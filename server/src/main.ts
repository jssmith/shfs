#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// agent-drive: serve | device add <name> | owner set-password | connection add <name>
import { createInterface } from 'node:readline';
import { configFromEnv, createContext } from './context.js';
import { startHttp } from './http.js';
import { addDevice, setOwnerPassword } from './auth/owner.js';
import { DriveOAuthProvider } from './auth/oauth.js';
import { openDb } from './store/db.js';
import { Blobs } from './store/blobs.js';
import { Drive } from './store/drive.js';
import { archiveToolCaches } from './merge/cleanup.js';
import path from 'node:path';

const USAGE = `usage:
  agent-drive serve                     start the server (AGENT_DRIVE_DATA, AGENT_DRIVE_PORT, AGENT_DRIVE_PUBLIC_URL)
  agent-drive device add <name>         create an upload-only device key for \`drive put\`
  agent-drive owner set-password        set the owner's password (read from stdin)
  agent-drive connection add <name>     issue an MCP access token directly (test harnesses; no browser)
  agent-drive archive-tool-caches       archive merged items that match the merge ignore list (one undoable package)`;

async function readPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  if (process.stdin.isTTY) process.stderr.write('New owner password: ');
  for await (const line of rl) {
    rl.close();
    return line.trim();
  }
  return '';
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  const config = configFromEnv();
  if (cmd === 'serve') {
    const ctx = createContext(config);
    // Leftover sandboxes from an earlier run hold no state we need.
    await ctx.sessions.destroyAll();
    ctx.jobs.start();
    const http = await startHttp(ctx);
    console.log(`agent-drive listening on 127.0.0.1:${config.port}, public URL ${config.publicUrl}, data ${config.dataDir}`);
    const stop = async () => {
      console.log('stopping');
      await http.close();
      await ctx.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
    return -1;
  }
  if (cmd === 'device' && sub === 'add' && rest[0]) {
    const db = openDb(config.dataDir);
    const d = addDevice(db, rest.join(' '));
    console.log(`Device key for "${rest.join(' ')}" (shown once; upload only):\n${d.token}`);
    console.log(`Use it with: AGENT_DRIVE_URL=${config.publicUrl} AGENT_DRIVE_TOKEN=<key> drive put <folder>`);
    return 0;
  }
  if (cmd === 'owner' && sub === 'set-password') {
    const pw = await readPassword();
    const db = openDb(config.dataDir);
    setOwnerPassword(db, pw);
    console.log('Owner password set.');
    return 0;
  }
  if (cmd === 'archive-tool-caches') {
    const drive = new Drive(openDb(config.dataDir), new Blobs(path.join(config.dataDir, 'blobs')));
    const r = archiveToolCaches(drive);
    console.log(r.pkg_id ? `Archived ${r.paths.length} tool-cache items as package ${r.pkg_id} (undo it in the app):\n${r.paths.join('\n')}` : 'No live items match the merge ignore list.');
    return 0;
  }
  if (cmd === 'connection' && sub === 'add' && rest[0]) {
    const db = openDb(config.dataDir);
    const p = new DriveOAuthProvider(db, new URL('/mcp', `${config.publicUrl}/`));
    const c = p.directConnection(rest.join(' '));
    console.log(JSON.stringify({ client_id: c.client_id, connection: c.grant_id, access_token: c.tokens.access_token, expires_in: c.tokens.expires_in }, null, 2));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
