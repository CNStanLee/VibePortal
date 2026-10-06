import fs from 'node:fs';
import path from 'node:path';
import { JsonlTailer, findJsonl, yieldToLoop } from '../jsonl';
import { SessionStats, UsageLedger, projectKey } from '../ledger';
import { PriceBook } from '../prices';
import { nextMonthly, severityFor } from './claudeSubscription';
import { ActivityLog } from '../activity';
import type { PlanInfo, QuotaWindow, SourceStatus, TaskInfo, TaskState } from '../../shared/types';

interface SessionState {
  id: string;
  file: string;
  cwd?: string;
  model: string;
  effort?: string;
  originator?: string;
  prevTotal?: { input: number; cached: number; output: number; total: number };
  lastTaskStarted?: number;
  lastTaskComplete?: number;
  firstUserMessage?: string;
  lastActivity: number;
}

interface RateLimitObs {
  ts: number;
  primary?: Window;
  secondary?: Window;
  planType?: string;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string };
}
interface Window {
  used_percent: number;
  window_minutes?: number;
  resets_at?: number;
}

/**
 * Reads Codex CLI / IDE rollout logs (~/.codex/sessions/YYYY/MM/DD/*.jsonl).
 * They carry cumulative token counts and — importantly — the ChatGPT plan's
 * rate-limit utilisation as last reported by the server.
 */
export class CodexLocalCollector {
  readonly ledger = new UsageLedger();
  readonly sessionStats = new SessionStats();
  /** per-session progress feed (tool calls, replies, plan) for the pet */
  readonly activity = new ActivityLog();
  private tailer = new JsonlTailer();
  private sessions = new Map<string, SessionState>();
  private latestLimits?: RateLimitObs;
  private lastDir = '';
  private prices = new PriceBook();
  plan?: PlanInfo;
  status: SourceStatus = { id: 'codex-logs', label: 'Codex logs', state: 'unavailable' };
  authStatus: SourceStatus = { id: 'chatgpt-plan', label: 'ChatGPT login', state: 'unavailable' };

  async collect(codexDir: string, historyDays: number, prices?: PriceBook) {
    if (prices && prices !== this.prices) {
      this.prices = prices;
      this.reset();
    }
    if (codexDir !== this.lastDir) {
      this.reset();
      this.lastDir = codexDir;
    }
    this.readPlan(codexDir);
    const root = path.join(codexDir, 'sessions');
    const files = findJsonl(root, Date.now() - historyDays * 86400_000, 4);
    if (files.length === 0) {
      this.status = { ...this.status, state: 'unavailable', message: `No Codex sessions under ${root}`, updatedAt: new Date().toISOString() };
      return;
    }
    for (const f of files) {
      let s = this.sessions.get(f);
      if (!s) {
        s = { id: path.basename(f, '.jsonl').replace(/^rollout-[\dT-]+?-(?=[0-9a-f]{8}-)/, ''), file: f, model: 'unknown', lastActivity: 0 };
        this.sessions.set(f, s);
      }
      const state = s;
      this.tailer.read(f, (o) => this.ingest(state, o), codexLineFilter);
      await yieldToLoop();
    }
    this.ledger.prune(Math.max(historyDays, 35));
    this.status = { ...this.status, state: 'ok', message: `${files.length} session files`, updatedAt: new Date().toISOString() };
  }

  ingest(s: SessionState, o: any) {
    const ts = Date.parse(o?.timestamp);
    if (Number.isFinite(ts)) s.lastActivity = Math.max(s.lastActivity, ts);
    const p = o?.payload;
    if (!p) return;
    if (o.type === 'session_meta') {
      s.cwd = p.cwd ?? s.cwd;
      if (p.id) s.id = p.id;
      if (typeof p.originator === 'string') s.originator = p.originator;
      return;
    }
    if (o.type === 'turn_context') {
      if (p.model) s.model = p.model;
      if (p.cwd) s.cwd = p.cwd;
      const effort = p.effort ?? p.collaboration_mode?.settings?.reasoning_effort;
      if (typeof effort === 'string') s.effort = effort;
      return;
    }
    if (o.type === 'response_item') return this.track(s, ts, p);
    if (o.type !== 'event_msg') return;
    switch (p.type) {
      case 'task_started':
        s.lastTaskStarted = ts;
        break;
      case 'task_complete':
        s.lastTaskComplete = ts;
        break;
      case 'agent_message':
        this.activity.say(s.id, ts, p.message);
        break;
      case 'user_message':
        this.activity.prompt(s.id, ts, p.message);
        if (!s.firstUserMessage && typeof p.message === 'string') s.firstUserMessage = p.message.slice(0, 120);
        break;
      case 'token_count': {
        const tot = p.info?.total_token_usage;
        if (tot) {
          const cur = {
            input: n(tot.input_tokens),
            cached: n(tot.cached_input_tokens),
            output: n(tot.output_tokens),
            total: n(tot.total_tokens),
          };
          const prev = s.prevTotal;
          // cumulative counter per session; a drop means the session was compacted/reset
          const base = prev && cur.total >= prev.total ? prev : { input: 0, cached: 0, output: 0, total: 0 };
          const d = {
            input: cur.input - base.input,
            cached: cur.cached - base.cached,
            output: cur.output - base.output,
            total: cur.total - base.total,
          };
          s.prevTotal = cur;
          if (d.total > 0) {
            const t = {
              input: Math.max(0, d.input - d.cached),
              cacheRead: Math.max(0, d.cached),
              cacheWrite: 0,
              output: Math.max(0, d.output),
              total: d.total,
              messages: 1,
              cost: 0,
            };
            t.cost = this.prices.cost(s.model, { ...t, cacheWrite5m: 0, cacheWrite1h: 0 });
            this.ledger.add(ts, s.model, t, projectKey(s.cwd));
          }
          const last = p.info?.last_token_usage;
          this.sessionStats.add(s.id, ts, Math.max(0, d.total - d.cached), n(last?.input_tokens), s.model, n(p.info?.model_context_window) || undefined, s.effort);
        }
        const rl = p.rate_limits;
        if (rl && Number.isFinite(ts) && (!this.latestLimits || ts >= this.latestLimits.ts)) {
          this.latestLimits = {
            ts,
            primary: rl.primary ?? undefined,
            secondary: rl.secondary ?? undefined,
            planType: rl.plan_type ?? undefined,
            credits: rl.credits ?? undefined,
          };
        }
        break;
      }
    }
  }

  /** Tool calls and the agent's commentary from response items. */
  private track(s: SessionState, ts: number, p: any) {
    switch (p.type) {
      case 'function_call': {
        let args: any = {};
        try {
          args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments ?? {};
        } catch {
          /* truncated / non-JSON arguments */
        }
        this.activity.tool(s.id, ts, p.name, args, { id: p.call_id, cwd: s.cwd });
        break;
      }
      case 'custom_tool_call':
        this.activity.tool(s.id, ts, p.name, p.input, { id: p.call_id, cwd: s.cwd });
        break;
      case 'local_shell_call':
        this.activity.tool(s.id, ts, 'local_shell_call', p.action ?? {}, { id: p.call_id, cwd: s.cwd });
        break;
      case 'web_search_call':
        this.activity.tool(s.id, ts, 'web_search_call', p, { id: p.id, cwd: s.cwd });
        break;
      case 'message':
        if (p.role === 'assistant' && Array.isArray(p.content)) {
          this.activity.say(s.id, ts, p.content.filter((c: any) => c?.type === 'output_text').map((c: any) => c.text).join('\n'));
        }
        break;
    }
  }

  quotas(t: { warn: number; critical: number }): { quotas: QuotaWindow[]; observedAt?: string } {
    const l = this.latestLimits;
    if (!l) return { quotas: [] };
    const out: QuotaWindow[] = [];
    for (const [key, w] of [
      ['primary', l.primary],
      ['secondary', l.secondary],
    ] as const) {
      if (!w || typeof w.used_percent !== 'number') continue;
      let resetsAt = w.resets_at ? new Date(w.resets_at * 1000).toISOString() : undefined;
      // if the window already rolled over since we last saw it, usage is back to 0
      const percent = resetsAt && Date.parse(resetsAt) < Date.now() ? 0 : w.used_percent;
      if (percent === 0 && resetsAt && Date.parse(resetsAt) < Date.now()) resetsAt = undefined;
      out.push({
        id: `codex-${key}`,
        label: windowLabel(w.window_minutes, key),
        percent,
        resetsAt,
        severity: severityFor(percent, t),
        kind: windowKind(w.window_minutes),
        windowMinutes: w.window_minutes,
      });
    }
    return { quotas: out, observedAt: new Date(l.ts).toISOString() };
  }

  /** Recently active Codex sessions as tasks. */
  tasks(titles: Map<string, string>): TaskInfo[] {
    const now = Date.now();
    const out: TaskInfo[] = [];
    for (const s of this.sessions.values()) {
      if (now - s.lastActivity > 30 * 60_000) continue;
      const started = s.lastTaskStarted ?? 0;
      const completed = s.lastTaskComplete ?? 0;
      let state: TaskState;
      if (started > completed) state = now - s.lastActivity < 10 * 60_000 ? 'running' : 'idle';
      else state = completed ? 'done' : 'idle';
      out.push({
        id: `codex:${s.id}`,
        kind: 'codex',
        provider: 'openai',
        canContinue: true,
        ide: s.originator === 'codex_vscode' ? 'vscode' : s.originator && /cli|tui|exec/.test(s.originator) ? 'terminal' : undefined,
        workload: this.sessionStats.workload(s.id),
        activity: this.activity.get(s.id),
        title: titles.get(s.id) ?? s.firstUserMessage ?? (s.cwd ? path.basename(s.cwd) : 'Codex session'),
        state,
        detail: s.model !== 'unknown' ? s.model : undefined,
        cwd: s.cwd,
        startedAt: started ? new Date(started).toISOString() : undefined,
        updatedAt: new Date(s.lastActivity).toISOString(),
      });
    }
    return out;
  }

  unpriced(): string[] {
    return this.ledger.models().filter((m) => m !== 'unknown' && !this.prices.find(m));
  }

  /** Rollout file of a session id, for the task actions. */
  sessionFile(id: string): string | undefined {
    for (const s of this.sessions.values()) if (s.id === id) return s.file;
    return undefined;
  }

  /** Overrides the log-derived limits with live numbers from the ChatGPT backend. */
  setLivePlan(planType: string | undefined) {
    if (planType && this.plan) this.plan = { ...this.plan, name: `ChatGPT ${planName(planType)}`, tier: planType };
  }

  readTitles(codexDir: string): Map<string, string> {
    const m = new Map<string, string>();
    try {
      const raw = fs.readFileSync(path.join(codexDir, 'session_index.jsonl'), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const o = JSON.parse(line);
          if (o.id && o.thread_name) m.set(o.id, o.thread_name);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* no index */
    }
    return m;
  }

  private readPlan(codexDir: string) {
    const file = path.join(codexDir, 'auth.json');
    try {
      const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
      const claims = decodeJwt(auth?.tokens?.id_token)?.['https://api.openai.com/auth'];
      // rate-limit events report the live plan; the id_token can be stale
      const planType: string | undefined = this.latestLimits?.planType ?? claims?.chatgpt_plan_type;
      if (!planType) {
        this.plan = auth?.OPENAI_API_KEY ? { name: 'OpenAI API key', tier: 'api' } : undefined;
        this.authStatus = { ...this.authStatus, state: auth?.OPENAI_API_KEY ? 'ok' : 'unavailable', message: auth?.OPENAI_API_KEY ? 'Using API key (no subscription)' : 'Not signed in with ChatGPT' };
        return;
      }
      // the id_token is only refreshed occasionally — a past "until" just means stale claims
      const until: string | undefined = claims?.chatgpt_subscription_active_until ?? undefined;
      const fresh = until ? Date.parse(until) > Date.now() : false;
      // a stale "until" still pins the billing day: roll it forward month by month
      const anchor: string | undefined = until ?? claims?.chatgpt_subscription_active_start ?? undefined;
      const renewsAt = fresh ? until : planType !== 'free' && anchor ? nextMonthly(anchor) : undefined;
      this.plan = {
        name: `ChatGPT ${planName(planType)}`,
        tier: planType,
        since: fresh ? claims?.chatgpt_subscription_active_start ?? undefined : undefined,
        until: fresh ? until : undefined,
        renewsAt,
        renewsEstimated: renewsAt && !fresh ? true : undefined,
      };
      this.authStatus = { ...this.authStatus, state: 'ok', message: undefined, updatedAt: new Date().toISOString() };
    } catch {
      this.plan = undefined;
      this.authStatus = { ...this.authStatus, state: 'unavailable', message: `No Codex login at ${file} — run \`codex login\``, updatedAt: new Date().toISOString() };
    }
  }

  private reset() {
    this.ledger.clear();
    this.sessionStats.clear();
    this.activity.clear();
    this.tailer = new JsonlTailer();
    this.sessions.clear();
    this.latestLimits = undefined;
  }
}

export function windowKind(minutes: number | undefined): 'session' | 'weekly' | 'other' {
  if (minutes === 300) return 'session';
  if (minutes === 10080) return 'weekly';
  return 'other';
}

export function windowLabel(minutes: number | undefined, key: string): string {
  if (!minutes) return key === 'primary' ? 'Primary window' : 'Secondary window';
  if (minutes === 300) return '5-hour window';
  if (minutes === 10080) return 'Weekly window';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

export function planName(t: string): string {
  return PLAN_NAMES[t] ?? t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function decodeJwt(token: unknown): any {
  if (typeof token !== 'string') return undefined;
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

const INTERESTING = ['"event_msg"', '"session_meta"', '"turn_context"'];
// tool calls and assistant messages, but not their (large) outputs; quotes inside string values are escaped, so these can't false-match
const RESPONSE_ITEMS = ['"type":"function_call",', '"type":"custom_tool_call",', '"type":"local_shell_call",', '"type":"web_search_call"', '"role":"assistant"'];
const codexLineFilter = (line: string) =>
  INTERESTING.some((k) => line.includes(k)) || (line.includes('"response_item"') && RESPONSE_ITEMS.some((k) => line.includes(k)));

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
