'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const ago = t => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  return Math.floor(s / 86400) + ' hari lalu';
};
const main = $('#main'), side = $('#side');
let INDEX = [], TREE = [], MAP = new Map(), cur = null, note = null, editing = false;

async function api(url, opt = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (r.status === 401) { location.reload(); throw new Error('belum login'); }
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.status = r.status; e.data = data; throw e; }
  return data;
}

/* ---------- markdown ---------- */
function wiki(t, embed) {
  const parts = t.split('|');
  const target = parts[0].split('#')[0].trim();
  const label = (parts[1] || parts[0]).trim();
  const p = MAP.get(target.toLowerCase());
  const pre = embed ? '↪ ' : '';
  return p ? `<a class="wl" href="#/${encodeURI(p)}">${pre}${label}</a>` : `<span class="wl missing">${pre}${label}</span>`;
}
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = esc(s);
  s = s.replace(/!\[\[([^\]]+)\]\]/g, (_, t) => wiki(t, true));
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, t) => wiki(t, false));
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  s = s.replace(/(^|\s)#([\p{L}][\p{L}\p{N}_\/-]*)/gu, '$1<span class="tag">#$2</span>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + esc(codes[i]) + '</code>');
  return s;
}
function metaHtml(t) {
  const rows = [];
  for (const l of t.split('\n')) {
    const k = l.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (!k) continue;
    const v = k[2].replace(/^\[|\]$/g, '').trim();
    if (!v) continue;
    if (k[1] === 'tags') rows.push(v.split(',').map(x => x.trim()).filter(Boolean).map(x => `<span class="tag">#${esc(x)}</span>`).join(' '));
    else rows.push(`<span class="mk">${esc(k[1])}</span>${esc(v)}`);
  }
  return rows.length ? `<div class="meta">${rows.map(r => `<div>${r}</div>`).join('')}</div>` : '';
}
function renderMd(src, noFM) {
  src = src.replace(/\r\n/g, '\n');
  let meta = '';
  if (!noFM) {
    const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
    if (m) { meta = metaHtml(m[1]); src = src.slice(m[0].length); }
  }
  const L = src.split('\n'), out = [];
  let i = 0;
  const isList = l => /^\s*([-*+]|\d+\.)\s+/.test(l);
  const isTable = (a, b) => b !== undefined && /\|/.test(a) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(b);
  const starts = (l, n) => /^#{1,6}\s/.test(l) || /^```/.test(l) || /^>/.test(l) || isList(l) || /^(-{3,}|\*{3,})\s*$/.test(l) || isTable(l, L[n + 1]);
  const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  while (i < L.length) {
    const line = L[i];
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < L.length && !/^```/.test(L[i])) buf.push(L[i++]);
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^>/.test(line)) {
      const buf = [];
      while (i < L.length && /^>/.test(L[i])) buf.push(L[i++].replace(/^>\s?/, ''));
      const co = buf[0].match(/^\[!(\w+)\][+-]?\s*(.*)$/);
      if (co) out.push(`<div class="callout c-${co[1].toLowerCase()}"><div class="ct">${inline(co[2] || co[1])}</div>${renderMd(buf.slice(1).join('\n'), true)}</div>`);
      else out.push(`<blockquote>${renderMd(buf.join('\n'), true)}</blockquote>`);
      continue;
    }
    if (isTable(line, L[i + 1])) {
      const head = cells(line); i += 2;
      const rows = [];
      while (i < L.length && L[i].trim() && /\|/.test(L[i])) rows.push(cells(L[i++]));
      out.push('<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (isList(line)) {
      const items = [];
      while (i < L.length && (isList(L[i]) || (/^\s+\S/.test(L[i]) && items.length))) {
        const m = L[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (m) items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3] });
        else items[items.length - 1].text += ' ' + L[i].trim();
        i++;
      }
      let html = '';
      const stack = [];
      for (const it of items) {
        while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
        const tag = it.ordered ? 'ol' : 'ul';
        if (!stack.length || it.indent > stack[stack.length - 1].indent) { html += `<${tag}>`; stack.push({ indent: it.indent, tag }); }
        else html += '</li>';
        const t = it.text.match(/^\[( |x|X)\]\s+(.*)$/);
        html += '<li>' + (t ? `<input type="checkbox" disabled${t[1] === ' ' ? '' : ' checked'}>${inline(t[2])}` : inline(it.text));
      }
      while (stack.length) html += `</li></${stack.pop().tag}>`;
      out.push(html);
      continue;
    }
    const buf = [line]; i++;
    while (i < L.length && L[i].trim() && !starts(L[i], i)) buf.push(L[i++]);
    out.push('<p>' + buf.map(inline).join('<br>') + '</p>');
  }
  return meta + out.join('\n');
}

/* ---------- data & sidebar ---------- */
async function loadMeta() {
  const [tree, index] = await Promise.all([api('/api/tree'), api('/api/index')]);
  TREE = tree; INDEX = index; MAP = new Map();
  for (const n of INDEX) {
    for (const k of [n.name, n.path.replace(/\.md$/, ''), ...n.aliases]) {
      const key = k.toLowerCase();
      if (!MAP.has(key)) MAP.set(key, n.path);
    }
  }
  renderSide();
}
function renderSide() {
  const open = n => (cur && cur.startsWith(n.path + '/')) || (!n.path.includes('/') && !n.name.startsWith('.'));
  const rec = nodes => nodes.map(n => n.type === 'dir'
    ? `<details${open(n) ? ' open' : ''}><summary>${esc(n.name)}</summary>${rec(n.children)}</details>`
    : `<a class="f${n.path === cur ? ' on' : ''}" href="#/${encodeURI(n.path)}">${esc(n.name.replace(/\.md$/, ''))}</a>`).join('');
  side.innerHTML = rec(TREE);
}
function markActive() {
  side.querySelectorAll('a.f.on').forEach(a => a.classList.remove('on'));
  const a = [...side.querySelectorAll('a.f')].find(x => decodeURI(x.getAttribute('href').slice(2)) === cur);
  if (a) {
    a.classList.add('on');
    for (let p = a.parentElement; p && p !== side; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
  }
}

/* ---------- views ---------- */
async function home() {
  cur = null; note = null; editing = false; markActive();
  main.innerHTML = '<p class="muted">Memuat…</p>';
  const [s, hl] = await Promise.all([api('/api/stats'), api('/api/health').catch(() => ({ missing: true }))]);
  const order = ['Memory', 'Projects', 'Agents', 'Log', 'Inbox', 'Templates', 'skills', '(root)'];
  const keys = [...order.filter(k => s.counts[k]), ...Object.keys(s.counts).filter(k => !order.includes(k))];
  let h = `<h1 class="ttl">Ingatan Bersama</h1><div class="muted small">${s.total} file di vault</div>`;
  h += '<div class="cards">' + keys.map(k => `<div class="card"><b>${s.counts[k]}</b><span>${esc(k)}</span></div>`).join('') + '</div>';
  const hp = hl.problems || [];
  h += hl.missing
    ? '<div class="health"><span class="muted">Bot belum melapor.</span></div>'
    : `<div class="health ${hl.errors ? 'bad' : hl.warnings ? 'warn' : 'ok'}"><b>${hl.errors ? '✕ ' + hl.errors + ' galat' : hl.warnings ? '! ' + hl.warnings + ' peringatan' : '✓ Vault sehat'}</b> <span class="muted small">· dicek bot ${ago(hl.time)} · ${hl.notes} catatan</span>${hp.map(x => `<div class="small"><a href="#/${encodeURI(x.p)}">${esc(x.p)}</a>: ${esc(x.msg)}</div>`).join('')}</div>`;
  h += '<h2 class="sec">Terakhir diubah</h2><div class="list">' +
    (s.recent.length ? s.recent.map(r => `<a href="#/${encodeURI(r.path)}"><span>${esc(r.path)}</span><span class="muted small">${ago(r.mtime)}</span></a>`).join('') : '<p class="muted">Belum ada catatan.</p>') + '</div>';
  h += '<h2 class="sec">Log agent</h2><div class="list">' +
    (s.logs.length ? s.logs.map(l => `<a href="${l.latestPath ? '#/' + encodeURI(l.latestPath) : '#/'}"><span>${esc(l.agent)}</span><span class="muted small">${l.count} log · terakhir ${esc(l.latest ? l.latest.replace(/\.md$/, '') : '-')}</span></a>`).join('') : '<p class="muted">Belum ada log agent.</p>') + '</div>';
  main.innerHTML = h;
}

async function openNote(rel) {
  cur = rel; editing = false; markActive();
  main.innerHTML = '<p class="muted">Memuat…</p>';
  try { note = await api('/api/note?path=' + encodeURIComponent(rel)); renderNote(); }
  catch (e) { main.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function renderNote() {
  const n = note, isMd = n.path.endsWith('.md');
  const title = n.path.split('/').pop().replace(/\.md$/, '');
  let h = `<div class="bar"><div><h1 class="ttl">${esc(title)}</h1><div class="muted small">${esc(n.path)} · ${ago(n.mtime)}</div></div><div class="btns">`;
  h += editing ? '<button id="bsave" class="pri">Simpan</button><button id="bcancel">Batal</button>' : '<button id="bedit">Edit</button>';
  h += '</div></div>';
  if (editing) h += `<textarea id="ta" spellcheck="false">${esc(n.content)}</textarea><div id="st" class="small muted"></div>`;
  else h += `<article class="md">${isMd ? renderMd(n.content) : '<pre><code>' + esc(n.content) + '</code></pre>'}</article><div id="bl"></div>`;
  main.innerHTML = h;
  if (editing) {
    $('#bsave').onclick = save;
    $('#bcancel').onclick = () => { editing = false; renderNote(); };
    $('#ta').focus();
  } else {
    $('#bedit').onclick = () => { editing = true; renderNote(); };
    if (isMd) loadBacklinks(n.path);
  }
}
async function loadBacklinks(rel) {
  try {
    const bl = await api('/api/backlinks?path=' + encodeURIComponent(rel));
    if (bl.length && cur === rel && $('#bl')) $('#bl').innerHTML = '<div class="muted small">Ditautkan dari</div>' + bl.map(p => `<a href="#/${encodeURI(p)}">${esc(p.replace(/\.md$/, ''))}</a>`).join('');
  } catch (_) {}
}
function touchFM(t) {
  const m = t.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return t;
  let fm = m[1];
  if (/^updated:/m.test(fm)) fm = fm.replace(/^updated:.*$/m, 'updated: ' + today());
  if (/^updated_by:/m.test(fm)) fm = fm.replace(/^updated_by:.*$/m, 'updated_by: user');
  return '---\n' + fm + '\n---' + t.slice(m[0].length);
}
async function save() {
  const st = $('#st');
  let text = $('#ta').value;
  if (note.path.endsWith('.md')) text = touchFM(text);
  st.className = 'small muted'; st.textContent = 'Menyimpan…';
  try {
    const r = await api('/api/note', { method: 'PUT', body: JSON.stringify({ path: note.path, content: text, mtime: note.mtime }) });
    note.content = text; note.mtime = r.mtime; editing = false;
    renderNote();
    loadMeta();
  } catch (e) {
    st.className = 'small err';
    st.textContent = e.status === 409
      ? 'Konflik: file sudah diubah pihak lain (mungkin agent). Teksmu masih di kotak ini. Salin dulu, lalu muat ulang halaman.'
      : 'Gagal menyimpan: ' + e.message;
  }
}

/* ---------- catatan baru ---------- */
function openNew() {
  const sel = $('#ntpl');
  sel.innerHTML = '<option value="">(kosong)</option>';
  const t = TREE.find(n => n.name === 'Templates' && n.type === 'dir');
  if (t) for (const f of t.children.filter(c => c.type === 'file')) sel.insertAdjacentHTML('beforeend', `<option value="${esc(f.path)}">${esc(f.name.replace(/\.md$/, ''))}</option>`);
  $('#npath').value = cur && cur.includes('/') ? cur.split('/').slice(0, -1).join('/') + '/' : 'Inbox/';
  $('#nerr').textContent = '';
  $('#dlg').showModal();
}
async function createNote() {
  let p = $('#npath').value.trim().replace(/^\/+/, '');
  if (!p || p.endsWith('/')) { $('#nerr').textContent = 'Isi nama file, mis. Memory/topik.md'; return; }
  if (!/\.[a-z]+$/i.test(p)) p += '.md';
  let content = '';
  try {
    const tp = $('#ntpl').value;
    if (tp) content = touchFM((await api('/api/note?path=' + encodeURIComponent(tp))).content.replace(/\{\{date\}\}/g, today()));
    else if (p.endsWith('.md')) content = `# ${p.split('/').pop().replace(/\.md$/, '')}\n\n`;
    await api('/api/note', { method: 'PUT', body: JSON.stringify({ path: p, content, create: true }) });
    $('#dlg').close();
    await loadMeta();
    location.hash = '#/' + encodeURI(p);
    setTimeout(() => { if (note && note.path === p) { editing = true; renderNote(); } }, 400);
  } catch (e) { $('#nerr').textContent = e.message; }
}

/* ---------- pencarian & routing ---------- */
let timer;
$('#q').addEventListener('input', e => {
  clearTimeout(timer);
  const q = e.target.value.trim();
  timer = setTimeout(() => q ? doSearch(q) : route(), 250);
});
async function doSearch(q) {
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    main.innerHTML = `<h1 class="ttl">Hasil "${esc(q)}"</h1>` +
      (r.length ? r.map(x => `<a class="res" href="#/${encodeURI(x.path)}"><b>${esc(x.path)}</b><span>${esc(x.snippet)}</span></a>`).join('') : '<p class="muted">Tidak ada hasil.</p>');
  } catch (e) { main.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function route() {
  side.classList.remove('open');
  const h = location.hash.replace(/^#\/?/, '');
  if (!h) return home().catch(e => { main.innerHTML = `<p class="err">${esc(e.message)}</p>`; });
  openNote(decodeURI(h));
}
window.addEventListener('hashchange', route);
window.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's' && editing) { e.preventDefault(); save(); } });
$('#menu').onclick = () => side.classList.toggle('open');
$('#new').onclick = openNew;
$('#ncancel').onclick = () => $('#dlg').close();
$('#ncreate').onclick = createNote;
$('#npath').addEventListener('keydown', e => { if (e.key === 'Enter') createNote(); });
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST', body: '{}' }); location.reload(); };

loadMeta().then(route).catch(e => { main.innerHTML = `<p class="err">${esc(e.message)}</p>`; });
api('/api/config').then(c => { if (!c.auth) $('#logout').style.display = 'none'; }).catch(() => {});
