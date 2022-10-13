const fs = require("fs");
const fetch = require('node-fetch');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
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

async function uploadImage(card){
    try{
        const fPath = path.join(card.dir, "front.png");
        const bPath = path.join(card.dir, "back.png");
        const bucketParams = {
            Bucket: "divinedrop",
            Key: "",
            ACL: "public-read",
            ContentType: "image/png",
        };
        if (fs.existsSync(fPath)){
            bucketParams.Body = await fs.promises.readFile(fPath);
            bucketParams.Key = "cards/" + card.id + "-front.png";
            await client.send(new PutObjectCommand(bucketParams));
            card.front = "https://divinedrop.nyc3.cdn.digitaloceanspaces.com/" + bucketParams.Key;
        }
        if (fs.existsSync(bPath)){
            bucketParams.Body = await fs.promises.readFile(bPath);
            bucketParams.Key = "cards/" + card.id + "-back.png";
            await client.send(new PutObjectCommand(bucketParams));
            card.back = "https://divinedrop.nyc3.cdn.digitaloceanspaces.com/" + bucketParams.Key;
        }
    } catch (e) {
        console.log(e);
        process.exit(1);
    }
}

module.exports = { uploadImage };
