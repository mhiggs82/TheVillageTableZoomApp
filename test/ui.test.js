// Simulated Zoom meeting: real server, real pages in a real browser, a stand-in for Zoom's SDK.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, closeAll, ctx, CODE_KEY } from './helpers.js';
import { encodeProfile } from '../server/codec.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
after(closeAll);

const code = (location, band) => encodeProfile(CODE_KEY, { location, bands: [band], life: 1, family: 0 });

function sdkScript({ user, header, participants = [], status = user?.status }) {
  return `
    window.__calls = []; window.__handlers = {};
    const rec = (n, a) => { window.__calls.push([n, a]); };
    window.zoomSdk = {
      async config(o) { rec('config', o); return { runningContext: 'inMeeting' }; },
      async getUserContext() { return ${JSON.stringify({ ...user, status })}; },
      async getAppContext() { return { context: ${JSON.stringify(header)} }; },
      async getMeetingParticipants() { return { participants: ${JSON.stringify(participants)} }; },
      addEventListener(n, f) { window.__handlers[n] = f; },
      async authorize(o) { rec('authorize', o); setTimeout(() => window.__handlers.onAuthorized && window.__handlers.onAuthorized({ result: true, code: 'zoom-code', state: o.state }), 50); },
      async createBreakoutRooms(o) { rec('create', o); return { rooms: o.names.map((name, i) => ({ name, breakoutRoomId: 'rm' + i })), state: 'closed' }; },
      async assignParticipantToBreakoutRoom(o) { rec('assign', o); return { message: 'success' }; },
      async configureBreakoutRooms(o) { rec('configure', o); return {}; },
      async openBreakoutRooms() { rec('open', {}); return {}; },
      async closeBreakoutRooms() { rec('close', {}); return {}; },
    };`;
}

async function openPage(browser, base, { sdk, issues, context: shared, init }) {
  const context = shared || await browser.newContext({ viewport: { width: 400, height: 900 } });
  const page = await context.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) issues.push(m.text()); });
  page.on('pageerror', (e) => issues.push(String(e)));
  await page.route('https://appssdk.zoom.us/**', (r) => r.fulfill({ contentType: 'text/javascript', body: '/* real SDK not needed in tests */' }));
  if (init) await page.addInitScript(init);
  if (sdk) await page.addInitScript(sdkScript(sdk));
  await page.goto(base + '/');
  return page;
}

test('a full meeting: parents enter codes, the host seats them, tables match', async () => {
  const issues = [];
  const server = await startServer({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  const browser = await chromium.launch();
  try {
    const parents = [
      { id: 'A1', loc: 5, band: 2 }, { id: 'A2', loc: 5, band: 2 }, { id: 'A3', loc: 5, band: 2 },
      { id: 'M1', loc: 0, band: 3 }, { id: 'M2', loc: 0, band: 3 }, { id: 'M3', loc: 0, band: 3 },
    ];
    for (const p of parents) {
      const user = { status: 'authorized', role: 'attendee', participantUUID: p.id, screenName: `Parent ${p.id}` };
      const page = await openPage(browser, server.base, { issues, sdk: { user, header: ctx({ uid: `uid-${p.id}`, role: 'participant' }) } });
      await page.waitForSelector('#parent:not([hidden])');
      await page.fill('#code', code(p.loc, p.band).toLowerCase().replace('-', ''));
      assert.match(await page.inputValue('#code'), /^[0-9A-Z]{3}-[0-9A-Z]{2}$/); // auto-formats
      await page.click('#code-save');
      await page.waitForSelector('#code-done:not([hidden])');
      assert.match(await page.textContent('#code-done'), /You are on the list/);
      await page.context().close();
    }

    const everyone = [
      { screenName: 'Host', participantUUID: 'H', role: 'host' },
      ...parents.map((p) => ({ screenName: `Parent ${p.id}`, participantUUID: p.id, role: 'attendee' })),
      { screenName: 'Late Joiner', participantUUID: 'LATE', role: 'attendee' },
    ];
    const hostUser = { status: 'authorized', role: 'host', participantUUID: 'H', screenName: 'Host' };
    const host = await openPage(browser, server.base, { issues, sdk: { user: hostUser, header: ctx({ uid: 'host-uid', role: 'host' }), participants: everyone } });
    await host.waitForSelector('#host:not([hidden])');
    await host.waitForFunction(() => document.getElementById('n-ready').textContent === '6');
    assert.equal(await host.textContent('#n-present'), '7');
    assert.equal(await host.textContent('#n-waiting'), '1');
    await host.click('#waiting-box summary');
    assert.match(await host.textContent('#waiting-list'), /Late Joiner/);
    assert.equal(await host.locator('input[name="mode"]').count(), 7);

    await host.check('input[name="mode"][value="city"]');
    await host.click('#preview');
    await host.waitForSelector('#preview-box:not([hidden])');
    assert.equal(await host.textContent('#preview-text'), '2 tables: 2 of 3. 6 parents will be seated.');
    assert.match(await host.textContent('#preview-note'), /1 without a code will stay in the main room/);
    await host.screenshot({ path: '/tmp/vt-host.png', fullPage: true });

    await host.click('#open');
    await host.waitForSelector('#result:not([hidden])');
    assert.match(await host.textContent('#result'), /Opened 2 tables\. Everyone was seated\./);

    const calls = await host.evaluate(() => window.__calls);
    const names = calls.map((c) => c[0]);
    assert.deepEqual(names.filter((n) => ['create', 'configure', 'open'].includes(n)), ['create', 'configure', 'open']);
    assert.equal(names.indexOf('create') < names.indexOf('assign'), true);
    assert.equal(names.lastIndexOf('assign') < names.indexOf('open'), true);
    const seated = calls.filter((c) => c[0] === 'assign').map((c) => c[1]);
    assert.equal(seated.length, 6);
    assert.ok(!seated.some((s) => s.participantUUID === 'LATE' || s.participantUUID === 'H'));
    const byRoom = new Map();
    for (const s of seated) byRoom.set(s.uuid, [...(byRoom.get(s.uuid) || []), s.participantUUID[0]]);
    assert.equal(byRoom.size, 2);
    for (const members of byRoom.values()) assert.equal(new Set(members).size, 1, `mixed table: ${members}`); // Amsterdam together, Madrid together
    assert.equal(calls.find((c) => c[0] === 'configure')[1].closeAfter, 20);
    assert.deepEqual(calls.find((c) => c[0] === 'create')[1].names, ['Table 1', 'Table 2']);

    await host.click('#close-tables');
    await host.waitForFunction(() => window.__calls.some((c) => c[0] === 'close'));
    await host.click('#clear');
    await host.waitForFunction(() => document.getElementById('n-ready').textContent === '0');
    await host.context().close();
  } finally { await browser.close(); }
  assert.deepEqual(issues.filter((i) => !/Failed to load resource/.test(i)), []);
});

test('random shuffle and a segment mode both run end to end', async () => {
  const issues = [];
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (const id of ids) {
      const page = await openPage(browser, server.base, { issues, sdk: { user: { status: 'authorized', role: 'attendee', participantUUID: id, screenName: id }, header: ctx({ uid: `u-${id}` }) } });
      await page.fill('#code', code(id < 'e' ? 7 : 8, id < 'd' ? 1 : 4));
      await page.click('#code-save');
      await page.waitForSelector('#code-done:not([hidden])');
      await page.context().close();
    }
    const everyone = [{ screenName: 'H', participantUUID: 'H', role: 'host' }, ...ids.map((id) => ({ screenName: id, participantUUID: id, role: 'attendee' }))];
    const host = await openPage(browser, server.base, { issues, sdk: { user: { status: 'authorized', role: 'host', participantUUID: 'H', screenName: 'H' }, header: ctx({ uid: 'h', role: 'host' }), participants: everyone } });
    await host.waitForFunction(() => document.getElementById('n-ready').textContent === '7');
    await host.check('input[name="mode"][value="random"]');
    await host.click('#preview');
    await host.waitForSelector('#preview-box:not([hidden])');
    assert.equal(await host.textContent('#preview-text'), '2 tables: 1 of 3, 1 of 4. 7 parents will be seated.');
    assert.equal(await host.isVisible('#reshuffle'), true);
    await host.click('#size-plus'); // 4 per table -> one table of 7
    assert.equal(await host.inputValue('#size'), '4');
    await host.check('input[name="mode"][value="age"]');
    await host.click('#preview');
    await host.waitForSelector('#preview-box:not([hidden])');
    assert.equal(await host.textContent('#preview-text'), '1 table: 1 of 7. 7 parents will be seated.');
    await host.context().close();
  } finally { await browser.close(); }
  assert.deepEqual(issues.filter((i) => !/Failed to load resource/.test(i)), []);
});

test('wrong codes, sign-in, authorization and outside-Zoom screens', async () => {
  const issues = [];
  const server = await startServer({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  const browser = await chromium.launch();
  try {
    const user = { role: 'attendee', participantUUID: 'p', screenName: 'p' };
    // wrong code
    let page = await openPage(browser, server.base, { issues, sdk: { user: { ...user, status: 'authorized' }, header: ctx({ uid: 'x1' }) } });
    await page.fill('#code', 'ZZZ-ZZ');
    await page.click('#code-save');
    await page.waitForFunction(() => document.getElementById('code-msg').textContent.length > 0);
    assert.match(await page.textContent('#code-msg'), /does not look right/);
    await page.fill('#code', 'AB');
    await page.click('#code-save');
    assert.match(await page.textContent('#code-msg'), /5 characters/);
    assert.equal(await page.isVisible('#form-link'), true); // link to the intake form
    await page.context().close();
    // not signed in
    page = await openPage(browser, server.base, { issues, sdk: { user: { ...user, status: 'unauthenticated' }, header: ctx({ uid: 'x2' }) } });
    await page.waitForSelector('#signin:not([hidden])');
    assert.match(await page.textContent('#signin'), /Guests and phones cannot be placed/);
    await page.context().close();
    // signed in but has not added the app
    page = await openPage(browser, server.base, { issues, sdk: { user: { ...user, status: 'authenticated' }, header: ctx({ uid: 'x3' }) } });
    await page.waitForSelector('#allow:not([hidden])');
    await page.click('#allow-btn');
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'authorize'));
    const auth = await page.evaluate(() => window.__calls.find((c) => c[0] === 'authorize')[1]);
    assert.equal(auth.codeChallenge.length, 43);
    await page.context().close();
    // opened outside Zoom
    page = await openPage(browser, server.base, { issues, sdk: null });
    await page.waitForSelector('#outside:not([hidden])');
    assert.match(await page.textContent('#outside'), /works inside a Zoom meeting/);
    await page.screenshot({ path: '/tmp/vt-parent.png', fullPage: true });
    await page.context().close();
  } finally { await browser.close(); }
  assert.deepEqual(issues.filter((i) => !/Failed to load resource/.test(i)), []);
});

test('a parent types the code once; it is remembered on their device for every later call', async () => {
  const issues = [];
  const server = await startServer();
  const browser = await chromium.launch();
  const hostHeader = ctx({ uid: 'host-uid', role: 'host' });
  const ready = async () => (await server.call('GET', '/api/status', { header: hostHeader })).json.ready;
  try {
    const device = await browser.newContext({ viewport: { width: 400, height: 900 } }); // one parent's computer
    const me = (uuid) => ({ user: { status: 'authorized', role: 'attendee', participantUUID: uuid, screenName: 'Me' }, header: ctx({ uid: 'same-parent', role: 'participant' }) });
    const myCode = code(7, 2);

    // First call: type the code.
    let page = await openPage(browser, server.base, { issues, context: device, sdk: me('P1') });
    await page.fill('#code', myCode);
    await page.click('#code-save');
    await page.waitForSelector('#code-done:not([hidden])');
    assert.match(await page.textContent('#code-done-text'), /You are on the list/);
    assert.equal(await page.evaluate(() => localStorage.getItem('village-table-code')), myCode);
    await page.close();

    // The next call, a new meeting session (new participant id): nothing to type.
    await server.app.store.clear('M1');
    page = await openPage(browser, server.base, { issues, context: device, sdk: me('P2') });
    await page.waitForSelector('#code-done:not([hidden])');
    assert.match(await page.textContent('#code-done-text'), /Welcome back/);
    assert.equal(await page.isVisible('#code-form'), false);
    assert.deepEqual(await ready(), ['P2']);

    // The server restarts and forgets: the panel quietly sends the code again.
    server.app.store.clear('M1');
    assert.deepEqual(await ready(), []);
    await page.close();
    page = await openPage(browser, server.base, { issues, context: device, sdk: me('P3'), init: 'window.__VT_RESEND_MS = 150;' });
    await page.waitForSelector('#code-done:not([hidden])');
    server.app.store.clear('M1');
    for (let i = 0; i < 40 && !(await ready()).length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await ready(), ['P3']);

    // Choosing a different code forgets the old one on this device and on the server.
    await page.click('#code-change');
    await page.waitForSelector('#code-form:not([hidden])');
    assert.equal(await page.evaluate(() => localStorage.getItem('village-table-code')), null);
    for (let i = 0; i < 40 && (await ready()).length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await ready(), []);
    await page.close();
    await device.close();
  } finally { await browser.close(); }
  assert.deepEqual(issues.filter((i) => !/Failed to load resource/.test(i)), []);
});

test('an out-of-date saved code is dropped, and blocked storage never breaks the panel', async () => {
  const issues = [];
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    const me = (uid) => ({ user: { status: 'authorized', role: 'attendee', participantUUID: uid, screenName: 'Me' }, header: ctx({ uid, role: 'participant' }) });
    // saved code that no longer decodes (for example the secret key changed)
    let page = await openPage(browser, server.base, { issues, sdk: me('s1'), init: "localStorage.setItem('village-table-code', 'ZZZ-ZZ');" });
    await page.waitForSelector('#parent:not([hidden])');
    await page.waitForFunction(() => localStorage.getItem('village-table-code') === null);
    assert.equal(await page.isVisible('#code-form'), true);
    await page.context().close();
    // storage that throws on every use
    const blocked = "Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });";
    page = await openPage(browser, server.base, { issues, sdk: me('s2'), init: blocked });
    await page.waitForSelector('#parent:not([hidden])');
    await page.fill('#code', code(5, 3));
    await page.click('#code-save');
    await page.waitForSelector('#code-done:not([hidden])');
    await page.context().close();
  } finally { await browser.close(); }
  assert.deepEqual(issues.filter((i) => !/Failed to load resource/.test(i)), []);
});
