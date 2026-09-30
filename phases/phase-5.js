const fs = require("fs");
const path = require("path");
const clear = require('clear');
const cliProgress = require('cli-progress');
require('dotenv').config();

const { getDirectories } = require("../lib/utils");
const { upload, listKeys, faceKey, artKey, describeTarget } = require("../lib/upload");
const ledger = require("../lib/ledger");

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");
const manifestFile = path.join(cwd, "import.jsonl");
const uploadedFile = ledger.ledgerFile;
const errorFile = path.join(cwd, "upload-errors");
const metaFile = path.join(cwd, "import.meta.json");
const dataMetaFile = path.join(cwd, "data.meta.json");

const WORKERS = 8;

// How much of the ledger --repair-ledger may throw away before it refuses.
//
// A repair rewrites the ledger to be exactly what the bucket listing said, which
// is right when the listing is right and catastrophic when it is not: a wrong
// endpoint, a wrong bucket or a wrong prefix all list successfully and return
// almost nothing, and acting on that would discard the record of 111,547 objects
// and commit the next run to re-fetching 99GB of png. Genuine drift is a handful
// of keys.
const MAX_LEDGER_LOSS_SHARE = 0.05;

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

function readDataMeta(){
    try {
        return JSON.parse(fs.readFileSync(dataMetaFile, { encoding: "utf8" }));
    } catch (error){
        return null;
    }
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

// Every object key the manifests name, which is what makes "in the bucket and
// referenced by nothing" a question that can be answered.
function referencedKeys(dirs){
    const keys = new Set();
    for (const dir of dirs){
        let card, looks;
        try {
            ({ card, looks } = readManifest(dir));
        } catch (error){
            continue;
        }
        for (const look of looks){
            keys.add(faceKey(look.hash, "front"));
            if (look.backHash){
                keys.add(faceKey(look.backHash, "back"));
            }
        }
        if (card.art && card.defaultFront){
            keys.add(artKey(card.defaultFront));
        }
    }
    return keys;
}

// Reconciles the ledger against the bucket itself.
//
// Phases 2, 3 and 4 treat the ledger as authoritative, which means it is the
// single witness that an object was uploaded - where the local webp used to be a
// second one. This is how that witness gets checked, and it is the thing that
// makes relying on it reasonable rather than hopeful.
//
// Not part of any ordinary run. Listing 111,547 objects is about 112 paginated
// requests: cheap, but pointless to repeat when the ledger is right, which it is
// unless something happened outside this tool - a bucket lifecycle rule, a manual
// deletion, a half finished migration.
async function verifyBucket(dirs, argv){
    const recorded = ledger.load();
    console.log(`📇 ${ledger.describe(recorded)}`);
    console.log("☁️  Listing the bucket, about 112 requests...");

    const inBucket = new Set();
    let bytes = 0;
    try {
        for await (const object of listKeys()){
            inBucket.add(object.key);
            bytes += object.size ?? 0;
        }
    } catch (error){
        console.log(`🚨 Could not list the bucket: ${error.message}`);
        console.log("   Nothing was changed.");
        process.exit(1);
    }
    console.log(`   ${inBucket.size} objects, ${(bytes / 1073741824).toFixed(2)} GB`);

    // Measured against whatever manifests are on this machine. That matters for
    // the unreferenced count below: run against a partial cards/ directory it
    // would call most of the bucket unreferenced, so the card count is printed
    // next to it rather than left for the reader to assume.
    const referenced = referencedKeys(dirs);
    const lying = [...recorded].filter((key) => !inBucket.has(key));
    const unrecorded = [...inBucket].filter((key) => !recorded.has(key));
    const unreferenced = [...inBucket].filter((key) => !referenced.has(key));
    const absent = [...referenced].filter((key) => !inBucket.has(key));

    console.log("\n✔️  Reconciliation");
    console.log(`   📝 manifests name:    ${referenced.size} objects, from ${dirs.length} cards on this machine`);
    console.log(`   ☁️  bucket holds:      ${inBucket.size}`);
    console.log(`   📇 ledger claims:     ${recorded.size}`);

    if (lying.length){
        // The only finding here that can break the site. Every phase skips these
        // as done, so the image is never fetched, never converted, never
        // uploaded - and a card points at a URL that 404s.
        console.log(`\n   🚨 ${lying.length} keys are in the ledger but NOT in the bucket.`);
        console.log("      These are the dangerous ones: every phase skips them as already");
        console.log("      done, so nothing will ever upload them and any card pointing at");
        console.log("      one renders nothing.");
        for (const key of lying.slice(0, 10)){
            console.log(`      ✗ ${key}`);
        }
        if (lying.length > 10){
            console.log(`      ...and ${lying.length - 10} more`);
        }
    } else {
        console.log("\n   ✨ every key in the ledger is really in the bucket");
    }

    if (unrecorded.length){
        console.log(`\n   📝 ${unrecorded.length} objects are in the bucket but not in the ledger.`);
        console.log("      Harmless - they would simply be uploaded again. A repair records them.");
    }
    if (absent.length){
        console.log(`\n   ⚠️  ${absent.length} objects the manifests name are in neither.`);
        console.log("      Genuinely missing: run phases 2, 4 and 5.");
    }
    if (unreferenced.length){
        const share = inBucket.size ? unreferenced.length / inBucket.size : 0;
        console.log(`\n   🧹 ${unreferenced.length} objects in the bucket that no manifest names.`);
        if (share > 0.1){
            console.log("      That is a large share, which usually means the manifests here are");
            console.log("      incomplete rather than the bucket being full of junk. Run phase 1");
            console.log("      before reading this number as real.");
        } else {
            console.log("      Printings whose look hash changed between exports. They cost storage");
            console.log("      and nothing else; deleting them is a separate job, deliberately not");
            console.log("      done here.");
        }
    }

    if (!argv["repair-ledger"]){
        if (lying.length || unrecorded.length){
            console.log("\n   Pass --repair-ledger to rewrite the ledger as exactly what the bucket holds.");
        }
        return;
    }

    if (!inBucket.size){
        console.log("\n🚨 Refusing to repair: the listing returned nothing at all.");
        console.log("   That is a configuration problem, not an empty bucket. Check S3_ENDPOINT,");
        console.log("   S3_BUCKET and the credentials before trying again.");
        process.exit(1);
    }
    const share = recorded.size ? lying.length / recorded.size : 0;
    if (share > MAX_LEDGER_LOSS_SHARE && !argv.force){
        console.log(`\n🚨 Refusing to repair: it would drop ${lying.length} of ${recorded.size} keys (${(share * 100).toFixed(1)}%),`);
        console.log(`   over the ${(MAX_LEDGER_LOSS_SHARE * 100).toFixed(0)}% ceiling. Drift that large is far more likely to be a wrong`);
        console.log("   bucket or prefix than 100,000 objects having actually gone missing, and");
        console.log("   acting on it would commit the next run to re-downloading all of them.");
        console.log("\n   If the listing really is right:  --verify-bucket --repair-ledger --force");
        process.exit(1);
    }

    // The previous ledger is kept. It is 5.5MB and it is the only record of what
    // was uploaded, so overwriting it without a copy is not a trade worth making.
    const backup = `${uploadedFile}.bak`;
    if (fs.existsSync(uploadedFile)){
        await fs.promises.copyFile(uploadedFile, backup);
    }
    const part = `${uploadedFile}.part`;
    await fs.promises.writeFile(part, `${[...inBucket].sort().join("\n")}\n`);
    await fs.promises.rename(part, uploadedFile);

    console.log(`\n✔️  Ledger rewritten: ${inBucket.size} keys`);
    if (lying.length)     console.log(`   − ${lying.length} removed, so the next run uploads them again`);
    if (unrecorded.length) console.log(`   + ${unrecorded.length} recorded, so the next run does not`);
    console.log(`   💾 previous ledger kept at ${path.basename(backup)}`);
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

    if (argv["verify-bucket"]){
        await verifyBucket(dirs, argv);
        return;
    }

    const uploaded = ledger.load();
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

    // Whether this file describes the whole catalogue, written down rather than
    // left to be inferred.
    //
    // A card is left out when its default image is not in the bucket yet
    // (deferred) or when reading it threw (failed), and import.js cannot tell
    // either from a card Scryfall withdrew - both are simply absent from the
    // manifest. Its --remove-withdrawn would then delete perfectly good cards,
    // and the deck slots naming them, because this run was interrupted. The 5%
    // ceiling in lib/importer.js catches a wholesale truncation; a dozen
    // deferred cards slips under it, which is the case this file exists to stop.
    const limited = Boolean(argv.limit || argv.card);
    const complete = !limited && !argv["skip-upload"] && stats.deferred === 0 && stats.failed === 0;
    const meta = {
        generatedAt: new Date().toISOString(),
        manifest: path.basename(manifestFile),
        complete,
        cards: stats.cards,
        prints: stats.prints,
        deferred: stats.deferred,
        partial: stats.partial,
        failed: stats.failed,
        limited,
        skippedUpload: Boolean(argv["skip-upload"]),
        uploaded: stats.uploaded,
        bucket: argv["skip-upload"] ? null : describeTarget(),
        // Which Scryfall export this describes, carried through from phase 0 so
        // the database can be told how old the catalogue it just accepted is.
        source: readDataMeta(),
    };
    fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);

    console.log("✔️  Finished uploading card images");
    console.log(`   ☁️  uploaded:   ${stats.uploaded} objects, ${(stats.bytes / 1073741824).toFixed(2)} GB`);
    if (stats.alreadyUp) console.log(`   ⏭️  already up:  ${stats.alreadyUp}`);
    console.log(`   📝 manifest:   ${stats.cards} cards, ${stats.prints} printings`);
    if (stats.partial)  console.log(`   ⚠️  incomplete:  ${stats.partial} cards are missing some looks - run phase 4`);
    if (stats.deferred) console.log(`   ⏸️  deferred:    ${stats.deferred} cards have no default image yet`);
    if (stats.failed)   console.log(`   🚨 failed:      ${stats.failed} - see ${errorFile}`);

    if (complete){
        console.log(`   ✅ complete:    every card is in the manifest, recorded in ${path.basename(metaFile)}`);
        console.log(`\n   Next: node import.js --file ${path.basename(manifestFile)} --prune --remove-withdrawn`);
    } else {
        console.log(`   ⛔ incomplete:  ${path.basename(metaFile)} says so, so import.js will refuse --remove-withdrawn`);
        if (stats.deferred || stats.failed){
            console.log("      Run phases 2 and 4 to fill the gaps, then phase 5 again.");
        }
        console.log(`\n   Next: node import.js --file ${path.basename(manifestFile)}`);
    }
}
