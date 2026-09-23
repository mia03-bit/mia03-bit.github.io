import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { hashSecret } from './src/routes/auth.js';

dotenv.config();
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!process.env.MONGODB_URI || !email || !password) {
  console.error('MONGODB_URI, ADMIN_EMAIL, and ADMIN_PASSWORD are required.');
  process.exit(1);
}

try {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.db.collection('admin_accounts').updateOne(
    { email },
    { $set: { email, passwordHash: await hashSecret(password), role: 'admin', active: true, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  console.log('Admin account created or updated.');
} finally {
  await mongoose.disconnect();
}
