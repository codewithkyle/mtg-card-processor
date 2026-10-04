#!/usr/bin/env node
//
// Writes a mysqldump defaults file for the database import.js is about to write
// to, and prints that database's name on stdout.
//
//   node db-cnf.js .backup.cnf
//
// deploy-import.sh ships this so the pre-deploy backup resolves the database
// through lib/db.js, from the same .env the importer reads, rather than by a
// second reading of DSN that could disagree with it.
//
// The password reaches mysqldump in a file nothing else can read, never on a
// command line - the server's process list is world readable, and a dump is
// slow enough to be caught sitting there.
require("dotenv").config();

const fs = require("fs");
const { resolveParts, describe } = require("./lib/db");

const out = process.argv[2];
if (!out){
    console.error("usage: node db-cnf.js <file>");
    process.exit(1);
}

const parts = resolveParts();
if (!parts.database){
    console.error("🚨 nothing in the environment names a database to back up");
    process.exit(1);
}

// Option files take \\ and \" inside a double quoted value, so a password with
// a # or a space in it survives being written here.
const quote = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Removed first: the mode below applies only to a file this call creates, so a
// leftover from an interrupted run would keep whatever mode it already had.
fs.rmSync(out, { force: true });
fs.writeFileSync(out, [
    "[client]",
    `host=${quote(parts.host)}`,
    `port=${parts.port}`,
    `user=${quote(parts.user)}`,
    `password=${quote(parts.password)}`,
    "",
].join("\n"), { mode: 0o600 });

// stderr, so the operator sees which database this is while stdout stays the
// one machine readable thing the caller is reading.
console.error(`      ${describe(parts)}   [from ${parts.source}]`);
console.log(parts.database);
