const path = require("path");
var clear = require('clear');
const fs = require("fs");
const { parser } = require('stream-json/jsonl/Parser');
const {chain}  = require('stream-chain');
const {glob} = require("glob");
const cliProgress = require('cli-progress');

const cwd = process.cwd();
const outDir = path.join(cwd, "cards");
const file = path.join(process.cwd(), "data.jsonl");
if (!fs.existsSync(file)){
    console.log(`Missing file at ${file}`);
    process.exit(1);
}
const { prep, checkCardValidity } = require("../lib/utils");
prep(outDir);
const processCard = require("../lib/processor");

// Written together so a half finished run leaves a card with neither file
// rather than a card.json pointing at printings that were never listed.
async function writeCard(dir, entry){
    if (!fs.existsSync(dir)){
        await fs.promises.mkdir(dir);
    }
    const looks = [...entry.looks.values()];
    const card = {
        ...entry.card,
        defaultFront: entry.defaultFront,
        defaultBack: entry.defaultBack,
        // Phase 3 checks both of these against what is actually on disk.
        lookCount: looks.length,
        printCount: looks.reduce((total, look) => total + look.prints.length, 0),
    };
    await fs.promises.writeFile(path.join(dir, "card.json"), JSON.stringify(card));
    await fs.promises.writeFile(
        path.join(dir, "prints.jsonl"),
        looks.map((look) => JSON.stringify(look)).join("\n") + "\n",
    );
}

module.exports = async () => {
    clear();
    console.log("🚀 Launching MTG Card Processor");

    console.log("🧹 Cleaning up old manifests");
    // front-images and back-images are from the release date scheme, which
    // addressed a printing by a date that four printings could share. Nothing
    // reads them any more, so they go with the rest of the old manifests.
    const stale = await glob([
        "./cards/**/card.json",
        "./cards/**/prints.jsonl",
        "./cards/**/front-images",
        "./cards/**/back-images",
    ]);
    await Promise.all(stale.map((f) => fs.promises.unlink(f)));

    const store = new Map();
    const skipped = [];
    let printCount = 0;
    let folded = 0;

    try {
        console.log(`💽 Streaming card data from ${file}`);
        const pipeline = chain([
            fs.createReadStream(file),
            parser(),
        ]);
        console.log("🤖 Grouping printings by the artwork they show");
        for await (let chunk of pipeline) {
            if (!checkCardValidity(chunk.value)){
                continue;
            }
            const result = processCard(chunk.value, store);
            if (result.skipped){
                skipped.push(result.skipped);
                continue;
            }
            printCount++;
            if (result.look === "folded"){
                folded++;
            }
            if (printCount % 10000 === 0){
                console.log(`   ...${printCount} printings, ${printCount - folded} distinct looks`);
            }
        }
    } catch (error){
        console.log(error);
        process.exit(1);
    }

    console.log(`✍️  Writing ${store.size} cards`);
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    bar.start(store.size, 0);
    for (const [oracleId, entry] of store){
        await writeCard(path.join(outDir, oracleId), entry);
        bar.increment();
    }
    bar.stop();

    // Image counts are lower than the look count, because a pair of looks can
    // share one face - see the note on the look key in lib/processor.js.
    const fronts = new Set();
    const backs = new Set();
    for (const entry of store.values()){
        for (const look of entry.looks.values()){
            fronts.add(look.hash);
            if (look.backHash) backs.add(look.backHash);
        }
    }

    console.log("✔️  MTG card processing completed");
    console.log(`   🃏 cards:          ${store.size}`);
    console.log(`   🖨️  printings:      ${printCount}`);
    console.log(`   🎨 distinct looks: ${printCount - folded}`);
    console.log(`   📦 folded away:    ${folded}`);
    console.log(`   ⬇️  images to fetch: ${fronts.size} front, ${backs.size} back, ${store.size} art`);
    for (const reason of skipped){
        console.log(`   ⚠️  skipped ${reason}`);
    }

    // The images already on disk are named for the old release date scheme and
    // none of them will be read again. Said rather than done, because it is a
    // lot of bytes to delete on the strength of a guess about what the run is
    // for.
    const oldImages = await glob("./cards/**/[0-9]*-*.png");
    if (oldImages.length){
        console.log(`   🧹 ${oldImages.length} images remain from the release date scheme.`);
        console.log(`      They are stale - remove them before phase 2 to reclaim the space.`);
    }
    process.exit(0);
}
