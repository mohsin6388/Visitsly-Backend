/* eslint-disable no-console */
/**
 * Billing guard / offers / coupons smoke test — NO database, NO network
 * (in-memory models from test/helpers/fakeMongo.js, Razorpay HTTP stubbed).
 *   npm run test:billing
 *
 * Covers: coupon + offer maths (discount BEFORE tax, same rounding as pricing.js),
 * server-side coupon validation (every error), the Razorpay amount == quote == invoice,
 * redemption counted only after payment (once), "no plan switching while a plan is active",
 * renewal still allowed, nothing created/pending before "Pay now", stale pendingPlan can't
 * activate a plan, dismissed checkouts clear the pending plan.
 */
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
process.env.SAAS_MODE = 'true';
const R = (p) => require(path.join(ROOT, p));
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

// Stub Razorpay (axios instance created inside billingService) BEFORE it loads.
const axios = require('axios');
const rzpCalls = [];
const realCreate = axios.create.bind(axios);
axios.create = (...a) => {
  const inst = realCreate(...a);
  inst.post = async (url, body) => {
    rzpCalls.push({ url, body });
    if (url === '/orders') return { data: { id: `order_${rzpCalls.length}`, amount: body.amount, currency: body.currency } };
    if (url === '/plans') return { data: { id: `plan_${rzpCalls.length}` } };
    if (url === '/subscriptions') return { data: { id: `sub_${rzpCalls.length}` } };
    return { data: {} };
  };
  return inst;
};

const { createFake } = R('test/helpers/fakeMongo');
const Organization = R('src/models/Organization');
const Invoice = R('src/models/Invoice');
const Coupon = R('src/models/Coupon');
const CouponRedemption = R('src/models/CouponRedemption');
const PlanOffer = R('src/models/PlanOffer');
const RazorpayPlan = R('src/models/RazorpayPlan');
const orgs = createFake();
const invoices = createFake({ defaults: () => ({ status: 'paid', emailAttempts: 0 }) });
const coupons = createFake();
const redemptions = createFake();
const offers = createFake();
const rzpPlans = createFake();
const counters = createFake();
const Counter = R('src/models/Counter');
counters.install(Counter);
orgs.install(Organization); invoices.install(Invoice); coupons.install(Coupon);
redemptions.install(CouponRedemption); offers.install(PlanOffer); rzpPlans.install(RazorpayPlan);
// activate() loads the org as a document and calls save().
const plainFindById = orgs.findById;
Organization.findById = (id) => {
  const lean = () => plainFindById(id);
  return {
    lean,
    select() { return this; },
    then(res, rej) {
      return plainFindById(id).then((d) => {
        if (!d) return d;
        d.save = async () => {
          const target = orgs.docs.find((x) => String(x._id) === String(id));
          Object.keys(target).forEach((k) => delete target[k]);
          const { save, ...rest } = d; // eslint-disable-line no-unused-vars
          Object.assign(target, JSON.parse(JSON.stringify(rest)));
        };
        return d;
      }).then(res, rej);
    },
  };
};

const env = R('src/config/env');
env.razorpay.keyId = 'rzp_test_key';
env.razorpay.keySecret = 'secret';
const billing = R('src/services/saas/billingService');
const pricing = R('src/config/pricing');
const pricingService = R('src/services/billing/pricingService');

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.stack || e.message); process.exitCode = 1; } };
const reset = () => { [orgs, invoices, coupons, redemptions, offers, rzpPlans, counters].forEach((f) => { f.docs.length = 0; }); rzpCalls.length = 0; delete process.env.RAZORPAY_PAYMENT_MODE; };
const day = 86400000;
const seedOrg = (over = {}) => orgs.seed({ _id: 'orgA', name: 'ABC', country: 'IN', currency: 'INR', plan: 'trial', status: 'trialing', billingCycle: 'monthly', billingEmail: 'o@abc.in', ownerUserId: 'uA', razorpay: {}, addonGrants: [], ...over });
const seedCoupon = (over = {}) => coupons.seed({ _id: `c${Math.random().toString(36).slice(2, 8)}`, code: 'SAVE10', type: 'percent', value: 10, currency: null, active: true, perOrgLimit: 1, maxRedemptions: null, redemptionCount: 0, applicablePlans: [], applicableCycles: [], appliesTo: 'first', ...over });
const rejects = (p, code) => assert.rejects(p, (e) => (code ? e.details?.code === code : true) && e.statusCode === 400, `expected ${code}`);
const orgOf = (id = 'orgA') => orgs.docs.find((d) => d._id === id);
const hook = (event) => billing.handleWebhook(event);

(async () => {
  console.log('Quote maths (discount before tax)');
  await t('no offer / coupon: unchanged legacy numbers', () => {
    const q = billing.quote({ country: 'IN', currency: 'INR' }, 'growth', 'monthly');
    assert.strictEqual(q.price, 7999); assert.strictEqual(q.priceWithTax, 9439); assert.strictEqual(q.total, 9439);
    assert.strictEqual(q.offer, null); assert.strictEqual(q.coupon, null); assert.strictEqual(q.couponDiscount, 0);
    assert.strictEqual(q.subtotal + q.taxAmount, q.total);
  });
  await t('10% coupon: 7999 − 800 = 7199, GST on the discounted price → 8495', () => {
    const q = billing.quote({ currency: 'INR' }, 'growth', 'monthly', undefined, { coupon: { code: 'SAVE10', type: 'percent', value: 10 } });
    assert.deepStrictEqual([q.couponDiscount, q.subtotal, q.total, q.taxAmount], [800, 7199, pricing.withTax(7199, 'INR'), pricing.withTax(7199, 'INR') - 7199]);
    assert.strictEqual(q.total, 8495);
  });
  await t('flat coupon never goes below zero; 2-decimal currencies keep 2 decimals', () => {
    const q = billing.quote({ currency: 'AED' }, 'growth', 'monthly', undefined, { coupon: { code: 'X', type: 'percent', value: 10 } });
    assert.deepStrictEqual([q.price, q.couponDiscount, q.subtotal, q.total, q.taxAmount], [499, 49.9, 449.1, 449.1, 0]);
    assert.strictEqual(pricingService.couponDiscount({ type: 'flat', value: 99999 }, 100, 'INR'), 100);
  });
  await t('a 100% coupon (total 0) is rejected', () => {
    assert.throws(() => billing.quote({ currency: 'INR' }, 'growth', 'monthly', undefined, { coupon: { code: 'FREE', type: 'percent', value: 100 } }), (e) => e.details?.code === 'COUPON_INVALID');
  });
  await t('offer: was ₹7,999 → now ₹5,999 (25% off); total uses the offer price', () => {
    const offer = { listPrice: 7999, offerPrice: 5999, percentOff: 25, label: 'Diwali' };
    const q = billing.quote({ currency: 'INR' }, 'growth', 'monthly', undefined, { offer });
    assert.deepStrictEqual([q.listPrice, q.price, q.offer.percentOff, q.total], [7999, 5999, 25, pricing.withTax(5999, 'INR')]);
    const both = billing.quote({ currency: 'INR' }, 'growth', 'monthly', undefined, { offer, coupon: { code: 'SAVE10', type: 'percent', value: 10 } });
    assert.deepStrictEqual([both.couponDiscount, both.subtotal], [600, 5399]); // coupon on the OFFER price
  });
  await t("a company's custom price (priceOverride) wins over an offer", () => {
    const q = billing.quote({ currency: 'INR', plan: 'growth', priceOverride: 6500 }, 'growth', 'monthly', undefined, { offer: { listPrice: 7999, offerPrice: 5999, percentOff: 25 } });
    assert.strictEqual(q.price, 6500); assert.strictEqual(q.offer, null);
  });

  console.log('Offers (admin-set)');
  await t('active offer is picked up; expired / inactive / not-lower offers are ignored', async () => {
    reset();
    offers.seed({ plan: 'growth', cycle: 'monthly', currency: 'INR', offerPrice: 5999, active: true, label: 'Launch', validUntil: new Date(Date.now() + day) });
    offers.seed({ plan: 'starter', cycle: 'monthly', currency: 'INR', offerPrice: 2999, active: true, validUntil: new Date(Date.now() - day) });
    offers.seed({ plan: 'builder', cycle: 'monthly', currency: 'INR', offerPrice: 99999, active: true }); // higher than list
    offers.seed({ plan: 'builder', cycle: 'annual', currency: 'INR', offerPrice: 100, active: false });
    const by = await pricingService.offersByPlan('INR');
    assert.deepStrictEqual(Object.keys(by), ['growth']);
    assert.strictEqual(by.growth.monthly.percentOff, 25);
    const { quote } = await billing.quoteFor({ _id: 'orgA', currency: 'INR' }, 'growth', 'monthly');
    assert.strictEqual(quote.price, 5999); assert.strictEqual(quote.listPrice, 7999);
  });

  console.log('Coupon validation (server side)');
  await t('every failure has its own clear message / code', async () => {
    reset(); seedOrg();
    const ctx = { orgId: 'orgA', plan: 'growth', cycle: 'monthly', currency: 'INR' };
    await rejects(pricingService.validateCoupon('', ctx), 'COUPON_INVALID');
    await rejects(pricingService.validateCoupon('NOPE', ctx), 'COUPON_INVALID');
    seedCoupon({ code: 'OFF', active: false });
    await rejects(pricingService.validateCoupon('off', ctx), 'COUPON_INVALID');
    seedCoupon({ code: 'OLD', validUntil: new Date(Date.now() - day) });
    await rejects(pricingService.validateCoupon('OLD', ctx), 'COUPON_EXPIRED');
    seedCoupon({ code: 'SOON', validFrom: new Date(Date.now() + day) });
    await rejects(pricingService.validateCoupon('SOON', ctx), 'COUPON_NOT_STARTED');
    seedCoupon({ code: 'ONLYSTARTER', applicablePlans: ['starter'] });
    await rejects(pricingService.validateCoupon('ONLYSTARTER', ctx), 'COUPON_NOT_FOR_PLAN');
    seedCoupon({ code: 'YEARLY', applicableCycles: ['annual'] });
    await rejects(pricingService.validateCoupon('YEARLY', ctx), 'COUPON_NOT_FOR_CYCLE');
    seedCoupon({ code: 'AEDONLY', type: 'flat', value: 50, currency: 'AED' });
    await rejects(pricingService.validateCoupon('AEDONLY', ctx), 'COUPON_NOT_FOR_CURRENCY');
    seedCoupon({ code: 'FULL', maxRedemptions: 2, redemptionCount: 2 });
    await rejects(pricingService.validateCoupon('FULL', ctx), 'COUPON_EXHAUSTED');
    const used = seedCoupon({ code: 'USED' });
    redemptions.seed({ couponId: used._id, orgId: 'orgA', ref: 'order_old' });
    await rejects(pricingService.validateCoupon('USED', ctx), 'COUPON_USED');
    const ok = await pricingService.validateCoupon(' save 10 ', { ...ctx, orgId: 'orgB' }).catch(() => null);
    assert.strictEqual(ok, null); // "SAVE10" doesn't exist in this run
    seedCoupon({ code: 'SAVE10' });
    assert.strictEqual((await pricingService.validateCoupon(' save10 ', ctx)).code, 'SAVE10'); // case / spaces forgiven
  });
  await t('validating a coupon / asking for a quote creates nothing and sets no pendingPlan', async () => {
    reset(); seedOrg(); seedCoupon();
    await billing.quoteFor(orgOf(), 'growth', 'monthly', { couponCode: 'SAVE10' });
    assert.strictEqual(rzpCalls.length, 0);
    assert.strictEqual(invoices.docs.length, 0);
    assert.ok(!orgOf().pendingPlan && !orgOf().razorpay.pendingSubscriptionId);
    assert.strictEqual(redemptions.docs.length, 0);
  });

  console.log('Checkout: Razorpay amount == quote == invoice; redemption only after payment');
  await t('order mode + coupon: amounts match, redemption counted once after payment (webhook + verify + replay)', async () => {
    reset(); seedOrg(); const c = seedCoupon(); process.env.RAZORPAY_PAYMENT_MODE = 'order';
    const out = await billing.createCheckout('orgA', { plan: 'growth', cycle: 'monthly', coupon: 'save10' }, { name: 'O' });
    assert.strictEqual(out.mode, 'order');
    const orderCall = rzpCalls.find((x) => x.url === '/orders');
    assert.strictEqual(orderCall.body.amount, 849500);
    assert.strictEqual(out.amount, 849500); assert.strictEqual(out.quote.total, 8495);
    const inv = invoices.docs[0];
    assert.deepStrictEqual([inv.amount, inv.subtotal, inv.taxAmount, inv.taxRate, inv.status], [8495, 7199, 1296, 0.18, 'pending']);
    assert.strictEqual(inv.subtotal + inv.taxAmount, inv.amount);
    assert.deepStrictEqual([inv.pricing.couponCode, inv.pricing.couponDiscount, inv.pricing.listSubtotal], ['SAVE10', 800, 7999]);
    assert.strictEqual(redemptions.docs.length, 0, 'not counted before payment');
    assert.strictEqual(coupons.docs.find((d) => d._id === c._id).redemptionCount, 0);
    assert.strictEqual(orgOf().plan, 'trial', 'plan unchanged until payment');
    // payment succeeds: webhook, the browser verify, and a replay
    const event = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: out.orderId } } } };
    await Promise.all([hook(event), hook(event)]);
    const sig = crypto.createHmac('sha256', 'secret').update(`${out.orderId}|pay_1`).digest('hex');
    await billing.verifyPlanOrder('orgA', { razorpay_order_id: out.orderId, razorpay_payment_id: 'pay_1', razorpay_signature: sig });
    assert.strictEqual(redemptions.docs.length, 1, 'counted exactly once');
    assert.strictEqual(coupons.docs.find((d) => d._id === c._id).redemptionCount, 1);
    assert.deepStrictEqual([orgOf().plan, orgOf().status], ['growth', 'active']);
    assert.strictEqual(invoices.docs[0].status, 'paid');
    // the same company cannot use the same coupon again (perOrgLimit 1)
    await rejects(pricingService.validateCoupon('SAVE10', { orgId: 'orgA', plan: 'growth', cycle: 'monthly', currency: 'INR' }), 'COUPON_USED');
  });
  await t('client cannot dictate the amount: a bad coupon is refused, nothing is created', async () => {
    reset(); seedOrg(); process.env.RAZORPAY_PAYMENT_MODE = 'order';
    await rejects(billing.createCheckout('orgA', { plan: 'growth', cycle: 'monthly', coupon: 'FAKE' }, {}), 'COUPON_INVALID');
    assert.strictEqual(rzpCalls.length, 0); assert.strictEqual(invoices.docs.length, 0); assert.ok(!orgOf().pendingPlan);
  });
  await t('subscription mode: "first payment only" coupon → one-time order; "all" coupon → discounted Razorpay plan', async () => {
    reset(); seedOrg(); seedCoupon({ code: 'FIRST' }); seedCoupon({ code: 'ALWAYS', appliesTo: 'all' });
    const first = await billing.createCheckout('orgA', { plan: 'growth', cycle: 'monthly', coupon: 'FIRST' }, {});
    assert.strictEqual(first.mode, 'order');
    assert.ok(!rzpCalls.some((x) => x.url === '/subscriptions'));
    reset(); seedOrg(); seedCoupon({ code: 'ALWAYS', appliesTo: 'all' });
    const all = await billing.createCheckout('orgA', { plan: 'growth', cycle: 'monthly', coupon: 'ALWAYS' }, {});
    assert.strictEqual(all.mode, 'subscription');
    assert.strictEqual(rzpCalls.find((x) => x.url === '/plans').body.item.amount, 849500, 'plan amount = discounted price + GST');
    assert.strictEqual(orgOf().pendingPlan, 'growth');
    assert.strictEqual(orgOf().pendingCheckout.quote.coupon.code, 'ALWAYS');
    // verify with a correct signature → invoice carries the discounted amounts, coupon counted now
    const sig = crypto.createHmac('sha256', 'secret').update(`pay_9|${all.subscriptionId}`).digest('hex');
    await billing.verifyCheckout('orgA', { razorpay_payment_id: 'pay_9', razorpay_subscription_id: all.subscriptionId, razorpay_signature: sig });
    const inv = invoices.docs.find((d) => d.razorpayPaymentId === 'pay_9');
    assert.deepStrictEqual([inv.amount, inv.subtotal, inv.pricing.couponDiscount], [8495, 7199, 800]);
    assert.strictEqual(redemptions.docs.length, 1);
    assert.deepStrictEqual([orgOf().plan, orgOf().pendingPlan, orgOf().pendingCheckout], ['growth', null, null]);
  });
  await t('offer price is what Razorpay charges', async () => {
    reset(); seedOrg(); process.env.RAZORPAY_PAYMENT_MODE = 'order';
    offers.seed({ plan: 'growth', cycle: 'monthly', currency: 'INR', offerPrice: 5999, active: true });
    const out = await billing.createCheckout('orgA', { plan: 'growth', cycle: 'monthly' }, {});
    assert.strictEqual(out.amount, pricing.toMinor(pricing.withTax(5999, 'INR'), 'INR'));
    assert.strictEqual(invoices.docs[0].pricing.offerDiscount, 2000);
  });

  console.log('No plan switching while a plan is active');
  const active = (over = {}) => seedOrg({ plan: 'growth', status: 'active', billingCycle: 'monthly', currentPeriodEnd: new Date(Date.now() + 10 * day), razorpay: { mode: 'order' }, ...over });
  await t('active + live period: a different plan or cycle is refused (PLAN_ALREADY_ACTIVE), nothing created', async () => {
    reset(); active(); process.env.RAZORPAY_PAYMENT_MODE = 'order';
    await rejects(billing.createCheckout('orgA', { plan: 'builder', cycle: 'monthly' }, {}), 'PLAN_ALREADY_ACTIVE');
    await rejects(billing.createCheckout('orgA', { plan: 'starter', cycle: 'monthly' }, {}), 'PLAN_ALREADY_ACTIVE');
    await rejects(billing.createCheckout('orgA', { plan: 'growth', cycle: 'annual' }, {}), 'PLAN_ALREADY_ACTIVE');
    assert.strictEqual(rzpCalls.length, 0); assert.strictEqual(invoices.docs.length, 0); assert.ok(!orgOf().pendingPlan);
    process.env.RAZORPAY_PAYMENT_MODE = 'subscription';
    await rejects(billing.createCheckout('orgA', { plan: 'builder', cycle: 'monthly' }, {}), 'PLAN_ALREADY_ACTIVE');
  });
  await t('renewing the SAME plan in order mode keeps working (extends from the period end)', async () => {
    reset(); const end = new Date(Date.now() + 3 * day); active({ currentPeriodEnd: end }); process.env.RAZORPAY_PAYMENT_MODE = 'order';
    const out = await billing.createCheckout('orgA', { plan: 'growth', cycle: 'monthly' }, {});
    assert.strictEqual(out.mode, 'order');
    await hook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_r', order_id: out.orderId } } } });
    assert.ok(new Date(orgOf().currentPeriodEnd) > new Date(end.getTime() + 25 * day));
  });
  await t('a self-renewing subscription cannot be bought twice', async () => {
    reset(); active({ razorpay: { mode: 'subscription', subscriptionId: 'sub_live' } });
    await rejects(billing.createCheckout('orgA', { plan: 'growth', cycle: 'monthly' }, {}), 'PLAN_ALREADY_ACTIVE');
  });
  await t('trial / expired / cancelled / past-period companies can choose any plan', async () => {
    for (const over of [{ plan: 'trial', status: 'trialing' }, { status: 'cancelled' }, { status: 'past_due' }, { status: 'active', currentPeriodEnd: new Date(Date.now() - day) }]) {
      reset(); active(over); process.env.RAZORPAY_PAYMENT_MODE = 'order';
      const out = await billing.createCheckout('orgA', { plan: 'builder', cycle: 'annual' }, {});
      assert.strictEqual(out.mode, 'order', JSON.stringify(over));
    }
  });

  console.log('Plans change only after a verified payment');
  await t('stale pendingPlan cannot activate a plan (webhook for another / unknown subscription)', async () => {
    reset(); seedOrg({ pendingPlan: 'builder', pendingCycle: 'annual' });
    await hook({ event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_other', notes: { orgId: 'orgA' } } }, payment: { entity: { id: 'pay_x', amount: 100 } } } });
    assert.deepStrictEqual([orgOf().plan, orgOf().status], ['trial', 'trialing']);
    assert.strictEqual(invoices.docs.length, 0);
  });
  await t('the paid subscription\'s own notes win over a stale pendingPlan', async () => {
    reset(); seedOrg({ pendingPlan: 'builder', pendingCycle: 'annual', razorpay: { pendingSubscriptionId: 'sub_new' } });
    await hook({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_old2', notes: { orgId: 'orgA', plan: 'starter', cycle: 'monthly' } } } } });
    assert.deepStrictEqual([orgOf().plan, orgOf().billingCycle, orgOf().status], ['starter', 'monthly', 'active']);
  });
  await t('pendingPlan is used only when the webhook is for the pending subscription id', async () => {
    reset(); seedOrg({ pendingPlan: 'builder', pendingCycle: 'annual', razorpay: { pendingSubscriptionId: 'sub_new' } });
    await hook({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_new', notes: { orgId: 'orgA' } } } } });
    assert.deepStrictEqual([orgOf().plan, orgOf().billingCycle, orgOf().pendingPlan], ['builder', 'annual', null]);
    assert.strictEqual(orgOf().razorpay.subscriptionId, 'sub_new');
  });
  await t('verify with a wrong signature / wrong subscription id activates nothing', async () => {
    reset(); seedOrg({ pendingPlan: 'builder', pendingCycle: 'monthly', razorpay: { pendingSubscriptionId: 'sub_p' } });
    await assert.rejects(billing.verifyCheckout('orgA', { razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_p', razorpay_signature: 'bad-signature' }), /signature/i);
    const sig = crypto.createHmac('sha256', 'secret').update('pay_1|sub_zzz').digest('hex');
    await assert.rejects(billing.verifyCheckout('orgA', { razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_zzz', razorpay_signature: sig }), /does not match/);
    assert.strictEqual(orgOf().plan, 'trial');
  });
  await t('a payment for an order that is not this company\'s never activates a plan', async () => {
    reset(); seedOrg(); seedOrg({ _id: 'orgB' });
    invoices.seed({ _id: 'i1', orgId: 'orgB', kind: 'plan', status: 'pending', plan: 'builder', billingCycle: 'monthly', amount: 1, razorpayOrderId: 'order_b' });
    const sig = crypto.createHmac('sha256', 'secret').update('order_b|pay_1').digest('hex');
    await assert.rejects(billing.verifyPlanOrder('orgA', { razorpay_order_id: 'order_b', razorpay_payment_id: 'pay_1', razorpay_signature: sig }), /does not match/);
    assert.strictEqual(orgOf('orgA').plan, 'trial');
  });
  await t('dismissed / failed / cancelled checkouts clear pendingPlan', async () => {
    reset(); seedOrg(); process.env.RAZORPAY_PAYMENT_MODE = 'subscription';
    const sub = await billing.createCheckout('orgA', { plan: 'growth', cycle: 'monthly' }, {});
    assert.strictEqual(orgOf().pendingPlan, 'growth');
    assert.deepStrictEqual(await billing.abandonCheckout('orgA', { subscriptionId: 'sub_wrong' }), { cleared: false });
    assert.strictEqual(orgOf().pendingPlan, 'growth', 'a different id does not clear it');
    assert.deepStrictEqual(await billing.abandonCheckout('orgA', { subscriptionId: sub.subscriptionId }), { cleared: true });
    assert.deepStrictEqual([orgOf().pendingPlan, orgOf().pendingCycle, orgOf().razorpay.pendingSubscriptionId, orgOf().pendingCheckout], [null, null, null, null]);
    // order checkout dismissed: pending plan cleared, the unpaid invoice stays pending (a late payment still counts)
    reset(); seedOrg(); process.env.RAZORPAY_PAYMENT_MODE = 'order';
    const ord = await billing.createCheckout('orgA', { plan: 'growth', cycle: 'monthly' }, {});
    assert.strictEqual(orgOf().pendingPlan, 'growth');
    assert.deepStrictEqual(await billing.abandonCheckout('orgA', { orderId: ord.orderId }), { cleared: true });
    assert.strictEqual(orgOf().pendingPlan, null);
    assert.strictEqual(invoices.docs[0].status, 'pending');
    // subscription failed / cancelled webhooks
    reset(); seedOrg({ pendingPlan: 'growth', pendingCycle: 'monthly', razorpay: { pendingSubscriptionId: 'sub_f' } });
    await hook({ event: 'subscription.cancelled', payload: { subscription: { entity: { id: 'sub_f', notes: { orgId: 'orgA' } } } } });
    assert.deepStrictEqual([orgOf().pendingPlan, orgOf().razorpay.pendingSubscriptionId], [null, null]);
  });

  console.log(`\n${pass} checks passed`);
})();
