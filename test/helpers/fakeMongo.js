/**
 * Minimal in-memory stand-in for a Mongoose model, for smoke tests that must
 * run WITHOUT a database. Every operation is atomic (like a single MongoDB
 * document operation) but yields to the event loop first, so parallel callers
 * really interleave. Supports the few operators the billing / minutes code uses:
 *   filters: equality, dotted paths, $in $ne $exists $lt $lte $gt $gte $or $and
 *   updates: $set $inc $unset $push $setOnInsert (+ upsert)
 * NOT a MongoDB replacement: real-DB behaviour (indexes, casting) is not covered.
 */
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v), (k, x) => (typeof x === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(x) ? new Date(x) : x)));

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k) => { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; });
  o[keys[keys.length - 1]] = value;
}
function unsetPath(obj, path) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) { if (o[k] == null) return; o = o[k]; }
  delete o[keys[keys.length - 1]];
}
const same = (a, b) => (a instanceof Date || b instanceof Date ? new Date(a).getTime() === new Date(b).getTime() : String(a) === String(b));

function matchValue(actual, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond) && Object.keys(cond).some((k) => k.startsWith('$'))) {
    return Object.entries(cond).every(([op, v]) => {
      if (op === '$in') return v.some((x) => (x === null ? actual == null : same(actual, x)));
      if (op === '$ne') return !(v === null ? actual == null : same(actual, v));
      if (op === '$exists') return v ? actual !== undefined : actual === undefined;
      if (op === '$lt') return actual != null && actual < v;
      if (op === '$lte') return actual != null && actual <= v;
      if (op === '$gt') return actual != null && actual > v;
      if (op === '$gte') return actual != null && actual >= v;
      throw new Error(`fakeMongo: unsupported operator ${op}`);
    });
  }
  if (cond === null) return actual == null;
  return actual !== undefined && same(actual, cond);
}
function matches(doc, filter) {
  return Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    if (k === '$and') return cond.every((f) => matches(doc, f));
    return matchValue(getPath(doc, k), cond);
  });
}
function applyUpdate(doc, update) {
  const u = update.$set || update.$inc || update.$unset || update.$push || update.$setOnInsert ? update : { $set: update };
  Object.entries(u.$setOnInsert || {}).forEach(([k, v]) => { if (getPath(doc, k) === undefined) setPath(doc, k, clone(v)); });
  Object.entries(u.$set || {}).forEach(([k, v]) => setPath(doc, k, clone(v)));
  Object.entries(u.$inc || {}).forEach(([k, v]) => setPath(doc, k, (Number(getPath(doc, k)) || 0) + v));
  Object.keys(u.$unset || {}).forEach((k) => unsetPath(doc, k));
  Object.entries(u.$push || {}).forEach(([k, v]) => { const a = getPath(doc, k) || []; a.push(clone(v)); setPath(doc, k, a); });
}

let seq = 0;
function createFake({ defaults = () => ({}) } = {}) {
  const docs = [];
  const tick = () => new Promise((r) => setImmediate(r));
  const query = (fn) => {
    const q = { select: () => q, lean: () => q, sort: () => q, limit: () => q, populate: () => q, then: (res, rej) => fn().then(res, rej), catch: (f) => fn().catch(f) };
    return q;
  };
  const api = {
    docs,
    seed(doc) { const d = { _id: doc._id || `id${++seq}`, ...doc }; docs.push(clone(d)); return d; },
    find: (filter) => query(async () => { await tick(); return docs.filter((d) => matches(d, filter)).map(clone); }),
    findOne: (filter) => query(async () => { await tick(); const d = docs.find((x) => matches(x, filter)); return d ? clone(d) : null; }),
    countDocuments: (filter) => query(async () => { await tick(); return docs.filter((d) => matches(d, filter)).length; }),
    findById: (id) => query(async () => { await tick(); const d = docs.find((x) => String(x._id) === String(id)); return d ? clone(d) : null; }),
    updateOne: (filter, update, opts = {}) => query(async () => {
      await tick();
      let d = docs.find((x) => matches(x, filter));
      if (!d && opts.upsert) { d = { _id: filter._id || `id${++seq}` }; docs.push(d); }
      if (!d) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(d, update);
      return { matchedCount: 1, modifiedCount: 1 };
    }),
    findOneAndUpdate: (filter, update, opts = {}) => query(async () => {
      await tick();
      let d = docs.find((x) => matches(x, filter));
      let created = false;
      if (!d && opts.upsert) { d = { _id: filter._id || `id${++seq}` }; docs.push(d); created = true; }
      if (!d) return null;
      const before = clone(d);
      applyUpdate(d, update);
      return opts.new === false ? (created ? null : before) : clone(d);
    }),
    create: async (data) => {
      await tick();
      const d = { _id: data._id || `id${++seq}`, ...defaults(), ...clone(data) };
      if (d.invoiceNumber !== undefined && docs.some((x) => x.invoiceNumber === d.invoiceNumber)) throw new Error('E11000 duplicate key');
      docs.push(d);
      return { ...clone(d), toObject() { return clone(d); } };
    },
    // Installs these methods on a real Mongoose model (the model's other behaviour is untouched).
    install(Model) {
      for (const m of ['find', 'findOne', 'findById', 'countDocuments', 'updateOne', 'findOneAndUpdate', 'create']) Model[m] = api[m];
      return api;
    },
  };
  return api;
}

module.exports = { createFake, matches };
