// Disk-cached fetch for the eval scripts (Wikipedia / Wikidata), with a descriptive User-Agent
// as Wikimedia asks of API clients. Browsers can't set it; Node can.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '.cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const key = crypto.createHash('sha1').update(String(url)).digest('hex');
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(file)) {
    const body = fs.readFileSync(file, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  }
  const res = await realFetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), 'User-Agent': 'WikiMastersBot-eval/1.0 (local benchmark)' }
  });
  const body = await res.text();
  if (res.ok) fs.writeFileSync(file, body);
  return { ok: res.ok, status: res.status, headers: res.headers, json: async () => JSON.parse(body) };
};

