const fs = require("fs");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
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


async function uploadImage(id, card, side, file){
    try{
        const fPath = path.join(card.dir, file);
        if (!fs.existsSync(fPath)){
            console.error(`${fPath} does not exist!`);
            throw `${fPath} does not exist!`;
        }
        const bucketParams = {
            Bucket: "divinedrop",
            Key: `cards/${id}-${side}`,
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

async function deleteImage(card, side){
    try{
        const bucketParams = {
            Bucket: "divinedrop",
            Key: `cards/${card.id.toLowerCase()}-${side}`,
        };
        await client.send(new DeleteObjectCommand(bucketParams));
    } catch (e) {
        console.log(e);
        process.exit(1);
    }
}

module.exports = { uploadImage, deleteImage };
