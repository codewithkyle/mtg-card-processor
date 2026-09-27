const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");

const { getDirectories, delay } = require("../lib/utils");
const { downloadImage } = require("../lib/download");
const { loadSpacesIndex, imageKey, artKey } = require("../lib/spaces");

// Walks a side's manifest, fetching only what is neither in Spaces nor already
// on disk. An image that is already in Spaces is marked "old" on the way past,
// so phase 5 knows not to upload a file we deliberately never downloaded.
async function syncImages(dir, card, side, spaces, stats){
    const manifest = path.join(dir, `${side}-images`);
    const images = (await fs.promises.readFile(manifest, { encoding: "utf8" })).split("\n");
    const lines = [];
    let changed = false;
    for (const img of images) {
        if (!img.length) continue;
        const [state, date, url] = img.split("|");
        const file = path.join(dir, `${date}-${side}.png`);
        let resolved = state;
        if (spaces.has(imageKey(card, date, side))){
            resolved = "old";
            stats.inSpaces++;
        } else if (fs.existsSync(file)){
            stats.onDisk++;
        } else {
            await delay();
            await downloadImage(url, file);
            stats.downloaded++;
        }
        if (resolved !== state){
            changed = true;
        }
        lines.push(`${resolved}|${date}|${url}`);
    }
    if (changed){
        await fs.promises.writeFile(manifest, lines.length ? `${lines.join("\n")}\n` : "");
    }
}

module.exports = async (refresh = false) => {
    clear();
    console.log("🚀 Launching MTG Image Downloader");
    const spaces = await loadSpacesIndex(refresh);
    let cards = await getDirectories(cardsDir);
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    const stats = { downloaded: 0, inSpaces: 0, onDisk: 0 };
    bar.start(cards.length, 0);
    for (const dir of cards){
        try {
            const data = (await fs.promises.readFile(path.join(dir, "card.json"))).toString();
            const card = JSON.parse(data);

            await syncImages(dir, card, "front", spaces, stats);

            if (card.back) {
                await syncImages(dir, card, "back", spaces, stats);
            }

            if (card.art){
                if (spaces.has(artKey(card))){
                    stats.inSpaces++;
                } else if (fs.existsSync(path.join(dir, "art.png"))){
                    stats.onDisk++;
                } else {
                    await delay();
                    await downloadImage(card.art, path.join(dir, "art.png"));
                    stats.downloaded++;
                }
            }
        } catch (error){
            console.log(`🚨 Failed to open card at ${dir}`);
            console.log(error);
        }
        bar.increment();
    }
    bar.stop();
    console.log("✔️  Finished downloading MTG card images");
    console.log(`   ⬇️  downloaded from Scryfall: ${stats.downloaded}`);
    console.log(`   ☁️  already in Spaces:        ${stats.inSpaces}`);
    console.log(`   💾 already on disk:          ${stats.onDisk}`);
}
