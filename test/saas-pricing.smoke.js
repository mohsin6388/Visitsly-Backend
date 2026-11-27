/**
 * SaaS plans / pricing / feature-gate smoke test. Needs NO database.
 *   npm run test:saas
 * Covers: plan limits + features, env-driven prices, trial totals, feature
 * gates, voice minutes, phone parsing, validators, setup-fee-free quotes and
 * the public /plans and /geo endpoints.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
process.env.SAAS_MODE = process.env.SAAS_MODE || 'true';
const req = (m) => require(path.join(ROOT, m));
const assert = require('assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false); // no DB: fail fast instead of hanging
let pass = 0; const t = async (name, fn) => { try { await fn(); pass++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '\n     ', e.message); process.exitCode = 1; } };

(async () => {
  const plans = req('src/config/plans');
  const pricing = req('src/config/pricing');
  const sub = req('src/services/saas/subscription');
  const phone = req('src/utils/phone');

  await t('plan limits match spec', () => {
    const L = (c) => plans.PLANS[c].limits;
    assert.deepStrictEqual([L('starter').users, L('growth').users, L('builder').users, L('enterprise').users], [1, 5, 10, null]);
    assert.deepStrictEqual([L('starter').aiConversations, L('growth').aiConversations, L('builder').aiConversations], [1000, 3000, 10000]);
    assert.deepStrictEqual([L('starter').voiceMinutesIncluded, L('growth').voiceMinutesIncluded, L('builder').voiceMinutesIncluded], [0, 30, 100]);
    assert.strictEqual(plans.PLANS.builder.name, 'Builder Pro');
  });
  await t('trial limits match spec', () => {
    const l = plans.PLANS.trial.limits;
    assert.deepStrictEqual({ u: l.users, c: l.contacts, b: l.bulkMessages, a: l.aiConversations, r: l.aiRepliesPerContact, k: l.campaignsPerMonth, w: l.whatsappNumbers }, { u: 1, c: 50, b: 50, a: 50, r: 15, k: 1, w: 1 });
    const f = plans.PLANS.trial.features;
    assert.strictEqual(f.emailCampaigns, false); assert.strictEqual(f.aiCalling, false); assert.strictEqual(f.bulkWhatsapp, true);
  });
  await t('feature ladder', () => {
    const f = (c) => plans.PLANS[c].features;
    assert.ok(f('starter').aiAgent && f('starter').bulkWhatsapp && f('starter').autoFollowUps && !f('starter').emailCampaigns && !f('starter').aiCalling);
    assert.ok(f('growth').bulkWhatsapp && f('growth').emailCampaigns && f('growth').teamRouting && f('growth').autoFollowUps && f('growth').aiCalling && !f('growth').inventory);
    assert.ok(f('builder').aiCalling);
    assert.ok(f('builder').inventory && f('builder').multiProjectBot && f('builder').metaLeadAds && f('builder').weeklyReports && !f('builder').portalIntegrations);
    assert.ok(Object.values(f('enterprise')).every(Boolean));
  });
  await t('no money in plans.js', () => {
    for (const p of Object.values(plans.PLANS)) assert.ok(!('monthly' in p) && !('setupFee' in p) && !('annual' in p), p.code);
  });
  await t('env limit override still works', () => {
    process.env.STARTER_MAX_USERS = '4';
    delete require.cache[require.resolve(path.join(ROOT, 'src/config/plans'))];
    const fresh = req('src/config/plans');
    assert.strictEqual(fresh.PLANS.starter.limits.users, 4);
    delete process.env.STARTER_MAX_USERS;
  });
  await t('default prices + currency map', () => {
    assert.strictEqual(pricing.planPrice('growth', 'INR').monthly, 7999);
    assert.strictEqual(pricing.planPrice('builder', 'AED').monthly, 999);
    assert.strictEqual(pricing.planPrice('starter', 'USD').annual, 690);
    assert.strictEqual(pricing.planPrice('enterprise', 'USD').monthly, null);
    assert.deepStrictEqual(['IN', 'AE', 'GB', 'SA', 'US'].map(pricing.currencyForCountry), ['INR', 'AED', 'USD', 'USD', 'USD']);
    assert.strictEqual(pricing.addonPrice('voiceMinute', 'AED'), 0.45);
    assert.strictEqual(pricing.taxRate('INR'), 0.18);
    assert.ok(!pricing.supported('GBP'));
  });
  await t('limitsFor + featureOverrides', () => {
    const org = { plan: 'starter', limitOverrides: { users: 3 }, featureOverrides: { bulkWhatsapp: true, bogus: true } };
    assert.strictEqual(plans.limitsFor(org).users, 3);
    assert.strictEqual(plans.featuresFor(org).bulkWhatsapp, true);
    assert.ok(!('bogus' in plans.featuresFor(org)));
  });
  await t('trial uses lifetime totals', () => {
    const org = { plan: 'trial', status: 'trialing', usageTotals: { aiConversations: 50, campaigns: 1 } };
    const r = sub.checkLimit(org, 'aiConversations', 0, 1);
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /Free trial limit reached: 50 AI conversations/);
    assert.strictEqual(sub.checkLimit(org, 'campaignsPerMonth', 0, 1).ok, false);
    assert.strictEqual(sub.checkLimit({ plan: 'trial', status: 'trialing' }, 'contacts', 49, 1).ok, true);
    assert.strictEqual(sub.checkLimit({ plan: 'trial', status: 'trialing' }, 'contacts', 50, 1).ok, false);
    const reply = sub.aiReplyLimitInfo({ plan: 'trial', status: 'trialing' }, 15);
    assert.strictEqual(reply.reached, true);
  });
  await t('paid plan still monthly', () => {
    const org = { plan: 'starter', status: 'active', usageTotals: { aiConversations: 99999 } };
    assert.strictEqual(sub.checkLimit(org, 'aiConversations', 10, 1).ok, true);
  });
  await t('bulk message trial message', () => {
    const tenantContext = req('src/context/tenantContext');
    const org = { _id: 'x', ownerUserId: 'o', plan: 'trial', status: 'trialing', bulkMessagesTotal: 50, usage: {} };
    let err;
    tenantContext.run(org, () => { try { sub.assertBulkMessagesAllowed(1); } catch (e) { err = e; } });
    assert.ok(err); assert.strictEqual(err.statusCode, 403); assert.match(err.message, /Free trial limit reached: 50 bulk messages/);
    assert.strictEqual(err.details.code, 'PLAN_LIMIT');
  });
  await t('assertFeature / requireFeature', () => {
    const trial = { plan: 'trial', status: 'trialing' };
    assert.throws(() => sub.assertFeature('emailCampaigns', trial), (e) => e.statusCode === 403 && e.details.code === 'PLAN_LIMIT' && /free trial/.test(e.message));
    assert.throws(() => sub.assertFeature('aiCalling', trial), /AI calling is not available on the free trial/);
    assert.doesNotThrow(() => sub.assertFeature('bulkWhatsapp', trial));
    assert.throws(() => sub.assertFeature('inventory', { plan: 'growth', status: 'active' }), /Builder Pro/);
    let got; sub.requireFeature('teamRouting')({ org: { plan: 'starter', status: 'active' }, method: 'POST' }, {}, (e) => { got = e; });
    assert.ok(got && got.details.feature === 'teamRouting');
    got = 'none'; sub.requireFeature('teamRouting')({ org: { plan: 'growth', status: 'active' } }, {}, (e) => { got = e; });
    assert.strictEqual(got, undefined);
    got = 'none'; sub.requireFeature('teamRouting')({}, {}, (e) => { got = e; }); // legacy, no org
    assert.strictEqual(got, undefined);
  });
  await t('voice usage: plan + recharged minutes, no overage (calls stop at 0)', () => {
    const month = req('src/services/saas/orgService').currentMonthIST();
    const v = sub.voiceUsage({ plan: 'growth', status: 'active', usage: { month, voiceMinutes: 45 }, addonGrants: [{ key: 'voiceMinute', quantity: 10 }] });
    assert.deepStrictEqual([v.enabled, v.includedMinutes, v.prepaidMinutes, v.overageMinutes, v.remainingIncluded], [true, 30, 10, 0, 10]); // pack counter starts at 0 → full pack balance (existing orgs)
    assert.strictEqual(sub.voiceUsage({ plan: 'trial', status: 'trialing' }).enabled, false);
  });
  await t('phone: international + dial code fallback', () => {
    assert.strictEqual(phone.normalizePhone('+971501234567', { defaultCountry: 'IN' }).phone, '971501234567');
    assert.strictEqual(phone.normalizePhone('+14155552671', { defaultCountry: 'IN' }).phone, '14155552671');
    assert.strictEqual(phone.normalizePhone('9876543210', { defaultCountry: 'IN', dialCode: '91' }).phone, '919876543210');
    assert.strictEqual(phone.normalizePhone('07911123456', { defaultCountry: 'GB', dialCode: '44' }).phone, '447911123456');
    assert.strictEqual(phone.normalizePhone('0501234567', { defaultCountry: 'AE', dialCode: '971' }).phone, '971501234567');
    assert.strictEqual(phone.normalizePhone('+91 12345', {}).ok, false);
  });
  await t('validators', () => {
    const a = req('src/validators/authValidators');
    assert.ok(a.signupSchema.safeParse({ body: { email: 'a@b.co', phone: '+971501234567', password: 'Passw0rdX' } }).success);
    assert.ok(!a.signupSchema.safeParse({ body: { email: 'a@b.co', phone: '+971501234567', password: 'weak' } }).success);
    const s = req('src/validators/saasValidators');
    const ok = s.orgProfileSchema.safeParse({ body: { ownerName: 'Ravi K', companyName: 'Acme Homes', country: 'ae', city: 'Dubai', businessType: 'agency' } });
    assert.ok(ok.success); assert.strictEqual(ok.data.body.country, 'AE');
    assert.ok(!s.orgProfileSchema.safeParse({ body: { ownerName: 'Ravi', companyName: 'Acme', country: 'ZZ', city: 'X1', businessType: 'agency' } }).success);
    assert.ok(!s.orgProfileSchema.safeParse({ body: { ownerName: 'Ravi', companyName: 'Acme', country: 'IN', city: 'Pune', businessType: 'other' } }).success);
    assert.ok(s.platformUpdateSchema.safeParse({ params: { id: 'a'.repeat(24) }, body: { country: 'US', featureOverrides: { emailCampaigns: true, aiCalling: null }, limitOverrides: { voiceMinutesIncluded: 500 } } }).success);
  });
  await t('billing quote has no setup fee', () => {
    const billing = req('src/services/saas/billingService');
    const q = billing.quote({ plan: 'trial', country: 'AE', currency: 'AED' }, 'growth', 'monthly');
    assert.deepStrictEqual([q.currency, q.price, q.setupFee, q.firstPayment], ['AED', 499, 0, 499]);
    const qi = billing.quote({ country: 'IN', currency: 'INR' }, 'starter', 'annual');
    assert.deepStrictEqual([qi.price, qi.firstPayment], [39990, Math.round(39990 * 1.18)]);
    assert.strictEqual(billing.currencyOf({ currency: 'GBP', country: 'GB' }), 'USD');
  });
  await t('voice: reminder script + company script in prompt', () => {
    const va = req('src/config/voiceAgents');
    const line = va.reminderScript('en', { name: 'Ravi Kumar', project: 'Omega', time: '14:00', company: 'Acme' });
    assert.match(line, /Ravi/); assert.match(line, /Omega/); assert.match(line, /today/); assert.match(line, /2 PM/);
    const conf = va.confirmationScript('en', { name: 'Ravi', project: 'Omega', date: '2099-01-01', time: '11:00', company: 'Acme' });
    assert.match(conf, /yes or no/i);
    const agent = req('src/services/voice/voiceAgent');
    const p1 = agent.systemPrompt({ purpose: 'enquiry', name: 'Ravi', company: 'Acme', script: '1. Ask about 3 BHK in Pune' });
    assert.match(p1, /CALL SCRIPT FROM THE COMPANY/); assert.match(p1, /3 BHK in Pune/);
    const p2 = agent.systemPrompt({ purpose: 'visit_reminder', project: 'Omega', visitTime: '14:00' });
    assert.match(p2, /REMINDER CALL/);
    assert.ok(!/CALL SCRIPT/.test(agent.systemPrompt({ purpose: 'enquiry' })));
  });
  await t('order-mode plan expires after grace', () => {
    const past = new Date(Date.now() - 10 * 86400000);
    const st = sub.subscriptionState({ status: 'active', plan: 'growth', currentPeriodEnd: past, razorpay: { mode: 'order' } });
    assert.strictEqual(st.active, false); assert.match(st.reason, /Renew/);
    const soon = sub.subscriptionState({ status: 'active', plan: 'growth', currentPeriodEnd: new Date(Date.now() - 86400000), razorpay: { mode: 'order' } });
    assert.strictEqual(soon.active, true); assert.strictEqual(soon.renewDue, true);
    assert.strictEqual(sub.subscriptionState({ status: 'active', plan: 'growth', currentPeriodEnd: past, razorpay: { mode: 'subscription' } }).active, true);
  });
  await t('payment mode env', () => {
    const billing = req('src/services/saas/billingService');
    assert.strictEqual(billing.paymentMode(), 'subscription');
    process.env.RAZORPAY_PAYMENT_MODE = 'order'; assert.strictEqual(billing.paymentMode(), 'order'); delete process.env.RAZORPAY_PAYMENT_MODE;
  });
  await t('new routes are mounted', () => {
    const list = (router, prefix = '') => router.stack.flatMap((l) => (l.route ? Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${prefix}${l.route.path}`) : []));
    const routes = [
      ...list(req('src/routes/campaignRoutes'), '/campaigns'),
      ...list(req('src/routes/voiceRoutes'), '/voice'),
      ...list(req('src/routes/billingRoutes'), '/billing'),
      ...list(req('src/routes/orgRoutes'), '/org'),
    ];
    for (const r of ['DELETE /campaigns/:id', 'GET /voice/history', 'DELETE /voice/history/:id', 'DELETE /voice/history', 'GET /voice/leads', 'POST /voice/queue', 'POST /voice/queue/cancel', 'POST /billing/verify-order', 'PATCH /org/profile']) {
      assert.ok(routes.includes(r), `missing ${r}`);
    }
  });
  await t('campaign validator accepts durationDays', () => {
    const v = req('src/validators/campaignValidators');
    const ok = v.launchCampaignSchema.safeParse({ body: { name: 'x', leadIds: ['a'.repeat(24)], channels: { whatsapp: true, email: false }, whatsappTemplateName: 't', dailyLimit: 100, durationDays: 5, startDate: '2099-01-01', sendTime: '10:00' } });
    assert.ok(ok.success, JSON.stringify(ok.error?.issues));
    assert.strictEqual(ok.data.body.durationDays, 5);
  });
  await t('send error explainer (backend) keeps working', () => {
    const { explainSendError } = req('src/utils/metaErrors');
    assert.ok(explainSendError('(#131042) Message failed to send because no payment method').message);
  });
  await t('voice: listening window covers the prompt; slow replies are acknowledged', async () => {
    const plivo = req('src/services/voice/plivoClient');
    const long = 'Hello Ravi, you booked a site visit to Omega with us on WhatsApp for tomorrow at 2 PM. I am calling to confirm, will you be able to come? Please say yes or no.';
    const xml = plivo.gatherXml({ actionUrl: 'https://x/a', noInputUrl: 'https://x/n', say: { text: long }, language: 'en' });
    const secs = Number(xml.match(/executionTimeout="(\d+)"/)[1]);
    assert.ok(secs >= 20 && secs <= 60, `executionTimeout ${secs}`);
    assert.match(xml, /hints="/);
    const agent = req('src/services/voice/voiceAgent');
    const tts = req('src/services/voice/tts');
    const CallLog = req('src/models/CallLog');
    const vs = req('src/services/voice/voiceService');
    const orig = { next: agent.nextTurn, syn: tts.synthesize, upd: CallLog.updateOne };
    tts.synthesize = async () => null;
    CallLog.updateOne = async () => ({});
    const mk = () => ({ _id: '0123456789abcdef01234567', context: { language: 'en' }, turns: [{ role: 'agent', text: 'hi' }], extracted: {}, markModified() {}, save: async () => {} });
    try {
      agent.nextTurn = async () => { await new Promise((r) => setTimeout(r, 1600)); return { say: 'See you on Sunday!', end_call: false, visit: 'unknown' }; };
      const log = mk();
      const started = Date.now();
      const hold = await vs.onTurn(log, { Speech: 'can we do Sunday' });
      assert.ok(Date.now() - started < 1400, 'acknowledgement must be quick');
      assert.match(hold, /<Redirect/); assert.match(hold, /\/reply\//);
      const reply = await vs.onReply(log);
      assert.match(reply, /See you on Sunday/); assert.match(reply, /GetInput/);
    } finally {
      agent.nextTurn = orig.next; tts.synthesize = orig.syn; CallLog.updateOne = orig.upd;
    }
  });
  await t('orgSummary flags (no DB parts)', () => {
    // profileDone: only explicit false forces the wizard
    const view = (o) => o.onboarding?.profileDone !== false;
    assert.strictEqual(view({}), true); assert.strictEqual(view({ onboarding: { profileDone: false } }), false);
  });

  // ---- HTTP: public endpoints (no DB needed) ----
  const app = req('src/app');
  const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  // Tiny supertest-like helper on top of fetch.
  const request = () => ({
    get: (url) => { const headers = {}; const p = { set(k, v) { headers[k] = v; return p; }, then(res, rej) { return fetch(base + url.replace(/^\/api/, ''), { headers }).then(async (r) => ({ status: r.status, body: await r.json() })).then(res, rej); }, async expect(code) { const r = await p; assert.strictEqual(r.status, code); return r; } }; return p; },
    post: (url) => ({ send: (body) => fetch(base + url.replace(/^\/api/, ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() })) }),
  });
  await t('GET /api/public/plans?country=AE', async () => {
    const r = await request(app).get('/api/public/plans?country=AE').expect(200);
    const d = r.body.data;
    assert.strictEqual(d.currency, 'AED');
    assert.deepStrictEqual(d.plans.map((p) => [p.code, p.monthly, p.setupFee]), [['starter', 249, 0], ['growth', 499, 0], ['builder', 999, 0], ['enterprise', null, 0]]);
    assert.strictEqual(d.plans[3].customPricing, true);
    assert.strictEqual(d.gstRate, 0);
    assert.ok(d.countries.length > 200);
    assert.ok(!JSON.stringify(d).match(/RAZORPAY|SECRET|KEY_/));
  });
  await t('GET /api/public/plans?country=FR → USD; ?currency=INR', async () => {
    assert.strictEqual((await request(app).get('/api/public/plans?country=FR')).body.data.currency, 'USD');
    const r = (await request(app).get('/api/public/plans?currency=INR')).body.data;
    assert.strictEqual(r.currency, 'INR'); assert.strictEqual(r.gstRate, 0.18); assert.strictEqual(r.plans[0].monthly, 3999);
    assert.strictEqual((await request(app).get('/api/public/plans')).body.data.currency, 'INR');
  });
  await t('GET /api/public/geo headers', async () => {
    assert.strictEqual((await request(app).get('/api/public/geo').set('CF-IPCountry', 'ae')).body.data.country, 'AE');
    assert.strictEqual((await request(app).get('/api/public/geo').set('x-vercel-ip-country', 'US')).body.data.country, 'US');
    assert.strictEqual((await request(app).get('/api/public/geo').set('CF-IPCountry', 'XX')).body.data.country, null);
    const r = await request(app).get('/api/public/geo');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.country, null);
  });
  await t('geo lookup provider + timeout never throws', async () => {
    const geo = req('src/services/geo/geoLookup');
    process.env.GEO_LOOKUP_URL = 'http://10.255.255.1/{ip}'; // unroutable → must time out / fail quietly
    const fakeReq = { get: () => undefined, ip: '8.8.8.8' };
    const t0 = Date.now(); const c = await geo.countryForRequest(fakeReq);
    assert.strictEqual(c, null); assert.ok(Date.now() - t0 < 2500, 'took too long');
    delete process.env.GEO_LOOKUP_URL;
  });
  await t('signup validation rejects missing phone (no DB)', async () => {
    const r = await request(app).post('/api/auth/signup').send({ email: 'x@y.com', password: 'Passw0rdX' });
    assert.strictEqual(r.status, 400);
  });
  server.close();
  console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
  process.exit(process.exitCode || 0);
})();
