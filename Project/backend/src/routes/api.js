import { clockOutSessions, forcedClockOutUpdate } from '../force-clock-out.js';
import { activityFilter, auditPresentation } from '../audit-display.js';
import { loadNotifications } from '../notifications.js';
import { Router } from 'express';
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { attendanceRiskForEmployee, buildAIInsights } from '../ai-insights.js';
import { hashSecret, verifyAdminPassword, verifySecret } from './auth.js';
import { getSystemControls, updateSystemControls } from '../system-controls.js';
import { auditEvent, auditScreenName, authenticate, csrfProtection, pick, requireRole, rateLimit } from '../security.js';
import {
  BiometricError,
  encryptFingerprintSamples,
  fingerprintMatchStrength,
  fingerprintMatchThreshold,
  findFingerprintDecision,
  findFingerprintMatch,
  normalizeFingerprintSamples,
  rejectDuplicateEnrollment,
  validateEnrollmentSamples,
} from '../biometrics.js';

const router = Router();
const MAX_DAILY_ATTENDANCE_SESSIONS = 3;
const AI_INSIGHTS_CACHE_MS = 60_000;
let aiInsightsCache = { expiresAt: 0, value: null };

async function visibleEmployeeIds(db) {
  const employees = await db.collection('employees').find(
    { archived: { $ne: true } },
    { projection: { id: 1 } },
  ).toArray();
  return employees.map((employee) => employee.id).filter(Boolean);
}

async function activeBiometricTemplates(db) {
  const employees = await db.collection('employees').find(
    { archived: { $ne: true }, status: { $ne: 'inactive' } },
    { projection: { id: 1 } },
  ).toArray();
  const employeeIds = employees.map((employee) => employee.id).filter(Boolean);
  if (!employeeIds.length) return [];
  return db.collection('biometric_templates').find({ employeeId: { $in: employeeIds } }).toArray();
}

function generateTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(14), (byte) => alphabet[byte % alphabet.length]).join('');
}

function monthKeyInManila(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

function leaveDaysInMonth(request, monthKey) {
  const exactDates = Array.isArray(request.approvedDates) && request.approvedDates.length ? request.approvedDates : Array.isArray(request.requestedDates) ? request.requestedDates : null;
  if (exactDates) return exactDates.filter((date) => String(date).startsWith(`${monthKey}-`)).length;
  const monthStart = new Date(`${monthKey}-01T00:00:00Z`);
  const monthEnd = new Date(monthStart);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  monthEnd.setUTCDate(0);
  const requestStart = new Date(`${request.startDate}T00:00:00Z`);
  const requestEnd = new Date(`${request.endDate}T00:00:00Z`);
  if ([monthStart, monthEnd, requestStart, requestEnd].some((date) => Number.isNaN(date.getTime()))) return 0;
  const overlapStart = Math.max(monthStart.getTime(), requestStart.getTime());
  const overlapEnd = Math.min(monthEnd.getTime(), requestEnd.getTime());
  return overlapEnd < overlapStart ? 0 : Math.floor((overlapEnd - overlapStart) / 86400000) + 1;
}

function monthlyLeaveSummary(requests, monthlyCredits, month = monthKeyInManila()) {
  const used = requests.filter((request) => request.status === 'approved').reduce((total, request) => total + leaveDaysInMonth(request, month), 0);
  const allowance = Math.max(0, Number(monthlyCredits || 0));
  return { month, total: allowance, used, remaining: Math.max(0, allowance - used) };
}

function monthKeysForRange(startDate, endDate) {
  const start = new Date(`${String(startDate).slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${String(endDate).slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const months = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    months.push(cursor.toISOString().slice(0, 7));
  }
  return months;
}

function scheduledWorkStatus(settings, dateValue) {
  const override = settings?.shift?.scheduleOverrides?.find((entry) => entry.date === dateValue);
  if (override) return override.working === true;
  const date = new Date(`${dateValue}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return Array.isArray(settings?.shift?.workWeekdays) && settings.shift.workWeekdays.includes(date.getUTCDay());
}

export async function enforceAutomaticAbsences(db, settings, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 30);
  const reviewDates = [];
  for (const cursor = new Date(start); cursor.toISOString().slice(0, 10) < today; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    if (scheduledWorkStatus(settings, date)) reviewDates.push(date);
  }
  await db.collection('attendance').deleteMany({ automaticAbsence: true, date: { $gte: start.toISOString().slice(0, 10), $lt: today, $nin: reviewDates } });
  if (!reviewDates.length) return { created: 0 };
  const employees = await db.collection('employees').find({ archived: { $ne: true }, status: { $ne: 'inactive' } }, { projection: { id: 1, name: 1, role: 1, createdAt: 1 } }).toArray();
  if (!employees.length) return { created: 0 };
  const employeeIds = employees.map((employee) => employee.id);
  const [existing, approvedLeave] = await Promise.all([
    db.collection('attendance').find({ employeeId: { $in: employeeIds }, date: { $in: reviewDates } }, { projection: { employeeId: 1, date: 1 } }).toArray(),
    db.collection('leave_requests').find({ employeeId: { $in: employeeIds }, status: 'approved' }).toArray(),
  ]);
  const occupied = new Set(existing.map((record) => `${record.employeeId}:${record.date}`));
  const leaveDates = new Set();
  for (const leave of approvedLeave) {
    const dates = Array.isArray(leave.approvedDates) && leave.approvedDates.length ? leave.approvedDates : [];
    for (const date of dates) leaveDates.add(`${leave.employeeId}:${date}`);
  }
  const createdAt = new Date();
  const operations = [];
  for (const employee of employees) {
    const employeeStart = employee.createdAt ? new Date(employee.createdAt).toISOString().slice(0, 10) : null;
    for (const date of reviewDates) {
      const key = `${employee.id}:${date}`;
      if ((employeeStart && date < employeeStart) || occupied.has(key) || leaveDates.has(key)) continue;
      operations.push({ updateOne: {
        filter: { employeeId: employee.id, date },
        update: { $setOnInsert: { employeeId: employee.id, name: employee.name, role: employee.role === 'extra' ? 'Extra' : 'Regular', date, checkIn: null, checkOut: null, sessions: [], status: 'Absent', automaticAbsence: true, createdAt, updatedAt: createdAt } },
        upsert: true,
      } });
    }
  }
  if (!operations.length) return { created: 0 };
  const result = await db.collection('attendance').bulkWrite(operations, { ordered: false });
  aiInsightsCache = { expiresAt: 0, value: null };
  return { created: result.upsertedCount || 0 };
}

async function reconcileLeaveWithSchedule(db, settings) {
  const requests = await db.collection('leave_requests').find({ status: { $in: ['pending', 'approved'] } }).toArray();
  for (const request of requests) {
    const field = request.status === 'approved' ? 'approvedDates' : 'requestedDates';
    const dates = Array.isArray(request[field]) ? request[field] : [];
    if (!dates.length) continue;
    const eligibleDates = dates.filter((date) => scheduledWorkStatus(settings, date));
    const removedDates = dates.filter((date) => !eligibleDates.includes(date));
    if (!removedDates.length) continue;
    const changes = {
      [field]: eligibleDates,
      totalDays: eligibleDates.length,
      scheduleAdjustedAt: new Date(),
      status: eligibleDates.length ? request.status : 'cancelled',
    };
    if (eligibleDates.length) {
      changes.startDate = eligibleDates[0];
      changes.endDate = eligibleDates.at(-1);
    }
    await db.collection('leave_requests').updateOne({ _id: request._id }, { $set: changes });
    if (request.status === 'approved') {
      await db.collection('attendance').deleteMany({ employeeId: request.employeeId, leaveRequestId: request.id, status: 'On Leave', date: { $in: removedDates }, $or: [{ checkIn: null }, { checkIn: '' }, { checkIn: { $exists: false } }] });
    }
  }
}

router.use(authenticate, csrfProtection);
router.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  res.on('finish', () => {
    if (res.locals.skipAudit === true || req.path === '/admin/notifications/read') return;
    const body = req.body ?? {};
    const changedFields = Object.keys(body).filter((key) => !['adminPassword', 'password', 'fingerprintSamples', 'template', 'captchaAnswer'].includes(key)).slice(0, 30);
    const targetName = String(body.employeeName || body.name || [body.firstName, body.lastName].filter(Boolean).join(' ') || '').trim().slice(0, 120) || null;
    void auditEvent({
      req,
      actor: req.auth?.actor,
      action: `api.${req.method.toLowerCase()}`,
      targetType: req.path.split('/').filter(Boolean)[0] ?? 'api',
      targetId: req.params?.id ?? req.params?.employeeId ?? null,
      outcome: res.locals.auditOutcome || (res.statusCode < 400 ? 'success' : 'failure'),
      metadata: {
        path: req.path, method: req.method, statusCode: res.statusCode, changedFields, targetName,
        requestedStatus: typeof body.status === 'string' ? body.status : null,
        payrollContext: /payroll/.test(req.path) ? {
          scope: body.scope, amount: body.amount, periodStart: body.periodStart,
          selectedCount: Array.isArray(body.ids) ? body.ids.length : undefined,
          printScope: body.printScope, employeeName: body.employeeName, recordCount: body.recordCount,
        } : null,
        settingsValues: req.path === '/settings' ? {
          workStart: body.shift?.startTime, lateGraceMinutes: body.shift?.lateGraceMinutes,
          automaticClockOutTime: body.shift?.autoClockOutTime, workDays: body.shift?.workDays,
          monthlyLeaveCredits: body.leave?.monthlyCredits,
          regularHourlyRate: body.payroll?.hourlyRates?.regular, extraHourlyRate: body.payroll?.hourlyRates?.extra,
        } : null,
        ...(res.locals.auditMetadata || {}),
      },
    });
  });
  next();
});
router.use((req, res, next) => {
  if (req.auth?.accountType === 'employee' && req.auth.actor?.mustChangePassword === true) {
    return res.status(403).json({
      error: 'Change your temporary password before continuing.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }
  next();
});

router.get('/employee/me', requireRole('regular', 'extra'), async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const employeeId = req.auth.actor.employeeId;
    const employee = await db.collection('employees').findOne({ id: employeeId, archived: { $ne: true } });
    if (!employee) return res.status(404).json({ error: 'Employee profile not found' });
    const [attendance, leaveRequests, biometricTemplate, settings] = await Promise.all([
      db.collection('attendance').find({ employeeId }).sort({ date: -1 }).limit(60).toArray(),
      db.collection('leave_requests').find({ employeeId }).sort({ createdAt: -1, _id: -1 }).toArray(),
      db.collection('biometric_templates').findOne({ employeeId }, { projection: { _id: 1 } }),
      getSettings(db),
    ]);
    const carriedPayroll = await db.collection('payroll_requests').find({ employeeId, status: 'carried_over' }).toArray();
    for (const record of carriedPayroll) {
      const periodStart = payrollPeriodKeyForRecord(record);
      if (/^\d{4}-\d{2}-(01|16)$/.test(periodStart)) await preparePayrollRecord(db, employee, periodStart, settings);
    }
    const activePeriod = payrollPeriodKey();
    const activePayroll = await db.collection('payroll_requests').findOne({ employeeId, periodStart: activePeriod });
    if (!activePayroll || ['processing', 'rejected'].includes(activePayroll.status)) {
      await preparePayrollRecord(db, employee, activePeriod, settings);
    }
    const payroll = await db.collection('payroll_requests').find({ employeeId }).sort({ createdAt: -1, _id: -1 }).limit(12).toArray();
    const monthlyLeaveCredits = monthlyLeaveSummary(leaveRequests, settings.leave.monthlyCredits);
    const today = kioskTimestamp().date;
    const onLeaveToday = leaveRequests.some((leave) => leave.status === 'approved' && (Array.isArray(leave.approvedDates) && leave.approvedDates.length ? leave.approvedDates.includes(today) : leave.startDate <= today && leave.endDate >= today));
    const attendanceFlag = attendanceRiskForEmployee(attendance, employeeId, leaveRequests, today);
    res.json({
      profile: { id: employee.id, name: employee.name, email: employee.email, phone: employee.phone, address: employee.address, role: employee.role, status: employee.status === 'inactive' ? 'inactive' : onLeaveToday ? 'on-leave' : 'active', biometricStatus: biometricTemplate ? 'enrolled' : 'none', monthlyLeaveCredits, hourlyRate: configuredHourlyRate(employee, settings), grossSalary: employee.grossSalary, createdAt: employee.createdAt },
      attendance: attendance.map(({ _id, ...record }) => record),
      leaveRequests: leaveRequests.map(({ _id, ...record }) => record),
      attendanceFlag,
      workSchedule: { workWeekdays: settings.shift.workWeekdays, scheduleOverrides: settings.shift.scheduleOverrides, startTime: settings.shift.startTime, autoClockOutTime: settings.shift.autoClockOutTime },
      payroll: payroll.map((record) => ({
        id: record.id,
        amount: Number(record.amount || 0),
        grossAmount: Number(record.grossAmount || 0),
        currentAmount: Number(record.currentAmount || 0),
        carryOverAmount: Number(record.carryOverAmount || 0),
        additions: Array.isArray(record.additions) ? record.additions.slice(0, 20).map((item) => ({ label: String(item.label || 'Addition').slice(0, 80), value: Number(item.value || 0) })) : [],
        hoursWorked: Number(record.hoursWorked || 0),
        hourlyRate: Number(record.hourlyRate || 0),
        status: record.status,
        periodStart: payrollPeriodKeyForRecord(record),
        paidAt: record.paidAt,
        warnings: Array.isArray(record.warnings) ? record.warnings.slice(0, 20).map((warning) => String(warning).slice(0, 200)) : [],
        createdAt: record.createdAt,
      })),
    });
  } catch { res.status(500).json({ error: 'Unable to load employee workspace' }); }
});

router.patch('/employee/me/contact', requireRole('regular', 'extra'), async (req, res) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    const address = String(req.body?.address ?? '').trim().replace(/\s+/g, ' ');
    if (phone.length < 7 || phone.length > 30 || !/^[0-9+()\-\s.]+$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid phone number using 7 to 30 characters.' });
    }
    if (address.length < 5 || address.length > 200) {
      return res.status(400).json({ error: 'Enter an address using 5 to 200 characters.' });
    }
    const db = mongoose.connection.db;
    const employeeId = req.auth.actor.employeeId;
    const updatedAt = new Date();
    const result = await db.collection('employees').findOneAndUpdate(
      { id: employeeId, archived: { $ne: true }, status: { $ne: 'inactive' } },
      { $set: { phone, address, updatedAt } },
      { returnDocument: 'after', projection: { _id: 0, id: 1, phone: 1, address: 1 } },
    );
    if (!result) return res.status(404).json({ error: 'Active employee profile not found.' });
    res.json(result);
  } catch (error) {
    console.error('Employee contact update failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Unable to update your contact information.' });
  }
});

router.post('/employee/me/leave-requests', requireRole('regular', 'extra'), async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const employeeId = req.auth.actor.employeeId;
    const employee = await db.collection('employees').findOne({ id: employeeId, archived: { $ne: true }, status: { $ne: 'inactive' } });
    if (!employee) return res.status(404).json({ error: 'Active employee profile not found' });
    const leaveType = String(req.body?.leaveType ?? '');
    const requestedDates = Array.isArray(req.body?.requestedDates) ? [...new Set(req.body.requestedDates.map((date) => String(date)).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort() : [];
    const reason = String(req.body?.reason ?? '').trim();
    if (!['Annual Leave', 'Sick Leave', 'Personal Leave', 'Maternity Leave'].includes(leaveType)) return res.status(400).json({ error: 'Select a valid leave type' });
    if (!requestedDates.length || requestedDates.length > 366) return res.status(400).json({ error: 'Select between 1 and 366 leave dates.' });
    const startDate = requestedDates[0];
    const endDate = requestedDates.at(-1);
    const totalDays = requestedDates.length;
    const settings = await getSettings(db);
    const nonWorkingDates = requestedDates.filter((date) => scheduledWorkStatus(settings, date) === false);
    if (nonWorkingDates.length) return res.status(409).json({ error: `Leave cannot include ${nonWorkingDates[0]} because it is a scheduled non-working date.` });
    if (reason.length < 5 || reason.length > 500) return res.status(400).json({ error: 'Provide a reason between 5 and 500 characters' });
    const existingRequests = await db.collection('leave_requests').find({ employeeId, status: { $in: ['pending', 'approved'] }, startDate: { $lte: endDate }, endDate: { $gte: startDate } }).toArray();
    const requestedSet = new Set(requestedDates);
    const overlap = existingRequests.find((item) => (Array.isArray(item.approvedDates) && item.approvedDates.length ? item.approvedDates : item.requestedDates ?? []).some((date) => requestedSet.has(date)));
    if (overlap) return res.status(409).json({ error: 'One or more selected dates already belong to another leave request.' });
    const id = `LR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const initials = employee.name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
    const request = { id, employeeId, employeeName: employee.name, role: employee.role === 'extra' ? 'Extra' : 'Regular', leaveType, startDate, endDate, requestedDates, approvedDates: [], totalDays, reason, status: 'pending', initials, createdAt: new Date() };
    await db.collection('leave_requests').insertOne(request);
    res.locals.auditMetadata = { targetName: employee.name, employeeId, leaveType, requestedDates, leaveAction: 'submitted' };
    res.status(201).json({ ...request, _id: undefined });
  } catch { res.status(500).json({ error: 'Unable to submit leave request' }); }
});

router.patch('/employee/me/leave-requests/:id/cancel', requireRole('regular', 'extra'), async (req, res) => {
  try {
    const request = await mongoose.connection.db.collection('leave_requests').findOneAndUpdate(
      { id: req.params.id, employeeId: req.auth.actor.employeeId, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: req.auth.actor.email } },
      { returnDocument: 'after' },
    );
    if (!request) return res.status(409).json({ error: 'Only your own pending leave requests can be cancelled.' });
    res.json({ ...request, _id: undefined });
  } catch { res.status(500).json({ error: 'Unable to cancel the leave request.' }); }
});

router.use(requireRole('admin'));

// Read state belongs to the account, so it survives logout and device changes.
router.get('/admin/notifications', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const notifications = await loadNotifications(db);
    const seen = new Set(req.auth.actor.seenNotificationIds || []);
    const legacySeen = new Set(req.auth.actor.seenLeaveNotifications || []);
    res.json(notifications.map(({ _id, ...event }) => ({
      ...event, id: _id, read: seen.has(_id) || (event.category === 'leave' && legacySeen.has(_id.slice(6))),
    })));
  } catch {
    res.status(500).json({ error: 'Unable to load notifications' });
  }
});

router.post('/admin/notifications/read', async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length > 2_000 || ids.some((id) => typeof id !== 'string' || !id || id.length > 200)) {
    return res.status(400).json({ error: 'Invalid notification IDs' });
  }
  try {
    const db = mongoose.connection.db;
    const notifications = await db.collection('admin_notifications').find({ _id: { $in: ids }, expiresAt: { $gt: new Date() } }, { projection: { _id: 1 } }).toArray();
    const readIds = notifications.map((notification) => notification._id);
    if (readIds.length) {
      await db.collection(req.auth.accountType === 'employee' ? 'employee_accounts' : 'admin_accounts').updateOne(
        { _id: req.auth.actor._id }, { $addToSet: { seenNotificationIds: { $each: readIds } } },
      );
    }
    res.json({ readIds });
  } catch {
    res.status(500).json({ error: 'Unable to mark notifications as read' });
  }
});

router.get('/admin/account-security', (req, res) => {
  res.json({ email: req.auth.actor.email, name: req.auth.actor.name || req.auth.actor.fullName || '' });
});

router.patch('/admin/account-security', async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword ?? '');
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const newPassword = String(req.body?.newPassword ?? '');
    if (!currentPassword) return res.status(400).json({ error: 'Enter your current administrator password.' });
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid administrator email address.' });
    if (newPassword && (newPassword.length < 8 || newPassword.length > 64)) return res.status(400).json({ error: 'The new password must be between 8 and 64 characters.' });

    const verification = await verifyAdminPassword(req, currentPassword);
    if (!verification.valid) {
      if (verification.retryAfterSeconds) res.setHeader('Retry-After', String(verification.retryAfterSeconds));
      return res.status(verification.retryAfterSeconds ? 429 : 401).json({
        error: verification.retryAfterSeconds ? `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.` : 'Incorrect administrator password.',
        ...(verification.retryAfterSeconds ? { retryAfterSeconds: verification.retryAfterSeconds } : {}),
      });
    }

    const admin = verification.admin;
    const emailChanged = email !== admin.email;
    const passwordChanged = Boolean(newPassword);
    if (!emailChanged && !passwordChanged) return res.status(400).json({ error: 'Enter a new email address or a new password.' });
    if (passwordChanged && await verifySecret(newPassword, admin.passwordHash)) return res.status(400).json({ error: 'Choose a password different from your current password.' });

    const db = mongoose.connection.db;
    if (emailChanged) {
      const [adminConflict, employeeConflict] = await Promise.all([
        db.collection('admin_accounts').findOne({ email, _id: { $ne: admin._id } }, { projection: { _id: 1 } }),
        db.collection('employee_accounts').findOne({ email }, { projection: { _id: 1 } }),
      ]);
      if (adminConflict || employeeConflict) return res.status(409).json({ error: 'That email address is already used by another WORKPULSE MVL account.' });
    }

    const changedAt = new Date();
    const changes = { email, updatedAt: changedAt, credentialsChangedAt: changedAt };
    if (passwordChanged) changes.passwordHash = await hashSecret(newPassword);
    await db.collection('admin_accounts').updateOne({ _id: admin._id, active: true }, { $set: changes });
    const revoked = await db.collection('admin_sessions').deleteMany({ _id: { $ne: req.auth.session._id }, $or: [{ accountType: 'admin', accountId: admin._id }, { adminId: admin._id }] });
    await db.collection('login_otps').deleteMany({ $or: [{ accountType: 'admin', accountId: admin._id }, { adminId: admin._id }] });
    await auditEvent({ req, actor: { ...admin, email }, action: 'auth.admin_credentials_changed', targetType: 'admin_account', targetId: String(admin._id), outcome: 'success', metadata: { emailChanged, passwordChanged, revokedSessions: revoked.deletedCount } });
    res.locals.skipAudit = true;
    res.locals.auditMetadata = { adminAction: 'credentials-updated', emailChanged, passwordChanged, revokedSessions: revoked.deletedCount };
    res.json({ email, emailChanged, passwordChanged, revokedSessions: revoked.deletedCount });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'That email address is already used by another WORKPULSE MVL account.' });
    console.error('Admin credential update failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Unable to update administrator credentials.' });
  }
});

router.get('/admin/system-controls', async (_req, res) => {
  try { res.json(await getSystemControls(mongoose.connection.db)); }
  catch { res.status(500).json({ error: 'Unable to load system controls' }); }
});

router.patch('/admin/system-controls', async (req, res) => {
  try {
    const changes = {};
    if (Object.hasOwn(req.body ?? {}, 'maintenanceMode')) changes.maintenanceMode = Boolean(req.body.maintenanceMode);
    if (Object.hasOwn(req.body ?? {}, 'registrationOpen')) changes.registrationOpen = Boolean(req.body.registrationOpen);
    if (!Object.keys(changes).length) return res.status(400).json({ error: 'No supported control was provided' });
    res.locals.auditMetadata = { adminAction: 'system-control-updated', controlChanges: changes };
    res.json(await updateSystemControls(mongoose.connection.db, changes, req.auth.actor.email));
  } catch { res.status(500).json({ error: 'Unable to update system controls' }); }
});

router.patch('/admin/employees/:id/access', async (req, res) => {
  try {
    const banned = Boolean(req.body?.banned);
    const db = mongoose.connection.db;
    const employee = await db.collection('employees').findOneAndUpdate(
      { id: req.params.id, archived: { $ne: true } },
      { $set: { banned, updatedAt: new Date() } }, { returnDocument: 'after' },
    );
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    await db.collection('employee_accounts').updateMany({ employeeId: employee.id }, { $set: { active: !banned, updatedAt: new Date() } });
    if (banned) {
      const accounts = await db.collection('employee_accounts').find({ employeeId: employee.id }, { projection: { _id: 1 } }).toArray();
      if (accounts.length) await db.collection('admin_sessions').deleteMany({ accountType: 'employee', accountId: { $in: accounts.map((account) => account._id) } });
    }
    res.locals.auditMetadata = { adminAction: banned ? 'employee-access-blocked' : 'employee-access-restored', targetName: employee.name, employeeId: employee.id };
    res.json({ id: employee.id, banned });
  } catch { res.status(500).json({ error: 'Unable to update employee access' }); }
});

router.get('/admin/force-clock-out', async (req, res) => {
  try {
    const stamp = kioskTimestamp();
    const records = await mongoose.connection.db.collection('attendance').find({ date: stamp.date }).sort({ name: 1 }).toArray();
    res.json({ date: stamp.date, employees: records.filter((record) => clockOutSessions(record).some((session) => session.checkIn)).map((record) => {
      const sessions = clockOutSessions(record);
      return { employeeId: record.employeeId, name: record.name || record.employeeId, checkIn: sessions[0]?.checkIn, lastCheckIn: sessions.at(-1)?.checkIn, checkOut: sessions.at(-1)?.checkOut || null, clockedIn: sessions.some((session) => session.checkIn && !session.checkOut) };
    }) });
  } catch { res.status(500).json({ error: "Unable to load today's attendance" }); }
});

router.post('/admin/force-clock-out', async (req, res) => {
  const { scope, employeeIds, date } = req.body || {};
  if (!['all', 'individual'].includes(scope) || !Array.isArray(employeeIds) || !employeeIds.length || employeeIds.length > 2000 || employeeIds.some((id) => typeof id !== 'string' || !id || id.length > 200) || (scope === 'individual' && employeeIds.length !== 1)) {
    return res.status(400).json({ error: 'Choose an employee or all clocked-in employees.' });
  }
  const stamp = kioskTimestamp();
  if (date !== stamp.date) return res.status(409).json({ error: 'The day has changed. Refresh the list before clocking out.' });
  let clockedOut = 0;
  const names = [];
  const failedIds = [];
  try {
    const db = mongoose.connection.db;
    const ids = [...new Set(employeeIds)];
    const records = await db.collection('attendance').find({ date: stamp.date, employeeId: { $in: ids } }).toArray();
    for (const record of records) {
      const operation = forcedClockOutUpdate(record, stamp, req.auth.actor.email);
      if (!operation) continue;
      try {
        const result = await db.collection('attendance').updateOne(operation.filter, operation.update);
        if (result.modifiedCount) { clockedOut += 1; names.push(record.name || record.employeeId); }
      } catch { failedIds.push(record.employeeId); }
    }
    const skipped = ids.length - clockedOut - failedIds.length;
    res.locals.auditMetadata = { adminAction: 'force-clock-out', scope, recordCount: clockedOut, skippedCount: skipped, failedCount: failedIds.length, targetName: scope === 'individual' ? records[0]?.name : null, eventTime: stamp.time };
    if (failedIds.length) res.locals.auditOutcome = 'failure';
    res.json({ clockedOut, skipped, failed: failedIds.length, names, time: stamp.time, date: stamp.date });
  } catch (error) {
    res.locals.auditMetadata = { adminAction: 'force-clock-out', scope, recordCount: clockedOut, eventTime: stamp.time };
    console.error('Force clock out failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Unable to complete force clock out. Refresh attendance before retrying.' });
  }
});

router.get('/admin/backup', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const collectionNames = [
      'employees', 'attendance', 'leave_requests', 'payroll_requests', 'settings', 'system_controls',
      'biometric_templates', 'biometric_verification_attempts', 'biometric_evaluation_trials',
    ];
    const collections = {};
    for (const name of collectionNames) {
      collections[name] = (await db.collection(name).find({}).toArray()).map(({ _id, ...document }) => document);
    }
    const createdAt = new Date();
    const backup = { format: 'workpulse-json-backup', version: 1, createdAt, createdBy: req.auth.actor.email, collections };
    const filename = `workpulse-backup-${createdAt.toISOString().replace(/[:.]/g, '-')}.json`;
    await auditEvent({ req, actor: req.auth.actor, action: 'admin.backup_created', targetType: 'database_backup', outcome: 'success', metadata: { collections: collectionNames, filename } });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (error) {
    console.error('Backup generation failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Unable to generate the database backup' });
  }
});

router.get('/ai-insights', async (req, res) => {
  try {
    if (req.query.refresh !== '1' && aiInsightsCache.value && aiInsightsCache.expiresAt > Date.now()) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(aiInsightsCache.value);
    }
    const db = mongoose.connection.db;
    const employeeIds = await visibleEmployeeIds(db);
    const employeeIdSet = new Set(employeeIds);
    const attendanceStart = new Date();
    attendanceStart.setUTCFullYear(attendanceStart.getUTCFullYear() - 1);
    const attendanceStartDate = attendanceStart.toISOString().slice(0, 10);
    const [attendance, employees, leaveRequests, verificationAttempts, evaluationTrials] = await Promise.all([
      db.collection('attendance').find({ employeeId: { $in: employeeIds }, date: { $gte: attendanceStartDate } }).sort({ date: 1 }).toArray(),
      db.collection('employees').find({ id: { $in: employeeIds } }).toArray(),
      db.collection('leave_requests').find({ employeeId: { $in: employeeIds }, status: 'approved', endDate: { $gte: attendanceStartDate } }).toArray(),
      db.collection('biometric_verification_attempts').find({}).sort({ createdAt: -1 }).limit(500).toArray(),
      db.collection('biometric_evaluation_trials').find({}).sort({ createdAt: -1 }).limit(1000).toArray(),
    ]);
    const legacyIdentificationTrials = verificationAttempts.filter((attempt) => attempt.source === 'admin-identification').map((attempt) => ({
      ...attempt, id: String(attempt._id), mode: 'automatic-identification', expectedType: 'automatic',
      expectedEmployeeId: null, expectedEmployeeName: null, actualEmployeeId: attempt.employeeId || null,
      actualEmployeeName: employees.find((employee) => employee.id === attempt.employeeId)?.name || null,
      classification: null,
    }));
    const visibleVerificationAttempts = verificationAttempts.filter((attempt) => attempt.source !== 'admin-identification' && (!attempt.employeeId || employeeIdSet.has(attempt.employeeId)));
    const visibleEvaluationTrials = [...evaluationTrials, ...legacyIdentificationTrials].filter((trial) =>
      (!trial.expectedEmployeeId || employeeIdSet.has(trial.expectedEmployeeId))
      && (!trial.actualEmployeeId || employeeIdSet.has(trial.actualEmployeeId))).sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
    const insights = buildAIInsights({ attendance, employees, leaveRequests, verificationAttempts: visibleVerificationAttempts, evaluationTrials: visibleEvaluationTrials, fingerJetThreshold: fingerprintMatchThreshold() });
    aiInsightsCache = { value: insights, expiresAt: Date.now() + AI_INSIGHTS_CACHE_MS };
    res.setHeader('X-Cache', 'MISS');
    res.json(insights);
  } catch (error) {
    console.error('AI insights generation failed:', error);
    res.status(500).json({ error: 'Unable to generate AI insights right now.' });
  }
});

router.post('/biometric-evaluation-trials', async (req, res) => {
  try {
    const db = mongoose.connection?.db;
    if (!db) return res.status(503).json({ error: 'MongoDB connection not ready' });
    const expectedType = req.body?.expectedType === 'impostor' ? 'impostor' : req.body?.expectedType === 'genuine' ? 'genuine' : null;
    const expectedEmployeeId = String(req.body?.expectedEmployeeId ?? '').trim();
    if (!expectedType) return res.status(400).json({ error: 'Choose an enrolled employee or a non-enrolled finger test' });
    if (expectedType === 'genuine' && !expectedEmployeeId) return res.status(400).json({ error: 'Choose the employee expected to match' });
    const [probe] = normalizeFingerprintSamples(req.body?.fingerprintSamples, 1);
    const deviceUid = String(req.body?.deviceUid ?? '').trim().slice(0, 200);
    const templates = await activeBiometricTemplates(db);
    if (expectedType === 'genuine' && !templates.some((template) => template.employeeId === expectedEmployeeId)) {
      return res.status(400).json({ error: 'The selected employee does not have an active fingerprint enrollment.' });
    }
    const startedAt = Date.now();
    const decision = await findFingerprintDecision(probe, templates);
    const responseTimeMs = Date.now() - startedAt;
    const actualEmployeeId = decision.accepted ? decision.best?.employeeId || null : null;
    let classification;
    if (expectedType === 'impostor') classification = decision.accepted ? 'FA' : 'TR';
    else if (!decision.accepted) classification = 'FR';
    else classification = actualEmployeeId === expectedEmployeeId ? 'TA' : 'FA';
    const expectedEmployee = expectedType === 'genuine' ? await db.collection('employees').findOne({ id: expectedEmployeeId }) : null;
    const actualEmployee = actualEmployeeId ? await db.collection('employees').findOne({ id: actualEmployeeId }) : null;
    const trial = {
      id: crypto.randomUUID(), mode: 'one-to-many', expectedType,
      expectedEmployeeId: expectedType === 'genuine' ? expectedEmployeeId : null,
      expectedEmployeeName: expectedEmployee?.name || null,
      actualEmployeeId, actualEmployeeName: actualEmployee?.name || null,
      accepted: decision.accepted, classification,
      wrongEmployeeMatch: expectedType === 'genuine' && decision.accepted && actualEmployeeId !== expectedEmployeeId,
      score: decision.best?.score ?? null, threshold: decision.threshold,
      matchStrength: fingerprintMatchStrength(decision.best?.score, decision.threshold),
      deviceUid: deviceUid || null, responseTimeMs, createdAt: new Date(),
      createdBy: req.auth.actor.email,
    };
    await db.collection('biometric_evaluation_trials').insertOne(trial);
    res.status(201).json(trial);
  } catch (error) {
    if (error instanceof BiometricError) return res.status(error.status).json({ error: error.message });
    console.error('Biometric evaluation failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Unable to record the fingerprint evaluation trial' });
  }
});

const employeeFields = ['id', 'firstName', 'lastName', 'name', 'role', 'casualLeave', 'sickLeave', 'status', 'grossSalary', 'hoursWorked', 'hourlyRate', 'email', 'phone', 'address', 'identifiers'];

function serializedAuditEvent(event) {
  return {
    id: String(event._id),
    occurredAt: event.occurredAt,
    actorEmail: event.actorEmail ?? null,
    actorRole: event.actorRole ?? 'anonymous',
    screenName: auditScreenName(event.action, event.targetType, event.metadata),
    action: event.action ?? 'unknown',
    targetType: event.targetType ?? 'system',
    targetId: event.targetId ?? null,
    outcome: event.outcome ?? 'unknown',
    metadata: event.metadata ?? {},
    ...auditPresentation(event),
  };
}

router.get('/overview', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const db = mongoose.connection?.db;
    if (!db) return res.status(503).json({ error: 'Database is unavailable' });
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const today = kioskTimestamp().date;
    const performanceDate = datePattern.test(String(req.query.performanceDate || '')) ? String(req.query.performanceDate) : today;
    const auditDate = datePattern.test(String(req.query.auditDate || '')) ? String(req.query.auditDate) : today;
    const rangeStart = new Date(`${performanceDate}T00:00:00Z`);
    rangeStart.setUTCMonth(rangeStart.getUTCMonth() - 6);
    const attendanceStart = rangeStart.toISOString().slice(0, 10);
    const auditStart = new Date(`${auditDate}T00:00:00+08:00`);
    const auditEnd = new Date(auditStart.getTime() + 86_400_000);
    const currentPeriod = payrollPeriodKey();
    const employeeProjection = { id: 1, status: 1, createdAt: 1 };
    const [settings, employees] = await Promise.all([
      getSettings(db),
      db.collection('employees').find({ archived: { $ne: true } }, { projection: employeeProjection }).toArray(),
    ]);
    const employeeIds = employees.map((employee) => employee.id).filter(Boolean);
    const [attendance, payroll, leaveRequests, biometricTemplates, auditEvents] = await Promise.all([
      db.collection('attendance').find(
        { employeeId: { $in: employeeIds }, date: { $gte: attendanceStart, $lte: performanceDate } },
        { projection: { employeeId: 1, name: 1, role: 1, date: 1, checkIn: 1, checkOut: 1, sessions: 1, status: 1 } },
      ).sort({ date: -1 }).limit(10_000).toArray(),
      db.collection('payroll_requests').find(
        { employeeId: { $in: employeeIds }, periodStart: currentPeriod },
        { projection: { status: 1, periodStart: 1 } },
      ).limit(2_000).toArray(),
      db.collection('leave_requests').find(
        { employeeId: { $in: employeeIds }, $or: [{ status: 'pending' }, { startDate: { $lte: performanceDate }, endDate: { $gte: attendanceStart } }] },
        { projection: { id: 1, employeeId: 1, startDate: 1, endDate: 1, approvedDates: 1, totalDays: 1, status: 1 } },
      ).sort({ createdAt: -1 }).limit(2_000).toArray(),
      db.collection('biometric_templates').find({ employeeId: { $in: employeeIds } }, { projection: { employeeId: 1 } }).toArray(),
      db.collection('audit_events').find(
        { ...activityFilter, occurredAt: { $gte: auditStart, $lt: auditEnd } },
        { projection: { occurredAt: 1, actorEmail: 1, actorRole: 1, screenName: 1, action: 1, targetType: 1, targetId: 1, outcome: 1, metadata: 1 } },
      ).sort({ occurredAt: -1, _id: -1 }).limit(100).toArray(),
    ]);
    const enrolledIds = new Set(biometricTemplates.map((item) => item.employeeId));
    const onLeaveToday = new Set(leaveRequests.filter((leave) => leave.status === 'approved' && (Array.isArray(leave.approvedDates) && leave.approvedDates.length ? leave.approvedDates.includes(today) : leave.startDate <= today && leave.endDate >= today)).map((leave) => leave.employeeId));
    res.json({
      employees: employees.map((employee) => ({
        status: employee.status === 'inactive' ? 'inactive' : onLeaveToday.has(employee.id) ? 'on-leave' : 'active',
        biometricStatus: enrolledIds.has(employee.id) ? 'enrolled' : 'none',
        createdAt: employee.createdAt,
      })),
      payroll,
      attendance: attendance.map((record) => ({
        employeeId: record.employeeId, name: record.name, role: record.role, date: record.date,
        checkIn: record.checkIn, checkOut: record.checkOut, status: attendanceArrivalStatus(record, settings),
      })),
      leaveRequests,
      auditEvents: auditEvents.map(serializedAuditEvent),
    });
  } catch (error) {
    console.error('Overview fetch failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to load overview data' });
  }
});

router.get('/audit-events', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    if (!db) return res.status(503).json({ error: 'Database is unavailable' });
    const requestedLimit = Number.parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 20;
    const date = String(req.query.date ?? '').trim();
    const filter = { ...activityFilter };
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Audit date must use YYYY-MM-DD format' });
      const start = new Date(`${date}T00:00:00+08:00`);
      const end = new Date(start.getTime() + 86_400_000);
      filter.occurredAt = { $gte: start, $lt: end };
    }
    const events = await db.collection('audit_events').find(filter).sort({ occurredAt: -1, _id: -1 }).limit(limit).toArray();
    res.json(events.map(serializedAuditEvent));
  } catch (error) {
    console.error('Audit event fetch failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to fetch audit events' });
  }
});

function normalizedEmployee(input) {
  const employee = pick(input ?? {}, employeeFields);
  employee.id = String(employee.id ?? '').trim().slice(0, 40);
  employee.firstName = String(employee.firstName ?? '').trim().slice(0, 60);
  employee.lastName = String(employee.lastName ?? '').trim().slice(0, 60);
  employee.name = `${employee.firstName} ${employee.lastName}`.trim() || String(employee.name ?? '').trim().slice(0, 120);
  employee.role = ['regular', 'extra'].includes(employee.role) ? employee.role : 'regular';
  employee.status = employee.status === 'inactive' ? 'inactive' : 'active';
  if (employee.email != null) employee.email = String(employee.email).trim().toLowerCase().slice(0, 254);
  if (employee.phone != null) employee.phone = String(employee.phone).trim().slice(0, 30);
  if (employee.address != null) employee.address = String(employee.address).trim().slice(0, 300);
  employee.grossSalary = Math.max(0, Number(employee.grossSalary || 0));
  employee.hoursWorked = Math.max(0, Number(employee.hoursWorked || 0));
  employee.hourlyRate = Math.max(0, Number(employee.hourlyRate || 0));
  employee.identifiers = Array.isArray(employee.identifiers) ? employee.identifiers.slice(0, 20).map((item) => ({ type: String(item?.type ?? '').slice(0, 50), value: String(item?.value ?? '').slice(0, 100), amount: Math.max(0, Number(item?.amount || 0)) })) : [];
  const leaveBalance = (value) => ({ used: Math.max(0, Number(value?.used || 0)), total: Math.max(0, Number(value?.total || 0)) });
  employee.casualLeave = leaveBalance(employee.casualLeave);
  employee.sickLeave = leaveBalance(employee.sickLeave);
  return employee;
}

async function nextEmployeeId(db) {
  // Treat IDs in linked collections as reserved too. This prevents a manually
  // deleted employee profile from reusing an ID that still has a login,
  // fingerprint, attendance, leave, or payroll record attached to it.
  const idLists = await Promise.all([
    db.collection('employees').distinct('id'),
    db.collection('employee_accounts').distinct('employeeId'),
    db.collection('biometric_templates').distinct('employeeId'),
    db.collection('attendance').distinct('employeeId'),
    db.collection('leave_requests').distinct('employeeId'),
    db.collection('payroll_requests').distinct('employeeId'),
  ]);
  const highest = idLists.flat().reduce((maximum, id) => {
    const match = /^EMP-(\d+)$/i.exec(String(id ?? ''));
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  return `EMP-${String(highest + 1).padStart(3, '0')}`;
}

function duplicateEmployeeMessage(error) {
  const fields = Object.keys(error?.keyPattern ?? error?.keyValue ?? {});
  if (fields.includes('email')) return 'This email address is already used by another WORKPULSE MVL account.';
  if (fields.includes('employeeId')) return 'The generated employee ID is still reserved by linked account or fingerprint data. Refresh the form and try again.';
  if (fields.includes('id')) return 'The generated employee ID is already in use. Refresh the form and try again.';
  return 'A unique employee account value already exists. Refresh the form and try again.';
}

const defaultSettings = {
  shift: { enabled: true, startTime: '09:00', autoClockOutTime: '18:00', lateGraceMinutes: 0, workDays: 5, workWeekdays: [1, 2, 3, 4, 5], scheduleOverrides: [] },
  leave: { monthlyCredits: 10 },
  payroll: { hourlyRates: { regular: 50, extra: 40 } },
};

function configuredHourlyRate(employee, settings) {
  return String(employee?.role ?? '').toLowerCase() === 'extra'
    ? Number(settings?.payroll?.hourlyRates?.extra ?? defaultSettings.payroll.hourlyRates.extra)
    : Number(settings?.payroll?.hourlyRates?.regular ?? defaultSettings.payroll.hourlyRates.regular);
}

function parseAttendanceTime(date, time) {
  if (!date || !time) return null;
  const match = String(time).match(/(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (match[3]?.toUpperCase() === 'PM' && hour < 12) hour += 12;
  if (match[3]?.toUpperCase() === 'AM' && hour === 12) hour = 0;
  const result = new Date(`${date}T00:00:00`);
  if (Number.isNaN(result.getTime())) return null;
  result.setHours(hour, Number(match[2]), 0, 0);
  return result;
}

function clockMinutes(time) {
  if (!time) return null;
  const match = String(time).match(/(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (match[3]?.toUpperCase() === 'PM' && hour < 12) hour += 12;
  if (match[3]?.toUpperCase() === 'AM' && hour === 12) hour = 0;
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : null;
}

function formatAttendanceTime(date) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function attendanceSessions(record) {
  if (Array.isArray(record?.sessions) && record.sessions.length) {
    return record.sessions.slice(0, MAX_DAILY_ATTENDANCE_SESSIONS).map((session) => ({
      ...session,
      checkIn: String(session?.checkIn ?? ''),
      checkOut: session?.checkOut ? String(session.checkOut) : null,
    })).filter((session) => session.checkIn);
  }
  return record?.checkIn ? [{ checkIn: String(record.checkIn), checkOut: record.checkOut ? String(record.checkOut) : null }] : [];
}

function attendanceHoursForRecord(record, settings, calculationStart = null) {
  const calculationStartTime = calculationStart ? new Date(calculationStart).getTime() : 0;
  const rawHours = attendanceSessions(record).filter((session) => {
    if (!calculationStartTime) return true;
    const sessionStartedAt = new Date(session.checkInAt ?? record.createdAt ?? record.updatedAt ?? 0).getTime();
    return Number.isFinite(sessionStartedAt) && sessionStartedAt > calculationStartTime;
  }).reduce((total, session) => {
    const checkIn = parseAttendanceTime(record.date, session.checkIn);
    const checkOut = parseAttendanceTime(record.date, session.checkOut);
    if (!checkIn || !checkOut) return total;
    if (checkOut <= checkIn) checkOut.setDate(checkOut.getDate() + 1);
    return total + Math.max(0, (checkOut.getTime() - checkIn.getTime()) / 3600000);
  }, 0);
  return Math.max(0, rawHours);
}

export async function getSettings(db) {
  const stored = await db.collection('settings').findOne({ key: 'company' });
  const storedShift = stored?.shift ?? {};
  const storedStartMinutes = clockMinutes(storedShift.startTime ?? defaultSettings.shift.startTime);
  const legacyLateMinutes = clockMinutes(storedShift.lateAfterTime);
  const migratedGraceMinutes = legacyLateMinutes == null || storedStartMinutes == null ? 0 : Math.max(0, Math.min(180, legacyLateMinutes - storedStartMinutes));
  const workDays = Math.min(7, Math.max(1, Number(storedShift.workDays ?? defaultSettings.shift.workDays)));
  const fallbackWorkWeekdays = Array.from({ length: workDays }, (_, index) => index + 1).map((day) => day === 7 ? 0 : day);
  const storedWorkWeekdays = Array.isArray(storedShift.workWeekdays) ? [...new Set(storedShift.workWeekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))] : fallbackWorkWeekdays;
  return {
    shift: {
      enabled: true,
      startTime: storedShift.startTime ?? defaultSettings.shift.startTime,
      autoClockOutTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(storedShift.autoClockOutTime) ? storedShift.autoClockOutTime : defaultSettings.shift.autoClockOutTime,
      lateGraceMinutes: Math.max(0, Math.min(180, Number(storedShift.lateGraceMinutes ?? migratedGraceMinutes))),
      workDays,
      workWeekdays: storedWorkWeekdays.length === workDays ? storedWorkWeekdays : fallbackWorkWeekdays,
      scheduleOverrides: Array.isArray(storedShift.scheduleOverrides) ? storedShift.scheduleOverrides.filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry?.date) && typeof entry?.working === 'boolean').slice(0, 366).map((entry) => ({ date: entry.date, working: entry.working, kind: ['holiday', 'rest-day', 'workday'].includes(entry.kind) ? entry.kind : entry.working ? 'workday' : 'rest-day' })) : [],
    },
    leave: { monthlyCredits: Number(stored?.leave?.monthlyCredits ?? stored?.leave?.casualDays ?? defaultSettings.leave.monthlyCredits) },
    payroll: {
      hourlyRates: {
        regular: Number(stored?.payroll?.hourlyRates?.regular ?? defaultSettings.payroll.hourlyRates.regular),
        extra: Number(stored?.payroll?.hourlyRates?.extra ?? defaultSettings.payroll.hourlyRates.extra),
      },
    },
  };
}

function attendanceArrivalStatus(record, settings) {
  if (record?.status === 'Absent' || record?.status === 'On Leave') return record.status;
  const arrival = clockMinutes(attendanceSessions(record)[0]?.checkIn || record?.checkIn);
  const start = clockMinutes(settings?.shift?.startTime);
  const graceMinutes = Number(settings?.shift?.lateGraceMinutes || 0);
  const cutoff = start == null ? null : start + graceMinutes;
  if (arrival == null || cutoff == null) return record?.status || 'Present';
  return arrival > cutoff ? 'Late' : 'Present';
}

export async function enforceAutomaticClockOut(db, settings) {
  if (!settings.shift.enabled || clockMinutes(settings.shift.autoClockOutTime) == null) return;
  const openRecords = await db.collection('attendance').find({ $or: [
    { sessions: { $elemMatch: { $or: [{ checkOut: null }, { checkOut: '' }, { checkOut: { $exists: false } }] } } },
    { sessions: { $exists: false }, checkOut: null },
    { sessions: { $exists: false }, checkOut: '' },
    { sessions: { $exists: false }, checkOut: { $exists: false } },
  ] }).toArray();
  const now = new Date();
  await Promise.all(openRecords.map(async (record) => {
    const sessions = attendanceSessions(record);
    const openSessionIndex = sessions.findLastIndex((session) => !session.checkOut);
    if (openSessionIndex < 0) return;
    const checkIn = parseAttendanceTime(record.date, sessions[openSessionIndex].checkIn);
    if (!checkIn) return;
    const automaticOut = parseAttendanceTime(record.date, settings.shift.autoClockOutTime);
    if (!automaticOut) return;
    // A configured time earlier than the session start belongs to the following day (night shift support).
    if (automaticOut <= checkIn) automaticOut.setDate(automaticOut.getDate() + 1);
    if (automaticOut > now) return;
    const automaticOutTime = formatAttendanceTime(automaticOut);
    sessions[openSessionIndex] = { ...sessions[openSessionIndex], checkOut: automaticOutTime, autoClockedOut: true };
    await db.collection('attendance').updateOne({ _id: record._id }, { $set: { sessions, checkOut: automaticOutTime, autoClockedOut: true, sessionCount: sessions.length, updatedAt: now } });
  }));
}

router.get('/settings', async (_req, res) => {
  try { res.json(await getSettings(mongoose.connection.db)); }
  catch { res.status(500).json({ error: 'Failed to fetch settings' }); }
});

router.put('/settings', async (req, res) => {
  try {
    const incoming = req.body ?? {};
    const verification = await verifyAdminPassword(req, incoming.adminPassword);
    if (!verification.valid) {
      if (verification.retryAfterSeconds) res.setHeader('Retry-After', String(verification.retryAfterSeconds));
      return res.status(verification.forbidden ? 403 : verification.retryAfterSeconds ? 429 : 401).json({
        error: verification.forbidden ? 'Administrator access required' : verification.retryAfterSeconds ? `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.` : 'Incorrect administrator password.',
        ...(verification.retryAfterSeconds ? { retryAfterSeconds: verification.retryAfterSeconds } : {}),
      });
    }
    const numberInRange = (value, fallback, minimum, maximum) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
    };
    const db = mongoose.connection.db;
    const currentSettings = await getSettings(db);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const incomingOverrides = Array.isArray(incoming.shift?.scheduleOverrides) ? incoming.shift.scheduleOverrides.filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry?.date) && typeof entry?.working === 'boolean').slice(0, 366).map((entry) => ({ date: entry.date, working: entry.working, kind: ['holiday', 'rest-day', 'workday'].includes(entry.kind) ? entry.kind : entry.working ? 'workday' : 'rest-day' })) : [];
    const lockedPastOverrides = currentSettings.shift.scheduleOverrides.filter((entry) => entry.date < today);
    const editableOverrides = incomingOverrides.filter((entry) => entry.date >= today);
    const scheduleOverrides = [...new Map([...lockedPastOverrides, ...editableOverrides].map((entry) => [entry.date, entry])).values()].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 366);
    const normalized = {
      shift: {
        enabled: true,
        startTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(incoming.shift?.startTime) ? incoming.shift.startTime : defaultSettings.shift.startTime,
        autoClockOutTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(incoming.shift?.autoClockOutTime) ? incoming.shift.autoClockOutTime : defaultSettings.shift.autoClockOutTime,
        lateGraceMinutes: numberInRange(incoming.shift?.lateGraceMinutes, 0, 0, 180),
        workDays: numberInRange(incoming.shift?.workDays, 5, 1, 7),
        workWeekdays: Array.isArray(incoming.shift?.workWeekdays) ? [...new Set(incoming.shift.workWeekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))] : defaultSettings.shift.workWeekdays,
        scheduleOverrides,
      },
      leave: { monthlyCredits: numberInRange(incoming.leave?.monthlyCredits, 10, 0, 31) },
      payroll: {
        hourlyRates: {
          regular: numberInRange(incoming.payroll?.hourlyRates?.regular, defaultSettings.payroll.hourlyRates.regular, 1, 10000),
          extra: numberInRange(incoming.payroll?.hourlyRates?.extra, defaultSettings.payroll.hourlyRates.extra, 1, 10000),
        },
      },
    };
    if (normalized.shift.workWeekdays.length !== normalized.shift.workDays) return res.status(400).json({ error: `Select exactly ${normalized.shift.workDays} regular workdays.` });
    await mongoose.connection.db.collection('settings').updateOne({ key: 'company' }, { $set: { ...normalized, updatedAt: new Date() }, $unset: { lateness: '' } }, { upsert: true });
    await enforceAutomaticClockOut(mongoose.connection.db, normalized);
    await reconcileLeaveWithSchedule(mongoose.connection.db, normalized);
    await enforceAutomaticAbsences(mongoose.connection.db, normalized);
    const currentPeriod = payrollPeriodKey();
    const recalculablePayroll = await mongoose.connection.db.collection('payroll_requests').find({ periodStart: currentPeriod, status: { $in: ['processing', 'rejected'] } }, { projection: { employeeId: 1 } }).toArray();
    if (recalculablePayroll.length) {
      const employees = await mongoose.connection.db.collection('employees').find({ id: { $in: recalculablePayroll.map((record) => record.employeeId) }, archived: { $ne: true } }).toArray();
      for (const employee of employees) await preparePayrollRecord(mongoose.connection.db, employee, currentPeriod, normalized);
    }
    res.json(normalized);
  } catch { res.status(500).json({ error: 'Failed to save settings' }); }
});

// Uses the existing mongoose connection; documents are fetched directly from collections.
// This avoids needing mongoose schemas for now.

router.get('/employees', async (req, res) => {
  try {
    const db = mongoose.connection?.db;
    if (!db) return res.status(500).json({ error: 'MongoDB connection not ready' });

    const settings = await getSettings(db);
    await enforceAutomaticClockOut(db, settings);
    const employees = await db.collection('employees').find({ archived: { $ne: true } }).toArray();
    const employeeIds = employees.map((employee) => employee.id).filter(Boolean);
    const today = kioskTimestamp().date;
    const periodStart = currentPayrollPeriodStart();
    const [attendance, biometricTemplates, approvedLeavesToday] = await Promise.all([
      db.collection('attendance').find(
        { employeeId: { $in: employeeIds }, date: { $gte: periodStart.toISOString().slice(0, 10) } },
        { projection: { employeeId: 1, date: 1, checkIn: 1, checkOut: 1, sessions: 1 } },
      ).toArray(),
      db.collection('biometric_templates').find({ employeeId: { $in: employeeIds } }, { projection: { employeeId: 1 } }).toArray(),
      db.collection('leave_requests').find({ employeeId: { $in: employeeIds }, status: 'approved', $or: [{ approvedDates: today }, { approvedDates: { $exists: false }, startDate: { $lte: today }, endDate: { $gte: today } }] }, { projection: { employeeId: 1 } }).toArray(),
    ]);
    const enrolledEmployeeIds = new Set(biometricTemplates.map((template) => template.employeeId));
    const employeesOnLeaveToday = new Set(approvedLeavesToday.map((leave) => leave.employeeId));

    res.json(
      employees.map((e) => {
        const records = attendance.filter((record) => record.employeeId === e.id && new Date(record.date) >= periodStart);
        const hoursWorked = records.reduce((total, record) => total + attendanceHoursForRecord(record, settings), 0);
        const hourlyRate = configuredHourlyRate(e, settings);
        const calculatedGross = Math.round(hoursWorked * hourlyRate * 100) / 100;
        return ({
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
        name: e.name,
        role: e.role,
        grossSalary: records.length ? calculatedGross : Number(e.grossSalary ?? 0),
        hoursWorked: records.length ? Math.round(hoursWorked * 100) / 100 : Math.round(Number(e.hoursWorked || 0) * 100) / 100,
        hourlyRate,
        payrollPeriodDays: 15,
        status: e.status === 'inactive' ? 'inactive' : employeesOnLeaveToday.has(e.id) ? 'on-leave' : 'active',
        banned: Boolean(e.banned),
        casualLeave: e.casualLeave ?? { total: 10, used: 0 },
        sickLeave: e.sickLeave ?? { total: 10, used: 0 },
        biometricStatus: enrolledEmployeeIds.has(e.id) ? 'enrolled' : 'none',
        email: e.email,
        phone: e.phone,
        address: e.address,
        createdAt: e.createdAt,
        identifiers: e.identifiers ?? [],
      });})
    );
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

router.get('/employees-next-id', async (_req, res) => {
  try { res.json({ id: await nextEmployeeId(mongoose.connection.db) }); }
  catch { res.status(500).json({ error: 'Failed to generate the next employee ID' }); }
});

router.post('/fingerprints/check-enrollment', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const fingerprintSamples = normalizeFingerprintSamples(req.body?.fingerprintSamples, 3);
    const enrollment = await validateEnrollmentSamples(fingerprintSamples);
    await rejectDuplicateEnrollment(db, enrollment.templates);
    res.json({ available: true });
  } catch (error) {
    if (error instanceof BiometricError) return res.status(error.status).json({ error: error.message });
    console.error('Fingerprint availability check failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'The fingerprint could not be checked. Capture three new scans and try again.' });
  }
});

router.post('/fingerprints/check-scan', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const [fingerprintSample] = normalizeFingerprintSamples(req.body?.fingerprintSamples, 1);
    const storedTemplates = await db.collection('biometric_templates').find({}).toArray();
    const duplicate = storedTemplates.length ? await findFingerprintMatch(fingerprintSample, storedTemplates) : null;
    if (duplicate) return res.status(409).json({ error: 'This fingerprint is already registered. Use a different finger that is not saved in the system.' });
    res.json({ available: true });
  } catch (error) {
    if (error instanceof BiometricError) return res.status(error.status).json({ error: error.message });
    console.error('Fingerprint scan check failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'The fingerprint could not be checked. Please scan again.' });
  }
});

router.post('/fingerprints/identify', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const [fingerprintSample] = normalizeFingerprintSamples(req.body?.fingerprintSamples, 1);
    const deviceUid = String(req.body?.deviceUid ?? '').trim().slice(0, 200);
    const templates = await activeBiometricTemplates(db);
    const startedAt = Date.now();
    const decision = await findFingerprintDecision(fingerprintSample, templates);
    const responseTimeMs = Date.now() - startedAt;
    if (!decision.accepted || !decision.best?.employeeId) {
      await db.collection('biometric_evaluation_trials').insertOne({
        id: crypto.randomUUID(), mode: 'automatic-identification', expectedType: 'automatic',
        expectedEmployeeId: null, expectedEmployeeName: null, actualEmployeeId: null, actualEmployeeName: null,
        accepted: false, classification: null, score: decision.best?.score ?? null, threshold: decision.threshold,
        deviceUid: deviceUid || null, responseTimeMs, createdAt: new Date(), createdBy: req.auth.actor.email,
      });
      res.locals.auditMetadata = { fingerprintRecognized: false };
      res.locals.auditOutcome = 'failure';
      return res.json({ recognized: false, employeeId: null, employeeName: null, matchStrength: fingerprintMatchStrength(decision.best?.score, decision.threshold) });
    }
    const employee = await db.collection('employees').findOne(
      { id: decision.best.employeeId, archived: { $ne: true }, status: { $ne: 'inactive' } },
      { projection: { _id: 0, id: 1, name: 1 } },
    );
    if (!employee) return res.status(404).json({ error: 'The matching employee account is not active.' });
    await db.collection('biometric_evaluation_trials').insertOne({
      id: crypto.randomUUID(), mode: 'automatic-identification', expectedType: 'automatic',
      expectedEmployeeId: null, expectedEmployeeName: null, actualEmployeeId: employee.id, actualEmployeeName: employee.name,
      accepted: true, classification: null, score: decision.best.score, threshold: decision.threshold,
      deviceUid: deviceUid || null, responseTimeMs, createdAt: new Date(), createdBy: req.auth.actor.email,
    });
    res.locals.auditMetadata = { fingerprintRecognized: true, targetName: employee.name, employeeId: employee.id };
    res.json({
      recognized: true, employeeId: employee.id, employeeName: employee.name,
      matchStrength: fingerprintMatchStrength(decision.best.score, decision.threshold),
    });
  } catch (error) {
    if (error instanceof BiometricError) return res.status(error.status).json({ error: error.message });
    console.error('Fingerprint identification failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'The fingerprint could not be identified. Please try again.' });
  }
});

router.post('/employees/email-verification', rateLimit({ windowMs: 10 * 60_000, max: 5, keyPrefix: 'employee-email-verification' }), async (req, res) => {
  try {
    const db = mongoose.connection.db;
    if (!(await getSystemControls(db)).registrationOpen) return res.status(403).json({ error: 'New employee registration is currently restricted in Admin Controls' });
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid employee email address.' });
    if (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) return res.status(503).json({ error: 'Employee email delivery is not configured.' });
    const existing = await Promise.all(['employees', 'employee_accounts', 'admin_accounts'].map((name) => db.collection(name).findOne({ email }, { projection: { _id: 1 }, collation: { locale: 'en', strength: 2 } })));
    if (existing.some(Boolean)) return res.status(409).json({ error: 'This email address is already used by another WORKPULSE MVL account.' });
    const verificationId = crypto.randomUUID();
    const code = String(crypto.randomInt(100000, 1_000_000));
    const records = db.collection('employee_email_verifications');
    await records.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await records.insertOne({ verificationId, email, requestedBy: req.auth.actor.email, codeHash: await hashSecret(code), attempts: 0, expiresAt: new Date(Date.now() + 10 * 60_000) });
    try {
      const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_APP_PASSWORD } });
      const delivery = await transport.sendMail({
        from: `WORKPULSE MVL <${process.env.SMTP_USER}>`, to: email,
        subject: 'Verify your email for WORKPULSE MVL employee registration',
        text: `Your employee registration code is ${code}. It expires in 10 minutes. Give this code to the administrator assisting with your registration. Your account will only be created after this code is entered. If you did not request an employee account, ignore this email.`,
      });
      if (!(delivery.accepted ?? []).some((address) => String(address).toLowerCase() === email)) throw new Error('Recipient not accepted');
    } catch (error) {
      await records.deleteOne({ verificationId });
      throw error;
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV] Employee registration verification code for ${email}: ${code}`);
    }
    res.json({ verificationId, message: 'Ask the employee for the code in their email. No account has been created yet.' });
  } catch (error) {
    console.error('Employee verification email failed:', error instanceof Error ? error.message : error);
    res.status(502).json({ error: 'Unable to send the verification email. Check the address and try again. No account was created.' });
  }
});

router.post('/employees', async (req, res) => {
  try {
    if (!(await getSystemControls(mongoose.connection.db)).registrationOpen) return res.status(403).json({ error: 'New employee registration is currently restricted in Admin Controls' });
    const employee = normalizedEmployee(req.body);
    if (!employee.firstName || !employee.lastName) return res.status(400).json({ error: 'First name and last name are required' });
    if (!employee.email || !employee.phone || !employee.address) return res.status(400).json({ error: 'Email, phone number, and address are required' });
    if (!/^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(employee.email)) return res.status(400).json({ error: 'Enter a valid employee email address.' });
    if (!/^\+639\d{9}$/.test(employee.phone)) return res.status(400).json({ error: 'Phone number must use +639XXXXXXXXX with no spaces' });
    if (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) return res.status(503).json({ error: 'Employee email delivery is not configured. Ask the system owner to configure SMTP before creating an account.' });
    const db = mongoose.connection.db;
    const verificationId = String(req.body?.emailVerificationId ?? '');
    const code = String(req.body?.emailVerificationCode ?? '').trim();
    if (!verificationId || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the six-digit registration code received by the employee before creating the account.' });
    const verification = await db.collection('employee_email_verifications').findOneAndUpdate(
      { verificationId, email: employee.email, requestedBy: req.auth.actor.email, expiresAt: { $gt: new Date() }, attempts: { $lt: 5 } },
      { $inc: { attempts: 1 } }, { returnDocument: 'after' },
    );
    if (!verification || !(await verifySecret(code, verification.codeHash))) return res.status(400).json({ error: 'The registration code is incorrect, expired, or has reached its attempt limit. Check the code or request a new one.' });
    const [adminEmail, employeeAccountEmail, employeeRecordEmail] = await Promise.all([
      db.collection('admin_accounts').findOne({ email: employee.email }, { projection: { _id: 1 }, collation: { locale: 'en', strength: 2 } }),
      db.collection('employee_accounts').findOne({ email: employee.email }, { projection: { _id: 1 }, collation: { locale: 'en', strength: 2 } }),
      db.collection('employees').findOne({ email: employee.email }, { projection: { _id: 1 }, collation: { locale: 'en', strength: 2 } }),
    ]);
    if (adminEmail || employeeAccountEmail || employeeRecordEmail) return res.status(409).json({ error: 'This email address is already used by another WORKPULSE MVL account.' });
    const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_APP_PASSWORD } });
    try { await transport.verify(); }
    catch (emailError) {
      console.error('Employee email service verification failed:', emailError instanceof Error ? emailError.message : emailError);
      return res.status(503).json({ error: 'The employee email service is unavailable. No account was created. Check the Gmail App Password and restart the backend.' });
    }
    const fingerprintSamples = normalizeFingerprintSamples(req.body?.fingerprintSamples, 3);
    const deviceUid = String(req.body?.fingerprintDeviceUid ?? '').trim().slice(0, 200);
    const enrollment = await validateEnrollmentSamples(fingerprintSamples);
    employee.id = await nextEmployeeId(db);
    await rejectDuplicateEnrollment(db, enrollment.templates);
    const createdAt = new Date();
    const generatedPassword = generateTemporaryPassword();
    const passwordHash = await hashSecret(generatedPassword);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const consumed = await db.collection('employee_email_verifications').deleteOne({ _id: verification._id, expiresAt: { $gt: new Date() } }, { session });
        if (consumed.deletedCount !== 1) throw new Error('Email verification expired or was already used. Request a new code.');
        await db.collection('employees').insertOne({ ...employee, biometricStatus: 'enrolled', createdAt, updatedAt: createdAt }, { session });
        await db.collection('employee_accounts').insertOne({
          employeeId: employee.id, email: employee.email, passwordHash,
          role: employee.role, active: true, mustChangePassword: true, emailVerifiedAt: createdAt, createdAt, updatedAt: createdAt,
        }, { session });
        await db.collection('biometric_templates').insertOne({
          employeeId: employee.id,
          protectedSamples: encryptFingerprintSamples(enrollment.templates),
          sampleFormat: 'ansi-378-fmd', sampleCount: enrollment.templates.length,
          matcher: 'HID FingerJet', matcherFormat: enrollment.format, matchThreshold: enrollment.threshold, deviceUid: deviceUid || null,
          enrolledAt: createdAt, enrolledBy: req.auth.actor.email, version: 2,
        }, { session });
      });
    } finally { await session.endSession(); }
    try {
      const loginUrl = String(process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
      const delivery = await transport.sendMail({
          from: `WORKPULSE MVL <${process.env.SMTP_USER}>`,
          to: employee.email,
          subject: 'Your WORKPULSE MVL employee login details',
          text: [
            `Hello ${employee.firstName},`,
            '',
            'Your WORKPULSE MVL employee account is ready.',
            `Employee ID: ${employee.id}`,
            `Login page: ${loginUrl}`,
            `Email: ${employee.email}`,
            `Generated password: ${generatedPassword}`,
            '',
            'After entering these details, complete the verification code sent to this email address.',
            'You will be required to create a new password before opening your workspace.',
            'Keep this message private and do not share your password.',
          ].join('\n'),
      });
      const accepted = (delivery.accepted ?? []).map((address) => String(address).toLowerCase());
      if (!accepted.includes(employee.email)) throw new Error('The recipient address was not accepted by the mail service');
    } catch (emailError) {
      console.error('Employee login details email failed:', emailError instanceof Error ? emailError.message : emailError);
      const cleanupSession = await mongoose.startSession();
      try {
        await cleanupSession.withTransaction(async () => {
          await db.collection('employees').deleteOne({ id: employee.id, createdAt }, { session: cleanupSession });
          await db.collection('employee_accounts').deleteOne({ employeeId: employee.id, createdAt }, { session: cleanupSession });
          await db.collection('biometric_templates').deleteOne({ employeeId: employee.id, enrolledAt: createdAt }, { session: cleanupSession });
        });
      } finally {
        await cleanupSession.endSession();
      }
      return res.status(502).json({ error: 'The login email could not be sent, so the employee account was removed. Request a new verification code before trying again.' });
    }
    res.locals.auditMetadata = { targetName: employee.name, employeeId: employee.id, employeeAction: 'created' };
    res.status(201).json({ ...employee, biometricStatus: 'enrolled', createdAt, loginEmailSent: true });
  } catch (error) {
    if (error instanceof BiometricError) return res.status(error.status).json({ error: error.message });
    if (error?.code === 11000) return res.status(409).json({ error: duplicateEmployeeMessage(error) });
    console.error('Employee creation failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

router.put('/employees/:id', async (req, res) => {
  try {
    const verification = await verifyAdminPassword(req, req.body?.adminPassword);
    if (!verification.valid) {
      if (verification.retryAfterSeconds) res.setHeader('Retry-After', String(verification.retryAfterSeconds));
      const status = verification.forbidden ? 403 : verification.retryAfterSeconds ? 429 : 401;
      const error = verification.forbidden ? 'Administrator access required' : verification.retryAfterSeconds ? `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.` : 'Incorrect admin password';
      return res.status(status).json({ error, ...(verification.retryAfterSeconds ? { retryAfterSeconds: verification.retryAfterSeconds } : {}) });
    }
    const employee = normalizedEmployee(req.body);
    employee.id = req.params.id;
    if (!employee.firstName || !employee.lastName) return res.status(400).json({ error: 'First name and last name are required' });
    if (employee.phone && !/^\+639\d{9}$/.test(employee.phone)) return res.status(400).json({ error: 'Phone number must use +639XXXXXXXXX with no spaces' });
    const existing = await mongoose.connection.db.collection('employees').findOne({ id: req.params.id });
    if (!existing) return res.status(404).json({ error: 'Employee not found' });
    res.locals.auditMetadata = { targetName: employee.name || existing.name, employeeId: req.params.id, employeeAction: 'edited' };
    employee.biometricStatus = existing.biometricStatus ?? 'none';
    const db = mongoose.connection.db;
    const [adminEmail, employeeAccountEmail, employeeRecordEmail] = await Promise.all([
      db.collection('admin_accounts').findOne({ email: employee.email }, { projection: { _id: 1 }, collation: { locale: 'en', strength: 2 } }),
      db.collection('employee_accounts').findOne({ email: employee.email, employeeId: { $ne: employee.id } }, { projection: { _id: 1 }, collation: { locale: 'en', strength: 2 } }),
      db.collection('employees').findOne({ email: employee.email, id: { $ne: employee.id } }, { projection: { _id: 1 }, collation: { locale: 'en', strength: 2 } }),
    ]);
    if (adminEmail || employeeAccountEmail || employeeRecordEmail) return res.status(409).json({ error: 'This email address is already used by another WORKPULSE MVL account.' });
    const result = await db.collection('employees').updateOne({ id: req.params.id }, { $set: { ...employee, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ error: 'Employee not found' });
    await db.collection('employee_accounts').updateOne({ employeeId: employee.id }, { $set: { email: employee.email, role: employee.role, updatedAt: new Date() } });
    res.json({ ...employee, createdAt: existing.createdAt });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'This email address is already used by another WORKPULSE MVL account.' });
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

router.put('/employees/:id/fingerprint', async (req, res) => {
  try {
    const verification = await verifyAdminPassword(req, req.body?.adminPassword);
    if (!verification.valid) {
      if (verification.retryAfterSeconds) res.setHeader('Retry-After', String(verification.retryAfterSeconds));
      const status = verification.forbidden ? 403 : verification.retryAfterSeconds ? 429 : 401;
      return res.status(status).json({ error: verification.forbidden ? 'Administrator access required' : 'Incorrect admin password', ...(verification.retryAfterSeconds ? { retryAfterSeconds: verification.retryAfterSeconds } : {}) });
    }
    const db = mongoose.connection.db;
    const employee = await db.collection('employees').findOne({ id: req.params.id, archived: { $ne: true } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    const fingerprintSamples = normalizeFingerprintSamples(req.body?.fingerprintSamples, 3);
    const deviceUid = String(req.body?.fingerprintDeviceUid ?? '').trim().slice(0, 200);
    const enrollment = await validateEnrollmentSamples(fingerprintSamples);
    await rejectDuplicateEnrollment(db, enrollment.templates);
    const now = new Date();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await db.collection('biometric_templates').updateOne({ employeeId: employee.id }, { $set: {
          protectedSamples: encryptFingerprintSamples(enrollment.templates),
          sampleFormat: 'ansi-378-fmd', sampleCount: enrollment.templates.length,
          matcher: 'HID FingerJet', matcherFormat: enrollment.format, matchThreshold: enrollment.threshold, deviceUid: deviceUid || null,
          enrolledAt: now, enrolledBy: req.auth.actor.email, version: 2,
        } }, { upsert: true, session });
        await db.collection('employees').updateOne({ id: employee.id }, { $set: { biometricStatus: 'enrolled', updatedAt: now } }, { session });
      });
    } finally { await session.endSession(); }
    res.json({ employeeId: employee.id, biometricStatus: 'enrolled', enrolledAt: now });
  } catch (error) {
    if (error instanceof BiometricError) return res.status(error.status).json({ error: error.message });
    console.error('Fingerprint registration failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to register fingerprint' });
  }
});

router.post('/employees/:id/send-login-email', async (req, res) => {
  try {
    const verification = await verifyAdminPassword(req, req.body?.adminPassword);
    if (!verification.valid) {
      if (verification.retryAfterSeconds) res.setHeader('Retry-After', String(verification.retryAfterSeconds));
      return res.status(verification.forbidden ? 403 : verification.retryAfterSeconds ? 429 : 401).json({ error: verification.forbidden ? 'Administrator access required' : verification.retryAfterSeconds ? `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.` : 'Incorrect admin password', ...(verification.retryAfterSeconds ? { retryAfterSeconds: verification.retryAfterSeconds } : {}) });
    }
    if (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) return res.status(503).json({ error: 'Employee email delivery is not configured.' });
    const db = mongoose.connection.db;
    const employee = await db.collection('employees').findOne({ id: req.params.id, archived: { $ne: true } });
    const account = await db.collection('employee_accounts').findOne({ employeeId: req.params.id, active: true });
    if (!employee || !account) return res.status(404).json({ error: 'Active employee login account not found.' });
    const generatedPassword = generateTemporaryPassword();
    const passwordHash = await hashSecret(generatedPassword);
    const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_APP_PASSWORD } });
    try {
      await transport.verify();
      const loginUrl = String(process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
      const delivery = await transport.sendMail({
        from: `WORKPULSE MVL <${process.env.SMTP_USER}>`, to: employee.email,
        subject: 'Your new WORKPULSE MVL login details',
        text: [`Hello ${employee.firstName || employee.name},`, '', 'A new WORKPULSE MVL password was requested for your employee account.', `Employee ID: ${employee.id}`, `Login page: ${loginUrl}`, `Email: ${employee.email}`, `New generated password: ${generatedPassword}`, '', 'Complete the verification code sent to this email after signing in.', 'You will be required to create a new password before opening your workspace.', 'Keep this message private.'].join('\n'),
      });
      const accepted = (delivery.accepted ?? []).map((address) => String(address).toLowerCase());
      if (!accepted.includes(employee.email)) throw new Error('The recipient address was not accepted by the mail service');
    } catch (emailError) {
      console.error('Replacement employee login email failed:', emailError instanceof Error ? emailError.message : emailError);
      return res.status(502).json({ error: 'The new login email could not be delivered. The existing password was not changed.' });
    }
    await db.collection('employee_accounts').updateOne({ _id: account._id }, { $set: { passwordHash, email: employee.email, mustChangePassword: true, updatedAt: new Date() }, $unset: { passwordChangedAt: '' } });
    res.json({ message: `New login details were sent to ${employee.email}.` });
  } catch (error) {
    console.error('Employee login email reset failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Unable to send new employee login details.' });
  }
});

async function authenticatedAdmin(req, passwordRequired = false) {
  const admin = req.auth?.actor;
  if (!admin || admin.role !== 'admin') return null;
  if (passwordRequired && !(await verifySecret(req.body?.password ?? '', admin.passwordHash))) return null;
  return admin;
}

router.post('/employees/:id/archive', async (req, res) => {
  try {
    if (!(await authenticatedAdmin(req, true))) return res.status(401).json({ error: 'Incorrect password or expired session' });
    const db = mongoose.connection.db;
    const result = await db.collection('employees').findOneAndUpdate({ id: req.params.id, archived: { $ne: true } }, { $set: { archived: true, status: 'inactive', archivedAt: new Date(), updatedAt: new Date() } }, { returnDocument: 'after' });
    if (!result) return res.status(404).json({ error: 'Employee not found or already archived' });
    res.locals.auditMetadata = { targetName: result.name, employeeId: result.id, employeeAction: 'archived' };
    const accounts = await db.collection('employee_accounts').find({ employeeId: req.params.id }, { projection: { _id: 1 } }).toArray();
    await db.collection('employee_accounts').updateMany({ employeeId: req.params.id }, { $set: { active: false, updatedAt: new Date() } });
    if (accounts.length) {
      const accountIds = accounts.map((account) => account._id);
      await Promise.all([
        db.collection('admin_sessions').deleteMany({ accountType: 'employee', accountId: { $in: accountIds } }),
        db.collection('login_otps').deleteMany({ accountId: { $in: accountIds } }),
      ]);
    }
    res.json({ id: result.id, status: result.status, archived: true });
  } catch { res.status(500).json({ error: 'Failed to archive employee' }); }
});

router.get('/archived-employees', async (req, res) => {
  try {
    if (!(await authenticatedAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await mongoose.connection.db.collection('employees').find({ archived: true }).sort({ archivedAt: -1 }).toArray());
  } catch { res.status(500).json({ error: 'Failed to fetch archived employees' }); }
});

router.post('/employees/:id/unarchive', async (req, res) => {
  try {
    if (!(await authenticatedAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const db = mongoose.connection.db;
    const hasFingerprint = Boolean(await db.collection('biometric_templates').findOne({ employeeId: req.params.id }, { projection: { _id: 1 } }));
    const result = await db.collection('employees').findOneAndUpdate({ id: req.params.id, archived: true }, { $set: { archived: false, status: 'active', biometricStatus: hasFingerprint ? 'enrolled' : 'none', unarchivedAt: new Date(), updatedAt: new Date() }, $unset: { archivedAt: '' } }, { returnDocument: 'after' });
    if (!result) return res.status(404).json({ error: 'Archived employee not found' });
    res.locals.auditMetadata = { targetName: result.name, employeeId: result.id, employeeAction: 'unarchived' };
    await db.collection('employee_accounts').updateOne({ employeeId: req.params.id }, { $set: { active: true, updatedAt: new Date() } });
    res.json(result);
  } catch { res.status(500).json({ error: 'Failed to restore employee' }); }
});

router.delete('/employees/:id/permanent', async (req, res) => {
  try {
    if (!(await authenticatedAdmin(req, true))) return res.status(401).json({ error: 'Incorrect password or expired session' });
    const db = mongoose.connection.db;
    const employee = await db.collection('employees').findOne({ id: req.params.id, archived: true });
    if (!employee) return res.status(404).json({ error: 'Archived employee not found. Only archived employees can be permanently deleted.' });
    const accounts = await db.collection('employee_accounts').find({ employeeId: employee.id }, { projection: { _id: 1 } }).toArray();
    const accountIds = accounts.map((account) => account._id);
    const session = await mongoose.startSession();
    const deleted = {};
    try {
      await session.withTransaction(async () => {
        deleted.attendance = (await db.collection('attendance').deleteMany({ employeeId: employee.id }, { session })).deletedCount;
        deleted.leaveRequests = (await db.collection('leave_requests').deleteMany({ employeeId: employee.id }, { session })).deletedCount;
        deleted.payrollRequests = (await db.collection('payroll_requests').deleteMany({ employeeId: employee.id }, { session })).deletedCount;
        deleted.biometricTemplates = (await db.collection('biometric_templates').deleteMany({ employeeId: employee.id }, { session })).deletedCount;
        deleted.verificationAttempts = (await db.collection('biometric_verification_attempts').deleteMany({ employeeId: employee.id }, { session })).deletedCount;
        deleted.evaluationTrials = (await db.collection('biometric_evaluation_trials').deleteMany({ $or: [{ expectedEmployeeId: employee.id }, { actualEmployeeId: employee.id }] }, { session })).deletedCount;
        deleted.loginOtps = accountIds.length ? (await db.collection('login_otps').deleteMany({ accountId: { $in: accountIds } }, { session })).deletedCount : 0;
        deleted.sessions = accountIds.length ? (await db.collection('admin_sessions').deleteMany({ accountType: 'employee', accountId: { $in: accountIds } }, { session })).deletedCount : 0;
        deleted.auditEvents = (await db.collection('audit_events').deleteMany({ $or: [{ targetId: employee.id }, ...(accountIds.length ? [{ actorId: { $in: accountIds } }] : [])] }, { session })).deletedCount;
        deleted.employeeAccounts = (await db.collection('employee_accounts').deleteMany({ employeeId: employee.id }, { session })).deletedCount;
        deleted.employee = (await db.collection('employees').deleteOne({ _id: employee._id, archived: true }, { session })).deletedCount;
        if (deleted.employee !== 1) throw new Error('Archived employee changed while deletion was in progress');
      });
    } finally {
      await session.endSession();
    }
    res.json({ id: employee.id, name: employee.name, deleted });
  } catch (error) {
    console.error('Permanent employee deletion failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'The archived employee and linked records could not be deleted.' });
  }
});

router.get('/payroll-requests', async (req, res) => {
  try {
    const db = mongoose.connection?.db;
    if (!db) return res.status(500).json({ error: 'MongoDB connection not ready' });

    const employeeIds = await visibleEmployeeIds(db);
    const payrollRequests = await db.collection('payroll_requests').find({ employeeId: { $in: employeeIds } }).sort({ createdAt: -1, _id: -1 }).limit(2_000).toArray();

    res.json(
      payrollRequests.map((p) => ({
        id: p.id,
        employeeId: p.employeeId,
        employeeName: p.employeeName,
        amount: p.amount,
        status: p.status,
        currentAmount: p.currentAmount,
        carryOverAmount: p.carryOverAmount,
        periodStart: payrollPeriodKeyForRecord(p),
        grossAmount: p.grossAmount,
        additions: p.additions,
        bonusAmount: Number(p.bonusAmount || 0),
        hoursWorked: p.hoursWorked,
        hourlyRate: p.hourlyRate,
        createdAt: p.createdAt,
        paidAt: p.paidAt,
        rejectedAt: p.rejectedAt,
        warnings: Array.isArray(p.warnings) ? p.warnings : [],
      }))
    );
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payroll requests' });
  }
});

function payrollPeriodKey(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const startDay = Number(parts.day) <= 15 ? '01' : '16';
  return `${parts.year}-${parts.month}-${startDay}`;
}

function payrollPeriodKeyForRecord(record) {
  const stored = String(record?.periodStart ?? '');
  if (/^\d{4}-\d{2}-(01|16)$/.test(stored)) return stored;
  const createdAt = record?.createdAt ? new Date(record.createdAt) : null;
  if (createdAt && !Number.isNaN(createdAt.getTime())) return payrollPeriodKey(createdAt);
  return stored;
}

function currentPayrollPeriodStart() {
  return new Date(`${payrollPeriodKey()}T00:00:00+08:00`);
}

function payrollPeriodEnd(periodStart) {
  const [year, month, day] = String(periodStart).split('-').map(Number);
  if (!year || !month || ![1, 16].includes(day)) return null;
  return day === 1
    ? `${year}-${String(month).padStart(2, '0')}-15`
    : `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
}

function payrollAdditions(employee) {
  return (Array.isArray(employee.identifiers) ? employee.identifiers : [])
    .map((item) => ({ label: String(item?.type ?? '').trim().slice(0, 80), value: Math.max(0, Number(item?.amount || 0)) }))
    .filter((item) => item.label && item.value > 0)
    .slice(0, 20);
}

// A payroll row is a single statement for an employee's 15-day period.  The
// portal and the admin screen can both prepare it at about the same time, so
// clean up any older, unpaid race duplicates before calculating it again.
async function reconcileDuplicateUnpaidPayrollRecords(db, employeeId, periodStart) {
  const records = await db.collection('payroll_requests').find({ employeeId, periodStart }).toArray();
  const unpaid = records.filter((record) => ['processing', 'rejected'].includes(record.status));
  if (records.length < 2 || unpaid.length !== records.length) return records[0] ?? null;

  const [primary, ...duplicates] = unpaid.sort((left, right) => (
    Number(right.carryOverAmount || 0) - Number(left.carryOverAmount || 0)
    || Number(right.currentAmount || 0) - Number(left.currentAmount || 0)
    || new Date(left.createdAt || 0) - new Date(right.createdAt || 0)
  ));
  const carriedBalance = Math.max(...unpaid.map((record) => Number(record.carryOverAmount || 0)));
  if (carriedBalance !== Number(primary.carryOverAmount || 0)) {
    await db.collection('payroll_requests').updateOne(
      { _id: primary._id },
      { $set: { carryOverAmount: carriedBalance, amount: Number(primary.currentAmount || 0) + carriedBalance, updatedAt: new Date() } },
    );
  }
  if (duplicates.length) {
    await db.collection('payroll_requests').updateMany(
      { rolledInto: { $in: duplicates.map((record) => record.id) } },
      { $set: { rolledInto: primary.id, rolledAt: new Date() } },
    );
    await db.collection('payroll_requests').deleteMany({ _id: { $in: duplicates.map((record) => record._id) } });
  }
  return { ...primary, carryOverAmount: carriedBalance, amount: Number(primary.currentAmount || 0) + carriedBalance };
}

async function carryPayrollCorrectionForward(db, payrollId, difference) {
  if (!difference) return;
  const nextPayroll = await db.collection('payroll_requests').findOne({ id: payrollId });
  if (!nextPayroll || ['paid', 'approved'].includes(nextPayroll.status)) return;
  await db.collection('payroll_requests').updateOne(
    { _id: nextPayroll._id },
    { $inc: { carryOverAmount: difference, amount: difference }, $set: { updatedAt: new Date() } },
  );
  if (nextPayroll.rolledInto) await carryPayrollCorrectionForward(db, nextPayroll.rolledInto, difference);
}

export async function preparePayrollRecord(db, employee, periodStart, settings) {
  const existing = await reconcileDuplicateUnpaidPayrollRecords(db, employee.id, periodStart)
    ?? await db.collection('payroll_requests').findOne({ employeeId: employee.id, periodStart });
  if (existing) {
    if (!['processing', 'rejected', 'carried_over'].includes(existing.status)) {
      return { record: { ...existing, periodStart: payrollPeriodKeyForRecord(existing) }, created: false };
    }
    const periodEnd = payrollPeriodEnd(periodStart);
    if (!periodEnd) throw new Error('Invalid payroll period');
    const attendance = await db.collection('attendance').find({ employeeId: employee.id, date: { $gte: periodStart, $lte: periodEnd }, ...(existing.calculationResetAt ? { updatedAt: { $gt: existing.calculationResetAt } } : {}) }).toArray();
    const incompleteAttendance = attendance.some((record) => attendanceSessions(record).some((session) => !session.checkOut));
    const hoursWorked = Math.round(attendance.reduce((total, record) => total + attendanceHoursForRecord(record, settings, existing.calculationResetAt), 0) * 100) / 100;
    const hourlyRate = configuredHourlyRate(employee, settings);
    const grossAmount = Math.round(hoursWorked * hourlyRate * 100) / 100;
    const bonusAmount = Math.max(0, Number(existing.bonusAmount || 0));
    const additions = [...payrollAdditions(employee), ...(bonusAmount > 0 ? [{ label: 'Bonus', value: bonusAmount }] : [])];
    const currentAmount = grossAmount + additions.reduce((sum, item) => sum + item.value, 0);
    const newlyOutstanding = existing.calculationResetAt ? [] : await db.collection('payroll_requests').find({
      employeeId: employee.id,
      status: { $in: ['processing', 'rejected'] },
      rolledInto: { $exists: false },
      periodStart: { $lt: periodStart },
    }).toArray();
    const addedCarry = newlyOutstanding.reduce((sum, payroll) => sum + Number(payroll.amount || 0), 0);
    const carryOverAmount = Number(existing.carryOverAmount || 0) + addedCarry;
    const amount = currentAmount + carryOverAmount;
    const warnings = [
      ...(hoursWorked <= 0 ? ['No completed attendance hours'] : []),
      ...(incompleteAttendance ? ['Incomplete attendance session'] : []),
    ];
    const previousAmount = Number(existing.amount || 0);
    const updated = await db.collection('payroll_requests').findOneAndUpdate(
      { _id: existing._id },
      { $set: { grossAmount, additions, bonusAmount, hoursWorked, hourlyRate, currentAmount, carryOverAmount, amount, warnings, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    await db.collection('payroll_requests').updateMany(
      { _id: { $in: newlyOutstanding.map((item) => item._id) } },
      { $set: { status: 'carried_over', rolledInto: existing.id, rolledAt: new Date() } },
    );
    if (existing.status === 'carried_over') {
      await carryPayrollCorrectionForward(db, existing.rolledInto, amount - previousAmount);
    }
    return { record: { ...updated, periodStart: payrollPeriodKeyForRecord(updated) }, created: false };
  }
  const periodEnd = payrollPeriodEnd(periodStart);
  if (!periodEnd) throw new Error('Invalid payroll period');
  const attendance = await db.collection('attendance').find({ employeeId: employee.id, date: { $gte: periodStart, $lte: periodEnd } }).toArray();
  const incompleteAttendance = attendance.some((record) => attendanceSessions(record).some((session) => !session.checkOut));
  const hoursWorked = Math.round(attendance.reduce((total, record) => total + attendanceHoursForRecord(record, settings), 0) * 100) / 100;
  const hourlyRate = configuredHourlyRate(employee, settings);
  const grossAmount = Math.round(hoursWorked * hourlyRate * 100) / 100;
  const additions = payrollAdditions(employee);
  const currentAmount = grossAmount + additions.reduce((sum, item) => sum + item.value, 0);
  const outstanding = await db.collection('payroll_requests').find({
    employeeId: employee.id, status: { $in: ['processing', 'rejected'] }, rolledInto: { $exists: false },
    $or: [{ periodStart: { $lt: periodStart } }, { periodStart: { $exists: false } }],
  }).toArray();
  const carryOverAmount = outstanding.reduce((sum, payroll) => sum + Number(payroll.amount || 0), 0);
  const warnings = [
    ...(hoursWorked <= 0 ? ['No completed attendance hours'] : []),
    ...(incompleteAttendance ? ['Incomplete attendance session'] : []),
  ];
  const id = `PR-${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${employee.id}`;
  const record = { id, employeeId: employee.id, employeeName: employee.name, employeeEmail: employee.email, grossAmount, additions, hoursWorked, hourlyRate, currentAmount, carryOverAmount, amount: currentAmount + carryOverAmount, periodStart, periodDays: 15, status: 'processing', warnings, createdAt: new Date() };
  try {
    await db.collection('payroll_requests').insertOne(record);
  } catch (error) {
    const periodConflict = error?.code === 11000 && (
      (error.keyPattern?.employeeId === 1 && error.keyPattern?.periodStart === 1)
      || String(error.message).includes('index: one_unpaid_payroll_per_period ')
    );
    if (!periodConflict) throw error;
    // Another preparation won the insert race. Only that request should link
    // outstanding balances; the losing request must not apply them again.
    const concurrent = await db.collection('payroll_requests').findOne({ employeeId: employee.id, periodStart });
    if (!concurrent) throw error;
    return { record: { ...concurrent, periodStart: payrollPeriodKeyForRecord(concurrent) }, created: false };
  }
  if (outstanding.length) await db.collection('payroll_requests').updateMany(
    { _id: { $in: outstanding.map((item) => item._id) } },
    { $set: { status: 'carried_over', rolledInto: id, rolledAt: new Date() } },
  );
  return { record, created: true };
}

async function mapWithConcurrency(items, limit, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await operation(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

router.post('/payroll-requests/prepare-bulk', async (req, res) => {
  try {
    // The payroll screen calls this automatically to synchronize calculated
    // values. It is a background refresh, not a deliberate administrator
    // action, so do not attribute it to the signed-in administrator.
    res.locals.skipAudit = true;
    const periodStart = String(req.body?.periodStart ?? '');
    if (periodStart !== payrollPeriodKey()) return res.status(400).json({ error: 'Only the current payroll period can be prepared' });
    const db = mongoose.connection.db;
    const requestedIds = Array.isArray(req.body?.employeeIds) ? req.body.employeeIds.map(String).slice(0, 500) : [];
    const query = { archived: { $ne: true }, status: { $ne: 'inactive' }, ...(requestedIds.length ? { id: { $in: requestedIds } } : {}) };
    const [employees, settings] = await Promise.all([db.collection('employees').find(query).toArray(), getSettings(db)]);
    // Payroll calculations are independent per employee. A small worker pool
    // avoids the old one-request-at-a-time delay without overwhelming Atlas.
    const results = await mapWithConcurrency(employees, 8, (employee) => preparePayrollRecord(db, employee, periodStart, settings));
    const records = results.map((item) => item.record);
    res.json({
      records,
      prepared: results.filter((item) => item.created).length,
      alreadyPrepared: results.filter((item) => !item.created).length,
      carriedEmployees: records.filter((item) => Number(item.carryOverAmount || 0) > 0).length,
      carriedTotal: records.reduce((sum, item) => sum + Number(item.carryOverAmount || 0), 0),
    });
  } catch (error) {
    console.error('Bulk payroll preparation failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to prepare payroll' });
  }
});

router.post('/payroll/audit-print', async (req, res) => {
  const printScope = req.body?.printScope === 'individual-payslip' ? 'individual-payslip' : 'paid-list';
  res.locals.auditMetadata = {
    payrollAction: 'printed', printScope,
    targetName: String(req.body?.employeeName || '').trim().slice(0, 120) || null,
    periodStart: String(req.body?.periodStart || '').slice(0, 10) || null,
    recordCount: Math.max(0, Math.min(1000, Number(req.body?.recordCount || 0))),
  };
  res.status(204).end();
});

router.patch('/payroll-requests/bonus', async (req, res) => {
  try {
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const periodStart = String(req.body?.periodStart ?? '');
    const scope = req.body?.scope === 'all' ? 'all' : 'individual';
    const requestId = String(req.body?.requestId ?? '');
    if (!(amount > 0) || amount > 1_000_000) return res.status(400).json({ error: 'Enter a bonus between 0.01 and 1,000,000.' });
    if (!/^\d{4}-\d{2}-(01|16)$/.test(periodStart)) return res.status(400).json({ error: 'Select a valid payroll period.' });
    if (scope === 'individual' && !requestId) return res.status(400).json({ error: 'Choose an employee.' });
    const db = mongoose.connection.db;
    const query = { periodStart, status: { $in: ['processing', 'rejected'] }, ...(scope === 'individual' ? { id: requestId } : {}) };
    const records = await db.collection('payroll_requests').find(query).toArray();
    if (!records.length) return res.status(404).json({ error: scope === 'all' ? 'No unpaid payroll records are available for this period.' : 'The selected unpaid payroll record was not found.' });
    const operations = records.map((record) => {
      const bonusAmount = Math.round((Number(record.bonusAmount || 0) + amount) * 100) / 100;
      const additions = [...(Array.isArray(record.additions) ? record.additions.filter((item) => item?.label !== 'Bonus') : []), { label: 'Bonus', value: bonusAmount }];
      return { updateOne: { filter: { _id: record._id, status: { $in: ['processing', 'rejected'] } }, update: { $set: { bonusAmount, additions, currentAmount: Math.round((Number(record.currentAmount || 0) + amount) * 100) / 100, amount: Math.round((Number(record.amount || 0) + amount) * 100) / 100, bonusUpdatedAt: new Date(), bonusUpdatedBy: req.auth.actor.email } } } };
    });
    const result = await db.collection('payroll_requests').bulkWrite(operations);
    res.locals.auditMetadata = { payrollAction: 'bonus-added', scope, amount, recordCount: result.modifiedCount, targetName: scope === 'individual' ? records[0]?.employeeName : null, periodStart };
    res.json({ updated: result.modifiedCount, amount, scope });
  } catch (error) {
    console.error('Payroll bonus update failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Unable to add the payroll bonus.' });
  }
});

router.patch('/payroll-requests/pay-bulk', async (req, res) => {
  try {
    const verification = await verifyAdminPassword(req, req.body?.password);
    if (!verification.valid) {
      if (verification.retryAfterSeconds) res.setHeader('Retry-After', String(verification.retryAfterSeconds));
      return res.status(verification.forbidden ? 403 : verification.retryAfterSeconds ? 429 : 401).json({ error: verification.forbidden ? 'Administrator access required' : verification.retryAfterSeconds ? `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.` : 'Incorrect admin password' });
    }
    const periodStart = String(req.body?.periodStart ?? '');
    if (!/^\d{4}-\d{2}-(01|16)$/.test(periodStart)) return res.status(400).json({ error: 'Select a valid payroll period' });
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 500) : [];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one ready payroll record' });
    const db = mongoose.connection.db;
    const ready = await db.collection('payroll_requests').find({ id: { $in: ids }, periodStart, status: 'processing' }).toArray();
    if (!ready.length) return res.status(409).json({ error: 'No selected payroll records are ready to pay' });
    const paidAt = new Date();
    const paymentActionId = `PAY-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await db.collection('payroll_requests').updateMany({ _id: { $in: ready.map((item) => item._id) } }, { $set: { status: 'paid', paidAt, approvedBy: req.auth.actor.email, paymentActionId }, $unset: { rejectedAt: '', rejectedBy: '' } });
    for (const record of ready) {
      await db.collection('payroll_requests').updateMany({
        employeeId: record.employeeId, rolledInto: { $exists: true }, status: { $in: ['processing', 'rejected', 'carried_over'] }, periodStart: { $lte: periodStart },
      }, { $set: { status: 'paid', paidAt, settledBy: record.id, approvedBy: req.auth.actor.email, paymentActionId } });
    }
    const total = ready.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    res.locals.auditMetadata = { payrollAction: ready.length === 1 ? 'individual-paid' : 'bulk-paid', recordCount: ready.length, targetName: ready.length === 1 ? ready[0].employeeName : null, total, periodStart };
    res.json({ paid: ready.length, skipped: ids.length - ready.length, total, ids: ready.map((item) => item.id), paidAt });
  } catch (error) {
    console.error('Bulk payroll payment failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to confirm bulk payment' });
  }
});

router.patch('/payroll-requests/undo-last-payment', async (req, res) => {
  try {
    const verification = await verifyAdminPassword(req, req.body?.password);
    if (!verification.valid) {
      if (verification.retryAfterSeconds) res.setHeader('Retry-After', String(verification.retryAfterSeconds));
      return res.status(verification.forbidden ? 403 : verification.retryAfterSeconds ? 429 : 401).json({ error: verification.forbidden ? 'Administrator access required' : verification.retryAfterSeconds ? `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.` : 'Incorrect admin password' });
    }
    const periodStart = String(req.body?.periodStart ?? '');
    if (!/^\d{4}-\d{2}-(01|16)$/.test(periodStart)) return res.status(400).json({ error: 'Select a valid payroll period' });
    const db = mongoose.connection.db;
    const latest = await db.collection('payroll_requests').find({ periodStart, status: 'paid', settledBy: { $exists: false } }).sort({ paidAt: -1, _id: -1 }).limit(1).next();
    if (!latest) return res.status(409).json({ error: 'There is no payment to undo for this period' });
    const paidAt = latest.paidAt instanceof Date ? latest.paidAt : new Date(latest.paidAt);
    const undoDeadline = new Date(paidAt.getTime() + 15 * 24 * 60 * 60_000);
    if (Number.isNaN(paidAt.getTime()) || new Date() >= undoDeadline) {
      return res.status(409).json({ error: 'This payment can no longer be undone because the 15-day undo period has expired.' });
    }
    const directRecords = latest.paymentActionId
      ? await db.collection('payroll_requests').find({ periodStart, status: 'paid', paymentActionId: latest.paymentActionId, settledBy: { $exists: false } }).toArray()
      : [latest];
    const directIds = directRecords.map((item) => item.id);
    const total = directRecords.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    await db.collection('payroll_requests').updateMany(
      { _id: { $in: directRecords.map((item) => item._id) } },
      { $set: { status: 'processing', undoneAt: new Date(), undoneBy: req.auth.actor.email }, $unset: { paidAt: '', approvedBy: '', paymentActionId: '' } },
    );
    await db.collection('payroll_requests').updateMany(
      { settledBy: { $in: directIds }, status: 'paid' },
      { $set: { status: 'carried_over', undoneAt: new Date(), undoneBy: req.auth.actor.email }, $unset: { paidAt: '', approvedBy: '', paymentActionId: '', settledBy: '' } },
    );
    res.locals.auditMetadata = { payrollAction: 'payment-undone', recordCount: directRecords.length, targetName: directRecords.length === 1 ? directRecords[0].employeeName : null, total, periodStart };
    res.json({ undone: directRecords.length, ids: directIds, total });
  } catch (error) {
    console.error('Undo payroll payment failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to undo the last payroll payment' });
  }
});

router.post('/payroll-requests', async (req, res) => {
  try {
    const { employeeId } = req.body ?? {};
    const currentAmount = Math.max(0, Number(req.body?.currentAmount || 0));
    const grossAmount = Math.max(0, Number(req.body?.grossAmount || 0));
    const hoursWorked = Math.max(0, Number(req.body?.hoursWorked || 0));
    const hourlyRate = Math.max(0, Number(req.body?.hourlyRate || 0));
    const additions = Array.isArray(req.body?.additions) ? req.body.additions.slice(0, 20).map((item) => ({
      label: String(item?.label ?? '').trim().slice(0, 80),
      value: Math.max(0, Number(item?.value || 0)),
    })).filter((item) => item.label && item.value > 0) : [];
    if (!employeeId) return res.status(400).json({ error: 'Employee ID is required' });
    const db = mongoose.connection.db;
    const employee = await db.collection('employees').findOne({ id: employeeId, archived: { $ne: true } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    const periodStart = payrollPeriodKey();
    const legacyPeriodStart = currentPayrollPeriodStart().toISOString().slice(0, 10);
    const existing = await db.collection('payroll_requests').findOne({ employeeId, periodStart: { $in: [...new Set([periodStart, legacyPeriodStart])] } });
    if (existing) return res.json({ ...existing, periodStart: payrollPeriodKeyForRecord(existing) });

    const outstanding = await db.collection('payroll_requests').find({
      employeeId,
      status: { $in: ['processing', 'rejected'] },
      rolledInto: { $exists: false },
      $or: [{ periodStart: { $lt: periodStart } }, { periodStart: { $exists: false } }],
    }).toArray();
    const carryOverAmount = outstanding.reduce((sum, payroll) => sum + Number(payroll.amount || 0), 0);
    const id = `PR-${Date.now()}-${employeeId}`;
    const payroll = {
      id, employeeId, employeeName: employee.name, employeeEmail: employee.email,
      grossAmount, additions, hoursWorked, hourlyRate,
      currentAmount, carryOverAmount, amount: currentAmount + carryOverAmount,
      periodStart, periodDays: 15, status: 'processing', createdAt: new Date(),
    };
    await db.collection('payroll_requests').insertOne(payroll);
    if (outstanding.length) await db.collection('payroll_requests').updateMany(
      { _id: { $in: outstanding.map((item) => item._id) } },
      { $set: { status: 'carried_over', rolledInto: id, rolledAt: new Date() } },
    );
    res.status(201).json(payroll);
  } catch { res.status(500).json({ error: 'Failed to process payroll' }); }
});

router.patch('/payroll-requests/:id/confirm-payment', async (req, res) => {
  try {
    const verification = await verifyAdminPassword(req, req.body?.password);
    if (!verification.valid) {
      if (verification.retryAfterSeconds) res.setHeader('Retry-After', String(verification.retryAfterSeconds));
      return res.status(verification.forbidden ? 403 : verification.retryAfterSeconds ? 429 : 401).json({ error: verification.forbidden ? 'Administrator access required' : verification.retryAfterSeconds ? `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.` : 'Incorrect admin password', ...(verification.retryAfterSeconds ? { retryAfterSeconds: verification.retryAfterSeconds } : {}) });
    }
    const db = mongoose.connection.db;
    const paidAt = new Date();
    const paymentActionId = `PAY-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const result = await db.collection('payroll_requests').findOneAndUpdate(
      { id: req.params.id, status: { $in: ['processing', 'rejected'] } },
      { $set: { status: 'paid', paidAt, approvedBy: req.auth.actor.email, paymentActionId }, $unset: { rejectedAt: '', rejectedBy: '' } },
      { returnDocument: 'after' },
    );
    if (!result) return res.status(404).json({ error: 'Unpaid payroll record not found' });
    res.locals.auditMetadata = { payrollAction: 'individual-paid', targetName: result.employeeName, employeeId: result.employeeId, amount: result.amount, periodStart: result.periodStart };
    await db.collection('payroll_requests').updateMany(
      {
        employeeId: result.employeeId,
        rolledInto: { $exists: true },
        status: { $in: ['processing', 'rejected', 'carried_over'] },
        ...(result.periodStart ? { periodStart: { $lte: result.periodStart } } : {}),
      },
      { $set: { status: 'paid', paidAt, settledBy: result.id, approvedBy: req.auth.actor.email, paymentActionId } },
    );
    res.json({ id: result.id, status: result.status, paidAt: result.paidAt });
  } catch { res.status(500).json({ error: 'Failed to confirm payment' }); }
});

router.patch('/payroll-requests/:id/reject-payment', async (req, res) => {
  try {
    const verification = await verifyAdminPassword(req, req.body?.password);
    if (!verification.valid) {
      if (verification.retryAfterSeconds) res.setHeader('Retry-After', String(verification.retryAfterSeconds));
      return res.status(verification.forbidden ? 403 : verification.retryAfterSeconds ? 429 : 401).json({ error: verification.forbidden ? 'Administrator access required' : verification.retryAfterSeconds ? `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.` : 'Incorrect admin password', ...(verification.retryAfterSeconds ? { retryAfterSeconds: verification.retryAfterSeconds } : {}) });
    }
    const result = await mongoose.connection.db.collection('payroll_requests').findOneAndUpdate(
      { id: req.params.id, status: 'processing' },
      { $set: { status: 'rejected', rejectedAt: new Date(), rejectedBy: req.auth.actor.email } },
      { returnDocument: 'after' },
    );
    if (!result) return res.status(404).json({ error: 'Processing payroll record not found' });
    res.locals.auditMetadata = { payrollAction: 'payment-held', targetName: result.employeeName, employeeId: result.employeeId, amount: result.amount, periodStart: result.periodStart };
    res.json({ id: result.id, status: result.status, rejectedAt: result.rejectedAt });
  } catch { res.status(500).json({ error: 'Failed to mark payroll as not paid' }); }
});

router.patch('/payroll-requests/:id/remove-hold', async (req, res) => {
  try {
    const verification = await verifyAdminPassword(req, req.body?.password);
    if (!verification.valid) {
      if (verification.retryAfterSeconds) res.setHeader('Retry-After', String(verification.retryAfterSeconds));
      return res.status(verification.forbidden ? 403 : verification.retryAfterSeconds ? 429 : 401).json({ error: verification.forbidden ? 'Administrator access required' : verification.retryAfterSeconds ? `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.` : 'Incorrect admin password' });
    }
    const result = await mongoose.connection.db.collection('payroll_requests').findOneAndUpdate(
      { id: req.params.id, status: 'rejected' },
      { $set: { status: 'processing', holdRemovedAt: new Date(), holdRemovedBy: req.auth.actor.email }, $unset: { rejectedAt: '', rejectedBy: '' } },
      { returnDocument: 'after' },
    );
    if (!result) return res.status(404).json({ error: 'Held payroll record not found' });
    res.locals.auditMetadata = { payrollAction: 'hold-removed', targetName: result.employeeName, employeeId: result.employeeId, amount: result.amount, periodStart: result.periodStart };
    res.json({ id: result.id, status: result.status });
  } catch { res.status(500).json({ error: 'Failed to remove payroll hold' }); }
});

router.post('/payroll-requests/:id/email', async (req, res) => {
  try {
    if (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) return res.status(503).json({ error: 'Email delivery is not configured' });
    const db = mongoose.connection.db;
    const payroll = await db.collection('payroll_requests').findOne({ id: req.params.id });
    if (!payroll) return res.status(404).json({ error: 'Payslip not found' });
    const employee = await db.collection('employees').findOne({ id: payroll.employeeId, archived: { $ne: true } });
    if (!employee) return res.status(404).json({ error: 'Active employee not found' });
    if (!employee.email) return res.status(400).json({ error: 'Add an email address to this employee profile first' });
    const money = (value) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value || 0));
    const additions = Array.isArray(payroll.additions) ? payroll.additions : [];
    const text = [
      'WORKPULSE MVL Payslip',
      `Pay period: ${payroll.periodStart}`,
      `Employee: ${employee.name}`,
      `Employee ID: ${employee.id}`,
      '',
      `Hours worked: ${Number(payroll.hoursWorked || 0).toFixed(2)}`,
      `Hourly rate: ${money(payroll.hourlyRate)}`,
      `Attendance-based pay: ${money(payroll.grossAmount ?? payroll.currentAmount)}`,
      ...additions.map((item) => `${item.label}: +${money(item.value)}`),
      ...(Number(payroll.carryOverAmount || 0) > 0 ? [`Unpaid balance carried forward: +${money(payroll.carryOverAmount)}`] : []),
      '',
      `Total payroll: ${money(payroll.amount)}`,
      `Status: ${payroll.status === 'paid' ? 'Paid' : payroll.status === 'rejected' ? 'Payment on hold - carries forward' : payroll.status === 'carried_over' ? 'Carried to the next pay period' : 'Ready to pay'}`,
    ].join('\n');
    const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_APP_PASSWORD } });
    await transport.sendMail({ from: `WORKPULSE MVL <${process.env.SMTP_USER}>`, to: employee.email, subject: `Payslip ${payroll.periodStart} - ${employee.name}`, text });
    res.locals.auditMetadata = { payrollAction: 'payslip-emailed', targetName: employee.name, employeeId: employee.id, periodStart: payroll.periodStart };
    res.json({ message: `Payslip sent to ${employee.email}` });
  } catch (error) {
    console.error('Payslip email failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to email the payslip' });
  }
});

router.post('/payroll/:employeeId/email-summary', async (req, res) => {
  try {
    if (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) return res.status(503).json({ error: 'Email delivery is not configured' });
    const employee = await mongoose.connection.db.collection('employees').findOne({ id: req.params.employeeId, archived: { $ne: true } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    if (!employee.email) return res.status(400).json({ error: 'Add an email address to this employee profile first' });
    const settings = await getSettings(mongoose.connection.db);
    await enforceAutomaticClockOut(mongoose.connection.db, settings);
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - 14);
    periodStart.setHours(0, 0, 0, 0);
    const records = await mongoose.connection.db.collection('attendance').find({ employeeId: employee.id }).toArray();
    const periodRecords = records.filter((record) => new Date(record.date) >= periodStart);
    const hoursWorked = periodRecords.reduce((total, record) => total + attendanceHoursForRecord(record, settings), 0);
    const hourlyRate = configuredHourlyRate(employee, settings);
    const gross = periodRecords.length ? Math.round(hoursWorked * hourlyRate * 100) / 100 : Number(employee.grossSalary ?? 0);
    const identifiers = Array.isArray(employee.identifiers) ? employee.identifiers.filter((item) => item?.type && item?.value) : [];
    const additionLines = identifiers.filter((item) => Number(item.amount) > 0).map((item) => [String(item.type), Number(item.amount)]);
    const total = additionLines.reduce((sum, item) => sum + item[1], 0);
    const money = (value) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(value);
    const identifierText = identifiers.length ? `\nProfile identifiers:\n${identifiers.map((item) => `${item.type}: ${item.value}`).join('\n')}` : '';
    const activePeriodStart = payrollPeriodKey();
    const legacyActivePeriodStart = currentPayrollPeriodStart().toISOString().slice(0, 10);
    const activePayroll = await mongoose.connection.db.collection('payroll_requests').findOne({ employeeId: employee.id, periodStart: { $in: [...new Set([activePeriodStart, legacyActivePeriodStart])] } });
    const carryOver = Number(activePayroll?.carryOverAmount || 0);
    const text = `Payroll Summary (15-day period)\nEmployee: ${employee.name}\nEmployee ID: ${employee.id}${identifierText}\nHours Worked: ${hoursWorked.toFixed(2)}\nHourly Rate: ${money(hourlyRate)}\n\nGross Salary: ${money(gross)}\n${additionLines.map(([label, value]) => `${label}: +${money(value)}`).join('\n')}\nTotal Additions: +${money(total)}\nUnpaid Balance Carried Forward: +${money(carryOver)}\nNet Salary: ${money(gross + total + carryOver)}`;
    const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_APP_PASSWORD } });
    await transport.sendMail({ from: `WORKPULSE MVL <${process.env.SMTP_USER}>`, to: employee.email, subject: `Payroll Summary - ${employee.name}`, text });
    res.locals.auditMetadata = { payrollAction: 'summary-emailed', targetName: employee.name, employeeId: employee.id };
    res.json({ message: `Payroll summary sent to ${employee.email}` });
  } catch (error) {
    console.error('Payroll email failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to email payroll summary' });
  }
});

router.get('/leave-requests', async (req, res) => {
  try {
    const db = mongoose.connection?.db;
    if (!db) return res.status(500).json({ error: 'MongoDB connection not ready' });

    const employeeIds = await visibleEmployeeIds(db);
    const leaveRequests = await db.collection('leave_requests').find({ employeeId: { $in: employeeIds } }).sort({ createdAt: -1, _id: -1 }).limit(2_000).toArray();

    res.json(
      leaveRequests.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        role: r.role,
        leaveType: r.leaveType,
        startDate: r.startDate,
        endDate: r.endDate,
        requestedDates: Array.isArray(r.requestedDates) ? r.requestedDates : [],
        approvedDates: Array.isArray(r.approvedDates) ? r.approvedDates : [],
        totalDays: r.totalDays,
        reason: r.reason,
        status: r.status,
        avatarUrl: undefined,
        initials: r.initials,
        createdAt: r.createdAt,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leave requests' });
  }
});

router.patch('/payroll-requests/:id/reset', async (req, res) => {
  try {
    const verification = await verifyAdminPassword(req, req.body?.password);
    if (!verification.valid) {
      if (verification.retryAfterSeconds) res.setHeader('Retry-After', String(verification.retryAfterSeconds));
      return res.status(verification.forbidden ? 403 : verification.retryAfterSeconds ? 429 : 401).json({ error: verification.forbidden ? 'Administrator access required' : verification.retryAfterSeconds ? `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.` : 'Incorrect admin password' });
    }
    const db = mongoose.connection.db;
    const existing = await db.collection('payroll_requests').findOne({ id: req.params.id });
    if (!existing) return res.status(404).json({ error: 'Payroll record not found' });
    const resetAt = new Date();
    const result = await db.collection('payroll_requests').findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          hoursWorked: 0, hourlyRate: 0, grossAmount: 0, bonusAmount: 0, additions: [], currentAmount: 0,
          carryOverAmount: 0, amount: 0, warnings: [], status: 'processing',
          calculationResetAt: resetAt, resetBy: req.auth.actor.email, updatedAt: resetAt,
        },
        $unset: { paidAt: '', approvedBy: '', paymentActionId: '', rejectedAt: '', rejectedBy: '', settledBy: '', undoneAt: '', undoneBy: '' },
      },
      { returnDocument: 'after' },
    );
    res.locals.auditMetadata = { payrollAction: 'reset', targetName: existing.employeeName, employeeId: existing.employeeId, periodStart: existing.periodStart, recordCount: 1 };
    res.json(result);
  } catch (error) {
    console.error('Payroll reset failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Payroll could not be reset' });
  }
});

router.post('/attendance/audit-export', async (req, res) => {
  res.locals.auditMetadata = {
    attendanceAction: 'exported', exportFormat: req.body?.format === 'csv' ? 'csv' : 'unknown',
    from: String(req.body?.from || '').slice(0, 10), to: String(req.body?.to || '').slice(0, 10),
    recordCount: Math.max(0, Math.min(10000, Number(req.body?.recordCount || 0))),
  };
  res.status(204).end();
});

router.post('/payroll/audit-export', async (req, res) => {
  res.locals.auditMetadata = {
    payrollAction: 'exported', exportFormat: req.body?.format === 'csv' ? 'csv' : 'unknown',
    periodStart: String(req.body?.periodStart || '').slice(0, 10), filter: String(req.body?.filter || 'all').slice(0, 30),
    searchApplied: Boolean(req.body?.searchApplied), recordCount: Math.max(0, Math.min(10000, Number(req.body?.recordCount || 0))),
  };
  res.status(204).end();
});

router.patch('/leave-requests/bulk-status', async (req, res) => {
  try {
    const status = req.body?.status;
    const ids = [...new Set(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [])].slice(0, 100);
    if (!['approved', 'rejected'].includes(status) || !ids.length) return res.status(400).json({ error: 'Select pending requests and a valid decision.' });
    const verification = await verifyAdminPassword(req, req.body?.password);
    if (!verification.valid) return res.status(verification.retryAfterSeconds ? 429 : 401).json({ error: verification.retryAfterSeconds ? `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.` : 'Incorrect administrator password.' });
    const db = mongoose.connection.db;
    const visibleIds = await visibleEmployeeIds(db);
    const results = [];
    for (const id of ids) {
      try {
        const pending = await db.collection('leave_requests').findOne({ id, employeeId: { $in: visibleIds }, status: 'pending' });
        if (!pending) throw new Error('Request is no longer pending.');
        const requestedDates = Array.isArray(pending.requestedDates) ? [...new Set(pending.requestedDates.map(String))].sort() : [];
        if (status === 'approved') {
          if (!requestedDates.length) throw new Error('No valid requested dates are available.');
          const [settings, approvedRequests] = await Promise.all([getSettings(db), db.collection('leave_requests').find({ employeeId: pending.employeeId, status: 'approved' }).toArray()]);
          const nonWorking = requestedDates.find((date) => scheduledWorkStatus(settings, date) === false);
          if (nonWorking) throw new Error(`${nonWorking} is a holiday or rest day.`);
          const attendanceConflict = await db.collection('attendance').findOne({ employeeId: pending.employeeId, date: { $in: requestedDates }, $or: [{ checkIn: { $nin: [null, ''] } }, { sessions: { $elemMatch: { checkIn: { $nin: [null, ''] } } } }] });
          if (attendanceConflict) throw new Error(`Attendance already exists on ${attendanceConflict.date}.`);
          const approval = { ...pending, approvedDates: requestedDates };
          for (const month of [...new Set(requestedDates.map((date) => date.slice(0, 7)))]) {
            const current = monthlyLeaveSummary(approvedRequests, settings.leave.monthlyCredits, month);
            if (current.used + leaveDaysInMonth(approval, month) > current.total) throw new Error(`Not enough leave credits for ${month}.`);
          }
        }
        const approvedDates = status === 'approved' ? requestedDates : [];
        const updated = await db.collection('leave_requests').findOneAndUpdate({ _id: pending._id, status: 'pending' }, { $set: { status, approvedDates, totalDays: status === 'approved' ? approvedDates.length : pending.totalDays, reviewedAt: new Date(), reviewedBy: req.auth.actor.email } }, { returnDocument: 'after' });
        if (!updated) throw new Error('Request changed while it was being processed.');
        if (status === 'approved') await Promise.all(approvedDates.map((date) => db.collection('attendance').updateOne(
          { employeeId: updated.employeeId, date, $or: [{ checkIn: { $exists: false } }, { checkIn: null }, { checkIn: '' }] },
          { $set: { name: updated.employeeName, role: updated.role, status: 'On Leave', leaveRequestId: updated.id, updatedAt: new Date() }, $setOnInsert: { employeeId: updated.employeeId, date, checkIn: null, checkOut: null, sessions: [], createdAt: new Date() } }, { upsert: true },
        )));
        results.push({ id, employeeName: updated.employeeName, ok: true, request: { ...updated, _id: undefined } });
      } catch (error) { results.push({ id, ok: false, error: error instanceof Error ? error.message : 'Unable to process request.' }); }
    }
    const successful = results.filter((item) => item.ok);
    res.locals.auditMetadata = { leaveAction: `bulk-${status}`, requestedStatus: status, recordCount: successful.length, failedCount: results.length - successful.length, requestIds: ids };
    res.json({ status, successful, failed: results.filter((item) => !item.ok) });
  } catch (error) {
    console.error('Bulk leave decision failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Unable to process the selected leave requests.' });
  }
});

router.patch('/leave-requests/:id/status', async (req, res) => {
  try {
    const status = req.body?.status;
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Status must be approved or rejected' });
    const db = mongoose.connection.db;
    const employeeIds = await visibleEmployeeIds(db);
    const pendingRequest = await db.collection('leave_requests').findOne({ id: req.params.id, employeeId: { $in: employeeIds }, status: 'pending' });
    if (!pendingRequest) return res.status(404).json({ error: 'Pending leave request not found' });
    res.locals.auditMetadata = { targetName: pendingRequest.employeeName, employeeId: pendingRequest.employeeId, requestedStatus: status, leaveAction: status };
    const requestedDates = Array.isArray(pendingRequest.requestedDates) && pendingRequest.requestedDates.length ? pendingRequest.requestedDates : [];
    const approvedDates = status === 'approved' ? [...new Set((Array.isArray(req.body?.approvedDates) ? req.body.approvedDates : requestedDates).map(String))].sort() : [];
    if (status === 'approved' && (!approvedDates.length || approvedDates.some((date) => !requestedDates.includes(date)))) return res.status(400).json({ error: 'Select at least one date from the employee request.' });
    if (status === 'approved' && pendingRequest.employeeId) {
      const [settings, approvedRequests] = await Promise.all([
        getSettings(db),
        db.collection('leave_requests').find({ employeeId: pendingRequest.employeeId, status: 'approved' }).toArray(),
      ]);
      const nonWorkingDates = approvedDates.filter((date) => scheduledWorkStatus(settings, date) === false);
      if (nonWorkingDates.length) return res.status(409).json({ error: `${nonWorkingDates[0]} is now a holiday or rest day and cannot use leave credit.` });
      const attendanceConflict = await db.collection('attendance').findOne({ employeeId: pendingRequest.employeeId, date: { $in: approvedDates }, $or: [{ checkIn: { $nin: [null, ''] } }, { sessions: { $elemMatch: { checkIn: { $nin: [null, ''] } } } }] });
      if (attendanceConflict) return res.status(409).json({ error: `Attendance already exists on ${attendanceConflict.date}. Remove that date from the approval or resolve its attendance first.` });
      const approval = { ...pendingRequest, approvedDates };
      for (const month of [...new Set(approvedDates.map((date) => date.slice(0, 7)))]) {
        const current = monthlyLeaveSummary(approvedRequests, settings.leave.monthlyCredits, month);
        const requested = leaveDaysInMonth(approval, month);
        if (current.used + requested > current.total) {
          const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
          return res.status(409).json({ error: `Not enough leave credits for ${monthLabel}. ${current.remaining} of ${current.total} credits remain.` });
        }
      }
    }
    const request = await db.collection('leave_requests').findOneAndUpdate({ id: req.params.id, status: 'pending' }, { $set: { status, approvedDates, totalDays: status === 'approved' ? approvedDates.length : pendingRequest.totalDays, reviewedAt: new Date(), reviewedBy: req.auth.actor.email } }, { returnDocument: 'after' });
    if (!request) return res.status(404).json({ error: 'Pending leave request not found' });
    if (status === 'approved' && request.employeeId) {
      await Promise.all(approvedDates.map((date) => db.collection('attendance').updateOne(
        { employeeId: request.employeeId, date, $or: [{ checkIn: { $exists: false } }, { checkIn: null }, { checkIn: '' }] },
        { $set: { name: request.employeeName, role: request.role, status: 'On Leave', leaveRequestId: request.id, updatedAt: new Date() }, $setOnInsert: { employeeId: request.employeeId, date, checkIn: null, checkOut: null, sessions: [], createdAt: new Date() } },
        { upsert: true },
      )));
    }
    res.json({ ...request, _id: undefined });
  } catch { res.status(500).json({ error: 'Failed to update leave request' }); }
});

router.patch('/leave-requests/:id/undo-approval', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const today = kioskTimestamp().date;
    const existing = await db.collection('leave_requests').findOne({ id: req.params.id, status: 'approved' });
    if (!existing) return res.status(409).json({ error: 'Only an approved leave request can be undone.' });
    const approvedDates = Array.isArray(existing.approvedDates) ? existing.approvedDates : [];
    const pastDates = approvedDates.filter((date) => date < today);
    const reversibleDates = approvedDates.filter((date) => date >= today);
    if (!reversibleDates.length) return res.status(409).json({ error: 'This leave has no current or future approved dates to undo.' });
    const request = await db.collection('leave_requests').findOneAndUpdate(
      { _id: existing._id, status: 'approved' },
      { $set: { status: pastDates.length ? 'approved' : 'cancelled', approvedDates: pastDates, totalDays: pastDates.length, approvalUndoneAt: new Date(), approvalUndoneBy: req.auth.actor.email } },
      { returnDocument: 'after' },
    );
    await db.collection('attendance').deleteMany({ employeeId: request.employeeId, leaveRequestId: request.id, status: 'On Leave', date: { $gte: today }, $or: [{ checkIn: null }, { checkIn: '' }, { checkIn: { $exists: false } }] });
    res.json({ ...request, _id: undefined });
  } catch { res.status(500).json({ error: 'Unable to undo the leave approval.' }); }
});

// Attendance is stored in `attendance` collection.
router.get('/attendance', async (req, res) => {
  try {
    const db = mongoose.connection?.db;
    if (!db) return res.status(500).json({ error: 'MongoDB connection not ready' });

    const settings = await getSettings(db);
    await enforceAutomaticClockOut(db, settings);
    const employeeIds = await visibleEmployeeIds(db);
    const requestedLimit = Number.parseInt(String(req.query.limit ?? '5000'), 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(10_000, requestedLimit)) : 5_000;
    const dateFilter = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) dateFilter.$gte = String(req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) dateFilter.$lte = String(req.query.to);
    const attendance = await db.collection('attendance').find(
      { employeeId: { $in: employeeIds }, ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}) },
      { projection: { employeeId: 1, name: 1, role: 1, date: 1, checkIn: 1, checkOut: 1, sessions: 1, status: 1, autoClockedOut: 1 } },
    ).sort({ date: -1 }).limit(limit).toArray();

    res.json(
      attendance.map((a) => ({
        employeeId: a.employeeId,
        name: a.name,
        role: a.role,
        date: a.date,
        checkIn: a.checkIn,
        checkOut: a.checkOut,
        sessions: attendanceSessions(a),
        sessionCount: attendanceSessions(a).length,
        status: attendanceArrivalStatus(a, settings),
        autoClockedOut: a.autoClockedOut ?? false,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

function kioskTimestamp() {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    now,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: true }).format(now),
  };
}

router.post('/attendance/kiosk', async (req, res) => {
  res.locals.auditMetadata = { kioskAction: 'fingerprint scan', attendanceRecorded: false };
  const rejectScan = (status, reason, error, extra = {}) => {
    res.locals.auditMetadata = { ...res.locals.auditMetadata, kioskReason: reason, failureReason: error };
    return res.status(status).json({ error, ...extra });
  };
  try {
    const db = mongoose.connection?.db;
    if (!db) return rejectScan(503, 'database-unavailable', 'MongoDB connection not ready');
    const [probe] = normalizeFingerprintSamples(req.body?.fingerprintSamples, 1);
    const deviceUid = String(req.body?.deviceUid ?? '').trim().slice(0, 200);
    const templates = await activeBiometricTemplates(db);
    const matchStartedAt = Date.now();
    const decision = await findFingerprintDecision(probe, templates);
    const matched = decision.accepted ? decision.best : null;
    const attemptTime = new Date();
    let verificationAttemptId = null;
    try {
      const insertedAttempt = await db.collection('biometric_verification_attempts').insertOne({
        mode: 'one-to-many', accepted: decision.accepted,
        employeeId: matched?.employeeId || null, score: decision.best?.score ?? null,
        threshold: decision.threshold, deviceUid: deviceUid || null,
        responseTimeMs: Date.now() - matchStartedAt, action: matched ? 'recognized' : 'no-match', createdAt: attemptTime,
      });
      verificationAttemptId = insertedAttempt.insertedId;
    } catch (attemptError) {
      console.error('Fingerprint verification attempt could not be logged:', attemptError instanceof Error ? attemptError.message : attemptError);
    }
    if (!matched) return rejectScan(404, 'no-match', 'Fingerprint not recognized. Use a registered finger.');
    const employeeId = matched.employeeId;
    const employee = await db.collection('employees').findOne({ id: employeeId, archived: { $ne: true }, status: { $ne: 'inactive' } });
    if (!employee) return rejectScan(404, 'employee-unavailable', 'Active employee not found');
    res.locals.auditMetadata = { ...res.locals.auditMetadata, targetName: employee.name, employeeId };

    const stamp = kioskTimestamp();
    const existing = await db.collection('attendance').findOne({ employeeId, date: stamp.date });
    const settings = await getSettings(db);
    const hasOpenSession = attendanceSessions(existing).some((session) => !session.checkOut);
    const approvedLeave = await db.collection('leave_requests').findOne({ employeeId, status: 'approved', $or: [{ approvedDates: stamp.date }, { approvedDates: { $exists: false }, startDate: { $lte: stamp.date }, endDate: { $gte: stamp.date } }] });
    if (approvedLeave && !hasOpenSession) {
      if (verificationAttemptId) await db.collection('biometric_verification_attempts').updateOne({ _id: verificationAttemptId }, { $set: { action: 'approved-leave', eventTime: stamp.time, attendanceDate: stamp.date } });
      return rejectScan(403, 'approved-leave', 'Time-in is unavailable because you have approved leave today.');
    }
    if (scheduledWorkStatus(settings, stamp.date) === false && !hasOpenSession) {
      if (verificationAttemptId) await db.collection('biometric_verification_attempts').updateOne({ _id: verificationAttemptId }, { $set: { action: 'non-working-day', eventTime: stamp.time, attendanceDate: stamp.date } });
      return rejectScan(403, 'non-working-day', 'Time-in is unavailable today because this date is marked as a non-working day.');
    }
    if (!existing) {
      const record = {
        employeeId, name: employee.name, role: employee.role === 'extra' ? 'Extra' : 'Regular',
        date: stamp.date, checkIn: stamp.time, checkOut: null,
        sessions: [{ checkIn: stamp.time, checkOut: null, checkInAt: stamp.now, deviceUid: deviceUid || null, matchScore: matched.score }],
        sessionCount: 1, lastAction: 'time-in',
        status: clockMinutes(stamp.time) > clockMinutes(settings.shift.startTime) + Number(settings.shift.lateGraceMinutes || 0) ? 'Late' : 'Present',
        captureMethod: 'digitalpersona-fingerjet', deviceUid: deviceUid || null,
        identityVerified: true, matchScore: matched.score, matcherFormat: matched.format,
        createdAt: stamp.now, updatedAt: stamp.now,
      };
      try { await db.collection('attendance').insertOne(record); }
      catch (error) {
        if (error?.code === 11000) return rejectScan(409, 'conflict', 'Attendance was already recorded for this employee today');
        throw error;
      }
      res.locals.auditMetadata = { ...res.locals.auditMetadata, attendanceRecorded: true, kioskAction: 'time-in', eventTime: stamp.time };
      if (verificationAttemptId) await db.collection('biometric_verification_attempts').updateOne({ _id: verificationAttemptId }, { $set: { action: 'time-in', eventTime: stamp.time, attendanceDate: stamp.date } });
      res.locals.auditMetadata = { ...res.locals.auditMetadata, kioskAction: 'time-in', eventTime: stamp.time };
      return res.status(201).json({ action: 'time-in', record: { ...record, eventTime: stamp.time, _id: undefined } });
    }

    const lastAttendanceUpdate = new Date(existing.updatedAt ?? existing.createdAt ?? 0).getTime();
    const duplicateScanWindowMs = 30_000;
    const elapsedSinceTimeIn = stamp.now.getTime() - lastAttendanceUpdate;
    if (Number.isFinite(lastAttendanceUpdate) && elapsedSinceTimeIn >= 0 && elapsedSinceTimeIn < duplicateScanWindowMs) {
      const retryAfterSeconds = Math.max(1, Math.ceil((duplicateScanWindowMs - elapsedSinceTimeIn) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return rejectScan(429, 'duplicate-scan', 'Attendance was just recorded. Remove your finger before the next scan.', { retryAfterSeconds });
    }

    const sessions = attendanceSessions(existing);
    const lastSession = sessions.at(-1);
    const versionFilter = { _id: existing._id, ...(existing.updatedAt ? { updatedAt: existing.updatedAt } : {}) };
    let action;
    let update;
    if (lastSession && !lastSession.checkOut) {
      sessions[sessions.length - 1] = {
        ...lastSession, checkOut: stamp.time, checkOutAt: stamp.now,
        checkoutDeviceUid: deviceUid || null, checkoutMatchScore: matched.score,
      };
      action = 'time-out';
      update = {
        sessions, sessionCount: sessions.length, checkOut: stamp.time, lastAction: action, updatedAt: stamp.now,
        checkoutCaptureMethod: 'digitalpersona-fingerjet', checkoutDeviceUid: deviceUid || null,
        checkoutIdentityVerified: true, checkoutMatchScore: matched.score,
      };
    } else {
      if (sessions.length >= MAX_DAILY_ATTENDANCE_SESSIONS) {
        if (verificationAttemptId) await db.collection('biometric_verification_attempts').updateOne({ _id: verificationAttemptId }, { $set: { action: 'daily-limit', eventTime: stamp.time, attendanceDate: stamp.date } });
        return rejectScan(409, 'daily-limit', 'Daily attendance limit reached: three time-in/time-out sessions are already complete.');
      }
      sessions.push({ checkIn: stamp.time, checkOut: null, checkInAt: stamp.now, deviceUid: deviceUid || null, matchScore: matched.score });
      action = 'time-in';
      update = {
        sessions, sessionCount: sessions.length, checkOut: null, lastAction: action, updatedAt: stamp.now,
        lastCheckIn: stamp.time, deviceUid: deviceUid || null, matchScore: matched.score,
      };
    }

    const updated = await db.collection('attendance').findOneAndUpdate(versionFilter, { $set: update }, { returnDocument: 'after' });
    if (!updated) return rejectScan(409, 'conflict', 'Attendance was updated by another request');
    res.locals.auditMetadata = { ...res.locals.auditMetadata, attendanceRecorded: true, kioskAction: action, eventTime: stamp.time };
    if (action === 'time-out') {
      const attendancePeriod = payrollPeriodKey(new Date(`${stamp.date}T12:00:00+08:00`));
      await preparePayrollRecord(db, employee, attendancePeriod, settings);
    }
    if (verificationAttemptId) await db.collection('biometric_verification_attempts').updateOne({ _id: verificationAttemptId }, { $set: { action, eventTime: stamp.time, attendanceDate: stamp.date } });
    res.locals.auditMetadata = { ...res.locals.auditMetadata, kioskAction: action, eventTime: stamp.time };
    return res.json({ action, record: { ...updated, eventTime: stamp.time, _id: undefined } });
  } catch (error) {
    if (error instanceof BiometricError) return rejectScan(error.status, error.status === 503 ? 'matcher-unavailable' : error.status === 422 ? 'unsupported-sample' : 'invalid-sample', error.message);
    console.error('Kiosk attendance failed:', error instanceof Error ? error.message : error);
    rejectScan(500, 'internal-error', res.locals.auditMetadata.attendanceRecorded ? 'Attendance was saved, but a follow-up operation failed.' : 'Unable to record kiosk attendance');
  }
});

export default router;


