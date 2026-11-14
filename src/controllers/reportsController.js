const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const { buildReport } = require('../services/reports/reportsService');

/** GET /api/reports?range=7d|30d|90d|this_month|last_month */
const getReport = asyncHandler(async (req, res) => {
  const range = ['7d', '30d', '90d', 'this_month', 'last_month'].includes(req.query.range) ? req.query.range : '30d';
  const report = await buildReport(req.user.id, req.org?._id, range);
  const org = req.org;
  return new ApiResponse(200, { report, weeklyReport: org?.weeklyReport || null }).send(res);
});

module.exports = { getReport };

/* ------------------------------------------------------------------ */
/* Spend budget                                                        */
/* ------------------------------------------------------------------ */
const budgetService = require('../services/budget/budgetService');
const OrganizationModel = require('../models/Organization');
const orgServiceForBudget = require('../services/saas/orgService');

function budgetView(org) {
  const b = org.budget || {};
  return {
    enabled: !!b.enabled,
    amount: b.amount || 0,
    currency: b.currency || org.currency || 'INR',
    period: b.period || 'month',
    startDate: b.startDate || null,
    endDate: b.endDate || null,
    thresholds: b.thresholds?.length ? b.thresholds : [50, 80, 100],
    alertPhone: b.alertPhone || '',
    pauseCampaignsAtLimit: !!b.pauseCampaignsAtLimit,
    rates: { marketing: 0.88, utility: 0.13, authentication: 0.13, service: 0, voicePerMinute: 7, ...(b.rates || {}) },
    lastAlert: b.lastAlert || null,
  };
}

/** GET /api/reports/budget — settings + live spend for the current period. */
const getBudget = require('../utils/asyncHandler')(async (req, res) => {
  const org = await OrganizationModel.findById(req.org._id).select('_id ownerUserId budget name currency').lean();
  const spend = await budgetService.computeSpend(org);
  return new (require('../utils/ApiResponse'))(200, { budget: budgetView(org), spend }).send(res);
});

/** PATCH /api/reports/budget */
const updateBudget = require('../utils/asyncHandler')(async (req, res) => {
  const b = req.body || {};
  const $set = {};
  for (const k of ['enabled', 'amount', 'currency', 'period', 'startDate', 'endDate', 'alertPhone', 'pauseCampaignsAtLimit']) {
    if (b[k] !== undefined) $set[`budget.${k}`] = b[k];
  }
  if (Array.isArray(b.thresholds)) $set['budget.thresholds'] = [...new Set(b.thresholds.map(Number).filter((n) => n > 0 && n <= 200))].sort((x, y) => x - y);
  if (b.rates) for (const [k, v] of Object.entries(b.rates)) if (Number.isFinite(Number(v))) $set[`budget.rates.${k}`] = Number(v);
  // Changing the amount or period re-arms the alerts.
  if (b.amount !== undefined || b.period !== undefined || b.startDate !== undefined) $set['budget.lastAlert'] = { periodKey: null, level: 0, at: null };
  if (b.period === 'custom' && (!b.startDate || !b.endDate || b.startDate > b.endDate)) {
    throw require('../utils/ApiError').badRequest('Custom period ke liye sahi start aur end date chunein');
  }
  await OrganizationModel.updateOne({ _id: req.org._id }, { $set });
  orgServiceForBudget.invalidate(req.org._id);
  const org = await OrganizationModel.findById(req.org._id).select('_id ownerUserId budget name currency').lean();
  const spend = await budgetService.computeSpend(org);
  return new (require('../utils/ApiResponse'))(200, { budget: budgetView(org), spend }, 'Budget save ho gaya').send(res);
});

/** POST /api/reports/budget/send — send the spend report to WhatsApp now. */
const sendBudgetReport = require('../utils/asyncHandler')(async (req, res) => {
  const org = await OrganizationModel.findById(req.org._id).select('_id ownerUserId budget name currency').lean();
  const spend = await budgetService.computeSpend(org);
  const result = await budgetService.sendReport(org, spend);
  const ok = result.whatsapp.some((r) => r.ok);
  return new (require('../utils/ApiResponse'))(200, { result, spend }, ok ? 'Report WhatsApp par bhej di' : result.email?.ok ? 'WhatsApp nahi gaya (24 ghante ka window band) — report email par bhej di' : 'Report nahi gayi — Settings mein alert number / template check karein').send(res);
});

module.exports.getBudget = getBudget;
module.exports.updateBudget = updateBudget;
module.exports.sendBudgetReport = sendBudgetReport;
