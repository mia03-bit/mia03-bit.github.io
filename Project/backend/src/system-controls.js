export const defaultSystemControls = {
  maintenanceMode: false,
  registrationOpen: true,
};

export async function getSystemControls(db) {
  const stored = await db.collection('system_controls').findOne({ key: 'global' });
  return {
    maintenanceMode: Boolean(stored?.maintenanceMode),
    registrationOpen: stored?.registrationOpen !== false,
    updatedAt: stored?.updatedAt ?? null,
    updatedBy: stored?.updatedBy ?? null,
  };
}

export async function updateSystemControls(db, changes, actorEmail) {
  const allowed = {};
  if (Object.hasOwn(changes, 'maintenanceMode')) allowed.maintenanceMode = Boolean(changes.maintenanceMode);
  if (Object.hasOwn(changes, 'registrationOpen')) allowed.registrationOpen = Boolean(changes.registrationOpen);
  const updatedAt = new Date();
  await db.collection('system_controls').updateOne(
    { key: 'global' },
    { $set: { ...allowed, updatedAt, updatedBy: actorEmail || null }, $setOnInsert: { key: 'global', createdAt: updatedAt } },
    { upsert: true },
  );
  return getSystemControls(db);
}
