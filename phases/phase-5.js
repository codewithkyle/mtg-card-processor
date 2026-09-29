const fs = require("fs");
const path = require("path");
const clear = require('clear');
const cliProgress = require('cli-progress');
require('dotenv').config();

const { getDirectories } = require("../lib/utils");
const { upload, faceKey, artKey, describeTarget } = require("../lib/upload");

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");
const manifestFile = path.join(cwd, "import.jsonl");
const uploadedFile = path.join(cwd, "uploaded");
const errorFile = path.join(cwd, "upload-errors");

const WORKERS = 8;

// Phase 5 no longer touches the database. It puts the images in the bucket and
// writes one line per card describing what the database should hold, and
// import.js applies that file wherever it is pointed.
//
// The split is what makes shipping this to production safe. The alternative
// was to write a local database and restore a dump over the real one, which
// carries Decks, Deck_Cards and Sleeves along with the card data and would
// take real user rows with it. A manifest can only touch card tables.
//
// It also means nothing in the bucket depends on a database any more. Cards.id
// is resolved per environment, so anything named after it would be uploaded
// under one id locally and looked for under another on production.

// Which objects are already in the bucket. Kept locally rather than by listing
// R2, for the same reason phase 2 resumes from the filesystem: a local check
// costs nothing and the answer does not change underneath us.
function loadUploaded(){
    if (!fs.existsSync(uploadedFile)){
        return new Set();
    }
    const keys = fs.readFileSync(uploadedFile, { encoding: "utf8" }).split("\n").filter((key) => key.length);
    return new Set(keys);
}

function readManifest(dir){
    const card = JSON.parse(fs.readFileSync(path.join(dir, "card.json"), { encoding: "utf8" }));
    const looks = fs.readFileSync(path.join(dir, "prints.jsonl"), { encoding: "utf8" })
        .split("\n")
        .filter((line) => line.length)
        .map((line) => JSON.parse(line));
    return { card, looks };
}

// Only the fields the importer writes, plus the printings. Deliberately no
// Cards.id and no set of local paths: the same line has to mean the same thing
// against any database, which is what lets one file be applied to a test
// database and then to production.
function manifestLine(card, rows){
    return JSON.stringify({
        oracleId: card.oracleId,
        name: card.name,
        layout: card.layout,
        colors: card.colors,
        legalities: card.legalities,
        rarity: card.rarity,
        keywords: card.keywords,
        type: card.type,
        subtypes: card.subtypes,
        texts: card.texts,
        manaCosts: card.manaCosts,
        totalManaCost: card.totalManaCost,
        faceNames: card.faceNames,
        flavorTexts: card.flavorTexts,
        toughness: card.toughness,
        power: card.power,
        price: card.price,
        tix: card.tix,
        set: card.set,
        edhRank: card.edhRank,
        front: card.front,
        back: card.back,
        art: card.art,
        prints: rows,
    });
}

module.exports = async (argv = {}) => {
    clear();
    console.log("🚀 Launching MTG Card Uploader");
    console.log(`☁️  Objects:  ${argv["skip-upload"] ? "skipped (--skip-upload)" : describeTarget()}`);
    console.log(`📝 Manifest: ${manifestFile}`);

    const dirs = await getDirectories(cardsDir);
    if (!dirs.length){
        console.log("⚠️  No cards found, run phase 1 first");
        return;
    }

    const uploaded = loadUploaded();
    if (uploaded.size){
        console.log(`📇 ${uploaded.size} objects already uploaded, they will not be sent again`);
    }

    let queue = dirs;
    if (argv.card){
        queue = dirs.filter((dir) => path.basename(dir) === argv.card);
        if (!queue.length){
            console.log(`⚠️  No card directory for ${argv.card}`);
            return;
        }
    } else if (argv.limit){
        queue = dirs.slice(0, Number(argv.limit));
    }

    const total = queue.length;
    const stats = {
        cards: 0, prints: 0, uploaded: 0, bytes: 0,
        alreadyUp: 0, deferred: 0, partial: 0, failed: 0,
    };

    const manifest = fs.createWriteStream(manifestFile, { flags: "w" });
    const uploadLog = fs.createWriteStream(uploadedFile, { flags: "a" });

    const bar = new cliProgress.SingleBar({
        format: "   {bar} {percentage}% | {value}/{total} cards | {eta_formatted} left | {up} uploads",
    }, cliProgress.Presets.shades_classic);
    bar.start(total, 0, { up: 0 });

    // Sends one object unless it is already up, and records it only once it is.
    // A key reaching the log is a promise that the bytes are in the bucket,
    // which is what the next run's resume depends on.
    async function send(key, file){
        if (uploaded.has(key)){
            stats.alreadyUp++;
            return true;
        }
        if (argv["skip-upload"]){
            return true;
        }
        if (!fs.existsSync(file)){
            return false;
        }
        // See the note in phase 2: awaiting inside a `+=` loses updates when
        // several workers are in flight.
        const bytes = await upload(key, file);
        stats.bytes += bytes;
        uploaded.add(key);
        uploadLog.write(`${key}\n`);
        stats.uploaded++;
        return true;
    }

    async function uploadOne(dir){
        const { card, looks } = readManifest(dir);

        const rows = [];
        let missing = 0;
        for (const look of looks){
            const front = await send(faceKey(look.hash, "front"), path.join(dir, `${look.hash}-front.webp`));
            let back = true;
            if (look.backHash){
                back = await send(faceKey(look.backHash, "back"), path.join(dir, `${look.backHash}-back.webp`));
            }
            if (!front || !back){
                // No webp yet. Left out rather than written as a hash that
                // promises an object nobody uploaded.
                missing++;
                continue;
            }
            for (const printId of look.prints){
                rows.push({
                    id: printId,
                    released: look.released,
                    frontHash: look.hash,
                    backHash: look.backHash,
                });
            }
        }

        // The card is described by its default printing, so if that one is not
        // in the bucket the whole card waits for the next run. Emitting it
        // would point Cards.front at an object that does not exist.
        if (!rows.some((row) => row.frontHash === card.defaultFront)){
            stats.deferred++;
            return;
        }
        if (missing){
            stats.partial++;
        }

        let art = null;
        if (card.art && await send(artKey(card.defaultFront), path.join(dir, "art.webp"))){
            art = card.defaultFront;
        }

        card.front = card.defaultFront;
        card.back = card.defaultBack;
        card.art = art;

        manifest.write(`${manifestLine(card, rows)}\n`);
        stats.cards++;
        stats.prints += rows.length;
    }

    async function work(){
        while (queue.length){
            const dir = queue.pop();
            try {
                await uploadOne(dir);
            } catch (error){
                stats.failed++;
                fs.appendFileSync(errorFile, `${error.message} - ${dir}\n`);
            }
            bar.increment({ up: stats.uploaded });
        }
    }

    await Promise.all(Array.from({ length: WORKERS }, () => work()));
    bar.stop();

    await new Promise((resolve) => manifest.end(resolve));
    await new Promise((resolve) => uploadLog.end(resolve));

    console.log("✔️  Finished uploading card images");
    console.log(`   ☁️  uploaded:   ${stats.uploaded} objects, ${(stats.bytes / 1073741824).toFixed(2)} GB`);
    if (stats.alreadyUp) console.log(`   ⏭️  already up:  ${stats.alreadyUp}`);
    console.log(`   📝 manifest:   ${stats.cards} cards, ${stats.prints} printings`);
    if (stats.partial)  console.log(`   ⚠️  incomplete:  ${stats.partial} cards are missing some looks - run phase 4`);
    if (stats.deferred) console.log(`   ⏸️  deferred:    ${stats.deferred} cards have no default image yet`);
    if (stats.failed)   console.log(`   🚨 failed:      ${stats.failed} - see ${errorFile}`);
    console.log(`\n   Next: node import.js --file ${path.basename(manifestFile)}`);
}
