const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
require('dotenv').config();

// Every setting comes from the environment under the same names the
// application uses in helpers/s3.go, so one .env shape serves both repos and
// moving hosts is a change to the environment rather than a release. The
// fallbacks are the DigitalOcean Space this has always written to.
const PREFIX = "cards/";

function envOr(name, fallback){
    const value = (process.env[name] ?? "").trim();
    return value.length ? value : fallback;
}

const BUCKET = envOr("S3_BUCKET", "divinedrop");

// R2 wants the bucket as the first path segment of an account endpoint, where
// Spaces serves it as a subdomain. It is the one setting that has to change
// for the move and the one with no sensible default.
const client = new S3Client({
    endpoint: envOr("S3_ENDPOINT", "https://nyc3.digitaloceanspaces.com/"),
    region: envOr("S3_REGION", "us-east-1"),
    forcePathStyle: envOr("S3_FORCE_PATH_STYLE", "false") === "true",
    credentials: {
        accessKeyId: envOr("S3_ACCESS_KEY_ID", process.env.SPACES_KEY),
        secretAccessKey: envOr("S3_SECRET_ACCESS_KEY", process.env.SPACES_SECRET),
    },
});

// Spaces needs public-read on every object to serve it. R2 has no per object
// ACLs at all and rejects the header, so this is sent only when asked for:
// leave S3_ACL unset for R2, set it to public-read for Spaces.
const ACL = envOr("S3_ACL", null);

const CONTENT_TYPES = {
    ".webp": "image/webp",
    ".png": "image/png",
};

// A face is addressed by a hash of its own content, so the bytes behind one of
// those URLs can never change: a different image is a different key. That is
// what immutable means, and it lets the CDN answer for a year without ever
// asking the bucket - which matters because a read served from cache is
// neither billed as a Class B operation nor counted against a rate limit.
const IMMUTABLE = "public, max-age=31536000, immutable";

// Art used to be the exception, named for the card id and therefore mutable.
// That made the bucket depend on the database: the id is resolved per
// environment, so a card first seen locally would be uploaded under one id and
// looked up under another on production. Art is now addressed by the hash of
// the printing its crop comes from, which is environment independent and
// immutable for the same reason a face is - a different default printing is a
// different hash and so a different object.

// A face is addressed by the hash of what it shows, so every printing that
// looks alike resolves to one object and the bucket holds 73,861 fronts rather
// than 108,834. The -front / -back suffix is redundant next to the hash and
// kept because it makes a bucket listing readable.
function faceKey(hash, side, extension = ".webp"){
    return `${PREFIX}${hash.toLowerCase()}-${side}${extension}`;
}

// The crop belongs to the printing the card defaults to, so it is addressed by
// that printing's hash. Nothing here needs to know a card id, which is what
// lets the upload run without a database.
function artKey(hash, extension = ".webp"){
    return `${PREFIX}${hash.toLowerCase()}-art${extension}`;
}

async function upload(key, file, cacheControl = IMMUTABLE){
    const extension = path.extname(file);
    const params = {
        Bucket: BUCKET,
        Key: key,
        ContentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
        CacheControl: cacheControl,
        Body: await fs.promises.readFile(file),
    };
    if (ACL){
        params.ACL = ACL;
    }
    await client.send(new PutObjectCommand(params));
    return params.Body.length;
}

// Named so a caller can report where it is writing without printing a secret.
function describeTarget(){
    return `${BUCKET} at ${envOr("S3_ENDPOINT", "https://nyc3.digitaloceanspaces.com/")}`;
}

module.exports = { upload, faceKey, artKey, describeTarget, IMMUTABLE };
