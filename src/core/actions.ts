import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './config';
import type { HistoryItem, TaskContext, TaskHistory, TaskInfo } from '../shared/types';
import { describeTool } from './activity';

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
function spawnCli(bin: string, args: string[], opts: SpawnOptions & { cwd: string }) {
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

const HISTORY_MAX = 400;
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((b: any) => b?.type === 'text' || b?.type === 'output_text' || b?.type === 'input_text')
          .map((b: any) => b.text)
          .join('\n')
      : '';
const toolItem = (name: string, input: unknown, cwd: string | undefined, ts?: string): HistoryItem => {
  const d = describeTool(name, input, cwd);
  return { role: 'tool', ts, tool: name, verb: d?.verb ?? 'tool', text: d?.text ?? '' };
};
const finish = (items: HistoryItem[]): TaskHistory => ({ items: items.slice(-HISTORY_MAX), truncated: items.length > HISTORY_MAX });

/** The conversation of a Claude Code transcript: prompts, replies, tool calls and (short) results. */
export function claudeHistory(file: string): TaskHistory {
  const items: HistoryItem[] = [];
  let cwd: string | undefined;
  for (const line of tailLines(file, 12 << 20)) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain || o.isMeta) continue;
    cwd = o.cwd ?? cwd;
    const content = o.message?.content;
    if (o.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_result') {
            const t = textOf(b.content) || (typeof b.content === 'string' ? b.content : '');
            if (t.trim()) items.push({ role: 'result', ts: o.timestamp, text: clip(t.trim(), 600)!, error: !!b.is_error });
          }
        }
      }
      const t = textOf(content).trim();
      if (t && !t.startsWith('<')) items.push({ role: 'user', ts: o.timestamp, text: clip(t, 8000)! });
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && b.text?.trim()) items.push({ role: 'assistant', ts: o.timestamp, text: clip(b.text.trim(), 12000)! });
        else if (b?.type === 'tool_use') items.push(toolItem(b.name, b.input, cwd, o.timestamp));
      }
    }
  }
  return finish(items);
}

/** The conversation of a Codex rollout. */
export function codexHistory(file: string): TaskHistory {
  const items: HistoryItem[] = [];
  let cwd: string | undefined;
  for (const line of tailLines(file, 12 << 20)) {
    if (!line.includes('"event_msg"') && !line.includes('"response_item"') && !line.includes('"session_meta"')) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload ?? {};
    if (o.type === 'session_meta') cwd = p.cwd ?? cwd;
    if (o.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string' && !p.message.startsWith('<')) items.push({ role: 'user', ts: o.timestamp, text: clip(p.message.trim(), 8000)! });
      if (p.type === 'agent_message' && typeof p.message === 'string') items.push({ role: 'assistant', ts: o.timestamp, text: clip(p.message.trim(), 12000)! });
    } else if (o.type === 'response_item') {
      if (p.type === 'function_call') {
        let args: unknown = {};
        try {
          args = JSON.parse(p.arguments ?? '{}');
        } catch {
          /* partial */
        }
        items.push(toolItem(p.name, args, cwd, o.timestamp));
      } else if (p.type === 'custom_tool_call') items.push(toolItem(p.name, p.input, cwd, o.timestamp));
      else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && typeof p.output === 'string' && p.output.trim()) {
        items.push({ role: 'result', ts: o.timestamp, text: clip(p.output.trim(), 600)! });
      }
    }
  }
  // agent_message events and assistant response items repeat each other: keep one
  return finish(items.filter((x, i) => !(x.role === 'assistant' && items.slice(Math.max(0, i - 3), i).some((y) => y.role === 'assistant' && y.text === x.text))));
}

interface Job {
  id: string;
  title: string;
  /** the instruction, on one line */
  detail: string;
  agent: 'claude' | 'codex';
  cwd: string;
  startedAt: number;
  pid?: number;
  running: boolean;
  /** the agent session this run writes to, once known */
  sessionId?: string;
}

/** Where background runs keep their output and the list of runs still going. */
const runsDir = () => path.join(dataDir(), 'runs');
const outFile = (jobId: string) => path.join(runsDir(), `${jobId}.out`);
const recordsFile = () => path.join(runsDir(), 'running.json');

type Bins = { claudeBin: string; codexBin: string };

export interface JobUpdate {
  id: string;
  title: string;
  state: TaskInfo['state'];
  detail?: string;
  cwd?: string;
  agent?: 'claude' | 'codex';
  sessionId?: string;
}

/** Which agent a background run (dispatch task) belongs to. */
const agentOf = (t: TaskInfo): 'claude' | 'codex' => (t.provider === 'openai' ? 'codex' : 'claude');

/** Per-run overrides; empty fields keep the CLI's own defaults. */
export interface RunOptions {
  model?: string;
  effort?: string;
  /**
   * auto (default): Claude Code's auto mode — its safety classifier approves
   * routine actions; whatever still needs approval is asked in VibePortal.
   * ask: everything that needs approval is asked in VibePortal; edits: file
   * edits are allowed, the rest is asked; default: the CLI's own settings
   * decide and anything that would prompt is refused (headless)
   */
  permission?: 'auto' | 'ask' | 'edits' | 'default';
}

/** The MCP tool that routes a run's permission prompts to VibePortal. */
export const PERMISSION_TOOL = 'mcp__vibeportal__approve';

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
  if (['auto', 'ask', 'edits', 'default'].includes(o?.permission)) out.permission = o.permission;
  return out;
}

/** `mcpConfig`: the per-run config file of the permission tool (when VibePortal can answer prompts). */
function claudeRunArgs(o: RunOptions, mcpConfig?: string): string[] {
  const perm = o.permission ?? 'auto';
  return [
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    ...(perm === 'auto' ? ['--permission-mode', 'auto'] : perm === 'edits' ? ['--permission-mode', 'acceptEdits'] : []),
    // prompts go to the VibePortal UI instead of being refused
    ...(perm !== 'default' && mcpConfig ? ['--mcp-config', mcpConfig, '--permission-prompt-tool', PERMISSION_TOOL, '--permission-prompts', 'host'] : []),
  ];
}

function codexRunArgs(o: RunOptions): string[] {
  return [
    ...(o.model ? ['-m', o.model] : []),
    ...(o.effort ? ['-c', `model_reasoning_effort="${o.effort}"`] : []),
    // Codex has no prompt for headless runs: auto / edits give it its folder to work in
    ...(o.permission === 'edits' || (o.permission ?? 'auto') === 'auto' ? ['--sandbox', 'workspace-write'] : []),
  ];
}

const newJobId = () => `dispatch-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export class ActionRunner {
  private jobs = new Map<string, Job>();
  /** writes the permission tool's MCP config for a job and returns its path (set by the server once it listens) */
  permissionConfig?: (jobId: string) => string | undefined;
  /** a run ended (its open permission requests are void) */
  onJobEnd?: (jobId: string) => void;
  private running = 0;

  constructor(private onJobUpdate: (job: JobUpdate) => void) {}

  jobOutput(id: string): string | undefined {
    return this.jobs.has(id) ? readTail(outFile(id), 32_000) : undefined;
  }

  /**
   * Runs live in their own process group and write to a file, so they keep going while
   * VibePortal restarts (an update, a crash, the phone's "restart"). On start, pick the
   * ones still running back up and follow them to the end.
   */
  adopt() {
    let records: Job[] = [];
    try {
      records = JSON.parse(fs.readFileSync(recordsFile(), 'utf8'));
    } catch {
      /* none */
    }
    for (const r of Array.isArray(records) ? records : []) {
      if (!r?.id || this.jobs.has(r.id) || !r.pid || !isOurRun(r.pid, r.agent)) continue;
      const job: Job = { ...r, running: true };
      this.jobs.set(job.id, job);
      this.running++;
      this.onJobUpdate({ id: job.id, title: job.title, state: 'running', detail: job.detail, cwd: job.cwd, agent: job.agent, sessionId: job.sessionId });
      // not our child any more: no exit code, so watch the pid
      const watch = setInterval(() => {
        if (isOurRun(job.pid!, job.agent)) return;
        clearInterval(watch);
        this.finish(job, null);
      }, 2000);
      watch.unref?.();
    }
    this.saveRecords();
  }

  private saveRecords() {
    const list = [...this.jobs.values()].filter((j) => j.running);
    try {
      fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(recordsFile(), JSON.stringify(list), { mode: 0o600 });
    } catch {
      /* best effort: the run itself goes on */
    }
  }

  /** A run ended: `code` is null for one picked up after a restart (its exit code is gone). */
  private finish(job: Job, code: number | null) {
    if (!job.running) return;
    this.running--;
    job.running = false;
    const last = readTail(outFile(job.id), 4000).trim().split('\n').filter(Boolean).pop();
    this.onJobEnd?.(job.id);
    this.onJobUpdate({ id: job.id, title: job.title, state: code === 0 || code === null ? 'done' : 'failed', detail: last ? oneLine(last) : `exit ${code}`, cwd: job.cwd, agent: job.agent, sessionId: job.sessionId });
    this.saveRecords();
    // keep a handful of outputs around
    if (this.jobs.size > 20) {
      const old = this.jobs.keys().next().value!;
      this.jobs.delete(old);
      fs.rm(outFile(old), { force: true }, () => {});
    }
  }

  /** Background jobs (running or recent), so the session each one creates can be folded into it. */
  jobList(): { id: string; agent: 'claude' | 'codex'; cwd: string; startedAt: number; pid?: number; running: boolean; sessionId?: string }[] {
    return [...this.jobs.values()].map(({ id, agent, cwd, startedAt, pid, running, sessionId }) => ({ id, agent, cwd, startedAt, pid, running, sessionId }));
  }

  /** Ends a run (its whole process group): the office stops desks that went over budget. */
  stop(id: string) {
    const j = this.jobs.get(id);
    if (!j?.running || !j.pid) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(j.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
      else process.kill(-j.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  hasRunning(): boolean {
    return this.running > 0;
  }

  setJobSession(id: string, sessionId: string) {
    const j = this.jobs.get(id);
    if (j && !j.sessionId) {
      j.sessionId = sessionId;
      if (j.running) this.saveRecords();
    }
  }

  /** One headless question to a (small) Claude model, outside any repo, nothing persisted; the reply text. */
  async ask(prompt: string, opts: { claudeBin: string; model: string; timeoutMs?: number }): Promise<string> {
    const bin = resolveBin('claude', opts.claudeBin);
    if (!bin) throw httpError(501, 'Claude Code CLI not found — install it or set "claudeBin" in config.json');
    const out = await runCapture(bin, ['-p', '--model', opts.model, '--output-format', 'json', '--no-session-persistence'], prompt, suggestDir(), opts.timeoutMs ?? 240_000);
    try {
      return JSON.parse(out).result ?? out;
    } catch {
      return out;
    }
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
    const jobId = newJobId();
    let bin: string | null;
    let args: string[];
    if (task.kind === 'claude-code' || (task.kind === 'dispatch' && agentOf(task) === 'claude')) {
      bin = resolveBin('claude', bins.claudeBin);
      args = ['-p', '--resume', sessionId, ...(task.alive ? ['--fork-session'] : []), ...claudeRunArgs(run, this.permissionConfig?.(jobId))];
      // resuming writes to the same session; a fork gets a new id we find by pid
    } else if (task.kind === 'codex' || task.kind === 'dispatch') {
      bin = resolveBin('codex', bins.codexBin);
      // `exec resume` takes -m / -c after the subcommand and has no --sandbox (the session keeps its own)
      args = ['exec', 'resume', ...codexRunArgs({ ...run, permission: undefined }), sessionId, '-'];
    } else throw httpError(400, 'This task cannot be continued');
    if (!bin) throw httpError(501, `${task.kind === 'codex' ? 'Codex' : 'Claude Code'} CLI not found`);
    const agent = task.kind === 'codex' || (task.kind === 'dispatch' && agentOf(task) === 'codex') ? 'codex' : 'claude';
    const same = agent === 'codex' || !task.alive ? sessionId : undefined;
    const title = task.title.startsWith('↪ ') || task.title.startsWith('✦ ') ? task.title : `↪ ${task.title}`;
    return this.runJob(jobId, title, agent, bin, args, cwd, prompt, same);
  }

  /** Start a brand-new agent session in a folder (the "new task" dialog). */
  start(req: { agent: 'claude' | 'codex'; cwd: string; prompt: string } & RunOptions, bins: Bins): { jobId: string } {
    let bin: string | null;
    let args: string[];
    let sessionId: string | undefined;
    const jobId = newJobId();
    if (req.agent === 'claude') {
      bin = resolveBin('claude', bins.claudeBin);
      // pick the session id up front, so its transcript can be followed even after the run exits
      sessionId = crypto.randomUUID();
      args = ['-p', '--session-id', sessionId, ...claudeRunArgs(req, this.permissionConfig?.(jobId))];
    } else {
      bin = resolveBin('codex', bins.codexBin);
      args = ['exec', '--skip-git-repo-check', ...codexRunArgs(req), '-'];
    }
    if (!bin) throw httpError(501, `${req.agent === 'codex' ? 'Codex' : 'Claude Code'} CLI not found`);
    return this.runJob(jobId, `✦ ${path.basename(req.cwd)}: ${oneLine(req.prompt).slice(0, 48)}`, req.agent, bin, args, req.cwd, req.prompt, sessionId);
  }

  private runJob(jobId: string, title: string, agent: 'claude' | 'codex', bin: string, args: string[], cwd: string, prompt: string, sessionId?: string): { jobId: string } {
    if (this.running >= 3) throw httpError(429, 'Too many background runs — wait for one to finish');
    const job: Job = { id: jobId, title, detail: oneLine(prompt), agent, cwd, startedAt: Date.now(), running: true, sessionId };
    this.jobs.set(jobId, job);
    this.running++;
    this.onJobUpdate({ id: jobId, title, state: 'running', detail: job.detail, cwd, agent, sessionId });
    // Let the CLI label the session itself (headless runs are "sdk-cli", which VS Code keeps out of
    // its history list — the task's "Open in VS Code" opens it by id instead). Don't pass on an
    // entrypoint inherited from the terminal VibePortal was started in.
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CLAUDECODE: undefined };
    // output goes to a file and the run gets its own process group: when VibePortal
    // stops, the run neither gets a hang-up nor a broken pipe, and adopt() finds it again
    fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
    const out = fs.openSync(outFile(jobId), 'w', 0o600);
    let child;
    try {
      child = spawnCli(bin, args, { cwd, env, stdio: ['pipe', out, out], detached: process.platform !== 'win32', windowsHide: true });
    } finally {
      fs.closeSync(out);
    }
    job.pid = child.pid;
    this.saveRecords();
    // the prompt goes through stdin: no quoting issues, nothing shell-interpreted
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
    child.on('error', (e) => {
      fs.appendFile(outFile(jobId), `${e}\n`, () => {});
    });
    child.on('close', (code) => this.finish(job, code ?? 1));
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

/** The last `maxBytes` of a file, as text ('' when it can't be read). */
function readTail(file: string, maxBytes: number): string {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Whether a run's process is still there (and is still an agent CLI, not a reused pid). */
function isOurRun(pid: number, agent: 'claude' | 'codex'): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    // an exited child of ours that nobody reaped yet is a zombie with an empty command line
    return cmd.includes(agent);
  } catch {
    return false;
  }
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
