import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, closeAll, ctx, CODE_KEY, SECRET, CLIENT_ID } from './helpers.js';

after(closeAll);
import { encodeProfile } from '../server/codec.js';
import { SessionStore } from '../server/store.js';

const code = (location, band = 2, life = 1, family = 0) => encodeProfile(CODE_KEY, { location, bands: [band], life, family });
const host = (meeting = 'M1') => ctx({ uid: 'host', meeting, role: 'host' });
const parent = (uid, meeting = 'M1') => ctx({ uid, meeting });

async function seat(s, n, location = 5, meeting = 'M1') {
  for (let i = 0; i < n; i++) {
    const r = await s.call('POST', '/api/code', { header: parent(`p${location}-${i}`, meeting), body: { code: code(location), participantUUID: `P${location}-${i}` } });
    assert.equal(r.status, 200);
  }
}

test('a parent saves a valid code and learns nothing about it back', async () => {
  const s = await startServer();
  const r = await s.call('POST', '/api/code', { header: parent('u1'), body: { code: code(7), participantUUID: 'X1' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  await s.close();
});

test('a mistyped code is refused without hints', async () => {
  const s = await startServer();
  const r = await s.call('POST', '/api/code', { header: parent('u1'), body: { code: 'ZZZ-ZZ', participantUUID: 'X1' } });
  assert.equal(r.status, 422);
  assert.ok(!/location|city|country|age|family/i.test(r.text));
  await s.close();
});

test('requests without valid Zoom context are refused', async () => {
  const s = await startServer();
  const body = { code: code(7), participantUUID: 'X1' };
  const cases = {
    'no header': undefined,
    'garbage': 'AAAA',
    'wrong secret': ctx({ secret: 'someone-elses-secret' }),
    'wrong app': ctx({ aud: 'another-app' }),
    'expired': ctx({ exp: Date.now() - 1000 }),
  };
  for (const [name, header] of Object.entries(cases)) {
    const r = await s.call('POST', '/api/code', { header, body });
    assert.equal(r.status, 401, name);
  }
  await s.close();
});

test('only the host and co-hosts can read status, plan or clear', async () => {
  const s = await startServer();
  for (const [m, p, b] of [['GET', '/api/status'], ['POST', '/api/plan', { participants: [] }], ['POST', '/api/clear', {}]]) {
    const r = await s.call(m, p, { header: parent('u9'), body: b });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  const cohost = ctx({ uid: 'c1', role: 'co-host' });
  assert.equal((await s.call('GET', '/api/status', { header: cohost })).status, 200);
  assert.equal((await s.call('GET', '/api/status', { header: host() })).status, 200);
  await s.close();
});

test('a parent cannot pass as host by claiming it', async () => {
  const s = await startServer();
  const res = await fetch(`${s.base}/api/status`, { headers: { 'x-zoom-app-context': parent('u9'), 'x-claimed-role': 'host' } });
  assert.equal(res.status, 403);
  await s.close();
});

test('plan seats only parents who entered a code, and reveals no code contents', async () => {
  const s = await startServer();
  await seat(s, 4, 5);
  await seat(s, 3, 0);
  const present = [...Array(4)].map((_, i) => `P5-${i}`).concat([...Array(3)].map((_, i) => `P0-${i}`), ['NOCODE1', 'NOCODE2']);
  const r = await s.call('POST', '/api/plan', { header: host(), body: { mode: 'city', roomSize: 3, participants: present } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['mode', 'roomSize', 'rooms', 'waiting']);
  assert.deepEqual(r.json.waiting.sort(), ['NOCODE1', 'NOCODE2']);
  assert.deepEqual(r.json.rooms.flat().sort(), present.filter((x) => !x.startsWith('NOCODE')).sort());
  const cities = r.json.rooms.map((room) => new Set(room.map((u) => u.split('-')[0])).size);
  assert.deepEqual(cities, [1, 1]); // Amsterdam parents together, Madrid parents together
  assert.ok(!/"location"|"bands"|"life"|"family"/.test(r.text));
  await s.close();
});

test('status lists who is ready, nothing more', async () => {
  const s = await startServer();
  await seat(s, 2, 5);
  const r = await s.call('GET', '/api/status', { header: host() });
  assert.deepEqual(Object.keys(r.json), ['ready']);
  assert.deepEqual(r.json.ready.sort(), ['P5-0', 'P5-1']);
  await s.close();
});

test('bad plan requests are refused', async () => {
  const s = await startServer();
  const post = (body) => s.call('POST', '/api/plan', { header: host(), body });
  assert.equal((await post({ mode: 'bogus', participants: [] })).status, 400);
  assert.equal((await post({ roomSize: 1, participants: [] })).status, 400);
  assert.equal((await post({ roomSize: 11, participants: [] })).status, 400);
  assert.equal((await post({ roomSize: 3.5, participants: [] })).status, 400);
  assert.equal((await post({ participants: 'x' })).status, 400);
  assert.equal((await post({ participants: [1, 2] })).status, 400);
  assert.equal((await post({ participants: Array(1001).fill('a') })).status, 400);
  await s.close();
});

test('more than 50 tables is refused with a helpful message', async () => {
  const s = await startServer();
  const uuids = [];
  for (let i = 0; i < 120; i++) {
    const uid = `bulk${i}`;
    await s.call('POST', '/api/code', { header: parent(uid), body: { code: code(5), participantUUID: `B${i}` } });
    uuids.push(`B${i}`);
  }
  const r = await s.call('POST', '/api/plan', { header: host(), body: { roomSize: 2, participants: uuids } });
  assert.equal(r.status, 400); // 120 parents at 2 per table would need 60 tables, over Zoom's limit of 50
  assert.match(r.json.error, /50 maximum/);
  const ok = await s.call('POST', '/api/plan', { header: host(), body: { roomSize: 3, participants: uuids } });
  assert.equal(ok.status, 200); // 40 tables is fine
  assert.equal(ok.json.rooms.length, 40);
  await s.close();
});

test('meetings are isolated from each other', async () => {
  const s = await startServer();
  await seat(s, 3, 5, 'M1');
  const other = await s.call('GET', '/api/status', { header: host('M2') });
  assert.deepEqual(other.json.ready, []);
  await s.close();
});

test('clear wipes the meeting', async () => {
  const s = await startServer();
  await seat(s, 3, 5);
  assert.equal((await s.call('POST', '/api/clear', { header: host(), body: {} })).status, 200);
  assert.deepEqual((await s.call('GET', '/api/status', { header: host() })).json.ready, []);
  await s.close();
});

test('a parent can change or withdraw their code; one entry per person', async () => {
  const s = await startServer();
  const h = parent('same');
  await s.call('POST', '/api/code', { header: h, body: { code: code(5), participantUUID: 'A' } });
  await s.call('POST', '/api/code', { header: h, body: { code: code(0), participantUUID: 'A2' } });
  assert.deepEqual((await s.call('GET', '/api/status', { header: host() })).json.ready, ['A2']);
  await s.call('DELETE', '/api/code', { header: h });
  assert.deepEqual((await s.call('GET', '/api/status', { header: host() })).json.ready, []);
  await s.close();
});

test('a parent can check whether the server still has their code', async () => {
  const s = await startServer();
  const h = parent('chk');
  const ask = async (uuid) => (await s.call('GET', `/api/code/status?participantUUID=${uuid}`, { header: h })).json;
  assert.deepEqual(await ask('A'), { saved: false });
  await s.call('POST', '/api/code', { header: h, body: { code: code(5), participantUUID: 'A' } });
  assert.deepEqual(await ask('A'), { saved: true });
  assert.deepEqual(await ask('OTHER'), { saved: false }); // a new Zoom participant id needs a resend
  assert.equal((await s.call('GET', '/api/code/status?participantUUID=A', {})).status, 401);
  await s.close();
});

test('guessing codes is rate limited', async () => {
  const s = await startServer();
  const h = parent('guesser');
  let last;
  for (let i = 0; i < 14; i++) last = await s.call('POST', '/api/code', { header: h, body: { code: 'ZZZ-ZZ', participantUUID: 'g' } });
  assert.equal(last.status, 429);
  await s.close();
});

test('codes are forgotten after the idle limit', () => {
  let t = 1000;
  const store = new SessionStore({ ttlMs: 500, now: () => t });
  store.submit('M', 'u', 'P', { location: 0 });
  assert.equal(store.size, 1);
  t += 400; assert.equal(store.readyParticipants('M').length, 1);
  t += 600; assert.equal(store.readyParticipants('M').length, 0);
  assert.equal(store.size, 0);
});

test('in-client authorization uses PKCE once and keeps no tokens', async () => {
  const seen = [];
  const s = await startServer({ fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, json: async () => ({ access_token: 'secret' }) }; } });
  const h = parent('u1');
  const ch = (await s.call('GET', '/api/auth/challenge', { header: h })).json;
  assert.equal(ch.codeChallenge.length, 43);
  const done = await s.call('POST', '/api/auth/token', { header: h, body: { code: 'zoom-code', state: ch.state } });
  assert.deepEqual(done.json, { ok: true });
  const sent = new URLSearchParams(String(seen[0].init.body));
  assert.equal(sent.get('code'), 'zoom-code');
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(sent.get('code_verifier')).digest('base64url'), ch.codeChallenge);
  assert.ok(!done.text.includes('secret'));
  const replay = await s.call('POST', '/api/auth/token', { header: h, body: { code: 'zoom-code', state: ch.state } });
  assert.equal(replay.status, 403);
  const stolen = await s.call('GET', '/api/auth/challenge', { header: h });
  const other = await s.call('POST', '/api/auth/token', { header: parent('someone-else'), body: { code: 'c', state: stolen.json.state } });
  assert.equal(other.status, 403);
  await s.close();
});

test('security headers are present and the page loads', async () => {
  const s = await startServer();
  const r = await s.call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /The Village Table/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/zoom\.us/);
  assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.equal(r.headers.get('x-powered-by'), null);
  await s.close();
});

test('the server will not start without secrets', async () => {
  const { createApp } = await import('../server/app.js');
  assert.throws(() => createApp({ codeKey: CODE_KEY }), /CLIENT_SECRET/);
  assert.throws(() => createApp({ clientSecret: SECRET }), /CODE_KEY/);
  assert.ok(CLIENT_ID);
});
