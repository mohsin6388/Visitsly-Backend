const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const env = require('../config/env');
const tenantContext = require('../context/tenantContext');
const Property = require('../models/Property');
const { captureLead, orgByCaptureKey } = require('../services/leads/leadCapture');
const metaLeadAds = require('../services/leads/metaLeadAds');
const logger = require('../utils/logger');

/**
 * PUBLIC lead-capture endpoints. The company's secret capture key in the URL
 * identifies the company (like a webhook secret).
 */
async function withOrg(key, fn) {
  const org = await orgByCaptureKey(key);
  if (!org) throw ApiError.notFound('Form not found');
  if (['suspended', 'cancelled'].includes(org.status)) throw ApiError.forbidden('Form is not active');
  return tenantContext.run(org, () => fn(org));
}

const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj[k] ?? obj[k.toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return undefined;
};

/** GET /api/inbound/form/:key — hosted form info (company name, logo, projects). */
const formInfo = asyncHandler(async (req, res) => {
  await withOrg(req.params.key, async (org) => {
    const projects = await Property.distinct('projectName', { isActive: true });
    return new ApiResponse(200, {
      company: org.branding?.productName || org.name,
      logoUrl: org.branding?.logoUrl || '',
      city: org.city || '',
      projects: projects.filter(Boolean).slice(0, 50),
    }).send(res);
  });
});

/**
 * POST /api/inbound/leads/:key — website forms, hosted form, n8n / Zapier /
 * Pabbly, any CRM webhook. Accepts JSON or form-encoded.
 */
const submitLead = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.website || b._gotcha) return new ApiResponse(200, { ok: true }).send(res); // honeypot → silently drop bots
  await withOrg(req.params.key, async () => {
    const result = await captureLead({
      name: pick(b, ['name', 'full_name', 'fullName', 'Name']),
      phone: pick(b, ['phone', 'mobile', 'phone_number', 'whatsapp', 'Phone', 'Mobile']),
      email: pick(b, ['email', 'Email', 'email_address']),
      city: pick(b, ['city', 'City']),
      location: pick(b, ['location', 'locality']),
      project: pick(b, ['project', 'property', 'Project']),
      budgetMin: pick(b, ['budgetMin', 'budget_min']),
      budgetMax: pick(b, ['budgetMax', 'budget_max']) || (Number(pick(b, ['budget'])) ? pick(b, ['budget']) : undefined),
      message: [pick(b, ['message', 'requirement', 'comments', 'Message']), (() => { const bud = pick(b, ['budget']); return bud && Number.isNaN(Number(bud)) ? `Budget: ${bud}` : null; })()].filter(Boolean).join(' | ') || undefined,
      source: pick(b, ['source', 'utm_source']) || 'website_form',
      sourceDetail: [pick(b, ['utm_campaign', 'campaign']), pick(b, ['page', 'page_url', 'form'])].filter(Boolean).join(' · ') || undefined,
    });
    if (!result.lead) throw ApiError.badRequest('Phone ya email zaroori hai');
    if (req.is('application/x-www-form-urlencoded') && b.redirect && /^https?:\/\//.test(b.redirect)) {
      return res.redirect(303, b.redirect);
    }
    return new ApiResponse(201, { ok: true, repeat: !result.created }, 'Thank you! Hum jald contact karenge.').send(res);
  });
});

/**
 * POST /api/inbound/google-ads/:key — Google Ads lead form extension webhook.
 * Set the webhook URL to this endpoint and the "key" to the same capture key.
 */
const googleAds = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.google_key && b.google_key !== req.params.key) throw ApiError.unauthorized('Invalid google_key');
  await withOrg(req.params.key, async () => {
    if (b.is_test) return res.json({});
    const cols = {};
    const extra = [];
    for (const c of b.user_column_data || []) {
      const id = String(c.column_id || '').toUpperCase();
      const val = c.string_value;
      if (id === 'FULL_NAME') cols.name = val;
      else if (id === 'FIRST_NAME') cols.name = `${val} ${cols.name || ''}`.trim();
      else if (id === 'LAST_NAME') cols.name = `${cols.name || ''} ${val}`.trim();
      else if (id === 'PHONE_NUMBER') cols.phone = val;
      else if (id === 'EMAIL') cols.email = val;
      else if (id === 'CITY') cols.city = val;
      else extra.push(`${c.column_name || id}: ${val}`);
    }
    await captureLead({ ...cols, message: extra.join(' | '), source: 'google_ads', sourceDetail: `campaign ${b.campaign_id || ''} form ${b.form_id || ''}`.trim(), externalId: b.lead_id ? `google:${b.lead_id}` : null });
    return res.json({});
  });
});

/* ---- Meta Lead Ads webhook (Page object, field "leadgen") ---- */
const metaLeadsVerify = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  if (mode === 'subscribe' && token && token === env.platformMeta.verifyToken) return res.status(200).send(req.query['hub.challenge']);
  return res.sendStatus(403);
};

const metaLeadsReceive = (req, res) => {
  res.sendStatus(200); // ack fast; Meta retries otherwise
  metaLeadAds.handleWebhook(req.body).catch((err) => logger.error('[meta-leads] webhook failed', { error: err.message }));
};

module.exports = { formInfo, submitLead, googleAds, metaLeadsVerify, metaLeadsReceive };
