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

const dsn = process.env.DSN;

module.exports = async () => { 
    const errors = [];
    const { reportedCores, estimatedIdleCores, estimatedPhysicalCores } = await WebCPU.detectCPU();
    let TOTAL_WORKER_COUNT = estimatedIdleCores;
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
                        DSN: dsn,
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
                            if (cards.length){
                                worker.postMessage(cards.pop());
                                bar.increment();
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
        const cards = await getDirectories(cardsDir);
        bar.start(cards.length, 0);
        for (let i = 0; i < workerPool.length; i++){
            workerPool[i].postMessage(cards.pop());
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

