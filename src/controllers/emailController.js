const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const EmailMessage = require("../models/EmailMessage");
const logger = require("../utils/logger");

const TZ = "Asia/Kolkata";
const FAILED_STATES = ["failed", "bounced", "complained", "suppressed"];
const PENDING_STATES = ["queued", "sending"];

const ownerFilter = (req) => ({ ownerId: req.user.id });

/* ------------------------------------------------------------------ */
/* Company sender (official email, verified through Brevo) + wallet     */
/* ------------------------------------------------------------------ */

const AuditLog = require("../models/AuditLog");
const Organization = require("../models/Organization");
const senders = require("../services/email/emailSenderService");
const wallet = require("../services/email/emailWallet");
const safety = require("../services/email/emailSafety");

const audit = (req, action, meta = {}) =>
  AuditLog.create({ userId: req.user.actorId, action, meta, ip: req.ip }).catch(
    () => {},
  );

/** Domain errors from the services carry EMAIL_* / BREVO_* codes and client-ready messages. */
function asClientError(err) {
  const code = String(err?.code || "");
  if (code.startsWith("EMAIL_") || code.startsWith("BREVO_"))
    return ApiError.badRequest(err.message);
  return err;
}
const guard = (fn) =>
  asyncHandler(async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err) {
      throw asClientError(err);
    }
  });

async function freshOrg(req) {
  return Organization.findById(req.org._id).select("name emailWallet").lean();
}

/** GET /api/email/status — sender + wallet + today's usage in one call (setup page). */
const status = asyncHandler(async (req, res) => {
  const [sender, org] = await Promise.all([
    senders.getSender(req.user.id),
    freshOrg(req),
  ]);
  if (sender?.status === "pending_verification")
    await senders.syncActive(sender).catch(() => {}); // Brevo may have activated it (no code is sent then)
  const view = senders.publicView(sender);
  if (sender) view.sentToday = await safety.sentToday(req.user.id);
  view.dailyCap = safety.dailyCap();
  return new ApiResponse(200, {
    sender: view,
    wallet: wallet.summary(org),
    featureEnabled: require("../services/saas/subscription").hasFeature(
      req.org,
      "emailCampaigns",
    ),
  }).send(res);
});

/** POST /api/email/sender { email, displayName, guidelinesAccepted } — Brevo emails a 6-digit code. */
const startSender = guard(async (req, res) => {
  const sender = await senders.start({
    org: req.org,
    ownerId: req.user.id,
    email: req.body?.email,
    displayName: req.body?.displayName,
    guidelinesAccepted: req.body?.guidelinesAccepted,
  });
  await audit(req, "email.sender.start", { email: sender.email });
  const startMsg =
    sender.status === "verified"
      ? "Your email is verified."
      : sender.status === "awaiting_domain"
        ? "Add the DNS records below first. We will email the code right after."
        : "We sent a 6-digit code to this email";
  return new ApiResponse(
    200,
    { sender: senders.publicView(sender) },
    startMsg,
  ).send(res);
});

/** POST /api/email/sender/verify { otp } */
const verifySender = guard(async (req, res) => {
  const sender = await senders.verifyOtp(req.user.id, req.body?.otp);
  await audit(req, "email.sender.verify", { email: sender.email });
  return new ApiResponse(
    200,
    { sender: senders.publicView(sender) },
    "Email verified",
  ).send(res);
});

/** POST /api/email/sender/resend — new code (Brevo has no resend call: the sender is re-created). */
const resendSender = guard(async (req, res) => {
  const sender = await senders.resendOtp(req.user.id);
  return new ApiResponse(
    200,
    { sender: senders.publicView(sender) },
    sender.status === "verified"
      ? "Your email is already verified."
      : "We sent a new code",
  ).send(res);
});

/** POST /api/email/sender/check-dns — re-read DNS status and authenticate when ready. */
const checkDns = guard(async (req, res) => {
  const sender = await senders.checkDns(req.user.id);
  await audit(req, "email.sender.check_dns", {
    domain: sender.domain,
    domainAuthStatus: sender.domainAuthStatus,
  });
  return new ApiResponse(200, { sender: senders.publicView(sender) }).send(res);
});

/** DELETE /api/email/sender */
const removeSender = guard(async (req, res) => {
  await senders.remove(req.user.id);
  await audit(req, "email.sender.remove");
  return new ApiResponse(200, { removed: true }, "Sender removed").send(res);
});

/** GET /api/email/wallet — balance, price per email (incl. GST), recent recharges. No cost / margin. */
const getWallet = asyncHandler(async (req, res) => {
  const org = await freshOrg(req);
  const ledger = await wallet.recentLedger(req.org._id, 20);
  return new ApiResponse(200, {
    wallet: wallet.summary(org),
    history: ledger.map((t) => ({
      _id: t._id,
      type:
        t.type === "admin_credit" || t.type === "recharge" ? "credit" : "debit",
      emails: t.emails,
      amount: t.amountMilli / 1000,
      at: t.createdAt,
    })),
  }).send(res);
});

/** GET /api/email/estimate?count=N — launch-time cost estimate. */
const estimate = asyncHandler(async (req, res) => {
  const org = await freshOrg(req);
  return new ApiResponse(200, {
    estimate: wallet.estimate(org, req.query.count),
  }).send(res);
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
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(req.query.limit, 10) || 25),
  );
  const base = { ...ownerFilter(req), direction: "outbound", kind: "campaign" };
  const range = istRange(req.query.from, req.query.to);
  const and = [base];
  const dateFilter = dateClause(range);
  if (dateFilter) and.push(dateFilter);
  if (req.query.campaignId && mongoose.isValidObjectId(req.query.campaignId))
    and.push({ campaignId: req.query.campaignId });

  const scoped = { $and: [...and] }; // summary / daily ke liye (status + search ke bina)

  const status = String(req.query.status || "");
  if (status === "sent")
    and.push({
      status: { $nin: [...FAILED_STATES, ...PENDING_STATES, "cancelled"] },
    });
  else if (status === "failed") and.push({ status: { $in: FAILED_STATES } });
  else if (status === "pending") and.push({ status: { $in: PENDING_STATES } });

  const search = String(req.query.search || "")
    .trim()
    .slice(0, 120);
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    and.push({ $or: [{ to: rx }, { subject: rx }] });
  }
  const filter = { $and: and };

  const ownerObjectId = new mongoose.Types.ObjectId(String(req.user.id));
  const dayExpr = {
    $dateToString: {
      format: "%Y-%m-%d",
      date: { $ifNull: ["$sentAt", "$createdAt"] },
      timezone: TZ,
    },
  };
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
    EmailMessage.aggregate([
      { $match: { ownerId: ownerObjectId, ...scopedMatch(scoped) } },
      { $group: { _id: bucket, n: { $sum: 1 } } },
    ]),
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
    if (!byDay.has(day))
      byDay.set(day, { date: day, sent: 0, failed: 0, pending: 0, total: 0 });
    const entry = byDay.get(day);
    if (row._id.bucket in entry) entry[row._id.bucket] += row.n;
    if (row._id.bucket !== "cancelled") entry.total += row.n;
  }

  return new ApiResponse(200, {
    items: items.map((m) => ({
      _id: m._id,
      to: m.to,
      subject: m.subject,
      status: FAILED_STATES.includes(m.status)
        ? "failed"
        : PENDING_STATES.includes(m.status)
          ? "pending"
          : m.status === "cancelled"
            ? "cancelled"
            : "sent",
      errorMessage: m.errorMessage || null,
      sentAt: m.sentAt || null,
      createdAt: m.createdAt,
      lead: m.leadId
        ? { _id: m.leadId._id, name: m.leadId.name, phone: m.leadId.phone }
        : null,
      campaign: m.campaignId
        ? { _id: m.campaignId._id, name: m.campaignId.name }
        : null,
    })),
    summary,
    daily: [...byDay.values()].slice(0, 31),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  }).send(res);
});

/** $and filter ko aggregate $match me use karne layak banata hai (ObjectId cast ke saath). */
function scopedMatch(scoped) {
  const cast = (clause) => {
    const out = { ...clause };
    if (out.campaignId)
      out.campaignId = new mongoose.Types.ObjectId(String(out.campaignId));
    delete out.ownerId;
    return out;
  };
  return { $and: scoped.$and.map(cast) };
}

/**
 * GET|POST /api/webhooks/email-unsubscribe/:token — public. The link in every bulk email
 * (and the one-click List-Unsubscribe header) lands here. Only stops EMAIL campaigns.
 */
const unsubscribe = async (req, res) => {
  const leadId = require("../utils/emailUnsub").verifyToken(req.params.token);
  const page = (title, text) =>
    res
      .status(leadId ? 200 : 400)
      .type("html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:Arial,Helvetica,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f8fafc;margin:0"><div style="max-width:420px;padding:32px;text-align:center;background:#fff;border-radius:14px;box-shadow:0 1px 8px rgba(0,0,0,.08)"><h2 style="margin:0 0 10px;color:#064e3b">${title}</h2><p style="color:#475569;line-height:1.6;margin:0">${text}</p></div></body></html>`,
      );
  if (!leadId)
    return page(
      "Invalid link",
      "This unsubscribe link is invalid or incomplete.",
    );
  try {
    await require("../models/Lead").updateOne(
      { _id: leadId },
      { $set: { emailOptedOut: true, emailOptedOutAt: new Date() } },
    );
  } catch (err) {
    logger.error("[email] unsubscribe failed", { error: err.message });
    return res
      .status(500)
      .type("html")
      .send("Something went wrong. Please try again later.");
  }
  if (req.method === "POST") return res.json({ ok: true }); // mail clients' one-click
  return page(
    "You are unsubscribed",
    "You will no longer receive emails from this company.",
  );
};

module.exports = {
  unsubscribe,
  status,
  startSender,
  verifySender,
  resendSender,
  checkDns,
  removeSender,
  getWallet,
  estimate,
  details,
};
