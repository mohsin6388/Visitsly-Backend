const Lead = require('../../models/Lead');
const User = require('../../models/User');
const env = require('../../config/env');
const { getPlan, limitsFor } = require('../../config/plans');
const { subscriptionState } = require('./subscription');
const { usageFor } = require('./orgService');
const { publicView } = require('./whatsappConnect');
const billing = require('./billingService');

/** Everything the frontend needs about the current company in one object. */
async function orgSummary(org) {
  if (!org) return null;
  const [contacts, users] = await Promise.all([
    Lead.countDocuments({ ownerId: org.ownerUserId }),
    User.countDocuments({ orgId: org._id, isActive: true }),
  ]);
  const plan = getPlan(org.plan);
  const usage = usageFor(org);
  return {
    id: String(org._id),
    name: org.name,
    slug: org.slug,
    city: org.city || '',
    businessType: org.businessType || 'broker',
    gstin: org.gstin || '',
    billingEmail: org.billingEmail || '',
    phone: org.phone || '',
    plan: plan.code,
    planName: plan.name,
    pendingPlan: org.pendingPlan || null,
    billingCycle: org.billingCycle,
    status: org.status,
    subscription: subscriptionState(org),
    trialEndsAt: org.trialEndsAt,
    currentPeriodEnd: org.currentPeriodEnd,
    cancelAtPeriodEnd: !!org.cancelAtPeriodEnd,
    priceOverride: org.priceOverride || null,
    limits: limitsFor(org),
    features: plan.features,
    usage: { ...usage, contacts, users },
    whatsapp: publicView(org),
    onboarding: org.onboarding || {},
    addons: org.addons || {},
    branding: org.branding || {},
    routing: { mode: org.routing?.mode || 'off', agentsSeeOnlyAssigned: !!org.routing?.agentsSeeOnlyAssigned },
    channelPartners: org.channelPartners || { enabled: false },
    voice: { enabled: !!org.voice?.enabled, autoCallNewLeads: !!org.voice?.autoCallNewLeads },
    leadCapture: { autoWhatsapp: org.leadCapture?.autoWhatsapp !== false, metaPageName: org.leadCapture?.metaPageName || null },
    weeklyReport: { enabled: !!org.weeklyReport?.enabled, phone: org.weeklyReport?.phone || null },
    billingConfigured: billing.configured(),
    productName: org.branding?.productName || env.saas.productName,
    sales: { phone: env.saas.salesPhone, email: env.saas.salesEmail },
    createdAt: org.createdAt,
  };
}

module.exports = { orgSummary };
