'use strict';
// Annual Leave Planner: a zero-dependency Node server.
// Run with:  node server.js   (Node 18 or newer)
//
// Environment variables
//   PORT        port to listen on (default 3000)
//   DATA_DIR    folder where leave.json is stored (default ./data)
//   EDIT_CODE   optional team code. When set, anyone can view the plan,
//               but adding or removing leave needs the code.
//   TRUST_PROXY set to 1 when running behind a reverse proxy, so the
//               per-IP rate limit uses the forwarded client address.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FILE = path.join(DATA_DIR, 'leave.json');
const EDIT_CODE = process.env.EDIT_CODE || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_ENTRIES = 5000;
const MAX_BODY = 10 * 1024;
const WRITES_PER_MINUTE = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

fs.mkdirSync(DATA_DIR, { recursive: true });

let entries = [];
try { entries = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { entries = []; }
if (!Array.isArray(entries)) entries = [];

function persist() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries));
  fs.renameSync(tmp, FILE);
}

const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'));
const clients = new Set();

function broadcast() {
  for (const res of clients) res.write('data: changed\n\n');
}
setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 25000).unref();

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function authorised(req) {
  if (!EDIT_CODE) return true;
  const given = req.headers['x-access-code'] || '';
  return crypto.timingSafeEqual(sha(given), sha(EDIT_CODE));
}

const hits = new Map();
function rateLimited(req) {
  let ip = req.socket.remoteAddress || '';
  if (TRUST_PROXY) ip = String(req.headers['x-forwarded-for'] || ip).split(',')[0].trim();
  const t = Date.now();
  let h = hits.get(ip);
  if (!h || t > h.reset) { h = { count: 0, reset: t + 60000 }; hits.set(ip, h); }
  h.count++;
  return h.count > WRITES_PER_MINUTE;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (t > v.reset) hits.delete(k); }, 60000).unref();

function send(res, status, body, headers) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, Object.assign({
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 2000 && y <= 2100;
}

const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, INDEX, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP });
    }
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, 'ok');
    if (req.method === 'GET' && p === '/api/config') return send(res, 200, { editRequiresCode: !!EDIT_CODE });
    if (req.method === 'GET' && p === '/api/leave') return send(res, 200, { entries });

    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff'
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && p === '/api/verify') {
      if (rateLimited(req)) return send(res, 429, { error: 'Too many attempts. Wait a minute.' });
      return authorised(req) ? send(res, 204, '') : send(res, 401, { error: 'Wrong team code.' });
    }

    if (req.method === 'POST' && p === '/api/leave') {
      if (rateLimited(req)) return send(res, 429, { error: 'Too many changes. Wait a minute.' });
      if (!authorised(req)) return send(res, 401, { error: 'Team code required.' });
      const b = await readBody(req);
      const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
      if (!name || name.length > 60) return send(res, 400, { error: 'Enter a name of 1 to 60 characters.' });
      if (!validDate(b.start) || !validDate(b.end)) return send(res, 400, { error: 'Dates must be real dates.' });
      if (b.end < b.start) return send(res, 400, { error: 'The last day off must be on or after the first day off.' });
      if (entries.length >= MAX_ENTRIES) return send(res, 400, { error: 'The plan is full. Remove old entries first.' });
      const entry = { id: crypto.randomUUID(), name, start: b.start, end: b.end, created: Date.now() };
      entries.push(entry);
      persist(); broadcast();
      return send(res, 201, entry);
    }

    const del = p.match(/^\/api\/leave\/([A-Za-z0-9-]{1,64})$/);
    if (req.method === 'DELETE' && del) {
      if (rateLimited(req)) return send(res, 429, { error: 'Too many changes. Wait a minute.' });
      if (!authorised(req)) return send(res, 401, { error: 'Team code required.' });
      const before = entries.length;
      entries = entries.filter((e) => e.id !== del[1]);
      if (entries.length !== before) { persist(); broadcast(); }
      return send(res, 204, '');
    }

    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log('Leave planner running on http://localhost:' + PORT);
  console.log(EDIT_CODE ? 'Editing needs the team code.' : 'No EDIT_CODE set: anyone with the link can edit.');
});
