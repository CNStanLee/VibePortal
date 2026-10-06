/*
 * The crab farm: tokens you burn earn seed draws; seeds grow into plants that
 * are only there to look at. Pure state functions, shared by the server (which
 * keeps the farm in ~/.vibeportal/farm.json) and the UI's demo mode.
 */

export type Rarity = 'common' | 'fine' | 'rare' | 'epic' | 'legendary' | 'mythic';
export const RARITIES: Rarity[] = ['common', 'fine', 'rare', 'epic', 'legendary', 'mythic'];
/** draw odds, in percent */
export const RARITY_ODDS: Record<Rarity, number> = { common: 55, fine: 28, rare: 11, epic: 4.5, legendary: 1.4, mythic: 0.1 };

export type SeedColor = 'red' | 'orange' | 'yellow' | 'pink' | 'purple' | 'blue' | 'white' | 'black' | 'gold' | 'rainbow';
export const BASE_COLORS: SeedColor[] = ['red', 'orange', 'yellow', 'pink', 'purple', 'blue', 'white'];
/** colors that only turn up on better seeds */
export const SPECIAL_COLORS: SeedColor[] = ['black', 'gold', 'rainbow'];

export interface Species {
  id: string;
  rarity: Rarity;
  zh: string;
  en: string;
  /** minutes from planting to ripe */
  grow: number;
}
export const SPECIES: Species[] = [
  { id: 'daisy', rarity: 'common', zh: '雏菊', en: 'Daisy', grow: 15 },
  { id: 'clover', rarity: 'common', zh: '三叶草', en: 'Clover', grow: 20 },
  { id: 'tulip', rarity: 'common', zh: '郁金香', en: 'Tulip', grow: 25 },
  { id: 'dandelion', rarity: 'common', zh: '蒲公英', en: 'Dandelion', grow: 30 },
  { id: 'mushroom', rarity: 'common', zh: '蘑菇', en: 'Mushroom', grow: 35 },
  { id: 'carrot', rarity: 'common', zh: '胡萝卜', en: 'Carrot', grow: 40 },
  { id: 'lavender', rarity: 'fine', zh: '薰衣草', en: 'Lavender', grow: 60 },
  { id: 'strawberry', rarity: 'fine', zh: '大草莓', en: 'Strawberry', grow: 75 },
  { id: 'bamboo', rarity: 'fine', zh: '翠竹', en: 'Bamboo', grow: 80 },
  { id: 'sunflower', rarity: 'fine', zh: '向日葵', en: 'Sunflower', grow: 90 },
  { id: 'pumpkin', rarity: 'fine', zh: '南瓜', en: 'Pumpkin', grow: 105 },
  { id: 'cactus', rarity: 'fine', zh: '仙人掌', en: 'Cactus', grow: 120 },
  { id: 'rose', rarity: 'rare', zh: '玫瑰', en: 'Rose', grow: 180 },
  { id: 'lotus', rarity: 'rare', zh: '睡莲', en: 'Lotus', grow: 210 },
  { id: 'orchid', rarity: 'rare', zh: '蝴蝶兰', en: 'Orchid', grow: 240 },
  { id: 'venus', rarity: 'rare', zh: '捕蝇草', en: 'Venus flytrap', grow: 270 },
  { id: 'bonsai', rarity: 'rare', zh: '盆景松', en: 'Bonsai pine', grow: 300 },
  { id: 'crystal', rarity: 'epic', zh: '水晶花', en: 'Crystal bloom', grow: 480 },
  { id: 'glowshroom', rarity: 'epic', zh: '荧光菇', en: 'Glowshroom', grow: 540 },
  { id: 'coral', rarity: 'epic', zh: '珊瑚树', en: 'Coral tree', grow: 600 },
  { id: 'cherry', rarity: 'epic', zh: '樱花树', en: 'Cherry blossom', grow: 720 },
  { id: 'crabclaw', rarity: 'legendary', zh: '蟹爪兰', en: 'Crab-claw cactus', grow: 1080 },
  { id: 'phoenix', rarity: 'legendary', zh: '凤凰木', en: 'Phoenix flame tree', grow: 1260 },
  { id: 'startree', rarity: 'legendary', zh: '星辰树', en: 'Star tree', grow: 1440 },
  { id: 'moonflower', rarity: 'mythic', zh: '月下美人', en: 'Moonflower', grow: 2880 },
  { id: 'dragonblood', rarity: 'mythic', zh: '龙血树', en: 'Dragon’s blood tree', grow: 3600 },
  { id: 'worldtree', rarity: 'mythic', zh: '世界树', en: 'World tree', grow: 4320 },
];

/** Minutes a species takes from seed to ripe. */
export function growMinutes(speciesId: string): number {
  return speciesOf(speciesId).grow;
}

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
const MAX_STORED = 2000;
/** chance a harvest comes out one quality better than its seed */
export const MUTATION = 0.08;
/** ...but a legendary only turns mythic this rarely */
export const MYTHIC_MUTATION = 0.01;

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
  /** draws since the last legendary (or better) */
  pity: number;
  seeds: Seed[];
  plots: Plot[];
  /** the showcase */
  crops: Crop[];
  /** plants taken off the showcase, kept in the storehouse */
  stored: Crop[];
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
  return { v: 1, startDate: today, days: {}, spentTokens: 0, draws: 0, pity: 0, seeds: [], plots: emptyPlots(), crops: [], stored: [] };
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
    stored: Array.isArray(s.stored) ? s.stored : [],
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
  // the odds are percentages with decimals: scale by their actual sum so float drift can't skip a tier
  let x = rnd() * RARITIES.reduce((n, r) => n + RARITY_ODDS[r], 0);
  for (const r of RARITIES) {
    x -= RARITY_ODDS[r];
    if (x < 0) return r;
  }
  return 'common';
}

function rollColor(rarity: Rarity, rnd: () => number): SeedColor {
  const i = RARITIES.indexOf(rarity);
  const x = rnd();
  if (rarity === 'mythic') return x < 0.25 ? 'rainbow' : x < 0.5 ? 'gold' : x < 0.6 ? 'black' : pick(BASE_COLORS, rnd);
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
    // pity promises a legendary, never a mythic (a mythic that turns up by luck stands)
    if (s.pity + 1 >= PITY && r !== 'mythic') r = 'legendary';
    s.pity = r === 'legendary' || r === 'mythic' ? 0 : s.pity + 1;
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
  s.plots[plot] = { seed, plantedAt: now, readyAt: now + growMinutes(seed.species) * 60_000 };
}

export function harvest(s: FarmState, plot: number, now = Date.now(), rnd: () => number = Math.random): Crop {
  const p = plotAt(s, plot);
  if (!p.seed || !p.readyAt) throw new FarmError('nothing grows there');
  if (now < p.readyAt) throw new FarmError('not ripe yet');
  if (s.crops.length >= MAX_CROPS) throw new FarmError('the showcase is full — move some plants to the storehouse first');
  const i = RARITIES.indexOf(p.seed.rarity);
  const up = RARITIES[i + 1];
  const mutated = !!up && rnd() < (up === 'mythic' ? MYTHIC_MUTATION : MUTATION);
  const crop: Crop = { id: uid(rnd), species: p.seed.species, rarity: RARITIES[mutated ? i + 1 : i], color: p.seed.color, harvestedAt: now, ...(mutated ? { mutated } : {}) };
  s.crops.push(crop);
  s.plots[plot] = {};
  return crop;
}

/** A visitor waters the field: every growing plant gets `minutes` closer to ripe. Returns how many grew. */
export function waterField(s: FarmState, minutes: number, now = Date.now()): number {
  let n = 0;
  for (const p of s.plots) {
    if (!p.seed || !p.readyAt || p.readyAt <= now) continue;
    p.readyAt = Math.max(now, p.readyAt - minutes * 60_000);
    n++;
  }
  return n;
}

/** Digs a plant up before it is ripe: the seed goes back into the bag. */
export function uproot(s: FarmState, plot: number) {
  const p = plotAt(s, plot);
  if (!p.seed) return;
  s.seeds.push(p.seed);
  s.plots[plot] = {};
}

/** Takes a plant off the showcase into the storehouse. */
export function storeCrop(s: FarmState, cropId: string) {
  const i = s.crops.findIndex((c) => c.id === cropId);
  if (i < 0) throw new FarmError('no such plant on the showcase');
  if (s.stored.length >= MAX_STORED) throw new FarmError('the storehouse is full — give some plants away first');
  s.stored.push(...s.crops.splice(i, 1));
}

/** Puts a plant from the storehouse back on the showcase. */
export function displayCrop(s: FarmState, cropId: string) {
  const i = s.stored.findIndex((c) => c.id === cropId);
  if (i < 0) throw new FarmError('no such plant in the storehouse');
  if (s.crops.length >= MAX_CROPS) throw new FarmError('the showcase is full — move some plants to the storehouse first');
  s.crops.push(...s.stored.splice(i, 1));
}

/** Gives a plant away for good. */
export function discardCrop(s: FarmState, cropId: string) {
  s.crops = s.crops.filter((c) => c.id !== cropId);
  s.stored = s.stored.filter((c) => c.id !== cropId);
}

/** Every plant you own: the showcase and the storehouse. */
export const allCrops = (s: Pick<FarmState, 'crops' | 'stored'>): Crop[] => [...s.crops, ...s.stored];

export function speciesOf(id: string): Species {
  return SPECIES.find((x) => x.id === id) ?? SPECIES[0];
}

/** Growth stage for drawing: 0 seed, 1 sprout, 2 budding, 3 ripe. */
export function stageOf(p: Plot, now: number): 0 | 1 | 2 | 3 {
  if (!p.plantedAt || !p.readyAt) return 0;
  const f = (now - p.plantedAt) / (p.readyAt - p.plantedAt);
  return f >= 1 ? 3 : f >= 0.55 ? 2 : f >= 0.15 ? 1 : 0;
}
