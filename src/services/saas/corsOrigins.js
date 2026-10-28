const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Allowed browser origins: the customer app, the separate admin panel, any
 * extra CORS_ORIGINS, and white-label custom domains set on companies.
 */
let customDomains = new Set();
let loadedAt = 0;
const TTL = 5 * 60 * 1000;

function normalize(origin) {
  return String(origin || '').trim().replace(/\/+$/, '').toLowerCase();
}

async function refreshCustomDomains() {
  try {
    const Organization = require('../../models/Organization');
    const orgs = await Organization.find({ 'branding.customDomain': { $nin: [null, ''] } }).select('branding.customDomain').lean();
    customDomains = new Set(orgs.map((o) => normalize(o.branding.customDomain.startsWith('http') ? o.branding.customDomain : `https://${o.branding.customDomain}`)));
    loadedAt = Date.now();
  } catch (err) {
    logger.warn('[cors] Could not load custom domains', { error: err.message });
  }
}

function staticOrigins() {
  return new Set([env.clientUrl, env.adminUrl, ...env.extraOrigins].map(normalize));
}

function isAllowed(origin) {
  if (!origin) return true; // server-to-server / same-origin
  if (Date.now() - loadedAt > TTL) refreshCustomDomains();
  const o = normalize(origin);
  return staticOrigins().has(o) || customDomains.has(o);
}

function corsOptions() {
  return {
    credentials: true,
    origin(origin, cb) {
      cb(null, isAllowed(origin));
    },
  };
}

module.exports = { isAllowed, corsOptions, refreshCustomDomains, normalize };
