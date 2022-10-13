const fs = require("fs");
const fetch = require('node-fetch');
const { S3Client, PutObjectCommand, ListObjectsCommand } = require("@aws-sdk/client-s3");
const path = require("path");
require('dotenv').config();

const client = new S3Client({
    endpoint: "https://nyc3.digitaloceanspaces.com/",
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET
    }
});

async function getImageList(){
    const params = {
        Bucket: "divinedrop",
    };
    const res = await client.send(new ListObjectsCommand(params));
    const data = res.Contents;
    let out = [];
    for (let i = 0; i < data.length; i++){
        if (data[i].Key.indexOf("cards/") !== -1){
            const name = data[i].Key.replace("cards/", "").trim();
            out.push(name);
        }
    }
    return out;
}

async function uploadImage(card, side){
    try{
        const fPath = path.join(card.dir, side);
        if (!fs.existsSync(fPath)){
            throw `${fPath} does not exist!`;
        }
        const bucketParams = {
            Bucket: "divinedrop",
            Key: `cards/${card.id}-${side}`,
            ACL: "public-read",
            ContentType: "image/png",
            Body: await fs.promises.readFile(fPath),
        };
        await client.send(new PutObjectCommand(bucketParams));
    } catch (e) {
        console.log(e);
        process.exit(1);
    }
}

async function uploadCardsFile(file){
    const bucketParams = {
        Bucket: "divinedrop",
        Key: "cards.jsonl",
        ACL: "public-read",
        Body: await fs.promises.readFile(file),
    };
    await client.send(new PutObjectCommand(bucketParams));
}

module.exports = { uploadImage, getImageList, uploadCardsFile };
