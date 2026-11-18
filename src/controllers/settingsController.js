const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const settingsService = require('../services/settings/settingsService');
const { sendDailySummary } = require('../services/reports/dailySummaryService');

/** GET /api/settings */
const getSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.getPublicSettings();
  return new ApiResponse(200, { settings }).send(res);
});

/**
 * PATCH /api/settings
 * Accepts any subset of: companyName, logoUrl, geminiApiKey, businessHours,
 * workingDays, greetingMessage, openingText, aiPaused, autoReplyEnabled.
 */
const updateSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings(req.body);
  return new ApiResponse(200, { settings }, 'Settings updated').send(res);
});

/** POST /api/settings/ai/pause — quick toggle used by the WhatsApp/Settings page "Pause AI" button. */
const pauseAI = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings({ aiPaused: true });
  return new ApiResponse(200, { settings }, 'AI paused across all conversations').send(res);
});

/** POST /api/settings/ai/resume */
const resumeAI = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings({ aiPaused: false });
  return new ApiResponse(200, { settings }, 'AI resumed').send(res);
});

/**
 * POST /api/settings/daily-report/send-now
 * Manual trigger to test the daily WhatsApp summary immediately instead of
 * waiting for the scheduled time — uses whatever dailyReportPhone is
 * currently saved in Settings.
 */
const sendDailyReportNow = asyncHandler(async (req, res) => {
  const settings = await settingsService.getOrCreateSettings();
  if (!settings.dailyReportPhone) {
    throw ApiError.badRequest('Set dailyReportPhone in Settings first (PATCH /api/settings)');
  }

  const result = await sendDailySummary({
    phone: settings.dailyReportPhone,
    timezone: 'Asia/Kolkata',
  });

  return new ApiResponse(200, result, 'Daily summary sent').send(res);
});

/** POST /api/settings/test-alert — sends a sample owner alert so the owner can check delivery. */
const sendTestAlert = asyncHandler(async (req, res) => {
  const { sendOwnerAlert } = require('../services/alerts/ownerAlerts');
  const result = await sendOwnerAlert({
    kind: 'test',
    title: '✅ Test alert — Visitsly',
    lines: ['You’ll get a WhatsApp like this whenever a lead turns HOT or a visit is booked/confirmed.'],
    link: '/settings',
    templateValues: ['Test lead', '-', '-', '100', 'Test alert'],
  });
  const ok = result.whatsapp.some((r) => r.ok);
  const anyNumber = result.whatsapp.length > 0;
  const message = ok
    ? 'Test alert sent — check your WhatsApp.'
    : !anyNumber
      ? 'No alert number set — enter your WhatsApp number above and save.'
      : result.email?.ok
        ? 'WhatsApp not sent (24-hour window closed), so it was emailed. Send "Hi" from your number to the business WhatsApp or choose an alert template.'
        : 'WhatsApp not sent. Send "Hi" from your number to the business WhatsApp (or choose an alert template) and try again.';
  return new ApiResponse(200, { result }, message).send(res);
});

module.exports = { getSettings, updateSettings, pauseAI, resumeAI, sendDailyReportNow, sendTestAlert };
