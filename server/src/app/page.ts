// The one-page app: plain HTML and a little script. Agent-written text is
// inserted with textContent only, never as HTML.
import { esc } from '../util/html.js';

const STYLE = `body{font:15px/1.45 system-ui,sans-serif;max-width:60rem;margin:1.5rem auto;padding:0 1rem;color:#222;background:#fafafa}
h1{font-size:1.3rem}h2{font-size:1.1rem;margin-top:2rem}.card{background:#fff;border:1px solid #ddd;border-radius:6px;padding:.75rem 1rem;margin:.75rem 0}
.m{color:#666;font-size:.85rem}.q{font-style:italic}button{font-size:.85rem;margin-left:.5rem}ul{margin:.3rem 0;padding-left:1.2rem}
.ring{color:#a33}code{font-size:.85rem}details summary{cursor:pointer}.bad{color:#a33}`;

export function loginPage(msg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Drive</title><style>${STYLE}</style></head><body>
<h1>Agent Drive</h1>${msg ? `<p class="bad">${esc(msg)}</p>` : ''}
<form method="post" action="/login"><label hidden>Username <input type="text" name="username" value="owner" autocomplete="username" hidden></label><label>Owner password<br><input type="password" name="password" autofocus required></label> <button type="submit">Sign in</button></form></body></html>`;
}

export const APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Drive</title><style>${STYLE}</style></head><body>
<h1>Agent Drive</h1>
<form method="post" action="/logout" style="float:right;margin-top:-2.5rem"><button>Sign out</button></form>
<div id="msg" class="bad"></div>
<h2>Sessions</h2><div id="sessions">Loading…</div>
<h2>Uploads and your changes</h2><div id="packages"></div>
<h2>Items</h2><div id="items"></div>
<script>
const $ = (t, attrs = {}, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(attrs)) { if (k === 'onclick') e.onclick = v; else e.setAttribute(k, v); } for (const k of kids) e.append(k instanceof Node ? k : document.createTextNode(String(k ?? ''))); return e; };
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-drive-app': '1' }, body: JSON.stringify(body) } : {});
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  return r.json();
}
function opsList(ops) { return $('ul', {}, ...ops.map(o => $('li', {}, o.op + ' ', $('code', {}, o.from_path ? o.from_path + ' → ' + o.path : o.path)))); }
function undoButton(p) {
  if (p.undone_by) return $('span', { class: 'm' }, ' (undone)');
  return $('button', { onclick: async () => {
    const r = await api('/api/app/undo', { pkg_id: p.pkg_id });
    showUndo(p, r);
  } }, 'Undo');
}
function showUndo(p, r) {
  const box = document.getElementById('msg'); box.replaceChildren();
  if (r.conflicts && r.conflicts.length) {
    box.append($('p', {}, 'Undo of ' + p.pkg_id + ': ' + r.reverted.length + ' reverted; these changed since, so they were left as they are:'));
    for (const c of r.conflicts) box.append($('div', {}, $('code', {}, c.path), ' ', c.reason, ' ', $('button', { onclick: async () => { showUndo(p, await api('/api/app/undo', { pkg_id: p.pkg_id, force: [c.item_id] })); } }, 'Revert to before anyway')));
  }
  load();
}
function pkgCard(p) {
  return $('div', { class: 'card' }, $('div', {}, $('b', {}, p.kind), ' ', $('span', { class: 'm' }, p.created_at + ' · ' + p.pkg_id), undoButton(p)),
    p.summary_claimed ? $('div', {}, 'Agent says: ', $('span', { class: 'q' }, '“' + p.summary_claimed + '”')) : '',
    $('div', { class: 'm' }, 'Drive observed: ' + (p.summary_observed || '')), opsList(p.operations));
}
async function load() {
  const s = await api('/api/app/sessions');
  const box = document.getElementById('sessions'); box.replaceChildren();
  if (!s.sessions.length) box.append($('p', { class: 'm' }, 'No sessions yet.'));
  for (const x of s.sessions) {
    const a = x.agent;
    const reads = x.activity.filter(e => e.op === 'read').map(e => e.detail && e.detail.path);
    const runs = x.activity.filter(e => e.op === 'run');
    const writes = x.activity.filter(e => e.op === 'write').map(e => e.detail && e.detail.path);
    box.append($('div', { class: 'card' },
      $('div', {}, $('b', {}, (a.declared_name || a.registered_name || 'unnamed agent') + (a.declared_version ? ' ' + a.declared_version : '')), $('span', { class: 'm' }, ' (as declared) · ' + x.status + ' · started ' + x.created_at + ' · last call ' + x.last_call_at)),
      $('div', {}, 'Purpose: ', $('span', { class: 'q' }, '“' + x.purpose + '”')),
      x.summary_claimed ? $('div', {}, 'Latest summary: ', $('span', { class: 'q' }, '“' + x.summary_claimed + '”')) : '',
      $('div', { class: 'm' }, 'Observed by the drive: ' + reads.length + ' reads, ' + writes.length + ' writes, ' + runs.length + ' commands, ' + x.merges.length + ' merges'),
      $('details', {}, $('summary', {}, 'What it read and ran'),
        $('ul', {}, ...x.activity.slice().reverse().map(e => $('li', {}, $('span', { class: 'm' }, e.ts.slice(11, 19) + ' '), e.op + ' ', $('code', {}, e.detail ? (e.detail.path || e.detail.command || e.detail.query || '') : ''), e.op === 'run' && e.detail ? ' → exit ' + e.detail.exit : '')))),
      ...x.merges.map(pkgCard)));
  }
  const it = await api('/api/app/items');
  const pk = document.getElementById('packages'); pk.replaceChildren(...it.packages.map(pkgCard));
  const ib = document.getElementById('items'); ib.replaceChildren();
  for (const i of it.items) ib.append($('div', {}, $('code', {}, i.path), ' ', i.state === 'trashed' ? $('span', { class: 'm' }, '(in Trash)') : '',
    i.hidden_by.length ? $('span', { class: 'ring' }, ' hidden from agents: ' + i.hidden_by.join(', ')) : '',
    i.state === 'live' ? $('button', { onclick: async () => { await api('/api/app/trash', { item_id: i.item_id }); load(); } }, 'Trash') : ''));
}
load().catch(e => { document.getElementById('msg').textContent = String(e); });
</script></body></html>`;
