const EmailMessage = require("../../models/EmailMessage");
const EmailSender = require("../../models/EmailSender");
const logger = require("../../utils/logger");

/**
 * Sending-reputation guard rails for campaign e-mail (platform Brevo account is shared,
 * so one careless company must not hurt everybody).
 *
 *  - per-company daily cap (IST day): EMAIL_DAILY_CAP_PER_COMPANY (0 = no cap)
 *  - auto-pause the company's e-mail when, over the last 7 days and with at least
 *    EMAIL_BOUNCE_MIN_SAMPLE e-mails sent, the bounce rate or complaint rate crosses
 *    EMAIL_MAX_BOUNCE_RATE / EMAIL_MAX_COMPLAINT_RATE.
 */
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
const dailyCap = () => Math.floor(num("EMAIL_DAILY_CAP_PER_COMPANY", 1000));
const thresholds = () => ({
  minSample: Math.max(1, Math.floor(num("EMAIL_BOUNCE_MIN_SAMPLE", 100))),
  maxBounce: num("EMAIL_MAX_BOUNCE_RATE", 0.05),
  maxComplaint: num("EMAIL_MAX_COMPLAINT_RATE", 0.003),
});

const SENT_STATES = ["sent", "delivered", "delivery_delayed", "bounced", "complained"];
const IST_MS = 5.5 * 60 * 60 * 1000;
function istDayStart(now = Date.now()) {
  const ist = new Date(now + IST_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_MS);
}

async function sentToday(ownerId) {
  return EmailMessage.countDocuments({
    ownerId, direction: "outbound", kind: "campaign",
    status: { $in: ["sending", ...SENT_STATES] },
    sentAt: { $gte: istDayStart() },
  });
}

/** Pure decision, easy to test. */
function decide({ sent, bounced, complained }, t = thresholds()) {
  if (sent < t.minSample) return { pause: false };
  const bounceRate = bounced / sent;
  const complaintRate = complained / sent;
  if (complaintRate > t.maxComplaint) return { pause: true, reason: `Email paused: spam-complaint rate is too high (${(complaintRate * 100).toFixed(2)}%).`, bounceRate, complaintRate };
  if (bounceRate > t.maxBounce) return { pause: true, reason: `Email paused: too many emails bounced (${(bounceRate * 100).toFixed(1)}%). Clean your list.`, bounceRate, complaintRate };
  return { pause: false, bounceRate, complaintRate };
}

const lastChecked = new Map();
/** Cheap (cached 60 s per company). Pauses the sender when the thresholds are crossed. */
async function check(ownerId, { force = false } = {}) {
  const key = String(ownerId);
  if (!force && Date.now() - (lastChecked.get(key) || 0) < 60_000) return { pause: false, skipped: true };
  lastChecked.set(key, Date.now());
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const base = { ownerId, direction: "outbound", kind: "campaign", sentAt: { $gte: since } };
  const [sent, bounced, complained] = await Promise.all([
    EmailMessage.countDocuments({ ...base, status: { $in: SENT_STATES } }),
    EmailMessage.countDocuments({ ...base, status: "bounced" }),
    EmailMessage.countDocuments({ ...base, status: "complained" }),
  ]);
  const d = decide({ sent, bounced, complained });
  if (d.pause) {
    const r = await EmailSender.updateOne({ ownerId, paused: { $ne: true } }, { $set: { paused: true, pausedReason: d.reason, pausedAt: new Date() } });
    if (r?.modifiedCount || r?.matchedCount) {
      logger.warn("[email] auto-paused company e-mail", { ownerId: key, reason: d.reason });
      d.newlyPaused = true;
      try {
        const Notification = require("../../models/Notification");
        await Notification.create({ userId: ownerId, type: "plan_limit", title: "Email sending paused", body: `${d.reason} Contact support after cleaning your list to resume.`, link: "/email/setup" });
        require("../../sockets").emitToUser(ownerId, "notification:new", {});
      } catch (err) {
        logger.warn("[email] could not notify owner of auto-pause", { error: err.message });
      }
    }
  }
  return d;
}

module.exports = { dailyCap, thresholds, istDayStart, sentToday, decide, check, SENT_STATES };
