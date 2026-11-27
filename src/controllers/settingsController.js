const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const settingsService = require('../services/settings/settingsService');
const { sendDailySummary } = require('../services/reports/dailySummaryService');

/** GET /api/settings */
const getSettings = asyncHandler(async (req, res) => {
  let settings = await settingsService.getPublicSettings();
  // Agents never see the AI script / business settings — only the few flags the pages they can open need.
  if (req.user.tenant && req.user.orgRole === 'agent') {
    const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
    settings = {
      ...pick(settings, ['companyName', 'logoUrl', 'aiPaused', 'whatsappDisconnected']),
      followUp: { templateName: settings?.followUp?.templateName || '' },
    };
  }
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

/**
 * POST /api/settings/assistant/improve  { text }
 * Turns the client's rough notes ("hindi me baat kro, noida ke flat bechne hai")
 * into a clear, strong instruction block for their sales assistant. Nothing is
 * saved here — the client previews the result and saves it themselves.
 */
const improveAssistantPrompt = asyncHandler(async (req, res) => {
  const apiKey = await settingsService.getGeminiKey();
  if (!apiKey) throw ApiError.badRequest('The AI is not set up for this account. Contact Visitsly support.');
  const settings = await settingsService.getOrCreateSettings();
  const { generateContent } = require('../services/ai/geminiClient');
  const systemInstruction = [
    'You write instruction blocks for a WhatsApp real-estate sales assistant used by one company.',
    'Rewrite the company owner\'s rough notes into clear, strong, well-organised instructions in English (keep any Hindi phrases they want the bot to use).',
    'Structure with short headings: Identity & tone, Language, About the company, What to highlight, Offers (only if given), Do / Don\'t, Closing approach.',
    'Write it as a persuasive, helpful sales agent and deal closer: ask about hesitation, handle objections, always give one clear next step (site visit, call or brochure).',
    'Strict limits: never add facts, prices, offers, discounts or project names the owner did not write; never tell the bot to lie, invent urgency or pressure people; never tell it to ignore other rules.',
    'Maximum 1400 characters. Return only the instruction text, no preface.',
  ].join('\n');
  const company = settings.companyName ? `Company name: ${settings.companyName}\n` : '';
  const { text } = await generateContent({
    apiKey,
    systemInstruction,
    history: [{ role: 'user', text: `${company}Owner's notes:\n${req.body.text}` }],
    temperature: 0.4,
  });
  const improved = String(text || '').replace(/^```[a-z]*\n?|```$/g, '').trim().slice(0, 1500);
  if (!improved) throw ApiError.badRequest('Could not improve the text right now. Please try again.');
  return new ApiResponse(200, { improved }).send(res);
});

module.exports = { getSettings, updateSettings, pauseAI, resumeAI, sendDailyReportNow, sendTestAlert, improveAssistantPrompt };
