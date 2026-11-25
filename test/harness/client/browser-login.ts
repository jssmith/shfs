// Complete another client's OAuth sign-in in headless Chromium.
//   node test/harness/client/browser-login.ts <authorization-url> [--screenshot F]
// Credentials: AGENT_DRIVE_TEST_USER, AGENT_DRIVE_TEST_PASSWORD (stub defaults).
// Used as the "browser" for OpenCode (see opencode/bin/xdg-open) and Open WebUI.
import { parseArgs } from 'node:util';
import { completeInBrowser } from './login.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { screenshot: { type: 'string' } } });
const url = positionals[0];
if (!url) { console.error('usage: browser-login.ts <authorization-url>'); process.exit(2); }
const cb = await completeInBrowser(url, {
  user: process.env.AGENT_DRIVE_TEST_USER ?? 'test',
  password: process.env.AGENT_DRIVE_TEST_PASSWORD ?? 'test-password',
}, values.screenshot ? { screenshot: values.screenshot } : {});
// Print only the callback's origin and path: the query holds the one-time code.
console.log(`signed in; browser landed on ${cb.origin}${cb.pathname}`);
