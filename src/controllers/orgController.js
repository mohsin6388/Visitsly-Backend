const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const env = require('../config/env');
const Organization = require('../models/Organization');
const User = require('../models/User');
const Lead = require('../models/Lead');
const Property = require('../models/Property');
const AuditLog = require('../models/AuditLog');
const orgService = require('../services/saas/orgService');
const { orgSummary } = require('../services/saas/orgSummary');
const tenantContext = require('../context/tenantContext');
const whatsappConnect = require('../services/saas/whatsappConnect');
const openingTemplateService = require('../services/whatsapp/openingTemplateService');
const { assertWithinLimit } = require('../services/saas/subscription');
const { teamAvailable, sanitizePermissions, permissionsFor } = require('../services/saas/permissions');
const logger = require('../utils/logger');

function requireOrg(req) {
  if (!req.org) throw ApiError.badRequest('No company selected');
  return req.org;
}

async function freshSummary(orgId) {
  return orgSummary(await orgService.getSnapshot(orgId, { fresh: true }));
}

/** GET /api/org — current company, plan, limits, usage, WhatsApp status. */
const getOrg = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  // Onboarding checklist auto-ticks from real data.
  const [contacts, properties] = await Promise.all([
    Lead.exists({ ownerId: org.ownerUserId }),
    Property.exists({ ownerId: org.ownerUserId }),
  ]);
  const patch = {};
  if (contacts && !org.onboarding?.contactsDone) patch['onboarding.contactsDone'] = true;
  if (properties && !org.onboarding?.propertiesDone) patch['onboarding.propertiesDone'] = true;
  if (Object.keys(patch).length) {
    await Organization.updateOne({ _id: org._id }, { $set: patch });
    return new ApiResponse(200, { org: await freshSummary(org._id) }).send(res);
  }
  return new ApiResponse(200, { org: await orgSummary(org) }).send(res);
});

/** PATCH /api/org — company profile (owner only). */
const updateOrg = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  const allowed = ['name', 'city', 'businessType', 'gstin', 'billingEmail', 'phone'];
  const $set = {};
  for (const key of allowed) if (req.body[key] !== undefined) $set[key] = req.body[key];
  if ($set.name) $set['onboarding.companyDone'] = true;
  // Billing country decides the currency (what Razorpay charges). It is fixed
  // once onboarding is done; after that only a platform admin can change it.
  if (req.body.country && String(req.body.country).toUpperCase() !== String(org.country || 'IN').toUpperCase()) {
    if (org.onboarding?.profileDone !== false) {
      throw new ApiError(403, 'Country and billing currency can’t be changed after setup. Contact support if this is wrong.', { code: 'COUNTRY_LOCKED' });
    }
    if (org.status === 'active' && org.razorpay?.subscriptionId) {
      throw ApiError.badRequest('Billing country can’t be changed during an active subscription. Contact support.');
    }
    if (!require('../config/countries').isCountryCode(req.body.country)) throw ApiError.badRequest('Choose a valid country');
    $set.country = String(req.body.country).toUpperCase();
    $set.currency = require('../config/pricing').currencyForCountry($set.country);
  }
  await Organization.updateOne({ _id: org._id }, { $set });
  orgService.invalidate(org._id);
  if ($set.name) {
    // Keep the AI's company name in sync.
    await require('../models/Settings').updateOne({ orgId: org._id }, { $set: { companyName: $set.name } });
  }
  return new ApiResponse(200, { org: await freshSummary(org._id) }, 'Company profile updated').send(res);
});

/**
 * PATCH /api/org/profile — onboarding wizard submit (owner only).
 * Saves the owner's name and the company profile, fixes the billing country
 * and currency, and marks the wizard done. Once done, the country can only
 * be changed by a platform admin.
 */
const updateProfile = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  const { ownerName, companyName, city, businessType } = req.body;
  const country = String(req.body.country).toUpperCase();
  const pricing = require('../config/pricing');
  const Settings = require('../models/Settings');
  const { defaultOpeningText, PLACEHOLDER_COMPANY } = require('./authController');

  const current = await Organization.findById(org._id).select('name country currency onboarding status razorpay').lean();
  if (!current) throw ApiError.notFound('Company not found');
  const alreadyDone = current.onboarding?.profileDone !== false;
  const countryChanged = country !== String(current.country || 'IN').toUpperCase();
  if (alreadyDone && countryChanged) {
    throw new ApiError(403, 'Country and billing currency can’t be changed after setup. Contact support if this is wrong.', { code: 'COUNTRY_LOCKED' });
  }

  const $set = {
    name: companyName,
    city,
    businessType,
    'onboarding.companyDone': true,
    'onboarding.profileDone': true,
  };
  if (!alreadyDone) {
    // First completion: country + currency become final here.
    $set.country = country;
    $set.currency = pricing.currencyForCountry(country);
    $set['onboarding.profileCompletedAt'] = new Date();
    $set['onboarding.profileDraft'] = { ownerName: '', companyName: '', country: '', city: '', businessType: '', step: 0 };
  }
  await Organization.updateOne({ _id: org._id }, { $set });

  // The owner's own name (req.user.actorId = the real logged-in person).
  await User.updateOne({ _id: req.user.actorId, orgId: org._id }, { $set: { name: ownerName } });

  // Keep the AI's company name in sync; refresh the opening text if it still
  // mentions the signup placeholder / the previous company name.
  const settings = await Settings.findOne({ orgId: org._id }).select('companyName openingText').lean();
  if (settings) {
    const patch = { companyName };
    const previous = [PLACEHOLDER_COMPANY, current.name, settings.companyName].filter(Boolean);
    if (!settings.openingText || previous.some((n) => settings.openingText === defaultOpeningText(n))) {
      patch.openingText = defaultOpeningText(companyName);
    }
    await Settings.updateOne({ orgId: org._id }, { $set: patch });
  }

  orgService.invalidate(org._id);
  await AuditLog.create({
    orgId: org._id,
    userId: req.user.actorId,
    action: 'org.profile',
    entityType: 'Organization',
    entityId: org._id,
    meta: { ownerName, companyName, country: alreadyDone ? current.country : country, city, businessType, currency: alreadyDone ? current.currency : $set.currency, firstCompletion: !alreadyDone },
    ip: req.ip,
  });
  return new ApiResponse(200, { org: await freshSummary(org._id) }, 'Profile saved').send(res);
});

/** PATCH /api/org/profile/draft — save wizard answers after each step (resume later). */
const saveProfileDraft = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  if (org.onboarding?.profileDone !== false) {
    return new ApiResponse(200, { saved: false }, 'Profile already completed').send(res);
  }
  const $set = {};
  for (const key of ['ownerName', 'companyName', 'country', 'city', 'businessType', 'step']) {
    if (req.body[key] !== undefined) $set[`onboarding.profileDraft.${key}`] = req.body[key];
  }
  if (Object.keys($set).length) await Organization.updateOne({ _id: org._id, 'onboarding.profileDone': false }, { $set });
  orgService.invalidate(org._id);
  return new ApiResponse(200, { saved: true }).send(res);
});

/** PATCH /api/org/onboarding — tick or dismiss checklist items. */
const updateOnboarding = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  const $set = {};
  for (const key of ['dismissed']) {
    if (typeof req.body[key] === 'boolean') $set[`onboarding.${key}`] = req.body[key];
  }
  await Organization.updateOne({ _id: org._id }, { $set });
  orgService.invalidate(org._id);
  return new ApiResponse(200, { org: await freshSummary(org._id) }).send(res);
});

/* ---------------- WhatsApp connection ---------------- */

const getWhatsapp = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  return new ApiResponse(200, { whatsapp: whatsappConnect.publicView(org) }).send(res);
});

/** GET /api/org/whatsapp/number-labels — names only (no tokens), readable by every team member, for the inbox/leads badges. */
const whatsappNumberLabels = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  const wa = org.whatsapp || {};
  const numbers = [];
  if (wa.phoneNumberId) numbers.push({ phoneNumberId: String(wa.phoneNumberId), label: "Main", displayPhoneNumber: wa.displayPhoneNumber || "", isMain: true });
  for (const n of org.extraNumbers || []) {
    numbers.push({ phoneNumberId: String(n.phoneNumberId), label: n.label || "Extra", displayPhoneNumber: n.displayPhoneNumber || "", isMain: false });
  }
  return new ApiResponse(200, { numbers }).send(res);
});

/** GET /api/org/whatsapp/health — simple step-by-step connection check. */
const whatsappHealth = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  // Optional ?phoneNumberId=… → checklist for ONE extra number (default: main number).
  const phoneNumberId = /^\d+$/.test(String(req.query.phoneNumberId || '')) ? String(req.query.phoneNumberId) : null;
  const health = await tenantContext.run(org, () => tenantContext.runWithNumber(phoneNumberId, () => whatsappConnect.healthCheck(org._id, phoneNumberId ? { phoneNumberId } : {})));
  return new ApiResponse(200, { health }).send(res);
});

/** POST /api/org/whatsapp/fix-webhook — re-subscribe the app to the WABA. */
const fixWhatsappWebhook = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  const phoneNumberId = /^\d+$/.test(String(req.query.phoneNumberId || '')) ? String(req.query.phoneNumberId) : null;
  const health = await whatsappConnect.resubscribeWebhook(org._id, phoneNumberId ? { phoneNumberId } : {});
  return new ApiResponse(200, { health }, 'Webhook reconnected').send(res);
});

const connectEmbedded = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  try {
    await whatsappConnect.connectEmbedded(org._id, req.body);
  } catch (err) {
    await whatsappConnect.recordConnectionError(org._id, err, 'connect_embedded');
    throw err;
  }
  await AuditLog.create({ userId: req.user.actorId, action: 'org.whatsapp.connect', meta: { via: 'embedded_signup' }, ip: req.ip })
    .catch((err) => logger.warn('[org] WhatsApp connected but audit log could not be written', { organizationId: String(org._id), error: err.message }));
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(200, { whatsapp: whatsappConnect.publicView(fresh) }, 'WhatsApp connected').send(res);
});

/** Start the server-side half of Embedded Signup. OAuth code is exchanged once. */
const prepareEmbeddedSignup = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  try {
    const attempt = await whatsappConnect.prepareEmbedded(org._id, req.user.actorId, req.body);
    return new ApiResponse(200, { attempt }, 'Meta account authorized. Complete phone registration to finish connecting.').send(res);
  } catch (err) {
    // An extra number that fails must never put an error banner on the main number.
    if (req.body?.target !== 'extra') await whatsappConnect.recordConnectionError(org._id, err, 'prepare_embedded_signup');
    throw err;
  }
});

/** Finish number registration after the customer selects a number and enters their PIN. */
const completeEmbeddedSignup = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  const WhatsAppConnectionAttempt = require('../models/WhatsAppConnectionAttempt');
  const attemptInfo = await WhatsAppConnectionAttempt.findOne({ _id: req.body.attemptId, organizationId: org._id }).select('target').lean().catch(() => null);
  const isExtra = attemptInfo?.target === 'extra';
  try {
    await whatsappConnect.completeEmbedded(org._id, req.body);
  } catch (err) {
    if (!isExtra) await whatsappConnect.recordConnectionError(org._id, err, 'complete_embedded_signup');
    throw err;
  }
  await AuditLog.create({ userId: req.user.actorId, action: isExtra ? 'org.whatsapp.number.add' : 'org.whatsapp.connect', meta: { via: 'embedded_signup', target: isExtra ? 'extra' : 'main', phoneNumberId: req.body.phoneNumberId }, ip: req.ip })
    .catch((err) => logger.warn('[org] WhatsApp connected but audit log could not be written', { organizationId: String(org._id), error: err.message }));
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(200, { whatsapp: whatsappConnect.publicView(fresh) }, 'WhatsApp connected').send(res);
});

const connectManual = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  try {
    await whatsappConnect.connectManual(org._id, req.body);
  } catch (err) {
    await whatsappConnect.recordConnectionError(org._id, err, 'connect_manual');
    throw err;
  }
  await AuditLog.create({ userId: req.user.actorId, action: 'org.whatsapp.connect', meta: { via: 'manual' }, ip: req.ip })
    .catch((err) => logger.warn('[org] WhatsApp connected but audit log could not be written', { organizationId: String(org._id), error: err.message }));
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(200, { whatsapp: whatsappConnect.publicView(fresh) }, 'WhatsApp connected').send(res);
});

/** POST /api/org/whatsapp/test-message — send a test message to the owner's own number. */
const sendWhatsappTestMessage = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  const result = await whatsappConnect.sendTestMessage(org._id, req.body);
  await AuditLog.create({ userId: req.user.actorId, action: 'org.whatsapp.test_message', ip: req.ip }).catch(() => {});
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(200, { ...result, whatsapp: whatsappConnect.publicView(fresh) }, 'Test message sent').send(res);
});

/** POST /api/org/whatsapp/coexistence/sync — (re)request contacts + chat history sync (24h window). */
const retryCoexistenceSync = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  await whatsappConnect.startCoexistenceSync(org._id, req.params.phoneNumberId || null);
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(200, { whatsapp: whatsappConnect.publicView(fresh) }, 'Sync requested').send(res);
});

const disconnectWhatsapp = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  await whatsappConnect.disconnect(org._id);
  await AuditLog.create({ userId: req.user.actorId, action: 'org.whatsapp.disconnect', ip: req.ip });
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(200, { whatsapp: whatsappConnect.publicView(fresh) }, 'WhatsApp disconnected').send(res);
});

function openingTemplateError(err) {
  const known = {
    WHATSAPP_NOT_CONNECTED: 409,
    TENANT_CONTEXT_MISSING: 400,
    OPENING_TEMPLATE_UNAVAILABLE: 422,
    OPENING_TEMPLATE_NOT_ELIGIBLE: 422,
    OPENING_TEMPLATE_VARIABLES_MISSING: 422,
    OPENING_TEMPLATE_MEDIA_MISSING: 422,
    TEMPLATES_FETCH_FAILED: 502,
  };
  if (known[err.code]) {
    return new ApiError(known[err.code], err.message, {
      code: err.code,
      reasons: err.reasons,
      unresolved: err.unresolved,
    });
  }
  return err;
}

/** GET /api/org/whatsapp/opening-template/options — this org's templates + eligibility. */
const listOpeningTemplateOptions = asyncHandler(async (req, res) => {
  requireOrg(req);
  try {
    const data = await openingTemplateService.listForCurrentOrg({ force: req.query.refresh === 'true' });
    return new ApiResponse(200, data, 'Templates loaded').send(res);
  } catch (err) {
    throw openingTemplateError(err);
  }
});

/** PATCH /api/org/whatsapp/opening-template — select (or clear with name=null) the opening template. */
const updateOpeningTemplate = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  try {
    if (!req.body.name) {
      await openingTemplateService.clearSelection();
    } else {
      if (!req.body.language) throw ApiError.badRequest('Template language is required');
      await openingTemplateService.saveSelection({
        name: req.body.name,
        language: req.body.language,
        variables: req.body.variables || [],
        userId: req.user?.actorId || null,
      });
    }
  } catch (err) {
    throw openingTemplateError(err);
  }
  await AuditLog.create({
    userId: req.user.actorId,
    action: 'org.whatsapp.openingTemplate',
    meta: { name: req.body.name || null, language: req.body.language || null },
    ip: req.ip,
  }).catch(() => {});
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(200, { whatsapp: whatsappConnect.publicView(fresh) }, 'Opening template saved').send(res);
});

const addNumber = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  await whatsappConnect.addNumber(org._id, req.body);
  await AuditLog.create({ userId: req.user.actorId, action: 'org.whatsapp.number.add', meta: { via: 'manual', target: 'extra', phoneNumberId: req.body.phoneNumberId }, ip: req.ip }).catch(() => {});
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(201, { whatsapp: whatsappConnect.publicView(fresh) }, 'Number added').send(res);
});

const removeNumber = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  await whatsappConnect.removeNumber(org._id, req.params.phoneNumberId);
  await AuditLog.create({ userId: req.user.actorId, action: 'org.whatsapp.number.remove', meta: { phoneNumberId: req.params.phoneNumberId }, ip: req.ip }).catch(() => {});
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(200, { whatsapp: whatsappConnect.publicView(fresh) }, 'Number removed').send(res);
});

/* ---------------- Team ---------------- */

function teamRow(u) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    phone: u.phone || '',
    orgRole: u.orgRole === 'owner' ? 'owner' : 'agent',
    permissions: permissionsFor(u),
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    mustChangePassword: !!u.mustChangePassword,
    createdAt: u.createdAt,
  };
}

const listTeam = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  const users = await User.find({ orgId: org._id }).sort({ createdAt: 1 }).lean();
  return new ApiResponse(200, { items: users.map(teamRow) }).send(res);
});

/** Starter/Trial have no team. Raised before any seat maths so the message is clear. */
function assertTeamPlan(org) {
  if (!teamAvailable(org)) throw ApiError.forbidden('Team members are available on Growth and above', { code: 'PLAN_LIMIT', key: 'team', requiredPlan: 'growth' });
}

/** Only the Owner manages the team (the route guard already checks; this keeps the controller safe on its own). */
function assertOwner(req) {
  if (req.user.orgRole !== 'owner') throw ApiError.forbidden('Only the company owner can manage the team');
}

function tempPassword() {
  return `Prop${crypto.randomBytes(4).toString('hex')}9A`;
}

const inviteMember = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  const email = String(req.body.email).trim().toLowerCase();
  assertOwner(req);
  assertTeamPlan(org);
  const orgRole = 'agent';

  // Seat limit includes the owner (Growth 5, Builder 10, Enterprise unlimited; env + admin overrides apply).
  const activeUsers = await User.countDocuments({ orgId: org._id, isActive: true });
  assertWithinLimit('users', activeUsers, 1);

  if (await User.exists({ email })) throw ApiError.conflict('A login already exists for this email');

  const password = req.body.password || tempPassword();
  const user = new User({
    name: req.body.name,
    email,
    phone: req.body.phone || undefined,
    role: 'broker',
    orgId: org._id,
    orgRole,
    permissions: sanitizePermissions(req.body.permissions),
    mustChangePassword: !req.body.password,
  });
  user.setPassword(password);
  await user.save();

  await AuditLog.create({ userId: req.user.actorId, action: 'org.team.invite', entityType: 'User', entityId: user._id, meta: { email, orgRole, permissions: permissionsFor(user) }, ip: req.ip });

  // Best-effort invite email (also returned once so the owner can share it on WhatsApp).
  try {
    const { sendDirectEmail } = require('../services/email/mailer');
    await sendDirectEmail({
      to: email,
      subject: `${org.name} added you to ${env.saas.productName}`,
      text: `Hi ${req.body.name},\n\n${org.name} added you to ${env.saas.productName} CRM.\n\nLogin: ${env.appBaseUrl}/login\nEmail: ${email}\nPassword: ${password}\n\nPlease change your password after your first login.`,
    });
  } catch (err) {
    logger.info('[team] Invite email not sent', { error: err.message });
  }

  return new ApiResponse(
    201,
    { member: teamRow(user), tempPassword: req.body.password ? null : password, loginUrl: `${env.appBaseUrl}/login` },
    'Team member added'
  ).send(res);
});

/**
 * POST /api/org/team/bulk — add several teammates at once (each with an
 * optional password chosen by the owner). Returns one result row per person,
 * so one bad email does not block the rest.
 */
const bulkInvite = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  assertOwner(req);
  assertTeamPlan(org);
  const rows = Array.isArray(req.body.members) ? req.body.members : [];
  const results = [];
  let active = await User.countDocuments({ orgId: org._id, isActive: true });
  for (const row of rows) {
    const email = String(row.email || '').trim().toLowerCase();
    const orgRole = 'agent';
    try {
      assertWithinLimit('users', active, 1);
      if (await User.exists({ email })) throw ApiError.conflict('A login already exists for this email');
      const password = row.password || tempPassword();
      const user = new User({
        name: String(row.name).trim(),
        email,
        phone: row.phone || undefined,
        role: 'broker',
        orgId: org._id,
        orgRole,
        permissions: sanitizePermissions(row.permissions),
        mustChangePassword: !row.password,
      });
      user.setPassword(password);
      await user.save();
      active += 1;
      await AuditLog.create({ userId: req.user.actorId, action: 'org.team.invite', entityType: 'User', entityId: user._id, meta: { email, orgRole, bulk: true, permissions: permissionsFor(user) }, ip: req.ip });
      try {
        const { sendDirectEmail } = require('../services/email/mailer');
        await sendDirectEmail({
          to: email,
          subject: `${org.name} added you to ${env.saas.productName}`,
          text: `Hi ${row.name},\n\n${org.name} added you to ${env.saas.productName} CRM.\n\nLogin: ${env.appBaseUrl}/login\nEmail: ${email}\nPassword: ${password}\n\nYou can change your password after logging in.`,
        });
      } catch (err) {
        logger.info('[team] Invite email not sent', { error: err.message });
      }
      results.push({ ok: true, email, name: user.name, member: teamRow(user), password });
    } catch (err) {
      results.push({ ok: false, email, name: row.name, error: err.message || 'Could not add' });
    }
  }
  const added = results.filter((r) => r.ok).length;
  return new ApiResponse(201, { results, loginUrl: `${env.appBaseUrl}/login` }, `${added} teammate(s) added${added < results.length ? `, ${results.length - added} failed` : ''}`).send(res);
});

/** POST /api/org/team/:id/set-password — owner sets a chosen password. */
const setMemberPassword = asyncHandler(async (req, res) => {
  assertOwner(req);
  const member = await findMember(req);
  if (member.orgRole === 'owner' && String(member._id) !== req.user.actorId) throw ApiError.forbidden('Only the owner can change the owner’s password');
  member.setPassword(req.body.password);
  member.mustChangePassword = false;
  member.tokenVersion += 1;
  member.refreshTokenHash = null;
  await member.save();
  await AuditLog.create({ userId: req.user.actorId, action: 'org.team.set_password', entityType: 'User', entityId: member._id, ip: req.ip });
  return new ApiResponse(200, {}, 'Password set').send(res);
});

async function findMember(req) {
  const org = requireOrg(req);
  const member = await User.findOne({ _id: req.params.id, orgId: org._id });
  if (!member) throw ApiError.notFound('Team member not found');
  return member;
}

const updateMember = asyncHandler(async (req, res) => {
  assertOwner(req);
  const member = await findMember(req);
  // The owner can't be deactivated, demoted or have permissions edited.
  if (member.orgRole === 'owner') throw ApiError.badRequest('The owner can’t be deactivated, changed or have permissions edited');
  const before = permissionsFor(member);
  if (req.body.orgRole) member.orgRole = 'agent';
  if (member.orgRole === 'manager') member.orgRole = 'agent'; // legacy value → agent on first edit
  if (req.body.permissions) {
    member.permissions = { ...(member.permissions?.toObject?.() || {}), ...sanitizePermissions(req.body.permissions) };
  }
  if (typeof req.body.isActive === 'boolean') {
    if (req.body.isActive && !member.isActive) {
      assertWithinLimit('users', await User.countDocuments({ orgId: member.orgId, isActive: true }), 1);
    }
    member.isActive = req.body.isActive;
    if (!member.isActive) {
      member.tokenVersion += 1;
      member.refreshTokenHash = null;
    }
  }
  if (req.body.name) member.name = req.body.name;
  await member.save();
  await AuditLog.create({ userId: req.user.actorId, action: 'org.team.update', entityType: 'User', entityId: member._id, meta: req.body, ip: req.ip });
  if (req.body.permissions) {
    const after = permissionsFor(member);
    const changed = Object.fromEntries(Object.keys(after).filter((k) => before[k] !== after[k]).map((k) => [k, { from: before[k], to: after[k] }]));
    await AuditLog.create({ userId: req.user.actorId, action: 'org.team.permissions', entityType: 'User', entityId: member._id, meta: { changed }, ip: req.ip });
  }
  return new ApiResponse(200, { member: teamRow(member) }, 'Team member updated').send(res);
});

const resetMemberPassword = asyncHandler(async (req, res) => {
  assertOwner(req);
  const member = await findMember(req);
  if (member.orgRole === 'owner' && String(member._id) !== req.user.actorId) {
    throw ApiError.forbidden('Only the owner can change the owner’s password');
  }
  const password = tempPassword();
  member.setPassword(password);
  member.mustChangePassword = true;
  member.tokenVersion += 1;
  member.refreshTokenHash = null;
  await member.save();
  return new ApiResponse(200, { tempPassword: password }, 'Temporary password created').send(res);
});

module.exports = {
  whatsappNumberLabels,
  addNumber,
  removeNumber,
  getOrg,
  updateOrg,
  updateProfile,
  saveProfileDraft,
  updateOnboarding,
  getWhatsapp,
  whatsappHealth,
  fixWhatsappWebhook,
  bulkInvite,
  setMemberPassword,
  connectEmbedded,
  prepareEmbeddedSignup,
  completeEmbeddedSignup,
  connectManual,
  disconnectWhatsapp,
  sendWhatsappTestMessage,
  retryCoexistenceSync,
  updateOpeningTemplate,
  listOpeningTemplateOptions,
  listTeam,
  inviteMember,
  updateMember,
  resetMemberPassword,
};
