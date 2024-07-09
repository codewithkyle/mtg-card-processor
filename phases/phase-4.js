const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');
const { exec } = require("node:child_process");

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");

const { getDirectories } = require("../lib/utils");

const errorFile = path.join(cwd, "image-errors");

module.exports = async () => {
    clear();
    console.log("🚀 Launching MTG Card Image Converter");
    let cards = await getDirectories(cardsDir);
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    bar.start(cards.length, 0);
    for (const dir of cards){
        try {

            let frontImages = (await fs.promises.readFile(path.join(dir, "front-images"), { encoding: "utf8" }));
            frontImages = frontImages.split("\n");
            for (const img of frontImages) {
                if (!img.length) continue;
                const [date, url] = img.split("|");
                const frontImg = path.join(dir, `${date}-front.png`);
                if (fs.existsSync(frontImg)){
                    exec(`cwebp -q 80 ${frontImg} -o ${path.join(dir, `${date}-front.webp`)}`, (err, stdout, stderr)=>{
                        if (stderr?.length) fs.appendFileSync(errorFile, `${stderr} - ${frontImg}\n`);
                    });
                }
            }

            if (card.back) {
                let backImages = (await fs.promises.readFile(path.join(dir, "back-images"), { encoding: "utf8" }));
                backImages = backImages.split("\n");
                for (const img of backImages) {
                    if (!img.length) continue;
                    const [date, url] = img.split("|");
                    const backImg = path.join(dir, `${date}-back.png`);
                    if (fs.existsSync(backImg)){
                        exec(`cwebp -q 80 ${backImg} -o ${path.join(dir, `${date}-back.webp`)}`, (err, stdout, stderr)=>{
                            if (stderr?.length) fs.appendFileSync(errorFile, `${stderr} - ${backImg}\n`);
                        });
                    }
                }
            }

            if (fs.existsSync(path.join(dir, "art.png"))){
                exec(`cwebp -q 80 ${path.join(dir, "art.png")} -o ${path.join(dir, "art.webp")}`, (err, stdout, stderr)=>{
                    if (stderr?.length) fs.appendFileSync(errorFile, `${stderr} - ${path.join(dir, "art.png")}\n`);
                });
            }
        } catch (error){
            console.log(`🚨 Card issue at ${dir}`);
        }
        bar.increment();
    }
    bar.stop();
    console.log("✔️  MTG card and image validation completed");
}
