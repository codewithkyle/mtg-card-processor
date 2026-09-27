const path = require("path");
const clear = require('clear');
const { Worker } = require("worker_threads");
require('dotenv').config();
const { getDirectories } = require("../lib/utils");
const cliProgress = require('cli-progress');
const WebCPU = require('webcpu/dist/umd/webcpu').WebCPU;

clear();
console.log("🚀 Launching MTG Card Uploader");

const cwd = process.cwd();
const cardsDir = path.join(cwd, "cards");

// Connection settings come from the environment so the same code can be aimed
// at the local test database (./local-db.sh) or at production. DSN wins when it
// is set; otherwise the individual pieces do, and they default to what the
// local script provisions.
const db = process.env.DSN || {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "ddadmin",
    password: process.env.DB_PASSWORD || "password",
    database: process.env.DB_NAME || "divinedrop",
};

// Never print the password, but do say which server is about to be written to.
function describe(target){
    if (typeof target === "string"){
        return target.replace(/\/\/[^:@/]*:[^@/]*@/, "//***:***@");
    }
    return `${target.user}@${target.host}:${target.port}/${target.database}`;
}

module.exports = async () => { 
    console.log(`🗄️  Database: ${describe(db)}`);
    const errors = [];
    const cards = await getDirectories(cardsDir);
    if (!cards.length){
        console.log("⚠️  No cards found, run phase 1 first");
        return;
    }
    const { reportedCores, estimatedIdleCores, estimatedPhysicalCores } = await WebCPU.detectCPU();
    // Never spawn more workers than there are cards to hand out. A worker primed
    // with an undefined directory throws, and a worker that is never primed never
    // reports back, which stalls the run waiting on a NEXT that cannot come.
    let TOTAL_WORKER_COUNT = Math.min(estimatedIdleCores, cards.length);
    const workerPool = [];

    await new Promise(async (resolveGenerator) => {
        const workerPromises = [];
        let finishedWorkers = 0;
        const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
        console.log(`🧵 Spawning ${TOTAL_WORKER_COUNT} worker threads`);
        for (let i = 0; i < TOTAL_WORKER_COUNT; i++){
            workerPromises.push(new Promise((resolveWorker) => {
                const worker = new Worker(path.join(__dirname, "worker.js"), {
                    workerData: {
                        db,
                    },
                });
                worker.on('message', ({ type, data }) => {
                    switch(type){
                        case "READY":
                            resolveWorker();
                            break;
                        case "ERROR":
                            console.log(data);
                            process.exit(1);
                        case "NEXT":
                            // A card just finished. Count completions here, not
                            // dispatches: the cards handed out to prime the pool
                            // never pass through the branch below, so counting
                            // dispatches left the bar short by the worker count.
                            bar.increment();
                            if (cards.length){
                                worker.postMessage(cards.pop());
                            } else {
                                finishedWorkers++;
                                if (finishedWorkers === workerPool.length){
                                    bar.stop();
                                    resolveGenerator();
                                }
                            }
                            break;
                        default:
                            break;
                    }
                });
                worker.on("error", (error) => {
                    console.log(error);
                    process.exit(1);
                });
                workerPool.push(worker);
            }));
        }
        await Promise.all(workerPromises);
        console.log("🚀 Updating cards database");
        bar.start(cards.length, 0);
        for (const worker of workerPool){
            worker.postMessage(cards.pop());
        }
    });
    console.log("✔️  Finished importing cards");
    for (const worker of workerPool){
        worker.terminate();
    }
    if (errors.length){
        console.log("🚨 Errors:");
        for (const error of errors){
            console.log(error);
        }
    }
}

