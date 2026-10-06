import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './config';
import type { TaskContext, TaskInfo } from '../shared/types';

/**
 * "What next?" actions on a task: read its last exchange, ask Claude for a
 * suggested next step, continue the session headlessly with an instruction,
 * or open the repo. Every command is spawned without a shell, with the prompt
 * passed as a single argv entry.
 */

const binCache = new Map<string, string | null>();

export function resolveBin(name: 'claude' | 'codex' | 'code' | 'cloudflared' | 'ssh' | 'ngrok' | 'tailscale', override = ''): string | null {
  if (override && fs.existsSync(override)) return override;
  if (binCache.has(name)) return binCache.get(name)!;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'AppData', 'Roaming', 'npm'),
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin',
  ];
  let found: string | null = null;
  outer: for (const d of dirs) {
    if (!d) continue;
    for (const e of exts) {
      const p = path.join(d, name + e);
      try {
        if (fs.statSync(p).isFile()) {
          found = p;
          break outer;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  // GUI launches often miss the user's shell PATH (nvm, volta…): ask a login shell
  if (!found && process.platform !== 'win32') {
    const r = spawnSync(process.env.SHELL || '/bin/bash', ['-lc', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 });
    const p = r.stdout?.trim().split('\n').pop();
    if (p && fs.existsSync(p)) found = p;
  }
  binCache.set(name, found);
  return found;
}

/** Windows .cmd shims can't be spawned directly; route them through cmd. Only fixed flags, ids and paths reach this command line — prompts go via stdin. */
function spawnCli(bin: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const quoted = [bin, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return spawn(bin, args, opts);
}

/** Last user prompt and assistant reply of a Claude Code transcript. */
export function claudeContext(file: string): TaskContext {
  const lines = tailLines(file, 4 << 20);
  let lastPrompt: string | undefined;
  let lastReply: string | undefined;
  for (let i = lines.length - 1; i >= 0 && (!lastPrompt || !lastReply); i--) {
    let o: any;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = o?.message?.content;
    if (!lastReply && o.type === 'assistant' && Array.isArray(content)) {
      const text = content.filter((b: any) => b?.type === 'text' && b.text).map((b: any) => b.text).join('\n');
      if (text.trim()) lastReply = text.trim();
    }
    if (!lastPrompt && o.type === 'user' && !o.isMeta) {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
      if (text.trim() && !text.startsWith('<')) lastPrompt = text.trim();
    }
  }
  return { lastPrompt: clip(lastPrompt, 2000), lastReply: clip(lastReply, 4000) };
}

/** Last user message and agent message of a Codex rollout. */
export function codexContext(file: string): TaskContext {
  const lines = tailLines(file, 4 << 20);
  let lastPrompt: string | undefined;
  let lastReply: string | undefined;
  for (let i = lines.length - 1; i >= 0 && (!lastPrompt || !lastReply); i--) {
    if (!lines[i].includes('"event_msg"')) continue;
    let o: any;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const p = o?.payload;
    if (!lastReply && p?.type === 'agent_message' && typeof p.message === 'string') lastReply = p.message;
    if (!lastPrompt && p?.type === 'user_message' && typeof p.message === 'string') lastPrompt = p.message;
  }
  return { lastPrompt: clip(lastPrompt, 2000), lastReply: clip(lastReply, 4000) };
}

interface Job {
  id: string;
  output: string;
  agent: 'claude' | 'codex';
  cwd: string;
  startedAt: number;
  pid?: number;
  running: boolean;
  /** the agent session this run writes to, once known */
  sessionId?: string;
}

type Bins = { claudeBin: string; codexBin: string };

/** Per-run overrides; empty fields keep the CLI's own defaults. */
export interface RunOptions {
  model?: string;
  effort?: string;
  /** 'edits' lets the agent change files in its folder without asking */
  permission?: 'default' | 'edits';
}

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const MODEL_RE = /^[\w.:/\-[\]]{1,100}$/;

/** Validates user-supplied run options (they end up on a command line). */
export function cleanRunOptions(agent: 'claude' | 'codex', o: any): RunOptions {
  const out: RunOptions = {};
  if (typeof o?.model === 'string' && o.model.trim()) {
    if (!MODEL_RE.test(o.model.trim())) throw httpError(400, 'invalid model name');
    out.model = o.model.trim();
  }
  if (typeof o?.effort === 'string' && o.effort) {
    if (!(agent === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS).includes(o.effort)) throw httpError(400, 'invalid effort level');
    out.effort = o.effort;
  }
  if (o?.permission === 'edits') out.permission = 'edits';
  return out;
}

function claudeRunArgs(o: RunOptions): string[] {
  return [
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    ...(o.permission === 'edits' ? ['--permission-mode', 'acceptEdits'] : []),
  ];
}

function codexRunArgs(o: RunOptions): string[] {
  return [
    ...(o.model ? ['-m', o.model] : []),
    ...(o.effort ? ['-c', `model_reasoning_effort="${o.effort}"`] : []),
    ...(o.permission === 'edits' ? ['--sandbox', 'workspace-write'] : []),
  ];
}

export class ActionRunner {
  private jobs = new Map<string, Job>();
  private running = 0;

  constructor(private onJobUpdate: (job: { id: string; title: string; state: TaskInfo['state']; detail?: string; cwd?: string }) => void) {}

  jobOutput(id: string): string | undefined {
    return this.jobs.get(id)?.output;
  }

  /** Background jobs (running or recent), so the session each one creates can be folded into it. */
  jobList(): { id: string; agent: 'claude' | 'codex'; cwd: string; startedAt: number; pid?: number; running: boolean; sessionId?: string }[] {
    return [...this.jobs.values()].map(({ id, agent, cwd, startedAt, pid, running, sessionId }) => ({ id, agent, cwd, startedAt, pid, running, sessionId }));
  }

  hasRunning(): boolean {
    return this.running > 0;
  }

  setJobSession(id: string, sessionId: string) {
    const j = this.jobs.get(id);
    if (j && !j.sessionId) j.sessionId = sessionId;
  }

  /** Ask Claude (headless, no tools, nothing persisted) for up to three next steps. */
  async suggest(task: TaskInfo, ctx: TaskContext, opts: { claudeBin: string; model: string; lang: 'zh' | 'en' }): Promise<string[]> {
    const bin = resolveBin('claude', opts.claudeBin);
    if (!bin) throw httpError(501, 'Claude Code CLI not found — install it or set "claudeBin" in config.json');
    const prompt = [
      `You help a developer decide the next step for a coding-agent task.`,
      `Task: ${task.title} (${task.kind}, state: ${task.state})${task.cwd ? ` in ${task.cwd}` : ''}.`,
      ctx.lastPrompt ? `The developer's last instruction:\n"""${ctx.lastPrompt}"""` : '',
      ctx.lastReply ? `The agent's last reply:\n"""${ctx.lastReply}"""` : '',
      `Reply with ONLY a JSON array of 1-3 short, concrete next instructions the developer could send to the agent` +
        ` (each under 120 characters), written in ${opts.lang === 'zh' ? 'Simplified Chinese' : 'English'}. No prose, no code fences.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    // run outside any repo so the suggestion can't touch files, and so its hook events are recognisable
    const cwd = suggestDir();
    const out = await runCapture(bin, ['-p', '--model', opts.model, '--output-format', 'json', '--no-session-persistence'], prompt, cwd, 120_000);
    let text = out;
    try {
      text = JSON.parse(out).result ?? out;
    } catch {
      /* plain text */
    }
    const m = /\[[\s\S]*\]/.exec(text);
    if (m) {
      try {
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string').slice(0, 3);
      } catch {
        /* fall through */
      }
    }
    return text
      .split('\n')
      .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 3);
  }

  /**
   * Continue a session headlessly with a new instruction. A Claude session whose
   * interactive process is still open is forked instead of resumed, so the two
   * never write to the same transcript.
   */
  continue(task: TaskInfo, sessionId: string, prompt: string, bins: Bins, run: RunOptions = {}): { jobId: string } {
    const cwd = task.cwd && fs.existsSync(task.cwd) ? task.cwd : os.homedir();
    let bin: string | null;
    let args: string[];
    if (task.kind === 'claude-code') {
      bin = resolveBin('claude', bins.claudeBin);
      args = ['-p', '--resume', sessionId, ...(task.alive ? ['--fork-session'] : []), ...claudeRunArgs(run)];
      // resuming writes to the same session; a fork gets a new id we find by pid
    } else if (task.kind === 'codex') {
      bin = resolveBin('codex', bins.codexBin);
      // `exec resume` takes -m / -c after the subcommand and has no --sandbox (the session keeps its own)
      args = ['exec', 'resume', ...codexRunArgs({ ...run, permission: undefined }), sessionId, '-'];
    } else throw httpError(400, 'This task cannot be continued');
    if (!bin) throw httpError(501, `${task.kind === 'codex' ? 'Codex' : 'Claude Code'} CLI not found`);
    const same = task.kind === 'codex' || !task.alive ? sessionId : undefined;
    return this.runJob(`↪ ${task.title}`, task.kind === 'codex' ? 'codex' : 'claude', bin, args, cwd, prompt, same);
  }

  /** Start a brand-new agent session in a folder (the "new task" dialog). */
  start(req: { agent: 'claude' | 'codex'; cwd: string; prompt: string } & RunOptions, bins: Bins): { jobId: string } {
    let bin: string | null;
    let args: string[];
    let sessionId: string | undefined;
    if (req.agent === 'claude') {
      bin = resolveBin('claude', bins.claudeBin);
      // pick the session id up front, so its transcript can be followed even after the run exits
      sessionId = crypto.randomUUID();
      args = ['-p', '--session-id', sessionId, ...claudeRunArgs(req)];
    } else {
      bin = resolveBin('codex', bins.codexBin);
      args = ['exec', '--skip-git-repo-check', ...codexRunArgs(req), '-'];
    }
    if (!bin) throw httpError(501, `${req.agent === 'codex' ? 'Codex' : 'Claude Code'} CLI not found`);
    return this.runJob(`✦ ${path.basename(req.cwd)}: ${oneLine(req.prompt).slice(0, 48)}`, req.agent, bin, args, req.cwd, req.prompt, sessionId);
  }

  private runJob(title: string, agent: 'claude' | 'codex', bin: string, args: string[], cwd: string, prompt: string, sessionId?: string): { jobId: string } {
    if (this.running >= 3) throw httpError(429, 'Too many background runs — wait for one to finish');
    const jobId = `dispatch-${Date.now().toString(36)}`;
    const job: Job = { id: jobId, output: '', agent, cwd, startedAt: Date.now(), running: true, sessionId };
    this.jobs.set(jobId, job);
    this.running++;
    this.onJobUpdate({ id: jobId, title, state: 'running', detail: oneLine(prompt), cwd });
    const child = spawnCli(bin, args, { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
    job.pid = child.pid;
    // the prompt goes through stdin: no quoting issues, nothing shell-interpreted
    child.stdin?.end(prompt);
    const collect = (b: Buffer) => {
      job.output = (job.output + b.toString('utf8')).slice(-32_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (e) => {
      collect(Buffer.from(String(e)));
    });
    child.on('close', (code) => {
      this.running--;
      job.running = false;
      const last = job.output.trim().split('\n').filter(Boolean).pop();
      this.onJobUpdate({ id: jobId, title, state: code === 0 ? 'done' : 'failed', detail: last ? oneLine(last) : `exit ${code}`, cwd });
      // keep a handful of outputs around
      if (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value!);
    });
    return { jobId };
  }

  /**
   * Opens a vscode:// link through the OS URL handler, which hands it to the
   * running VS Code window (`code --open-url` isn't a supported flag everywhere —
   * the snap build ignores it). No shell is involved on any platform.
   */
  openUrl(url: string) {
    if (!/^vscode:\/\/[\w.-]+\//.test(url)) throw httpError(400, 'not a vscode:// link');
    const [cmd, args] =
      process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args, { cwd: os.homedir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: 'ignore', detached: true });
    child.on('error', () => {
      // no OS handler (minimal desktop): fall back to the VS Code CLI
      const code = resolveBin('code');
      if (code) spawnCli(code, ['--open-url', url], { cwd: os.homedir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }).on('error', () => {});
    });
    child.unref();
  }

  open(task: TaskInfo) {
    this.openPath(task.cwd);
  }

  /** Opens a folder in VS Code when available, else the system file manager. */
  openPath(target: string | undefined) {
    const dir = target && fs.existsSync(target) ? target : undefined;
    if (!dir) throw httpError(404, 'Working directory not found');
    const code = resolveBin('code');
    const [cmd, args] = code
      ? [code, [dir]]
      : process.platform === 'win32'
        ? ['explorer.exe', [dir]]
        : process.platform === 'darwin'
          ? ['open', [dir]]
          : ['xdg-open', [dir]];
    const child = spawnCli(cmd as string, args as string[], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
    child.on('error', () => {});
    child.unref();
  }
}

export function suggestDir(): string {
  const d = path.join(dataDir(), 'suggest');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function runCapture(bin: string, args: string[], stdin: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(bin, args, { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
    child.stdin?.end(stdin);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(httpError(504, 'Suggestion timed out'));
    }, timeoutMs);
    child.stdout?.on('data', (b) => (out += b));
    child.stderr?.on('data', (b) => (err += b));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(httpError(500, String(e)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(httpError(502, (err || out).trim().split('\n').pop() || `exit ${code}`));
    });
  });
}

function tailLines(file: string, maxBytes: number): string[] {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // partial first line
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n) + '…' : s);
const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 119) + '…' : t;
};
