// Turns a plan ({ rooms: [[participantUUID, ...], ...] }) into Zoom breakout rooms through the
// Zoom Apps SDK. Kept free of page code so it can be tested against a stand-in SDK.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function describePlan(rooms) {
  const counts = new Map();
  for (const r of rooms) counts.set(r.length, (counts.get(r.length) || 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([size, n]) => `${n} of ${size}`);
  return { tables: rooms.length, people: rooms.reduce((s, r) => s + r.length, 0), summary: parts.join(', ') };
}

export function friendlyZoomError(e) {
  const code = e && (e.code ?? e.errorCode);
  const text = (e && (e.message || e.reason)) || String(e);
  if (code === 10095) return 'Zoom allows at most 50 tables. Raise the room size.';
  if (code === 10097 || /not enabled|disabled/i.test(text)) return 'Zoom could not create the tables. Check that breakout rooms are turned on for this meeting.';
  if (code === 10121) return 'The tables are already open. Close them first, then try again.';
  return `Zoom said: ${text}`;
}

/**
 * options: { minutes: auto-close after N minutes (0 = never), open: boolean, pauseMs: delay before a retry }
 * Returns { tables, assigned, failed: [{ participantUUID, message }], opened }
 */
export async function runPlan(sdk, plan, { minutes = 0, open = true, pauseMs = 400 } = {}) {
  const names = plan.rooms.map((_, i) => `Table ${i + 1}`);
  const made = await sdk.createBreakoutRooms({ numberOfRooms: names.length, assign: 'manually', names });
  const byName = new Map((made.rooms || []).map((r) => [r.name, r.breakoutRoomId]));
  const ids = names.map((n, i) => byName.get(n) ?? (made.rooms && made.rooms[i] && made.rooms[i].breakoutRoomId));
  if (ids.some((id) => !id)) throw new Error('Zoom did not return every table. Try again.');

  const failed = [];
  let assigned = 0;
  for (let i = 0; i < plan.rooms.length; i++) {
    for (const participantUUID of plan.rooms[i]) {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await sdk.assignParticipantToBreakoutRoom({ participantUUID, uuid: ids[i] });
          assigned++;
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          if (attempt === 0) await wait(pauseMs);
        }
      }
      if (lastError) failed.push({ participantUUID, message: friendlyZoomError(lastError) });
    }
  }

  await sdk.configureBreakoutRooms({
    allowParticipantsChooseRoom: false,
    allowParticipantsReturnToMainSession: true,
    automaticallyMoveParticipantsIntoRooms: true,
    closeAfter: minutes,
    countDown: 60,
  });
  let opened = false;
  if (open) { await sdk.openBreakoutRooms(); opened = true; }
  return { tables: names.length, assigned, failed, opened };
}
