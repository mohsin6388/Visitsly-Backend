const ApiError = require('../utils/ApiError');

/**
 * Restricts a route to specific roles. Must run after `authenticate`.
 * Usage: router.get('/admin-only', authenticate, roleGuard('admin'), handler)
 *
 * SaaS: a company user works in one workspace that covers both the broker
 * and builder features, so tenant users pass any broker/builder guard.
 * 'admin'-only routes (audit log) need the company owner.
 */
const roleGuard = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return next(ApiError.unauthorized('Authentication required'));
  }
  if (req.user.tenant) {
    const tenantOk = allowedRoles.includes('broker') || allowedRoles.includes('builder');
    const adminOk = allowedRoles.includes('admin') && req.user.orgRole === 'owner';
    if (tenantOk || adminOk) return next();
    return next(ApiError.forbidden('You do not have permission to perform this action'));
  }
  if (!allowedRoles.includes(req.user.role)) {
    return next(ApiError.forbidden('You do not have permission to perform this action'));
  }
  next();
};

/** Company-level permission: roleGuard.org('owner'). Only Owner and Agent roles exist. */
roleGuard.org = (...orgRoles) => {
  const mw = (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized('Authentication required'));
    if (!req.user.tenant) return next(); // legacy single-client mode: no team roles
    if (orgRoles.includes(req.user.orgRole)) return next();
    return next(ApiError.forbidden('Only the company owner can do this'));
  };
  mw.orgRoles = orgRoles; // label (used by the route→permission table test)
  return mw;
};

/** Reads allowed for every teammate; writes only for these company roles. */
roleGuard.orgWrite = (...orgRoles) => {
  const mw = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    return roleGuard.org(...orgRoles)(req, res, next);
  };
  mw.orgRoles = orgRoles;
  mw.writesOnly = true;
  return mw;
};

/** Platform super-admin only (PropAI staff). */
roleGuard.superAdmin = (req, res, next) => {
  if (req.user?.isSuperAdmin && !req.user.impersonating) return next();
  return next(ApiError.forbidden('Platform admin access required'));
};

module.exports = roleGuard;
