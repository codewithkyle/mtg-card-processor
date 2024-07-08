const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { colors, rarities } = require("../lib/constants");

clear();
console.log("🚀 Launching MTG Card Uploader");

console.log("🔌 Connecting to database");
const mysql = require('mysql2')
const connection = mysql.createConnection(process.env.DSN);
connection.connect();

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");

const { getDirectories } = require("../lib/utils");
const { uploadImage } = require("../lib/upload");

function reportError(error, card){
    console.log("🚨 Error:");
    console.log(error);
    console.log(card);
    process.exit(1);
}

let cards;
//const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

async function write(dir) {
    const data = await fs.promises.readFile(path.join(dir, "card.json"), { encoding: "utf-8" });
    const card = JSON.parse(data);

    const oldCard = await new Promise((resolve, reject) => {
        connection.query(`SELECT name, HEX(id) as id, HEX(oracle_id) as oracleId FROM Cards WHERE id = UNHEX('${card.id}') AND oracle_id IS NULL`, (err, results) => {
            if (err) reject(err);
            resolve(results?.[0] ?? null);
        });
    });
    if (oldCard === null) {
        console.log("New: ", card.name);
        card.id = uuidv4().replace(/-/g, "");
    } else {
        console.log("Found card: ", oldCard.name);
    }

    if (card.front !== null){
        await uploadImage(card, "front.webp");
        card.front = `https://divinedrop.nyc3.cdn.digitaloceanspaces.com/cards/${card.id}-front.webp`;
    }
    
    if (card.back !== null){
        await uploadImage(card, "back.webp");
        card.back = `https://divinedrop.nyc3.cdn.digitaloceanspaces.com/cards/${card.id}-back.webp`;
    }

    if (card.art !== null){
        await uploadImage(card, "art.webp");
        card.art = `https://divinedrop.nyc3.cdn.digitaloceanspaces.com/cards/${card.id}-art.webp`;
    }

    try {
        if (oldCard === null) {
            insertCard(card);
        } else {
            updateCard(card);
        }
        purgeTables(card);
        insertCardColors(card);
        insertCardNames(card);
        insertCardTexts(card);
        insertCardFlavorTexts(card);
        insertCardKeywords(card);
        insertCardSubtypes(card);
    } catch (error){
        reportError(error, card);
    }
}

function purgeTables(card){
    const tables = ["Card_Subtypes", "Card_Keywords", "Card_Flavor_Text", "Card_Texts", "Card_Names", "Card_Colors"];
    for (const table of tables){
        connection.query(
            `DELETE FROM ${table} WHERE card_id = UNHEX(?)`,
            [card.id],
            (error) => {
                if (error) {
                    reportError(error, card);
                }
            }
        );
    }
}

function insertCardSubtypes(card){
    if (!card.subtypes.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const subtype of card.subtypes){
        values.push(uuidv4().replace(/-/g, ""), card.id, subtype);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    connection.query(
        `INSERT INTO Card_Subtypes (id, card_id, subtype) VALUES ${querySegments.join(", ")}`,
        values, 
        (error) => {
            if (error) {
                reportError(error, card);
            }
        }
    );
}

function insertCardKeywords(card){
    if (!card.keywords.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const keyword of card.keywords){
        values.push(uuidv4().replace(/-/g, ""), card.id, keyword);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    connection.query(
        `INSERT INTO Card_Keywords (id, card_id, keyword) VALUES ${querySegments.join(", ")}`,
        values, 
        (error) => {
            if (error) {
                reportError(error, card);
            }
        }
    );
}

function insertCardFlavorTexts(card){
    if (!card.flavorTexts.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const text of card.flavorTexts){
        values.push(uuidv4().replace(/-/g, ""), card.id, text);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    connection.query(
        `INSERT INTO Card_Flavor_Text (id, card_id, text) VALUES ${querySegments.join(", ")}`,
        values, 
        (error) => {
            if (error) {
                reportError(error, card);
            }
        }
    );
}

function insertCardTexts(card){
    if (!card.texts.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const text of card.texts){
        values.push(uuidv4().replace(/-/g, ""), card.id, text);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    connection.query(
        `INSERT INTO Card_Texts (id, card_id, text) VALUES ${querySegments.join(", ")}`,
        values, 
        (error) => {
            if (error) {
                reportError(error, card);
            }
        }
    );
}

function insertCardNames(card){
    if (!card.faceNames.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const name of card.faceNames){
        values.push(uuidv4().replace(/-/g, ""), card.id, name);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    connection.query(
        `INSERT INTO Card_Names (id, card_id, name) VALUES ${querySegments.join(", ")}`,
        values, 
        (error) => {
            if (error) {
                reportError(error, card);
            }
        }
    );
}

function insertCardColors(card){
    if (!card.colors.length){
        return;
    }
    const values = [];
    const querySegments = [];
    for (const color of card.colors){
        values.push(uuidv4().replace(/-/g, ""), card.id, colors[color]);
        querySegments.push("(UNHEX(?), UNHEX(?), ?)");
    }
    connection.query(
        `INSERT INTO Card_Colors (id, card_id, color_id) VALUES ${querySegments.join(", ")}`,
        values, 
        (error) => {
            if (error) {
                reportError(error, card);
            }
        }
    );
}

function updateCard(card){
    console.log("Updating: ", card.name);
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
    const query = `UPDATE Cards SET oracle_id = UNHEX(?), layout = ?, front = ?, back = ?, art = ?, rarity = ?, type = ?, toughness = ?, power = ?, manaCost = ?, totalManaCost = ?, standard = ?, future = ?, historic = ?, gladiator = ?, pioneer = ?, explorer = ?, modern = ?, legacy = ?, pauper = ?, vintage = ?, penny = ?, commander = ?, oathbreaker = ?, brawl = ?, historicbrawl = ?, alchemy = ?, paupercommander = ?, duel = ?, oldschool = ?, premodern = ?, predh = ? WHERE id = UNHEX(?)`;
    const params = [
        card.oracleId.replace(/-/g, ""),
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
    connection.query(query, params, (error) => {
        if (error) {
            console.log(error);
            reportError(error, card);
        }
    });
}

function insertCard(card){
    console.log("Inserting: ", card.name);
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
    const query = `INSERT INTO Cards (id, oracle_id, name, layout, front, back, art, rarity, type, toughness, power, manaCost, totalManaCost, standard, future, historic, gladiator, pioneer, explorer, modern, legacy, pauper, vintage, penny, commander, oathbreaker, brawl, historicbrawl, alchemy, paupercommander, duel, oldschool, premodern, predh) VALUES (UNHEX(?), UNHEX(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
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
    ];
    connection.query(query, params, (error) => {
        if (error) {
            reportError(error, card);
        }
    });
}

module.exports = async () => {
    console.log("🚀 Updating cards database");
    cards = await getDirectories(cardsDir);
    const errors = [];
    //bar.start(cards.length, 0);
    for (const dir of cards){
        try {
            await write(dir);
        } catch (error){
            errors.push(error);
        }
        //bar.increment();
    }
    //bar.stop();
    console.log("✔️  Finished importing cards");
    if (errors.length){
        console.log("🚨 Errors:");
        for (const error of errors){
            console.log(error);
        }
    }
}
