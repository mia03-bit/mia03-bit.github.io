import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { hashSecret } from './src/routes/auth.js';

dotenv.config();

const SEED_TAG = 'attendance-red-flag-test-v1';
const email = 'testing@gmail.com';
const password = 'hello123';
const employeeId = 'TEST-RED-FLAG-001';
const absenceStart = '2026-08-15';
const absenceEnd = '2026-09-09';
const DAY_MS = 86_400_000;

function datesBetween(start, end) {
  const dates = [];
  for (let date = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`); date <= last; date = new Date(date.getTime() + DAY_MS)) {
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is required in backend/.env');
  process.exit(1);
}

try {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const now = new Date();
  const dates = datesBetween(absenceStart, absenceEnd);

  const existingEmployee = await db.collection('employees').findOne({ email });
  if (existingEmployee && existingEmployee.seedTag !== SEED_TAG) {
    throw new Error(`Refusing to modify an existing non-test employee with email ${email}.`);
  }

  const existingAccount = await db.collection('employee_accounts').findOne({ email });
  if (existingAccount && existingAccount.employeeId !== employeeId) {
    throw new Error(`Refusing to modify an existing non-test account with email ${email}.`);
  }

  const employee = {
    id: employeeId,
    name: 'Attendance Red Flag Test',
    firstName: 'Attendance',
    lastName: 'Test',
    email,
    role: 'regular',
    status: 'active',
    phone: '',
    address: 'Test-only record — safe to remove with its seed tag.',
    hourlyRate: 50,
    grossSalary: 0,
    casualLeave: { total: 10, used: 0 },
    sickLeave: { total: 10, used: 0 },
    biometricStatus: 'none',
    identifiers: [],
    seedTag: SEED_TAG,
    updatedAt: now,
  };

  await db.collection('employees').updateOne(
    { id: employeeId },
    { $set: employee, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  await db.collection('employee_accounts').updateOne(
    { email },
    { $set: { employeeId, email, passwordHash: await hashSecret(password), role: 'regular', active: true, mustChangePassword: false, seedTag: SEED_TAG, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  await db.collection('attendance').deleteMany({ employeeId, seedTag: SEED_TAG });
  await db.collection('attendance').insertMany(dates.map((date) => ({
    employeeId,
    name: employee.name,
    role: 'Regular',
    date,
    checkIn: null,
    checkOut: null,
    sessions: [],
    sessionCount: 0,
    status: 'Absent',
    automaticAbsence: false,
    captureMethod: 'test-seed',
    seedTag: SEED_TAG,
    createdAt: now,
    updatedAt: now,
  })));

  console.log(`Test employee seeded: ${email} (${employeeId})`);
  console.log(`Test absences: ${dates.length}, from ${absenceStart} through ${absenceEnd}`);
  console.log(`Seed tag: ${SEED_TAG}`);
} catch (error) {
  console.error('Red-flag test seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
