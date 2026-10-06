import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// keep farm-social.json out of the real ~/.vibeportal
process.env.VIBEPORTAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-social-'));

test('profile fields are cleaned: handles, LinkedIn URLs, no markup', async () => {
  const { cleanProfile } = await import('../src/shared/farmSocial');
  const p = cleanProfile({
    name: ' <b>Ada</b> ',
    github: 'https://github.com/ada-dev/repo',
    linkedin: 'linkedin.com/in/ada-lovelace/',
    x: '@ada_dev',
    website: 'ada.dev',
    bio: 'x'.repeat(500),
  });
  assert.equal(p.name, 'bAda/b');
  assert.equal(p.github, 'ada-dev');
  assert.equal(p.linkedin, 'https://www.linkedin.com/in/ada-lovelace');
  assert.equal(p.x, 'ada_dev');
  assert.equal(p.website, 'https://ada.dev/');
  assert.equal(p.bio!.length, 120);
  const bad = cleanProfile({ name: '', github: 'not a user!', linkedin: 'javascript:alert(1)', website: 'javascript:alert(1)' }, 'Box');
  assert.deepEqual(bad, { name: 'Box' });
});

test('farm links: visit links and API URLs, behind a path too', async () => {
  const { parseFarmLink } = await import('../src/shared/farmSocial');
  const a = parseFarmLink('https://ada.ngrok.app/#/visit/abcdefghijklmnop12');
  assert.equal(a?.api, 'https://ada.ngrok.app/api/public/farm/abcdefghijklmnop12');
  const b = parseFarmLink('https://host.dev/vp/?x=1#/visit/abcdefghijklmnop12');
  assert.equal(b?.base, 'https://host.dev/vp/');
  assert.equal(parseFarmLink('https://host.dev/vp/api/public/farm/abcdefghijklmnop12')?.link, 'https://host.dev/vp/#/visit/abcdefghijklmnop12');
  assert.equal(parseFarmLink('https://host.dev/#/visit/short'), undefined);
  assert.equal(parseFarmLink('file:///etc/passwd#/visit/abcdefghijklmnop12'), undefined);
  assert.equal(parseFarmLink('not a url'), undefined);
});

test('a farm is only visible through its link while public; watering is limited', async () => {
  const { FarmSocial } = await import('../src/core/farmSocial');
  const { farmView, newFarm, waterField } = await import('../src/shared/farm');
  const now = Date.now();
  const state = newFarm('2026-10-01');
  state.plots[0] = { seed: { id: 's', species: 'rose', rarity: 'rare', color: 'red' }, plantedAt: now - 60_000, readyAt: now + 3 * 3600_000 };
  state.plots[1] = { seed: { id: 't', species: 'tulip', rarity: 'common', color: 'red' }, plantedAt: now - 60_000, readyAt: now + 5 * 60_000 };
  const view = () => farmView(state);
  const s = new FarmSocial('Box');
  assert.equal(s.view().public, false);
  s.update({ public: true, profile: { name: 'Ada', github: 'ada-dev' } });
  const id = s.view().shareId!;
  assert.match(id, /^[a-z0-9]{16,32}$/);
  const card = s.publicFor(id, view)!;
  assert.equal(card.profile.name, 'Ada');
  assert.equal(card.field.length, 2);
  assert.equal(s.publicFor('x'.repeat(16), view), undefined, 'a wrong id shows nothing');

  const r = s.water(id, { name: 'Grace', github: 'grace-h' }, '1.2.3.4', (m) => waterField(state, m));
  assert.deepEqual([r.plants, r.today], [2, 1]);
  assert.equal(state.plots[0].readyAt, now + 3 * 3600_000 - 20 * 60_000);
  assert.ok(state.plots[1].readyAt! <= Date.now(), 'never past ripe, just ripe');
  assert.throws(() => s.water(id, { name: 'Grace', github: 'grace-h' }, '5.6.7.8', () => 0), /already watered/);
  assert.throws(() => s.water(id, { name: 'Other' }, '1.2.3.4', () => 0), /already watered/);
  assert.equal(s.view().visitors[0].github, 'grace-h');

  const old = id;
  s.rotate();
  assert.equal(s.publicFor(old, view), undefined, 'a new link retires the old one');
  s.update({ public: false });
  assert.equal(s.publicFor(s.view().shareId!, view), undefined);
});

test('friends: links only, not yourself, no duplicates', async () => {
  const { FarmSocial } = await import('../src/core/farmSocial');
  const s = new FarmSocial();
  assert.throws(() => s.addFriend('https://example.com/'), /not a VibePortal farm link/);
  assert.throws(() => s.addFriend('https://me.dev/#/visit/mine0000000000000', 'mine0000000000000'), /your own/);
  s.addFriend('https://grace.dev/#/visit/grace000000000000');
  s.addFriend('https://grace.dev/api/public/farm/grace000000000000');
  assert.equal(s.view().friends.length, 1);
  s.removeFriend(s.view().friends[0].url);
  assert.equal(s.view().friends.length, 0);
});

test('the share card is self-contained SVG with the name escaped', async () => {
  const { farmCardSvg } = await import('../src/shared/farmCard');
  const { publicFarm } = await import('../src/shared/farmSocial');
  const { farmView, newFarm } = await import('../src/shared/farm');
  const f = newFarm('2026-10-01');
  f.crops.push({ id: 'a', species: 'worldtree', rarity: 'mythic', color: 'rainbow', harvestedAt: 1 }, { id: 'b', species: 'nope', rarity: 'common', color: 'red', harvestedAt: 2 });
  const svg = farmCardSvg(publicFarm('abcdefghijklmnop', { name: 'A <script>&"' }, farmView(f), { waterToday: 0, visitors: [] }), 'zh');
  assert.ok(svg.startsWith('<svg') && svg.trim().endsWith('</svg>'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('A &lt;script&gt;&amp;&quot;'));
  assert.ok(!/NaN|undefined|var\(/.test(svg), 'no CSS variables or broken numbers: it is shown outside the app');
  assert.ok(!/href=|<image/.test(svg), 'nothing to fetch');
});

test('a friend’s farm from their server is cleaned before it is shown', async () => {
  const { cleanPublicFarm } = await import('../src/shared/farmSocial');
  const f = cleanPublicFarm(
    {
      v: 1,
      id: 'abcdefghijklmnop',
      profile: { name: 'Eve', website: 'javascript:alert(1)', linkedin: 'https://evil.example/in/x' },
      score: 'lots',
      best: [{ species: '<img>', rarity: 'common', color: 'red' }, { species: 'rose', rarity: 'rare', color: 'red' }, { species: 'rose', rarity: 'godly', color: 'red' }],
      field: [{ species: 'tulip', rarity: 'common', color: 'nope', plantedAt: 1, readyAt: 2 }],
      visitors: [{ name: 'x', farm: 'javascript:alert(1)' }],
    },
    'abcdefghijklmnop',
  );
  assert.deepEqual(f.profile, { name: 'Eve' });
  assert.equal(f.score, 0);
  assert.deepEqual(f.best, [{ species: 'rose', rarity: 'rare', color: 'red' }]);
  assert.equal(f.field.length, 0);
  assert.equal(f.visitors[0].farm, undefined);
  assert.throws(() => cleanPublicFarm({ v: 1, id: 'other' }, 'abcdefghijklmnop'));
});
