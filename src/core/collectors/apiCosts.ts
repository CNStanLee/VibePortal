import type { CostSummary, SourceStatus } from '../../shared/types';

/**
 * Optional: organisation-level API spend via admin keys.
 *  - Anthropic: GET /v1/organizations/cost_report (amounts are USD decimal strings in cents)
 *  - OpenAI:    GET /v1/organization/costs        (amount.value is in dollars)
 * Neither endpoint is covered by the official SDKs, so plain fetch is used.
 */
export class ApiCostCollector {
  anthropic?: CostSummary;
  openai?: CostSummary;
  anthropicStatus: SourceStatus = { id: 'anthropic-admin', label: 'Anthropic Admin API', state: 'disabled', message: 'No admin key configured' };
  openaiStatus: SourceStatus = { id: 'openai-admin', label: 'OpenAI Admin API', state: 'disabled', message: 'No admin key configured' };

  async collect(keys: { anthropic: string; openai: string }, days: number) {
    const span = Math.min(31, Math.max(1, days));
    await Promise.all([this.collectAnthropic(keys.anthropic, span), this.collectOpenAI(keys.openai, span)]);
  }

  private async collectAnthropic(key: string, days: number) {
    if (!key) {
      this.anthropic = undefined;
      this.anthropicStatus = { ...this.anthropicStatus, state: 'disabled', message: 'No admin key configured' };
      return;
    }
    try {
      const start = startOfDayUtc(days);
      const daily = new Map<string, number>();
      let page: string | undefined;
      for (let i = 0; i < 10; i++) {
        const url = new URL('https://api.anthropic.com/v1/organizations/cost_report');
        url.searchParams.set('starting_at', start.toISOString());
        url.searchParams.set('bucket_width', '1d');
        url.searchParams.set('limit', '31');
        if (page) url.searchParams.set('page', page);
        const res = await fetch(url, {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`cost_report → HTTP ${res.status}`);
        const body: any = await res.json();
        for (const bucket of body.data ?? []) {
          const date = String(bucket.starting_at ?? '').slice(0, 10);
          let cents = 0;
          for (const r of bucket.results ?? []) cents += parseFloat(r.amount ?? '0') || 0;
          daily.set(date, (daily.get(date) ?? 0) + cents / 100);
        }
        if (!body.has_more || !body.next_page) break;
        page = body.next_page;
      }
      this.anthropic = summarize(daily, days);
      this.anthropicStatus = { ...this.anthropicStatus, state: 'ok', message: undefined, updatedAt: new Date().toISOString() };
    } catch (e) {
      this.anthropicStatus = { ...this.anthropicStatus, state: 'error', message: (e as Error).message, updatedAt: new Date().toISOString() };
    }
  }

  private async collectOpenAI(key: string, days: number) {
    if (!key) {
      this.openai = undefined;
      this.openaiStatus = { ...this.openaiStatus, state: 'disabled', message: 'No admin key configured' };
      return;
    }
    try {
      const start = Math.floor(startOfDayUtc(days).getTime() / 1000);
      const daily = new Map<string, number>();
      let page: string | undefined;
      for (let i = 0; i < 10; i++) {
        const url = new URL('https://api.openai.com/v1/organization/costs');
        url.searchParams.set('start_time', String(start));
        url.searchParams.set('bucket_width', '1d');
        url.searchParams.set('limit', String(days));
        if (page) url.searchParams.set('page', page);
        const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`organization/costs → HTTP ${res.status}`);
        const body: any = await res.json();
        for (const bucket of body.data ?? []) {
          const date = new Date((bucket.start_time ?? 0) * 1000).toISOString().slice(0, 10);
          let usd = 0;
          for (const r of bucket.results ?? []) usd += Number(r.amount?.value ?? 0) || 0;
          daily.set(date, (daily.get(date) ?? 0) + usd);
        }
        if (!body.has_more || !body.next_page) break;
        page = body.next_page;
      }
      this.openai = summarize(daily, days);
      this.openaiStatus = { ...this.openaiStatus, state: 'ok', message: undefined, updatedAt: new Date().toISOString() };
    } catch (e) {
      this.openaiStatus = { ...this.openaiStatus, state: 'error', message: (e as Error).message, updatedAt: new Date().toISOString() };
    }
  }
}

function startOfDayUtc(daysBack: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (daysBack - 1));
  return d;
}

function summarize(daily: Map<string, number>, days: number): CostSummary {
  const rows = [...daily.entries()].map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date));
  return { amount: rows.reduce((s, r) => s + r.amount, 0), periodDays: days, daily: rows };
}
