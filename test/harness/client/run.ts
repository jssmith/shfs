// Command line for the scripted MCP client. Prints a JSON report.
//
//   node test/harness/client/run.ts --url http://localhost:9301/mcp \
//     [--login browser|form] [--call 'echo={"text":"hi"}'] [--token-file F] [--screenshot F]
//
// Credentials for the sign-in page: AGENT_DRIVE_TEST_USER, AGENT_DRIVE_TEST_PASSWORD
// (the stub's defaults are test / test-password). Exit status 1 if any call fails.

import { parseArgs } from 'node:util';
import { runHarness } from './mcp-client.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    login: { type: 'string', default: 'browser' },
    call: { type: 'string', multiple: true, default: [] },
    'token-file': { type: 'string' },
    screenshot: { type: 'string' },
    'redirect-uri': { type: 'string' },
  },
});
const url = values.url ?? process.env.AGENT_DRIVE_MCP_URL;
if (!url) { console.error('give --url or AGENT_DRIVE_MCP_URL'); process.exit(2); }
if (values.login !== 'browser' && values.login !== 'form') { console.error('--login is browser or form'); process.exit(2); }

const calls = values.call.map((c) => {
  const i = c.indexOf('=');
  return i < 0 ? { name: c, args: {} } : { name: c.slice(0, i), args: JSON.parse(c.slice(i + 1)) as Record<string, unknown> };
});

const report = await runHarness({
  url, login: values.login, calls,
  ...(values['token-file'] ? { tokenFile: values['token-file'] } : {}),
  ...(values.screenshot ? { screenshot: values.screenshot } : {}),
  ...(values['redirect-uri'] ? { redirectUri: values['redirect-uri'] } : {}),
});
console.log(JSON.stringify(report, null, 2));
process.exit(report.calls.every((c) => c.ok) ? 0 : 1);
