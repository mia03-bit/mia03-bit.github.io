import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();
if (!process.env.MONGODB_URI) {
  console.error('Missing MONGODB_URI in backend/.env');
  process.exit(1);
}

try {
  await mongoose.connect(process.env.MONGODB_URI);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const events = await mongoose.connection.db.collection('audit_events').find({
    occurredAt: { $gte: since },
    $or: [
      { outcome: 'failure' },
      { action: { $in: ['auth.login', 'auth.otp_verify', 'api.post', 'api.put', 'api.patch', 'api.delete'] } },
    ],
  }).sort({ occurredAt: -1 }).limit(100).toArray();

  console.table(events.map((event) => ({
    time: event.occurredAt?.toISOString(),
    actor: event.actorEmail ?? 'anonymous',
    role: event.actorRole,
    action: event.action,
    target: [event.targetType, event.targetId].filter(Boolean).join(':'),
    outcome: event.outcome,
    status: event.metadata?.statusCode ?? '',
    ip: event.ip,
  })));
  console.log(`Important audit events (last 7 days): ${events.length}`);
} catch (error) {
  console.error('Audit report failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
