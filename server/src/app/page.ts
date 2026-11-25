// The app's pages: plain HTML and a little script. Agent-written text and
// item content are inserted with textContent only, never as HTML; previews
// are images from the drive's own preview endpoint (app/held.ts).
import { esc } from '../util/html.js';

const STYLE = `body{font:15px/1.45 system-ui,sans-serif;max-width:60rem;margin:1.5rem auto;padding:0 1rem;color:#222;background:#fafafa}
h1{font-size:1.3rem}h2{font-size:1.1rem;margin-top:2rem}h3{font-size:1rem;margin:1.2rem 0 .3rem}.card{background:#fff;border:1px solid #ddd;border-radius:6px;padding:.75rem 1rem;margin:.75rem 0}
.m{color:#666;font-size:.85rem}.q{font-style:italic}button,select{font-size:.85rem;margin:.15rem .5rem .15rem 0}ul{margin:.3rem 0;padding-left:1.2rem}
.ring{color:#a33}code{font-size:.85rem;overflow-wrap:anywhere}details summary{cursor:pointer}.bad{color:#a33}.ok{color:#262}nav a{margin-right:1rem}
.bar{position:sticky;top:0;background:#fafafa;padding:.4rem 0;border-bottom:1px solid #ddd;z-index:1}.prev{max-width:100%;max-height:16rem;display:block;margin:.4rem 0;border:1px solid #eee}
pre.prev{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8rem;background:#f4f4f4;padding:.5rem;max-height:12rem;overflow:auto}.row{display:flex;gap:.6rem;align-items:flex-start}.row>input{margin-top:.3rem}
.undone{opacity:.6}`;

function shell(title: string, body: string, script: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body>
<h1>Agent Drive</h1>
<form method="post" action="/logout" style="float:right;margin-top:-2.5rem"><button>Sign out</button></form>
<nav><a href="/">Home</a><a href="/held">Held items</a></nav>
<div id="msg" class="bad" role="status"></div>
${body}
<script>${PRELUDE}${script}</script></body></html>`;
}

export function loginPage(msg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Drive</title><style>${STYLE}</style></head><body>
<h1>Agent Drive</h1>${msg ? `<p class="bad">${esc(msg)}</p>` : ''}
<form method="post" action="/login"><label hidden>Username <input type="text" name="username" value="owner" autocomplete="username" hidden></label><label>Owner password<br><input type="password" name="password" autofocus required></label> <button type="submit">Sign in</button></form></body></html>`;
}

// Shared helpers: $ builds elements (text only), api calls the owner API.
const PRELUDE = `
const $ = (t, attrs = {}, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e[k] = v; else if (k === 'checked') e.checked = !!v; else e.setAttribute(k, v); } for (const k of kids) if (k !== null && k !== undefined && k !== '') e.append(k instanceof Node ? k : document.createTextNode(String(k))); return e; };
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-drive-app': '1' }, body: JSON.stringify(body) } : {});
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  return r.json();
}
const msg = (...kids) => { const b = document.getElementById('msg'); b.replaceChildren(...kids.map(k => k instanceof Node ? k : document.createTextNode(String(k)))); };
const when = (ts) => ts ? ts.slice(0, 16).replace('T', ' ') : '';
const size = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
function opsList(ops) { return $('ul', {}, ...ops.map(o => $('li', {}, o.op + ' ', $('code', {}, o.from_path ? o.from_path + ' → ' + o.path : o.path)))); }
function showConflicts(what, r, retry) {
  msg();
  if (r.error) { msg(r.error); return; }
  if (r.conflicts && r.conflicts.length) {
    const box = document.getElementById('msg');
    box.append($('p', {}, what + ': these changed since, so they were left as they are:'));
    for (const c of r.conflicts) box.append($('div', {}, $('code', {}, c.path), ' ', c.reason, ' ', retry ? $('button', { onclick: () => retry(c) }, 'Revert to before anyway') : ''));
  }
}
function undoButton(p, after) {
  if (p.undone_by) return $('span', { class: 'm' }, ' (undone)');
  const go = async (force) => { const r = await api('/api/app/undo', { pkg_id: p.pkg_id, force }); showConflicts('Undo of ' + p.pkg_id, r, (c) => go([c.item_id])); after(); };
  return $('button', { onclick: () => go([]) }, 'Undo');
}
function pkgCard(p, after) {
  return $('div', { class: 'card' + (p.undone_by ? ' undone' : '') }, $('div', {}, $('b', {}, p.kind), ' ', $('span', { class: 'm' }, when(p.created_at) + ' · ' + p.pkg_id), ' ', undoButton(p, after)),
    p.summary_claimed ? $('div', {}, 'Agent says: ', $('span', { class: 'q' }, '“' + p.summary_claimed + '”')) : '',
    $('div', { class: 'm' }, 'Drive observed: ' + (p.summary_observed || '')), opsList(p.operations));
}
function agentName(a) { return (a.declared_name || a.registered_name || 'unnamed agent') + (a.declared_version ? ' ' + a.declared_version : ''); }
function fail(e) { msg(String(e)); }
`;

const HOME_SCRIPT = `
async function load() {
  const [s, it, h] = await Promise.all([api('/api/app/sessions'), api('/api/app/items'), api('/api/app/held')]);
  const hb = document.getElementById('held'); hb.replaceChildren();
  hb.append(h.items.length ? $('p', {}, $('a', { href: '/held' }, h.items.length + (h.items.length === 1 ? ' item is' : ' items are') + ' held for you to review'), $('span', { class: 'm' }, ' — the drive could not place ' + (h.items.length === 1 ? 'it' : 'them') + ' in a ring, so no session sees ' + (h.items.length === 1 ? 'it' : 'them') + ' yet.')) : $('p', { class: 'm' }, 'Nothing is held.'));
  const box = document.getElementById('sessions'); box.replaceChildren();
  if (!s.sessions.length) box.append($('p', { class: 'm' }, 'No sessions yet.'));
  for (const x of s.sessions) {
    const saves = x.merges.length, turns = x.turns.length;
    box.append($('div', { class: 'card' },
      $('div', {}, $('a', { href: '/session/' + encodeURIComponent(x.dir_id) }, $('b', {}, agentName(x.agent))), $('span', { class: 'm' }, ' (as declared) · ' + x.status + ' · last call ' + when(x.last_call_at))),
      $('div', {}, 'Purpose: ', $('span', { class: 'q' }, '“' + x.purpose + '”')),
      $('div', { class: 'm' }, turns + (turns === 1 ? ' turn, ' : ' turns, ') + saves + (saves === 1 ? ' save' : ' saves'))));
  }
  const pk = document.getElementById('packages'); pk.replaceChildren(...it.packages.map(p => pkgCard(p, load)));
  const ib = document.getElementById('items'); ib.replaceChildren();
  for (const i of it.items) ib.append($('div', {}, $('code', {}, i.path), ' ', i.state === 'trashed' ? $('span', { class: 'm' }, '(in Trash)') : '',
    i.hidden_by.length ? $('span', { class: 'ring' }, ' hidden from agents: ' + i.hidden_by.join(', ')) : '',
    i.state === 'live' ? $('button', { onclick: async () => { await api('/api/app/trash', { item_id: i.item_id }); load(); } }, 'Trash') : ''));
}
load().catch(fail);
`;

export const APP_HTML = shell('Agent Drive', `<h2>Held for review</h2><div id="held"></div>
<h2>Sessions</h2><div id="sessions">Loading…</div>
<h2>Uploads and your changes</h2><div id="packages"></div>
<h2>Items</h2><div id="items"></div>`, HOME_SCRIPT);

// One session, its saves grouped by turn: what the agent said, the files each turn changed, one Undo per turn.
const SESSION_SCRIPT = `
const dir = decodeURIComponent(location.pathname.split('/').pop());
function turnCard(t, n) {
  const pk = t.packages, first = pk[pk.length - 1], last = pk[0];
  const span = when(first.created_at) + (pk.length > 1 && when(last.created_at) !== when(first.created_at) ? ' – ' + when(last.created_at).slice(11) : '');
  const undo = async () => {
    if (t.turn_id) showConflicts('Undo of turn ' + n, await api('/api/app/undo-turn', { turn_id: t.turn_id }));
    else for (const p of pk) if (!p.undone_by) showConflicts('Undo of ' + p.pkg_id, await api('/api/app/undo', { pkg_id: p.pkg_id }));
    load();
  };
  const said = pk.slice().reverse().map(p => p.summary_claimed).filter(Boolean);
  return $('div', { class: 'card' + (t.undone ? ' undone' : '') },
    $('div', {}, $('b', {}, 'Turn ' + n), ' ', $('span', { class: 'm' }, span + ' · ' + pk.length + (pk.length === 1 ? ' save' : ' saves')), ' ',
      t.undone ? $('span', { class: 'm' }, '(undone)') : $('button', { onclick: undo }, 'Undo turn')),
    said.length ? $('div', {}, $('div', { class: 'm' }, 'The agent said:'), $('ul', {}, ...said.map(s => $('li', { class: 'q' }, '“' + s + '”')))) : $('div', { class: 'm' }, 'The agent gave no description.'),
    $('div', { class: 'm' }, 'Files changed (' + t.files.length + '):'),
    $('ul', {}, ...t.files.map(f => $('li', {}, $('code', {}, f.path), ' ', $('span', { class: 'm' }, f.ops.join(', '))))),
    $('details', {}, $('summary', { class: 'm' }, 'What the drive observed'), ...pk.slice().reverse().map(p => $('div', { class: 'm' }, when(p.created_at).slice(11) + ' ' + (p.summary_observed || '') + (p.undone_by ? ' (undone)' : '')))));
}
async function load() {
  const r = await api('/api/app/sessions/' + encodeURIComponent(dir));
  const box = document.getElementById('session'); box.replaceChildren();
  if (r.error) { box.append($('p', { class: 'bad' }, r.error)); return; }
  const x = r.session, a = x.agent;
  const reads = x.activity.filter(e => e.op === 'read').length, runs = x.activity.filter(e => e.op === 'run').length;
  document.title = 'Session · ' + agentName(a);
  box.append($('div', { class: 'card' },
    $('div', {}, $('b', {}, agentName(a)), $('span', { class: 'm' }, ' (as declared) · ' + x.status + ' · started ' + when(x.created_at) + ' · last call ' + when(x.last_call_at))),
    $('div', {}, 'Purpose: ', $('span', { class: 'q' }, '“' + x.purpose + '”')),
    x.summary_claimed ? $('div', {}, 'Latest summary: ', $('span', { class: 'q' }, '“' + x.summary_claimed + '”')) : '',
    $('div', { class: 'm' }, 'Observed by the drive: ' + reads + ' reads, ' + runs + ' commands, ' + x.merges.length + ' saves in ' + x.turns.length + ' turns'),
    $('details', {}, $('summary', {}, 'What it read and ran'),
      $('ul', {}, ...x.activity.slice().reverse().map(e => $('li', {}, $('span', { class: 'm' }, e.ts.slice(11, 19) + ' '), e.op + ' ', $('code', {}, e.detail ? (e.detail.path || e.detail.command || e.detail.query || '') : ''), e.op === 'run' && e.detail ? ' → exit ' + e.detail.exit : ''))))));
  box.append($('h2', {}, 'Turns, newest first'));
  if (!x.turns.length) box.append($('p', { class: 'm' }, 'No saves yet.'));
  x.turns.forEach((t, i) => box.append(turnCard(t, x.turns.length - i)));
}
load().catch(fail);
`;

export const SESSION_HTML = shell('Session', `<div id="session">Loading…</div>`, SESSION_SCRIPT);

// Held items: grouped by folder or by reason; release, put in a ring, or trash, one by one or a selection.
const HELD_SCRIPT = `
let data = null, by = 'folder';
const selected = new Set();
function previewOf(i) {
  if (i.preview === 'image') return $('img', { class: 'prev', loading: 'lazy', alt: 'preview of ' + i.name, src: '/api/app/items/' + encodeURIComponent(i.item_id) + '/preview', onerror: function () { this.replaceWith($('div', { class: 'm' }, 'No preview.')); } });
  if (i.preview === 'text') {
    const pre = $('pre', { class: 'prev' }, '…');
    api('/api/app/items/' + encodeURIComponent(i.item_id) + '/text').then(t => { pre.textContent = (t.text || '(empty)') + (t.truncated ? '\\n…' : ''); }).catch(() => { pre.textContent = 'No preview.'; });
    return pre;
  }
  return $('div', { class: 'm' }, 'No preview for this kind of file.');
}
function ringSelect() { return $('select', { 'aria-label': 'ring' }, ...data.rings.map(r => $('option', { value: r }, r.replace('ring:', '')))); }
async function act(kind, ids, ring) {
  if (!ids.length) { msg('Select some items first.'); return; }
  const r = await api('/api/app/held/' + kind, { item_ids: ids, ring });
  if (!r.ok) { msg(r.error === 'not_held' ? 'Nothing changed: ' + r.problems.map(p => p.reason).join('; ') : r.error); return load(); }
  const done = kind === 'release' ? 'Released' : kind === 'ring' ? 'Put in ' + ring.replace('ring:', '') + ':' : 'Moved to Trash:';
  for (const id of ids) selected.delete(id);
  const box = document.getElementById('msg'); box.replaceChildren($('span', { class: 'ok' }, done + ' ' + r.items.length + (r.items.length === 1 ? ' item. ' : ' items. ')),
    $('button', { onclick: async () => { showConflicts('Undo', await api('/api/app/undo', { pkg_id: r.pkg_id })); load(); } }, 'Undo'));
  load();
}
function itemCard(i) {
  const sel = $('input', { type: 'checkbox', 'aria-label': 'select ' + i.name, checked: selected.has(i.item_id), onchange: (e) => { e.target.checked ? selected.add(i.item_id) : selected.delete(i.item_id); count(); } });
  const rs = ringSelect();
  return $('div', { class: 'card row' }, sel, $('div', { style: 'flex:1;min-width:0' },
    $('div', {}, $('b', {}, i.name), ' ', $('span', { class: 'm' }, size(i.size) + ' · ' + when(i.created_at) + (by === 'reason' ? ' · ' + (i.folder || '(top level)') : ''))),
    $('div', {}, by === 'folder' ? $('b', {}, data.reasons[i.reason] + '. ') : '', i.reason_text),
    i.rings_found.length ? $('div', { class: 'ring' }, 'Also placed in ' + i.rings_found.join(', ') + '; releasing clears those too.') : '',
    previewOf(i),
    $('div', {}, $('button', { onclick: () => act('release', [i.item_id]) }, 'Release'), rs, $('button', { onclick: () => act('ring', [i.item_id], rs.value) }, 'Put in ring'), $('button', { onclick: () => act('trash', [i.item_id]) }, 'Trash'))));
}
function count() { document.getElementById('count').textContent = selected.size + ' selected'; }
function render() {
  const box = document.getElementById('list'); box.replaceChildren();
  const ids = new Set(data.items.map(i => i.item_id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  count();
  if (!data.items.length) { box.append($('p', { class: 'm' }, 'Nothing is held. Items the ring check cannot place wait here for you.')); return; }
  const groups = new Map();
  for (const i of data.items) { const k = by === 'folder' ? (i.folder || '(top level)') : i.reason; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const keys = [...groups.keys()].sort((a, b) => by === 'reason' ? Object.keys(data.reasons).indexOf(a) - Object.keys(data.reasons).indexOf(b) : a.localeCompare(b));
  for (const k of keys) {
    const list = groups.get(k);
    const all = $('input', { type: 'checkbox', 'aria-label': 'select group', checked: list.every(i => selected.has(i.item_id)), onchange: (e) => { for (const i of list) e.target.checked ? selected.add(i.item_id) : selected.delete(i.item_id); render(); } });
    box.append($('h3', {}, all, ' ', by === 'folder' ? $('code', {}, k) : data.reasons[k], $('span', { class: 'm' }, ' · ' + list.length)));
    for (const i of list) box.append(itemCard(i));
  }
}
async function load() {
  data = await api('/api/app/held');
  const c = document.getElementById('counts');
  c.textContent = data.items.length + ' held' + (data.items.length ? ': ' + Object.entries(data.counts).map(([k, n]) => data.reasons[k] + ' ' + n).join(' · ') : '');
  const rs = document.getElementById('ring'); if (!rs.options.length) for (const r of data.rings) rs.append($('option', { value: r }, r.replace('ring:', '')));
  render();
}
document.getElementById('by').onchange = (e) => { by = e.target.value; render(); };
document.getElementById('rel').onclick = () => act('release', [...selected]);
document.getElementById('put').onclick = () => act('ring', [...selected], document.getElementById('ring').value);
document.getElementById('tr').onclick = () => act('trash', [...selected]);
load().catch(fail);
`;

export const HELD_HTML = shell('Held items', `<h2>Held for review</h2>
<p class="m">The ring check could not place these, so no session sees them. Release what is fine for agents to use; put the rest in a ring or in Trash. Every action can be undone.</p>
<p id="counts" class="m"></p>
<div class="bar"><label>Group by <select id="by"><option value="folder">folder</option><option value="reason">reason</option></select></label>
<span id="count" class="m"></span><br><button id="rel">Release selected</button><select id="ring" aria-label="ring for the selection"></select><button id="put">Put selected in ring</button><button id="tr">Trash selected</button></div>
<div id="list">Loading…</div>`, HELD_SCRIPT);
