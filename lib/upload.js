const fs = require("fs");
const fetch = require('node-fetch');
require('dotenv').config();

const API_INGEST_URL = `http://api.divinedrop.local/v1/ingest/card?token=${process.env.API_AUTH_TOKEN}`;

async function uploadCardData(card, frontImage, backImage){
    const data = {
        name: card.name,
        layout: card.layout,
        colors: card.colors,
        legalities: card.legalities,
        rarity: card.rarity,
        keywords: card.keywords,
        type: card.type,
        subtypes: card.subtypes,
        text: card.texts.join("\n"),
        manaCosts: card.manaCosts,
        totalManaCost: card.totalManaCost,
        faceNames: card.faceNames,
        flavorText: card.flavorTexts.join("\n"),
        vitalitys: card.vitalitys,
        slug: card.fsFriendlyName,
        front: null,
        back: null,
    }
    if (fs.existsSync(frontImage)){
        data.front = await fs.promises.readFile(frontImage, 'base64');
    }
    if (fs.existsSync(backImage)){
        data.back = await fs.promises.readFile(backImage, 'base64');
    }
    const response = await fetch(API_INGEST_URL, {
        method: "POST",
        body: JSON.stringify(data),
        headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok){
        throw response;
    }
    return;
}

module.exports = { uploadCardData };