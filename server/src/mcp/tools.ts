// The MCP surface (tech spec §7, thin subset). One McpServer per MCP
// transport session; every tool call is recorded in `calls`. Which tools an
// agent sees depends on AGENT_DRIVE_SURFACE (config.surface):
//   v0  the thin drive's tools as at checkpoint 2 (classic.ts)
//   v1  the same tools, reworded for one session per conversation (classic.ts)
//   v2  shell-first: bash, read, write, edit, automatic merge (shell.ts)
//   v3  shell-first minimal: bash only (shell.ts)
// docs/mcp-tools.md describes each with its exact wording.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context, Surface } from '../context.js';
import { makeKit } from './common.js';
import { registerClassic } from './classic.js';
import { registerShell } from './shell.js';
import { instructionsFor } from './skill.js';

export const VERSION = '0.1.0';

export { callerFrom, hiddenLine, type Caller } from './common.js';

export function buildMcpServer(ctx: Context, surface: Surface = ctx.config.surface): McpServer {
  const server = new McpServer({ name: 'agent-drive', version: VERSION }, { instructions: instructionsFor(surface), capabilities: surface === 'v2' || surface === 'v3' ? { resources: {} } : {} });
  const kit = makeKit(ctx, server, surface !== 'v0');
  if (surface === 'v0' || surface === 'v1') registerClassic(kit, surface);
  else registerShell(kit, surface);
  return server;
}
