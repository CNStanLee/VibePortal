import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LaunchProject, ProjectUsage } from '../shared/types';

/** VS Code-family editors whose recent folders we can read (user data dir names). */
const EDITORS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor'];

function userDataDirs(): string[] {
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return EDITORS.map((e) => path.join(base, e));
}

/**
 * Local folders known to VS Code: the open windows first, then every folder
 * that has a profile association (VS Code records each folder it opens there).
 * Remote (ssh / container) workspaces are skipped — an agent can't run there.
 */
export function vscodeFolders(): { path: string; open: boolean }[] {
  const out = new Map<string, boolean>();
  for (const dir of userDataDirs()) {
    let storage: any;
    try {
      storage = JSON.parse(fs.readFileSync(path.join(dir, 'User', 'globalStorage', 'storage.json'), 'utf8'));
    } catch {
      continue;
    }
    const ws = storage?.windowsState;
    for (const w of [ws?.lastActiveWindow, ...(ws?.openedWindows ?? [])]) {
      const p = fileUri(w?.folder);
      if (p) out.set(p, true);
    }
    for (const uri of Object.keys(storage?.profileAssociations?.workspaces ?? {})) {
      const p = fileUri(uri);
      if (p && !out.has(p)) out.set(p, false);
    }
  }
  return [...out].map(([p, open]) => ({ path: p, open }));
}

function fileUri(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return undefined;
  try {
    return path.normalize(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

/**
 * Folders a new agent task can start in: repos the agents already worked in
 * (most recent first) merged with VS Code's folders. Only existing directories.
 */
export function launchProjects(usage: { claude: ProjectUsage[]; codex: ProjectUsage[] }): LaunchProject[] {
  const map = new Map<string, LaunchProject>();
  const add = (p: string, src: LaunchProject['sources'][number], lastUsed?: string) => {
    let e = map.get(p);
    if (!e) {
      if (!isDir(p) || p === os.homedir() || p === path.parse(p).root) return;
      map.set(p, (e = { path: p, name: path.basename(p) || p, sources: [], git: fs.existsSync(path.join(p, '.git')) }));
    }
    if (!e.sources.includes(src)) e.sources.push(src);
    if (lastUsed && (!e.lastUsed || lastUsed > e.lastUsed)) e.lastUsed = lastUsed;
  };
  for (const pr of usage.claude) add(pr.key, 'claude', pr.lastActive);
  for (const pr of usage.codex) add(pr.key, 'codex', pr.lastActive);
  for (const f of vscodeFolders()) {
    if (!f.open && isTemp(f.path)) continue;
    // folder mtimes churn (caches, temp files); the git index only moves when someone works in the repo
    add(f.path, f.open ? 'open' : 'vscode', f.open ? new Date().toISOString() : mtime(path.join(f.path, '.git', 'index')));
  }
  return [...map.values()].sort((a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '')).slice(0, 200);
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const isTemp = (p: string) => p === os.tmpdir() || p.startsWith(os.tmpdir() + path.sep) || p === '/tmp' || p.startsWith('/tmp/');

function mtime(p: string): string | undefined {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return undefined;
  }
}
