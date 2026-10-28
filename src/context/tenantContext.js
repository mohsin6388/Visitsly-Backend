const { AsyncLocalStorage } = require('async_hooks');

/**
 * Tenant (organization) context for the multi-tenant SaaS.
 *
 * Every HTTP request, webhook delivery, queued job and scheduler tick runs
 * inside `run(org, fn)`. Code anywhere below it (Meta client, settings
 * service, AI engine, mailer) can ask "which company am I working for?"
 * without the org being threaded through every function signature.
 *
 * The store holds a plain snapshot of the org (with decrypted WhatsApp
 * credentials) — never a Mongoose document — so it is safe to read from
 * concurrent async chains.
 */
const als = new AsyncLocalStorage();

function run(org, fn) {
  return als.run({ org }, fn);
}

/** Same company, but send from one specific (extra) WhatsApp number. */
function runWithNumber(phoneNumberId, fn) {
  const cur = als.getStore();
  if (!cur || !phoneNumberId) return fn();
  return als.run({ ...cur, phoneNumberId: String(phoneNumberId) }, fn);
}

function numberOverride() {
  return als.getStore()?.phoneNumberId || null;
}

function get() {
  return als.getStore() || null;
}

function getOrg() {
  return get()?.org || null;
}

function orgId() {
  return getOrg()?._id || null;
}

/** The workspace owner id that every tenant record is stored under (ownerId). */
function ownerId() {
  return getOrg()?.ownerUserId || null;
}

module.exports = { run, runWithNumber, numberOverride, get, getOrg, orgId, ownerId, als };

// Register the auto-scoping plugin before any model is compiled (this module
// is loaded by config/env.js, which every entry point loads first).
try {
  require('mongoose').plugin(require('./tenantScopePlugin'));
} catch (err) {
  // mongoose not installed (e.g. a tooling context) — nothing to scope.
}
