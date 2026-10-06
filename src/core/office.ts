import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_GRANTS, OFFICE_ROLES, ROLE_GRANTS, autoLayout, cascadeGrants, chainOf, childrenOf, costPerToken, grantOf, newOfficeId, nodePrompt, normalizeView, usdToWeeklyPct, wouldCycle, type OfficeAsk, type OfficeGrant, type OfficeNode, type OfficeRole, type OfficeRun, type OfficeTeam, type OfficeView, type WeeklyRate } from '../shared/office';
import type { LaunchAgent, LaunchPermission, TaskInfo } from '../shared/types';
import { summarize, type Decision } from './permissions';
import { dataDir } from './config';

/**
 * The office: agent teams drawn as an org chart, kept in ~/.vibeportal/office.json.
 * A run goes bottom-up: every desk whose people have all reported is started as a
 * background run (Claude or Codex, side by side), and its own report is carried up
 * to its supervisor. Once the run has spent its budget everything is stopped.
 */

const MAX_NODES = 24;
const MAX_RUNS = 12;
const REPORT_MAX = 4000;
const MODEL_RE = /^[\w.:/\-[\]]{0,100}$/;
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const REVIEWS = ['agent', 'auto', 'user'];
/** what one supervisor review costs, roughly (a short headless question) */
const REVIEW_TOKENS = 12_000;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, max) : '');
const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n) + '…' : s);

/** A team from the UI (or the planner), with only sane values and a tree without loops. */
export function cleanTeam(raw: any, now = new Date()): OfficeTeam {
  const nodes: OfficeNode[] = [];
  const ids = new Set<string>();
  for (const n of Array.isArray(raw?.nodes) ? raw.nodes.slice(0, MAX_NODES) : []) {
    const id = str(n?.id, 40).replace(/[^\w-]/g, '') || newOfficeId('n');
    if (ids.has(id)) continue;
    ids.add(id);
    const agent: LaunchAgent = n?.agent === 'codex' ? 'codex' : 'claude';
    const model = str(n?.model, 100).trim();
    const role: OfficeRole = OFFICE_ROLES.includes(n?.role) ? n.role : 'engineer';
    nodes.push({
      id,
      name: str(n?.name, 40).trim() || 'Agent',
      role,
      agent,
      ...(model && MODEL_RE.test(model) ? { model } : {}),
      ...(EFFORTS.includes(n?.effort) && (agent === 'claude' ? n.effort !== 'minimal' : n.effort !== 'max') ? { effort: n.effort } : {}),
      task: str(n?.task, 4000),
      ...(typeof n?.parent === 'string' && n.parent ? { parent: n.parent } : {}),
      grants: Array.isArray(n?.grants) ? OFFICE_GRANTS.filter((g) => n.grants.includes(g)) : ROLE_GRANTS[role],
      ...(REVIEWS.includes(n?.review) ? { review: n.review } : {}),
      ...(Number(n?.difficulty) >= 1 ? { difficulty: Math.min(5, Math.round(Number(n.difficulty))) } : {}),
      ...(str(n?.why, 200).trim() ? { why: str(n.why, 200).trim() } : {}),
      x: Math.round(num(n?.x, 0, 6000, 24)),
      y: Math.round(num(n?.y, 0, 6000, 24)),
    });
  }
  // a supervisor must exist, be someone else, and not sit below the node
  for (const n of nodes) {
    if (!n.parent) continue;
    const p = n.parent;
    delete n.parent;
    if (p !== n.id && ids.has(p) && !wouldCycle(nodes, n.id, p)) n.parent = p;
  }
  const cwd = str(raw?.cwd, 1000);
  return {
    id: str(raw?.id, 40).replace(/[^\w-]/g, '') || newOfficeId('t'),
    name: str(raw?.name, 60).trim() || 'Team',
    goal: str(raw?.goal, 8000),
    budget: Math.round(num(raw?.budget, 0.1, 10_000, 5) * 100) / 100,
    ...(cwd && path.isAbsolute(cwd) ? { cwd } : {}),
    nodes: cascadeGrants(nodes),
    updatedAt: now.toISOString(),
  };
}

// ── goal → org chart ────────────────────────────────────────────────────────
export function planPrompt(goal: string, opts: { budget: number; lang: 'zh' | 'en'; codex: boolean; claude: boolean; rates?: Partial<Record<LaunchAgent, WeeklyRate>> }): string {
  const agents = [opts.claude && 'claude', opts.codex && 'codex'].filter(Boolean).join(' and ') || 'claude';
  const week = (a: LaunchAgent, name: string) => {
    const r = opts.rates?.[a];
    if (!opts[a]) return `${name}: not installed — don't use it.`;
    if (!r) return `${name}: weekly usage unknown.`;
    const one = usdToWeeklyPct(1, a, [], r);
    return [
      `${name}: ${Math.round(r.used)}% of its weekly limit used, ${Math.max(0, 100 - Math.round(r.used))}% left${r.resetsAt ? ` (resets ${r.resetsAt.slice(0, 16).replace('T', ' ')} UTC)` : ''}`,
      ...r.others.map((o) => `${o.label}: ${Math.round(o.used)}% used`),
      one ? `$1 of work ≈ ${one.toFixed(2)}% of the ${name} week` : '',
    ]
      .filter(Boolean)
      .join('; ');
  };
  return [
    "You design a team of coding agents (an org chart) for a developer's goal. The agents run as headless Claude Code or Codex sessions in one repository.",
    `Goal:\n"""${goal.trim()}"""`,
    [
      'Break the goal down top-down into its real parts (e.g. design, implementation per component, verification, documentation / writing). One lead at the top. Give a part its own manager when it has 2 or more workers, so bigger goals become several levels: lead → managers → workers (→ sub-teams if needed). 2-14 agents, at most 4 levels.',
      'Work flows bottom-up: workers run first (in parallel), then each supervisor gets their reports and integrates / reviews. Give every agent a concrete assignment (1-3 sentences) that does not overlap with its siblings.',
      'For every agent judge how hard its part is ("difficulty" 1-5: 1 routine edits / docs, 3 normal feature work, 5 research-level design or the hardest debugging) and choose provider, model and effort from that, from what each model is good at, and from how much weekly usage is left:',
      '- Claude fable: the strongest reasoning, for the very hardest open-ended design (expensive; has its own small weekly limit). opus: architecture, hard algorithms, integration, careful review, leading. sonnet: solid everyday implementation and review. haiku: simple edits, docs, formatting, quick checks.',
      '- Codex (GPT-5 class, leave "model" empty): strong at focused implementation, debugging, scripts, running and fixing tests, terminal work; it draws on the separate ChatGPT weekly limit.',
      '- Effort: low | medium | high | xhigh (claude also max, codex also minimal) — higher for harder parts, low for routine ones.',
      `- Weekly usage now. ${week('claude', 'Claude')} ${week('codex', 'Codex')}`,
      '- Prefer the provider with more weekly room left for work both do well; never plan more than about half of what is left on either; leads and the hardest parts stay on the strongest model available.',
      `Budget for the whole team: about $${opts.budget} at API prices. Rough cost of one agent: opus/high ≈ $2.3, sonnet/medium ≈ $0.7, haiku/medium ≈ $0.3, codex/medium ≈ $0.3. Fit the team to it.`,
      `Agents available: ${agents}. Roles: ${OFFICE_ROLES.join(' | ')}.`,
      'Permissions ("grants"): a subset of edit | run | git | web | tools (edit files, run commands, git commit/push, use the web, other tools). Least privilege: give each agent only what its assignment needs; an agent can only hold what its supervisor holds. Give git only to whoever commits / pushes (usually the lead). Agents can still ask their supervisor for more during the run.',
      `Write names, assignments and "why" in ${opts.lang === 'zh' ? 'Simplified Chinese' : 'English'}. Names are short (a role-like nickname). "why": one short sentence on why this provider / model / effort.`,
      'Reply with ONLY this JSON, no prose, no code fences:',
      '{"name":"team name","nodes":[{"key":"a1","parent":null,"name":"","role":"lead","difficulty":4,"agent":"claude","model":"opus","effort":"high","grants":["edit","run","git"],"task":"","why":""}]}',
      '"parent" is the key of the supervisor (null for the lead).',
    ].join('\n'),
  ].join('\n\n');
}

/** The planner's reply as a laid-out team (unknown parents dropped, at least one desk). */
export function parsePlan(reply: string, goal: string, budget: number, now = new Date()): OfficeTeam {
  let text = reply;
  try {
    text = JSON.parse(reply).result ?? reply;
  } catch {
    /* the bare reply */
  }
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw Object.assign(new Error('the planner did not reply with a team'), { status: 502 });
  let raw: any;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    throw Object.assign(new Error('the planner replied with broken JSON — try again'), { status: 502 });
  }
  const list: any[] = Array.isArray(raw?.nodes) ? raw.nodes.slice(0, MAX_NODES) : [];
  const keyToId = new Map<string, string>();
  list.forEach((n, i) => keyToId.set(String(n?.key ?? i), `n${i + 1}${Math.random().toString(36).slice(2, 6)}`));
  const nodes = list.map((n, i) => ({
    ...n,
    id: keyToId.get(String(n?.key ?? i)),
    parent: n?.parent != null ? keyToId.get(String(n.parent)) : undefined,
    role: OFFICE_ROLES.includes(n?.role) ? (n.role as OfficeRole) : 'engineer',
  }));
  if (!nodes.length) throw Object.assign(new Error('the planner came back with an empty team — try again'), { status: 502 });
  const team = cleanTeam({ name: raw?.name, goal, budget, nodes }, now);
  return { ...team, nodes: autoLayout(team.nodes) };
}

// ── requests up the chain ───────────────────────────────────────────────────
const GRANT_TEXT: Record<OfficeGrant, string> = { edit: 'edit files', run: 'run a command', git: 'commit / push with git', web: 'use the web', tools: 'use a tool' };

/** The question a supervisor answers when one of its people asks for a permission. */
export function reviewPrompt(goal: string, boss: OfficeNode, from: OfficeNode, ask: Pick<OfficeAsk, 'grant' | 'tool' | 'summary'>): string {
  return [
    `You are ${boss.name} (${boss.role}), supervising ${from.name} (${from.role}) in a team of coding agents.`,
    goal.trim() ? `The team's goal:\n"""${goal.trim().slice(0, 2000)}"""` : '',
    `${from.name}'s assignment:\n"""${from.task.trim().slice(0, 1500) || '(none given)'}"""`,
    `${from.name} asks for permission to ${GRANT_TEXT[ask.grant]}: ${ask.tool} — ${ask.summary}`,
    'You hold this permission and may hand it down. Allow it only if their assignment needs it and it is safe: nothing destructive (deleting data, force-pushing, rewriting history), no secrets leaving the machine, nothing outside the project folder unless clearly needed. Once allowed they keep it for the rest of the run.',
    'Reply with ONLY this JSON, no prose: {"allow": true or false, "reason": "one short sentence"}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function parseReview(reply: string): { allow: boolean; reason: string } | undefined {
  let text = reply;
  try {
    text = JSON.parse(reply).result ?? reply;
  } catch {
    /* the bare reply */
  }
  // the verdict is a flat object; the last one that parses wins
  for (const m of [...text.matchAll(/\{[^{}]*\}/g)].reverse()) {
    try {
      const o = JSON.parse(m[0]);
      if (typeof o?.allow === 'boolean') return { allow: o.allow, reason: str(o.reason, 200).trim() };
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

// ── runs ────────────────────────────────────────────────────────────────────
export interface OfficeHost {
  /** starts one desk as a background run; throws with status 429 when too many runs are going */
  start(req: { agent: LaunchAgent; cwd: string; prompt: string; model?: string; effort?: string; permission?: LaunchPermission }): { jobId: string; taskId: string };
  /** one headless question to a model (a supervisor reviewing a request); the reply text */
  judge(prompt: string, model: string): Promise<string>;
  stop(jobId: string): void;
  /** the final words of a finished run */
  report(taskId: string): string | undefined;
  /** jobs ActionRunner knows (after a restart: the ones it picked up again) */
  jobs(): { id: string; running: boolean }[];
  changed(): void;
}

export class Office {
  private file = path.join(dataDir(), 'office.json');
  private data: OfficeView = { teams: [], runs: [] };
  private host?: OfficeHost;
  private checkedLost = false;
  /** starting a desk publishes a snapshot, which observes again: not while we're at it */
  private busy = false;

  constructor() {
    try {
      // teams saved by earlier versions are brought up to date
      const o = normalizeView(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      this.data.teams = o.teams.map((t) => cleanTeam(t, new Date(t.updatedAt || Date.now())));
      this.data.runs = o.runs;
    } catch {
      /* a new office */
    }
  }

  attach(host: OfficeHost) {
    this.host = host;
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
    } catch (e) {
      console.warn('[office] could not save', (e as Error).message);
    }
  }

  view(): OfficeView {
    return this.data;
  }

  /** The runs worth animating: going now or ended in the last half hour (reports clipped). */
  live(now = Date.now()): OfficeRun[] {
    return this.data.runs
      .filter((r) => r.state === 'running' || (r.endedAt && now - Date.parse(r.endedAt) < 30 * 60_000))
      .map((r) => ({ ...r, progress: Object.fromEntries(Object.entries(r.progress).map(([k, v]) => [k, { ...v, report: clip(v.report, 280) }])) }));
  }

  saveTeam(raw: any): OfficeTeam {
    const team = cleanTeam(raw);
    const i = this.data.teams.findIndex((t) => t.id === team.id);
    if (i >= 0) this.data.teams[i] = team;
    else this.data.teams.push(team);
    this.save();
    return team;
  }

  deleteTeam(id: string) {
    if (this.data.runs.some((r) => r.teamId === id && r.state === 'running')) throw Object.assign(new Error('stop the team’s run first'), { status: 409 });
    this.data.teams = this.data.teams.filter((t) => t.id !== id);
    this.data.runs = this.data.runs.filter((r) => r.teamId !== id);
    this.save();
  }

  startRun(teamId: string, cwdOk: (p: string) => boolean): OfficeRun {
    const team = this.data.teams.find((t) => t.id === teamId);
    if (!team) throw Object.assign(new Error('no such team'), { status: 404 });
    if (!team.nodes.length) throw Object.assign(new Error('the team has no one in it yet'), { status: 400 });
    if (!team.cwd || !cwdOk(team.cwd)) throw Object.assign(new Error('pick the folder the team works in first'), { status: 400 });
    if (this.data.runs.some((r) => r.teamId === teamId && r.state === 'running')) throw Object.assign(new Error('this team is already at work'), { status: 409 });
    const run: OfficeRun = {
      id: newOfficeId('r'),
      teamId,
      teamName: team.name,
      state: 'running',
      startedAt: new Date().toISOString(),
      budget: team.budget,
      spent: 0,
      nodes: team.nodes.map((n) => ({ ...n })),
      progress: Object.fromEntries(team.nodes.map((n) => [n.id, { state: 'waiting' as const, grants: [...n.grants] }])),
    };
    this.data.runs = [...this.data.runs, run].slice(-MAX_RUNS);
    this.pump(run);
    this.save();
    this.notify();
    return run;
  }

  stopRun(runId: string, state: 'stopped' | 'over-budget' = 'stopped'): OfficeRun {
    const run = this.data.runs.find((r) => r.id === runId);
    if (!run) throw Object.assign(new Error('no such run'), { status: 404 });
    if (run.state !== 'running') return run;
    for (const p of Object.values(run.progress)) {
      if (p.state === 'running' && p.jobId) this.host?.stop(p.jobId);
      if (p.state === 'waiting' || p.state === 'running') {
        p.state = p.state === 'running' ? 'failed' : 'skipped';
        p.endedAt = new Date().toISOString();
        if (state === 'over-budget') p.error = 'over budget';
      }
    }
    run.state = state;
    run.endedAt = new Date().toISOString();
    this.save();
    this.notify();
    return run;
  }

  /** A background run changed state: if it belongs to a desk, hand its report up and start whoever can go next. */
  onJob(job: { id: string; state: TaskInfo['state']; detail?: string }) {
    for (const run of this.data.runs) {
      if (run.state !== 'running') continue;
      const entry = Object.entries(run.progress).find(([, p]) => p.jobId === job.id);
      if (!entry) continue;
      const p = entry[1];
      if (job.state === 'running' || p.state !== 'running') return;
      p.state = job.state === 'failed' ? 'failed' : 'done';
      p.endedAt = new Date().toISOString();
      p.verb = undefined;
      p.doing = undefined;
      p.report = clip(this.host?.report(p.taskId!) ?? job.detail, REPORT_MAX);
      if (p.state === 'failed') p.error = clip(job.detail, 300);
      this.pump(run);
      this.save();
      this.notify();
      return;
    }
  }

  /** requests being reviewed, per desk and permission (a second ask waits for the same answer) */
  private reviewing = new Map<string, Promise<Decision | undefined>>();

  /**
   * A desk's run wants to use a tool that needs approval. Its own permissions answer
   * first; otherwise the request goes up the chain to the first supervisor that holds
   * the permission, which reviews it (its agent decides, hands it down, or passes it
   * to the developer). Undefined: the developer decides (the normal prompt).
   */
  decide(jobId: string, tool: string, input: unknown): Promise<Decision | undefined> {
    const found = this.findJob(jobId);
    if (!found) return Promise.resolve(undefined);
    const { run, node, p } = found;
    const grant = grantOf(tool, input);
    if (p.grants?.includes(grant)) return Promise.resolve({ behavior: 'allow' });
    const key = `${jobId}:${grant}`;
    const open = this.reviewing.get(key);
    if (open) return open.then((d) => d ?? undefined);
    const ask: OfficeAsk = { id: newOfficeId('a'), grant, tool, summary: summarize(tool, input), at: new Date().toISOString(), state: 'user' };
    p.asks = [...(p.asks ?? []), ask].slice(-8);
    const boss = chainOf(run.nodes, node.id).find((s) => (run.progress[s.id]?.grants ?? s.grants).includes(grant));
    const settle = (d: Decision | undefined, state: OfficeAsk['state'], reason?: string) => {
      Object.assign(ask, { state, ...(reason ? { reason: clip(reason, 200) } : {}), decidedAt: new Date().toISOString() });
      // handed down: it holds the permission for the rest of the run
      if (state === 'allowed') p.grants = [...new Set([...(p.grants ?? []), grant])];
      this.save();
      this.notify();
      return d;
    };
    if (!boss || (boss.review ?? 'agent') === 'user') {
      if (boss) ask.to = boss.id;
      this.save();
      this.notify();
      return Promise.resolve(undefined);
    }
    ask.to = boss.id;
    if (boss.review === 'auto') return Promise.resolve(settle({ behavior: 'allow' }, 'allowed', 'handed down'));
    ask.state = 'reviewing';
    this.save();
    this.notify();
    const model = boss.agent === 'claude' ? boss.model || 'sonnet' : 'haiku';
    const team = this.data.teams.find((t) => t.id === run.teamId);
    const decision = (async (): Promise<Decision | undefined> => {
      let reply: string;
      try {
        reply = await this.host!.judge(reviewPrompt(team?.goal ?? '', boss, node, ask), model);
      } catch {
        // the supervisor could not be asked: the developer decides
        return settle(undefined, 'user', 'review failed');
      } finally {
        run.extra = (run.extra ?? 0) + REVIEW_TOKENS * costPerToken('claude', model);
      }
      const v = parseReview(reply);
      if (!v) return settle(undefined, 'user', 'no clear answer');
      return v.allow
        ? settle({ behavior: 'allow' }, 'allowed', v.reason)
        : settle({ behavior: 'deny', message: `Your supervisor ${boss.name} denied this: ${v.reason || 'not needed for your assignment'}` }, 'denied', v.reason);
    })().finally(() => this.reviewing.delete(key));
    this.reviewing.set(key, decision);
    return decision;
  }

  private findJob(jobId: string) {
    for (const run of this.data.runs) {
      if (run.state !== 'running') continue;
      for (const node of run.nodes) {
        const p = run.progress[node.id];
        if (p?.jobId === jobId) return { run, node, p };
      }
    }
    return undefined;
  }

  /** Every snapshot: follow what the desks are doing and what they spent; stop at the budget. */
  observe(tasks: TaskInfo[]) {
    if (!this.host || this.busy) return;
    this.busy = true;
    try {
      this.observeRuns(this.host, tasks);
    } finally {
      this.busy = false;
    }
  }

  private notify() {
    if (!this.busy) this.host?.changed();
  }

  private observeRuns(host: OfficeHost, tasks: TaskInfo[]) {
    let dirty = false;
    // after a restart: desks whose run did not survive it
    if (!this.checkedLost) {
      this.checkedLost = true;
      const known = new Set(host.jobs().map((j) => j.id));
      for (const run of this.data.runs.filter((r) => r.state === 'running'))
        for (const p of Object.values(run.progress))
          if (p.state === 'running' && p.jobId && !known.has(p.jobId)) {
            p.state = 'failed';
            p.error = 'lost while VibePortal was restarting';
            p.endedAt = new Date().toISOString();
            dirty = true;
          }
    }
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const run of this.data.runs) {
      if (run.state !== 'running') continue;
      let spent = 0;
      for (const n of run.nodes) {
        const p = run.progress[n.id];
        const t = p?.taskId ? byId.get(p.taskId) : undefined;
        if (t?.workload) {
          if (t.workload.sessionTokens !== p.tokens || !p.movedAt) p.movedAt = new Date().toISOString();
          p.tokens = t.workload.sessionTokens;
          p.cost = p.tokens * costPerToken(n.agent, t.workload.model ?? n.model);
        }
        if (p?.state === 'running') {
          const last = t?.activity?.feed?.filter((f) => f.kind === 'tool').pop();
          p.verb = last?.verb;
          p.doing = clip(last?.text, 80);
        }
        spent += p?.cost ?? 0;
      }
      run.spent = Math.round((spent + (run.extra ?? 0)) * 1000) / 1000;
      if (run.spent >= run.budget) this.stopRun(run.id, 'over-budget');
      else if (this.pump(run)) dirty = true;
    }
    if (dirty) this.save();
  }

  /**
   * Starts every waiting desk whose people have all finished; ends the run when no
   * one is left. Whether anything changed.
   */
  private pump(run: OfficeRun): boolean {
    if (run.state !== 'running' || !this.host) return false;
    const team = this.data.teams.find((t) => t.id === run.teamId);
    const wasBusy = this.busy;
    this.busy = true;
    let changed = false;
    try {
      for (const n of run.nodes) {
        const p = run.progress[n.id];
        if (p.state !== 'waiting') continue;
        const kids = childrenOf(run.nodes, n.id);
        if (kids.some((k) => ['waiting', 'running'].includes(run.progress[k.id]?.state))) continue;
        if (!team?.cwd) {
          Object.assign(p, { state: 'failed', error: 'the team has no folder', endedAt: new Date().toISOString() });
          changed = true;
          continue;
        }
        const prompt = nodePrompt({ goal: team.goal, nodes: run.nodes }, n, kids.map((k) => ({ node: k, state: run.progress[k.id].state, report: run.progress[k.id].report })));
        // taken before it starts: the start itself publishes (and its job update comes back here)
        p.state = 'running';
        try {
          // Claude desks ask for everything that needs approval (their permissions answer it here, or the
          // request goes up the chain); Codex can't ask, so its sandbox follows its permissions
          const permission: LaunchPermission = n.agent === 'claude' ? 'ask' : n.grants.some((g) => g === 'edit' || g === 'run') ? 'edits' : 'default';
          const r = this.host.start({ agent: n.agent, cwd: team.cwd, prompt, model: n.model, effort: n.effort, permission });
          Object.assign(p, { jobId: r.jobId, taskId: r.taskId, startedAt: new Date().toISOString() });
          changed = true;
        } catch (e) {
          // too many background runs: try again on the next snapshot
          if ((e as { status?: number }).status === 429) {
            p.state = 'waiting';
            continue;
          }
          Object.assign(p, { state: 'failed', error: clip((e as Error).message, 300), endedAt: new Date().toISOString() });
          changed = true;
        }
      }
      const states = Object.values(run.progress).map((p) => p.state);
      if (!states.some((s) => s === 'waiting' || s === 'running')) {
        run.state = states.some((s) => s === 'failed') ? 'failed' : 'done';
        run.endedAt = new Date().toISOString();
        changed = true;
      }
    } finally {
      this.busy = wasBusy;
    }
    return changed;
  }
}
