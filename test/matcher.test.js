import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, groupSizes, pairCost, WEIGHTS } from '../server/matcher.js';
import { LOCATIONS } from '../server/model.js';
import { rng, randomProfile } from './helpers.js';

const people = (n, seed) => { const r = rng(seed); return Array.from({ length: n }, () => randomProfile(r)); };

// Exact best answer by trying every possible grouping (only feasible for small groups of people).
function bestPossible(profiles, sizes, focus) {
  const n = profiles.length;
  const M = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : pairCost(profiles[i], profiles[j], focus))));
  const groups = sizes.map(() => []);
  let best = Infinity;
  const go = (i, cost) => {
    if (cost >= best) return;
    if (i === n) { best = cost; return; }
    const triedEmpty = new Set();
    for (let g = 0; g < groups.length; g++) {
      if (groups[g].length >= sizes[g]) continue;
      if (groups[g].length === 0) { if (triedEmpty.has(sizes[g])) continue; triedEmpty.add(sizes[g]); }
      let add = 0;
      for (const x of groups[g]) add += M[i][x];
      groups[g].push(i);
      go(i + 1, cost + add);
      groups[g].pop();
    }
  };
  go(0, 0);
  return best;
}
const costOf = (profiles, rooms, focus) => rooms.reduce((s, g) => s + g.reduce((t, a, i) => t + g.slice(i + 1).reduce((u, b) => u + pairCost(profiles[a], profiles[b], focus), 0), 0), 0);

test('room sizes: leftovers become one extra seat in a room', () => {
  assert.deepEqual(groupSizes(100, 3), [4, ...Array(32).fill(3)]);
  assert.deepEqual(groupSizes(9, 3), [3, 3, 3]);
  assert.deepEqual(groupSizes(10, 3), [4, 3, 3]);
  assert.deepEqual(groupSizes(11, 3), [4, 4, 3]);
  assert.deepEqual(groupSizes(5, 3), [5]);
  assert.deepEqual(groupSizes(2, 3), [2]);
  assert.deepEqual(groupSizes(0, 3), []);
  assert.deepEqual(groupSizes(17, 4), [5, 4, 4, 4]);
});

test('every parent is seated exactly once, in every mode and size', () => {
  for (const mode of ['smart', 'random', 'country', 'city', 'age', 'life', 'family']) {
    for (const [n, size] of [[1, 3], [2, 3], [7, 3], [30, 3], [101, 3], [64, 4], [45, 5], [23, 2], [60, 10]]) {
      const { rooms } = makePlan(people(n, n + size), { mode, roomSize: size, seed: 1 });
      const flat = rooms.flat().sort((a, b) => a - b);
      assert.deepEqual(flat, Array.from({ length: n }, (_, i) => i), `${mode} n=${n} size=${size}`);
      assert.deepEqual(rooms.map((r) => r.length), groupSizes(n, size).length ? rooms.map((r) => r.length) : []);
      for (const r of rooms) assert.ok(r.length >= Math.min(n, 2) || n === 1);
    }
  }
});

test('same seed, same tables', () => {
  const p = people(60, 4);
  assert.deepEqual(makePlan(p, { seed: 7 }).rooms, makePlan(p, { seed: 7 }).rooms);
});

test('benchmark: matches the exact best grouping on small meetings', () => {
  let optimal = 0, worst = 0, runs = 0;
  for (let t = 0; t < 120; t++) {
    const n = [9, 10, 11, 12][t % 4];
    const p = people(n, 1000 + t);
    const focus = [null, 'city', 'age', 'family'][Math.floor(t / 4) % 4];
    const mode = focus || 'smart';
    const { rooms } = makePlan(p, { mode, roomSize: 3, seed: t });
    const got = costOf(p, rooms, focus);
    const best = bestPossible(p, groupSizes(n, 3), focus);
    runs++;
    if (Math.abs(got - best) < 1e-9) optimal++;
    worst = Math.max(worst, best === 0 ? got : (got - best) / best);
  }
  console.log(`  exact best in ${optimal}/${runs} runs, worst case ${(worst * 100).toFixed(2)}% above best`);
  assert.ok(optimal / runs >= 0.97, `exact best in only ${optimal}/${runs}`);
  assert.ok(worst <= 0.05, `worst case ${(worst * 100).toFixed(1)}% above the best possible`);
});

test('smart match beats random and beats plain sort-and-cut on 100 pilot-style parents', () => {
  const r = rng(77);
  const mix = [15, 14, 7, 6, 3, 20, 8, 14, 6, 3, 4];
  const bag = mix.flatMap((w, loc) => Array(w).fill(loc));
  const p = Array.from({ length: 100 }, () => ({ ...randomProfile(r), location: bag[Math.floor(r() * bag.length)] }));
  const smart = costOf(p, makePlan(p, { seed: 1 }).rooms);
  const random = costOf(p, makePlan(p, { mode: 'random', seed: 1 }).rooms);
  assert.ok(smart < random / 4, `smart ${smart} vs random ${random}`);
  const order = [...p.keys()].sort((a, b) => LOCATIONS[p[a].location].country.localeCompare(LOCATIONS[p[b].location].country) || p[a].location - p[b].location || Math.min(...p[a].bands) - Math.min(...p[b].bands));
  const cut = []; const sizes = groupSizes(100, 3); let pos = 0; for (const s of sizes) { cut.push(order.slice(pos, pos + s)); pos += s; }
  assert.ok(smart <= costOf(p, cut), `smart ${smart} vs sort-and-cut ${costOf(p, cut)}`);
});

test('city mode: rooms are single-city wherever the head-count allows', () => {
  const r = rng(12);
  const counts = { 5: 14, 7: 11, 0: 9, 1: 8, 2: 4, 6: 5 }; // location -> parents
  const p = Object.entries(counts).flatMap(([loc, c]) => Array.from({ length: c }, () => ({ ...randomProfile(r), location: Number(loc) })));
  const { rooms } = makePlan(p, { mode: 'city', roomSize: 3, seed: 2 });
  const pure = rooms.filter((g) => new Set(g.map((i) => p[i].location)).size === 1).length;
  const possible = Object.values(counts).reduce((s, c) => s + Math.floor(c / 3), 0);
  assert.ok(pure >= possible - 1, `${pure} single-city rooms, ${possible} possible`);
});

test('country mode: nobody sits with another country unless forced', () => {
  const r = rng(13);
  const p = [...Array(18)].map(() => ({ ...randomProfile(r), location: Math.floor(r() * 5) })).concat([...Array(15)].map(() => ({ ...randomProfile(r), location: 5 + Math.floor(r() * 5) })));
  const { rooms } = makePlan(p, { mode: 'country', roomSize: 3, seed: 3 });
  const mixed = rooms.filter((g) => new Set(g.map((i) => LOCATIONS[p[i].location].country)).size > 1).length;
  assert.equal(mixed, 0); // 18 and 15 both divide by 3
});

test('age mode groups neighbouring bands; a lone odd one out joins the nearest', () => {
  const mk = (b) => ({ location: 5, bands: [b], life: 1, family: 0 });
  const p = [mk(1), mk(1), mk(1), mk(2), mk(2), mk(2), mk(4), mk(4), mk(4), mk(3)];
  const { rooms } = makePlan(p, { mode: 'age', roomSize: 3, seed: 1 });
  const lone = rooms.find((g) => g.includes(9));
  assert.ok(lone.some((i) => [2, 3, 4].includes(p[i].bands[0]) && i !== 9), 'the band 3 parent should join band 2 or band 4');
  assert.equal(rooms.length, 3);
});

test('one shared child age is enough for a match', () => {
  const a = { location: 5, bands: [1, 4], life: 1, family: 0 };
  const b = { location: 5, bands: [4], life: 1, family: 0 };
  const c = { location: 5, bands: [2], life: 1, family: 0 };
  assert.equal(pairCost(a, b), 0);
  assert.ok(pairCost(a, c) > 0);
});

test('Randstad cities are nearer to each other than to Eindhoven or Spain', () => {
  const at = (location) => ({ location, bands: [2], life: 1, family: 0 });
  const ams = at(5), rot = at(6), hag = at(7), ein = at(8), mad = at(0);
  assert.ok(pairCost(ams, hag) < pairCost(ams, ein));
  assert.ok(pairCost(ams, rot) < pairCost(ams, mad));
  assert.ok(pairCost(ams, ams) === 0);
  assert.equal(WEIGHTS.sameMetro > Math.max(...WEIGHTS.age), true); // city never traded for age
});

test('random mode is fair: each pair lands together about equally often', () => {
  const p = people(12, 1);
  const together = new Map();
  for (let t = 0; t < 4000; t++) for (const g of makePlan(p, { mode: 'random', roomSize: 3 }).rooms) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) { const k = `${Math.min(g[i], g[j])}-${Math.max(g[i], g[j])}`; together.set(k, (together.get(k) || 0) + 1); }
  const expected = 4000 * (2 / 11);
  for (const [k, c] of together) assert.ok(Math.abs(c - expected) < expected * 0.25, `pair ${k} together ${c} times, expected about ${expected.toFixed(0)}`);
});

test('speed: 100, 200 and 400 parents', () => {
  for (const n of [100, 200, 400]) {
    const t0 = performance.now();
    makePlan(people(n, n), { roomSize: 3, seed: 1 });
    const ms = performance.now() - t0;
    assert.ok(ms < 5000, `${n} parents took ${ms.toFixed(0)} ms`);
    console.log(`  ${n} parents: ${ms.toFixed(0)} ms`);
  }
});

test('bad input is refused', () => {
  assert.throws(() => makePlan(people(5, 1), { mode: 'nope' }));
  assert.throws(() => makePlan(people(5, 1), { roomSize: 1 }));
  assert.throws(() => makePlan(people(5, 1), { roomSize: 11 }));
  assert.deepEqual(makePlan([], {}).rooms, []);
});

test('large meeting: different random starts land within 3% of each other', () => {
  const p = people(100, 321);
  const costs = [1, 2, 3, 4, 5, 6].map((seed) => makePlan(p, { seed }).cost);
  const spread = (Math.max(...costs) - Math.min(...costs)) / Math.min(...costs);
  console.log(`  100 parents, 6 seeds: ${costs.join(', ')} (spread ${(spread * 100).toFixed(2)}%)`);
  assert.ok(spread < 0.03, `spread ${(spread * 100).toFixed(2)}%`);
});
