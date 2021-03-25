const fetch = require('node-fetch');
const fs = require('fs');
const { delay } = require("./utils");
const path = require("path");

async function downloadData(id){
    const request = await fetch(`https://api.scryfall.com/cards/${id}?format=json`, {
        redirect: "follow",
        method: "GET",
    });
    let response = null;
    if (request.ok){
        response = await request.json();
    } else {
        if (request.status === 429){
            console.log("HTTP 429 recieved. Stopping so we don't get banned.");
            process.exit(1);
        }
    }
    return response;
}

async function downloadImage(url, file) {
    const response = await fetch(url, {
        redirect: "follow",
        method: "GET"
    });
    const buffer = await response.buffer();
    await fs.promises.writeFile(file, buffer);
    return;
}

async function downloadCard(card){
    if (card.front){
        const frontPath = path.join(card.dir, `front.jpg`);
        if (fs.existsSync(path.join(card.dir, "front.jpg"))){
            await fs.promises.unlink(path.join(card.dir, "front.jpg"));
        }
        await delay();
        await downloadImage(card.front, frontPath);
    }
    if (card.back){
        const backPath = path.join(card.dir, `back.jpg`);
        if (fs.existsSync(path.join(card.dir, "back.jpg"))){
            await fs.promises.unlink(path.join(card.dir, "back.jpg"));
        }
        await delay();
        await downloadImage(card.back, backPath);
    }
    return;
}

module.exports = { downloadImage, downloadData, downloadCard };