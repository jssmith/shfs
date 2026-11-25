// The shell-first surfaces. v2: start_session, bash, read, write, edit, with
// the argument names and conventions of coding-agent harnesses (Claude
// Code's Bash, Read, Write, Edit). v3: start_session and bash only. Changes
// under /drive merge automatically (merge/auto.ts); the rest of the drive is
// the `drive` command inside the shell (sessions/drive-command.ts). The skill
// is `drive help` and the resource skill://agent-drive/SKILL.md.
// docs/mcp-tools.md quotes every string here.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { diffWithIgnored } from '../merge/merge.js';
import { isToolCache } from '../merge/ignore.js';
import { outcomeText, type AutoMerge } from '../merge/auto.js';
import { hiddenCountsText } from '../sessions/drive-command.js';
import type { Sessions } from '../sessions/manager.js';
import { callerFrom, plural, RESULT_SCHEMA, type Extra, type Kit } from './common.js';
import { PURPOSE_EXAMPLES } from './classic.js';
import { PARTIAL_VIEW, SHELL_SKILL } from './skill.js';

export const SKILL_URI = 'skill://agent-drive/SKILL.md';
export const READ_LIMIT = 2000;
export const LINE_CAP = 2000;
export const BASH_TIMEOUT_MS = 120_000;
export const BASH_TIMEOUT_MAX_MS = 600_000;

const SAVES = 'Changes under /drive save to the drive automatically about 2 s after your last change; the next result says whether the save worked.';

export const SHELL_WORDING = {
  start_session: `Open a session in the person's drive: a Linux shell with their files at /drive. Call it once per conversation and keep the session_id it returns for every later call, including later requests in the same conversation. Changes under /drive save to the drive automatically. Examples of a purpose: ${PURPOSE_EXAMPLES.join(', ')}.`,
  purpose: `What you are going to do, in a sentence, e.g. ${PURPOSE_EXAMPLES.join(' or ')}`,
  session_id: 'The session_id returned by start_session; the same one for the whole conversation',
  bash: (v3: boolean) =>
    `Run a bash command in the session's Linux sandbox (no network). Each command starts in /drive, the person's files; /work is scratch space that is never saved. ${SAVES} ` +
    (v3 ? `Read files with cat -n or sed -n '10,40p' file, write them with cat > file <<'EOF', and edit them with sed -i or python3. ` : '') +
    `The drive command does the rest: drive search <words>, drive status, drive save "message", drive help. Output is capped at 64 KB (the full output is saved under /work/.drive-output/).`,
  command: 'The command to run, e.g. "ls -R", "grep -ril invoice ." or "drive search tax 2025"',
  timeout: `Optional timeout in milliseconds (default ${BASH_TIMEOUT_MS}, max ${BASH_TIMEOUT_MAX_MS})`,
  description: 'Clear, concise description of what this command does in 5-10 words, e.g. "List the files in household". The person sees it in the drive\'s history.',
  read: `Read a file in the session. file_path is under /drive (the person's files; relative paths are taken from /drive) or /work. Returns the lines numbered like cat -n, starting at 1: by default up to ${READ_LIMIT} lines from the start; for longer files pass offset and limit. Lines longer than ${LINE_CAP} characters are cut. Your unsaved changes are included.`,
  read_path: 'The file to read, e.g. /drive/household/notes/plan.md',
  offset: 'The line number to start reading from (1 is the first line). Only for files too long to read at once',
  limit: `The number of lines to read (default ${READ_LIMIT})`,
  write: 'Write a file in the session, replacing it if it exists; folders are created as needed. Under /drive the file saves to the drive automatically about 2 s after your last change; under /work it stays scratch. Prefer edit for changing part of an existing file.',
  write_path: 'The file to write, e.g. /drive/household/notes/summary.md',
  content: 'The complete content of the file',
  edit: 'Replace exact text in a file in the session. old_string must appear in the file exactly once (include enough surrounding text to make it unique), unless replace_all is true. Keep the file\'s indentation exactly. Under /drive the change saves to the drive automatically. Read the file first.',
  edit_path: 'The file to edit, e.g. /drive/household/notes/plan.md',
  old_string: 'The exact text to replace',
  new_string: 'The text to replace it with (must differ from old_string)',
  replace_all: 'Replace every occurrence of old_string (default false)',
};

export const SHELL_NEXT_STEP: Record<string, string> = {
  edit_no_match: 'Read the file to see its current text, then call edit again with an exact copy of the text to replace.',
  edit_not_unique: 'Add surrounding lines to old_string so it matches once, or set replace_all to true.',
  edit_no_change: 'Pass the new text as new_string.',
  binary_file: 'Use bash for binary files (e.g. file, pdftotext, python3).',
  not_found: 'Check the path with ls in bash, then try again.',
};

/** cat -n: the line number right-aligned in 6 columns, a tab, the line. */
export function numberLines(text: string, offset = 1, limit = READ_LIMIT): { out: string; total: number; first: number; last: number } {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const first = Math.max(1, Math.floor(offset));
  const slice = lines.slice(first - 1, first - 1 + Math.max(1, Math.floor(limit)));
  const out = slice.map((l, i) => `${String(first + i).padStart(6)}\t${l.length > LINE_CAP ? `${l.slice(0, LINE_CAP)}… (line cut at ${LINE_CAP} characters)` : l}`).join('\n');
  return { out, total, first, last: first + slice.length - 1 };
}

/** What a changing call tells the agent about its changes under /drive. */
async function changedNote(sessions: Sessions, dir_id: string): Promise<{ note: string; changes: { kind: string; path: string }[] } | null> {
  const { changes } = await sessions.lock.run(dir_id, () => diffWithIgnored(sessions, dir_id));
  if (!changes.length) return null;
  const list = changes.slice(0, 20).map((c) => (c.from_path ? `${c.kind} ${c.from_path} → ${c.path}` : `${c.kind} ${c.path}`)).join(', ') + (changes.length > 20 ? `, and ${changes.length - 20} more` : '');
  return { note: `Unsaved changes under /drive: ${list}. They save to the drive automatically in about 2 s.`, changes: changes.map((c) => ({ kind: c.kind, path: c.path })) };
}

export function registerShell(kit: Kit, surface: 'v2' | 'v3'): void {
  const { server, ctx, ok, fail, withSession, record, clientInfo } = kit;
  const { sessions } = ctx;
  if (!ctx.auto) throw new Error('the shell surfaces need the context built with surface v2 or v3');
  const auto: AutoMerge = ctx.auto;
  const out = { outputSchema: RESULT_SCHEMA };
  const sid = z.string().optional().describe(SHELL_WORDING.session_id);
  const W = SHELL_WORDING;

  /** Outcomes of automatic merges since the last call go at the top of this result. */
  function withReports(dir_id: string, res: CallToolResult): CallToolResult {
    const reports = auto.takeReports(dir_id);
    if (!reports.length) return res;
    const head = reports.map((o) => `[drive] ${outcomeText(o)}`).join('\n');
    const content = [{ type: 'text' as const, text: `${head}\n\n${(res.content[0] as { text?: string } | undefined)?.text ?? ''}` }, ...res.content.slice(1)];
    const saves = reports.map((o) => ({ at: o.at, ok: o.result.ok, pkg_id: o.result.pkg_id ?? null, changes: o.result.changes, conflicts: o.result.conflicts }));
    return { ...res, content, structuredContent: { ...(res.structuredContent ?? {}), automatic_saves: saves } };
  }

  /** A session tool on this surface: typed errors with shell-specific next steps, merge reports on every result. */
  function tool<A extends { session_id?: string }>(name: string, fn: (dir_id: string, args: A) => Promise<CallToolResult>) {
    return withSession<A>(name, async (row, args) => {
      let res: CallToolResult;
      try {
        res = await fn(row.dir_id, args);
      } catch (e) {
        const reason = (e as { reason?: string }).reason;
        if (reason && SHELL_NEXT_STEP[reason]) res = fail(reason, (e as Error).message.slice(reason.length + 2), {}, SHELL_NEXT_STEP[reason]);
        else throw e;
      }
      return withReports(row.dir_id, res);
    });
  }

  server.registerTool(
    'start_session',
    { description: W.start_session, inputSchema: { purpose: z.string().min(1).max(2000).describe(W.purpose) }, ...out },
    async ({ purpose }, extra): Promise<CallToolResult> => {
      const t0 = Date.now();
      const c = callerFrom(extra as Extra);
      const ci = clientInfo();
      const { session_id, row } = await sessions.start(c.grant_id, purpose, { name: ci?.name, version: ci?.version, registered: c.registered_name ?? undefined, transport: c.transport_id });
      const s = sessions.summary(row.dir_id);
      const top = Object.entries(s.top).map(([d, n]) => `${d} (${n})`).join(', ') || 'empty';
      const res = ok(
        [
          `session_id: ${session_id}`,
          'Keep this session_id for this whole conversation, including later requests. Pass it to every other tool; it is a secret and nothing shows it again.',
          `/drive: ${plural(s.files, 'file')}. Top level: ${top}.`,
          `Topics matching your purpose: ${s.topics.join(', ') || 'none yet'}.`,
          'Changes you make under /drive save to the drive automatically, about 2 s after your last change. /work is scratch and is never saved.',
          `${PARTIAL_VIEW} Hidden from sessions: ${hiddenCountsText(s.hidden)}.`,
          'In the shell: drive help (how to work here), drive search <words>, drive status, drive save "message".',
        ].join('\n'),
        { session_id, files: s.files, top_level: s.top, topics: s.topics, hidden: s.hidden, partial_view: true },
      );
      record(c, 'start_session', row.dir_id, 'none', t0, res, false);
      return res;
    },
  );

  server.registerTool(
    'bash',
    {
      description: W.bash(surface === 'v3'),
      inputSchema: {
        session_id: sid,
        command: z.string().min(1).max(100_000).describe(W.command),
        timeout: z.number().int().min(1000).max(BASH_TIMEOUT_MAX_MS).optional().describe(W.timeout),
        description: z.string().max(500).optional().describe(W.description),
      },
      ...out,
    },
    tool('bash', async (dir_id, { command, timeout, description }: { session_id?: string; command: string; timeout?: number; description?: string }) => {
      auto.begin(dir_id);
      let note: string | undefined;
      let changed: Awaited<ReturnType<typeof changedNote>> = null;
      try {
        const before = await sessions.driveStamp(dir_id);
        let r;
        try {
          r = await sessions.run(dir_id, command, (timeout ?? BASH_TIMEOUT_MS) / 1000, { shell: 'bash' });
        } catch (e) {
          console.error('sandbox error:', e);
          return fail('sandbox_unavailable', 'the sandbox could not start');
        }
        if ((await sessions.driveStamp(dir_id)) !== before) changed = await changedNote(sessions, dir_id);
        if (changed) note = (description?.trim() || command.replace(/\s+/g, ' ').slice(0, 200)).slice(0, 300);
        const parts = [`exit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`];
        if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
        if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
        if (r.truncated) parts.push(`(output cut at 64 KB; full output in ${r.fullOutput})`);
        if (changed) parts.push(changed.note);
        return ok(parts.join('\n'), {
          exit_code: r.exitCode, timed_out: r.timedOut, truncated: r.truncated, ...(r.fullOutput ? { full_output: r.fullOutput } : {}),
          unsaved_changes: changed?.changes ?? [],
        });
      } finally {
        auto.end(dir_id, note);
      }
    }),
  );

  if (surface === 'v3') {
    registerSkillResource(kit);
    return;
  }

  server.registerTool(
    'read',
    {
      description: W.read,
      inputSchema: {
        session_id: sid,
        file_path: z.string().min(1).max(4096).describe(W.read_path),
        offset: z.number().int().min(1).optional().describe(W.offset),
        limit: z.number().int().min(1).max(100_000).optional().describe(W.limit),
      },
      ...out,
    },
    tool('read', async (dir_id, { file_path, offset, limit }: { session_id?: string; file_path: string; offset?: number; limit?: number }) => {
      const r = await sessions.readAny(dir_id, file_path);
      if (r.binary) return ok(`${r.shown} is a binary file of ${r.size} bytes; use bash to work with it (e.g. file, pdftotext, python3).`, { path: r.shown, size: r.size, binary: true });
      const text = r.data.toString('utf8');
      if (!text.length) return ok(`${r.shown} is empty.`, { path: r.shown, size: 0, lines: 0 });
      const n = numberLines(text, offset ?? 1, limit ?? READ_LIMIT);
      if (n.first > n.total) return ok(`${r.shown} has ${plural(n.total, 'line')}; offset ${n.first} is past the end.`, { path: r.shown, lines: n.total });
      const more: string[] = [];
      if (n.last < n.total) more.push(`(lines ${n.first}–${n.last} of ${n.total}; read more with offset=${n.last + 1})`);
      if (r.size > r.data.length) more.push(`(only the first ${r.data.length} of ${r.size} bytes were loaded; use bash for the rest)`);
      return ok([n.out, ...more].join('\n'), { path: r.shown, size: r.size, lines: n.total, first_line: n.first, last_line: n.last });
    }),
  );

  /** For write and edit: under /drive (and not a tool cache), the change waits for the automatic merge. */
  async function afterChange(dir_id: string, where: 'drive' | 'work', rel: string, what: string): Promise<string> {
    if (where === 'work') return '/work is scratch and is never saved to the drive.';
    if (isToolCache(rel)) return 'This path is a tool cache; it is not saved to the drive.';
    auto.end(dir_id, what);
    return 'It saves to the drive automatically in about 2 s.';
  }

  server.registerTool(
    'write',
    {
      description: W.write,
      inputSchema: { session_id: sid, file_path: z.string().min(1).max(4096).describe(W.write_path), content: z.string().describe(W.content) },
      ...out,
    },
    tool('write', async (dir_id, { file_path, content }: { session_id?: string; file_path: string; content: string }) => {
      auto.begin(dir_id);
      let ended = false;
      try {
        const r = await sessions.writeAny(dir_id, file_path, content);
        const tail = await afterChange(dir_id, r.where, r.rel, `write ${r.shown}`);
        ended = r.where === 'drive' && !isToolCache(r.rel);
        return ok(`Wrote ${r.bytes} bytes to ${r.shown}. ${tail}`, { path: r.shown, bytes: r.bytes });
      } finally {
        if (!ended) auto.end(dir_id);
      }
    }),
  );

  server.registerTool(
    'edit',
    {
      description: W.edit,
      inputSchema: {
        session_id: sid,
        file_path: z.string().min(1).max(4096).describe(W.edit_path),
        old_string: z.string().describe(W.old_string),
        new_string: z.string().describe(W.new_string),
        replace_all: z.boolean().optional().describe(W.replace_all),
      },
      ...out,
    },
    tool('edit', async (dir_id, a: { session_id?: string; file_path: string; old_string: string; new_string: string; replace_all?: boolean }) => {
      auto.begin(dir_id);
      let ended = false;
      try {
        const r = await sessions.editFile(dir_id, a.file_path, a.old_string, a.new_string, !!a.replace_all);
        const tail = await afterChange(dir_id, r.where, r.rel, `edit ${r.shown}`);
        ended = r.where === 'drive' && !isToolCache(r.rel);
        // A few numbered lines around the (first) change, as the file is now.
        const line = r.text.slice(0, r.at).split('\n').length;
        const span = a.new_string.split('\n').length;
        const snip = numberLines(r.text, Math.max(1, line - 3), span + 6).out;
        return ok(`Edited ${r.shown}: replaced ${plural(r.count, 'occurrence')}. ${tail}\n${snip}`, { path: r.shown, replaced: r.count });
      } finally {
        if (!ended) auto.end(dir_id);
      }
    }),
  );

  registerSkillResource(kit);
}

function registerSkillResource(kit: Kit): void {
  kit.server.registerResource(
    'agent-drive-skill',
    SKILL_URI,
    { title: 'Agent Drive skill', description: 'How to work in Agent Drive from its shell (same text as `drive help`).', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: SHELL_SKILL }] }),
  );
}
