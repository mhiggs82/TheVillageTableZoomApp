// Memory-only session store. Nothing is written to disk or a database.
// Holds, per meeting, who has entered a valid code and what it decoded to. Wiped when the host
// clears the session, or automatically after the idle limit.
const MAX_MEETINGS = 200;
const MAX_PER_MEETING = 2000;

export class SessionStore {
  constructor({ ttlMs = 12 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.meetings = new Map(); // meetingKey -> { touched, byUser: Map(uid -> { participantUUID, profile }) }
  }

  _meeting(key, create) {
    this.purge();
    let m = this.meetings.get(key);
    if (!m && create) {
      if (this.meetings.size >= MAX_MEETINGS) throw new Error('too many active meetings');
      m = { touched: this.now(), byUser: new Map() };
      this.meetings.set(key, m);
    }
    if (m) m.touched = this.now();
    return m;
  }

  submit(meetingKey, uid, participantUUID, profile) {
    const m = this._meeting(meetingKey, true);
    if (!m.byUser.has(uid) && m.byUser.size >= MAX_PER_MEETING) throw new Error('meeting is full');
    m.byUser.set(uid, { participantUUID, profile });
  }

  withdraw(meetingKey, uid) {
    const m = this._meeting(meetingKey, false);
    return m ? m.byUser.delete(uid) : false;
  }

  /** Map of participantUUID -> profile for this meeting. */
  profilesByParticipant(meetingKey) {
    const m = this._meeting(meetingKey, false);
    const out = new Map();
    if (m) for (const e of m.byUser.values()) out.set(e.participantUUID, e.profile);
    return out;
  }

  hasEntry(meetingKey, uid, participantUUID) {
    const m = this._meeting(meetingKey, false);
    const e = m && m.byUser.get(uid);
    return Boolean(e && e.participantUUID === participantUUID);
  }

  readyParticipants(meetingKey) {
    return [...this.profilesByParticipant(meetingKey).keys()];
  }

  clear(meetingKey) {
    return this.meetings.delete(meetingKey);
  }

  purge() {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, m] of this.meetings) if (m.touched < cutoff) this.meetings.delete(k);
  }

  get size() { return this.meetings.size; }
}
