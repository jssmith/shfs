// The merge ignore list: tool caches and build output that tools write into
// /drive. They are not the person's files. Checkpoint and finish never merge
// them (the result lists them as "not merged (tool cache)"), and the session's
// working copy keeps them, so the tools that made them still find them.
//
// One constant, matched per path component:
//   - a directory with one of these names anywhere in the path;
//   - a file with one of these names;
//   - a file with one of these suffixes.
// `dist/` and `build/` are deliberately absent: they are often real content.
export const MERGE_IGNORE = {
  dirs: ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', 'node_modules', '.venv', 'venv', 'target'],
  files: ['.DS_Store'],
  suffixes: ['.pyc', '.pyo'],
} as const;

const DIRS = new Set<string>(MERGE_IGNORE.dirs);
const FILES = new Set<string>(MERGE_IGNORE.files);

/** True if a drive path (no leading slash) is a tool cache that is never merged. */
export function isToolCache(p: string): boolean {
  const parts = p.split('/');
  const name = parts[parts.length - 1] ?? '';
  if (FILES.has(name)) return true;
  if (MERGE_IGNORE.suffixes.some((s) => name.endsWith(s))) return true;
  return parts.slice(0, -1).some((d) => DIRS.has(d));
}

/** Group ignored paths for a short report: `a/__pycache__/ (3 files)`, or the file itself. */
export function summariseIgnored(paths: string[]): string[] {
  const groups = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split('/');
    const i = parts.slice(0, -1).findIndex((d) => DIRS.has(d));
    const key = i >= 0 ? `${parts.slice(0, i + 1).join('/')}/` : p;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].map(([k, n]) => (k.endsWith('/') ? `${k} (${n} file${n === 1 ? '' : 's'})` : k));
}
