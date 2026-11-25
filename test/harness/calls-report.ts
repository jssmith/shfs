// Summarise the drive's call log (/api/debug/calls) per client: transport
// sessions, drive sessions, how session ids came back, gaps and errors.
//   AGENT_DRIVE_OWNER_PASSWORD=… node test/harness/calls-report.ts [--server http://localhost:9320] [--json calls.json]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { server: { type: 'string', default: 'http://localhost:9320' }, json: { type: 'string' } } });
type Call = { id: number; ts: string; client_name: string | null; client_version: string | null; grant_id: string; transport_session_id: string | null; tool: string; dir_id: string | null; session_arg: string; transport_changed: number; gap_session_ms: number | null; duration_ms: number; ok: number; error_reason: string | null };

let calls: Call[];
if (values.json) calls = (JSON.parse(readFileSync(values.json, 'utf8')) as { calls: Call[] }).calls;
else {
  const login = await fetch(`${values.server}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'owner', password: process.env.AGENT_DRIVE_OWNER_PASSWORD ?? '' }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  calls = ((await (await fetch(`${values.server}/api/debug/calls?limit=5000`, { headers: { cookie } })).json()) as { calls: Call[] }).calls;
}
calls.sort((a, b) => a.id - b.id);

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : null; };
const byClient = new Map<string, Call[]>();
for (const c of calls) { const k = `${c.client_name ?? '?'} ${c.client_version ?? ''}`.trim(); byClient.set(k, [...(byClient.get(k) ?? []), c]); }

const out = [...byClient].map(([client, cs]) => {
  const sessionCalls = cs.filter((c) => c.tool !== 'start_session');
  const args: Record<string, number> = {};
  for (const c of sessionCalls) args[c.session_arg] = (args[c.session_arg] ?? 0) + 1;
  const sessions = new Map<string, Call[]>();
  for (const c of cs) if (c.dir_id) sessions.set(c.dir_id, [...(sessions.get(c.dir_id) ?? []), c]);
  const transportsPerSession = [...sessions.values()].map((s) => new Set(s.map((c) => c.transport_session_id)).size);
  const sessionsPerTransport = new Map<string, Set<string>>();
  for (const c of cs) if (c.transport_session_id && c.dir_id) sessionsPerTransport.set(c.transport_session_id, (sessionsPerTransport.get(c.transport_session_id) ?? new Set()).add(c.dir_id));
  const gaps = cs.map((c) => c.gap_session_ms).filter((g): g is number => g !== null);
  const errors: Record<string, number> = {};
  for (const c of cs) if (!c.ok) errors[`${c.tool}:${c.error_reason}`] = (errors[`${c.tool}:${c.error_reason}`] ?? 0) + 1;
  const ended = [...sessions.values()].map((s) => s.some((c) => c.tool === 'finish' && c.ok) ? 'finished' : s.some((c) => c.tool === 'checkpoint' && c.ok) ? 'checkpointed' : 'open');
  return {
    client,
    calls: cs.length,
    connections: new Set(cs.map((c) => c.grant_id)).size,
    transports: new Set(cs.map((c) => c.transport_session_id)).size,
    drive_sessions: sessions.size,
    calls_per_session_median: pct([...sessions.values()].map((s) => s.length), 0.5),
    transports_per_session_max: Math.max(0, ...transportsPerSession),
    sessions_per_transport_max: Math.max(0, ...[...sessionsPerTransport.values()].map((s) => s.size)),
    transport_changes_within_session: cs.reduce((a, c) => a + c.transport_changed, 0),
    session_id_on_later_calls: args,
    resume_session_calls: cs.filter((c) => c.tool === 'resume_session').length,
    get_skill_calls: cs.filter((c) => c.tool === 'get_skill').length,
    sessions_ended: { finished: ended.filter((e) => e === 'finished').length, checkpointed_only: ended.filter((e) => e === 'checkpointed').length, open: ended.filter((e) => e === 'open').length },
    gap_between_calls_ms: { median: pct(gaps, 0.5), p90: pct(gaps, 0.9), max: gaps.length ? Math.max(...gaps) : null },
    errors,
  };
});
console.log(JSON.stringify(out, null, 2));
