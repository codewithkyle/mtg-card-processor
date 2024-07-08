const fs = require("fs");
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
            ContentType: "image/webp",
            Body: await fs.promises.readFile(fPath),
        };
        await client.send(new PutObjectCommand(bucketParams));
    } catch (e) {
        console.log(e);
        process.exit(1);
    }
}

module.exports = { uploadImage };
