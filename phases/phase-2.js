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
            const data = (await fs.promises.readFile(path.join(dir, "card.json"))).toString();
            const card = JSON.parse(data);

            let frontImages = (await fs.promises.readFile(path.join(dir, "front-images"), { encoding: "utf8" }));
            frontImages = frontImages.split("\n");
            for (const img of frontImages) {
                if (!img.length) continue;
                const [status, date, url] = img.split("|");
                if (!fs.existsSync(path.join(dir, `${date}-front.png`))){
                    await delay();
                    await downloadImage(url, path.join(dir, `${date}-front.png`));
                }
            }

            if (card.back) {
                let backImages = (await fs.promises.readFile(path.join(dir, "back-images"), { encoding: "utf8" }));
                backImages = backImages.split("\n");
                for (const img of backImages) {
                    if (!img.length) continue;
                    const [status, date, url] = img.split("|");
                    if (!fs.existsSync(path.join(dir, `${date}-back.png`))){
                        await delay();
                        await downloadImage(url, path.join(dir, `${date}-back.png`));
                    }
                }
            }

            if (card.art && !fs.existsSync(path.join(dir, "art.png"))){
                await delay();
                await downloadImage(card.art, path.join(dir, "art.png"));
            }
        } catch (error){
            console.log(`🚨 Failed to open card at ${dir}`);
        }
        bar.increment();
    }
    bar.stop();
    console.log("✔️  Finished downloading MTG card images");
}
