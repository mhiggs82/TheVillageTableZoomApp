import { createApp } from '../server/app.js';
import { encryptContext } from '../server/context.js';

export const SECRET = 'test-client-secret-0123456789';
export const CLIENT_ID = 'test-client-id';
export const CODE_KEY = 'demo-key-change-me';

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function randomProfile(r) {
  const n = 1 + Math.floor(r() * 4);
  return {
    location: Math.floor(r() * 11),
    bands: Array.from({ length: n }, () => 1 + Math.floor(r() * 4)),
    life: Math.floor(r() * 5),
    family: Math.floor(r() * 6),
  };
}

export function ctx({ uid = 'u1', meeting = 'M1', role = 'participant', exp, aud = CLIENT_ID, secret = SECRET } = {}) {
  return encryptContext({ typ: 'meeting', uid, mid: meeting, aud, ts: Date.now(), exp: exp ?? Date.now() + 3600e3, attendrole: role }, secret);
}

const openServers = new Set();
export async function closeAll() { for (const s of [...openServers]) await s.close(); }

export async function startServer(opts = {}) {
  const app = createApp({ clientId: CLIENT_ID, clientSecret: SECRET, codeKey: CODE_KEY, formUrl: 'https://example.org/form', redirectUri: 'https://example.org/auth', log: { info() {}, error() {} }, ...opts });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { header, body, raw } = {}) => {
    const headers = {};
    if (header) headers['x-zoom-app-context'] = header;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers, raw };
  };
  const handle = { app, base, call, close: () => { openServers.delete(handle); server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
  openServers.add(handle);
  return handle;
}
