const { v4: uuidv4 } = require('uuid');
const { colors, rarities } = require("./constants");

const MAX_RETRIES = 100;
const RETRY_DELAY = 1000; // milliseconds
const MAX_RETRY_DELAY = 5000; // milliseconds

// Card_Prints rows are written in batches rather than one statement per card,
// because a heavily reprinted card carries a few hundred printings and a card
// like Lightning Bolt would otherwise cost a round trip each.
const PRINT_BATCH = 250;

function hex(uuid){
    return uuid.replace(/-/g, "").toUpperCase();
}

async function executeTransaction(conn, query, values) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            await conn.beginTransaction();
            await conn.query(query, values);
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
    await executeTransaction(conn, query, [
        card.id,
        card.oracleId.replace(/-/g, ""),
        card.name,
        ...cardParams(card),
    ]);
}

async function updateCard(conn, card){
    const query = `UPDATE Cards SET name = ?, ${CARD_COLUMNS.map((column) => `${column} = ?`).join(", ")} WHERE id = UNHEX(?)`;
    await executeTransaction(conn, query, [card.name, ...cardParams(card), card.id]);
}

async function purgeTables(conn, card){
    const tables = ["Card_Subtypes", "Card_Keywords", "Card_Flavor_Text", "Card_Texts", "Card_Names", "Card_Colors"];
    for (const table of tables){
        await executeTransaction(conn, `DELETE FROM ${table} WHERE card_id = UNHEX(?)`, [card.id]);
    }
}

// Each of these tables is a plain list hanging off a card, so they are all
// rebuilt the same way: the card's rows are gone by the time this runs.
async function insertList(conn, table, column, card, values){
    if (!values.length) return;
    const params = [];
    const segments = [];
    for (const value of values){
        params.push(hex(uuidv4()), card.id, value);
        segments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    await executeTransaction(
        conn,
        `INSERT INTO ${table} (id, card_id, ${column}) VALUES ${segments.join(", ")}`,
        params,
    );
}

// One row per printing, addressed by the id Scryfall already gave it.
//
// That id is what makes a re-run an update instead of a second copy of the
// catalogue, which the random uuid the previous importer generated could never
// be. Nothing is deleted here: rows written before the hashes existed keep a
// NULL front_hash and stay until Deck_Cards has been migrated off release
// dates, which is what phase 5 --prune is for.
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
        await executeTransaction(conn, query, params);
    }
}

// The id this card will be written under. Resolved before anything is
// uploaded, because the art object is still named for the card rather than for
// a printing and the caller needs the id to address it.
async function resolveOrCreateId(conn, oracleId){
    const existing = await resolveCardId(conn, oracleId);
    return { id: existing ?? hex(uuidv4()), created: existing === null };
}

// Writes one card and everything hanging off it. The caller has already
// uploaded the images for the printings in rows, so a row reaching here is one
// whose object is known to be in the bucket - which is what lets a NULL
// front_hash mean "not done yet" on the next run.
async function importCard(conn, card, printRows, created){
    if (created){
        await insertCard(conn, card);
    } else {
        await updateCard(conn, card);
    }

    await purgeTables(conn, card);
    await insertList(conn, "Card_Colors", "color_id", card, card.colors.map((color) => colors[color]).filter(Boolean));
    await insertList(conn, "Card_Names", "name", card, card.faceNames);
    await insertList(conn, "Card_Texts", "text", card, card.texts);
    await insertList(conn, "Card_Flavor_Text", "text", card, card.flavorTexts);
    await insertList(conn, "Card_Keywords", "keyword", card, card.keywords);
    await insertList(conn, "Card_Subtypes", "subtype", card, card.subtypes);
    await upsertCardPrints(conn, card, printRows);
}

module.exports = { importCard, resolveOrCreateId, executeTransaction };
