const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const Campaign = require("../models/Campaign");
const Audience = require("../models/Audience");
const EmailMessage = require("../models/EmailMessage");
const { launchCampaign } = require("../services/campaign/campaignService");
const queue = require("../services/queue/outboundQueue");
const { emitToUser } = require("../sockets");

/** POST /api/campaigns/launch */
const launch = asyncHandler(async (req, res) => {
  const { rows, leadIds, audienceId, ...config } = req.body;

  const result = await launchCampaign({
    ownerId: req.user.id,
    userId: req.user.id,
    ip: req.ip,
    rows,
    leadIds,
    config: { ...config, audienceId },
  });
  if (audienceId) {
    await Audience.updateOne({ _id: audienceId, ownerId: req.user.id }, { $set: { lastUsedAt: new Date() } });
  }

  const { whatsapp, email } = result.queued;
  const parts = [];
  if (whatsapp) parts.push(`${whatsapp} WhatsApp`);
  if (email) parts.push(`${email} email`);

  return new ApiResponse(
    201,
    {
      campaignId: result.campaign._id,
      insertedCount: result.insertedCount,
      skipped: result.skipped,
      invalid: result.invalid,
      queued: result.queued,
      withoutEmail: result.withoutEmail,
      withoutPhone: result.withoutPhone,
      whatsappAvailable: result.whatsappAvailable,
      emailAvailable: result.emailAvailable,
      totalDays: result.totalDays,
      firstRunAt: result.firstRunAt,
      lastRunAt: result.lastRunAt,
    },
    `Campaign started: ${result.insertedCount} leads, ${parts.join(" + ")} scheduled over ${result.totalDays} day(s).`,
  ).send(res);
});

/** GET /api/campaigns */
const list = asyncHandler(async (req, res) => {
  const campaigns = await queue.listCampaigns(req.user.id, { limit: 30 });
  return new ApiResponse(200, { campaigns }).send(res);
});

/** GET /api/campaigns/:id */
const getOne = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    ownerId: req.user.id,
  }).lean();
  if (!campaign) throw ApiError.notFound("Campaign not found");
  const stats = await queue.getCampaignStats(campaign._id);
  return new ApiResponse(200, { campaign: { ...campaign, stats } }).send(res);
});

function control(action, message) {
  return asyncHandler(async (req, res) => {
    const result = await action(req);
    if (!result) throw ApiError.notFound("Campaign not found");

    if (message === "Campaign cancelled") {
      await EmailMessage.updateMany(
        { ownerId: req.user.id, campaignId: result.campaign._id, direction: "outbound", kind: "campaign", status: { $in: ["queued", "sending"] } },
        { $set: { status: "cancelled" } },
      );
    }

    const stats = await queue.getCampaignStats(result.campaign._id);
    emitToUser(req.user.id, "outreach:campaign", {
      campaignId: String(result.campaign._id),
      status: result.campaign.status,
    });
    emitToUser(req.user.id, "outreach:progress", {
      campaignId: String(result.campaign._id),
      stats,
    });

    return new ApiResponse(
      200,
      { status: result.campaign.status, affected: result.modified, stats },
      `${message}: ${result.modified} job(s)`,
    ).send(res);
  });
}

const pause = control(
  (req) => queue.pauseCampaign(req.user.id, req.params.id),
  "Campaign paused",
);
const resume = control(
  (req) => queue.resumeCampaign(req.user.id, req.params.id),
  "Campaign resumed",
);
const cancel = control(
  (req) => queue.cancelCampaign(req.user.id, req.params.id),
  "Campaign cancelled",
);
const retry = control(
  (req) => queue.retryFailed(req.user.id, req.params.id, req.body?.channel),
  "Failed jobs re-queued",
);

/** GET /api/outreach/summary — sidebar badges + page header cards */
const summary = asyncHandler(async (req, res) => {
  const data = await queue.getOutreachSummary(req.user.id);
  return new ApiResponse(200, data).send(res);
});

/** GET /api/outreach/jobs?channel=&campaignId=&status=&page= */
const jobs = asyncHandler(async (req, res) => {
  const data = await queue.listJobs(req.user.id, req.query);
  return new ApiResponse(200, data).send(res);
});

module.exports = {
  launch,
  list,
  getOne,
  pause,
  resume,
  cancel,
  retry,
  summary,
  jobs,
};
