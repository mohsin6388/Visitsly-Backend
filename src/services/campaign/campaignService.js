const Campaign = require("../../models/Campaign");
const EmailTemplate = require("../../models/EmailTemplate");
const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const AuditLog = require("../../models/AuditLog");
const ApiError = require("../../utils/ApiError");
const { importLeadRows } = require("../leads/leadImportService");
const { scheduleCampaignJobs, todayIST } = require("../queue/outboundQueue");
const { emitToUser } = require("../../sockets");

/**
 * Launches a campaign against already-imported lead IDs. Legacy `rows` support
 * remains for older clients, but the CRM UI only uploads leads in the Leads area.
 */
async function launchCampaign({ ownerId, userId, ip, rows, leadIds, config }) {
  const selectedChannels = config.channels || {};
  if (!selectedChannels.whatsapp && !selectedChannels.email) {
    throw ApiError.badRequest("Choose at least one channel.");
  }

  // Plan features (server-side): WhatsApp campaigns need `bulkWhatsapp`,
  // email campaigns need `emailCampaigns` (not on the free trial).
  {
    const { assertFeature } = require("../saas/subscription");
    if (selectedChannels.whatsapp) assertFeature("bulkWhatsapp");
    if (selectedChannels.email) assertFeature("emailCampaigns");
  }

  let selectedEmailTemplate = null;
  if (selectedChannels.email && config.emailTemplateId) {
    selectedEmailTemplate = await EmailTemplate.findOne({
      _id: config.emailTemplateId,
      ownerId,
    });
    if (!selectedEmailTemplate)
      throw ApiError.badRequest(
        "Selected email template not found. Refresh the template list.",
      );
    // Use saved server-side content rather than trusting a modified client payload.
    config.emailSubject = selectedEmailTemplate.subject;
    config.emailBody = selectedEmailTemplate.body;
    config.emailImageUrl = selectedEmailTemplate.imageUrl || "";
  }

  // SaaS plan limit: campaigns per month.
  const tenantOrg = require("../../context/tenantContext").getOrg();
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
      throw ApiError.badRequest("The selection has duplicate lead IDs.");
    }
    leads = await Lead.find({ ownerId, _id: { $in: leadIds } }).sort({
      createdAt: 1,
    });
    if (!leads.length)
      throw ApiError.badRequest(
        "Selected leads not found. Refresh and choose again.",
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
        "No phone/email contacts for the selected channel.",
      );
    const result = await importLeadRows(ownerId, rows || []);
    leads = result.inserted;
    skipped = result.skipped;
    invalid = result.invalid;
    if (!leads.length) {
      throw ApiError.badRequest(
        "No new leads added — all rows were duplicates or invalid.",
      );
    }
  }

  const whatsappLeads = leads.filter(
    (lead) => selectedChannels.whatsapp && Boolean(lead.phone),
  );
  const emailLeads = leads.filter(
    (lead) => selectedChannels.email && Boolean(lead.email),
  );
  if (selectedChannels.whatsapp && !config.whatsappTemplateName) {
    throw ApiError.badRequest(
      "Select an approved template for bulk WhatsApp.",
    );
  }
  if (
    selectedChannels.whatsapp &&
    !whatsappLeads.length &&
    !selectedChannels.email
  ) {
    throw ApiError.badRequest(
      "Selected leads have no valid WhatsApp numbers.",
    );
  }
  if (
    selectedChannels.email &&
    !emailLeads.length &&
    !selectedChannels.whatsapp
  ) {
    throw ApiError.badRequest(
      "Selected leads have no valid email addresses.",
    );
  }
  if (selectedChannels.email && !config.emailSubject?.trim()) {
    throw ApiError.badRequest("Email subject required.");
  }
  if (selectedChannels.email && !config.emailBody?.trim()) {
    throw ApiError.badRequest("Email body required.");
  }
  if (selectedChannels.email) {
    // Email sends from the company's verified sender, paid from the per-email wallet.
    const senders = require("../email/emailSenderService");
    const ready = senders.readiness(await senders.getSender(ownerId));
    if (!ready.ready) {
      throw ApiError.badRequest(`${ready.reason} Open Email → Setup.`);
    }
    if (tenantOrg) {
      const emailWallet = require("../email/emailWallet");
      const freshOrg = await require("../../models/Organization").findById(tenantOrg._id).select("emailWallet").lean();
      const estimate = emailWallet.estimate(freshOrg, emailLeads.length);
      if (!estimate.enough) {
        throw new ApiError(402, `Your email wallet has about ${estimate.emailsLeft.toLocaleString("en-IN")} emails left, but this campaign needs ${estimate.emails.toLocaleString("en-IN")}. Recharge your email wallet in Email → Setup.`, {
          code: "EMAIL_WALLET_LOW",
          estimate,
        });
      }
    }
  }

  // Only queue contacts that match the selected channel; contact rows themselves remain in CRM.
  const matchingLeads = leads.filter(
    (lead) =>
      (selectedChannels.whatsapp && Boolean(lead.phone)) ||
      (selectedChannels.email && Boolean(lead.email)),
  );
  if (!matchingLeads.length) {
    throw ApiError.badRequest(
      "No matching contact fields for the selected channel.",
    );
  }
  // Never message more contacts than "per day × days" allows. With fewer
  // contacts the campaign simply ends earlier (no empty days are created).
  const durationDays = Number(config.durationDays) > 0 ? Math.floor(Number(config.durationDays)) : null;
  const capacity = durationDays ? Math.max(1, Number(config.dailyLimit) || 1) * durationDays : Infinity;
  const eligibleLeads = matchingLeads.slice(0, capacity);
  const notScheduled = matchingLeads.length - eligibleLeads.length;

  // SaaS plan limit: total bulk messages (trial total / paid per month).
  if (tenantOrg) {
    const planned =
      (selectedChannels.whatsapp ? eligibleLeads.filter((l) => Boolean(l.phone)).length : 0) +
      (selectedChannels.email ? eligibleLeads.filter((l) => Boolean(l.email)).length : 0);
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

  const today = todayIST();
  const startDate =
    config.startDate && config.startDate >= today ? config.startDate : today;
  const campaign = await Campaign.create({
    ownerId,
    name: config.name,
    audienceId: config.audienceId || null,
    phoneNumberId: config.phoneNumberId || null,
    channels: selectedChannels,
    dailyLimit: config.dailyLimit,
    durationDays,
    notScheduled,
    sendTime: config.sendTime,
    startDate,
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
      hasPhone: Boolean(lead.phone),
      hasEmail: Boolean(lead.email),
      email: lead.email || "",
      phone: lead.phone || "",
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
      dailyLimit: config.dailyLimit,
      sendTime: config.sendTime,
      whatsappTemplateName: config.whatsappTemplateName || null,
    },
    ip,
  });

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
    whatsappAvailable: eligibleLeads.filter((lead) => Boolean(lead.phone))
      .length,
    emailAvailable: eligibleLeads.filter((lead) => Boolean(lead.email)).length,
    totalDays: plan.totalDays,
    notScheduled,
    firstRunAt: plan.firstRunAt,
    lastRunAt: plan.lastRunAt,
  };
}

module.exports = { launchCampaign };
