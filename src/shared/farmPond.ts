/*
 * The fishing pond next to the crab farm: cast, wait for a bite, reel in. Better
 * rods bring rarer fish; the catch sells for tokens. Catalog and pure helpers
 * only (the state changes live in ./farm, which owns the balance).
 */
import type { Rarity } from './farm';

export type RodId = 'bamboo' | 'carbon' | 'golden' | 'crabking';
export interface Rod {
  id: RodId;
  zh: string;
  en: string;
  /** tokens it costs (the bamboo rod comes with the farm) */
  price: number;
  /** catch odds, in percent */
  odds: Record<Rarity, number>;
  /** seconds until a bite, at least / at most */
  bite: [number, number];
  /** seconds you have to reel in once it bites */
  window: number;
}
export const RODS: Rod[] = [
  { id: 'bamboo', zh: '竹竿', en: 'Bamboo rod', price: 0, odds: { common: 70, fine: 22, rare: 6.5, epic: 1.3, legendary: 0.19, mythic: 0.01 }, bite: [3, 8], window: 2.5 },
  { id: 'carbon', zh: '碳素竿', en: 'Carbon rod', price: 2_000_000, odds: { common: 58, fine: 27, rare: 11, epic: 3.3, legendary: 0.65, mythic: 0.05 }, bite: [2.5, 6], window: 3 },
  { id: 'golden', zh: '鎏金竿', en: 'Golden rod', price: 8_000_000, odds: { common: 45, fine: 30, rare: 16, epic: 7, legendary: 1.8, mythic: 0.2 }, bite: [2, 5], window: 3.5 },
  { id: 'crabking', zh: '蟹王竿', en: 'Crab-king rod', price: 25_000_000, odds: { common: 35, fine: 30, rare: 20, epic: 10.5, legendary: 4, mythic: 0.5 }, bite: [1.5, 4], window: 4 },
];
export const rodOf = (id: string): Rod => RODS.find((r) => r.id === id) ?? RODS[0];

/** one cast takes one bait; a few are free every day */
export const BAIT_PRICE = 20_000;
export const BAIT_PACK = 10;
export const FREE_BAIT_PER_DAY = 5;
/** casts a day, free bait included (the pond is a pastime, not a token mint) */
export const CASTS_PER_DAY = 20;
export const MAX_FISH = 200;
/** grace for the round trip: a reel a little early or late still counts */
export const REEL_GRACE_MS = { early: 300, late: 1500 };

export type FishShape = 'slim' | 'long' | 'round' | 'crab';
export interface FishKind {
  id: string;
  rarity: Rarity;
  zh: string;
  en: string;
  color: string;
  shape: FishShape;
  /** kilograms, lightest / heaviest */
  kg: [number, number];
}
export const FISH: FishKind[] = [
  { id: 'minnow', rarity: 'common', zh: '麦穗鱼', en: 'Minnow', color: '#b9c3b0', shape: 'slim', kg: [0.02, 0.08] },
  { id: 'crucian', rarity: 'common', zh: '鲫鱼', en: 'Crucian carp', color: '#a2a77f', shape: 'slim', kg: [0.2, 0.8] },
  { id: 'loach', rarity: 'common', zh: '泥鳅', en: 'Loach', color: '#8a7650', shape: 'long', kg: [0.05, 0.2] },
  { id: 'bluegill', rarity: 'common', zh: '蓝鳃太阳鱼', en: 'Bluegill', color: '#5c8db5', shape: 'round', kg: [0.1, 0.5] },
  { id: 'carp', rarity: 'fine', zh: '鲤鱼', en: 'Carp', color: '#d39b3a', shape: 'slim', kg: [1, 6] },
  { id: 'catfish', rarity: 'fine', zh: '鲶鱼', en: 'Catfish', color: '#6d705d', shape: 'long', kg: [1, 8] },
  { id: 'perch', rarity: 'fine', zh: '鲈鱼', en: 'Perch', color: '#7fa35a', shape: 'slim', kg: [0.5, 3] },
  { id: 'koi', rarity: 'rare', zh: '锦鲤', en: 'Koi', color: '#f0643a', shape: 'slim', kg: [2, 10] },
  { id: 'trout', rarity: 'rare', zh: '虹鳟', en: 'Rainbow trout', color: '#e490b4', shape: 'slim', kg: [1, 5] },
  { id: 'puffer', rarity: 'rare', zh: '河豚', en: 'Pufferfish', color: '#e6cf6e', shape: 'round', kg: [0.3, 1.5] },
  { id: 'arowana', rarity: 'epic', zh: '金龙鱼', en: 'Golden arowana', color: '#f0b429', shape: 'long', kg: [3, 12] },
  { id: 'sturgeon', rarity: 'epic', zh: '鲟鱼', en: 'Sturgeon', color: '#7d8aa0', shape: 'long', kg: [10, 60] },
  { id: 'oarfish', rarity: 'legendary', zh: '皇带鱼', en: 'Oarfish', color: '#cdd8ec', shape: 'long', kg: [20, 100] },
  { id: 'kingcrab', rarity: 'legendary', zh: '帝王蟹', en: 'King crab', color: '#d9473f', shape: 'crab', kg: [2, 8] },
  { id: 'dragonfish', rarity: 'mythic', zh: '龙鱼', en: 'Dragonfish', color: '#9b6cf0', shape: 'long', kg: [50, 200] },
  { id: 'kun', rarity: 'mythic', zh: '鲲', en: 'Kun', color: '#3b5bdb', shape: 'round', kg: [100, 500] },
];
export const fishKind = (id: string): FishKind => FISH.find((f) => f.id === id) ?? FISH[0];

export interface Fish {
  id: string;
  species: string;
  rarity: Rarity;
  kg: number;
  caughtAt: number;
}

/** today's casts, and the line in the water (if any) */
export interface PondState {
  day: string;
  casts: number;
  /** free bait used today */
  free: number;
  cast?: { id: string; biteAt: number; until: number };
}

/** tokens a fish sells for, by quality, at its average weight */
export const FISH_PRICE: Record<Rarity, number> = { common: 15_000, fine: 35_000, rare: 90_000, epic: 250_000, legendary: 800_000, mythic: 3_000_000 };

/** A fish's price: heavier ones of a kind are worth more (0.6× the lightest, 1.4× the heaviest). */
export function fishPrice(f: Pick<Fish, 'species' | 'rarity' | 'kg'>): number {
  const [lo, hi] = fishKind(f.species).kg;
  const t = hi > lo ? Math.min(1, Math.max(0, (f.kg - lo) / (hi - lo))) : 0.5;
  return Math.round((FISH_PRICE[f.rarity] * (0.6 + 0.8 * t)) / 1000) * 1000;
}

const ORDER: Rarity[] = ['common', 'fine', 'rare', 'epic', 'legendary', 'mythic'];

/** What bites: a quality by the rod's odds, a kind of that quality, a weight (most are on the light side). */
export function rollFish(rod: Rod, rnd: () => number, id: string, now: number): Fish {
  let x = rnd() * ORDER.reduce((n, r) => n + rod.odds[r], 0);
  const rarity = ORDER.find((r) => (x -= rod.odds[r]) < 0) ?? 'common';
  const kinds = FISH.filter((f) => f.rarity === rarity);
  const kind = kinds[Math.min(kinds.length - 1, Math.floor(rnd() * kinds.length))];
  const [lo, hi] = kind.kg;
  const kg = Math.round((lo + (hi - lo) * rnd() ** 2) * 100) / 100;
  return { id, species: kind.id, rarity, kg, caughtAt: now };
}
