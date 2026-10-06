import fs from 'node:fs';
import path from 'node:path';
import type { QuotaWindow, ResetCredits, SourceStatus } from '../../shared/types';
import { severityFor } from './claudeSubscription';
import { decodeJwt, windowKind, windowLabel } from './codexLocal';

/**
 * Live ChatGPT/Codex plan limits from chatgpt.com/backend-api/wham/usage — the
 * endpoint Codex's /status uses — authenticated with the Codex login token.
 * The token is only read, never refreshed (Codex owns it).
 */
export class ChatGptUsageCollector {
  quotas: QuotaWindow[] = [];
  planType?: string;
  resetCredits?: ResetCredits;
  observedAt?: string;
  status: SourceStatus = { id: 'chatgpt-usage', label: 'ChatGPT usage (live)', state: 'unavailable' };

  async collect(codexDir: string, t: { warn: number; critical: number }) {
    let auth: any;
    try {
      auth = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'));
    } catch {
      return this.fail('unavailable', 'No Codex login — run `codex login`');
    }
    const token: string | undefined = auth?.tokens?.access_token;
    if (!token) return this.fail('unavailable', 'Codex is not signed in with ChatGPT');
    const exp = decodeJwt(token)?.exp;
    if (typeof exp === 'number' && exp * 1000 < Date.now()) {
      return this.fail('unavailable', 'ChatGPT token expired — run Codex once to refresh it (showing log data)');
    }
    try {
      const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        headers: {
          Authorization: `Bearer ${token}`,
          'ChatGPT-Account-Id': auth?.tokens?.account_id ?? '',
          Accept: 'application/json',
          'User-Agent': 'vibeportal',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`wham/usage → HTTP ${res.status}`);
      const body: any = await res.json();
      this.quotas = parseWham(body, t);
      this.planType = body.plan_type ?? undefined;
      this.resetCredits = parseResetCredits(body);
      this.observedAt = new Date().toISOString();
      this.status = { ...this.status, state: 'ok', message: undefined, updatedAt: this.observedAt };
    } catch (e) {
      this.fail('error', (e as Error).message);
    }
  }

  private fail(state: SourceStatus['state'], message: string) {
    this.quotas = [];
    this.resetCredits = undefined;
    this.status = { ...this.status, state, message, updatedAt: new Date().toISOString() };
  }
}

export function parseResetCredits(body: any): ResetCredits | undefined {
  const r = body?.rate_limit_reset_credits;
  if (!r || typeof r.available_count !== 'number') return undefined;
  return { available: r.available_count, usableNow: typeof r.applicable_available_count === 'number' ? r.applicable_available_count : 0 };
}

export function parseWham(body: any, t: { warn: number; critical: number }): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  const push = (prefix: string, rl: any, name?: string) => {
    for (const key of ['primary_window', 'secondary_window'] as const) {
      const w = rl?.[key];
      if (!w || typeof w.used_percent !== 'number') continue;
      const minutes = w.limit_window_seconds ? Math.round(w.limit_window_seconds / 60) : undefined;
      const base = windowLabel(minutes, key === 'primary_window' ? 'primary' : 'secondary');
      out.push({
        id: `${prefix}-${key}`,
        label: name ? `${name} · ${base}` : base,
        percent: w.used_percent,
        resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : undefined,
        severity: rl.limit_reached ? 'critical' : severityFor(w.used_percent, t),
        kind: name ? 'other' : windowKind(minutes),
        windowMinutes: minutes,
      });
    }
  };
  push('codex', body?.rate_limit);
  for (const extra of body?.additional_rate_limits ?? []) {
    const name = String(extra?.limit_name ?? 'extra')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c: string) => c.toUpperCase());
    push(`extra-${extra?.limit_name ?? 'x'}`, extra?.rate_limit, name);
  }
  if (body?.code_review_rate_limit) push('review', body.code_review_rate_limit, 'Code review');
  return out;
}
