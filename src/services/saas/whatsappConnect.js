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

/**
 * Plain-language (Hinglish) explanation for the Meta errors customers hit most
 * while connecting a number. Users of this product are often not technical,
 * so every message says WHAT went wrong and WHAT to do next.
 */
const FRIENDLY = {
  190: 'Facebook permission expired. Click "Connect with Facebook" again.',
  102: 'Facebook login session ended. Please connect again.',
  10: 'This Facebook account has no WhatsApp Business permission. Connect with the business admin’s Facebook account.',
  200: 'Permission not granted. Allow all permissions in the Facebook popup and try again.',
  100: 'These IDs are wrong or belong to another account. Check the Phone Number ID and WhatsApp Business Account ID.',
  4: 'Meta rate-limited the request. Try again in 10–15 minutes.',
  80008: 'Meta rate-limited the request. Try again in 10–15 minutes.',
  131037: 'Display name is not approved by Meta yet, so messages are not sent. Check WhatsApp Manager > Phone numbers > Display name (usually up to 48 hours).',
  131031: 'Meta has restricted this WhatsApp Business account. Check the account status in WhatsApp Manager.',
  131005: 'Missing permission. Ask the business admin for WhatsApp "Full control".',
  133005: 'Wrong PIN. Enter this number’s 6-digit two-step PIN (change it in WhatsApp Manager → Phone numbers → Two-step verification).',
  133006: 'Number not verified yet. Verify it with Meta’s OTP and try again.',
  133008: 'Too many wrong PIN attempts. Wait a while and try the correct PIN.',
  133009: 'PIN tried too quickly. Wait 1–2 minutes and retry.',
  133010: 'Number is not registered on WhatsApp Cloud API. Reconnect with Facebook and enter the PIN.',
  133015: 'This number was just removed from another WhatsApp account. Try again in 5–10 minutes.',
  133016: 'Registration limit reached. Try again after 72 hours or contact support.',
  136025: 'Could not verify the number. Request a new OTP and verify.',
  2388001: 'This number is already in another WhatsApp Business account. Remove it there first or select that account.',
  368: 'Meta temporarily blocked this account for a policy reason. Check Business Support Home.',
};

function friendlyMetaMessage(metaError, fallback) {
  if (!metaError) return fallback;
  const code = Number(metaError.code);
  const sub = Number(metaError.error_subcode);
  if (code === 100 && sub === 33) return 'ID not found or the token lacks permission. Check the Phone Number ID / WABA ID.';
  return FRIENDLY[sub] || FRIENDLY[code] || metaError.error_user_msg || metaError.message || fallback;
}

function metaFail(err, fallback, stage = 'meta_api') {
  const metaError = err.response?.data?.error || err.metaError || null;
  const message = friendlyMetaMessage(metaError, err.message || fallback);
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
  if (status === 429) return new ApiError(429, 'Meta rate-limited the request. Try again shortly.', details);
  if (status === 401 || metaError?.code === 190) return new ApiError(401, 'Meta authorization expired or is invalid. Reconnect WhatsApp with Facebook.', details);
  if (status === 403) return new ApiError(403, message, details);
  return ApiError.badRequest(message || fallback, details);
}

async function exchangeCode(code) {
  const { appId, appSecret } = env.platformMeta;
  if (!appId || !appSecret) {
    throw ApiError.badRequest('META_APP_ID and META_WHATSAPP_APP_SECRET are not set on the platform — contact the admin.');
  }
  try {
    const { data } = await graph.get(`https://graph.facebook.com/${v()}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, code },
    });
    if (!data?.access_token) throw new Error('Meta did not return a token');
    return data.access_token;
  } catch (err) {
    throw metaFail(err, 'Meta code exchange failed');
  }
}

async function phoneInfo(token, phoneNumberId) {
  try {
    const { data } = await graph.get(`https://graph.facebook.com/${v()}/${phoneNumberId}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { fields: 'display_phone_number,verified_name,quality_rating,code_verification_status,is_on_biz_app,platform_type' },
    });
    return data;
  } catch (err) {
    throw metaFail(err, 'Phone number check failed — wrong token or Phone Number ID');
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
    throw ApiError.badRequest('A valid 6-digit PIN is required for Meta phone registration.');
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
    throw metaFail(err, 'Could not get WhatsApp numbers from Meta. Check business permissions and WABA access.', 'discover_phone_numbers');
  }
  const unique = new Map(phones.map((phone) => [phone.phoneNumberId, phone]));
  return [...unique.values()];
}

/**
 * Where one number's state lives: the main number = `whatsapp.*`, an extra number =
 * `extraNumbers.$[n].*` (use with the returned arrayFilters). Returns null for an unknown number.
 */
function numberTarget(org, phoneNumberId) {
  const mainId = org?.whatsapp?.phoneNumberId;
  if (!phoneNumberId || String(phoneNumberId) === String(mainId)) {
    return { extra: false, id: mainId || null, prefix: 'whatsapp', opts: {}, record: org?.whatsapp || {} };
  }
  const rec = (org?.extraNumbers || []).find((n) => n.phoneNumberId === String(phoneNumberId));
  if (!rec) return null;
  return { extra: true, id: rec.phoneNumberId, prefix: 'extraNumbers.$[n]', opts: { arrayFilters: [{ 'n.phoneNumberId': rec.phoneNumberId }] }, record: rec };
}

/** Plan limit + duplicate checks for adding an extra number. `reconnect` allows re-saving an existing extra. */
async function assertCanAddExtra(orgId, phoneNumberId, { reconnect = false } = {}) {
  const org = await Organization.findById(orgId).select('+whatsapp.accessTokenEncrypted').lean();
  if (!org?.whatsapp?.phoneNumberId && org?.whatsapp?.connectedVia !== 'env') throw ApiError.badRequest('Connect your main WhatsApp number first');
  const { limitsFor } = require('../../config/plans');
  const limit = limitsFor(org).whatsappNumbers;
  const count = 1 + (org.extraNumbers || []).length;
  const already = (org.extraNumbers || []).some((n) => n.phoneNumberId === String(phoneNumberId));
  if (phoneNumberId && String(phoneNumberId) === org.whatsapp?.phoneNumberId) throw ApiError.conflict('This number is already your main WhatsApp number.');
  if (already && !reconnect) throw ApiError.conflict('This number is already connected');
  if (!already && limit != null && count + 1 > limit) {
    throw new ApiError(403, `Your plan allows ${limit} WhatsApp number(s). Upgrade your plan or add an "Extra WhatsApp number".`, { code: 'PLAN_LIMIT', key: 'whatsappNumbers', limit });
  }
  return { org, already };
}

/**
 * Exchange the one-time OAuth code exactly once and persist a short-lived,
 * encrypted attempt. This supports Meta events that return a WABA but omit
 * phone_number_id, and lets the user retry a wrong PIN without repeating OAuth.
 */
async function prepareEmbedded(orgId, userId, { code, wabaId, phoneNumberId, eventType, target = 'main', label = '', reconnectPhoneNumberId = null }) {
  const isCoexistence = eventType === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
  const isExtra = target === 'extra';
  // Extra number: fail early (before using the one-time Meta code) when the plan has no room.
  if (isExtra) await assertCanAddExtra(orgId, reconnectPhoneNumberId || phoneNumberId || null, { reconnect: Boolean(reconnectPhoneNumberId) });
  if (!code || !/^\d+$/.test(String(wabaId || ''))) {
    throw ApiError.badRequest('Meta did not return a signup code or WhatsApp Business Account ID. Connect with Facebook again.', {
      code: 'META_SIGNUP_DATA_INCOMPLETE', stage: 'receive_signup_result',
    });
  }
  const token = await exchangeCode(code);
  let availablePhones = await listWabaPhoneNumbers(token, wabaId);
  // Coexistence: the number can take a few seconds to show up in the WABA after onboarding.
  for (let i = 0; isCoexistence && !availablePhones.length && i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    availablePhones = await listWabaPhoneNumbers(token, wabaId);
  }
  if (!availablePhones.length) {
    throw ApiError.badRequest(
      'Meta signup finished, but no phone number is accessible in this WhatsApp Business Account. Reopen the Meta flow to add/verify a number. To use an existing WhatsApp Business App number, check Coexistence eligibility.',
      { code: 'META_PHONE_NUMBER_NOT_FOUND', stage: 'discover_phone_numbers' },
    );
  }

  let selectedPhoneNumberId = phoneNumberId ? String(phoneNumberId) : null;
  if (selectedPhoneNumberId && !availablePhones.some((phone) => phone.phoneNumberId === selectedPhoneNumberId)) {
    throw ApiError.badRequest(
      'The number Meta returned is not in the selected WhatsApp Business Account. Select the right account and try again.',
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
    isCoexistence,
    target: isExtra ? 'extra' : 'main',
    label: String(label || '').slice(0, 60),
    reconnectPhoneNumberId: isExtra && reconnectPhoneNumberId ? String(reconnectPhoneNumberId) : null,
    status: 'pending',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });

  // A new valid Meta handoff supersedes stale error banners from an earlier attempt (main number only).
  if (!isExtra) {
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
  }

  return {
    target: isExtra ? 'extra' : 'main',
    attemptId: String(attempt._id),
    wabaId: String(wabaId),
    phoneNumbers: availablePhones,
    selectedPhoneNumberId,
    needsPhoneSelection: !selectedPhoneNumberId && availablePhones.length > 1,
    isCoexistence,
    expiresAt: attempt.expiresAt,
  };
}

async function completeEmbedded(orgId, { attemptId, phoneNumberId, pin }) {
  const attempt = await WhatsAppConnectionAttempt.findOneAndUpdate(
    { _id: attemptId, organizationId: orgId, status: 'pending', expiresAt: { $gt: new Date() } },
    { $set: { status: 'completing' } },
    { new: true },
  ).select('+accessTokenEncrypted');
  if (!attempt) {
    throw new ApiError(410, 'Connection session expired or is already in progress. Connect with Facebook again.', {
      code: 'WHATSAPP_CONNECT_ATTEMPT_EXPIRED', stage: 'complete_signup',
    });
  }

  try {
    const selected = attempt.phoneNumbers.find((phone) => phone.phoneNumberId === String(phoneNumberId));
    if (!selected) throw ApiError.badRequest('The selected number is not part of this Meta signup session. Connect with Facebook again.', { code: 'META_PHONE_SELECTION_INVALID', stage: 'validate_phone_number' });
    const isExtra = attempt.target === 'extra';
    const reconnect = isExtra && attempt.reconnectPhoneNumberId === String(phoneNumberId);
    if (isExtra) await assertCanAddExtra(orgId, phoneNumberId, { reconnect });
    await assertNumberFree(orgId, phoneNumberId);
    const token = decrypt(attempt.accessTokenEncrypted);
    if (!token) throw ApiError.badRequest('Could not read the temporary Meta authorization. Connect with Facebook again.', { code: 'META_TOKEN_UNREADABLE', stage: 'exchange_code' });

    const isCoexistence = Boolean(attempt.isCoexistence);
    if (!isCoexistence && !/^\d{6}$/.test(String(pin || ''))) {
      throw ApiError.badRequest('Enter a 6-digit PIN for Meta registration.', { code: 'META_PIN_INVALID', stage: 'register_phone_number' });
    }
    await subscribeApp(token, attempt.wabaId);
    // Coexistence: the number already lives in the WhatsApp Business app. Never call /register.
    if (!isCoexistence) await registerNumber(token, phoneNumberId, pin);
    const info = await phoneInfo(token, phoneNumberId);
    if (isCoexistence && info?.is_on_biz_app === false) {
      throw ApiError.badRequest(
        'Meta did not confirm this number is linked to the WhatsApp Business app. Make sure it runs in Business app 2.24.17 or newer, then retry.',
        { code: 'COEXISTENCE_NOT_ON_BIZ_APP', stage: 'verify_coexistence' },
      );
    }
    // Extra number: stored next to the main one (never replaces or edits it).
    const result = isExtra
      ? await saveExtra(orgId, { token, phoneNumberId, wabaId: attempt.wabaId, via: 'embedded_signup', info, isCoexistence, label: attempt.label })
      : await save(orgId, { token, phoneNumberId, wabaId: attempt.wabaId, via: 'embedded_signup', info, isCoexistence });
    await WhatsAppConnectionAttempt.deleteMany({ organizationId: orgId });
    if (isCoexistence) scheduleCoexistenceSync(orgId, isExtra ? String(phoneNumberId) : null);
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
  const other = await Organization.findOne({ $or: [{ 'whatsapp.phoneNumberId': String(phoneNumberId) }, { 'extraNumbers.phoneNumberId': String(phoneNumberId) }], _id: { $ne: orgId } }).select('_id name').lean();
  if (other) throw ApiError.conflict('This WhatsApp number is already connected to another account.');
}

async function save(orgId, { token, phoneNumberId, wabaId, via, info, isCoexistence = false }) {
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
        'whatsapp.isCoexistence': isCoexistence,
        'whatsapp.coexistence': isCoexistence
          ? { onboardedAt: new Date(), contactsSyncStatus: 'pending', historySyncStatus: 'pending', historySyncProgress: 0 }
          : {},
        'onboarding.whatsappDone': true,
      },
    },
    { new: true }
  ).lean();
  orgService.invalidate(orgId);
  return org;
}

/** Adds (or, when reconnecting, refreshes) an EXTRA number. The main number is never modified. */
async function saveExtra(orgId, { token, phoneNumberId, wabaId, via, info, isCoexistence = false, label = '', keepOwnToken = true }) {
  const id = String(phoneNumberId);
  const existing = await Organization.findOne({ _id: orgId, 'extraNumbers.phoneNumberId': id }).select('_id').lean();
  const fields = {
    businessAccountId: wabaId ? String(wabaId) : null,
    displayPhoneNumber: info?.display_phone_number || null,
    verifiedName: info?.verified_name || null,
    qualityRating: info?.quality_rating || undefined,
    connectedVia: via,
    isCoexistence: Boolean(isCoexistence),
    status: 'connected',
    lastError: null,
    connectedAt: new Date(),
    coexistence: isCoexistence
      ? { onboardedAt: new Date(), contactsSyncStatus: 'pending', historySyncStatus: 'pending', historySyncProgress: 0 }
      : {},
  };
  if (token && keepOwnToken) fields.accessTokenEncrypted = encrypt(token);
  if (existing) {
    const $set = {};
    for (const [k, val] of Object.entries(fields)) if (val !== undefined) $set[`extraNumbers.$[n].${k}`] = val;
    if (label) $set['extraNumbers.$[n].label'] = label;
    await Organization.updateOne({ _id: orgId }, { $set }, { arrayFilters: [{ 'n.phoneNumberId': id }] });
  } else {
    const entry = { label: label || '', phoneNumberId: id };
    for (const [k, val] of Object.entries(fields)) if (val !== undefined) entry[k] = val;
    // Guard against a double click adding the same number twice.
    const r = await Organization.updateOne({ _id: orgId, 'extraNumbers.phoneNumberId': { $ne: id } }, { $push: { extraNumbers: entry } });
    if (r.matchedCount === 0) throw ApiError.conflict('This number is already connected');
  }
  orgService.invalidate(orgId);
  return Organization.findById(orgId).lean();
}

async function connectEmbedded(orgId, { code, wabaId, phoneNumberId, pin }) {
  if (!code || !wabaId || !phoneNumberId) throw ApiError.badRequest('code, wabaId and phoneNumberId are required');
  if (!/^\d{6}$/.test(String(pin || ''))) throw ApiError.badRequest('A valid 6-digit PIN is required for Meta phone registration.');
  await assertNumberFree(orgId, phoneNumberId);
  const token = await exchangeCode(code);
  await subscribeApp(token, wabaId);
  await registerNumber(token, phoneNumberId, pin);
  const info = await phoneInfo(token, phoneNumberId);
  return save(orgId, { token, phoneNumberId, wabaId, via: 'embedded_signup', info });
}

/** Removes the invisible junk people paste along with IDs/tokens (spaces, quotes, "Bearer "). */
function cleanToken(value) {
  return String(value || '').replace(/^\s*bearer\s+/i, '').replace(/[\s"'`]+/g, '');
}
function cleanId(value) {
  return String(value || '').replace(/\D/g, '');
}

async function connectManual(orgId, input) {
  const accessToken = cleanToken(input.accessToken);
  const phoneNumberId = cleanId(input.phoneNumberId);
  const businessAccountId = cleanId(input.businessAccountId);
  if (!accessToken || !phoneNumberId || !businessAccountId) {
    throw ApiError.badRequest('Access token, Phone Number ID and WhatsApp Business Account ID are all required.', { code: 'MANUAL_FIELDS_MISSING', stage: 'manual_connect' });
  }
  if (accessToken.length < 50) {
    throw ApiError.badRequest('The access token looks incomplete. Paste the full (long) token.', { code: 'MANUAL_TOKEN_SHORT', stage: 'manual_connect' });
  }
  if (phoneNumberId === businessAccountId) {
    throw ApiError.badRequest('Phone Number ID and WhatsApp Business Account ID are different. Copy both from WhatsApp Manager → API Setup.', { code: 'MANUAL_IDS_SAME', stage: 'manual_connect' });
  }
  await assertNumberFree(orgId, phoneNumberId);
  const info = await phoneInfo(accessToken, phoneNumberId);
  // The number must belong to the WABA that was entered, otherwise webhooks
  // would be subscribed on the wrong account and replies would never arrive.
  const numbers = await listWabaPhoneNumbers(accessToken, businessAccountId);
  if (numbers.length && !numbers.some((n) => n.phoneNumberId === phoneNumberId)) {
    throw ApiError.badRequest('This number does not belong to this WhatsApp Business Account. Use a Phone Number ID from that account.', { code: 'META_PHONE_WABA_MISMATCH', stage: 'manual_connect' });
  }
  await subscribeApp(accessToken, businessAccountId);
  return save(orgId, { token: accessToken, phoneNumberId, wabaId: businessAccountId, via: 'manual', info });
}

/** Extra numbers (limit from the plan). Manual: Phone Number ID, optional WABA ID / token (token defaults to the main one). */
async function addNumber(orgId, { label, accessToken, phoneNumberId, businessAccountId, reconnect = false }) {
  const { org } = await assertCanAddExtra(orgId, phoneNumberId, { reconnect });
  await assertNumberFree(orgId, phoneNumberId);
  const token = cleanToken(accessToken) || decrypt(org.whatsapp?.accessTokenEncrypted) || env.platformMeta.accessToken;
  const info = await phoneInfo(token, phoneNumberId);
  const wabaId = cleanId(businessAccountId) || org.whatsapp?.businessAccountId;
  if (wabaId && wabaId !== org.whatsapp?.businessAccountId) await subscribeApp(token, wabaId);
  await saveExtra(orgId, { token: accessToken ? token : null, phoneNumberId, wabaId, via: 'manual', info, label: label || '', keepOwnToken: Boolean(accessToken) });
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
        'whatsapp.isCoexistence': false,
        'whatsapp.coexistence': {},
        'onboarding.whatsappDone': false,
      },
    }
  );
  orgService.invalidate(orgId);
}

/** Called when a live send fails with a connection-level Meta error (see metaWhatsappClient). */
async function flagRuntimeError(orgId, metaError) {
  const message = friendlyMetaMessage(metaError, 'WhatsApp messages are not sending.');
  await Organization.updateOne(
    { _id: orgId },
    {
      $set: {
        'whatsapp.lastError': String(message).slice(0, 500),
        'whatsapp.lastErrorCode': String(metaError?.code ?? 'META_RUNTIME').slice(0, 80),
        'whatsapp.lastErrorStage': 'sending',
        'whatsapp.lastErrorAt': new Date(),
        ...(Number(metaError?.code) === 131042 ? { 'whatsapp.paymentIssueAt': new Date() } : {}),
        ...(Number(metaError?.code) === 190 ? { 'whatsapp.status': 'error' } : {}),
      },
    },
  );
  orgService.invalidate(orgId);
  try {
    const org = await Organization.findById(orgId).select('ownerUserId').lean();
    if (org?.ownerUserId) {
      const Notification = require('../../models/Notification');
      const recent = await Notification.findOne({ userId: org.ownerUserId, type: 'whatsapp_connection', createdAt: { $gte: new Date(Date.now() - 6 * 3600 * 1000) } }).lean();
      if (!recent) {
        await Notification.create({ userId: org.ownerUserId, type: 'whatsapp_connection', title: 'WhatsApp connection problem', body: message, link: '/whatsapp' });
        require('../../sockets').emitToUser(org.ownerUserId, 'notification:new', {});
      }
    }
  } catch { /* best effort */ }
  logger.warn('[whatsapp] Runtime connection problem flagged', { orgId: String(orgId), code: metaError?.code });
}

/**
 * One-click "Check connection" for the dashboard. Every step returns a simple
 * ok / warning / error with a one-line fix, so a non-technical owner can see
 * exactly what is missing.
 */
async function healthCheck(orgId, { phoneNumberId: onlyNumber } = {}) {
  const org = await Organization.findById(orgId).select('+whatsapp.accessTokenEncrypted +extraNumbers.accessTokenEncrypted').lean();
  const mainWa = org?.whatsapp || {};
  let wa = mainWa;
  // Optional: check ONE extra number instead of the main one.
  const target = onlyNumber ? numberTarget(org, onlyNumber) : null;
  if (onlyNumber && !target) throw ApiError.notFound('That WhatsApp number is not connected to this account.');
  const extraRec = target?.extra ? target.record : null;
  if (extraRec) {
    wa = {
      status: extraRec.status || 'connected',
      connectedVia: extraRec.connectedVia || 'manual',
      phoneNumberId: extraRec.phoneNumberId,
      businessAccountId: extraRec.businessAccountId || mainWa.businessAccountId,
      accessTokenEncrypted: extraRec.accessTokenEncrypted || mainWa.accessTokenEncrypted,
      isCoexistence: Boolean(extraRec.isCoexistence),
      displayPhoneNumber: extraRec.displayPhoneNumber,
      qualityRating: extraRec.qualityRating,
      paymentIssueAt: mainWa.paymentIssueAt || null,
      webhookLastReceivedAt: extraRec.webhookLastReceivedAt || null,
    };
  }
  const viaEnv = wa.connectedVia === 'env';
  const token = viaEnv ? env.platformMeta.accessToken : decrypt(wa.accessTokenEncrypted);
  const phoneNumberId = viaEnv ? env.platformMeta.phoneNumberId : wa.phoneNumberId;
  const wabaId = viaEnv ? env.platformMeta.businessAccountId : wa.businessAccountId;
  const steps = [];
  const add = (key, label, state, help = '') => steps.push({ key, label, state, help });

  if (!phoneNumberId || !token) {
    add('connected', 'WhatsApp number connected', 'error', 'No number connected. Click "Connect with Facebook".');
    return { ok: false, steps, checkedAt: new Date() };
  }
  add('connected', 'WhatsApp number connected', 'ok');

  const auth = { headers: { Authorization: `Bearer ${token}` } };
  let phone = null;
  try {
    const { data } = await graph.get(`https://graph.facebook.com/${v()}/${phoneNumberId}`, {
      ...auth,
      params: { fields: 'display_phone_number,verified_name,quality_rating,code_verification_status,name_status,status,messaging_limit_tier,platform_type,is_on_biz_app' },
    });
    phone = data;
    add('token', 'Facebook permission is active', 'ok');
  } catch (err) {
    const metaError = err.response?.data?.error;
    add('token', 'Facebook permission is active', 'error', friendlyMetaMessage(metaError, 'Token is not working. Please reconnect.'));
    return { ok: false, steps, checkedAt: new Date() };
  }

  const status = String(phone.status || '').toUpperCase();
  if (phone.platform_type && String(phone.platform_type).toUpperCase() !== 'CLOUD_API') {
    add('registered', 'Number is registered on Cloud API', 'error', 'Number is not registered. Reconnect and enter the 6-digit PIN.');
  } else if (['BANNED', 'RESTRICTED', 'FLAGGED', 'DISCONNECTED'].includes(status)) {
    add('registered', 'Number is active', 'error', `Meta marked the number as ${status.toLowerCase()}. Check its status in WhatsApp Manager.`);
  } else {
    add('registered', 'Number is active', 'ok', phone.display_phone_number ? `${phone.display_phone_number}${phone.verified_name ? ` · ${phone.verified_name}` : ''}` : '');
  }

  if (wa.isCoexistence) {
    const stillOnApp = phone.is_on_biz_app === true;
    add('coexistence', 'Running alongside the WhatsApp Business app', stillOnApp ? 'ok' : 'warning', stillOnApp ? 'You can chat from both the phone app and Visitsly.' : 'Meta no longer sees this number on the Business app. Check Settings → Account → Business Platform on the phone.');
  }

  const quality = String(phone.quality_rating || '').toUpperCase();
  if (quality === 'RED') add('quality', 'Message quality', 'error', 'Quality is LOW — people are blocking/reporting messages. Send fewer bulk messages and only to interested contacts.');
  else if (quality === 'YELLOW') add('quality', 'Message quality', 'warning', 'Quality is MEDIUM. Send bulk messages carefully.');
  else add('quality', 'Message quality', 'ok', quality ? 'HIGH' : '');

  const nameStatus = String(phone.name_status || '').toUpperCase();
  if (nameStatus && !['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'].includes(nameStatus)) {
    add('display_name', 'Business display name approved', nameStatus === 'DECLINED' ? 'error' : 'pending', nameStatus === 'DECLINED' ? 'Meta rejected the display name. Change it in WhatsApp Manager > Phone numbers and resubmit.' : 'Display name is in Meta review. Messages will not send until it is approved (error 131037). Check WhatsApp Manager > Phone numbers > Display name; this takes minutes to 48 hours.');
  }

  if (phone.messaging_limit_tier) {
    const tier = String(phone.messaging_limit_tier).replace('TIER_', '').replace('_', ' ');
    add('limit', 'Daily limit for new customers', 'ok', `${tier} / day (increases after Meta business verification)`);
  }

  if (wabaId) {
    try {
      const { data } = await graph.get(`https://graph.facebook.com/${v()}/${wabaId}/subscribed_apps`, auth);
      const apps = Array.isArray(data?.data) ? data.data : [];
      const ours = !env.platformMeta.appId || apps.some((a) => String(a?.whatsapp_business_api_data?.id || a?.id) === String(env.platformMeta.appId));
      add('webhook', 'Customer replies reach you (webhook)', ours ? 'ok' : 'error', ours ? '' : 'Reply connection is off. Click "Fix" below.');
    } catch (err) {
      add('webhook', 'Customer replies reach you (webhook)', 'warning', friendlyMetaMessage(err.response?.data?.error, 'Could not check webhook status.'));
    }
    try {
      const { data } = await graph.get(`https://graph.facebook.com/${v()}/${wabaId}/message_templates`, { ...auth, params: { status: 'APPROVED', limit: 50, fields: 'name' } });
      const count = Array.isArray(data?.data) ? data.data.length : 0;
      add('templates', 'Approved message templates', count ? 'ok' : 'warning', count ? `${count}${data?.paging?.next ? '+' : ''} approved` : 'No approved templates yet. The first message to new customers must be a template — create one on the Templates page.');
    } catch (err) {
      add('templates', 'Approved message templates', 'warning', friendlyMetaMessage(err.response?.data?.error, 'Could not check templates.'));
    }
  }

  if (wa.paymentIssueAt) {
    add('payment', 'Meta payment method', 'error', 'Meta rejected the last message because no payment method is set (error 131042). Add a card in Meta Billing, then send a test message.');
  } else {
    add('payment', 'Meta payment method', 'ok', '');
  }

  const lastHook = wa.webhookLastReceivedAt ? new Date(wa.webhookLastReceivedAt) : null;
  if (lastHook) add('activity', 'Last update from WhatsApp', 'ok', lastHook.toISOString());
  else add('activity', 'Last update from WhatsApp', 'warning', 'No messages yet. Send "Hi" from your personal number to the business number to test.');

  const ok = !steps.some((s) => s.state === 'error');
  if (extraRec) {
    const $set = { 'extraNumbers.$[n].qualityRating': phone.quality_rating || wa.qualityRating || null };
    if (ok) { $set['extraNumbers.$[n].status'] = 'connected'; $set['extraNumbers.$[n].lastError'] = null; }
    await Organization.updateOne({ _id: orgId }, { $set }, { arrayFilters: [{ 'n.phoneNumberId': extraRec.phoneNumberId }] });
    orgService.invalidate(orgId);
    const pendingX = steps.some((st) => st.state === 'pending');
    return { ok: ok && !pendingX, steps, checkedAt: new Date(), phoneNumberId: extraRec.phoneNumberId, phone: { display: phone.display_phone_number || wa.displayPhoneNumber || '', name: phone.verified_name || '', nameStatus } };
  }
  await Organization.updateOne({ _id: orgId }, { $set: ok ? { 'whatsapp.lastError': null, 'whatsapp.lastErrorCode': null, 'whatsapp.lastErrorStage': null, 'whatsapp.lastErrorAt': null, 'whatsapp.status': 'connected', 'whatsapp.qualityRating': phone.quality_rating || wa.qualityRating || null } : { 'whatsapp.qualityRating': phone.quality_rating || wa.qualityRating || null } });
  orgService.invalidate(orgId);
  const pending = steps.some((st) => st.state === 'pending');
  return { ok: ok && !pending, steps, checkedAt: new Date(), phone: { display: phone.display_phone_number || wa.displayPhoneNumber || '', name: phone.verified_name || '', nameStatus } };
}

/** "Fix" for a missing webhook subscription. */
async function resubscribeWebhook(orgId, { phoneNumberId: onlyNumber } = {}) {
  const org = await Organization.findById(orgId).select('+whatsapp.accessTokenEncrypted +extraNumbers.accessTokenEncrypted').lean();
  let wa = org?.whatsapp || {};
  const target = onlyNumber ? numberTarget(org, onlyNumber) : null;
  if (onlyNumber && !target) throw ApiError.notFound('That WhatsApp number is not connected to this account.');
  if (target?.extra) {
    wa = { connectedVia: target.record.connectedVia || 'manual', accessTokenEncrypted: target.record.accessTokenEncrypted || wa.accessTokenEncrypted, businessAccountId: target.record.businessAccountId || wa.businessAccountId };
  }
  const viaEnv = wa.connectedVia === 'env';
  const token = viaEnv ? env.platformMeta.accessToken : decrypt(wa.accessTokenEncrypted);
  const wabaId = viaEnv ? env.platformMeta.businessAccountId : wa.businessAccountId;
  if (!token || !wabaId) throw ApiError.badRequest('Connect a WhatsApp number first.');
  await subscribeApp(token, wabaId);
  return healthCheck(orgId, onlyNumber ? { phoneNumberId: onlyNumber } : {});
}

/** { limit, used, canAdd } for the "Add number" button (limit null = unlimited). */
function numberLimit(org) {
  try {
    const { limitsFor } = require('../../config/plans');
    const limit = limitsFor(org).whatsappNumbers;
    const used = (org?.whatsapp?.phoneNumberId || org?.whatsapp?.connectedVia === 'env' ? 1 : 0) + (org?.extraNumbers || []).length;
    return { limit: limit == null ? null : limit, used, canAdd: limit == null || used < limit };
  } catch {
    return { limit: null, used: (org?.extraNumbers || []).length + 1, canAdd: true };
  }
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
    openingTemplateCategory: wa.openingTemplateCategory || null,
    openingTemplateVariables: wa.openingTemplateVariables || [],
    openingTemplateSelectedAt: wa.openingTemplateSelectedAt || null,
    connectedAt: wa.connectedAt || null,
    paymentIssueAt: wa.paymentIssueAt || null,
    lastError: wa.lastError || null,
    lastErrorCode: wa.lastErrorCode || null,
    lastErrorStage: wa.lastErrorStage || null,
    lastErrorAt: wa.lastErrorAt || null,
    webhookLastReceivedAt: wa.webhookLastReceivedAt || null,
    webhookLastMessageAt: wa.webhookLastMessageAt || null,
    isCoexistence: Boolean(wa.isCoexistence),
    coexistence: wa.isCoexistence ? {
      onboardedAt: wa.coexistence?.onboardedAt || null,
      syncDeadline: wa.coexistence?.onboardedAt ? new Date(new Date(wa.coexistence.onboardedAt).getTime() + COEX_SYNC_WINDOW_MS) : null,
      contactsSyncStatus: wa.coexistence?.contactsSyncStatus || null,
      historySyncStatus: wa.coexistence?.historySyncStatus || null,
      historySyncProgress: wa.coexistence?.historySyncProgress || 0,
      syncError: wa.coexistence?.syncError || null,
      disconnectedFromPhoneAt: wa.coexistence?.disconnectedFromPhoneAt || null,
    } : null,
    testMessageSentAt: wa.testMessageSentAt || null,
    testMessageTo: wa.testMessageTo || null,
    // Never includes tokens.
    extraNumbers: (org?.extraNumbers || []).map((n) => ({
      label: n.label || '',
      phoneNumberId: n.phoneNumberId,
      businessAccountId: n.businessAccountId || null,
      displayPhoneNumber: n.displayPhoneNumber || null,
      verifiedName: n.verifiedName || null,
      qualityRating: n.qualityRating || null,
      status: n.status || 'connected',
      connectedVia: n.connectedVia || 'manual',
      isCoexistence: Boolean(n.isCoexistence),
      lastError: n.lastError || null,
      connectedAt: n.connectedAt || null,
      coexistence: n.isCoexistence ? {
        onboardedAt: n.coexistence?.onboardedAt || null,
        syncDeadline: n.coexistence?.onboardedAt ? new Date(new Date(n.coexistence.onboardedAt).getTime() + COEX_SYNC_WINDOW_MS) : null,
        contactsSyncStatus: n.coexistence?.contactsSyncStatus || null,
        historySyncStatus: n.coexistence?.historySyncStatus || null,
        historySyncProgress: n.coexistence?.historySyncProgress || 0,
        syncError: n.coexistence?.syncError || null,
      } : null,
    })),
    numbers: numberLimit(org),
    embeddedSignup: {
      available: Boolean(env.platformMeta.appId && env.platformMeta.embeddedSignupConfigId),
      appId: env.platformMeta.appId || null,
      configId: env.platformMeta.embeddedSignupConfigId || null,
      solutionId: env.platformMeta.embeddedSignupSolutionId || null,
      apiVersion: env.platformMeta.apiVersion,
    },
  };
}

/* ---------------- Coexistence: 24h data sync ---------------- */

const COEX_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

async function coexOrg(orgId, phoneNumberId = null) {
  const org = await Organization.findById(orgId).select('+whatsapp.accessTokenEncrypted +extraNumbers.accessTokenEncrypted').lean();
  const target = org ? numberTarget(org, phoneNumberId) : null;
  const rec = target?.record || {};
  if (!org || !target || !rec.isCoexistence || !target.id) {
    throw ApiError.badRequest('This number is not connected via coexistence.', { code: 'NOT_COEXISTENCE' });
  }
  const token = decrypt(rec.accessTokenEncrypted || (target.extra ? org.whatsapp?.accessTokenEncrypted : null));
  if (!token) throw ApiError.badRequest('Could not read Meta authorization. Connect with Facebook again.', { code: 'META_TOKEN_UNREADABLE' });
  return { org, wa: rec, token, target };
}

/**
 * Asks Meta to send contacts and then chat history of the Business app.
 * Meta allows each call ONCE per onboarding and only within 24 hours, so a
 * call that already succeeded (or was declined) is never repeated.
 * `phoneNumberId` = which number (omitted = main number).
 */
async function startCoexistenceSync(orgId, phoneNumberId = null) {
  const { wa, token, target } = await coexOrg(orgId, phoneNumberId);
  const P = target.prefix;
  const upd = (set) => Organization.updateOne({ _id: orgId }, { $set: set }, target.opts);
  const startedAt = wa.coexistence?.onboardedAt ? new Date(wa.coexistence.onboardedAt).getTime() : Date.now();
  if (Date.now() - startedAt > COEX_SYNC_WINDOW_MS) {
    await upd({ [`${P}.coexistence.syncError`]: 'Meta’s 24-hour sync window has ended. Disconnect the number in the phone app and reconnect to sync.' });
    orgService.invalidate(orgId);
    throw ApiError.badRequest('The 24-hour sync window has ended. Disconnect via Settings → Account → Business Platform on the phone and reconnect.', { code: 'COEXISTENCE_SYNC_WINDOW_CLOSED' });
  }
  const steps = [
    { type: 'smb_app_state_sync', status: `${P}.coexistence.contactsSyncStatus`, reqId: `${P}.coexistence.contactsSyncRequestId`, current: wa.coexistence?.contactsSyncStatus },
    { type: 'history', status: `${P}.coexistence.historySyncStatus`, reqId: `${P}.coexistence.historySyncRequestId`, current: wa.coexistence?.historySyncStatus },
  ];
  const failures = [];
  for (const step of steps) {
    if (['requested', 'done', 'declined'].includes(step.current)) continue;
    try {
      const { data } = await graph.post(
        `https://graph.facebook.com/${v()}/${target.id}/smb_app_data`,
        { messaging_product: 'whatsapp', sync_type: step.type },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      await upd({ [step.status]: 'requested', [step.reqId]: data?.request_id ? String(data.request_id) : null, [`${P}.coexistence.syncError`]: null });
    } catch (err) {
      const failure = metaFail(err, `${step.type} sync request failed`, 'coexistence_sync');
      failures.push(failure.message);
      await upd({ [step.status]: 'failed', [`${P}.coexistence.syncError`]: String(failure.message).slice(0, 400) });
      logger.warn('[whatsapp] Coexistence sync request failed', { orgId: String(orgId), phoneNumberId: target.id, syncType: step.type, error: failure.message });
    }
  }
  orgService.invalidate(orgId);
  if (failures.length) throw ApiError.badRequest(failures[0], { code: 'COEXISTENCE_SYNC_FAILED', stage: 'coexistence_sync' });
}

/** Runs the sync in the background right after onboarding, retrying a few times. */
function scheduleCoexistenceSync(orgId, phoneNumberId = null) {
  const delays = [0, 30 * 1000, 3 * 60 * 1000, 15 * 60 * 1000];
  const attempt = (i) => {
    const timer = setTimeout(async () => {
      try {
        await startCoexistenceSync(orgId, phoneNumberId);
      } catch (err) {
        if (i + 1 < delays.length && err?.details?.code !== 'COEXISTENCE_SYNC_WINDOW_CLOSED') attempt(i + 1);
        else logger.warn('[whatsapp] Coexistence sync gave up (use the retry button in the dashboard)', { orgId: String(orgId), phoneNumberId: phoneNumberId || 'main', error: err.message });
      }
    }, delays[i]);
    if (timer.unref) timer.unref();
  };
  attempt(0);
}

/**
 * "Test message" after connecting: sends a message to the owner's own number so
 * they can see the connection really works. Plain text works when that person
 * has messaged the business number in the last 24h; otherwise falls back to
 * Meta's default "hello_world" template.
 */
async function sendTestMessage(orgId, { phone, text }) {
  const org = await Organization.findById(orgId).select('+whatsapp.accessTokenEncrypted').lean();
  const wa = org?.whatsapp || {};
  const viaEnv = wa.connectedVia === 'env';
  const token = viaEnv ? env.platformMeta.accessToken : decrypt(wa.accessTokenEncrypted);
  const phoneNumberId = viaEnv ? env.platformMeta.phoneNumberId : wa.phoneNumberId;
  if (!token || !phoneNumberId || wa.status !== 'connected') {
    throw ApiError.badRequest('Connect a WhatsApp number first.', { code: 'WHATSAPP_NOT_CONNECTED' });
  }
  let to = String(phone || '').replace(/\D/g, '');
  if (to.length === 10) to = `${env.platformMeta.defaultCountryCode || '91'}${to}`;
  if (to.length < 9 || to.length > 15) throw ApiError.badRequest('Enter a valid number with country code (e.g. 919876543210).');
  if (to === String(wa.displayPhoneNumber || '').replace(/\D/g, '')) {
    throw ApiError.badRequest('That is the business number. Use your personal WhatsApp number for the test.');
  }

  const url = `https://graph.facebook.com/${v()}/${phoneNumberId}/messages`;
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const body = String(text || '').trim() || 'Visitsly test message ✅ Your WhatsApp number is connected.';
  let messageId = null;
  let mode = 'text';
  try {
    const { data } = await graph.post(url, { messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } }, auth);
    messageId = data?.messages?.[0]?.id || null;
  } catch (err) {
    const metaError = err.response?.data?.error;
    if (Number(metaError?.code) !== 131047) throw metaFail(err, 'Test message failed', 'test_message');
    // 24h window closed -> Meta's standard sample template.
    mode = 'template';
    try {
      const { data } = await graph.post(url, { messaging_product: 'whatsapp', to, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } }, auth);
      messageId = data?.messages?.[0]?.id || null;
    } catch (err2) {
      const sendErr = metaFail(err2, 'Test message failed', 'test_message');
      throw ApiError.badRequest(
        `${sendErr.message} Tip: send "Hi" from your personal WhatsApp to the business number (opens a 24-hour window), then send the test again.`,
        { ...(sendErr.details || {}), code: 'TEST_MESSAGE_FAILED', stage: 'test_message' },
      );
    }
  }
  await Organization.updateOne({ _id: orgId }, { $set: { 'whatsapp.testMessageSentAt': new Date(), 'whatsapp.testMessageTo': `${to.slice(0, 2)}******${to.slice(-3)}` } });
  orgService.invalidate(orgId);
  return { messageId, mode };
}

module.exports = { numberTarget, saveExtra, startCoexistenceSync, scheduleCoexistenceSync, sendTestMessage, healthCheck, resubscribeWebhook, flagRuntimeError, friendlyMetaMessage, connectEmbedded, prepareEmbedded, completeEmbedded, recordConnectionError, connectManual, disconnect, publicView, addNumber, removeNumber };
