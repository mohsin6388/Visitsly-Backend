/**
 * Spend budget: how much the company has spent on WhatsApp (Meta) + AI
 * calling in the budget period, compared with the budget it set.
 *
 * - WhatsApp cost comes from Meta's pricing_analytics when Meta returns COST;
 *   otherwise it is estimated from message volume × per-category rate
 *   (rates are editable by the company — Meta changes prices by country).
 * - AI calling = billed minutes × per-minute rate.
 * - At each threshold (default 50 / 80 / 100 %) the owner gets ONE WhatsApp
 *   report (falls back to template / email — see ownerAlerts.js).
 *
 * Functions that read Meta must run inside the company's tenant context.
 */
const Organization = require("../../models/Organization");
const CallLog = require("../../models/CallLog");
const tenantContext = require("../../context/tenantContext");
const orgService = require("../saas/orgService");
const { getMetaUsage } = require("../meta/metaBillingService");
const { withLock } = require("../../utils/distributedLock");
const logger = require("../../utils/logger");

const IST = 330 * 60000;
const DAY = 86400000;

function istDate(d = new Date()) {
  return new Date(d.getTime() + IST).toISOString().slice(0, 10);
}

/** Start/end (Date) and a stable key for the current budget period. */
function periodFor(budget = {}) {
  if (budget.period === "custom" && budget.startDate && budget.endDate) {
    const start = new Date(`${budget.startDate}T00:00:00+05:30`);
    const end = new Date(`${budget.endDate}T23:59:59+05:30`);
    return { start, end, key: `${budget.startDate}_${budget.endDate}`, label: `${budget.startDate} – ${budget.endDate}` };
  }
  const today = istDate();
  const [y, m] = today.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - IST);
  const end = new Date(Date.UTC(y, m, 1) - IST - 1000);
  const label = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  return { start, end, key: `${y}-${String(m).padStart(2, "0")}`, label };
}

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function computeSpend(orgDoc) {
  const budget = orgDoc.budget || {};
  const rates = { marketing: 0.88, utility: 0.13, authentication: 0.13, service: 0, voicePerMinute: 7, ...(budget.rates || {}) };
  const period = periodFor(budget);
  const now = new Date();
  const until = now < period.end ? now : period.end;

  // ---- WhatsApp (Meta) ----
  let whatsapp = { cost: 0, estimated: true, currency: budget.currency || "INR", lines: [], error: null };
  try {
    const usage = await getMetaUsage({ range: "custom", start: period.start, end: until });
    if (usage.error) whatsapp.error = usage.error;
    else {
      const useMetaCost = usage.costAvailable && (usage.currency || "INR") === (budget.currency || "INR");
      for (const c of usage.byCategory || []) {
        const key = String(c.category || "").toLowerCase().replace("_international", "");
        const est = (c.chargedVolume || 0) * (rates[key] ?? 0);
        const cost = useMetaCost ? c.cost : est;
        whatsapp.lines.push({ category: c.category, volume: c.volume, chargedVolume: c.chargedVolume, cost: round(cost) });
        whatsapp.cost += cost;
      }
      whatsapp.estimated = !useMetaCost;
      whatsapp.cost = round(whatsapp.cost);
    }
  } catch (err) {
    whatsapp.error = err.message;
  }

  // ---- AI calling ----
  const calls = await CallLog.aggregate([
    { $match: { ownerId: orgDoc.ownerUserId, createdAt: { $gte: period.start, $lte: until } } },
    { $group: { _id: null, minutes: { $sum: "$billedMinutes" }, calls: { $sum: 1 } } },
  ]);
  const minutes = calls[0]?.minutes || 0;
  const voice = { minutes, calls: calls[0]?.calls || 0, cost: round(minutes * rates.voicePerMinute) };

  const total = round(whatsapp.cost + voice.cost);
  const amount = Number(budget.amount) || 0;
  const elapsedDays = Math.max(1, (until - period.start) / DAY);
  const totalDays = Math.max(1, (period.end - period.start) / DAY);
  const projected = round((total / elapsedDays) * totalDays);
  return {
    period: { key: period.key, label: period.label, start: period.start, end: period.end },
    currency: budget.currency || "INR",
    amount,
    total,
    percent: amount > 0 ? Math.round((total / amount) * 1000) / 10 : 0,
    projected,
    remaining: round(Math.max(0, amount - total)),
    whatsapp,
    voice,
    rates,
    computedAt: new Date(),
  };
}

function money(n, currency = "INR") {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n);
  } catch {
    return `${currency} ${Math.round(n)}`;
  }
}

const CATEGORY_LABEL = { MARKETING: "WhatsApp marketing", UTILITY: "WhatsApp utility", AUTHENTICATION: "WhatsApp OTP", SERVICE: "WhatsApp chat (service)", REFERRAL_CONVERSION: "Ad se aaye chats" };

function reportLines(spend) {
  const c = spend.currency;
  const lines = [
    `Budget: ${money(spend.amount, c)} (${spend.period.label})`,
    `Kharcha ab tak: ${money(spend.total, c)} (${spend.percent}%)`,
    `Bacha hua: ${money(spend.remaining, c)}`,
  ];
  for (const l of spend.whatsapp.lines.filter((x) => x.cost > 0 || x.volume > 0).slice(0, 5)) {
    lines.push(`• ${CATEGORY_LABEL[l.category] || l.category}: ${l.volume} msgs ≈ ${money(l.cost, c)}`);
  }
  if (spend.voice.minutes) lines.push(`• AI calling: ${spend.voice.minutes} min ≈ ${money(spend.voice.cost, c)}`);
  if (spend.projected > spend.total) lines.push(`Isi speed se period ke end tak ≈ ${money(spend.projected, c)}`);
  if (spend.whatsapp.estimated) lines.push("(WhatsApp kharcha andaazan hai — final bill Meta ke invoice par)");
  return lines;
}

/** Sends the spend report to the owner now (tenant context required). */
async function sendReport(orgDoc, spend, { level = null } = {}) {
  const { sendOwnerAlert } = require("../alerts/ownerAlerts");
  const title = level
    ? level >= 100
      ? `🚨 BUDGET POORA HO GAYA (${spend.percent}%)`
      : `💰 Budget ${level}% tak pahunch gaya (${spend.percent}%)`
    : "💰 Kharcha report";
  const extra = [];
  if (level >= 100 && orgDoc.budget?.pauseCampaignsAtLimit) extra.push("Naye bulk campaigns pause kar diye gaye hain. Budget badha kar Resume karein.");
  // Budget alerts may go to a dedicated number.
  const alertPhone = orgDoc.budget?.alertPhone;
  if (alertPhone) {
    const metaWhatsappClient = require("../whatsapp/metaWhatsappClient");
    try {
      await metaWhatsappClient.sendTextMessage({ phone: alertPhone, text: [title, ...reportLines(spend), ...extra].join("\n") });
    } catch (err) {
      logger.info("[budget] direct alert phone failed, using owner alert ladder", { error: err.message });
    }
  }
  return sendOwnerAlert({ kind: "budget", title, lines: [...reportLines(spend), ...extra], link: "/reports?tab=budget", templateValues: [title, money(spend.total, spend.currency), money(spend.amount, spend.currency), `${spend.percent}%`, spend.period.label] });
}

async function pauseActiveCampaigns(ownerId) {
  const Campaign = require("../../models/Campaign");
  const queue = require("../queue/outboundQueue");
  const active = await Campaign.find({ ownerId, status: "active" }).select("_id").lean();
  for (const c of active) {
    // eslint-disable-next-line no-await-in-loop
    await queue.pauseCampaign(ownerId, c._id).catch(() => null);
  }
  return active.length;
}

/** Hourly: check every company with a budget and alert at thresholds. */
async function tick() {
  const orgs = await Organization.find({ "budget.enabled": true, "budget.amount": { $gt: 0 }, status: { $in: ["trialing", "active", "past_due"] } })
    .select("_id ownerUserId budget name")
    .lean();
  for (const org of orgs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await orgService.runForOrg(org._id, async () => {
        const spend = await computeSpend(org);
        const thresholds = [...(org.budget.thresholds?.length ? org.budget.thresholds : [50, 80, 100])].sort((a, b) => a - b);
        const crossed = thresholds.filter((t) => spend.percent >= t).pop();
        const last = org.budget.lastAlert || {};
        const lastLevel = last.periodKey === spend.period.key ? last.level || 0 : 0;
        if (!crossed || crossed <= lastLevel) return;
        // Claim first so a parallel run never double-alerts.
        const claim = await Organization.updateOne(
          { _id: org._id, $or: [{ "budget.lastAlert.periodKey": { $ne: spend.period.key } }, { "budget.lastAlert.level": { $lt: crossed } }] },
          { $set: { "budget.lastAlert": { periodKey: spend.period.key, level: crossed, at: new Date() } } },
        );
        if (!claim.modifiedCount) return;
        if (crossed >= 100 && org.budget.pauseCampaignsAtLimit) await pauseActiveCampaigns(org.ownerUserId);
        await sendReport(org, spend, { level: crossed });
        logger.info("[budget] threshold alert sent", { org: String(org._id), level: crossed, percent: spend.percent });
      });
    } catch (err) {
      logger.warn("[budget] check failed", { org: String(org._id), error: err.message });
    }
  }
}

let handle = null;
function startBudgetScheduler() {
  if (handle) return;
  const run = () => withLock("budget-alerts", 50 * 60 * 1000, tick).catch((err) => logger.error("[budget] tick failed", { error: err.message }));
  handle = setInterval(run, 60 * 60 * 1000);
  setTimeout(run, 2 * 60 * 1000).unref?.();
  logger.info("[budget] Scheduler started (hourly)");
}

async function getForCurrentOrg() {
  const org = tenantContext.getOrg();
  const doc = await Organization.findById(org._id).select("_id ownerUserId budget name currency").lean();
  return doc;
}

module.exports = { computeSpend, periodFor, sendReport, tick, startBudgetScheduler, getForCurrentOrg, reportLines };
