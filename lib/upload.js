const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { delay } = require("./utils");
require('dotenv').config();

const MAX_ATTEMPTS = 5;

// A run this long will meet a network that goes away for a moment - a laptop
// suspending mid run is enough, and cost eight cards their objects the first
// time. The download side has always retried these; the upload side did not,
// and a card whose upload throws is left out of the manifest entirely.
const TRANSIENT = new Set([
    "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "ECONNREFUSED",
    "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

function transient(error){
    const code = error?.code ?? error?.cause?.code;
    if (code && TRANSIENT.has(code)) return true;
    const status = error?.$metadata?.httpStatusCode;
    return status === 429 || (status >= 500 && status < 600);
}

// Every setting comes from the environment under the same names the
// application uses in helpers/s3.go, so one .env shape serves both repos and
// moving hosts is a change to the environment rather than a release.
const PREFIX = "cards/";

function envOr(name, fallback){
    const value = (process.env[name] ?? "").trim();
    return value.length ? value : fallback;
}

// No default for the endpoint or the credentials.
//
// They used to fall back to the DigitalOcean Space this migrated away from, and
// that is the worst possible shape for a default: an incomplete .env would send
// 16GB to a bucket nothing reads any more, or authenticate against the wrong
// host, and either way phase 5 would report a successful upload. There is
// nothing to guess here - a missing endpoint is a question, not a value.
function required(name){
    const value = (process.env[name] ?? "").trim();
    if (!value.length){
        console.log(`🚨 ${name} is not set. Phase 5 has nowhere to put the images.`);
        console.log("   The bucket settings live in .env - see .env.example for the R2 shape.");
        process.exit(1);
    }
    return value;
}

const ENDPOINT = (process.env.S3_ENDPOINT ?? "").trim();
const BUCKET = envOr("S3_BUCKET", "divinedrop");

// Built on the first upload rather than when the module loads, so phase 5
// --skip-upload still runs with no bucket configured at all - it writes the
// manifest from what is already on disk and never opens a connection.
//
// R2 wants the bucket as the first path segment of an account endpoint, where an
// S3 style host serves it as a subdomain - hence the path style switch.
let client = null;
function getClient(){
    if (client) return client;
    client = new S3Client({
        endpoint: required("S3_ENDPOINT"),
        region: envOr("S3_REGION", "auto"),
        forcePathStyle: envOr("S3_FORCE_PATH_STYLE", "true") === "true",
        credentials: {
            accessKeyId: required("S3_ACCESS_KEY_ID"),
            secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
        },
    });
    return client;
}

// R2 has no per object ACLs and rejects the header, so nothing is sent unless
// asked for. Leave S3_ACL unset for R2; a host that needs public-read on every
// object to serve it wants S3_ACL=public-read.
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
    for (let attempt = 0; ; attempt++){
        try {
            await getClient().send(new PutObjectCommand(params));
            return params.Body.length;
        } catch (error){
            if (!transient(error) || attempt + 1 >= MAX_ATTEMPTS){
                throw error;
            }
            await delay(1000 * (2 ** attempt));
        }
    }
}

// Named so a caller can report where it is writing without printing a secret.
function describeTarget(){
    return `${BUCKET} at ${ENDPOINT || "(S3_ENDPOINT is not set)"}`;
}

module.exports = { upload, faceKey, artKey, describeTarget, IMMUTABLE };
