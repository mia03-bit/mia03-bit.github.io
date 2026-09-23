export const activityFilter = {
  action: { $nin: ['auth.otp_sent', 'auth.otp_verify'] },
  'metadata.path': { $ne: '/admin/notifications/read' },
};

export function auditPresentation(event) {
  const meta = event.metadata || {};
  const path = String(meta.path || '');
  const failed = event.outcome === 'failure';
  const target = meta.targetName ? ` — ${meta.targetName}` : '';
  const result = (success, attempt) => ({ executedAction: `${failed ? `${attempt} failed` : success}${target}` });
  if (path === '/attendance/kiosk') {
    const reasons = {
      'no-match': 'Fingerprint not recognized',
      'employee-unavailable': 'Active employee not found',
      'approved-leave': 'Time-in blocked — approved leave',
      'non-working-day': 'Time-in blocked — non-working day',
      'duplicate-scan': 'Repeat scan blocked — wait before scanning again',
      'daily-limit': 'Scan blocked — three sessions already completed',
      'conflict': 'Scan not saved — attendance changed during the request',
      'invalid-sample': 'Fingerprint scan invalid',
      'matcher-unavailable': 'Fingerprint matcher unavailable',
      'unsupported-sample': 'Fingerprint format not supported',
      'database-unavailable': 'Attendance service unavailable',
    };
    const recorded = meta.attendanceRecorded === true || (!failed && ['time-in', 'time-out'].includes(meta.kioskAction));
    const executedAction = recorded
      ? `${meta.kioskAction === 'time-out' ? 'Clock-out recorded' : 'Clock-in recorded'}${failed ? ' — follow-up failed' : ''}${target}`
      : `${reasons[meta.kioskReason] || (failed ? 'Fingerprint scan failed' : 'Fingerprint scan processed')}${target}`;
    return {
      executedAction,
      detail: `${executedAction}.${recorded ? ` Attendance was saved${meta.eventTime ? ` at ${meta.eventTime}` : ''}.` : meta.attendanceRecorded === false ? ' No attendance was recorded by this request.' : failed ? ' This older entry does not contain the rejection reason or confirm whether attendance was saved.' : ''}${meta.failureReason ? ` ${meta.failureReason}` : ''}`,
    };
  }
  if (event.action === 'auth.login') return result('Signed in', 'Sign-in');
  if (event.action === 'auth.logout') return result('Signed out', 'Sign-out');
  if (event.action === 'auth.password_verify') return result('Administrator password verified', 'Administrator password verification');
  if (event.action === 'security.rate_limit') return { executedAction: 'Request blocked — too many attempts' };
  if (path === '/fingerprints/identify' && typeof meta.fingerprintRecognized === 'boolean') return {
    executedAction: meta.fingerprintRecognized ? `Registered fingerprint identified${target}` : 'Fingerprint identification — no registered match',
    detail: 'Fingerprint identification test only. This operation does not record attendance.',
  };
  if (path.includes('leave-requests')) {
    if (path.endsWith('/undo-approval')) return result('Leave approval undone', 'Undo leave approval');
    if (path.endsWith('/cancel')) return result('Leave request cancelled', 'Cancel leave request');
    if (path.includes('/status') || path.endsWith('/bulk-status')) {
      const status = meta.requestedStatus === 'approved' ? 'approval' : meta.requestedStatus === 'rejected' ? 'rejection' : 'status update';
      const plural = path.endsWith('/bulk-status');
      return result(`${plural ? 'Bulk leave' : 'Leave'} ${status}${Number(meta.failedCount) > 0 ? ' partially completed' : ' completed'}`, `${plural ? 'Bulk leave' : 'Leave'} ${status}`);
    }
    return result('Leave request submitted', 'Submit leave request');
  }
  if (path === '/admin/force-clock-out') {
    const count = Number(meta.recordCount || 0);
    return {
      executedAction: count ? `${meta.scope === 'individual' ? 'Individual force clock-out' : 'Force clock-out all'} ? ${count} employee${count === 1 ? '' : 's'} clocked out${failed ? '; some actions failed' : ''}${target}` : failed ? 'Force clock-out failed' : 'Force clock-out ? no open sessions changed',
      detail: `${count} employee attendance records closed at ${meta.eventTime || 'the requested time'}. ${Number(meta.skippedCount || 0)} skipped because attendance had already changed or was closed. ${Number(meta.failedCount || 0)} failed.`,
    };
  }
  const operations = [
    [/\/employees\/[^/]+\/fingerprint$/, 'Employee fingerprint replaced', 'Replace employee fingerprint'],
    [/\/employees\/[^/]+\/send-login-email$/, 'Employee login email sent', 'Send employee login email'],
    [/\/employees\/[^/]+\/unarchive$/, 'Employee restored from archive', 'Restore employee'],
    [/\/employees\/[^/]+\/archive$/, 'Employee archived', 'Archive employee'],
    [/\/employees\/[^/]+\/permanent$/, 'Employee permanently deleted', 'Delete employee'],
    [/^\/employees$/, 'Employee account created', 'Create employee account'],
    [/^\/employees\/[^/]+$/, 'Employee details updated', 'Update employee details'],
    [/^\/employee\/me\/contact$/, 'Employee contact details updated', 'Update contact details'],
    [/^\/settings$/, 'Attendance, leave or pay settings updated', 'Update system settings'],
    [/\/fingerprints\/check-enrollment$/, 'Fingerprint enrollment checked', 'Check fingerprint enrollment'],
    [/\/fingerprints\/check-scan$/, 'Fingerprint scan validated', 'Validate fingerprint scan'],
    [/\/fingerprints\/identify$/, 'Fingerprint identification completed', 'Identify fingerprint'],
    [/\/biometric-evaluation-trials$/, 'Fingerprint evaluation recorded', 'Record fingerprint evaluation'],
    [/\/attendance\/audit-export$/, 'Attendance CSV export requested', 'Export attendance CSV'],
    [/\/admin\/force-clock-out$/, 'Open attendance sessions clocked out', 'Force clock-out'],
  ];
  for (const [pattern, success, attempt] of operations) if (pattern.test(path)) return result(success, attempt);
  if (path.endsWith('/account-security') || event.action === 'auth.admin_credentials_changed') return result('Administrator credentials updated', 'Update administrator credentials');
  if (path.endsWith('/system-controls')) {
    const changes = meta.controlChanges || {};
    const labels = Object.entries(changes).map(([key, value]) => `${key === 'maintenanceMode' ? 'Maintenance mode' : key === 'registrationOpen' ? 'Employee registration' : key} ${value ? 'enabled' : 'disabled'}`);
    return result(labels.join('; ') || 'System controls updated', 'Update system controls');
  }
  if (path.endsWith('/access')) return result(meta.adminAction === 'employee-access-blocked' ? 'Employee access blocked' : meta.adminAction === 'employee-access-restored' ? 'Employee access restored' : 'Employee access updated', 'Update employee access');
  if (event.action === 'admin.backup_created') return result('System backup generated', 'Generate system backup');
  if (path.includes('payroll')) {
    const actions = {
      'bonus-added': ['Payroll bonus added', 'Add payroll bonus'], 'bulk-paid': ['Bulk payroll payment completed', 'Complete bulk payroll payment'],
      'individual-paid': ['Employee payment completed', 'Complete employee payment'], 'payment-held': ['Employee payment put on hold', 'Hold employee payment'],
      'hold-removed': ['Payment hold removed', 'Remove payment hold'], 'payment-undone': ['Payroll payment undone', 'Undo payroll payment'],
      printed: ['Payroll print requested', 'Request payroll print'], exported: ['Payroll CSV export requested', 'Export payroll CSV'],
      reset: ['Employee payroll reset', 'Reset employee payroll'], 'payslip-emailed': ['Payslip emailed', 'Email payslip'], 'summary-emailed': ['Payroll summary emailed', 'Email payroll summary'],
    };
    const suffixActions = { 'confirm-payment': 'individual-paid', 'pay-bulk': 'bulk-paid', 'reject-payment': 'payment-held', 'remove-hold': 'hold-removed', 'undo-last-payment': 'payment-undone', 'bonus': 'bonus-added', 'reset': 'reset', 'email': 'payslip-emailed', 'email-summary': 'summary-emailed', 'audit-print': 'printed', 'audit-export': 'exported' };
    const action = actions[meta.payrollAction || suffixActions[path.split('/').at(-1)]];
    if (action) return result(...action);
    if (path.endsWith('/prepare-bulk')) return result('Payroll records prepared', 'Prepare payroll records');
    return result('Payroll request processed', 'Process payroll request');
  }
  // An HTTP method alone cannot establish that a business record was created.
  return { executedAction: `${String(event.targetType || 'System').replaceAll('_', ' ')} request ${failed ? 'failed' : event.outcome === 'success' ? 'processed' : 'outcome unknown'}` };
}
