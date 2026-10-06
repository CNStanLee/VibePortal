import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FarmView } from '../shared/farm';
import {
  MAX_FRIENDS,
  SHARE_ID,
  WATERS_PER_DAY,
  WATER_MINUTES,
  cleanProfile,
  cleanPublicFarm,
  cleanVisitor,
  farmLink,
  parseFarmLink,
  publicFarm,
  type FarmProfile,
  type FarmSocialView,
  type FriendFarm,
  type PublicFarm,
  type Visitor,
} from '../shared/farmSocial';
import { dataDir } from './config';
import { localDate } from './jsonl';
import { httpError } from './actions';

interface SocialState {
  profile: FarmProfile;
  public: boolean;
  shareId?: string;
  visitors: Visitor[];
  /** waterings today: the day, and who already watered (one each per day) */
  waterDay: string;
  watered: string[];
  friends: { url: string; addedAt: number }[];
}

/**
 * The farm's social side, kept in ~/.vibeportal/farm-social.json: the profile,
 * whether the farm is public (and under which unguessable id), visitors, and
 * friends' farm links. Friends' farms are read from their own VibePortal.
 */
export class FarmSocial {
  private file = path.join(dataDir(), 'farm-social.json');
  private state?: SocialState;
  private friendCache = new Map<string, { at: number; data: FriendFarm }>();

  constructor(private machineName = 'Crab farmer') {}

  private load(): SocialState {
    if (this.state) return this.state;
    let raw: Partial<SocialState> = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) ?? {};
    } catch {
      /* not set up yet */
    }
    this.state = {
      profile: cleanProfile(raw.profile, this.machineName),
      public: raw.public === true && typeof raw.shareId === 'string' && SHARE_ID.test(raw.shareId),
      shareId: typeof raw.shareId === 'string' && SHARE_ID.test(raw.shareId) ? raw.shareId : undefined,
      visitors: Array.isArray(raw.visitors) ? raw.visitors.slice(0, 50) : [],
      waterDay: typeof raw.waterDay === 'string' ? raw.waterDay : '',
      watered: Array.isArray(raw.watered) ? raw.watered.slice(0, WATERS_PER_DAY) : [],
      friends: Array.isArray(raw.friends) ? raw.friends.filter((f) => f && typeof f.url === 'string' && parseFarmLink(f.url)).slice(0, MAX_FRIENDS) : [],
    };
    return this.state;
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 });
    } catch (e) {
      console.warn('[farm] could not save the social settings', (e as Error).message);
    }
  }

  view(publicUrl?: string): FarmSocialView {
    const s = this.load();
    return { profile: s.profile, public: s.public, shareId: s.shareId, publicUrl, visitors: s.visitors.slice(0, 30), friends: s.friends };
  }

  /** Profile fields and the public switch. Going public the first time makes up the share id. */
  update(body: any) {
    const s = this.load();
    if (body?.profile) s.profile = cleanProfile(body.profile, this.machineName);
    if (typeof body?.public === 'boolean') {
      if (body.public && !s.shareId) s.shareId = newShareId();
      s.public = body.public;
    }
    this.save();
  }

  /** A new share id: the old link stops working. */
  rotate() {
    const s = this.load();
    s.shareId = newShareId();
    s.visitors = [];
    this.save();
  }

  /** The public card for a share id, or undefined when that farm isn't (or no longer) public. */
  publicFor(id: string, farm: () => FarmView): PublicFarm | undefined {
    const s = this.load();
    if (!s.public || !s.shareId || id !== s.shareId) return undefined;
    this.rollDay();
    return publicFarm(s.shareId, s.profile, farm(), { waterToday: s.watered.length, visitors: s.visitors });
  }

  /**
   * Someone waters this farm through its share link: every growing plant gets a little
   * closer to ripe. One watering per visitor (and per address) a day, a few dozen in all.
   */
  water(id: string, body: any, ip: string, apply: (minutes: number) => number): { minutes: number; plants: number; today: number } {
    const s = this.load();
    if (!s.public || !s.shareId || id !== s.shareId) throw httpError(404, 'no such farm');
    this.rollDay();
    const visitor = cleanVisitor(body, Date.now());
    const keys = [`ip:${ip}`, `who:${(visitor.github ?? visitor.name).toLowerCase()}`];
    if (keys.some((k) => s.watered.includes(k))) throw httpError(429, 'you already watered this farm today');
    if (s.watered.length >= WATERS_PER_DAY * 2) throw httpError(429, 'this farm is soaked for today — come back tomorrow');
    const plants = apply(WATER_MINUTES);
    s.watered.push(...keys);
    s.visitors = [visitor, ...s.visitors.filter((v) => !(v.name === visitor.name && v.github === visitor.github))].slice(0, 50);
    this.save();
    return { minutes: WATER_MINUTES, plants, today: s.watered.length / 2 };
  }

  private rollDay() {
    const s = this.load();
    const today = localDate(Date.now());
    if (s.waterDay !== today) {
      s.waterDay = today;
      s.watered = [];
    }
  }

  // ── friends ────────────────────────────────────────────────────────────────
  addFriend(link: string, ownId?: string) {
    const f = parseFarmLink(String(link ?? ''));
    if (!f) throw httpError(400, 'that is not a VibePortal farm link (…/#/visit/<id>)');
    if (f.id === ownId) throw httpError(400, 'that is your own farm');
    const s = this.load();
    if (s.friends.some((x) => parseFarmLink(x.url)?.id === f.id)) return;
    if (s.friends.length >= MAX_FRIENDS) throw httpError(400, `up to ${MAX_FRIENDS} friends`);
    s.friends.push({ url: f.link, addedAt: Date.now() });
    this.save();
  }

  removeFriend(url: string) {
    const s = this.load();
    s.friends = s.friends.filter((x) => x.url !== url);
    this.friendCache.delete(url);
    this.save();
  }

  /** Every friend's public farm, read from their machine (cached for a minute). */
  async friends(): Promise<FriendFarm[]> {
    const list = this.load().friends;
    return Promise.all(list.map((f) => this.fetchFriend(f.url)));
  }

  private async fetchFriend(url: string, fresh = false): Promise<FriendFarm> {
    const hit = this.friendCache.get(url);
    if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.data;
    const f = parseFarmLink(url)!;
    let data: FriendFarm;
    try {
      // someone else's server: nothing it sends goes on screen unchecked
      data = { url, farm: cleanPublicFarm(await getJson(f.api), f.id) };
    } catch (e) {
      data = { url, error: (e as Error).message };
    }
    this.friendCache.set(url, { at: Date.now(), data });
    return data;
  }

  /** Waters a friend's farm, signed with this farm's profile (and link, so they can visit back). */
  async waterFriend(url: string, ownBase?: string): Promise<{ friend: FriendFarm; result: unknown }> {
    const f = parseFarmLink(url);
    if (!f || !this.load().friends.some((x) => x.url === url)) throw httpError(404, 'not one of your friends');
    const s = this.load();
    const from = { name: s.profile.name, github: s.profile.github, farm: s.public && s.shareId && ownBase ? farmLink(ownBase, s.shareId) : undefined };
    const result = await postJson(`${f.api}/water`, from);
    return { friend: await this.fetchFriend(url, true), result };
  }

  ownLink(base?: string): string | undefined {
    const s = this.load();
    return s.public && s.shareId && base ? farmLink(base, s.shareId) : undefined;
  }
}

const newShareId = () =>
  BigInt('0x' + crypto.randomBytes(12).toString('hex'))
    .toString(36)
    .padStart(16, '0')
    .slice(0, 24);

// free ngrok tunnels put an HTML warning page in front unless asked not to
const HEADERS = { Accept: 'application/json', 'ngrok-skip-browser-warning': '1', 'User-Agent': 'VibePortal-farm' };
const MAX_BODY = 256 << 10;

async function getJson(url: string): Promise<unknown> {
  return readBody(await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000), redirect: 'error' }));
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  return readBody(await fetch(url, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: 'error' }));
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_BODY) throw new Error('answer too large');
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(res.ok ? 'not a VibePortal farm' : `HTTP ${res.status}`);
  }
  if (!res.ok) throw httpError(res.status === 429 ? 429 : 502, data?.error ?? `HTTP ${res.status}`);
  return data;
}
