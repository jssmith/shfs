// Wiring: the store, the job loop and sessions for one data directory.
import path from 'node:path';
import { openDb } from './store/db.js';
import { Blobs } from './store/blobs.js';
import { Drive } from './store/drive.js';
import { JobRunner } from './ingest/check.js';
import { Sessions } from './sessions/manager.js';
import { NoExecSandbox, type Sandbox } from './sessions/sandbox.js';
import { RunscSandbox } from './sessions/runsc.js';
import { loadImageSettings } from './sessions/image.js';
import { AutoMerge } from './merge/auto.js';
import { driveCommands } from './sessions/drive-command.js';

export interface Config {
  dataDir: string;
  port: number;
  publicUrl: string;
  runsc: string | null; // null: no sandbox (run is refused)
  runscRoot: string;
  rootfs: string;
  sandboxPrefix: string;
  /** Which MCP surface to offer (AGENT_DRIVE_SURFACE, default v3): v0 checkpoint 2's, v1 reworded, v2 shell-first, v3 shell-first minimal. */
  surface: Surface;
  /** A session with no calls for this long has its sandbox destroyed and is marked idle (AGENT_DRIVE_IDLE_AFTER_S). */
  idleAfterMs?: number;
  /** A session with no calls for this long is expired for good (AGENT_DRIVE_EXPIRE_AFTER_S). */
  expireAfterMs?: number;
}

/** Defaults for session expiry: idle after 1 hour, expired after 30 days (the security design's re-approval period). */
export const IDLE_AFTER_MS = 60 * 60 * 1000;
export const EXPIRE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export const SURFACES = ['v0', 'v1', 'v2', 'v3'] as const;
export type Surface = (typeof SURFACES)[number];

export function parseSurface(v: string | undefined): Surface {
  const s = (v ?? 'v3').trim() || 'v3';
  if (!(SURFACES as readonly string[]).includes(s)) throw new Error(`AGENT_DRIVE_SURFACE must be one of ${SURFACES.join(', ')}; got "${s}"`);
  return s as Surface;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.AGENT_DRIVE_DATA ?? './data');
  const port = Number(env.AGENT_DRIVE_PORT ?? 8787);
  return {
    dataDir,
    port,
    publicUrl: (env.AGENT_DRIVE_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    runsc: env.AGENT_DRIVE_RUNSC === 'none' ? null : env.AGENT_DRIVE_RUNSC ?? 'runsc',
    runscRoot: env.AGENT_DRIVE_RUNSC_ROOT ?? path.join(dataDir, 'runsc'),
    rootfs: env.AGENT_DRIVE_ROOTFS ?? path.join(dataDir, 'images', 'default', 'rootfs'),
    sandboxPrefix: env.AGENT_DRIVE_SANDBOX_PREFIX ?? 'ad-',
    surface: parseSurface(env.AGENT_DRIVE_SURFACE),
    idleAfterMs: env.AGENT_DRIVE_IDLE_AFTER_S ? Number(env.AGENT_DRIVE_IDLE_AFTER_S) * 1000 : IDLE_AFTER_MS,
    expireAfterMs: env.AGENT_DRIVE_EXPIRE_AFTER_S ? Number(env.AGENT_DRIVE_EXPIRE_AFTER_S) * 1000 : EXPIRE_AFTER_MS,
  };
}

export interface Context {
  config: Config;
  drive: Drive;
  sessions: Sessions;
  jobs: JobRunner;
  /** The shell surfaces (v2, v3) only: the merge at the end of each changing call. */
  auto?: AutoMerge;
  close(): Promise<void>;
}

export function createContext(config: Config, sandbox?: Sandbox): Context {
  const db = openDb(config.dataDir);
  const drive = new Drive(db, new Blobs(path.join(config.dataDir, 'blobs')));
  const sb: Sandbox =
    sandbox ??
    (config.runsc
      ? new RunscSandbox({ runsc: config.runsc, stateRoot: config.runscRoot, rootfs: config.rootfs, prefix: config.sandboxPrefix, image: loadImageSettings(config.rootfs) })
      : new NoExecSandbox());
  const sessions = new Sessions(drive, path.join(config.dataDir, 'sessions'), sb, config.sandboxPrefix);
  sessions.idleAfterMs = config.idleAfterMs ?? IDLE_AFTER_MS;
  sessions.expireAfterMs = config.expireAfterMs ?? EXPIRE_AFTER_MS;
  // Idle and expired sessions lose their sandboxes (sessions/manager.ts, sweep).
  const sweeper = setInterval(() => void sessions.sweep().catch((e) => console.error('session sweep failed:', e)), Math.max(1000, Math.min(60_000, sessions.idleAfterMs / 4)));
  sweeper.unref();
  const jobs = new JobRunner(drive, (item_id) => sessions.applyVisibility(item_id));
  let auto: AutoMerge | undefined;
  if (config.surface === 'v2' || config.surface === 'v3') {
    auto = new AutoMerge(sessions);
    sessions.driveCommand = driveCommands(sessions, auto);
  }
  return {
    config,
    drive,
    sessions,
    jobs,
    auto,
    async close() {
      clearInterval(sweeper);
      jobs.stop();
      await sessions.destroyAll();
      await sb.releaseRoot?.();
      db.close();
    },
  };
}
