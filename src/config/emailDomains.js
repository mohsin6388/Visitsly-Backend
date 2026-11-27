/**
 * Free / personal / disposable e-mail domains that can NOT be used as a campaign
 * sender. This is the ONE place to edit the list. Extra domains can also be added
 * without a code change: EMAIL_BLOCKED_DOMAINS=foo.com,bar.com (comma separated).
 *
 * A company must send from its own official domain (name@yourcompany.com) so that
 * SPF/DKIM/DMARC can be set up and customers' replies reach the company.
 */
const BLOCKED_DOMAINS = [
  // Big free mailbox providers
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in", "yahoo.co.uk", "ymail.com", "rocketmail.com",
  "outlook.com", "outlook.in", "hotmail.com", "hotmail.co.uk", "hotmail.in", "live.com", "live.in", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "zoho.com", "zohomail.com",
  "zohomail.in", "gmx.com", "gmx.net", "gmx.de", "mail.com", "yandex.com", "yandex.ru", "rediffmail.com", "rediff.com",
  "inbox.com", "fastmail.com", "tutanota.com", "tuta.io", "hey.com", "qq.com", "163.com", "126.com", "naver.com",
  "web.de", "mail.ru", "bk.ru", "list.ru", "inbox.ru", "sify.com", "indiatimes.com", "in.com", "lycos.com",
  // Disposable / temporary inboxes
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "10minutemail.com", "10minutemail.net", "tempmail.com",
  "temp-mail.org", "temp-mail.io", "tempmail.net", "tempail.com", "throwawaymail.com", "yopmail.com", "yopmail.net",
  "getnada.com", "nada.email", "sharklasers.com", "grr.la", "dispostable.com", "trashmail.com", "trashmail.net",
  "maildrop.cc", "mintemail.com", "moakt.com", "mohmal.com", "fakeinbox.com", "emailondeck.com", "spamgourmet.com",
  "mailnesia.com", "mytemp.email", "burnermail.io", "tmpmail.org", "tmpmail.net", "mail.tm", "discard.email",
  "mailcatch.com", "inboxkitten.com", "spam4.me", "anonaddy.com", "simplelogin.com",
];

const extra = String(process.env.EMAIL_BLOCKED_DOMAINS || "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const BLOCKED = new Set([...BLOCKED_DOMAINS, ...extra]);

const OFFICIAL_EMAIL_MESSAGE = "Please use your official company email";
const EMAIL_RE = /^[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

/** Domain part of an address, lower-cased ("" when it is not a valid address). */
function domainOf(email) {
  const m = String(email || "").trim().toLowerCase().match(EMAIL_RE);
  return m ? m[1] : "";
}

/** true when the domain (or its parent, e.g. mail.gmail.com) is on the block list. */
function isBlockedDomain(domain) {
  const d = String(domain || "").trim().toLowerCase();
  if (!d) return true;
  const parts = d.split(".");
  for (let i = 0; i < parts.length - 1; i += 1) if (BLOCKED.has(parts.slice(i).join("."))) return true;
  return false;
}

/**
 * Validates a sender address. Returns { email, domain } or throws an Error with
 * code EMAIL_BAD_ADDRESS / EMAIL_PERSONAL_DOMAIN and a client-ready message.
 */
function assertOfficialEmail(input) {
  const email = String(input || "").trim().toLowerCase();
  const domain = domainOf(email);
  if (!domain) {
    const err = new Error("Enter a valid email address.");
    err.code = "EMAIL_BAD_ADDRESS";
    throw err;
  }
  // Also honour the platform-wide DISPOSABLE_EMAIL_DOMAINS list (same one used at sign-up).
  if (isBlockedDomain(domain) || require("../services/auth/emailAddress").isDisposableEmail(email)) {
    const err = new Error(OFFICIAL_EMAIL_MESSAGE);
    err.code = "EMAIL_PERSONAL_DOMAIN";
    throw err;
  }
  return { email, domain };
}

module.exports = { BLOCKED_DOMAINS, OFFICIAL_EMAIL_MESSAGE, domainOf, isBlockedDomain, assertOfficialEmail };
