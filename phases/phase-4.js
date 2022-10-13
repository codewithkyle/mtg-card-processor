const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");

const { getDirectories } = require("../lib/utils");
const { uploadImage, getImageList, uploadCardsFile } = require("../lib/upload");

const outFile = path.join(cwd, "cards.jsonl");
if (fs.existsSync(outFile)){
    fs.unlinkSync(outFile);
}

let cards;
const wStream = fs.createWriteStream(outFile, { flags: "a" });
const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
let pCards;

function waitDrain(){
    return new Promise(resolve => {
        wStream.once("drain", resolve);
    });
}

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

    // Remove unused props
    delete card.dir;
    delete card.fsFriendlyName;

    wStream.write(`${JSON.stringify(card)}\n`);
    if (wStream.writableNeedDrain){
        await waitDrain();
    }
}

module.exports = async () => {
    clear();
    console.log("🚀 Launching MTG Card JSONL Creator");
    cards = await getDirectories(cardsDir);
    const errors = [];
    bar.start(cards.length, 0);
    pCards = await getImageList();
    for (const dir of cards){
        await write(dir);
        bar.increment();
    }
    wStream.end();
    wStream.on("close", async ()=>{
        bar.stop();
        console.log("✔️  JSONL file has been created.");
        await uploadCardsFile(outFile);
        console.log("🚀 JSONL file has been uploaded.");
        if (errors.length){
            console.log(errors);
        }
        process.exit(0);
    });
}
