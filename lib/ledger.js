const fs = require("fs");
const path = require("path");

// What an image is called in the bucket, and which of those objects are already
// there.
//
// Naming and the ledger are one question - "what is this image called in R2, and
// do we already have it" - and every phase from 2 onwards needs to ask it. They
// live here rather than in lib/upload.js so that asking costs nothing: upload.js
// pulls in the S3 client and reads the credentials, and phases 2, 3 and 4 have no
// business doing either. lib/upload.js re-exports these so phase 5 still gets
// them from one place.

const PREFIX = "cards/";

// The ledger is one key per line, appended by phase 5 after a PutObject resolves.
// A key being in it is a promise that the bytes are in the bucket, which is what
// every resume below rests on.
const ledgerFile = path.join(process.cwd(), "uploaded");

// A face is addressed by the hash of what it shows, so every printing that looks
// alike resolves to one object and the bucket holds 73,861 fronts rather than
// 108,839. The -front / -back suffix is redundant next to the hash and kept
// because it makes a bucket listing readable.
function faceKey(hash, side, extension = ".webp"){
    return `${PREFIX}${hash.toLowerCase()}-${side}${extension}`;
}

// The crop belongs to the printing the card defaults to, so it is addressed by
// that printing's hash. Nothing here needs to know a card id, which is what lets
// the upload run without a database.
function artKey(hash, extension = ".webp"){
    return `${PREFIX}${hash.toLowerCase()}-art${extension}`;
}

// Missing file, empty Set: every phase then behaves exactly as it did before the
// ledger was consulted at all, which is what makes this safe to add. 111,547
// keys is 5.5MB and a few hundred milliseconds.
function load(){
    if (!fs.existsSync(ledgerFile)){
        return new Set();
    }
    const keys = fs.readFileSync(ledgerFile, { encoding: "utf8" })
        .split("\n")
        .filter((key) => key.length);
    return new Set(keys);
}

// One line for a phase to print, so all four say the same thing about it.
function describe(ledger){
    if (!ledger.size){
        return `no ${path.basename(ledgerFile)} ledger - every image will be treated as missing`;
    }
    return `${ledger.size} objects in ${path.basename(ledgerFile)}`;
}

// What phase 4 leaves in a png's place. Here rather than in three phases,
// because all three have to agree on it: phase 4 --prune deletes the png once
// the webp is written, so a check that only looked for the png would call a
// converted catalogue entirely missing.
function webpFor(file){
    return file.replace(/\.png$/, ".webp");
}

module.exports = { load, describe, faceKey, artKey, webpFor, PREFIX, ledgerFile };
