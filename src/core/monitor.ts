import { TaskArchive } from './archive';
import { SkillGraphStore } from './skillGraph';
import { ResetTracker } from './resets';
import { ModelCatalog, catalogEfforts, type AgentCatalog } from './models';
import { Office, parsePlan, planPrompt } from './office';
import { subagentsOf } from './subagents';
import { weeklyRates } from '../shared/office';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { ClaudeLocalCollector } from './collectors/claudeLocal';
import { ClaudeSubscriptionCollector } from './collectors/claudeSubscription';
import { CodexLocalCollector } from './collectors/codexLocal';
import { ChatGptUsageCollector } from './collectors/chatgptUsage';
import { ApiCostCollector } from './collectors/apiCosts';
import { TaskTracker } from './tasks';
import { QuotaHistory } from './forecast';
import { PriceBook } from './prices';
import { RemoteHosts } from './remote';
import fs from 'node:fs';
import { ActionRunner, CLAUDE_EFFORTS, CODEX_EFFORTS, claudeContext, claudeHistory, codexHistory, cleanRunOptions, codexContext, httpError, resolveBin, suggestDir, type RunOptions } from './actions';
import { isDir, launchProjects } from './projects';
import { ResourceMonitor } from './resources';
import { SkillStore } from './skills';
import { OfficialRemote } from './officialRemote';
import { PermissionBroker } from './permissions';
import { dataDir, type Config } from './config';
import type { LaunchOptions, TaskHistory, PetState, Provider, ProviderSnapshot, QuotaWindow, Snapshot, TaskContext, TaskInfo } from '../shared/types';

export interface Notice {
  title: string;
  body: string;
  level: 'info' | 'warning' | 'critical';
  taskId?: string;
}

const FINISHED_TTL = 30 * 60_000;
/** drafts office teams */
const PLAN_MODEL = 'sonnet';

/**
 * Owns all collectors, polls them on their own cadences and publishes a
 * merged Snapshot. Emits:
 *   'snapshot' (Snapshot) — after every poll
 *   'notice'   (Notice)   — task finished / needs attention, quota crossed a threshold
 */
export class Monitor extends EventEmitter {
  readonly tasks = new TaskTracker();
  readonly remotes = new RemoteHosts();
  readonly actions: ActionRunner;
  readonly resources = new ResourceMonitor();
  readonly archive = new TaskArchive();
  readonly skillGraph = new SkillGraphStore();
  /** agent teams; their desks run as background runs */
  readonly office = new Office();
  /** permission prompts of background Claude runs, answered in the UI */
  readonly permissions = new PermissionBroker((p) => {
    if (p) {
      const t = this.findTask(`dispatch:${p.jobId}`);
      this.emit('notice', { title: `🔐 ${t?.title ?? 'Background run'}`, body: `${p.tool}: ${p.summary}`, level: 'warning', taskId: `dispatch:${p.jobId}` } satisfies Notice);
    }
    this.poke();
  });
  readonly official = new OfficialRemote(() => ({ claudeBin: this.cfg.claudeBin, codexBin: this.cfg.codexBin, claudeDir: this.cfg.claudeDir }), () => this.poke());
  readonly skills = new SkillStore(() => ({ claudeDir: this.cfg.claudeDir, codexDir: this.cfg.codexDir, projects: this.skillProjects() }));
  private claudeLocal = new ClaudeLocalCollector();
  private claudeSub = new ClaudeSubscriptionCollector();
  private codex = new CodexLocalCollector();
  private chatgpt = new ChatGptUsageCollector();
  private costs = new ApiCostCollector();
  readonly resets = new ResetTracker(path.join(dataDir(), 'reset-calendar.json'));
  private models = new ModelCatalog(path.join(dataDir(), 'models.json'));
  private history = new QuotaHistory(path.join(dataDir(), 'quota-history.json'));
  private prices: PriceBook;
  private pricesKey = '';

  private timers: NodeJS.Timeout[] = [];
  private snapshot?: Snapshot;
  private prevTaskStates = new Map<string, TaskInfo['state']>();
  private finishedAt = new Map<string, number>();
  private prevSeverity = new Map<string, QuotaWindow['severity']>();
  private lastSubFetch = 0;
  private lastCostFetch = 0;
  private ticking = false;
  private dispatchProvider = new Map<string, Provider>();
  /** instructions sent to a background run while it was busy, keyed by job id */
  private followUps = new Map<string, { prompts: string[]; run: RunOptions }>();

  constructor(private cfg: Config) {
    super();
    this.prices = new PriceBook(cfg.prices);
    this.pricesKey = JSON.stringify(cfg.prices ?? {});
    this.tasks.ignoreCwd = suggestDir();
    this.tasks.activity = this.claudeLocal.activity;
    // skills that tasks write get archived into the library
    this.claudeLocal.activity.onWrite = (f, cwd) => this.skills.noteWrite(f, { cwd, agent: 'claude' });
    this.codex.activity.onWrite = (f, cwd) => this.skills.noteWrite(f, { cwd, agent: 'codex' });
    this.actions = new ActionRunner((job) => {
      this.tasks.upsertDispatch(job, this.dispatchProvider.get(job.id));
      this.office.onJob(job);
      if (job.state !== 'running' && this.followUps.has(job.id)) this.runFollowUp(job.id);
      this.poke();
      // a finished run: read the tail of its transcript now rather than at the next poll
      if (job.state !== 'running') void this.tick();
    });
    this.loadFollowUps();
    this.office.attach({
      start: (req) => this.startTask(req),
      resume: (req) => {
        const task = this.findTask(req.taskId);
        if (!task) throw httpError(404, 'the desk’s conversation is gone');
        const r = this.continueTask(task, req.prompt, cleanRunOptions(req.agent, req));
        // still busy (not a finished desk's run): no queued instructions for a desk
        if (r.queued) throw httpError(409, 'the desk’s run is still going');
        return { jobId: r.jobId, taskId: `dispatch:${r.jobId}` };
      },
      stop: (jobId) => this.actions.stop(jobId),
      report: (taskId) => {
        const t = this.findTask(taskId);
        if (!t) return undefined;
        const ctx = this.taskContext(t);
        return ctx.lastReply ?? ctx.output?.trim();
      },
      jobs: () => this.actions.jobList(),
      helpers: (sid, since) => {
        const file = this.claudeLocal.transcripts.get(sid);
        return file ? subagentsOf(file, since) : [];
      },
      changed: () => this.poke(),
      judge: (prompt, model) => this.actions.ask(prompt, { claudeBin: this.cfg.claudeBin, model, timeoutMs: 120_000 }),
    });
    this.permissions.gate = (jobId, tool, input) => this.office.decide(jobId, tool, input);
    // runs that kept going while VibePortal was down (they live in their own process group)
    this.actions.adopt();
  }
  get config() {
    return this.cfg;
  }

  setConfig(cfg: Config) {
    const pollChanged = cfg.pollSeconds !== this.cfg.pollSeconds;
    const keysChanged = cfg.anthropicAdminKey !== this.cfg.anthropicAdminKey || cfg.openaiAdminKey !== this.cfg.openaiAdminKey;
    const pk = JSON.stringify(cfg.prices ?? {});
    if (pk !== this.pricesKey) {
      this.prices = new PriceBook(cfg.prices);
      this.pricesKey = pk;
    }
    this.cfg = cfg;
    if (keysChanged) this.lastCostFetch = 0;
    if (pollChanged && this.timers.length) {
      this.stop();
      this.start();
    } else {
      void this.tick();
    }
  }

  start() {
    void this.tick(true);
    this.timers.push(setInterval(() => void this.tick(), this.cfg.pollSeconds * 1000));
    // while a background run is going, follow its transcript closely (the scan is incremental)
    this.timers.push(setInterval(() => this.actions.hasRunning() && void this.tick(), 4000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.history.save(true);
    this.resets.save(true);
  }

  current(): Snapshot | undefined {
    return this.snapshot;
  }

  /** Forces a refresh of remote sources too (rate-limited to once per 30s). */
  async refresh() {
    if (Date.now() - this.lastSubFetch > 30_000) this.lastSubFetch = 0;
    if (Date.now() - this.lastCostFetch > 30_000) this.lastCostFetch = 0;
    await this.tick();
  }

  /** Re-publish immediately, e.g. after a hook event — no log scanning. */
  poke() {
    if (!this.snapshot) return;
    this.publish();
  }

  // ── task actions ──────────────────────────────────────────────────────────
  findTask(id: string): TaskInfo | undefined {
    return this.snapshot?.tasks.find((t) => t.id === id);
  }

  taskContext(task: TaskInfo): TaskContext {
    if (task.kind === 'dispatch') {
      // the run's own session has the whole exchange; the CLI output is the fallback
      const output = this.actions.jobOutput(task.id.replace(/^dispatch:/, ''));
      const sid = task.sessionId;
      const file = sid ? (task.provider === 'openai' ? this.codex.sessionFile(sid) : this.claudeLocal.transcripts.get(sid)) : undefined;
      const ctx = file ? (task.provider === 'openai' ? codexContext(file) : claudeContext(file)) : {};
      return { ...ctx, output: ctx.lastReply ? undefined : output };
    }
    const sid = sessionIdOf(task);
    if (task.kind === 'claude-code' && sid) {
      const file = this.claudeLocal.transcripts.get(sid);
      return file ? claudeContext(file) : {};
    }
    if (task.kind === 'codex' && sid) {
      const file = this.codex.sessionFile(sid);
      return file ? codexContext(file) : {};
    }
    return {};
  }

  /** The whole conversation (most recent part) of a task, for its history view. */
  taskHistory(task: TaskInfo): TaskHistory {
    const sid = task.kind === 'dispatch' ? task.sessionId : sessionIdOf(task);
    const codex = task.kind === 'codex' || (task.kind === 'dispatch' && task.provider === 'openai');
    const file = sid ? (codex ? this.codex.sessionFile(sid) : this.claudeLocal.transcripts.get(sid)) : undefined;
    if (file) return codex ? codexHistory(file) : claudeHistory(file);
    // a run whose session isn't known (yet): its CLI output is the history
    const out = task.kind === 'dispatch' ? this.actions.jobOutput(task.id.replace(/^dispatch:/, '')) : undefined;
    return { items: out ? [{ role: 'assistant', text: out.trim() }] : [], truncated: false };
  }

  /** The skills organized into a knowledge map by the small "suggest" model. */
  organizeSkills() {
    const model = this.cfg.suggestModel;
    return this.skillGraph.organize(this.skills.list(true), (prompt) => this.actions.ask(prompt, { claudeBin: this.cfg.claudeBin, model }), model);
  }

  /** A team for a goal, broken down top-down by the small model, laid out and saved. */
  async planTeam(body: any) {
    const goal = typeof body?.goal === 'string' ? body.goal.trim().slice(0, 8000) : '';
    if (!goal) throw httpError(400, 'describe the goal first');
    const budget = Number(body?.budget) > 0 ? Math.min(10_000, Number(body.budget)) : 5;
    const lang = body?.lang === 'zh' ? 'zh' : 'en';
    const c = this.cfg;
    const rates = weeklyRates(this.snapshot?.providers ?? []);
    // the final deliverable, when the developer settled it first
    const fixed = {
      deliverable: typeof body?.deliverable === 'string' ? body.deliverable.trim().slice(0, 600) : undefined,
      criteria: Array.isArray(body?.criteria) ? body.criteria.filter((x: unknown) => typeof x === 'string').slice(0, 6) : undefined,
    };
    const prompt = planPrompt(goal, { budget, lang, rates, ...fixed, claude: !!resolveBin('claude', c.claudeBin), codex: !!resolveBin('codex', c.codexBin) });
    // weighing difficulty, strengths and weekly room is judgment: a mid-size model by default, or the one picked
    const model = typeof body?.model === 'string' && /^[\w.:/\-[\]]{1,100}$/.test(body.model) ? body.model : PLAN_MODEL;
    const effort = CLAUDE_EFFORTS.includes(body?.effort) ? (body.effort as string) : undefined;
    const slow = effort === 'xhigh' || effort === 'max' || /fable|opus/.test(model);
    const team = parsePlan(await this.actions.ask(prompt, { claudeBin: c.claudeBin, model, effort, timeoutMs: slow ? 600_000 : 300_000 }), goal, budget, new Date(), fixed);
    return this.office.saveTeam({ ...team, ...(typeof body?.id === 'string' ? { id: body.id } : {}), cwd: body?.cwd });
  }

  async suggest(task: TaskInfo, lang: 'zh' | 'en') {
    return this.actions.suggest(task, this.taskContext(task), { claudeBin: this.cfg.claudeBin, model: this.cfg.suggestModel, lang });
  }

  continueTask(task: TaskInfo, prompt: string, run: RunOptions = {}): { jobId: string; queued?: boolean } {
    // a background run that is still busy: the instruction waits for its turn to end, in the same conversation
    const jobId = task.kind === 'dispatch' ? task.id.replace(/^dispatch:/, '') : '';
    if (jobId && this.actions.jobList().some((j) => j.id === jobId && j.running)) {
      const q = this.followUps.get(jobId) ?? { prompts: [], run: {} };
      if (q.prompts.length >= 10) throw httpError(429, 'Too many queued instructions');
      q.prompts.push(prompt);
      q.run = { ...q.run, ...run };
      this.followUps.set(jobId, q);
      this.saveFollowUps();
      this.poke();
      return { jobId, queued: true };
    }
    const sid = task.kind === 'dispatch' ? task.sessionId : sessionIdOf(task);
    if (!sid || !task.canContinue) throw httpError(400, 'This task cannot be continued');
    const r = this.actions.continue(task, sid, prompt, { claudeBin: this.cfg.claudeBin, codexBin: this.cfg.codexBin }, this.keepSessionModel(task, sid, run));
    if (task.provider) this.dispatchProvider.set(r.jobId, task.provider);
    // the new run carries the conversation on: a background run it resumes makes way for it (one
    // conversation, one task), and cards / lists that showed the old task follow it
    if (task.kind === 'dispatch') this.tasks.handOver(task.id, r.jobId);
    else this.tasks.linkContinued(r.jobId, task.id);
    this.poke();
    return r;
  }

  /**
   * `codex exec resume` without -m switches to config.toml's model, which may be one this
   * Codex CLI or account can't use (the turn then fails at once). Unless another model is
   * picked, go on with the model and effort that last answered in this conversation.
   */
  private keepSessionModel(task: TaskInfo, sid: string, run: RunOptions): RunOptions {
    if (task.kind !== 'codex' && task.provider !== 'openai') return run;
    const w = this.codex.sessionStats.workload(sid);
    const model = w?.model && w.model !== 'unknown' ? w.model : undefined;
    return { ...run, model: run.model ?? model, effort: run.effort ?? w?.effort };
  }

  /** Takes back the instructions queued on a busy background run. */
  clearQueue(task: TaskInfo) {
    this.followUps.delete(task.id.replace(/^dispatch:/, ''));
    this.saveFollowUps();
    this.poke();
  }

  // queued instructions outlive a restart, like the runs they wait for
  private followUpsFile() {
    return path.join(dataDir(), 'runs', 'queued.json');
  }
  private loadFollowUps() {
    try {
      const o = JSON.parse(fs.readFileSync(this.followUpsFile(), 'utf8'));
      for (const [k, v] of Object.entries(o ?? {}) as [string, { prompts?: unknown; run?: RunOptions }][]) {
        if (Array.isArray(v?.prompts) && v.prompts.length) this.followUps.set(k, { prompts: v.prompts.filter((x) => typeof x === 'string'), run: v.run ?? {} });
      }
    } catch {
      /* nothing queued */
    }
  }
  private saveFollowUps() {
    try {
      fs.mkdirSync(path.dirname(this.followUpsFile()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.followUpsFile(), JSON.stringify(Object.fromEntries(this.followUps)), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  /** A busy run finished its turn: its queued instructions go on in the same conversation, as one new run. */
  private runFollowUp(jobId: string) {
    const q = this.followUps.get(jobId)!;
    this.followUps.delete(jobId);
    this.saveFollowUps();
    const task = this.tasks.customTasks().find((t) => t.id === `dispatch:${jobId}`);
    try {
      if (!task?.sessionId) throw new Error('its conversation could not be found');
      const r = this.actions.continue({ ...task, alive: false }, task.sessionId, q.prompts.join('\n\n'), { claudeBin: this.cfg.claudeBin, codexBin: this.cfg.codexBin }, this.keepSessionModel(task, task.sessionId, q.run));
      if (task.provider) this.dispatchProvider.set(r.jobId, task.provider);
      this.tasks.handOver(task.id, r.jobId);
    } catch (e) {
      this.emit('notice', { title: `⚠ ${task?.title ?? 'Background run'}`, body: `Queued instruction not sent: ${(e as Error).message}`, level: 'warning', taskId: `dispatch:${jobId}` } satisfies Notice);
    }
  }

  /**
   * Hands an instruction to the conversation where it lives, in VS Code: the
   * Claude extension opens that session with the prompt filled in; the Codex
   * extension opens the thread (it can't prefill — the UI copies the text).
   */
  openInVscode(task: TaskInfo, prompt?: string) {
    const sid = task.kind === 'dispatch' ? task.sessionId : sessionIdOf(task);
    if (!sid) throw httpError(400, 'not an agent session');
    let url: string;
    const kind = task.kind === 'dispatch' ? (task.provider === 'openai' ? 'codex' : 'claude-code') : task.kind;
    if (kind === 'claude-code') {
      if (!/^[0-9a-f-]{36}$/i.test(sid)) throw httpError(400, 'invalid session id');
      url = `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sid)}${prompt ? `&prompt=${encodeURIComponent(prompt.slice(0, 8000))}` : ''}`;
    } else if (kind === 'codex') {
      url = `vscode://openai.chatgpt/local/${encodeURIComponent(sid)}`;
    } else throw httpError(400, 'only Claude Code / Codex sessions open in VS Code');
    this.actions.openUrl(url);
  }

  /**
   * Once the server listens: background Claude runs get the permission tool,
   * which asks this server (loopback + API token) and waits for your answer.
   */
  setPermissionEndpoint(url: string, token: string) {
    const dir = path.join(dataDir(), 'runs');
    // bundled next to the server / Electron main (unpacked from the asar so `node` can run it)
    const script = path.join(__dirname, '..', 'mcp', 'permission.cjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    this.actions.permissionConfig = (jobId) => {
      if (!fs.existsSync(script)) return undefined;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${jobId}.mcp.json`);
      const cfg = {
        mcpServers: {
          vibeportal: {
            command: process.execPath,
            args: [script],
            // Electron's binary runs scripts as plain Node with this; the token never shows in `ps`
            env: { ELECTRON_RUN_AS_NODE: '1', VP_URL: url, VP_TOKEN: token, VP_JOB: jobId },
          },
        },
      };
      fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
      return file;
    };
    this.actions.onJobEnd = (jobId) => {
      this.permissions.endJob(jobId);
      fs.rm(path.join(dir, `${jobId}.mcp.json`), { force: true }, () => {});
    };
  }

  // ── new tasks ─────────────────────────────────────────────────────────────
  launchOptions(): LaunchOptions {
    const c = this.cfg;
    const days = c.historyDays;
    const claudeDefaults = readClaudeDefaults(c.claudeDir);
    const codexDefaults = readCodexDefaults(c.codexDir);
    const seen = (models: string[], keep: (m: string) => boolean) => models.filter(keep).sort();
    const claudeList = this.models.get('claude');
    const codexList = this.models.get('codex');
    return {
      projects: launchProjects({ claude: this.claudeLocal.ledger.projects(days), codex: this.codex.ledger.projects(days) }, c.cloneDir),
      agents: {
        claude: {
          available: !!resolveBin('claude', c.claudeBin),
          models: unique(['fable', 'opus', 'sonnet', 'haiku', ...(claudeList?.models.map((m) => m.id) ?? seen(this.claudeLocal.ledger.models(), (m) => m.startsWith('claude-')))]),
          efforts: CLAUDE_EFFORTS,
          ...listed(claudeList, CLAUDE_EFFORTS),
          ...claudeDefaults,
        },
        codex: {
          available: !!resolveBin('codex', c.codexBin),
          // the provider's list leaves out what the installed CLI is too old for (a default it can't run included)
          models: codexList?.models.map((m) => m.id) ?? unique([...(codexDefaults.defaultModel ? [codexDefaults.defaultModel] : []), ...seen(this.codex.ledger.models(), (m) => m !== 'unknown')]),
          efforts: catalogEfforts(codexList) ?? CODEX_EFFORTS,
          ...listed(codexList),
          ...codexDefaults,
        },
      },
    };
  }

  /** Repos whose .claude/skills etc. are worth listing: the ones agents worked in, plus open VS Code folders. */
  private skillProjects(): string[] {
    const days = this.cfg.historyDays;
    return launchProjects({ claude: this.claudeLocal.ledger.projects(days), codex: this.codex.ledger.projects(days) })
      .slice(0, 60)
      .map((p) => p.path);
  }

  startTask(body: any) {
    const agent = body?.agent === 'codex' ? 'codex' : body?.agent === 'claude' ? 'claude' : undefined;
    if (!agent) throw httpError(400, 'agent must be "claude" or "codex"');
    const cwd = typeof body?.cwd === 'string' ? body.cwd : '';
    if (!path.isAbsolute(cwd) || !isDir(cwd)) throw httpError(400, 'cwd must be an existing folder');
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 20_000) : '';
    if (!prompt) throw httpError(400, 'prompt is required');
    const run = cleanRunOptions(agent, body);
    const withSkills = this.skills.promptFor(body?.skills) + prompt;
    const r = this.actions.start({ agent, cwd, prompt: withSkills, ...run }, { claudeBin: this.cfg.claudeBin, codexBin: this.cfg.codexBin });
    this.dispatchProvider.set(r.jobId, agent === 'codex' ? 'openai' : 'claude');
    // the dispatch job already published; return its task id so the UI can follow it
    return { ...r, taskId: `dispatch:${r.jobId}` };
  }

  // ── polling ───────────────────────────────────────────────────────────────
  private async tick(first = false) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const c = this.cfg;
      const t = { warn: c.warnPercent, critical: c.criticalPercent };
      const now = Date.now();
      void this.resets.collect();
      void this.models.refresh(c);
      const remote: Promise<unknown>[] = [];
      if (now - this.lastSubFetch >= c.subscriptionPollSeconds * 1000) {
        this.lastSubFetch = now;
        remote.push(this.claudeSub.collect(c.claudeDir, t), this.chatgpt.collect(c.codexDir, t));
      }
      if (now - this.lastCostFetch >= 15 * 60_000) {
        this.lastCostFetch = now;
        remote.push(this.costs.collect({ anthropic: c.anthropicAdminKey, openai: c.openaiAdminKey }, c.historyDays));
      }
      if (c.hosts.length) remote.push(this.remotes.poll(c.hosts));
      // publish quickly on first run so the UI isn't blank while history loads
      if (first) {
        await Promise.all(remote.splice(0));
        this.publish();
      }
      await Promise.all([
        this.claudeLocal.collect(c.claudeDir, c.historyDays, this.prices),
        this.codex.collect(c.codexDir, c.historyDays, this.prices),
        ...remote,
      ]);
      this.publish();
      this.history.save();
      this.skills.flush();
    } catch (e) {
      console.error('[monitor] tick failed', e);
    } finally {
      this.ticking = false;
    }
  }

  private withForecast(provider: Provider, quotas: QuotaWindow[]): QuotaWindow[] {
    const t = { warn: this.cfg.warnPercent, critical: this.cfg.criticalPercent };
    return quotas.map((q) => {
      const key = `${provider}:${q.id}`;
      this.history.record(key, q);
      return { ...q, severity: rescale(q, t), forecast: this.history.forecast(key, q) };
    });
  }

  private publish() {
    const c = this.cfg;
    // live ChatGPT numbers beat the log-derived ones when available
    const live = this.chatgpt.status.state === 'ok';
    const codexQ = live ? { quotas: this.chatgpt.quotas, observedAt: this.chatgpt.observedAt } : this.codex.quotas({ warn: c.warnPercent, critical: c.criticalPercent });
    if (live) this.codex.setLivePlan(this.chatgpt.planType);

    const claude: ProviderSnapshot = {
      provider: 'claude',
      name: 'Claude',
      plan: this.claudeSub.plan,
      quotas: this.withForecast('claude', this.claudeSub.quotas),
      quotasObservedAt: this.claudeSub.observedAt,
      daily: this.claudeLocal.ledger.daily(c.historyDays),
      today: this.claudeLocal.ledger.today(),
      last5h: this.claudeLocal.ledger.last5h(),
      apiCost: this.costs.anthropic,
      sources: [this.claudeSub.status, this.claudeLocal.status, this.costs.anthropicStatus],
      projects: this.claudeLocal.ledger.projects(c.historyDays),
      unpricedModels: this.claudeLocal.unpriced(),
    };
    const openai: ProviderSnapshot = {
      provider: 'openai',
      name: 'ChatGPT',
      plan: this.codex.plan,
      quotas: this.withForecast('openai', codexQ.quotas),
      quotasObservedAt: codexQ.observedAt,
      daily: this.codex.ledger.daily(c.historyDays),
      today: this.codex.ledger.today(),
      last5h: this.codex.ledger.last5h(),
      apiCost: this.costs.openai,
      sources: [this.chatgpt.status, this.codex.authStatus, this.codex.status, this.costs.openaiStatus],
      projects: this.codex.ledger.projects(c.historyDays),
      unpricedModels: this.codex.unpriced(),
      resetCredits: live ? this.chatgpt.resetCredits : undefined,
    };

    const local = this.withJobSessions((ownedBy, linked) => [
      ...this.tasks
        .claudeTasks(c.claudeDir, (sid) => this.claudeLocal.activity.title(sid), ownedBy, linked)
        .map((t) => {
          const sid = sessionIdOf(t) ?? '';
          return { ...t, workload: this.claudeLocal.sessions.workload(sid), activity: this.claudeLocal.activity.get(sid) };
        }),
      ...this.codex.tasks(this.codex.readTitles(c.codexDir)),
      ...this.tasks.customTasks(),
    ]);
    const tasks = this.archive
      .mark([...local, ...this.remotes.tasks(c.hosts)])
      .map((t) => {
        const f = this.finishedAt.get(t.id);
        return f ? { ...t, finishedAt: new Date(f).toISOString() } : t;
      })
      .sort((a, b) => stateRank(a.state) - stateRank(b.state) || b.updatedAt.localeCompare(a.updatedAt));

    this.detectTransitions(tasks, [claude, openai]);
    this.office.observe(tasks);
    const providers = [claude, openai];
    this.resets.observe(providers);
    this.snapshot = {
      generatedAt: new Date().toISOString(),
      providers,
      tasks,
      pet: this.petState(tasks, providers),
      pets: {
        claude: this.petState(tasks.filter((t) => providerOf(t) === 'claude'), [claude]),
        openai: this.petState(tasks.filter((t) => providerOf(t) === 'openai'), [openai]),
      },
      petConfig: { ...c.pet },
      historyDays: c.historyDays,
      machineName: c.machineName,
      remotes: this.remotes.snapshots(c.hosts),
      official: this.official.state(),
      permissions: this.permissions.list(),
      office: this.office.live(),
    };
    this.emit('snapshot', this.snapshot);
  }

  /**
   * A background run (new task / continued instruction) creates a session of its
   * own. Fold that session into the run's task — one clone, with the session's
   * progress — instead of showing both. Claude sessions are matched by pid,
   * Codex rollouts by folder and start time.
   */
  private withJobSessions(build: (ownedBy: (pid: number) => string | undefined, linked: Map<string, string>) => TaskInfo[]): TaskInfo[] {
    const jobs = this.actions.jobList();
    const byPid = new Map(jobs.filter((j) => j.running && j.pid).map((j) => [j.pid!, j.id]));
    const linked = new Map<string, string>();
    let tasks = build((pid) => byPid.get(pid), linked);
    for (const j of jobs) {
      const sid = j.sessionId ?? linked.get(j.id);
      if (sid) {
        this.actions.setJobSession(j.id, sid);
        this.tasks.linkDispatch(j.id, sid);
        linked.set(j.id, sid);
        // a session we already know belongs to the run: don't show it twice
        tasks = tasks.filter((x) => sessionIdOf(x) !== sid || x.kind === 'dispatch');
        continue;
      }
      if (j.agent !== 'codex' || !j.running) continue;
      const t = tasks.find((x) => x.kind === 'codex' && x.cwd === j.cwd && x.startedAt && Date.parse(x.startedAt) >= j.startedAt - 5000);
      if (!t) continue;
      this.actions.setJobSession(j.id, sessionIdOf(t)!);
      this.tasks.linkDispatch(j.id, sessionIdOf(t)!);
      linked.set(j.id, sessionIdOf(t)!);
      tasks = tasks.filter((x) => x !== t);
    }
    const agentOf = new Map(jobs.map((j) => [`dispatch:${j.id}`, j.agent]));
    return tasks.map((x) => {
      // a run waiting for a permission answer needs you
      const asks = x.kind === 'dispatch' ? this.permissions.forJob(x.id.replace(/^dispatch:/, '')) : [];
      let t: TaskInfo = asks.length ? { ...x, permissions: asks, state: 'waiting', detail: `🔐 ${asks[0].tool}: ${asks[0].summary}` } : x;
      const queued = x.kind === 'dispatch' ? this.followUps.get(x.id.replace(/^dispatch:/, ''))?.prompts : undefined;
      if (queued?.length) t = { ...t, queued: [...queued] };
      const sid = t.kind === 'dispatch' ? linked.get(t.id.replace(/^dispatch:/, '')) : undefined;
      if (!sid) return t;
      const codex = agentOf.get(t.id) === 'codex';
      const activity = codex ? this.codex.activity.get(sid) : this.claudeLocal.activity.get(sid);
      const workload = codex ? this.codex.sessionStats.workload(sid) : this.claudeLocal.sessions.workload(sid);
      return { ...t, activity: activity ?? t.activity, workload: workload ?? t.workload };
    });
  }

  private detectTransitions(tasks: TaskInfo[], providers: ProviderSnapshot[]) {
    const first = !this.snapshot;
    const seen = new Set<string>();
    const now = Date.now();
    for (const [id, at] of this.finishedAt) if (now - at > FINISHED_TTL) this.finishedAt.delete(id);
    for (const task of tasks) {
      seen.add(task.id);
      const prev = this.prevTaskStates.get(task.id);
      this.prevTaskStates.set(task.id, task.state);
      if (task.state === 'running' || task.state === 'waiting') this.finishedAt.delete(task.id);
      if (first || prev === undefined || prev === task.state) continue;
      const where = task.host ? ` @${task.host}` : '';
      if (prev === 'running' && (task.state === 'idle' || task.state === 'done')) {
        this.finishedAt.set(task.id, now);
        task.finishedAt = new Date(now).toISOString();
        this.emit('notice', { title: `✅ ${task.title}${where}`, body: `${kindLabel(task.kind)} finished — what next?`, level: 'info', taskId: task.id } satisfies Notice);
      } else if (task.state === 'failed') {
        this.finishedAt.set(task.id, now);
        this.emit('notice', { title: `❌ ${task.title}${where}`, body: task.detail ?? 'Task failed', level: 'warning', taskId: task.id } satisfies Notice);
      } else if (task.state === 'waiting') {
        this.emit('notice', { title: `⏳ ${task.title}${where}`, body: task.detail ?? 'Needs your attention', level: 'warning', taskId: task.id } satisfies Notice);
      }
    }
    for (const id of this.prevTaskStates.keys()) if (!seen.has(id)) this.prevTaskStates.delete(id);

    for (const p of providers) {
      for (const q of p.quotas) {
        const key = `${p.provider}:${q.id}`;
        const prev = this.prevSeverity.get(key);
        this.prevSeverity.set(key, q.severity);
        const exhaustKey = `${key}:exhaust`;
        const willExhaust = !!q.forecast?.willExhaustBeforeReset;
        const prevExhaust = this.prevSeverity.get(exhaustKey) === 'critical';
        this.prevSeverity.set(exhaustKey, willExhaust ? 'critical' : 'normal');
        if (!first && willExhaust && !prevExhaust && q.forecast?.exhaustAt) {
          this.emit('notice', {
            title: `${p.name}: ${q.label} may run out`,
            body: `At the current pace it hits 100% around ${new Date(q.forecast.exhaustAt).toLocaleTimeString()} — before it resets`,
            level: 'warning',
          } satisfies Notice);
        }
        if (first || prev === undefined || prev === q.severity) continue;
        if (sevRank(q.severity) > sevRank(prev)) {
          this.emit('notice', {
            title: `${p.name}: ${q.label} at ${Math.round(q.percent)}%`,
            body: q.resetsAt ? `Resets ${new Date(q.resetsAt).toLocaleString()}` : 'Usage is getting high',
            level: q.severity === 'critical' ? 'critical' : 'warning',
          } satisfies Notice);
        }
      }
    }
  }

  private petState(tasks: TaskInfo[], providers: ProviderSnapshot[]): PetState {
    const waiting = tasks.find((t) => t.state === 'waiting');
    if (waiting) return { mood: 'waiting', message: `${waiting.title} needs you` };

    const quotas = providers.flatMap((p) => p.quotas.map((q) => ({ p, q })));
    const worst = [...quotas].sort((a, b) => b.q.percent - a.q.percent)[0];
    if (worst && worst.q.severity === 'critical') {
      return { mood: 'alert', message: `${worst.p.name} ${worst.q.label}: ${Math.round(worst.q.percent)}%!` };
    }
    const justDone = tasks
      .filter((t) => t.finishedAt && Date.now() - Date.parse(t.finishedAt) < 90_000)
      .sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))[0];
    if (justDone) return { mood: 'happy', message: `Done: ${justDone.title}` };
    const running = tasks.filter((t) => t.state === 'running');
    if (running.length) {
      return { mood: 'working', message: running.length === 1 ? `Working on ${running[0].title}` : `${running.length} tasks running` };
    }
    // only worry once a window is past the warning line and on pace to run out: a fresh weekly
    // window's early pace (9% in 3 h) or a high one that will last till its reset is no cause to shiver
    const exhausting = quotas.find(({ q }) => q.severity === 'warning' && q.forecast?.willExhaustBeforeReset);
    if (exhausting) return { mood: 'alert', message: `${exhausting.p.name} ${exhausting.q.label} may run out before reset` };
    const lastActivity = Math.max(0, ...tasks.map((t) => Date.parse(t.updatedAt)));
    const summary = providers
      .filter((p) => p.quotas.length)
      .map((p) => `${p.name} ${Math.round(Math.max(...p.quotas.map((x) => x.percent)))}%`)
      .join(' · ');
    if (Date.now() - lastActivity > 30 * 60_000) return { mood: 'sleeping', message: summary || 'Zzz…' };
    return { mood: 'idle', message: summary || 'All quiet' };
  }
}

/** Model / effort Claude Code uses when none is given (its settings.json). */
function readClaudeDefaults(claudeDir: string): { defaultModel?: string; defaultEffort?: string } {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    return { defaultModel: typeof s.model === 'string' ? s.model : undefined, defaultEffort: typeof s.effortLevel === 'string' ? s.effortLevel : undefined };
  } catch {
    return {};
  }
}

/** Top-level `model` / `model_reasoning_effort` of ~/.codex/config.toml (before any [table]). */
function readCodexDefaults(codexDir: string): { defaultModel?: string; defaultEffort?: string } {
  try {
    const top = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8').split(/^\s*\[/m)[0];
    const get = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm').exec(top)?.[1];
    return { defaultModel: get('model'), defaultEffort: get('model_reasoning_effort') };
  } catch {
    return {};
  }
}

const unique = (xs: string[]) => [...new Set(xs)];

/** Per-model efforts (only ones the CLI takes) and the list's age, for the pickers. */
function listed(list: AgentCatalog | undefined, allowed?: string[]): { modelEfforts?: Record<string, string[]>; modelsUpdatedAt?: string } {
  if (!list) return {};
  const modelEfforts: Record<string, string[]> = {};
  for (const m of list.models) {
    const e = m.efforts?.filter((x) => !allowed || allowed.includes(x));
    if (e?.length) modelEfforts[m.id] = e;
  }
  return { modelEfforts, modelsUpdatedAt: list.fetchedAt };
}

export function sessionIdOf(task: TaskInfo): string | undefined {
  const m = /^(claude|codex):(.+)$/.exec(task.id);
  return m?.[2];
}

export function providerOf(t: TaskInfo): Provider {
  if (t.provider) return t.provider;
  return t.kind === 'codex' ? 'openai' : 'claude';
}

/** Re-apply the user's thresholds so changes in Settings take effect without a refetch. */
function rescale(q: QuotaWindow, t: { warn: number; critical: number }): QuotaWindow['severity'] {
  if (q.percent >= t.critical) return 'critical';
  if (q.percent >= t.warn) return q.severity === 'critical' ? 'critical' : 'warning';
  return q.severity;
}

const stateRank = (s: TaskInfo['state']) => ({ waiting: 0, running: 1, failed: 2, done: 3, idle: 4 })[s];
const sevRank = (s: QuotaWindow['severity']) => ({ normal: 0, warning: 1, critical: 2 })[s];
const kindLabel = (k: string) => (k === 'claude-code' ? 'Claude Code' : k === 'codex' ? 'Codex' : 'Task');
