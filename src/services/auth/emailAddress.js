const env = require('../../config/env');

// A blocklist is an abuse filter, not proof that a mailbox is genuine.
// Inbox verification remains the source of truth. Deployments can extend this
// list through DISPOSABLE_EMAIL_DOMAINS without a code release.
const DEFAULT_DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '10minutemail.org',
  'tempmail.com', 'temp-mail.org', 'tempmail.net', 'temp-mail.io',
  'mailinator.com', 'mailinator.net', 'yopmail.com', 'yopmail.fr',
  'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com',
  'grr.la', 'getnada.com', 'nada.email', 'maildrop.cc',
  'throwawaymail.com', 'fakeinbox.com', 'mailnesia.com',
  'moakt.com', 'minuteinbox.com', 'emailondeck.com', 'trashmail.com',
  'dispostable.com', 'mintemail.com', 'mohmal.com', 'burnermail.io',
]);

function emailDomain(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  return at > 0 ? normalized.slice(at + 1) : '';
}

function isDisposableEmail(email) {
  const domain = emailDomain(email);
  if (!domain) return false;
  const configured = new Set([...DEFAULT_DISPOSABLE_DOMAINS, ...(env.disposableEmailDomains || [])]);
  for (const blocked of configured) {
    if (domain === blocked || domain.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

module.exports = { emailDomain, isDisposableEmail };
