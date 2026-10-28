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
const whatsappConnect = require('../services/saas/whatsappConnect');
const { assertWithinLimit } = require('../services/saas/subscription');
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

/** PATCH /api/org — company profile (owner/manager). */
const updateOrg = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  const allowed = ['name', 'city', 'businessType', 'gstin', 'billingEmail', 'phone'];
  const $set = {};
  for (const key of allowed) if (req.body[key] !== undefined) $set[key] = req.body[key];
  if ($set.name) $set['onboarding.companyDone'] = true;
  await Organization.updateOne({ _id: org._id }, { $set });
  orgService.invalidate(org._id);
  if ($set.name) {
    // Keep the AI's company name in sync.
    await require('../models/Settings').updateOne({ orgId: org._id }, { $set: { companyName: $set.name } });
  }
  return new ApiResponse(200, { org: await freshSummary(org._id) }, 'Company profile updated').send(res);
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
    await whatsappConnect.recordConnectionError(org._id, err, 'prepare_embedded_signup');
    throw err;
  }
});

/** Finish number registration after the customer selects a number and enters their PIN. */
const completeEmbeddedSignup = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  try {
    await whatsappConnect.completeEmbedded(org._id, req.body);
  } catch (err) {
    await whatsappConnect.recordConnectionError(org._id, err, 'complete_embedded_signup');
    throw err;
  }
  await AuditLog.create({ userId: req.user.actorId, action: 'org.whatsapp.connect', meta: { via: 'embedded_signup' }, ip: req.ip })
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

const disconnectWhatsapp = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  await whatsappConnect.disconnect(org._id);
  await AuditLog.create({ userId: req.user.actorId, action: 'org.whatsapp.disconnect', ip: req.ip });
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(200, { whatsapp: whatsappConnect.publicView(fresh) }, 'WhatsApp disconnected').send(res);
});

const updateOpeningTemplate = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  await Organization.updateOne(
    { _id: org._id },
    {
      $set: {
        'whatsapp.openingTemplateName': req.body.name || null,
        'whatsapp.openingTemplateLanguage': req.body.language || null,
      },
    }
  );
  orgService.invalidate(org._id);
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(200, { whatsapp: whatsappConnect.publicView(fresh) }, 'Opening template saved').send(res);
});

const addNumber = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  await whatsappConnect.addNumber(org._id, req.body);
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(201, { whatsapp: whatsappConnect.publicView(fresh) }, 'Number add ho gaya').send(res);
});

const removeNumber = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  await whatsappConnect.removeNumber(org._id, req.params.phoneNumberId);
  const fresh = await orgService.getSnapshot(org._id, { fresh: true });
  return new ApiResponse(200, { whatsapp: whatsappConnect.publicView(fresh) }, 'Number hata diya').send(res);
});

/* ---------------- Team ---------------- */

function teamRow(u) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    phone: u.phone || '',
    orgRole: u.orgRole || 'agent',
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

function tempPassword() {
  return `Prop${crypto.randomBytes(4).toString('hex')}9A`;
}

const inviteMember = asyncHandler(async (req, res) => {
  const org = requireOrg(req);
  const email = String(req.body.email).trim().toLowerCase();
  const orgRole = req.body.orgRole || 'agent';
  if (orgRole === 'owner') throw ApiError.badRequest('Company mein ek hi owner hota hai');
  if (req.user.orgRole !== 'owner' && orgRole === 'manager') throw ApiError.forbidden('Manager sirf owner bana sakta hai');

  const activeUsers = await User.countDocuments({ orgId: org._id, isActive: true });
  assertWithinLimit('users', activeUsers, 1);

  if (await User.exists({ email })) throw ApiError.conflict('Is email se pehle se ek PropAI login hai');

  const password = req.body.password || tempPassword();
  const user = new User({
    name: req.body.name,
    email,
    phone: req.body.phone || undefined,
    role: 'broker',
    orgId: org._id,
    orgRole,
    mustChangePassword: !req.body.password,
  });
  user.setPassword(password);
  await user.save();

  await AuditLog.create({ userId: req.user.actorId, action: 'org.team.invite', entityType: 'User', entityId: user._id, meta: { email, orgRole }, ip: req.ip });

  // Best-effort invite email (also returned once so the owner can share it on WhatsApp).
  try {
    const { sendDirectEmail } = require('../services/email/mailer');
    await sendDirectEmail({
      to: email,
      subject: `${org.name} ne aapko ${env.saas.productName} par add kiya hai`,
      text: `Namaste ${req.body.name},\n\n${org.name} ne aapko ${env.saas.productName} CRM par add kiya hai.\n\nLogin: ${env.appBaseUrl}/login\nEmail: ${email}\nPassword: ${password}\n\nPehli baar login ke baad password badal lijiye.`,
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

async function findMember(req) {
  const org = requireOrg(req);
  const member = await User.findOne({ _id: req.params.id, orgId: org._id });
  if (!member) throw ApiError.notFound('Team member not found');
  return member;
}

const updateMember = asyncHandler(async (req, res) => {
  const member = await findMember(req);
  if (member.orgRole === 'owner') throw ApiError.badRequest('Owner ka role ya status yahan se nahi badalta');
  if (req.body.orgRole) {
    if (req.body.orgRole === 'owner') throw ApiError.badRequest('Ownership transfer ke liye support se baat karein');
    if (req.user.orgRole !== 'owner' && req.body.orgRole === 'manager') throw ApiError.forbidden('Manager sirf owner bana sakta hai');
    member.orgRole = req.body.orgRole;
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
  return new ApiResponse(200, { member: teamRow(member) }, 'Team member updated').send(res);
});

const resetMemberPassword = asyncHandler(async (req, res) => {
  const member = await findMember(req);
  if (member.orgRole === 'owner' && String(member._id) !== req.user.actorId) {
    throw ApiError.forbidden('Owner ka password sirf owner badal sakta hai');
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
  addNumber,
  removeNumber,
  getOrg,
  updateOrg,
  updateOnboarding,
  getWhatsapp,
  connectEmbedded,
  prepareEmbeddedSignup,
  completeEmbeddedSignup,
  connectManual,
  disconnectWhatsapp,
  updateOpeningTemplate,
  listTeam,
  inviteMember,
  updateMember,
  resetMemberPassword,
};
