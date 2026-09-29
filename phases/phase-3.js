const fs = require("fs");
const path = require("path");
const cliProgress = require('cli-progress');
var clear = require('clear');

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");
const metaFile = path.join(cwd, "data.meta.json");

const { getDirectories } = require("../lib/utils");

function readMeta(){
    try {
        return JSON.parse(fs.readFileSync(metaFile, { encoding: "utf8" }));
    } catch (error){
        return null;
    }
}

// Everything a card is supposed to have on disk, named from its manifest. The
// old validator asked DigitalOcean whether an image existed; this one asks the
// manifest, which is both faster and the only thing that still knows what an
// image is called.
function expectedFiles(dir, card, looks){
    const expected = new Map();
    if (card.art){
        expected.set(path.join(dir, "art.png"), "art");
    }
    for (const look of looks){
        expected.set(path.join(dir, `${look.hash}-front.png`), `${look.treatment} front`);
        if (look.backHash && look.back){
            expected.set(path.join(dir, `${look.backHash}-back.png`), `${look.treatment} back`);
        }
    }
    return expected;
}

module.exports = async (argv = {}) => {
    clear();
    console.log("🚀 Launching MTG Card Validator");

    const meta = readMeta();
    const expectedSource = meta?.updatedAt ?? null;
    if (expectedSource){
        console.log(`📚 Checking against the export of ${expectedSource}`);
    }
    if (argv.prune){
        console.log("🧹 --prune: unreferenced images will be deleted");
    }

    const dirs = await getDirectories(cardsDir);
    if (!dirs.length){
        console.log("⚠️  No cards found, run phase 1 first");
        return;
    }

    const stats = {
        cards: 0,
        looks: 0,
        prints: 0,
        png: 0,
        webp: 0,
        missing: 0,
        orphans: 0,
        unreadable: 0,
        miscounted: 0,
        stale: 0,
        unstamped: 0,
        partial: 0,
        reclaimed: 0,
        deleted: 0,
    };
    const complaints = [];

    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    bar.start(dirs.length, 0);

    for (const dir of dirs){
        try {
            const card = JSON.parse(await fs.promises.readFile(path.join(dir, "card.json"), { encoding: "utf8" }));
            const manifest = await fs.promises.readFile(path.join(dir, "prints.jsonl"), { encoding: "utf8" });
            const looks = manifest.split("\n").filter((line) => line.length).map((line) => JSON.parse(line));

            stats.cards++;
            stats.looks += looks.length;
            const prints = looks.reduce((total, look) => total + look.prints.length, 0);
            stats.prints += prints;

            // Which export the manifest was written from. A phase 1 that died
            // partway leaves manifests from the previous one, and nothing else
            // would notice: phase 2 would fetch printings that no longer exist
            // and phase 5 would put their ids in the import manifest regardless.
            if (expectedSource){
                if (!card.source){
                    stats.unstamped++;
                } else if (card.source !== expectedSource){
                    stats.stale++;
                    complaints.push(`🕰️  ${card.name} was written from the export of ${card.source}`);
                }
            }

            // The counts phase 1 recorded are checked rather than trusted,
            // because a manifest half written by an interrupted run would
            // otherwise look perfectly valid to every phase after it.
            if (card.lookCount !== looks.length || card.printCount !== prints){
                stats.miscounted++;
                complaints.push(`🚨 ${card.name} says ${card.lookCount} looks / ${card.printCount} prints, manifest holds ${looks.length} / ${prints}`);
            }

            const expected = expectedFiles(dir, card, looks);
            for (const [file, what] of expected){
                // An image counts as present in either form. Phase 4 --prune
                // deletes the png once the webp is written, so after a pruned
                // run the png is meant to be gone and only its absence
                // alongside a missing webp is a problem.
                const png = fs.existsSync(file);
                const webp = fs.existsSync(file.replace(/\.png$/, ".webp"));
                if (png) stats.png++;
                if (webp) stats.webp++;
                if (!png && !webp){
                    stats.missing++;
                    complaints.push(`⚠️  ${card.name} is missing its ${what} (${path.basename(file)})`);
                }
            }

            // Anything on disk the manifest does not name. After a refresh of
            // data.jsonl these are printings that have changed treatment or
            // left the data, and they would otherwise be uploaded forever.
            for (const entry of await fs.promises.readdir(dir)){
                const file = path.join(dir, entry);
                // A half written download or encode. Both phases write under
                // .part and move the file into place, so one left behind is
                // debris from a run that was killed - never a file to keep.
                if (entry.endsWith(".part")){
                    stats.partial++;
                    if (argv.prune){
                        stats.reclaimed += (await fs.promises.stat(file)).size;
                        await fs.promises.unlink(file);
                        stats.deleted++;
                    } else {
                        complaints.push(`🧩 ${card.name} has a half written ${entry}`);
                    }
                    continue;
                }
                if (!entry.endsWith(".png") && !entry.endsWith(".webp")) continue;
                const asPng = path.join(dir, entry.replace(/\.webp$/, ".png"));
                if (!expected.has(asPng)){
                    stats.orphans++;
                    if (argv.prune){
                        stats.reclaimed += (await fs.promises.stat(file)).size;
                        await fs.promises.unlink(file);
                        stats.deleted++;
                    } else {
                        complaints.push(`🧹 ${card.name} has an unreferenced ${entry}`);
                    }
                }
            }
        } catch (error){
            stats.unreadable++;
            complaints.push(`🚨 Cannot read the manifest at ${path.basename(dir)} - ${error.message}`);
        }
        bar.increment();
    }
    bar.stop();

    console.log("✔️  MTG card and image validation completed");
    console.log(`   🃏 cards:          ${stats.cards}`);
    console.log(`   🎨 looks:          ${stats.looks}`);
    console.log(`   🖨️  printings:      ${stats.prints}`);
    console.log(`   💾 images on disk: ${stats.png} png, ${stats.webp} webp`);
    if (stats.missing)    console.log(`   ⚠️  missing images: ${stats.missing}`);
    if (stats.orphans)    console.log(`   🧹 unreferenced:   ${stats.orphans}`);
    if (stats.partial)    console.log(`   🧩 half written:   ${stats.partial}`);
    if (stats.deleted)    console.log(`   🗑️  deleted:        ${stats.deleted} files, ${(stats.reclaimed / 1073741824).toFixed(2)} GB reclaimed`);
    if (stats.miscounted) console.log(`   🚨 bad manifests:  ${stats.miscounted}`);
    if (stats.unreadable) console.log(`   🚨 unreadable:     ${stats.unreadable}`);
    if (stats.stale)      console.log(`   🕰️  stale:          ${stats.stale} manifests are from an older export - re-run phase 1`);
    if (stats.unstamped)  console.log(`   📋 unstamped:      ${stats.unstamped} manifests predate provenance being recorded`);

    // Capped because a phase 2 that was interrupted early produces tens of
    // thousands of these, and a wall of them buries the summary above.
    const shown = complaints.slice(0, 40);
    for (const complaint of shown){
        console.log(`   ${complaint}`);
    }
    if (complaints.length > shown.length){
        console.log(`   ...and ${complaints.length - shown.length} more`);
    }
    if (!complaints.length){
        console.log("   ✨ Everything the manifests name is on disk");
    }
    if ((stats.orphans || stats.partial) && !argv.prune){
        console.log("\n   Pass --prune to delete what nothing references.");
    }
}
