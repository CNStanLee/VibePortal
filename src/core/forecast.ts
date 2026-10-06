import fs from 'node:fs';
import path from 'node:path';
import type { Forecast, QuotaWindow } from '../shared/types';

interface Sample {
  t: number;
  p: number;
  /** resetsAt (ms) identifies the window instance */
  r: number;
}

const KEEP_MS = 8 * 86400_000;
const RECENT_MS = 2 * 3600_000;

/**
 * Remembers how quota percentages move over time so we can project when a
 * window will run out. Persisted so forecasts survive restarts.
 */
export class QuotaHistory {
  private samples = new Map<string, Sample[]>();
  private dirty = false;
  private lastSave = 0;

  constructor(private file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) this.samples.set(k, v as Sample[]);
    } catch {
      /* first run */
    }
  }

  record(key: string, q: QuotaWindow, now = Date.now()) {
    if (!q.resetsAt) return;
    const r = Date.parse(q.resetsAt);
    const list = this.samples.get(key) ?? [];
    const last = list[list.length - 1];
    // one sample per 2 minutes is plenty; always keep changes
    if (last && now - last.t < 120_000 && last.p === q.percent) return;
    list.push({ t: now, p: q.percent, r });
    this.samples.set(key, list.filter((s) => now - s.t < KEEP_MS));
    this.dirty = true;
  }

  forecast(key: string, q: QuotaWindow, now = Date.now()): Forecast | undefined {
    if (!q.resetsAt || !q.windowMinutes) return undefined;
    const resetAt = Date.parse(q.resetsAt);
    const windowStart = resetAt - q.windowMinutes * 60_000;
    const elapsedH = Math.max(0.25, (now - windowStart) / 3600_000);
    const windowRate = q.percent / elapsedH;

    // samples from this window instance (resets_at can jitter by a few seconds)
    const same = (this.samples.get(key) ?? []).filter((s) => Math.abs(s.r - resetAt) < 10 * 60_000 && now - s.t < RECENT_MS);
    let rate = windowRate;
    let basis: Forecast['basis'] = 'window';
    if (same.length >= 1) {
      const first = same[0];
      const spanH = (now - first.t) / 3600_000;
      if (spanH >= 1 / 3 && q.percent >= first.p) {
        const recent = (q.percent - first.p) / spanH;
        // short windows follow the current pace; for long (weekly) windows an idle couple of
        // hours shouldn't hide a heavy week, so only a faster recent pace overrides the average
        if (q.windowMinutes <= 300 || recent > windowRate) {
          rate = recent;
          basis = 'recent';
        }
      }
    }
    const hoursToReset = Math.max(0, (resetAt - now) / 3600_000);
    const projectedAtReset = q.percent + rate * hoursToReset;
    let exhaustAt: string | undefined;
    if (q.percent >= 100) exhaustAt = new Date(now).toISOString();
    else if (rate > 0) {
      const at = now + ((100 - q.percent) / rate) * 3600_000;
      if (at < resetAt) exhaustAt = new Date(at).toISOString();
    }
    return {
      ratePerHour: round(rate),
      basis,
      windowRatePerHour: round(windowRate),
      exhaustAt,
      projectedAtReset: round(projectedAtReset),
      willExhaustBeforeReset: !!exhaustAt,
    };
  }

  save(force = false) {
    if (!this.dirty || (!force && Date.now() - this.lastSave < 60_000)) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.samples)));
      this.dirty = false;
      this.lastSave = Date.now();
    } catch {
      /* non-fatal */
    }
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
