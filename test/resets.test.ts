import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calendarEvents, classifyResetPost, DAY_MS, resetOutlook, type ResetPost } from '../src/shared/resets';
import { parseTiboTimeline, ResetTracker } from '../src/core/resets';
import type { ProviderSnapshot, QuotaWindow } from '../src/shared/types';

const now = Date.parse('2026-10-08T12:00:00Z');
const iso = (n: number) => new Date(n).toISOString();
const quota = (percent = 90, extra: Partial<QuotaWindow> = {}): QuotaWindow => ({ id: 'weekly', label: 'Weekly', kind: 'weekly', severity: 'normal', percent, resetsAt: iso(now + DAY_MS), windowMinutes: 10080, ...extra });
const provider = (percent: number, at = now) => ({ provider: 'openai' as const, name: 'ChatGPT', quotas: [quota(percent)], quotasObservedAt: iso(at) });
const post = (days: number, kind: ResetPost['kind'] = 'reset'): ResetPost => ({ id: String(days), postedAt: iso(now - days * DAY_MS), url: 'https://x.com/thsottiaux', text: '', kind, source: 'x' });
const tweet = (text: string, id = '2107676072871600470', author = 'thsottiaux') => ({ id_str: id, created_at: iso(now), full_text: text, user: { screen_name: author } });
const timeline = (tweets: unknown[]) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { timeline: { entries: tweets.map((tweet) => ({ content: { tweet } })) } } } })}</script>`;

test('reset posts: completed resets, credits, conditional promises and questions stay distinct', () => {
  for (const s of ['Reset all propagated. Enjoy.', 'Resets all propagated.', 'The reset has been processed. Enjoy!', 'We have reset Codex usage limits across all plans.']) assert.equal(classifyResetPost(s).kind, 'reset', s);
  assert.equal(classifyResetPost('We are loading a banked reset into all accounts.').kind, 'credit');
  assert.deepEqual(classifyResetPost('Over the next 28 days, each day we’ll either ship one improvement or ship a full reset.'), { kind: 'pledge', pledgeDays: 28 });
  for (const s of ['Did the reset all propagate?', 'The reset has not propagated.', 'We have not reset limits.', 'If we reset all limits tomorrow…', 'A random swag drop!']) assert.notEqual(classifyResetPost(s).kind, 'reset', s);
  assert.equal(classifyResetPost('Global reset landing tomorrow 10am PST.').kind, 'announcement');
});

test('reset outlook: deduplication, sample threshold, credits excluded, no rolling an overdue forecast forward', () => {
  assert.equal(resetOutlook([post(5), post(3), post(1)], now).expectedAt, undefined);
  const posts = [post(13), post(9), post(5), post(1), post(2, 'credit'), post(0, 'announcement'), post(1)];
  const p = resetOutlook(posts, now);
  assert.equal(p.samples, 4);
  assert.equal(p.medianDays, 4);
  assert.equal(p.expectedAt, iso(now + 3 * DAY_MS));
  const late = resetOutlook(posts, now + 8 * DAY_MS);
  assert.equal(late.expectedAt, p.expectedAt);
  assert.equal(late.overdue, true);
  const pledge = { ...post(2, 'pledge'), pledgeDays: 28 };
  assert.equal(resetOutlook([...posts, pledge], now).pledge?.id, pledge.id);
  assert.equal(resetOutlook([...posts, pledge], now + 29 * DAY_MS).pledge, undefined);
  assert.equal(resetOutlook([post(-2), post(130)], now).samples, 0);
});

test('calendar: upcoming times are per window, only weeks recur, stale data is omitted', () => {
  const p = { ...provider(40), quotas: [quota(), quota(20, { id: 'session', label: 'Session', kind: 'session', windowMinutes: 300, resetsAt: iso(now + 3600_000) })] };
  const events = calendarEvents([p], [], [], now);
  assert.equal(events.filter((e) => e.kind === 'scheduled').length, 2);
  assert.equal(events.filter((e) => e.label === 'Session').length, 1);
  assert.ok(events.some((e) => e.kind === 'estimated' && e.at === iso(now + 8 * DAY_MS)));
  assert.deepEqual(calendarEvents([{ ...p, quotasObservedAt: iso(now - DAY_MS) }], [], [], now), []);
  assert.deepEqual(calendarEvents([{ ...p, quotasObservedAt: 'invalid' }], [], [], now), []);
});

test('reset history: fresh drops survive restart, repeated, stale and minor changes do not add events', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-resets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.json');
  const tracker = new ResetTracker(file);
  tracker.observe([provider(90)], now);
  tracker.observe([provider(1, now + 60_000)], now + 60_000);
  tracker.observe([provider(1, now + 60_000)], now + 120_000);
  tracker.save(true);
  const loaded = new ResetTracker(file);
  const history = loaded.view([], now + 120_000).events.filter((e) => e.kind === 'observed');
  assert.equal(history.length, 1);
  assert.equal(history[0].after, iso(now));
  loaded.observe([provider(80, now + 180_000)], now + 180_000);
  loaded.observe([provider(79, now + 240_000)], now + 240_000);
  loaded.observe([provider(1, now + 2 * DAY_MS)], now + 2 * DAY_MS);
  assert.equal(loaded.view([], now + 2 * DAY_MS).events.filter((e) => e.kind === 'observed').length, 1);
});

test('Tibo timeline: wrong authors, retweets and quoted reset posts do not become reset evidence', () => {
  const html = timeline([tweet('Reset all propagated.'), tweet('Reset all propagated.', '123456', 'other'), { ...tweet('News', '234567'), quoted_status: tweet('Reset all propagated.') }, { ...tweet('Reset all propagated.', '345678'), retweeted_status: {} }]);
  const posts = parseTiboTimeline(html);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].kind, 'update');
  assert.throws(() => parseTiboTimeline('<html>Please sign in</html>'), /public timeline/);
});

test('Tibo refresh and import: preserve cached history on failures; only fixed author URLs can be fetched', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-tibo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tracker = new ResetTracker(path.join(dir, 'history.json'));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(timeline([tweet('Reset all propagated.')]), { status: 200 }); });
  await Promise.all([tracker.collect(), tracker.collect()]);
  assert.equal(calls, 1);
  assert.equal(tracker.view([], now).feed.state, 'ok');
  assert.equal(tracker.view([], now).posts.find((p) => p.id === '2107676072871600470')?.source, 'x');
  await assert.rejects(tracker.importPost('https://localhost/private'), /Tibo/);
  await assert.rejects(tracker.importPost('https://x.com/other/status/123456'), /Tibo/);
  assert.equal(calls, 1);
  const failed = new ResetTracker(path.join(dir, 'history.json'));
  t.mock.method(globalThis, 'fetch', async () => new Response('rate limited', { status: 429 }));
  await failed.collect();
  assert.equal(failed.view([], now).feed.state, 'error');
  assert.ok(failed.view([], now).feed.fetchedAt);
  assert.ok(failed.view([], now).posts.length >= 5);
});
