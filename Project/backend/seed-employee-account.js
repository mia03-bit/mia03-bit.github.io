import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { hashSecret } from './src/routes/auth.js';

dotenv.config();

const email = 'deocaresemman@gmail.com';
const password = 'hello123';
const name = 'Emmanuel Deocares';
const role = 'regular';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is required in backend/.env');
  process.exit(1);
}

try {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  let employee = await db.collection('employees').findOne({ email });

  if (!employee) {
    const records = await db.collection('employees').find({}, { projection: { id: 1 } }).toArray();
    const nextNumber = Math.max(0, ...records.map((record) => Number(String(record.id ?? '').match(/\d+/)?.[0] ?? 0))) + 1;
    const id = `EMP-${String(nextNumber).padStart(3, '0')}`;
    employee = {
      id, name, email, role, phone: '', address: '', hourlyRate: 50, grossSalary: 0,
      status: 'active', casualLeave: { total: 10, used: 0 }, sickLeave: { total: 10, used: 0 },
      biometricStatus: 'none', identifiers: [], createdAt: new Date(), updatedAt: new Date(),
    };
    await db.collection('employees').insertOne(employee);
  } else {
    await db.collection('employees').updateOne({ _id: employee._id }, { $set: { role, status: 'active', updatedAt: new Date() } });
  }

  await db.collection('employee_accounts').updateOne(
    { email },
    {
      $set: { employeeId: employee.id, email, passwordHash: await hashSecret(password), role, active: true, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  console.log(`Regular employee account created: ${email} (${employee.id})`);
} catch (error) {
  console.error('Employee account seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
