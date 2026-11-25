// Shared by every MCP surface: results and typed errors, the call log, and
// the session check every tool but start_session goes through.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { get, run } from '../store/db.js';
import type { MergeResult } from '../merge/merge.js';
import { summariseIgnored } from '../merge/ignore.js';
import { ToolError, type SessionRow } from '../sessions/manager.js';

export interface Caller {
  grant_id: string;
  client_id: string;
  registered_name: string | null;
  transport_id: string | undefined;
}

export type Extra = { authInfo?: { clientId: string; extra?: Record<string, unknown> }; sessionId?: string };

export function callerFrom(extra: Extra): Caller {
  const e = extra.authInfo?.extra ?? {};
  if (typeof e.grant_id !== 'string') throw new Error('MCP call without a verified connection');
  return { grant_id: e.grant_id, client_id: extra.authInfo?.clientId ?? '', registered_name: (e.client_name as string | null) ?? null, transport_id: extra.sessionId };
}

export function plural(n: number, w: string): string {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

export function hiddenLine(hidden: Record<string, number>): string {
  const parts = Object.entries(hidden).map(([r, n]) => `in_ring: ${r} (${plural(n, 'item')})`);
  return parts.length ? parts.join('; ') : 'none';
}

export function mergeText(r: MergeResult, verb: string): string {
  const lines: string[] = [];
  if (!r.changes.length) lines.push(`Nothing to merge. Your /drive is up to date with the drive.`);
  else lines.push(`${verb}: ${r.changes.map((c) => (c.from_path ? `${c.kind} ${c.from_path} → ${c.path}` : `${c.kind} ${c.path}`)).join(', ')}.`);
  if (r.pkg_id) lines.push(`Package ${r.pkg_id}. Your /drive now shows the drive's current state, including others' changes.`);
  if (r.ignored.length) lines.push(`Not merged (tool cache): ${summariseIgnored(r.ignored).join(', ')}. They stay in your /drive; nothing to do.`);
  if (r.withheld.length) lines.push(`Placed behind a ring by the drive's check and no longer visible to this session: ${r.withheld.map((w) => `${w.path} (${w.rings.join(', ')})`).join(', ')}.`);
  return lines.join('\n');
}

/**
 * The output schema of every tool on the typed surfaces (v1–v3): `ok`, and on
 * failure a machine-readable `reason` and one sentence `next_step`. Other
 * fields are allowed and vary by tool.
 */
export const RESULT_SCHEMA = z.looseObject({
  ok: z.boolean().describe('true if the call did what was asked'),
  reason: z.string().optional().describe('On failure: a reason code such as needs_session, not_found, merge_conflict'),
  next_step: z.string().optional().describe('On failure: what to do next, in one sentence'),
});

/** The default next step for each reason code (typed surfaces). */
export const NEXT_STEP: Record<string, string> = {
  needs_session: 'Call start_session(purpose) and pass the session_id it returns to every other tool.',
  finished: 'Start a new session with start_session(purpose).',
  stopped: 'Start a new session with start_session(purpose).',
  paused: 'Tell the person the session is paused and try again later.',
  not_found: 'Check the path with ls in the shell, then try again.',
  invalid_path: 'Use a path under /drive or /work without "..", such as /drive/notes/plan.md.',
  too_large: 'Use the shell for large files.',
  sandbox_unavailable: 'Try again in a moment; if it keeps failing, tell the person.',
  internal_error: 'Try the call once more; if it fails again, tell the person.',
  merge_conflict: 'Redo your change on top of the file now in /drive; the next merge then succeeds.',
};

export interface Kit {
  ctx: Context;
  server: McpServer;
  /** v1–v3: results carry ok/reason/next_step and tools declare RESULT_SCHEMA. */
  typed: boolean;
  ok(text: string, structured?: Record<string, unknown>): CallToolResult;
  fail(reason: string, message: string, extra?: Record<string, unknown>, next?: string): CallToolResult;
  record(c: Caller, tool: string, dir_id: string | null, arg: string, t0: number, res: CallToolResult, transportChanged: boolean): void;
  withSession<A extends { session_id?: string }>(tool: string, fn: (row: SessionRow, args: A) => Promise<CallToolResult>): (args: A, extra: Extra) => Promise<CallToolResult>;
  clientInfo(): { name?: string; version?: string } | undefined;
}

export function makeKit(ctx: Context, server: McpServer, typed: boolean): Kit {
  const { sessions, drive } = ctx;
  const db = drive.db;
  const clientInfo = () => server.server.getClientVersion();

  function ok(t: string, structured?: Record<string, unknown>): CallToolResult {
    if (!typed) return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) };
    return { content: [{ type: 'text', text: t }], structuredContent: { ok: true, ...(structured ?? {}) } };
  }

  function fail(reason: string, message: string, extra: Record<string, unknown> = {}, next?: string): CallToolResult {
    if (!typed) return { isError: true, content: [{ type: 'text', text: `${reason}: ${message}` }], structuredContent: { error: reason, message, ...extra } };
    const step = next ?? NEXT_STEP[reason] ?? 'Tell the person what happened.';
    const msg = message.replace(/[.\s]+$/, '');
    return { isError: true, content: [{ type: 'text', text: `${reason}: ${msg}. ${step}` }], structuredContent: { ok: false, reason, next_step: step, message: msg, ...extra } };
  }

  function record(c: Caller, tool: string, dir_id: string | null, arg: string, t0: number, res: CallToolResult, transportChanged: boolean) {
    const ci = clientInfo();
    const prevSession = dir_id ? get<{ ts: string }>(db, 'SELECT ts FROM calls WHERE dir_id = ? ORDER BY id DESC LIMIT 1', dir_id) : undefined;
    const prevConn = get<{ ts: string }>(db, 'SELECT ts FROM calls WHERE grant_id = ? ORDER BY id DESC LIMIT 1', c.grant_id);
    const gap = (p?: { ts: string }) => (p ? t0 - Date.parse(p.ts) : null);
    const sc = res.structuredContent as { error?: string; reason?: string } | undefined;
    const reason = res.isError ? String(sc?.reason ?? sc?.error ?? 'error') : null;
    run(
      db,
      `INSERT INTO calls (ts, grant_id, client_id, client_name, client_version, registered_name, transport_session_id, tool, dir_id, session_arg, transport_changed, gap_session_ms, gap_connection_ms, duration_ms, ok, error_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      new Date(t0).toISOString(), c.grant_id, c.client_id, ci?.name ?? null, ci?.version ?? null, c.registered_name, c.transport_id ?? null, tool, dir_id, arg, transportChanged ? 1 : 0,
      gap(prevSession), gap(prevConn), Date.now() - t0, res.isError ? 0 : 1, reason,
    );
  }

  function withSession<A extends { session_id?: string }>(tool: string, fn: (row: SessionRow, args: A) => Promise<CallToolResult>) {
    return async (args: A, extra: Extra): Promise<CallToolResult> => {
      const t0 = Date.now();
      const c = callerFrom(extra);
      const found = sessions.lookup(args.session_id, c.grant_id);
      let res: CallToolResult;
      let transportChanged = false;
      const row = found.row;
      if (!row) {
        if (typed)
          res = found.arg === 'none'
            ? fail('needs_session', 'this call has no session_id')
            : fail('needs_session', 'this session_id is not valid for this connection', {}, 'Start a new session with start_session(purpose) and use its session_id.');
        else
          res =
            found.arg === 'none'
              ? fail('needs_session', 'pass the session_id from start_session; start one with start_session(purpose) if you have none')
              : fail('needs_session', 'this session_id is not valid for this connection; start a new session with start_session(purpose)');
      } else if (row.status === 'finished' || row.status === 'stopped') {
        const r = row.status === 'finished' ? 'finished' : 'stopped';
        res = typed ? fail(r, `this session is ${row.status}`) : fail(r, `this session is ${row.status}; start a new one with start_session(purpose)`);
      } else if (row.status === 'paused') {
        res = typed ? fail('paused', 'the person paused this session') : fail('paused', 'the person paused this session; try again later');
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

  return { ctx, server, typed, ok, fail, record, withSession, clientInfo };
}
