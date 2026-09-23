import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import router from './routes/api.js';
import { hashSecret } from './routes/auth.js';

const handler = (path) => router.stack.find((layer) => layer.route?.path === path && layer.route.methods.post).route.stack.at(-1).handle;
const employee = { firstName: 'Test', lastName: 'Employee', email: 'person@example.test', phone: '+639123456789', address: 'Test address' };
const request = (body) => ({ body, auth: { actor: { email: 'admin@example.test' } } });
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('employee registration requires inbox verification', async (t) => {
  const originalDb = mongoose.connection.db;
  const originalTransport = nodemailer.createTransport;
  const originalUser = process.env.SMTP_USER;
  const originalPassword = process.env.SMTP_APP_PASSWORD;
  process.env.SMTP_USER = 'sender@example.test';
  process.env.SMTP_APP_PASSWORD = 'test-only';
  t.after(() => {
    mongoose.connection.db = originalDb;
    nodemailer.createTransport = originalTransport;
    if (originalUser === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = originalUser;
    if (originalPassword === undefined) delete process.env.SMTP_APP_PASSWORD; else process.env.SMTP_APP_PASSWORD = originalPassword;
  });
  let record;
  let sentMessage;
  mongoose.connection.db = { collection(name) {
    if (name === 'employee_email_verifications') return {
      createIndex: async () => {},
      insertOne: async (value) => { record = { ...value, _id: 'verification' }; },
      findOneAndUpdate: async (filter) => {
        if (!record || record.verificationId !== filter.verificationId || record.email !== filter.email || record.requestedBy !== filter.requestedBy || record.expiresAt <= filter.expiresAt.$gt || record.attempts >= filter.attempts.$lt) return null;
        record.attempts += 1;
        return { ...record };
      },
    };
    // Any account writes or biometric work would fail this mock and the assertion.
    return { findOne: async () => null };
  } };
  nodemailer.createTransport = () => ({ sendMail: async (message) => { sentMessage = message; return { accepted: [employee.email] }; } });

  await t.test('mail acceptance only issues a challenge, without creating an employee', async () => {
    const res = response();
    await handler('/employees/email-verification')(request({ email: employee.email }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.verificationId, record.verificationId);
    assert.equal(res.body.loginEmailSent, undefined);
    assert.match(sentMessage.text, /\b\d{6}\b/);
    assert.equal(res.body.code, undefined);
    assert.ok(record.codeHash.includes(':'));
  });
  await t.test('direct creation without a code is rejected', async () => {
    const res = response();
    await handler('/employees')(request(employee), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /six-digit/);
  });
  record.codeHash = await hashSecret('123456');
  const payload = { ...employee, emailVerificationId: record.verificationId, emailVerificationCode: '654321' };
  await t.test('wrong codes consume attempts and never create accounts', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = response();
      await handler('/employees')(request(payload), res);
      assert.equal(res.statusCode, 400);
    }
    assert.equal(record.attempts, 5);
    const res = response();
    await handler('/employees')(request({ ...payload, emailVerificationCode: '123456' }), res);
    assert.equal(res.statusCode, 400);
  });
  for (const scenario of ['expired', 'changed email', 'different admin', 'consumed']) {
    await t.test(`rejects a valid code when ${scenario}`, async () => {
      record.attempts = 0;
      const saved = { ...record };
      const req = request({ ...payload, emailVerificationCode: '123456' });
      if (scenario === 'expired') record.expiresAt = new Date(0);
      if (scenario === 'changed email') req.body.email = 'someone-else@example.test';
      if (scenario === 'different admin') req.auth.actor.email = 'other-admin@example.test';
      if (scenario === 'consumed') record = null;
      const res = response();
      await handler('/employees')(req, res);
      assert.equal(res.statusCode, 400);
      record = saved;
    });
  }
});
