import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { GitRepositories, GitRepository, LaunchProject } from '../shared/types';

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });

export function normalizeCloneDir(value: string): string {
  const trimmed = value.trim();
  const dir = trimmed === '~' ? os.homedir() : /^~[\\/]/.test(trimmed) ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  if (!dir || dir.includes('\0') || !path.isAbsolute(dir)) throw fail('Clone directory must be an absolute path (or start with ~/).');
  return path.normalize(dir);
}

/** Only GitHub owner/repository names; never command options or arbitrary paths. */
export function repositoryName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(value)) throw fail('Choose a GitHub repository.');
  const name = value.split('/')[1];
  if (name === '.' || name === '..' || name.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw fail('Repository name cannot be used as a local folder.');
  return value;
}

export type RepositoryCommand = (bin: 'gh' | 'git', args: string[], timeout: number, input?: string) => Promise<string>;
const command: RepositoryCommand = (bin, args, timeout, input) => new Promise((resolve, reject) => {
  const child = execFile(bin, args, {
    timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    // never wait for a password: no terminal prompt, no askpass window
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1' },
  }, (error, stdout) => error ? reject(error) : resolve(stdout));
  child.stdin?.on('error', () => {});
  child.stdin?.end(input ?? '');
});

const REPOS_PATH = 'user/repos?sort=pushed&direction=desc&per_page=100';

/** The REST call with a token git already stores for github.com (its credential helper). */
export type GithubApi = (token: string, apiPath: string) => Promise<unknown>;
const githubApi: GithubApi = async (token, apiPath) => {
  const res = await fetch(`https://api.github.com/${apiPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vibeportal' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub API → HTTP ${res.status}`);
  return res.json();
};

/** The password / token git would send to github.com, if a credential helper has one. */
async function gitToken(run: RepositoryCommand): Promise<string> {
  const out = await run('git', ['credential', 'fill'], 10_000, 'protocol=https\nhost=github.com\n\n');
  const token = /^password=(.+)$/m.exec(out)?.[1]?.trim();
  if (!token) throw new Error('no stored GitHub credential');
  return token;
}

/**
 * Names/metadata only, from the GitHub CLI's login, or else from the credential git itself
 * stores for github.com. Credentials never leave the host's own configuration.
 */
export async function recentRepositories(run: RepositoryCommand = command, api: GithubApi = githubApi): Promise<GitRepositories> {
  const sources = [
    async () => JSON.parse(await run('gh', ['api', '--hostname', 'github.com', REPOS_PATH], 20_000)) as unknown,
    async () => api(await gitToken(run), REPOS_PATH),
  ];
  for (const source of sources) {
    try {
      return { repositories: parseRepositories(await source()), state: 'ready' };
    } catch { /* try the next login */ }
  }
  return { repositories: [], state: 'unavailable' };
}

function parseRepositories(raw: unknown): GitRepository[] {
  if (!Array.isArray(raw)) throw new Error('Invalid repository response');
  const repositories: GitRepository[] = [];
  for (const r of raw) {
    if (!r || r.disabled || r.permissions?.pull === false) continue;
    try {
      const fullName = repositoryName(r.full_name);
      repositories.push({ fullName, description: typeof r.description === 'string' ? r.description : '', private: r.private === true, pushedAt: typeof r.pushed_at === 'string' ? r.pushed_at : undefined });
    } catch { /* malformed or unsupported name */ }
  }
  repositories.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
  return repositories;
}

/** Accept HTTPS or SSH origin URLs, but only the canonical GitHub host. */
function githubOrigin(raw: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s?#]+)$/i.exec(raw.trim());
  return match?.[1].replace(/\.git$/i, '').toLowerCase();
}

const cloning = new Set<string>();

export async function cloneRepository(rawName: unknown, cloneDir: string, run: RepositoryCommand = command): Promise<LaunchProject> {
  const fullName = repositoryName(rawName);
  const parent = normalizeCloneDir(cloneDir);
  const destination = path.join(parent, fullName.split('/')[1]);
  const key = process.platform === 'win32' ? destination.toLowerCase() : destination;
  if (cloning.has(key)) throw fail('This repository is already being cloned. Please wait.', 409);
  cloning.add(key);
  try {
    fs.mkdirSync(parent, { recursive: true });
    try {
      // Reserve the directory atomically. Never overwrite an existing folder.
      fs.mkdirSync(destination);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const stat = fs.lstatSync(destination);
      const origin = stat.isDirectory() && !stat.isSymbolicLink() && fs.existsSync(path.join(destination, '.git'))
        ? await run('git', ['-C', destination, 'remote', 'get-url', 'origin'], 5000).catch(() => '') : '';
      if (githubOrigin(origin) !== fullName.toLowerCase()) throw fail('That folder already exists and belongs to a different repository. Choose another clone directory.', 409);
      return project(destination);
    }
    const url = `https://github.com/${fullName}.git`;
    try {
      // git with its own credential helper; the GitHub CLI's login when that fails
      await run('git', ['clone', '--', url, destination], 120_000).catch(() => run('gh', ['repo', 'clone', url, destination], 120_000));
    } catch {
      // Only remove the directory this operation created, so a retry can succeed.
      fs.rmSync(destination, { recursive: true, force: true });
      throw fail('Could not clone the repository. Check that git can sign in to GitHub (a stored HTTPS credential, or gh auth login), repository access and the network on the VibePortal host, then retry.', 502);
    }
    return project(destination);
  } finally {
    cloning.delete(key);
  }
}

function project(dir: string): LaunchProject {
  return { path: dir, name: path.basename(dir), sources: ['clone'], git: true, lastUsed: new Date().toISOString() };
}
