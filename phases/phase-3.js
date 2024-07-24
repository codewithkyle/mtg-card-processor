const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");

const { getDirectories } = require("../lib/utils");

module.exports = async () => {
    clear();
    console.log("🚀 Launching MTG Card Validator");
    let cards = await getDirectories(cardsDir);
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    bar.start(cards.length, 0);
    for (const dir of cards){
        try {
            const data = (await fs.promises.readFile(path.join(dir, "card.json"))).toString();
            const card = JSON.parse(data);

            let frontImages = (await fs.promises.readFile(path.join(dir, "front-images"), { encoding: "utf8" }));
            frontImages = frontImages.split("\n");
            for (const img of frontImages) {
                if (!img.length) continue;
                const [state, date, url] = img.split("|");
                if (!fs.existsSync(path.join(dir, `${date}-front.png`))){
                    console.log(`⚠️  ${card.name} #${date} is missing the front image`);
                }
            }

            if (card.back) {
                let backImages = (await fs.promises.readFile(path.join(dir, "back-images"), { encoding: "utf8" }));
                backImages = backImages.split("\n");
                for (const img of backImages) {
                    if (!img.length) continue;
                    const [state, date, url] = img.split("|");
                    if (!fs.existsSync(path.join(dir, `${date}-back.png`))){
                        console.log(`⚠️  ${card.name} #${date} is missing the back image`);
                    }
                }
            }

            if (card.art !== null && !fs.existsSync(path.join(dir, "art.png"))){
                console.log(`⚠️  ${card.name} is missing the art image`);
            }
        } catch (error){
            console.log(`🚨 Missing card data at ${dir}`);
        }
        bar.increment();
    }
    bar.stop();
    console.log("✔️  MTG card and image validation completed");
}
