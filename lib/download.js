const fetch = require('node-fetch');
const fs = require('fs');
const { delay } = require('./utils');

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
    let res, buffer;
    try {
        res = await fetch(url, {
            redirect: "follow",
            method: "GET",
            keepAlive: true
        });
        if (!res.ok) throw new Error(res.statusText);
        buffer = await res.buffer();
    } catch (e) {
        if (e.code === 'ECONNRESET') {
            console.log(e);
            await delay(2000);
            console.log("retrying...");
            return downloadImage(url, file);
        }
        throw e;
    }
    await fs.promises.writeFile(file, buffer);
    return;
}

module.exports = { downloadImage, downloadData };
