// Table matching: weighted closeness between parents, then rooms built to minimise total distance.
// Modes: smart (default weights), random (fair shuffle), or one segment given extra weight
// (country, city, age, life, family). Leftover parents always join the room they are most like.
import { randomBytes, randomInt } from 'node:crypto';
import { LOCATIONS, LIFE_PNS, FAMILY_PNS, MODES, MIN_ROOM_SIZE, MAX_ROOM_SIZE } from './model.js';

// Smart-match weights (placeholders to tune with real families).
export const WEIGHTS = {
  diffCountry: 80,
  sameCountryFar: 40,
  sameCountryUnknown: 30, // one side is "other city in ..."
  sameMetro: 25, // Amsterdam, Rotterdam, The Hague
  bothElsewhere: 40,
  age: [0, 4, 8, 10], // by smallest band gap between any child of each parent
  lifeDiff: 6, lifePns: 3,
  famDiff: 4, famPns: 2,
};
const FOCUS = 1000; // added for a chosen segment so it dominates the smart score

function locationCost(i, j) {
  if (i === j) return LOCATIONS[i].country === 'XX' ? WEIGHTS.bothElsewhere : 0;
  const a = LOCATIONS[i], b = LOCATIONS[j];
  if (a.country !== b.country || a.country === 'XX') return WEIGHTS.diffCountry;
  if (a.cluster && a.cluster === b.cluster) return WEIGHTS.sameMetro;
  if (!a.cluster || !b.cluster) return WEIGHTS.sameCountryUnknown;
  return WEIGHTS.sameCountryFar;
}

function bandGap(a, b) {
  let g = 9;
  for (const x of a.bands) for (const y of b.bands) g = Math.min(g, Math.abs(x - y));
  return g;
}

function mismatch(x, y, pns) {
  if (x === y) return 0;
  return x === pns || y === pns ? 0.5 : 1;
}

export function pairCost(a, b, focus = null) {
  const gap = Math.min(bandGap(a, b), 3);
  let cost = locationCost(a.location, b.location) + WEIGHTS.age[gap];
  if (a.life !== b.life) cost += a.life === LIFE_PNS || b.life === LIFE_PNS ? WEIGHTS.lifePns : WEIGHTS.lifeDiff;
  if (a.family !== b.family) cost += a.family === FAMILY_PNS || b.family === FAMILY_PNS ? WEIGHTS.famPns : WEIGHTS.famDiff;
  switch (focus) {
    case 'country': {
      const ca = LOCATIONS[a.location].country, cb = LOCATIONS[b.location].country;
      cost += ca !== cb ? FOCUS : ca === 'XX' ? FOCUS / 2 : 0;
      break;
    }
    case 'city':
      cost += a.location !== b.location ? FOCUS : LOCATIONS[a.location].country === 'XX' ? FOCUS / 2 : 0;
      break;
    case 'age': cost += 100 * gap; break;
    case 'life': cost += FOCUS * mismatch(a.life, b.life, LIFE_PNS); break;
    case 'family': cost += FOCUS * mismatch(a.family, b.family, FAMILY_PNS); break;
    default:
  }
  return cost;
}

/** n people into rooms near `size`: as many rooms as fit, spread evenly, so leftovers become size+1 rooms. */
export function groupSizes(n, size) {
  if (n <= 0) return [];
  const rooms = Math.max(1, Math.floor(n / size));
  const base = Math.floor(n / rooms);
  const extra = n % rooms;
  return Array.from({ length: rooms }, (_, i) => (i < extra ? base + 1 : base));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(n, rng) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = rng ? Math.floor(rng() * (i + 1)) : randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function chunk(order, sizes) {
  const rooms = [];
  let pos = 0;
  for (const s of sizes) { rooms.push(order.slice(pos, pos + s)); pos += s; }
  return rooms;
}

function matrix(profiles, focus) {
  const n = profiles.length;
  const M = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) M[i * n + j] = M[j * n + i] = pairCost(profiles[i], profiles[j], focus);
  return M;
}

export function totalCost(rooms, M, n) {
  let s = 0;
  for (const g of rooms) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) s += M[g[i] * n + g[j]];
  return s;
}

function swapDelta(M, n, A, ia, B, ib) {
  const p = A[ia], q = B[ib];
  let d = 0;
  for (let x = 0; x < A.length; x++) if (x !== ia) d += M[q * n + A[x]] - M[p * n + A[x]];
  for (let y = 0; y < B.length; y++) if (y !== ib) d += M[p * n + B[y]] - M[q * n + B[y]];
  return d;
}

function improve(rooms, M, n, rng, iterations) {
  if (rooms.length < 2) return rooms;
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { sum += M[i * n + j]; cnt++; }
  const avg = cnt ? sum / cnt : 1;
  let temp = Math.max(2, 0.5 * avg);
  const cooling = Math.pow(1 / 200, 1 / iterations);
  let cur = totalCost(rooms, M, n);
  let best = rooms.map((g) => g.slice()), bestCost = cur;
  for (let it = 0; it < iterations; it++) {
    const a = Math.floor(rng() * rooms.length);
    let b = Math.floor(rng() * (rooms.length - 1));
    if (b >= a) b++;
    const ia = Math.floor(rng() * rooms[a].length), ib = Math.floor(rng() * rooms[b].length);
    const delta = swapDelta(M, n, rooms[a], ia, rooms[b], ib);
    if (delta <= 0 || rng() < Math.exp(-delta / temp)) {
      [rooms[a][ia], rooms[b][ib]] = [rooms[b][ib], rooms[a][ia]];
      cur += delta;
      if (cur < bestCost - 1e-9) { bestCost = cur; best = rooms.map((g) => g.slice()); }
    }
    temp *= cooling;
  }
  rooms = best;
  // Final polish: keep applying any single swap that lowers the total.
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (let a = 0; a < rooms.length; a++) for (let b = a + 1; b < rooms.length; b++)
      for (let ia = 0; ia < rooms[a].length; ia++) for (let ib = 0; ib < rooms[b].length; ib++)
        if (swapDelta(M, n, rooms[a], ia, rooms[b], ib) < -1e-9) {
          [rooms[a][ia], rooms[b][ib]] = [rooms[b][ib], rooms[a][ia]];
          moved = true;
        }
    if (!moved) break;
  }
  return rooms;
}

function startOrder(profiles, mode) {
  const key = (p) => {
    const l = LOCATIONS[p.location];
    const lowAge = Math.min(...p.bands);
    switch (mode) {
      case 'age': return [lowAge];
      case 'life': return [p.life];
      case 'family': return [p.family];
      case 'city': return [l.country, p.location];
      default: return [l.country, l.cluster || '~', p.location, lowAge];
    }
  };
  return Array.from({ length: profiles.length }, (_, i) => i).sort((x, y) => {
    const kx = key(profiles[x]), ky = key(profiles[y]);
    for (let i = 0; i < kx.length; i++) if (kx[i] < ky[i]) return -1; else if (kx[i] > ky[i]) return 1;
    return 0;
  });
}

/**
 * profiles: array of { location, bands, life, family }
 * Returns { rooms: number[][] (indices into profiles), cost }
 */
export function makePlan(profiles, { mode = 'smart', roomSize = 3, seed, effort } = {}) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  if (!Number.isInteger(roomSize) || roomSize < MIN_ROOM_SIZE || roomSize > MAX_ROOM_SIZE) throw new Error('bad room size');
  const n = profiles.length;
  const sizes = groupSizes(n, roomSize);
  const rng = mulberry32(seed ?? randomBytes(4).readUInt32LE());
  if (mode === 'random') return { rooms: chunk(shuffled(n, seed === undefined ? null : rng), sizes), cost: 0 };
  const focus = mode === 'smart' ? null : mode;
  const M = matrix(profiles, focus);
  // Several runs from different starting points (the first from a sensible sorted start); keep the best.
  const work = effort ?? (n <= 150 ? 3 : n <= 300 ? 2 : 1); // small meetings get a longer, more careful search
  const iterations = Math.round(Math.min(300000, Math.max(20000, 1500 * n)) * work);
  const restarts = n <= 400 ? 8 : 3;
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const start = chunk(r === 0 ? startOrder(profiles, mode) : shuffled(n, rng), sizes);
    const rooms = improve(start, M, n, rng, iterations);
    const cost = totalCost(rooms, M, n);
    if (!best || cost < best.cost - 1e-9) best = { rooms, cost };
  }
  return best;
}
