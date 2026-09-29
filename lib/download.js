const fetch = require('node-fetch');
const https = require('https');
const fs = require('fs');
const { delay } = require('./utils');

const MAX_ATTEMPTS = 5;

// One pool of sockets for the whole run. Phase 2 opens something like 111,000
// connections to the same two hosts, and without this every one of them pays
// for a fresh TLS handshake.
const agent = new https.Agent({ keepAlive: true, maxSockets: 16 });

// Thrown when Scryfall asks us to back off. It is separate from an ordinary
// failure because the right response is to stop the whole run rather than to
// retry, skip, or press on into a ban.
class RateLimited extends Error {}

// Thrown when the image is simply not there. Not fatal: phase 3 reports what
// is missing, and one absent printing should not end a three hour download.
class NotFound extends Error {}

function retryable(status){
    return status === 500 || status === 502 || status === 503 || status === 504;
}

async function downloadImage(url, file, attempt = 0){
    let res;
    try {
        res = await fetch(url, { redirect: "follow", method: "GET", agent });
    } catch (e) {
        // Connection resets and socket timeouts are routine over a run this
        // long, so they are worth several attempts before giving up.
        if (attempt + 1 < MAX_ATTEMPTS){
            await delay(1000 * (2 ** attempt));
            return downloadImage(url, file, attempt + 1);
        }
        throw e;
    }

    if (res.status === 429){
        throw new RateLimited(`HTTP 429 for ${url}`);
    }
    if (res.status === 404){
        throw new NotFound(`HTTP 404 for ${url}`);
    }
    if (!res.ok){
        if (retryable(res.status) && attempt + 1 < MAX_ATTEMPTS){
            await delay(1000 * (2 ** attempt));
            return downloadImage(url, file, attempt + 1);
        }
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }

    const buffer = await res.buffer();
    // Written under a temporary name and moved into place once it is whole.
    // Phase 2 resumes by checking whether a file exists, so a run killed
    // mid-download must not leave a truncated one behind for the next run to
    // mistake for finished work.
    const part = `${file}.part`;
    await fs.promises.writeFile(part, buffer);
    await fs.promises.rename(part, file);
    return buffer.length;
}

module.exports = { downloadImage, RateLimited, NotFound };
