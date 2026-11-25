// The shell-first surfaces (v2, v3). Not built yet.
import type { Kit } from './common.js';

export function registerShell(_kit: Kit, surface: 'v2' | 'v3'): void {
  throw new Error(`surface ${surface} is not built yet`);
}
