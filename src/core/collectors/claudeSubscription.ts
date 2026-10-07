import fs from 'node:fs';
import path from 'node:path';
import type { PlanInfo, QuotaWindow, Severity, SourceStatus } from '../../shared/types';
import { fetchRetry } from './net';

const API = 'https://api.anthropic.com/api/oauth';

/**
 * Subscription plan + plan-limit utilisation for a Claude.ai login, using the
 * same OAuth endpoints Claude Code's `/usage` screen uses. The token is read
 * from Claude Code's credentials file and never refreshed here: refreshing
 * would rotate the refresh token underneath Claude Code.
 */
export class ClaudeSubscriptionCollector {
  plan?: PlanInfo;
  quotas: QuotaWindow[] = [];
  observedAt?: string;
  status: SourceStatus = { id: 'claude-subscription', label: 'Claude subscription', state: 'unavailable' };
  private lastProfileAt = 0;

  async collect(claudeDir: string, thresholds: { warn: number; critical: number }) {
    const token = readAccessToken(claudeDir);
    if (!token.ok) {
      this.status = { ...this.status, state: 'unavailable', message: token.reason, updatedAt: new Date().toISOString() };
      return;
    }
    const headers = {
      Authorization: `Bearer ${token.value}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      'User-Agent': 'vibeportal',
    };
    try {
      const usage = await getJson(`${API}/usage`, headers);
      this.quotas = parseUsage(usage, thresholds);
      this.observedAt = new Date().toISOString();
      if (Date.now() - this.lastProfileAt > 3600_000 || !this.plan) {
        const profile = await getJson(`${API}/profile`, headers);
        this.plan = parseProfile(profile);
        this.lastProfileAt = Date.now();
      }
      this.status = { ...this.status, state: 'ok', message: undefined, updatedAt: this.observedAt };
    } catch (e) {
      this.status = { ...this.status, state: 'error', message: String((e as Error).message ?? e), updatedAt: new Date().toISOString() };
    }
  }
}

function readAccessToken(claudeDir: string): { ok: true; value: string } | { ok: false; reason: string } {
  const file = path.join(claudeDir, '.credentials.json');
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {
      ok: false,
      reason:
        process.platform === 'darwin'
          ? 'Credentials are stored in the macOS keychain (not supported)'
          : `No Claude login found at ${file} — sign in with Claude Code (/login)`,
    };
  }
  const o = raw?.claudeAiOauth;
  if (!o?.accessToken) return { ok: false, reason: 'Claude Code is not signed in with a Claude.ai subscription' };
  if (typeof o.expiresAt === 'number' && o.expiresAt < Date.now()) {
    return { ok: false, reason: 'OAuth token expired — run Claude Code once to refresh it' };
  }
  return { ok: true, value: o.accessToken };
}

async function getJson(url: string, headers: Record<string, string>) {
  const res = await fetchRetry(url, { headers });
  if (!res.ok) throw new Error(`${new URL(url).pathname} → HTTP ${res.status}`);
  return res.json();
}

export function severityFor(percent: number, t: { warn: number; critical: number }, api?: string): Severity {
  if (api === 'critical' || api === 'exceeded' || api === 'error') return 'critical';
  if (percent >= t.critical) return 'critical';
  if (api === 'warning' || percent >= t.warn) return 'warning';
  return 'normal';
}

const KIND_LABELS: Record<string, string> = {
  session: '5-hour session',
  weekly_all: 'Weekly · all models',
};

export function parseUsage(u: any, t: { warn: number; critical: number }): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  if (Array.isArray(u?.limits) && u.limits.length) {
    for (const l of u.limits) {
      const percent = num(l.percent);
      const scopeName = l.scope?.model?.display_name ?? l.scope?.surface?.display_name ?? l.scope?.surface;
      let label = KIND_LABELS[l.kind] ?? humanize(String(l.kind ?? 'limit'));
      if (l.kind === 'weekly_scoped' || scopeName) label = `Weekly · ${scopeName ?? 'scoped'}`;
      const kind = l.kind === 'session' ? 'session' : String(l.kind).startsWith('weekly') ? 'weekly' : 'other';
      out.push({
        id: `${l.kind}${scopeName ? ':' + scopeName : ''}`,
        label,
        percent,
        resetsAt: l.resets_at ?? undefined,
        severity: severityFor(percent, t, l.severity),
        kind,
        windowMinutes: kind === 'session' ? 300 : kind === 'weekly' ? 10080 : undefined,
      });
    }
  } else {
    const legacy: [string, string][] = [
      ['five_hour', '5-hour session'],
      ['seven_day', 'Weekly · all models'],
      ['seven_day_opus', 'Weekly · Opus'],
      ['seven_day_sonnet', 'Weekly · Sonnet'],
    ];
    for (const [k, label] of legacy) {
      const w = u?.[k];
      if (!w || typeof w.utilization !== 'number') continue;
      const kind = k === 'five_hour' ? 'session' : 'weekly';
      out.push({
        id: k,
        label,
        percent: w.utilization,
        resetsAt: w.resets_at ?? undefined,
        severity: severityFor(w.utilization, t),
        kind,
        windowMinutes: kind === 'session' ? 300 : 10080,
      });
    }
  }
  // dollar-denominated pools the API reports under internal code names
  for (const [k, w] of Object.entries<any>(u ?? {})) {
    if (KNOWN_USAGE_KEYS.has(k) || !w || typeof w !== 'object' || typeof w.utilization !== 'number' || typeof w.limit_dollars !== 'number') continue;
    out.push({
      id: `pool:${k}`,
      label: 'Usage credit',
      kind: 'other',
      percent: w.utilization,
      resetsAt: w.resets_at ?? undefined,
      severity: severityFor(w.utilization, t),
      usedDollars: typeof w.used_dollars === 'number' ? w.used_dollars : undefined,
      limitDollars: w.limit_dollars,
    });
  }
  const x = u?.extra_usage;
  if (x?.is_enabled && typeof x.utilization === 'number') {
    out.push({
      id: 'extra_usage',
      label: 'Extra usage (monthly)',
      kind: 'other',
      percent: x.utilization,
      severity: severityFor(x.utilization, t),
      usedDollars: typeof x.used_credits === 'number' ? x.used_credits / 10 ** num(x.decimal_places ?? 2) : undefined,
      limitDollars: typeof x.monthly_limit === 'number' ? x.monthly_limit / 10 ** num(x.decimal_places ?? 2) : undefined,
    });
  }
  return out;
}

export function parseProfile(p: any): PlanInfo {
  const org = p?.organization ?? {};
  const acct = p?.account ?? {};
  const tier: string = org.rate_limit_tier ?? '';
  const type: string = org.organization_type ?? '';
  let name = 'Claude';
  const mult = /max_(\d+)x/.exec(tier)?.[1];
  if (type.includes('max') || acct.has_claude_max) name = `Claude Max${mult ? ` ${mult}x` : ''}`;
  else if (type.includes('pro') || acct.has_claude_pro) name = 'Claude Pro';
  else if (type.includes('team')) name = 'Claude Team';
  else if (type.includes('enterprise')) name = 'Claude Enterprise';
  else if (type) name = `Claude ${humanize(type.replace(/^claude_/, ''))}`;
  else name = 'Claude Free';
  const status: string | undefined = org.subscription_status ?? undefined;
  const since: string | undefined = org.subscription_created_at ?? undefined;
  // the profile has no renewal date: project the monthly anniversary of the start date
  const renewsAt = since && status === 'active' ? nextMonthly(since) : undefined;
  return { name, tier: tier || type || undefined, status, since, renewsAt, renewsEstimated: renewsAt ? true : undefined };
}

/** Next same-day-of-month (and time) after `now`, clamped to short months. */
export function nextMonthly(anchorIso: string, now = Date.now()): string | undefined {
  const a = new Date(anchorIso);
  if (Number.isNaN(a.getTime())) return undefined;
  const at = (y: number, m: number) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(a.getUTCDate(), last), a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds());
  };
  const n = new Date(now);
  let y = n.getUTCFullYear();
  let m = n.getUTCMonth();
  if (a.getTime() > now) return a.toISOString();
  while (at(y, m) <= now) {
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return new Date(at(y, m)).toISOString();
}

const KNOWN_USAGE_KEYS = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps', 'seven_day_cowork', 'extra_usage', 'spend', 'limits']);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
