const axios = require("axios");
const env = require("../../config/env");

/**
 * Thin wrapper over Brevo's Senders & Domains API (platform account, api-key header).
 * Only documented endpoints are used:
 *   POST   /v3/senders                                  → 201 { id }      (Brevo e-mails a 6-digit OTP to the address)
 *   PUT    /v3/senders/{senderId}/validate  { otp }     → 204
 *   GET    /v3/senders                                  → { senders: [{ id, name, email, active }] }
 *   DELETE /v3/senders/{senderId}
 *   POST   /v3/senders/domains { name }                 → { domain_name, dns_records{...} }
 *   GET    /v3/senders/domains/{domainName}             → { domain, verified, authenticated, dns_records{...} }
 *   PUT    /v3/senders/domains/{domainName}/authenticate
 *   DELETE /v3/senders/domains/{domainName}
 */
const BASE = "https://api.brevo.com/v3";
let http = axios.create({ baseURL: BASE, timeout: 20_000 });
/** test hook */
const _setHttp = (h) => {
  http = h;
};

function appError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const configured = () => Boolean(env.brevo?.apiKey);
function assertConfigured() {
  if (!configured())
    throw appError(
      "Email service is not configured yet. Please contact support.",
      "BREVO_NOT_CONFIGURED",
    );
}

const headers = () => ({
  "api-key": env.brevo.apiKey,
  "Content-Type": "application/json",
  Accept: "application/json",
});

/** Brevo error → Error with a client-ready message and a stable code. */
function wrap(err, fallback) {
  if (err?.code && String(err.code).startsWith("BREVO_") && !err.response)
    return err;
  const status = Number(err?.response?.status || 0) || undefined;
  const msg = String(
    err?.response?.data?.message || err?.message || fallback,
  ).slice(0, 300);
  let code = "BREVO_ERROR";
  if (status === 401 || status === 403) code = "BREVO_AUTH_ERROR";
  else if (status === 429) code = "BREVO_RATE_LIMIT";
  else if (status === 404) code = "BREVO_NOT_FOUND";
  else if (status === 400) code = "BREVO_BAD_REQUEST";
  const e = appError(
    status === 401 || status === 403
      ? "Email service is temporarily unavailable. Please contact support."
      : msg || fallback,
    code,
    { status },
  );
  e.providerMessage = msg;
  return e;
}

async function call(method, url, { data, fallback } = {}) {
  assertConfigured();
  try {
    return await http.request({ method, url, data, headers: headers() });
  } catch (err) {
    throw wrap(err, fallback || "Email provider request failed");
  }
}

/* ------------------------------ senders ------------------------------ */

async function listSenders() {
  const { data } = await call("get", "/senders", {
    fallback: "Could not read senders",
  });
  return Array.isArray(data?.senders) ? data.senders : [];
}

/** Creates a sender; Brevo e-mails an OTP to `email`. Re-uses the sender when it already exists in our account. */
async function createSender({ email, name }) {
  try {
    const { data } = await call("post", "/senders", {
      data: { email, name },
      fallback: "Could not create the sender",
    });
    const id = Number(data?.id);
    // On an already authenticated domain Brevo activates the sender at once and sends NO code.
    let active = false;
    try {
      const found = (await listSenders()).find((s) => Number(s.id) === id);
      active = Boolean(found && found.active);
    } catch {
      /* unknown → treat as "needs a code" */
    }
    return {
      id,
      spfError: Boolean(data?.spfError),
      dkimError: Boolean(data?.dkimError),
      existing: false,
      active,
    };
  } catch (err) {
    if (
      err.code === "BREVO_BAD_REQUEST" &&
      /already|exist|duplicate/i.test(err.providerMessage || "")
    ) {
      const found = (await listSenders()).find(
        (s) => String(s.email).toLowerCase() === email.toLowerCase(),
      );
      if (found)
        return {
          id: Number(found.id),
          spfError: false,
          dkimError: false,
          existing: true,
          active: found.active !== false,
        };
    }
    throw err;
  }
}

/** OTP verification. Returns true; throws EMAIL_OTP_INVALID / EMAIL_OTP_EXPIRED / EMAIL_OTP_DONE. */
async function validateSender(senderId, otp) {
  const n = Number.parseInt(String(otp || "").replace(/\D/g, ""), 10);
  if (
    !Number.isInteger(n) ||
    String(otp || "").replace(/\D/g, "").length !== 6
  ) {
    throw appError(
      "Enter the 6-digit code we emailed to this address.",
      "EMAIL_OTP_INVALID",
    );
  }
  try {
    await call("put", `/senders/${encodeURIComponent(senderId)}/validate`, {
      data: { otp: n },
      fallback: "Could not verify the code",
    });
    return true;
  } catch (err) {
    const m = String(err.providerMessage || "");
    if (/expired/i.test(m))
      throw appError(
        "This code has expired. Request a new code.",
        "EMAIL_OTP_EXPIRED",
      );
    if (/already processed/i.test(m)) return true; // sender is already validated
    if (/invalid otp/i.test(m))
      throw appError(
        "That code is not correct. Check it and try again.",
        "EMAIL_OTP_INVALID",
      );
    if (err.code === "BREVO_NOT_FOUND")
      throw appError(
        "This sender no longer exists. Start again.",
        "EMAIL_SENDER_GONE",
      );
    throw err;
  }
}

async function deleteSender(senderId) {
  try {
    await call("delete", `/senders/${encodeURIComponent(senderId)}`, {
      fallback: "Could not remove the sender",
    });
  } catch (err) {
    if (err.code !== "BREVO_NOT_FOUND") throw err;
  }
}

/* ------------------------------ domains ------------------------------ */

// Brevo sends the two DKIM records as camelCase (dkim1Record / dkim2Record); older accounts use snake_case.
const RECORD_KEYS = [
  ["brevo_code", "Brevo code"],
  ["dkim_record", "DKIM"],
  ["dkim1Record", "DKIM 1"],
  ["dkim2Record", "DKIM 2"],
  ["dkim1_record", "DKIM 1"],
  ["dkim2_record", "DKIM 2"],
  ["dmarc_record", "DMARC"],
  ["spf_record", "SPF"],
];

/** Brevo dns_records object → flat list for the UI. */
function normalizeRecords(dns = {}) {
  const out = [];
  for (const [key, label] of RECORD_KEYS) {
    const r = dns?.[key];
    if (!r || typeof r !== "object") continue;
    out.push({
      key,
      label,
      type: String(r.type || "TXT").toUpperCase(),
      host: String(r.host_name || r.host || ""),
      value: String(r.value || ""),
      ok: r.status === true,
    });
  }
  return out;
}

async function createDomain(domain) {
  try {
    const { data } = await call("post", "/senders/domains", {
      data: { name: domain },
      fallback: "Could not add the domain",
    });
    return {
      domain: data?.domain_name || domain,
      records: normalizeRecords(data?.dns_records),
      verified: false,
      authenticated: false,
    };
  } catch (err) {
    if (
      err.code === "BREVO_BAD_REQUEST" &&
      /already exist/i.test(err.providerMessage || "")
    )
      return getDomain(domain);
    throw err;
  }
}

async function getDomain(domain) {
  const { data } = await call(
    "get",
    `/senders/domains/${encodeURIComponent(domain)}`,
    { fallback: "Could not read the domain" },
  );
  return {
    domain: data?.domain || domain,
    records: normalizeRecords(data?.dns_records),
    verified: Boolean(data?.verified),
    authenticated: Boolean(data?.authenticated),
  };
}

/** Asks Brevo to authenticate the domain. Returns true, or false when DNS is not ready yet. */
async function authenticateDomain(domain) {
  try {
    await call(
      "put",
      `/senders/domains/${encodeURIComponent(domain)}/authenticate`,
      { fallback: "Could not authenticate the domain" },
    );
    return true;
  } catch (err) {
    if (err.code === "BREVO_BAD_REQUEST") return false; // "DNS records not properly configured"
    throw err;
  }
}

async function deleteDomain(domain) {
  try {
    await call("delete", `/senders/domains/${encodeURIComponent(domain)}`, {
      fallback: "Could not remove the domain",
    });
  } catch (err) {
    if (err.code !== "BREVO_NOT_FOUND") throw err;
  }
}

module.exports = {
  configured,
  listSenders,
  createSender,
  validateSender,
  deleteSender,
  createDomain,
  getDomain,
  authenticateDomain,
  deleteDomain,
  normalizeRecords,
  _setHttp,
};
