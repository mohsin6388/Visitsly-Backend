const axios = require('axios');
const env = require('../../config/env');
const Organization = require('../../models/Organization');
const ApiError = require('../../utils/ApiError');
const { encrypt, decrypt } = require('../../utils/crypto');
const WhatsAppConnectionAttempt = require('../../models/WhatsAppConnectionAttempt');
const orgService = require('./orgService');
const logger = require('../../utils/logger');

/**
 * Connects a company's own WhatsApp Business number to PropAI.
 *
 * Two ways:
 *  1. Embedded Signup (recommended) — the customer clicks "Connect WhatsApp",
 *     logs into Facebook in a Meta popup, picks/creates their WABA and number.
 *     The frontend gets back { code, wabaId, phoneNumberId } and posts them
 *     here; we swap the code for a business token. Needs PropAI's Meta app to
 *     be a Tech Provider with an Embedded Signup configuration (META_ES_CONFIG_ID).
 *  2. Manual — paste a permanent System User token + Phone Number ID + WABA ID
 *     (useful before Tech Provider approval, or for an existing setup).
 *
 * The customer pays Meta directly for messages on their own WABA (they add a
 * payment method in WhatsApp Manager), so PropAI never carries their Meta bill.
 */
const graph = axios.create({ timeout: 20000 });
const v = () => env.platformMeta.apiVersion;

function metaFail(err, fallback, stage = 'meta_api') {
  const metaError = err.response?.data?.error || err.metaError || null;
  const message = metaError?.error_user_msg || metaError?.message || err.message || fallback;
  const details = {
    code: 'META_ERROR',
    metaCode: metaError?.code ?? err.code ?? null,
    metaSubcode: metaError?.error_subcode ?? null,
    metaType: metaError?.type ?? null,
    fbtraceId: metaError?.fbtrace_id ?? null,
    stage,
  };
  // Preserve actionable HTTP semantics without exposing credentials or raw request data.
  const status = Number(err.response?.status || 0);
  if (status === 429) return new ApiError(429, 'Meta ne request limit lagayi hai. Kuch der baad dobara try karein.', details);
  if (status === 401 || metaError?.code === 190) return new ApiError(401, 'Meta authorization expire ya invalid hai. Facebook se WhatsApp dobara connect karein.', details);
  if (status === 403) return new ApiError(403, message, details);
  return ApiError.badRequest(message || fallback, details);
}

async function exchangeCode(code) {
  const { appId, appSecret } = env.platformMeta;
  if (!appId || !appSecret) {
    throw ApiError.badRequest('Platform par META_APP_ID aur META_WHATSAPP_APP_SECRET set nahi hain — PropAI admin se baat karein.');
  }
  try {
    const { data } = await graph.get(`https://graph.facebook.com/${v()}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, code },
    });
    if (!data?.access_token) throw new Error('Meta ne token nahi diya');
    return data.access_token;
  } catch (err) {
    throw metaFail(err, 'Meta code exchange failed');
  }
}

async function phoneInfo(token, phoneNumberId) {
  try {
    const { data } = await graph.get(`https://graph.facebook.com/${v()}/${phoneNumberId}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { fields: 'display_phone_number,verified_name,quality_rating,code_verification_status' },
    });
    return data;
  } catch (err) {
    throw metaFail(err, 'Phone number check failed — token ya Phone Number ID galat hai');
  }
}

async function subscribeApp(token, wabaId) {
  try {
    await graph.post(`https://graph.facebook.com/${v()}/${wabaId}/subscribed_apps`, {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw metaFail(err, 'WABA webhook subscription failed');
  }
}

/** Registers the number for Cloud API (needed once for numbers added via Embedded Signup). */
async function registerNumber(token, phoneNumberId, pin) {
  if (!/^\d{6}$/.test(String(pin || ''))) {
    throw ApiError.badRequest('Meta phone registration ke liye valid 6-digit PIN required hai.');
  }
  try {
    await graph.post(
      `https://graph.facebook.com/${v()}/${phoneNumberId}/register`,
      { messaging_product: 'whatsapp', pin: String(pin) },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return true;
  } catch (err) {
    const metaError = err.response?.data?.error;
    const message = String(metaError?.message || err.message || '');
    // Only tolerate the specific case where Meta confirms the number is
    // already registered. Do not silently swallow permissions, PIN or state errors.
    if (/already registered/i.test(message)) {
      logger.info('[saas] Phone number is already registered with WhatsApp Cloud API', { phoneNumberId: String(phoneNumberId) });
      return false;
    }
    throw metaFail(err, 'WhatsApp number registration failed. Verify the 6-digit PIN and Meta permissions.');
  }
}


async function listWabaPhoneNumbers(token, wabaId) {
  const phones = [];
  let url = `https://graph.facebook.com/${v()}/${wabaId}/phone_numbers`;
  let params = { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status', limit: 100 };
  try {
    // Follow pagination defensively, but cap it so a misconfigured Graph response cannot loop forever.
    for (let page = 0; url && page < 5; page += 1) {
      const { data } = await graph.get(url, { headers: { Authorization: `Bearer ${token}` }, params });
      for (const item of Array.isArray(data?.data) ? data.data : []) {
        if (item?.id) phones.push({
          phoneNumberId: String(item.id),
          displayPhoneNumber: item.display_phone_number || null,
          verifiedName: item.verified_name || null,
          qualityRating: item.quality_rating || null,
        });
      }
      url = data?.paging?.next || null;
      params = undefined; // subsequent URLs already contain their query parameters
    }
  } catch (err) {
    throw metaFail(err, 'Meta se WhatsApp numbers ki list nahi mil paayi. Business permissions aur WABA access check karein.', 'discover_phone_numbers');
  }
  const unique = new Map(phones.map((phone) => [phone.phoneNumberId, phone]));
  return [...unique.values()];
}

/**
 * Exchange the one-time OAuth code exactly once and persist a short-lived,
 * encrypted attempt. This supports Meta events that return a WABA but omit
 * phone_number_id, and lets the user retry a wrong PIN without repeating OAuth.
 */
async function prepareEmbedded(orgId, userId, { code, wabaId, phoneNumberId }) {
  if (!code || !/^\d+$/.test(String(wabaId || ''))) {
    throw ApiError.badRequest('Meta ne signup code ya WhatsApp Business Account ID nahi diya. Facebook se dobara connect karein.', {
      code: 'META_SIGNUP_DATA_INCOMPLETE', stage: 'receive_signup_result',
    });
  }
  const token = await exchangeCode(code);
  const availablePhones = await listWabaPhoneNumbers(token, wabaId);
  if (!availablePhones.length) {
    throw ApiError.badRequest(
      'Meta signup complete dikh raha hai, lekin is WhatsApp Business Account mein koi phone number accessible nahi mila. Meta flow dobara kholkar number add/verify karein. Existing WhatsApp Business App number use karna hai to Coexistence eligibility/configuration check karein.',
      { code: 'META_PHONE_NUMBER_NOT_FOUND', stage: 'discover_phone_numbers' },
    );
  }

  let selectedPhoneNumberId = phoneNumberId ? String(phoneNumberId) : null;
  if (selectedPhoneNumberId && !availablePhones.some((phone) => phone.phoneNumberId === selectedPhoneNumberId)) {
    throw ApiError.badRequest(
      'Meta ne jo phone number return kiya, woh selected WhatsApp Business Account ki accessible number list mein nahi hai. Sahi Business Account select karke dobara try karein.',
      { code: 'META_PHONE_WABA_MISMATCH', stage: 'validate_phone_number' },
    );
  }
  if (!selectedPhoneNumberId && availablePhones.length === 1) selectedPhoneNumberId = availablePhones[0].phoneNumberId;

  await WhatsAppConnectionAttempt.deleteMany({ organizationId: orgId, status: 'pending' });
  const attempt = await WhatsAppConnectionAttempt.create({
    organizationId: orgId,
    createdBy: userId,
    wabaId: String(wabaId),
    accessTokenEncrypted: encrypt(token),
    phoneNumbers: availablePhones,
    selectedPhoneNumberId,
    status: 'pending',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });

  // A new valid Meta handoff supersedes stale error banners from an earlier attempt.
  const currentOrg = await Organization.findById(orgId).select('whatsapp.status whatsapp.phoneNumberId').lean();
  const clearErrors = {
    'whatsapp.lastError': null,
    'whatsapp.lastErrorCode': null,
    'whatsapp.lastErrorStage': null,
    'whatsapp.lastErrorAt': null,
  };
  if (!currentOrg?.whatsapp?.phoneNumberId || currentOrg?.whatsapp?.status !== 'connected') {
    clearErrors['whatsapp.status'] = 'not_connected';
  }
  await Organization.updateOne({ _id: orgId }, { $set: clearErrors });
  orgService.invalidate(orgId);

  return {
    attemptId: String(attempt._id),
    wabaId: String(wabaId),
    phoneNumbers: availablePhones,
    selectedPhoneNumberId,
    needsPhoneSelection: !selectedPhoneNumberId && availablePhones.length > 1,
    expiresAt: attempt.expiresAt,
  };
}

async function completeEmbedded(orgId, { attemptId, phoneNumberId, pin }) {
  if (!/^\d{6}$/.test(String(pin || ''))) {
    throw ApiError.badRequest('Meta registration ke liye 6-digit PIN enter karein.', { code: 'META_PIN_INVALID', stage: 'register_phone_number' });
  }
  const attempt = await WhatsAppConnectionAttempt.findOneAndUpdate(
    { _id: attemptId, organizationId: orgId, status: 'pending', expiresAt: { $gt: new Date() } },
    { $set: { status: 'completing' } },
    { new: true },
  ).select('+accessTokenEncrypted');
  if (!attempt) {
    throw new ApiError(410, 'Connection session expire ho gaya ya already process ho raha hai. Security ke liye Facebook se dobara connect karein.', {
      code: 'WHATSAPP_CONNECT_ATTEMPT_EXPIRED', stage: 'complete_signup',
    });
  }

  try {
    const selected = attempt.phoneNumbers.find((phone) => phone.phoneNumberId === String(phoneNumberId));
    if (!selected) throw ApiError.badRequest('Selected phone number is is Meta signup session ka hissa nahi hai. Facebook se dobara connect karein.', { code: 'META_PHONE_SELECTION_INVALID', stage: 'validate_phone_number' });
    await assertNumberFree(orgId, phoneNumberId);
    const token = decrypt(attempt.accessTokenEncrypted);
    if (!token) throw ApiError.badRequest('Temporary Meta authorization decrypt nahi ho paayi. Facebook se dobara connect karein.', { code: 'META_TOKEN_UNREADABLE', stage: 'exchange_code' });

    await subscribeApp(token, attempt.wabaId);
    await registerNumber(token, phoneNumberId, pin);
    const info = await phoneInfo(token, phoneNumberId);
    const result = await save(orgId, { token, phoneNumberId, wabaId: attempt.wabaId, via: 'embedded_signup', info });
    await WhatsAppConnectionAttempt.deleteMany({ organizationId: orgId });
    return result;
  } catch (err) {
    // Wrong PIN, temporary Meta failures, and permission fixes can be retried
    // against this short-lived attempt. Never store the PIN itself.
    await WhatsAppConnectionAttempt.updateOne(
      { _id: attempt._id, organizationId: orgId, status: 'completing' },
      { $set: { status: 'pending' } },
    ).catch(() => {});
    throw err;
  }
}

async function recordConnectionError(orgId, err, stage = 'connect') {
  if (!orgId || !err) return;
  const message = String(err.message || 'WhatsApp connection failed')
    .replace(/Bearer\s+\S+/gi, '[redacted]')
    .slice(0, 500);
  const details = err.details || {};
  const code = details.metaCode || details.code || err.code || 'WHATSAPP_CONNECTION_FAILED';
  const current = await Organization.findById(orgId).select('whatsapp.status whatsapp.phoneNumberId').lean().catch(() => null);
  const $set = {
    'whatsapp.lastError': message,
    'whatsapp.lastErrorCode': String(code).slice(0, 80),
    'whatsapp.lastErrorStage': String(details.stage || stage).slice(0, 80),
    'whatsapp.lastErrorAt': new Date(),
  };
  // Do not mark a working number as disconnected merely because a reconnect attempt failed.
  if (!current?.whatsapp?.phoneNumberId || current?.whatsapp?.status !== 'connected') $set['whatsapp.status'] = 'error';
  await Organization.updateOne({ _id: orgId }, { $set }).catch(() => {});
  orgService.invalidate(orgId);
}

async function assertNumberFree(orgId, phoneNumberId) {
  const other = await Organization.findOne({ 'whatsapp.phoneNumberId': phoneNumberId, _id: { $ne: orgId } }).select('_id name').lean();
  if (other) throw ApiError.conflict('Ye WhatsApp number pehle se kisi aur PropAI account se juda hai.');
}

async function save(orgId, { token, phoneNumberId, wabaId, via, info }) {
  const org = await Organization.findByIdAndUpdate(
    orgId,
    {
      $set: {
        'whatsapp.status': 'connected',
        'whatsapp.connectedVia': via,
        'whatsapp.phoneNumberId': String(phoneNumberId),
        'whatsapp.businessAccountId': String(wabaId),
        'whatsapp.accessTokenEncrypted': encrypt(token),
        'whatsapp.displayPhoneNumber': info?.display_phone_number || null,
        'whatsapp.verifiedName': info?.verified_name || null,
        'whatsapp.qualityRating': info?.quality_rating || null,
        'whatsapp.connectedAt': new Date(),
        'whatsapp.lastError': null,
        'whatsapp.lastErrorCode': null,
        'whatsapp.lastErrorStage': null,
        'whatsapp.lastErrorAt': null,
        'onboarding.whatsappDone': true,
      },
    },
    { new: true }
  ).lean();
  orgService.invalidate(orgId);
  return org;
}

async function connectEmbedded(orgId, { code, wabaId, phoneNumberId, pin }) {
  if (!code || !wabaId || !phoneNumberId) throw ApiError.badRequest('code, wabaId aur phoneNumberId chahiye');
  if (!/^\d{6}$/.test(String(pin || ''))) throw ApiError.badRequest('Meta phone registration ke liye valid 6-digit PIN required hai.');
  await assertNumberFree(orgId, phoneNumberId);
  const token = await exchangeCode(code);
  await subscribeApp(token, wabaId);
  await registerNumber(token, phoneNumberId, pin);
  const info = await phoneInfo(token, phoneNumberId);
  return save(orgId, { token, phoneNumberId, wabaId, via: 'embedded_signup', info });
}

async function connectManual(orgId, { accessToken, phoneNumberId, businessAccountId }) {
  if (!accessToken || !phoneNumberId || !businessAccountId) {
    throw ApiError.badRequest('Access token, Phone Number ID aur WABA ID teeno chahiye');
  }
  await assertNumberFree(orgId, phoneNumberId);
  const info = await phoneInfo(accessToken, phoneNumberId);
  await subscribeApp(accessToken, businessAccountId);
  return save(orgId, { token: accessToken, phoneNumberId, wabaId: businessAccountId, via: 'manual', info });
}

/** Extra numbers (Builder: 2 total, Enterprise: many). Token optional when same WABA/system user. */
async function addNumber(orgId, { label, accessToken, phoneNumberId, businessAccountId }) {
  const org = await Organization.findById(orgId).select('+whatsapp.accessTokenEncrypted').lean();
  if (!org?.whatsapp?.phoneNumberId && org?.whatsapp?.connectedVia !== 'env') throw ApiError.badRequest('Pehle main WhatsApp number connect karein');
  const { limitsFor } = require('../../config/plans');
  const limit = limitsFor(org).whatsappNumbers;
  const count = 1 + (org.extraNumbers || []).length;
  if (limit != null && count + 1 > limit) {
    throw new ApiError(403, `Aapke plan mein ${limit} WhatsApp number(s) allowed hain. Builder plan ya "Extra WhatsApp number" add-on lein.`, { code: 'PLAN_LIMIT', key: 'whatsappNumbers', limit });
  }
  if (String(phoneNumberId) === org.whatsapp?.phoneNumberId || (org.extraNumbers || []).some((n) => n.phoneNumberId === String(phoneNumberId))) {
    throw ApiError.conflict('Ye number pehle se juda hai');
  }
  await assertNumberFree(orgId, phoneNumberId);
  const other = await Organization.findOne({ 'extraNumbers.phoneNumberId': String(phoneNumberId), _id: { $ne: orgId } }).select('_id').lean();
  if (other) throw ApiError.conflict('Ye WhatsApp number pehle se kisi aur PropAI account se juda hai.');
  const { decrypt } = require('../../utils/crypto');
  const token = accessToken || decrypt(org.whatsapp?.accessTokenEncrypted) || env.platformMeta.accessToken;
  const info = await phoneInfo(token, phoneNumberId);
  const wabaId = businessAccountId || org.whatsapp?.businessAccountId;
  if (businessAccountId && businessAccountId !== org.whatsapp?.businessAccountId) await subscribeApp(token, businessAccountId);
  await Organization.updateOne(
    { _id: orgId },
    {
      $push: {
        extraNumbers: {
          label: label || '',
          phoneNumberId: String(phoneNumberId),
          businessAccountId: wabaId || null,
          displayPhoneNumber: info?.display_phone_number || null,
          verifiedName: info?.verified_name || null,
          accessTokenEncrypted: accessToken ? encrypt(accessToken) : null,
          connectedAt: new Date(),
        },
      },
    }
  );
  orgService.invalidate(orgId);
}

async function removeNumber(orgId, phoneNumberId) {
  await Organization.updateOne({ _id: orgId }, { $pull: { extraNumbers: { phoneNumberId: String(phoneNumberId) } } });
  orgService.invalidate(orgId);
}

async function disconnect(orgId) {
  await Organization.updateOne(
    { _id: orgId },
    {
      $set: {
        'whatsapp.status': 'not_connected',
        'whatsapp.connectedVia': null,
        'whatsapp.phoneNumberId': null,
        'whatsapp.businessAccountId': null,
        'whatsapp.accessTokenEncrypted': null,
        'whatsapp.displayPhoneNumber': null,
        'whatsapp.verifiedName': null,
        'whatsapp.qualityRating': null,
        'whatsapp.lastError': null,
        'whatsapp.lastErrorCode': null,
        'whatsapp.lastErrorStage': null,
        'whatsapp.lastErrorAt': null,
        'onboarding.whatsappDone': false,
      },
    }
  );
  orgService.invalidate(orgId);
}

/** Public, safe view of the connection (never the token). */
function publicView(org) {
  const wa = org?.whatsapp || {};
  const connectedViaEnv = wa.connectedVia === 'env';
  return {
    status: connectedViaEnv ? 'connected' : wa.status || 'not_connected',
    connectedVia: wa.connectedVia || null,
    phoneNumberId: connectedViaEnv ? env.platformMeta.phoneNumberId : wa.phoneNumberId || null,
    businessAccountId: connectedViaEnv ? env.platformMeta.businessAccountId : wa.businessAccountId || null,
    displayPhoneNumber: wa.displayPhoneNumber || null,
    verifiedName: wa.verifiedName || null,
    qualityRating: wa.qualityRating || null,
    openingTemplateName: wa.openingTemplateName || null,
    openingTemplateLanguage: wa.openingTemplateLanguage || null,
    connectedAt: wa.connectedAt || null,
    lastError: wa.lastError || null,
    lastErrorCode: wa.lastErrorCode || null,
    lastErrorStage: wa.lastErrorStage || null,
    lastErrorAt: wa.lastErrorAt || null,
    webhookLastReceivedAt: wa.webhookLastReceivedAt || null,
    webhookLastMessageAt: wa.webhookLastMessageAt || null,
    extraNumbers: (org?.extraNumbers || []).map((n) => ({ label: n.label, phoneNumberId: n.phoneNumberId, displayPhoneNumber: n.displayPhoneNumber, verifiedName: n.verifiedName, connectedAt: n.connectedAt })),
    embeddedSignup: {
      available: Boolean(env.platformMeta.appId && env.platformMeta.embeddedSignupConfigId),
      appId: env.platformMeta.appId || null,
      configId: env.platformMeta.embeddedSignupConfigId || null,
      solutionId: env.platformMeta.embeddedSignupSolutionId || null,
      apiVersion: env.platformMeta.apiVersion,
    },
  };
}

module.exports = { connectEmbedded, prepareEmbedded, completeEmbedded, recordConnectionError, connectManual, disconnect, publicView, addNumber, removeNumber };
