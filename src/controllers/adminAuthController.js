const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const env = require('../config/env');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { signAdminAccessToken, signAdminRefreshToken, verifyAdminRefreshToken, hashToken } = require('../utils/tokens');

const COOKIE = 'adminRefreshToken';

function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.cookie.secure,
    sameSite: env.cookie.sameSite || 'lax',
    domain: env.cookie.domain,
    path: '/api/admin-auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

const isSuper = (u) => Boolean(u && (u.isSuperAdmin || env.saas.superAdminEmails.includes(String(u.email).toLowerCase())));
const view = (u) => ({ id: String(u._id), name: u.name, email: u.email, lastLoginAt: u.lastLoginAt });

async function issue(res, user) {
  const refresh = signAdminRefreshToken(user);
  // Separate hash field from the customer app's refresh token.
  await User.updateOne({ _id: user._id }, { $set: { adminRefreshTokenHash: hashToken(refresh) } });
  res.cookie(COOKIE, refresh, cookieOptions());
  return signAdminAccessToken(user);
}

const login = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user || !isSuper(user) || !(await user.comparePassword(req.body.password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');
  const accessToken = await issue(res, user);
  user.lastLoginAt = new Date();
  await user.save();
  await AuditLog.create({ userId: user._id, action: 'admin.login', ip: req.ip, meta: { panel: 'admin' } });
  return new ApiResponse(200, { admin: view(user), accessToken }, 'Logged in').send(res);
});

const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (!token) throw ApiError.unauthorized('Missing refresh token');
  let payload;
  try {
    payload = verifyAdminRefreshToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }
  const user = await User.findById(payload.sub).select('+adminRefreshTokenHash');
  if (!user || !user.isActive || !isSuper(user) || user.adminRefreshTokenHash !== hashToken(token)) {
    if (user) await User.updateOne({ _id: user._id }, { $set: { adminRefreshTokenHash: null } });
    throw ApiError.unauthorized('Session expired — please log in again');
  }
  const accessToken = await issue(res, user);
  return new ApiResponse(200, { admin: view(user), accessToken }).send(res);
});

const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) {
    try {
      const payload = verifyAdminRefreshToken(token);
      await User.updateOne({ _id: payload.sub }, { $set: { adminRefreshTokenHash: null } });
    } catch { /* already invalid */ }
  }
  res.clearCookie(COOKIE, { path: '/api/admin-auth' });
  return new ApiResponse(200, null, 'Logged out').send(res);
});

const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.admin.id);
  return new ApiResponse(200, { admin: view(user) }).send(res);
});

const changePassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.admin.id).select('+passwordHash');
  if (!(await user.comparePassword(req.body.currentPassword))) throw ApiError.badRequest('Current password galat hai');
  user.setPassword(req.body.newPassword);
  await user.save();
  return new ApiResponse(200, null, 'Password changed').send(res);
});

module.exports = { login, refresh, logout, me, changePassword, isSuper };
