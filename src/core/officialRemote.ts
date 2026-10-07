import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { httpError, killTree, resolveBin, spawnCli } from './actions';
import type { OfficialRemoteState } from '../shared/types';

const MAX_CLAUDE_ENVS = 5;

interface ClaudeEnv {
  cwd: string;
  name: string;
  child: ChildProcess;
  state: 'connecting' | 'ready' | 'error';
  url?: string;
  error?: string;
  startedAt: string;
}

/**
 * The agents' own remote control, so a conversation can be continued from the
 * Claude / ChatGPT apps or claude.ai/code:
 *  - Claude: `claude remote-control` in a folder → a claude.ai/code environment
 *    link (sessions started there run on this machine, in that folder)
 *  - Codex: the app-server daemon with remote control (`codex remote-control
 *    start`), paired to the ChatGPT app with a short-lived code
 * VibePortal only starts / stops the official CLIs and shows what they print.
 */
export class OfficialRemote {
  private claude = new Map<string, ClaudeEnv>();
  private codex: OfficialRemoteState['codex'] = { state: 'off' };

  constructor(
    private bins: () => { claudeBin: string; codexBin: string; claudeDir: string },
    private onChange: () => void,
  ) {}

  state(): OfficialRemoteState {
    return {
      claude: [...this.claude.values()].map(({ cwd, name, state, url, error, startedAt }) => ({ cwd, name, state, url, error, startedAt })),
      codex: this.codex,
    };
  }

  /** Claude Code's global state file, where folder trust is recorded. */
  private claudeJson(): string {
    const file = path.join(path.dirname(this.bins().claudeDir), '.claude.json');
    return fs.existsSync(file) ? file : path.join(os.homedir(), '.claude.json');
  }

  /** Is `cwd` (or a folder above it) trusted in Claude Code? Remote control refuses untrusted folders. */
  claudeTrusted(cwd: string): boolean {
    try {
      const cfg = JSON.parse(fs.readFileSync(this.claudeJson(), 'utf8'));
      const projects: Record<string, { hasTrustDialogAccepted?: boolean }> = cfg.projects ?? {};
      for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
        if (projectKeys(d).some((k) => projects[k]?.hasTrustDialogAccepted)) return true;
        if (path.dirname(d) === d) return false;
      }
    } catch {
      return false;
    }
  }

  startClaude(cwd: string, name: string) {
    if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw httpError(400, 'cwd must be an existing folder');
    if (this.claude.has(cwd)) return;
    if (this.claude.size >= MAX_CLAUDE_ENVS) throw httpError(429, `at most ${MAX_CLAUDE_ENVS} remote-control folders at a time`);
    if (!this.claudeTrusted(cwd)) {
      throw Object.assign(httpError(409, `Claude Code hasn't trusted this folder yet`), { code: 'untrusted' });
    }
    const bin = resolveBin('claude', this.bins().claudeBin);
    if (!bin) throw httpError(501, 'Claude Code CLI not found');
    // no pre-created empty session: sessions start when you open the link
    // spawnCli: on Windows an npm install of claude is a .cmd shim, which spawn() refuses
    const child = spawnCli(bin, ['remote-control', '--name', name.slice(0, 60), '--no-create-session-in-dir'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      windowsHide: true,
    });
    const env: ClaudeEnv = { cwd, name, child, state: 'connecting', startedAt: new Date().toISOString() };
    this.claude.set(cwd, env);
    const scan = (b: Buffer) => {
      const text = stripAnsi(b.toString('utf8'));
      const url = /https:\/\/claude\.ai\/code\?environment=[\w-]+/.exec(text)?.[0];
      if (url) env.url = url;
      if (/\bReady\b/.test(text) && env.url) env.state = 'ready';
      const err = /Error:\s*(.+)/.exec(text)?.[1];
      if (err) {
        env.state = 'error';
        env.error = err.trim().slice(0, 300);
      }
      this.onChange();
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('error', (e) => {
      env.state = 'error';
      env.error = e.message;
      this.onChange();
    });
    child.on('exit', (code) => {
      if (this.claude.get(cwd) !== env) return;
      if (env.state !== 'error') {
        env.state = 'error';
        env.error = `claude remote-control exited (${code})`;
      }
      this.onChange();
    });
    this.onChange();
  }

  /**
   * What accepting Claude Code's "Do you trust the files in this folder?" prompt
   * does: mark the folder trusted in ~/.claude.json. Claude Code processes rewrite
   * that file too, so it's replaced atomically and checked again afterwards.
   */
  async trustClaudeFolder(cwd: string): Promise<boolean> {
    if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw httpError(400, 'cwd must be an existing folder');
    const file = this.claudeJson();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.claudeTrusted(cwd)) return true;
      let cfg: any = {};
      let mode = 0o600;
      try {
        cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
        mode = fs.statSync(file).mode & 0o777;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw httpError(500, `cannot read ${file}`);
      }
      cfg.projects = cfg.projects ?? {};
      for (const k of projectKeys(cwd)) cfg.projects[k] = { ...(cfg.projects[k] ?? {}), hasTrustDialogAccepted: true };
      const tmp = `${file}.vibeportal-${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode });
      fs.renameSync(tmp, file);
      // a Claude Code process writing at the same moment could undo it: look again
      await new Promise((r) => setTimeout(r, 800));
    }
    return this.claudeTrusted(cwd);
  }

  stopClaude(cwd: string) {
    const env = this.claude.get(cwd);
    if (!env) return;
    this.claude.delete(cwd);
    // SIGINT lets it deregister the environment (Windows has no signals: it is ended outright)
    killTree(env.child, 'SIGINT');
    setTimeout(() => env.child.exitCode === null && killTree(env.child), 5000).unref();
    this.onChange();
  }

  async startCodex() {
    this.codex = { state: 'starting' };
    this.onChange();
    try {
      const r = JSON.parse(lastJsonLine(await this.codexCli(['remote-control', 'start', '--json'], 60_000)));
      const ok = r.status === 'connected' && r.daemon?.remoteControlEnabled !== false;
      this.codex = ok
        ? { state: 'on', serverName: r.serverName, environmentId: r.environmentId }
        : { state: 'error', error: `daemon status: ${r.status ?? 'unknown'}` };
    } catch (e) {
      this.codex = { state: 'error', error: (e as Error).message };
    }
    this.onChange();
  }

  async stopCodex() {
    try {
      await this.codexCli(['remote-control', 'stop', '--json'], 30_000);
    } finally {
      this.codex = { state: 'off' };
      this.onChange();
    }
  }

  /** A short-lived code to type into the ChatGPT app (Codex → connect a computer). */
  async pairCodex(): Promise<{ code: string; expiresAt: string }> {
    if (this.codex.state !== 'on') throw httpError(409, 'start Codex remote control first');
    const r = JSON.parse(lastJsonLine(await this.codexCli(['remote-control', 'pair', '--json'], 30_000)));
    if (typeof r.manualPairingCode !== 'string') throw httpError(502, 'codex did not return a pairing code');
    return { code: r.manualPairingCode, expiresAt: new Date(Number(r.expiresAt) * 1000).toISOString() };
  }

  stopAll() {
    for (const cwd of [...this.claude.keys()]) this.stopClaude(cwd);
    // the Codex daemon is shared with other Codex clients: leave it to `codex remote-control stop`
  }

  private codexCli(args: string[], timeoutMs: number): Promise<string> {
    const bin = resolveBin('codex', this.bins().codexBin);
    if (!bin) return Promise.reject(httpError(501, 'Codex CLI not found'));
    return new Promise((resolve, reject) => {
      const child = spawnCli(bin, args, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        killTree(child);
        reject(httpError(504, `codex ${args.slice(0, 2).join(' ')} timed out`));
      }, timeoutMs);
      child.stdout?.on('data', (b) => (out += b));
      child.stderr?.on('data', (b) => (err += b));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(httpError(500, e.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(httpError(502, (err || out).trim().split('\n').filter(Boolean).pop() || `exit ${code}`));
      });
    });
  }
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '\n');
const lastJsonLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop() ?? '{}';

/**
 * The keys ~/.claude.json may file a folder under. On Windows a folder can be
 * filed as C:\x\y or as C:/x/y: trust is looked up, and written, under both.
 */
function projectKeys(dir: string): string[] {
  return process.platform === 'win32' ? [...new Set([dir, dir.replace(/\\/g, '/')])] : [dir];
}
