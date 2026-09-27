const fs = require("fs");
const path = require("path");
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
require('dotenv').config();

const BUCKET = "divinedrop";
const PREFIX = "cards/";

const cacheFile = path.join(process.cwd(), "spaces-keys.txt");

const client = new S3Client({
    endpoint: "https://nyc3.digitaloceanspaces.com/",
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET
    }
});

async function listBucketKeys(){
    const keys = [];
    let token = undefined;
    let pages = 0;
    do {
        const res = await client.send(new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: PREFIX,
            ContinuationToken: token,
            MaxKeys: 1000,
        }));
        for (const obj of res.Contents ?? []){
            keys.push(obj.Key);
        }
        token = res.NextContinuationToken;
        pages++;
        if (pages % 25 === 0){
            console.log(`   ...${keys.length} objects`);
        }
    } while (token);
    return keys;
}

// The listing is ~175k keys and takes about half a minute, so it is cached on
// disk. Pass refresh (or use --refresh) after an upload run to rebuild it.
async function loadSpacesIndex(refresh = false){
    let keys = [];
    if (!refresh && fs.existsSync(cacheFile)){
        const data = await fs.promises.readFile(cacheFile, { encoding: "utf8" });
        keys = data.split("\n").filter((key) => key.length);
        console.log(`📇 Loaded ${keys.length} Spaces keys from cache (--refresh to rebuild)`);
    } else {
        console.log("☁️  Listing DigitalOcean Spaces");
        keys = await listBucketKeys();
        await fs.promises.writeFile(cacheFile, keys.join("\n"));
        console.log(`📇 Indexed ${keys.length} Spaces keys`);
    }
    return new Set(keys);
}

// Card images live at cards/<HEX CARD ID>-<YYYYMMDD>-<side>.png and art crops
// at cards/<HEX CARD ID>-art.png. That id is whatever the database holds: the
// md5 of the cleaned card name for everything imported before the uuid switch,
// which is exactly what processor.js writes into card.json. Cards created after
// that switch carry a uuid we cannot derive here, so they miss the index and
// get downloaded again - wasteful, but never wrong.
function imageKey(card, date, side){
    return `${PREFIX}${card.id.toUpperCase()}-${date.replace(/-/g, "")}-${side}.png`;
}

function artKey(card){
    return `${PREFIX}${card.id.toUpperCase()}-art.png`;
}

module.exports = { loadSpacesIndex, imageKey, artKey };
