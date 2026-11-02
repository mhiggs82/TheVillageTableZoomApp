import { api } from './api.js';
import { runPlan, describePlan, friendlyZoomError } from './orchestrate.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['loading', 'outside', 'signin', 'allow', 'parent', 'host'];
const show = (name) => VIEWS.forEach((v) => { $(v).hidden = v !== name; });

const PARENT_CAPS = ['getMeetingContext', 'getUserContext', 'getAppContext', 'getMeetingUUID', 'authorize', 'onAuthorized', 'onBreakoutRoomChange'];
const HOST_CAPS = [...PARENT_CAPS, 'getMeetingParticipants', 'onParticipantChange', 'createBreakoutRooms', 'assignParticipantToBreakoutRoom',
  'configureBreakoutRooms', 'openBreakoutRooms', 'closeBreakoutRooms', 'getBreakoutRoomList'];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const isHostRole = (r) => ['host', 'cohost'].includes(norm(r));

let sdk;
let user;
let isHost = false;

async function main() {
  sdk = window.zoomSdk;
  if (!sdk) return show('outside');
  let cfg;
  try { cfg = await sdk.config({ capabilities: HOST_CAPS, version: '0.16' }); } catch {
    try { cfg = await sdk.config({ capabilities: PARENT_CAPS, version: '0.16' }); } catch { return show('outside'); }
  }
  if (cfg.runningContext !== 'inMeeting') return show('outside');
  user = await sdk.getUserContext();
  if (user.status === 'unauthenticated') return show('signin');
  if (user.status !== 'authorized') return showAllow();
  start();
}

function showAllow() {
  show('allow');
  $('allow-btn').onclick = async () => {
    $('allow-error').textContent = '';
    try {
      const { codeChallenge, state } = await api(sdk, 'GET', '/api/auth/challenge');
      sdk.addEventListener('onAuthorized', async (ev) => {
        if (!ev.result) { $('allow-error').textContent = 'No problem. Tap the button again whenever you are ready.'; return; }
        try {
          await api(sdk, 'POST', '/api/auth/token', { code: ev.code, state: ev.state || state });
          user = await sdk.getUserContext();
          start();
        } catch (e) { $('allow-error').textContent = e.message; }
      });
      await sdk.authorize({ codeChallenge, state });
    } catch (e) { $('allow-error').textContent = e.message || 'Could not start. Try again.'; }
  };
}

function start() {
  isHost = isHostRole(user.role);
  if (isHost) startHost(); else startParent();
}

/* ---------------- parent ---------------- */
// The parent's own code is remembered in this app's storage on their device, never on our server,
// so they type it once. Storage may be unavailable or cleared, so every use is guarded.
const STORE_KEY = 'village-table-code';
const saved = {
  get() { try { return localStorage.getItem(STORE_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(STORE_KEY, v); } catch { /* storage unavailable */ } },
  clear() { try { localStorage.removeItem(STORE_KEY); } catch { /* storage unavailable */ } },
};
const FIRST_TIME = 'You are on the list. Keep this open or close it. You will be moved to your table when the host opens the rooms.';
const WELCOME_BACK = 'Welcome back. Your saved code is in, so there is nothing to type. You will be moved to your table when the host opens the rooms.';

function startParent() {
  show('parent');
  fetch('/api/config').then((r) => r.json()).then(({ formUrl }) => {
    if (formUrl) { $('form-anchor').href = formUrl; $('form-link').hidden = false; }
  }).catch(() => {});
  const input = $('code');

  const showDone = (text) => { $('code-done-text').textContent = text; $('code-form').hidden = true; $('code-done').hidden = false; };
  const submit = (code) => api(sdk, 'POST', '/api/code', { code, participantUUID: user.participantUUID });

  input.addEventListener('input', () => {
    const raw = input.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 5);
    input.value = raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
    $('code-msg').textContent = '';
  });

  $('code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('code-msg');
    if (input.value.replace('-', '').length !== 5) { msg.textContent = 'Codes have 5 characters. Check yours and try again.'; return; }
    $('code-save').disabled = true;
    try {
      await submit(input.value);
      saved.set(input.value);
      showDone(FIRST_TIME);
    } catch (err) {
      msg.textContent = err.status === 422 ? 'That code does not look right. Check each character and try again.' : err.message;
    } finally { $('code-save').disabled = false; }
  });

  $('code-change').addEventListener('click', async () => {
    saved.clear();
    try { await api(sdk, 'DELETE', '/api/code'); } catch { /* ignore */ }
    input.value = ''; $('code-done').hidden = true; $('code-form').hidden = false; input.focus();
  });

  // Returning parent: use the remembered code without asking.
  const remembered = saved.get();
  if (remembered) {
    submit(remembered).then(() => showDone(WELCOME_BACK)).catch((err) => {
      if (err.status === 422) saved.clear(); // no longer valid (for example the code format changed)
    });
  }

  // If the server forgets (a restart), quietly send the remembered code again.
  const every = Number(window.__VT_RESEND_MS) || 45000;
  setInterval(async () => {
    const code = saved.get();
    if (!code || document.hidden) return;
    try {
      const { saved: has } = await api(sdk, 'GET', `/api/code/status?participantUUID=${encodeURIComponent(user.participantUUID)}`);
      if (!has) await submit(code);
    } catch { /* try again next time */ }
  }, every);
}

/* ---------------- host ---------------- */
const state = { names: new Map(), present: [], ready: new Set(), plan: null, busy: false };

function setError(text) { $('host-error').textContent = text || ''; }

function renderCounts() {
  const waiting = state.present.filter((u) => !state.ready.has(u));
  $('n-present').textContent = String(state.present.length);
  $('n-ready').textContent = String(state.present.length - waiting.length);
  $('n-waiting').textContent = String(waiting.length);
  $('waiting-box').hidden = waiting.length === 0;
  const list = $('waiting-list');
  list.replaceChildren(...waiting.map((u) => { const li = document.createElement('li'); li.textContent = state.names.get(u) || 'A parent'; return li; }));
}

async function refresh() {
  try {
    const { participants } = await sdk.getMeetingParticipants();
    const guests = participants.filter((p) => !isHostRole(p.role));
    state.names = new Map(guests.map((p) => [p.participantUUID, p.screenName]));
    state.present = guests.map((p) => p.participantUUID);
    const { ready } = await api(sdk, 'GET', '/api/status', undefined, user.role);
    state.ready = new Set(ready);
    renderCounts();
  } catch (e) { setError(e.message); }
}

function currentMode() { return document.querySelector('input[name="mode"]:checked').value; }
function currentSize() { return Math.min(10, Math.max(2, parseInt($('size').value, 10) || 3)); }

async function preview() {
  setError(''); $('result').hidden = true; $('result-fails').replaceChildren();
  await refresh();
  try {
    const plan = await api(sdk, 'POST', '/api/plan', { mode: currentMode(), roomSize: currentSize(), participants: state.present }, user.role);
    state.plan = plan;
    if (!plan.rooms.length) {
      $('preview-box').hidden = true;
      setError('No codes are in yet. Ask parents to open The Village Table and enter their code.');
      return;
    }
    const d = describePlan(plan.rooms);
    $('preview-text').textContent = `${d.tables} ${d.tables === 1 ? 'table' : 'tables'}: ${d.summary}. ${d.people} parents will be seated.`;
    $('preview-note').textContent = plan.waiting.length
      ? `${plan.waiting.length} without a code will stay in the main room.`
      : 'Everyone here has a code.';
    $('preview-box').hidden = false;
    $('reshuffle').hidden = !['smart', 'random'].includes(currentMode());
  } catch (e) { setError(e.message); }
}

async function openTables() {
  if (!state.plan || state.busy) return;
  state.busy = true; setError('');
  $('open').disabled = true;
  try {
    const out = await runPlan(sdk, state.plan, { minutes: parseInt($('minutes').value, 10) || 0, open: true });
    $('result').textContent = out.failed.length
      ? `Opened ${out.tables} tables. ${out.failed.length} could not be seated automatically.`
      : `Opened ${out.tables} tables. Everyone was seated.`;
    $('result').hidden = false;
    $('result-fails').replaceChildren(...out.failed.map((f) => { const li = document.createElement('li'); li.textContent = `${state.names.get(f.participantUUID) || 'A parent'}: ${f.message}`; return li; }));
    $('preview-box').hidden = true;
  } catch (e) { setError(friendlyZoomError(e)); } finally { state.busy = false; $('open').disabled = false; }
}

function startHost() {
  show('host');
  $('preview').addEventListener('click', preview);
  $('reshuffle').addEventListener('click', preview);
  $('open').addEventListener('click', openTables);
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => { $('preview-box').hidden = true; $('reshuffle').hidden = true; }));
  $('size-minus').addEventListener('click', () => { $('size').value = Math.max(2, currentSize() - 1); $('preview-box').hidden = true; });
  $('size-plus').addEventListener('click', () => { $('size').value = Math.min(10, currentSize() + 1); $('preview-box').hidden = true; });
  $('size').addEventListener('change', () => { $('size').value = currentSize(); $('preview-box').hidden = true; });
  $('close-tables').addEventListener('click', async () => {
    try { await sdk.closeBreakoutRooms(); setError(''); } catch (e) { setError(friendlyZoomError(e)); }
  });
  $('clear').addEventListener('click', async () => {
    try { await api(sdk, 'POST', '/api/clear', {}, user.role); state.ready = new Set(); state.plan = null; $('preview-box').hidden = true; renderCounts(); setError(''); } catch (e) { setError(e.message); }
  });
  try { sdk.addEventListener('onParticipantChange', refresh); } catch { /* polling covers it */ }
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}

main().catch(() => show('outside'));
