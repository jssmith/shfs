// The MCP surface (tech spec §7, thin subset). One McpServer per MCP
// transport session; every tool call is recorded in `calls`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { get, run } from '../store/db.js';
import { mergeSession, diffSession, type MergeResult } from '../merge/merge.js';
import { ToolError, type SessionRow } from '../sessions/manager.js';
import { SERVER_INSTRUCTIONS, SKILL } from './skill.js';

export const VERSION = '0.1.0';

export interface Caller {
  grant_id: string;
  client_id: string;
  registered_name: string | null;
  transport_id: string | undefined;
}

type Extra = { authInfo?: { clientId: string; extra?: Record<string, unknown> }; sessionId?: string };

function text(t: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

function fail(reason: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `${reason}: ${message}` }], structuredContent: { error: reason, message, ...extra } };
}

function plural(n: number, w: string): string {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

export function hiddenLine(hidden: Record<string, number>): string {
  const parts = Object.entries(hidden).map(([r, n]) => `in_ring: ${r} (${plural(n, 'item')})`);
  return parts.length ? parts.join('; ') : 'none';
}

function mergeText(r: MergeResult, verb: string): string {
  const lines: string[] = [];
  if (!r.changes.length) lines.push(`Nothing to merge. Your /drive is up to date with the drive.`);
  else lines.push(`${verb}: ${r.changes.map((c) => (c.from_path ? `${c.kind} ${c.from_path} → ${c.path}` : `${c.kind} ${c.path}`)).join(', ')}.`);
  if (r.pkg_id) lines.push(`Package ${r.pkg_id}. Your /drive now shows the drive's current state, including others' changes.`);
  if (r.withheld.length) lines.push(`Placed behind a ring by the drive's check and no longer visible to this session: ${r.withheld.map((w) => `${w.path} (${w.rings.join(', ')})`).join(', ')}.`);
  return lines.join('\n');
}

export function buildMcpServer(ctx: Context): McpServer {
  const server = new McpServer({ name: 'agent-drive', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const clientInfo = () => server.server.getClientVersion();
  const { sessions, drive } = ctx;
  const db = drive.db;

  function record(c: Caller, tool: string, dir_id: string | null, arg: string, t0: number, res: CallToolResult, transportChanged: boolean) {
    const ci = clientInfo();
    const prevSession = dir_id ? get<{ ts: string }>(db, 'SELECT ts FROM calls WHERE dir_id = ? ORDER BY id DESC LIMIT 1', dir_id) : undefined;
    const prevConn = get<{ ts: string }>(db, 'SELECT ts FROM calls WHERE grant_id = ? ORDER BY id DESC LIMIT 1', c.grant_id);
    const gap = (p?: { ts: string }) => (p ? t0 - Date.parse(p.ts) : null);
    const reason = res.isError ? String((res.structuredContent as { error?: string } | undefined)?.error ?? 'error') : null;
    run(
      db,
      `INSERT INTO calls (ts, grant_id, client_id, client_name, client_version, transport_session_id, tool, dir_id, session_arg, transport_changed, gap_session_ms, gap_connection_ms, duration_ms, ok, error_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      new Date(t0).toISOString(), c.grant_id, c.client_id, ci?.name ?? null, ci?.version ?? null, c.transport_id ?? null, tool, dir_id, arg, transportChanged ? 1 : 0,
      gap(prevSession), gap(prevConn), Date.now() - t0, res.isError ? 0 : 1, reason,
    );
  }

  /** Wrap a tool that needs a session: checks the id and the connection, records the call. */
  function withSession<A extends { session_id?: string }>(tool: string, fn: (row: SessionRow, args: A) => Promise<CallToolResult>) {
    return async (args: A, extra: Extra): Promise<CallToolResult> => {
      const t0 = Date.now();
      const c = callerFrom(extra);
      const found = sessions.lookup(args.session_id, c.grant_id);
      let res: CallToolResult;
      let transportChanged = false;
      const row = found.row;
      if (!row) {
        res =
          found.arg === 'none'
            ? fail('needs_session', 'pass the session_id from start_session; start one with start_session(purpose) if you have none')
            : fail('needs_session', 'this session_id is not valid for this connection; start a new session with start_session(purpose)');
      } else if (row.status === 'finished' || row.status === 'stopped') {
        res = fail(row.status === 'finished' ? 'finished' : 'stopped', `this session is ${row.status}; start a new one with start_session(purpose)`);
      } else if (row.status === 'paused') {
        res = fail('paused', 'the person paused this session; try again later');
      } else {
        const meta = get<{ last_transport_id: string | null }>(db, 'SELECT last_transport_id FROM session_meta WHERE dir_id = ?', row.dir_id);
        if (c.transport_id && meta?.last_transport_id !== c.transport_id) {
          transportChanged = !!meta?.last_transport_id;
          run(db, 'UPDATE session_meta SET last_transport_id = ? WHERE dir_id = ?', c.transport_id, row.dir_id);
          if (transportChanged) drive.activity({ dir_id: row.dir_id, actor: 'agent', op: 'transport_changed', detail: { from: meta?.last_transport_id, to: c.transport_id } });
        }
        sessions.touch(row.dir_id);
        try {
          res = await fn(row, args);
        } catch (e) {
          if (e instanceof ToolError) res = fail(e.reason, e.message.slice(e.reason.length + 2));
          else if (e instanceof Error && e.message.startsWith('invalid_path')) res = fail('invalid_path', e.message.replace(/^invalid_path:?\s*/, '') || 'bad path');
          else {
            console.error(`tool ${tool} failed:`, e);
            res = fail('internal_error', 'the drive hit an internal error; nothing was changed by this call');
          }
        }
      }
      record(c, tool, row?.dir_id ?? null, found.arg, t0, res, transportChanged);
      return res;
    };
  }

  const sid = z.string().optional().describe('The session_id returned by start_session');

  server.registerTool(
    'start_session',
    {
      description: 'Open a session in the drive for one purpose. Returns a secret session_id: keep it and pass it to every other tool. Also returns what /drive holds and how many items are hidden in rings.',
      inputSchema: { purpose: z.string().min(1).max(2000).describe('What you are going to do, in a sentence') },
    },
    async ({ purpose }, extra): Promise<CallToolResult> => {
      const t0 = Date.now();
      const c = callerFrom(extra as Extra);
      const ci = clientInfo();
      const { session_id, row } = await sessions.start(c.grant_id, purpose, { name: ci?.name, version: ci?.version, registered: c.registered_name ?? undefined, transport: c.transport_id });
      const s = sessions.summary(row.dir_id);
      const top = Object.entries(s.top).map(([d, n]) => `${d} (${n})`).join(', ') || 'empty';
      const res = text(
        [
          `session_id: ${session_id}`,
          `Keep this session_id for this conversation and pass it to every other tool. It is a secret; nothing shows it again.`,
          `/drive: ${plural(s.files, 'file')}. Top level: ${top}.`,
          `Topics matching your purpose: ${s.topics.join(', ') || 'none yet'}.`,
          `Hidden from sessions: ${hiddenLine(s.hidden)}.`,
          `/work is scratch and is never merged. Call get_skill(session_id) for how to work here.`,
        ].join('\n'),
        { session_id, files: s.files, top_level: s.top, topics: s.topics, hidden: s.hidden },
      );
      record(c, 'start_session', row.dir_id, 'none', t0, res, false);
      return res;
    },
  );

  server.registerTool(
    'resume_session',
    { description: 'Rejoin a session you started earlier in this conversation, with its session_id. Returns where it stands.', inputSchema: { session_id: sid } },
    withSession('resume_session', async (row) => {
      const changes = await sessions.lock.run(row.dir_id, () => diffSession(sessions, row.dir_id));
      const s = sessions.summary(row.dir_id);
      drive.activity({ dir_id: row.dir_id, actor: 'agent', op: 'resume_session' });
      return text(
        [
          `Session resumed. Purpose: “${row.purpose}”. Status: ${row.status}. Started ${row.created_at}.`,
          `/drive: ${plural(s.files, 'file')}. Unmerged changes: ${changes.length ? changes.map((c) => `${c.kind} ${c.path}`).join(', ') : 'none'}.`,
          `Hidden from sessions: ${hiddenLine(s.hidden)}.`,
        ].join('\n'),
        { status: row.status, purpose: row.purpose, files: s.files, unmerged: changes.length, hidden: s.hidden },
      );
    }),
  );

  server.registerTool(
    'run',
    {
      description: 'Run a shell command (sh -c) in the session sandbox. cwd is /drive. No network. Output is capped at 64 KB.',
      inputSchema: { session_id: sid, command: z.string().min(1).max(100_000), timeout: z.number().int().min(1).max(600).optional().describe('Seconds, default 60') },
    },
    withSession('run', async (row, { command, timeout }: { session_id?: string; command: string; timeout?: number }) => {
      let r;
      try {
        r = await sessions.run(row.dir_id, command, timeout ?? 60);
      } catch (e) {
        console.error('sandbox error:', e);
        return fail('sandbox_unavailable', 'the sandbox could not start; try again, or use read and write');
      }
      const parts = [`exit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`];
      if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
      if (r.truncated) parts.push(`(output cut at 64 KB; full output in ${r.fullOutput})`);
      return text(parts.join('\n'), { exit_code: r.exitCode, timed_out: r.timedOut, truncated: r.truncated, ...(r.fullOutput ? { full_output: r.fullOutput } : {}) });
    }),
  );

  server.registerTool(
    'search',
    { description: 'Search the text and labels of files in the drive. Also reports how many matches are hidden in rings (counts, never names).', inputSchema: { session_id: sid, query: z.string().min(1).max(500) } },
    withSession('search', async (row, { query }: { session_id?: string; query: string }) => {
      const r = sessions.search(row.dir_id, query);
      const lines = r.results.map((x) => `${x.path}${x.note ? ` (${x.note})` : ''}\n  ${x.snippet.replace(/\s+/g, ' ')}`);
      return text(`${r.results.length ? lines.join('\n') : 'No matches you can see.'}\nHidden matches: ${hiddenLine(r.hidden)}.`, { results: r.results, hidden: r.hidden });
    }),
  );

  server.registerTool(
    'read',
    { description: 'Read a text file under /drive in this session (your unmerged changes included). Capped at 256 KB.', inputSchema: { session_id: sid, path: z.string().min(1).max(4096) } },
    withSession('read', async (row, { path }: { session_id?: string; path: string }) => {
      const r = await sessions.read(row.dir_id, path);
      if (r.binary) return text(`${r.path} is a binary file of ${r.size} bytes; use run to work with it.`, { path: r.path, size: r.size, binary: true });
      return text(r.truncated ? `${r.text}\n(cut at 256 KB of ${r.size} bytes; use run for the rest)` : r.text, { path: r.path, size: r.size, truncated: r.truncated });
    }),
  );

  server.registerTool(
    'write',
    { description: 'Write a small text file under /drive in this session (creates folders as needed). Merged at the next checkpoint.', inputSchema: { session_id: sid, path: z.string().min(1).max(4096), content: z.string() } },
    withSession('write', async (row, { path, content }: { session_id?: string; path: string; content: string }) => {
      const r = await sessions.write(row.dir_id, path, content);
      return text(`Wrote ${r.bytes} bytes to ${r.path}. Not merged yet: call checkpoint when ready.`, r);
    }),
  );

  const mergeTool = (kind: 'checkpoint' | 'finish') =>
    withSession(kind, async (row, { summary }: { session_id?: string; summary: string }) => {
      const r = await sessions.lock.run(row.dir_id, () => mergeSession(sessions, row.dir_id, kind, summary));
      run(db, 'UPDATE session_meta SET summary_last = ? WHERE dir_id = ?', summary, row.dir_id);
      if (!r.ok) {
        if (kind === 'finish') run(db, "UPDATE sessions SET status = 'needs_resolution' WHERE dir_id = ?", row.dir_id);
        return fail('merge_conflict', `nothing was merged. ${r.conflicts.map((c) => `${c.path}: ${c.reason}`).join('; ')}`, { conflicts: r.conflicts });
      }
      if (kind === 'finish') {
        run(db, "UPDATE sessions SET status = 'finished' WHERE dir_id = ?", row.dir_id);
        await sessions.destroySandbox(row.dir_id);
      }
      return text(`${mergeText(r, 'Merged')}${kind === 'finish' ? '\nSession finished.' : ''}`, { pkg_id: r.pkg_id ?? null, changes: r.changes, withheld: r.withheld });
    });

  server.registerTool(
    'checkpoint',
    { description: 'Merge your changes under /drive into the shared drive (all or nothing), then bring in others\' changes.', inputSchema: { session_id: sid, summary: z.string().max(5000).describe('What you changed and why') } },
    mergeTool('checkpoint'),
  );
  server.registerTool(
    'finish',
    { description: 'Merge your changes and close the session.', inputSchema: { session_id: sid, summary: z.string().max(5000).describe('What you did in this session') } },
    mergeTool('finish'),
  );
  server.registerTool(
    'get_skill',
    { description: 'How to work in the drive: /drive, /work, checkpoints, rings.', inputSchema: { session_id: sid } },
    withSession('get_skill', async () => text(SKILL)),
  );
  return server;
}

export function callerFrom(extra: Extra): Caller {
  const e = extra.authInfo?.extra ?? {};
  if (typeof e.grant_id !== 'string') throw new Error('MCP call without a verified connection');
  return { grant_id: e.grant_id, client_id: extra.authInfo?.clientId ?? '', registered_name: (e.client_name as string | null) ?? null, transport_id: extra.sessionId };
}
