// The classic surfaces: v0 (the thin drive's tools as they were at
// checkpoint 2) and v1 (the same tools, reworded so a session lasts a
// conversation; typed results). docs/mcp-tools.md quotes every string here.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { run } from '../store/db.js';
import { mergeSession, diffSession } from '../merge/merge.js';
import { hiddenCountsOf } from '../sessions/search.js';
import { callerFrom, hiddenLine, mergeText, plural, RESULT_SCHEMA, type Extra, type Kit } from './common.js';
import { SKILL } from './skill.js';

export const PURPOSE_EXAMPLES = ['"Pull together my 2025 tax documents"', '"Add a kg to pounds function to the unitconv project and test it"', '"Find what I spent at Oak Street Grocer in October"'];

/** Every string that differs between v0 and v1. */
export const CLASSIC_WORDING = {
  v0: {
    start_session: 'Open a session in the drive for one purpose. Returns a secret session_id: keep it and pass it to every other tool. Also returns what /drive holds and how many items are hidden in rings.',
    purpose: 'What you are going to do, in a sentence',
    keep: 'Keep this session_id for this conversation and pass it to every other tool. It is a secret; nothing shows it again.',
    run: 'Run a shell command (sh -c) in the session sandbox. cwd is /drive. No network. Output is capped at 64 KB.',
    command: undefined as string | undefined,
    search: 'Search the text and labels of files in the drive. Also reports how many matches are hidden in rings (counts, never names).',
    query: undefined as string | undefined,
    read: 'Read a text file under /drive in this session (your unmerged changes included). Capped at 256 KB.',
    path: undefined as string | undefined,
    write: 'Write a small text file under /drive in this session (creates folders as needed). Merged at the next checkpoint.',
    content: undefined as string | undefined,
    checkpoint: "Merge your changes under /drive into the shared drive (all or nothing), then bring in others' changes.",
    finish: 'Merge your changes and close the session.',
  },
  v1: {
    start_session: `Open a session in the drive for one purpose. Returns a secret session_id: keep it for this whole conversation and pass it to every other tool. Also returns what /drive holds and how many items are hidden in rings. Examples of a purpose: ${PURPOSE_EXAMPLES.join(', ')}.`,
    purpose: `What you are going to do, in a sentence, e.g. ${PURPOSE_EXAMPLES.join(' or ')}`,
    keep: 'Keep this session_id for this whole conversation, including later requests. Pass it to every other tool; it is a secret and nothing shows it again.',
    run: 'Run a shell command (sh -c) in the session sandbox. cwd is /drive. No network. Output is capped at 64 KB.',
    command: 'The shell command, run with sh -c in /drive, e.g. "ls -R household" or "python3 /work/totals.py"',
    search: 'Search the text and labels of files in the drive. Also reports how many matches are hidden in rings (counts, never names).',
    query: 'Words to look for in the files\' text, names and labels, e.g. "Oak Street Grocer"',
    read: 'Read a text file under /drive in this session (your unmerged changes included). Capped at 256 KB.',
    path: 'A path under /drive, with or without the /drive/ prefix, e.g. "household/notes/plan.md"',
    write: 'Write a small text file under /drive in this session (creates folders as needed). Merged at the next checkpoint.',
    content: 'The complete new content of the file (it replaces what is there)',
    checkpoint: "Merge your changes under /drive into the shared drive (all or nothing), then bring in others' changes. Call this when a piece of work is done, before you answer the person.",
    finish:
      'Merge your changes and close the session. Only call this when the person says they are done or the conversation is ending. For the next request in the same conversation, keep using the same session_id; use checkpoint to merge work as you go.',
  },
};

export function registerClassic(kit: Kit, variant: 'v0' | 'v1'): void {
  const { server, ctx, typed, ok: text, fail, withSession, record, clientInfo } = kit;
  const { sessions, drive } = ctx;
  const db = drive.db;
  const W = CLASSIC_WORDING[variant];
  const out = typed ? { outputSchema: RESULT_SCHEMA } : {};
  const d = <T extends z.ZodType>(s: T, desc: string | undefined): T => (desc ? (s.describe(desc) as T) : s);

  const sid = z.string().optional().describe('The session_id returned by start_session');

  server.registerTool(
    'start_session',
    { description: W.start_session, inputSchema: { purpose: z.string().min(1).max(2000).describe(W.purpose) }, ...out },
    async ({ purpose }, extra): Promise<CallToolResult> => {
      const t0 = Date.now();
      const c = callerFrom(extra as Extra);
      const ci = clientInfo();
      const { session_id, row } = await sessions.start(c.grant_id, purpose, { name: ci?.name, version: ci?.version, registered: c.registered_name ?? undefined, transport: c.transport_id });
      const s = sessions.summary(row.dir_id);
      const top = Object.entries(s.top).map(([dd, n]) => `${dd} (${n})`).join(', ') || 'empty';
      const res = text(
        [
          `session_id: ${session_id}`,
          W.keep,
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
    { description: 'Rejoin a session you started earlier in this conversation, with its session_id. Returns where it stands.', inputSchema: { session_id: sid }, ...out },
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
      description: W.run,
      inputSchema: { session_id: sid, command: d(z.string().min(1).max(100_000), W.command), timeout: z.number().int().min(1).max(600).optional().describe('Seconds, default 60') },
      ...out,
    },
    withSession('run', async (row, { command, timeout }: { session_id?: string; command: string; timeout?: number }) => {
      let r;
      try {
        r = await sessions.run(row.dir_id, command, timeout ?? 60);
      } catch (e) {
        console.error('sandbox error:', e);
        return typed ? fail('sandbox_unavailable', 'the sandbox could not start', {}, 'Try again in a moment, or use read and write meanwhile.') : fail('sandbox_unavailable', 'the sandbox could not start; try again, or use read and write');
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
    { description: W.search, inputSchema: { session_id: sid, query: d(z.string().min(1).max(500), W.query) }, ...out },
    withSession('search', async (row, { query }: { session_id?: string; query: string }) => {
      const r = sessions.search(row.dir_id, query);
      const results = r.results.slice(0, 50);
      const hidden = hiddenCountsOf(r.hidden);
      const lines = results.map((x) => `${x.path}${x.note ? ` (${x.note})` : ''}\n  ${x.snippet.replace(/\s+/g, ' ')}`);
      return text(`${results.length ? lines.join('\n') : 'No matches you can see.'}\nHidden matches: ${hiddenLine(hidden)}.`, { results, hidden });
    }),
  );

  server.registerTool(
    'read',
    { description: W.read, inputSchema: { session_id: sid, path: d(z.string().min(1).max(4096), W.path) }, ...out },
    withSession('read', async (row, { path }: { session_id?: string; path: string }) => {
      const r = await sessions.read(row.dir_id, path);
      if (r.binary) return text(`${r.path} is a binary file of ${r.size} bytes; use run to work with it.`, { path: r.path, size: r.size, binary: true });
      return text(r.truncated ? `${r.text}\n(cut at 256 KB of ${r.size} bytes; use run for the rest)` : r.text, { path: r.path, size: r.size, truncated: r.truncated });
    }),
  );

  server.registerTool(
    'write',
    { description: W.write, inputSchema: { session_id: sid, path: d(z.string().min(1).max(4096), W.path), content: d(z.string(), W.content) }, ...out },
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
        const list = r.conflicts.map((c) => `${c.path}: ${c.reason}${c.yours ? ` (your version is saved at ${c.yours})` : ''}`).join('; ');
        const next =
          "Each conflicting file in /drive now holds the drive's current version (or is gone, if it left the drive); your version is saved under /work/conflicts/. " +
          'Redo your change on top of the file in /drive, then merge again.';
        if (kind === 'finish') {
          run(db, "UPDATE sessions SET status = 'needs_resolution' WHERE dir_id = ?", row.dir_id);
          if (typed)
            return fail(
              'merge_conflict',
              `nothing was merged and the session is NOT finished: it is still open (status needs_resolution). ${list}. ${next.replace(/ Redo.*$/, '')} Your other changes are still in /drive; resume_session(session_id) shows what is unmerged`,
              { conflicts: r.conflicts, status: 'needs_resolution' },
              'Redo your change on top of the file in /drive, then call finish(session_id, summary) again with the same session_id.',
            );
          return fail(
            'merge_conflict',
            `nothing was merged and the session is NOT finished: it is still open (status needs_resolution). ${list}. ${next} ` +
              'Then call finish(session_id, summary) again with the same session_id; your other changes are still in /drive and merge with it. ' +
              'resume_session(session_id) shows what is unmerged.',
            { conflicts: r.conflicts, status: 'needs_resolution' },
          );
        }
        if (typed)
          return fail('merge_conflict', `nothing was merged. ${list}. ${next.replace(/ Redo.*$/, '')}`, { conflicts: r.conflicts }, 'Redo your change on top of the file in /drive, then call checkpoint again.');
        return fail('merge_conflict', `nothing was merged. ${list}. ${next} Then call checkpoint again.`, { conflicts: r.conflicts });
      }
      if (kind === 'checkpoint' && row.status === 'needs_resolution') run(db, "UPDATE sessions SET status = 'open' WHERE dir_id = ?", row.dir_id);
      if (kind === 'finish') {
        run(db, "UPDATE sessions SET status = 'finished' WHERE dir_id = ?", row.dir_id);
        await sessions.destroySandbox(row.dir_id);
      }
      return text(`${mergeText(r, 'Merged')}${kind === 'finish' ? '\nSession finished.' : ''}`, { pkg_id: r.pkg_id ?? null, changes: r.changes, withheld: r.withheld, not_merged_tool_cache: r.ignored });
    });

  server.registerTool(
    'checkpoint',
    { description: W.checkpoint, inputSchema: { session_id: sid, summary: z.string().max(5000).describe('What you changed and why') }, ...out },
    mergeTool('checkpoint'),
  );
  server.registerTool(
    'finish',
    { description: W.finish, inputSchema: { session_id: sid, summary: z.string().max(5000).describe('What you did in this session') }, ...out },
    mergeTool('finish'),
  );
  server.registerTool(
    'get_skill',
    { description: 'How to work in the drive: /drive, /work, checkpoints, rings.', inputSchema: { session_id: sid }, ...out },
    withSession('get_skill', async () => text(SKILL)),
  );
}
