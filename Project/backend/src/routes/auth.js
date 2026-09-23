import { Router } from 'express';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import { auditEvent, authenticate, clearSessionCookie, createCsrfToken, csrfProtection, getRequestToken, rateLimit, SESSION_LIFETIME_MS, setSessionCookie } from '../security.js';
import { getSystemControls } from '../system-controls.js';

const router = Router();
const scrypt = promisify(crypto.scrypt);
let operationIndex = 0;
const operations = ['+', '-', '×', '÷'];
const captchaLimit = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'captcha' });
const loginLimit = rateLimit({ windowMs: 15 * 60_000, max: 8, keyPrefix: 'login' });
const otpLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, keyPrefix: 'otp' });
const passwordResetRequestLimit = rateLimit({ windowMs: 15 * 60_000, max: 5, keyPrefix: 'password-reset-request' });
const passwordResetVerifyLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, keyPrefix: 'password-reset-verify' });
const passwordResetCompleteLimit = rateLimit({ windowMs: 15 * 60_000, max: 5, keyPrefix: 'password-reset-complete' });
const passwordCooldowns = new Map();

export async function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(secret, salt, 64);
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}

export async function verifySecret(secret, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const derived = Buffer.from(await scrypt(secret, salt, 64));
  const storedKey = Buffer.from(key, 'hex');
  return derived.length === storedKey.length && crypto.timingSafeEqual(derived, storedKey);
}

export async function verifyAdminPassword(request, password) {
  const admin = request.auth?.actor;
  if (!admin || admin.role !== 'admin') return { valid: false, forbidden: true };
  const key = `${admin._id}:${request.ip}`;
  const now = Date.now();
  const state = passwordCooldowns.get(key) ?? { failures: 0, lockedUntil: 0 };
  if (state.lockedUntil > now) return { valid: false, retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000) };
  if (await verifySecret(String(password ?? ''), admin.passwordHash)) {
    passwordCooldowns.delete(key);
    return { valid: true, admin };
  }
  const failures = state.failures + 1;
  if (failures < 3) {
    passwordCooldowns.set(key, { failures, lockedUntil: 0 });
    return { valid: false };
  }
  const retryAfterSeconds = Math.min(50, 5 + (failures - 3) * 10);
  passwordCooldowns.set(key, { failures, lockedUntil: now + retryAfterSeconds * 1000 });
  return { valid: false, retryAfterSeconds };
}

function makeCaptcha() {
  const operation = operations[operationIndex++ % operations.length];
  let left = crypto.randomInt(2, 13);
  let right = crypto.randomInt(1, 10);
  if (operation === '-' && right > left) [left, right] = [right, left];
  if (operation === '÷') left *= right;
  const answer = operation === '+' ? left + right : operation === '-' ? left - right : operation === '×' ? left * right : left / right;
  return { challenge: `${left} ${operation} ${right}`, answer: String(answer) };
}

router.get('/captcha', captchaLimit, async (_request, response) => {
  const db = mongoose.connection.db;
  if (!db) return response.status(503).json({ error: 'Database is unavailable' });
  const captchaId = crypto.randomUUID();
  const { challenge, answer } = makeCaptcha();
  await db.collection('login_captchas').insertOne({ captchaId, answerHash: await hashSecret(answer), expiresAt: new Date(Date.now() + 5 * 60_000) });
  response.json({ captchaId, challenge });
});

router.post('/login', loginLimit, async (request, response) => {
  try {
    const { email, password, captchaId, captchaAnswer } = request.body ?? {};
    if (!email || !password || !captchaId || captchaAnswer === undefined) return response.status(400).json({ error: 'Complete all login fields' });
    if (String(email).length > 254 || String(password).length > 200 || String(captchaAnswer).length > 20) return response.status(400).json({ error: 'Invalid login input' });
    const db = mongoose.connection.db;
    const captcha = await db.collection('login_captchas').findOneAndDelete({ captchaId });
    if (!captcha || captcha.expiresAt < new Date() || !(await verifySecret(String(captchaAnswer).trim(), captcha.answerHash))) { await auditEvent({ req: request, action: 'auth.login', targetType: 'session', outcome: 'failure', metadata: { reason: 'captcha', attemptedEmail: email } }); return response.status(400).json({ error: 'Invalid or expired CAPTCHA' }); }

    const normalizedEmail = String(email).trim().toLowerCase();
    let account = await db.collection('admin_accounts').findOne({ email: normalizedEmail, active: true });
    let accountType = 'admin';
    if (!account) { account = await db.collection('employee_accounts').findOne({ email: normalizedEmail, active: true }); accountType = 'employee'; }
    if (!account || !(await verifySecret(password, account.passwordHash))) { await auditEvent({ req: request, actor: account, action: 'auth.login', targetType: 'session', outcome: 'failure', metadata: { reason: 'credentials', attemptedEmail: email } }); return response.status(401).json({ error: 'Invalid email or password' }); }
    if (accountType === 'employee' && (await getSystemControls(db)).maintenanceMode) {
      await auditEvent({ req: request, actor: account, action: 'auth.login', targetType: 'session', outcome: 'failure', metadata: { reason: 'maintenance_mode' } });
      return response.status(503).json({ error: 'WORKPULSE MVL is temporarily available to administrators only while maintenance is in progress.' });
    }

    if (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) return response.status(503).json({ error: 'Email OTP is not configured on the server' });
    const otp = String(crypto.randomInt(100000, 1_000_000));
    const verificationId = crypto.randomUUID();
    await db.collection('login_otps').insertOne({ verificationId, accountId: account._id, accountType, otpHash: await hashSecret(otp), expiresAt: new Date(Date.now() + 10 * 60_000), attempts: 0 });

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV] Login verification code for ${account.email}: ${otp}`);
    }

    const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_APP_PASSWORD } });
    await transport.sendMail({ from: `WORKPULSE MVL <${process.env.SMTP_USER}>`, to: account.email, subject: 'Your WORKPULSE MVL login code', text: `Your WORKPULSE MVL verification code is ${otp}. It expires in 10 minutes.` });
    await auditEvent({ req: request, actor: account, action: 'auth.otp_sent', targetType: 'session', outcome: 'success' });
    response.json({ verificationId, message: 'OTP sent to your email' });
  } catch (error) {
    console.error('Login failed:', error instanceof Error ? error.message : error);
    response.status(500).json({ error: 'Unable to complete login' });
  }
});

router.post('/verify-otp', otpLimit, async (request, response) => {
  const { verificationId, otp } = request.body ?? {};
  const db = mongoose.connection.db;
  const record = await db.collection('login_otps').findOne({ verificationId });
  if (!record || record.expiresAt < new Date() || record.attempts >= 5) { await auditEvent({ req: request, action: 'auth.otp_verify', targetType: 'session', outcome: 'failure', metadata: { reason: 'expired_or_locked' } }); return response.status(401).json({ error: 'Invalid or expired verification code' }); }
  const valid = await verifySecret(String(otp ?? '').trim(), record.otpHash);
  if (!valid) {
    await db.collection('login_otps').updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    await auditEvent({ req: request, action: 'auth.otp_verify', targetType: 'session', outcome: 'failure', metadata: { reason: 'invalid_code' } });
    return response.status(401).json({ error: 'Invalid or expired verification code' });
  }
  await db.collection('login_otps').deleteOne({ _id: record._id });
  const token = crypto.randomBytes(32).toString('hex');
  const tokenDigest = crypto.createHash('sha256').update(token).digest('hex');
  const csrf = createCsrfToken();
  const accountId = record.accountId ?? record.adminId;
  const accountType = record.accountType ?? 'admin';
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_LIFETIME_MS);
  await db.collection('admin_sessions').insertOne({ tokenDigest, csrfDigest: csrf.tokenDigest, accountId, accountType, ...(accountType === 'admin' ? { adminId: accountId } : {}), createdAt, expiresAt });
  setSessionCookie(response, token);
  const account = await db.collection(accountType === 'employee' ? 'employee_accounts' : 'admin_accounts').findOne({ _id: accountId });
  if (accountType === 'employee' && account && typeof account.mustChangePassword !== 'boolean' && !account.passwordChangedAt) {
    account.mustChangePassword = true;
    await db.collection('employee_accounts').updateOne(
      { _id: account._id, mustChangePassword: { $exists: false } },
      { $set: { mustChangePassword: true, updatedAt: new Date() } },
    );
  }
  await auditEvent({ req: request, actor: account, action: 'auth.login', targetType: 'session', outcome: 'success' });
  response.json({
    csrfToken: csrf.token,
    role: account?.role ?? 'admin',
    accountType,
    mustChangePassword: accountType === 'employee' && account?.mustChangePassword === true,
    expiresAt: expiresAt.toISOString(),
  });
});

router.get('/session', async (request, response) => {
  const requestToken = getRequestToken(request);
  if (!requestToken) return response.status(401).json({ authenticated: false });
  const tokenDigest = crypto.createHash('sha256').update(requestToken.token).digest('hex');
  const session = await mongoose.connection.db.collection('admin_sessions').findOne({ tokenDigest, expiresAt: { $gt: new Date() } });
  if (!session) return response.status(401).json({ authenticated: false });
  const hardExpiry = new Date(session.createdAt).getTime() + SESSION_LIFETIME_MS;
  if (!Number.isFinite(hardExpiry) || hardExpiry <= Date.now()) {
    await mongoose.connection.db.collection('admin_sessions').deleteOne({ _id: session._id });
    clearSessionCookie(response);
    return response.status(401).json({ authenticated: false, error: 'Your five-hour session has expired. Sign in again.' });
  }
  const csrf = createCsrfToken();
  await mongoose.connection.db.collection('admin_sessions').updateOne({ _id: session._id }, { $set: { csrfDigest: csrf.tokenDigest } });
  const accountId = session.accountId ?? session.adminId;
  const accountType = session.accountType ?? 'admin';
  const account = await mongoose.connection.db.collection(accountType === 'employee' ? 'employee_accounts' : 'admin_accounts').findOne({ _id: accountId, active: true });
  if (!account) return response.status(401).json({ authenticated: false });
  if (accountType === 'employee' && (await getSystemControls(mongoose.connection.db)).maintenanceMode) {
    return response.status(503).json({ authenticated: false, error: 'WORKPULSE MVL is temporarily available to administrators only while maintenance is in progress.' });
  }
  response.json({
    authenticated: true,
    csrfToken: csrf.token,
    role: account.role,
    accountType,
    mustChangePassword: accountType === 'employee' && account.mustChangePassword === true,
    expiresAt: new Date(Math.min(new Date(session.expiresAt).getTime(), hardExpiry)).toISOString(),
  });
});

router.post('/forgot-password/request', passwordResetRequestLimit, async (request, response) => {
  const genericMessage = 'If that email belongs to an active employee, a 6-digit reset code has been sent.';
  try {
    const email = String(request.body?.email ?? '').trim().toLowerCase();
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response.status(400).json({ error: 'Enter a valid employee email address.' });
    }
    const db = mongoose.connection.db;
    const account = await db.collection('employee_accounts').findOne({ email, active: true });
    if (!account) {
      await auditEvent({ req: request, action: 'auth.password_reset_requested', targetType: 'employee_account', outcome: 'failure', metadata: { reason: 'account_not_found' } });
      return response.json({ verificationId: crypto.randomUUID(), message: genericMessage });
    }
    if (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) {
      return response.status(503).json({ error: 'Employee email delivery is not configured. Ask your administrator for help.' });
    }

    const code = String(crypto.randomInt(100000, 1_000_000));
    const verificationId = crypto.randomUUID();
    await db.collection('password_reset_otps').deleteMany({ accountId: account._id });
    await db.collection('password_reset_otps').insertOne({
      verificationId,
      accountId: account._id,
      codeHash: await hashSecret(code),
      attempts: 0,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    if (process.env.NODE_ENV !== 'production') console.log(`[DEV] Employee password reset code for ${account.email}: ${code}`);
    const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_APP_PASSWORD } });
    await transport.sendMail({
      from: `WORKPULSE MVL <${process.env.SMTP_USER}>`,
      to: account.email,
      subject: 'Reset your WORKPULSE MVL employee password',
      text: `Your WORKPULSE MVL password reset code is ${code}. It expires in 10 minutes. If you did not request this change, you can ignore this email.`,
    });
    await auditEvent({ req: request, actor: account, action: 'auth.password_reset_requested', targetType: 'employee_account', targetId: account.employeeId, outcome: 'success' });
    response.json({ verificationId, message: genericMessage });
  } catch (error) {
    console.error('Password reset request failed:', error instanceof Error ? error.message : error);
    response.status(500).json({ error: 'Unable to send a reset code. Please try again.' });
  }
});

router.post('/forgot-password/verify', passwordResetVerifyLimit, async (request, response) => {
  try {
    const verificationId = String(request.body?.verificationId ?? '');
    const code = String(request.body?.code ?? '').trim();
    if (!verificationId || !/^\d{6}$/.test(code)) return response.status(400).json({ error: 'Enter the complete 6-digit code.' });
    const db = mongoose.connection.db;
    const record = await db.collection('password_reset_otps').findOne({ verificationId });
    if (!record || record.expiresAt < new Date() || record.attempts >= 5 || record.usedAt) {
      return response.status(401).json({ error: 'The reset code is invalid or has expired.' });
    }
    if (!(await verifySecret(code, record.codeHash))) {
      await db.collection('password_reset_otps').updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
      await auditEvent({ req: request, action: 'auth.password_reset_code_verified', targetType: 'employee_account', outcome: 'failure' });
      return response.status(401).json({ error: 'The reset code is invalid or has expired.' });
    }
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenDigest = crypto.createHash('sha256').update(resetToken).digest('hex');
    await db.collection('password_reset_otps').updateOne(
      { _id: record._id, usedAt: { $exists: false } },
      { $set: { resetTokenDigest, verifiedAt: new Date(), resetExpiresAt: new Date(Date.now() + 10 * 60_000), expiresAt: new Date(Date.now() + 10 * 60_000) }, $unset: { codeHash: '' } },
    );
    response.json({ resetToken });
  } catch (error) {
    console.error('Password reset verification failed:', error instanceof Error ? error.message : error);
    response.status(500).json({ error: 'Unable to verify the reset code. Please try again.' });
  }
});

router.post('/forgot-password/reset', passwordResetCompleteLimit, async (request, response) => {
  try {
    const verificationId = String(request.body?.verificationId ?? '');
    const resetToken = String(request.body?.resetToken ?? '');
    const newPassword = request.body?.newPassword;
    if (!verificationId || verificationId.length > 100 || resetToken.length !== 64) return response.status(401).json({ error: 'Your password reset request has expired.' });
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 32) {
      return response.status(400).json({ error: 'Your new password must be between 8 and 32 characters.' });
    }
    const db = mongoose.connection.db;
    const resetTokenDigest = crypto.createHash('sha256').update(resetToken).digest('hex');
    const record = await db.collection('password_reset_otps').findOne({ verificationId, resetTokenDigest, resetExpiresAt: { $gt: new Date() }, usedAt: { $exists: false } });
    if (!record) return response.status(401).json({ error: 'Your password reset request is invalid or has expired.' });
    const account = await db.collection('employee_accounts').findOne({ _id: record.accountId, active: true });
    if (!account) return response.status(401).json({ error: 'This employee account is unavailable.' });
    if (await verifySecret(newPassword, account.passwordHash)) return response.status(400).json({ error: 'Choose a password different from your current password.' });

    const changedAt = new Date();
    await db.collection('employee_accounts').updateOne(
      { _id: account._id },
      { $set: { passwordHash: await hashSecret(newPassword), mustChangePassword: false, passwordChangedAt: changedAt, credentialsChangedAt: changedAt, updatedAt: changedAt } },
    );
    await db.collection('password_reset_otps').updateOne({ _id: record._id, usedAt: { $exists: false } }, { $set: { usedAt: changedAt }, $unset: { resetTokenDigest: '' } });
    await db.collection('admin_sessions').deleteMany({ accountId: account._id, accountType: 'employee' });
    await auditEvent({ req: request, actor: account, action: 'auth.password_reset_completed', targetType: 'employee_account', targetId: account.employeeId, outcome: 'success' });
    response.json({ changed: true, message: 'Your password has been reset. You can now sign in.' });
  } catch (error) {
    console.error('Password reset failed:', error instanceof Error ? error.message : error);
    response.status(500).json({ error: 'Unable to reset your password. Please try again.' });
  }
});

router.post('/change-initial-password', authenticate, csrfProtection, async (request, response) => {
  try {
    if (request.auth?.accountType !== 'employee') return response.status(403).json({ error: 'Employee account required' });
    const newPassword = request.body?.newPassword;
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 32) {
      return response.status(400).json({ error: 'Your new password must be between 8 and 32 characters.' });
    }
    const account = request.auth.actor;
    if (account.mustChangePassword !== true) return response.status(409).json({ error: 'This temporary password has already been replaced.' });
    if (await verifySecret(newPassword, account.passwordHash)) {
      return response.status(400).json({ error: 'Choose a password different from your temporary password.' });
    }
    const changedAt = new Date();
    await mongoose.connection.db.collection('employee_accounts').updateOne(
      { _id: account._id, mustChangePassword: true },
      { $set: { passwordHash: await hashSecret(newPassword), mustChangePassword: false, passwordChangedAt: changedAt, updatedAt: changedAt } },
    );
    await auditEvent({ req: request, actor: account, action: 'auth.initial_password_changed', targetType: 'employee_account', targetId: account.employeeId, outcome: 'success' });
    response.json({ changed: true });
  } catch (error) {
    console.error('Initial password change failed:', error instanceof Error ? error.message : error);
    response.status(500).json({ error: 'Unable to save your new password. Please try again.' });
  }
});

router.post('/verify-password', authenticate, csrfProtection, async (request, response) => {
  const token = getRequestToken(request)?.token;
  const password = request.body?.password;
  if (!token || !password) return response.status(400).json({ error: 'Password is required' });
  const db = mongoose.connection.db;
  const tokenDigest = crypto.createHash('sha256').update(token).digest('hex');
  const session = await db.collection('admin_sessions').findOne({ tokenDigest, expiresAt: { $gt: new Date() } });
  if (!session) return response.status(401).json({ error: 'Your session has expired' });
  const admin = request.auth.actor;
  const verification = await verifyAdminPassword(request, password);
  if (verification.forbidden) return response.status(403).json({ error: 'Administrator access required' });
  if (!verification.valid) {
    await auditEvent({ req: request, actor: admin, action: 'auth.password_verify', targetType: 'admin_controls', outcome: 'failure' });
    if (!verification.retryAfterSeconds) return response.status(401).json({ error: 'Incorrect admin password' });
    response.setHeader('Retry-After', String(verification.retryAfterSeconds));
    return response.status(429).json({ error: `Incorrect admin password. Try again in ${verification.retryAfterSeconds} seconds.`, retryAfterSeconds: verification.retryAfterSeconds });
  }
  await auditEvent({ req: request, actor: admin, action: 'auth.password_verify', targetType: 'admin_controls', outcome: 'success' });
  response.json({ verified: true });
});

router.post('/logout', authenticate, csrfProtection, async (request, response) => {
  const token = getRequestToken(request)?.token;
  if (token) {
    const tokenDigest = crypto.createHash('sha256').update(token).digest('hex');
    await mongoose.connection.db.collection('admin_sessions').deleteOne({ tokenDigest });
  }
  await auditEvent({ req: request, actor: request.auth?.actor, action: 'auth.logout', targetType: 'session', outcome: 'success' });
  clearSessionCookie(response);
  response.status(204).end();
});

export default router;
