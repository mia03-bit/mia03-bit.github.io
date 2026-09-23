import { useState, useEffect, useMemo } from 'react';
import { Bell, CalendarDays, Clock, LogOut, Menu, Sparkles } from 'lucide-react';
import { Dialog, DialogHeader } from '../components/ui/Dialog';
import { Button } from '../components/ui/Button';
import { AdminSidebar, type ViewKey } from '../components/AdminSidebar';
import { AdminOverviewView } from '../views/AdminOverviewView';
import { EmployeeDirectoryView } from '../views/EmployeeDirectoryView';

import { PayrollView } from '../views/PayrollView';
import { SettingsView } from '../views/SettingsView';
import { AIInsightsView } from '../views/AIInsightsView';
import { LeaveRequestsView } from '../views/LeaveRequestsView';
import { AdminView } from '../views/AdminView';
import { AttendanceView } from '../views/AttendanceView';
import { apiFetch, clearSession } from '../lib/api';

type OverviewEmployee = { status: string; biometricStatus: string; createdAt?: string };
type OverviewPayroll = { status: string; periodStart?: string };
type OverviewAttendance = { employeeId?: string; name?: string; role?: string; date?: string; checkIn?: string; checkOut?: string; status: string };
type OverviewLeave = { id: string; employeeId?: string; startDate: string; endDate: string; approvedDates?: string[]; totalDays: number; status: string };
type OverviewAuditEvent = { id: string; executedAction?: string; detail?: string; occurredAt?: string; actorEmail?: string | null; actorRole?: string; screenName?: string; action?: string; targetType?: string; targetId?: string | null; outcome?: string; metadata?: Record<string, unknown> };

function readableAuditAction(action = 'unknown', targetType = 'system') {
  const labels: Record<string, string> = {
    'auth.login': 'Signed in', 'auth.logout': 'Signed out', 'auth.otp_sent': 'Verification code sent',
    'auth.otp_verify': 'Verification code checked', 'auth.password_verify': 'Admin password checked',
    'security.rate_limit': 'Request limit reached',
  };
  if (labels[action]) return labels[action];
  const apiMatch = action.match(/^api\.(post|put|patch|delete)$/);
  if (apiMatch) {
    const verbs: Record<string, string> = { post: 'Created', put: 'Updated', patch: 'Updated', delete: 'Deleted' };
    return `${verbs[apiMatch[1]]} ${targetType.replace(/[-_]/g, ' ')}`;
  }
  return action.replace(/[._-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function auditActionLabel(event: OverviewAuditEvent) {
  if (event.executedAction) return event.executedAction;
  const path = String(event.metadata?.path || '');
  const leaveAction = String(event.metadata?.leaveAction || '');
  if (String(event.metadata?.attendanceAction || '') === 'exported') return 'Attendance Exported';
  if (leaveAction === 'bulk-approved') return 'Multiple Leave Requests Approved';
  if (leaveAction === 'bulk-rejected') return 'Multiple Leave Requests Rejected';
  if (path.includes('/admin/') || event.action === 'auth.admin_credentials_changed' || event.action === 'admin.backup_created') {
    const adminAction = String(event.metadata?.adminAction || '');
    if (adminAction === 'credentials-updated' || path.endsWith('/account-security')) {
      const emailChanged = event.metadata?.emailChanged === true;
      const passwordChanged = event.metadata?.passwordChanged === true;
      return emailChanged && passwordChanged ? 'Changed Admin Email and Password' : passwordChanged ? 'Changed Admin Password' : emailChanged ? 'Changed Admin Email' : 'Updated Admin Credentials';
    }
    if (adminAction === 'system-control-updated' || path.endsWith('/system-controls')) {
      const fields = Array.isArray(event.metadata?.changedFields) ? event.metadata.changedFields : [];
      if (fields.includes('maintenanceMode')) return 'Changed Maintenance Mode';
      if (fields.includes('registrationOpen')) return 'Changed Employee Registration Access';
      return 'Changed System Controls';
    }
    if (adminAction === 'employee-access-blocked') return 'Blocked Employee Account';
    if (adminAction === 'employee-access-restored') return 'Restored Employee Account';
    if (path.includes('/employees/') && path.endsWith('/access')) return 'Changed Employee Account Access';
    if (adminAction === 'force-clock-out' || path.endsWith('/force-clock-out')) return 'Forced Employee Clock-Out';
    if (event.action === 'admin.backup_created') return 'Downloaded System Backup';
  }
  if (!path.includes('payroll')) return readableAuditAction(event.action, event.targetType);
  const payrollAction = String(event.metadata?.payrollAction || '');
  const labels: Record<string, string> = {
    'bonus-added': 'Bonus Added',
    'bulk-paid': 'Multiple Employees Paid',
    'individual-paid': 'Individual Payment Completed',
    'payment-held': 'Payment Held',
    'hold-removed': 'Payment Hold Removed',
    'payment-undone': 'Payment Undone',
    printed: 'Payroll Printed',
    exported: 'Payroll Exported',
    reset: 'Payroll Reset',
    'payslip-emailed': 'Payslip Emailed',
    'summary-emailed': 'Payroll Summary Emailed',
  };
  if (labels[payrollAction]) return labels[payrollAction];
  if (path.includes('/undo-last-payment')) return 'Payment Undone';
  if (path.includes('/prepare-bulk')) return 'Payroll Prepared';
  return readableAuditAction(event.action, event.targetType);
}

function auditEventDetail(event: OverviewAuditEvent, time: string) {
  if (event.detail) return event.detail;
  if (event.outcome === 'failure') return `${event.actorEmail || "User"}: ${auditActionLabel(event)} at ${time}.`;
  const actor = event.actorEmail || String(event.metadata?.attemptedEmail || '') || (event.actorRole === 'anonymous' ? 'Unknown user' : 'System');
  if (event.executedAction) return `${actor}: ${event.executedAction} at ${time}.${typeof event.metadata?.recordCount === 'number' ? ` Records affected: ${event.metadata.recordCount}.` : ''}`;
  const path = String(event.metadata?.path || '');
  const targetName = String(event.metadata?.targetName || event.targetId || '').trim();
  const result = event.outcome === 'success' ? 'succeeded' : event.outcome === 'failure' ? 'failed' : 'finished with an unknown result';
  if (event.action === 'auth.login') return `${actor} login ${result} at ${time}.`;
  if (event.action === 'auth.logout') return `${actor} logged out at ${time}.`;
  if (path === '/attendance/kiosk') return event.outcome === 'success' ? `${targetName || 'An employee'} completed a kiosk ${String(event.metadata?.kioskAction || 'attendance scan')} at ${time}.` : `A kiosk attendance attempt ${result} at ${time}${targetName ? ` for ${targetName}` : ''}.`;
  if (path === '/attendance/audit-export') {
    const recordCount = Number(event.metadata?.recordCount || 0);
    return `${actor} exported ${recordCount} attendance record${recordCount === 1 ? '' : 's'} from ${String(event.metadata?.from || '')} to ${String(event.metadata?.to || '')} as CSV at ${time}; the action ${result}.`;
  }
  if (/^\/employees(?:\/|$)/.test(path)) {
    const operation = path.endsWith('/archive') ? 'archived' : path.endsWith('/unarchive') ? 'unarchived' : event.action === 'api.post' ? 'created' : event.action === 'api.delete' ? 'permanently deleted' : 'edited';
    return `${actor} ${operation} ${targetName || 'an employee record'} at ${time}; the action ${result}.`;
  }
  if (path.includes('leave-requests')) {
    const requestedStatus = String(event.metadata?.requestedStatus || '');
    const leaveAction = String(event.metadata?.leaveAction || '');
    const recordCount = Number(event.metadata?.recordCount || 0);
    const failedCount = Number(event.metadata?.failedCount || 0);
    if (leaveAction.startsWith('bulk-')) return `${actor} ${requestedStatus} ${recordCount} leave request${recordCount===1?'':'s'} at ${time}; ${failedCount ? `${failedCount} remained pending after validation` : 'all selected requests were processed'}; the action ${result}.`;
    const operation = path.includes('/employee/me/') ? path.endsWith('/cancel') ? 'cancelled a leave request' : 'submitted a leave request' : requestedStatus ? `${requestedStatus} a leave request` : 'updated a leave request';
    return `${actor} ${operation}${targetName ? ` for ${targetName}` : ''} at ${time}; the action ${result}.`;
  }
  if (path.includes('payroll')) {
    const payrollAction = String(event.metadata?.payrollAction || '');
    const recordCount = Number(event.metadata?.recordCount || 0);
    const amount = Number(event.metadata?.amount ?? event.metadata?.total ?? 0);
    const periodStart = String(event.metadata?.periodStart || '');
    const period = /^\d{4}-\d{2}-\d{2}$/.test(periodStart) ? ` for pay period ${new Date(`${periodStart}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })}` : '';
    const money = amount > 0 ? ` worth ${amount.toLocaleString('en-PH', { style: 'currency', currency: 'PHP' })}` : '';
    const people = recordCount > 0 ? `${recordCount} employee${recordCount === 1 ? '' : 's'}` : 'the selected employees';
    const descriptions: Record<string, string> = {
      'bonus-added': `${actor} added a bonus${money} to ${targetName || people}`,
      'bulk-paid': `${actor} completed payroll for ${people}${money}`,
      'individual-paid': `${actor} marked ${targetName || 'an employee'} as paid${money}`,
      'payment-held': `${actor} placed ${targetName || "an employee's"} payment on hold`,
      'hold-removed': `${actor} removed the payment hold for ${targetName || 'an employee'}`,
      'payment-undone': `${actor} undid the latest completed payment for ${targetName || people}${money}`,
      printed: event.metadata?.printScope === 'individual-payslip' ? `${actor} printed the payslip for ${targetName || 'an employee'}` : `${actor} printed the paid payroll list${recordCount ? ` containing ${recordCount} records` : ''}`,
      exported: `${actor} exported ${recordCount} matching payroll record${recordCount === 1 ? '' : 's'} as CSV`,
      reset: `${actor} reset the payroll values for ${targetName || 'an employee'} to zero`,
      'payslip-emailed': `${actor} emailed a payslip to ${targetName || 'an employee'}`,
      'summary-emailed': `${actor} emailed a payroll summary to ${targetName || 'an employee'}`,
    };
    const description = descriptions[payrollAction] || (path.includes('/undo-last-payment') ? `${actor} undid the most recent payroll payment` : path.includes('/prepare-bulk') ? `${actor} prepared payroll for ${people}` : `${actor} performed a payroll action${targetName ? ` for ${targetName}` : ''}`);
    return `${description}${period} at ${time}; the action ${result}.`;
  }
  if (path === '/settings') {
    const values = event.metadata?.settingsValues && typeof event.metadata.settingsValues === 'object' ? Object.entries(event.metadata.settingsValues).filter(([, value]) => value != null).map(([key, value]) => `${key.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${value}`).join(', ') : '';
    return `${actor} updated system settings${values ? ` (${values})` : ''} at ${time}; the action ${result}.`;
  }
  if (path.includes('/admin/') || event.action === 'auth.admin_credentials_changed' || event.action === 'admin.backup_created') {
    const label = auditActionLabel(event).toLowerCase();
    const controls = event.metadata?.controlChanges && typeof event.metadata.controlChanges === 'object'
      ? Object.entries(event.metadata.controlChanges).map(([key, value]) => `${key === 'maintenanceMode' ? 'maintenance mode' : key === 'registrationOpen' ? 'employee registration' : key} was turned ${value ? 'on' : 'off'}`).join(' and ')
      : '';
    const count = Number(event.metadata?.recordCount || 0);
    const extra = controls ? `: ${controls}` : targetName ? ` for ${targetName}` : path.endsWith('/force-clock-out') ? `; ${count} open attendance session${count === 1 ? '' : 's'} closed` : '';
    return `${actor} ${label}${extra} at ${time}; the action ${result}.`;
  }
  return `${actor} ${readableAuditAction(event.action, event.targetType)} at ${time}; the action ${result}.`;
}

function attendanceTrend(records: OverviewAttendance[], mode: 'daily' | 'weekly' | 'monthly', anchorDate: string) {
  const anchor = new Date(`${anchorDate}T00:00:00Z`);
  if (Number.isNaN(anchor.getTime())) return [];

  const buckets = new Map<string, { label: string; present: number; late: number; absent: number }>();
  const dateKey = (date: Date) => date.toISOString().slice(0, 10);
  const mondayFor = (date: Date) => {
    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return monday;
  };
  const bucketKey = (date: Date) => {
    if (mode === 'daily') return dateKey(date);
    if (mode === 'weekly') return dateKey(mondayFor(date));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  const bucketDates: Date[] = [];
  const bucketCount = mode === 'daily' ? 7 : 6;
  for (let index = bucketCount - 1; index >= 0; index -= 1) {
    const date = mode === 'weekly' ? mondayFor(anchor) : new Date(anchor);
    if (mode === 'daily') date.setUTCDate(anchor.getUTCDate() - index);
    if (mode === 'weekly') date.setUTCDate(date.getUTCDate() - index * 7);
    if (mode === 'monthly') {
      date.setUTCDate(1);
      date.setUTCMonth(anchor.getUTCMonth() - index);
    }
    bucketDates.push(date);
  }

  bucketDates.forEach((date) => {
    const label = mode === 'daily'
      ? date.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric' })
      : date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', ...(mode === 'weekly' ? { day: 'numeric' } : {}) });
    buckets.set(bucketKey(date), { label, present: 0, late: 0, absent: 0 });
  });

  records.forEach((record) => {
    if (!record.date) return;
    const date = new Date(`${record.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return;
    if (date.getTime() > anchor.getTime()) return;
    const bucket = buckets.get(bucketKey(date));
    if (!bucket) return;
    if (record.status === 'Present') bucket.present += 1;
    if (record.status === 'Late') bucket.late += 1;
    if (record.status === 'Absent') bucket.absent += 1;
  });

  return [...buckets.values()];
}

function currentPayrollPeriodKey() {
  const now = new Date();
  const day = now.getDate() <= 15 ? 1 : 16;
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function manilaDateToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function AppRoutes() {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const paramView = params.get('view') as ViewKey;
  const validViews: ViewKey[] = ['overview', 'attendance', 'employees', 'leave', 'payroll', 'insights', 'settings', 'admin'];
  const initialView: ViewKey = validViews.includes(paramView) ? paramView : 'overview';
  const [active, setActive] = useState<ViewKey>(initialView);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [accountName, setAccountName] = useState('');
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<{ id: string; category: 'leave' | 'attendance' | 'insights'; title: string; description: string; createdAt: string; expiresAt: string; read: boolean }[]>([]);
  const [notificationCategory, setNotificationCategory] = useState<'all' | 'leave' | 'attendance' | 'insights'>('all');
  const [newNotificationIds, setNewNotificationIds] = useState<string[]>([]);
  const [notificationNow, setNotificationNow] = useState(Date.now);
  const visibleNotifications = notifications.filter((item) => new Date(item.expiresAt).getTime() > notificationNow).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const filteredNotifications = visibleNotifications.filter((item) => notificationCategory === 'all' || item.category === notificationCategory);
  const notificationCategories = [
    { key: 'all', label: 'All', icon: Bell },
    { key: 'leave', label: 'Leave Requests', icon: CalendarDays },
    { key: 'attendance', label: 'Attendance', icon: Clock },
    { key: 'insights', label: 'AI Insights', icon: Sparkles },
  ] as const;
  useEffect(() => {
    const timer = window.setInterval(() => setNotificationNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [notificationsError, setNotificationsError] = useState('');
  const [notificationReadError, setNotificationReadError] = useState('');
  const unreadCount = notificationsOpen ? 0 : visibleNotifications.filter((request) => !request.read).length;

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/admin/account-security').then(async (response) => {
      if (!response.ok) throw new Error('Unable to load account');
      const account = await response.json();
      if (!cancelled) setAccountName(account.name?.trim() || account.email);
    }).catch(() => { if (!cancelled) setAccountName('Account unavailable'); });
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    async function refreshNotifications() {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try {
        const response = await apiFetch('/api/admin/notifications');
        if (!response.ok) throw new Error('Unable to load notifications. Please try again.');
        const requests = await response.json() as typeof notifications;
        if (!cancelled) {
          setNotifications(requests);
          setNotificationsError('');
          if (notificationsOpen) {
            const ids = requests.filter((request) => !request.read).map((request) => request.id);
            if (ids.length) {
              setNewNotificationIds((current) => [...new Set([...current, ...ids])]);
              try {
                const readResponse = await apiFetch('/api/admin/notifications/read', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
                });
                if (!readResponse.ok) throw new Error('Unable to save read state');
                const { readIds } = await readResponse.json() as { readIds: string[] };
                if (!cancelled) {
                  setNotifications((current) => current.map((request) => readIds.includes(request.id) ? { ...request, read: true } : request));
                  setNotificationReadError('');
                }
              } catch {
                if (!cancelled) setNotificationReadError('Could not save read status. The badge may return. Reopen notifications to retry.');
              }
            } else setNotificationReadError('');
          }
        }
      } catch {
        if (!cancelled) setNotificationsError('Unable to load notifications. Please try again.');
      } finally {
        refreshing = false;
        if (!cancelled) setNotificationsLoading(false);
      }
    }
    void refreshNotifications();
    const timer = window.setInterval(() => void refreshNotifications(), 30_000);
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void refreshNotifications(); };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshWhenVisible); };
  }, [active, notificationsOpen]);

  function requestLogout() {
    setMobileNavigationOpen(false);
    setLogoutError('');
    setLogoutOpen(true);
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError('');
    try {
      const response = await apiFetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok && response.status !== 401) throw new Error('Logout failed');
      clearSession();
      window.location.replace('/');
    } catch {
      setLogoutError('Unable to log out. Please try again.');
      setLoggingOut(false);
    }
  }
  const [overviewPerformanceDate, setOverviewPerformanceDate] = useState(manilaDateToday);
  const [overviewViewMode, setOverviewViewMode] = useState<'daily' | 'weekly' | 'monthly'>('weekly');

  const [overviewEmployees, setOverviewEmployees] = useState<OverviewEmployee[]>([]);
  const [overviewPayroll, setOverviewPayroll] = useState<OverviewPayroll[]>([]);
  const [overviewAttendance, setOverviewAttendance] = useState<OverviewAttendance[]>([]);
  const [overviewLeaves, setOverviewLeaves] = useState<OverviewLeave[]>([]);
  const [overviewAuditEvents, setOverviewAuditEvents] = useState<OverviewAuditEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState('');
  const [auditDate, setAuditDate] = useState(manilaDateToday);

  useEffect(() => {
    if (active !== 'overview') return;
    let cancelled = false;
    let loading = false;
    async function loadOverview() {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      try {
        const query = new URLSearchParams({ performanceDate: overviewPerformanceDate, auditDate });
        const response = await apiFetch(`/api/overview?${query.toString()}`);
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `Overview request failed (${response.status})`);
        if (!data || !Array.isArray(data.employees) || !Array.isArray(data.payroll) || !Array.isArray(data.attendance) || !Array.isArray(data.leaveRequests) || !Array.isArray(data.auditEvents)) {
          throw new Error('Overview server returned an invalid response');
        }
        if (cancelled) return;
        setOverviewEmployees(data.employees);
        setOverviewPayroll(data.payroll);
        setOverviewAttendance(data.attendance);
        setOverviewLeaves(data.leaveRequests);
        setOverviewAuditEvents(data.auditEvents);
        setAuditError('');
        setAuditLoading(false);
      } catch (reason) {
        if (!cancelled) {
          setAuditError(reason instanceof Error ? reason.message : 'Unable to load overview data');
          setAuditLoading(false);
        }
      } finally {
        loading = false;
      }
    }
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void loadOverview(); };
    void loadOverview();
    const overviewInterval = window.setInterval(() => void loadOverview(), 60_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(overviewInterval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [active, auditDate, overviewPerformanceDate]);

  const adminMetricsData = useMemo(() => {
    const totalStaff = overviewEmployees.length;
    const activeWorkforce = overviewEmployees.filter((employee) => employee.status === "active").length;
    const workforceEligible = overviewEmployees.filter((employee) => employee.status === "active" || employee.status === "on-leave").length;
    const currentPayroll = overviewPayroll.filter((payroll) => payroll.periodStart === currentPayrollPeriodKey());
    const pendingPayrollCount = currentPayroll.filter((payroll) => payroll.status === "processing").length;
    
    return {
      totalStaff,
      activeWorkforce,
      workforceEligible,
      pendingPayrollCount,
      biometricKeysActive: overviewEmployees.filter((employee) => employee.biometricStatus === "enrolled").length,
    };
  }, [overviewEmployees, overviewPayroll]);

  const attendanceTrends = useMemo(() => ({
    daily: attendanceTrend(overviewAttendance, 'daily', overviewPerformanceDate),
    weekly: attendanceTrend(overviewAttendance, 'weekly', overviewPerformanceDate),
    monthly: attendanceTrend(overviewAttendance, 'monthly', overviewPerformanceDate),
  }), [overviewAttendance, overviewPerformanceDate]);

  const latestAttendanceDate = useMemo(() => overviewAttendance.reduce((latest, record) =>
    record.date && record.date > latest ? record.date : latest, ''), [overviewAttendance]);

  const attendanceAnalytics = useMemo(() => {
    const total = overviewAttendance.length;
    const attended = overviewAttendance.filter((record) => record.status === 'Present' || record.status === 'Late').length;
    const onTime = overviewAttendance.filter((record) => record.status === 'Present').length;
    return {
      attendanceRate: total ? attended / total * 100 : 0,
      punctualityRate: attended ? onTime / attended * 100 : 0,
      payrollCompletion: overviewPayroll.filter((payroll) => payroll.periodStart === currentPayrollPeriodKey()).length
        ? overviewPayroll.filter((payroll) => payroll.periodStart === currentPayrollPeriodKey() && payroll.status === 'paid').length
          / overviewPayroll.filter((payroll) => payroll.periodStart === currentPayrollPeriodKey()).length * 100 : 0,
    };
  }, [overviewAttendance, overviewPayroll]);

  const auditTrail = useMemo(() => overviewAuditEvents.filter((event) => !['auth.otp_sent', 'auth.otp_verify'].includes(event.action || '') && event.metadata?.path !== '/admin/notifications/read').map((event) => {
    const occurredAt = event.occurredAt ? new Date(event.occurredAt) : null;
    const validDate = occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null;
    const time = validDate ? validDate.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    return {
      id: event.id,
      user: event.screenName || 'System',
      role: event.actorRole === 'admin' ? 'Admin' : event.actorRole === 'manager' ? 'Manager' : event.actorRole === 'anonymous' ? 'System' : 'Staff',
      action: auditActionLabel(event),
      time,
      date: validDate ? validDate.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' }) : '—',
      status: event.outcome === 'success' ? 'Success' : event.outcome === 'failure' ? 'Failed' : 'Unknown',
      detail: auditEventDetail(event, time),
    };
  }), [overviewAuditEvents]);

  // One unified workspace: administrators also have all manager capabilities.
  const viewMap: Record<ViewKey, React.ReactNode> = {
    overview: (
      <AdminOverviewView 
        attendanceTrends={attendanceTrends}
        viewMode={overviewViewMode}
        onViewModeChange={setOverviewViewMode}
        auditTrail={auditTrail}
        metrics={adminMetricsData}
        analytics={attendanceAnalytics}
        latestAttendanceDate={latestAttendanceDate}
        performanceDate={overviewPerformanceDate}
        onPerformanceDateChange={setOverviewPerformanceDate}
        employees={overviewEmployees}
        leaveRequests={overviewLeaves}
        attendanceRecords={overviewAttendance}
        auditLoading={auditLoading}
        auditError={auditError}
        auditDate={auditDate}
        onAuditDateChange={setAuditDate}
        onNavigate={setActive}
      />
    ),
    attendance: <AttendanceView role="admin" records={[]} />,

    employees: <EmployeeDirectoryView employees={[]} />,

    leave: <LeaveRequestsView requests={[]} onApprove={(id) => {
      setOverviewLeaves((current) => current.map((leave) => leave.id === id ? { ...leave, status: 'approved' } : leave));
      apiFetch('/api/employees').then((response) => response.ok ? response.json() : Promise.reject()).then(setOverviewEmployees).catch(() => undefined);
    }} onReject={(id) => setOverviewLeaves((current) => current.map((leave) => leave.id === id ? { ...leave, status: 'rejected' } : leave))} />,

    payroll: <PayrollView employees={[]} requests={[]} />,

    insights: <AIInsightsView />,
    admin: <AdminView />,
    settings: <SettingsView />,
  };

  const viewLabels: Record<ViewKey, string> = {
    overview: 'Overview', attendance: 'Attendance', employees: 'Employee Directory', leave: 'Leave Requests',
    payroll: 'Payroll', insights: 'AI Insights', settings: 'System Settings', admin: 'Admin Controls',
  };

  // Sync state transitions back to URL queries
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const newParams = new URLSearchParams(window.location.search);
      newParams.set('view', active);
      newParams.delete('role');
      
      const targetUrl = `${window.location.pathname}?${newParams.toString()}`;
      window.history.replaceState(window.history.state, '', targetUrl);
    }
  }, [active]);

  return (
    <div className="flex min-h-screen w-full bg-slate-100/70">
      <AdminSidebar active={active} onNavigate={setActive} mobileOpen={mobileNavigationOpen} onMobileClose={() => setMobileNavigationOpen(false)} accountName={accountName} onLogout={requestLogout} />
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-16 items-center border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
          <button onClick={() => setMobileNavigationOpen(true)} aria-label="Open navigation" className="mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-slate-200 sm:mr-3 text-slate-600 hover:bg-slate-50 lg:hidden"><Menu className="h-5 w-5" /></button>
          <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-violet-600">Admin workspace</p><h1 className="truncate text-base font-bold text-slate-900 sm:text-lg">{viewLabels[active]}</h1></div>
          <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            <button type="button" onClick={() => { setNotificationCategory('all'); setNewNotificationIds([]); setNotificationReadError(''); setNotificationsOpen(true); }} aria-label={`Notifications${!notificationsError && unreadCount ? `, ${unreadCount} unread notifications` : ''}`} className="relative grid h-11 w-11 place-items-center rounded-xl border border-slate-200 text-slate-600 hover:bg-violet-50 hover:text-violet-700">
              <Bell className="h-5 w-5" />
              {!notificationsError && unreadCount > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-violet-600 px-1.5 text-[10px] font-bold text-white">{unreadCount > 99 ? '99+' : unreadCount}</span>}
            </button>
            <Button variant="outline" className="h-11 w-11 px-0 sm:w-auto sm:px-4" onClick={requestLogout}><LogOut className="h-4 w-4" /><span className="hidden sm:inline">Log out</span><span className="sr-only sm:hidden">Log out</span></Button>
          </div>
        </header>
        <main className="min-w-0 overflow-x-hidden px-3 py-4 sm:px-5 sm:py-6 lg:px-8 lg:py-8">
          <div className="mx-auto w-full max-w-[1600px]">{viewMap[active] || viewMap.overview}</div>
        </main>
      </div>
      <Dialog open={logoutOpen} onClose={() => !loggingOut && setLogoutOpen(false)} className="max-w-sm">
        <div role="dialog" aria-modal="true" aria-labelledby="logout-title" onKeyDown={(event) => { if (event.key === 'Escape' && !loggingOut) setLogoutOpen(false); }}>
          <DialogHeader><div><h2 id="logout-title" className="text-lg font-bold text-slate-900">Log out?</h2><p className="mt-2 text-sm text-slate-600">Are you sure you want to log out?</p></div></DialogHeader>
          {logoutError && <p role="alert" className="px-6 py-2 text-sm text-red-600">{logoutError}</p>}
          <div className="flex justify-end gap-2 p-6"><Button autoFocus variant="outline" disabled={loggingOut} onClick={() => setLogoutOpen(false)}>Cancel</Button><Button variant="destructive" disabled={loggingOut} onClick={() => void logout()}>{loggingOut ? 'Logging out...' : 'Log out'}</Button></div>
        </div>
      </Dialog>
      <Dialog open={notificationsOpen} onClose={() => setNotificationsOpen(false)} className="h-[90dvh] max-h-[90dvh] max-w-2xl overflow-hidden sm:h-[640px] sm:max-h-[calc(100dvh-2rem)]">
        <div className="flex h-full min-h-0 flex-col" role="dialog" aria-modal="true" aria-labelledby="notifications-title" onKeyDown={(event) => { if (event.key === 'Escape') setNotificationsOpen(false); }}>
          <DialogHeader><div><h2 id="notifications-title" className="text-lg font-bold text-slate-900">Notifications</h2><p className="mt-1 text-sm text-slate-500">Latest updates from the last 3 days. Opening this panel marks them as read.</p></div></DialogHeader>
          {notificationReadError && <p role="alert" className="shrink-0 px-4 pt-3 text-xs text-amber-700 sm:px-6">{notificationReadError}</p>}
          <div className="grid shrink-0 grid-cols-2 gap-2 px-4 pt-3 sm:grid-cols-4 sm:px-6" aria-label="Notification categories">
            {notificationCategories.map(({ key, label, icon: Icon }) => <button key={key} type="button" aria-pressed={notificationCategory === key} onClick={() => setNotificationCategory(key)} className={`inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold transition ${notificationCategory === key ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-violet-50'}`}><Icon className="h-3.5 w-3.5" />{label}<span className="rounded-full bg-white/20 px-1.5">{visibleNotifications.filter((item) => key === 'all' || item.category === key).length}</span></button>)}
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
            {notificationsLoading ? <p className="text-sm text-slate-500">Loading notifications...</p> : notificationsError ? <p role="alert" className="text-sm text-red-600">{notificationsError}</p> : filteredNotifications.length === 0 ? <p className="flex h-full min-h-24 items-center justify-center text-center text-sm text-slate-500">No updates in the last 3 days{notificationCategory === 'all' ? '.' : ' in this category.'}</p> : filteredNotifications.map((item) => {
              const category = notificationCategories.find((category) => category.key === item.category)!;
              const Icon = category.icon;
              const isNew = newNotificationIds.includes(item.id) || !item.read;
              return <button key={item.id} onClick={() => { setActive(item.category); setNotificationsOpen(false); }} className={`block w-full rounded-xl border p-4 text-left transition hover:border-violet-300 hover:bg-violet-50 ${isNew ? 'border-violet-200 bg-violet-50/70' : 'border-slate-200 bg-white'}`}>
                <div className="flex items-center gap-2 text-xs font-semibold text-violet-700"><Icon className="h-4 w-4" />{category.label}{isNew && <span className="rounded-full bg-violet-600 px-2 py-0.5 text-[10px] text-white">New</span>}</div>
                <p className="mt-2 break-words text-sm font-semibold text-slate-900">{item.title}</p>
                <p className="mt-1 break-words text-sm leading-5 text-slate-600">{item.description}</p>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs"><time dateTime={item.createdAt} className="text-slate-500">{new Date(item.createdAt).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><span className="font-semibold text-violet-700">Open {category.label}</span></div>
              </button>;
            })}
          </div>
          <div className="flex shrink-0 justify-end border-t border-slate-100 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6"><Button autoFocus className="w-full sm:w-auto" variant="outline" onClick={() => setNotificationsOpen(false)}>Close</Button></div>
        </div>
      </Dialog>
    </div>
  );
}
