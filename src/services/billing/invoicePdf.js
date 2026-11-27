const PDFDocument = require('pdfkit');
const { getPlan, ADDONS } = require('../../config/plans');
const ApiError = require('../../utils/ApiError');

/**
 * One-page invoice PDF (pdfkit, built-in Helvetica).
 *
 * Helvetica has no rupee glyph, so amounts print as "Rs." (INR) or the
 * currency code (AED / USD). Characters outside Latin-1 (e.g. Hindi company
 * names) cannot be drawn by the built-in font and are shown as "?".
 *
 * Only paid / refunded invoices produce a PDF.
 */

const GREEN = '#064E3B';
const GREY = '#64748B';
const INK = '#0F172A';
const RED = '#B91C1C';

const safe = (v) =>
  String(v == null ? '' : v)
    .replace(/\r/g, '')
    .replace(/[^\n\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022]/g, '?')
    .trim();

function money(amount, currency) {
  const cur = String(currency || 'INR').toUpperCase();
  const n = Number(amount) || 0;
  if (cur === 'INR') {
    const text = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
    return `${n < 0 ? '- ' : ''}Rs. ${text}`;
  }
  return `${n < 0 ? '- ' : ''}${cur} ${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateText(d) {
  if (!d) return '';
  const ist = new Date(new Date(d).getTime() + 330 * 60 * 1000);
  if (Number.isNaN(ist.getTime())) return '';
  return `${String(ist.getUTCDate()).padStart(2, '0')} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

function lineItem(inv) {
  const qty = inv.kind === 'addon' ? Number(inv.addon?.quantity) || 1 : 1;
  let title = safe(inv.description);
  const details = [];
  if (inv.kind === 'addon') {
    const name = ADDONS[inv.addon?.key]?.name;
    if (!title) title = safe(name || 'Add-on');
    if (name && inv.addon?.key === 'voiceMinute') details.push(`${qty} AI calling minutes (recharge)`);
    else if (name && inv.addon?.key === 'emailCredit') details.push(`${qty} campaign emails (wallet recharge)`);
    else if (name) details.push(`${name} x ${qty}`);
  } else {
    const planName = inv.plan ? getPlan(inv.plan).name : '';
    if (!title) title = safe(planName ? `${planName} plan` : 'Subscription payment');
    if (planName) details.push(`Plan: ${planName}${inv.billingCycle ? ` (${inv.billingCycle === 'annual' ? 'yearly' : 'monthly'})` : ''}`);
    if (inv.periodStart || inv.periodEnd) details.push(`Period: ${dateText(inv.periodStart)}${inv.periodEnd ? ` - ${dateText(inv.periodEnd)}` : ''}`);
  }
  return { title, details, qty };
}

/**
 * @param {object} inv     lean Invoice (paid / refunded, with invoiceNumber, subtotal, taxAmount, taxRate, billedTo)
 * @param {object} issuer  { name, gstin, address, pan, sac, email, phone } — a line prints only when set
 * @returns {Promise<Buffer>}
 */
function buildInvoicePdf(inv, issuer = {}) {
  if (!inv || !['paid', 'refunded'].includes(inv.status)) {
    return Promise.reject(new ApiError(409, 'An invoice is available only for a successful payment'));
  }
  return new Promise((resolve, reject) => {
    const refunded = inv.status === 'refunded';
    const currency = String(inv.currency || 'INR').toUpperCase();
    const taxRate = Number(inv.taxRate) || 0;
    const total = Number(inv.amount) || 0;
    const subtotal = inv.subtotal != null ? Number(inv.subtotal) : total;
    const taxAmount = inv.taxAmount != null ? Number(inv.taxAmount) : 0;
    const title = issuer.gstin && taxRate > 0 ? 'Tax Invoice' : 'Invoice';

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 44, left: 44, right: 44, bottom: 44 },
      info: { Title: `${title} ${inv.invoiceNumber || ''}`.trim(), Author: safe(issuer.name) },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 44;
    const W = doc.page.width - 88;
    const col2 = left + W / 2 + 10;

    // Header band
    doc.rect(0, 0, doc.page.width, 92).fill(GREEN);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(20).text(safe(issuer.name) || 'Invoice', left, 28, { width: W * 0.6, lineBreak: false, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(16).text(title.toUpperCase(), left, 26, { width: W, align: 'right' });
    doc.font('Helvetica').fontSize(10).text(`No. ${safe(inv.invoiceNumber)}`, left, 50, { width: W, align: 'right' });
    doc.text(`Date: ${dateText(inv.paidAt || inv.createdAt)}`, left, 64, { width: W, align: 'right' });

    // Status
    const statusText = refunded ? 'REFUNDED' : 'PAID';
    const statusColor = refunded ? RED : '#047857';
    doc.roundedRect(doc.page.width - 44 - 96, 106, 96, 24, 4).lineWidth(1.5).stroke(statusColor);
    doc.fillColor(statusColor).font('Helvetica-Bold').fontSize(13).text(statusText, doc.page.width - 44 - 96, 112, { width: 96, align: 'center' });

    // From / Billed to
    let yFrom = 112;
    const block = (heading, lines, x, width, y0) => {
      doc.fillColor(GREY).font('Helvetica').fontSize(8).text(heading, x, y0, { width });
      let y = y0 + 12;
      lines.filter((l) => l && l.text).forEach((l, i) => {
        doc.fillColor(INK).font(i === 0 && l.bold !== false ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 0 ? 11 : 9.5);
        doc.text(l.text, x, y, { width });
        y = doc.y + 2;
      });
      return y;
    };
    const fromLines = [
      { text: safe(issuer.name) },
      { text: safe(issuer.address) },
      issuer.gstin ? { text: `GSTIN: ${safe(issuer.gstin)}` } : null,
      issuer.pan ? { text: `PAN: ${safe(issuer.pan)}` } : null,
      issuer.email ? { text: safe(issuer.email) } : null,
      issuer.phone ? { text: safe(issuer.phone) } : null,
    ].filter(Boolean);
    const b = inv.billedTo || {};
    const toLines = [
      { text: safe(b.name) || 'Customer' },
      b.gstin ? { text: `GSTIN: ${safe(b.gstin)}` } : null,
      b.address ? { text: safe(b.address) } : null,
      b.email ? { text: safe(b.email) } : null,
    ].filter(Boolean);
    const yA = block('FROM', fromLines, left, W / 2 - 20, yFrom + 28);
    const yB = block('BILLED TO', toLines, col2, W / 2 - 10, yFrom + 28);
    let y = Math.max(yA, yB) + 22;

    // Items table
    doc.rect(left, y, W, 22).fill('#F1F5F9');
    doc.fillColor(GREY).font('Helvetica-Bold').fontSize(8.5);
    doc.text('DESCRIPTION', left + 8, y + 7, { width: W * 0.6 });
    doc.text('QTY', left + W * 0.64, y + 7, { width: 40, align: 'right' });
    doc.text('AMOUNT', left + W * 0.7, y + 7, { width: W * 0.3 - 8, align: 'right' });
    y += 30;
    const item = lineItem(inv);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(item.title, left + 8, y, { width: W * 0.6 });
    doc.font('Helvetica').fontSize(9).fillColor(GREY);
    item.details.forEach((d) => doc.text(safe(d), left + 8, doc.y + 1, { width: W * 0.6 }));
    if (issuer.sac) doc.text(`SAC: ${safe(issuer.sac)}`, left + 8, doc.y + 1, { width: W * 0.6 });
    const itemEnd = doc.y;
    doc.fillColor(INK).font('Helvetica').fontSize(10);
    doc.text(String(item.qty), left + W * 0.64, y, { width: 40, align: 'right' });
    doc.text(money(subtotal, currency), left + W * 0.7, y, { width: W * 0.3 - 8, align: 'right' });
    y = itemEnd + 12;
    doc.moveTo(left, y).lineTo(left + W, y).lineWidth(0.5).stroke('#CBD5E1');
    y += 12;

    // Totals
    const row = (label, value, bold = false, size = 10) => {
      doc.fillColor(bold ? INK : GREY).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
      doc.text(label, left + W * 0.5, y, { width: W * 0.25 });
      doc.fillColor(INK).text(value, left + W * 0.7, y, { width: W * 0.3 - 8, align: 'right' });
      y += size + 8;
    };
    if (taxRate > 0) {
      row('Subtotal', money(subtotal, currency));
      row(`${currency === 'INR' ? 'GST' : 'Tax'} (${Math.round(taxRate * 10000) / 100}%)`, money(taxAmount, currency));
    } else {
      row('Tax', money(0, currency));
    }
    doc.moveTo(left + W * 0.5, y - 2).lineTo(left + W, y - 2).lineWidth(0.5).stroke('#CBD5E1');
    y += 4;
    row(refunded ? 'Total (refunded)' : 'Total paid', money(total, currency), true, 12);

    // Payment details
    y += 14;
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text('PAYMENT', left, y, { width: W });
    y += 12;
    doc.fillColor(INK).font('Helvetica').fontSize(9.5);
    const pay = [];
    pay.push(`Paid on: ${dateText(inv.paidAt || inv.createdAt)}`);
    pay.push(inv.razorpayPaymentId ? `Payment reference: ${safe(inv.razorpayPaymentId)}` : 'Payment mode: offline (UPI / bank transfer)');
    if (inv.razorpayOrderId && !inv.razorpayPaymentId) pay.push(`Order: ${safe(inv.razorpayOrderId)}`);
    pay.forEach((t) => {
      doc.text(t, left, y, { width: W });
      y = doc.y + 2;
    });

    // Refunded stamp
    if (refunded) {
      doc.save();
      doc.rotate(-25, { origin: [doc.page.width / 2, 400] });
      doc.fillColor(RED).fillOpacity(0.12).font('Helvetica-Bold').fontSize(90).text('REFUNDED', 0, 360, { width: doc.page.width, align: 'center', lineBreak: false });
      doc.restore();
    }

    // Footer (kept above the bottom margin so the page never overflows)
    doc.fillOpacity(1).fillColor(GREY).font('Helvetica').fontSize(8.5);
    doc.text('This is a computer-generated invoice.', left, doc.page.height - 78, { width: W, align: 'center', lineBreak: false });
    doc.end();
  });
}

module.exports = { buildInvoicePdf, money, dateText };
