import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTotals, emptyTotals, type DailyUsage, type ProjectUsage, type TokenTotals, type Workload } from '../shared/types';
import { localDate } from './jsonl';

const WINDOW_MS = 5 * 60 * 60 * 1000;

interface Day {
  totals: TokenTotals;
  byModel: Record<string, TokenTotals>;
  projects: Map<string, { totals: TokenTotals; byModel: Record<string, TokenTotals> }>;
}

/** Aggregates token usage per local day, model and repository, plus a rolling 5-hour window. */
export class UsageLedger {
  private days = new Map<string, Day>();
  private recent: { ts: number; totals: TokenTotals }[] = [];
  private lastActive = new Map<string, number>();

  add(ts: number, model: string, t: TokenTotals, project?: string) {
    if (!Number.isFinite(ts)) return;
    const date = localDate(ts);
    let day = this.days.get(date);
    if (!day) {
      day = { totals: emptyTotals(), byModel: {}, projects: new Map() };
      this.days.set(date, day);
    }
    day.totals = addTotals(day.totals, t);
    day.byModel[model] = addTotals(day.byModel[model] ?? emptyTotals(), t);
    if (project) {
      let pr = day.projects.get(project);
      if (!pr) day.projects.set(project, (pr = { totals: emptyTotals(), byModel: {} }));
      pr.totals = addTotals(pr.totals, t);
      pr.byModel[model] = addTotals(pr.byModel[model] ?? emptyTotals(), t);
      this.lastActive.set(project, Math.max(this.lastActive.get(project) ?? 0, ts));
    }
    if (ts > Date.now() - WINDOW_MS) this.recent.push({ ts, totals: t });
  }

  /** Oldest first, limited to the last `historyDays` days (inclusive of today). */
  daily(historyDays: number): DailyUsage[] {
    const cutoff = localDate(Date.now() - (historyDays - 1) * 86400_000);
    return [...this.days.entries()]
      .filter(([date]) => date >= cutoff)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, d]) => ({ date, totals: d.totals, byModel: d.byModel }));
  }

  projects(historyDays: number): ProjectUsage[] {
    const now = Date.now();
    const cutoff = localDate(now - (historyDays - 1) * 86400_000);
    const today = localDate(now);
    const week = localDate(now - 6 * 86400_000);
    const sparkDates = Array.from({ length: 14 }, (_, i) => localDate(now - (13 - i) * 86400_000));
    const out = new Map<string, ProjectUsage>();
    for (const [date, day] of this.days) {
      if (date < cutoff) continue;
      for (const [key, pr] of day.projects) {
        let u = out.get(key);
        if (!u) {
          u = {
            key,
            name: projectName(key),
            total: emptyTotals(),
            today: emptyTotals(),
            last7d: emptyTotals(),
            byModel: {},
            spark: new Array(14).fill(0),
            lastActive: new Date(this.lastActive.get(key) ?? 0).toISOString(),
            ...repoWeb(key),
          };
          out.set(key, u);
        }
        u.total = addTotals(u.total, pr.totals);
        if (date === today) u.today = addTotals(u.today, pr.totals);
        if (date >= week) u.last7d = addTotals(u.last7d, pr.totals);
        for (const [m, t] of Object.entries(pr.byModel)) u.byModel[m] = addTotals(u.byModel[m] ?? emptyTotals(), t);
        const i = sparkDates.indexOf(date);
        if (i >= 0) u.spark[i] += pr.totals.total;
      }
    }
    return [...out.values()].sort((a, b) => b.total.total - a.total.total);
  }

  today(): TokenTotals {
    return this.days.get(localDate(Date.now()))?.totals ?? emptyTotals();
  }

  last5h(): TokenTotals {
    const cutoff = Date.now() - WINDOW_MS;
    this.recent = this.recent.filter((r) => r.ts > cutoff);
    return this.recent.reduce((acc, r) => addTotals(acc, r.totals), emptyTotals());
  }

  models(): string[] {
    const s = new Set<string>();
    for (const d of this.days.values()) for (const m of Object.keys(d.byModel)) s.add(m);
    return [...s];
  }

  /** Drop days older than `keepDays` to bound memory in long-running sessions. */
  prune(keepDays: number) {
    const cutoff = localDate(Date.now() - keepDays * 86400_000);
    for (const k of this.days.keys()) if (k < cutoff) this.days.delete(k);
  }

  clear() {
    this.days.clear();
    this.recent = [];
    this.lastActive.clear();
  }
}

const rootCache = new Map<string, string>();

/** Maps a working directory to its git repository root (cached). */
export function projectKey(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const hit = rootCache.get(cwd);
  if (hit) return hit;
  let dir = path.resolve(cwd);
  let root = dir;
  for (let i = 0; i < 40; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        root = dir;
        break;
      }
    } catch {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  rootCache.set(cwd, root);
  return root;
}

const webCache = new Map<string, { webUrl?: string; forge?: ProjectUsage['forge'] }>();

/** Web URL of a repo's `origin` remote, read from .git/config (no git process needed). */
export function repoWeb(root: string): { webUrl?: string; forge?: ProjectUsage['forge'] } {
  const hit = webCache.get(root);
  if (hit) return hit;
  let out: { webUrl?: string; forge?: ProjectUsage['forge'] } = {};
  try {
    let gitDir = path.join(root, '.git');
    if (fs.statSync(gitDir).isFile()) {
      // worktree / submodule: ".git" is a file pointing at the real git dir
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(gitDir, 'utf8'));
      if (m) gitDir = path.resolve(root, m[1].trim());
      const common = path.join(gitDir, 'commondir');
      if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim());
    }
    const cfg = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const remotes = [...cfg.matchAll(/\[remote "([^"]+)"\]([^[]*)/g)].map((m) => ({ name: m[1], url: /\burl\s*=\s*(\S+)/.exec(m[2])?.[1] }));
    const url = (remotes.find((r) => r.name === 'origin') ?? remotes[0])?.url;
    const webUrl = url ? toWebUrl(url) : undefined;
    if (webUrl) {
      const host = new URL(webUrl).hostname;
      out = { webUrl, forge: host.includes('github') ? 'github' : host.includes('gitlab') ? 'gitlab' : host.includes('bitbucket') ? 'bitbucket' : 'other' };
    }
  } catch {
    /* not a git repo, or unreadable */
  }
  webCache.set(root, out);
  return out;
}

/** git@host:org/repo.git, ssh://…, https://user:token@host/org/repo.git → https://host/org/repo */
export function toWebUrl(remote: string): string | undefined {
  let host: string;
  let p: string;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(remote);
  if (scp) {
    host = scp[1];
    p = scp[2];
  } else {
    let u: URL;
    try {
      u = new URL(remote);
    } catch {
      return undefined;
    }
    if (!/^(https?|ssh|git|git\+ssh):$/.test(u.protocol)) return undefined;
    host = u.hostname; // drops user:token@ and ssh ports
    p = u.pathname;
  }
  p = p.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '');
  if (!host || !p) return undefined;
  return `https://${host}/${p}`;
}

export function projectName(key: string): string {
  const home = os.homedir();
  if (key === home) return '~';
  return path.basename(key) || key;
}

/** Per-session workload: recent token rate, session total and current context size. */
export class SessionStats {
  private map = new Map<string, { total: number; ctx: number; ctxWindow?: number; model?: string; effort?: string; recent: [number, number][]; last: number }>();

  add(id: string, ts: number, tokens: number, ctx: number, model?: string, ctxWindow?: number, effort?: string) {
    let s = this.map.get(id);
    if (!s) this.map.set(id, (s = { total: 0, ctx: 0, recent: [], last: 0 }));
    s.total += tokens;
    if (ts >= s.last) {
      s.last = ts;
      if (ctx > 0) s.ctx = ctx;
      if (model) s.model = model;
      if (ctxWindow) s.ctxWindow = ctxWindow;
      if (effort) s.effort = effort;
    }
    if (ts > Date.now() - 10 * 60_000) s.recent.push([ts, tokens]);
  }

  workload(id: string): Workload | undefined {
    const s = this.map.get(id);
    if (!s) return undefined;
    const cutoff = Date.now() - 5 * 60_000;
    s.recent = s.recent.filter(([t]) => t > cutoff);
    const recent = s.recent.reduce((a, [, n]) => a + n, 0);
    return {
      tokensPerMin: Math.round(recent / 5),
      sessionTokens: s.total,
      contextTokens: s.ctx || undefined,
      contextWindow: s.ctxWindow ?? contextWindowFor(s.model),
      model: s.model,
      effort: s.effort,
    };
  }

  clear() {
    this.map.clear();
  }
}

/** Context window by model family; current Claude generations ship 1M. */
export function contextWindowFor(model?: string): number | undefined {
  if (!model) return undefined;
  if (/haiku|claude-3/.test(model)) return 200_000;
  if (model.startsWith('claude-')) return 1_000_000;
  return undefined;
}
