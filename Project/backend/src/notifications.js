import { buildAIInsights } from './ai-insights.js';

export const NOTIFICATION_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000;

function eventTime(date, clock) {
  const match = String(clock || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (match[4]) hour = hour % 12 + (match[4].toUpperCase() === 'PM' ? 12 : 0);
  return new Date(`${date}T${String(hour).padStart(2, '0')}:${match[2]}:${match[3] || '00'}+08:00`);
}

export function buildNotifications({ leaveRequests = [], attendance = [], insights, now = new Date() }) {
  const events = new Map();
  function add(id, category, title, description, occurredAt, employeeId) {
    const timestamp = occurredAt ? new Date(occurredAt).getTime() : NaN;
    if (!Number.isFinite(timestamp) || timestamp > now.getTime() || timestamp + NOTIFICATION_LIFETIME_MS <= now.getTime()) return;
    events.set(id, { id, category, title, description, employeeId, createdAt: new Date(timestamp), expiresAt: new Date(timestamp + NOTIFICATION_LIFETIME_MS) });
  }
  for (const request of leaveRequests) {
    add(`leave:${request.id}`, 'leave', `${request.employeeName || 'Employee'} requested leave`, `${request.startDate} to ${request.endDate}`, request.createdAt, request.employeeId);
  }
  for (const record of attendance) {
    const key = `${record.employeeId}:${record.date}`;
    const name = record.name || record.employeeId;
    const sessions = record.sessions?.length ? record.sessions : record.checkIn ? [{ checkIn: record.checkIn, checkOut: record.checkOut }] : [];
    sessions.forEach((session, index) => {
      if (session.checkIn) add(`attendance:${key}:${index}:in`, 'attendance', `${name} clocked in${index === 0 && record.status === 'Late' ? ' late' : ''}`, `${record.date} at ${session.checkIn}`, session.checkInAt || eventTime(record.date, session.checkIn), record.employeeId);
      if (session.checkOut) add(`attendance:${key}:${index}:out`, 'attendance', `${name} clocked out`, `${record.date} at ${session.checkOut}`, session.checkOutAt || eventTime(record.date, session.checkOut), record.employeeId);
    });
    if (record.status === 'Absent' && !sessions.length) {
      add(`attendance:${key}:absent`, 'attendance', `${name} recorded absent`, `No attendance recorded for ${record.date}. Review the attendance record.`, record.createdAt || eventTime(record.date, '23:59:59'), record.employeeId);
    }
  }
  for (const risk of insights?.risk?.employees || []) {
    if (!['orange', 'red'].includes(risk.tier)) continue;
    const lastDate = [...risk.absenceDates].sort().at(-1);
    const source = attendance.find((record) => record.employeeId === risk.employeeId && record.date === lastDate);
    add(`ai:risk:${risk.employeeId}:${lastDate}:${risk.tier}`, 'insights', `${risk.name}: ${risk.tier} attendance flag`, `${risk.absenceDays} unapproved absence days in the last 30 days. Review AI Insights.`, source?.createdAt || eventTime(lastDate, '23:59:59'), risk.employeeId);
  }
  if (insights?.anomaly?.status === 'ready') {
    for (const anomaly of insights.anomaly.anomalies) {
      const source = attendance.find((record) => record.employeeId === anomaly.employeeId && record.date === anomaly.date);
      add(`ai:arrival:${anomaly.employeeId}:${anomaly.date}`, 'insights', `${anomaly.name}: unusual arrival time`, `Arrival at ${anomaly.time} on ${anomaly.date} differs from the usual pattern. Review AI Insights.`, source?.sessions?.[0]?.checkInAt || eventTime(anomaly.date, anomaly.time), anomaly.employeeId);
    }
  }
  return [...events.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export async function loadNotifications(db, now = new Date()) {
  const employees = await db.collection('employees').find({ archived: { $ne: true } }).toArray();
  const employeeIds = employees.map((employee) => employee.id);
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const [attendance, leaveRequests] = await Promise.all([
    db.collection('attendance').find({ employeeId: { $in: employeeIds }, date: { $gte: start.toISOString().slice(0, 10) } }).toArray(),
    db.collection('leave_requests').find({ employeeId: { $in: employeeIds }, $or: [{ createdAt: { $gt: new Date(now.getTime() - NOTIFICATION_LIFETIME_MS) } }, { status: 'approved', endDate: { $gte: start.toISOString().slice(0, 10) } }] }).toArray(),
  ]);
  const insights = buildAIInsights({ attendance, employees, leaveRequests, now });
  const events = buildNotifications({ attendance, leaveRequests, insights, now });
  const collection = db.collection('admin_notifications');
  // Stable IDs and insert-only timestamps prevent refreshes from renewing old alerts.
  if (events.length) await collection.bulkWrite(events.map(({ id, ...event }) => ({ updateOne: { filter: { _id: id }, update: { $setOnInsert: event }, upsert: true } })), { ordered: false });
  return collection.find({ employeeId: { $in: employeeIds }, expiresAt: { $gt: now }, createdAt: { $lte: now } }).sort({ createdAt: -1, _id: 1 }).limit(2_000).toArray();
}
