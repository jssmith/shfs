// The drive's whole session flow through the scripted SDK client, against the
// real server: OAuth (DCR + PKCE), start_session, search, read, run, write,
// checkpoint, finish, plus leak probes for a ringed item and session-id misuse.
//
//   AGENT_DRIVE_TEST_USER=owner AGENT_DRIVE_TEST_PASSWORD=… \
//   node test/harness/client/session-flow.ts --url http://localhost:9320/mcp [--login browser|form]
//     [--folder household] [--secret 4111]   (a string only the ringed item contains)
// Prints a JSON report, one entry per step; exit 1 if a step's expectation fails.
import { parseArgs } from 'node:util';
import { connect } from './mcp-client.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.AGENT_DRIVE_MCP_URL ?? 'http://localhost:9320/mcp' },
    login: { type: 'string', default: 'browser' },
    folder: { type: 'string', default: 'household' },
    secret: { type: 'string', default: '4111' },
    'ringed-path': { type: 'string', default: 'household/notes/card-for-online-orders.txt' },
  },
});
const folder = values.folder!;
const t0 = Date.now();
const { client, transport, provider, connectMs } = await connect({ url: values.url!, login: values.login as 'browser' | 'form' });

type Step = { step: string; tool: string; ok: boolean; expect: boolean; ms: number; text: string; note?: string };
const steps: Step[] = [];
async function call(step: string, tool: string, args: Record<string, unknown>, expect: (text: string, isError: boolean) => boolean, note?: string) {
  const t = Date.now();
  let txt = '', isError = false;
  try {
    const r = await client.callTool({ name: tool, arguments: args });
    isError = !!r.isError;
    txt = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
  } catch (e) { isError = true; txt = String(e); }
  const passed = expect(txt, isError);
  steps.push({ step, tool, ok: !isError, expect: passed, ms: Date.now() - t, text: txt.length > 600 ? `${txt.slice(0, 600)}…` : txt, ...(note ? { note } : {}) });
  return txt;
}

const tools = (await client.listTools()).tools.map((t) => t.name);
const started = await call('start', 'start_session', { purpose: 'checkpoint 2: scripted client exercises every tool' }, (_t, e) => !e);
const session_id = started.match(/session_id: (\S+)/)?.[1] ?? '';
const s = { session_id };

await call('search', 'search', { ...s, query: 'Oak Street Grocer' }, (t, e) => !e && t.includes('receipt-oak-street-grocer.md'));
await call('read', 'read', { ...s, path: `${folder}/README.md` }, (t, e) => !e && t.includes('Household folder'));
await call('run-ls', 'run', { ...s, command: `ls -R ${folder} | head -40` }, (t, e) => !e && t.includes('unitconv.py'));
await call('run-pytest', 'run', { ...s, command: `cd ${folder}/projects/unitconv && python3 -m pytest -q 2>&1 | tail -3` }, (t, e) => !e && /2 passed/.test(t));
await call('write', 'write', { ...s, path: `${folder}/notes/cp2-scripted.md`, content: '# Written by the scripted client\n' }, (_t, e) => !e);
await call('run-sees-write', 'run', { ...s, command: `cat ${folder}/notes/cp2-scripted.md` }, (t, e) => !e && t.includes('scripted client'));
await call('checkpoint', 'checkpoint', { ...s, summary: 'Add a note from the scripted client' }, (t, e) => !e && /Merged/.test(t));

// Leak probes: the ringed item must not show by name, content or listing.
await call('leak-search', 'search', { ...s, query: values.secret! }, (t) => !t.includes(values.secret!) && !t.includes('card-for-online'), 'only counts may show');
await call('leak-read', 'read', { ...s, path: values['ringed-path']! }, (t, e) => e && !t.includes(values.secret!));
await call('leak-grep', 'run', { ...s, command: `grep -r '${values.secret}' / 2>/dev/null | grep -v '^/proc' | head -5; ls ${folder}/notes` }, (t) => !t.includes(values.secret! + ' ') && !t.includes('card-for-online'));
// Session-id misuse.
await call('no-session-id', 'read', { path: `${folder}/README.md` }, (t, e) => e && t.includes('needs_session'));
await call('bad-session-id', 'read', { session_id: 'not-a-real-id', path: `${folder}/README.md` }, (t, e) => e && t.includes('needs_session'));

await call('finish', 'finish', { ...s, summary: 'Scripted client run done' }, (_t, e) => !e);
await call('after-finish', 'read', { ...s, path: `${folder}/README.md` }, (t, e) => e && /finished/.test(t));

await transport.terminateSession().catch(() => {});
await client.close();
const failed = steps.filter((x) => !x.expect).map((x) => x.step);
console.log(JSON.stringify({ url: values.url, oauth: provider.events, connectMs, totalMs: Date.now() - t0, transport: transport.sessionId, tools, failed, steps }, null, 2));
process.exit(failed.length ? 1 : 0);
