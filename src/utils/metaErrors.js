/**
 * Plain-language explanations for Meta WhatsApp send errors.
 * Stored job errors look like "(#131037) WhatsApp provided number needs ...".
 * `fix: 'whatsapp_setup'` tells the UI to show a "Check setup" link.
 */
const SEND_ERRORS = {
  131037: { text: 'Display name is not approved by Meta yet. Submit it in WhatsApp Manager > Phone numbers > Display name (usually minutes to 48 hours).', fix: 'whatsapp_setup' },
  131047: { text: 'No reply from the customer in 24 hours. Send an approved template first.' },
  131026: { text: 'Not delivered. The number may not be on WhatsApp or uses an old app version.' },
  131030: { text: 'This number is not on the test list. Meta test numbers only message approved test recipients. Connect your real number.', fix: 'whatsapp_setup' },
  131042: { text: 'No payment method on your Meta account. Add a card in WhatsApp Manager > Payment settings.', fix: 'whatsapp_setup' },
  131048: { text: 'Meta limited sending due to spam signals. Wait a few hours and message only interested contacts.' },
  131049: { text: 'Meta blocked marketing messages to this customer (low engagement). Try later.' },
  131056: { text: 'Too many messages to this customer too quickly. Try again shortly.' },
  130429: { text: 'Meta rate limit hit. It will retry automatically.' },
  131051: { text: 'This message type is not supported.' },
  132000: { text: 'Template variables are missing. Fill all template variables.' },
  132001: { text: 'Template not found or not approved by Meta. Check the Templates page.' },
  132015: { text: 'Template paused (low quality). Create a new template.' },
  190: { text: 'Facebook connection expired. Reconnect WhatsApp.', fix: 'whatsapp_setup' },
  133010: { text: 'Number is not registered on Cloud API. Reconnect WhatsApp and enter the PIN.', fix: 'whatsapp_setup' },
};

function explainSendError(raw) {
  if (!raw) return { message: raw, fix: null };
  const match = String(raw).match(/#?\((?:#)?(\d{3,7})\)|\(#(\d{3,7})\)|code[:\s]+(\d{3,7})/i);
  const code = match ? Number(match[1] || match[2] || match[3]) : null;
  const known = code && SEND_ERRORS[code];
  if (!known) return { message: raw, fix: null };
  return { message: known.text, fix: known.fix || null, code };
}

module.exports = { explainSendError, SEND_ERRORS };
