const crypto = require("crypto");
const { v4: uuidv4 } = require('uuid');
const { colors, rarities } = require("./constants");

const MAX_RETRIES = 100;
const RETRY_DELAY = 1000; // milliseconds
const MAX_RETRY_DELAY = 5000; // milliseconds

// Card_Prints rows are written in batches rather than one statement per card,
// because a heavily reprinted card carries a few hundred printings and a card
// like Lightning Bolt would otherwise cost a round trip each.
const PRINT_BATCH = 250;

// The manifest's oracle ids go into a temporary table so the sweep below can
// join against them. Batched for the same reason as the printings: 36,000
// single row inserts is a round trip each.
const MANIFEST_BATCH = 5000;

// Every table that names a card. Taken from information_schema rather than from
// memory, because the schema carries no foreign keys at all - nothing cascades,
// and a reference left behind is a row pointing at a card that no longer exists.
const CARD_CHILD_TABLES = [
    "Card_Colors", "Card_Flavor_Text", "Card_Keywords", "Card_Names",
    "Card_Prints", "Card_Subtypes", "Card_Texts",
];

// A deck names a card in these three places as well as through Deck_Cards.
const DECK_CARD_COLUMNS = ["commander_card_id", "oathbreaker_card_id", "partner_card_id"];

// How much of the catalogue the sweep is allowed to remove before it refuses.
// Phase 5 defers a card whose default image is not in the bucket yet, so a
// manifest written mid run is legitimately short, and a short manifest is
// indistinguishable from a catalogue that has genuinely gone out of date. The
// ceiling is what stops the second reading from being acted on: 219 withdrawn
// cards out of 36,187 is 0.6%, so anything approaching 5% is a truncated
// manifest rather than news from Scryfall.
const MAX_WITHDRAWN_SHARE = 0.05;

function hex(uuid){
    return uuid.replace(/-/g, "").toUpperCase();
}

// One transaction around everything a single card writes.
//
// A card's lists are brought up to date in two statements each - a delete of
// what the card no longer says and an insert of what it now does - and a commit
// between them would leave the card missing whatever changed. An import of this
// size will be interrupted, so that window has to not exist: either the whole
// card lands or none of it does, and a re-run starts from a card that is
// whole rather than from one that is half swapped.
//
// Retrying the work as a unit is safe because all of it is idempotent. Every
// statement is keyed on something derived from the card rather than generated
// per attempt, so a second pass addresses the same rows and changes nothing.
async function withTransaction(conn, work) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            await conn.beginTransaction();
            await work();
            await conn.commit();
            return;
        } catch (error) {
            await conn.rollback();
            if (error.sqlState === '40001') { // Deadlock detected
                if (attempt < MAX_RETRIES - 1) {
                    // Capped on purpose: uncapped, 2**attempt reaches a 12 day
                    // sleep by the twentieth retry, which does not look like a
                    // deadlock storm - it looks like the program has frozen.
                    const backoff = Math.min(RETRY_DELAY * (2 ** attempt), MAX_RETRY_DELAY);
                    await new Promise(resolve => setTimeout(resolve, backoff));
                    continue;
                }
                throw new Error('Transaction failed after maximum retries');
            }
            throw error;
        }
    }
}

// The id a card already has, so re-importing updates the row a player's decks
// point at instead of creating a second one. Bound rather than interpolated -
// the oracle id comes from a file we do not write.
async function resolveCardId(conn, oracleId){
    const [rows] = await conn.query(
        "SELECT HEX(id) AS id FROM Cards WHERE oracle_id = UNHEX(?)",
        [oracleId.replace(/-/g, "")],
    );
    return rows?.[0]?.id ?? null;
}

function normalise(card){
    const power = parseInt(card.power);
    const toughness = parseInt(card.toughness);
    return {
        power: isNaN(power) ? null : power,
        toughness: isNaN(toughness) ? null : toughness,
        price: card.price || card.tix || 100,
        edhRank: card.edhRank === null ? 99999 : card.edhRank,
    };
}

function legalityParams(card){
    const formats = [
        "standard", "future", "historic", "gladiator", "pioneer", "explorer",
        "modern", "legacy", "pauper", "vintage", "penny", "commander",
        "oathbreaker", "brawl", "historicbrawl", "alchemy", "paupercommander",
        "duel", "oldschool", "premodern", "predh",
    ];
    return formats.map((format) => (card.legalities?.[format] ? 1 : 0));
}

const CARD_COLUMNS = [
    "layout", "front", "back", "art", "rarity", "type", "toughness", "power",
    "manaCost", "totalManaCost", "standard", "future", "historic", "gladiator",
    "pioneer", "explorer", "modern", "legacy", "pauper", "vintage", "penny",
    "commander", "oathbreaker", "brawl", "historicbrawl", "alchemy",
    "paupercommander", "duel", "oldschool", "premodern", "predh", "edh_rank",
    "price", "set_name",
];

function cardParams(card){
    const { power, toughness, price, edhRank } = normalise(card);
    return [
        card.layout,
        card.front,
        card.back,
        card.art,
        rarities?.[card.rarity] ?? null,
        card.type,
        toughness,
        power,
        card.manaCosts?.[0] ?? null,
        card.totalManaCost,
        ...legalityParams(card),
        edhRank,
        price,
        card.set,
    ];
}

async function insertCard(conn, card){
    const query = `INSERT INTO Cards (id, oracle_id, name, ${CARD_COLUMNS.join(", ")}) VALUES (UNHEX(?), UNHEX(?), ?, ${CARD_COLUMNS.map(() => "?").join(", ")})`;
    await conn.query(query, [
        card.id,
        card.oracleId.replace(/-/g, ""),
        card.name,
        ...cardParams(card),
    ]);
}

async function updateCard(conn, card){
    const query = `UPDATE Cards SET name = ?, ${CARD_COLUMNS.map((column) => `${column} = ?`).join(", ")} WHERE id = UNHEX(?)`;
    await conn.query(query, [card.name, ...cardParams(card), card.id]);
}

// The id of a child row, derived from the fact the row records.
//
// Six tables are plain lists hanging off a card - one row per colour, face name,
// text, flavour text, keyword and subtype - and nothing anywhere reads their
// ids. Every query in the application joins on card_id and selects the value.
// The id existed only to satisfy the primary key, and it was a fresh uuidv4()
// on every import, which is what made a re-run rewrite the entire catalogue.
//
// Deriving it from the card and the value makes the same fact always land on the
// same row, so a card that has not changed writes nothing at all. md5 is here
// for its width rather than for any cryptographic property: sixteen bytes is
// exactly what binary(16) holds, and lib/hash.js already addresses images this
// way.
//
// The table name is in the digest so that an id names a row rather than a fact.
// Two of these tables hold free text and a card can legitimately carry the same
// string in both; without it, those two rows would share an id.
function rowId(table, cardId, value){
    return crypto.createHash("md5").update(`${table}:${cardId}:${value}`).digest("hex").toUpperCase();
}

// Brings one of those lists to what the card now says, touching only what
// changed.
//
// This replaces a delete of every row belonging to the card followed by an
// insert of all of them back again. That was 357,224 of a full import's 502,026
// row modifications and not one of them recorded anything new - the rows came
// back identical apart from ids nothing reads. InnoDB clusters rows on the
// primary key, so refilling a table with fresh random keys is close to the worst
// case for it: inserts land at random points in the index, pages split and fill
// badly, and the tablespace only ever ratchets up because freed pages are never
// returned to the OS. Both directions of every row also go to the binlog.
//
// Two statements now, and on an unchanged card both affect nothing:
//
//   DELETE  whatever the card no longer says
//   INSERT  whatever it now says - a row that is already right collides on the
//           primary key and MySQL leaves it where it is
//
// The first import after this change is the exception, exactly once. Every row
// already in the database carries a random uuid that does not match its derived
// id, so the delete takes it and the insert writes it back under the new one -
// the same work every import used to do, after which they stop doing it.
async function syncList(conn, table, column, card, values){
    // Duplicates collapse here rather than becoming a second row under the same
    // id. There are 70 of them in the catalogue, all the same shape: a two faced
    // card whose faces carry the same subtype, because buildCardData pushes one
    // subtype per face. The application reads these with SELECT DISTINCT subtype
    // and matches them with WHERE subtype = ?, so the duplicate row was never
    // visible to it.
    const unique = [...new Set(values)];

    if (!unique.length){
        await conn.query(`DELETE FROM ${table} WHERE card_id = UNHEX(?)`, [card.id]);
        return;
    }

    const ids = unique.map((value) => rowId(table, card.id, value));

    await conn.query(
        `DELETE FROM ${table} WHERE card_id = UNHEX(?) AND id NOT IN (${ids.map(() => "UNHEX(?)").join(", ")})`,
        [card.id, ...ids],
    );

    // ON DUPLICATE KEY rather than INSERT IGNORE. Both say the same thing about a
    // row that is already there, but IGNORE would also swallow every other error
    // the insert could raise - a face name too long for varchar(255) would be
    // quietly truncated instead of stopping the import.
    //
    // The update assigns card_id to itself, which is the whole intent: a key that
    // already exists belongs to a row that already holds this card and this
    // value, because the id is derived from both. So there is nothing to write,
    // and MySQL does not write it - measured as zero Innodb_rows_updated across a
    // 3,000 card re-import. Self assignment rather than VALUES(card_id), which
    // says the same thing but is deprecated as of MySQL 8.0.20 and raises warning
    // 1287 on every statement. upsertCardPrints below still uses that form.
    await conn.query(
        `INSERT INTO ${table} (id, card_id, ${column}) VALUES ${unique.map(() => "(UNHEX(?), UNHEX(?), ?)").join(", ")} ON DUPLICATE KEY UPDATE card_id = card_id`,
        unique.flatMap((value, at) => [ids[at], card.id, value]),
    );
}

// One row per printing, addressed by the id Scryfall already gave it.
//
// That id is what makes a re-run an update instead of a second copy of the
// catalogue, which the random uuid the previous importer generated could never
// be.
//
// Nothing is deleted here. A printing that leaves the Scryfall data is simply
// not in the manifest any more, so its row stays behind pointing at an image
// nobody will pick, and a row that predates the hashes keeps a NULL front_hash.
// Neither is this function's business - both are swept by import.js --prune,
// which can see the whole catalogue at once and so can tell the difference
// between a printing that is gone and a manifest that is short.
async function upsertCardPrints(conn, card, rows){
    if (!rows.length) return;
    for (let offset = 0; offset < rows.length; offset += PRINT_BATCH){
        const batch = rows.slice(offset, offset + PRINT_BATCH);
        const params = [];
        const segments = [];
        for (const row of batch){
            params.push(hex(row.id), card.id, row.released, row.frontHash, row.backHash);
            segments.push("(UNHEX(?), UNHEX(?), ?, UNHEX(?), UNHEX(?))");
        }
        const query = `INSERT INTO Card_Prints (id, card_id, released, front_hash, back_hash) VALUES ${segments.join(", ")} ON DUPLICATE KEY UPDATE card_id = VALUES(card_id), released = VALUES(released), front_hash = VALUES(front_hash), back_hash = VALUES(back_hash)`;
        await conn.query(query, params);
    }
}

// Writes one card and everything hanging off it, as a single transaction.
//
// Resolving the id is part of that transaction now. Phase 5 used to need it
// beforehand to name the art object, but nothing in the bucket is named after
// a card id any more, so the read and the writes that depend on it can be
// atomic.
async function importCard(conn, card, printRows){
    let created = false;
    await withTransaction(conn, async () => {
        const existing = await resolveCardId(conn, card.oracleId);
        created = existing === null;
        card.id = existing ?? hex(uuidv4());

        if (created){
            await insertCard(conn, card);
        } else {
            await updateCard(conn, card);
        }

        await syncList(conn, "Card_Colors", "color_id", card, card.colors.map((color) => colors[color]).filter(Boolean));
        await syncList(conn, "Card_Names", "name", card, card.faceNames);
        await syncList(conn, "Card_Texts", "text", card, card.texts);
        await syncList(conn, "Card_Flavor_Text", "text", card, card.flavorTexts);
        await syncList(conn, "Card_Keywords", "keyword", card, card.keywords);
        await syncList(conn, "Card_Subtypes", "subtype", card, card.subtypes);
        await upsertCardPrints(conn, card, printRows);
    });
    return { id: card.id, created };
}

// Cards the current Scryfall data no longer describes.
//
// Everything in the catalogue arrives through a manifest, so a card the manifest
// does not name is one upstream has withdrawn. Almost all of them are the
// Alchemy rebalanced cards - Scryfall deleted those outright rather than
// superseding them, so their oracle ids return not_found and no future run will
// ever refresh the rows.
//
// Leaving them is worse than removing them. Cards.front is a hash the CDN
// resolves, and a card no run will ever refresh keeps whatever its front was
// when it was last seen - for the Alchemy cards, an absolute DigitalOcean URL
// the app pastes into a CDN path and renders as nothing. A card that is absent
// is a clean absence; a card that is present and unrenderable is a broken tile
// in every list that includes it.
//
// Deck_Cards rows naming one go too. That is not a policy choice - with the card
// gone the row points at nothing - so the deck simply comes up a card short, the
// same as any card rotating out. The deck itself is never touched.
async function pruneWithdrawn(conn, oracleIds, options = {}){
    const maxShare = options.maxShare ?? MAX_WITHDRAWN_SHARE;
    const dryRun = options.dryRun ?? false;

    await conn.query("DROP TEMPORARY TABLE IF EXISTS tmp_manifest_oracle");
    await conn.query("CREATE TEMPORARY TABLE tmp_manifest_oracle (oid binary(16) NOT NULL PRIMARY KEY)");

    const ids = [...oracleIds];
    for (let offset = 0; offset < ids.length; offset += MANIFEST_BATCH){
        const batch = ids.slice(offset, offset + MANIFEST_BATCH);
        // INSERT IGNORE because a manifest is one line per card but nothing
        // guarantees that, and a duplicate oracle id should not abort a sweep.
        await conn.query(
            `INSERT IGNORE INTO tmp_manifest_oracle (oid) VALUES ${batch.map(() => "(UNHEX(?))").join(", ")}`,
            batch.map((id) => id.replace(/-/g, "")),
        );
    }

    const [[{ total }]] = await conn.query("SELECT COUNT(*) AS total FROM Cards");
    const [withdrawn] = await conn.query(`
        SELECT HEX(c.id) AS id, c.name, c.set_name AS setName
        FROM Cards c
        LEFT JOIN tmp_manifest_oracle m ON m.oid = c.oracle_id
        WHERE m.oid IS NULL
        ORDER BY c.name`);

    const report = {
        total,
        withdrawn,
        share: total ? withdrawn.length / total : 0,
        refused: null,
        slots: [],
        deleted: null,
    };
    if (!withdrawn.length){
        await conn.query("DROP TEMPORARY TABLE tmp_manifest_oracle");
        return report;
    }
    if (report.share > maxShare){
        report.refused = `${withdrawn.length} of ${total} cards (${(report.share * 100).toFixed(1)}%) are absent from the manifest, over the ${(maxShare * 100).toFixed(0)}% ceiling`;
        await conn.query("DROP TEMPORARY TABLE tmp_manifest_oracle");
        return report;
    }

    await conn.query("DROP TEMPORARY TABLE IF EXISTS tmp_withdrawn");
    await conn.query("CREATE TEMPORARY TABLE tmp_withdrawn (id binary(16) NOT NULL PRIMARY KEY)");
    await conn.query(`
        INSERT INTO tmp_withdrawn (id)
        SELECT c.id FROM Cards c
        LEFT JOIN tmp_manifest_oracle m ON m.oid = c.oracle_id
        WHERE m.oid IS NULL`);

    // Read before writing, so what the decks lose can be written down. Eight
    // people's decks come up short here and the only record of which card left
    // which deck is this one - after the delete there is nothing to join back
    // to.
    // Decks.user_id is a varchar holding the identity provider's own id, not a
    // binary uuid like every other id here, so it is read as it is. HEX() on it
    // wrote the hex of the ASCII - 757365725F... for user_... - into the one
    // record of what a deck lost.
    const [slots] = await conn.query(`
        SELECT HEX(d.id) AS deckId, d.label AS deck, d.user_id AS owner, c.name AS card, dc.qty, dc.sideboard
        FROM Deck_Cards dc
        JOIN tmp_withdrawn w ON w.id = dc.card_id
        JOIN Cards c ON c.id = dc.card_id
        JOIN Decks d ON d.id = dc.deck_id
        ORDER BY d.label, c.name`);
    report.slots = slots;

    if (dryRun){
        await conn.query("DROP TEMPORARY TABLE tmp_withdrawn");
        await conn.query("DROP TEMPORARY TABLE tmp_manifest_oracle");
        return report;
    }

    // One transaction for the whole sweep. Half of it - a Cards row gone while
    // its Card_Texts survive, or the reverse - is a worse state than either
    // end, and there is no resume that could tell the difference.
    const deleted = { slots: 0, references: 0, children: {}, cards: 0 };
    await withTransaction(conn, async () => {
        const [dc] = await conn.query("DELETE dc FROM Deck_Cards dc JOIN tmp_withdrawn w ON w.id = dc.card_id");
        deleted.slots = dc.affectedRows;

        for (const column of DECK_CARD_COLUMNS){
            const [upd] = await conn.query(
                `UPDATE Decks d JOIN tmp_withdrawn w ON w.id = d.${column} SET d.${column} = NULL`);
            deleted.references += upd.affectedRows;
        }

        for (const table of CARD_CHILD_TABLES){
            const [res] = await conn.query(`DELETE t FROM ${table} t JOIN tmp_withdrawn w ON w.id = t.card_id`);
            deleted.children[table] = res.affectedRows;
        }

        const [cards] = await conn.query("DELETE c FROM Cards c JOIN tmp_withdrawn w ON w.id = c.id");
        deleted.cards = cards.affectedRows;
    });
    report.deleted = deleted;

    await conn.query("DROP TEMPORARY TABLE tmp_withdrawn");
    await conn.query("DROP TEMPORARY TABLE tmp_manifest_oracle");
    return report;
}

// Rows hanging off a card that is not there.
//
// Two shapes, both debris. A card_id naming a Cards row that does not exist, and
// a card_id that is NULL. Neither is reachable from any card, so nothing renders
// them and nothing else will ever find them: the schema has no foreign keys, so
// nothing stopped them being written and nothing cleans up after a card that
// went away.
//
// They predate this pipeline - they arrive in every production dump, in the same
// numbers - and the withdrawn sweep above cannot see them, because that one
// works outwards from Cards and these rows are exactly the ones no card points
// at. So they are counted and removed from the other direction: every table that
// names a card, anti-joined against Cards.
//
// Deck_Cards is swept too. A slot naming a card that does not exist renders as
// nothing and only inflates the deck's size, which is the same reason the
// withdrawn sweep takes its slots. The deck itself is never touched.
async function pruneOrphans(conn, options = {}){
    const dryRun = options.dryRun ?? false;
    const tables = [...CARD_CHILD_TABLES, "Deck_Cards"];

    const report = { tables: {}, orphaned: 0, nullCard: 0, cardIds: 0, slots: [], references: 0, deleted: false };

    for (const table of tables){
        // One pass counts both shapes: a NULL card_id and a card_id with no row
        // both leave c.id NULL after the join, so the sums are what separate
        // them.
        const [[counts]] = await conn.query(`
            SELECT COALESCE(SUM(t.card_id IS NOT NULL), 0) AS orphaned,
                   COALESCE(SUM(t.card_id IS NULL), 0) AS nullCard
            FROM ${table} t LEFT JOIN Cards c ON c.id = t.card_id
            WHERE c.id IS NULL`);
        report.tables[table] = { orphaned: Number(counts.orphaned), nullCard: Number(counts.nullCard) };
        report.orphaned += Number(counts.orphaned);
        report.nullCard += Number(counts.nullCard);
    }

    const [[{ ids }]] = await conn.query(`
        SELECT COUNT(DISTINCT card_id) AS ids FROM (
            ${tables.map((table) => `SELECT t.card_id FROM ${table} t LEFT JOIN Cards c ON c.id = t.card_id WHERE t.card_id IS NOT NULL AND c.id IS NULL`).join(" UNION ALL ")}
        ) o`);
    report.cardIds = Number(ids);

    // Read before writing. Once the row is gone there is no way back to which
    // deck held it, and unlike the withdrawn sweep there is not even a card name
    // to record - the card was already gone before this dump was taken.
    const [slots] = await conn.query(`
        SELECT HEX(d.id) AS deckId, d.label AS deck, d.user_id AS owner,
               HEX(dc.card_id) AS cardId, dc.qty, dc.sideboard
        FROM Deck_Cards dc
        LEFT JOIN Cards c ON c.id = dc.card_id
        JOIN Decks d ON d.id = dc.deck_id
        WHERE dc.card_id IS NOT NULL AND c.id IS NULL
        ORDER BY d.label, dc.card_id`);
    report.slots = slots;

    if (dryRun || (!report.orphaned && !report.nullCard)){
        return report;
    }

    await withTransaction(conn, async () => {
        for (const table of tables){
            await conn.query(`DELETE t FROM ${table} t LEFT JOIN Cards c ON c.id = t.card_id WHERE c.id IS NULL`);
        }
        // A NULL here is a deck with no commander, which is legitimate, so only
        // the orphan shape is cleared.
        for (const column of DECK_CARD_COLUMNS){
            const [upd] = await conn.query(`
                UPDATE Decks d LEFT JOIN Cards c ON c.id = d.${column}
                SET d.${column} = NULL
                WHERE d.${column} IS NOT NULL AND c.id IS NULL`);
            report.references += upd.affectedRows;
        }
    });
    report.deleted = true;
    return report;
}

module.exports = { importCard, pruneWithdrawn, pruneOrphans, MAX_WITHDRAWN_SHARE };
