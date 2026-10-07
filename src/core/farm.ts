import fs from 'node:fs';
import path from 'node:path';
import type { ProviderSnapshot } from '../shared/types';
import { FarmError, buyBait, cast, claimAd, reel, sellCrop, sellDuplicates, sellFish, startAd, takeRod, creditUsage, waterField, discardCrop, displayCrop, storeCrop, draw, farmView, harvest, normalizeFarm, plant, uproot, type FarmState, type FarmView } from '../shared/farm';
import { dataDir } from './config';
import { localDate } from './jsonl';

/**
 * The crab farm, kept in ~/.vibeportal/farm.json so the phone and the desktop
 * share one field. Tokens counted are input + output + cache writes (cache reads
 * are cheap re-reads and would dwarf everything else).
 */
export class FarmStore {
  private file = path.join(dataDir(), 'farm.json');
  private state?: FarmState;

  private load(): FarmState {
    if (this.state) return this.state;
    let raw: Partial<FarmState> | null = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* a new farm */
    }
    this.state = normalizeFarm(raw, localDate(Date.now()));
    return this.state;
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 });
    } catch (e) {
      console.warn('[farm] could not save', (e as Error).message);
    }
  }

  /** The farm with today's tokens counted in. */
  view(providers: ProviderSnapshot[] = []): FarmView {
    const s = this.load();
    const before = JSON.stringify(s.days);
    creditUsage(s, farmDaily(providers));
    if (JSON.stringify(s.days) !== before) this.save();
    return farmView(s);
  }

  /** Someone watered the farm through its share link. */
  water(minutes: number): number {
    const n = waterField(this.load(), minutes);
    if (n) this.save();
    return n;
  }

  /** draw | plant | harvest | uproot | store | display | discard | sell | sell-dupes | sell-fish | rod | bait | cast | reel | ad | ad-claim */
  act(action: string, body: any, providers: ProviderSnapshot[] = []): { farm: FarmView; result?: unknown } {
    const s = this.load();
    creditUsage(s, farmDaily(providers));
    let result: unknown;
    switch (action) {
      case 'draw':
        result = draw(s, Number(body?.count) || 1);
        break;
      case 'plant':
        plant(s, Number(body?.plot), String(body?.seedId ?? ''));
        break;
      case 'harvest':
        result = harvest(s, Number(body?.plot));
        break;
      case 'uproot':
        uproot(s, Number(body?.plot));
        break;
      case 'store':
        storeCrop(s, String(body?.cropId ?? ''));
        break;
      case 'display':
        displayCrop(s, String(body?.cropId ?? ''));
        break;
      case 'discard':
        discardCrop(s, String(body?.cropId ?? ''));
        break;
      case 'sell':
        result = sellCrop(s, String(body?.cropId ?? ''));
        break;
      case 'sell-dupes':
        result = sellDuplicates(s);
        break;
      case 'sell-fish':
        result = sellFish(s, Array.isArray(body?.ids) ? body.ids.map(String) : undefined);
        break;
      case 'rod':
        takeRod(s, String(body?.rod ?? ''));
        break;
      case 'bait':
        buyBait(s, Number(body?.packs) || 1);
        break;
      case 'cast':
        result = cast(s);
        break;
      case 'reel':
        result = reel(s, String(body?.castId ?? ''));
        break;
      case 'ad':
        result = startAd(s);
        break;
      case 'ad-claim':
        result = claimAd(s, String(body?.id ?? ''));
        break;
      default:
        throw new FarmError('unknown farm action');
    }
    this.save();
    return { farm: farmView(s), result };
  }
}

/** Billable-ish tokens per local day, all providers together. */
export function farmDaily(providers: ProviderSnapshot[]): { date: string; tokens: number }[] {
  const by = new Map<string, number>();
  for (const p of providers) for (const d of p.daily ?? []) by.set(d.date, (by.get(d.date) ?? 0) + d.totals.input + d.totals.output + d.totals.cacheWrite);
  return [...by].map(([date, tokens]) => ({ date, tokens }));
}
