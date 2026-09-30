# mtg-card-processor

Turns Scryfall's bulk export into card images in Cloudflare R2 and card rows in
the divinedrop database.

Six phases run locally and write two things: a directory of images per card, and
an `import.jsonl` describing what the database should hold. A seventh program,
`import.js`, applies that file to a database — locally for a rehearsal, then on
production through `deploy-import.sh`. The split is the point: the manifest holds
no `Cards.id` and no file paths, so the same file means the same thing against
any database, and applying it can only touch card tables. `Decks`, `Deck_Cards`
and `Sleeves` are never written except by the two sweeps described below, which
say so before they run.

## A new set is out

```bash
npm run phase0     # download the current Scryfall export to data.jsonl
npm run phase1     # group its printings into cards/<oracle id>/ manifests
npm run phase2     # fetch the images the manifests name that are not on disk
npm run phase3     # check the manifests against what is on disk
npm run phase4 -- --prune     # encode png to webp, deleting the png as it goes
npm run phase5     # upload new objects to R2, write import.jsonl
```

Then rehearse against a local database, and only then go to production:

```bash
node import.js --file import.jsonl --dry-run            # parse and report, write nothing
node import.js --file import.jsonl --prune              # apply to the local database
./deploy-import.sh --host <host> --user <user> --dry-run
./deploy-import.sh --host <host> --user <user> --prune --remove-withdrawn
```

Every phase resumes, and `import.js` updates rows rather than duplicating them —
so an interrupted run is fixed by running it again, and a run with nothing to do
says so and stops. That is what makes a set release cheap: the first full run
moved 111,000 images, and a set release moves the few hundred that are new.

That holds all the way down to the row. Every card row and every row hanging off
it is keyed on something derived from the card itself — Scryfall's print id for a
printing, a digest of the card and the value for a colour, name, text, keyword or
subtype — so re-importing a card that has not changed writes **nothing at all**,
rather than deleting its rows and putting them back under new ids. Measured on
3,000 cards: 29,566 row modifications per repeat import before, zero after.

Nothing ever asks Scryfall or R2 what it already has. Each resume is a local
check, and each one has to be read exactly:

| phase | "already have it" means | if the check is wrong |
| --- | --- | --- |
| 2 `download` | the png **or** the webp is in `cards/` | re-downloads the catalogue, 3 hours and 82GB |
| 4 `convert` | the webp is in `cards/` | re-encodes, costs CPU only |
| 5 `upload` | the key is in the local `uploaded` ledger | re-uploads 111,000 objects |

Phase 2 counting the webp is the one worth remembering. Phase 4 `--prune` deletes
each png once its webp is written, so a converted catalogue has almost no png
left — and a phase 2 that only looked for pngs would call all 109,442 of them
missing. To deliberately re-fetch an image, delete its webp as well as its png.

### What each phase costs

| phase | what it does | scale |
| --- | --- | --- |
| 0 `fetch` | Scryfall's `default_cards` export, gunzipped to `data.jsonl` | 75MB down, 632MB on disk, seconds |
| 1 `process` | groups 118,000 printings into 36,000 cards by the artwork they show | streams the whole file, minutes |
| 2 `download` | one image per distinct look, 10 requests a second | hours for a full catalogue, minutes for a set |
| 3 `validate` | reads every manifest, checks it against the filesystem | minutes, writes nothing unless `--prune` |
| 4 `convert` | png to webp at q80, one encoder per core | 82GB becomes 16GB; hours full, minutes for a set |
| 5 `upload` | new objects to R2, then writes `import.jsonl` | 53MB manifest, 36,000 lines |

Phase 2 holds itself to Scryfall's rate limit across all eight workers and stops
the whole run on a 429 rather than pressing on into a ban. Re-run it to continue.

## The two sweeps

Both belong to `import.js`, both **report on every run and delete only when
asked**, and both can remove `Deck_Cards` rows — the only user rows anything here
touches. A deck is never deleted; it just comes up a card short, the same as any
card rotating out.

**`--prune`** deletes rows nothing can render. Two shapes: a `Card_Prints` row
with no `front_hash` (the application resolves a card's image from that hash, so
a hashless printing is one it cannot show), and any row hanging off a card that
is not there. The schema carries no foreign keys at all, so nothing cascades and
nothing cleans up after a card that goes away. Keep running it: a sweep that
reports nothing is how you know the schema has not started leaking again.

**`--remove-withdrawn`** deletes cards the manifest no longer names. Scryfall
does withdraw cards — it deleted the Alchemy rebalanced cards outright rather
than superseding them, 217 of them, and their oracle ids now return not_found.
A withdrawn card left in place keeps whatever `front` it had when it was last
seen and renders as a broken tile in every list that includes it, forever, since
no future run will ever refresh it. This is the flag that keeps the catalogue in
step with upstream, so it belongs in the routine run.

Both were built for the one-time migration off DigitalOcean and both earn their
place in the seasonal run. Neither is safe to run blind, which is what the guard
rails are for.

## What refuses, and why

Every one of these exists because the failure it prevents is invisible: the run
reports success and the damage shows up later, in someone's deck.

| guard | refuses when | the failure it prevents |
| --- | --- | --- |
| phase 1 stale ceiling | more than 5% of local cards are absent from the export | a truncated `data.jsonl` reads as Magic having shrunk, and deletes gigabytes of images |
| phase 5 `import.meta.json` | — | records whether the manifest covers every card; nothing else knows |
| `--remove-withdrawn` | that file is missing or says incomplete | a phase 5 that deferred a dozen cards is indistinguishable from Scryfall withdrawing them |
| withdrawn share ceiling | more than 5% of the catalogue would be removed | the same shortfall, wholesale |
| `--prune` / `--remove-withdrawn` | the import itself failed or was cut short with `--limit` | acting on a catalogue that is not the one the manifest describes |
| `deploy-import.sh` | `--remove-withdrawn` without a complete manifest | fails before 40MB goes over the wire |

`--assume-complete` overrides the manifest check and `--withdrawn-max-share`
overrides the ceiling. Both are for when you know why the number is what it is.

Whatever a sweep removes, it writes down first: `withdrawn-removed.tsv` and
`orphans-removed.tsv` record the deck, its owner and the card, because after the
delete there is nothing left to join back to.

## Files on disk

| path | written by | keep? |
| --- | --- | --- |
| `data.jsonl` | phase 0 | regenerable, 632MB |
| `data.meta.json` | phase 0 | which export `data.jsonl` is, and when it was fetched |
| `cards/<oracle id>/` | phases 1–4 | `card.json`, `prints.jsonl`, and the images. 15GB |
| `uploaded` | phase 5 | the resume ledger, one key per line. **Lose this and everything uploads again** — it is never rebuilt by listing R2 |
| `import.jsonl` | phase 5 | what the database should hold |
| `import.meta.json` | phase 5 | whether that manifest is complete. Shipped with it |
| `*-errors` | any phase | appended to, never truncated. Delete when you have read them |

`npm run phase3 -- --prune` deletes images no manifest names and any `.part` file
a killed run left behind. `npm run phase4 -- --prune` deletes a png once its webp
exists, including ones an earlier run left behind.

Nothing here reads a card's directory by name except by its oracle id, and phase
1 removes the directory of any card the export no longer describes — so a card
Scryfall withdraws stops costing disk after the next phase 1.

## Environment

Copy `.env.example` to `.env`. The database variables are read by `import.js`;
the `S3_*` variables are read by phase 5 and use the same names as the
application's `helpers/s3.go`, so one file shape serves both repos.

There are deliberately no defaults for `S3_ENDPOINT` or the credentials. An
incomplete `.env` stops phase 5 rather than sending 16GB somewhere plausible.

`local-db.sh` runs a MySQL 8.0 in Docker and restores a `database.sql` into it,
which is how a production dump gets rehearsed against before anything is
deployed.

## Deploying to production

`./deploy-import.sh --help` covers the flags. It sends six files — `import.js`,
`lib/importer.js`, `lib/constants.js`, a pinned `package.json`, the gzipped
manifest and its `import.meta.json` — verifies the transfer by checksum, and runs
the import on the far side under the server's own node or a throwaway container.

The local `.env` is never shipped. The server keeps its own in the target
directory; `--env-file` installs one over stdin so its contents never reach a
process list.

Check the `Database:` line it prints before answering the prompt. It names the
resolved host, user and database and where each came from, and it is the cheapest
place to catch a server pointed at the wrong thing.

## When something goes wrong

**`Access denied for user ''@'...' (using password: NO)`** — the `.env` on the
server sets `DSN` in the Go driver's format, `user:pass@tcp(host:port)/dbname`.
mysql2 accepts that string and silently mis-parses it into an empty user. That is
now handled and `import.js` prints which form it used, but if the resolved line
looks wrong, remove `DSN` from that `.env` and let `DB_*` speak.

**Phase 2 stops with a 429** — expected, and deliberate. Re-run it.

**Phase 5 defers cards** — their default image is not in the bucket, so the card
would point at an object that does not exist. Run phases 2 and 4, then 5 again.
Until it reports the manifest complete, `--remove-withdrawn` will refuse.

**Phase 3 reports stale manifests** — a phase 1 died partway and left manifests
from the previous export. Run phase 1 again.

**A card looks wrong in the application** — `lib/hash.js` decides which printings
share an image, and `lib/utils.js` decides which cards are skipped entirely
(non-English, art series, reversible cards, plain basic lands, the `Card` type).
Both have their reasoning written down where the code is.
