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
            if (fs.existsSync(path.join(dir, "front.png"))){
                exec(`cwebp -q 80 ${path.join(dir, "front.png")} -o ${path.join(dir, "front.webp")}`, (err, stdout, stderr)=>{
                    if (stderr?.length) fs.appendFileSync(errorFile, `${path.join(dir, "front.png")}\n`);
                });
            }
            if (fs.existsSync(path.join(dir, "back.png"))){
                exec(`cwebp -q 80 ${path.join(dir, "back.png")} -o ${path.join(dir, "back.webp")}`, (err, stdout, stderr)=>{
                    if (stderr?.length) fs.appendFileSync(errorFile, `${path.join(dir, "back.png")}\n`);
                });
            }
            if (fs.existsSync(path.join(dir, "art.png"))){
                exec(`cwebp -q 80 ${path.join(dir, "art.png")} -o ${path.join(dir, "art.webp")}`, (err, stdout, stderr)=>{
                    if (stderr?.length) fs.appendFileSync(errorFile, `${path.join(dir, "art.png")}\n`);
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
