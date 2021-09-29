const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");

const { getDirectories } = require("../lib/utils");
const { uploadCardData } = require("../lib/upload");

const outFile = path.join(cwd, "cards.ndjson");
if (fs.existsSync(outFile)){
    fs.unlinkSync(outFile);
}

module.exports = async () => {
    clear();
    console.log("🚀 Launching MTG Card Feeder");
    let cards = await getDirectories(cardsDir);
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    const errors = [];
    bar.start(cards.length, 0);
    for (const dir of cards){
        try {
            const data = await fs.promises.readFile(path.join(dir, "card.json"), { encoding: "utf-8" });
            //const card = JSON.parse(data);
            await fs.promises.writeFile(outFile, `${data}\n`, { flag: "a" });
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
