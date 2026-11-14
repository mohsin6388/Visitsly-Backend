const jwt = require('jsonwebtoken');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const env = require('../config/env');
const Organization = require('../models/Organization');
const ChannelPartner = require('../models/ChannelPartner');
const Lead = require('../models/Lead');
const Meeting = require('../models/Meeting');
const Property = require('../models/Property');
const PropertySite = require('../models/PropertySite');
const Notification = require('../models/Notification');
const tenantContext = require('../context/tenantContext');
const orgService = require('../services/saas/orgService');
const { captureLead, normalizePhone } = require('../services/leads/leadCapture');

/**
 * Channel partner (CP) portal: external brokers register with a builder,
 * submit buyers (with lead protection), track their leads' stage, see live
 * inventory + brochures, and their commission. Builders approve CPs and set
 * commission from Company → Channel partners.
 */
const DAY = 24 * 60 * 60 * 1000;
const CP_AUD = 'propai-cp';

async function orgBySlug(slug) {
  const org = await Organization.findOne({ slug: String(slug || '').toLowerCase() }).select('_id').lean();
  const snap = org ? await orgService.getSnapshot(org._id) : null;
  if (!snap || !snap.channelPartners?.enabled) throw ApiError.notFound('Channel partner programme not found');
  return snap;
}

function cpView(cp, org) {
  return {
    id: String(cp._id),
    name: cp.name,
    firmName: cp.firmName,
    phone: cp.phone,
    email: cp.email,
    city: cp.city,
    reraNumber: cp.reraNumber,
    status: cp.status,
    commissionPct: cp.commissionPct ?? org?.channelPartners?.defaultCommissionPct ?? 0,
    createdAt: cp.createdAt,
  };
}

/* ---------------- Public ---------------- */

const info = asyncHandler(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  return new ApiResponse(200, {
    company: org.branding?.productName || org.name,
    logoUrl: org.branding?.logoUrl || '',
    city: org.city,
    commissionPct: org.channelPartners.defaultCommissionPct,
    leadProtectionDays: org.channelPartners.leadProtectionDays,
  }).send(res);
});

const register = asyncHandler(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  const phone = normalizePhone(req.body.phone);
  if (!phone) throw ApiError.badRequest('Valid mobile number chahiye');
  const email = String(req.body.email).trim().toLowerCase();
  if (await ChannelPartner.exists({ orgId: org._id, $or: [{ email }, { phone }] })) throw ApiError.conflict('Is email/phone se pehle se registration hai — login karein');
  const cp = new ChannelPartner({
    orgId: org._id,
    ownerId: org.ownerUserId,
    name: req.body.name,
    firmName: req.body.firmName || '',
    phone,
    email,
    city: req.body.city || '',
    reraNumber: req.body.reraNumber || '',
    status: org.channelPartners.autoApprove ? 'approved' : 'pending',
  });
  await cp.setPassword(req.body.password);
  await cp.save();
  await Notification.create({ userId: org.ownerUserId, type: 'cp_registered', title: `Naya channel partner: ${cp.name}`, body: `${cp.firmName || ''} ${cp.city || ''} — ${cp.status === 'approved' ? 'auto-approved' : 'approval pending'}`.trim(), link: '/channel-partners' }).catch(() => {});
  return new ApiResponse(201, { partner: cpView(cp, org) }, cp.status === 'approved' ? 'Registration ho gaya — login karein' : 'Registration ho gaya — builder ke approve karte hi login kar payenge').send(res);
});

const login = asyncHandler(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  const id = String(req.body.email || '').trim().toLowerCase();
  const cp = await ChannelPartner.findOne({ orgId: org._id, $or: [{ email: id }, { phone: normalizePhone(id) || '__' }] }).select('+passwordHash');
  if (!cp || !(await cp.comparePassword(req.body.password))) throw ApiError.unauthorized('Email/phone ya password galat hai');
  if (cp.status === 'pending') throw ApiError.forbidden('Aapka registration abhi approve nahi hua');
  if (cp.status !== 'approved') throw ApiError.forbidden('Aapka account active nahi hai — builder se baat karein');
  cp.lastLoginAt = new Date();
  await cp.save();
  const token = jwt.sign({ sub: String(cp._id), org: String(org._id), v: cp.tokenVersion, aud: CP_AUD }, env.jwt.accessSecret, { expiresIn: '12h' });
  return new ApiResponse(200, { token, partner: cpView(cp, org), company: org.branding?.productName || org.name }).send(res);
});

/* ---------------- CP auth ---------------- */

async function cpAuth(req, res, next) {
  try {
    const [scheme, token] = String(req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) throw ApiError.unauthorized('Login required');
    let p;
    try {
      p = jwt.verify(token, env.jwt.accessSecret, { audience: CP_AUD });
    } catch {
      throw ApiError.unauthorized('Session expired — dobara login karein');
    }
    const cp = await ChannelPartner.findById(p.sub);
    if (!cp || cp.status !== 'approved' || cp.tokenVersion !== p.v) throw ApiError.unauthorized('Account not active');
    const org = await orgService.getSnapshot(cp.orgId);
    if (!org || !org.channelPartners?.enabled) throw ApiError.forbidden('Programme band hai');
    req.cp = cp;
    req.cpOrg = org;
    tenantContext.run(org, () => next());
  } catch (err) {
    next(err);
  }
}

const STAGE = (lead, visits) => {
  if (lead.bookedAt) return 'booked';
  if (lead.status === 'lost') return 'lost';
  if (visits.some((m) => m.status === 'visited')) return 'visited';
  if (visits.length) return 'visit_scheduled';
  if (['hot', 'warm', 'qualified', 'contacted'].includes(lead.status) || lead.leadScore > 0) return 'in_discussion';
  return 'registered';
};

const me = asyncHandler(async (req, res) => {
  const leads = await Lead.find({ channelPartnerId: req.cp._id }).select('bookedAt dealValue').lean();
  const pct = req.cp.commissionPct ?? req.cpOrg.channelPartners.defaultCommissionPct ?? 0;
  const bookings = leads.filter((l) => l.bookedAt);
  return new ApiResponse(200, {
    partner: cpView(req.cp, req.cpOrg),
    company: req.cpOrg.branding?.productName || req.cpOrg.name,
    leadProtectionDays: req.cpOrg.channelPartners.leadProtectionDays,
    stats: {
      leads: leads.length,
      bookings: bookings.length,
      commissionEarned: Math.round(bookings.reduce((a, l) => a + ((l.dealValue || 0) * pct) / 100, 0)),
    },
  }).send(res);
});

const myLeads = asyncHandler(async (req, res) => {
  const leads = await Lead.find({ channelPartnerId: req.cp._id }).sort({ createdAt: -1 }).limit(500).lean();
  const meetings = await Meeting.find({ leadId: { $in: leads.map((l) => l._id) } }).select('leadId status preferredDate preferredTime').lean();
  const pct = req.cp.commissionPct ?? req.cpOrg.channelPartners.defaultCommissionPct ?? 0;
  const items = leads.map((l) => {
    const visits = meetings.filter((m) => String(m.leadId) === String(l._id));
    const next = visits.filter((m) => m.status === 'scheduled').sort((a, b) => `${a.preferredDate}${a.preferredTime}`.localeCompare(`${b.preferredDate}${b.preferredTime}`))[0];
    return {
      id: String(l._id),
      name: l.name,
      phone: l.phone,
      project: l.project,
      stage: STAGE(l, visits),
      nextVisit: next ? `${next.preferredDate} ${next.preferredTime}` : null,
      protectedUntil: l.cpProtectedUntil,
      dealValue: l.bookedAt ? l.dealValue : null,
      commission: l.bookedAt && l.dealValue ? Math.round((l.dealValue * pct) / 100) : null,
      createdAt: l.createdAt,
    };
  });
  return new ApiResponse(200, { items }).send(res);
});

const submitLead = asyncHandler(async (req, res) => {
  const org = req.cpOrg;
  const phone = normalizePhone(req.body.phone);
  if (!phone) throw ApiError.badRequest('Customer ka valid mobile number chahiye');
  // Lead protection: a buyer already in the builder's CRM can't be claimed.
  const existing = await Lead.findOne({ ownerId: org.ownerUserId, phone: { $in: [phone, `+${phone}`] } }).select('channelPartnerId cpProtectedUntil').lean();
  if (existing) {
    const mine = existing.channelPartnerId && String(existing.channelPartnerId) === String(req.cp._id);
    throw ApiError.conflict(mine ? 'Ye customer aap pehle hi register kar chuke hain' : 'Ye customer pehle se builder ke paas registered hai — is par claim nahi ho sakta');
  }
  const protectedUntil = new Date(Date.now() + (org.channelPartners.leadProtectionDays || 60) * DAY);
  const result = await captureLead({
    name: req.body.name,
    phone,
    email: req.body.email,
    project: req.body.project,
    budgetMax: req.body.budget,
    message: [req.body.notes, req.body.visitDate ? `CP visit request: ${req.body.visitDate}` : null].filter(Boolean).join(' | '),
    source: 'channel_partner',
    sourceDetail: `${req.cp.name}${req.cp.firmName ? ` (${req.cp.firmName})` : ''}`,
    channelPartnerId: req.cp._id,
    cpProtectedUntil: protectedUntil,
  });
  return new ApiResponse(201, { id: String(result.lead._id), protectedUntil }, `Customer register ho gaya — ${org.channelPartners.leadProtectionDays} din tak aapke naam protected`).send(res);
});

const inventory = asyncHandler(async (req, res) => {
  const [props, sites] = await Promise.all([
    Property.find({ isActive: true }).select('projectName propertyType bhk location city budgetMin budgetMax sizeSqft availability possession reraNumber brochureUrl').limit(500).lean(),
    PropertySite.find({}).select('name city location brochures mapsLink').lean(),
  ]);
  const items = props.map((p) => {
    const site = sites.find((s) => String(s.name).toLowerCase().trim() === String(p.projectName).toLowerCase().trim());
    const brochure = site?.brochures?.length ? site.brochures[site.brochures.length - 1] : null;
    return {
      project: p.projectName,
      type: p.propertyType,
      bhk: p.bhk,
      location: [p.location, p.city].filter(Boolean).join(', '),
      sizeSqft: p.sizeSqft,
      priceMin: p.budgetMin,
      priceMax: p.budgetMax,
      availability: p.availability || 'available',
      possession: p.possession || null,
      rera: p.reraNumber || null,
      brochureUrl: brochure?.url || p.brochureUrl || null,
      mapsLink: site?.mapsLink || null,
    };
  });
  return new ApiResponse(200, { items }).send(res);
});

/* ---------------- Builder side (tenant) ---------------- */

const listPartners = asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.org._id).select('channelPartners slug').lean();
  const partners = await ChannelPartner.find({ orgId: req.org._id }).sort({ createdAt: -1 }).lean();
  const leads = await Lead.find({ ownerId: req.user.id, channelPartnerId: { $ne: null } }).select('channelPartnerId bookedAt dealValue').lean();
  const def = org.channelPartners?.defaultCommissionPct ?? 0;
  const items = partners.map((p) => {
    const mine = leads.filter((l) => String(l.channelPartnerId) === String(p._id));
    const pct = p.commissionPct ?? def;
    const bookings = mine.filter((l) => l.bookedAt);
    return { ...cpView(p, { channelPartners: { defaultCommissionPct: def } }), leads: mine.length, bookings: bookings.length, commissionDue: Math.round(bookings.reduce((a, l) => a + ((l.dealValue || 0) * pct) / 100, 0)), lastLoginAt: p.lastLoginAt };
  });
  return new ApiResponse(200, {
    settings: { ...(org.channelPartners || {}), portalUrl: `${env.clientUrl.replace(/\/+$/, '')}/cp/${org.slug}` },
    items,
  }).send(res);
});

const updatePartner = asyncHandler(async (req, res) => {
  const cp = await ChannelPartner.findOne({ _id: req.params.id, orgId: req.org._id });
  if (!cp) throw ApiError.notFound('Partner not found');
  if (req.body.status) {
    cp.status = req.body.status;
    if (req.body.status !== 'approved') cp.tokenVersion += 1; // log them out
  }
  if (req.body.commissionPct !== undefined) cp.commissionPct = req.body.commissionPct;
  await cp.save();
  return new ApiResponse(200, { partner: cpView(cp, req.org) }, 'Partner updated').send(res);
});

const updateSettings = asyncHandler(async (req, res) => {
  const $set = {};
  for (const k of ['enabled', 'defaultCommissionPct', 'leadProtectionDays', 'autoApprove']) {
    if (req.body[k] !== undefined) $set[`channelPartners.${k}`] = req.body[k];
  }
  await Organization.updateOne({ _id: req.org._id }, { $set });
  orgService.invalidate(req.org._id);
  return new ApiResponse(200, null, 'Saved').send(res);
});

/** POST /api/org/deals/:leadId — mark a lead booked (deal value drives CP commission + reports). */
const markBooked = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.leadId, ownerId: req.user.id });
  if (!lead) throw ApiError.notFound('Lead not found');
  if (req.body.undo) {
    lead.bookedAt = null;
    lead.dealValue = null;
  } else {
    lead.bookedAt = req.body.bookedAt ? new Date(req.body.bookedAt) : new Date();
    lead.dealValue = req.body.dealValue || null;
    lead.status = 'closed';
  }
  await lead.save();
  return new ApiResponse(200, { lead }, req.body.undo ? 'Booking hata di' : 'Booking mark ho gayi 🎉').send(res);
});

module.exports = { info, register, login, cpAuth, me, myLeads, submitLead, inventory, listPartners, updatePartner, updateSettings, markBooked };
