// Wiring: the store, the job loop and sessions for one data directory.
import path from 'node:path';
import { openDb } from './store/db.js';
import { Blobs } from './store/blobs.js';
import { Drive } from './store/drive.js';
import { JobRunner } from './ingest/check.js';
import { Sessions } from './sessions/manager.js';
import { NoExecSandbox, type Sandbox } from './sessions/sandbox.js';
import { RunscSandbox } from './sessions/runsc.js';

export interface Config {
  dataDir: string;
  port: number;
  publicUrl: string;
  runsc: string | null; // null: no sandbox (run is refused)
  runscRoot: string;
  rootfs: string;
  sandboxPrefix: string;
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
  };
}

export interface Context {
  config: Config;
  drive: Drive;
  sessions: Sessions;
  jobs: JobRunner;
  close(): Promise<void>;
}

export function createContext(config: Config, sandbox?: Sandbox): Context {
  const db = openDb(config.dataDir);
  const drive = new Drive(db, new Blobs(path.join(config.dataDir, 'blobs')));
  const sb =
    sandbox ??
    (config.runsc
      ? new RunscSandbox({ runsc: config.runsc, stateRoot: config.runscRoot, rootfs: config.rootfs, prefix: config.sandboxPrefix })
      : new NoExecSandbox());
  const sessions = new Sessions(drive, path.join(config.dataDir, 'sessions'), sb, config.sandboxPrefix);
  const jobs = new JobRunner(drive, (item_id) => sessions.applyVisibility(item_id));
  return {
    config,
    drive,
    sessions,
    jobs,
    async close() {
      jobs.stop();
      await sessions.destroyAll();
      db.close();
    },
  };
}
