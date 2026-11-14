const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const EmailMessage = require("../models/EmailMessage");
const accounts = require("../services/email/emailAccountService");
const logger = require("../utils/logger");

const TZ = "Asia/Kolkata";
const FAILED_STATES = ["failed", "bounced", "complained", "suppressed"];
const PENDING_STATES = ["queued", "sending"];

const ownerFilter = (req) => ({ ownerId: req.user.id });

/* ------------------------------------------------------------------ */
/* Email account (client ka apna official email)                       */
/* ------------------------------------------------------------------ */

/** GET /api/email/account */
const getAccount = asyncHandler(async (req, res) => {
  const account = await accounts.getAccount(req.user.id);
  return new ApiResponse(200, { account: accounts.publicView(account) }).send(res);
});

/** PUT /api/email/account — login verify hota hai, tabhi save. */
const saveAccount = asyncHandler(async (req, res) => {
  try {
    const account = await accounts.saveAccount(req.user.id, req.body || {});
    return new ApiResponse(200, { account }, "Email account connect ho gaya").send(res);
  } catch (err) {
    if (String(err.code || "").startsWith("EMAIL_")) throw ApiError.badRequest(err.message);
    throw err;
  }
});

/** POST /api/email/account/test — apne aap ko test email. */
const testAccount = asyncHandler(async (req, res) => {
  const account = await accounts.getAccount(req.user.id, { withPassword: true });
  if (!account) throw ApiError.badRequest("Pehle email account connect karein.");
  const to = String(req.body?.to || account.fromEmail).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw ApiError.badRequest("Sahi email address daaliye.");
  try {
    await accounts.sendMail(account, {
      to,
      subject: "Visitsly test email",
      text: "Ye Visitsly se ek test email hai. Agar ye mil gayi, to aapka email account sahi connect hai.",
    });
    await accounts.getAccount(req.user.id).then((a) => a && a.updateOne({ $set: { status: "connected", lastError: null } }));
    return new ApiResponse(200, { to }, `Test email ${to} par bhej di`).send(res);
  } catch (err) {
    const message = accounts.friendlyError(err);
    await accounts.markError(req.user.id, message);
    logger.warn("[email] Test email failed", { ownerId: String(req.user.id), error: err.message });
    throw ApiError.badRequest(message);
  }
});

/** DELETE /api/email/account */
const removeAccount = asyncHandler(async (req, res) => {
  await accounts.removeAccount(req.user.id);
  return new ApiResponse(200, { removed: true }, "Email account hata diya").send(res);
});

/* ------------------------------------------------------------------ */
/* Delivery details: sent / failed, din ke hisaab se                   */
/* ------------------------------------------------------------------ */

function istRange(from, to) {
  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  const start = isDay(from) ? new Date(`${from}T00:00:00+05:30`) : null;
  const end = isDay(to) ? new Date(`${to}T23:59:59.999+05:30`) : null;
  return { start, end };
}

/** Email ka "din" = jis din bheji gayi (sentAt), na bheji ho to jab queue hui. */
function dateClause({ start, end }) {
  if (!start && !end) return null;
  const range = {};
  if (start) range.$gte = start;
  if (end) range.$lte = end;
  return { $or: [{ sentAt: range }, { sentAt: null, createdAt: range }] };
}

/**
 * GET /api/email/details?status=sent|failed|pending&from=YYYY-MM-DD&to=YYYY-MM-DD&search=&campaignId=
 * Response: items (page), summary (selected date range), daily (din ke hisaab se count).
 */
const details = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const base = { ...ownerFilter(req), direction: "outbound", kind: "campaign" };
  const range = istRange(req.query.from, req.query.to);
  const and = [base];
  const dateFilter = dateClause(range);
  if (dateFilter) and.push(dateFilter);
  if (req.query.campaignId && mongoose.isValidObjectId(req.query.campaignId)) and.push({ campaignId: req.query.campaignId });

  const scoped = { $and: [...and] }; // summary / daily ke liye (status + search ke bina)

  const status = String(req.query.status || "");
  if (status === "sent") and.push({ status: { $nin: [...FAILED_STATES, ...PENDING_STATES, "cancelled"] } });
  else if (status === "failed") and.push({ status: { $in: FAILED_STATES } });
  else if (status === "pending") and.push({ status: { $in: PENDING_STATES } });

  const search = String(req.query.search || "").trim().slice(0, 120);
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    and.push({ $or: [{ to: rx }, { subject: rx }] });
  }
  const filter = { $and: and };

  const ownerObjectId = new mongoose.Types.ObjectId(String(req.user.id));
  const dayExpr = { $dateToString: { format: "%Y-%m-%d", date: { $ifNull: ["$sentAt", "$createdAt"] }, timezone: TZ } };
  const bucket = {
    $switch: {
      branches: [
        { case: { $in: ["$status", FAILED_STATES] }, then: "failed" },
        { case: { $in: ["$status", PENDING_STATES] }, then: "pending" },
        { case: { $eq: ["$status", "cancelled"] }, then: "cancelled" },
      ],
      default: "sent",
    },
  };

  const [items, total, grouped, daily] = await Promise.all([
    EmailMessage.find(filter)
      .populate("leadId", "name phone email")
      .populate("campaignId", "name")
      .sort({ sentAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    EmailMessage.countDocuments(filter),
    EmailMessage.aggregate([{ $match: { ownerId: ownerObjectId, ...scopedMatch(scoped) } }, { $group: { _id: bucket, n: { $sum: 1 } } }]),
    EmailMessage.aggregate([
      { $match: { ownerId: ownerObjectId, ...scopedMatch(scoped) } },
      { $group: { _id: { day: dayExpr, bucket }, n: { $sum: 1 } } },
      { $sort: { "_id.day": -1 } },
      { $limit: 400 },
    ]),
  ]);

  const summary = { total: 0, sent: 0, failed: 0, pending: 0 };
  for (const g of grouped) {
    if (g._id in summary) summary[g._id] = g.n;
    if (g._id !== "cancelled") summary.total += g.n;
  }

  const byDay = new Map();
  for (const row of daily) {
    const day = row._id.day;
    if (!byDay.has(day)) byDay.set(day, { date: day, sent: 0, failed: 0, pending: 0, total: 0 });
    const entry = byDay.get(day);
    if (row._id.bucket in entry) entry[row._id.bucket] += row.n;
    if (row._id.bucket !== "cancelled") entry.total += row.n;
  }

  return new ApiResponse(200, {
    items: items.map((m) => ({
      _id: m._id,
      to: m.to,
      subject: m.subject,
      status: FAILED_STATES.includes(m.status) ? "failed" : PENDING_STATES.includes(m.status) ? "pending" : m.status === "cancelled" ? "cancelled" : "sent",
      errorMessage: m.errorMessage || null,
      sentAt: m.sentAt || null,
      createdAt: m.createdAt,
      lead: m.leadId ? { _id: m.leadId._id, name: m.leadId.name, phone: m.leadId.phone } : null,
      campaign: m.campaignId ? { _id: m.campaignId._id, name: m.campaignId.name } : null,
    })),
    summary,
    daily: [...byDay.values()].slice(0, 31),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  }).send(res);
});

/** $and filter ko aggregate $match me use karne layak banata hai (ObjectId cast ke saath). */
function scopedMatch(scoped) {
  const cast = (clause) => {
    const out = { ...clause };
    if (out.campaignId) out.campaignId = new mongoose.Types.ObjectId(String(out.campaignId));
    delete out.ownerId;
    return out;
  };
  return { $and: scoped.$and.map(cast) };
}

module.exports = { getAccount, saveAccount, testAccount, removeAccount, details };
