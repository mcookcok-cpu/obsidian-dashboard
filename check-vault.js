#!/usr/bin/env node
'use strict';
// Pemeriksa konsistensi vault. Hanya membaca, tidak mengubah apa pun.
// Pakai: node check-vault.js [folder-vault]
const fs = require('fs');
const path = require('path');

const ARG = process.argv.slice(2).find(a => !a.startsWith('--'));
const VAULT = path.resolve(ARG || process.env.VAULT_DIR || '/home/Claude/Obsidian');
const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.claude', 'Templates']);
const SKIP_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);

const files = [];
(function walk(d, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(path.join(d, e.name), r);
    else if (e.name.endsWith('.md') && !SKIP_FILES.has(r)) files.push(r);
  }
})(VAULT, '');

function parse(txt) {
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (!m) return { fm: null, body: txt };
  for (const l of m[1].split('\n')) {
    const k = l.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (k) fm[k[1]] = k[2].startsWith('[') ? k[2].slice(1, -1).split(',').map(s => s.trim()).filter(Boolean) : k[2];
  }
  return { fm, body: txt.slice(m[0].length) };
}

const notes = files.map(p => {
  const txt = fs.readFileSync(path.join(VAULT, p), 'utf8');
  const { fm, body } = parse(txt);
  const al = fm && fm.aliases ? [].concat(fm.aliases) : [];
  return { p, txt, fm, body, name: path.basename(p, '.md'), aliases: al };
});

const keyMap = new Map();
const problems = [];
const add = (level, p, msg, code) => problems.push({ level, p, msg, code });

for (const n of notes) {
  const ks = n.p.startsWith('Log/') ? [n.p.replace(/\.md$/, '')] : [n.name, n.p.replace(/\.md$/, ''), ...n.aliases];
  for (const k of ks) {
    const key = k.toLowerCase();
    if (keyMap.has(key) && keyMap.get(key) !== n.p) add('error', n.p, `nama/alias "${k}" bentrok dengan ${keyMap.get(key)}`);
    else keyMap.set(key, n.p);
  }
}

const SECRET = [
  /sk-[A-Za-z0-9_-]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/,
  /(api[_-]?key|secret|passw(or)?d|token)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}/i
];

for (const n of notes) {
  const top = n.p.split('/')[0];
  const isLog = top === 'Log';
  const need = isLog ? ['tags', 'agent', 'date'] : ['tags', 'updated', 'updated_by'];
  if (!n.fm) add('error', n.p, 'tidak punya frontmatter');
  else for (const k of need) if (!n.fm[k] || (Array.isArray(n.fm[k]) && !n.fm[k].length)) add('error', n.p, `frontmatter "${k}" kosong atau hilang`);

  if (isLog) {
    const m = n.p.match(/^Log\/([^/]+)\/(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) add('error', n.p, 'log harus berada di Log/<agent>/YYYY-MM-DD.md');
    else if (n.fm) {
      if (n.fm.agent && n.fm.agent !== m[1]) add('error', n.p, `agent di frontmatter ("${n.fm.agent}") tidak sama dengan nama folder ("${m[1]}")`);
      if (n.fm.date && n.fm.date !== m[2]) add('error', n.p, `date di frontmatter ("${n.fm.date}") tidak sama dengan nama file`);
    }
  }
  if (n.fm && n.fm.updated && !/^\d{4}-\d{2}-\d{2}$/.test(n.fm.updated)) add('warn', n.p, `format "updated" bukan YYYY-MM-DD ("${n.fm.updated}")`);

  const clean = n.body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const re = /!?\[\[([^\]]+)\]\]/g; let m;
  while ((m = re.exec(clean))) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target && !keyMap.has(target.toLowerCase())) add('warn', n.p, `tautan rusak [[${target}]]`);
  }
  for (const l of n.txt.split('\n')) if (SECRET.some(r => r.test(l))) { add('error', n.p, 'ada yang mirip rahasia (token/password/API key), hapus dari vault'); break; }
}

const idx = notes.find(n => n.p === 'Memory/_index.md');
if (idx) {
  for (const n of notes) {
    if (n.p.startsWith('Memory/') && n.p !== 'Memory/_index.md' && !new RegExp('\\[\\[' + n.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\||\\]\\])', 'i').test(idx.txt))
      add('warn', n.p, 'belum tercantum di Memory/_index.md', 'not-indexed');
  }
}

const errs = problems.filter(x => x.level === 'error'), warns = problems.filter(x => x.level === 'warn');
if (process.argv.includes('--json')) { console.log(JSON.stringify({ vault: VAULT, notes: notes.length, problems })); process.exit(0); }
console.log(`Vault: ${VAULT}\nDiperiksa: ${notes.length} catatan`);
for (const x of problems) console.log(`${x.level === 'error' ? 'GALAT ' : 'PERINGATAN'}  ${x.p}: ${x.msg}`);
console.log(problems.length ? `\n${errs.length} galat, ${warns.length} peringatan` : '\nBersih, tidak ada masalah.');
process.exit(errs.length ? 1 : 0);
