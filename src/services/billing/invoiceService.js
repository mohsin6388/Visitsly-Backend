const Invoice = require('../../models/Invoice');
const Counter = require('../../models/Counter');
const Organization = require('../../models/Organization');
const User = require('../../models/User');
const env = require('../../config/env');
const pricing = require('../../config/pricing');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');

/**
 * Invoices: numbering, tax breakup, buyer snapshot, PDF and e-mail.
 *
 * Everything here is best-effort around a payment: callers wrap these in
 * try/catch (or use the fire-and-forget helpers) so an invoice problem can
 * never change a payment, a plan or an add-on activation.
 */

const RESENDS_PER_DAY = 5;
const PAID_STATES = ['paid', 'refunded'];

/* ------------------------------------------------------------------ */
/* Issuer (seller) — optional env vars, never invented                  */
/* ------------------------------------------------------------------ */
function issuer() {
  const v = (k) => String(process.env[k] || '').trim();
  return {
    name: v('INVOICE_COMPANY_NAME') || env.saas.productName,
    gstin: v('INVOICE_GSTIN'),
    address: v('INVOICE_ADDRESS').replace(/\\n/g, '\n'),
    pan: v('INVOICE_PAN'),
    sac: v('INVOICE_SAC'),
    email: v('INVOICE_EMAIL'),
    phone: v('INVOICE_PHONE'),
  };
}

/* ------------------------------------------------------------------ */
/* Tax breakup                                                          */
/* ------------------------------------------------------------------ */
/**
 * amount = total as charged (tax included). Returns { taxRate, subtotal, taxAmount }
 * with subtotal + taxAmount === amount exactly (worked in minor units).
 * INR subtotal is whole rupees (like pricing.withTax); other currencies 2 decimals.
 */
function taxBreakup(amount, currency = 'INR') {
  const cur = String(currency || 'INR').toUpperCase();
  const rate = pricing.taxRate(cur) || 0;
  const totalMinor = Math.round((Number(amount) || 0) * 100);
  let subtotalMinor = totalMinor;
  if (rate > 0) {
    const raw = totalMinor / (1 + rate);
    subtotalMinor = cur === 'INR' ? Math.round(raw / 100) * 100 : Math.round(raw);
  }
  return { taxRate: rate, subtotal: subtotalMinor / 100, taxAmount: (totalMinor - subtotalMinor) / 100 };
}

/* ------------------------------------------------------------------ */
/* Invoice numbers: PREFIX-2026-27-000123 (India financial year Apr–Mar) */
/* ------------------------------------------------------------------ */
function financialYear(date = new Date()) {
  const ist = new Date(new Date(date).getTime() + 330 * 60 * 1000);
  const year = ist.getUTCFullYear();
  const startYear = ist.getUTCMonth() >= 3 ? year : year - 1; // April = month 3
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function prefix() {
  return String(process.env.INVOICE_PREFIX || 'VIS').trim().replace(/[^A-Za-z0-9]/g, '') || 'VIS';
}

/** Atomically takes the next number of the financial year (concurrent callers never get the same one). */
async function takeNextNumber(date) {
  const fy = financialYear(date);
  const key = `invoice:${prefix()}:${fy}`;
  const c = await Counter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return { key, seq: c.seq, number: `${prefix()}-${fy}-${String(c.seq).padStart(6, '0')}` };
}

const NUMBERING_LOCK_MS = 30 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Gives a paid / refunded invoice its number (idempotent: an invoice that has
 * one keeps it). Pending / failed invoices never get a number.
 *
 * Only ONE caller per invoice takes a counter value (a short claim on the
 * invoice), so concurrent verify / webhook / "open PDF" calls can neither
 * double-number an invoice nor leave gaps in the series. Everyone else waits
 * for the winner's number. A claim older than 30 s (crashed server) is retaken.
 */
async function ensureInvoiceNumber(invoiceId) {
  const inv = await Invoice.findById(invoiceId).select('invoiceNumber status paidAt createdAt').lean();
  if (!inv) return null;
  if (inv.invoiceNumber) return inv.invoiceNumber;
  if (!PAID_STATES.includes(inv.status)) return null;
  const claimed = await Invoice.findOneAndUpdate(
    { _id: invoiceId, invoiceNumber: null, $or: [{ numberingAt: null }, { numberingAt: { $lt: new Date(Date.now() - NUMBERING_LOCK_MS) } }] },
    { $set: { numberingAt: new Date() } },
    { new: true },
  );
  if (!claimed) {
    // Another request is numbering this invoice right now: wait for its number.
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);
      // eslint-disable-next-line no-await-in-loop
      const now = await Invoice.findById(invoiceId).select('invoiceNumber').lean();
      if (now?.invoiceNumber) return now.invoiceNumber;
    }
    return null;
  }
  const taken = await takeNextNumber(inv.paidAt || inv.createdAt || new Date());
  await Invoice.updateOne({ _id: invoiceId }, { $set: { invoiceNumber: taken.number }, $unset: { numberingAt: 1 } });
  return taken.number;
}

/* ------------------------------------------------------------------ */
/* Buyer snapshot                                                       */
/* ------------------------------------------------------------------ */
async function buyerFor(orgId) {
  const org = await Organization.findById(orgId).select('name gstin billingEmail ownerUserId city country').lean();
  if (!org) return null;
  let email = org.billingEmail || '';
  if (!email && org.ownerUserId) {
    const owner = await User.findById(org.ownerUserId).select('email').lean();
    email = owner?.email || '';
  }
  let countryName = '';
  try {
    const { COUNTRY_LIST } = require('../../config/countries');
    countryName = (COUNTRY_LIST.find((c) => c[0] === org.country) || [])[1] || '';
  } catch { /* names are optional */ }
  return {
    name: org.name || '',
    gstin: org.gstin || '',
    email,
    address: [org.city, countryName].filter(Boolean).join(', '),
  };
}

/**
 * Completes a paid invoice: tax breakup, buyer snapshot, invoice number.
 * Safe to call any number of times. Returns the invoice (lean) or null.
 */
async function finalizePaid(invoiceId) {
  const inv = await Invoice.findById(invoiceId).lean();
  if (!inv || !PAID_STATES.includes(inv.status)) return null;
  const $set = {};
  if (inv.subtotal == null || inv.taxAmount == null || inv.taxRate == null) Object.assign($set, taxBreakup(inv.amount, inv.currency));
  if (!inv.billedTo?.name && !inv.billedTo?.email) {
    const buyer = await buyerFor(inv.orgId);
    if (buyer) $set.billedTo = buyer;
  }
  if (Object.keys($set).length) await Invoice.updateOne({ _id: invoiceId }, { $set });
  await ensureInvoiceNumber(invoiceId);
  return Invoice.findById(invoiceId).lean();
}

/* ------------------------------------------------------------------ */
/* PDF                                                                  */
/* ------------------------------------------------------------------ */
/** Invoice (lean) for a PDF download; throws 404 / 409 as the API should answer. */
async function invoiceForPdf(filter) {
  const inv = await Invoice.findOne(filter).select('_id status').lean();
  if (!inv) throw ApiError.notFound('Invoice not found');
  if (!PAID_STATES.includes(inv.status)) throw new ApiError(409, 'An invoice is available only for a successful payment');
  const full = await finalizePaid(inv._id);
  if (!full) throw ApiError.notFound('Invoice not found');
  return full;
}

async function pdfFor(filter) {
  const inv = await invoiceForPdf(filter);
  const { buildInvoicePdf } = require('./invoicePdf');
  const buffer = await buildInvoicePdf(inv, issuer());
  return { buffer, filename: `${inv.invoiceNumber || String(inv._id)}.pdf`, invoice: inv };
}

/* ------------------------------------------------------------------ */
/* E-mail                                                               */
/* ------------------------------------------------------------------ */
const fmtMoney = (amount, currency) => {
  const n = Number(amount) || 0;
  const text = n.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  return `${currency === 'INR' ? 'Rs.' : currency} ${text}`;
};

const istDate = (d) => new Date(new Date(d || Date.now()).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);

function emailContent(inv, from) {
  const what = inv.kind === 'addon' ? inv.description || 'Add-on' : inv.description || `${inv.plan || 'Plan'} payment`;
  const total = fmtMoney(inv.amount, inv.currency);
  const date = istDate(inv.paidAt);
  const esc = require('../email/mailer').escapeHtml;
  const subject = `Payment received: invoice ${inv.invoiceNumber}`;
  const text = [
    `Hi ${inv.billedTo?.name || 'there'},`,
    '',
    `Thank you. We received your payment of ${total} on ${date}.`,
    `For: ${what}`,
    `Invoice number: ${inv.invoiceNumber}`,
    '',
    'Your invoice (PDF) is attached.',
    '',
    from.name,
  ].join('\n');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1e293b;max-width:560px">
      <p>Hi ${esc(inv.billedTo?.name || 'there')},</p>
      <p>Thank you. We received your payment of <b>${esc(total)}</b> on ${esc(date)}.</p>
      <table style="border-collapse:collapse;font-size:14px;margin:12px 0">
        <tr><td style="padding:4px 14px 4px 0;color:#64748b">For</td><td>${esc(what)}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#64748b">Invoice number</td><td>${esc(inv.invoiceNumber)}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#64748b">Amount</td><td>${esc(total)}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#64748b">Date</td><td>${esc(date)}</td></tr>
      </table>
      <p>Your invoice (PDF) is attached.</p>
      <p style="color:#64748b;font-size:13px">${esc(from.name)}</p>
    </div>`;
  return { subject, text, html };
}

/**
 * E-mails the invoice PDF to billedTo.email, from the platform (never from a tenant company).
 * Exactly once per invoice: emailedAt is claimed atomically (null → now) BEFORE sending, so
 * the client verify call and the Razorpay webhook cannot both send. A failed send gives the
 * claim back, stores emailError and counts the attempt so a later "resend" works.
 * `force` = explicit resend (claims against the current emailedAt value instead of null).
 * Never throws; returns { sent, reason?, to? }.
 */
async function sendInvoiceEmail(invoiceId, { force = false } = {}) {
  try {
    const mailer = require('../email/mailer');
    const inv = await finalizePaid(invoiceId);
    if (!inv) return { sent: false, reason: 'not_paid' };
    if (!mailer.isBrevoConfigured()) {
      logger.warn('[invoice] e-mail skipped: Brevo is not configured', { invoice: String(invoiceId) });
      return { sent: false, reason: 'mail_not_configured' };
    }
    let to = inv.billedTo?.email;
    if (!to) {
      const buyer = await buyerFor(inv.orgId);
      to = buyer?.email || '';
      if (to) await Invoice.updateOne({ _id: invoiceId }, { $set: { 'billedTo.email': to } }).catch(() => {});
    }
    if (!to) {
      logger.warn('[invoice] e-mail skipped: no billing e-mail on file', { invoice: String(invoiceId) });
      return { sent: false, reason: 'no_email' };
    }
    const previous = inv.emailedAt || null;
    const claimed = await Invoice.findOneAndUpdate(
      { _id: invoiceId, emailedAt: force ? previous : null },
      { $set: { emailedAt: new Date() } },
      { new: true },
    );
    if (!claimed) return { sent: false, reason: 'already_sent' };
    try {
      const from = issuer();
      const { buildInvoicePdf } = require('./invoicePdf');
      const pdf = await buildInvoicePdf({ ...inv, invoiceNumber: claimed.invoiceNumber || inv.invoiceNumber }, from);
      const { subject, text, html } = emailContent({ ...inv, billedTo: { ...(inv.billedTo || {}), email: to } }, from);
      await mailer.sendDirectEmail({
        to,
        subject,
        text,
        html,
        senderName: from.name,
        attachments: [{ name: `${inv.invoiceNumber}.pdf`, contentBase64: pdf.toString('base64') }],
        tags: ['invoice'],
        idempotencyKey: `invoice-${invoiceId}-${(inv.emailAttempts || 0) + 1}`,
      });
      await Invoice.updateOne({ _id: invoiceId }, { $unset: { emailError: 1 } });
      return { sent: true, to };
    } catch (err) {
      // Give the claim back (so a later resend works), keep the reason, count the attempt.
      const update = { $set: { emailError: String(err.message || err).slice(0, 300) }, $inc: { emailAttempts: 1 } };
      if (previous) update.$set.emailedAt = previous;
      else update.$unset = { emailedAt: 1 };
      await Invoice.updateOne({ _id: invoiceId }, update).catch(() => {});
      logger.warn('[invoice] e-mail failed', { invoice: String(invoiceId), error: err.message });
      return { sent: false, reason: 'send_failed', error: String(err.message || err).slice(0, 200) };
    }
  } catch (err) {
    logger.warn('[invoice] e-mail failed', { invoice: String(invoiceId), error: err.message });
    return { sent: false, reason: 'error', error: String(err.message || err).slice(0, 200) };
  }
}

/**
 * Called when an invoice NEWLY becomes paid: number + breakup + buyer snapshot
 * (awaited, wrapped, so the response already carries the number), then the
 * e-mail in the background. Never throws, never delays or changes the payment.
 */
async function onInvoicePaid(invoiceId) {
  try {
    await finalizePaid(invoiceId);
  } catch (err) {
    logger.warn('[invoice] could not finalize invoice (will be numbered on first open)', { invoice: String(invoiceId), error: err.message });
  }
  setImmediate(() => {
    sendInvoiceEmail(invoiceId).catch(() => {});
  });
}

/** "Email me a copy": max 5 per invoice per day. Throws ApiError for the customer-facing messages. */
async function resendInvoice(orgId, invoiceId) {
  const inv = await Invoice.findOne({ _id: invoiceId, orgId }).select('_id status').lean();
  if (!inv) throw ApiError.notFound('Invoice not found');
  if (!PAID_STATES.includes(inv.status)) throw new ApiError(409, 'An invoice is available only for a successful payment');
  const day = istDate();
  await Invoice.updateOne({ _id: invoiceId, 'emailResends.day': { $ne: day } }, { $set: { 'emailResends.day': day, 'emailResends.count': 0 } });
  const slot = await Invoice.findOneAndUpdate(
    { _id: invoiceId, orgId, 'emailResends.day': day, 'emailResends.count': { $lt: RESENDS_PER_DAY } },
    { $inc: { 'emailResends.count': 1 } },
    { new: true },
  );
  if (!slot) throw new ApiError(429, `You can email the same invoice up to ${RESENDS_PER_DAY} times a day. Please try again tomorrow.`);
  const result = await sendInvoiceEmail(invoiceId, { force: true });
  if (result.sent) return result;
  const messages = {
    mail_not_configured: 'Email sending is not set up yet. Please download the PDF instead.',
    no_email: 'There is no billing email on file. Add one in your billing details, then try again.',
    already_sent: 'This invoice is already being emailed. Please check your inbox in a minute.',
    not_paid: 'An invoice is available only for a successful payment',
  };
  throw ApiError.badRequest(messages[result.reason] || `Could not send the email${result.error ? `: ${result.error}` : ''}. Please try again.`);
}

/** Gives numbers to this company's older paid invoices (oldest first). Best effort, used by the Billing list. */
async function numberOlderInvoices(invoices) {
  const missing = invoices.filter((i) => PAID_STATES.includes(i.status) && !i.invoiceNumber).sort((a, b) => new Date(a.paidAt || a.createdAt) - new Date(b.paidAt || b.createdAt));
  const done = new Map();
  for (const inv of missing) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const full = await finalizePaid(inv._id);
      if (full) done.set(String(inv._id), full);
    } catch (err) {
      logger.warn('[invoice] lazy numbering failed', { invoice: String(inv._id), error: err.message });
    }
  }
  return invoices.map((i) => done.get(String(i._id)) || i);
}

module.exports = {
  issuer,
  taxBreakup,
  financialYear,
  takeNextNumber,
  ensureInvoiceNumber,
  finalizePaid,
  invoiceForPdf,
  pdfFor,
  sendInvoiceEmail,
  onInvoicePaid,
  resendInvoice,
  numberOlderInvoices,
  fmtMoney,
  RESENDS_PER_DAY,
};
