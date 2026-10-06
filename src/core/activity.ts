import path from 'node:path';
import type { ActivityItem, ActivityVerb, PlanStep, TaskActivity, TaskPlan } from '../shared/types';

const FEED_MAX = 6;
/** a hook event and the transcript line for the same call land within this window */
const DEDUPE_MS = 120_000;

interface Entry {
  feed: (ActivityItem & { id?: string; at: number })[];
  plan?: PlanStep[];
  /** active forms of plan steps, by step text (Claude's TodoWrite / TaskCreate) */
  active: Map<string, string>;
  /** TaskCreate/TaskUpdate keep an id → step list */
  taskIds: string[];
  title?: string;
}

/**
 * Per-session progress feed for the pet's speech bubble: tool calls, the
 * agent's own words, the user's instructions and the agent's plan. Everything
 * is parsed from data already on disk or pushed by hooks — no model calls.
 * Labels are localized in the UI; only the raw targets / snippets live here.
 */
export class ActivityLog {
  private map = new Map<string, Entry>();
  /** called with absolute paths a tool call wrote (Write / Edit / apply_patch) — used to archive new skills */
  onWrite?: (file: string, cwd?: string) => void;

  private entry(sid: string): Entry {
    let e = this.map.get(sid);
    if (!e) this.map.set(sid, (e = { feed: [], active: new Map(), taskIds: [] }));
    return e;
  }

  tool(sid: string, ts: number, name: string, input: any, opts: { id?: string; cwd?: string } = {}) {
    if (!sid || typeof name !== 'string') return;
    if (this.onWrite) for (const f of writtenFiles(name, input, opts.cwd)) this.onWrite(f, opts.cwd);
    if (this.plan(sid, name, input)) return;
    const d = describeTool(name, input, opts.cwd);
    if (!d) return;
    this.push(sid, { kind: 'tool', ts, verb: d.verb, tool: d.verb === 'tool' ? shortTool(name) : undefined, text: d.text, id: opts.id });
  }

  say(sid: string, ts: number, text: unknown, id?: string) {
    const t = typeof text === 'string' ? firstSentence(text) : '';
    if (t) this.push(sid, { kind: 'say', ts, text: t, id });
  }

  prompt(sid: string, ts: number, text: unknown) {
    const t = typeof text === 'string' ? promptText(text) : '';
    if (t) this.push(sid, { kind: 'prompt', ts, text: t });
  }

  setTitle(sid: string, title: unknown) {
    if (sid && typeof title === 'string' && title.trim()) this.entry(sid).title = clip(title.trim(), 80);
  }

  title(sid: string): string | undefined {
    return this.map.get(sid)?.title;
  }

  get(sid: string): TaskActivity | undefined {
    const e = this.map.get(sid);
    if (!e || (!e.feed.length && !e.plan?.length)) return undefined;
    return {
      feed: e.feed.map(({ id: _id, at: _at, ...item }) => item),
      plan: e.plan?.length ? planSummary(e.plan, e.active) : undefined,
    };
  }

  clear() {
    this.map.clear();
  }

  private push(sid: string, item: Omit<ActivityItem, 'ts'> & { ts: number; id?: string }) {
    const at = Number.isFinite(item.ts) ? item.ts : Date.now();
    const e = this.entry(sid);
    const same = (x: Entry['feed'][number]) =>
      (item.id && x.id === item.id) ||
      (x.kind === item.kind && x.verb === item.verb && x.text === item.text && x.tool === item.tool && Math.abs(x.at - at) < DEDUPE_MS);
    if (e.feed.some(same)) return;
    const row = { ...item, ts: new Date(at).toISOString(), at };
    // hooks and transcripts interleave: keep the feed in time order
    let i = e.feed.length;
    while (i > 0 && e.feed[i - 1].at > at) i--;
    e.feed.splice(i, 0, row);
    if (e.feed.length > FEED_MAX) e.feed.splice(0, e.feed.length - FEED_MAX);
  }

  /** Plan tools update the plan instead of the feed. Returns true when handled. */
  private plan(sid: string, name: string, input: any): boolean {
    if (!input || typeof input !== 'object') return PLAN_TOOLS.has(name);
    const e = () => this.entry(sid);
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      const en = e();
      en.active.clear();
      en.plan = input.todos.map((t: any) => {
        const text = clip(String(t?.content ?? ''), 80);
        if (typeof t?.activeForm === 'string') en.active.set(text, clip(t.activeForm, 80));
        return { text, status: stepStatus(t?.status) };
      });
      return true;
    }
    if (name === 'update_plan' && Array.isArray(input.plan)) {
      e().plan = input.plan.map((t: any) => ({ text: clip(String(t?.step ?? ''), 80), status: stepStatus(t?.status) }));
      return true;
    }
    if (name === 'TaskCreate' && typeof input.subject === 'string') {
      const en = e();
      const text = clip(input.subject, 80);
      en.plan = [...(en.plan ?? []), { text, status: 'pending' }];
      en.taskIds.push(String(en.taskIds.length + 1));
      if (typeof input.activeForm === 'string') en.active.set(text, clip(input.activeForm, 80));
      return true;
    }
    if (name === 'TaskUpdate' && input.taskId !== undefined) {
      const en = e();
      const i = en.taskIds.indexOf(String(input.taskId));
      if (i < 0 || !en.plan?.[i]) return true;
      if (input.status === 'deleted') {
        en.plan.splice(i, 1);
        en.taskIds.splice(i, 1);
        return true;
      }
      const step = en.plan[i];
      if (typeof input.subject === 'string') step.text = clip(input.subject, 80);
      if (typeof input.activeForm === 'string') en.active.set(step.text, clip(input.activeForm, 80));
      if (input.status) step.status = stepStatus(input.status);
      return true;
    }
    return PLAN_TOOLS.has(name);
  }
}

const PLAN_TOOLS = new Set(['TodoWrite', 'TodoRead', 'update_plan', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

function planSummary(steps: PlanStep[], active: Map<string, string>): TaskPlan {
  const cur = steps.find((s) => s.status === 'in_progress') ?? steps.find((s) => s.status === 'pending');
  return {
    done: steps.filter((s) => s.status === 'completed').length,
    total: steps.length,
    current: cur ? (cur.status === 'in_progress' ? active.get(cur.text) ?? cur.text : cur.text) : undefined,
    steps: steps.slice(0, 12),
  };
}

const stepStatus = (s: unknown): PlanStep['status'] => (s === 'completed' || s === 'done' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending');

/** Tool calls that are pure plumbing and would only flood the bubble. */
const NOISE = new Set(['write_stdin', 'list_agents', 'ListAgents', 'TaskOutput', 'BashOutput', 'KillShell', 'TaskStop', 'ExitPlanMode', 'EnterPlanMode', 'ToolSearch']);

/** Maps a Claude Code / Codex tool call to a verb + an untranslated target. Null = not worth showing. */
export function describeTool(name: string, input: any, cwd?: string): { verb: ActivityVerb; text?: string } | null {
  if (NOISE.has(name)) return null;
  const a = input && typeof input === 'object' ? input : {};
  const file = (p: unknown) => (typeof p === 'string' && p ? relPath(p, cwd) : undefined);
  switch (name) {
    case 'Read':
    case 'NotebookRead':
    case 'view_image':
      return { verb: 'read', text: file(a.file_path ?? a.notebook_path ?? a.path) };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'edit', text: file(a.file_path ?? a.notebook_path) };
    case 'Write':
      return { verb: 'write', text: file(a.file_path) };
    case 'apply_patch':
      return patchTarget(typeof input === 'string' ? input : a.input ?? a.patch, cwd);
    case 'Bash':
    case 'PowerShell':
      return { verb: 'run', text: a.description ? oneLine(a.description, 90) : command(a.command) };
    case 'exec_command':
    case 'shell':
    case 'local_shell_call':
    case 'container.exec':
      return { verb: 'run', text: command(Array.isArray(a.command) ? shellArgs(a.command) : a.cmd ?? a.command) };
    case 'exec':
      return codexExec(typeof input === 'string' ? input : '', cwd);
    case 'Grep':
    case 'Glob':
    case 'LS':
      return { verb: 'search', text: oneLine(String(a.pattern ?? a.path ?? ''), 60) || undefined };
    case 'WebSearch':
    case 'web_search_call':
      return { verb: 'web', text: oneLine(String(a.query ?? a.action?.query ?? ''), 80) || undefined };
    case 'WebFetch':
      return { verb: 'web', text: host(a.url) };
    case 'run': // Codex web.run
      return { verb: 'web', text: oneLine(String(a.search_query?.[0]?.q ?? a.open?.[0]?.ref_id ?? ''), 80) || undefined };
    case 'Agent':
    case 'Task':
    case 'spawn_agent':
    case 'followup_task':
    case 'SendMessage':
    case 'send_message':
      return { verb: 'agent', text: oneLine(String(a.description ?? a.task_name ?? a.target ?? a.to ?? a.subagent_type ?? ''), 60) || undefined };
    case 'AskUserQuestion':
    case 'request_user_input':
    case 'request_user_input_async': {
      const q = Array.isArray(a.questions) ? a.questions[0] : undefined;
      return { verb: 'ask', text: oneLine(String(q?.question ?? q?.title ?? ''), 80) || undefined };
    }
    case 'Monitor':
    case 'wait':
    case 'wait_agent':
    case 'sleep':
      return { verb: 'wait', text: oneLine(String(a.description ?? ''), 60) || undefined };
  }
  return { verb: 'tool' };
}

/** Absolute paths a tool call creates or changes. */
export function writtenFiles(name: string, input: any, cwd?: string): string[] {
  const abs = (p: string) => (path.isAbsolute(p) ? p : cwd ? path.resolve(cwd, p) : '');
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const p = input?.file_path ?? input?.notebook_path;
    return typeof p === 'string' && abs(p) ? [abs(p)] : [];
  }
  const patch = name === 'apply_patch' ? (typeof input === 'string' ? input : input?.input ?? input?.patch) : name === 'exec' && typeof input === 'string' && input.includes('*** Begin Patch') ? input : undefined;
  if (typeof patch !== 'string') return [];
  return [...patch.matchAll(/^\*\*\* (?:Update|Add) File: (.+)$/gm)].map((m) => abs(m[1].trim())).filter(Boolean);
}

/** "mcp__claude_ai_Google_Drive__search_files" → "search_files" */
function shortTool(name: string): string {
  const parts = name.split('__');
  return parts.length >= 3 ? parts.slice(2).join('__') : name;
}

function patchTarget(patch: unknown, cwd?: string): { verb: ActivityVerb; text?: string } {
  const files = typeof patch === 'string' ? [...patch.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)] : [];
  if (!files.length) return { verb: 'edit' };
  const verb: ActivityVerb = files.every((m) => m[1] === 'Add') ? 'write' : 'edit';
  const first = relPath(files[0][2].trim(), cwd);
  return { verb, text: files.length > 1 ? `${first} +${files.length - 1}` : first };
}

/** Codex "exec" runs JS that calls tools; pull out the first command it runs. */
function codexExec(code: string, cwd?: string): { verb: ActivityVerb; text?: string } {
  // tools.exec_command({cmd:"…"}) — the key may or may not be quoted
  const cmd = /["']?\bcmd["']?\s*:\s*("(?:[^"\\]|\\.)*")/.exec(code);
  if (cmd) {
    let text: string;
    try {
      text = JSON.parse(cmd[1]);
    } catch {
      text = cmd[1].slice(1, -1);
    }
    return { verb: 'run', text: command(text) };
  }
  if (code.includes('*** Begin Patch')) return patchTarget(code, cwd);
  const tool = /tools\.(\w+)\(/.exec(code)?.[1];
  if (tool && tool !== 'exec_command') return describeTool(tool, {}, cwd) ?? { verb: 'tool' };
  return { verb: 'run' };
}

/** First line of a command — heredoc scripts would otherwise fill the bubble. */
function command(cmd: unknown): string | undefined {
  const first = String(cmd ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return first ? oneLine(first, 90) : undefined;
}

function shellArgs(argv: unknown[]): string {
  const s = argv.map(String);
  // ["bash","-lc","…"] → the script itself
  if (s.length >= 3 && /^(ba|z)?sh$/.test(path.basename(s[0])) && s[1].startsWith('-')) return s.slice(2).join(' ');
  return s.join(' ');
}

function relPath(p: string, cwd?: string): string {
  if (cwd && path.isAbsolute(p)) {
    const r = path.relative(cwd, p);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r;
  }
  return path.isAbsolute(p) ? path.basename(p) : p;
}

function host(url: unknown): string | undefined {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return undefined;
  }
}

/** The first sentence or line of the agent's message, without markdown noise. */
export function firstSentence(text: string): string {
  const line = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s\d.)]+/, '').replace(/[*_`]/g, '').trim())
    .find(Boolean);
  if (!line) return '';
  const m = /^(.{6,}?[。！？]|.{8,}?[.!?](?=\s))/.exec(line);
  return clip(m ? m[1] : line, 120);
}

/** The user's actual request: IDE context wrappers and system tags stripped. */
function promptText(text: string): string {
  let t = text;
  const ide = /## My request for Codex:\s*([\s\S]*)$/.exec(t);
  if (ide) t = ide[1];
  t = t.trim();
  if (!t || t.startsWith('<') || t.startsWith('# Context from my IDE')) return '';
  return oneLine(t, 100);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const oneLine = (s: unknown, n: number) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n);
