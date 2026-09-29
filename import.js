#!/usr/bin/env node
//
// Applies an import.jsonl written by phase 5 to a database.
//
//   node import.js --file import.jsonl            apply everything
//   node import.js --file import.jsonl --dry-run  parse and report, write nothing
//   node import.js --file import.jsonl --prune    also delete rows nothing can
//                                                 render: printings with no
//                                                 hash, and anything hanging
//                                                 off a card that is not there
//   node import.js --file import.jsonl --remove-withdrawn
//                                                 also delete cards the
//                                                 manifest no longer names -
//                                                 Scryfall has withdrawn them
//
// Both sweeps report on every run and delete only when asked, so an ordinary
// refresh shows the drift without acting on it.
//
// --remove-withdrawn needs import.meta.json beside the manifest, written by
// phase 5, saying the manifest describes every card. Without that a run of
// phase 5 that deferred a dozen cards is indistinguishable from Scryfall having
// withdrawn them, and the sweep would take them out of the database and out of
// the decks that hold them. --assume-complete overrides that deliberately.
//
// This is deliberately a separate program from the phases. The manifest holds
// no Cards.id and no file paths, so the same file can be applied to a test
// database and then to production, and applying it can only touch card tables
// - never Decks, Deck_Cards or Sleeves, which a restored dump would have taken
// with it.
//
// To run it somewhere else, it needs this file, lib/importer.js,
// lib/constants.js, the manifest, its import.meta.json, and
// `npm install mysql2 uuid yargs dotenv`. deploy-import.sh ships exactly that.

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

function readJson(file){
    try {
        return JSON.parse(fs.readFileSync(file, { encoding: "utf8" }));
    } catch (error){
        return null;
    }
}

// Why phase 5's own record says the manifest is short, in the words it recorded.
function shortfall(meta){
    const reasons = [];
    if (meta.deferred) reasons.push(`${meta.deferred} cards have no image in the bucket yet`);
    if (meta.failed) reasons.push(`${meta.failed} cards failed`);
    if (meta.limited) reasons.push("it was written with --limit or --card");
    if (meta.skippedUpload) reasons.push("it was written with --skip-upload, so no image was checked");
    return reasons.length ? reasons.join(", ") : "phase 5 did not mark it complete";
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

    // What phase 5 recorded about this manifest. The withdrawn sweep deletes
    // cards, and the deck slots naming them, on the strength of a card being
    // absent from the manifest - so "absent" has to mean withdrawn upstream and
    // not "phase 5 never got that far", and this file is the only thing that
    // knows the difference.
    const metaFile = `${file.replace(/\.jsonl$/, "")}.meta.json`;
    const manifestMeta = readJson(metaFile);

    console.log("🚀 Launching MTG Card Importer");
    console.log(`📝 Manifest: ${file}`);
    if (manifestMeta){
        const exported = manifestMeta.source?.updatedAt;
        console.log(`   ${manifestMeta.complete ? "✅" : "⛔"} ${manifestMeta.cards} cards, written ${manifestMeta.generatedAt}${exported ? `, from the Scryfall export of ${exported}` : ""}`);
        if (!manifestMeta.complete){
            console.log(`   ⚠️  ${path.basename(metaFile)} says this manifest is incomplete: ${shortfall(manifestMeta)}`);
        }
    } else {
        console.log(`   ⚠️  no ${path.basename(metaFile)} beside it, so nothing records what it covers`);
    }
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

    // Every reason this run must not delete, gathered so the refusal names all
    // of them rather than the first one found.
    const blockers = [];
    if (stats.failed) blockers.push(`${stats.failed} cards failed to import, so the catalogue is not what this manifest describes`);
    if (argv.limit) blockers.push(`--limit ${argv.limit} means only part of the manifest was read`);
    if (!argv["assume-complete"]){
        if (!manifestMeta){
            blockers.push(`there is no ${path.basename(metaFile)}, so nothing says the manifest covers every card`);
        } else if (!manifestMeta.complete){
            blockers.push(`${path.basename(metaFile)} says the manifest is incomplete - ${shortfall(manifestMeta)}`);
        }
    }

    const mayRemoveWithdrawn = argv["remove-withdrawn"] && !blockers.length && !argv["dry-run"];
    if (argv["remove-withdrawn"] && blockers.length){
        console.log("   🚫 Refusing to remove withdrawn cards. This would delete deck slots, and:");
        for (const why of blockers){
            console.log(`      - ${why}`);
        }
        console.log("      Re-run phase 5 until it reports the manifest complete, or pass --assume-complete.");
    }
    if (!truncated){
        const conn = await pool.getConnection();
        try {
            const sweep = await pruneWithdrawn(conn, manifestOracleIds, {
                dryRun: !mayRemoveWithdrawn,
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
                if (argv["dry-run"]){
                    console.log("      Nothing was removed: this is a dry run.");
                } else if (!argv["remove-withdrawn"]){
                    console.log("      Pass --remove-withdrawn to delete them.");
                }
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

    // Rows nothing can render, in two shapes.
    //
    // A printing with no front_hash: the application resolves a card's image
    // from that hash, so a hashless printing is one it cannot show and a print
    // picker cannot offer. And a row hanging off a card that is not there - the
    // schema carries no foreign keys at all, so nothing cleans up after a card
    // that goes away and nothing stopped the row being written in the first
    // place.
    //
    // Both started as migration debris and both are swept on every run now,
    // because the schema still cannot stop them coming back. A sweep that
    // reports nothing is how you know it has not.
    const mayPrune = argv.prune && !stats.failed && !argv.limit && !argv["dry-run"];
    if (argv.prune && !mayPrune){
        console.log(`   🚫 Not pruning: ${argv["dry-run"] ? "this is a dry run" : "the run was incomplete"}. Reporting only.`);
    }
    {
        const conn = await pool.getConnection();
        try {
            if (mayPrune){
                const [result] = await conn.query("DELETE FROM Card_Prints WHERE front_hash IS NULL");
                if (result.affectedRows){
                    console.log(`   🧹 pruned ${result.affectedRows} printings with no hash, which nothing could render`);
                }
            } else {
                const [[left]] = await conn.query("SELECT COUNT(*) AS n FROM Card_Prints WHERE front_hash IS NULL");
                if (left.n){
                    console.log(`   📌 ${left.n} printings have no hash and cannot be rendered.${argv.prune ? "" : " Pass --prune to remove them."}`);
                }
            }

            const orphans = await pruneOrphans(conn, { dryRun: !mayPrune });
            const total = orphans.orphaned + orphans.nullCard;
            if (!total){
                console.log("   ✨ nothing hanging off a card that is not there");
            } else {
                const shape = `${orphans.orphaned} pointing at ${orphans.cardIds} cards that do not exist, ${orphans.nullCard} with no card at all`;
                if (!orphans.deleted){
                    console.log(`   📌 ${total} orphaned rows - ${shape}.`);
                    console.log(`      ${orphans.slots.length} of them are deck slots.${argv.prune ? "" : " Pass --prune to remove them."}`);
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
