const ApiError = require('../utils/ApiError');
const { verifyAccessToken } = require('../utils/tokens');
const User = require('../models/User');
const env = require('../config/env');
const tenantContext = require('../context/tenantContext');
const orgService = require('../services/saas/orgService');
const { subscriptionState } = require('../services/saas/subscription');

// Routes a company can still use when its trial/subscription has lapsed, so
// it can pay, manage the team, or read and export its data.
const ALWAYS_ALLOWED_PREFIXES = ['/api/auth', '/api/billing', '/api/org'];

function isSuperAdmin(user) {
  return Boolean(user.isSuperAdmin || env.saas.superAdminEmails.includes(String(user.email || '').toLowerCase()));
}

/**
 * Requires a valid access token in the Authorization header:
 *   Authorization: Bearer <token>
 *
 * SaaS mode: loads the user's company (tenant) and runs the rest of the
 * request inside its tenant context. `req.user.id` is set to the company's
 * workspace owner id — every existing controller scopes records by
 * `ownerId: req.user.id`, so the whole team shares one workspace while
 * companies stay fully isolated. The real person is `req.user.actorId`.
 *
 * PropAI admins work in the separate admin panel; to help a customer they
 * open a short-lived support session (token typ=support) from there.
 */
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw ApiError.unauthorized('Missing or malformed access token');
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      throw ApiError.unauthorized(
        err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token'
      );
    }

    const user = await User.findById(payload.sub);
    if (!user || !user.isActive || user.emailVerified === false || (env.clientEmail && String(user.email || '').toLowerCase() !== env.clientEmail)) {
      throw ApiError.unauthorized('Account not found, email not verified, or deactivated');
    }

    if (!env.saas.enabled) {
      req.user = { id: user._id.toString(), actorId: user._id.toString(), role: user.role, email: user.email, name: user.name };
      return next();
    }

    // Support session opened from the separate admin panel: a PropAI
    // super-admin working inside one company for a limited time.
    const support = payload.typ === 'support';
    if (support && !isSuperAdmin(user)) throw ApiError.unauthorized('Invalid support session');
    const orgId = support ? payload.org : user.orgId;

    // Never let a client pick another workspace through the query string.
    if (req.query && 'ownerId' in req.query) delete req.query.ownerId;

    if (!orgId) {
      throw ApiError.unauthorized(isSuperAdmin(user)
        ? 'PropAI admin login admin panel se karein'
        : 'This login is not linked to any company');
    }

    const org = await orgService.getSnapshot(orgId);
    if (!org) throw ApiError.unauthorized('Company not found');

    const tenantRole = user.role === 'admin' ? 'broker' : user.role; // 'admin' would bypass owner scoping
    req.org = org;
    req.subscription = subscriptionState(org);
    req.user = {
      id: org.ownerUserId,
      actorId: user._id.toString(),
      role: tenantRole,
      orgRole: support ? 'owner' : user.orgRole || 'owner',
      isSuperAdmin: false,
      impersonating: support,
      email: user.email,
      name: user.name,
      tenant: true,
    };

    const path = req.originalUrl || '';
    const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (!req.subscription.active && !readOnly && !ALWAYS_ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
      throw new ApiError(402, req.subscription.reason, { code: 'SUBSCRIPTION_INACTIVE', status: req.subscription.status });
    }

    return tenantContext.run(org, () => next());
  } catch (err) {
    next(err);
  }
};

authenticate.isSuperAdmin = isSuperAdmin;

module.exports = authenticate;
