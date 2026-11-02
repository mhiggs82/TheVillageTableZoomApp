import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptContext, encryptContext } from '../server/context.js';
import { SECRET } from './helpers.js';

const payload = { typ: 'meeting', uid: 'abc', mid: 'M', attendrole: 'host' };

test('round trip', () => assert.deepEqual(decryptContext(encryptContext(payload, SECRET), SECRET), payload));
test('wrong secret fails', () => assert.throws(() => decryptContext(encryptContext(payload, SECRET), 'other-secret')));
test('tampered ciphertext fails', () => {
  const b = Buffer.from(encryptContext(payload, SECRET), 'base64');
  b[20] ^= 1;
  assert.throws(() => decryptContext(b.toString('base64'), SECRET));
});
test('tampered authenticated data fails', () => {
  const b = Buffer.from(encryptContext(payload, SECRET, '{"a":1}'), 'base64');
  b[1 + 12 + 2 + 2] ^= 1; // flip a byte inside the aad
  assert.throws(() => decryptContext(b.toString('base64'), SECRET));
});
test('shortened auth tags are rejected (known GCM forgery trick)', () => {
  const b = Buffer.from(encryptContext(payload, SECRET), 'base64');
  assert.throws(() => decryptContext(b.subarray(0, b.length - 8).toString('base64'), SECRET));
});
test('garbage and truncated input fail cleanly', () => {
  for (const bad of ['', 'AAAA', 'not base64 at all!!', Buffer.from([255, 1, 2]).toString('base64'), encryptContext(payload, SECRET).slice(0, 30)]) assert.throws(() => decryptContext(bad, SECRET));
});
test('url-safe base64 is accepted', () => {
  const urlSafe = encryptContext(payload, SECRET).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.deepEqual(decryptContext(urlSafe, SECRET), payload);
});
