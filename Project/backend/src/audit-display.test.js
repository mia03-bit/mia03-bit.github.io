import test from 'node:test';
import assert from 'node:assert/strict';
import { activityFilter, auditPresentation } from './audit-display.js';

const kiosk = (metadata = {}, outcome = 'failure') => auditPresentation({ action: 'api.post', targetType: 'attendance', outcome, metadata: { path: '/attendance/kiosk', ...metadata } });

test('unrecognized fingerprint never claims to create attendance', () => {
  const result = kiosk({ kioskReason: 'no-match', attendanceRecorded: false });
  assert.equal(result.executedAction, 'Fingerprint not recognized');
  assert.match(result.detail, /No attendance was recorded/);
});

test('legacy failure does not invent a cause or a database result', () => {
  const result = kiosk({ statusCode: 404 });
  assert.equal(result.executedAction, 'Fingerprint scan failed');
  assert.match(result.detail, /does not contain the rejection reason/);
});

test('clock-in and clock-out are distinct confirmed operations', () => {
  assert.equal(kiosk({ kioskAction: 'time-in', targetName: 'Alex' }, 'success').executedAction, 'Clock-in recorded — Alex');
  assert.equal(kiosk({ kioskAction: 'time-out' }, 'success').executedAction, 'Clock-out recorded');
});

test('failure after attendance commit does not claim attendance was lost', () => {
  const result = kiosk({ kioskAction: 'time-out', attendanceRecorded: true });
  assert.equal(result.executedAction, 'Clock-out recorded — follow-up failed');
  assert.match(result.detail, /Attendance was saved/);
});

test('rejections distinguish schedule, leave, limits and scanner errors', () => {
  for (const [reason, expected] of [['approved-leave', 'approved leave'], ['non-working-day', 'non-working day'], ['duplicate-scan', 'Repeat scan'], ['daily-limit', 'three sessions'], ['matcher-unavailable', 'matcher unavailable'], ['invalid-sample', 'scan invalid']]) {
    assert.ok(kiosk({ kioskReason: reason }).executedAction.includes(expected));
  }
});

test('failed business operations are attempts, not completed changes', () => {
  for (const path of ['/employees', '/employees/E1/archive', '/leave-requests/L1/status', '/payroll-requests/P1/confirm-payment', '/admin/account-security']) {
    assert.match(auditPresentation({ outcome: 'failure', metadata: { path, requestedStatus: 'approved' } }).executedAction, /failed/);
  }
  assert.equal(auditPresentation({ outcome: 'success', metadata: { path: '/employees/E1/unarchive' } }).executedAction, 'Employee restored from archive');
});

test('identification test distinguishes no match from a recognized employee', () => {
  const result = auditPresentation({ outcome: 'failure', metadata: { path: '/fingerprints/identify', fingerprintRecognized: false } });
  assert.match(result.executedAction, /no registered match/);
  assert.match(result.detail, /does not record attendance/);
});

test('activity query excludes verification noise and notification acknowledgements before pagination', () => {
  assert.ok(activityFilter.action.$nin.includes('auth.otp_sent'));
  assert.ok(activityFilter.action.$nin.includes('auth.otp_verify'));
  assert.equal(activityFilter['metadata.path'].$ne, '/admin/notifications/read');
});
