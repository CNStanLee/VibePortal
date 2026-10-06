// The office: agent teams laid out as an org chart. Shared by the server (runs,
// storage) and the UI (the drag-and-drop floor, estimates, budget).
import type { ActivityVerb, LaunchAgent } from './types';

export type OfficeRole = 'lead' | 'manager' | 'engineer' | 'researcher' | 'reviewer' | 'tester' | 'writer';
export const OFFICE_ROLES: OfficeRole[] = ['lead', 'manager', 'engineer', 'researcher', 'reviewer', 'tester', 'writer'];

/** What a desk may do without asking anyone (reading the folder is always allowed). */
export type OfficeGrant = 'edit' | 'run' | 'git' | 'web' | 'tools';
export const OFFICE_GRANTS: OfficeGrant[] = ['edit', 'run', 'git', 'web', 'tools'];
/** How a supervisor answers its people's requests for a permission it holds. */
export type OfficeReview = 'agent' | 'auto' | 'user';
/** a new desk's permissions, by role (then cut down to what its supervisor holds) */
export const ROLE_GRANTS: Record<OfficeRole, OfficeGrant[]> = {
  lead: ['edit', 'run', 'git'],
  manager: ['edit', 'run'],
  engineer: ['edit', 'run'],
  researcher: ['web'],
  reviewer: ['edit', 'run'],
  tester: ['edit', 'run'],
  writer: ['edit'],
};

/** One agent at a desk. `parent` is the node it reports to (its supervisor). */
export interface OfficeNode {
  id: string;
  name: string;
  role: OfficeRole;
  agent: LaunchAgent;
  /** empty = the CLI's default model */
  model?: string;
  effort?: string;
  task: string;
  parent?: string;
  /** what it may do without asking: always a subset of its supervisor's (a supervisor hands permissions down) */
  grants: OfficeGrant[];
  /** supervisors: how requests from below are answered (default: its agent reviews them) */
  review?: OfficeReview;
  /** position on the floor (top-left of the desk) */
  x: number;
  y: number;
}

export interface OfficeTeam {
  id: string;
  name: string;
  goal: string;
  /** the whole task package may spend at most this much (USD, API-equivalent) */
  budget: number;
  /** the folder every agent works in */
  cwd?: string;
  nodes: OfficeNode[];
  updatedAt: string;
}

export type OfficeNodeState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
export type OfficeRunState = 'running' | 'done' | 'failed' | 'stopped' | 'over-budget';

export interface OfficeRunNode {
  state: OfficeNodeState;
  jobId?: string;
  taskId?: string;
  startedAt?: string;
  endedAt?: string;
  /** what the agent handed up to its supervisor (clipped) */
  report?: string;
  /** new tokens so far (input + output + cache writes) and what they cost at list price */
  tokens?: number;
  cost?: number;
  /** what it is doing right now, for the animation */
  verb?: ActivityVerb;
  doing?: string;
  /** when its token count last grew (a desk quiet for long may be stuck) */
  movedAt?: string;
  error?: string;
  /** its permissions now: what it started with plus what was handed down during the run */
  grants?: OfficeGrant[];
  /** permissions it asked for, newest last */
  asks?: OfficeAsk[];
}

/** A desk asked for a permission it did not have; the request goes up the chain. */
export interface OfficeAsk {
  id: string;
  grant: OfficeGrant;
  tool: string;
  summary: string;
  at: string;
  /** the supervisor deciding (absent: the developer) */
  to?: string;
  state: 'reviewing' | 'allowed' | 'denied' | 'user';
  reason?: string;
  decidedAt?: string;
}

export interface OfficeRun {
  id: string;
  teamId: string;
  teamName: string;
  state: OfficeRunState;
  startedAt: string;
  endedAt?: string;
  budget: number;
  spent: number;
  /** spent outside the desks' own sessions (supervisors reviewing requests) */
  extra?: number;
  /** the team as it was when the run started */
  nodes: OfficeNode[];
  progress: Record<string, OfficeRunNode>;
}

export interface OfficeView {
  teams: OfficeTeam[];
  runs: OfficeRun[];
}

// ── permissions ─────────────────────────────────────────────────────────────
const GIT_WRITE = /(^|[;&|(]\s*)git\s+(-C\s+\S+\s+)?(commit|push|merge|rebase|reset|tag|checkout|switch|cherry-pick|revert|pull|am|stash)\b/;

/** Which permission a tool call needs. */
export function grantOf(tool: string, input: unknown): OfficeGrant {
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return 'edit';
  if (/^(Bash|BashOutput|KillShell|KillBash)$/.test(tool)) {
    const cmd = String((input as { command?: unknown })?.command ?? '');
    return GIT_WRITE.test(cmd) ? 'git' : 'run';
  }
  if (/^(WebFetch|WebSearch)$/.test(tool)) return 'web';
  return 'tools';
}

/** Permissions as they can be held: each desk keeps only what its supervisor holds. */
export function cascadeGrants(nodes: OfficeNode[]): OfficeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const held = new Map<string, OfficeGrant[]>();
  const of = (n: OfficeNode, depth = 0): OfficeGrant[] => {
    const known = held.get(n.id);
    if (known) return known;
    const own = OFFICE_GRANTS.filter((g) => n.grants?.includes(g));
    const p = n.parent ? byId.get(n.parent) : undefined;
    const g = p && depth < nodes.length ? own.filter((x) => of(p, depth + 1).includes(x)) : own;
    held.set(n.id, g);
    return g;
  };
  return nodes.map((n) => ({ ...n, grants: of(n) }));
}

// ── the tree ────────────────────────────────────────────────────────────────
export const childrenOf = (nodes: OfficeNode[], id: string) => nodes.filter((n) => n.parent === id);
export const rootsOf = (nodes: OfficeNode[]) => nodes.filter((n) => !n.parent || !nodes.some((m) => m.id === n.parent));

/** Whether making `parent` the supervisor of `child` would close a loop. */
export function wouldCycle(nodes: OfficeNode[], child: string, parent: string): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (let at: string | undefined = parent, hops = 0; at && hops <= nodes.length; at = byId.get(at)?.parent, hops++) if (at === child) return true;
  return false;
}

/** The chain of supervisors above a node, nearest first. */
export function chainOf(nodes: OfficeNode[], id: string): OfficeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: OfficeNode[] = [];
  for (let at = byId.get(byId.get(id)?.parent ?? ''); at && out.length < nodes.length; at = byId.get(at.parent ?? '')) out.push(at);
  return out;
}

export const DESK_W = 168;
export const DESK_H = 150;
const GAP_X = 28;
const GAP_Y = 70;

/** A tidy top-down org chart: leaves side by side, each supervisor centred over its team. */
export function autoLayout(nodes: OfficeNode[]): OfficeNode[] {
  const pos = new Map<string, { x: number; y: number }>();
  let next = 0;
  const place = (n: OfficeNode, depth: number, seen: Set<string>): number => {
    seen.add(n.id);
    const kids = childrenOf(nodes, n.id).filter((k) => !seen.has(k.id));
    const xs = kids.map((k) => place(k, depth + 1, seen));
    const x = xs.length ? (xs[0] + xs[xs.length - 1]) / 2 : next++ * (DESK_W + GAP_X);
    pos.set(n.id, { x, y: depth * (DESK_H + GAP_Y) });
    return x;
  };
  const seen = new Set<string>();
  for (const r of rootsOf(nodes)) place(r, 0, seen);
  // anything stuck in a loop goes on a row of its own
  for (const n of nodes) if (!seen.has(n.id)) place(n, 0, seen);
  return nodes.map((n) => ({ ...n, x: Math.round(pos.get(n.id)!.x + 24), y: Math.round(pos.get(n.id)!.y + 24) }));
}

// ── what it costs ───────────────────────────────────────────────────────────
/** USD per million tokens (input, output, cache read) — rough list prices for estimates. */
interface Rate {
  input: number;
  output: number;
  cacheRead: number;
}
const RATES: [RegExp, Rate][] = [
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/opus/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/sonnet/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/mini|nano/, { input: 0.25, output: 2, cacheRead: 0.025 }],
  [/gpt|codex|^o\d/, { input: 1.25, output: 10, cacheRead: 0.125 }],
];

export const rateOf = (agent: LaunchAgent, model?: string): Rate => {
  const m = (model || (agent === 'claude' ? 'opus' : 'gpt')).toLowerCase();
  return RATES.find(([re]) => re.test(m))?.[1] ?? RATES[agent === 'claude' ? 1 : 5][1];
};

/**
 * USD per "new" token (input + output + cache writes — what the session counter counts).
 * An agent session also re-reads its cached context many times over: about 8 cached
 * tokens for every new one, at the cache-read price.
 */
export const costPerToken = (agent: LaunchAgent, model?: string) => {
  const r = rateOf(agent, model);
  return (0.88 * r.input + 0.12 * r.output + 8 * r.cacheRead) / 1e6;
};

/** New tokens a session tends to use at each effort level. */
export const EFFORT_TOKENS: Record<string, number> = { minimal: 50_000, low: 90_000, medium: 170_000, high: 300_000, xhigh: 480_000, max: 720_000 };
export const DEFAULT_EFFORT = 'medium';

export interface NodeEstimate {
  tokens: number;
  cost: number;
}

/** Rough use of one desk: its effort, how much it is asked, and how many reports it reads. */
export function estimateNode(nodes: OfficeNode[], n: OfficeNode): NodeEstimate {
  const base = EFFORT_TOKENS[n.effort || DEFAULT_EFFORT] ?? EFFORT_TOKENS[DEFAULT_EFFORT];
  const ask = 0.8 + Math.min(0.6, n.task.length / 1500);
  const reports = 1 + 0.15 * childrenOf(nodes, n.id).length;
  const tokens = Math.round(base * ask * reports);
  return { tokens, cost: tokens * costPerToken(n.agent, n.model) };
}

export function estimateTeam(nodes: OfficeNode[]): NodeEstimate & { byNode: Record<string, NodeEstimate> } {
  const byNode: Record<string, NodeEstimate> = {};
  let tokens = 0;
  let cost = 0;
  for (const n of nodes) {
    const e = estimateNode(nodes, n);
    byNode[n.id] = e;
    tokens += e.tokens;
    cost += e.cost;
  }
  return { tokens, cost, byNode };
}

export const CLAUDE_TIERS = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORT_ORDER: Record<LaunchAgent, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
};

/** One step cheaper: lower effort first, then (Claude) a smaller model at medium effort; undefined when it can't go lower. */
function cheaper(n: OfficeNode): OfficeNode | undefined {
  const efforts = EFFORT_ORDER[n.agent];
  const e = efforts.indexOf(n.effort || DEFAULT_EFFORT);
  if (e > 0) return { ...n, effort: efforts[e - 1] };
  if (n.agent !== 'claude') return undefined;
  const m = (n.model || 'opus').toLowerCase();
  const tier = CLAUDE_TIERS.findIndex((t) => m.includes(t));
  if (tier < 0 || tier >= CLAUDE_TIERS.length - 1) return undefined;
  return { ...n, model: CLAUDE_TIERS[tier + 1], effort: 'medium' };
}

/**
 * Brings the estimate under the budget by making the most expensive desks
 * cheaper, one step at a time; supervisors are spared until last.
 */
export function fitToBudget(nodes: OfficeNode[], budget: number): { nodes: OfficeNode[]; fits: boolean } {
  let cur = nodes.map((n) => ({ ...n }));
  for (let guard = 0; guard < 200 && estimateTeam(cur).cost > budget; guard++) {
    const est = estimateTeam(cur).byNode;
    const order = [...cur]
      .filter((n) => cheaper(n))
      .sort((a, b) => est[b.id].cost * (childrenOf(cur, b.id).length ? 0.6 : 1) - est[a.id].cost * (childrenOf(cur, a.id).length ? 0.6 : 1));
    if (!order.length) break;
    const pick = order[0];
    cur = cur.map((n) => (n.id === pick.id ? cheaper(n)! : n));
  }
  return { nodes: cur, fits: estimateTeam(cur).cost <= budget };
}

// ── run prompts ─────────────────────────────────────────────────────────────
const ROLE_LINE: Record<OfficeRole, string> = {
  lead: 'You lead the team: you own the final result.',
  manager: 'You manage part of the team: combine and check what your people did.',
  engineer: 'You build: write and change code.',
  researcher: 'You research: read code and docs and report findings; change files only if asked.',
  reviewer: 'You review: check the work for bugs and gaps, fix small things, report the rest.',
  tester: 'You test: write and run tests, report what passes and what fails.',
  writer: 'You write: docs, changelogs, explanations.',
};

const GRANT_LINE: Record<OfficeGrant, string> = {
  edit: 'edit files',
  run: 'run commands',
  git: 'git commit / push',
  web: 'use the web',
  tools: 'other tools (MCP)',
};

/** What a desk is told: the team goal, who it reports to, its own task, and its people's reports. */
export function nodePrompt(team: { goal: string; nodes: OfficeNode[] }, n: OfficeNode, reports: { node: OfficeNode; state: OfficeNodeState; report?: string }[]): string {
  const chain = chainOf(team.nodes, n.id);
  const who = (m: OfficeNode) => `${m.name} (${m.role}, ${m.agent === 'codex' ? 'Codex' : 'Claude'})`;
  // the whole prompt stays well under the launcher's 20k characters
  const perReport = Math.floor(Math.min(4000, 12_000 / Math.max(1, reports.length)));
  return [
    `You are ${who(n)} in a team of coding agents working in this folder.`,
    team.goal.trim() ? `The team's goal:\n"""${team.goal.trim().slice(0, 3000)}"""` : '',
    ROLE_LINE[n.role],
    chain.length ? `You report to ${chain.map(who).join(', who reports to ')}. ${chain[0].name}'s assignment: "${chain[0].task.trim().slice(0, 600)}"` : 'You are at the top of the team.',
    `Your assignment:\n"""${n.task.trim() || 'Do your part toward the goal.'}"""`,
    n.agent === 'claude'
      ? `Your permissions: ${n.grants.length ? n.grants.map((g) => GRANT_LINE[g]).join('; ') : 'read only'}. For anything else just go ahead and try it: the request goes to ${chain.length ? `your supervisor ${chain[0].name}` : 'the developer'}, who decides. If it is refused, work around it or say so in your report.`
      : `You may ${n.grants.some((g) => g === 'edit' || g === 'run') ? 'change files in this folder and run commands' : 'only read this folder'}.`,
    reports.length
      ? `Your team members have finished. Their reports:\n\n${reports
          .map((r) => `### ${who(r.node)} — ${r.state === 'done' ? 'done' : r.state === 'skipped' ? 'did not run' : 'FAILED'}\n${(r.report ?? '').trim().slice(0, perReport) || '(no report)'}`)
          .join('\n\n')}\n\nBuild on their work; don't redo it.`
      : '',
    'Others in the team work in the same folder at the same time: stay within your assignment.',
    `End with a short report for ${chain[0]?.name ?? 'the developer'}: what you did, which files changed, anything left open.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const newOfficeId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
