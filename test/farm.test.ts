import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MULTI_DRAW, MUTATION, MYTHIC_MUTATION, PITY, RARITIES, RARITY_ODDS, SPECIAL_COLORS, SPECIES, TOKENS_PER_DRAW, WELCOME_DRAWS, allCrops, colorsFor, creditUsage, discardCrop, displayCrop, draw, farmView, growMinutes, harvest, newFarm, normalizeFarm, plant, stageOf, storeCrop, uproot, type Rarity } from '../src/shared/farm';
import { farmDaily } from '../src/core/farm';
import { CROP_PRICE, buyBait, cast, claimAd, cropPrice, reel, sellCrop, sellFish, startAd, takeRod } from '../src/shared/farm';
import { BAIT_PACK, BAIT_PRICE, CASTS_PER_DAY, FISH, FISH_PRICE, FREE_BAIT_PER_DAY, RODS, fishKind, fishPrice, type Fish } from '../src/shared/farmPond';
import { AD_REWARD, AD_SECONDS, ADS_PER_DAY, HOUSE_ADS } from '../src/shared/farmAds';

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
  assert.equal(v.drawsAvailable, WELCOME_DRAWS + 3);
});

test('farm: cheaper seeds preserve legacy balances and do not reprice past spending', () => {
  const { welcomeTokens: _, ...legacy } = newFarm('2026-10-05');
  legacy.days['2026-10-05'] = 1_000_000;
  legacy.spentTokens = 2_000_000;
  legacy.draws = 4;
  const migrated = normalizeFarm(legacy, '2026-10-07');
  assert.equal(farmView(migrated).balance, 500_000);
  draw(migrated, 1, () => 0);
  assert.equal(farmView(migrated).balance, 100_000);
  assert.equal(migrated.spentTokens, 2_400_000);
  assert.equal(farmView(normalizeFarm(JSON.parse(JSON.stringify(migrated)), '2026-10-08')).balance, 100_000);
  assert.equal(farmView(newFarm('2026-10-07')).drawsAvailable, 3);
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
  // pity hands out a legendary, never a mythic, whatever was rolled below it
  for (const roll of [0, 0.6, 0.9, 0.97]) {
    f.pity = PITY - 1;
    assert.equal(draw(f, 1, () => roll)[0].rarity, 'legendary');
  }
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

test('farm: plants taken off the showcase wait in the storehouse until put back or given away', () => {
  const f = newFarm('2026-10-05');
  const crop = { id: 'c1', species: 'rose', rarity: 'rare' as Rarity, color: 'red' as const, harvestedAt: 1 };
  f.crops.push(crop, { ...crop, id: 'c2' });
  storeCrop(f, 'c1');
  assert.deepEqual(f.crops.map((c) => c.id), ['c2']);
  assert.deepEqual(f.stored, [crop]);
  assert.equal(allCrops(f).length, 2);
  assert.throws(() => storeCrop(f, 'c1'), /no such plant/);
  displayCrop(f, 'c1');
  assert.deepEqual(f.crops.map((c) => c.id), ['c2', 'c1']);
  assert.deepEqual(f.stored, []);
  storeCrop(f, 'c2');
  discardCrop(f, 'c2');
  assert.equal(allCrops(f).length, 1);
  // farms saved before the storehouse existed get an empty one
  assert.deepEqual(normalizeFarm({ crops: [crop] }, '2026-10-05').stored, []);
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

test('farm: odds add up to 100 and every quality has something to draw', () => {
  const sum = RARITIES.reduce((n, r) => n + RARITY_ODDS[r], 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, `odds sum to ${sum}`);
  assert.equal(RARITY_ODDS.mythic, 0.1);
  for (const r of RARITIES) assert.ok(SPECIES.some((s) => s.rarity === r), `no ${r} species`);
  assert.equal(new Set(SPECIES.map((s) => s.id)).size, SPECIES.length);
  // a roll at the very top of the range is a mythic, just below the mythic band a legendary
  const f = newFarm('2026-10-05');
  f.days['2026-10-05'] = 10 * TOKENS_PER_DRAW;
  assert.equal(draw(f, 1, () => 0.9999)[0].rarity, 'mythic');
  assert.equal(draw(f, 1, () => 0.9985)[0].rarity, 'legendary');
  assert.equal(f.pity, 0);
  assert.deepEqual(colorsFor('mythic').filter((c) => SPECIAL_COLORS.includes(c)), SPECIAL_COLORS);
});

test('farm: each species grows in its own time, slower for better qualities', () => {
  const range: Record<Rarity, [number, number]> = { common: [15, 40], fine: [60, 120], rare: [180, 300], epic: [480, 720], legendary: [1080, 1440], mythic: [2880, 4320] };
  for (const s of SPECIES) {
    const [lo, hi] = range[s.rarity];
    assert.ok(growMinutes(s.id) >= lo && growMinutes(s.id) <= hi, `${s.id} grows in ${growMinutes(s.id)} min`);
  }
  // times vary within a quality
  for (const r of RARITIES) assert.ok(new Set(SPECIES.filter((s) => s.rarity === r).map((s) => s.grow)).size > 1, `${r} times all alike`);
  const f = newFarm('2026-10-05');
  f.seeds.push({ id: 'w', species: 'worldtree', rarity: 'mythic', color: 'gold' }, { id: 'd', species: 'daisy', rarity: 'common', color: 'white' });
  plant(f, 0, 'w', 1000);
  plant(f, 1, 'd', 1000);
  assert.equal(f.plots[0].readyAt, 1000 + growMinutes('worldtree') * 60_000);
  assert.equal(f.plots[1].readyAt, 1000 + growMinutes('daisy') * 60_000);
});

test('farm: a legendary turns mythic only at the rarer mutation rate', () => {
  assert.ok(MYTHIC_MUTATION < MUTATION);
  const grow = (rarity: Rarity, roll: number) => {
    const f = newFarm('2026-10-05');
    f.seeds.push({ id: 's', species: rarity === 'legendary' ? 'startree' : 'rose', rarity, color: 'blue' });
    plant(f, 0, 's', 0);
    return harvest(f, 0, 1e12, () => roll);
  };
  // a roll that would mutate anything else leaves a legendary as it is
  assert.equal(grow('legendary', (MYTHIC_MUTATION + MUTATION) / 2).rarity, 'legendary');
  assert.equal(grow('rare', (MYTHIC_MUTATION + MUTATION) / 2).rarity, 'epic');
  const m = grow('legendary', MYTHIC_MUTATION / 2);
  assert.equal(m.rarity, 'mythic');
  assert.equal(m.mutated, true);
  // nothing above mythic
  const f = newFarm('2026-10-05');
  f.seeds.push({ id: 'x', species: 'moonflower', rarity: 'mythic', color: 'rainbow' });
  plant(f, 0, 'x', 0);
  const top = harvest(f, 0, 1e12, () => 0);
  assert.equal(top.rarity, 'mythic');
  assert.equal(top.mutated, undefined);
});

test('farm: plants sell by quality and colour, and the money buys draws', () => {
  const s = newFarm('2026-01-01');
  s.crops.push({ id: 'a', species: 'rose', rarity: 'rare', color: 'gold', harvestedAt: 1 }, { id: 'b', species: 'daisy', rarity: 'common', color: 'red', mutated: true, harvestedAt: 1 });
  s.stored.push({ id: 'c', species: 'worldtree', rarity: 'mythic', color: 'rainbow', harvestedAt: 1 });
  assert.equal(cropPrice(s.crops[0]), 450_000, 'gold is worth half again');
  assert.equal(cropPrice(s.crops[1]), 72_000, 'a mutation adds a fifth');
  const before = farmView(s).balance;
  assert.equal(sellCrop(s, 'c'), 20_000_000, 'from the storehouse too');
  assert.equal(sellCrop(s, 'a'), 450_000);
  assert.deepEqual(allCrops(s).map((c) => c.id), ['b']);
  assert.throws(() => sellCrop(s, 'a'), /no such plant/);
  const v = farmView(s);
  assert.equal(v.balance - before, 20_450_000);
  assert.equal(v.incomeTokens, 20_450_000);
  assert.equal(v.drawsAvailable, Math.floor(v.balance / TOKENS_PER_DRAW));
  // a seed earns back well under its draw on average: selling is no token mint
  const avg = RARITIES.reduce((n, r) => n + (RARITY_ODDS[r] / 100) * CROP_PRICE[r], 0);
  assert.ok(avg < TOKENS_PER_DRAW * 0.5, `avg ${avg}`);
});

test('farm: fishing — cast, reel in on the bite, the catch sells; bait and daily limits', () => {
  const s = newFarm('2026-01-01');
  const t0 = new Date(2026, 0, 2, 9).getTime();
  let seq = 0;
  const rnd = () => ((seq = (seq * 9301 + 49297) % 233280) / 233280);
  const c = cast(s, t0, rnd);
  assert.ok(c.biteIn >= 3000 && c.biteIn <= 8000, 'the bamboo rod: 3-8 s to a bite');
  assert.deepEqual(reel(s, c.id, t0 + c.biteIn - 1000, rnd), { result: 'early' });
  assert.throws(() => reel(s, c.id, t0 + c.biteIn, rnd), /no line/, 'one reel per cast');
  const c2 = cast(s, t0, rnd);
  assert.deepEqual(reel(s, c2.id, t0 + c2.biteIn + c2.window + 2000, rnd), { result: 'late' });
  const c3 = cast(s, t0, rnd);
  const got = reel(s, c3.id, t0 + c3.biteIn + 200, rnd);
  assert.equal(got.result, 'caught');
  const fish = (got as { fish: Fish }).fish;
  const kind = fishKind(fish.species);
  assert.equal(kind.rarity, fish.rarity);
  assert.ok(fish.kg >= kind.kg[0] && fish.kg <= kind.kg[1]);
  assert.equal(s.caught[fish.species], 1);
  assert.equal(sellFish(s), fishPrice(fish));
  assert.equal(s.fish.length, 0);
  assert.equal(farmView(s).incomeTokens, fishPrice(fish));

  // five free bait a day, then bought bait, and no more than the day's casts
  cast(s, t0, rnd);
  cast(s, t0, rnd);
  assert.equal(farmView(s, t0).freeBaitLeft, 0);
  assert.throws(() => cast(s, t0, rnd), /no bait/);
  buyBait(s, 2);
  assert.equal(s.bait, 2 * BAIT_PACK);
  assert.equal(s.spentTokens, 2 * BAIT_PACK * BAIT_PRICE);
  while (farmView(s, t0).castsLeft > 0) cast(s, t0, rnd);
  assert.equal(s.bait, 2 * BAIT_PACK - (CASTS_PER_DAY - FREE_BAIT_PER_DAY));
  assert.throws(() => cast(s, t0, rnd), /done for today/);
  const tomorrow = t0 + 86400_000;
  assert.equal(farmView(s, tomorrow).castsLeft, CASTS_PER_DAY);
  assert.equal(farmView(s, tomorrow).freeBaitLeft, FREE_BAIT_PER_DAY);
  cast(s, tomorrow, rnd);
  assert.equal(s.bait, 2 * BAIT_PACK - (CASTS_PER_DAY - FREE_BAIT_PER_DAY), 'free bait first');
});

test('farm: better rods cost tokens and bring rarer fish', () => {
  const s = newFarm('2026-01-01');
  assert.throws(() => takeRod(s, 'golden'), /not enough tokens/);
  s.days['2026-01-01'] = 10_000_000;
  takeRod(s, 'golden');
  assert.equal(s.rod, 'golden');
  assert.deepEqual(s.rods, ['bamboo', 'golden']);
  const spent = s.spentTokens;
  takeRod(s, 'bamboo');
  takeRod(s, 'golden');
  assert.equal(s.spentTokens, spent, 'a rod you own is free to take up again');
  assert.throws(() => takeRod(s, 'laser'), /no such rod/);
  const ev = (r: (typeof RODS)[number]) => RARITIES.reduce((n, q) => n + (r.odds[q] / 100) * FISH_PRICE[q], 0);
  for (let i = 1; i < RODS.length; i++) assert.ok(ev(RODS[i]) > ev(RODS[i - 1]), `${RODS[i].id} catches better`);
  for (const r of RODS) assert.ok(Math.abs(RARITIES.reduce((n, q) => n + r.odds[q], 0) - 100) < 1e-9, `${r.id} odds add up to 100`);
  for (const q of RARITIES) assert.ok(FISH.some((f) => f.rarity === q), `a ${q} fish`);
  // a day at the pond with the best rod is worth a few draws, not a fortune
  assert.ok(CASTS_PER_DAY * ev(RODS[RODS.length - 1]) < 6 * TOKENS_PER_DRAW);
  // an old farm file gets a rod and an empty creel
  const old = normalizeFarm({ v: 1, startDate: '2026-01-01', days: {}, rod: 'laser' } as never, '2026-01-01');
  assert.equal(old.rod, 'bamboo');
  assert.deepEqual(old.fish, []);
  assert.deepEqual(old.income, { crops: 0, fish: 0, ads: 0 });
});

test('farm: an ad watched to the end pays tokens, a few times a day', () => {
  const s = newFarm('2026-01-01');
  const t0 = new Date(2026, 0, 2, 9).getTime();
  const a = startAd(s, t0, () => 0);
  assert.equal(a.seconds, AD_SECONDS);
  assert.ok(HOUSE_ADS.some((x) => x.id === a.ad));
  assert.throws(() => claimAd(s, a.id, t0 + 5000), /to the end/);
  assert.throws(() => claimAd(s, 'other', t0 + AD_SECONDS * 1000), /no ad/);
  assert.equal(claimAd(s, a.id, t0 + AD_SECONDS * 1000), AD_REWARD);
  assert.throws(() => claimAd(s, a.id, t0 + AD_SECONDS * 1000), /no ad/, 'paid once');
  for (let i = 1; i < ADS_PER_DAY; i++) {
    const x = startAd(s, t0);
    claimAd(s, x.id, t0 + AD_SECONDS * 1000);
  }
  assert.equal(farmView(s, t0).adsLeft, 0);
  assert.equal(farmView(s, t0).incomeTokens, ADS_PER_DAY * AD_REWARD);
  assert.throws(() => startAd(s, t0), /all the ads for today/);
  assert.equal(farmView(s, t0 + 86400_000).adsLeft, ADS_PER_DAY);
  startAd(s, t0 + 86400_000);
});
