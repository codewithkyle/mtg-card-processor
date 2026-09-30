const fs = require("fs");
const os = require("os");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const run = promisify(execFile);

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");
const errorFile = path.join(cwd, "image-errors");

const { getDirectories } = require("../lib/utils");
const ledger = require("../lib/ledger");

const DEFAULT_QUALITY = 80;

// Measured on a 745x1040 card render: 1.78MB of png becomes 212KB at q80,
// 176KB at q75 and 320KB at q90. q80 is the point where the frame's gradients
// stop banding, and it takes the whole catalogue from 82GB to about 16GB.
const ENCODERS = [
    {
        name: "cwebp",
        probe: ["-version"],
        args: (input, output, quality) => ["-quiet", "-q", String(quality), input, "-o", output],
    },
    {
        name: "vips",
        probe: ["--version"],
        args: (input, output, quality) => ["webpsave", input, output, "--Q", String(quality)],
    },
];

async function findEncoder(){
    for (const encoder of ENCODERS){
        try {
            await run(encoder.name, encoder.probe);
            return encoder;
        } catch (error){
            // Not installed, or installed and broken. Either way, try the next.
        }
    }
    return null;
}

// Every png the manifests name, paired with the webp it should become. Driven
// from the manifest rather than from a directory listing, so an image left
// over from a printing that has since changed treatment is not converted and
// then uploaded.
async function buildQueue(dirs){
    const jobs = [];
    for (const dir of dirs){
        let card, manifest;
        try {
            card = JSON.parse(await fs.promises.readFile(path.join(dir, "card.json"), { encoding: "utf8" }));
            manifest = await fs.promises.readFile(path.join(dir, "prints.jsonl"), { encoding: "utf8" });
        } catch (error){
            console.log(`🚨 Missing manifest at ${dir}, run phase 1`);
            continue;
        }
        const files = new Map();
        if (card.art && card.defaultFront){
            files.set(path.join(dir, "art.png"), ledger.artKey(card.defaultFront));
        }
        for (const line of manifest.split("\n")){
            if (!line.length) continue;
            const look = JSON.parse(line);
            files.set(path.join(dir, `${look.hash}-front.png`), ledger.faceKey(look.hash, "front"));
            if (look.backHash && look.back){
                files.set(path.join(dir, `${look.backHash}-back.png`), ledger.faceKey(look.backHash, "back"));
            }
        }
        for (const [input, key] of files){
            jobs.push({ input, output: ledger.webpFor(input), key });
        }
    }
    return jobs;
}

module.exports = async (argv = {}) => {
    clear();
    console.log("🚀 Launching MTG Card Image Converter");

    const encoder = await findEncoder();
    if (!encoder){
        console.log("🚨 No webp encoder found. Install libwebp (cwebp) or libvips (vips).");
        process.exit(1);
    }
    const quality = Number(argv.quality ?? DEFAULT_QUALITY);
    console.log(`🗜️  Encoding with ${encoder.name} at q${quality}`);

    const dirs = await getDirectories(cardsDir);
    if (!dirs.length){
        console.log("⚠️  No cards found, run phase 1 first");
        return;
    }

    console.log(`📇 Reading manifests for ${dirs.length} cards`);
    const queue = await buildQueue(dirs);

    const uploaded = ledger.load();
    console.log(`📇 ${ledger.describe(uploaded)}`);

    const pending = [];
    const convertedEarlier = [];
    let converted = 0;
    let absent = 0;
    let alreadyUp = 0;
    for (const job of queue){
        if (fs.existsSync(job.output)){
            converted++;
            // A webp that already exists whose png is also still here. Only a
            // run that converted without --prune leaves that pair behind, and
            // this run would otherwise skip the job and never look at the png
            // again - 1.46GB of them had accumulated that way.
            if (fs.existsSync(job.input)){
                convertedEarlier.push(job.input);
            }
        } else if (!fs.existsSync(job.input)){
            // No png and no webp. If the object is in the bucket then this is
            // simply a machine that does not hold a copy, and there is nothing to
            // convert and nothing wrong - saying "run phase 2 first" here would
            // send you off to re-download 99GB of images that are already
            // uploaded. Only the rest are phase 3's business.
            if (uploaded.has(job.key)){
                alreadyUp++;
            } else {
                absent++;
            }
        } else {
            pending.push(job);
        }
    }

    console.log(`🎯 ${queue.length} images, ${converted} already converted, ${pending.length} to encode`);
    if (alreadyUp){
        console.log(`   ☁️  ${alreadyUp} are already in the bucket with no local copy - nothing to do`);
    }
    if (absent){
        console.log(`   ⚠️  ${absent} have no png yet - run phase 2 first`);
    }

    // Before the early return below, because "nothing to convert" is exactly the
    // state a catalogue that has been converted without --prune ends up in, and
    // returning there is what left the pngs sitting next to their webp.
    let reclaimed = 0;
    if (convertedEarlier.length){
        if (argv.prune){
            for (const input of convertedEarlier){
                reclaimed += (await fs.promises.stat(input)).size;
                await fs.promises.unlink(input);
            }
            console.log(`   🧹 removed ${convertedEarlier.length} png left beside a webp by an earlier run (${(reclaimed / 1073741824).toFixed(2)} GB)`);
        } else {
            console.log(`   💾 ${convertedEarlier.length} png sit beside a finished webp - pass --prune to reclaim them`);
        }
    }

    if (!pending.length){
        console.log("✔️  Nothing to convert");
        return;
    }

    // Bounded on purpose. The previous version called exec() for every image
    // without waiting, which on a catalogue this size meant tens of thousands
    // of concurrent processes and a progress bar that finished long before the
    // work did.
    const WORKERS = Math.max(1, os.cpus().length);
    console.log(`🧵 ${WORKERS} encoders`);

    const stats = { converted: 0, failed: 0, pngBytes: 0, webpBytes: 0, pruned: 0 };
    const bar = new cliProgress.SingleBar({
        format: "   {bar} {percentage}% | {value}/{total} | {eta_formatted} left | {saved}",
    }, cliProgress.Presets.shades_classic);
    bar.start(pending.length, 0, { saved: "" });

    async function work(){
        while (pending.length){
            const job = pending.pop();
            try {
                // Encoded under a temporary name and moved into place once it
                // is whole. Neither encoder writes atomically, and resume here
                // is just "does the webp exist" - so a run killed mid encode
                // would otherwise leave a truncated file that the next run
                // skips as finished and phase 5 then uploads.
                const partial = `${job.output}.part`;
                await run(encoder.name, encoder.args(job.input, partial, quality));
                await fs.promises.rename(partial, job.output);
                // Checked rather than assumed: both encoders report plenty on
                // stderr that is not an error, so the output file is the only
                // honest signal that the conversion happened.
                const out = await fs.promises.stat(job.output);
                stats.webpBytes += out.size;
                const before = await fs.promises.stat(job.input);
                stats.pngBytes += before.size;
                stats.converted++;
                if (argv.prune){
                    await fs.promises.unlink(job.input);
                    stats.pruned++;
                }
            } catch (error){
                stats.failed++;
                await fs.promises.rm(`${job.output}.part`, { force: true });
                fs.appendFileSync(errorFile, `${error.message} - ${job.input}\n`);
            }
            const saved = stats.pngBytes ? `${Math.round((1 - stats.webpBytes / stats.pngBytes) * 100)}% smaller` : "";
            bar.increment({ saved });
        }
    }

    await Promise.all(Array.from({ length: WORKERS }, () => work()));
    bar.stop();

    console.log("✔️  MTG card image conversion completed");
    console.log(`   🗜️  converted: ${stats.converted}`);
    console.log(`   📉 ${(stats.pngBytes / 1073741824).toFixed(1)} GB of png became ${(stats.webpBytes / 1073741824).toFixed(1)} GB of webp`);
    if (stats.pruned){
        console.log(`   🧹 pruned:    ${stats.pruned} png removed as they converted (--prune)`);
    } else {
        console.log(`   💾 the png originals are kept - pass --prune to remove them as they convert`);
    }
    if (stats.failed){
        console.log(`   🚨 failed:    ${stats.failed} - see ${errorFile}`);
    }
}
