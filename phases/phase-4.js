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
        const files = [];
        if (card.art){
            files.push(path.join(dir, "art.png"));
        }
        for (const line of manifest.split("\n")){
            if (!line.length) continue;
            const look = JSON.parse(line);
            files.push(path.join(dir, `${look.hash}-front.png`));
            if (look.backHash && look.back){
                files.push(path.join(dir, `${look.backHash}-back.png`));
            }
        }
        for (const input of new Set(files)){
            jobs.push({ input, output: input.replace(/\.png$/, ".webp") });
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

    const pending = [];
    let converted = 0;
    let absent = 0;
    for (const job of queue){
        if (fs.existsSync(job.output)){
            converted++;
        } else if (!fs.existsSync(job.input)){
            // Phase 3 is what reports these; here it is simply nothing to do.
            absent++;
        } else {
            pending.push(job);
        }
    }

    console.log(`🎯 ${queue.length} images, ${converted} already converted, ${pending.length} to encode`);
    if (absent){
        console.log(`   ⚠️  ${absent} have no png yet - run phase 2 first`);
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
        console.log(`   🧹 pruned:    ${stats.pruned} png removed (--prune)`);
    } else {
        console.log(`   💾 the png originals are kept - pass --prune to remove them as they convert`);
    }
    if (stats.failed){
        console.log(`   🚨 failed:    ${stats.failed} - see ${errorFile}`);
    }
}
