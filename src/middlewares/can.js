const ApiError = require('../utils/ApiError');

/**
 * Permission guard (run after `authenticate`, and after the route's plan-feature
 * check — a toggle can never unlock something the plan does not include).
 *   can('leadDelete')                 → the agent needs that toggle
 *   can.any('leads', 'whatsappLeads') → at least one of them
 * The Owner always passes. Legacy single-client mode (no tenant) has no team.
 */
const deny = () => ApiError.forbidden('You do not have permission to do this. Ask your company owner to enable it.', { code: 'PERMISSION_DENIED' });

// `permissionKeys` / `mode` are only labels so a test (or a docs script) can list what each route needs.
function can(...keys) {
  const mw = (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized('Authentication required'));
    if (!req.user.tenant || req.user.orgRole === 'owner') return next();
    return keys.every((k) => req.user.permissions?.[k] === true) ? next() : next(deny());
  };
  mw.permissionKeys = keys;
  mw.mode = 'all';
  return mw;
}

can.any = (...keys) => {
  const mw = (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized('Authentication required'));
    if (!req.user.tenant || req.user.orgRole === 'owner') return next();
    return keys.some((k) => req.user.permissions?.[k] === true) ? next() : next(deny());
  };
  mw.permissionKeys = keys;
  mw.mode = 'any';
  return mw;
};

module.exports = can;
