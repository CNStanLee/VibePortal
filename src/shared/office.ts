// The office: agent teams laid out as an org chart. Shared by the server (runs,
// storage) and the UI (the drag-and-drop floor, estimates, budget).
import type { ActivityVerb, LaunchAgent, ProviderSnapshot } from './types';

export type OfficeRole = 'lead' | 'manager' | 'engineer' | 'researcher' | 'reviewer' | 'tester' | 'writer';
export const OFFICE_ROLES: OfficeRole[] = ['lead', 'manager', 'engineer', 'researcher', 'reviewer', 'tester', 'writer'];

/** What a desk may do without asking anyone (reading the folder is always allowed). */
export type OfficeGrant = 'edit' | 'run' | 'git' | 'web' | 'tools';
export const OFFICE_GRANTS: OfficeGrant[] = ['edit', 'run', 'git', 'web', 'tools'];
/** How a supervisor answers its people's requests for a permission it holds. */
export type OfficeReview = 'agent' | 'auto' | 'user';
/** a new desk holds everything (the team can be narrowed down with a preset or per desk) */
export const DEFAULT_GRANTS: OfficeGrant[] = [...OFFICE_GRANTS];
/** least privilege, by role (the "by role" preset; then cut down to what its supervisor holds) */
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
  /** how hard its part is, 1 (routine) – 5 (hardest); drives the model it gets */
  difficulty?: number;
  /** why it got this provider / model (from the planner) */
  why?: string;
  /** what it hands up to its supervisor (the lead: to the developer) */
  deliverable?: string;
  /** how its supervisor judges the delivery a success: short, checkable */
  criteria?: string[];
  /** desks that must have finished before it starts (e.g. revising from the reviews comes after the reviews); their reports go to it */
  after?: string[];
  /** position on the floor (top-left of the desk) */
  x: number;
  y: number;
}

export interface OfficeTeam {
  id: string;
  name: string;
  goal: string;
  /** what the team finally hands to the developer, and how it is accepted: settled first, the desks' deliverables are cut from it */
  deliverable?: string;
  criteria?: string[];
  /** the whole task package may spend at most this much (USD, API-equivalent) */
  budget: number;
  /** the folder every agent works in; omitted = create an isolated workspace on first run */
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
  /** its conversation: a later run of it (continued from the task list, queued instructions) is followed here */
  sessionId?: string;
  /** which round of its conversation is going (2 = continued once) */
  round?: number;
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
  /** its own checklist against its criteria (from its report), one per criterion */
  checks?: OfficeCheck[];
  /** its supervisor's verdict on the delivery (from the supervisor's report) */
  accepted?: boolean;
  acceptNote?: string;
  /** how often its supervisor sent the delivery back to be redone (at most MAX_REDOS) */
  redos?: number;
  /** the latest send-back: who, and what is still missing */
  sentBack?: { by: string; note: string };
  /** a supervisor waiting to check these people again once they have redone their part */
  recheck?: string[];
  /** sub-agents it started (Claude's Agent tool): they join the floor below it */
  helpers?: OfficeHelper[];
}

/** A sub-agent a desk handed part of its work to. */
export interface OfficeHelper {
  id: string;
  /** what it was asked to do (the Agent call's description) */
  name: string;
  type?: string;
  state: 'running' | 'done' | 'stopped';
  startedAt: string;
  endedAt?: string;
  verb?: ActivityVerb;
  doing?: string;
}

/** A success criterion as the desk reported it: met, not met, or not said. */
export type OfficeCheck = 'met' | 'unmet' | 'unknown';

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
  deliverable?: string;
  criteria?: string[];
  progress: Record<string, OfficeRunNode>;
  /** a desk's conversation was taken up again after the run ended: from then on the developer drives it, not the budget */
  resumedAt?: string;
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

/** Team-wide permission presets: everyone the same set, or each its role's share ("role"). */
export type OfficePreset = 'all' | 'build' | 'edit' | 'read' | 'role';
export const OFFICE_PRESETS: OfficePreset[] = ['all', 'build', 'edit', 'read', 'role'];
const PRESET_GRANTS: Record<Exclude<OfficePreset, 'role'>, OfficeGrant[]> = { all: DEFAULT_GRANTS, build: ['edit', 'run'], edit: ['edit'], read: [] };

/** Every desk set to the preset (still a desk holds only what its supervisor holds). */
export function applyPreset(nodes: OfficeNode[], preset: OfficePreset): OfficeNode[] {
  return cascadeGrants(nodes.map((n) => ({ ...n, grants: [...(preset === 'role' ? ROLE_GRANTS[n.role] : PRESET_GRANTS[preset])] })));
}

/** The preset the team's permissions match, if any. */
export function presetOf(nodes: OfficeNode[]): OfficePreset | undefined {
  if (!nodes.length) return undefined;
  const same = (a: OfficeGrant[], b: OfficeGrant[]) => a.length === b.length && a.every((g) => b.includes(g));
  return OFFICE_PRESETS.find((p) => applyPreset(nodes, p).every((n, i) => same(n.grants, nodes[i].grants)));
}

/**
 * A team as stored by any version: desks saved before they had permissions get their
 * role's, and nothing is left that would trip the floor up.
 */
export function normalizeNodes(nodes: unknown): OfficeNode[] {
  const list = Array.isArray(nodes) ? (nodes as Partial<OfficeNode>[]) : [];
  return cascadeGrants(
    list
      .filter((n) => n && typeof n.id === 'string')
      .map((n) => {
        const role = OFFICE_ROLES.includes(n.role as OfficeRole) ? (n.role as OfficeRole) : 'engineer';
        return {
          ...n,
          id: n.id!,
          name: typeof n.name === 'string' ? n.name : 'Agent',
          role,
          agent: n.agent === 'codex' ? 'codex' : 'claude',
          task: typeof n.task === 'string' ? n.task : '',
          grants: Array.isArray(n.grants) ? n.grants : DEFAULT_GRANTS,
          criteria: Array.isArray(n.criteria) ? n.criteria.filter((c) => typeof c === 'string') : undefined,
          x: Number.isFinite(n.x) ? n.x! : 24,
          y: Number.isFinite(n.y) ? n.y! : 24,
        } as OfficeNode;
      }),
  );
}

export function normalizeView(v: Partial<OfficeView> | null | undefined): OfficeView {
  return {
    teams: (Array.isArray(v?.teams) ? v.teams : []).map((t) => ({ ...t, nodes: normalizeNodes(t.nodes) })),
    runs: (Array.isArray(v?.runs) ? v.runs : []).map((r) => ({
      ...r,
      nodes: normalizeNodes(r.nodes),
      progress: r.progress ?? {},
    })),
  };
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

/** What a desk waits for before it starts: its people, and the desks it (or a desk above it) goes after. */
export function waitsOn(nodes: OfficeNode[], id: string): string[] {
  const n = nodes.find((x) => x.id === id);
  if (!n) return [];
  const after = [n, ...chainOf(nodes, id)].flatMap((m) => m.after ?? []);
  return [...new Set([...childrenOf(nodes, id).map((k) => k.id), ...after])].filter((x) => x !== id && nodes.some((m) => m.id === x));
}

/** Whether some desks would wait for each other in a ring (and so never start). */
export function waitsInRing(nodes: OfficeNode[]): boolean {
  const seen = new Map<string, 'open' | 'done'>();
  const visit = (id: string): boolean => {
    if (seen.get(id) === 'done') return false;
    if (seen.get(id) === 'open') return true;
    seen.set(id, 'open');
    const ring = waitsOn(nodes, id).some(visit);
    seen.set(id, 'done');
    return ring;
  };
  return nodes.some((n) => visit(n.id));
}

/** Whether `id` may go after `other`: not a desk above or below it (those wait anyway), and no ring of waiting. */
export function canGoAfter(nodes: OfficeNode[], id: string, other: string): boolean {
  if (id === other || !nodes.some((n) => n.id === other)) return false;
  if (chainOf(nodes, id).some((m) => m.id === other) || chainOf(nodes, other).some((m) => m.id === id)) return false;
  return !waitsInRing(nodes.map((n) => (n.id === id ? { ...n, after: [...new Set([...(n.after ?? []), other])] } : n)));
}

/** Only the "goes after" links that can work, in the order given. */
export function cleanAfter(nodes: OfficeNode[]): OfficeNode[] {
  const wanted = new Map(nodes.map((n) => [n.id, n.after ?? []]));
  let cur = nodes.map(({ after: _, ...n }) => n as OfficeNode);
  for (const n of nodes)
    for (const a of wanted.get(n.id)!)
      if (canGoAfter(cur, n.id, a)) cur = cur.map((m) => (m.id === n.id ? { ...m, after: [...(m.after ?? []), a] } : m));
  return cur;
}

export const DESK_W = 168;
export const DESK_H = 150;
const GAP_X = 28;
const GAP_Y = 70;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A tidy top-down tree: leaves side by side, each supervisor centred over its team,
 * every level as tall as its tallest box. Positions are top-left, from (pad, pad).
 */
export function layoutTree(nodes: OfficeNode[], o: { w: number; h: (n: OfficeNode) => number; gapX: number; gapY: number; pad?: number }): Map<string, Box> {
  const at = new Map<string, { x: number; depth: number }>();
  let next = 0;
  const place = (n: OfficeNode, depth: number, seen: Set<string>): number => {
    seen.add(n.id);
    const kids = childrenOf(nodes, n.id).filter((k) => !seen.has(k.id));
    const xs = kids.map((k) => place(k, depth + 1, seen));
    const x = xs.length ? (xs[0] + xs[xs.length - 1]) / 2 : next++ * (o.w + o.gapX);
    at.set(n.id, { x, depth });
    return x;
  };
  const seen = new Set<string>();
  for (const r of rootsOf(nodes)) place(r, 0, seen);
  // anything stuck in a loop goes on a row of its own
  for (const n of nodes) if (!seen.has(n.id)) place(n, 0, seen);
  const rowH: number[] = [];
  for (const n of nodes) {
    const d = at.get(n.id)!.depth;
    rowH[d] = Math.max(rowH[d] ?? 0, o.h(n));
  }
  const rowY: number[] = [];
  for (let d = 0, y = o.pad ?? 24; d < rowH.length; d++) {
    rowY[d] = y;
    y += (rowH[d] ?? 0) + o.gapY;
  }
  const pad = o.pad ?? 24;
  return new Map(nodes.map((n) => {
    const p = at.get(n.id)!;
    return [n.id, { x: Math.round(p.x + pad), y: Math.round(rowY[p.depth]), w: o.w, h: o.h(n) }];
  }));
}

/** A tidy top-down org chart of the desks on the floor. */
export function autoLayout(nodes: OfficeNode[]): OfficeNode[] {
  const pos = layoutTree(nodes, { w: DESK_W, h: () => DESK_H, gapX: GAP_X, gapY: GAP_Y });
  return nodes.map((n) => ({ ...n, x: pos.get(n.id)!.x, y: pos.get(n.id)!.y }));
}

// ── deliveries: what goes up each reporting line, and when it counts ───────
export interface Deliverables {
  nodes: OfficeNode[];
  /** the team's final deliverable and its criteria */
  deliverable?: string;
  criteria?: string[];
}

/** What a desk delivers and how it is accepted: its own, or — at the top of the team — the team's final deliverable. */
export function specOf(team: Deliverables, n: OfficeNode): { deliverable?: string; criteria: string[] } {
  const top = !n.parent || !team.nodes.some((m) => m.id === n.parent);
  const deliverable = n.deliverable?.trim() || (top ? team.deliverable?.trim() : undefined) || undefined;
  const own = (n.criteria ?? []).map((c) => c.trim()).filter(Boolean);
  return { deliverable, criteria: own.length || !top ? own : (team.criteria ?? []).map((c) => c.trim()).filter(Boolean) };
}

/** Desks that don't know yet what they deliver (deliverables come first: a team isn't ready without them). */
export const undelivered = (team: Deliverables) => team.nodes.filter((n) => !specOf(team, n).deliverable);

/**
 * When a desk hands its deliverable up: 1 for the people who start right away, then
 * one more for every level of reports it waits for.
 */
export function stageOf(nodes: OfficeNode[], id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 1;
  seen.add(id);
  const kids = childrenOf(nodes, id);
  return kids.length ? 1 + Math.max(...kids.map((k) => stageOf(nodes, k.id, seen))) : 1;
}

/** Where a desk's delivery stands: not started, being made, handed up, then accepted or rejected by its supervisor. */
export type OfficeDelivery = 'none' | 'waiting' | 'making' | 'delivered' | 'accepted' | 'rejected' | 'failed' | 'skipped';
export function deliveryOf(p?: Pick<OfficeRunNode, 'state' | 'accepted'>): OfficeDelivery {
  if (!p) return 'none';
  if (p.accepted === true) return 'accepted';
  if (p.accepted === false) return 'rejected';
  return p.state === 'done' ? 'delivered' : p.state === 'running' ? 'making' : p.state;
}

const plain = (s: string) => s.toLowerCase().replace(/[*_`~"'“”‘’]/g, '').replace(/\s+/g, ' ').trim();
const CHECK_LINE = /^\s*(?:[-*•+]\s*|\d+[.)]\s*)?\[([^\]]?)\]\s*(.+)$/;

/**
 * A desk's own checklist against its criteria, from the end of its report
 * ("- [x] criterion" / "- [ ] criterion — why not"): by the criterion's words,
 * else by position among the last lines of the checklist.
 */
export function parseChecks(report: string | undefined, criteria: string[] = []): OfficeCheck[] {
  if (!criteria.length) return [];
  const lines = (report ?? '')
    .split('\n')
    .map((l) => CHECK_LINE.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ met: /[xX✓✔☑]/.test(m[1]), text: plain(m[2]) }));
  const tail = lines.slice(-criteria.length);
  const used = new Set<(typeof lines)[number]>();
  return criteria.map((c, i) => {
    const key = plain(c).slice(0, 24);
    let hit = key ? lines.find((l) => !used.has(l) && l.text.startsWith(key)) : undefined;
    if (!hit && tail.length === criteria.length && !used.has(tail[i])) hit = tail[i];
    if (!hit) return 'unknown';
    used.add(hit);
    return hit.met ? 'met' : 'unmet';
  });
}

const VERDICT_LINE = /^\s*(?:[-*•+]\s*)?[*_]*(ACCEPTED|REJECTED|接受|验收通过|退回|不通过)[*_]*\s*[:：]\s*(.+)$/i;

/**
 * A supervisor's verdict on each of its people's deliveries, from its report
 * ("ACCEPTED: name" / "REJECTED: name — what is missing"); people it did not name are absent.
 */
export function parseVerdicts(report: string | undefined, people: Pick<OfficeNode, 'id' | 'name'>[]): Record<string, { accepted: boolean; note?: string }> {
  const out: Record<string, { accepted: boolean; note?: string }> = {};
  // the longest names first, so "UI lead" isn't taken for "UI"
  const byName = [...people].sort((a, b) => b.name.length - a.name.length);
  for (const line of (report ?? '').split('\n')) {
    const m = VERDICT_LINE.exec(line);
    if (!m) continue;
    const rest = m[2].replace(/^[*_`]+/, '').trim();
    const who = byName.find((p) => rest.toLowerCase().startsWith(p.name.toLowerCase()));
    if (!who) continue;
    const note = rest.slice(who.name.length).replace(/^[*_`]*\s*[—–:：,，-]*\s*/, '').trim();
    out[who.id] = { accepted: /^(accepted|接受|验收通过)$/i.test(m[1]), ...(note ? { note: note.slice(0, 600) } : {}) };
  }
  return out;
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
  const weight = (n: OfficeNode) => (childrenOf(cur, n.id).length ? 0.6 : 1) * (1.4 - 0.15 * difficultyOf(n));
  for (let guard = 0; guard < 200 && estimateTeam(cur).cost > budget; guard++) {
    const est = estimateTeam(cur).byNode;
    const order = [...cur]
      .filter((n) => cheaper(n))
      // the costliest first; supervisors and harder parts are spared longer
      .sort((a, b) => weight(b) * est[b.id].cost - weight(a) * est[a.id].cost);
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

/** how often a supervisor may send one delivery back to be redone */
export const MAX_REDOS = 2;

/** A finished desk's report, as passed to whoever builds on it. */
export interface DeskReport {
  node: OfficeNode;
  state: OfficeNodeState;
  report?: string;
  /** times it was sent back already (supervisors see how many are left) */
  redos?: number;
}

const whoOf = (m: OfficeNode) => `${m.name} (${m.role}, ${m.agent === 'codex' ? 'Codex' : 'Claude'})`;
const stateWord = (s: OfficeNodeState) => (s === 'done' ? 'done' : s === 'skipped' ? 'did not run' : 'FAILED');

/** Reports one after another, each with what it was to deliver; `budget`: characters for all of them. */
function reportList(team: Deliverables & { nodes: OfficeNode[] }, reports: DeskReport[], budget: number, withRedos: boolean): string {
  const per = Math.floor(Math.min(4000, budget / Math.max(1, reports.length)));
  return reports
    .map((r) => {
      const x = specOf(team, r.node);
      const spec = [x.deliverable && `Deliverable: ${x.deliverable.slice(0, 300)}`, x.criteria.length && `Criteria: ${x.criteria.map((c) => c.slice(0, 160)).join('; ')}`]
        .filter(Boolean)
        .join('\n')
        .slice(0, Math.max(200, Math.floor(4000 / Math.max(1, reports.length))));
      const left = MAX_REDOS - (r.redos ?? 0);
      const redo = withRedos ? (left > 0 ? ` (can be sent back ${left} more time${left > 1 ? 's' : ''})` : ' (can\'t be sent back again: fix what is still missing yourself)') : '';
      return `### ${whoOf(r.node)} — ${stateWord(r.state)}${redo}\n${spec ? `${spec}\n` : ''}${(r.report ?? '').trim().slice(0, per) || '(no report)'}`;
    })
    .join('\n\n');
}

const VERDICT_ASK = 'In the report give your verdict on each delivery, one line per person: "ACCEPTED: <name>" or "REJECTED: <name> — what is still missing".';
/** supervisors send work back instead of doing it themselves (or handing it to sub-agents nobody budgeted) */
const SEND_BACK_LINE =
  "A REJECTED delivery goes back to that person with your note, to be redone in their own conversation (they keep what they know), and then comes back to you: say exactly what is missing. Don't redo your people's work yourself or hand it to sub-agents (the Agent tool) — send it back; use sub-agents only for small lookups within your own part. Work that has to happen in order (revise, then review again) comes back in that order.";
const checklistLine = (crit: string[]) => (crit.length ? 'Finish the report with your criteria as a checklist, in the order given: "- [x] <criterion>" when met, "- [ ] <criterion> — why not" when not.' : '');

/** What a desk is told: the team goal, who it reports to, its own task, the reports of desks it goes after, and its people's reports. */
export function nodePrompt(team: { goal: string } & Deliverables, n: OfficeNode, reports: DeskReport[], before: DeskReport[] = []): string {
  const chain = chainOf(team.nodes, n.id);
  const mine = specOf(team, n);
  const crit = mine.criteria;
  // the whole prompt stays well under the launcher's 20k characters
  const share = before.length && reports.length ? 6000 : 12_000;
  return [
    `You are ${whoOf(n)} in a team of coding agents working in this folder.`,
    team.goal.trim() ? `The team's goal:\n"""${team.goal.trim().slice(0, 3000)}"""` : '',
    ROLE_LINE[n.role],
    chain.length ? `You report to ${chain.map(whoOf).join(', who reports to ')}. ${chain[0].name}'s assignment: "${chain[0].task.trim().slice(0, 600)}"` : 'You are at the top of the team.',
    mine.deliverable ? `What you hand to ${chain[0]?.name ?? 'the developer'} (your deliverable): ${mine.deliverable.slice(0, 600)}` : '',
    crit.length ? `It counts as delivered when:\n${crit.map((c) => `- ${c}`).join('\n')}` : '',
    chain.length && specOf(team, chain[0]).deliverable ? `It goes into ${chain[0].name}'s deliverable: ${specOf(team, chain[0]).deliverable!.slice(0, 400)}` : '',
    `Your assignment${mine.deliverable ? ' (how you get there)' : ''}:\n"""${n.task.trim() || 'Do your part toward the goal.'}"""`,
    n.agent === 'claude'
      ? `Your permissions: ${n.grants.length ? n.grants.map((g) => GRANT_LINE[g]).join('; ') : 'read only'}. For anything else just go ahead and try it: the request goes to ${chain.length ? `your supervisor ${chain[0].name}` : 'the developer'}, who decides. If it is refused, work around it or say so in your report.`
      : `You may ${n.grants.some((g) => g === 'edit' || g === 'run') ? 'change files in this folder and run commands' : 'only read this folder'}.`,
    before.length ? `You start after these desks have finished; build on what they handed over:\n\n${reportList(team, before, share, false)}` : '',
    reports.length
      ? `Your team members have finished. Their reports:\n\n${reportList(team, reports, share, true)}\n\nBuild on their work; don't redo it. Check each delivery against its criteria (look at the files, run what proves it); fix small gaps yourself.`
      : '',
    reports.length ? SEND_BACK_LINE : '',
    'Others in the team work in the same folder at the same time: stay within your assignment.',
    `End with a short report for ${chain[0]?.name ?? 'the developer'}: what you did, which files changed, anything left open.`,
    reports.length ? VERDICT_ASK : '',
    checklistLine(crit),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A desk's delivery came back: what its supervisor still misses, and what the desks it goes after handed over since. Goes on in its own conversation. */
export function redoPrompt(team: { goal: string } & Deliverables, n: OfficeNode, back: { by: string; note: string }, redo: number, before: DeskReport[] = []): string {
  const chain = chainOf(team.nodes, n.id);
  const crit = specOf(team, n).criteria;
  const kids = childrenOf(team.nodes, n.id).length > 0;
  return [
    `${back.by} sent your delivery back to be redone (${redo} of at most ${MAX_REDOS}). What is still missing:\n"""${back.note.trim().slice(0, 2000) || '(no note: check your delivery against its criteria again)'}"""`,
    before.length ? `The desks you go after have handed over again since:\n\n${reportList(team, before, 8000, false)}` : '',
    "Fix what is missing; build on what you did instead of starting over. Stay within your assignment: others work in the same folder.",
    kids ? `Your own people's work is in your earlier messages. If it is their part that falls short, reject it — ${SEND_BACK_LINE}` : '',
    `End with a short report for ${chain[0]?.name ?? 'the developer'}: what you changed this time, which files, anything still open.`,
    kids ? VERDICT_ASK : '',
    checklistLine(crit),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The people a supervisor sent back have redone their part: their new reports, to check again in its own conversation. */
export function recheckPrompt(team: { goal: string } & Deliverables, n: OfficeNode, reports: DeskReport[]): string {
  const chain = chainOf(team.nodes, n.id);
  const crit = specOf(team, n).criteria;
  return [
    `The deliveries you sent back have been redone. The new reports:\n\n${reportList(team, reports, 12_000, true)}`,
    'Check each against its criteria again (look at the files, run what proves it), then finish your own deliverable on top of them.',
    SEND_BACK_LINE,
    `End with your report for ${chain[0]?.name ?? 'the developer'}: what you did, which files changed, anything left open.`,
    `${VERDICT_ASK} Give it for everyone in your team, not only the ones just redone.`,
    checklistLine(crit),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const newOfficeId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ── reasoning effort: one ladder for both agents ────────────────────────────
export const EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** the rungs each agent has (Claude: low … max, Codex: minimal … xhigh) */
export const effortSpan = (agent: LaunchAgent): [number, number] => (agent === 'claude' ? [1, 5] : [0, 4]);
export const effortLevel = (n: Pick<OfficeNode, 'effort'>) => Math.max(0, EFFORT_LADDER.indexOf(n.effort || DEFAULT_EFFORT));
export function withEffortLevel<T extends Pick<OfficeNode, 'agent' | 'effort'>>(n: T, level: number): T {
  const [lo, hi] = effortSpan(n.agent);
  return { ...n, effort: EFFORT_LADDER[Math.min(hi, Math.max(lo, Math.round(level)))] };
}
/** The whole package's effort: the desks' average rung. */
export const teamEffort = (nodes: OfficeNode[]) => (nodes.length ? nodes.reduce((s, n) => s + effortLevel(n), 0) / nodes.length : 2);
/** Everyone one or more rungs up or down (each within what its agent has). */
export const shiftEfforts = (nodes: OfficeNode[], delta: number) => nodes.map((n) => withEffortLevel(n, effortLevel(n) + delta));

// ── weekly limits ───────────────────────────────────────────────────────────
export interface WeeklyRate {
  /** % of the weekly limit used so far */
  used: number;
  resetsAt?: string;
  /** new tokens (input + output + cache writes) per 1% of the weekly limit, from this week's use */
  tokensPerPct?: number;
  /** this week's tokens the conversion rests on (few = rough: use from other machines / the cloud isn't in the logs) */
  sample: number;
  /** other weekly limits of the provider (e.g. Fable's own), for the planner */
  others: { label: string; used: number }[];
}

const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Each agent's weekly limit and how many tokens 1% of it is worth — this week's
 * tokens over this week's percentage (rough: whole days, and only the use this
 * machine's logs know about).
 */
export function weeklyRates(providers: ProviderSnapshot[]): Partial<Record<LaunchAgent, WeeklyRate>> {
  const out: Partial<Record<LaunchAgent, WeeklyRate>> = {};
  for (const p of providers) {
    const weekly = p.quotas.filter((q) => q.kind === 'weekly');
    const main = weekly.find((q) => !/scoped|reserve/i.test(q.id)) ?? weekly[0];
    if (!main) continue;
    let tokensPerPct: number | undefined;
    let sample = 0;
    if (main.resetsAt && main.percent >= 1) {
      const from = localDay(Date.parse(main.resetsAt) - (main.windowMinutes ?? 7 * 1440) * 60_000);
      sample = p.daily.filter((d) => d.date >= from).reduce((s, d) => s + d.totals.input + d.totals.output + d.totals.cacheWrite, 0);
      if (sample > 0) tokensPerPct = sample / main.percent;
    }
    out[p.provider === 'claude' ? 'claude' : 'codex'] = {
      used: main.percent,
      resetsAt: main.resetsAt,
      tokensPerPct,
      sample,
      others: weekly.filter((q) => q !== main).map((q) => ({ label: q.label, used: q.percent })),
    };
  }
  return out;
}

/** A conversion from little of this week's use (under ~1.5M tokens, or under 5%) is only a rough guide. */
export const roughRate = (r?: WeeklyRate) => !!r?.tokensPerPct && (r.sample < 1_500_000 || r.used < 5);

/** Tokens and cost of the team's estimate, per agent. */
export function estimateByAgent(nodes: OfficeNode[]): Record<LaunchAgent, NodeEstimate> {
  const out: Record<LaunchAgent, NodeEstimate> = { claude: { tokens: 0, cost: 0 }, codex: { tokens: 0, cost: 0 } };
  for (const n of nodes) {
    const e = estimateNode(nodes, n);
    out[n.agent].tokens += e.tokens;
    out[n.agent].cost += e.cost;
  }
  return out;
}

/** What `usd` buys of an agent's weekly limit, at the team's mix of models for it (or a typical one). */
export function usdToWeeklyPct(usd: number, agent: LaunchAgent, nodes: OfficeNode[], rate?: WeeklyRate): number | undefined {
  if (!rate?.tokensPerPct) return undefined;
  const mine = estimateByAgent(nodes)[agent];
  const perToken = mine.tokens ? mine.cost / mine.tokens : costPerToken(agent, agent === 'claude' ? 'sonnet' : undefined);
  return usd / perToken / rate.tokensPerPct;
}
/** The other way round: the dollars that are `pct` of an agent's weekly limit. */
export function weeklyPctToUsd(pct: number, agent: LaunchAgent, nodes: OfficeNode[], rate?: WeeklyRate): number | undefined {
  const one = usdToWeeklyPct(1, agent, nodes, rate);
  return one ? pct / one : undefined;
}

// ── who gets which model ────────────────────────────────────────────────────
export const ROLE_DIFFICULTY: Record<OfficeRole, number> = { lead: 4, manager: 3, engineer: 3, researcher: 3, reviewer: 3, tester: 2, writer: 2 };
export const difficultyOf = (n: Pick<OfficeNode, 'difficulty' | 'role'>) => Math.min(5, Math.max(1, Math.round(n.difficulty ?? ROLE_DIFFICULTY[n.role])));
const CLAUDE_BY_DIFFICULTY: Record<number, [string, string]> = { 1: ['haiku', 'low'], 2: ['haiku', 'medium'], 3: ['sonnet', 'medium'], 4: ['opus', 'high'], 5: ['opus', 'xhigh'] };
const CODEX_BY_DIFFICULTY: Record<number, string> = { 1: 'low', 2: 'low', 3: 'medium', 4: 'high', 5: 'xhigh' };
/** roles Codex does well (focused implementation, tests, terminal work, and a second model family's look at the work) */
const CODEX_ROLES: OfficeRole[] = ['engineer', 'tester', 'reviewer', 'researcher'];

/**
 * Gives every desk a provider, model and effort from how hard its part is, what each
 * model is good at and how much of each weekly limit is left: the hardest parts and the
 * people in charge get the strong Claude models; implementation, tests, reviews and
 * research go to Codex — all of them when it has more room left this week, a share in
 * line with its room otherwise; a provider that is nearly used up is avoided.
 */
export function assignModels(nodes: OfficeNode[], ctx: { rates: Partial<Record<LaunchAgent, WeeklyRate>>; available: Record<LaunchAgent, boolean> }): OfficeNode[] {
  const room = (a: LaunchAgent) => (ctx.available[a] ? 100 - (ctx.rates[a]?.used ?? 0) : -1);
  const leads = (n: OfficeNode) => childrenOf(nodes, n.id).length > 0;
  // the desks Codex could take, its strongest suits (implementation, tests) and easier parts first
  const suited = nodes
    .filter((n) => CODEX_ROLES.includes(n.role) && !leads(n) && difficultyOf(n) <= 4)
    .sort((a, b) => Number(CODEX_ROLES.indexOf(a.role) > 1) - Number(CODEX_ROLES.indexOf(b.role) > 1) || difficultyOf(a) - difficultyOf(b));
  const [claude, codex] = [room('claude'), room('codex')];
  const share = codex < 15 ? 0 : codex >= claude ? suited.length : Math.round((suited.length * codex) / (codex + Math.max(0, claude)));
  const toCodex = new Set(suited.slice(0, share).map((n) => n.id));
  return nodes.map((n) => {
    const d = difficultyOf(n);
    let agent: LaunchAgent = 'claude';
    if (claude < 0) agent = 'codex';
    else if (codex >= 0 && (toCodex.has(n.id) || (claude < 15 && !(leads(n) && d >= 4)))) agent = 'codex';
    if (agent === 'codex') return { ...n, agent, model: undefined, effort: CODEX_BY_DIFFICULTY[d], difficulty: d };
    const [model, effort] = CLAUDE_BY_DIFFICULTY[d];
    return { ...n, agent, model, effort, difficulty: d };
  });
}
