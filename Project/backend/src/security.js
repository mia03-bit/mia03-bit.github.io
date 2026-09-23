import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { getSystemControls } from './system-controls.js';

const SESSION_COOKIE = 'workpulse_session';
export const SESSION_LIFETIME_MS = 5 * 60 * 60_000;
const rateBuckets = new Map();

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

export function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_LIFETIME_MS / 1000}; SameSite=Lax${secure}`);
}

export function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`);
}

export function getRequestToken(req) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (bearer) return { token: bearer, source: 'bearer' };
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return token ? { token, source: 'cookie' } : null;
}

export function rateLimit({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    const now = Date.now();
    const identity = `${keyPrefix}:${req.ip}:${String(req.body?.email ?? '').trim().toLowerCase()}`;
    const bucket = rateBuckets.get(identity);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(identity, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      void auditEvent({ req, action: 'security.rate_limit', targetType: keyPrefix, outcome: 'failure' });
      return res.status(429).json({ error: `Too many attempts. Try again in ${retryAfterSeconds} seconds.`, retryAfterSeconds });
    }
    next();
  };
}

export function auditScreenName(action, targetType, metadata = {}) {
  const path = String(metadata?.path || '').toLowerCase();
  const target = String(targetType || '').toLowerCase();
  if (['auth.login', 'auth.logout', 'auth.otp_sent', 'auth.otp_verify'].includes(String(action || '')) || target === 'session') return 'Login';
  if (path.includes('/attendance/kiosk')) return 'Kiosk';
  if (path.startsWith('/attendance') || target === 'attendance') return 'Attendance';
  if (path.startsWith('/admin/')) return 'Admin Controls';
  if (path.includes('/payroll') || target.includes('payroll')) return 'Payroll';
  if (path.includes('/leave-requests') || target.includes('leave')) return 'Leave Requests';
  if (path.includes('/employees') || target === 'employees' || target.includes('employee')) return 'Employee Directory';
  if (path === '/settings' || target === 'settings') return 'System Settings';
  if (path.includes('/admin/') || target.includes('admin')) return 'Admin Controls';
  if (String(action || '').startsWith('auth.')) return 'Account Security';
  if (path.includes('/fingerprints') || target.includes('fingerprint') || target.includes('biometric')) return 'Fingerprint Management';
  if (path.includes('/audit-events') || target.includes('audit')) return 'Overview';
  return 'System';
}

export async function auditEvent({ req, actor = null, action, targetType, targetId = null, outcome = 'success', metadata = {} }) {
  try {
    const db = mongoose.connection.db;
    if (!db) return;
    await db.collection('audit_events').insertOne({
      occurredAt: new Date(),
      actorId: actor?._id ?? null,
      actorEmail: actor?.email ?? null,
      actorRole: actor?.role ?? 'anonymous',
      screenName: auditScreenName(action, targetType, metadata),
      action,
      targetType,
      targetId,
      outcome,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      requestId: req.requestId,
      metadata,
    });
  } catch (error) {
    console.error('Audit event write failed:', error instanceof Error ? error.message : error);
  }
}

export async function authenticate(req, res, next) {
  try {
    const requestToken = getRequestToken(req);
    if (!requestToken) return res.status(401).json({ error: 'Authentication required' });
    const db = mongoose.connection.db;
    const tokenDigest = digest(requestToken.token);
    const session = await db.collection('admin_sessions').findOne({ tokenDigest, expiresAt: { $gt: new Date() } });
    if (!session) return res.status(401).json({ error: 'Your session has expired' });
    const hardExpiry = new Date(session.createdAt).getTime() + SESSION_LIFETIME_MS;
    if (!Number.isFinite(hardExpiry) || hardExpiry <= Date.now()) {
      await db.collection('admin_sessions').deleteOne({ _id: session._id });
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Your five-hour session has expired. Sign in again.' });
    }
    const accountType = session.accountType ?? 'admin';
    const accountId = session.accountId ?? session.adminId;
    const collection = accountType === 'employee' ? 'employee_accounts' : 'admin_accounts';
    const actor = await db.collection(collection).findOne({ _id: accountId, active: true });
    if (!actor) return res.status(401).json({ error: 'Account is unavailable' });
    if (accountType === 'employee') {
      const controls = await getSystemControls(db);
      if (controls.maintenanceMode) return res.status(503).json({ error: 'WORKPULSE MVL is temporarily available to administrators only while maintenance is in progress.' });
    }
    req.auth = { actor, session, accountType, tokenSource: requestToken.source };
    next();
  } catch { res.status(401).json({ error: 'Authentication failed' }); }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth?.actor || !roles.includes(req.auth.actor.role)) return res.status(403).json({ error: 'You do not have permission to perform this action' });
    next();
  };
}

export function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.auth?.tokenSource === 'bearer') return next();
  const supplied = String(req.headers['x-csrf-token'] ?? '');
  const expected = String(req.auth?.session?.csrfDigest ?? '');
  if (!supplied || !expected || digest(supplied) !== expected) return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  next();
}

export function createCsrfToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenDigest: digest(token) };
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function validate(schema) {
  return (req, res, next) => {
    const result = schema(req.body ?? {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    req.body = result.value;
    next();
  };
}

export function pick(object, allowed) {
  return Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(object, key)).map((key) => [key, object[key]]));
}
