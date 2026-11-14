const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");
const Meeting = require("../../models/Meeting");
const Notification = require("../../models/Notification");
const OutboundJob = require("../../models/OutboundJob");
const Property = require("../../models/Property");

const settingsService = require("../settings/settingsService");
const metaWhatsappClient = require("../whatsapp/metaWhatsappClient");
const { recordOutboundMessage } = require("../whatsapp/messageStore");
const { matchProperties } = require("./propertyMatcher");
const { generateStructured } = require("./geminiClient");
const {
  buildSystemInstruction,
  REPLY_RESPONSE_SCHEMA,
  toGeminiHistory,
} = require("./promptBuilder");
const { analyzeConversationAsync } = require("./leadAnalyzer");
const { attachSiteBrochure } = require("../sites/siteBrochure");
const {
  createCalendarEvent,
  updateCalendarEvent,
} = require("../calendar/googleCalendarService");
const { enqueueLeads } = require("../queue/outboundQueue");
const env = require("../../config/env");
const tenantContext = require("../../context/tenantContext");
const openingTemplateService = require("../whatsapp/openingTemplateService");
const { emitToUser } = require("../../sockets");
const logger = require("../../utils/logger");

// Recent messages sent verbatim as context. Older context is carried by the
// rolling `conversation.memory` + AI summary + collected requirements, so the
// AI remembers a buyer who comes back days later without blowing the token budget.
const HISTORY_LIMIT = Number(process.env.AI_HISTORY_LIMIT) || 30;

/* ------------------------------------------------------------------ */
/* Language lock + long-term memory                                    */
/* ------------------------------------------------------------------ */
const LANGUAGE_ALIASES = [
  ["Hinglish", /^(hinglish|roman hindi)$/i],
  ["English", /^(english|eng|angrezi|inglish|en)$/i],
  ["Hindi", /^(hindi|हिंदी|हिन्दी|hin)$/i],
  ["Bangla", /^(bangla|bengali|বাংলা)$/i],
  ["Arabic", /^(arabic|عربي|العربية)$/i],
  ["Urdu", /^(urdu|اردو)$/i],
  ["Marathi", /^(marathi|मराठी)$/i],
  ["Gujarati", /^(gujarati|ગુજરાતી)$/i],
  ["Punjabi", /^(punjabi|ਪੰਜਾਬੀ)$/i],
  ["Tamil", /^(tamil|தமிழ்)$/i],
  ["Telugu", /^(telugu|తెలుగు)$/i],
  ["Kannada", /^(kannada|ಕನ್ನಡ)$/i],
  ["Malayalam", /^(malayalam|മലയാളം)$/i],
];

function normalizeLanguage(value) {
  const v = String(value || "").trim().toLowerCase().replace(/[.!🙂😊]+$/g, "").trim();
  if (!v) return null;
  for (const [name, re] of LANGUAGE_ALIASES) if (re.test(v)) return name;
  // "english please", "in english", "hindi me baat karo"
  for (const [name, re] of LANGUAGE_ALIASES) {
    const word = re.source.replace(/^\^\(|\)\$$/g, "").split("|")[0];
    if (new RegExp(`\\b${word}\\b`, "i").test(v)) return name;
  }
  return null;
}

/** A short reply that is just a language choice, or an explicit request to switch. */
function languageFromMessage(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (t.length <= 25) {
    const direct = normalizeLanguage(t.replace(/\b(please|plz|pls|me|mein|main|in|only|language|bhasha)\b/gi, "").trim());
    if (direct) return direct;
  }
  const m = t.match(/\b(english|hindi|hinglish|bangla|bengali|arabic|urdu|marathi|gujarati|punjabi|tamil|telugu|kannada|malayalam)\b\s*(me|mein|main|mai|in)?\s*(baat|bat|reply|bolo|likho|karo|kro|talk|speak|chat|please|plz)/i)
    || t.match(/\b(speak|talk|reply|chat|write|continue)\b[^.?!]{0,20}\b(english|hindi|hinglish|bangla|bengali|arabic|urdu|marathi|gujarati|punjabi|tamil|telugu|kannada|malayalam)\b/i);
  if (m) return normalizeLanguage(m[1] && !/^(speak|talk|reply|chat|write|continue)$/i.test(m[1]) ? m[1] : m[2]);
  return null;
}

function languageRule(language) {
  if (!language) {
    return "LANGUAGE: Reply in the same language and script the customer is using in their latest message.";
  }
  const extra = {
    English: 'Write the ENTIRE reply in natural, simple English. Do NOT use Hindi/Hinglish words such as "aap", "hai", "ji", "kya", "haan", "nahi", "bataiye", "karein". The Hinglish examples in this prompt only show behaviour, not language.',
    Hindi: "Write the reply in simple Hindi. If the customer writes Hindi in Roman letters, reply in Roman Hindi; if they use Devanagari, reply in Devanagari.",
    Hinglish: "Write the reply in natural Roman-script Hinglish (Hindi + English mix), like a friendly Indian sales consultant on WhatsApp.",
  }[language] || `Write the ENTIRE reply in ${language}. Do not switch to English or Hinglish.`;
  return `LANGUAGE LOCK — the customer chose ${language}. ${extra} Keep using ${language} in every reply until the customer clearly asks to change the language. Never ask which language they prefer again.`;
}

function istNow() {
  const d = new Date(Date.now() + 330 * 60000);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return { date: d.toISOString().slice(0, 10), day: days[d.getUTCDay()], time: d.toISOString().slice(11, 16) };
}

function humanGap(ms) {
  const h = ms / 3600000;
  if (h < 24) return `${Math.round(h)} ghante`;
  const d = Math.round(h / 24);
  return `${d} din`;
}

/** Extra system-prompt block: today's date, language lock, memory, returning-customer note. */
function buildContextBlock({ conversation, lead, language, recentMessages }) {
  const now = istNow();
  const inbound = recentMessages.filter((m) => m.direction === "inbound");
  const prevInbound = inbound.length >= 2 ? inbound[inbound.length - 2] : null;
  const gapMs = prevInbound ? Date.now() - new Date(prevInbound.timestamp).getTime() : 0;
  const req = conversation.collectedRequirements || {};
  const known = [
    lead.name && !/^whatsapp\s/i.test(lead.name) && `Name: ${lead.name}`,
    req.bhk && `BHK: ${req.bhk}`,
    req.propertyType && `Type: ${req.propertyType}`,
    (req.budgetMin != null || req.budgetMax != null) && `Budget: ${req.budgetMin ?? "?"} - ${req.budgetMax ?? "?"}`,
    req.city && `City: ${req.city}`,
    req.location && `Location: ${req.location}`,
    req.projectName && `Project discussed: ${req.projectName}`,
    req.purpose && `Purpose: ${req.purpose}`,
    req.timeline && `Timeline: ${req.timeline}`,
    conversation.meetingStatus && conversation.meetingStatus !== "none" && `Site visit status: ${conversation.meetingStatus}`,
  ].filter(Boolean);

  const lines = [
    "",
    "==================================================",
    "FINAL HARD RULES (highest priority — override any example above)",
    "==================================================",
    `TODAY (India time): ${now.date}, ${now.day}, ${now.time}. Use this to understand "aaj", "kal", "parso", "next Sunday" and NEVER suggest a past date or time.`,
    languageRule(language),
  ];
  const memory = String(conversation.memory || conversation.aiSummary || "").trim();
  if (memory || known.length) {
    lines.push(
      "",
      "LONG-TERM MEMORY (from earlier chats with this same customer — you already know this, NEVER ask it again):",
      ...(memory ? [memory.slice(0, 1200)] : []),
      ...known.map((k) => `- ${k}`),
    );
  }
  if (gapMs > 6 * 3600 * 1000) {
    lines.push(
      "",
      `RETURNING CUSTOMER: their previous message was about ${humanGap(gapMs)} ago. Do NOT restart the conversation, do NOT greet as if new, do NOT ask the language or requirements again. Briefly welcome them back (one short phrase at most) and continue exactly from where the chat left off, answering their latest message.`,
    );
  }
  lines.push(
    "",
    "STYLE: Short WhatsApp-style replies (1-4 short lines). Ask at most ONE question per reply. Be warm and human.",
  );
  return lines.join("\n");
}

/**
 * Sends a photo / brochure and records it in the chat, so whatever the AI
 * sends (property photos, brochures) is visible in the AI inbox too.
 */
function mediaSender(conversation, lead) {
  const record = (type, media, caption, messageId) =>
    recordOutboundMessage({
      conversationId: conversation._id,
      leadId: lead._id,
      text: caption || "",
      sender: "ai",
      type,
      media,
      whatsappMessageId: messageId || null,
      ownerId: conversation.ownerId,
    }).catch((err) => logger.warn("[ai] could not record media message", { error: err.message }));
  return {
    async image({ phone, imageUrl, caption }) {
      const result = await metaWhatsappClient.sendImageMessage({ phone, imageUrl, caption });
      await record("image", { url: imageUrl, caption: caption || null }, caption, result.messageId);
      return result;
    },
    async document({ phone, documentUrl, filename, caption }) {
      const result = await metaWhatsappClient.sendDocumentMessage({ phone, documentUrl, filename, caption });
      await record("document", { url: documentUrl, filename: filename || null, mimeType: "application/pdf", caption: caption || null }, caption, result.messageId);
      return result;
    },
  };
}

function isBrochureRequest(text = "") {
  const normalized = String(text).toLowerCase().trim();

  const brochureKeywords = [
    "brochure",
    "pdf",
    "document",
    "brochure bhejo",
    "pdf bhejo",
    "brochure send",
    "pdf send",
    "brochure share",
    "pdf share",
  ];

  return brochureKeywords.some((keyword) => normalized.includes(keyword));
}

function isImageRequest(text = "") {
  const normalized = String(text).toLowerCase().trim();

  const imageKeywords = [
    "photo",
    "photos",
    "photo bhejo",
    "photos bhejo",
    "image",
    "images",
    "image bhejo",
    "images bhejo",
    "pic",
    "pics",
    "pics bhejo",
    "picture",
    "pictures",
    "property ki photo",
    "property ki photos",
    "property ki image",
    "property ki images",
    "property pics",
    "property photos",
  ];

  return imageKeywords.some((keyword) => normalized.includes(keyword));
}

function isSiteVisitRequest(text = "") {
  const normalized = String(text).toLowerCase().trim();

  // Explicit negative requests should NOT create a visit.
  const negativePatterns = [
    "site visit nahi",
    "visit nahi",
    "site visit cancel",
    "visit cancel",
    "don't want to visit",
    "do not want to visit",
    "not interested in visit",
  ];

  if (negativePatterns.some((pattern) => normalized.includes(pattern))) {
    return false;
  }

  const visitPatterns = [
    "site visit book",
    "site visit kar",
    "site visit schedule",
    "site visit arrange",
    "site visit chahiye",
    "site visit lena",
    "site visit ke liye",
    "site visit",
    "visit book",
    "visit karna hai",
    "visit karni hai",
    "visit schedule",
    "visit arrange",
    "property dekhne aana",
    "property dekhne jaana",
    "property dekhna hai",
    "ghar dekhne aana",
    "flat dekhne aana",
    "i want to visit",
    "want to visit",
    "book a visit",
    "schedule a visit",
    "arrange a visit",
    "book site visit",
  ];

  return visitPatterns.some((pattern) => normalized.includes(pattern));
}

/**
 * Counts one "AI conversation" per lead per calendar month against the
 * company's plan. Returns false when the AI must not reply.
 */
async function reserveAiConversation(conversation) {
  const tenantContext = require("../../context/tenantContext");
  const orgService = require("../saas/orgService");
  const { subscriptionState, checkLimit } = require("../saas/subscription");
  const org = tenantContext.getOrg();
  if (!org) return true; // legacy single-client mode

  if (!subscriptionState(org).active) {
    logger.info(
      `[ai] Subscription inactive for org ${org._id} — AI reply skipped`,
    );
    return false;
  }

  const month = orgService.currentMonthIST();
  if (conversation.aiBilledMonth === month) return true; // already counted this month

  const usage = orgService.usageFor(org);
  const limit = checkLimit(org, "aiConversations", usage.aiConversations, 1);
  if (!limit.ok) {
    logger.warn(
      `[ai] AI conversation limit reached for org ${org._id} (${limit.limit})`,
    );
    try {
      const start = new Date(`${month}-01T00:00:00+05:30`);
      const already = await Notification.findOne({
        userId: org.ownerUserId,
        type: "plan_limit",
        createdAt: { $gte: start },
      }).lean();
      if (!already) {
        await Notification.create({
          userId: org.ownerUserId,
          type: "plan_limit",
          title: "AI conversation limit poora ho gaya",
          body: `${limit.message} Naye chats mein AI reply ruk gaya hai, aap manually reply kar sakte hain.`,
          link: "/billing",
        });
      }
    } catch (err) {
      logger.warn("[ai] Could not create plan-limit notification", {
        error: err.message,
      });
    }
    return false;
  }

  const res = await Conversation.updateOne(
    { _id: conversation._id, aiBilledMonth: { $ne: month } },
    { $set: { aiBilledMonth: month } },
  );
  if (res.modifiedCount)
    await orgService.incrementUsage(org._id, "aiConversations", 1);
  conversation.aiBilledMonth = month;
  return true;
}

/**
 * Per-contact AI reply cap (plan limit `aiRepliesPerContact`). Once the AI has
 * sent that many replies to one contact it stays silent — the broker can still
 * reply by hand — and the owner is told to upgrade (notification + live event;
 * the chat screen shows the upgrade banner).
 */
async function announceAiLimit(conversation, lead, org, info) {
  try {
    const res = await Conversation.updateOne(
      { _id: conversation._id, aiLimitReachedAt: null },
      { $set: { aiLimitReachedAt: new Date() } },
    );
    emitToUser(conversation.ownerId, "conversation:aiLimit", {
      conversationId: conversation._id,
      leadId: lead?._id,
      ...info,
    });
    if (!res.modifiedCount) return; // already announced for this chat
    await Notification.create({
      userId: org.ownerUserId || conversation.ownerId,
      type: "ai_reply_limit",
      title: "Is contact ke liye AI reply limit poori ho gayi",
      body:
        `${lead?.name || "Is contact"} ko AI ne ${info.limit} replies de diye. AI ab reply nahi karega — ` +
        `aap chat mein jaakar khud reply kar sakte hain, ya plan upgrade karein.`,
      link: `/conversations?id=${conversation._id}`,
    });
  } catch (err) {
    logger.warn("[ai] Could not announce AI reply limit", {
      error: err.message,
    });
  }
}

/** True when the AI must NOT reply to this contact any more. */
async function aiReplyLimitReached(conversation, lead) {
  const org = require("../../context/tenantContext").getOrg();
  if (!org) return false; // legacy single-client mode
  const { aiReplyLimitInfo } = require("../saas/subscription");
  // Read the live count — two quick customer messages must not both slip through.
  const fresh = await Conversation.findById(conversation._id)
    .select("aiReplyCount aiLimitReachedAt")
    .lean();
  const info = aiReplyLimitInfo(
    org,
    fresh?.aiReplyCount ?? conversation.aiReplyCount,
  );
  if (info.reached) {
    logger.info(
      `[ai] Per-contact AI reply limit (${info.limit}) reached for lead ${lead._id} — AI reply skipped`,
    );
    await announceAiLimit(conversation, lead, org, info);
    return true;
  }
  // Limit was raised (plan upgrade) — clear the old marker so it can fire again later.
  if (fresh?.aiLimitReachedAt) {
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { aiLimitReachedAt: null } },
    );
  }
  return false;
}

/** Counts one AI reply for this contact; announces the limit the moment it is reached. */
async function registerAiReply(conversation, lead) {
  try {
    const updated = await Conversation.findOneAndUpdate(
      { _id: conversation._id },
      { $inc: { aiReplyCount: 1 } },
      { new: true },
    )
      .select("aiReplyCount")
      .lean();
    const org = require("../../context/tenantContext").getOrg();
    if (!org || !updated) return;
    const { aiReplyLimitInfo } = require("../saas/subscription");
    const info = aiReplyLimitInfo(org, updated.aiReplyCount);
    if (info.reached) await announceAiLimit(conversation, lead, org, info);
  } catch (err) {
    logger.warn("[ai] Could not count AI reply", { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Gemini poori tarah fail ho (saare models 503/429) tab bhi buyer ko chup
// nahi rehna chahiye. Ek chhota "hold" message bhejte hain (per conversation
// max 1 baar / 2 min) taaki spam na ho. Band karne ke liye:
//   AI_FALLBACK_REPLY_ENABLED=false
// ---------------------------------------------------------------------------
const AI_FALLBACK_REPLY_ENABLED =
  String(process.env.AI_FALLBACK_REPLY_ENABLED || "true").toLowerCase() !==
  "false";
const AI_FALLBACK_REPLY_TEXT =
  process.env.AI_FALLBACK_REPLY_TEXT ||
  "Aapka message mil gaya hai 🙏 Ek minute me aapko details ke saath reply karte hain.";
const AI_FALLBACK_COOLDOWN_MS = 2 * 60 * 1000;
const lastFallbackAt = new Map(); // conversationId -> timestamp

async function sendAiFallbackReply({ conversation, lead }) {
  if (!AI_FALLBACK_REPLY_ENABLED) return;

  const key = String(conversation._id);
  const last = lastFallbackAt.get(key) || 0;
  if (Date.now() - last < AI_FALLBACK_COOLDOWN_MS) return;
  lastFallbackAt.set(key, Date.now());

  try {
    const { messageId } = await metaWhatsappClient.sendToLead({
      phone: lead.phone,
      text: AI_FALLBACK_REPLY_TEXT,
    });
    await recordOutboundMessage({
      conversationId: conversation._id,
      leadId: lead._id,
      text: AI_FALLBACK_REPLY_TEXT,
      sender: "ai",
      whatsappMessageId: messageId || null,
    });
  } catch (err) {
    logger.error(`[ai] Fallback reply failed for lead ${lead._id}`, {
      error: err.message,
    });
  }
}

async function handleInbound({ conversation, lead, message }) {
  // Even when the AI does not reply (manual takeover, paused AI, no key),
  // the customer's reply must still be scored so lead rules keep working.
  const scoreOnly = () =>
    analyzeConversationAsync({
      leadId: lead._id,
      conversationId: conversation._id,
    }).catch((err) =>
      logger.error(`[ai] Lead scoring failed for lead ${lead._id}`, {
        error: err.message,
      }),
    );

  // Manual takeover, closed chat or customer opted out — no AI reply.
  if (
    conversation.status === "manual" ||
    conversation.status === "closed" ||
    conversation.optedOut
  )
    return scoreOnly();

  const settings = await settingsService.getOrCreateSettings();
  if (settings.aiPaused || !settings.autoReplyEnabled) return scoreOnly();
  if (settings.whatsappDisconnected) return scoreOnly(); // broker hit "Disconnect" on the Settings page

  const apiKey = await settingsService.getGeminiKey();
  if (!apiKey) {
    logger.warn(
      `[ai] No Gemini API key configured — skipping AI reply for lead ${lead._id}`,
    );
    return scoreOnly();
  }

  // SaaS: per-contact AI reply cap (e.g. trial = 15 replies per contact).
  // After that the AI stays silent; scoring still happens.
  if (await aiReplyLimitReached(conversation, lead)) return scoreOnly();

  // SaaS: no AI replies when the company's subscription is inactive or its
  // monthly AI-conversation quota is used up (scoring still happens).
  if (!(await reserveAiConversation(conversation))) return scoreOnly();

  const recentMessages = await Message.find({
    conversationId: conversation._id,
  })
    .sort({ timestamp: -1 })
    .limit(HISTORY_LIMIT)
    .lean();
  recentMessages.reverse(); // oldest -> newest for the model

  // Pull in any properties that already look like a fit given what we know
  // so far, so the model can reference them by name instead of inventing details.

  // const requirements = conversation.collectedRequirements || {};
  const requirements = conversation.collectedRequirements || {};

  // Internal media-pending context ko Gemini ke customer context mein mat bhejo.
  const aiRequirements = { ...requirements };
  delete aiRequirements.__pendingBrochure;

  const currentMessage = message?.text || "";

  const candidateProperties = await matchProperties({
    query: currentMessage,

    city: requirements.city || lead.city,
    location: requirements.location || lead.location,

    projectName: requirements.projectName,

    budgetMin: requirements.budgetMin ?? lead.budgetMin,
    budgetMax: requirements.budgetMax ?? lead.budgetMax,

    bhk: requirements.bhk,
    propertyType: requirements.propertyType,
    amenities: requirements.amenities || [],
  });

  // Language: explicit choice / switch in the latest message wins, then the
  // stored lock. Persisted so it survives days of silence.
  const chosenLanguage = languageFromMessage(currentMessage);
  if (chosenLanguage && chosenLanguage !== conversation.language) {
    conversation.language = chosenLanguage;
    conversation.languageLockedAt = new Date();
    aiRequirements.language = chosenLanguage;
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { language: chosenLanguage, languageLockedAt: conversation.languageLockedAt } },
    ).catch(() => {});
  }
  const lockedLanguage = conversation.language || normalizeLanguage(requirements.language) || null;
  if (lockedLanguage) aiRequirements.language = lockedLanguage;

  const baseInstruction = buildSystemInstruction({
    lead,
    settings,
    collectedRequirements: aiRequirements,
    matchedProperties: candidateProperties,
    currentMessage,

    referralStatus: conversation.referralStatus || "none",

    referralPersonName:
      settings.referral?.personName || env.referral.personName,
  });
  const systemInstruction = `${baseInstruction}\n${buildContextBlock({
    conversation,
    lead,
    language: lockedLanguage,
    recentMessages,
  })}`;

  let result;
  try {
    result = await generateStructured({
      apiKey,
      systemInstruction,
      history: toGeminiHistory(recentMessages),
      responseSchema: REPLY_RESPONSE_SCHEMA,
    });
  } catch (err) {
    logger.error(`[ai] Gemini reply generation failed for lead ${lead._id}`, {
      error: err.message,
    });
    // Saare Gemini models fail — buyer ko "hold" message bhejo, broker
    // Conversations page se manually bhi reply kar sakta hai.
    await sendAiFallbackReply({ conversation, lead });
    return;
  }

  const { parsed, raw } = result;

  // Merge newly extracted requirements into what we already knew (never overwrite with blanks).
  const mergedRequirements = mergeRequirements(requirements, {
    ...(parsed.extractedRequirements || {}),
    purpose: parsed.purpose || undefined,
    timeline: parsed.timeline || undefined,
    budgetText: parsed.budget || undefined,
    propertyTypeText: parsed.property_type || undefined,
    locationText: parsed.location_preference || undefined,
  });
  // The model reports the language it detected/was told; lock it if we had none.
  if (!conversation.language) {
    const detected = normalizeLanguage(parsed.preferred_language);
    if (detected) {
      conversation.language = detected;
      conversation.languageLockedAt = new Date();
    }
  }
  if (conversation.language) mergedRequirements.language = conversation.language;
  // Better name than the WhatsApp placeholder → update the lead.
  if (parsed.name && /^whatsapp\s/i.test(lead.name || "") && String(parsed.name).trim().length >= 2) {
    await Lead.updateOne({ _id: lead._id }, { $set: { name: String(parsed.name).trim().slice(0, 120) } }).catch(() => {});
  }
  conversation.collectedRequirements = mergedRequirements;
  conversation.lastIntent = parsed.intent;
  conversation.lastSentiment = parsed.sentiment;
  if (candidateProperties.length) {
    // Overwrite, not append — recommendedProperties always reflects the
    // CURRENT recommendation set, not a running history of everything ever
    // suggested. See Conversation model notes.
    conversation.recommendedProperties = candidateProperties.map((p) => p._id);
  }

  // Referral/handoff closing step ("kya aap Monica ko apne kaam ke liye
  // lena chahenge?"). The AI only ever DECIDES the stage transition
  // (referralStage) — the actual phone number is appended here, by code,
  // so it's always the real configured number and never something the LLM
  // could get wrong or hallucinate.
  let outboundText = parsed.reply;
  const referralPersonName =
    settings.referral?.personName || env.referral.personName;
  const referralContactNumber =
    settings.referral?.contactNumber || env.referral.contactNumber;
  const referralEnabled = settings.referral?.enabled ?? env.referral.enabled;

  if (
    referralEnabled &&
    conversation.referralStatus === "none" &&
    parsed.referralStage === "ask_now"
  ) {
    conversation.referralStatus = "asked";
    conversation.referralAskedAt = new Date();
  } else if (
    conversation.referralStatus === "asked" &&
    parsed.referralStage === "accepted"
  ) {
    conversation.referralStatus = "accepted";
    conversation.referralRespondedAt = new Date();
    if (referralContactNumber) {
      outboundText = `${parsed.reply}\n\n${referralPersonName} ka number: ${referralContactNumber}\nAap directly WhatsApp/call kar sakte hain 🙂`;
    } else {
      logger.warn(
        `[ai] Referral accepted for lead ${lead._id} but no referral contact number is configured (set REFERRAL_CONTACT_NUMBER or Settings.referral.contactNumber)`,
      );
    }
  } else if (
    conversation.referralStatus === "asked" &&
    parsed.referralStage === "declined"
  ) {
    conversation.referralStatus = "declined";
    conversation.referralRespondedAt = new Date();
  }

  // Mirror the key fields back onto Lead so existing list/filter/CSV export UI stays useful.
  const leadUpdates = {};
  if (mergedRequirements.city) leadUpdates.city = mergedRequirements.city;
  if (mergedRequirements.location)
    leadUpdates.location = mergedRequirements.location;
  if (mergedRequirements.budgetMin != null)
    leadUpdates.budgetMin = mergedRequirements.budgetMin;
  if (mergedRequirements.budgetMax != null)
    leadUpdates.budgetMax = mergedRequirements.budgetMax;
  if (Object.keys(leadUpdates).length) {
    await Lead.updateOne({ _id: lead._id }, { $set: leadUpdates });
  }

  // Small human-like "typing" pause before sending — kept tight at 3-4s
  // (randomized so every reply doesn't land at the exact same delay) rather
  // than the old 2/5/10s Settings dropdown, which could feel too slow.
  const replyDelayMs = 500 + Math.floor(Math.random() * 500); // 3000-4000ms
  await new Promise((resolve) => setTimeout(resolve, replyDelayMs));

  // Send the reply out through the Meta WhatsApp Cloud API. This is always a
  // free-text send here — an inbound customer message is exactly what opens
  // the 24h customer service window in the first place, so we're always
  // inside it at this point.
  let outbound;
  try {
    const { messageId } = await metaWhatsappClient.sendToLead({
      phone: lead.phone,
      text: outboundText,
    });

    outbound = await recordOutboundMessage({
      conversationId: conversation._id,
      leadId: lead._id,
      text: outboundText,
      sender: "ai",
      whatsappMessageId: messageId || null,
      aiPrompt: systemInstruction,
      aiResponseRaw: raw,
      intent: parsed.intent,
      sentiment: parsed.sentiment,
      ownerId: conversation.ownerId,
    });

    // Count this reply against the per-contact cap (15th reply => upgrade prompt).
    await registerAiReply(conversation, lead);

    // A photo/PDF the CUSTOMER sent is not a request for our brochure/photos.
    const customerSentMedia = ["image", "video", "audio", "document", "sticker", "location", "contacts"].includes(message?.type);
    const wantsBrochure = !customerSentMedia && isBrochureRequest(currentMessage);
    const wantsImages = !customerSentMedia && isImageRequest(currentMessage);

    const normalizedCurrentMessage = String(currentMessage)
      .toLowerCase()
      .trim();

    /*
     * Positive confirmation:
     * Example:
     * "haan"
     * "yes"
     * "haan bhejo"
     * "send it"
     * "send"
     */
    const isPositiveConfirmation = [
      "haan",
      "ha",
      "yes",
      "y",
      "ok",
      "okay",
      "sure",
      "send",
      "send it",
      "bhejo",
      "bhej do",
      "share",
      "share it",
      "yes please",
      "haan bhejo",
      "haan send karo",
      "haan share karo",
    ].some((phrase) => {
      return (
        normalizedCurrentMessage === phrase ||
        normalizedCurrentMessage.startsWith(`${phrase} `)
      );
    });

    /*
     * Last explicitly mentioned/recommended property.
     */
    let lastRecommendedProperty = null;

    if (Array.isArray(conversation.recommendedProperties)) {
      const lastPropertyId =
        conversation.recommendedProperties[
          conversation.recommendedProperties.length - 1
        ];

      if (lastPropertyId) {
        try {
          lastRecommendedProperty = await Property.findById(lastPropertyId);
        } catch (err) {
          logger.warn("[ai] Failed to load last recommended property", {
            propertyId: lastPropertyId,
            error: err.message,
          });
        }
      }
    }

    /*
     * Try to identify property from current message.
     *
     * Priority:
     * 1. Gemini property_reference
     * 2. Exact project name mentioned in message
     * 3. Last recommended property
     */
    let requestedProperty = null;

    /*
     * 1. Gemini structured property reference
     */
    if (parsed?.property_reference) {
      const propertyReference = String(parsed.property_reference)
        .trim()
        .toLowerCase();

      requestedProperty =
        candidateProperties.find(
          (property) =>
            property?.projectName &&
            property.projectName.toLowerCase() === propertyReference,
        ) || null;
    }

    /*
     * 2. Exact project name from current message
     */
    if (!requestedProperty && normalizedCurrentMessage) {
      requestedProperty =
        candidateProperties.find((property) => {
          if (!property?.projectName) return false;

          return normalizedCurrentMessage.includes(
            property.projectName.toLowerCase(),
          );
        }) || null;
    }

    /*
     * Also check all candidate properties in case the requested
     * property isn't inside the current top-ranked result.
     */
    if (!requestedProperty && normalizedCurrentMessage) {
      try {
        requestedProperty =
          (await Property.findOne({
            isActive: true,
            projectName: {
              $regex: normalizedCurrentMessage,
              $options: "i",
            },
          })) || null;
      } catch (err) {
        logger.warn("[ai] Failed to find property by project name", {
          error: err.message,
        });
      }
    }

    /*
     * 3. If user didn't explicitly mention a property,
     * use the last recommended property.
     */
    if (!requestedProperty && lastRecommendedProperty) {
      requestedProperty = lastRecommendedProperty;
    }

    // Each site keeps its own brochure (Properties → Sites & brochures):
    // make sure we send this project's brochure, not a stale unit-row copy.
    if (requestedProperty) await attachSiteBrochure(requestedProperty);

    /*
     * Pending brochure context.
     *
     * This is used when:
     *
     * User:
     * "Ivory ka brochure bhejo"
     *
     * Ivory brochure unavailable.
     *
     * Assistant:
     * "Mere paas Palm Premiere ka brochure available hai.
     *  Chahiye?"
     *
     * User:
     * "haan"
     *
     * Then we send Palm Premiere brochure.
     */
    const pendingBrochure = requirements.__pendingBrochure || null;

    /*
     * ---------------------------------------------------------
     * HANDLE POSITIVE CONFIRMATION FOR PENDING BROCHURE
     * ---------------------------------------------------------
     */
    if (isPositiveConfirmation && pendingBrochure?.propertyId) {
      try {
        const pendingProperty = await Property.findById(
          pendingBrochure.propertyId,
        );
        if (pendingProperty) await attachSiteBrochure(pendingProperty);

        if (pendingProperty?.brochureUrl) {
          try {
            const brochureResult = await mediaSender(conversation, lead).document(
              {
                phone: lead.phone,
                documentUrl: pendingProperty.brochureUrl,
                filename:
                  pendingProperty.brochureName ||
                  `${pendingProperty.projectName || "property"}-brochure.pdf`,
                caption: `${pendingProperty.projectName || "Property"} ka brochure 📄`,
              },
            );

            logger.info(`[ai] Pending brochure sent to lead ${lead._id}`, {
              propertyId: pendingProperty._id,
              projectName: pendingProperty.projectName,
              messageId: brochureResult.messageId,
            });
          } catch (err) {
            logger.error(
              `[ai] Failed to send pending brochure to lead ${lead._id}`,
              {
                propertyId: pendingProperty._id,
                error: err.metaError || err.response?.data || err.message,
              },
            );
          }
        } else {
          logger.info(`[ai] Pending brochure is no longer available`, {
            leadId: lead._id,
            propertyId: pendingBrochure.propertyId,
          });
        }
      } catch (err) {
        logger.error(`[ai] Failed to load pending brochure property`, {
          leadId: lead._id,
          propertyId: pendingBrochure.propertyId,
          error: err.message,
        });
      }

      /*
       * Clear pending brochure after confirmation.
       */
      const updatedRequirements = {
        ...requirements,
      };

      delete updatedRequirements.__pendingBrochure;

      conversation.collectedRequirements = updatedRequirements;

      await conversation.save();
    } else if (wantsBrochure || wantsImages) {
      /*
       * ---------------------------------------------------------
       * HANDLE EXPLICIT MEDIA REQUEST
       * ---------------------------------------------------------
       */
      /*
       * If no property could be identified,
       * don't randomly send another property's media.
       */
      if (!requestedProperty) {
        logger.info(
          `[ai] Media requested but property could not be identified`,
          {
            leadId: lead._id,
            wantsBrochure,
            wantsImages,
          },
        );
      } else {
        const property = requestedProperty;

        const hasImages =
          Array.isArray(property.images) && property.images.length > 0;

        const hasBrochure = !!property.brochureUrl;

        /*
         * -------------------------------------------------------
         * BOTH BROCHURE + IMAGES REQUESTED
         * -------------------------------------------------------
         */
        if (wantsBrochure && wantsImages) {
          /*
           * Send images if available.
           */
          if (hasImages) {
            for (let i = 0; i < property.images.length; i++) {
              try {
                const imageResult = await mediaSender(conversation, lead).image({
                  phone: lead.phone,
                  imageUrl: property.images[i],
                  caption:
                    i === 0
                      ? `${property.projectName || "Property"} ki photos 🏠`
                      : undefined,
                });

                logger.info(`[ai] Property image sent to lead ${lead._id}`, {
                  propertyId: property._id,
                  projectName: property.projectName,
                  imageNumber: i + 1,
                  messageId: imageResult.messageId,
                });
              } catch (err) {
                logger.error(
                  `[ai] Failed to send property image to lead ${lead._id}`,
                  {
                    propertyId: property._id,
                    imageNumber: i + 1,
                    error: err.metaError || err.response?.data || err.message,
                  },
                );
              }
            }
          }

          /*
           * Send brochure only if it actually exists.
           */
          if (hasBrochure) {
            try {
              const brochureResult =
                await mediaSender(conversation, lead).document({
                  phone: lead.phone,
                  documentUrl: property.brochureUrl,
                  filename:
                    property.brochureName ||
                    `${property.projectName || "property"}-brochure.pdf`,
                  caption: `${property.projectName || "Property"} ka brochure 📄`,
                });

              logger.info(`[ai] Brochure sent to lead ${lead._id}`, {
                propertyId: property._id,
                projectName: property.projectName,
                messageId: brochureResult.messageId,
              });
            } catch (err) {
              logger.error(`[ai] Failed to send brochure to lead ${lead._id}`, {
                propertyId: property._id,
                error: err.metaError || err.response?.data || err.message,
              });
            }
          }

          /*
           * Nothing available.
           */
          if (!hasImages && !hasBrochure) {
            logger.info(`[ai] Neither images nor brochure available`, {
              leadId: lead._id,
              propertyId: property._id,
              projectName: property.projectName,
            });
          }
        } else if (wantsImages) {
          /*
           * -------------------------------------------------------
           * ONLY IMAGES REQUESTED
           * -------------------------------------------------------
           */
          /*
           * IMPORTANT:
           * No brochure fallback here.
           */
          if (hasImages) {
            for (let i = 0; i < property.images.length; i++) {
              try {
                const imageResult = await mediaSender(conversation, lead).image({
                  phone: lead.phone,
                  imageUrl: property.images[i],
                  caption:
                    i === 0
                      ? `${property.projectName || "Property"} ki photos 🏠`
                      : undefined,
                });

                logger.info(`[ai] Property image sent to lead ${lead._id}`, {
                  propertyId: property._id,
                  projectName: property.projectName,
                  imageNumber: i + 1,
                  messageId: imageResult.messageId,
                });
              } catch (err) {
                logger.error(
                  `[ai] Failed to send property image to lead ${lead._id}`,
                  {
                    propertyId: property._id,
                    imageNumber: i + 1,
                    error: err.metaError || err.response?.data || err.message,
                  },
                );
              }
            }
          } else {
            logger.info(`[ai] Images requested but not available`, {
              leadId: lead._id,
              propertyId: property._id,
              projectName: property.projectName,
            });
          }
        } else if (wantsBrochure) {
          /*
           * -------------------------------------------------------
           * ONLY BROCHURE REQUESTED
           * -------------------------------------------------------
           */
          /*
           * Brochure exists -> send it.
           */
          if (hasBrochure) {
            try {
              const brochureResult =
                await mediaSender(conversation, lead).document({
                  phone: lead.phone,
                  documentUrl: property.brochureUrl,
                  filename:
                    property.brochureName ||
                    `${property.projectName || "property"}-brochure.pdf`,
                  caption: `${property.projectName || "Property"} ka brochure 📄`,
                });

              logger.info(`[ai] Brochure sent to lead ${lead._id}`, {
                propertyId: property._id,
                projectName: property.projectName,
                messageId: brochureResult.messageId,
              });
            } catch (err) {
              logger.error(`[ai] Failed to send brochure to lead ${lead._id}`, {
                propertyId: property._id,
                projectName: property.projectName,
                error: err.metaError || err.response?.data || err.message,
              });
            }
          } else {
            /*
             * Requested property's brochure is NOT available.
             *
             * IMPORTANT:
             * Do NOT send another property's brochure automatically.
             *
             * Instead find an alternate property with brochure
             * and ask the user first.
             */
            let alternateProperty = null;

            try {
              alternateProperty =
                (await Property.findOne({
                  isActive: true,
                  brochureUrl: {
                    $exists: true,
                    $ne: null,
                  },
                  _id: {
                    $ne: property._id,
                  },
                })) || null;
            } catch (err) {
              logger.warn(`[ai] Failed to find alternate brochure property`, {
                error: err.message,
              });
            }

            // Also look at sites that have their own brochure.
            if (!alternateProperty) {
              try {
                const PropertySite = require("../../models/PropertySite");
                const site = await PropertySite.findOne({
                  "brochures.0": { $exists: true },
                  nameKey: { $ne: PropertySite.keyFor(property.projectName) },
                  ...(property.ownerId ? { ownerId: property.ownerId } : {}),
                }).lean();
                if (site) {
                  const escaped = site.name.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    "\\$&",
                  );
                  alternateProperty = await Property.findOne({
                    isActive: true,
                    projectName: new RegExp(`^\\s*${escaped}\\s*$`, "i"),
                  });
                }
              } catch (err) {
                logger.warn(`[ai] Failed to find alternate site brochure`, {
                  error: err.message,
                });
              }
            }

            if (alternateProperty) {
              const mergedRequirements = {
                ...requirements,
              };

              mergedRequirements.__pendingBrochure = {
                propertyId: alternateProperty._id,
                projectName: alternateProperty.projectName,
                requestedPropertyId: property._id,
                requestedPropertyName: property.projectName,
                createdAt: new Date().toISOString(),
              };

              conversation.collectedRequirements = mergedRequirements;

              await conversation.save();

              /*
               * Send asking message.
               */
              const alternateMessage =
                `Mere paas abhi ${property.projectName || "is property"} ka brochure available nahi hai. ` +
                `Mere paas ${alternateProperty.projectName || "ek aur property"} ka brochure available hai. ` +
                `Kya main woh bhej doon?`;

              try {
                const textResult = await metaWhatsappClient.sendToLead({
                  phone: lead.phone,
                  text: alternateMessage,
                });

                await recordOutboundMessage({
                  conversationId: conversation._id,
                  leadId: lead._id,
                  text: alternateMessage,
                  sender: "ai",
                  whatsappMessageId: textResult?.messageId || null,
                  ownerId: conversation.ownerId,
                });

                logger.info(
                  `[ai] Asked permission before sending alternate brochure`,
                  {
                    leadId: lead._id,
                    requestedPropertyId: property._id,
                    requestedPropertyName: property.projectName,
                    alternatePropertyId: alternateProperty._id,
                    alternatePropertyName: alternateProperty.projectName,
                  },
                );
              } catch (err) {
                logger.error(
                  `[ai] Failed to ask permission for alternate brochure`,
                  {
                    leadId: lead._id,
                    error: err.metaError || err.response?.data || err.message,
                  },
                );
              }
            } else {
              logger.info(
                `[ai] Requested brochure unavailable and no alternate brochure found`,
                {
                  leadId: lead._id,
                  propertyId: property._id,
                  projectName: property.projectName,
                },
              );
            }
          }
        }
      }
    }

  } catch (err) {
    logger.error(
      `[ai] Failed to send AI reply for lead ${lead._id} via Meta WhatsApp Cloud API`,
      { error: err.response?.data || err.message },
    );
    await Notification.create({
      userId: conversation.ownerId,
      type: "whatsapp_send_failed",
      title: `Couldn't message ${lead.name || "lead"} — WhatsApp send failed`,
      body: `Sending via WhatsApp failed for ${lead.phone}: ${err.message}`,
      link: `/leads/${lead._id}`,
    });
    emitToUser(conversation.ownerId, "notification:new", { leadId: lead._id });
    return;
  }

  // Buyer just agreed to a site visit — create it automatically.
  const wantsSiteVisit =
    parsed.wantsSiteVisit ||
    parsed.intent === "ready_to_visit" ||
    (!["image", "video", "audio", "document", "sticker"].includes(message?.type) && isSiteVisitRequest(currentMessage));

  if (wantsSiteVisit) {
    const visitProperty =
      candidateProperties[0] ||
      (conversation.recommendedProperties?.length
        ? await Property.findById(
            conversation.recommendedProperties[
              conversation.recommendedProperties.length - 1
            ],
          )
        : null);

    await createSiteVisit({
      lead,
      conversation,
      date: parsed.proposedDate,
      time: parsed.proposedTime,
      property: visitProperty,
    });
  }

  conversation.requirementsComplete = !!parsed.readyForPropertyRecommendation;
  await conversation.save();

  emitToUser(conversation.ownerId, "conversation:aiReply", {
    conversationId: conversation._id,
    leadId: lead._id,
    message: outbound,
  });

  // Lead scoring + follow-up planning runs as a separate Gemini pass, fired
  // async so the buyer isn't kept waiting on a second model call.
  analyzeConversationAsync({
    leadId: lead._id,
    conversationId: conversation._id,
  }).catch((err) =>
    logger.error(`[ai] Async lead analysis failed for lead ${lead._id}`, {
      error: err.message,
    }),
  );
}

/**
 * Sends the very first outbound WhatsApp message to a lead.
 *
 * Ab yeh function queue worker (services/queue/bulkWorker.js) ke liye
 * banaya gaya hai, isliye:
 *   - Success par        -> { sent: true, usedTemplate }
 *   - Skip karna pade to -> { skipped: true, reason }
 *       reasons: not_ai_active | already_started | ai_paused | whatsapp_disconnected
 *   - Koi bhi ERROR par  -> THROW karta hai (err.code / err.metaError ke saath),
 *       taaki worker retry ya fail decide kar sake. Yahan koi error nigla nahi jata.
 *
 * Idempotent: agar outbound message pehle se ja chuka hai to dobara nahi bhejta
 * (isse retry par double message nahi jayega).
 */
async function startConversation({
  lead,
  conversation,
  templateOverride = null,
  outboundJobId = null,
}) {
  if (!templateOverride && conversation.status !== "ai_active") {
    return { skipped: true, reason: "not_ai_active" };
  }

  // Campaign template messages are intentionally allowed for previously-contacted leads.
  // Use the durable job ID for idempotency instead of blocking every lead that ever had a message.
  const alreadyStarted =
    templateOverride && outboundJobId
      ? await Message.exists({ outboundJobId })
      : !templateOverride
        ? await Message.exists({
            conversationId: conversation._id,
            direction: "outbound",
          })
        : false;
  if (alreadyStarted)
    return { skipped: true, reason: "already_started", sent: true };

  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.phoneNumberId) {
    const err = new Error(
      "Meta WhatsApp Cloud API is not configured (META_WHATSAPP_ACCESS_TOKEN / META_WHATSAPP_PHONE_NUMBER_ID)",
    );
    err.code = "META_NOT_CONFIGURED";
    throw err;
  }

  const settings = await settingsService.getOrCreateSettings();
  if (!templateOverride && (settings.aiPaused || !settings.autoReplyEnabled)) {
    return { skipped: true, reason: "ai_paused" };
  }
  if (settings.whatsappDisconnected) {
    return { skipped: true, reason: "whatsapp_disconnected" };
  }

  const openingText =
    settings.openingText ||
    env.metaWhatsapp.openingText ||
    settings.greetingMessage ||
    "Hi! Thanks for your interest. I'm here to help you find the right property 🙂";

  let outbound = null;
  let usedTemplate = false;

  try {
    const lastInboundAt = conversation.lastInboundAt
      ? new Date(conversation.lastInboundAt)
      : null;

    const isWindowOpen =
      lastInboundAt &&
      !Number.isNaN(lastInboundAt.getTime()) &&
      Date.now() - lastInboundAt.getTime() < 24 * 60 * 60 * 1000;

    if (templateOverride?.name) {
      const variables = Array.isArray(templateOverride.variables)
        ? templateOverride.variables
        : [];
      const maxIndex = variables.reduce(
        (max, item) => Math.max(max, Number(item.index) || 0),
        0,
      );
      const parameters = [];
      for (let index = 1; index <= maxIndex; index += 1) {
        const variable = variables.find((item) => Number(item.index) === index);
        let value = "";
        if (variable?.source === "name") value = lead.name || "";
        else if (variable?.source === "phone") value = lead.phone || "";
        else if (variable?.source === "email") value = lead.email || "";
        else value = variable?.value || "";
        parameters.push({
          type: "text",
          text: String(value || "Customer").slice(0, 1024),
        });
      }
      const components = [];
      if (parameters.length) components.push({ type: "body", parameters });
      if (templateOverride.headerImageUrl) {
        components.unshift({
          type: "header",
          parameters: [
            { type: "image", image: { link: templateOverride.headerImageUrl } },
          ],
        });
      }
      const { messageId } = await metaWhatsappClient.sendTemplateMessage({
        phone: lead.phone,
        templateName: templateOverride.name,
        languageCode: templateOverride.language || "en_US",
        components,
      });
      // Store the actual message body in CRM history instead of the internal
      // template key. This lets brokers understand what the customer received.
      const fillVars = (text) =>
        String(text || "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, number) => {
          const parameter = parameters[Number(number) - 1];
          return parameter?.text || "";
        });
      const bodyPreview = fillVars(templateOverride.body);
      // Full message as the customer sees it: header, body, footer and buttons
      // (WhatsApp *bold* / _italic_ markers are rendered by the chat screen).
      const messagePreview = bodyPreview.trim()
        ? [
            templateOverride.header
              ? `*${fillVars(templateOverride.header).trim()}*`
              : "",
            bodyPreview.trim(),
            templateOverride.footer
              ? `_${templateOverride.footer.trim()}_`
              : "",
            (templateOverride.buttons || [])
              .filter(Boolean)
              .map((label) => `[ ${label} ]`)
              .join("\n"),
          ]
            .filter(Boolean)
            .join("\n\n")
        : `Template sent: ${templateOverride.name}`;
      outbound = await recordOutboundMessage({
        conversationId: conversation._id,
        leadId: lead._id,
        text: messagePreview,
        sender: "ai",
        whatsappMessageId: messageId || null,
        outboundJobId,
      });
      usedTemplate = true;
      logger.info(
        `[campaign] Approved WhatsApp template sent for lead ${lead._id}`,
        {
          templateName: templateOverride.name,
          templateLanguage: templateOverride.language,
          campaignJobId: outboundJobId ? String(outboundJobId) : null,
        },
      );
    } else if (isWindowOpen) {
      // Customer ne last 24 hours mein message kiya hai: normal text allowed.
      const { messageId } = await metaWhatsappClient.sendTextMessage({
        phone: lead.phone,
        text: openingText,
      });

      outbound = await recordOutboundMessage({
        conversationId: conversation._id,
        leadId: lead._id,
        text: openingText,
        sender: "ai",
        whatsappMessageId: messageId || null,
      });

      logger.info(
        `[ai] Opening text sent via Meta Cloud API for lead ${lead._id}`,
        { phone: lead.phone, reason: "24h-window-open" },
      );
    } else {
      // New lead / closed 24-hour window: WhatsApp requires an approved
      // template. It comes ONLY from this lead's organization (selected in its
      // WhatsApp settings and re-validated against its own Meta account).
      // There is deliberately no env / other-tenant / plain-text fallback.
      const resolved = await openingTemplateService.resolveForSend({ lead });

      let messageId;
      try {
        ({ messageId } = await metaWhatsappClient.sendTemplateMessage({
          phone: lead.phone,
          templateName: resolved.templateName,
          languageCode: resolved.languageCode,
          components: resolved.components,
        }));
      } catch (sendErr) {
        throw openingTemplateService.translateSendError(
          sendErr,
          resolved.templateName,
        );
      }

      outbound = await recordOutboundMessage({
        conversationId: conversation._id,
        leadId: lead._id,
        text: resolved.preview,
        sender: "ai",
        whatsappMessageId: messageId || null,
      });

      usedTemplate = true;

      logger.info(`[ai] Opening WhatsApp template sent for lead ${lead._id}`, {
        organizationId: resolved.organizationId,
        templateName: resolved.templateName,
        templateLanguage: resolved.languageCode,
        reason: "24h-window-closed",
      });
    }
  } catch (err) {
    logger.error(
      `[ai] Failed to send opening WhatsApp message for lead ${lead._id}`,
      {
        error: err.metaError || err.response?.data || err.message,
        code: err.code,
        organizationId: tenantContext.orgId() ? String(tenantContext.orgId()) : null,
        phone: lead.phone,
      },
    );
    // IMPORTANT: error ko nigalna nahi hai — worker ko pata chalna chahiye.
    throw err;
  }

  conversation.templateSent = usedTemplate;
  conversation.templateSentAt = usedTemplate ? new Date() : null;
  conversation.lastMessageAt = new Date();
  await conversation.save();

  emitToUser(conversation.ownerId, "conversation:aiReply", {
    conversationId: conversation._id,
    leadId: lead._id,
    message: outbound,
  });

  return { sent: true, usedTemplate };
}

/**
 * Broker ke woh leads dhundhta hai jinka conversation ai_active hai lekin
 * abhi tak koi message nahi gaya, aur unhe QUEUE mein daal deta hai.
 * (Ab seedha message nahi bhejta — isse 100+ leads par parallel burst nahi hoga.)
 *
 * Skip karta hai:
 *   - jinka message pehle se ja chuka hai
 *   - jinka job pehle 'failed' ya 'cancelled' ho chuka hai
 *     (warna har server restart par woh dobara queue mein aa jate)
 *   - jinka job abhi pending/processing/paused hai (enqueueLeads khud handle karta hai)
 */
async function catchUpPendingConversations(brokerId) {
  const pending = await Conversation.find({
    ownerId: brokerId,
    status: "ai_active",
  })
    .select("_id leadId")
    .lean();
  if (!pending.length) return;

  const conversationIds = pending.map((c) => c._id);
  const leadIds = pending.map((c) => c.leadId);

  const [withMessages, blockedLeadIds] = await Promise.all([
    Message.distinct("conversationId", {
      conversationId: { $in: conversationIds },
    }),
    // failed/cancelled jobs, ya koi bhi campaign job: campaign leads ka schedule
    // campaign khud sambhalta hai (e.g. email-only campaign ki lead ko
    // restart par WhatsApp nahi jana chahiye).
    OutboundJob.distinct("leadId", {
      leadId: { $in: leadIds },
      $or: [
        { status: { $in: ["failed", "cancelled"] } },
        { campaignId: { $ne: null } },
      ],
    }),
  ]);

  const hasMessageSet = new Set(withMessages.map(String));
  const blockedSet = new Set(blockedLeadIds.map(String));

  const toQueue = pending
    .filter(
      (c) =>
        !hasMessageSet.has(String(c._id)) && !blockedSet.has(String(c.leadId)),
    )
    .map((c) => c.leadId);

  if (!toQueue.length) return;

  const { queued } = await enqueueLeads({
    ownerId: brokerId,
    leadIds: toQueue,
  });

  if (queued) {
    logger.info(
      `[ai] Catch-up: ${queued} pending conversation(s) queued for broker ${brokerId}`,
    );
  }
}

function mergeRequirements(existing, incoming = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Keeps one active booking per lead + property. Re-confirming/rescheduling the
 * same property's active visit updates that visit; booking a different property
 * creates a separate Meeting row, so a lead can have multiple site visits.
 */
async function createSiteVisit({ lead, conversation, date, time, property }) {
  const preferredDate =
    date || new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10); // default: 2 days out if not specified yet
  const preferredTime = time || "11:00";

  const propertyMatch = property?._id
    ? { propertyId: property._id }
    : { $or: [{ propertyId: null }, { propertyId: { $exists: false } }] };
  let meeting = await Meeting.findOne({
    leadId: lead._id,
    ...propertyMatch,
    status: { $in: ["scheduled", "rescheduled"] },
  }).sort({ createdAt: -1 });

  let isNew = false;
  if (meeting) {
    meeting.preferredDate = preferredDate;
    meeting.preferredTime = preferredTime;
    if (property?._id) meeting.propertyId = property._id;
    meeting.status = "scheduled";
    meeting.confirmation = { status: "none" };
    await meeting.save();
  } else {
    isNew = true;
    meeting = await Meeting.create({
      leadId: lead._id,
      ownerId: conversation.ownerId,
      propertyId: property?._id || null,
      preferredDate,
      preferredTime,
      status: "scheduled",
      source: "whatsapp_ai",
      conversationId: conversation._id,
    });
  }

  // Cached copy on Conversation for quick UI reads — Meeting model remains
  // the source of truth. Keep this in sync any time Meeting.status changes
  // elsewhere too (e.g. a broker marking a visit as done/cancelled).
  conversation.meetingStatus = "scheduled";
  await Lead.updateOne({ _id: lead._id }, { $set: { status: "site_visit" } });

  // Book/update the real calendar event. Best-effort: a Calendar failure
  // must never block the WhatsApp conversation or lose the Meeting record.
  try {
    if (meeting.googleEventId) {
      const event = await updateCalendarEvent({
        eventId: meeting.googleEventId,
        date: preferredDate,
        time: preferredTime,
      });
      if (event) {
        meeting.googleEventLink = event.eventLink;
        await meeting.save();
      }
    } else {
      const event = await createCalendarEvent({
        summary: `Site Visit — ${lead.name || lead.phone}${property ? ` (${property.projectName})` : ""}`,
        description: [
          `Lead: ${lead.name || "N/A"} (${lead.phone})`,
          property
            ? `Property: ${property.projectName}, ${property.city || ""}`
            : null,
          "Booked automatically by the AI WhatsApp assistant.",
        ]
          .filter(Boolean)
          .join("\n"),
        date: preferredDate,
        time: preferredTime,
      });
      if (event) {
        meeting.googleEventId = event.eventId;
        meeting.googleEventLink = event.eventLink;
        await meeting.save();
      }
    }
  } catch (err) {
    logger.error(
      `[calendar] Failed to sync Google Calendar event for lead ${lead._id}`,
      { error: err.message },
    );
  }

  if (isNew) {
    await Notification.create({
      userId: conversation.ownerId,
      type: "site_visit_scheduled",
      title: `Site visit scheduled — ${lead.name}`,
      body: `${preferredDate} at ${preferredTime}${property ? ` for ${property.projectName}` : ""}`,
      link: `/site-visits`,
    });
    // Instant WhatsApp alert to the owner: a booked visit = hot lead.
    try {
      const settings = await settingsService.getOrCreateSettings();
      if (settings.alertOn?.visitBooked !== false) {
        const { sendOwnerAlert } = require("../alerts/ownerAlerts");
        await sendOwnerAlert({
          kind: "visit_booked",
          title: `📅 SITE VISIT BOOK HUI — ${lead.name || "Buyer"}`,
          lines: [
            `📞 ${lead.phone || "-"}`,
            `🗓 ${preferredDate} · ${preferredTime}`,
            property ? `🏠 ${property.projectName}${property.city ? `, ${property.city}` : ""}` : "",
            "AI ne WhatsApp par visit book ki hai. Confirmation call/WhatsApp apne aap jayega.",
          ],
          link: "/site-visits",
          templateValues: [lead.name || "Lead", lead.phone || "-", `${preferredDate} ${preferredTime}`, property?.projectName || "-", "Site visit booked"],
        });
      }
    } catch (err) {
      logger.warn("[ai] visit-booked owner alert failed", { error: err.message });
    }
  }

  emitToUser(conversation.ownerId, "meeting:created", { meeting });

  return meeting;
}

module.exports = {
  handleInbound,
  createSiteVisit,
  startConversation,
  catchUpPendingConversations,
};
