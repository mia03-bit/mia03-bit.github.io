export function clockOutSessions(record) {
  return Array.isArray(record.sessions) && record.sessions.length
    ? record.sessions
    : record.checkIn ? [{ checkIn: record.checkIn, checkOut: record.checkOut || null }] : [];
}

export function forcedClockOutUpdate(record, stamp, actorEmail) {
  if (record.date !== stamp.date) return null;
  const original = clockOutSessions(record);
  if (!original.some((session) => session.checkIn && !session.checkOut)) return null;
  const sessions = original.map((session) => session.checkIn && !session.checkOut
    ? { ...session, checkOut: stamp.time, checkOutAt: stamp.now, forcedClockOut: true, forcedClockOutBy: actorEmail }
    : { ...session });
  return {
    filter: {
      _id: record._id, date: stamp.date,
      updatedAt: record.updatedAt ?? { $exists: false },
      sessions: record.sessions ?? { $exists: false },
      checkOut: record.checkOut ?? null,
    },
    update: { $set: { sessions, sessionCount: sessions.length, checkOut: sessions.at(-1).checkOut, lastAction: 'time-out', forcedClockOut: true, forcedClockOutAt: stamp.now, forcedClockOutBy: actorEmail, updatedAt: stamp.now } },
  };
}
