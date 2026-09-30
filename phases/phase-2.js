const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");
const errorFile = path.join(cwd, "download-errors");

const { getDirectories, delay } = require("../lib/utils");
const { downloadImage, RateLimited, NotFound } = require("../lib/download");
const ledger = require("../lib/ledger");

// Scryfall asks for 50 to 100ms between requests. That ceiling belongs to the
// run as a whole rather than to each worker, so the workers share one clock:
// every request takes the next slot on it, and the pool exists only to keep
// the connection busy while earlier responses are still on the wire. Spacing
// the starts rather than sleeping after each download is what gets the run to
// the full ten per second instead of to five.
const REQUEST_INTERVAL = 100;
const WORKERS = 8;

// Above this many images, the run stops and asks.
//
// A set release is a few hundred images, and a refresh whose treatments moved
// around is a few thousand. 111,084 is a cold start - which is a legitimate thing
// to do once, and a three hour 99GB accident every time after that. The number
// only has to sit between those two, and the point is that the accident cannot
// happen silently: the estimate was always printed, immediately followed by the
// download starting.
const BULK_THRESHOLD = 10000;

let nextSlot = 0;
async function reserveSlot(){
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + REQUEST_INTERVAL;
    if (at > now){
        await delay(at - now);
    }
}

// One job per file rather than per look. A front image can belong to two looks
// at once - the Ixalan transforming cards that share a front and differ on the
// back - and both name the same file, so keying the queue on the path is what
// keeps it from being fetched twice.
//
// Each job also carries `key`: the name the finished webp has in the bucket. The
// hashes were always in scope here and simply not kept, and keeping them is what
// lets the resume below ask whether the object exists at all rather than only
// whether this machine happens to hold a copy.
async function buildQueue(dirs){
    const jobs = new Map();
    for (const dir of dirs){
        let card, manifest;
        try {
            card = JSON.parse(await fs.promises.readFile(path.join(dir, "card.json"), { encoding: "utf8" }));
            manifest = await fs.promises.readFile(path.join(dir, "prints.jsonl"), { encoding: "utf8" });
        } catch (error){
            console.log(`🚨 Missing manifest at ${dir}, run phase 1`);
            continue;
        }
        // The crop is addressed by the printing it comes from, not by the file
        // name - art.png is art.png whichever printing the card defaults to - so
        // this is the one key that cannot be recovered from the path.
        if (card.art && card.defaultFront){
            const art = path.join(dir, "art.png");
            jobs.set(art, { url: card.art, file: art, kind: "art", key: ledger.artKey(card.defaultFront) });
        }
        for (const line of manifest.split("\n")){
            if (!line.length) continue;
            const look = JSON.parse(line);
            const front = path.join(dir, `${look.hash}-front.png`);
            jobs.set(front, { url: look.front, file: front, kind: "front", key: ledger.faceKey(look.hash, "front") });
            if (look.backHash && look.back){
                const back = path.join(dir, `${look.backHash}-back.png`);
                jobs.set(back, { url: look.back, file: back, kind: "back", key: ledger.faceKey(look.backHash, "back") });
            }
        }
    }
    return [...jobs.values()];
}

// Measured across the catalogue: 99GB over 111,084 images.
const MEAN_PNG_BYTES = 953000;

function gb(bytes){
    return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`;
}

function hours(seconds){
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
}

module.exports = async (argv = {}) => {
    clear();
    console.log("🚀 Launching MTG Image Downloader");

    const dirs = await getDirectories(cardsDir);
    if (!dirs.length){
        console.log("⚠️  No cards found, run phase 1 first");
        return;
    }

    console.log(`📇 Reading manifests for ${dirs.length} cards`);
    const queue = await buildQueue(dirs);

    const uploaded = ledger.load();
    console.log(`📇 ${ledger.describe(uploaded)}`);

    // Three ways an image can already be held, and the point of this phase is
    // that any of them is enough.
    //
    //   the png  - downloaded, not yet converted
    //   the webp - converted, phase 4 --prune having taken the png
    //   the ledger - uploaded, so the finished object is in R2 whatever this
    //                machine happens to have lying around
    //
    // The first two are local and were always checked; both matter, because
    // phase 4 --prune deletes the png once the webp is written and a check that
    // only looked for the png would call a converted catalogue entirely missing.
    //
    // The ledger is the new one, and it is the authoritative answer. Without it
    // the 15GB cards/ directory is load-bearing without looking it: delete the
    // images to reclaim space - a reasonable thing to do between set releases,
    // and nothing warns you - and this phase re-fetches 99GB of png over three
    // hours, to rebuild objects that are already in the bucket. With it, that
    // costs nothing at all.
    //
    // To deliberately re-fetch an image, its key has to come out of the ledger as
    // well as its files off the disk. That is the cost of this being
    // authoritative, and --verify-bucket on phase 5 is how the ledger gets
    // checked against R2 itself.
    const held = (job) => fs.existsSync(job.file)
        || fs.existsSync(ledger.webpFor(job.file))
        || uploaded.has(job.key);
    const pending = queue.filter((job) => !held(job));
    const onDisk = queue.length - pending.length;

    // --limit exists because the full run is hours long. It fetches a slice
    // first, so the pipeline can be proved end to end before committing to it.
    if (argv.limit){
        pending.length = Math.min(pending.length, Number(argv.limit));
        console.log(`🔬 --limit ${argv.limit}: fetching a slice only`);
    }

    console.log(`🎯 ${queue.length} images, ${onDisk} already held, ${pending.length} to fetch`);
    if (!pending.length){
        console.log("✔️  Nothing to download");
        return;
    }
    console.log(`⏱️  At ${1000 / REQUEST_INTERVAL} requests a second this takes about ${hours(pending.length / (1000 / REQUEST_INTERVAL))}`);
    console.log(`   💾 roughly ${gb(pending.length * MEAN_PNG_BYTES)} of png at the measured mean of ${Math.round(MEAN_PNG_BYTES / 1024)} KB`);

    // Checked after --limit, so asking for a slice explicitly is never blocked.
    if (pending.length > BULK_THRESHOLD && !argv["allow-bulk-download"]){
        console.log(`🚨 That is more than ${BULK_THRESHOLD} images, which is not what a set release looks like.`);
        console.log("   Something is probably missing rather than genuinely new - most likely");
        console.log(`   the ${path.basename(ledger.ledgerFile)} ledger, which is what records that these objects are`);
        console.log("   already in the bucket. Check that first.");
        console.log("\n   To go ahead anyway:  --allow-bulk-download");
        console.log("   To prove it works first:  --limit 20");
        process.exit(1);
    }

    const stats = { downloaded: 0, bytes: 0, missing: 0, failed: 0, onDisk };
    let halted = null;

    const bar = new cliProgress.SingleBar({
        format: "   {bar} {percentage}% | {value}/{total} | {eta_formatted} left | {mb} MB",
    }, cliProgress.Presets.shades_classic);
    bar.start(pending.length, 0, { mb: 0 });

    async function work(){
        while (pending.length && !halted){
            const job = pending.pop();
            try {
                await reserveSlot();
                if (halted) return;
                // Hoisted out of a `+=` on purpose. `stats.bytes += await f()`
                // reads stats.bytes BEFORE awaiting, so with eight workers in
                // flight each one writes back a value it read before the others
                // committed theirs, and most of the total is lost.
                const bytes = await downloadImage(job.url, job.file);
                stats.bytes += bytes;
                stats.downloaded++;
            } catch (error){
                if (error instanceof RateLimited){
                    // Every worker checks this flag, so one 429 stops the run
                    // rather than letting the other seven keep asking.
                    halted = error;
                    return;
                }
                if (error instanceof NotFound){
                    stats.missing++;
                } else {
                    stats.failed++;
                }
                fs.appendFileSync(errorFile, `${error.message} - ${job.file}\n`);
            }
            bar.increment({ mb: Math.round(stats.bytes / 1048576) });
        }
    }

    await Promise.all(Array.from({ length: WORKERS }, () => work()));
    bar.stop();

    if (halted){
        console.log(`🚨 ${halted.message}`);
        console.log("   Stopped so we do not get banned. Re-run phase 2 to pick up where this left off.");
        process.exit(1);
    }

    console.log("✔️  Finished downloading MTG card images");
    console.log(`   ⬇️  downloaded:     ${stats.downloaded} (${(stats.bytes / 1073741824).toFixed(1)} GB)`);
    console.log(`   💾 already held:    ${stats.onDisk}`);
    if (stats.missing){
        console.log(`   🕳️  missing upstream: ${stats.missing}`);
    }
    if (stats.failed){
        console.log(`   🚨 failed:          ${stats.failed} - see ${errorFile}`);
    }
}
