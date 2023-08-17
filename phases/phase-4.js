const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");

const { getDirectories } = require("../lib/utils");
const { uploadImage } = require("../lib/upload");

const outFile = path.join(cwd, "cards.jsonl");
if (fs.existsSync(outFile)){
    fs.unlinkSync(outFile);
}

let cards;
const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

async function write(dir) {
    const data = await fs.promises.readFile(path.join(dir, "card.json"), { encoding: "utf-8" });
    const card = JSON.parse(data);

    if (card.front !== null){
        await uploadImage(card, "front.png");
        card.front = `https://divinedrop.nyc3.cdn.digitaloceanspaces.com/cards/${card.id}-front.png`;
    }
    
    if (card.back !== null){
        await uploadImage(card, "back.png");
        card.back = `https://divinedrop.nyc3.cdn.digitaloceanspaces.com/cards/${card.id}-back.png`;
    }

    if (card.art !== null){
        await uploadImage(card, "art.png");
        card.art = `https://divinedrop.nyc3.cdn.digitaloceanspaces.com/cards/${card.id}-art.png`;
    }

    // Only needed for local processing
    delete card.dir;

    // TODO: insert / update card in database
}

module.exports = async () => {
    clear();
    console.log("🚀 Launching MTG Card JSONL Creator");
    cards = await getDirectories(cardsDir);
    const errors = [];
    bar.start(cards.length, 0);
    for (const dir of cards){
        try {
            await write(dir);
        } catch (error){
            errors.push(error);
        }
        bar.increment();
    }
    bar.stop();
    console.log("✔️  Finished importing cards");
    if (errors.length){
        console.log("🚨 Errors:");
        for (const error of errors){
            console.log(error);
        }
    }
}
