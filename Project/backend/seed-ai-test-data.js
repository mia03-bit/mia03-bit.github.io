import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not defined in backend/.env');
  process.exit(1);
}

const SEED_TAG = 'workpulse-ai-demo-v1';
const DAY_MS = 86_400_000;
const pad = (value) => String(value).padStart(2, '0');
const dateKey = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const addDays = (date, amount) => new Date(date.getTime() + amount * DAY_MS);

function manilaToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}

const people = [
  ['AI-TEST-001', 'Maya', 'Santos', 'regular'],
  ['AI-TEST-002', 'Noah', 'Reyes', 'regular'],
  ['AI-TEST-003', 'Liam', 'Cruz', 'regular'],
  ['AI-TEST-004', 'Sofia', 'Garcia', 'regular'],
  ['AI-TEST-005', 'Ethan', 'Mendoza', 'extra'],
  ['AI-TEST-006', 'Ava', 'Lim', 'extra'],
];

function employeeDocuments(now) {
  return people.map(([id, firstName, lastName, role], index) => ({
    id, firstName, lastName, name: `${firstName} ${lastName}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}.ai-test@example.com`,
    phone: `+63917000${String(index + 1).padStart(4, '0')}`,
    address: 'AI analytics demonstration record', role, status: 'active',
    hourlyRate: role === 'regular' ? 50 : 40, grossSalary: 0,
    casualLeave: { total: 10, used: 0 }, sickLeave: { total: 10, used: 0 },
    biometricStatus: 'none', identifiers: [], seedTag: SEED_TAG,
    createdAt: now, updatedAt: now,
  }));
}

function attendanceDocuments(today, now) {
  const records = [];
  const start = addDays(today, -69);
  for (let offset = 0; offset < 70; offset += 1) {
    const date = addDays(start, offset);
    const dateString = dateKey(date);
    const weekday = date.getUTCDay();
    const weekend = weekday === 0 || weekday === 6;

    people.forEach(([employeeId, firstName, lastName, role], employeeIndex) => {
      const frequentAbsence = employeeId === 'AI-TEST-003' && [8, 17, 28, 39, 50, 61, 67].includes(offset);
      const occasionalAbsence = employeeId === 'AI-TEST-005' && [22, 47].includes(offset);
      const approvedLeave = employeeId === 'AI-TEST-006' && offset >= 54 && offset <= 56;
      const weekendOff = weekend && employeeIndex > 1;
      const absent = frequentAbsence || occasionalAbsence || approvedLeave || weekendOff;
      const unusualArrival = employeeId === 'AI-TEST-004' && offset === 68;
      const lateArrival = employeeId === 'AI-TEST-002' && [15, 34, 58].includes(offset);
      const normalMinute = (employeeIndex * 4 + offset % 5) % 18;
      const checkIn = unusualArrival ? '02:35 AM' : lateArrival ? '10:20 AM' : `08:${pad(normalMinute)} AM`;
      const checkOut = unusualArrival ? '11:30 AM' : '05:00 PM';
      const status = absent ? 'Absent' : lateArrival ? 'Late' : 'Present';
      const sessions = absent ? [] : [{ checkIn, checkOut }];
      records.push({
        employeeId, name: `${firstName} ${lastName}`, role: role === 'extra' ? 'Extra' : 'Regular',
        date: dateString, checkIn: absent ? null : checkIn, checkOut: absent ? null : checkOut,
        sessions, sessionCount: sessions.length, status,
        captureMethod: 'ai-demo-seed', seedTag: SEED_TAG, createdAt: now, updatedAt: now,
      });
    });
  }
  return records;
}

async function seedAIData() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    const now = new Date();
    const today = manilaToday();
    const employees = employeeDocuments(now);
    const attendance = attendanceDocuments(today, now);
    const leave = {
      id: 'AI-TEST-LEAVE-001', employeeId: 'AI-TEST-006', employeeName: 'Ava Lim',
      role: 'Extra', leaveType: 'Approved Leave', startDate: dateKey(addDays(today, -15)),
      endDate: dateKey(addDays(today, -13)), totalDays: 3,
      reason: 'Approved leave used to verify that Risk AI excludes authorized absences.',
      status: 'approved', seedTag: SEED_TAG, createdAt: now, reviewedAt: now,
    };

    await db.collection('attendance').deleteMany({ seedTag: SEED_TAG });
    await db.collection('leave_requests').deleteMany({ seedTag: SEED_TAG });
    await db.collection('employees').bulkWrite(employees.map((employee) => ({
      updateOne: { filter: { id: employee.id }, update: { $set: employee }, upsert: true },
    })));
    await db.collection('attendance').insertMany(attendance, { ordered: false });
    await db.collection('leave_requests').insertOne(leave);

    console.log(`AI demo data pushed to MongoDB successfully.`);
    console.log(`Employees: ${employees.length}`);
    console.log(`Attendance records: ${attendance.length}`);
    console.log(`Approved leave records: 1`);
    console.log(`Date window: ${dateKey(addDays(today, -69))} through ${dateKey(today)}`);
    console.log('Test employees use IDs AI-TEST-001 through AI-TEST-006.');
  } catch (error) {
    console.error('AI demo seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

void seedAIData();
