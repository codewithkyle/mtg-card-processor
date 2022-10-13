const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");

const { getDirectories } = require("../lib/utils");
const { uploadImage } = require("../lib/upload");

const outFile = path.join(cwd, "cards.ndjson");
if (fs.existsSync(outFile)){
    fs.unlinkSync(outFile);
}

let cards;
const wStream = fs.createWriteStream(outFile, { flags: "a" });
const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

function waitDrain(){
    return new Promise(resolve => {
        wStream.once("drain", resolve);
    });
}

async function write(dir) {
    const data = await fs.promises.readFile(path.join(dir, "card.json"), { encoding: "utf-8" });
    const card = JSON.parse(data);

    await uploadImage(card);

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
    console.log("🚀 Launching MTG Card NDSJON Creator");
    cards = await getDirectories(cardsDir);
    const errors = [];
    bar.start(cards.length, 0);
    for (const dir of cards){
        await write(dir);
        bar.increment();
    }
    wStream.on("close", ()=>{
        bar.stop();
        console.log("✔️  NDJSON file has been created.");
        if (errors.length){
            console.log(errors);
        }
        process.exit(0);
    });
}
