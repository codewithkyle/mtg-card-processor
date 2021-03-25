const path = require("path");
var clear = require('clear');
const fs = require("fs");
const StreamArray = require( 'stream-json/streamers/StreamArray');
const {chain}  = require('stream-chain');

const cwd = process.cwd();
const outDir = path.join(cwd, "cards");
const file = path.join(process.cwd(), "data.json");
if (!fs.existsSync(file)){
    console.log(`Missing file at ${file}`);
    process.exit(1);
}
const { prep, checkCardValidity } = require("../lib/utils");
prep(outDir);
const processCard = require("../lib/processor");

module.exports = async () => {
	clear();
	console.log("🚀 Launching MTG Card Processor");
    try{
		console.log(`💽 Streaming card data from ${file}`);
        const pipeline = chain([
            fs.createReadStream(file),
            StreamArray.withParser({ objectMode: true }),
        ]);
        console.log(`🤖 Starting to process the card data`);
        let cardCount = 0;
        for await (let chunk of pipeline) {
            if (checkCardValidity(chunk.value)){
                cardCount++;
                await processCard(chunk.value, outDir, cardCount);
            }
        }
    }catch (error){
        console.log(error);
        process.exit(1);
    }
	console.log("✔️  MTG card processing completed");
    process.exit(0);
}
