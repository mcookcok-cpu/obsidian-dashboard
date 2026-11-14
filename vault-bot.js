'use strict';
// Bot penjaga vault: memantau perubahan, menjalankan pemeriksa konsistensi,
// memperbaiki hal aman (daftar isi Memory), dan melapor ke dashboard.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch (_) {}

const VAULT = path.resolve(process.env.VAULT_DIR || '/home/Claude/Obsidian');
const DATA = path.join(__dirname, 'data');
const REPORT = path.join(DATA, 'report.json');
const INTERVAL = 10 * 60 * 1000;
const DEBOUNCE = 3000;

let running = false, queued = false, timer = null, lastHash = '', hadProblems = false;
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pad = n => String(n).padStart(2, '0');

function runCheck() {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(__dirname, 'check-vault.js'), '--json', VAULT],
      { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err, out) => {
        try { resolve(JSON.parse(out)); } catch { resolve(null); }
      });
  });
}

async function botLog(line) {
  line = line.replace(/\[\[([^\]]+)\]\]/g, '"$1"');
  const d = new Date();
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dir = path.join(VAULT, 'Log', 'vault-bot');
  const file = path.join(dir, day + '.md');
  await fsp.mkdir(dir, { recursive: true });
  let head = '';
  try { await fsp.access(file); } catch { head = `---\ntags: [log]\nagent: vault-bot\ndate: ${day}\n---\n# Log ${day}\n\n`; }
  await fsp.appendFile(file, head + `- ${pad(d.getHours())}:${pad(d.getMinutes())} ${line}\n`);
}

// Perbaikan aman: hanya menambah baris ke Memory/_index.md, tidak mengubah baris lama.
async function fixIndex(problems) {
  const missing = problems.filter(p => p.code === 'not-indexed').map(p => p.p);
  if (!missing.length) return [];
  const idx = path.join(VAULT, 'Memory', '_index.md');
  const cur = await fsp.readFile(idx, 'utf8'); // baca ulang tepat sebelum menulis
  const lines = [];
  for (const p of missing) {
    const name = path.basename(p, '.md');
    if (!new RegExp('\\[\\[' + reEsc(name) + '(\\||\\]\\])', 'i').test(cur)) lines.push(`- [[${name}]]`);
  }
  if (!lines.length) return [];
  await fsp.appendFile(idx, (cur.endsWith('\n') ? '' : '\n') + lines.join('\n') + '\n');
  return lines.map(l => l.slice(4, -2));
}

async function cycle(reason) {
  if (running) { queued = true; return; }
  running = true;
  try {
    let r = await runCheck();
    if (!r) { console.error('pemeriksa gagal dijalankan'); return; }
    let fixed = [];
    try { fixed = await fixIndex(r.problems); } catch (e) { console.error('auto-fix gagal:', e.message); }
    if (fixed.length) {
      r = (await runCheck()) || r;
      await botLog(`Menambahkan ke Memory/_index.md: ${fixed.map(n => `[[${n}]]`).join(', ')}`);
    }
    const errs = r.problems.filter(x => x.level === 'error').length;
    const warns = r.problems.filter(x => x.level === 'warn').length;
    const report = { time: Date.now(), reason, vault: VAULT, notes: r.notes, errors: errs, warnings: warns, problems: r.problems, autoFixed: fixed };
    await fsp.mkdir(DATA, { recursive: true });
    const tmp = REPORT + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(report));
    await fsp.rename(tmp, REPORT);

    const h = crypto.createHash('sha1').update(JSON.stringify(r.problems.map(x => [x.p, x.msg]))).digest('hex');
    if (r.problems.length && h !== lastHash) await botLog(`Ditemukan ${errs} galat, ${warns} peringatan: ${r.problems.slice(0, 5).map(x => `${x.p} (${x.msg})`).join('; ')}`);
    else if (!r.problems.length && hadProblems) await botLog('Semua masalah sudah beres');
    lastHash = h; hadProblems = r.problems.length > 0;
  } catch (e) {
    console.error('siklus gagal:', e);
  } finally {
    running = false;
    if (queued) { queued = false; schedule(2000, 'susulan'); }
  }
}

function schedule(ms = DEBOUNCE, reason = 'perubahan file') {
  clearTimeout(timer);
  timer = setTimeout(() => cycle(reason), ms);
}

try {
  fs.watch(VAULT, { recursive: true }, (ev, f) => {
    if (!f) return;
    f = f.replace(/\\/g, '/');
    if (!f.endsWith('.md') || f.startsWith('.claude/') || f.startsWith('.git/') || f.startsWith('Log/vault-bot/') || f.includes('.tmp-')) return;
    schedule();
  });
} catch (e) { console.error('watch gagal, hanya pakai jadwal:', e.message); }

setInterval(() => cycle('terjadwal'), INTERVAL);
process.on('SIGTERM', () => process.exit(0));
console.log(`vault-bot memantau ${VAULT}`);
cycle('start');
