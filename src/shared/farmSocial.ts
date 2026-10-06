/*
 * The farm's social side: a farmer profile (GitHub, LinkedIn, X, a website), an
 * opt-in public farm others can visit and water through its share link, and
 * friends' farms fetched from their own VibePortal. Pure helpers and types,
 * shared by the server and the UI.
 */
import { BASE_COLORS, RARITIES, SPECIAL_COLORS, SPECIES, allCrops, colorsFor, type Crop, type FarmView, type Rarity, type SeedColor } from './farm';

export interface FarmProfile {
  name: string;
  bio?: string;
  /** GitHub user name (the avatar comes from github.com/<name>.png) */
  github?: string;
  /** full profile URL, https://www.linkedin.com/in/… */
  linkedin?: string;
  /** X / Twitter handle */
  x?: string;
  website?: string;
}

export interface PublicCrop {
  species: string;
  color: SeedColor;
  rarity: Rarity;
  mutated?: boolean;
}

export interface Visitor {
  name: string;
  github?: string;
  /** their own farm, to visit back */
  farm?: string;
  at: number;
}

/** What a share link shows: no tokens, tasks or anything else of the machine. */
export interface PublicFarm {
  v: 1;
  id: string;
  profile: FarmProfile;
  score: number;
  crops: number;
  byRarity: Partial<Record<Rarity, number>>;
  dex: { found: number; total: number };
  /** the showcase's best plants */
  best: PublicCrop[];
  field: (PublicCrop & { plantedAt: number; readyAt: number })[];
  /** tokens this farm was grown from */
  earnedTokens: number;
  waters: { today: number; max: number };
  visitors: Visitor[];
  /** how many farmer friends this farm keeps */
  friends?: number;
  now: number;
}

/** The owner's view of the social settings. */
export interface FarmSocialView {
  profile: FarmProfile;
  public: boolean;
  shareId?: string;
  /** base URL others can reach this machine at (a tunnel / public URL), when there is one */
  publicUrl?: string;
  visitors: Visitor[];
  friends: { url: string; addedAt: number }[];
}

export interface FriendFarm {
  url: string;
  farm?: PublicFarm;
  error?: string;
}

/** how much each watering speeds every growing plant up */
export const WATER_MINUTES = 20;
/** waterings a farm takes per day, from everyone together */
export const WATERS_PER_DAY = 30;
export const RARITY_SCORE: Record<Rarity, number> = { common: 1, fine: 2, rare: 5, epic: 12, legendary: 30, mythic: 100 };
export const MAX_FRIENDS = 50;
/** where to get VibePortal, for share cards and captions */
export const REPO_URL = 'https://github.com/CNStanLee/VibePortal';

export function farmScore(crops: Pick<Crop, 'rarity' | 'mutated'>[]): number {
  return crops.reduce((n, c) => n + (RARITY_SCORE[c.rarity] ?? 0) + (c.mutated ? 1 : 0), 0);
}

export function dexOf(crops: Pick<Crop, 'species' | 'color'>[]): { found: number; total: number } {
  const total = SPECIES.reduce((n, s) => n + colorsFor(s.rarity).length, 0);
  return { found: new Set(crops.map((c) => `${c.species}|${c.color}`)).size, total };
}

const rank = (r: Rarity) => RARITIES.indexOf(r);

/** The public card of a farm. */
export function publicFarm(id: string, profile: FarmProfile, farm: FarmView, extra: { waterToday: number; visitors: Visitor[]; friends?: number }): PublicFarm {
  // score and counts take in the storehouse too; the best plants are the ones on show
  const owned = allCrops(farm);
  const byRarity: Partial<Record<Rarity, number>> = {};
  for (const c of owned) byRarity[c.rarity] = (byRarity[c.rarity] ?? 0) + 1;
  // one of each kind first, best first: a showcase of 300 tulips shouldn't hide the one rose
  const seen = new Set<string>();
  const best = [...farm.crops]
    .sort((a, b) => rank(b.rarity) - rank(a.rarity) || b.harvestedAt - a.harvestedAt)
    .filter((c) => {
      const k = `${c.species}|${c.color}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 12)
    .map(({ species, color, rarity, mutated }) => ({ species, color, rarity, ...(mutated ? { mutated } : {}) }));
  return {
    v: 1,
    id,
    profile,
    score: farmScore(owned),
    crops: owned.length,
    byRarity,
    dex: dexOf(owned),
    best,
    field: farm.plots.flatMap((p) => (p.seed && p.plantedAt && p.readyAt ? [{ species: p.seed.species, color: p.seed.color, rarity: p.seed.rarity, plantedAt: p.plantedAt, readyAt: p.readyAt }] : [])),
    earnedTokens: farm.earnedTokens,
    waters: { today: extra.waterToday, max: WATERS_PER_DAY },
    visitors: extra.visitors.slice(0, 12),
    ...(extra.friends ? { friends: extra.friends } : {}),
    now: farm.now,
  };
}

// ── input cleaning (profiles and visitors come from forms and from other people) ──

const plain = (s: unknown, max: number) =>
  typeof s === 'string'
    ? s
        .replace(/[\u0000-\u001f\u007f<>]/g, '')
        .trim()
        .slice(0, max)
    : '';

export function cleanGithub(s: unknown): string | undefined {
  const v = plain(s, 120)
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '');
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(v) ? v : undefined;
}

export function cleanLinkedin(s: unknown): string | undefined {
  const v = plain(s, 200);
  if (!v) return undefined;
  const m = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(in|company)\/([A-Za-z0-9_%-]{2,100})\/?/i.exec(v);
  if (m) return `https://www.linkedin.com/${m[1].toLowerCase()}/${m[2]}`;
  return /^[A-Za-z0-9_-]{3,100}$/.test(v) ? `https://www.linkedin.com/in/${v}` : undefined;
}

export function cleanX(s: unknown): string | undefined {
  const v = plain(s, 120)
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^@/, '')
    .replace(/[/?].*$/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(v) ? v : undefined;
}

export function cleanUrl(s: unknown): string | undefined {
  const v = plain(s, 300);
  if (!v) return undefined;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function cleanProfile(p: any, fallbackName = 'Crab farmer'): FarmProfile {
  const out: FarmProfile = { name: plain(p?.name, 40) || fallbackName };
  const bio = plain(p?.bio, 120);
  if (bio) out.bio = bio;
  const gh = cleanGithub(p?.github);
  if (gh) out.github = gh;
  const li = cleanLinkedin(p?.linkedin);
  if (li) out.linkedin = li;
  const x = cleanX(p?.x);
  if (x) out.x = x;
  const w = cleanUrl(p?.website);
  if (w) out.website = w;
  return out;
}

export function cleanVisitor(v: any, now: number): Visitor {
  const out: Visitor = { name: plain(v?.name, 40) || 'A passing crab', at: now };
  const gh = cleanGithub(v?.github);
  if (gh) out.github = gh;
  const farm = v?.farm ? parseFarmLink(String(v.farm)) : undefined;
  if (farm) out.farm = farm.link;
  return out;
}

export const SHARE_ID = /^[a-z0-9]{16,32}$/;

/**
 * A farm link → where its public card lives. Takes the visit link someone shares
 * (`https://host/#/visit/<id>`, also with a path or query in front) or the API URL.
 */
export function parseFarmLink(s: string): { base: string; id: string; link: string; api: string } | undefined {
  let u: URL;
  try {
    u = new URL(s.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const m = /#\/visit\/([a-z0-9]+)/.exec(u.hash) ?? /\/api\/public\/farm\/([a-z0-9]+)/.exec(u.pathname);
  if (!m || !SHARE_ID.test(m[1])) return undefined;
  const id = m[1];
  // the app's own path (behind a reverse proxy it may not be /)
  const basePath = u.hash ? u.pathname.replace(/[^/]*$/, '') : u.pathname.slice(0, u.pathname.indexOf('/api/public/farm/') + 1);
  const base = `${u.origin}${basePath}`;
  return { base, id, link: farmLink(base, id), api: `${base}api/public/farm/${id}` };
}

export const farmLink = (base: string, id: string) => `${base.endsWith('/') ? base : base + '/'}#/visit/${id}`;

const num = (x: unknown, max = Number.MAX_SAFE_INTEGER) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(max, x)) : 0);
const COLOR_SET = new Set<string>([...BASE_COLORS, ...SPECIAL_COLORS]);
const cleanCrop = (c: any): PublicCrop | undefined =>
  c && typeof c.species === 'string' && /^[a-z]{1,24}$/.test(c.species) && RARITIES.includes(c.rarity) && COLOR_SET.has(c.color)
    ? { species: c.species, color: c.color, rarity: c.rarity, ...(c.mutated ? { mutated: true } : {}) }
    : undefined;

/** A farm card that came from someone else's machine: keep only well-formed fields. */
export function cleanPublicFarm(f: any, id: string): PublicFarm {
  if (f?.v !== 1 || f.id !== id) throw new Error('not a VibePortal farm');
  const byRarity: Partial<Record<Rarity, number>> = {};
  for (const r of RARITIES) if (f.byRarity?.[r]) byRarity[r] = num(f.byRarity[r], 1e6);
  return {
    v: 1,
    id,
    profile: cleanProfile(f.profile),
    score: num(f.score, 1e9),
    crops: num(f.crops, 1e6),
    byRarity,
    dex: { found: num(f.dex?.found, 1e4), total: num(f.dex?.total, 1e4) },
    best: (Array.isArray(f.best) ? f.best : []).slice(0, 12).map(cleanCrop).filter(Boolean) as PublicCrop[],
    field: (Array.isArray(f.field) ? f.field : [])
      .slice(0, 9)
      .map((p: any) => {
        const c = cleanCrop(p);
        return c && { ...c, plantedAt: num(p.plantedAt), readyAt: num(p.readyAt) };
      })
      .filter(Boolean),
    earnedTokens: num(f.earnedTokens),
    waters: { today: num(f.waters?.today, 1e4), max: num(f.waters?.max, 1e4) },
    visitors: (Array.isArray(f.visitors) ? f.visitors : []).slice(0, 12).map((v: any) => ({ ...cleanVisitor(v, num(v?.at)) })),
    now: num(f.now) || Date.now(),
  };
}
