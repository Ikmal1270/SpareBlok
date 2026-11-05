// Small HTTP helpers (no external deps) used for every download/API call.
const https = require('https');
const http = require('http');
const fs = require('fs');

const USER_AGENT = 'SpareBlok/1.4 (by M.N.Ikmal; minecraft-server-manager)';
const REDIRECTS = [301, 302, 303, 307, 308];

function request(url, { headers = {}, timeout = 20000, method = 'GET', body = null } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.request(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      timeout,
    }, (res) => {
      if (REDIRECTS.includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects > 8) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(request(next, { headers, timeout, method, body }, redirects + 1));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out: ${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchText(url, opts = {}) {
  const res = await request(url, opts);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode} from ${new URL(url).host}`);
  }
  return text;
}

async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON from ${new URL(url).host}`);
  }
}

// Streams a file to disk. Writes to `<dest>.part` first so a failed download never
// leaves a broken jar behind.
async function downloadFile(url, dest, onProgress) {
  const res = await request(url, { timeout: 60000 });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`Download failed: HTTP ${res.statusCode} (${new URL(url).host})`);
  }
  const total = parseInt(res.headers['content-length'], 10) || 0;
  const tmp = dest + '.part';
  let downloaded = 0;
  let lastEmit = 0;

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp);
    res.on('data', (chunk) => {
      downloaded += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastEmit > 150) {
        lastEmit = now;
        onProgress({ downloaded, total, percent: total ? Math.round(downloaded / total * 100) : -1 });
      }
    });
    res.on('error', reject);
    file.on('error', reject);
    file.on('finish', resolve);
    res.pipe(file);
  }).catch((err) => {
    fs.rmSync(tmp, { force: true });
    throw err;
  });

  if (total && downloaded < total) {
    fs.rmSync(tmp, { force: true });
    throw new Error('Download was interrupted');
  }
  fs.renameSync(tmp, dest);
  if (onProgress) onProgress({ downloaded, total: total || downloaded, percent: 100 });
  return dest;
}

module.exports = { USER_AGENT, request, fetchText, fetchJson, downloadFile };
