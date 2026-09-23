import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePayrollRecord } from './routes/api.js';

const employee = { id: 'EMP-018', name: 'Test Employee', role: 'regular' };
const periodStart = '2026-09-16';
const conflict = () => Object.assign(new Error('duplicate payroll'), { code: 11000, keyPattern: { employeeId: 1, periodStart: 1 } });

function database({ error, winner } = {}) {
  const writes = [];
  let inserted = false;
  const payroll = {
    find: (query) => ({ toArray: async () => typeof query.periodStart === 'string' ? [] : [{ _id: 'old', amount: 100 }] }),
    findOne: async () => inserted ? winner : null,
    insertOne: async (record) => { inserted = true; writes.push(record); if (error) throw error; },
    updateMany: async (filter, update) => { writes.push({ filter, update }); },
  };
  return { writes, collection: (name) => name === 'payroll_requests' ? payroll : { find: () => ({ toArray: async () => [] }) } };
}

test('a concurrent insert returns the winning payroll without relinking carry-over', async () => {
  const winner = { id: 'PR-winner', employeeId: employee.id, periodStart, status: 'processing', amount: 100 };
  const db = database({ error: conflict(), winner });
  const result = await preparePayrollRecord(db, employee, periodStart, {});
  assert.equal(result.created, false);
  assert.deepEqual(result.record, winner);
  assert.equal(db.writes.length, 1);
});

test('the creator links outstanding balances to its new payroll once', async () => {
  const db = database();
  const result = await preparePayrollRecord(db, employee, periodStart, {});
  assert.equal(result.created, true);
  assert.equal(result.record.carryOverAmount, 100);
  assert.equal(db.writes.length, 2);
  assert.equal(db.writes[1].update.$set.rolledInto, result.record.id);
});

test('unrelated duplicate keys and database failures are not hidden', async () => {
  for (const error of [Object.assign(new Error('duplicate id'), { code: 11000, keyPattern: { id: 1 } }), new Error('database unavailable')]) {
    await assert.rejects(preparePayrollRecord(database({ error }), employee, periodStart, {}), (caught) => caught === error);
  }
});

test('a conflict without a surviving payroll still reports the failure', async () => {
  const error = conflict();
  await assert.rejects(preparePayrollRecord(database({ error }), employee, periodStart, {}), (caught) => caught === error);
});
