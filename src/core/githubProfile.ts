import { execFile } from 'node:child_process';
import { cleanGithub, profileFromGithub, type FarmProfile } from '../shared/farmSocial';

const run = (bin: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(bin, args, { timeout: 5000, windowsHide: true }, (e, out) => resolve(e ? '' : String(out).trim())));

/** This machine's GitHub account: the GitHub CLI's signed-in user, else git's github.user. */
export async function detectGithubLogin(): Promise<string | undefined> {
  return cleanGithub(await run('gh', ['api', 'user', '--jq', '.login'])) ?? cleanGithub(await run('git', ['config', '--global', 'github.user']));
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { 'User-Agent': 'VibePortal', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) throw Object.assign(new Error('no such GitHub user'), { status: 404 });
  if (!r.ok) throw Object.assign(new Error(`GitHub answered ${r.status}`), { status: 502 });
  return r.json();
}

/**
 * One click instead of four fields: the farmer profile from a public GitHub
 * profile (the given name, or the account this machine is signed in to).
 */
export async function importGithubProfile(name?: string): Promise<{ login: string; profile: Partial<FarmProfile> }> {
  const login = cleanGithub(name) ?? (await detectGithubLogin());
  if (!login) throw Object.assign(new Error('enter your GitHub user name'), { status: 400 });
  const base = `https://api.github.com/users/${encodeURIComponent(login)}`;
  const [user, socials] = await Promise.all([getJson(base), getJson(`${base}/social_accounts`).catch(() => [])]);
  return { login, profile: profileFromGithub(user, socials) };
}
