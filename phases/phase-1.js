const path = require("path");
var clear = require('clear');
const fs = require("fs");
const { parser } = require('stream-json/jsonl/Parser');
const {chain}  = require('stream-chain');
const cliProgress = require('cli-progress');

const cwd = process.cwd();
const outDir = path.join(cwd, "cards");
const file = path.join(process.cwd(), "data.jsonl");
const metaFile = path.join(process.cwd(), "data.meta.json");
if (!fs.existsSync(file)){
    console.log(`Missing file at ${file}`);
    console.log("Run phase 0 to download the current Scryfall export.");
    process.exit(1);
}
const { prep, checkCardValidity, getDirectories } = require("../lib/utils");
prep(outDir);
const processCard = require("../lib/processor");

// How much of the local catalogue may disappear in one run before this refuses
// to act on it. A set release adds cards and withdraws a handful; a data.jsonl
// that arrived truncated looks exactly like Magic having shrunk by a third, and
// the difference matters because acting on it deletes gigabytes of images that
// then cost another three hour download. Same reasoning and same ceiling as the
// withdrawn sweep in lib/importer.js.
const MAX_STALE_SHARE = 0.05;

function readMeta(){
    try {
        return JSON.parse(fs.readFileSync(metaFile, { encoding: "utf8" }));
    } catch (error){
        return null;
    }
}

// Written together so a half finished run leaves a card with neither file
// rather than a card.json pointing at printings that were never listed.
async function writeCard(dir, entry, source){
    if (!fs.existsSync(dir)){
        await fs.promises.mkdir(dir);
    }
    const looks = [...entry.looks.values()];
    const card = {
        ...entry.card,
        defaultFront: entry.defaultFront,
        defaultBack: entry.defaultBack,
        // Which Scryfall export this describes. Phase 3 compares it against
        // data.meta.json, so a phase 1 that died halfway is visible as the
        // stale manifests it left rather than as printings phase 2 cannot
        // download and print ids phase 5 puts in the manifest regardless.
        source,
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

async function directorySize(dir){
    let bytes = 0;
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })){
        if (entry.isFile()){
            bytes += (await fs.promises.stat(path.join(dir, entry.name))).size;
        }
    }
    return bytes;
}

module.exports = async (argv = {}) => {
    clear();
    console.log("🚀 Launching MTG Card Processor");

    const meta = readMeta();
    if (meta){
        console.log(`📚 ${meta.type} exported ${meta.updatedAt}, fetched ${meta.fetchedAt}`);
    } else {
        console.log(`📚 ${path.basename(file)} has no data.meta.json beside it, so its age is unknown`);
        console.log("   Phase 0 records that. Until then nothing can tell a fresh export from a year old one.");
    }
    const source = meta?.updatedAt ?? null;

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

    // What is already here, so the run can say what the export added and what
    // it dropped. Read before writing: afterwards every card looks current.
    const before = new Set((await getDirectories(outDir)).map((dir) => path.basename(dir)));
    const added = [...store.keys()].filter((oracleId) => !before.has(oracleId));
    const stale = [...before].filter((oracleId) => !store.has(oracleId));

    console.log(`✍️  Writing ${store.size} cards`);
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    bar.start(store.size, 0);
    for (const [oracleId, entry] of store){
        await writeCard(path.join(outDir, oracleId), entry, source);
        bar.increment();
    }
    bar.stop();

    // Cards this export no longer describes. Their directories have to go, not
    // just their manifests: every later phase walks cards/ and a directory with
    // images and no card.json is one phase 2 complains about, phase 3 counts as
    // unreadable and phase 5 records as an outright failure - so what is
    // actually an orderly withdrawal upstream reads as the pipeline breaking.
    let removed = { cards: 0, bytes: 0, refused: null };
    if (stale.length){
        const share = before.size ? stale.length / before.size : 0;
        if (share > MAX_STALE_SHARE && !argv["allow-mass-removal"]){
            removed.refused = `${stale.length} of ${before.size} local cards (${(share * 100).toFixed(1)}%) are absent from this export, over the ${(MAX_STALE_SHARE * 100).toFixed(0)}% ceiling`;
        } else {
            for (const oracleId of stale){
                const dir = path.join(outDir, oracleId);
                removed.bytes += await directorySize(dir);
                await fs.promises.rm(dir, { recursive: true, force: true });
                removed.cards++;
            }
        }
    }

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
    if (before.size){
        console.log(`   ✨ new this export: ${added.length} cards`);
    }
    if (removed.refused){
        console.log(`   🚨 ${removed.refused}`);
        console.log("      That reads as a truncated data.jsonl, not as news from Scryfall.");
        console.log("      Nothing was removed. Re-run phase 0, or pass --allow-mass-removal if the export is genuinely right.");
    } else if (removed.cards){
        console.log(`   🧹 withdrawn:      ${removed.cards} cards removed from cards/ (${(removed.bytes / 1073741824).toFixed(2)} GB)`);
        console.log("      They are gone from Scryfall. import.js --remove-withdrawn takes them out of the database.");
    }
    for (const reason of skipped){
        console.log(`   ⚠️  skipped ${reason}`);
    }
    console.log("\n   Next: npm run phase2");
    process.exit(0);
}
