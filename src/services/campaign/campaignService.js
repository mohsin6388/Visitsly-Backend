// const Campaign = require("../../models/Campaign");
// const EmailTemplate = require("../../models/EmailTemplate");
// const Lead = require("../../models/Lead");
// const Conversation = require("../../models/Conversation");
// const AuditLog = require("../../models/AuditLog");
// const ApiError = require("../../utils/ApiError");
// const { importLeadRows } = require("../leads/leadImportService");
// const { scheduleCampaignJobs, todayIST } = require("../queue/outboundQueue");
// const { emitToUser } = require("../../sockets");

// /**
//  * Launches a campaign against already-imported lead IDs. Legacy `rows` support
//  * remains for older clients, but the CRM UI only uploads leads in the Leads area.
//  */
// async function launchCampaign({ ownerId, userId, ip, rows, leadIds, config }) {
//   const selectedChannels = config.channels || {};
//   if (!selectedChannels.whatsapp && !selectedChannels.email) {
//     throw ApiError.badRequest("Kam se kam ek channel chuno.");
//   }

//   let selectedEmailTemplate = null;
//   if (selectedChannels.email && config.emailTemplateId) {
//     selectedEmailTemplate = await EmailTemplate.findOne({ _id: config.emailTemplateId, ownerId });
//     if (!selectedEmailTemplate) throw ApiError.badRequest("Selected email template nahi mila. Template list refresh karein.");
//     // Use saved server-side content rather than trusting a modified client payload.
//     config.emailSubject = selectedEmailTemplate.subject;
//     config.emailBody = selectedEmailTemplate.body;
//     config.emailImageUrl = selectedEmailTemplate.imageUrl || "";
//   }

//   // SaaS plan limit: campaigns per month.
//   const tenantOrg = require("../../context/tenantContext").getOrg();
//   if (tenantOrg) {
//     const { assertWithinLimit, monthlyUsage } = require("../saas/subscription");
//     assertWithinLimit("campaignsPerMonth", monthlyUsage(tenantOrg).campaigns, 1);
//   }

//   let leads = [];
//   let skipped = 0;
//   let invalid = 0;
//   if (Array.isArray(leadIds) && leadIds.length) {
//     if (new Set(leadIds.map(String)).size !== leadIds.length) {
//       throw ApiError.badRequest("Selected list mein duplicate lead IDs hain.");
//     }
//     leads = await Lead.find({ ownerId, _id: { $in: leadIds } }).sort({ createdAt: 1 });
//     if (!leads.length) throw ApiError.badRequest("Selected leads nahi mili. List refresh karke dobara choose karein.");
//     skipped = leadIds.length - leads.length;
//   } else {
//     const eligible = (rows || []).some((row) =>
//       (selectedChannels.whatsapp && String(row.phone || "").trim()) ||
//       (selectedChannels.email && String(row.email || "").trim())
//     );
//     if (!eligible) throw ApiError.badRequest("Selected channel ke liye koi phone/email contact nahi mila.");
//     const result = await importLeadRows(ownerId, rows || []);
//     leads = result.inserted;
//     skipped = result.skipped;
//     invalid = result.invalid;
//     if (!leads.length) {
//       throw ApiError.badRequest("Koi nayi lead insert nahi hui — saari rows duplicate ya invalid thi.");
//     }
//   }

//   const whatsappLeads = leads.filter((lead) => selectedChannels.whatsapp && Boolean(lead.phone));
//   const emailLeads = leads.filter((lead) => selectedChannels.email && Boolean(lead.email));
//   if (selectedChannels.whatsapp && !config.whatsappTemplateName) {
//     throw ApiError.badRequest("Bulk WhatsApp ke liye Meta ka approved template select karein.");
//   }
//   if (selectedChannels.whatsapp && !whatsappLeads.length && !selectedChannels.email) {
//     throw ApiError.badRequest("Selected leads mein valid WhatsApp numbers nahi hain.");
//   }
//   if (selectedChannels.email && !emailLeads.length && !selectedChannels.whatsapp) {
//     throw ApiError.badRequest("Selected leads mein valid email addresses nahi hain.");
//   }
//   if (selectedChannels.email && !config.emailSubject?.trim()) {
//     throw ApiError.badRequest("Email subject required.");
//   }
//   if (selectedChannels.email && !config.emailBody?.trim()) {
//     throw ApiError.badRequest("Email body required.");
//   }

//   // Only queue contacts that match the selected channel; contact rows themselves remain in CRM.
//   const eligibleLeads = leads.filter((lead) =>
//     (selectedChannels.whatsapp && Boolean(lead.phone)) ||
//     (selectedChannels.email && Boolean(lead.email))
//   );
//   if (!eligibleLeads.length) {
//     throw ApiError.badRequest("Selected channel ke liye matching contact fields nahi hain.");
//   }

//   const conversationLeads = eligibleLeads.filter((lead) => Boolean(lead.phone));
//   if (conversationLeads.length) {
//     await Conversation.bulkWrite(conversationLeads.map((lead) => ({
//       updateOne: {
//         filter: { ownerId, leadId: lead._id },
//         update: { $setOnInsert: { ownerId, leadId: lead._id } },
//         upsert: true,
//       },
//     })), { ordered: false });
//   }

//   const today = todayIST();
//   const startDate = config.startDate && config.startDate >= today ? config.startDate : today;
//   const campaign = await Campaign.create({
//     ownerId,
//     name: config.name,
//     audienceId: config.audienceId || null,
//     phoneNumberId: config.phoneNumberId || null,
//     channels: selectedChannels,
//     dailyLimit: config.dailyLimit,
//     sendTime: config.sendTime,
//     startDate,
//     whatsappTemplate: selectedChannels.whatsapp ? {
//       name: config.whatsappTemplateName,
//       language: config.whatsappTemplateLanguage || "en_US",
//       category: config.whatsappTemplateCategory || "",
//       variables: Array.isArray(config.whatsappTemplateVariables) ? config.whatsappTemplateVariables : [],
//       headerImageUrl: config.whatsappTemplateHeaderImageUrl || "",
//       body: config.whatsappTemplateBody || "",
//       header: config.whatsappTemplateHeader || "",
//       footer: config.whatsappTemplateFooter || "",
//       buttons: (config.whatsappTemplateButtons || []).filter(Boolean).slice(0, 10),
//     } : undefined,
//     email: {
//       templateId: selectedEmailTemplate?._id || null,
//       templateName: selectedEmailTemplate?.name || "",
//       subject: config.emailSubject || "",
//       body: config.emailBody || "",
//       imageUrl: config.emailImageUrl || "",
//     },
//     totalLeads: eligibleLeads.length,
//   });

//   const plan = await scheduleCampaignJobs({
//     campaign,
//     leads: eligibleLeads.map((lead) => ({
//       _id: lead._id,
//       hasPhone: Boolean(lead.phone),
//       hasEmail: Boolean(lead.email),
//       email: lead.email || "",
//       name: lead.name || "",
//     })),
//   });

//   campaign.leadsWithoutEmail = selectedChannels.email ? eligibleLeads.filter((lead) => !lead.email).length : 0;
//   campaign.totalDays = plan.totalDays;
//   campaign.firstRunAt = plan.firstRunAt;
//   campaign.lastRunAt = plan.lastRunAt;
//   await campaign.save();

//   await AuditLog.create({
//     userId,
//     action: "campaign.launch",
//     entityType: "Campaign",
//     entityId: campaign._id,
//     meta: {
//       leads: eligibleLeads.length,
//       selectedLeadIds: Array.isArray(leadIds) ? leadIds.length : 0,
//       skipped,
//       invalid,
//       channels: selectedChannels,
//       dailyLimit: config.dailyLimit,
//       sendTime: config.sendTime,
//       whatsappTemplateName: config.whatsappTemplateName || null,
//     },
//     ip,
//   });

//   emitToUser(ownerId, "outreach:campaign", { campaignId: String(campaign._id), status: "active" });

//   if (tenantOrg) {
//     require("../saas/orgService").incrementUsage(tenantOrg._id, "campaigns", 1).catch(() => {});
//   }

//   return {
//     campaign,
//     insertedCount: eligibleLeads.length,
//     skipped,
//     invalid,
//     queued: { whatsapp: plan.whatsapp, email: plan.email },
//     withoutEmail: campaign.leadsWithoutEmail,
//     withoutPhone: eligibleLeads.filter((lead) => !lead.phone).length,
//     whatsappAvailable: eligibleLeads.filter((lead) => Boolean(lead.phone)).length,
//     emailAvailable: eligibleLeads.filter((lead) => Boolean(lead.email)).length,
//     totalDays: plan.totalDays,
//     firstRunAt: plan.firstRunAt,
//     lastRunAt: plan.lastRunAt,
//   };
// }

// module.exports = { launchCampaign };

const Campaign = require("../../models/Campaign");
const EmailTemplate = require("../../models/EmailTemplate");
const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const AuditLog = require("../../models/AuditLog");
const ApiError = require("../../utils/ApiError");
const { importLeadRows } = require("../leads/leadImportService");
const { scheduleCampaignJobs, todayIn, tenantTimezone } = require("../queue/outboundQueue");
const policy = require("../compliance/messagingPolicy");
const { hasFeature, upgradeMessageFor, limitsFor } = require("../../config/plans");
const { emitToUser } = require("../../sockets");

/**
 * Launches a campaign against already-imported lead IDs. Legacy `rows` support
 * remains for older clients, but the CRM UI only uploads leads in the Leads area.
 */
async function launchCampaign({ ownerId, userId, ip, rows, leadIds, config }) {
  const selectedChannels = config.channels || {};
  if (!selectedChannels.whatsapp && !selectedChannels.email) {
    throw ApiError.badRequest("Kam se kam ek channel chuno.");
  }

  let selectedEmailTemplate = null;
  if (selectedChannels.email && config.emailTemplateId) {
    selectedEmailTemplate = await EmailTemplate.findOne({
      _id: config.emailTemplateId,
      ownerId,
    });
    if (!selectedEmailTemplate)
      throw ApiError.badRequest(
        "Selected email template nahi mila. Template list refresh karein.",
      );
    // Use saved server-side content rather than trusting a modified client payload.
    config.emailSubject = selectedEmailTemplate.subject;
    config.emailBody = selectedEmailTemplate.body;
    config.emailImageUrl = selectedEmailTemplate.imageUrl || "";
  }

  // SaaS plan limit: campaigns per month.
  const tenantOrg = require("../../context/tenantContext").getOrg();

  // Plan features: bulk WhatsApp / email campaigns are Growth+ (trial can try them).
  if (tenantOrg) {
    if (selectedChannels.whatsapp && !hasFeature(tenantOrg, "bulkWhatsapp")) {
      throw new ApiError(403, upgradeMessageFor("bulkWhatsapp", tenantOrg), { code: "PLAN_FEATURE", feature: "bulkWhatsapp" });
    }
    if (selectedChannels.email && !hasFeature(tenantOrg, "emailCampaigns")) {
      throw new ApiError(403, upgradeMessageFor("emailCampaigns", tenantOrg), { code: "PLAN_FEATURE", feature: "emailCampaigns" });
    }
  }

  // Bulk Messaging Policy: the person launching confirms consent + accepts the rules.
  if (!config.acceptPolicy || !config.consentConfirmed) {
    throw ApiError.badRequest(
      "Campaign launch karne se pehle Bulk Messaging Policy accept karein aur confirm karein ki in contacts ne aapse message lene ki permission di hai.",
      { code: "POLICY_NOT_ACCEPTED" },
    );
  }
  // Marketing only inside the allowed local hours: a send time at night is
  // moved to the morning window (the worker also holds night-time jobs).
  const clamped = policy.clampSendTime(tenantOrg, config.sendTime);
  config.sendTime = clamped.sendTime;

  if (tenantOrg) {
    const { assertWithinLimit, monthlyUsage } = require("../saas/subscription");
    assertWithinLimit(
      "campaignsPerMonth",
      monthlyUsage(tenantOrg).campaigns,
      1,
    );
  }

  let leads = [];
  let skipped = 0;
  let invalid = 0;
  if (Array.isArray(leadIds) && leadIds.length) {
    if (new Set(leadIds.map(String)).size !== leadIds.length) {
      throw ApiError.badRequest("Selected list mein duplicate lead IDs hain.");
    }
    leads = await Lead.find({ ownerId, _id: { $in: leadIds } }).sort({
      createdAt: 1,
    });
    if (!leads.length)
      throw ApiError.badRequest(
        "Selected leads nahi mili. List refresh karke dobara choose karein.",
      );
    skipped = leadIds.length - leads.length;
  } else {
    const eligible = (rows || []).some(
      (row) =>
        (selectedChannels.whatsapp && String(row.phone || "").trim()) ||
        (selectedChannels.email && String(row.email || "").trim()),
    );
    if (!eligible)
      throw ApiError.badRequest(
        "Selected channel ke liye koi phone/email contact nahi mila.",
      );
    const result = await importLeadRows(ownerId, rows || []);
    leads = result.inserted;
    skipped = result.skipped;
    invalid = result.invalid;
    if (!leads.length) {
      throw ApiError.badRequest(
        "Koi nayi lead insert nahi hui — saari rows duplicate ya invalid thi.",
      );
    }
  }

  // Consent / suppression: opted-out, do-not-contact, bounced and spam-complaint
  // contacts are dropped per channel (they stay in the CRM).
  const suppressed = { whatsapp: 0, email: 0, reasons: {} };
  const waOk = (lead) => {
    if (!selectedChannels.whatsapp || !lead.phone) return false;
    const r = policy.suppressionReason(lead, "whatsapp");
    if (r) {
      suppressed.whatsapp += 1;
      suppressed.reasons[r] = (suppressed.reasons[r] || 0) + 1;
      return false;
    }
    return true;
  };
  const emOk = (lead) => {
    if (!selectedChannels.email || !lead.email) return false;
    const r = policy.suppressionReason(lead, "email");
    if (r) {
      suppressed.email += 1;
      suppressed.reasons[r] = (suppressed.reasons[r] || 0) + 1;
      return false;
    }
    return true;
  };
  const usable = new Map(leads.map((lead) => [String(lead._id), { wa: waOk(lead), email: emOk(lead) }]));
  const whatsappLeads = leads.filter((lead) => usable.get(String(lead._id)).wa);
  const emailLeads = leads.filter((lead) => usable.get(String(lead._id)).email);
  if (!whatsappLeads.length && !emailLeads.length && (suppressed.whatsapp || suppressed.email)) {
    throw ApiError.badRequest(
      "Selected saare contacts ne opt-out kiya hai ya unke email bounce/spam ho chuke hain — inhe campaign nahi bheja ja sakta.",
      { code: "ALL_SUPPRESSED" },
    );
  }
  if (selectedChannels.whatsapp && !config.whatsappTemplateName) {
    throw ApiError.badRequest(
      "Bulk WhatsApp ke liye Meta ka approved template select karein.",
    );
  }
  if (
    selectedChannels.whatsapp &&
    !whatsappLeads.length &&
    !selectedChannels.email
  ) {
    throw ApiError.badRequest(
      "Selected leads mein valid WhatsApp numbers nahi hain.",
    );
  }
  if (
    selectedChannels.email &&
    !emailLeads.length &&
    !selectedChannels.whatsapp
  ) {
    throw ApiError.badRequest(
      "Selected leads mein valid email addresses nahi hain.",
    );
  }
  if (selectedChannels.email && !config.emailSubject?.trim()) {
    throw ApiError.badRequest("Email subject required.");
  }
  if (selectedChannels.email && !config.emailBody?.trim()) {
    throw ApiError.badRequest("Email body required.");
  }

  // Only queue contacts that match the selected channel; contact rows themselves remain in CRM.
  const eligibleLeads = leads.filter((lead) => {
    const u = usable.get(String(lead._id));
    return u.wa || u.email;
  });
  if (!eligibleLeads.length) {
    throw ApiError.badRequest(
      "Selected channel ke liye matching contact fields nahi hain.",
    );
  }

  // SaaS plan limit: total bulk messages (trial total / paid per month).
  if (tenantOrg) {
    const planned =
      (selectedChannels.whatsapp ? whatsappLeads.length : 0) +
      (selectedChannels.email ? emailLeads.length : 0);
    require("../saas/subscription").assertBulkMessagesAllowed(planned);
  }

  const conversationLeads = eligibleLeads.filter((lead) => Boolean(lead.phone));
  if (conversationLeads.length) {
    await Conversation.bulkWrite(
      conversationLeads.map((lead) => ({
        updateOne: {
          filter: { ownerId, leadId: lead._id },
          update: { $setOnInsert: { ownerId, leadId: lead._id } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  const today = todayIn(tenantTimezone());
  const startDate =
    config.startDate && config.startDate >= today ? config.startDate : today;

  // Never schedule more per day than the company's daily safety cap allows.
  let dailyLimit = config.dailyLimit;
  if (tenantOrg) {
    const caps = [];
    if (selectedChannels.whatsapp) caps.push(await policy.dailyCap(tenantOrg, ownerId, "whatsapp"));
    if (selectedChannels.email) caps.push(await policy.dailyCap(tenantOrg, ownerId, "email"));
    const cap = Math.min(...caps.filter((c) => Number.isFinite(c) && c > 0));
    if (Number.isFinite(cap) && dailyLimit > cap) dailyLimit = cap;
  }
  const policyAcceptedAt = new Date();
  const campaign = await Campaign.create({
    ownerId,
    name: config.name,
    audienceId: config.audienceId || null,
    phoneNumberId: config.phoneNumberId || null,
    channels: selectedChannels,
    dailyLimit,
    sendTime: config.sendTime,
    startDate,
    compliance: {
      policyVersion: policy.POLICY_VERSION,
      acceptedBy: userId || null,
      acceptedAt: policyAcceptedAt,
      consentConfirmed: true,
      ip: ip || null,
      suppressedAtLaunch: suppressed.whatsapp + suppressed.email,
    },
    whatsappTemplate: selectedChannels.whatsapp
      ? {
          name: config.whatsappTemplateName,
          language: config.whatsappTemplateLanguage || "en_US",
          category: config.whatsappTemplateCategory || "",
          variables: Array.isArray(config.whatsappTemplateVariables)
            ? config.whatsappTemplateVariables
            : [],
          headerImageUrl: config.whatsappTemplateHeaderImageUrl || "",
          body: config.whatsappTemplateBody || "",
          header: config.whatsappTemplateHeader || "",
          footer: config.whatsappTemplateFooter || "",
          buttons: (config.whatsappTemplateButtons || [])
            .filter(Boolean)
            .slice(0, 10),
        }
      : undefined,
    email: {
      templateId: selectedEmailTemplate?._id || null,
      templateName: selectedEmailTemplate?.name || "",
      subject: config.emailSubject || "",
      body: config.emailBody || "",
      imageUrl: config.emailImageUrl || "",
    },
    totalLeads: eligibleLeads.length,
  });

  const plan = await scheduleCampaignJobs({
    campaign,
    leads: eligibleLeads.map((lead) => ({
      _id: lead._id,
      hasPhone: usable.get(String(lead._id)).wa,
      hasEmail: usable.get(String(lead._id)).email,
      email: lead.email || "",
      name: lead.name || "",
    })),
  });

  campaign.leadsWithoutEmail = selectedChannels.email
    ? eligibleLeads.filter((lead) => !lead.email).length
    : 0;
  campaign.totalDays = plan.totalDays;
  campaign.firstRunAt = plan.firstRunAt;
  campaign.lastRunAt = plan.lastRunAt;
  await campaign.save();

  await AuditLog.create({
    userId,
    action: "campaign.launch",
    entityType: "Campaign",
    entityId: campaign._id,
    meta: {
      leads: eligibleLeads.length,
      selectedLeadIds: Array.isArray(leadIds) ? leadIds.length : 0,
      skipped,
      invalid,
      channels: selectedChannels,
      dailyLimit,
      sendTime: config.sendTime,
      whatsappTemplateName: config.whatsappTemplateName || null,
      policyVersion: policy.POLICY_VERSION,
      consentConfirmed: true,
      suppressed,
    },
    ip,
  });

  // Remember that this workspace accepted the current policy version.
  if (tenantOrg && tenantOrg.messaging?.policyVersion !== policy.POLICY_VERSION) {
    await require("../../models/Organization").updateOne(
      { _id: tenantOrg._id },
      { $set: { "messaging.policyVersion": policy.POLICY_VERSION, "messaging.policyAcceptedAt": policyAcceptedAt, "messaging.policyAcceptedBy": userId || null } },
    );
    require("../saas/orgService").invalidate(tenantOrg._id);
  }

  emitToUser(ownerId, "outreach:campaign", {
    campaignId: String(campaign._id),
    status: "active",
  });

  if (tenantOrg) {
    require("../saas/orgService")
      .incrementUsage(tenantOrg._id, "campaigns", 1)
      .catch(() => {});
  }

  return {
    campaign,
    insertedCount: eligibleLeads.length,
    skipped,
    invalid,
    queued: { whatsapp: plan.whatsapp, email: plan.email },
    withoutEmail: campaign.leadsWithoutEmail,
    withoutPhone: eligibleLeads.filter((lead) => !lead.phone).length,
    whatsappAvailable: whatsappLeads.length,
    emailAvailable: emailLeads.length,
    suppressed,
    dailyLimit,
    sendTimeShifted: clamped.shifted,
    totalDays: plan.totalDays,
    firstRunAt: plan.firstRunAt,
    lastRunAt: plan.lastRunAt,
  };
}

module.exports = { launchCampaign };
