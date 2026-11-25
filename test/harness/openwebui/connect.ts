// Connect Open WebUI to the drive as a native MCP tool server, sign in through
// OAuth with headless Chromium, and (optionally) run one chat that uses a tool.
//
//   node test/harness/openwebui/connect.ts [--mcp-url URL] [--chat "prompt"] [--model M]
//
// Steps, all through Open WebUI's HTTP API except the sign-in page:
//   1. create (or sign in as) a harness admin; its synthetic password lives in
//      $OWUI_DATA/harness-admin.json, outside the repository
//   2. dynamic client registration with the drive (/api/v1/configs/oauth/clients/register)
//   3. register the drive as an MCP (Streamable HTTP) tool server with auth_type oauth_2.1
//   4. the per-user OAuth step: /oauth/clients/mcp:drive/authorize in Chromium with
//      the Open WebUI session cookie set, the drive's sign-in page filled in
//   5. list tools; with --chat, one /api/chat/completions call with the drive's tools
// Prints a JSON report.

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { loadPlaywright, USER_SEL, PASS_SEL, SUBMIT_SEL } from '../client/login.ts';

const { values } = parseArgs({
  options: {
    'owui-url': { type: 'string', default: process.env.OWUI_URL ?? 'http://localhost:9310' },
    'mcp-url': { type: 'string', default: process.env.AGENT_DRIVE_MCP_URL ?? 'http://localhost:9301/mcp' },
    'server-id': { type: 'string', default: 'drive' },
    chat: { type: 'string', multiple: true, default: [] },
    model: { type: 'string', default: process.env.OWUI_MODEL ?? 'accounts/fireworks/models/kimi-k3' },
    screenshot: { type: 'string' },
  },
});
const owui = values['owui-url']!.replace(/\/$/, '');
const mcpUrl = values['mcp-url']!;
const serverId = values['server-id']!;
const dataDir = process.env.OWUI_DATA ?? '/tmp/a3-data/openwebui';
const report: Record<string, unknown> = { owui, mcpUrl };

async function api(path: string, token: string | undefined, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${owui}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${text.slice(0, 500)}`);
  return json as Record<string, any>;
}

// 1. Admin account (the first account on a fresh Open WebUI becomes admin).
const credFile = `${dataDir}/harness-admin.json`;
let admin: { email: string; password: string };
if (existsSync(credFile)) admin = JSON.parse(readFileSync(credFile, 'utf8'));
else {
  admin = { email: 'harness-admin@example.test', password: randomBytes(18).toString('base64url') };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(credFile, JSON.stringify(admin), { mode: 0o600 });
}
let token: string;
try {
  token = (await api('/api/v1/auths/signin', undefined, { body: admin })).token;
} catch {
  token = (await api('/api/v1/auths/signup', undefined, { body: { name: 'Harness Admin', ...admin } })).token;
}
report.signedIn = true;

// 2. Dynamic client registration against the drive's authorization server.
const reg = await api('/api/v1/configs/oauth/clients/register?type=mcp', token, {
  body: { url: mcpUrl, client_id: serverId, client_name: 'Open WebUI' },
});
report.registered = reg.status === true;

// 3. The drive as a native MCP tool server.
const connection = {
  url: mcpUrl, path: '', type: 'mcp', auth_type: 'oauth_2.1', key: '',
  config: { enable: true, access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }] },
  info: { id: serverId, name: 'Agent Drive', description: 'Agent Drive MCP server', oauth_client_info: reg.oauth_client_info },
};
await api('/api/v1/configs/tool_servers', token, { body: { TOOL_SERVER_CONNECTIONS: [connection] } });
report.toolServer = `server:mcp:${serverId}`;

// 4. The per-user OAuth step, in headless Chromium with the Open WebUI session.
const pw = loadPlaywright();
if (!pw) throw new Error('Playwright not found');
const browser = await pw.chromium.launch();
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'token', value: token, url: owui }]);
  const page = await context.newPage();
  const authorize = `${owui}/oauth/clients/mcp:${serverId}/authorize`;
  await page.goto(authorize);
  const driveOrigin = new URL(mcpUrl).origin;
  if (new URL(page.url()).origin === driveOrigin) {
    const user = page.locator(USER_SEL).first();
    if (await user.isVisible()) await user.fill(process.env.AGENT_DRIVE_TEST_USER ?? 'test');
    await page.locator(PASS_SEL).first().fill(process.env.AGENT_DRIVE_TEST_PASSWORD ?? 'test-password');
    await page.locator(SUBMIT_SEL).first().click();
    await page.waitForURL((u: URL) => u.origin === new URL(owui).origin, { timeout: 30_000 });
  }
  report.oauthLandedOn = new URL(page.url()).pathname;
  if (values.screenshot) await page.screenshot({ path: values.screenshot });
} finally {
  await browser.close();
}

// 5. Tools as Open WebUI sees them; then one chat.
const tools = await api('/api/v1/tools/', token);
report.tools = (Array.isArray(tools) ? tools : []).map((t: any) => t.id);
// One chat, one or more turns (--chat repeated). Open WebUI runs the tool loop
// only for a saved chat processed in the background (chat_id + session_id +
// message id), the way its own page does; a bare /api/chat/completions call
// returns the model's tool call unexecuted. Earlier assistant turns are sent
// with their `output` items (tool calls and results), which Open WebUI expands
// back into the history the model sees, as its page does.
const turns: Record<string, unknown>[] = [];
if (values.chat.length) {
  const history: Record<string, any> = {};
  const sent: Record<string, unknown>[] = [];
  let chatId: string | undefined;
  let parent: string | null = null;
  for (const prompt of values.chat) {
    const t0 = Date.now();
    const userId = crypto.randomUUID(), asstId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const userMsg = { id: userId, parentId: parent, childrenIds: [asstId], role: 'user', content: prompt, timestamp: now, models: [values.model] };
    const asstMsg = { id: asstId, parentId: userId, childrenIds: [], role: 'assistant', content: '', model: values.model, done: false, timestamp: now };
    if (parent) history[parent].childrenIds = [userId];
    history[userId] = userMsg; history[asstId] = asstMsg;
    const chatBody = { title: 'harness chat', models: [values.model], history: { currentId: asstId, messages: history } };
    if (!chatId) chatId = (await api('/api/v1/chats/new', token, { body: { chat: chatBody } })).id;
    else await api(`/api/v1/chats/${chatId}`, token, { body: { chat: chatBody } });
    sent.push({ role: 'user', content: prompt });
    const started = await api('/api/chat/completions', token, {
      body: {
        model: values.model, stream: true, messages: sent,
        tool_ids: [`server:mcp:${serverId}`], params: { function_calling: 'native' },
        chat_id: chatId, id: asstId, session_id: 'a3-harness', user_message: userMsg, parent_id: userId,
      },
    });
    let message: any;
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      message = (await api(`/api/v1/chats/${chatId}`, token)).chat?.history?.messages?.[asstId];
      if (message?.done) break;
    }
    history[asstId] = message ?? asstMsg;
    sent.push({ role: 'assistant', content: message?.content ?? '', ...(message?.output ? { output: message.output } : {}) });
    parent = asstId;
    turns.push({ prompt, ms: Date.now() - t0, chatId, started, done: message?.done ?? false, content: message?.content, output: message?.output, error: message?.error, usage: message?.usage });
  }
  report.model = values.model;
  report.turns = turns;
}
console.log(JSON.stringify(report, null, 2));
if (turns.length) {
  const out = (turns[0]!.output as { type: string; status?: string; tool_type?: string }[] | undefined) ?? [];
  const called = out.some((o) => o.type === 'function_call' && o.status === 'completed' && o.tool_type === 'mcp');
  if (!called) { console.error('no completed MCP tool call in the first turn'); process.exit(1); }
}
