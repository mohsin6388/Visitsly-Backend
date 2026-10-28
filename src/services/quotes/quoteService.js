const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const Quote = require('../../models/Quote');

const round = (n) => Math.round(Number(n) || 0);

/** All money maths for a cost sheet. Stamp duty + registration on agreement value. */
function computeTotals(pricing = {}, unit = {}) {
  const base = pricing.ratePerSqft && unit.areaSqft ? round(pricing.ratePerSqft * unit.areaSqft) : round(pricing.baseAmount);
  const items = (pricing.items || []).filter((i) => i && i.label && Number(i.amount));
  const extras = round(items.reduce((a, i) => a + Number(i.amount), 0));
  const taxableExtras = round(items.filter((i) => i.taxable !== false).reduce((a, i) => a + Number(i.amount), 0));
  const discount = round(pricing.discount);
  const agreementValue = base + extras - discount;
  const gst = round(((base + taxableExtras - discount) * (Number(pricing.gstPct) || 0)) / 100);
  const stampDuty = round((agreementValue * (Number(pricing.stampDutyPct) || 0)) / 100);
  const registration = round((agreementValue * (Number(pricing.registrationPct) || 0)) / 100);
  return { base, extras, discount, agreementValue, gst, stampDuty, registration, grandTotal: agreementValue + gst + stampDuty + registration };
}

function planWithAmounts(plan = [], totals) {
  return (plan || [])
    .filter((p) => p && p.milestone)
    .map((p) => ({ milestone: p.milestone, pct: Number(p.pct) || 0, amount: round(((Number(p.pct) || 0) * (totals.agreementValue + totals.gst)) / 100) }));
}

async function nextNumber(ownerId) {
  const year = new Date().getFullYear();
  const count = await Quote.countDocuments({ ownerId, number: new RegExp(`^Q-${year}-`) });
  return `Q-${year}-${String(count + 1).padStart(4, '0')}`;
}

const newToken = () => crypto.randomBytes(16).toString('hex');

// PDFKit's built-in fonts have no ₹ glyph, so amounts print as "Rs.".
const money = (n) => `${Number(n) < 0 ? '- ' : ''}Rs. ${Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-IN')}`;

/** Streams a branded A4 cost sheet PDF. */
function renderPdf(quote, company, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 44, info: { Title: `${quote.number} - ${quote.project}` } });
  doc.pipe(stream);
  const green = '#064E3B';
  const grey = '#64748B';
  const W = doc.page.width - 88;

  doc.rect(0, 0, doc.page.width, 92).fill(green);
  doc.fillColor('#FFFFFF').fontSize(20).font('Helvetica-Bold').text(company.name || 'Cost sheet', 44, 28, { width: W * 0.65 });
  doc.fontSize(10).font('Helvetica').text([company.city, company.phone].filter(Boolean).join('  |  '), 44, 56, { width: W * 0.65 });
  doc.fontSize(12).font('Helvetica-Bold').text('COST SHEET', 44, 28, { width: W, align: 'right' });
  doc.fontSize(9).font('Helvetica').text(`${quote.number}\n${new Date(quote.createdAt || Date.now()).toLocaleDateString('en-IN')}`, 44, 46, { width: W, align: 'right' });

  let y = 112;
  const kv = (label, value, x, width) => {
    doc.fontSize(8).fillColor(grey).font('Helvetica').text(label.toUpperCase(), x, y, { width });
    doc.fontSize(11).fillColor('#0F172A').font('Helvetica-Bold').text(value || '-', x, y + 11, { width });
  };
  const u = quote.unit || {};
  kv('Customer', quote.customer?.name, 44, W / 2);
  kv('Project', quote.project, 44 + W / 2, W / 2);
  y += 36;
  kv('Unit', [u.tower && `Tower ${u.tower}`, u.unitNo && `Unit ${u.unitNo}`, u.floor && `Floor ${u.floor}`].filter(Boolean).join(', '), 44, W / 2);
  kv('Configuration', [u.bhk && `${u.bhk} BHK`, u.areaSqft && `${u.areaSqft} sq.ft`, u.facing].filter(Boolean).join(' · '), 44 + W / 2, W / 2);
  y += 44;

  const p = quote.pricing || {};
  const rows = [];
  rows.push([p.ratePerSqft && u.areaSqft ? `Basic cost (${u.areaSqft} sq.ft x Rs. ${p.ratePerSqft})` : 'Basic cost', quote.totals.base]);
  (p.items || []).forEach((i) => rows.push([i.label, i.amount]));
  if (quote.totals.discount) rows.push(['Discount', -quote.totals.discount]);
  rows.push(['Agreement value', quote.totals.agreementValue, true]);
  rows.push([`GST (${p.gstPct}%)`, quote.totals.gst]);
  rows.push([`Stamp duty (${p.stampDutyPct}%)`, quote.totals.stampDuty]);
  rows.push([`Registration (${p.registrationPct}%)`, quote.totals.registration]);

  const drawRow = (label, amount, bold, fill) => {
    if (y > doc.page.height - 140) {
      doc.addPage();
      y = 44;
    }
    if (fill) doc.rect(44, y - 4, W, 22).fill(fill);
    doc.fillColor('#0F172A').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).text(label, 52, y, { width: W * 0.65 });
    doc.text(money(amount), 44, y, { width: W - 8, align: 'right' });
    y += 22;
  };

  doc.font('Helvetica-Bold').fontSize(11).fillColor(green).text('Price breakup', 44, y);
  y += 20;
  rows.forEach(([l, a, b], i) => drawRow(l, a, b, i % 2 ? '#F8FAFC' : null));
  doc.rect(44, y - 2, W, 28).fill(green);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(12).text('All-inclusive total', 52, y + 6);
  doc.text(money(quote.totals.grandTotal), 44, y + 6, { width: W - 8, align: 'right' });
  y += 44;

  if ((quote.paymentPlan || []).length) {
    doc.fillColor(green).font('Helvetica-Bold').fontSize(11).text('Payment plan', 44, y);
    y += 20;
    quote.paymentPlan.forEach((m, i) => drawRow(`${m.milestone} (${m.pct}%)`, m.amount, false, i % 2 ? '#F8FAFC' : null));
    y += 6;
  }

  const foot = [
    quote.validTill ? `Valid till ${new Date(quote.validTill).toLocaleDateString('en-IN')}.` : null,
    quote.notes || null,
    "Prices are indicative and subject to change at the developer's discretion. Stamp duty and registration as per prevailing government rates.",
  ].filter(Boolean).join('\n');
  doc.fillColor(grey).font('Helvetica').fontSize(8.5).text(foot, 44, Math.max(y + 8, doc.page.height - 120), { width: W });
  doc.end();
}

module.exports = { computeTotals, planWithAmounts, nextNumber, newToken, renderPdf, money };
