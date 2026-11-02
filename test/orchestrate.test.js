import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlan, describePlan, friendlyZoomError } from '../public/orchestrate.js';

// A stand-in for Zoom's SDK that records every call and can be told to fail.
function fakeSdk({ failAssign = () => false, rooms } = {}) {
  const calls = [];
  return {
    calls,
    async createBreakoutRooms(o) { calls.push(['create', o]); return { rooms: rooms ? rooms(o) : o.names.map((name, i) => ({ name, breakoutRoomId: `room-${i}` })), state: 'closed' }; },
    async assignParticipantToBreakoutRoom(o) { calls.push(['assign', o]); if (failAssign(o, calls.filter((c) => c[0] === 'assign').length)) { const e = new Error('Participant not found'); e.code = 10075; throw e; } return { message: 'success' }; },
    async configureBreakoutRooms(o) { calls.push(['configure', o]); return {}; },
    async openBreakoutRooms() { calls.push(['open']); return { message: 'success' }; },
  };
}
const plan = { rooms: [['a', 'b', 'c'], ['d', 'e', 'f', 'g']] };

test('creates neutral tables, seats everyone, then opens', async () => {
  const sdk = fakeSdk();
  const out = await runPlan(sdk, plan, { minutes: 20, pauseMs: 0 });
  assert.deepEqual(sdk.calls.map((c) => c[0]), ['create', ...Array(7).fill('assign'), 'configure', 'open']);
  assert.deepEqual(sdk.calls[0][1], { numberOfRooms: 2, assign: 'manually', names: ['Table 1', 'Table 2'] });
  const seated = sdk.calls.filter((c) => c[0] === 'assign').map((c) => [c[1].participantUUID, c[1].uuid]);
  assert.deepEqual(seated, [['a', 'room-0'], ['b', 'room-0'], ['c', 'room-0'], ['d', 'room-1'], ['e', 'room-1'], ['f', 'room-1'], ['g', 'room-1']]);
  const cfg = sdk.calls.find((c) => c[0] === 'configure')[1];
  assert.equal(cfg.automaticallyMoveParticipantsIntoRooms, true);
  assert.equal(cfg.allowParticipantsChooseRoom, false);
  assert.equal(cfg.closeAfter, 20);
  assert.deepEqual(out, { tables: 2, assigned: 7, failed: [], opened: true });
});

test('room names never reveal why people were grouped', async () => {
  const sdk = fakeSdk();
  await runPlan(sdk, { rooms: [['a'], ['b']] }, { pauseMs: 0 });
  for (const n of sdk.calls[0][1].names) assert.match(n, /^Table \d+$/);
});

test('a one-off failure is retried and succeeds', async () => {
  const sdk = fakeSdk({ failAssign: (o, count) => o.participantUUID === 'b' && count === 2 });
  const out = await runPlan(sdk, plan, { pauseMs: 0 });
  assert.equal(out.assigned, 7);
  assert.deepEqual(out.failed, []);
});

test('a parent who cannot be seated is reported, and everyone else still is', async () => {
  const sdk = fakeSdk({ failAssign: (o) => o.participantUUID === 'e' });
  const out = await runPlan(sdk, plan, { pauseMs: 0 });
  assert.equal(out.assigned, 6);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].participantUUID, 'e');
  assert.equal(sdk.calls.at(-1)[0], 'open'); // rooms still open for the rest
});

test('tables can be prepared without opening them', async () => {
  const sdk = fakeSdk();
  const out = await runPlan(sdk, plan, { open: false, pauseMs: 0 });
  assert.equal(out.opened, false);
  assert.ok(!sdk.calls.some((c) => c[0] === 'open'));
});

test('if Zoom does not return every table, nothing is assigned', async () => {
  const sdk = fakeSdk({ rooms: () => [{ name: 'Table 1', breakoutRoomId: 'x' }] });
  await assert.rejects(runPlan(sdk, plan, { pauseMs: 0 }), /every table/);
  assert.ok(!sdk.calls.some((c) => c[0] === 'assign'));
});

test('table ids are matched by name even if Zoom returns them in another order', async () => {
  const sdk = fakeSdk({ rooms: (o) => [...o.names].reverse().map((name, i) => ({ name, breakoutRoomId: `id-${name}` })) });
  await runPlan(sdk, plan, { pauseMs: 0 });
  const first = sdk.calls.find((c) => c[0] === 'assign')[1];
  assert.equal(first.uuid, 'id-Table 1');
});

test('summary and error wording', () => {
  assert.deepEqual(describePlan([[1, 2, 3], [4, 5, 6], [7, 8, 9, 10]]), { tables: 3, people: 10, summary: '2 of 3, 1 of 4' });
  assert.match(friendlyZoomError({ code: 10121 }), /already open/);
  assert.match(friendlyZoomError({ code: 10097 }), /breakout rooms are turned on/);
});
