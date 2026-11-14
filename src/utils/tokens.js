const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');

/**
 * Access token: short-lived, sent in Authorization header, carries identity + role.
 */
function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
    },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessExpiresIn }
  );
}

/**
 * Refresh token: long-lived, stored ONLY as a hash on the user document,
 * delivered to the client via httpOnly cookie. Rotated on every refresh.
 */
function signRefreshToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
    env.jwt.refreshSecret,
    { expiresIn: env.jwt.refreshExpiresIn }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Generic random token for password reset / email verification links */
function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

/* ---- Separate PropAI admin panel ---- */
function signAdminAccessToken(user) {
  return jwt.sign({ sub: user._id.toString(), aud: 'propai-admin' }, env.jwt.adminAccessSecret, { expiresIn: '2h' });
}

function signAdminRefreshToken(user) {
  return jwt.sign({ sub: user._id.toString(), aud: 'propai-admin', tokenVersion: user.tokenVersion || 0 }, env.jwt.adminRefreshSecret, { expiresIn: '7d' });
}

function verifyAdminAccessToken(token) {
  return jwt.verify(token, env.jwt.adminAccessSecret, { audience: 'propai-admin' });
}

function verifyAdminRefreshToken(token) {
  return jwt.verify(token, env.jwt.adminRefreshSecret, { audience: 'propai-admin' });
}

/**
 * Support session: a short-lived CUSTOMER-app token that lets a PropAI admin
 * open one company (no refresh token, 60 minutes, fully audited).
 */
function signSupportToken(adminUser, orgId) {
  return jwt.sign(
    { sub: adminUser._id.toString(), typ: 'support', org: String(orgId) },
    env.jwt.accessSecret,
    { expiresIn: '60m' }
  );
}

module.exports = {
  signAdminAccessToken,
  signAdminRefreshToken,
  verifyAdminAccessToken,
  verifyAdminRefreshToken,
  signSupportToken,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  generateRawToken,
};
