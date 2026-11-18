const Lead = require("../../models/Lead");
const User = require("../../models/User");
const env = require("../../config/env");
const { getPlan, limitsFor, featuresFor, RECOMMENDED_PLAN } = require("../../config/plans");
const { subscriptionState, bulkUsedFor, usedForLimit, voiceUsage } = require("./subscription");
const { usageFor } = require("./orgService");
const { publicView } = require("./whatsappConnect");
const billing = require("./billingService");

function onboardingView(org) {
  const o = org.onboarding || {};
  const d = o.profileDraft || {};
  return {
    ...o,
    profileDone: o.profileDone !== false,
    profileDraft: {
      ownerName: d.ownerName || "",
      companyName: d.companyName || "",
      country: d.country || "",
      city: d.city || "",
      businessType: d.businessType || "",
      step: Number(d.step) || 0,
    },
  };
}

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
    city: org.city || "",
    businessType: org.businessType || "broker",
    gstin: org.gstin || "",
    billingEmail: org.billingEmail || "",
    phone: org.phone || "",
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
    country: org.country || 'IN',
    currency: billing.currencyOf(org),
    limits: limitsFor(org),
    features: featuresFor(org),
    usage: {
      ...usage,
      contacts,
      users,
      bulkMessages: bulkUsedFor(org),
      // Trial: totals for the whole trial; paid plans: this month.
      aiConversations: usedForLimit(org, "aiConversations", usage.aiConversations),
      campaigns: usedForLimit(org, "campaignsPerMonth", usage.campaigns),
    },
    voiceUsage: voiceUsage(org),
    recommendedPlan: RECOMMENDED_PLAN[org.businessType] || null,
    whatsapp: publicView(org),
    onboarding: onboardingView(org),
    // Onboarding wizard gate: only an explicit false (new workspaces) forces it.
    profileDone: org.onboarding?.profileDone !== false,
    // Country / currency are fixed once the wizard is done (platform admin only).
    countryLocked: org.onboarding?.profileDone !== false,
    addons: org.addons || {},
    branding: org.branding || {},
    routing: {
      mode: org.routing?.mode || "off",
      agentsSeeOnlyAssigned: !!org.routing?.agentsSeeOnlyAssigned,
    },
    channelPartners: org.channelPartners || { enabled: false },
    voice: {
      enabled: !!org.voice?.enabled,
      autoCallNewLeads: !!org.voice?.autoCallNewLeads,
    },
    leadCapture: {
      autoWhatsapp: org.leadCapture?.autoWhatsapp !== false,
      metaPageName: org.leadCapture?.metaPageName || null,
    },
    weeklyReport: {
      enabled: !!org.weeklyReport?.enabled,
      phone: org.weeklyReport?.phone || null,
    },
    billingConfigured: billing.configured(),
    // 'order' = paid per period (Renew button); 'subscription' = auto-renew.
    billingMode: org.razorpay?.mode || null,
    productName: org.branding?.productName || env.saas.productName,
    sales: { phone: env.saas.salesPhone, email: env.saas.salesEmail },
    createdAt: org.createdAt,
  };
}

module.exports = { orgSummary };
