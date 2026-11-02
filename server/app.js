import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { decodeCode, encodeProfile } from './codec.js';
import { decryptContext } from './context.js';
import { makePlan } from './matcher.js';
import { SessionStore } from './store.js';
import { MODES, MIN_ROOM_SIZE, MAX_ROOM_SIZE, MAX_ROOMS, LOCATIONS, LIFE_STAGES, FAMILY } from './model.js';

const here = path.dirname(fileURLToPath(import.meta.url));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function limiter(max, windowMs, now) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const recent = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(t);
    hits.set(key, recent);
    return true;
  };
}

/**
 * config: { clientId, clientSecret, codeKey, redirectUri, formUrl, allowClientRole, store, now, fetchImpl, log }
 */
export function createApp(config) {
  const {
    clientId = '', clientSecret, codeKey, redirectUri = '', formUrl = '',
    allowClientRole = false, now = () => Date.now(), fetchImpl = fetch, log = console,
  } = config;
  if (!clientSecret) throw new Error('ZOOM_APP_CLIENT_SECRET is required');
  if (!codeKey) throw new Error('CODE_KEY is required');
  const store = config.store || new SessionStore({ now });
  const codeAttempts = limiter(12, 5 * 60 * 1000, now);
  const encodeAttempts = limiter(30, 5 * 60 * 1000, now);
  const pkce = new Map(); // state -> { verifier, exp }
  let loggedContextKeys = false;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Security headers Zoom's review expects.
  app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' https://appssdk.zoom.us",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'self' https://zoom.us https://*.zoom.us",
    ].join('; '));
    next();
  });
  app.use(express.json({ limit: '50kb' }));
  app.use(express.static(path.join(here, '..', 'public'), { index: 'index.html' }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---- intake form: answers are turned into a code here, so the secret key never reaches a browser.
  // Nothing about the answers is stored or logged.
  const intakeDir = path.join(here, 'intake');
  app.get('/code', (req, res) => res.sendFile(path.join(intakeDir, 'intake.html')));
  app.get('/code/intake.css', (req, res) => res.sendFile(path.join(intakeDir, 'intake.css')));
  app.get('/code/intake.js', (req, res) => res.sendFile(path.join(intakeDir, 'intake.js')));

  const inRange = (v, n) => Number.isInteger(v) && v >= 0 && v < n;
  app.post('/api/encode', (req, res) => {
    if (!encodeAttempts(req.ip)) throw new HttpError(429, 'Too many tries. Please wait a few minutes.');
    const { location, bands, life, family } = req.body || {};
    const okBands = Array.isArray(bands) && bands.length >= 1 && bands.length <= 4 && bands.every((b) => Number.isInteger(b) && b >= 1 && b <= 4);
    if (!inRange(location, LOCATIONS.length) || !okBands || !inRange(life, LIFE_STAGES.length) || !inRange(family, FAMILY.length)) {
      throw new HttpError(400, 'Please answer every question so your code is accurate.');
    }
    res.json({ code: encodeProfile(codeKey, { location, bands, life, family }) });
  });
  app.get('/api/config', (req, res) => res.json({ formUrl }));

  // ---- who is calling? (decrypted from Zoom's context, never trusted from the browser)
  function who(req) {
    const header = req.get('x-zoom-app-context');
    if (!header) throw new HttpError(401, 'open this app inside a Zoom meeting');
    let ctx;
    try { ctx = decryptContext(header, clientSecret); } catch { throw new HttpError(401, 'invalid Zoom context'); }
    if (clientId && ctx.aud && ctx.aud !== clientId) throw new HttpError(401, 'wrong app');
    if (typeof ctx.exp === 'number') {
      const expMs = ctx.exp < 1e12 ? ctx.exp * 1000 : ctx.exp; // tolerate seconds or milliseconds
      if (expMs < now()) throw new HttpError(401, 'Zoom session expired, reopen the app');
    }
    if (!loggedContextKeys) {
      loggedContextKeys = true;
      log.info?.(`[village-table] Zoom context fields seen: ${Object.keys(ctx).sort().join(', ')}`);
    }
    const meetingKey = ctx.pid || ctx.mid;
    if (!meetingKey || !ctx.uid) throw new HttpError(400, 'open this app inside a Zoom meeting');
    const role = String(ctx.attendrole ?? ctx.role ?? '').toLowerCase().replace(/[^a-z]/g, '');
    let isHost = role === 'host' || role === 'cohost';
    if (!role && allowClientRole) {
      const claimed = String(req.get('x-claimed-role') || '').toLowerCase().replace(/[^a-z]/g, '');
      isHost = claimed === 'host' || claimed === 'cohost';
    }
    return { meetingKey: String(meetingKey), uid: String(ctx.uid), isHost };
  }
  const guard = (needHost) => (req, res, next) => {
    try {
      req.who = who(req);
      if (needHost && !req.who.isHost) throw new HttpError(403, 'only the host can do this');
      next();
    } catch (e) { next(e); }
  };

  // Express 4 does not catch errors thrown inside async handlers, so forward them ourselves.
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const isUuid = (s) => typeof s === 'string' && s.length > 0 && s.length <= 128;

  // ---- parents
  app.post('/api/code', guard(false), (req, res) => {
    const { code, participantUUID } = req.body || {};
    if (!isUuid(participantUUID)) throw new HttpError(400, 'missing participant');
    if (!codeAttempts(req.who.uid)) throw new HttpError(429, 'too many tries, wait a few minutes');
    const profile = decodeCode(codeKey, code);
    if (!profile) throw new HttpError(422, 'That code does not look right.');
    store.submit(req.who.meetingKey, req.who.uid, participantUUID, profile);
    res.json({ ok: true }); // never echoes what the code contains
  });

  // Lets a parent's panel check whether the server still has their code (it forgets on restart).
  app.get('/api/code/status', guard(false), (req, res) => {
    const participantUUID = String(req.query.participantUUID || '');
    res.json({ saved: store.hasEntry(req.who.meetingKey, req.who.uid, participantUUID) });
  });

  app.delete('/api/code', guard(false), (req, res) => {
    store.withdraw(req.who.meetingKey, req.who.uid);
    res.json({ ok: true });
  });

  // ---- host only
  app.get('/api/status', guard(true), (req, res) => {
    res.json({ ready: store.readyParticipants(req.who.meetingKey) });
  });

  app.post('/api/plan', guard(true), (req, res) => {
    const { mode = 'smart', roomSize = 3, participants, seed } = req.body || {};
    if (!MODES.includes(mode)) throw new HttpError(400, 'unknown mode');
    if (!Number.isInteger(roomSize) || roomSize < MIN_ROOM_SIZE || roomSize > MAX_ROOM_SIZE) throw new HttpError(400, 'room size must be 2 to 10');
    if (!Array.isArray(participants) || participants.length > 1000 || !participants.every(isUuid)) throw new HttpError(400, 'bad participant list');
    const known = store.profilesByParticipant(req.who.meetingKey);
    const present = [...new Set(participants)];
    const ready = present.filter((u) => known.has(u));
    const waiting = present.filter((u) => !known.has(u));
    if (!ready.length) return res.json({ rooms: [], waiting, mode, roomSize });
    if (Math.floor(ready.length / roomSize) > MAX_ROOMS) throw new HttpError(400, 'Too many tables for Zoom (50 maximum). Raise the room size.');
    const plan = makePlan(ready.map((u) => known.get(u)), { mode, roomSize, seed: Number.isInteger(seed) ? seed : undefined });
    if (plan.rooms.length > MAX_ROOMS) throw new HttpError(400, 'Too many tables for Zoom (50 maximum). Raise the room size.');
    // Only who sits with whom leaves the server, never what anyone's code contained.
    res.json({ rooms: plan.rooms.map((r) => r.map((i) => ready[i])), waiting, mode, roomSize });
  });

  app.post('/api/clear', guard(true), (req, res) => {
    store.clear(req.who.meetingKey);
    res.json({ ok: true });
  });

  // ---- in-client OAuth (PKCE). Tokens are used once and discarded: the app needs no stored access.
  app.get('/api/auth/challenge', guard(false), (req, res) => {
    for (const [s, v] of pkce) if (v.exp < now()) pkce.delete(s);
    const verifier = crypto.randomBytes(32).toString('hex');
    const state = crypto.randomBytes(16).toString('hex');
    pkce.set(state, { verifier, exp: now() + 10 * 60 * 1000, uid: req.who.uid });
    res.json({ codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'), state });
  });

  app.post('/api/auth/token', guard(false), wrap(async (req, res) => {
    const { code, state } = req.body || {};
    const saved = pkce.get(state);
    if (!saved || saved.exp < now() || saved.uid !== req.who.uid || typeof code !== 'string') throw new HttpError(403, 'invalid state');
    pkce.delete(state);
    const r = await fetchImpl('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: saved.verifier }),
    });
    if (!r.ok) throw new HttpError(502, 'Zoom did not accept the authorization');
    res.json({ ok: true }); // token deliberately dropped here
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) log.error?.('[village-table]', err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong. Try again.' : err.message });
  });

  app.store = store;
  return app;
}
