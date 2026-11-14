const ApiError = require('../utils/ApiError');
const User = require('../models/User');
const env = require('../config/env');
const { verifyAdminAccessToken } = require('../utils/tokens');

/**
 * Auth for the separate PropAI admin panel. Only admin-panel tokens (own
 * secret + audience) are accepted, and only for platform super-admins.
 */
async function adminAuth(req, res, next) {
  try {
    const [scheme, token] = String(req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) throw ApiError.unauthorized('Missing admin token');
    let payload;
    try {
      payload = verifyAdminAccessToken(token);
    } catch (err) {
      throw ApiError.unauthorized(err.name === 'TokenExpiredError' ? 'Admin token expired' : 'Invalid admin token');
    }
    const user = await User.findById(payload.sub);
    const isSuper = user && (user.isSuperAdmin || env.saas.superAdminEmails.includes(String(user.email).toLowerCase()));
    if (!user || !user.isActive || !isSuper) throw ApiError.forbidden('Platform admin access required');
    req.admin = { id: user._id.toString(), email: user.email, name: user.name };
    req.user = { id: user._id.toString(), actorId: user._id.toString(), role: 'superadmin', isSuperAdmin: true, email: user.email, name: user.name };
    req.org = null;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = adminAuth;
