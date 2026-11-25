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
  /** Which MCP surface to offer (AGENT_DRIVE_SURFACE): v0 today's, v1 reworded, v2 shell-first, v3 shell-first minimal. */
  surface: Surface;
}

export const SURFACES = ['v0', 'v1', 'v2', 'v3'] as const;
export type Surface = (typeof SURFACES)[number];

export function parseSurface(v: string | undefined): Surface {
  const s = (v ?? 'v0').trim() || 'v0';
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
  };
}

export interface Context {
  config: Config;
  drive: Drive;
  sessions: Sessions;
  jobs: JobRunner;
  /** The shell surfaces (v2, v3) only: automatic merge after changing calls. */
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
      // Changes still waiting for their automatic merge are merged, not dropped.
      await auto?.flushAll();
      jobs.stop();
      await sessions.destroyAll();
      await sb.releaseRoot?.();
      db.close();
    },
  };
}
