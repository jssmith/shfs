// Test helper: a drive with a given MCP surface over HTTP, and an SDK client signed in to it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp, type HttpServer } from '../http.js';
import { tempContext } from '../testing.js';
import type { Surface } from '../context.js';
import type { Sandbox } from '../sessions/sandbox.js';

export interface McpEnv {
  ctx: ReturnType<typeof tempContext>;
  http: HttpServer;
  client: Client;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; structured: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** `port` is shifted by AGENT_DRIVE_TEST_PORT_OFFSET. */
export async function mcpEnv(surface: Surface, port: number, sandbox?: Sandbox): Promise<McpEnv> {
  const p = port + Number(process.env.AGENT_DRIVE_TEST_PORT_OFFSET ?? 0);
  const ctx = tempContext(sandbox, surface);
  ctx.config.port = p;
  ctx.config.publicUrl = `http://127.0.0.1:${p}`;
  const http = await startHttp(ctx);
  const conn = http.provider.directConnection('surface-test');
  const client = new Client({ name: 'surface-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${p}/mcp`), { requestInit: { headers: { authorization: `Bearer ${conn.tokens.access_token}` } } }));
  return {
    ctx,
    http,
    client,
    async call(name, args) {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
      return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: !!r.isError, structured: r.structuredContent ?? {} };
    },
    async close() {
      await client.close();
      await http.close();
      await ctx.dispose();
    },
  };
}
