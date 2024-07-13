const fetch = require('node-fetch');
const fs = require('fs');

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

module.exports = { downloadImage, downloadData };
