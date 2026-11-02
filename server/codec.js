// 5-character community code: encode and decode.
// Layout (25 bits): version 2 | location 5 | age bands 7 | life stage 3 | family 3 | check 5,
// scrambled with a keyed Feistel permutation. Must stay byte-for-byte compatible with
// triad_match.py and the intake form page.
import { createHash, createHmac } from 'node:crypto';
import { LOCATIONS, LIFE_STAGES, FAMILY } from './model.js';

const VERSION = 0;
const MASK = (1 << 25) - 1;
const HALF = 13;
const HMASK = (1 << 13) - 1;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U

const AGE_INDEX = new Map();
const AGE_SETS = [];
for (let a = 0; a <= 4; a++) for (let b = a; b <= 4; b++) for (let c = b; c <= 4; c++) for (let d = c; d <= 4; d++) {
  AGE_INDEX.set(`${a},${b},${c},${d}`, AGE_SETS.length);
  AGE_SETS.push([a, b, c, d]);
}

export function keyBytes(key) {
  if (typeof key !== 'string' || key.length < 8) throw new Error('Code key must be a string of at least 8 characters');
  if (!/^[\x20-\x7e]+$/.test(key)) throw new Error('Code key must use plain ASCII characters only');
  return Buffer.from(key, 'latin1');
}

function roundFn(key, round, half) {
  const d = createHmac('sha256', key).update(Buffer.from([round, (half >> 8) & 255, half & 255])).digest();
  return ((d[0] << 8) | d[1]) & HMASK;
}

function feistel(key, x, decrypt) {
  let left = x >>> HALF;
  let right = x & HMASK;
  if (!decrypt) {
    for (let r = 0; r < 6; r++) { const t = right; right = left ^ roundFn(key, r, right); left = t; }
  } else {
    for (let r = 5; r >= 0; r--) { const t = left; left = right ^ roundFn(key, r, left); right = t; }
  }
  return ((left << HALF) | right) >>> 0;
}

function scramble(key, x, decrypt) {
  x = feistel(key, x, decrypt);
  while (x > MASK) x = feistel(key, x, decrypt);
  return x;
}

function check(payload) {
  const m = Buffer.concat([Buffer.from('chk'), Buffer.from([(payload >> 16) & 255, (payload >> 8) & 255, payload & 255])]);
  return createHash('sha256').update(m).digest()[0] & 31;
}

/** profile: { location 0..10, bands [1..4] (1 to 4 entries), life 0..4, family 0..5 } */
export function encodeProfile(key, profile) {
  const kb = keyBytes(key);
  const bands = [...profile.bands];
  if (bands.length < 1 || bands.length > 4 || bands.some((b) => !Number.isInteger(b) || b < 1 || b > 4)) throw new Error('bad bands');
  while (bands.length < 4) bands.push(0);
  bands.sort((x, y) => x - y);
  let payload = VERSION;
  payload = (payload << 5) | profile.location;
  payload = (payload << 7) | AGE_INDEX.get(bands.join(','));
  payload = (payload << 3) | profile.life;
  payload = (payload << 3) | profile.family;
  const x = scramble(kb, ((payload << 5) | check(payload)) >>> 0, false);
  let chars = '';
  for (let i = 4; i >= 0; i--) chars += ALPHABET[(x >> (5 * i)) & 31];
  return `${chars.slice(0, 3)}-${chars.slice(3)}`;
}

/** Returns a profile, or null if the code is mistyped or invalid. */
export function decodeCode(key, code) {
  if (typeof code !== 'string' || code.length > 20) return null;
  const s = code.toUpperCase().replace(/[-\s]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
  if (s.length !== 5 || [...s].some((c) => !ALPHABET.includes(c))) return null;
  let x = 0;
  for (const c of s) x = (x << 5) | ALPHABET.indexOf(c);
  const value = scramble(keyBytes(key), x >>> 0, true);
  const chk = value & 31;
  const payload = value >> 5;
  if (chk !== check(payload)) return null;
  const family = payload & 7;
  const life = (payload >> 3) & 7;
  const ageIdx = (payload >> 6) & 127;
  const location = (payload >> 13) & 31;
  const version = payload >> 18;
  if (version !== VERSION || location >= LOCATIONS.length || ageIdx >= AGE_SETS.length || life >= LIFE_STAGES.length || family >= FAMILY.length) return null;
  const bands = AGE_SETS[ageIdx].filter(Boolean);
  if (!bands.length) return null;
  return { location, bands, life, family };
}
