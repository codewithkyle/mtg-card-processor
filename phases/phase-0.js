const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Transform, PassThrough } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const fetch = require("node-fetch");
const cliProgress = require("cli-progress");
var clear = require('clear');

const cwd = process.cwd();
const dataFile = path.join(cwd, "data.jsonl");
const metaFile = path.join(cwd, "data.meta.json");

// Where the catalogue comes from. This phase exists because that was the one
// step nothing in the repo recorded: data.jsonl was a 600MB file that appeared
// by hand, and six months later there is no way to tell which bulk export it
// came from or how old it is.
const BULK_INDEX = "https://api.scryfall.com/bulk-data";

// default_cards is one row per printing, English where a printing has it. That
// is exactly what phase 1 groups: oracle_cards would collapse the printings we
// exist to tell apart, unique_artwork pre-folds them on illustration_id alone
// (which lib/hash.js explains is not enough), and all_cards adds every other
// language for phase 1 to throw away.
const BULK_TYPE = "default_cards";

// Scryfall asks for a descriptive agent and refuses a default one.
const UA = "divinedrop-card-processor/1.0";

const GZIP_MAGIC = [0x1f, 0x8b];

function mb(bytes){
    return `${(bytes / 1048576).toFixed(0)} MB`;
}

function readMeta(){
    try {
        return JSON.parse(fs.readFileSync(metaFile, { encoding: "utf8" }));
    } catch (error){
        return null;
    }
}

// Counts lines on the way past rather than reading the finished file again.
// 632MB is a second and a half of pure I/O that buys nothing: the number is
// wanted for the record, not for a decision.
function lineCounter(state){
    return new Transform({
        transform(chunk, encoding, done){
            let at = chunk.indexOf(10);
            while (at !== -1){
                state.lines++;
                at = chunk.indexOf(10, at + 1);
            }
            done(null, chunk);
        },
    });
}

// The export is a .gz file, and separately the server may or may not announce
// it as Content-Encoding: gzip - in which case node-fetch would have already
// decompressed it. Guessing wrong writes either gibberish or nothing, and both
// only surface as a parse error in phase 1, so the first two bytes decide.
function gunzipIfNeeded(source){
    const out = new PassThrough();
    let decided = false;
    source.on("error", (error) => out.destroy(error));
    source.on("data", function decide(chunk){
        if (decided) return;
        decided = true;
        source.pause();
        source.removeListener("data", decide);
        const gzipped = chunk[0] === GZIP_MAGIC[0] && chunk[1] === GZIP_MAGIC[1];
        const head = gzipped ? zlib.createGunzip() : new PassThrough();
        head.on("error", (error) => out.destroy(error));
        head.pipe(out);
        head.write(chunk);
        source.pipe(head);
        source.resume();
    });
    source.on("end", () => { if (!decided) out.end(); });
    return out;
}

async function bulkEntry(){
    const res = await fetch(BULK_INDEX, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok){
        throw new Error(`HTTP ${res.status} ${res.statusText} from ${BULK_INDEX}`);
    }
    const body = await res.json();
    const entry = (body?.data ?? []).find((item) => item.type === BULK_TYPE);
    if (!entry){
        throw new Error(`Scryfall's bulk index no longer lists ${BULK_TYPE}. It offers: ${(body?.data ?? []).map((i) => i.type).join(", ")}`);
    }
    return entry;
}

module.exports = async (argv = {}) => {
    clear();
    console.log("🚀 Launching MTG Bulk Data Fetcher");

    let entry;
    try {
        entry = await bulkEntry();
    } catch (error){
        console.log(`🚨 Could not read Scryfall's bulk index: ${error.message}`);
        process.exit(1);
    }

    // jsonl_download_uri is what phase 1 can stream. Scryfall used to publish
    // these as one big JSON array under download_uri, and if it ever goes back
    // to that this stops rather than writing a file phase 1 cannot parse.
    const url = entry["jsonl_download_uri"];
    if (!url){
        console.log(`🚨 ${BULK_TYPE} has no jsonl_download_uri.`);
        console.log(`   Scryfall offers ${entry["download_uri"] ?? "nothing else"}, which is a single JSON array.`);
        console.log("   Phase 1 streams one object per line, so that would need converting first.");
        process.exit(1);
    }

    console.log(`📚 ${entry.name ?? BULK_TYPE}, updated ${entry["updated_at"]}`);
    console.log(`   ${mb(entry["compressed_size"] ?? 0)} compressed, from ${url}`);

    const have = readMeta();
    if (have && have.updatedAt === entry["updated_at"] && fs.existsSync(dataFile) && !argv.force){
        console.log("✔️  data.jsonl is already this export - nothing to fetch");
        console.log(`   ${have.lines} cards, fetched ${have.fetchedAt}`);
        console.log("   Pass --force to download it again anyway.");
        return;
    }
    if (have && fs.existsSync(dataFile)){
        console.log(`♻️  Replacing the export from ${have.updatedAt} (${have.lines} cards)`);
    }

    const res = await fetch(url, { headers: { "User-Agent": UA }, compress: false });
    if (!res.ok){
        console.log(`🚨 HTTP ${res.status} ${res.statusText} downloading the export`);
        process.exit(1);
    }

    const expected = Number(res.headers.get("content-length") || entry["compressed_size"] || 0);
    const state = { lines: 0 };
    let received = 0;

    const bar = new cliProgress.SingleBar({
        format: "   {bar} {percentage}% | {mb} MB | {eta_formatted} left | {cards} cards",
    }, cliProgress.Presets.shades_classic);
    bar.start(expected || 1, 0, { mb: 0, cards: 0 });
    res.body.on("data", (chunk) => {
        received += chunk.length;
        bar.update(Math.min(received, expected || received), {
            mb: Math.round(received / 1048576),
            cards: state.lines,
        });
    });

    // Written beside the real file and moved into place at the end, so a
    // download that dies halfway leaves the previous export intact. Every
    // later phase reads data.jsonl directly and none of them would notice a
    // truncated one - phase 1 would simply grind to a halt mid-catalogue and
    // report however many cards it managed to see as the whole of Magic.
    const part = `${dataFile}.part`;
    try {
        await pipeline(gunzipIfNeeded(res.body), lineCounter(state), fs.createWriteStream(part));
    } catch (error){
        bar.stop();
        await fs.promises.rm(part, { force: true });
        console.log(`🚨 Download failed: ${error.message}`);
        console.log("   The previous data.jsonl is untouched. Re-run phase 0 to try again.");
        process.exit(1);
    }
    bar.stop();

    const { size } = await fs.promises.stat(part);
    await fs.promises.rename(part, dataFile);

    const meta = {
        type: BULK_TYPE,
        updatedAt: entry["updated_at"],
        fetchedAt: new Date().toISOString(),
        url,
        lines: state.lines,
        bytes: size,
    };
    await fs.promises.writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`);

    console.log("✔️  Bulk data downloaded");
    console.log(`   📦 ${path.basename(dataFile)}: ${state.lines} printings, ${mb(size)}`);
    console.log(`   🗓️  Scryfall exported it ${entry["updated_at"]}`);
    console.log(`   📝 provenance recorded in ${path.basename(metaFile)}`);
    console.log("\n   Next: npm run phase1");
}
