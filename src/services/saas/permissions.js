/**
 * Team permissions (agents only — the Owner implicitly has everything).
 *
 *   pages    → also gate the matching API routes
 *   actions  → gate individual write routes
 *   display  → showFullPhone: false = every phone number is masked to its last 4 digits
 *
 * A permission can never exceed the plan: the route's plan-feature check
 * (requireFeature) always runs first. Stored on User.permissions; keys that were
 * never stored fall back to the defaults below.
 */
const PAGE_KEYS = ['dashboard', 'leads', 'inbox', 'whatsappLeads', 'siteVisits', 'followUps', 'properties'];
const ACTION_KEYS = ['leadCreate', 'leadImport', 'leadEdit', 'leadDelete', 'chatReply'];
const DISPLAY_KEYS = ['showFullPhone'];
const ALL_KEYS = [...PAGE_KEYS, ...ACTION_KEYS, ...DISPLAY_KEYS];

/** What a newly added agent gets (the Owner can change every toggle). */
const DEFAULT_AGENT_PERMISSIONS = Object.freeze({
  dashboard: true, leads: true, inbox: true, whatsappLeads: true, siteVisits: true, followUps: true, properties: true,
  leadCreate: true, leadImport: false, leadEdit: true, leadDelete: false, chatReply: true,
  showFullPhone: false,
});

/** Only two roles exist. A legacy 'manager' is treated as 'agent' (the lower-privilege choice). */
const normalizeOrgRole = (role) => (role === 'owner' ? 'owner' : 'agent');

/** Plans that include team logins. Starter and Trial are Owner-only. */
const TEAM_PLANS = ['growth', 'builder', 'enterprise'];
const teamAvailable = (org) => TEAM_PLANS.includes(org?.plan);

/** Keeps only known keys with boolean values. */
function sanitizePermissions(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of ALL_KEYS) if (typeof input[key] === 'boolean') out[key] = input[key];
  return out;
}

/** Full permission map for a user document / plain object. Owner: everything on. */
function permissionsFor(user) {
  if (normalizeOrgRole(user?.orgRole) === 'owner') return Object.fromEntries(ALL_KEYS.map((k) => [k, true]));
  const stored = user?.permissions && typeof user.permissions.toObject === 'function' ? user.permissions.toObject() : user?.permissions || {};
  const out = { ...DEFAULT_AGENT_PERMISSIONS };
  for (const key of ALL_KEYS) if (typeof stored[key] === 'boolean') out[key] = stored[key];
  return out;
}

/** The permission map as the Team UI edits it (defaults filled in), plus the groups. */
const GROUPS = { pages: PAGE_KEYS, actions: ACTION_KEYS, phone: DISPLAY_KEYS };

module.exports = {
  PAGE_KEYS, ACTION_KEYS, DISPLAY_KEYS, ALL_KEYS, GROUPS, DEFAULT_AGENT_PERMISSIONS,
  TEAM_PLANS, teamAvailable, normalizeOrgRole, sanitizePermissions, permissionsFor,
};
