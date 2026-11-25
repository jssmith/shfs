// OpenCode as a multi-turn client: one OpenCode session across turns
// (`opencode run --session <id>` after the first turn), in an isolated home.
// The drive is reached with a static Bearer token from `agent-drive connection
// add` instead of OAuth: OpenCode's OAuth callback listens on a fixed port
// (19876), which parallel runs would fight over. Sign-in is not what these
// runs measure; decision 0005 covers it.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, createWriteStream, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { ClientTurn, ToolUse } from './types.ts';

export interface OpencodeOptions {
  home: string; // per run
  cacheDir: string; // shared, pre-warmed (provider packages)
  mcpUrl: string;
  token: string;
  model: string;
  apiKey: string;
  timeoutS: number;
  /** Optional: lower the model's context limit so OpenCode compacts sooner. */
  contextLimit?: number;
}

type Ev = {
  type: string; sessionID?: string; timestamp?: number;
  part?: { type?: string; tool?: string; sessionID?: string; state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string }; text?: string; tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } };
  error?: unknown;
};

export function opencodeClient(o: OpencodeOptions) {
  const cfgDir = join(o.home, 'config', 'opencode');
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(join(o.home, 'data'), { recursive: true });
  mkdirSync(join(o.home, 'state'), { recursive: true });
  mkdirSync(join(o.home, 'project'), { recursive: true });
  mkdirSync(o.cacheDir, { recursive: true });
  const modelCfg: Record<string, unknown> = { name: 'Kimi K3', tool_call: true };
  if (o.contextLimit) modelCfg.limit = { context: o.contextLimit, output: 16_000 };
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: `fireworks/${o.model}`,
    small_model: `fireworks/${o.model}`,
    provider: {
      fireworks: {
        npm: '@ai-sdk/openai-compatible', name: 'Fireworks',
        options: { baseURL: 'https://api.fireworks.ai/inference/v1', apiKey: o.apiKey },
        models: { [o.model]: modelCfg },
      },
    },
    mcp: { drive: { type: 'remote', url: o.mcpUrl, enabled: true, oauth: false, headers: { Authorization: `Bearer ${o.token}` } } },
    permission: { edit: 'allow', bash: 'allow', webfetch: 'deny' },
    autoupdate: false, share: 'disabled',
  };
  writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(o.home, 'config'), XDG_DATA_HOME: join(o.home, 'data'),
    XDG_STATE_HOME: join(o.home, 'state'), XDG_CACHE_HOME: o.cacheDir,
  };
  let sessionId: string | undefined;
  let n = 0;

  return {
    name: 'opencode' as const,
    get conversationId() { return sessionId; },
    async turn(prompt: string): Promise<ClientTurn> {
      n++;
      const jsonl = join(o.home, `turn-${String(n).padStart(2, '0')}.jsonl`);
      const args = ['run', '--format', 'json', ...(sessionId ? ['--session', sessionId] : []), prompt];
      const t0 = Date.now();
      const code = await new Promise<number>((resolve) => {
        const p = spawn('timeout', [String(o.timeoutS), 'opencode', ...args], { cwd: join(o.home, 'project'), env, stdio: ['ignore', 'pipe', 'pipe'] });
        p.stdout.pipe(createWriteStream(jsonl));
        p.stderr.pipe(createWriteStream(jsonl.replace(/\.jsonl$/, '.err')));
        p.on('close', (c) => resolve(c ?? -1));
      });
      const ms = Date.now() - t0;
      const events: Ev[] = existsSync(jsonl)
        ? readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Ev]; } catch { return []; } })
        : [];
      const sid = events.find((e) => e.sessionID ?? e.part?.sessionID);
      const thisSession = sid?.sessionID ?? sid?.part?.sessionID;
      if (!sessionId) sessionId = thisSession;
      const tools: ToolUse[] = events.filter((e) => e.type === 'tool_use').map((e) => ({
        name: e.part?.tool ?? '', status: e.part?.state?.status ?? '', input: e.part?.state?.input ?? {},
        output: String(e.part?.state?.output ?? e.part?.state?.error ?? ''),
      }));
      const reply = events.filter((e) => e.type === 'text').map((e) => e.part?.text ?? '').join('\n');
      const tok = events.filter((e) => e.type === 'step_finish').map((e) => e.part?.tokens).filter((t): t is NonNullable<typeof t> => !!t);
      const errors = events.filter((e) => e.type === 'error').map((e) => JSON.stringify(e.error ?? e).slice(0, 300));
      if (code !== 0) errors.push(`exit ${code}${code === 124 ? ' (timeout)' : ''}`);
      return {
        reply, tools, ms, errors,
        sameConversation: thisSession === sessionId,
        tokens: {
          steps: tok.length,
          input: tok.reduce((a, t) => a + t.input, 0) + tok.reduce((a, t) => a + t.cache.read, 0),
          cached: tok.reduce((a, t) => a + t.cache.read, 0),
          output: tok.reduce((a, t) => a + t.output + t.reasoning, 0),
        },
        compacted: compactions(),
      };
    },
    async close() { /* nothing runs between turns */ },
  };

  /** Compaction parts OpenCode stored for this session so far. */
  function compactions(): number {
    if (!sessionId) return 0;
    // OpenCode 1.19 keeps messages and parts in SQLite (data/opencode/opencode.db).
    const file = join(o.home, 'data', 'opencode', 'opencode.db');
    if (!existsSync(file)) return 0;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const r = db.prepare("SELECT COUNT(*) AS n FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'compaction'").get(sessionId) as { n: number };
      return r.n;
    } finally { db.close(); }
  }
}
