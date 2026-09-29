const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const argv = yargs(hideBin(process.argv)).argv

// What each phase is for, in the order they run. Printed when the phase is
// missing or unknown, because the alternative is remembering that 4 is the
// converter and 5 is the uploader.
const PHASES = [
    [0, "fetch",    "download the current Scryfall bulk export to data.jsonl"],
    [1, "process",  "group its printings into cards/<oracle id>/ manifests"],
    [2, "download", "fetch every image a manifest names"],
    [3, "validate", "check the manifests against what is on disk"],
    [4, "convert",  "encode the png images as webp"],
    [5, "upload",   "put the webp in the bucket and write import.jsonl"],
];

// Nullish rather than falsy, because `-p 0` is a phase and `0 || null` is null.
// That bug made phase 0 unreachable the moment it was added.
const requested = argv?.p ?? argv?.phase ?? null;

const match = PHASES.find(([number, name]) => requested === number || requested === name || requested === String(number));

if (!match){
    console.log("⚠️  Which phase? Pass -p or --phase.\n");
    for (const [number, name, what] of PHASES){
        console.log(`   ${number}  ${name.padEnd(9)} ${what}`);
    }
    console.log("\n   Then: node import.js --file import.jsonl");
    console.log("   The whole sequence is written up in README.md.");
    process.exit(requested === null ? 0 : 1);
}

require(`./phases/phase-${match[0]}`)(argv);
