/*
 * The crab farm: tokens you burn earn seed draws; seeds grow into plants that
 * are only there to look at. Pure state functions, shared by the server (which
 * keeps the farm in ~/.vibeportal/farm.json) and the UI's demo mode.
 */

export type Rarity = 'common' | 'fine' | 'rare' | 'epic' | 'legendary';
export const RARITIES: Rarity[] = ['common', 'fine', 'rare', 'epic', 'legendary'];
/** draw odds, in percent */
export const RARITY_ODDS: Record<Rarity, number> = { common: 58, fine: 27, rare: 10, epic: 4, legendary: 1 };
export const GROW_MINUTES: Record<Rarity, number> = { common: 20, fine: 45, rare: 90, epic: 180, legendary: 360 };

export type SeedColor = 'red' | 'orange' | 'yellow' | 'pink' | 'purple' | 'blue' | 'white' | 'black' | 'gold' | 'rainbow';
export const BASE_COLORS: SeedColor[] = ['red', 'orange', 'yellow', 'pink', 'purple', 'blue', 'white'];
/** colors that only turn up on better seeds */
export const SPECIAL_COLORS: SeedColor[] = ['black', 'gold', 'rainbow'];

export interface Species {
  id: string;
  rarity: Rarity;
  zh: string;
  en: string;
}
export const SPECIES: Species[] = [
  { id: 'tulip', rarity: 'common', zh: '郁金香', en: 'Tulip' },
  { id: 'daisy', rarity: 'common', zh: '雏菊', en: 'Daisy' },
  { id: 'mushroom', rarity: 'common', zh: '蘑菇', en: 'Mushroom' },
  { id: 'sunflower', rarity: 'fine', zh: '向日葵', en: 'Sunflower' },
  { id: 'cactus', rarity: 'fine', zh: '仙人掌', en: 'Cactus' },
  { id: 'strawberry', rarity: 'fine', zh: '大草莓', en: 'Strawberry' },
  { id: 'rose', rarity: 'rare', zh: '玫瑰', en: 'Rose' },
  { id: 'lotus', rarity: 'rare', zh: '睡莲', en: 'Lotus' },
  { id: 'crystal', rarity: 'epic', zh: '水晶花', en: 'Crystal bloom' },
  { id: 'coral', rarity: 'epic', zh: '珊瑚树', en: 'Coral tree' },
  { id: 'crabclaw', rarity: 'legendary', zh: '蟹爪兰', en: 'Crab-claw cactus' },
  { id: 'startree', rarity: 'legendary', zh: '星辰树', en: 'Star tree' },
];

/** Colors a species can come in, by its rarity. */
export function colorsFor(rarity: Rarity): SeedColor[] {
  const i = RARITIES.indexOf(rarity);
  return [...BASE_COLORS, ...(i >= 2 ? ['black' as const] : []), ...(i >= 3 ? ['gold' as const] : []), ...(i >= 3 ? ['rainbow' as const] : [])];
}

export const TOKENS_PER_DRAW = 500_000;
/** a ten-draw costs the same as ten single draws but always holds a rare or better */
export const MULTI_DRAW = 10;
/** draws on the house when the farm opens */
export const WELCOME_DRAWS = 3;
/** a legendary is guaranteed by this many draws without one */
export const PITY = 80;
export const PLOTS = 9;
const MAX_SEEDS = 300;
const MAX_CROPS = 400;
/** chance a harvest comes out one quality better than its seed */
export const MUTATION = 0.08;

export interface Seed {
  id: string;
  species: string;
  rarity: Rarity;
  color: SeedColor;
}
export interface Plot {
  seed?: Seed;
  plantedAt?: number;
  readyAt?: number;
}
export interface Crop {
  id: string;
  species: string;
  /** quality of the plant (the seed's, or one better when it mutated) */
  rarity: Rarity;
  color: SeedColor;
  mutated?: boolean;
  harvestedAt: number;
}

export interface FarmState {
  v: 1;
  /** first day whose tokens count (local YYYY-MM-DD) */
  startDate: string;
  /** tokens per local day, highest seen, so days rolling out of the usage history keep counting */
  days: Record<string, number>;
  spentTokens: number;
  draws: number;
  /** draws since the last legendary */
  pity: number;
  seeds: Seed[];
  plots: Plot[];
  crops: Crop[];
}

export interface FarmView extends FarmState {
  earnedTokens: number;
  /** tokens left to spend (welcome draws included) */
  balance: number;
  tokensPerDraw: number;
  drawsAvailable: number;
  now: number;
}

export class FarmError extends Error {
  status = 400;
}

export function newFarm(today: string): FarmState {
  return { v: 1, startDate: today, days: {}, spentTokens: 0, draws: 0, pity: 0, seeds: [], plots: emptyPlots(), crops: [] };
}

const emptyPlots = (): Plot[] => Array.from({ length: PLOTS }, () => ({}));

/** Fills in fields an older or hand-edited farm file lacks. */
export function normalizeFarm(s: Partial<FarmState> | null | undefined, today: string): FarmState {
  const base = newFarm(today);
  if (!s || typeof s !== 'object') return base;
  const plots = Array.isArray(s.plots) ? s.plots.slice(0, PLOTS) : [];
  while (plots.length < PLOTS) plots.push({});
  return {
    ...base,
    ...s,
    v: 1,
    days: s.days && typeof s.days === 'object' ? s.days : {},
    seeds: Array.isArray(s.seeds) ? s.seeds : [],
    crops: Array.isArray(s.crops) ? s.crops : [],
    plots,
  };
}

/** Counts each day's tokens (from the farm's first day on). */
export function creditUsage(s: FarmState, daily: { date: string; tokens: number }[]) {
  for (const d of daily) {
    if (d.date < s.startDate || !(d.tokens > 0)) continue;
    s.days[d.date] = Math.max(s.days[d.date] ?? 0, Math.round(d.tokens));
  }
}

export function farmView(s: FarmState, now = Date.now()): FarmView {
  const earnedTokens = Object.values(s.days).reduce((a, b) => a + b, 0);
  const balance = earnedTokens + WELCOME_DRAWS * TOKENS_PER_DRAW - s.spentTokens;
  return { ...s, earnedTokens, balance, tokensPerDraw: TOKENS_PER_DRAW, drawsAvailable: Math.max(0, Math.floor(balance / TOKENS_PER_DRAW)), now };
}

const uid = (rnd: () => number) => Date.now().toString(36) + Math.floor(rnd() * 1e9).toString(36);
const pick = <T>(list: T[], rnd: () => number): T => list[Math.min(list.length - 1, Math.floor(rnd() * list.length))];

function rollRarity(rnd: () => number): Rarity {
  let x = rnd() * 100;
  for (const r of RARITIES) {
    x -= RARITY_ODDS[r];
    if (x < 0) return r;
  }
  return 'common';
}

function rollColor(rarity: Rarity, rnd: () => number): SeedColor {
  const i = RARITIES.indexOf(rarity);
  const x = rnd();
  if (i >= 4 && x < 0.12) return 'rainbow';
  if (i >= 3 && x < 0.04) return 'rainbow';
  if (i >= 3 && x < 0.12) return 'gold';
  if (i >= 2 && x < 0.2) return 'black';
  return pick(BASE_COLORS, rnd);
}

function makeSeed(rarity: Rarity, rnd: () => number): Seed {
  const species = pick(
    SPECIES.filter((x) => x.rarity === rarity),
    rnd,
  );
  return { id: uid(rnd), species: species.id, rarity, color: rollColor(rarity, rnd) };
}

/** Spends tokens on 1 or 10 seeds. */
export function draw(s: FarmState, count: number, rnd: () => number = Math.random): Seed[] {
  const n = count === MULTI_DRAW ? MULTI_DRAW : 1;
  if (farmView(s).balance < n * TOKENS_PER_DRAW) throw new FarmError('not enough tokens for that draw yet');
  if (s.seeds.length + n > MAX_SEEDS) throw new FarmError('the seed bag is full — plant some first');
  const out: Seed[] = [];
  for (let k = 0; k < n; k++) {
    let r = rollRarity(rnd);
    if (s.pity + 1 >= PITY) r = 'legendary';
    s.pity = r === 'legendary' ? 0 : s.pity + 1;
    out.push(makeSeed(r, rnd));
  }
  // a ten-draw holds at least one rare
  if (n === MULTI_DRAW && !out.some((x) => RARITIES.indexOf(x.rarity) >= 2)) out[n - 1] = makeSeed('rare', rnd);
  s.spentTokens += n * TOKENS_PER_DRAW;
  s.draws += n;
  s.seeds.push(...out);
  return out;
}

function plotAt(s: FarmState, i: number): Plot {
  const p = s.plots[i];
  if (!Number.isInteger(i) || !p) throw new FarmError('no such plot');
  return p;
}

export function plant(s: FarmState, plot: number, seedId: string, now = Date.now()) {
  const p = plotAt(s, plot);
  if (p.seed) throw new FarmError('that plot is taken');
  const i = s.seeds.findIndex((x) => x.id === seedId);
  if (i < 0) throw new FarmError('no such seed');
  const [seed] = s.seeds.splice(i, 1);
  s.plots[plot] = { seed, plantedAt: now, readyAt: now + GROW_MINUTES[seed.rarity] * 60_000 };
}

export function harvest(s: FarmState, plot: number, now = Date.now(), rnd: () => number = Math.random): Crop {
  const p = plotAt(s, plot);
  if (!p.seed || !p.readyAt) throw new FarmError('nothing grows there');
  if (now < p.readyAt) throw new FarmError('not ripe yet');
  if (s.crops.length >= MAX_CROPS) throw new FarmError('the showcase is full — give some plants away first');
  const i = RARITIES.indexOf(p.seed.rarity);
  const mutated = i < RARITIES.length - 1 && rnd() < MUTATION;
  const crop: Crop = { id: uid(rnd), species: p.seed.species, rarity: RARITIES[mutated ? i + 1 : i], color: p.seed.color, harvestedAt: now, ...(mutated ? { mutated } : {}) };
  s.crops.push(crop);
  s.plots[plot] = {};
  return crop;
}

/** Digs a plant up before it is ripe: the seed goes back into the bag. */
export function uproot(s: FarmState, plot: number) {
  const p = plotAt(s, plot);
  if (!p.seed) return;
  s.seeds.push(p.seed);
  s.plots[plot] = {};
}

export function discardCrop(s: FarmState, cropId: string) {
  s.crops = s.crops.filter((c) => c.id !== cropId);
}

export function speciesOf(id: string): Species {
  return SPECIES.find((x) => x.id === id) ?? SPECIES[0];
}

/** Growth stage for drawing: 0 seed, 1 sprout, 2 budding, 3 ripe. */
export function stageOf(p: Plot, now: number): 0 | 1 | 2 | 3 {
  if (!p.plantedAt || !p.readyAt) return 0;
  const f = (now - p.plantedAt) / (p.readyAt - p.plantedAt);
  return f >= 1 ? 3 : f >= 0.55 ? 2 : f >= 0.15 ? 1 : 0;
}
