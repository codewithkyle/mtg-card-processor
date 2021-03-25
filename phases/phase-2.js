const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");

const { getDirectories, delay } = require("../lib/utils");
const { downloadImage } = require("../lib/download");

module.exports = async () => {
    clear();
    console.log("🚀 Launching MTG Image Downloader");
    let cards = await getDirectories(cardsDir);
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    bar.start(cards.length, 0);
    for (const dir of cards){
        try {
            const data = await (await fs.promises.readFile(path.join(dir, "card.json"))).toString();
            const card = JSON.parse(data);
            if (card.front && !fs.existsSync(path.join(dir, "front.png"))){
                await delay();
                await downloadImage(card.front, path.join(dir, "front.png"));
            }
            if (card.back && !fs.existsSync(path.join(dir, "back.png"))){
                await delay();
                await downloadImage(card.back, path.join(dir, "back.png"));
            }
        } catch (error){
            console.log(`🚨 Failed to open card at ${dir}`);
        }
        bar.increment();
    }
    bar.stop();
    console.log("✔️  Finished downloading MTG card images");
}