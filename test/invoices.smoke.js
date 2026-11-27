/* eslint-disable no-console */
/**
 * Invoices smoke test — NO database (in-memory stand-in, see test/helpers/fakeMongo.js).
 *   node test/invoices.smoke.js
 *
 * Covers: unique + sequential invoice numbers under concurrency, financial-year format,
 * tax breakup (subtotal + tax = amount), PDF output, one e-mail per paid invoice even when
 * verify + webhook both report it, a mailer failure never breaking a payment, resend limit,
 * company isolation (404), no PDF for pending / failed invoices, the additive mailer changes.
 */
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
process.env.SAAS_MODE = 'true';
process.env.BREVO_API_KEY = 'test-key';
process.env.BREVO_FROM_EMAIL = 'noreply@example.com';
process.env.INVOICE_PREFIX = 'VIS';
process.env.INVOICE_GSTIN = '27ABCDE1234F1Z5';
process.env.INVOICE_COMPANY_NAME = 'Visitsly Test Co';
const R = (p) => require(path.join(ROOT, p));
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

// Capture what the mailer would POST to Brevo (patched BEFORE the mailer is loaded).
const axios = require('axios');
const posted = [];
const realCreate = axios.create.bind(axios);
axios.create = (...a) => {
  const inst = realCreate(...a);
  inst.post = async (url, body) => { posted.push(body); return { data: { messageId: `m${posted.length}` } }; };
  return inst;
};

const { createFake } = R('test/helpers/fakeMongo');
const Invoice = R('src/models/Invoice');
const Counter = R('src/models/Counter');
const Organization = R('src/models/Organization');
const User = R('src/models/User');
const invoices = createFake({ defaults: () => ({ status: 'paid', emailAttempts: 0 }) }); // schema defaults
const counters = createFake();
const orgs = createFake();
const users = createFake();
invoices.install(Invoice);
counters.install(Counter);
orgs.install(Organization);
users.install(User);

const mailer = R('src/services/email/mailer');
const invoiceService = R('src/services/billing/invoiceService');
const { buildInvoicePdf } = R('src/services/billing/invoicePdf');
const billing = R('src/services/saas/billingService');
const tenantContext = R('src/context/tenantContext');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.stack || e.message); process.exitCode = 1; }
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const reset = () => { [invoices, counters, orgs, users].forEach((f) => { f.docs.length = 0; }); posted.length = 0; };

const seedOrg = (over = {}) => orgs.seed({ _id: 'orgA', name: 'ABC Realty', gstin: '27AAAAA0000A1Z5', billingEmail: 'owner@abc.in', ownerUserId: 'uA', city: 'Pune', country: 'IN', addonGrants: [], ...over });
const hexId = () => require('crypto').randomBytes(12).toString('hex'); // real ObjectId shape (the API rejects other ids with 404)
const seedInvoice = (over = {}) => invoices.seed({ _id: hexId(), orgId: 'orgA', kind: 'addon', status: 'pending', amount: 826, currency: 'INR', addon: { key: 'voiceMinute', quantity: 100 }, description: 'AI voice calling × 100', razorpayOrderId: `order_${Math.random()}`, paidAt: null, createdAt: new Date(), ...over });

(async () => {
  console.log('Tax breakup');
  await t('INR 18% GST: subtotal + tax = amount exactly (whole-rupee subtotal)', () => {
    for (const amount of [1, 826, 9439, 21239, 47199, 123456, 9440.5, 0.5]) {
      const b = invoiceService.taxBreakup(amount, 'INR');
      assert.strictEqual(b.taxRate, 0.18);
      assert.strictEqual(Math.round((b.subtotal + b.taxAmount) * 100), Math.round(amount * 100), `amount ${amount}`);
      if (Number.isInteger(amount)) assert.ok(Number.isInteger(b.subtotal), `whole rupees for ${amount}`);
    }
    assert.deepStrictEqual(invoiceService.taxBreakup(9439, 'INR'), { taxRate: 0.18, subtotal: 7999, taxAmount: 1440 });
    assert.deepStrictEqual(invoiceService.taxBreakup(826, 'INR'), { taxRate: 0.18, subtotal: 700, taxAmount: 126 });
  });
  await t('AED / USD: tax is 0 and the subtotal is the total', () => {
    assert.deepStrictEqual(invoiceService.taxBreakup(499, 'AED'), { taxRate: 0, subtotal: 499, taxAmount: 0 });
    assert.deepStrictEqual(invoiceService.taxBreakup(149.5, 'USD'), { taxRate: 0, subtotal: 149.5, taxAmount: 0 });
  });

  console.log('Invoice numbers');
  await t('financial year is April–March (IST) and the number format matches', () => {
    assert.strictEqual(invoiceService.financialYear(new Date('2026-03-31T10:00:00Z')), '2025-26');
    assert.strictEqual(invoiceService.financialYear(new Date('2026-04-01T10:00:00Z')), '2026-27');
    assert.strictEqual(invoiceService.financialYear(new Date('2026-03-31T19:00:00Z')), '2026-27'); // 00:30 IST on 1 April
    assert.strictEqual(invoiceService.financialYear(new Date('2027-01-15T10:00:00Z')), '2026-27');
  });
  await t('20 parallel paid events → 20 unique, sequential numbers', async () => {
    reset();
    const ids = Array.from({ length: 20 }, () => seedInvoice({ status: 'paid', paidAt: new Date('2026-11-25T08:00:00Z') })._id);
    const numbers = await Promise.all(ids.map((id) => invoiceService.ensureInvoiceNumber(id)));
    assert.strictEqual(new Set(numbers).size, 20, 'all unique');
    const seqs = numbers.map((n) => Number(n.split('-').pop())).sort((a, b) => a - b);
    assert.deepStrictEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1), 'sequential, no gaps');
    numbers.forEach((n) => assert.match(n, /^VIS-2026-27-\d{6}$/));
  });
  await t('the same invoice numbered by 10 callers at once keeps ONE number and leaves no gap', async () => {
    reset();
    const id = seedInvoice({ status: 'paid', paidAt: new Date('2026-11-25T08:00:00Z') })._id;
    const numbers = await Promise.all(Array.from({ length: 10 }, () => invoiceService.ensureInvoiceNumber(id)));
    assert.strictEqual(new Set(numbers).size, 1);
    const next = seedInvoice({ status: 'paid', paidAt: new Date('2026-11-25T08:00:00Z') })._id;
    assert.match(await invoiceService.ensureInvoiceNumber(next), /-000002$/, 'the next invoice continues right after, not after wasted numbers');
    assert.strictEqual(await invoiceService.ensureInvoiceNumber(id), numbers[0], 'idempotent');
  });
  await t('pending / failed invoices get no number; the year restarts the sequence', async () => {
    reset();
    const p = seedInvoice({ status: 'pending' })._id;
    const f = seedInvoice({ status: 'failed' })._id;
    assert.strictEqual(await invoiceService.ensureInvoiceNumber(p), null);
    assert.strictEqual(await invoiceService.ensureInvoiceNumber(f), null);
    assert.ok(invoices.docs.every((d) => d.invoiceNumber === undefined));
    const a = seedInvoice({ status: 'paid', paidAt: new Date('2026-02-10T08:00:00Z') })._id;
    const b = seedInvoice({ status: 'paid', paidAt: new Date('2026-06-10T08:00:00Z') })._id;
    assert.strictEqual(await invoiceService.ensureInvoiceNumber(a), 'VIS-2025-26-000001');
    assert.strictEqual(await invoiceService.ensureInvoiceNumber(b), 'VIS-2026-27-000001');
  });
  await t('older paid invoices are numbered lazily, oldest first', async () => {
    reset();
    seedOrg();
    const newer = seedInvoice({ status: 'paid', paidAt: new Date('2026-11-01T08:00:00Z') });
    const older = seedInvoice({ status: 'paid', paidAt: new Date('2026-09-01T08:00:00Z') });
    const list = await invoiceService.numberOlderInvoices([newer, older].map((d) => ({ ...d })));
    const byId = Object.fromEntries(list.map((i) => [String(i._id), i.invoiceNumber]));
    assert.match(byId[String(older._id)], /-000001$/);
    assert.match(byId[String(newer._id)], /-000002$/);
  });

  console.log('PDF');
  await t('PDF is a non-empty buffer starting with %PDF (paid and refunded)', async () => {
    const base = { invoiceNumber: 'VIS-2026-27-000001', amount: 826, currency: 'INR', taxRate: 0.18, subtotal: 700, taxAmount: 126, kind: 'addon', addon: { key: 'voiceMinute', quantity: 100 }, description: 'AI voice calling × 100', paidAt: new Date(), billedTo: { name: 'ABC Realty', email: 'a@b.in' } };
    for (const status of ['paid', 'refunded']) {
      const buf = await buildInvoicePdf({ ...base, status }, invoiceService.issuer());
      assert.ok(Buffer.isBuffer(buf) && buf.length > 1000);
      assert.strictEqual(buf.slice(0, 4).toString(), '%PDF');
    }
    const aed = await buildInvoicePdf({ ...base, currency: 'AED', taxRate: 0, subtotal: 826, taxAmount: 0, status: 'paid' }, { name: 'X' });
    assert.strictEqual(aed.slice(0, 4).toString(), '%PDF');
  });
  await t('a pending or failed invoice cannot produce a PDF', async () => {
    reset();
    seedOrg();
    for (const status of ['pending', 'failed']) {
      await assert.rejects(buildInvoicePdf({ status, amount: 1, currency: 'INR' }, {}), (e) => e.statusCode === 409);
      const inv = seedInvoice({ status });
      await assert.rejects(invoiceService.pdfFor({ _id: inv._id, orgId: 'orgA' }), (e) => e.statusCode === 409);
    }
    assert.ok(invoices.docs.every((d) => d.invoiceNumber === undefined), 'and none got a number');
  });
  await t('Company A cannot download Company B\'s invoice (404), but can download its own', async () => {
    reset();
    seedOrg(); seedOrg({ _id: 'orgB', name: 'Other Co', billingEmail: 'b@b.in' });
    const bInv = seedInvoice({ orgId: 'orgB', status: 'paid', paidAt: new Date() });
    const aInv = seedInvoice({ orgId: 'orgA', status: 'paid', paidAt: new Date() });
    const ctrl = R('src/controllers/billingController');
    const call = (orgId, id) => new Promise((resolve) => {
      const res = { headers: {}, set(h) { Object.assign(this.headers, h); return this; }, status(c) { this.code = c; return this; }, send(b) { resolve({ res: this, body: b }); } };
      ctrl.invoicePdf({ org: { _id: orgId }, params: { id: String(id) } }, res, (err) => resolve({ err }));
    });
    const denied = await call('orgA', bInv._id);
    assert.strictEqual(denied.err.statusCode, 404);
    const junk = await call('orgA', 'not-an-id');
    assert.strictEqual(junk.err.statusCode, 404);
    const ok = await call('orgA', aInv._id);
    assert.ok(ok.res, `own invoice must download, got: ${ok.err && ok.err.stack}`);
    assert.strictEqual(ok.res.headers['Content-Type'], 'application/pdf');
    assert.match(ok.res.headers['Content-Disposition'], /attachment; filename="VIS-\d{4}-\d{2}-\d{6}\.pdf"/);
    assert.strictEqual(ok.body.slice(0, 4).toString(), '%PDF');
  });

  console.log('E-mail on payment');
  await t('verify + webhook both report the add-on → ONE e-mail, ONE number, add-on granted once', async () => {
    reset();
    seedOrg();
    const inv = seedInvoice();
    // The two real paths that both call grantAddon: the client verify call and the Razorpay webhook.
    const crypto = require('crypto');
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    R('src/config/env').razorpay.keySecret = 'secret';
    const orderId = inv.razorpayOrderId;
    const sign = crypto.createHmac('sha256', 'secret').update(`${orderId}|pay_1`).digest('hex');
    const verifyBody = { razorpay_order_id: orderId, razorpay_payment_id: 'pay_1', razorpay_signature: sign };
    const webhookEvent = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: orderId } } } };
    await Promise.all([billing.verifyAddonPayment('orgA', verifyBody), billing.handleWebhook(webhookEvent), billing.handleWebhook(webhookEvent)]);
    await billing.verifyAddonPayment('orgA', verifyBody); // and once more, later
    await settle();
    assert.strictEqual(posted.length, 1, `exactly one e-mail (got ${posted.length})`);
    const doc = invoices.docs[0];
    assert.match(doc.invoiceNumber, /^VIS-\d{4}-\d{2}-000001$/);
    assert.strictEqual(counters.docs.reduce((n, c) => n + c.seq, 0), 1, 'one number consumed');
    assert.strictEqual(orgs.docs[0].addonGrants.length, 1, 'add-on granted once');
    assert.strictEqual(doc.status, 'paid');
    assert.ok(doc.emailedAt);
    assert.deepStrictEqual([doc.subtotal, doc.taxAmount, doc.taxRate], [700, 126, 0.18]);
    assert.deepStrictEqual([doc.billedTo.name, doc.billedTo.gstin, doc.billedTo.email], ['ABC Realty', '27AAAAA0000A1Z5', 'owner@abc.in']);
    // What Brevo received
    const m = posted[0];
    assert.deepStrictEqual(m.to, [{ email: 'owner@abc.in' }]);
    assert.strictEqual(m.sender.name, 'Visitsly Test Co');
    assert.strictEqual(m.subject, `Payment received: invoice ${doc.invoiceNumber}`);
    assert.ok(m.htmlContent.includes(doc.invoiceNumber) && m.textContent.includes('Rs. 826'));
    assert.strictEqual(m.attachment.length, 1);
    assert.strictEqual(m.attachment[0].name, `${doc.invoiceNumber}.pdf`);
    assert.strictEqual(Buffer.from(m.attachment[0].content, 'base64').slice(0, 4).toString(), '%PDF');
    assert.ok(!('senderName' in m), 'internal option never reaches Brevo');
  });
  await t('billing e-mail falls back to the owner login e-mail', async () => {
    reset();
    seedOrg({ billingEmail: '' });
    users.seed({ _id: 'uA', email: 'owner@login.in' });
    const inv = seedInvoice({ status: 'paid', paidAt: new Date() });
    const r = await invoiceService.sendInvoiceEmail(inv._id);
    assert.strictEqual(r.sent, true);
    assert.deepStrictEqual(posted[0].to, [{ email: 'owner@login.in' }]);
  });
  await t('a mailer failure never breaks the payment: add-on active, invoice paid, claim given back', async () => {
    reset();
    seedOrg();
    const inv = seedInvoice();
    const real = mailer.sendDirectEmail;
    mailer.sendDirectEmail = async () => { throw new Error('Brevo is down'); };
    try {
      const crypto = require('crypto');
      const sign = crypto.createHmac('sha256', 'secret').update(`${inv.razorpayOrderId}|pay_2`).digest('hex');
      const out = await billing.verifyAddonPayment('orgA', { razorpay_order_id: inv.razorpayOrderId, razorpay_payment_id: 'pay_2', razorpay_signature: sign });
      assert.strictEqual(out.status, 'paid');
      await settle();
    } finally { mailer.sendDirectEmail = real; }
    const doc = invoices.docs[0];
    assert.strictEqual(orgs.docs[0].addonGrants.length, 1, 'add-on still activated');
    assert.strictEqual(doc.status, 'paid');
    assert.ok(doc.invoiceNumber, 'still numbered');
    assert.strictEqual(doc.emailedAt, undefined, 'claim reset');
    assert.match(doc.emailError, /Brevo is down/);
    assert.strictEqual(doc.emailAttempts, 1);
    // A later resend works.
    const again = await invoiceService.resendInvoice('orgA', doc._id);
    assert.strictEqual(again.sent, true);
    assert.ok(invoices.docs[0].emailedAt);
    assert.strictEqual(invoices.docs[0].emailError, undefined);
  });
  await t('no Brevo configured / no billing e-mail: skipped quietly, payment untouched', async () => {
    reset();
    seedOrg({ billingEmail: '' });
    const inv = seedInvoice({ status: 'paid', paidAt: new Date() });
    assert.strictEqual((await invoiceService.sendInvoiceEmail(inv._id)).reason, 'no_email');
    const realCfg = mailer.isBrevoConfigured;
    mailer.isBrevoConfigured = () => false;
    try { assert.strictEqual((await invoiceService.sendInvoiceEmail(inv._id)).reason, 'mail_not_configured'); } finally { mailer.isBrevoConfigured = realCfg; }
    assert.strictEqual(posted.length, 0);
    assert.strictEqual(invoices.docs[0].emailedAt, undefined);
  });
  await t('resend is limited to 5 per invoice per day, with a clear message', async () => {
    reset();
    seedOrg();
    const inv = seedInvoice({ status: 'paid', paidAt: new Date() });
    for (let i = 0; i < 5; i += 1) assert.strictEqual((await invoiceService.resendInvoice('orgA', inv._id)).sent, true);
    await assert.rejects(invoiceService.resendInvoice('orgA', inv._id), (e) => e.statusCode === 429 && /up to 5 times a day/.test(e.message));
    await assert.rejects(invoiceService.resendInvoice('orgB', inv._id), (e) => e.statusCode === 404);
    assert.strictEqual(posted.length, 5);
  });
  await t('a duplicate subscription charge (same payment id) creates no second invoice and no second e-mail', async () => {
    reset();
    seedOrg();
    const row = { plan: 'growth', billingCycle: 'monthly', amount: 9439, currency: 'INR', description: 'Growth (monthly)', razorpayPaymentId: 'pay_sub1' };
    await billing.recordInvoice('orgA', row); // e.g. the browser verify call
    await billing.recordInvoice('orgA', row); // e.g. the subscription.charged webhook
    await settle();
    assert.strictEqual(invoices.docs.length, 1);
    assert.strictEqual(posted.length, 1);
    assert.match(invoices.docs[0].invoiceNumber, /-000001$/);
    // A failed payment row is recorded but never numbered or e-mailed.
    await billing.recordInvoice('orgA', { ...row, razorpayPaymentId: 'pay_bad', status: 'failed' });
    await settle();
    assert.strictEqual(invoices.docs.length, 2);
    assert.strictEqual(invoices.docs[1].invoiceNumber, undefined);
    assert.strictEqual(posted.length, 1);
  });
  await t('admin offline payment: invoice is created, numbered and e-mailed', async () => {
    reset();
    seedOrg({ plan: 'growth', status: 'active', currentPeriodEnd: null, razorpay: {} });
    // activate() uses Organization.findById(...) as a document; give it a minimal one.
    const realFind = Organization.findById;
    Organization.findById = (id) => {
      const q = realFind(id);
      const orig = q.then;
      q.then = (res, rej) => orig.call(q, (d) => res(d && { ...d, save: async () => d, razorpay: d.razorpay || {} }), rej);
      return q;
    };
    const OutboundJob = R('src/models/OutboundJob');
    OutboundJob.updateMany = async () => ({});
    try {
      await billing.recordOfflinePayment('orgA', { plan: 'growth', cycle: 'monthly', amount: 9439, note: 'UPI ref 123' });
    } finally { Organization.findById = realFind; }
    await settle();
    const doc = invoices.docs.find((d) => /Offline/.test(d.description));
    assert.ok(doc, 'invoice row exists');
    assert.strictEqual(doc.status, 'paid');
    assert.match(doc.invoiceNumber, /^VIS-/);
    assert.strictEqual(posted.length, 1);
  });

  console.log('Mailer (additive)');
  await t('attachments + senderName are optional; existing callers behave exactly as before', async () => {
    posted.length = 0;
    // Existing style call inside a tenant: sender name = tenant company, no attachment key.
    await tenantContext.run({ _id: 'x', name: 'Tenant Realty', ownerUserId: 'o' }, () => mailer.sendDirectEmail({ to: 'a@b.com', subject: 'Hi', text: 'Body' }));
    assert.strictEqual(posted[0].sender.name, 'Tenant Realty');
    assert.ok(!('attachment' in posted[0]) && !('senderName' in posted[0]));
    // With senderName: the tenant context is not read at all (works from webhooks).
    const realGetOrg = tenantContext.getOrg;
    tenantContext.getOrg = () => { throw new Error('tenant context must not be read'); };
    try {
      await mailer.sendDirectEmail({ to: 'a@b.com', subject: 'Hi', text: 'Body', senderName: 'Platform Co', attachments: [{ name: 'x.pdf', contentBase64: 'JVBERi0=' }] });
    } finally { tenantContext.getOrg = realGetOrg; }
    assert.strictEqual(posted[1].sender.name, 'Platform Co');
    assert.deepStrictEqual(posted[1].attachment, [{ name: 'x.pdf', content: 'JVBERi0=' }]);
    // Empty attachments array adds nothing.
    await mailer.sendDirectEmail({ to: 'a@b.com', subject: 'Hi', text: 'Body', attachments: [] });
    assert.ok(!('attachment' in posted[2]));
  });

  console.log('Routes');
  await t('customer and admin invoice routes are mounted behind their auth', () => {
    const list = (router) => router.stack.flatMap((l) => (l.route ? Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`) : []));
    const b = list(R('src/routes/billingRoutes'));
    assert.ok(b.includes('GET /invoices/:id/pdf') && b.includes('POST /invoices/:id/resend'));
    const p = R('src/routes/platformRoutes');
    assert.ok(list(p).includes('GET /payments/:id/pdf'));
    assert.strictEqual(p.stack[0].name, 'adminAuth', 'admin auth is applied to every platform route');
  });

  console.log(`\n${pass} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
  process.exit(process.exitCode || 0);
})();
