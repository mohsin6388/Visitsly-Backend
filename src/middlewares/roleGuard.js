const ApiError = require('../utils/ApiError');

/**
 * Restricts a route to specific roles. Must run after `authenticate`.
 * Usage: router.get('/admin-only', authenticate, roleGuard('admin'), handler)
 *
 * SaaS: a company user works in one workspace that covers both the broker
 * and builder features, so tenant users pass any broker/builder guard.
 * 'admin'-only routes (audit log) need an owner or manager in the company.
 */
const roleGuard = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return next(ApiError.unauthorized('Authentication required'));
  }
  if (req.user.tenant) {
    const tenantOk = allowedRoles.includes('broker') || allowedRoles.includes('builder');
    const adminOk = allowedRoles.includes('admin') && ['owner', 'manager'].includes(req.user.orgRole);
    if (tenantOk || adminOk) return next();
    return next(ApiError.forbidden('You do not have permission to perform this action'));
  }
  if (!allowedRoles.includes(req.user.role)) {
    return next(ApiError.forbidden('You do not have permission to perform this action'));
  }
  next();
};

/** Company-level permission: roleGuard.org('owner', 'manager') */
roleGuard.org = (...orgRoles) => (req, res, next) => {
  if (!req.user) return next(ApiError.unauthorized('Authentication required'));
  if (!req.user.tenant) return next(); // legacy single-client mode: no team roles
  if (orgRoles.includes(req.user.orgRole)) return next();
  return next(ApiError.forbidden('Ye kaam sirf company owner/manager kar sakte hain'));
};

/** Reads allowed for every teammate; writes only for these company roles. */
roleGuard.orgWrite = (...orgRoles) => (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return roleGuard.org(...orgRoles)(req, res, next);
};

/** Platform super-admin only (PropAI staff). */
roleGuard.superAdmin = (req, res, next) => {
  if (req.user?.isSuperAdmin && !req.user.impersonating) return next();
  return next(ApiError.forbidden('Platform admin access required'));
};

module.exports = roleGuard;
