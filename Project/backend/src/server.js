import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import apiRouter, { enforceAutomaticAbsences, enforceAutomaticClockOut, getSettings } from './routes/api.js';
import authRouter from './routes/auth.js';
import { securityHeaders } from './security.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const mongoUri = process.env.MONGODB_URI;
const AUDIT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

async function ensureAuditRetentionIndex(db) {
  const collection = db.collection('audit_events');
  const indexes = await collection.listIndexes().toArray().catch((error) => {
    if (error?.codeName === 'NamespaceNotFound') return [];
    throw error;
  });
  const occurredAtIndex = indexes.find((index) => index.key?.occurredAt === -1 && Object.keys(index.key).length === 1);
  if (occurredAtIndex && occurredAtIndex.expireAfterSeconds !== AUDIT_RETENTION_SECONDS) {
    await db.command({ collMod: 'audit_events', index: { name: occurredAtIndex.name, expireAfterSeconds: AUDIT_RETENTION_SECONDS } });
    return;
  }
  if (!occurredAtIndex) {
    await collection.createIndex(
      { occurredAt: -1 },
      { expireAfterSeconds: AUDIT_RETENTION_SECONDS, name: 'audit_events_90_day_ttl' },
    );
  }
}

app.set('trust proxy', 1);
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173', credentials: true, allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'] }));
app.use(securityHeaders);
app.use((req, res, next) => { req.requestId = crypto.randomUUID(); res.setHeader('X-Request-ID', req.requestId); next(); });
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https' && !req.secure) return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
  next();
});
// Raw WebSDK samples are base64url-wrapped more than once. Four 500-DPI scans
// can therefore exceed 2 MB even though the decoded images are much smaller.
// The matcher separately caps each decoded sample at 1 MB, and raw images are
// converted to templates immediately rather than persisted.
app.use(express.json({ limit: '6mb' }));
app.use('/api/auth', authRouter);

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

app.use('/api', apiRouter);

app.use((error, _request, response, _next) => {
  if (error?.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Fingerprint scan upload is too large. Restart enrollment and capture four new scans.' });
  }
  if (error instanceof SyntaxError && 'body' in error) {
    return response.status(400).json({ error: 'Invalid JSON request body' });
  }
  console.error('Unhandled API error:', error instanceof Error ? error.message : error);
  response.status(500).json({ error: 'Unexpected server error' });
});

async function startServer() {
  if (!mongoUri) {
    console.error('Missing MONGODB_URI. Create backend/.env from backend/.env.example.');
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB Atlas.');
    // The API can serve requests as soon as MongoDB is connected. Index checks
    // and attendance housekeeping run afterward so a restart never holds the
    // whole application hostage to a large historical reconciliation.
    app.listen(port, () => console.log(`Server is running on http://localhost:${port}`));
    try {
      const db = mongoose.connection.db;
      await Promise.all([
        db.collection('login_captchas').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection('login_otps').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection('password_reset_otps').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection('password_reset_otps').createIndex({ verificationId: 1 }, { unique: true }),
        db.collection('admin_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection('admin_sessions').createIndex({ tokenDigest: 1 }, { unique: true }),
        db.collection('admin_accounts').createIndex({ email: 1 }, { unique: true }),
        db.collection('employee_accounts').createIndex({ email: 1 }, { unique: true }),
        db.collection('employee_accounts').createIndex({ employeeId: 1 }, { unique: true }),
        ensureAuditRetentionIndex(db),
        db.collection('employees').createIndex({ id: 1 }, { unique: true, name: 'employee_id_unique' }),
        db.collection('employees').createIndex({ archived: 1, status: 1 }),
        db.collection('biometric_templates').createIndex({ employeeId: 1 }, { unique: true, name: 'biometric_employee_unique' }),
        db.collection('attendance').createIndex({ employeeId: 1, date: 1 }, { unique: true }),
        db.collection('attendance').createIndex({ date: -1 }),
        db.collection('leave_requests').createIndex({ employeeId: 1, createdAt: -1 }),
        db.collection('leave_requests').createIndex({ status: 1, startDate: 1, endDate: 1 }),
        db.collection('payroll_requests').createIndex({ employeeId: 1, createdAt: -1 }),
        db.collection('payroll_requests').createIndex({ employeeId: 1, periodStart: 1, status: 1 }),
        db.collection('payroll_requests').createIndex({ periodStart: 1, status: 1 }),
        // Preparing payroll can be triggered by both employee and admin pages.
        // This prevents two unpaid statements for the same employee and period.
        db.collection('payroll_requests').createIndex(
          { employeeId: 1, periodStart: 1 },
          { unique: true, partialFilterExpression: { status: { $in: ['processing', 'rejected'] } }, name: 'one_unpaid_payroll_per_period' },
        ),
        db.collection('biometric_verification_attempts').createIndex({ createdAt: -1 }),
        db.collection('biometric_evaluation_trials').createIndex({ createdAt: -1 }),
      ]);
    } catch (error) {
      console.error('Security index setup failed:', error instanceof Error ? error.message : error);
    }
    let clockOutJobRunning = false;
    let absenceJobRunning = false;
    const enforceAutomaticClockOutSafely = async () => {
      if (clockOutJobRunning) return;
      clockOutJobRunning = true;
      try {
        const settings = await getSettings(mongoose.connection.db);
        await enforceAutomaticClockOut(mongoose.connection.db, settings);
      } catch (error) {
        console.error('Automatic clock-out check failed:', error instanceof Error ? error.message : error);
      } finally {
        clockOutJobRunning = false;
      }
    };
    const enforceAutomaticAbsencesSafely = async () => {
      if (absenceJobRunning) return;
      absenceJobRunning = true;
      try {
        const settings = await getSettings(mongoose.connection.db);
        await enforceAutomaticAbsences(mongoose.connection.db, settings);
      } catch (error) {
        console.error('Automatic absence check failed:', error instanceof Error ? error.message : error);
      } finally {
        absenceJobRunning = false;
      }
    };
    void enforceAutomaticClockOutSafely();
    void enforceAutomaticAbsencesSafely();
    setInterval(() => void enforceAutomaticClockOutSafely(), 60_000);
    setInterval(() => void enforceAutomaticAbsencesSafely(), 15 * 60_000);
  } catch (error) {
    console.error('MongoDB connection failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

startServer();
