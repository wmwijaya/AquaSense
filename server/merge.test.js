'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { merge, validate } = require('./merge');

const drink = (id, ml = 200) => ({ id, ts: id, ml, label: 'Gelas' });

test('unions drinks from two devices without duplicates', () => {
  const m = merge({ drinks: [drink(1), drink(2)] }, { drinks: [drink(2), drink(3)] });
  assert.deepStrictEqual(m.drinks.map(d => d.id), [1, 2, 3]);
});

test('deletes propagate and are not resurrected by a stale device', () => {
  const server = merge({ drinks: [drink(1), drink(2)] }, {});
  const a = { drinks: [drink(2)], deleted: [1] };      // device A deleted 1
  const stale = { drinks: [drink(1), drink(2)] };      // device B still has it
  assert.deepStrictEqual(merge(merge(server, a), stale).drinks.map(d => d.id), [2]);
});

test('urination: newest updatedAt wins per day', () => {
  const a = { urination: { '2026-10-01': { count: 2, updatedAt: 10 } } };
  const b = { urination: { '2026-10-01': { count: 5, updatedAt: 20 }, '2026-10-02': { count: 1, updatedAt: 5 } } };
  const m = merge(a, b);
  assert.strictEqual(m.urination['2026-10-01'].count, 5);
  assert.strictEqual(m.urination['2026-10-02'].count, 1);
});

test('target: newest targetUpdatedAt wins, in either argument order', () => {
  const a = { target: 2500, targetUpdatedAt: 20 }, b = { target: 1800, targetUpdatedAt: 10 };
  assert.strictEqual(merge(a, b).target, 2500);
  assert.strictEqual(merge(b, a).target, 2500);
});

test('merge is commutative and idempotent', () => {
  const a = { drinks: [drink(1)], deleted: [9], uro: [{ ts: 1, level: 3 }], target: 2200, targetUpdatedAt: 5 };
  const b = { drinks: [drink(2), drink(9)], uro: [{ ts: 2, level: 4 }] };
  assert.deepStrictEqual(merge(a, b), merge(b, a));
  assert.deepStrictEqual(merge(merge(a, b), b), merge(a, b));
});

test('validate rejects bad input', () => {
  assert.throws(() => validate({ target: 99999 }), /target/);
  assert.throws(() => validate({ drinks: [{ id: 1, ts: 1, ml: -5, label: 'x' }] }), /drink/);
  assert.throws(() => validate({ uro: [{ ts: 1, level: 9 }] }), /uro/);
  assert.throws(() => validate(null), /document/);
  assert.doesNotThrow(() => validate({ target: 2000, drinks: [drink(1)], uro: [], urination: {}, deleted: [] }));
});

test('empty side never erases settings on a timestamp tie', () => {
  const full = { target: 2500, reminders: { enabled: false, times: [] } };
  for (const m of [merge({}, full), merge(full, {})]) {
    assert.strictEqual(m.target, 2500);
    assert.strictEqual(m.reminders.enabled, false);
  }
});
