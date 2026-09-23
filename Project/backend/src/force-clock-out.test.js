import test from 'node:test';
import assert from 'node:assert/strict';
import { clockOutSessions, forcedClockOutUpdate } from './force-clock-out.js';

const stamp = { date: '2026-09-18', time: '05:00 PM', now: new Date('2026-09-18T09:00:00Z') };
const record = { _id: 'A1', date: stamp.date, employeeId: 'E1', updatedAt: new Date('2026-09-18T01:00:00Z'), sessions: [{ checkIn: '08:00 AM', checkOut: '12:00 PM', matchScore: 42 }, { checkIn: '01:00 PM', checkOut: null, deviceUid: 'reader' }] };

test('closes only open sessions and preserves completed sessions and biometric metadata', () => {
  const result = forcedClockOutUpdate(record, stamp, 'admin@example.test');
  assert.deepEqual(result.update.$set.sessions[0], record.sessions[0]);
  assert.equal(result.update.$set.sessions[1].checkOut, stamp.time);
  assert.equal(result.update.$set.sessions[1].deviceUid, 'reader');
  assert.equal(result.update.$set.sessions[1].forcedClockOutBy, 'admin@example.test');
  assert.equal(record.sessions[1].checkOut, null);
});

test('does not affect earlier dates, closed attendance or absences', () => {
  assert.equal(forcedClockOutUpdate({ ...record, date: '2026-09-17' }, stamp, 'admin'), null);
  assert.equal(forcedClockOutUpdate({ ...record, sessions: [record.sessions[0]] }, stamp, 'admin'), null);
  assert.equal(forcedClockOutUpdate({ date: stamp.date, sessions: [] }, stamp, 'admin'), null);
});

test('concurrent changes invalidate the update instead of overwriting a kiosk scan', () => {
  const result = forcedClockOutUpdate(record, stamp, 'admin');
  assert.equal(result.filter._id, record._id);
  assert.equal(result.filter.updatedAt, record.updatedAt);
  assert.deepEqual(result.filter.sessions, record.sessions);
});

test('supports legacy attendance without a sessions array', () => {
  const legacy = { _id: 'A2', date: stamp.date, checkIn: '09:00 AM', checkOut: null };
  assert.equal(clockOutSessions(legacy).length, 1);
  const result = forcedClockOutUpdate(legacy, stamp, 'admin');
  assert.equal(result.update.$set.checkOut, stamp.time);
  assert.deepEqual(result.filter.sessions, { $exists: false });
});
