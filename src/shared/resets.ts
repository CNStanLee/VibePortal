import type { Provider, ProviderSnapshot } from './types';

export const DAY_MS = 86_400_000;
export interface ResetPost {
  id: string;
  postedAt: string;
  url: string;
  text: string;
  kind: 'reset' | 'credit' | 'pledge' | 'announcement' | 'update';
  /** A conditional pledge has no guaranteed reset date. */
  pledgeDays?: number;
  source: 'x' | 'reference';
  referenceUrl?: string;
}
export interface ResetEvent {
  id: string;
  at: string;
  provider: Provider;
  label: string;
  kind: 'observed' | 'scheduled' | 'estimated' | 'reset' | 'credit' | 'pledge' | 'announcement';
  url?: string;
  /** Observations only locate a reset between two fresh samples. */
  after?: string;
  source?: ResetPost['source'];
}
export interface ResetOutlook {
  samples: number;
  lastAt?: string;
  medianDays?: number;
  from?: string;
  to?: string;
  expectedAt?: string;
  overdue?: boolean;
  pledge?: ResetPost;
}
export interface ResetCalendarView {
  events: ResetEvent[];
  posts: ResetPost[];
  outlook: ResetOutlook;
  feed: { state: 'cached' | 'ok' | 'error'; checkedAt?: string; fetchedAt?: string; error?: string };
}

/** Conservative classification: questions, hints and conditional promises are never completed resets. */
export function classifyResetPost(text: string): Pick<ResetPost, 'kind' | 'pledgeDays'> {
  const s = text.toLowerCase().replace(/[’‘]/g, "'");
  if (/password|factory reset|reset settings/.test(s)) return { kind: 'update' };
  const pledge = /next\s+(\d{1,2})\s+days/.exec(s);
  if (pledge && /either|or ship/.test(s) && /reset/.test(s)) return { kind: 'pledge', pledgeDays: Math.min(60, Number(pledge[1])) };
  if (/banked reset|reset credit|reset card/.test(s)) return { kind: 'credit' };
  if (/\b(?:no|not|never|hasn't|haven't|didn't|has not|have not)\b[^.!?]{0,60}\b(?:reset|propagated|processed)\b/.test(s)) return { kind: 'update' };
  if (!/[?]/.test(s) && !/\b(?:if|would|might|could|will|tomorrow)\b/.test(s) && /\bresets?\b/.test(s) && /\ball (?:been )?reset\b|\b(?:have|has|just) reset\b|\breset[^.!?]{0,40}\b(?:propagated|processed|completed)\b|\bresets all propagated\b/.test(s)) return { kind: 'reset' };
  if (/\breset\b/.test(s) && /\bwill\b|\bi'll\b|\blanding\b/.test(s)) return { kind: 'announcement' };
  return { kind: 'update' };
}

const quantile = (xs: number[], q: number) => {
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  return xs[lo] + (xs[Math.ceil(pos)] - xs[lo]) * (pos - lo);
};

/** Extra global resets are discretionary. Show a historical range, never a probability or a fixed deadline. */
export function resetOutlook(posts: ResetPost[], now = Date.now()): ResetOutlook {
  const times = [...new Set(posts.filter((p) => p.kind === 'reset').map((p) => Date.parse(p.postedAt)))]
    .filter((t) => Number.isFinite(t) && t <= now && now - t <= 120 * DAY_MS).sort((a, b) => a - b);
  // Completion posts and follow-ups about one rollout aren't separate resets.
  const distinct = times.filter((t, i) => !i || t - times[i - 1] > 6 * 3_600_000);
  const gaps = distinct.slice(1).map((t, i) => (t - distinct[i]) / DAY_MS).sort((a, b) => a - b);
  const pledge = posts.filter((p) => p.kind === 'pledge' && p.pledgeDays && Date.parse(p.postedAt) <= now && Date.parse(p.postedAt) + p.pledgeDays * DAY_MS > now)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt))[0];
  const last = distinct.at(-1);
  const base: ResetOutlook = { samples: distinct.length, ...(last ? { lastAt: new Date(last).toISOString() } : {}), ...(pledge ? { pledge } : {}) };
  if (gaps.length < 3 || !last) return base;
  const from = last + quantile(gaps, 0.25) * DAY_MS;
  const to = last + quantile(gaps, 0.75) * DAY_MS;
  const expected = last + quantile(gaps, 0.5) * DAY_MS;
  return { ...base, medianDays: quantile(gaps, 0.5), from: new Date(from).toISOString(), to: new Date(to).toISOString(), expectedAt: new Date(expected).toISOString(), overdue: now > to };
}

export function calendarEvents(providers: Pick<ProviderSnapshot, 'provider' | 'name' | 'quotas' | 'quotasObservedAt'>[], history: ResetEvent[], posts: ResetPost[], now = Date.now()): ResetEvent[] {
  const events = [...history];
  for (const p of providers) {
    // A stale log must not manufacture a future reset schedule.
    const observed = Date.parse(p.quotasObservedAt ?? '');
    if (!Number.isFinite(observed) || observed > now + 60_000 || now - observed > 30 * 60_000) continue;
    for (const q of p.quotas) {
      const at = Date.parse(q.resetsAt ?? '');
      if (!Number.isFinite(at) || at <= now) continue;
      events.push({ id: `${p.provider}:${q.id}:${at}`, provider: p.provider, label: q.label, at: new Date(at).toISOString(), kind: 'scheduled' });
      // Weekly recurrence only; rolling sessions start when the account is used again.
      if (q.kind === 'weekly' && q.windowMinutes && q.windowMinutes >= 1440) {
        for (let t = at + q.windowMinutes * 60_000; t < now + 42 * DAY_MS; t += q.windowMinutes * 60_000) {
          events.push({ id: `${p.provider}:${q.id}:${t}`, provider: p.provider, label: q.label, at: new Date(t).toISOString(), kind: 'estimated' });
        }
      }
    }
  }
  for (const p of posts) if (p.kind !== 'update') events.push({ id: p.id, provider: 'openai', label: 'Tibo', at: p.postedAt, kind: p.kind, url: p.url, source: p.source });
  return events.filter((e) => Number.isFinite(Date.parse(e.at))).sort((a, b) => a.at.localeCompare(b.at));
}

/** Small, attributed starting history, collected 2026-10-07. Live fetches replace matching records. */
export const RESET_POSTS: ResetPost[] = [
  ['2098685367058612394', '2026-09-12T08:09:00Z', 'reset', 'Usage reset rollout completed.'],
  ['2103911959544610829', '2026-09-26T18:17:00Z', 'reset', 'Usage reset rollout completed after a disruption.'],
  ['2106131810921136451', '2026-10-02T21:18:00Z', 'reset', 'Global reset rollout completed.'],
  ['2107676072871600470', '2026-10-07T03:35:00Z', 'reset', 'A reset was processed following the community vote.'],
].map(([id, postedAt, kind, text]) => ({ id, postedAt, kind: kind as 'reset', text, url: `https://x.com/thsottiaux/status/${id}`, source: 'reference', referenceUrl: 'https://opentherank.com/codex-reset/' }));
RESET_POSTS.push({ id: '2106845241357824205', postedAt: '2026-10-04T20:33:00Z', kind: 'pledge', pledgeDays: 28,
  text: 'For 28 days, each day brings a broadly useful improvement or a full reset. This is conditional, not a daily reset schedule.',
  url: 'https://x.com/thsottiaux/status/2106845241357824205', source: 'reference', referenceUrl: 'https://note.com/yyylab/n/nf8c135e69c22' });
