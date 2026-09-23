import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const email = 'deocaresemman01@gmail.com';
const employeeId = 'EMP-014';
const seedTag = 'deocares-payroll-attendance-v1';
const dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is required in backend/.env');
  process.exit(1);
}

const now = new Date();
const attendance = dates.map((date) => ({
  employeeId,
  name: 'testing 20',
  role: 'Regular',
  date,
  checkIn: '08:00 AM',
  checkOut: '05:00 PM',
  sessions: [{
    checkIn: '08:00 AM',
    checkOut: '05:00 PM',
    checkInAt: `${date}T00:00:00.000Z`,
    checkOutAt: `${date}T09:00:00.000Z`,
    captureMethod: 'seed',
  }],
  sessionCount: 1,
  status: 'Present',
  captureMethod: 'payroll-test-seed',
  seedTag,
  createdAt: now,
  updatedAt: now,
}));

const client = new MongoClient(process.env.MONGODB_URI);
try {
  await client.connect();
  const db = client.db();
  const employee = await db.collection('employees').findOne({ id: employeeId, email, archived: { $ne: true } });
  if (!employee) throw new Error(`Active employee ${employeeId} with email ${email} was not found.`);

  await db.collection('attendance').deleteMany({ employeeId, date: { $in: dates } });
  await db.collection('attendance').insertMany(attendance);

  console.log(`Seeded ${attendance.length} completed attendance days for ${email} (${employeeId}).`);
  console.log(`Dates: ${dates[0]} through ${dates.at(-1)}`);
  console.log(`Seed tag: ${seedTag}`);
} catch (error) {
  console.error('Deocares attendance seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.close();
}