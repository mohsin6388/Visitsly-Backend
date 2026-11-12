const Lead = require("../models/Lead");
const Organization = require("../models/Organization");
const AuditLog = require("../models/AuditLog");
const policy = require("../services/compliance/messagingPolicy");
const logger = require("../utils/logger");

/**
 * Public unsubscribe for campaign emails — no login.
 *
 *   GET  /api/public/unsubscribe/:token  → confirmation page (link scanners in
 *        mail servers open GET links, so GET never unsubscribes by itself)
 *   POST /api/public/unsubscribe/:token  → unsubscribes. Also used by Gmail /
 *        Yahoo one-click (body "List-Unsubscribe=One-Click", RFC 8058).
 *   GET  /api/public/unsubscribe/:token/status → JSON for the frontend page.
 */

const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function companyNameFor(lead) {
  if (!lead) return "";
  const org = await Organization.findOne({ ownerUserId: lead.ownerId }).select("name branding").lean();
  return org?.branding?.productName ? org.name : org?.name || "";
}

function page({ title, body, form = "" }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f5f8ff;color:#0b1b3f;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}
.card{background:#fff;border:1px solid #e2e8f5;border-radius:16px;max-width:440px;width:100%;padding:28px;box-shadow:0 10px 30px rgba(11,27,63,.08)}
h1{font-size:20px;margin:0 0 10px}p{color:#5b6788;line-height:1.55;margin:0 0 16px}
button{background:#2563eb;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:700;font-size:15px;cursor:pointer;width:100%}</style>
</head><body><div class="card"><h1>${esc(title)}</h1>${body}${form}</div></body></html>`;
}

async function resolve(token) {
  const data = policy.readUnsubscribeToken(token);
  if (!data) return null;
  const lead = await Lead.findById(data.leadId).select("ownerId email consent emailSuppressed").lean();
  if (!lead) return null;
  return { ...data, lead };
}

const show = async (req, res) => {
  const r = await resolve(req.params.token).catch(() => null);
  res.set("Cache-Control", "no-store");
  if (!r) {
    return res.status(404).type("html").send(page({ title: "Link not valid", body: "<p>This unsubscribe link is invalid or has expired.</p>" }));
  }
  const company = await companyNameFor(r.lead);
  if (r.lead.consent?.email?.status === "opted_out") {
    return res.type("html").send(page({ title: "You are unsubscribed", body: `<p>You will not receive marketing emails${company ? ` from ${esc(company)}` : ""}.</p>` }));
  }
  return res.type("html").send(
    page({
      title: "Unsubscribe from emails",
      body: `<p>Stop marketing emails${company ? ` from <b>${esc(company)}</b>` : ""} to ${esc(r.lead.email || "this address")}?</p>`,
      form: `<form method="POST"><button type="submit">Yes, unsubscribe me</button></form>`,
    }),
  );
};

const confirm = async (req, res) => {
  const r = await resolve(req.params.token).catch(() => null);
  res.set("Cache-Control", "no-store");
  const wantsJson = req.is("application/json") || String(req.get("accept") || "").includes("application/json");
  if (!r) {
    if (wantsJson) return res.status(404).json({ success: false, message: "Invalid link" });
    return res.status(404).type("html").send(page({ title: "Link not valid", body: "<p>This unsubscribe link is invalid.</p>" }));
  }
  try {
    await policy.applyEmailOptOut(r.lead._id, "unsubscribed");
    await AuditLog.create({
      userId: r.lead.ownerId,
      action: "lead.email_unsubscribe",
      entityType: "Lead",
      entityId: r.lead._id,
      meta: { oneClick: String(req.body?.["List-Unsubscribe"] || "") === "One-Click" },
      ip: req.ip,
    }).catch(() => {});
  } catch (err) {
    logger.error("[unsubscribe] Failed", { error: err.message });
    if (wantsJson) return res.status(500).json({ success: false, message: "Please try again" });
    return res.status(500).type("html").send(page({ title: "Something went wrong", body: "<p>Please try again in a minute.</p>" }));
  }
  if (wantsJson) return res.json({ success: true, unsubscribed: true });
  const company = await companyNameFor(r.lead);
  return res.type("html").send(page({ title: "You are unsubscribed", body: `<p>You will no longer receive marketing emails${company ? ` from ${esc(company)}` : ""}.</p>` }));
};

const status = async (req, res) => {
  const r = await resolve(req.params.token).catch(() => null);
  if (!r) return res.status(404).json({ success: false, message: "Invalid link" });
  return res.json({
    success: true,
    data: { email: r.lead.email || "", company: await companyNameFor(r.lead), unsubscribed: r.lead.consent?.email?.status === "opted_out" },
  });
};

module.exports = { show, confirm, status };
