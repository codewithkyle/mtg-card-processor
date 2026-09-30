# Two fixes to the importer

Branch: `nightly-automation` (now a misnomer — there is no nightly job; see
"What we decided against")

## Scope

Two changes, both to make the existing hand-run tool cheaper and harder to
damage. Deployment stays manual: `npm run phase0..5` then `./deploy-import.sh`,
which is already fast and documented in `README.md`.

1. **Stop the uuid churn** — a full import made 502,026 row modifications,
   357,224 of which were pointless. **Done, measured and verified.**
2. **Make the R2 ledger authoritative for images** — so the 15 GB local image
   cache stops being precious. **Not started.**

## What we decided against, and why

**A nightly container and cron job.** The motivation was keeping prices fresh.
This is a deck builder for a tabletop simulator gamemode, not a price-tracking
or card-buying site, so stale prices cost nothing. Without that, an automated
nightly run is machinery with no job to do — and it carried real risk: an
unattended pipeline on the production VM, a cold start that would have written
99 GB of png onto an 80 GB disk, and a whole observability problem (a heartbeat
file is not an alert) that only exists because nobody is watching.

Everything the automation was for is already covered by running the pipeline by
hand a few times a year, which is what the tooling was built for.

**The import fast path** (bulk-read the stable columns, batch the price updates).
It only paid off against a nightly run of 36k cards. With change 1 in place a
hand-run import is cheap enough that the extra code is not worth carrying.

## Current state

On this branch, committed: phase 0 fetches the Scryfall export and records its
provenance; phase 1 stamps it into every manifest and removes cards the export
dropped; phase 2 accepts a webp as proof an image is held; phase 3/4 gained
`--prune`; `import.meta.json` gates `--remove-withdrawn`; the DigitalOcean
fallbacks are gone; `README.md` is the runbook.

**The 2026-09-29 refresh is deployed.** `data.jsonl` is that export, and
regenerating the manifests from it surfaced real upstream drift: 5 new looks
(full-art textless basics), 2 changed treatments (Shadrix Silverquill, Yennett),
108,839 printings against the previous 108,834. The 9 objects that were pending
went through `phase2 → phase4 --prune → phase5` and out to production, which
doubled as a live rehearsal of the set-release path. `database.sql` is a
production backup taken after that, so it is the schema and data change 1 was
verified against.

---

## Change 1 — stop the uuid churn

**Done.** `lib/importer.js` only, no schema change. What it measured out at, and
how it was verified, are at the end of this section.

### The problem

`purgeTables` deletes every child row for a card, and `insertList` re-inserts
them with a fresh `uuidv4()` per row. Every run, for every card:

| table | rows |
| --- | --- |
| `Card_Colors` | 36,943 |
| `Card_Names` | 36,864 |
| `Card_Texts` | 36,181 |
| `Card_Keywords` | 24,935 |
| `Card_Subtypes` | 24,391 |
| `Card_Flavor_Text` | 19,298 |
| **child rows** | **178,612** |

So a full import is 178,612 deletes + 178,612 inserts, plus 108,834 `Card_Prints`
upserts and 35,968 `Cards` updates — **502,026 row modifications**, of which
357,224 exist only to give every row a new random id.

The primary keys are `binary(16)` holding random uuid v4, and InnoDB clusters
rows on the primary key. Emptying a table and refilling it with *new* random keys
is close to the worst case for that structure: inserts land at random points in
the clustered index, causing page splits and poor fill, and InnoDB never returns
freed pages to the OS — so the tablespace ratchets up and never shrinks. On top
of that, full row images go to the binlog in both directions.

`Card_Prints` does not have this problem. It is keyed on Scryfall's own print id
and upserted, so on a run where nothing changed MySQL reports zero affected rows
and does not rewrite the row. Its comment already states the principle:

> That id is what makes a re-run an update instead of a second copy of the
> catalogue, which the random uuid the previous importer generated could never be.

This change applies that to the remaining six tables. It is finishing an existing
idea, not introducing a new one.

### Verified safe before touching anything

- **No Go code reads a child row's id.** All ~20 references in `models/card.go`
  and `models/deck.go` join on `card_id` and select the value (`text`, `name`,
  `subtype`, `keyword`, `color_id`). Nothing selects `ct.id`.
- **No Go code writes those tables.** The importer is the only writer.

So the churn is purely a storage and I/O cost today, and changing the id scheme
cannot break a reader.

### The change

Derive each row's id from the fact it records, so the same fact always lands on
the same id:

```js
function rowId(table, cardId, value){
    return crypto.createHash("md5").update(`${table}:${cardId}:${value}`).digest("hex").toUpperCase();
}
```

md5 gives exactly the 16 bytes the column holds, and the project already
content-addresses images the same way.

Replace `purgeTables` + `insertList` with one `syncList` per table:

```js
async function syncList(conn, table, column, card, values){
    const unique = [...new Set(values)];
    if (!unique.length){
        await conn.query(`DELETE FROM ${table} WHERE card_id = UNHEX(?)`, [card.id]);
        return;
    }
    const ids = unique.map((v) => rowId(table, card.id, v));
    // whatever is no longer true
    await conn.query(
        `DELETE FROM ${table} WHERE card_id = UNHEX(?) AND id NOT IN (${ids.map(() => "UNHEX(?)").join(", ")})`,
        [card.id, ...ids]);
    // whatever is new; unchanged rows collide on the primary key and are skipped
    await conn.query(
        `INSERT IGNORE INTO ${table} (id, card_id, ${column}) VALUES ${unique.map(() => "(UNHEX(?), UNHEX(?), ?)").join(", ")}`,
        unique.flatMap((v) => [rowId(table, card.id, v), card.id, v]));
}
```

An unchanged card becomes two statements per table and **zero row writes**. A
card whose text genuinely changed deletes one row and inserts one.

### One behaviour change, decided

Hashing on the value collapses duplicate `(card_id, value)` pairs. There are
exactly **70**, all the same shape — two-faced cards where both faces carry the
same subtype:

```
Defiled Crypt // Cadaver Lab      [split]      ["Room", "Room"]
Arlinn, the Pack's Hope // ...    [transform]  ["Arlinn", "Arlinn"]
Alluring Suitor // Deadly Dancer  [transform]  ["Vampire", "Vampire"]
```

`buildCardData` pushes one subtype per face. The app queries these with
`WHERE cs.subtype = ?` inside an `IN (SELECT card_id …)` and builds its filter
list with `SELECT DISTINCT subtype`, so a duplicate row is invisible to it.

**Decision: collapse them.** It is a small data-quality improvement, not a
regression. To preserve them instead, add the array index to the hash input — at
the cost that a card gaining an element at the front rewrites all of that card's
rows.

### One deviation from the sketch above

The insert is `ON DUPLICATE KEY UPDATE card_id = card_id`, not `INSERT IGNORE`.
Both say the same thing about a row that is already there, but IGNORE also
downgrades every *other* error to a warning — a face name too long for
`varchar(255)` would be quietly truncated instead of stopping the import, which
is the opposite of what `STRICT_TRANS_TABLES` is in `sql_mode` for.

Self-assignment rather than `VALUES(card_id)` because MySQL 8.0.46 raises
deprecation warning 1287 on `VALUES()` in that clause, and there was no reason to
add a second instance of it. `upsertCardPrints` still uses that form —
pre-existing, harmless today, a one-line change whenever you want it.

### What it measures out at

Old code and new, four passes each over the same 3,000-card manifest, two fresh
databases, local MySQL 8.0.46. Counted with `Innodb_rows_inserted/updated/deleted`
— what the storage engine actually did. `affectedRows` is the wrong instrument
here and said so loudly: mysql2 connects with `CLIENT_FOUND_ROWS`, so it reports
rows *matched* and claims thousands of modifications on a pass that changed
nothing.

| | first import | every import after |
| --- | --- | --- |
| before | 26,498 rows written, 16.9s | **29,566 rows written** — 14,783 deleted, 14,783 re-inserted — 22.5s |
| after | 26,494 rows written, 17.3s | **0 rows written**, 5.8s |

Stable at zero across passes 2, 3 and 4, so it settles rather than alternating.
Scaled to the full 35,968-card catalogue that is roughly **354,000 row
modifications per import down to none**, and about 4.5 minutes of database work
down to 1.2. A set release still writes exactly the rows the set changed.

The 4-row difference on the first pass is the 70 duplicate subtypes collapsing —
4 of them fall in the first 3,000 cards.

The binlog turns out to matter more than expected: this server runs `log_bin=ON`
with `binlog_format=ROW`, so each of those 354,000 row modifications was also a
binlog row event carrying a full row image. Those are gone too, which is the part
that would have shown up as replication lag or backup size rather than as import
time.

**Tablespace, measured rather than argued.** The six `.ibd` files after four
passes: 12.35 MB before, 11.86 MB after. That is 4%, not the order of magnitude
the page-split reasoning implies — and excluding `Card_Texts`, whose FULLTEXT
index dominates its file size and is 9 MB either way, 17%. The ratchet is real
but slow, and four passes is nowhere near enough of it to see. **The row-operation
and wall-clock numbers are the honest case for this change**; bloat is a
secondary benefit that accrues over years.

### How it was verified

Throwaway databases on the local MySQL, the same method used for the withdrawn
and orphan sweeps, all dropped afterwards. Every assertion passed:

1. 50 hand-picked cards into a fresh schema — duplicate-subtype cards, multi-face
   cards, cards with empty lists, cards with ten keywords — then every child
   row's id recorded.
2. The identical manifest again: **no row added, removed or changed** in any of
   the six tables, every id identical, `Handler_delete` zero.
3. A third identical pass, to prove it settles rather than alternating.
4. One card's `texts` edited: exactly one row out and one in, **in `Card_Texts`
   only**, nothing moved in the other five tables.
5. One value dropped from a card's `subtypes`: exactly one row out, no insert.
6. That subtype restored: `Card_Subtypes` returns to **byte-identical ids**, which
   is the property random uuids could never have.
7. A duplicate-subtype card stored once, and the app's own
   `SELECT DISTINCT subtype` query returning the same answer as before.
8. A card losing all five of its keywords: five rows out, nothing else touched.
9. No MySQL warnings outstanding.
10. `import.js` itself, twice over 3,000 cards through its 8-worker pool, to
    exercise the concurrency the single-connection harness could not.

Safety was re-confirmed against the app rather than assumed: every reference to
these six tables in `models/card.go` and `models/deck.go` joins on `card_id` and
selects the *value*. Nothing anywhere selects a child row's `id`, and the one
`GROUP BY` that looked like a risk keys on `Cards.id`.

---

## Change 2 — ledger authority for images

`phases/phase-2.js`, `phase-3.js`, `phase-4.js`. Phase 5 needs no change.

### The problem, restated for a hand-run tool

Phase 2 asks "is this file on disk?". The authoritative question is "is the
finished object already in R2?", and the `uploaded` ledger answers it in **5.2 MB**.

The original motivation for this was an unattended 3am run filling the production
disk. That is gone. What remains is smaller but real, and it is a trap in exactly
the workflow that is left:

**The 15 GB `cards/` directory is currently load-bearing, and it does not look
it.** Delete it to reclaim space between set releases — a reasonable thing to do,
and nothing warns you — and the next run re-downloads **99 GB of png** (111,084
images at a measured mean of 931 KB) over about three hours at Scryfall's rate
limit, then re-encodes all of it. Every one of those objects is already in R2.
The same applies to moving to a different machine, or losing the directory to a
cleanup.

For a tool used a few times a year, "the cache is the thing most likely to be
gone by the next time you need it" is the realistic failure.

Honest assessment of the benefit: this is **robustness and portability, not
speed.** Phases 3 and 5 still walk `cards/` for the manifests, so a normal run is
no faster. It is worth doing because it turns a three-hour accident into a
non-event, and because it makes a fresh machine an 85 MB setup instead of a
99 GB one.

### The change

- **`phase-2.js`** — `buildQueue` already has `look.hash`, `look.backHash` and
  `card.defaultFront` in scope but does not store them on the job. Add each job's
  R2 key (`faceKey(hash, side)` / `artKey(card.defaultFront)`, both already
  exported from `lib/upload.js`), and skip a job whose key is in the ledger.
- **`phase-3.js`** — an image whose key is in the ledger is present, not missing.
  Report the state of the local cache separately from the state of the catalogue,
  so "no local copy" and "no image anywhere" stop looking alike.
- **`phase-4.js`** — do not say "run phase 2 first" for an image the ledger holds;
  there is nothing to convert.
- **`phase-5.js`** — no change. `send()` already consults the ledger before the
  filesystem and returns success without a local file.

Follow it through and a card with no local images still enters `import.jsonl`
with the correct hashes, because every hash comes from the manifest rather than
from a file listing.

### The cost of this change

**The ledger becomes the single witness** that an object is in R2. Today the local
webp is a second witness. If the ledger ever claims something R2 does not have, a
card points at a missing object and nothing local would notice.

Mitigations, in order of how much they are worth:

- `uploaded` is only appended after a `PutObjectCommand` resolves, so it does not
  claim an upload that failed.
- Add **`--verify-bucket`** to phase 5: list R2 and reconcile against the ledger.
  Run by hand, not routinely — a full listing of 111,538 objects is a few thousand
  Class B operations.
- Keep the local cache anyway until `--verify-bucket` has been run clean once.
  Nothing forces its deletion; the change only stops it being *required*.

### A smaller guard worth adding

Phase 2 already prints `At 10 requests a second this takes about 3h 5m` — and
then immediately starts. Require a flag (`--allow-bulk-download`) past some
threshold, so a missing ledger or an empty cache cannot silently commit you to a
three-hour, 99 GB job. Cheap, and it is the one guard whose failure mode survives
the automation being dropped.

### How we verify

1. Point a scratch working directory at a copy of the `uploaded` ledger and the
   manifests, with **no images at all**. Assert phase 2 fetches nothing, phase 4
   has nothing to convert, phase 5 uploads nothing and writes a manifest whose
   `import.meta.json` says `complete: true`.
2. Assert that manifest is byte-identical to one produced with the full 15 GB
   cache present. This is the real test: the manifest must not depend on which
   local files happen to exist.
3. Remove one key from the ledger copy and assert phase 2 fetches exactly that
   one image.
4. Empty the ledger and assert the bulk-download guard refuses.

---

## Order of work

1. ~~**Reconcile the 9 pending objects.**~~ Done, and deployed to production.
2. ~~**Change 1.**~~ Done, measured and verified.
3. **Change 2**, with `--verify-bucket` in the same pass, since the verify option
   is what makes relying on the ledger reasonable. ← next
4. Rename the branch, or just note in the commit that the automation was
   considered and dropped, so the reasoning is not lost.

Each is independently useful and neither depends on the other.

## Left alone deliberately

- **`uploaded` grows forever.** 458 of its keys point at R2 objects nothing
  references any more (printings whose treatment changed between exports).
  Harmless at this size. A compaction step, paired with a sweep for unreferenced
  R2 objects, is worth doing someday but is not blocking anything.
- **Hardcoded `WORKERS = 8`** in `import.js:47`, `phase-2.js:20`, `phase-5.js:18`.
  Fine on a workstation; it only mattered for a 2-vCPU server.
- **`--remove-withdrawn` stays manual**, as it always was. It deletes rows out of
  users' decks, so it wants a person reading the output.
