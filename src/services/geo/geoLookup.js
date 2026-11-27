const axios = require('axios');
const logger = require('../../utils/logger');
const { isCountryCode } = require('../../config/countries');

/**
 * Visitor country from the request — used only for defaults (dial code at
 * signup, country in onboarding, currency on the public Pricing page). It is
 * never trusted for anything security- or billing-critical: the customer
 * confirms the country in onboarding.
 *
 * Order:
 *   1. CF-IPCountry header (Cloudflare)
 *   2. x-vercel-ip-country header (Vercel)
 *   3. Optional lookup service: GEO_LOOKUP_URL, with "{ip}" replaced by the
 *      client IP, e.g. https://ipapi.co/{ip}/country/ or
 *      https://api.country.is/{ip}. Plain-text or JSON replies are accepted
 *      (country_code / countryCode / country / country.iso_code).
 *   4. null — callers fall back to the browser guess.
 *
 * Lookups time out after GEO_LOOKUP_TIMEOUT_MS (max 1500 ms) and results are
 * cached in memory per IP.
 */

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 5000;
const cache = new Map(); // ip -> { country, at }

function normalize(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  // Cloudflare uses XX (unknown) and T1 (Tor).
  if (c === 'XX' || c === 'T1') return null;
  return isCountryCode(c) ? c : null;
}

function isPrivateIp(ip) {
  const v = String(ip || '').replace(/^::ffff:/, '');
  if (!v || v === '::1' || v === '127.0.0.1') return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd|fe80)/i.test(v);
}

function fromBody(data) {
  if (!data) return null;
  if (typeof data === 'string') return normalize(data);
  return normalize(data.country_code || data.countryCode || data.country_iso || data.country?.iso_code || data.country);
}

function remember(ip, country) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(ip, { country, at: Date.now() });
}

async function lookupIp(ip) {
  const template = process.env.GEO_LOOKUP_URL;
  if (!template || isPrivateIp(ip)) return null;
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.country;
  const timeout = Math.min(Math.max(Number(process.env.GEO_LOOKUP_TIMEOUT_MS) || 1500, 200), 1500);
  try {
    const url = template.includes('{ip}') ? template.replace('{ip}', encodeURIComponent(ip)) : `${template.replace(/\/+$/, '')}/${encodeURIComponent(ip)}`;
    const { data } = await axios.get(url, { timeout, responseType: 'text', transformResponse: [(raw) => { try { return JSON.parse(raw); } catch { return raw; } }] });
    const country = fromBody(data);
    remember(ip, country);
    return country;
  } catch (err) {
    logger.debug?.('[geo] lookup failed', { error: err.message });
    remember(ip, null); // don't hammer the provider for the same IP
    return null;
  }
}

/** Never throws; returns an ISO country code or null. */
async function countryForRequest(req) {
  try {
    const header = normalize(req.get('cf-ipcountry')) || normalize(req.get('x-vercel-ip-country'));
    if (header) return header;
    return await lookupIp(req.ip); // `trust proxy` is set, so req.ip is the client IP
  } catch {
    return null;
  }
}

module.exports = { countryForRequest, _cache: cache };
