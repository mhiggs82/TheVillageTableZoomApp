import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeProfile, decodeCode } from '../server/codec.js';
import { rng, randomProfile, CODE_KEY } from './helpers.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/python-vectors.json', import.meta.url), 'utf8'));
const same = (a, b) => a && a.location === b.location && a.life === b.life && a.family === b.family && JSON.stringify([...a.bands].sort()) === JSON.stringify([...b.bands].sort());

test('decodes every code made by the original Python encoder', () => {
  for (const r of fx.rows) assert.ok(same(decodeCode(fx.key, r.code), r), `failed on ${r.code}`);
});

test('encodes byte-for-byte what the Python encoder encodes', () => {
  for (const r of fx.rows) assert.equal(encodeProfile(fx.key, r), r.code);
});

test('round trip on 20,000 random profiles', () => {
  const r = rng(5);
  for (let i = 0; i < 20000; i++) { const p = randomProfile(r); assert.ok(same(decodeCode(CODE_KEY, encodeProfile(CODE_KEY, p)), p)); }
});

test('input is forgiving: lowercase, no dash, look-alike letters', () => {
  const p = { location: 7, bands: [2], life: 1, family: 0 };
  const code = encodeProfile(CODE_KEY, p);
  assert.ok(same(decodeCode(CODE_KEY, code.toLowerCase()), p));
  assert.ok(same(decodeCode(CODE_KEY, code.replace('-', ' ')), p));
});

test('a single wrong character is caught almost every time', () => {
  const r = rng(9);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let caught = 0, total = 0;
  for (let i = 0; i < 20000; i++) {
    const code = encodeProfile(CODE_KEY, randomProfile(r)).replace('-', '');
    const pos = Math.floor(r() * 5);
    const rep = alphabet.replace(code[pos], '')[Math.floor(r() * 31)];
    total++;
    if (decodeCode(CODE_KEY, code.slice(0, pos) + rep + code.slice(pos + 1)) === null) caught++;
  }
  assert.ok(caught / total > 0.96, `only ${(100 * caught / total).toFixed(1)}% caught`);
});

test('a different key cannot read the codes', () => {
  const r = rng(3);
  let readable = 0;
  for (let i = 0; i < 3000; i++) if (decodeCode('another-secret-key', encodeProfile(CODE_KEY, randomProfile(r)))) readable++;
  assert.ok(readable / 3000 < 0.05, `${readable} codes decoded with the wrong key`);
});

test('junk input returns null instead of throwing', () => {
  for (const bad of ['', 'ZZZZZ', '12345', 'ABC-DE-F', null, undefined, 42, {}, 'A'.repeat(500), '!!!-??']) assert.equal(decodeCode(CODE_KEY, bad), null);
});

test('weak or non-ASCII keys are refused', () => {
  assert.throws(() => encodeProfile('short', { location: 0, bands: [1], life: 0, family: 0 }));
  assert.throws(() => encodeProfile('clé-secrète-longue', { location: 0, bands: [1], life: 0, family: 0 }));
});

test('similar families get unrelated-looking codes', () => {
  const a = encodeProfile(CODE_KEY, { location: 7, bands: [2], life: 1, family: 0 });
  const b = encodeProfile(CODE_KEY, { location: 7, bands: [2], life: 1, family: 1 });
  const diff = [...a.replace('-', '')].filter((c, i) => c !== b.replace('-', '')[i]).length;
  assert.ok(diff >= 3, `${a} vs ${b} look too alike`);
});
