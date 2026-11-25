// One Unix socket per session, for the `drive` command inside its sandbox
// (sandbox/bin/drive). The socket lives in the session's own directory
// (sessions/<dir_id>/sock/drive.sock) and is mounted read-only at /run/drive
// into that session's sandbox only, so which socket a request arrives on is
// what identifies the session: no token, nothing secret in the sandbox.
//
// Everything that arrives here is untrusted. One request per connection: a
// single JSON line {"argv": [...]} of at most 64 KB, strings only; anything
// else is refused. The handler is bound to the session when the socket is
// made and never reads a session from the request.
import net from 'node:net';
import { mkdirSync, promises as fsp } from 'node:fs';
import path from 'node:path';

export const MAX_REQUEST = 64 * 1024;
export const MAX_ARGS = 64;
export const MAX_CONNECTIONS = 4;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export type SocketHandler = (argv: string[]) => Promise<{ stdout: string; stderr?: string; exit: number }>;

/** Parse and check one request line; null if it is not exactly what the drive command sends. */
export function parseRequest(line: string): string[] | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const argv = (v as { argv?: unknown }).argv;
  if (!Array.isArray(argv) || argv.length > MAX_ARGS || !argv.every((a) => typeof a === 'string' && a.length <= 8192)) return null;
  return argv as string[];
}

export class SessionSocket {
  private constructor(
    private server: net.Server,
    readonly path: string,
    private conns: Set<net.Socket>,
  ) {}

  static async listen(dir: string, owner: { uid: number; gid: number }, handler: SocketHandler): Promise<SessionSocket> {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const p = path.join(dir, 'drive.sock');
    if (Buffer.byteLength(p) > 104) throw new Error(`socket path too long for a Unix socket (${p}); use a shorter AGENT_DRIVE_DATA`);
    await fsp.rm(p, { force: true });
    let active = 0;
    const conns = new Set<net.Socket>();
    const server = net.createServer({ allowHalfOpen: true }, (conn) => {
      conns.add(conn);
      conn.on('close', () => conns.delete(conn));
      const reply = (r: { stdout: string; stderr?: string; exit: number }) => {
        conn.end(`${JSON.stringify({ stdout: r.stdout, stderr: r.stderr ?? '', exit: r.exit })}\n`);
      };
      if (active >= MAX_CONNECTIONS) {
        reply({ stdout: '', stderr: 'drive: busy; try again\n', exit: 75 });
        return;
      }
      active++;
      conn.on('close', () => active--);
      conn.on('error', () => undefined);
      conn.setTimeout(REQUEST_TIMEOUT_MS, () => conn.destroy());
      let buf = '';
      let done = false;
      const finish = (line: string) => {
        if (done) return;
        done = true;
        const argv = parseRequest(line);
        if (!argv) {
          reply({ stdout: '', stderr: 'drive: bad request\n', exit: 2 });
          return;
        }
        handler(argv).then(reply, (e: unknown) => {
          console.error('drive command failed:', e);
          reply({ stdout: '', stderr: 'drive: internal error; nothing was changed by this command\n', exit: 70 });
        });
      };
      conn.setEncoding('utf8');
      conn.on('data', (chunk: string) => {
        if (done) return;
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl >= 0) finish(buf.slice(0, nl));
        else if (buf.length > MAX_REQUEST) {
          done = true;
          reply({ stdout: '', stderr: 'drive: request too large\n', exit: 2 });
        }
      });
      conn.on('end', () => finish(buf));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, () => {
        server.off('error', reject);
        resolve();
      });
    });
    // Only the sandbox's user may connect; the directory itself is read-only to it.
    await fsp.chown(p, owner.uid, owner.gid).catch(() => undefined);
    await fsp.chmod(p, 0o600);
    return new SessionSocket(server, p, conns);
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
    await fsp.rm(this.path, { force: true });
  }
}
