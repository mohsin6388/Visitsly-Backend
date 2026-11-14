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
    lines: ['Jab bhi koi lead HOT hogi ya site visit book/confirm hogi, aapko isi tarah WhatsApp par turant message aayega.'],
    link: '/settings',
    templateValues: ['Test lead', '-', '-', '100', 'Test alert'],
  });
  const ok = result.whatsapp.some((r) => r.ok);
  const anyNumber = result.whatsapp.length > 0;
  const message = ok
    ? 'Test alert WhatsApp par bhej diya — apna WhatsApp check karein.'
    : !anyNumber
      ? 'Alert number set nahi hai — upar apna WhatsApp number daal kar save karein.'
      : result.email?.ok
        ? 'WhatsApp nahi gaya (24 ghante ka window band hai), isliye email par bheja. Apne number se business WhatsApp par "Hi" bhejiye ya alert template chuniye.'
        : 'WhatsApp nahi gaya. Apne number se business WhatsApp number par "Hi" bhejiye (ya alert template chuniye) aur dobara try karein.';
  return new ApiResponse(200, { result }, message).send(res);
});

module.exports = { getSettings, updateSettings, pauseAI, resumeAI, sendDailyReportNow, sendTestAlert };
