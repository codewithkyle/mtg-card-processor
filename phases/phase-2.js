const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");
const errorFile = path.join(cwd, "download-errors");

const { getDirectories, delay } = require("../lib/utils");
const { downloadImage, RateLimited, NotFound } = require("../lib/download");

// Scryfall asks for 50 to 100ms between requests. That ceiling belongs to the
// run as a whole rather than to each worker, so the workers share one clock:
// every request takes the next slot on it, and the pool exists only to keep
// the connection busy while earlier responses are still on the wire. Spacing
// the starts rather than sleeping after each download is what gets the run to
// the full ten per second instead of to five.
const REQUEST_INTERVAL = 100;
const WORKERS = 8;

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
        if (card.art){
            jobs.set(path.join(dir, "art.png"), { url: card.art, file: path.join(dir, "art.png"), kind: "art" });
        }
        for (const line of manifest.split("\n")){
            if (!line.length) continue;
            const look = JSON.parse(line);
            const front = path.join(dir, `${look.hash}-front.png`);
            jobs.set(front, { url: look.front, file: front, kind: "front" });
            if (look.backHash && look.back){
                const back = path.join(dir, `${look.backHash}-back.png`);
                jobs.set(back, { url: look.back, file: back, kind: "back" });
            }
        }
    }
    return [...jobs.values()];
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

    // Resume is simply which files are already on disk. There is no bucket
    // listing any more: the old index was keyed on a card id and a release
    // date, neither of which names an image now, and a three hour run wants a
    // check it can make locally.
    const pending = queue.filter((job) => !fs.existsSync(job.file));
    const onDisk = queue.length - pending.length;

    // --limit exists because the full run is hours long. It fetches a slice
    // first, so the pipeline can be proved end to end before committing to it.
    if (argv.limit){
        pending.length = Math.min(pending.length, Number(argv.limit));
        console.log(`🔬 --limit ${argv.limit}: fetching a slice only`);
    }

    console.log(`🎯 ${queue.length} images, ${onDisk} already downloaded, ${pending.length} to fetch`);
    if (!pending.length){
        console.log("✔️  Nothing to download");
        return;
    }
    console.log(`⏱️  At ${1000 / REQUEST_INTERVAL} requests a second this takes about ${hours(pending.length / (1000 / REQUEST_INTERVAL))}`);

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
                stats.bytes += await downloadImage(job.url, job.file);
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
    console.log(`   💾 already on disk: ${stats.onDisk}`);
    if (stats.missing){
        console.log(`   🕳️  missing upstream: ${stats.missing}`);
    }
    if (stats.failed){
        console.log(`   🚨 failed:          ${stats.failed} - see ${errorFile}`);
    }
}
