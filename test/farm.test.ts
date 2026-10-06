import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MULTI_DRAW, PITY, RARITIES, TOKENS_PER_DRAW, WELCOME_DRAWS, creditUsage, draw, farmView, harvest, newFarm, normalizeFarm, plant, stageOf, uproot } from '../src/shared/farm';
import { farmDaily } from '../src/core/farm';

/** a repeatable stand-in for Math.random */
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

test('farm: tokens buy draws, counted per day from the first day on, never shrinking', () => {
  const f = newFarm('2026-10-05');
  assert.equal(farmView(f).drawsAvailable, WELCOME_DRAWS);
  creditUsage(f, [
    { date: '2026-10-04', tokens: 9e9 }, // before the farm opened
    { date: '2026-10-05', tokens: 1_200_000 },
  ]);
  // a day that later reads lower (it rolled out of the history) keeps its best count
  creditUsage(f, [{ date: '2026-10-05', tokens: 100 }]);
  const v = farmView(f);
  assert.equal(v.earnedTokens, 1_200_000);
  assert.equal(v.drawsAvailable, WELCOME_DRAWS + 2);
});

test('farm: drawing spends tokens; a ten-draw holds a rare; pity guarantees a legendary', () => {
  const f = newFarm('2026-10-05');
  f.days['2026-10-05'] = 100 * TOKENS_PER_DRAW;
  const one = draw(f, 1, seeded(3));
  assert.equal(one.length, 1);
  assert.equal(f.spentTokens, TOKENS_PER_DRAW);
  // an rng that always rolls "common"
  const ten = draw(f, MULTI_DRAW, () => 0);
  assert.equal(ten.length, 10);
  assert.ok(ten.some((s) => RARITIES.indexOf(s.rarity) >= 2));
  f.pity = PITY - 1;
  assert.equal(draw(f, 1, () => 0)[0].rarity, 'legendary');
  assert.equal(f.pity, 0);
  const broke = newFarm('2026-10-05');
  assert.throws(() => draw(broke, MULTI_DRAW), /not enough tokens/);
});

test('farm: plant, grow, harvest; uproot gives the seed back', () => {
  const f = newFarm('2026-10-05');
  const [a, b] = [...draw(f, 1, seeded(5)), ...draw(f, 1, seeded(9))];
  plant(f, 0, a.id, 1000);
  assert.throws(() => plant(f, 0, b.id, 1000), /taken/);
  assert.equal(stageOf(f.plots[0], 1000), 0);
  assert.throws(() => harvest(f, 0, 1001), /not ripe/);
  const ripeAt = f.plots[0].readyAt!;
  assert.equal(stageOf(f.plots[0], ripeAt), 3);
  const crop = harvest(f, 0, ripeAt, () => 0.99);
  assert.equal(crop.species, a.species);
  assert.equal(crop.rarity, a.rarity);
  assert.deepEqual(f.plots[0], {});
  plant(f, 1, b.id, 0);
  uproot(f, 1);
  assert.deepEqual(f.seeds.map((s) => s.id), [b.id]);
});

test('farm: a mutated harvest comes out one quality better', () => {
  const f = newFarm('2026-10-05');
  const [s] = draw(f, 1, () => 0); // common
  plant(f, 0, s.id, 0);
  const crop = harvest(f, 0, Date.now() + 864e5, () => 0);
  assert.equal(crop.rarity, 'fine');
  assert.equal(crop.mutated, true);
});

test('farm: a damaged file still loads, and tokens exclude cache reads', () => {
  const f = normalizeFarm({ plots: [{}], seeds: 'x' as never }, '2026-10-05');
  assert.equal(f.plots.length, 9);
  assert.deepEqual(f.seeds, []);
  const daily = farmDaily([
    { daily: [{ date: '2026-10-05', totals: { input: 1, output: 2, cacheWrite: 3, cacheRead: 1000, total: 1006, messages: 1, cost: 0 }, byModel: {} }] },
    { daily: [{ date: '2026-10-05', totals: { input: 10, output: 0, cacheWrite: 0, cacheRead: 5, total: 15, messages: 1, cost: 0 }, byModel: {} }] },
  ] as never);
  assert.deepEqual(daily, [{ date: '2026-10-05', tokens: 16 }]);
});
