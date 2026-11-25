// Run one command in a fresh drive session and finish it without changes: a
// quick way for a person or a harness to look at the merged drive.
//   node test/harness/client/drive-shell.ts [--token-file F] "<command>"
import { parseArgs } from 'node:util';
import { connect } from './mcp-client.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  url: { type: 'string', default: process.env.AGENT_DRIVE_MCP_URL ?? 'http://localhost:9320/mcp' },
  'token-file': { type: 'string', default: '/tmp/a3-cp2/shell-token.json' },
} });
const { client } = await connect({ url: values.url!, login: 'form', tokenFile: values['token-file']!,
  creds: { user: process.env.AGENT_DRIVE_TEST_USER ?? 'owner', password: process.env.AGENT_DRIVE_TEST_PASSWORD ?? '' } });
const t = async (name: string, args: Record<string, unknown>) =>
  ((await client.callTool({ name, arguments: args })).content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
const sid = (await t('start_session', { purpose: 'harness: look at the drive' })).match(/session_id: (\S+)/)?.[1];
console.log(await t('run', { session_id: sid, command: positionals.join(' ') }));
await t('finish', { session_id: sid, summary: 'harness look, no changes' });
await client.close();
