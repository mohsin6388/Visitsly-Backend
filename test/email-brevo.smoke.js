/* eslint-disable no-console */
/**
 * Email via Brevo (verified company sender + per-email wallet) — smoke test, NO database, NO network.
 *   node test/email-brevo.smoke.js
 */
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
process.env.SAAS_MODE = 'true';
process.env.GEMINI_API_KEY = 'test';
process.env.BREVO_API_KEY = 'test-key';
process.env.BREVO_FROM_EMAIL = 'noreply@platform.test';
process.env.EMAIL_DAILY_CAP_PER_COMPANY = '1000';
const R = (p) => require(path.join(ROOT, p));
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const axios = require('axios');
const { createFake } = R('test/helpers/fakeMongo');

// One fake HTTP client for both mailer.js and brevoSenders.js (they call axios.create at load time).
const calls = [];
let respond = () => ({ data: {} });
const fakeHttp = {
  interceptors: { request: { use() {} }, response: { use() {} } },
  post: async (url, body, cfg) => { calls.push({ method: 'post', url, body, cfg }); return respond('post', url, body); },
  request: async (cfg) => { calls.push({ method: cfg.method, url: cfg.url, body: cfg.data, cfg }); return respond(cfg.method, cfg.url, cfg.data); },
};
axios.create = () => fakeHttp;

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.stack || e.message); process.exitCode = 1; }
};
const httpErr = (status, message) => Object.assign(new Error(message), { response: { status, data: { message } } });

const domains = R('src/config/emailDomains');
const brevo = R('src/services/email/brevoSenders');
const Organization = R('src/models/Organization');
const EmailSender = R('src/models/EmailSender');
const EmailWalletTx = R('src/models/EmailWalletTx');
const OutboundJob = R('src/models/OutboundJob');

const orgs = createFake().install(Organization);
const walletTx = createFake();
walletTx.install(EmailWalletTx);
EmailWalletTx.deleteOne = async (f) => { const i = walletTx.docs.findIndex((d) => d.key === f.key); if (i >= 0) walletTx.docs.splice(i, 1); };
const jobs = createFake().install(OutboundJob);
OutboundJob.updateMany = async (filter, update) => {
  let n = 0;
  for (const d of jobs.docs) {
    const okOwner = String(d.ownerId) === String(filter.ownerId);
    const okStatus = filter.status === undefined || d.status === filter.status;
    const okChannel = !filter.channel || d.channel === filter.channel;
    const okErr = filter.lastError === undefined || d.lastError === filter.lastError;
    if (okOwner && okStatus && okChannel && okErr) { Object.assign(d, update.$set); n += 1; }
  }
  return { modifiedCount: n };
};
const senders = createFake().install(EmailSender);
// Documents returned by findOne() get a save() that writes back (lean() stays plain).
const rawFindOne = senders.findOne;
EmailSender.findOne = (f) => ({
  lean: () => rawFindOne(f),
  then: (res, rej) => rawFindOne(f).then((d) => (d ? Object.assign(d, { save: async () => { const i = senders.docs.findIndex((x) => x._id === d._id); const { save, ...plain } = d; Object.assign(senders.docs[i], JSON.parse(JSON.stringify(plain))); } }) : d)).then(res, rej),
});
EmailSender.deleteOne = async (f) => { const i = senders.docs.findIndex((d) => String(d.ownerId) === String(f.ownerId)); if (i >= 0) senders.docs.splice(i, 1); };

(async () => {
  console.log('Email via Brevo');

  /* ---------- B2: blocked domains ---------- */
  await t('free / personal / disposable domains are rejected with the friendly message', () => {
    for (const e of ['a@gmail.com', 'a@googlemail.com', 'a@yahoo.com', 'a@yahoo.co.in', 'a@outlook.com', 'a@hotmail.com', 'a@live.com', 'a@msn.com',
      'a@icloud.com', 'a@me.com', 'a@rediffmail.com', 'a@proton.me', 'a@protonmail.com', 'a@aol.com', 'a@zoho.com', 'a@gmx.net', 'a@yandex.ru',
      'a@mail.com', 'a@mailinator.com', 'a@mail.gmail.com']) {
      assert.throws(() => domains.assertOfficialEmail(e), (err) => err.code === 'EMAIL_PERSONAL_DOMAIN' && err.message === 'Please use your official company email', e);
    }
  });
  await t('an official address passes; garbage is a bad address', () => {
    assert.deepStrictEqual(domains.assertOfficialEmail(' Info@Acme-Realty.in '), { email: 'info@acme-realty.in', domain: 'acme-realty.in' });
    assert.throws(() => domains.assertOfficialEmail('nope'), (e) => e.code === 'EMAIL_BAD_ADDRESS');
  });

  /* ---------- B3: Brevo calls ---------- */
  await t('createSender posts name+email with the api-key header; validate sends an INTEGER otp', async () => {
    calls.length = 0;
    respond = () => ({ data: { id: 42 } });
    const r = await brevo.createSender({ email: 'info@acme.in', name: 'Acme' });
    assert.strictEqual(r.id, 42);
    assert.deepStrictEqual(calls[0].body, { email: 'info@acme.in', name: 'Acme' });
    assert.strictEqual(calls[0].url, '/senders');
    assert.strictEqual(calls[0].cfg.headers['api-key'], 'test-key');
    respond = () => ({ data: '' });
    await brevo.validateSender(42, '012345');
    const v = calls[calls.length - 1];
    assert.strictEqual(v.method, 'put');
    assert.strictEqual(v.url, '/senders/42/validate');
    assert.deepStrictEqual(v.body, { otp: 12345 });
  });
  await t('bad / expired OTP and a short code give friendly errors', async () => {
    await assert.rejects(brevo.validateSender(42, '12'), (e) => e.code === 'EMAIL_OTP_INVALID');
    respond = () => { throw httpErr(400, 'OTP code has expired'); };
    await assert.rejects(brevo.validateSender(42, '123456'), (e) => e.code === 'EMAIL_OTP_EXPIRED');
    respond = () => { throw httpErr(400, 'Invalid OTP code provided'); };
    await assert.rejects(brevo.validateSender(42, '123456'), (e) => e.code === 'EMAIL_OTP_INVALID');
    respond = () => { throw httpErr(400, 'Request already processed'); };
    assert.strictEqual(await brevo.validateSender(42, '123456'), true);
  });
  await t('domain: create returns DNS records; "already exists" falls back to reading it; authenticate false when DNS missing', async () => {
    const rec = (host, ok) => ({ host_name: host, type: 'TXT', value: `v-${host}`, status: ok });
    const dns = (ok) => ({ brevo_code: rec('@', ok), dkim_record: rec('mail._domainkey', ok), dmarc_record: rec('_dmarc', ok) });
    respond = (m, url) => (m === 'post' ? { data: { domain_name: 'acme.in', dns_records: dns(false) } } : { data: {} });
    const d = await brevo.createDomain('acme.in');
    assert.strictEqual(d.records.length, 3);
    assert.deepStrictEqual(d.records.map((r) => r.label), ['Brevo code', 'DKIM', 'DMARC']);
    respond = (m) => { if (m === 'post') throw httpErr(400, 'Domain already exists in your account'); return { data: { domain: 'acme.in', verified: false, authenticated: false, dns_records: dns(false) } }; };
    const d2 = await brevo.createDomain('acme.in');
    assert.strictEqual(d2.authenticated, false);
    respond = () => { throw httpErr(400, 'DNS records not properly configured'); };
    assert.strictEqual(await brevo.authenticateDomain('acme.in'), false);
    respond = () => { throw httpErr(401, 'Key not found'); };
    await assert.rejects(brevo.listSenders(), (e) => e.code === 'BREVO_AUTH_ERROR' && !/key/i.test(e.message));
  });

  /* ---------- sender flow ---------- */
  const svc = R('src/services/email/emailSenderService');
  const org1 = { _id: 'org1', name: 'Acme Realty' };
  const org2 = { _id: 'org2', name: 'Other Co' };
  let brevoState;
  const reset = () => { brevoState = { authenticated: false, recordsOk: false, deleted: [] }; };
  reset();
  const origs = {};
  for (const k of ['createSender', 'validateSender', 'deleteSender', 'createDomain', 'getDomain', 'authenticateDomain']) origs[k] = brevo[k];
  const recs = () => [{ label: 'Brevo code', type: 'TXT', host: '@', value: 'brevo-code=abc', ok: brevoState.recordsOk }, { label: 'DKIM', type: 'TXT', host: 'mail._domainkey', value: 'k=rsa', ok: brevoState.recordsOk }, { label: 'DMARC', type: 'TXT', host: '_dmarc', value: 'v=DMARC1', ok: brevoState.recordsOk }];
  brevo.createSender = async () => ({ id: 7, existing: false });
  brevo.validateSender = async (id, otp) => { if (String(otp) !== '123456') { const e = new Error('That code is not correct. Check it and try again.'); e.code = 'EMAIL_OTP_INVALID'; throw e; } return true; };
  brevo.deleteSender = async (id) => { brevoState.deleted.push(id); };
  brevo.createDomain = async () => ({ records: recs(), authenticated: false });
  brevo.getDomain = async () => ({ records: recs(), authenticated: brevoState.authenticated });
  brevo.authenticateDomain = async () => { if (!brevoState.recordsOk) return false; brevoState.authenticated = true; return true; };

  await t('B3: guidelines must be accepted; gmail rejected; official email creates a pending sender', async () => {
    await assert.rejects(svc.start({ org: org1, ownerId: 'u1', email: 'info@acme.in', guidelinesAccepted: false }), (e) => e.code === 'EMAIL_GUIDELINES_REQUIRED');
    await assert.rejects(svc.start({ org: org1, ownerId: 'u1', email: 'acme@gmail.com', guidelinesAccepted: true }), (e) => e.message === 'Please use your official company email');
    const s = await svc.start({ org: org1, ownerId: 'u1', email: 'info@acme.in', displayName: 'Acme Realty', guidelinesAccepted: true });
    assert.strictEqual(s.status, 'pending_verification');
    assert.strictEqual(svc.readiness(s).ready, false);
  });
  await t('B3: another company cannot claim the same address', async () => {
    await assert.rejects(svc.start({ org: org2, ownerId: 'u2', email: 'info@acme.in', displayName: 'X', guidelinesAccepted: true }), (e) => e.code === 'EMAIL_ALREADY_USED');
  });
  await t('B2/B11-2: wrong OTP fails; right OTP verifies and shows DNS records; domain not ready until authenticated', async () => {
    await assert.rejects(svc.verifyOtp('u1', '000000'), (e) => e.code === 'EMAIL_OTP_INVALID');
    const s = await svc.verifyOtp('u1', '123456');
    assert.strictEqual(s.status, 'verified');
    assert.strictEqual(s.dnsRecords.length, 3);
    assert.strictEqual(s.domainAuthStatus, 'pending');
    const r = svc.readiness(s);
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.step, 'domain');
  });
  await t('B11-2: "Check DNS" before DNS is set stays pending; after DNS is set it becomes authenticated and ready', async () => {
    let s = await svc.checkDns('u1');
    assert.strictEqual(s.domainAuthStatus, 'pending');
    assert.ok(s.lastError);
    brevoState.recordsOk = true;
    s = await svc.checkDns('u1');
    assert.strictEqual(s.domainAuthStatus, 'authenticated');
    assert.strictEqual(svc.readiness(s).ready, true);
    assert.strictEqual(svc.publicView(s).ready, true);
  });
  await t('B4: EMAIL_REQUIRE_DOMAIN_AUTH=false only needs a verified sender; a paused sender is never ready', () => {
    process.env.EMAIL_REQUIRE_DOMAIN_AUTH = 'false';
    assert.strictEqual(svc.readiness({ status: 'verified', domainAuthStatus: 'pending' }).ready, true);
    process.env.EMAIL_REQUIRE_DOMAIN_AUTH = 'true';
    assert.strictEqual(svc.readiness({ status: 'verified', domainAuthStatus: 'pending' }).ready, false);
    assert.strictEqual(svc.readiness({ status: 'verified', domainAuthStatus: 'authenticated', paused: true, pausedReason: 'x' }).ready, false);
    assert.strictEqual(svc.readiness(null).ready, false);
  });
  await t('B3: sender cannot be removed while an email campaign is running', async () => {
    jobs.seed({ ownerId: 'u1', channel: 'email', status: 'pending' });
    await assert.rejects(svc.remove('u1'), (e) => e.code === 'EMAIL_CAMPAIGN_RUNNING');
    jobs.docs.length = 0;
  });

  /* ---------- wallet ---------- */
  const wallet = R('src/services/email/emailWallet');
  const OID = 'orgW';
  const seedOrg = (balanceMilli) => { orgs.docs.length = 0; orgs.seed({ _id: OID, ownerUserId: 'uW', emailWallet: { balanceMilli, rechargedMilli: 0, spentMilli: 0 } }); walletTx.docs.length = 0; };
  const bal = () => orgs.docs.find((d) => d._id === OID).emailWallet.balanceMilli;

  await t('B5: price = 0.20 + 0.10 = ₹0.30; +18% GST = ₹0.354; integer milli units; no cost/margin in the client view', () => {
    assert.deepStrictEqual(wallet.pricing(), { costMilli: 200, marginMilli: 100, unitMilli: 300 });
    const p = wallet.clientPrice();
    assert.strictEqual(p.perEmail, 0.3);
    assert.strictEqual(p.gstRate, 0.18);
    assert.strictEqual(p.perEmailWithGst, 0.354);
    const view = JSON.stringify(wallet.summary({ emailWallet: { balanceMilli: 3000 } }));
    assert.ok(!/cost|margin/i.test(view), view);
    assert.strictEqual(wallet.summary({ emailWallet: { balanceMilli: 3000 } }).emailsLeft, 10);
  });
  await t('B5: estimate says whether the balance covers a campaign (with GST shown)', () => {
    const e = wallet.estimate({ emailWallet: { balanceMilli: 2999 } }, 10);
    assert.strictEqual(e.enough, false);
    assert.strictEqual(e.cost, 3);
    assert.strictEqual(e.costWithGst, 3.54);
    assert.strictEqual(e.shortfallEmails, 1);
    assert.strictEqual(wallet.estimate({ emailWallet: { balanceMilli: 3000 } }, 10).enough, true);
  });
  await t('B11-5: debit takes ₹0.30 once per job (retry never double-charges)', async () => {
    seedOrg(1000);
    assert.deepStrictEqual(await wallet.debitForJob(OID, 'j1'), { ok: true, charged: true, balanceMilli: 700 });
    assert.strictEqual((await wallet.debitForJob(OID, 'j1')).charged, false);
    assert.strictEqual(bal(), 700);
  });
  await t('B11-5: parallel debits never push the balance below zero', async () => {
    seedOrg(900); // 3 emails
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => wallet.debitForJob(OID, `p${i}`)));
    assert.strictEqual(results.filter((r) => r.ok).length, 3);
    assert.strictEqual(bal(), 0);
    assert.strictEqual(results.filter((r) => !r.ok && r.reason === 'insufficient').length, 7);
    assert.strictEqual(walletTx.docs.length, 3); // failed attempts leave no ledger row
  });
  await t('B5: our-side failure is refunded once; the retry is charged once again', async () => {
    seedOrg(600);
    await wallet.debitForJob(OID, 'r1');
    assert.strictEqual(await wallet.refundJob(OID, 'r1'), true);
    assert.strictEqual(await wallet.refundJob(OID, 'r1'), false);
    assert.strictEqual(bal(), 600);
    assert.strictEqual((await wallet.debitForJob(OID, 'r1')).charged, true);
    assert.strictEqual((await wallet.debitForJob(OID, 'r1')).charged, false);
    assert.strictEqual(bal(), 300);
    assert.strictEqual(await wallet.refundJob(OID, 'never-charged'), false);
  });
  await t('B5: recharge credits N × ₹0.30 (GST is not wallet value), once per invoice, and resumes paused jobs', async () => {
    seedOrg(0);
    jobs.docs.length = 0;
    jobs.seed({ ownerId: 'uW', channel: 'email', status: 'paused', lastError: wallet.WALLET_PAUSE_REASON });
    jobs.seed({ ownerId: 'uW', channel: 'email', status: 'paused', lastError: 'Subscription inactive' });
    assert.strictEqual(await wallet.creditRecharge(OID, 'inv1', 1000), true);
    assert.strictEqual(await wallet.creditRecharge(OID, 'inv1', 1000), false);
    assert.strictEqual(bal(), 300000);
    assert.deepStrictEqual(jobs.docs.map((d) => d.status), ['pending', 'paused']);
    const tx = walletTx.docs.find((d) => d.type === 'recharge');
    assert.strictEqual(tx.costMilli, 200000);
    assert.strictEqual(tx.marginMilli, 100000);
  });
  await t('B11-6: admin credit adds emails; a correction can never take the balance below zero', async () => {
    seedOrg(0);
    assert.strictEqual((await wallet.adminAdjust(OID, { emails: 100, actorId: 'adm', note: 'goodwill' })).changed, true);
    assert.strictEqual(bal(), 30000);
    assert.strictEqual((await wallet.adminAdjust(OID, { emails: -101, actorId: 'adm' })).changed, false);
    assert.strictEqual(bal(), 30000);
    assert.strictEqual((await wallet.adminAdjust(OID, { emails: -100, actorId: 'adm' })).changed, true);
    assert.strictEqual(bal(), 0);
  });

  /* ---------- billing: recharge quote ---------- */
  const billing = R('src/services/saas/billingService');
  await t('B5: recharge quote = N × ₹0.30 + 18% GST, INR, Growth+ only', () => {
    const growth = { plan: 'growth', status: 'active', currency: 'AED' };
    const q = billing.addonQuote(growth, 'emailCredit', 1000);
    assert.strictEqual(q.currency, 'INR');
    assert.strictEqual(q.amount, 300);
    assert.strictEqual(q.total, 354);
    assert.strictEqual(q.taxRate, 0.18);
    assert.throws(() => billing.addonQuote({ plan: 'starter', status: 'active' }, 'emailCredit', 1000), (e) => e.statusCode === 403);
    assert.throws(() => billing.addonQuote({ plan: 'trial', status: 'trialing' }, 'emailCredit', 1000), (e) => e.statusCode === 403);
    assert.strictEqual(R('src/config/pricing').addonsIn('INR').emailCredit, undefined);
  });
  await t('B6: Starter / Trial have no email feature; Growth, Builder, Enterprise do', () => {
    const sub = R('src/services/saas/subscription');
    for (const [plan, want] of [['starter', false], ['trial', false], ['growth', true], ['builder', true], ['enterprise', true]]) {
      assert.strictEqual(sub.hasFeature({ plan, status: plan === 'trial' ? 'trialing' : 'active' }, 'emailCampaigns'), want, plan);
    }
  });

  /* ---------- safety ---------- */
  const safety = R('src/services/email/emailSafety');
  await t('B8: auto-pause decision respects min sample, bounce and complaint thresholds', () => {
    const t0 = { minSample: 100, maxBounce: 0.05, maxComplaint: 0.003 };
    assert.strictEqual(safety.decide({ sent: 99, bounced: 99, complained: 99 }, t0).pause, false);
    assert.strictEqual(safety.decide({ sent: 100, bounced: 5, complained: 0 }, t0).pause, false);
    assert.strictEqual(safety.decide({ sent: 100, bounced: 6, complained: 0 }, t0).pause, true);
    assert.strictEqual(safety.decide({ sent: 1000, bounced: 0, complained: 4 }, t0).pause, true);
    assert.strictEqual(safety.decide({ sent: 1000, bounced: 0, complained: 3 }, t0).pause, false);
  });

  /* ---------- sending path ---------- */
  const mailer = R('src/services/email/mailer');
  await t('B4: campaign mail goes From the company sender with Reply-To the same address; platform mail still uses the platform sender', async () => {
    calls.length = 0;
    respond = () => ({ data: { messageId: '<m1@brevo>' } });
    await mailer.sendCampaignEmail({ to: 'lead@x.com', subject: 'Hi {{name}}', body: 'Hello', vars: { name: 'Ravi' }, companyName: 'Acme Realty', sender: { email: 'info@acme.in', name: 'Acme Realty' }, unsubscribeUrl: 'https://app.test/unsub/abc', tags: ['t1'], idempotencyKey: 'job-1' });
    const b = calls[0].body;
    assert.deepStrictEqual(b.sender, { email: 'info@acme.in', name: 'Acme Realty' });
    assert.deepStrictEqual(b.replyTo, { email: 'info@acme.in' });
    assert.ok(b.htmlContent.includes('https://app.test/unsub/abc'));
    assert.ok(b.textContent.includes('https://app.test/unsub/abc'));
    assert.strictEqual(b.senderOverride, undefined);
    assert.strictEqual(b.headers['X-PropAI-Request-Key'], 'job-1');
    calls.length = 0;
    await mailer.sendDirectEmail({ to: 'o@x.com', subject: 'Verify', text: 'code' });
    assert.strictEqual(calls[0].body.sender.email, 'noreply@platform.test');
  });

  /* ---------- worker: processEmail ---------- */
  const worker = R('src/services/queue/bulkWorker');
  const tenantContext = R('src/context/tenantContext');
  const settingsService = R('src/services/settings/settingsService');
  const Campaign = R('src/models/Campaign');
  const EmailMessage = R('src/models/EmailMessage');
  const Notification = R('src/models/Notification');
  const campaigns = createFake().install(Campaign);
  const msgs = [];
  EmailMessage.findOne = (f) => Promise.resolve(msgs.find((m) => String(m.outboundJobId) === String(f.outboundJobId)) || null);
  EmailMessage.countDocuments = async (f) => msgs.filter((m) => (f.to ? m.to === f.to : true) && (f.status && f.status.$in ? f.status.$in.includes(m.status) : true) && (!f.outboundJobId || !f.outboundJobId.$ne || String(m.outboundJobId) !== String(f.outboundJobId.$ne))).length;
  EmailMessage.updateOne = async (f, u) => { const m = msgs.find((x) => x._id === f._id); if (m && (!f.status || f.status.$in.includes(m.status))) Object.assign(m, u.$set); return {}; };
  const origCtor = EmailMessage;
  // minimal `new EmailMessage(...)` replacement used by processEmail
  const FakeMsg = function FakeMsg(data) { Object.assign(this, data); this._id = `m${msgs.length + 1}`; };
  FakeMsg.prototype.save = async function save() { if (!msgs.includes(this)) msgs.push(this); return this; };
  const realExports = require.cache[require.resolve(path.join(ROOT, 'src/models/EmailMessage'))];
  Object.assign(FakeMsg, { findOne: EmailMessage.findOne, countDocuments: EmailMessage.countDocuments, updateOne: EmailMessage.updateOne });
  // bulkWorker captured the model at load time, so patch the instance methods on the real model instead:
  EmailMessage.prototype.save = FakeMsg.prototype.save;
  void origCtor; void realExports;
  const notes = [];
  Notification.create = async (d) => { notes.push(d); return d; };
  settingsService.getOrCreateSettings = async () => ({ companyName: 'Acme Realty' });
  const Lead = R('src/models/Lead');
  const wOrg = { _id: OID, ownerUserId: 'uW' };
  tenantContext.getOrg = () => wOrg;
  const JOB = (id) => ({ _id: id, ownerId: 'uW', channel: 'email', campaignId: 'c1', leadId: 'l1', status: 'processing' });
  const LEAD = { _id: 'l1', name: 'Ravi Kumar', email: 'ravi@buyer.com' };
  const resetWorld = (balance) => {
    seedOrg(balance); jobs.docs.length = 0; msgs.length = 0; notes.length = 0; senders.docs.length = 0; campaigns.docs.length = 0;
    senders.seed({ orgId: OID, ownerId: 'uW', email: 'info@acme.in', displayName: 'Acme Realty', status: 'verified', domainAuthStatus: 'authenticated', domain: 'acme.in' });
    campaigns.seed({ _id: 'c1', status: 'active', email: { subject: 'Hello {{firstName}}', body: 'Visit us' } });
    jobs.seed({ _id: 'j1', ownerId: 'uW', channel: 'email', status: 'processing', attempts: 1 });
    ['j2', 'j3'].forEach((id) => jobs.seed({ _id: id, ownerId: 'uW', channel: 'email', status: 'pending', attempts: 0 }));
    safety._reset?.();
  };
  const jobStatus = (id) => jobs.docs.find((d) => d._id === id).status;
  const sentBodies = () => calls.filter((c) => c.url && /smtp\/email/.test(c.url)).map((c) => c.body);

  await t('B11-3/4/5: worker sends From the company sender, debits ₹0.30, tracks the message', async () => {
    resetWorld(900);
    calls.length = 0;
    respond = () => ({ data: { messageId: '<abc@brevo>' } });
    await worker._test.processEmail(JOB('j1'), LEAD);
    assert.strictEqual(sentBodies().length, 1);
    assert.strictEqual(sentBodies()[0].sender.email, 'info@acme.in');
    assert.strictEqual(sentBodies()[0].replyTo.email, 'info@acme.in');
    assert.strictEqual(bal(), 600);
    assert.strictEqual(jobStatus('j1'), 'sent');
    assert.strictEqual(msgs[0].from, 'info@acme.in');
    assert.strictEqual(msgs[0].status, 'sent');
  });
  await t('B11-5: empty wallet pauses (not fails) the job and every pending email job, notifies the Owner once, sends nothing', async () => {
    resetWorld(0);
    calls.length = 0;
    await worker._test.processEmail(JOB('j1'), LEAD);
    assert.strictEqual(sentBodies().length, 0);
    assert.strictEqual(jobStatus('j1'), 'paused');
    assert.ok(jobs.docs.every((d) => d.status === 'paused' || d.status === 'sent'));
    assert.strictEqual(bal(), 0);
    assert.ok(notes.some((n) => /wallet/i.test(n.title)));
    // recharge → jobs go back to pending
    await wallet.creditRecharge(OID, 'invX', 10);
    assert.ok(jobs.docs.every((d) => d.status === 'pending'));
  });
  await t('B11-5: provider (our-side) failure refunds the wallet and the error is rethrown for retry', async () => {
    resetWorld(900);
    respond = () => { throw httpErr(503, 'service unavailable'); };
    await assert.rejects(worker._test.processEmail(JOB('j1'), LEAD));
    assert.strictEqual(bal(), 900);
    // next attempt succeeds and is charged once
    respond = () => ({ data: { messageId: '<ok@brevo>' } });
    await worker._test.processEmail(JOB('j1'), LEAD);
    assert.strictEqual(bal(), 600);
  });
  await t('B8: opted-out and invalid addresses are skipped without charge; unready sender blocks sending', async () => {
    resetWorld(900);
    calls.length = 0;
    await worker._test.processEmail(JOB('j1'), { ...LEAD, emailOptedOut: true });
    await worker._test.processEmail(JOB('j2'), { ...LEAD, email: 'not-an-email' });
    assert.strictEqual(jobStatus('j1'), 'cancelled');
    assert.strictEqual(jobStatus('j2'), 'cancelled');
    assert.strictEqual(bal(), 900);
    senders.docs[0].domainAuthStatus = 'pending';
    await assert.rejects(worker._test.processEmail(JOB('j3'), LEAD), (e) => e.code === 'EMAIL_NOT_CONNECTED');
    assert.strictEqual(sentBodies().length, 0);
    assert.strictEqual(bal(), 900);
    assert.strictEqual(worker._test.classifyEmailError({ code: 'EMAIL_NOT_CONNECTED' }), 'fatal_pause');
  });
  await t('refund policy: recipient-side errors are not refunded, our-side ones are', () => {
    const f = worker._test.isOurSideEmailFailure;
    assert.strictEqual(f({ code: 'BREVO_AUTH_ERROR' }), true);
    assert.strictEqual(f({ status: 503 }), true);
    assert.strictEqual(f({ code: 'ETIMEDOUT' }), true);
    assert.strictEqual(f({ code: 'BREVO_INVALID_RECIPIENT', status: 400 }), false);
    assert.strictEqual(f({ status: 400 }), false);
  });

  /* ---------- B1: SMTP is gone ---------- */
  await t('B1: no SMTP code, routes or fallback remain', () => {
    const fs = require('fs');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = walk(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'));
    assert.ok(!fs.existsSync(path.join(ROOT, 'src/services/email/emailAccountService.js')));
    assert.ok(!fs.existsSync(path.join(ROOT, 'src/models/EmailAccount.js')));
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      assert.ok(!/emailAccountService|models\/EmailAccount|BREVO_CAMPAIGN_FALLBACK|nodemailer/.test(s), f);
    }
    const stack = R('scripts/route-permissions').collect().map((r) => `${r.method} ${r.url}`);
    assert.ok(!stack.some((r) => /\/email\/account/.test(r)), 'SMTP routes still exist');
    assert.ok(stack.some((r) => /POST \/api\/email\/sender\/verify/.test(r)));
  });

  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
