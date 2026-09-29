#!/usr/bin/env node
//
// Applies an import.jsonl written by phase 5 to a database.
//
//   node import.js --file import.jsonl            apply everything
//   node import.js --file import.jsonl --dry-run  parse and report, write nothing
//   node import.js --file import.jsonl --prune    also drop the pre-hash rows
//                                                 and any row hanging off a
//                                                 card that is not there
//   node import.js --file import.jsonl --remove-withdrawn
//                                                 also delete cards Scryfall no
//                                                 longer carries
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

const { importCard, pruneWithdrawn, pruneOrphans } = require("./lib/importer");

const argv = yargs(hideBin(process.argv)).argv;
const WORKERS = 8;
const errorFile = path.join(process.cwd(), "import-errors");
const withdrawnFile = path.join(process.cwd(), "withdrawn-removed.tsv");
const orphanFile = path.join(process.cwd(), "orphans-removed.tsv");

// How the database is named, in the forms the environments actually use.
//
// DSN is only handed to mysql2 when it is a URI, because that is the one form
// mysql2 parses. Production sets DSN in the Go driver's own format instead -
// user:pass@tcp(host:port)/dbname - which mysql2 accepts without complaint and
// silently mangles: user comes out undefined, password empty, host localhost and
// the database "assword@tcp(...)". What reaches you is "Access denied for user
// ''", which names none of that. So the Go form is parsed here instead, and a
// DSN in neither form is ignored out loud rather than quietly.
function fromParts(){
    return {
        host: process.env.DB_HOST || "localhost",
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || "ddadmin",
        password: process.env.DB_PASSWORD || "password",
        database: process.env.DB_NAME || "divinedrop",
    };
}

function resolveDb(){
    const dsn = (process.env.DSN || "").trim();
    if (!dsn){
        return { config: fromParts(), source: "DB_*" };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(dsn)){
        return { config: dsn, source: "DSN as a uri" };
    }
    // user:pass@tcp(host:port)/dbname?params - the net and address are optional
    // in the Go format, and so is the credential pair.
    const go = dsn.match(/^(?:([^:@/]*)(?::([^@]*))?@)?[a-z]*(?:\(([^)]*)\))?\/([^?]+)/i);
    if (go){
        const [, user, password, addr, database] = go;
        const [host, port] = (addr || "").split(":");
        const parts = fromParts();
        return {
            config: {
                host: host || parts.host,
                port: Number(port) || parts.port,
                user: user || parts.user,
                password: password ?? parts.password,
                database: database || parts.database,
            },
            source: "DSN in the Go driver format",
        };
    }
    return { config: fromParts(), source: "DB_* (DSN is set but in no form this understands, so it was ignored)" };
}

const { config: db, source: dbSource } = resolveDb();

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
    console.log(`🗄️  Database: ${describe(db)}   [from ${dbSource}]${argv["dry-run"] ? "  (dry run, nothing will be written)" : ""}`);

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
            const { created } = await importCard(conn, card, card.prints);
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

    // Collected as the file streams past, because the sweep at the end needs to
    // know every card the manifest describes and the manifest is too big to hold
    // in memory as objects. 36,000 oracle ids is about a megabyte of strings.
    const manifestOracleIds = new Set();

    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let batch = [];
    let read = 0;
    for await (const line of rl){
        if (!line.length) continue;
        if (argv.limit && read >= Number(argv.limit)) break;
        read++;
        const card = JSON.parse(line);
        manifestOracleIds.add(card.oracleId);
        batch.push(card);
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

    // Cards the manifest does not describe. Reported on every run so a drift
    // between the catalogue and Scryfall is visible without being acted on, and
    // removed only when asked - it deletes user deck slots, which no run should
    // do as a side effect of importing.
    //
    // A run that failed or was cut short does not even report: its set of oracle
    // ids is not the whole manifest, and every card missing from it looks exactly
    // like a card Scryfall withdrew. A dry run has the whole set, so it reports
    // and never deletes.
    const truncated = stats.failed || argv.limit;
    if (argv["remove-withdrawn"] && truncated){
        console.log("   🚫 Refusing to remove withdrawn cards after an incomplete run");
    } else if (!truncated){
        const conn = await pool.getConnection();
        try {
            const sweep = await pruneWithdrawn(conn, manifestOracleIds, {
                dryRun: !argv["remove-withdrawn"] || argv["dry-run"],
                maxShare: argv["withdrawn-max-share"] ? Number(argv["withdrawn-max-share"]) : undefined,
            });
            if (sweep.refused){
                console.log(`   🚨 ${sweep.refused}`);
                console.log("      That reads as a truncated manifest, not as news from Scryfall. Nothing was removed.");
                console.log("      Re-run phase 5 until it defers nothing, or pass --withdrawn-max-share to override.");
            } else if (!sweep.withdrawn.length){
                console.log("   ✨ every card in the catalogue is still in the manifest");
            } else if (!sweep.deleted){
                console.log(`   📌 ${sweep.withdrawn.length} cards are no longer in the manifest, across ${new Set(sweep.slots.map((s) => s.deckId)).size} decks (${sweep.slots.length} slots).`);
                console.log(`      ${argv["dry-run"] ? "Nothing was removed: this is a dry run." : "Pass --remove-withdrawn to delete them."}`);
            } else {
                // Written before the summary because it is the only record that
                // a given deck ever held a given card.
                fs.writeFileSync(withdrawnFile,
                    "# cards removed as withdrawn upstream, and the deck slots that named them\n" +
                    "deck_id\tdeck\towner\tcard\tqty\tsideboard\n" +
                    sweep.slots.map((s) => [s.deckId, s.deck, s.owner, s.card, s.qty, s.sideboard].join("\t")).join("\n") + "\n");
                const children = Object.values(sweep.deleted.children).reduce((a, b) => a + b, 0);
                console.log(`   🧹 removed ${sweep.deleted.cards} cards Scryfall no longer carries, and ${children} rows hanging off them`);
                console.log(`   🃏 ${sweep.deleted.slots} deck slots named one and are gone; the decks are untouched`);
                if (sweep.deleted.references){
                    console.log(`   ⚠️  ${sweep.deleted.references} commander/partner references cleared`);
                }
                console.log(`   📝 what each deck lost: ${withdrawnFile}`);
            }
        } finally {
            conn.release();
        }
    }

    // Rows written before printings carried hashes, and rows hanging off a card
    // that no longer exists. Both are debris of the old scheme, so one flag
    // clears both.
    //
    // The pre-hash printings have to go before the application migrates
    // Deck_Cards.print off release dates, not after: that migration aborts on a
    // choice whose printing still exists without a hash, and every one of these
    // rows is exactly that. The choices worth resolving resolve against the
    // hashed rows this import wrote.
    if (argv.prune && (stats.failed || argv.limit || argv["dry-run"])){
        console.log("   🚫 Refusing to prune after an incomplete run");
    } else {
        const conn = await pool.getConnection();
        try {
            if (argv.prune){
                const [result] = await conn.query("DELETE FROM Card_Prints WHERE front_hash IS NULL");
                console.log(`   🧹 pruned ${result.affectedRows} rows left over from the release date scheme`);
            } else {
                const [[left]] = await conn.query("SELECT COUNT(*) AS n FROM Card_Prints WHERE front_hash IS NULL");
                if (left.n){
                    console.log(`   📌 ${left.n} rows still have no hash. Prune them before migrating Deck_Cards.print.`);
                }
            }

            const orphans = await pruneOrphans(conn, { dryRun: !argv.prune });
            const total = orphans.orphaned + orphans.nullCard;
            if (!total){
                console.log("   ✨ nothing hanging off a card that is not there");
            } else {
                const shape = `${orphans.orphaned} pointing at ${orphans.cardIds} cards that do not exist, ${orphans.nullCard} with no card at all`;
                if (!orphans.deleted){
                    console.log(`   📌 ${total} orphaned rows - ${shape}.`);
                    console.log(`      ${orphans.slots.length} of them are deck slots. Pass --prune to remove them.`);
                } else {
                    if (orphans.slots.length){
                        fs.writeFileSync(orphanFile,
                            "# deck slots removed because the card they named does not exist\n" +
                            "deck_id\tdeck\towner\tcard_id\tqty\tsideboard\n" +
                            orphans.slots.map((s) => [s.deckId, s.deck, s.owner, s.cardId, s.qty, s.sideboard].join("\t")).join("\n") + "\n");
                    }
                    console.log(`   🧹 pruned ${total} orphaned rows - ${shape}`);
                    if (orphans.slots.length){
                        console.log(`   🃏 ${orphans.slots.length} were deck slots; the decks are untouched - ${orphanFile}`);
                    }
                    if (orphans.references){
                        console.log(`   ⚠️  ${orphans.references} commander/partner references cleared`);
                    }
                }
            }
        } finally {
            conn.release();
        }
    }

    await pool.end();
})().catch((error) => {
    console.log(error);
    process.exit(1);
});
