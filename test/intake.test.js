// The intake form at /code: answers become a code on the server, so the secret key never reaches a browser.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, closeAll, CODE_KEY } from './helpers.js';
import { encodeProfile, decodeCode } from '../server/codec.js';

const require = createRequire(import.meta.url);
after(closeAll);

const answers = { location: 7, bands: [3, 1], life: 2, family: 1 };

test('/code serves the form and its files, and none of them contain the secret key', async () => {
  const s = await startServer();
  for (const p of ['/code', '/code/intake.css', '/code/intake.js']) {
    const r = await s.call('GET', p);
    assert.equal(r.status, 200, p);
    assert.ok(!r.text.includes(CODE_KEY), `${p} must not contain the key`);
  }
  const html = (await s.call('GET', '/code')).text;
  assert.ok(html.includes('GetParentWise'));
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html) && !/<style/i.test(html), 'no inline script or style (the CSP blocks them)');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(html), 'no external fonts (the CSP blocks them)');
  assert.ok(!html.includes('—'), 'no em dashes in copy');
  await s.close();
});

test('the server turns answers into the same code the matcher reads back', async () => {
  const s = await startServer();
  const r = await s.call('POST', '/api/encode', { body: answers });
  assert.equal(r.status, 200);
  assert.equal(r.json.code, encodeProfile(CODE_KEY, answers));
  assert.deepEqual(decodeCode(CODE_KEY, r.json.code), { location: 7, bands: [1, 3], life: 2, family: 1 });
  await s.close();
});

test('incomplete or out-of-range answers are refused', async () => {
  const s = await startServer();
  const bad = [
    undefined, {}, { ...answers, location: 11 }, { ...answers, location: -1 }, { ...answers, location: '7' },
    { ...answers, bands: [] }, { ...answers, bands: [0] }, { ...answers, bands: [5] }, { ...answers, bands: [1, 1, 1, 1, 1] },
    { ...answers, bands: 'x' }, { ...answers, life: 5 }, { ...answers, family: 6 }, { ...answers, family: 1.5 },
  ];
  for (const body of bad) {
    const r = await s.call('POST', '/api/encode', { body: body === undefined ? {} : body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.json.error);
  }
  await s.close();
});

test('encoding is rate limited per address and nothing about the answers is logged', async () => {
  const lines = [];
  const spy = { info: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) };
  const s = await startServer({ log: spy });
  let last;
  for (let i = 0; i < 31; i++) last = await s.call('POST', '/api/encode', { body: answers });
  assert.equal(last.status, 429);
  assert.deepEqual(lines, []);
  await s.close();
});

test('the form works in a real browser under the app\'s security policy', async () => {
  const { chromium } = require('playwright');
  const s = await startServer();
  const browser = await chromium.launch();
  const issues = [];
  const page = await (await browser.newContext({ viewport: { width: 400, height: 900 } })).newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) issues.push(m.text()); });
  page.on('pageerror', (e) => issues.push(String(e)));
  await page.goto(s.base + '/code');
  await page.selectOption('#where', '7');
  await page.selectOption('#count', '2');
  await page.selectOption('#age1', '3');
  await page.selectOption('#age2', '1');
  await page.selectOption('#life', '2');
  await page.selectOption('#family', '1');
  await page.click('button[type="submit"]');
  await page.waitForSelector('#result:not([hidden])');
  const shown = (await page.textContent('#code')).trim();
  assert.equal(shown, encodeProfile(CODE_KEY, answers));
  assert.deepEqual(issues, []);
  await browser.close();
  await s.close();
});
