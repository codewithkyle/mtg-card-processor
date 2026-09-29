#!/usr/bin/env node
//
// Applies an import.jsonl written by phase 5 to a database.
//
//   node import.js --file import.jsonl            apply everything
//   node import.js --file import.jsonl --dry-run  parse and report, write nothing
//   node import.js --file import.jsonl --prune    also drop the pre-hash rows
//
// This is deliberately a separate program from the phases. The manifest holds
// no Cards.id and no file paths, so the same file can be applied to a test
// database and then to production, and applying it can only touch card tables
// - never Decks, Deck_Cards or Sleeves, which a restored dump would have taken
// with it.
//
// To run it somewhere else, it needs this file, lib/importer.js,
// lib/constants.js, the manifest, and `npm install mysql2 uuid yargs dotenv`.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const mysql = require("mysql2/promise");
const cliProgress = require("cli-progress");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
require("dotenv").config();

const { importCard, resolveOrCreateId } = require("./lib/importer");

const argv = yargs(hideBin(process.argv)).argv;
const WORKERS = 8;
const errorFile = path.join(process.cwd(), "import-errors");

const db = process.env.DSN || {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "ddadmin",
    password: process.env.DB_PASSWORD || "password",
    database: process.env.DB_NAME || "divinedrop",
};

function describe(target){
    if (typeof target === "string"){
        return target.replace(/\/\/[^:@/]*:[^@/]*@/, "//***:***@");
    }
    return `${target.user}@${target.host}:${target.port}/${target.database}`;
}

// Counted up front so the progress bar can show how long this will take. The
// file is tens of megabytes, so reading it twice costs about a second.
async function countLines(file){
    let count = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl){
        if (line.length) count++;
    }
    return count;
}

(async () => {
    const file = argv.file ? path.resolve(argv.file) : path.join(process.cwd(), "import.jsonl");
    if (!fs.existsSync(file)){
        console.log(`🚨 No manifest at ${file}. Run phase 5 first.`);
        process.exit(1);
    }

    console.log("🚀 Launching MTG Card Importer");
    console.log(`📝 Manifest: ${file}`);
    console.log(`🗄️  Database: ${describe(db)}${argv["dry-run"] ? "  (dry run, nothing will be written)" : ""}`);

    let pool;
    try {
        pool = typeof db === "string" ? mysql.createPool(db) : mysql.createPool({ ...db, connectionLimit: WORKERS + 1 });
        await pool.query("SELECT 1");
    } catch (error){
        console.log(`🚨 Could not connect to the database: ${error.message}`);
        process.exit(1);
    }

    const total = argv.limit ? Number(argv.limit) : await countLines(file);
    const stats = { cards: 0, created: 0, prints: 0, failed: 0 };

    const bar = new cliProgress.SingleBar({
        format: "   {bar} {percentage}% | {value}/{total} cards | {eta_formatted} left | {new} new",
    }, cliProgress.Presets.shades_classic);
    bar.start(total, 0, { new: 0 });

    async function apply(card){
        if (argv["dry-run"]){
            stats.cards++;
            stats.prints += card.prints.length;
            return;
        }
        const conn = await pool.getConnection();
        try {
            const { id, created } = await resolveOrCreateId(conn, card.oracleId);
            card.id = id;
            await importCard(conn, card, card.prints, created);
            stats.cards++;
            stats.prints += card.prints.length;
            if (created) stats.created++;
        } finally {
            conn.release();
        }
    }

    // Applied in batches rather than all at once so the manifest never has to
    // be held in memory, while still keeping the pool busy.
    async function drain(batch){
        const queue = [...batch];
        await Promise.all(Array.from({ length: WORKERS }, async () => {
            while (queue.length){
                const card = queue.pop();
                try {
                    await apply(card);
                } catch (error){
                    stats.failed++;
                    fs.appendFileSync(errorFile, `${error.message} - ${card.oracleId} ${card.name}\n`);
                }
                bar.increment({ new: stats.created });
            }
        }));
    }

    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let batch = [];
    let read = 0;
    for await (const line of rl){
        if (!line.length) continue;
        if (argv.limit && read >= Number(argv.limit)) break;
        read++;
        batch.push(JSON.parse(line));
        if (batch.length >= WORKERS * 8){
            await drain(batch);
            batch = [];
        }
    }
    if (batch.length){
        await drain(batch);
    }
    rl.close();
    bar.stop();

    console.log("✔️  Finished importing cards");
    console.log(`   🃏 cards:     ${stats.cards} (${stats.created} new)`);
    console.log(`   🖨️  printings: ${stats.prints}`);
    if (stats.failed) console.log(`   🚨 failed:    ${stats.failed} - see ${errorFile}`);

    // Rows written before printings carried hashes. They have to outlive the
    // import, because migrating Deck_Cards.print off release dates reads them.
    if (argv.prune){
        if (stats.failed || argv.limit || argv["dry-run"]){
            console.log("   🚫 Refusing to prune after an incomplete run");
        } else {
            const [result] = await pool.query("DELETE FROM Card_Prints WHERE front_hash IS NULL");
            console.log(`   🧹 pruned ${result.affectedRows} rows left over from the release date scheme`);
        }
    } else {
        const [[left]] = await pool.query("SELECT COUNT(*) AS n FROM Card_Prints WHERE front_hash IS NULL");
        if (left.n){
            console.log(`   📌 ${left.n} rows still have no hash. Migrate Deck_Cards.print, then re-run with --prune.`);
        }
    }

    await pool.end();
})().catch((error) => {
    console.log(error);
    process.exit(1);
});
