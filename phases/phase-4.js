const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");

const { getDirectories } = require("../lib/utils");
const { uploadCardData } = require("../lib/upload");

module.exports = async () => {
    clear();
    console.log("🚀 Launching MTG Card Feeder");
    let cards = await getDirectories(cardsDir);
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    const errors = [];
    bar.start(cards.length, 0);
    for (const dir of cards){
        try {
            const data = await (await fs.promises.readFile(path.join(dir, "card.json"))).toString();
            const card = JSON.parse(data);
            const frontImage = path.join(dir, "front.png");
            const backImage = path.join(dir, "back.png");
            await uploadCardData(card, frontImage, backImage);
            await fs.promises.rmdir(dir, { recursive: true });
        } catch (error){
            console.log(error);
            process.exit(1);
        }
        bar.increment();
    }
    bar.stop();
    console.log("✔️  MTG cards have been fed into the DB.");
    if (errors.length){
        console.log(errors);
    }
}