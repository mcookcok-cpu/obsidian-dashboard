'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// muat .env sederhana
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch (_) {}

const PORT = parseInt(process.env.PORT || '7070', 10);
const HOST = process.env.HOST || '0.0.0.0';
const VAULT = path.resolve(process.env.VAULT_DIR || '/home/Claude/Obsidian');
const TOKEN = process.env.DASH_TOKEN || '';
const AUTH = TOKEN.length > 0;
if (AUTH && TOKEN.length < 12) { console.error('DASH_TOKEN terlalu pendek (min 12 karakter), atau kosongkan untuk mematikan login'); process.exit(1); }

const SHOWN = new Set(['.md', '.base', '.canvas']);
const WRITABLE = new Set(['.md', '.base', '.canvas', '.json', '.txt']);
const HIDDEN = new Set(['.git', 'node_modules', '.obsidian', '.trash']);
const STATIC = { '/index.html': 'text/html; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8' };
const MAX_BODY = 1024 * 1024;

const SESSION = crypto.createHmac('sha256', TOKEN).update('ovd-session-v1').digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const httpErr = (status, message) => Object.assign(new Error(message), { status });

function isAuthed(req) {
  if (!AUTH) return true;
  const ah = req.headers.authorization || '';
  if (ah.startsWith('Bearer ') && safeEq(ah.slice(7).trim(), TOKEN)) return true;
  const ck = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('ovd='));
  return !!ck && safeEq(ck.slice(4), SESSION);
}

const fails = new Map();
const limited = ip => { const r = fails.get(ip); return !!r && r.n >= 10 && Date.now() - r.t < 600000; };
const noteFail = ip => {
  const r = fails.get(ip);
  if (!r || Date.now() - r.t > 600000) fails.set(ip, { n: 1, t: Date.now() }); else r.n++;
};

function resolveRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw httpErr(400, 'path tidak valid');
  const parts = rel.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..' || HIDDEN.has(p))) throw httpErr(400, 'path tidak valid');
  const abs = path.join(VAULT, ...parts);
  if (!abs.startsWith(VAULT + path.sep)) throw httpErr(400, 'path di luar vault');
  if (!WRITABLE.has(path.extname(abs).toLowerCase())) throw httpErr(400, 'tipe file tidak didukung (md, base, canvas, json, txt)');
  return { abs, rel: parts.join('/') };
}

async function checkReal(p) {
  let r, v;
  try { r = await fsp.realpath(p); v = await fsp.realpath(VAULT); } catch { return; }
  if (r !== v && !r.startsWith(v + path.sep)) throw httpErr(400, 'path di luar vault');
}

async function walk(dir, rel = '', depth = 0) {
  const out = [];
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (HIDDEN.has(e.name) || e.isSymbolicLink()) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (depth < 8) out.push({ name: e.name, path: r, type: 'dir', children: await walk(path.join(dir, e.name), r, depth + 1) });
    } else if (SHOWN.has(path.extname(e.name).toLowerCase())) {
      out.push({ name: e.name, path: r, type: 'file' });
    }
  }
  out.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, 'id', { numeric: true }) : (a.type === 'dir' ? -1 : 1));
  return out;
}
function flat(tree, acc = []) {
  for (const n of tree) { if (n.type === 'dir') flat(n.children, acc); else acc.push(n.path); }
  return acc;
}

function parseFM(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (!m) return fm;
  for (const l of m[1].split('\n')) {
    const k = l.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (!k) continue;
    let v = k[2];
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    fm[k[1]] = v;
  }
  return fm;
}
const arr = v => Array.isArray(v) ? v : (v ? [String(v)] : []);
const keysOf = n => [n.name, n.path.replace(/\.md$/, ''), ...n.aliases].map(s => s.toLowerCase());

let idxCache = { t: 0, v: null };
async function buildIndex() {
  if (idxCache.v && Date.now() - idxCache.t < 3000) return idxCache.v;
  const files = flat(await walk(VAULT)).filter(p => p.endsWith('.md') && !p.startsWith('.claude/'));
  const list = [];
  for (const p of files) {
    try {
      const abs = path.join(VAULT, p);
      const [txt, st] = await Promise.all([fsp.readFile(abs, 'utf8'), fsp.stat(abs)]);
      const fm = parseFM(txt);
      list.push({ path: p, name: path.basename(p, '.md'), aliases: arr(fm.aliases), tags: arr(fm.tags), updated: fm.updated || '', updated_by: fm.updated_by || '', mtime: st.mtimeMs, _txt: txt });
    } catch { /* lewati */ }
  }
  idxCache = { t: Date.now(), v: list };
  return list;
}

async function search(q) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!toks.length) return [];
  const res = [];
  for (const n of await buildIndex()) {
    const low = n._txt.toLowerCase(); const pl = n.path.toLowerCase();
    if (!toks.every(t => low.includes(t) || pl.includes(t))) continue;
    let score = 0;
    for (const t of toks) { if (n.name.toLowerCase().includes(t)) score += 10; score += Math.min(10, low.split(t).length - 1); }
    const lines = n._txt.split('\n');
    const li = lines.findIndex(l => l.toLowerCase().includes(toks[0]));
    res.push({ path: n.path, score, snippet: li >= 0 ? lines[li].trim().slice(0, 160) : '' });
  }
  return res.sort((a, b) => b.score - a.score).slice(0, 40);
}

async function backlinks(rel) {
  const idx = await buildIndex();
  const me = idx.find(n => n.path === rel);
  if (!me) return [];
  const keys = new Set(keysOf(me));
  const out = [];
  for (const n of idx) {
    if (n.path === rel) continue;
    const re = /\[\[([^\]|#]+)/g; let m;
    while ((m = re.exec(n._txt))) { if (keys.has(m[1].trim().toLowerCase())) { out.push(n.path); break; } }
  }
  return out;
}

async function stats() {
  const tree = await walk(VAULT);
  const items = [];
  for (const p of flat(tree)) { try { items.push({ path: p, mtime: (await fsp.stat(path.join(VAULT, p))).mtimeMs }); } catch { /* lewati */ } }
  const bucket = p => p.startsWith('.claude/') ? 'skills' : (p.includes('/') ? p.split('/')[0] : '(root)');
  const counts = {};
  for (const it of items) counts[bucket(it.path)] = (counts[bucket(it.path)] || 0) + 1;
  const recent = items.filter(i => !i.path.startsWith('.claude/')).sort((a, b) => b.mtime - a.mtime).slice(0, 12);
  const logs = [];
  const logDir = tree.find(n => n.name === 'Log' && n.type === 'dir');
  if (logDir) {
    for (const a of logDir.children.filter(c => c.type === 'dir')) {
      const fl = a.children.filter(c => c.type === 'file').sort((x, y) => x.name.localeCompare(y.name));
      const last = fl[fl.length - 1];
      logs.push({ agent: a.name, count: fl.length, latest: last ? last.name : null, latestPath: last ? last.path : null });
    }
  }
  return { total: items.length, counts, recent, logs };
}

function readBody(req) {
  return new Promise((ok, no) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(httpErr(413, 'isi terlalu besar')); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString('utf8') || '{}')); } catch { no(httpErr(400, 'JSON tidak valid')); } });
    req.on('error', no);
  });
}
function json(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}
async function sendFile(res, name, type) {
  const buf = await fsp.readFile(path.join(__dirname, 'public', name));
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const ip = req.socket.remoteAddress;
    const needsJson = ['POST', 'PUT'].includes(req.method);
    if (needsJson && !String(req.headers['content-type'] || '').includes('application/json')) throw httpErr(415, 'butuh application/json');

    if (p === '/api/login' && req.method === 'POST') {
      if (limited(ip)) throw httpErr(429, 'terlalu banyak percobaan, coba lagi nanti');
      const b = await readBody(req);
      if (typeof b.token === 'string' && safeEq(b.token.trim(), TOKEN)) {
        return json(res, 200, { ok: true }, { 'Set-Cookie': `ovd=${SESSION}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
      }
      noteFail(ip);
      throw httpErr(401, 'token salah');
    }
    if (p === '/api/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'ovd=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    if (!isAuthed(req)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'belum login' });
      return sendFile(res, 'login.html', 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && (p === '/' || STATIC[p])) return sendFile(res, p === '/' ? 'index.html' : p.slice(1), STATIC[p === '/' ? '/index.html' : p]);

    if (p === '/api/config' && req.method === 'GET') return json(res, 200, { auth: AUTH });
    if (p === '/api/health' && req.method === 'GET') {
      try { return json(res, 200, JSON.parse(await fsp.readFile(path.join(__dirname, 'data', 'report.json'), 'utf8'))); }
      catch { return json(res, 200, { missing: true }); }
    }
    if (p === '/api/tree' && req.method === 'GET') return json(res, 200, await walk(VAULT));
    if (p === '/api/index' && req.method === 'GET') return json(res, 200, (await buildIndex()).map(({ _txt, ...r }) => r));
    if (p === '/api/stats' && req.method === 'GET') return json(res, 200, await stats());
    if (p === '/api/search' && req.method === 'GET') return json(res, 200, await search(url.searchParams.get('q') || ''));
    if (p === '/api/backlinks' && req.method === 'GET') return json(res, 200, await backlinks(resolveRel(url.searchParams.get('path')).rel));

    if (p === '/api/note' && req.method === 'GET') {
      const { abs, rel } = resolveRel(url.searchParams.get('path'));
      await checkReal(abs);
      let st; try { st = await fsp.stat(abs); } catch { throw httpErr(404, 'catatan tidak ditemukan'); }
      return json(res, 200, { path: rel, content: await fsp.readFile(abs, 'utf8'), mtime: st.mtimeMs, size: st.size });
    }

    if (p === '/api/note' && req.method === 'PUT') {
      const b = await readBody(req);
      if (typeof b.content !== 'string') throw httpErr(400, 'content wajib berupa teks');
      const { abs } = resolveRel(b.path);
      let st = null; try { st = await fsp.stat(abs); } catch { /* belum ada */ }
      if (b.create) {
        if (st) throw httpErr(409, 'file sudah ada');
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await checkReal(path.dirname(abs));
      } else {
        if (!st) throw httpErr(404, 'file tidak ada');
        await checkReal(abs);
        if (typeof b.mtime !== 'number' || Math.abs(st.mtimeMs - b.mtime) > 1) return json(res, 409, { error: 'konflik: file sudah diubah pihak lain', mtime: st.mtimeMs });
      }
      const tmp = abs + '.tmp-' + process.pid;
      await fsp.writeFile(tmp, b.content, 'utf8');
      await fsp.rename(tmp, abs);
      idxCache.t = 0;
      return json(res, 200, { ok: true, mtime: (await fsp.stat(abs)).mtimeMs });
    }

    throw httpErr(404, 'tidak ditemukan');
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'kesalahan server' });
    if (!e.status) console.error(e);
  }
});

server.listen(PORT, HOST, () => console.log(`obsidian-dashboard di http://${HOST}:${PORT} (vault: ${VAULT})`));
