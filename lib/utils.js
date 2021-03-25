const fs = require('fs');
const path = require("path");

function prep (outDir) {
    if (!fs.existsSync(outDir)){
        fs.mkdirSync(outDir);
        console.log(`✔️  Created output directory`);
    }
}

function delay() {
    return new Promise((resolve) => {
        // Just following the rules ¯\_(ツ)_/¯
        setTimeout(resolve, 100);
    });
}

async function getDirectories(basePath){
    let dirs = []
    const files = await fs.promises.readdir(basePath);
    for (const file of files) {
        const filePath = path.join(basePath, file);
        if ((await fs.promises.stat(filePath)).isDirectory()) {
            dirs = [...dirs, filePath];
        }
    }
    return dirs;
}

function checkCardValidity(card){
    const blockedLayouts = ["art_series"];
    const blockedTypes = ["Card"];
    if (card?.lang?.toLowerCase() !== "en"){
        return false;
    } else if (card.name.match(/(World\sChampionship\sAd)|(World\sChampionships\sAd)/i)){
        return false;
    } else if (blockedLayouts.includes(card?.layout)){
        return false;
    } else if (!card?.["full_art"] && ["plains", "swamp", "forest", "island", "mountain"].includes(card.name.toLowerCase())){
        return false;
    }
    const types = card?.["type_line"]?.split("—") ?? [];
    if (types.length){
        const type = types[0].trim();
        if (blockedTypes.includes(type)){
            return false;
        }
    }
    return true;
}

module.exports = { prep, delay, getDirectories, checkCardValidity };