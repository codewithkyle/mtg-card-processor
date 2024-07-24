const fs = require("fs");
const path = require("path");
const { parentPort, workerData } = require("worker_threads");
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const { colors, rarities } = require("../lib/constants");
const { uploadImage, deleteImage } = require("../lib/upload");

const MAX_RETRIES = 100;
const RETRY_DELAY = 1000; // milliseconds

let connection
mysql.createConnection(workerData.DSN).then((conn)=>{
    connection = conn;
    parentPort.postMessage({
        type: "READY",
    });
});

async function write(dir) {
    const data = await fs.promises.readFile(path.join(dir, "card.json"), { encoding: "utf-8" });
    const card = JSON.parse(data);

    const results = (await connection.query(`SELECT name, HEX(id) as id, HEX(oracle_id) as oracleId FROM Cards WHERE oracle_id = UNHEX('${card.oracleId.replace(/-/g, "")}')`))?.[0] ?? null;
    const oldCard = results?.[0] ?? null;
    if (oldCard === null) {
        card.id = uuidv4().replace(/-/g, "");
    } else {
        card.id = oldCard.id;
    }

    let frontImages = (await fs.promises.readFile(path.join(dir, "front-images"), { encoding: "utf8" }));
    frontImages = frontImages.split("\n");
    for (const img of frontImages) {
        if (!img.length) continue;
        const [state, date, url] = img.split("|");
        if (state === "new") {
            const file = `${date}-front.png`;
            const frontImg = `${date.replace(/-/g, "")}-front.png`;
            uploadImage(card, frontImg, file);
        }
    }

    if (card.back) {
        let backImages = (await fs.promises.readFile(path.join(dir, "back-images"), { encoding: "utf8" }));
        backImages = backImages.split("\n");
        for (const img of backImages) {
            if (!img.length) continue;
            const [state, date, url] = img.split("|");
            if (state === "new") {
                const file = `${date}-back.png`;
                const backImg = `${date.replace(/-/g, "")}-back.png`;
                uploadImage(card, backImg, file);
            }
        }
    }

    card.front = `https://divinedrop.nyc3.cdn.digitaloceanspaces.com/cards/${card.id}-${card.date.replace(/-/g, "")}-front.png`;

    if (card.back !== null){
        card.back = `https://divinedrop.nyc3.cdn.digitaloceanspaces.com/cards/${card.id}-${card.date.replace(/-/g, "")}-back.png`;
    }

    if (card.art !== null){
        uploadImage(card, "art.png", "art.png");
        card.art = `https://divinedrop.nyc3.cdn.digitaloceanspaces.com/cards/${card.id}-art.png`;
    }

    if (oldCard === null) {
        await insertCard(card);
    } else {
        await updateCard(card);
    }
    await purgeTables(card);
    await insertCardColors(card);
    await insertCardNames(card);
    await insertCardTexts(card);
    await insertCardFlavorTexts(card);
    await insertCardKeywords(card);
    await insertCardSubtypes(card);
    await insertCardPrints(card, frontImages);
}

async function purgeTables(card){
    const tables = ["Card_Subtypes", "Card_Keywords", "Card_Flavor_Text", "Card_Texts", "Card_Names", "Card_Colors"];
    for (const table of tables){
        const query = `DELETE FROM ${table} WHERE card_id = UNHEX(?)`;
        await executeTransaction(query, [card.id]);
    }
}

async function insertCardPrints(card, images){
    if (!images.length) return;
    const values = [];
    const querySegments = [];
    for (const img of images){
        if (!img.length) continue;
        const [state, date, url] = img.split("|");
        if (state === "new") {
            values.push(uuidv4().replace(/-/g, ""), card.id, +date.replace(/-/g, ""));
            querySegments.push("(UNHEX(?), UNHEX(?), ?)");
        }
    }
    if (!querySegments.length) return;
    const query = `INSERT INTO Card_Prints (id, card_id, released) VALUES ${querySegments.join(", ")}`;
    await executeTransaction(query, values);
}

async function insertCardSubtypes(card){
    if (!card.subtypes.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const subtype of card.subtypes){
        values.push(uuidv4().replace(/-/g, ""), card.id, subtype);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    const query = `INSERT INTO Card_Subtypes (id, card_id, subtype) VALUES ${querySegments.join(", ")}`;
    await executeTransaction(query, values);
}

async function insertCardKeywords(card){
    if (!card.keywords.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const keyword of card.keywords){
        values.push(uuidv4().replace(/-/g, ""), card.id, keyword);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    const query = `INSERT INTO Card_Keywords (id, card_id, keyword) VALUES ${querySegments.join(", ")}`;
    await executeTransaction(query, values);
}

async function insertCardFlavorTexts(card){
    if (!card.flavorTexts.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const text of card.flavorTexts){
        values.push(uuidv4().replace(/-/g, ""), card.id, text);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    const query = `INSERT INTO Card_Flavor_Text (id, card_id, text) VALUES ${querySegments.join(", ")}`;
    await executeTransaction(query, values);
}

async function insertCardTexts(card){
    if (!card.texts.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const text of card.texts){
        values.push(uuidv4().replace(/-/g, ""), card.id, text);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    const query = `INSERT INTO Card_Texts (id, card_id, text) VALUES ${querySegments.join(", ")}`;
    await executeTransaction(query, values);
}

async function insertCardNames(card){
    if (!card.faceNames.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const name of card.faceNames){
        values.push(uuidv4().replace(/-/g, ""), card.id, name);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    const query = `INSERT INTO Card_Names (id, card_id, name) VALUES ${querySegments.join(", ")}`;
    await executeTransaction(query, values);
}

async function insertCardColors(card){
    if (!card.colors.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const color of card.colors){
        values.push(uuidv4().replace(/-/g, ""), card.id, colors[color]);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    const query = `INSERT INTO Card_Colors (id, card_id, color_id) VALUES ${querySegments.join(", ")}`;
    await executeTransaction(query, values);
}

async function updateCard(card){
    try {
        card.power = parseInt(card.power);
        if (isNaN(card.power)){
            card.power = null;
        }
    } catch (error){
        card.power = null;
    }
    try {
        card.toughness = parseInt(card.toughness);
        if (isNaN(card.toughness)){
            card.toughness = null;
        }
    } catch (error){
        card.toughness = null;
    }
    let price = card.price || card.tix || 100;
    let edhRank = card.edhRank === null ? 99999 : card.edhRank;
    const query = `UPDATE Cards SET edh_rank = ?, set_name = ?, price = ?, layout = ?, front = ?, back = ?, art = ?, rarity = ?, type = ?, toughness = ?, power = ?, manaCost = ?, totalManaCost = ?, standard = ?, future = ?, historic = ?, gladiator = ?, pioneer = ?, explorer = ?, modern = ?, legacy = ?, pauper = ?, vintage = ?, penny = ?, commander = ?, oathbreaker = ?, brawl = ?, historicbrawl = ?, alchemy = ?, paupercommander = ?, duel = ?, oldschool = ?, premodern = ?, predh = ? WHERE id = UNHEX(?)`;
    const params = [
        edhRank,
        card.set,
        price,
        card.layout,
        card.front,
        card.back,
        card.art,
        rarities?.[card.rarity] ?? null,
        card.type,
        card.toughness,
        card.power,
        card.manaCost?.[0] ?? null,
        card.totalManaCost,
        card.legalities?.standard ? 1 : 0,
        card.legalities?.future ? 1 : 0,
        card.legalities?.historic ? 1 : 0,
        card.legalities?.gladiator ? 1 : 0,
        card.legalities?.pioneer ? 1 : 0,
        card.legalities?.explorer ? 1 : 0,
        card.legalities?.modern ? 1 : 0,
        card.legalities?.legacy ? 1 : 0,
        card.legalities?.pauper ? 1 : 0,
        card.legalities?.vintage ? 1 : 0,
        card.legalities?.penny ? 1 : 0,
        card.legalities?.commander ? 1 : 0,
        card.legalities?.oathbreaker ? 1 : 0,
        card.legalities?.brawl ? 1 : 0,
        card.legalities?.historicbrawl ? 1 : 0,
        card.legalities?.alchemy ? 1 : 0,
        card.legalities?.paupercommander ? 1 : 0,
        card.legalities?.duel ? 1 : 0,
        card.legalities?.oldschool ? 1 : 0,
        card.legalities?.premodern ? 1 : 0,
        card.legalities?.predh ? 1 : 0,
        card.id,
    ];
    await executeTransaction(query, params);
}

async function insertCard(card){
    try {
        card.power = parseInt(card.power);
        if (isNaN(card.power)){
            card.power = null;
        }
    } catch (error){
        card.power = null;
    }
    try {
        card.toughness = parseInt(card.toughness);
        if (isNaN(card.toughness)){
            card.toughness = null;
        }
    } catch (error){
        card.toughness = null;
    }
    let price = card.price || card.tix || 100;
    let edhRank = card.edhRank === null ? 99999 : card.edhRank;
    const query = `INSERT INTO Cards (id, oracle_id, name, layout, front, back, art, rarity, type, toughness, power, manaCost, totalManaCost, standard, future, historic, gladiator, pioneer, explorer, modern, legacy, pauper, vintage, penny, commander, oathbreaker, brawl, historicbrawl, alchemy, paupercommander, duel, oldschool, premodern, predh, edh_rank, price, set_name) VALUES (UNHEX(?), UNHEX(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [
        card.id,
        card.oracleId.replace(/-/g, ""),
        card.name,
        card.layout,
        card.front,
        card.back,
        card.art,
        rarities?.[card.rarity] ?? null,
        card.type,
        card.toughness,
        card.power,
        card.manaCost?.[0] ?? null,
        card.totalManaCost,
        card.legalities.standard ? 1 : 0,
        card.legalities.future ? 1 : 0,
        card.legalities.historic ? 1 : 0,
        card.legalities.gladiator ? 1 : 0,
        card.legalities.pioneer ? 1 : 0,
        card.legalities.explorer ? 1 : 0,
        card.legalities.modern ? 1 : 0,
        card.legalities.legacy ? 1 : 0,
        card.legalities.pauper ? 1 : 0,
        card.legalities.vintage ? 1 : 0,
        card.legalities.penny ? 1 : 0,
        card.legalities.commander ? 1 : 0,
        card.legalities.oathbreaker ? 1 : 0,
        card.legalities.brawl ? 1 : 0,
        card.legalities.historicbrawl ? 1 : 0,
        card.legalities.alchemy ? 1 : 0,
        card.legalities.paupercommander ? 1 : 0,
        card.legalities.duel ? 1 : 0,
        card.legalities.oldschool ? 1 : 0,
        card.legalities.premodern ? 1 : 0,
        card.legalities.predh ? 1 : 0,
        edhRank,
        price,
        card.set,
    ];
    await executeTransaction(query, params);
}

async function executeTransaction(query, values) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            await connection.beginTransaction();
            await connection.query(query, values);
            await connection.commit();
            break; // exit loop if successful
        } catch (error) {
            if (error.sqlState === '40001') { // Deadlock detected
                await connection.rollback();
                if (attempt < MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (2 ** attempt))); // exponential backoff
                } else {
                    throw new Error('Transaction failed after maximum retries');
                }
            } else {
                await connection.rollback();
                throw error;
            }
        }
    }
}

parentPort.addListener("message", async (dir) => {
    try{
        await write(dir);
        parentPort.postMessage({
            type: "NEXT",
        });
    } catch (e) {
        parentPort.postMessage({
            type: "ERROR",
            data: e,
        });
    }
});


