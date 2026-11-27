const EmailSender = require("../../models/EmailSender");
const brevo = require("./brevoSenders");
const { assertOfficialEmail } = require("../../config/emailDomains");

/**
 * Company sender setup:  official email → OTP verify → domain authentication → ready.
 * All state lives in EmailSender; Brevo is only called through brevoSenders.js.
 */
const requireDomainAuth = () => String(process.env.EMAIL_REQUIRE_DOMAIN_AUTH ?? "true").toLowerCase() !== "false";

function appError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const getSender = (ownerId) => EmailSender.findOne({ ownerId });

/** Why a campaign can / cannot launch. `ready` is the single yes/no used by launch + worker. */
function readiness(sender) {
  if (!sender) return { ready: false, step: "email", reason: "Set up your official sender email first." };
  if (sender.paused) return { ready: false, step: "paused", reason: sender.pausedReason || "Email sending is paused for your account. Contact support." };
  if (sender.status !== "verified") return { ready: false, step: "verify", reason: "Verify your sender email with the code we sent." };
  if (requireDomainAuth() && sender.domainAuthStatus !== "authenticated") {
    return { ready: false, step: "domain", reason: "Authenticate your domain (add the DNS records) before sending." };
  }
  return { ready: true, step: "ready", reason: null };
}

function publicView(sender) {
  if (!sender) return { exists: false, ready: false, step: "email", requireDomainAuth: requireDomainAuth() };
  const r = readiness(sender);
  return {
    exists: true,
    email: sender.email,
    displayName: sender.displayName,
    domain: sender.domain,
    status: sender.status,
    domainAuthStatus: sender.domainAuthStatus,
    dnsRecords: (sender.dnsRecords || []).map((x) => ({ label: x.key, type: x.type, host: x.host, value: x.value, ok: Boolean(x.ok) })),
    lastError: sender.lastError || null,
    paused: Boolean(sender.paused),
    pausedReason: sender.pausedReason || null,
    ready: r.ready,
    step: r.step,
    reason: r.reason,
    requireDomainAuth: requireDomainAuth(),
    guidelinesAccepted: Boolean(sender.guidelinesAcceptedAt),
  };
}

/** Step 1: register the address; Brevo e-mails a 6-digit code to it. */
async function start({ org, ownerId, email, displayName, guidelinesAccepted }) {
  if (guidelinesAccepted !== true) throw appError("Please read and accept the email sending guidelines first.", "EMAIL_GUIDELINES_REQUIRED");
  const { email: addr, domain } = assertOfficialEmail(email); // blocks gmail/yahoo/disposable etc.
  const name = String(displayName || org?.name || "").trim().slice(0, 100);
  if (!name) throw appError("Enter the sender name (your company name).", "EMAIL_BAD_NAME");

  const taken = await EmailSender.findOne({ email: addr, ownerId: { $ne: ownerId } }).lean();
  if (taken) throw appError("This email address is already used by another company on Visitsly.", "EMAIL_ALREADY_USED");

  const existing = await getSender(ownerId);
  if (existing && existing.email === addr && existing.status === "verified") {
    existing.displayName = name;
    await existing.save();
    return existing; // nothing to redo
  }
  if (existing?.brevoSenderId && existing.email !== addr) await brevo.deleteSender(existing.brevoSenderId).catch(() => {});

  const made = await brevo.createSender({ email: addr, name });
  const alreadyActive = made.existing && made.active;
  const doc = await EmailSender.findOneAndUpdate(
    { ownerId },
    {
      $set: {
        orgId: org._id, ownerId, email: addr, displayName: name, brevoSenderId: made.id, domain,
        status: alreadyActive ? "verified" : "pending_verification",
        verifiedAt: alreadyActive ? new Date() : null,
        domainAuthStatus: "not_started", dnsRecords: [], lastError: null, guidelinesAcceptedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (alreadyActive) await startDomain(doc);
  return doc;
}

/** Step 2: the client types the 6-digit code from the Brevo e-mail. */
async function verifyOtp(ownerId, otp) {
  const sender = await getSender(ownerId);
  if (!sender) throw appError("Set up your sender email first.", "EMAIL_NO_SENDER");
  if (sender.status === "verified") return sender;
  try {
    await brevo.validateSender(sender.brevoSenderId, otp);
  } catch (err) {
    if (err.code === "EMAIL_SENDER_GONE") {
      sender.status = "failed";
      sender.lastError = err.message;
      await sender.save();
    }
    throw err;
  }
  sender.status = "verified";
  sender.verifiedAt = new Date();
  sender.lastError = null;
  await sender.save();
  await startDomain(sender);
  return sender;
}

/** Brevo has no documented "resend code" call: delete the pending sender and create it again. */
async function resendOtp(ownerId) {
  const sender = await getSender(ownerId);
  if (!sender) throw appError("Set up your sender email first.", "EMAIL_NO_SENDER");
  if (sender.status === "verified") throw appError("This sender is already verified.", "EMAIL_ALREADY_VERIFIED");
  if (sender.brevoSenderId) await brevo.deleteSender(sender.brevoSenderId).catch(() => {});
  const made = await brevo.createSender({ email: sender.email, name: sender.displayName });
  sender.brevoSenderId = made.id;
  sender.status = "pending_verification";
  sender.lastError = null;
  await sender.save();
  return sender;
}

function applyDomain(sender, d) {
  sender.dnsRecords = d.records.map((r) => ({ key: r.label || r.key, type: r.type, host: r.host, value: r.value, ok: r.ok }));
  if (d.authenticated) {
    sender.domainAuthStatus = "authenticated";
    sender.domainAuthenticatedAt = sender.domainAuthenticatedAt || new Date();
  } else if (sender.domainAuthStatus === "not_started") sender.domainAuthStatus = "pending";
}

/** Step 3a: add the domain in Brevo and keep the DNS records to show the client. */
async function startDomain(sender) {
  try {
    const d = await brevo.createDomain(sender.domain);
    applyDomain(sender, d);
    sender.lastError = null;
  } catch (err) {
    sender.domainAuthStatus = "failed";
    sender.lastError = err.message;
  }
  await sender.save();
  return sender;
}

/** Step 3b ("Check DNS"): re-read the records; when all are in place ask Brevo to authenticate. */
async function checkDns(ownerId) {
  const sender = await getSender(ownerId);
  if (!sender) throw appError("Set up your sender email first.", "EMAIL_NO_SENDER");
  if (sender.status !== "verified") throw appError("Verify your sender email first.", "EMAIL_NOT_VERIFIED");
  if (sender.domainAuthStatus === "not_started" || sender.domainAuthStatus === "failed" || !sender.dnsRecords?.length) {
    await startDomain(sender);
  }
  try {
    let d = await brevo.getDomain(sender.domain);
    applyDomain(sender, d);
    if (!d.authenticated) {
      const allOk = d.records.length > 0 && d.records.every((r) => r.ok);
      if (allOk && (await brevo.authenticateDomain(sender.domain))) {
        d = await brevo.getDomain(sender.domain);
        applyDomain(sender, d);
        if (!d.authenticated) {
          sender.domainAuthStatus = "authenticated";
          sender.domainAuthenticatedAt = new Date();
        }
      }
    }
    sender.lastError = sender.domainAuthStatus === "authenticated" ? null : "We could not find all DNS records yet. DNS changes can take up to a few hours.";
    if (sender.domainAuthStatus === "failed") sender.domainAuthStatus = "pending";
  } catch (err) {
    sender.lastError = err.message;
  }
  await sender.save();
  return sender;
}

/** Removes the sender (the domain stays in Brevo: other senders may use it). */
async function remove(ownerId) {
  const sender = await getSender(ownerId);
  if (!sender) return false;
  // Never pull the sender from under a running campaign.
  const running = await require("../../models/OutboundJob").countDocuments({ ownerId, channel: "email", status: { $in: ["pending", "processing"] } });
  if (running > 0) throw appError("An email campaign is still running. Cancel or finish it before removing the sender.", "EMAIL_CAMPAIGN_RUNNING");
  if (sender.brevoSenderId) await brevo.deleteSender(sender.brevoSenderId).catch(() => {});
  await EmailSender.deleteOne({ ownerId });
  return true;
}

/** Light background re-check: senders whose DNS was not ready yet are re-read every so often. */
async function recheckPending(limit = 50) {
  const list = await EmailSender.find({ status: "verified", domainAuthStatus: { $in: ["pending", "failed"] } }).limit(limit);
  let done = 0;
  for (const s of list) {
    try {
      await checkDns(s.ownerId);
      done += 1;
    } catch (_) { /* next */ }
  }
  return done;
}

module.exports = { recheckPending, requireDomainAuth, getSender, readiness, publicView, start, verifyOtp, resendOtp, startDomain, checkDns, remove };
