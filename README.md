# mtg-card-processor

Scryfall bulk export → card images in Cloudflare R2 → card rows in the divinedrop
database.

Six phases run locally and produce `import.jsonl`. Then `import.js` applies it to
a database, and `deploy-import.sh` does that on production.

## Setup

```bash
npm install
cp .env.example .env          # fill in DB_* and S3_*
cwebp -version                # or: vips --version   (phase 4 needs one of them)
```

## A new set is out

Run in order. Every phase resumes, so re-running after an interruption is safe.

```bash
npm run phase0                # download the Scryfall export -> data.jsonl
npm run phase1                # group printings into cards/<oracle id>/ manifests
npm run phase2                # fetch images not already on disk or in R2
npm run phase3                # check manifests against disk + R2
npm run phase4 -- --prune     # png -> webp, deleting each png as it converts
npm run phase5                # upload new objects to R2, write import.jsonl
```

Phase 5 must finish with `✅ complete`. If it reports deferred cards, run phase 2
and phase 4 again, then phase 5.

To try the whole sequence cheaply first, add `--limit 20` to phases 2 and 5.

## Deploy

Rehearse against a local database, then go to production.

```bash
./local-db.sh up                                          # MySQL in Docker from database.sql
node import.js --file import.jsonl --dry-run              # report, write nothing
node import.js --file import.jsonl --prune                # apply locally

./deploy-import.sh --host <host> --user <user> --dry-run
./deploy-import.sh --host <host> --user <user> --prune --remove-withdrawn
```

Check the `Database:` line it prints before answering the prompt.

`--prune` deletes rows nothing can render. `--remove-withdrawn` deletes cards
Scryfall no longer publishes. **Both delete `Deck_Cards` rows**, so read the
output — some decks come up a card short. Never automate either one. What they
remove is written to `orphans-removed.tsv` and `withdrawn-removed.tsv` first.

## Flags

| flag | phases | what it does |
| --- | --- | --- |
| `--limit <n>` | 2, 5, import.js, deploy | only the first n |
| `--prune` | 3, 4, import.js, deploy | 3: delete unreferenced images. 4: delete each png after converting. import.js: delete unrenderable rows |
| `--dry-run` | import.js, deploy | report only, write nothing |
| `--remove-withdrawn` | import.js, deploy | delete cards no longer in the manifest |
| `--card <oracle id>` | 5 | one card only |
| `--skip-upload` | 5 | write the manifest without touching R2 |
| `--quality <n>` | 4 | webp quality, default 80 |
| `--force` | 0 | re-download the export even if it is current |
| `--verify-bucket` | 5 | list R2 and reconcile it against the `uploaded` ledger |
| `--repair-ledger` | 5 | with `--verify-bucket`: rewrite the ledger as what R2 holds |
| `--env-file <file>` | deploy | install a `.env` on the server |
| `--runner <auto\|node\|docker>` | deploy | how to run it remotely |

## If something refuses

| message | what it means | override |
| --- | --- | --- |
| phase 2: more than 10000 images | the `uploaded` ledger is probably missing | `--allow-bulk-download`, or `--limit 20` |
| phase 1: over 5% of cards absent from the export | `data.jsonl` is truncated — re-run phase 0 | `--allow-mass-removal` |
| `--remove-withdrawn` refused | `import.meta.json` says the manifest is incomplete | `--assume-complete` |
| withdrawn sweep over 5% | the same shortfall, wholesale | `--withdrawn-max-share <n>` |
| `--repair-ledger` would drop over 5% | wrong bucket or endpoint | `--force` |

Only override when you know why the number is what it is.

## Other things that happen

**Phase 2 stops on a 429** — expected. Re-run it.

**Phase 3 reports stale manifests** — phase 1 died partway. Re-run phase 1.

**`Access denied for user ''`** — the server's `.env` sets `DSN` in Go driver
format. Remove `DSN` from it and let `DB_*` speak.

**Out of disk** — the images in `cards/` are a cache once uploaded, so deleting
them is safe. Run `npm run phase5 -- --verify-bucket` first to confirm the ledger
matches R2. Keep the `uploaded` file itself, or phase 2 will refuse to run.

## Files

| path | keep? |
| --- | --- |
| `uploaded` | **yes** — the record of what is in R2, 5.5MB. Rebuild with `phase5 --verify-bucket --repair-ledger` |
| `.env` | yes. Never committed, never shipped to the server |
| `database.sql` | production backup, used by `local-db.sh` |
| `data.jsonl` | regenerable by phase 0, 632MB |
| `cards/` | manifests regenerable by phase 1 (285MB); the images are a cache (15GB) |
| `import.jsonl`, `import.meta.json` | the deploy artefacts, regenerable by phase 5 |
| `*-errors` | read them, then delete |

## Reference

- `./deploy-import.sh --help` — every deploy flag
- `./local-db.sh` — `up`, `down`, `reset`, `dump`, `status`, `shell`, `query`
- `node index.js` with no arguments — lists the phases
- `PLAN.md` — the reasoning behind the current design, if you need it
