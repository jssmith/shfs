// Open WebUI as a multi-turn client: one chat across turns, the drive as a
// native MCP tool server. One container per parallel slot (start.sh with its
// own name, port and data dir), reconfigured for each run's drive. The drive
// is reached with a static Bearer token (auth_type "bearer") rather than the
// OAuth 2.1 flow, which decision 0005 already covered; it keeps runs parallel
// and free of browser steps. The chat mechanics follow connect.ts.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { ClientTurn, ToolUse } from './types.ts';

export interface OwuiOptions { owuiUrl: string; dataDir: string; mcpUrl: string; token: string; model: string; turnTimeoutS: number }

async function api(base: string, path: string, token: string | undefined, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return json as Record<string, any>;
}

type OutItem = { type: string; id?: string; call_id?: string; name?: string; arguments?: string; status?: string; output?: unknown; tool_type?: string; content?: unknown };

export async function openwebuiClient(o: OwuiOptions) {
  const base = o.owuiUrl.replace(/\/$/, '');
  const credFile = `${o.dataDir}/harness-admin.json`;
  let admin: { email: string; password: string };
  if (existsSync(credFile)) admin = JSON.parse(readFileSync(credFile, 'utf8'));
  else {
    admin = { email: 'harness-admin@example.test', password: randomBytes(18).toString('base64url') };
    mkdirSync(o.dataDir, { recursive: true });
    writeFileSync(credFile, JSON.stringify(admin), { mode: 0o600 });
  }
  let token: string;
  try { token = (await api(base, '/api/v1/auths/signin', undefined, { body: admin })).token; }
  catch { token = (await api(base, '/api/v1/auths/signup', undefined, { body: { name: 'Harness Admin', ...admin } })).token; }

  const version = String((await api(base, '/api/version', undefined)).version ?? 'unknown');
  const serverId = 'drive';
  const connection = {
    url: o.mcpUrl, path: '', type: 'mcp', auth_type: 'bearer', key: o.token,
    config: { enable: true, access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }] },
    info: { id: serverId, name: 'Agent Drive', description: 'Agent Drive MCP server' },
  };
  await api(base, '/api/v1/configs/tool_servers', token, { body: { TOOL_SERVER_CONNECTIONS: [connection] } });

  const history: Record<string, any> = {};
  const sent: Record<string, unknown>[] = [];
  let chatId: string | undefined;
  let parent: string | null = null;

  return {
    name: 'openwebui' as const,
    version,
    get conversationId() { return chatId; },
    async turn(prompt: string): Promise<ClientTurn> {
      const t0 = Date.now();
      const errors: string[] = [];
      const userId = crypto.randomUUID(), asstId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const userMsg = { id: userId, parentId: parent, childrenIds: [asstId], role: 'user', content: prompt, timestamp: now, models: [o.model] };
      const asstMsg = { id: asstId, parentId: userId, childrenIds: [], role: 'assistant', content: '', model: o.model, done: false, timestamp: now };
      if (parent) history[parent].childrenIds = [userId];
      history[userId] = userMsg; history[asstId] = asstMsg;
      const chatBody = { title: 'a6 harness chat', models: [o.model], history: { currentId: asstId, messages: history } };
      const prevChat = chatId;
      if (!chatId) chatId = (await api(base, '/api/v1/chats/new', token, { body: { chat: chatBody } })).id as string;
      else await api(base, `/api/v1/chats/${chatId}`, token, { body: { chat: chatBody } });
      sent.push({ role: 'user', content: prompt });
      try {
        await api(base, '/api/chat/completions', token, {
          body: {
            model: o.model, stream: true, messages: sent,
            tool_ids: [`server:mcp:${serverId}`], params: { function_calling: 'native' },
            chat_id: chatId, id: asstId, session_id: 'a6-harness', user_message: userMsg, parent_id: userId,
          },
        });
      } catch (e) { errors.push(String(e).slice(0, 300)); }
      let message: any;
      let polls_failed = 0;
      const deadline = Date.now() + o.turnTimeoutS * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        // A poll can fail while Open WebUI is busy; the turn goes on, so keep polling.
        try { message = (await api(base, `/api/v1/chats/${chatId}`, token)).chat?.history?.messages?.[asstId]; } catch { polls_failed++; continue; }
        if (message?.done) break;
      }
      if (!message?.done) errors.push('turn timed out');
      if (polls_failed) errors.push(`harness: ${polls_failed} status polls failed (Open WebUI busy), recovered`);
      if (message?.error) errors.push(JSON.stringify(message.error).slice(0, 300));
      history[asstId] = message ?? asstMsg;
      sent.push({ role: 'assistant', content: message?.content ?? '', ...(message?.output ? { output: message.output } : {}) });
      parent = asstId;

      const out: OutItem[] = message?.output ?? [];
      const outputs = new Map(out.filter((x) => x.type === 'function_call_output').map((x) => [x.call_id, x.output]));
      const tools: ToolUse[] = out.filter((x) => x.type === 'function_call').map((x) => {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(x.arguments ?? '{}'); } catch { /* keep empty */ }
        const res = outputs.get(x.call_id);
        return { name: x.name ?? '', status: x.status ?? '', input, output: typeof res === 'string' ? res : JSON.stringify(res ?? '') };
      });
      const u = message?.usage ?? {};
      return {
        reply: message?.content ?? '', tools, ms: Date.now() - t0, errors,
        sameConversation: prevChat === undefined || prevChat === chatId,
        tokens: {
          steps: tools.length + 1,
          // input_tokens / output_tokens are summed over the turn's model calls;
          // prompt_tokens, completion_tokens and cached_tokens are the last call's only.
          input: Number(u.input_tokens ?? u.prompt_tokens ?? 0),
          cached: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
          output: Number(u.output_tokens ?? u.completion_tokens ?? 0),
        },
        raw: { usage: u, output: out },
      } as ClientTurn & { raw: unknown };
    },
    async close() { return chatId ? (await api(base, `/api/v1/chats/${chatId}`, token)) : null; },
  };
}
