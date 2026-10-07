import fs from 'node:fs';
import path from 'node:path';
import { calendarEvents, classifyResetPost, DAY_MS, RESET_POSTS, resetOutlook, type ResetCalendarView, type ResetEvent, type ResetPost } from '../shared/resets';
import type { ProviderSnapshot } from '../shared/types';

const TIMELINE = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/thsottiaux';
interface Observation { at: number; percent: number; reset: number }

function postOf(raw: any): ResetPost | undefined {
  const id = raw?.id_str;
  const text = raw?.full_text ?? raw?.text;
  const at = Date.parse(raw?.created_at);
  if (!/^\d{5,25}$/.test(id ?? '') || typeof text !== 'string' || !Number.isFinite(at) || raw?.user?.screen_name?.toLowerCase() !== 'thsottiaux' || raw?.retweeted_status) return;
  return { id, postedAt: new Date(at).toISOString(), text: text.slice(0, 8000), url: `https://x.com/thsottiaux/status/${id}`, source: 'x', ...classifyResetPost(text) };
}

/** Parse only top-level posts by the requested author, never quoted tweets. */
export function parseTiboTimeline(html: string): ResetPost[] {
  const data = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (!data) throw new Error('X did not return a public timeline');
  const entries = JSON.parse(data)?.props?.pageProps?.timeline?.entries;
  if (!Array.isArray(entries)) throw new Error('X timeline format is unavailable');
  const posts = entries.map((e: any) => postOf(e?.content?.tweet)).filter((p): p is ResetPost => !!p);
  if (!posts.length) throw new Error('X did not return any readable posts');
  return posts;
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(12_000), redirect: 'error', headers: { Accept: 'text/html,application/json', 'User-Agent': 'VibePortal/0.4' } });
  if (!r.ok) throw new Error(`X HTTP ${r.status}`);
  // Cap both announced and streamed sizes before parsing external content.
  if (Number(r.headers.get('content-length')) > 2_000_000) throw new Error('X response too large');
  const reader = r.body?.getReader();
  if (!reader) throw new Error('X response is empty');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2_000_000) { await reader.cancel(); throw new Error('X response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Account observations and public announcements stay separate and survive restarts. */
export class ResetTracker {
  private posts = [...RESET_POSTS];
  private history: ResetEvent[] = [];
  private previous: Record<string, Observation> = {};
  private feed: ResetCalendarView['feed'] = { state: 'cached' };
  private fetching?: Promise<void>;
  private dirty = false;
  private savedAt = 0;

  constructor(private file: string) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data.posts)) this.merge(data.posts.filter((p: ResetPost) => /^\d{5,25}$/.test(p.id) && typeof p.text === 'string' && Number.isFinite(Date.parse(p.postedAt)) && p.url === `https://x.com/thsottiaux/status/${p.id}`));
      if (Array.isArray(data.history)) this.history = data.history.filter((e: ResetEvent) => e.kind === 'observed' && Number.isFinite(Date.parse(e.at))).slice(-800);
      if (data.previous && typeof data.previous === 'object') this.previous = data.previous;
      if (typeof data.fetchedAt === 'string') this.feed.fetchedAt = data.fetchedAt;
    } catch { /* first run */ }
  }

  observe(providers: Pick<ProviderSnapshot, 'provider' | 'quotas' | 'quotasObservedAt'>[], now = Date.now()) {
    for (const p of providers) {
      const at = Date.parse(p.quotasObservedAt ?? '');
      if (!Number.isFinite(at) || at > now + 60_000 || now - at > 30 * 60_000) continue;
      for (const q of p.quotas) {
        const reset = Date.parse(q.resetsAt ?? '');
        if (!Number.isFinite(reset) || !Number.isFinite(q.percent)) continue;
        const key = `${p.provider}:${q.id}`;
        const old = this.previous[key];
        if (old && at <= old.at) continue;
        // A substantial drop, with adjacent fresh observations, is evidence of a reset.
        // Small corrections and shifts of resets_at on their own are not evidence.
        if (old && at - old.at <= 30 * 60_000 && old.percent - q.percent >= 20 && q.percent <= 10) {
          this.history.push({ id: `${key}:${at}`, provider: p.provider, label: q.label, kind: 'observed', at: new Date(at).toISOString(), after: new Date(old.at).toISOString() });
        }
        this.previous[key] = { at, percent: q.percent, reset };
        this.dirty = true;
      }
    }
    this.history = this.history.filter((e) => now - Date.parse(e.at) <= 120 * DAY_MS).slice(-800);
    this.save();
  }

  private merge(posts: ResetPost[]) {
    this.posts = [...new Map([...this.posts, ...posts].map((p) => [p.id, p])).values()].sort((a, b) => b.postedAt.localeCompare(a.postedAt)).slice(0, 200);
    this.dirty = true;
  }

  collect(force = false): Promise<void> {
    if (this.fetching) return this.fetching;
    const elapsed = Date.now() - Date.parse(this.feed.checkedAt ?? '1970-01-01');
    if (elapsed < (force ? 60_000 : 30 * 60_000)) return Promise.resolve();
    this.feed.checkedAt = new Date().toISOString();
    this.fetching = (async () => {
      try {
        this.merge(parseTiboTimeline(await fetchText(TIMELINE)));
        this.feed = { state: 'ok', checkedAt: this.feed.checkedAt, fetchedAt: new Date().toISOString() };
        this.save(true);
      } catch (e) {
        this.feed = { ...this.feed, state: 'error', error: (e as Error).message };
      }
    })().finally(() => { this.fetching = undefined; });
    return this.fetching;
  }

  async importPost(url: string) {
    // Fixed author and fetch host; submitted URLs cannot make arbitrary server requests.
    const match = /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/thsottiaux\/status\/(\d{5,25})(?:\?[^#]*)?$/i.exec(url.trim());
    if (!match) throw Object.assign(new Error('Paste a Tibo (@thsottiaux) post URL'), { status: 400 });
    const raw = JSON.parse(await fetchText(`https://cdn.syndication.twimg.com/tweet-result?id=${match[1]}&lang=en&token=1`));
    const post = postOf(raw);
    if (!post || post.id !== match[1]) throw Object.assign(new Error('X did not return that Tibo post'), { status: 502 });
    this.merge([post]);
    this.save(true);
  }

  view(providers: ProviderSnapshot[], now = Date.now()): ResetCalendarView {
    const posts = this.posts.filter((p) => Date.parse(p.postedAt) <= now);
    return { events: calendarEvents(providers, this.history, posts, now), posts, outlook: resetOutlook(posts, now), feed: { ...this.feed } };
  }

  save(force = false) {
    if (!this.dirty || (!force && Date.now() - this.savedAt < 60_000)) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify({ posts: this.posts, history: this.history, previous: this.previous, fetchedAt: this.feed.fetchedAt }), { mode: 0o600 });
      this.savedAt = Date.now();
      this.dirty = false;
    } catch { /* observations remain available in memory */ }
  }
}
