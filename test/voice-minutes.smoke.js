/* eslint-disable no-console */
/**
 * AI calling plan access + minutes limit — smoke test, NO database
 * (an in-memory stand-in for the few Mongo operations used; see test/helpers/fakeMongo.js).
 *   node test/voice-minutes.smoke.js
 *
 * Covers: Starter has no AI calling (Growth / Builder / Enterprise do, trial does not);
 * placeCall is blocked at 0 minutes before anything is created; Enterprise without an
 * override is never blocked; plan minutes are used before the pack; pack minutes survive
 * a month rollover; concurrent finished calls never over-use a pack; the call time limit
 * is capped; add-on purchase is refused without the feature; queue / auto-call /
 * reminder ticks never fail or drop a customer when minutes are 0.
 */
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
process.env.SAAS_MODE = 'true';
process.env.GEMINI_API_KEY = 'test';
const R = (p) => require(path.join(ROOT, p));
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const { createFake } = R('test/helpers/fakeMongo');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.stack || e.message); process.exitCode = 1; }
};

const plans = R('src/config/plans');
const sub = R('src/services/saas/subscription');
const orgService = R('src/services/saas/orgService');
const tenantContext = R('src/context/tenantContext');
const Organization = R('src/models/Organization');
const Lead = R('src/models/Lead');
const CallLog = R('src/models/CallLog');
const Conversation = R('src/models/Conversation');
const Meeting = R('src/models/Meeting');
const Message = R('src/models/Message');
const Settings = R('src/models/Settings');
const Notification = R('src/models/Notification');
const platformVoice = R('src/config/voiceAgents');
const plivo = R('src/services/voice/plivoClient');
const callPolicy = R('src/services/voice/callPolicy');
const settingsService = R('src/services/settings/settingsService');
const visitConfirmation = R('src/services/visits/visitConfirmation');
const voice = R('src/services/voice/voiceService');

const month = orgService.currentMonthIST();
const grant = (quantity) => ({ key: 'voiceMinute', quantity, expiresAt: null });
const makeOrg = (over = {}) => ({ _id: 'org1', ownerUserId: 'owner1', plan: 'growth', status: 'active', country: 'IN', usage: { month, voiceMinutes: 0 }, addonGrants: [], voicePrepaidUsed: 0, limitOverrides: {}, featureOverrides: {}, ...over });

(async () => {
  console.log('Plan access');
  await t('Starter has no AI calling; Growth, Builder Pro, Enterprise do; trial does not', () => {
    const f = (c) => plans.PLANS[c].features;
    assert.strictEqual(f('starter').aiCalling, false);
    assert.strictEqual(f('growth').aiCalling, true);
    assert.strictEqual(f('builder').aiCalling, true);
    assert.strictEqual(f('enterprise').aiCalling, true);
    assert.strictEqual(f('trial').aiCalling, false);
    // Growth kept everything else it had.
    assert.ok(f('growth').emailCampaigns && f('growth').teamRouting && f('growth').metaBilling && f('growth').bulkWhatsapp && f('growth').autoFollowUps);
    assert.ok(f('builder').inventory && f('builder').weeklyReports);
  });
  await t('upgrade prompt for Starter / trial points to Growth', () => {
    assert.strictEqual(plans.cheapestPlanWith('aiCalling').code, 'growth');
    assert.strictEqual(sub.hasFeature({ plan: 'starter', status: 'active' }, 'aiCalling'), false);
    assert.strictEqual(sub.hasFeature({ plan: 'starter', status: 'active', featureOverrides: { aiCalling: true } }, 'aiCalling'), true);
    assert.throws(() => sub.assertFeature('aiCalling', { plan: 'starter', status: 'active' }), (e) => e.statusCode === 403 && e.details.requiredPlan === 'growth');
  });
  await t('buying the voiceMinute add-on is refused without AI calling', () => {
    const billing = R('src/services/saas/billingService');
    assert.throws(() => billing.addonQuote({ plan: 'starter', status: 'active', country: 'IN' }, 'voiceMinute', 100), (e) => e.statusCode === 403 && /AI calling is available on Growth and above/.test(e.message));
    assert.throws(() => billing.addonQuote({ plan: 'trial', status: 'trialing', country: 'IN' }, 'voiceMinute', 100), /Growth and above/);
    assert.strictEqual(billing.addonQuote({ plan: 'growth', status: 'active', country: 'IN' }, 'voiceMinute', 100).quantity, 100);
    // Team rules: Starter / Trial have no team, so the Extra-user add-on is not purchasable there (Growth and above still can).
    assert.throws(() => billing.addonQuote({ plan: 'starter', status: 'active', country: 'IN' }, 'extraUser', 1), /Growth and above/);
    assert.strictEqual(billing.addonQuote({ plan: 'growth', status: 'active', country: 'IN' }, 'extraUser', 1).quantity, 1);
    assert.strictEqual(billing.addonQuote({ plan: 'starter', status: 'active', country: 'IN' }, 'extraNumber', 1).quantity, 1); // other add-ons unchanged
  });

  console.log('Minutes maths');
  await t('voiceUsage: plan + pack, keys kept, overage is gone', () => {
    const u = sub.voiceUsage(makeOrg({ usage: { month, voiceMinutes: 10 }, addonGrants: [grant(100)], voicePrepaidUsed: 20 }));
    assert.deepStrictEqual([u.enabled, u.unlimited, u.includedMinutes, u.prepaidMinutes, u.usedMinutes], [true, false, 30, 100, 10]);
    assert.deepStrictEqual([u.planRemaining, u.packBalance, u.packPurchased, u.remainingIncluded, u.overageMinutes], [20, 80, 100, 100, 0]);
    for (const k of ['enabled', 'includedMinutes', 'prepaidMinutes', 'usedMinutes', 'remainingIncluded', 'overageMinutes']) assert.ok(k in u, k);
    // Used more than the plan gives → the rest came from the pack, nothing "overage".
    const v = sub.voiceUsage(makeOrg({ usage: { month, voiceMinutes: 45 }, addonGrants: [grant(100)], voicePrepaidUsed: 15 }));
    assert.deepStrictEqual([v.planRemaining, v.packBalance, v.remainingIncluded, v.overageMinutes], [0, 85, 85, 0]);
  });
  await t('unlimited: admin null limit, and Enterprise without a numeric override', () => {
    assert.strictEqual(sub.voiceUsage(makeOrg({ limitOverrides: { voiceMinutesIncluded: null } })).unlimited, true);
    assert.strictEqual(sub.voiceUsage(makeOrg({ plan: 'enterprise' })).unlimited, true);
    assert.strictEqual(sub.voiceUsage(makeOrg({ plan: 'enterprise', limitOverrides: { voiceMinutesIncluded: 500 } })).unlimited, false);
    assert.strictEqual(sub.voiceUsage(makeOrg({ plan: 'enterprise', limitOverrides: { voiceMinutesIncluded: 500 } })).remainingIncluded, 500);
    assert.strictEqual(sub.voiceMinutesExhausted(makeOrg({ plan: 'enterprise', usage: { month, voiceMinutes: 99999 } })), false);
    assert.strictEqual(sub.voiceMinutesExhausted(makeOrg({ usage: { month, voiceMinutes: 30 } })), true);
    assert.strictEqual(sub.voiceMinutesExhausted(makeOrg({ plan: 'starter', usage: { month, voiceMinutes: 30 } })), false); // no feature = "no calling", not "exhausted"
    assert.strictEqual(sub.voiceCallingAvailable(makeOrg({ plan: 'starter' })), false);
    assert.strictEqual(sub.voiceCallingAvailable(makeOrg({ usage: { month, voiceMinutes: 29 } })), true);
    assert.strictEqual(sub.voiceCallingAvailable(undefined), true); // legacy single-client mode
  });
  await t('call time limit is capped by the minutes left', () => {
    assert.strictEqual(voice.callTimeLimit(300, 2), 120);
    assert.strictEqual(voice.callTimeLimit(600, 100), 600);
    assert.strictEqual(voice.callTimeLimit(300, 1), 60);
    assert.strictEqual(voice.callTimeLimit(300, Infinity), 300);
  });

  console.log('Billing a finished call');
  const orgs = createFake();
  orgs.install(Organization);
  const seedOrg = (over) => { orgs.docs.length = 0; return orgs.seed(makeOrg(over)); };
  const orgNow = async () => (await Organization.findById('org1')).valueOf ? Organization.findById('org1') : null;
  const get = async () => Organization.findById('org1');

  await t('plan minutes are used before the pack', async () => {
    seedOrg({ usage: { month, voiceMinutes: 25 }, addonGrants: [grant(100)] });
    const r = await orgService.consumeVoiceMinutes('org1', 3); // plan has 5 left
    assert.deepStrictEqual([r.fromPlan, r.fromPack], [3, 0]);
    let o = await get();
    assert.deepStrictEqual([o.usage.voiceMinutes, o.voicePrepaidUsed || 0], [28, 0]);
    const r2 = await orgService.consumeVoiceMinutes('org1', 5); // 2 from plan, 3 from the pack
    assert.deepStrictEqual([r2.fromPlan, r2.fromPack], [2, 3]);
    o = await get();
    assert.deepStrictEqual([o.usage.voiceMinutes, o.voicePrepaidUsed], [33, 3]); // usage still counts the FULL minutes
    const u = sub.voiceUsage(o);
    assert.deepStrictEqual([u.planRemaining, u.packBalance, u.remainingIncluded], [0, 97, 97]);
  });
  await t('pack minutes persist across the month rollover (no monthly refill)', async () => {
    // Last month: plan used up and 40 minutes taken from a 100-minute pack.
    seedOrg({ usage: { month: '2020-01', voiceMinutes: 70 }, addonGrants: [grant(100)], voicePrepaidUsed: 40 });
    const before = sub.voiceUsage(await get());
    assert.deepStrictEqual([before.usedMinutes, before.planRemaining, before.packBalance], [0, 30, 60]); // new month: plan refilled, pack did NOT
    await orgService.consumeVoiceMinutes('org1', 30 + 10); // whole plan + 10 from the pack
    const o = await get();
    assert.strictEqual(o.usage.month, month);
    assert.deepStrictEqual([o.usage.voiceMinutes, o.voicePrepaidUsed], [40, 50]);
    assert.strictEqual(sub.voiceUsage(o).packBalance, 50);
  });
  await t('a pack is never over-used, even with many calls ending at once', async () => {
    seedOrg({ usage: { month, voiceMinutes: 30 }, addonGrants: [grant(10)] }); // plan finished, 10 in the pack
    await Promise.all(Array.from({ length: 8 }, () => orgService.consumeVoiceMinutes('org1', 2)));
    const o = await get();
    assert.strictEqual(o.usage.voiceMinutes, 46); // reports see every minute
    assert.strictEqual(o.voicePrepaidUsed, 10); // pack capped at what was bought
    assert.strictEqual(sub.voiceUsage(o).remainingIncluded, 0);
  });
  await t('unlimited companies are billed to the report only, packs untouched', async () => {
    seedOrg({ plan: 'enterprise', addonGrants: [grant(50)] });
    const r = await orgService.consumeVoiceMinutes('org1', 7);
    assert.deepStrictEqual([r.fromPlan, r.fromPack], [7, 0]);
    assert.strictEqual((await get()).voicePrepaidUsed || 0, 0);
  });

  console.log('placeCall');
  const calls = { plivo: 0, callLogs: 0 };
  platformVoice.missing = () => ['TEST_ENV'];
  plivo.makeCall = async () => { calls.plivo += 1; return { requestUuid: 'u' }; };
  CallLog.create = async () => { calls.callLogs += 1; return { _id: 'cl1' }; };
  const lead = { _id: 'L1', ownerId: 'owner1', name: 'Ravi', phone: '919800000000' };
  const place = (org, l = lead, opts) => tenantContext.run(org, () => voice.placeCall(l, opts));

  await t('blocked at 0 minutes: VOICE_MINUTES_EXHAUSTED, nothing created, Plivo untouched', async () => {
    const o = seedOrg({ usage: { month, voiceMinutes: 30 } });
    await assert.rejects(place({ ...o }), (e) => e.statusCode === 403 && e.details.code === 'VOICE_MINUTES_EXHAUSTED' && e.message === 'AI calling minutes finished. Recharge to continue.');
    assert.deepStrictEqual([calls.plivo, calls.callLogs], [0, 0]);
  });
  await t('the check uses LIVE usage, not a stale cached snapshot', async () => {
    const o = seedOrg({ usage: { month, voiceMinutes: 30 } });
    const stale = { ...o, usage: { month, voiceMinutes: 0 } }; // cache says 30 left
    await assert.rejects(place(stale), (e) => e.details?.code === 'VOICE_MINUTES_EXHAUSTED');
  });
  await t('a recharge makes calls possible again; Growth with minutes passes the check', async () => {
    const o = seedOrg({ usage: { month, voiceMinutes: 30 }, addonGrants: [grant(100)] });
    await assert.rejects(place({ ...o }), (e) => e.details?.code !== 'VOICE_MINUTES_EXHAUSTED' && /not set up/.test(e.message)); // got past the minutes check
    seedOrg({ usage: { month, voiceMinutes: 10 } });
    await assert.rejects(place({ ...o }), /not set up/);
  });
  await t('Enterprise without an override is not blocked', async () => {
    const o = seedOrg({ plan: 'enterprise', usage: { month, voiceMinutes: 500000 } });
    await assert.rejects(place({ ...o }), (e) => e.details?.code !== 'VOICE_MINUTES_EXHAUSTED' && /not set up/.test(e.message));
    const o2 = seedOrg({ plan: 'enterprise', limitOverrides: { voiceMinutesIncluded: 100 }, usage: { month, voiceMinutes: 100 } });
    await assert.rejects(place({ ...o2 }), (e) => e.details?.code === 'VOICE_MINUTES_EXHAUSTED');
  });
  await t('Starter (no feature) still gets the plan-limit prompt, not a minutes message', async () => {
    const o = seedOrg({ plan: 'starter' });
    await assert.rejects(place({ ...o }), (e) => e.details?.code === 'PLAN_LIMIT' && e.details.requiredPlan === 'growth');
  });
  await t('friendly error text for the exhausted case', () => {
    assert.match(callPolicy.friendlyCallError({ error: 'AI calling minutes finished. Recharge to continue.' }), /minutes finished/);
  });

  console.log('Callers when minutes are 0');
  platformVoice.isConfigured = () => true;
  callPolicy.regionEnabled = () => true;
  callPolicy.inHours = () => true;
  settingsService.getOrCreateSettings = async () => ({ visitConfirm: {}, calling: {} });
  const leadFake = createFake();
  const updates = [];
  const realLeadUpdate = (q, u) => { updates.push({ q, u }); return { modifiedCount: 1 }; };

  await t('bulk queue: org with no minutes is skipped, queued leads stay queued', async () => {
    const o = seedOrg({ usage: { month, voiceMinutes: 30 } });
    updates.length = 0;
    let claimed = 0;
    Lead.distinct = async () => ['owner1'];
    Lead.updateMany = async (q, u) => { updates.push({ q, u }); return {}; };
    Lead.findOneAndUpdate = async () => { claimed += 1; return null; };
    Lead.countDocuments = async () => 0;
    Lead.updateOne = async (q, u) => realLeadUpdate(q, u);
    orgService.runForOwner = (id, fn) => tenantContext.run({ ...o }, fn);
    await voice.bulkCallTick();
    assert.strictEqual(claimed, 0, 'no lead was even claimed');
    assert.ok(!updates.some((x) => JSON.stringify(x.u).includes('"failed"') || JSON.stringify(x.u).includes('"cancelled"')), 'nothing marked failed');
  });
  await t('bulk queue: minutes run out between the check and the call → lead goes back to queued, tick stops', async () => {
    const o = seedOrg({ usage: { month, voiceMinutes: 29 } }); // 1 minute left at the tick-level check
    updates.length = 0;
    const picked = { _id: 'L9', ownerId: 'owner1', phone: '919800000009', name: 'X', optedOut: false };
    let claims = 0;
    Lead.distinct = async () => ['owner1'];
    Lead.updateMany = async () => ({});
    Lead.countDocuments = async () => 0;
    Lead.findOneAndUpdate = async () => { claims += 1; orgs.docs[0].usage.voiceMinutes = 30; return picked; }; // someone used the last minute
    Lead.updateOne = async (q, u) => realLeadUpdate(q, u);
    Conversation.exists = async () => false;
    process.env.VOICE_BULK_CONCURRENCY = '1';
    orgService.runForOwner = (id, fn) => tenantContext.run({ ...o }, fn);
    await voice.bulkCallTick();
    assert.strictEqual(claims, 1);
    const back = updates.find((x) => x.u.$set && x.u.$set['aiCall.status'] === 'queued');
    assert.ok(back && back.u.$inc['aiCall.calls'] === -1, 'lead put back in the queue');
    assert.ok(!updates.some((x) => x.u.$set && x.u.$set['aiCall.status'] === 'failed'), 'not failed');
  });
  await t('auto-call new leads: org without minutes is skipped before any lead is touched', async () => {
    seedOrg({ usage: { month, voiceMinutes: 30 } });
    let leadQueries = 0;
    Organization.find = () => ({ select: () => ({ lean: async () => [{ ...orgs.docs[0], voice: { enabled: true, autoCallNewLeads: true, autoCallAfterMinutes: 30 } }] }) });
    Lead.find = () => { leadQueries += 1; return { limit: () => ({ lean: async () => [] }) }; };
    await voice.autoCallTick();
    assert.strictEqual(leadQueries, 0);
  });
  await t('auto-call new leads: minutes run out mid-tick → lead NOT marked failed, no more leads tried', async () => {
    const o = seedOrg({ usage: { month, voiceMinutes: 29 } });
    updates.length = 0;
    const l1 = { _id: 'A1', ownerId: 'owner1', phone: '919800000001', source: 'meta_ads' };
    const l2 = { _id: 'A2', ownerId: 'owner1', phone: '919800000002', source: 'meta_ads' };
    Organization.find = () => ({ select: () => ({ lean: async () => [{ ...orgs.docs[0], voice: { enabled: true, autoCallNewLeads: true, autoCallAfterMinutes: 30 } }] }) });
    Lead.find = () => ({ limit: () => ({ lean: async () => { orgs.docs[0].usage.voiceMinutes = 30; return [l1, l2]; } }) }); // minutes finish after the org check
    CallLog.exists = async () => false;
    Message.exists = async () => false;
    Lead.updateOne = async (q, u) => realLeadUpdate(q, u);
    orgService.runForOrg = (id, fn) => tenantContext.run({ ...o }, fn);
    await voice.autoCallTick();
    assert.ok(!updates.some((x) => x.u.$set && x.u.$set['aiCall.status'] === 'failed'), 'leads not failed');
    assert.strictEqual(calls.plivo, 0);
  });
  await t('visit-day reminder: no minutes → WhatsApp reminder is sent instead, nothing breaks or loops', async () => {
    const realNow = Date.now;
    const FIXED = Date.parse('2026-11-25T06:30:00Z'); // 12:00 IST
    Date.now = () => FIXED;
    try {
      const o = seedOrg({ usage: { month, voiceMinutes: 30 } });
      const meeting = { _id: 'M1', ownerId: 'owner1', leadId: 'L1', preferredDate: '2026-11-25', preferredTime: '17:00', status: 'scheduled', confirmation: { status: 'confirmed', reminderCallAt: null } };
      const fallback = [];
      Settings.find = () => ({ select: () => ({ lean: async () => [{ orgId: 'org1', visitConfirm: { callStartHour: 0, callEndHour: 24 } }] }) });
      Meeting.find = () => ({ populate: () => ({ limit: async () => [meeting] }) });
      Meeting.updateOne = async () => ({ modifiedCount: 1 });
      Lead.findById = async () => ({ _id: 'L1', phone: '919800000001', optedOut: false });
      orgService.runForOrg = (id, fn) => tenantContext.run({ ...o }, fn);
      visitConfirmation.afterCallOutcome = async (m, l, outcome) => { fallback.push(outcome); };
      await voice.reminderCallTick();
      assert.deepStrictEqual(fallback, ['confirmed']);
    } finally { Date.now = realNow; }
  });
  await t('manual call / queue endpoints return the exhausted message as-is', async () => {
    const o = seedOrg({ usage: { month, voiceMinutes: 30 } });
    const ctrl = R('src/controllers/voiceController');
    const errors = [];
    Lead.findOne = async () => ({ _id: 'L1', name: 'Ravi', phone: '919800000001' });
    await ctrl.callLead({ params: { leadId: 'L1' }, user: { id: 'owner1', actorId: 'a' }, org: o }, { status() { return this; }, json() {} }, (e) => errors.push(e));
    await ctrl.queueLeads({ body: { leadIds: ['a'.repeat(24)] }, user: { id: 'owner1', actorId: 'a' }, org: o, ip: '1' }, { status() { return this; }, json() {} }, (e) => errors.push(e));
    assert.strictEqual(errors.length, 2);
    errors.forEach((e) => assert.ok(e.details?.code === 'VOICE_MINUTES_EXHAUSTED' && e.message === 'AI calling minutes finished. Recharge to continue.'));
  });

  console.log('Master switch (AI calling → Controls → stop all)');
  await t('paused: manual calls refused, queue / auto-call skip the company, bot stops promising calls', async () => {
    const o = seedOrg({ voice: { paused: true } });
    await assert.rejects(place({ ...o }), (e) => e.statusCode === 403 && e.details.code === 'VOICE_PAUSED');
    assert.strictEqual(sub.voiceCallingAvailable({ ...o }), false);
    assert.strictEqual(sub.voiceCallingAvailable(makeOrg({ voice: { paused: false } })), true);
    // the live flag wins over a stale cached snapshot
    const stale = { ...o, voice: { paused: false, script: 'keep me' } };
    await assert.rejects(place(stale), (e) => e.details?.code === 'VOICE_PAUSED');
    // queue tick: nothing claimed
    let claimed = 0;
    Lead.distinct = async () => ['owner1'];
    Lead.updateMany = async () => ({});
    Lead.countDocuments = async () => 0;
    Lead.findOneAndUpdate = async () => { claimed += 1; return null; };
    orgService.runForOwner = (id, fn) => tenantContext.run({ ...o }, fn);
    await voice.bulkCallTick();
    assert.strictEqual(claimed, 0);
    // auto-call tick: no lead query at all
    let leadQueries = 0;
    Organization.find = () => ({ select: () => ({ lean: async () => [{ ...orgs.docs[0], voice: { enabled: true, autoCallNewLeads: true, paused: true } }] }) });
    Lead.find = () => { leadQueries += 1; return { limit: () => ({ lean: async () => [] }) }; };
    await voice.autoCallTick();
    assert.strictEqual(leadQueries, 0);
  });
  await t('settings: paused is saved from the settings endpoint and returned', async () => {
    const o = seedOrg({});
    const ctrl = R('src/controllers/voiceController');
    const calls2 = [];
    Organization.updateOne = async (q, u) => { calls2.push(u); return orgs.updateOne(q, u); };
    const out = [];
    await ctrl.updateSettings({ body: { paused: true }, org: o, user: { id: 'owner1' } }, { status() { return this; }, json(b) { out.push(b); } }, (e) => out.push(e));
    assert.deepStrictEqual(calls2[0].$set, { 'voice.paused': true });
    assert.strictEqual(out[0].data.voice.paused, true);
    assert.strictEqual(out[0].data.voice.overageCost, 0);
    assert.strictEqual(out[0].data.voice.costThisMonth, 0);
    assert.strictEqual(out[0].data.voice.minutesFinished, false);
  });

  console.log('WhatsApp bot promise');
  await t('the bot only promises a call when AI calling is on the plan and minutes are left', () => {
    assert.strictEqual(sub.voiceCallingAvailable(makeOrg({ plan: 'starter' })), false);
    assert.strictEqual(sub.voiceCallingAvailable(makeOrg({ usage: { month, voiceMinutes: 30 } })), false);
    assert.strictEqual(sub.voiceCallingAvailable(makeOrg({ usage: { month, voiceMinutes: 5 } })), true);
    assert.strictEqual(sub.voiceCallingAvailable(makeOrg({ plan: 'enterprise' })), true);
  });

  console.log('Owner alerts');
  await t('80% and 0-left alerts: once per month, never throw', async () => {
    const alerts = R('src/services/voice/voiceAlerts');
    const made = [];
    Notification.create = async (n) => { made.push(n); return n; };
    seedOrg({ usage: { month, voiceMinutes: 23 } });
    await alerts.afterBilling('org1'); // 23/30 = 76% → nothing
    assert.strictEqual(made.length, 0);
    orgs.docs[0].usage.voiceMinutes = 24;
    await alerts.afterBilling('org1');
    await alerts.afterBilling('org1'); // second time: same month → not again
    assert.deepStrictEqual(made.map((n) => n.type), ['voice_minutes_low']);
    orgs.docs[0].usage.voiceMinutes = 30;
    await alerts.afterBilling('org1');
    await alerts.afterBilling('org1');
    assert.deepStrictEqual(made.map((n) => n.type), ['voice_minutes_low', 'voice_minutes_finished']);
    assert.strictEqual(made[0].link, '/billing');
    Notification.create = async () => { throw new Error('db down'); };
    orgs.docs[0].voiceAlerts = {};
    await alerts.afterBilling('org1'); // must not throw
    await alerts.afterBilling('missing-org');
  });

  console.log(`\n${pass} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
  process.exit(process.exitCode || 0);
})();
