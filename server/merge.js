'use strict';
// Pure, commutative merge of two AquaSense documents. Used by the server so that
// any device can push its full state and get the reconciled state back.

const ts = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function newer(a, b, field) {
  return ts(b[field]) > ts(a[field]) ? b : a;
}

function merge(a, b) {
  a = a || {}; b = b || {};
  const deleted = [...new Set([...(a.deleted || []), ...(b.deleted || [])])].slice(-5000);
  const gone = new Set(deleted);

  const drinks = new Map();
  for (const d of [...(a.drinks || []), ...(b.drinks || [])]) {
    if (d && !gone.has(d.id) && !drinks.has(d.id)) drinks.set(d.id, d);
  }

  const uro = new Map();
  for (const u of [...(a.uro || []), ...(b.uro || [])]) {
    if (u) uro.set(`${u.ts}:${u.level}`, u);
  }

  const urination = {};
  const days = new Set([...Object.keys(a.urination || {}), ...Object.keys(b.urination || {})]);
  for (const day of days) {
    const x = (a.urination || {})[day], y = (b.urination || {})[day];
    urination[day] = !x ? y : !y ? x : ts(y.updatedAt) > ts(x.updatedAt) ? y : x;
  }

  const t = newer(a, b, 'targetUpdatedAt'), tOther = t === a ? b : a;
  const r = newer(a, b, 'remindersUpdatedAt'), rOther = r === a ? b : a;
  return {
    target: t.target ?? tOther.target ?? 2000,
    targetUpdatedAt: ts(t.targetUpdatedAt),
    reminders: r.reminders ?? rOther.reminders,
    remindersUpdatedAt: ts(r.remindersUpdatedAt),
    drinks: [...drinks.values()].sort((p, q) => p.ts - q.ts),
    uro: [...uro.values()].sort((p, q) => p.ts - q.ts).slice(-200),
    urination,
    deleted,
  };
}

// Reject malformed client payloads before they reach storage.
function validate(doc) {
  const bad = m => { throw Object.assign(new Error(m), { status: 400 }); };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) bad('invalid document');
  if (doc.target !== undefined && !(Number.isInteger(doc.target) && doc.target >= 500 && doc.target <= 6000)) bad('invalid target');
  for (const d of doc.drinks || []) {
    if (!d || !Number.isFinite(d.id) || !Number.isFinite(d.ts) || !Number.isInteger(d.ml) || d.ml <= 0 || d.ml > 5000 || typeof d.label !== 'string' || d.label.length > 60) bad('invalid drink');
  }
  for (const u of doc.uro || []) {
    if (!u || !Number.isFinite(u.ts) || !Number.isInteger(u.level) || u.level < 1 || u.level > 6) bad('invalid uro');
  }
  if (doc.urination && typeof doc.urination !== 'object') bad('invalid urination');
  for (const [k, v] of Object.entries(doc.urination || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== 'object') bad('invalid urination day');
  }
  if (doc.deleted && (!Array.isArray(doc.deleted) || doc.deleted.some(x => !Number.isFinite(x)))) bad('invalid deleted');
  return doc;
}

module.exports = { merge, validate };
