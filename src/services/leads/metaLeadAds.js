const axios = require('axios');
const env = require('../../config/env');
const Organization = require('../../models/Organization');
const ApiError = require('../../utils/ApiError');
const { encrypt, decrypt } = require('../../utils/crypto');
const orgService = require('../saas/orgService');
const tenantContext = require('../../context/tenantContext');
const { captureLead } = require('./leadCapture');
const logger = require('../../utils/logger');

/**
 * Meta (Facebook / Instagram) Lead Ads → PropAI, no Zapier needed.
 * The company connects its Facebook Page; PropAI subscribes its app to the
 * page's `leadgen` field. Meta then calls /api/webhooks/meta-leads with a
 * leadgen_id, and we fetch the answers with the page token.
 *
 * Needs on PropAI's Meta app: permissions leads_retrieval, pages_show_list,
 * pages_manage_metadata, pages_read_engagement (App Review), and a "Page"
 * webhook subscription to `leadgen` pointing at /api/webhooks/meta-leads.
 */
const graph = axios.create({ timeout: 20000 });
const v = () => env.platformMeta.apiVersion;
const pageCache = new Map(); // `${orgId}` -> { at, pages:[{id,name,token}] }

function fail(err, fallback) {
  const e = err.response?.data?.error;
  return ApiError.badRequest(e?.error_user_msg || e?.message || err.message || fallback, { code: 'META_ERROR' });
}

/** Step 1: user logged in with Facebook in the browser → list their pages. */
async function listPages(orgId, userAccessToken) {
  const { appId, appSecret } = env.platformMeta;
  let longToken = userAccessToken;
  if (appId && appSecret) {
    try {
      const { data } = await graph.get(`https://graph.facebook.com/${v()}/oauth/access_token`, {
        params: { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: userAccessToken },
      });
      longToken = data.access_token || userAccessToken;
    } catch (err) {
      throw fail(err, 'Facebook token exchange failed');
    }
  }
  try {
    const { data } = await graph.get(`https://graph.facebook.com/${v()}/me/accounts`, {
      params: { access_token: longToken, fields: 'id,name,access_token,tasks', limit: 100 },
    });
    const pages = (data.data || []).map((p) => ({ id: p.id, name: p.name, token: p.access_token }));
    pageCache.set(String(orgId), { at: Date.now(), pages });
    return pages.map(({ id, name }) => ({ id, name }));
  } catch (err) {
    throw fail(err, 'Pages load nahi hue');
  }
}

async function subscribePage(pageId, pageToken) {
  try {
    await graph.post(`https://graph.facebook.com/${v()}/${pageId}/subscribed_apps`, null, {
      params: { subscribed_fields: 'leadgen', access_token: pageToken },
    });
  } catch (err) {
    throw fail(err, 'Page subscribe nahi hua');
  }
}

/** Step 2 (or manual): connect one page. */
async function connectPage(orgId, { pageId, pageToken, pageName }) {
  let token = pageToken;
  let name = pageName;
  if (!token) {
    const cached = pageCache.get(String(orgId));
    const page = cached?.pages.find((p) => p.id === String(pageId));
    if (!page) throw ApiError.badRequest('Page list purani ho gayi — dobara Facebook se connect karein');
    token = page.token;
    name = page.name;
  }
  const other = await Organization.findOne({ 'leadCapture.metaPageId': String(pageId), _id: { $ne: orgId } }).select('_id').lean();
  if (other) throw ApiError.conflict('Ye Facebook Page kisi aur PropAI account se juda hai');
  await subscribePage(pageId, token);
  if (!name) {
    try {
      const { data } = await graph.get(`https://graph.facebook.com/${v()}/${pageId}`, { params: { fields: 'name', access_token: token } });
      name = data.name;
    } catch { /* optional */ }
  }
  await Organization.updateOne(
    { _id: orgId },
    { $set: { 'leadCapture.metaPageId': String(pageId), 'leadCapture.metaPageName': name || null, 'leadCapture.metaPageTokenEncrypted': encrypt(token), 'leadCapture.metaConnectedAt': new Date() } }
  );
  orgService.invalidate(orgId);
  pageCache.delete(String(orgId));
  return { pageId: String(pageId), pageName: name || null };
}

async function disconnectPage(orgId) {
  await Organization.updateOne({ _id: orgId }, { $set: { 'leadCapture.metaPageId': null, 'leadCapture.metaPageName': null, 'leadCapture.metaPageTokenEncrypted': null, 'leadCapture.metaConnectedAt': null } });
  orgService.invalidate(orgId);
}

/** Converts Meta field_data into our lead fields. Unknown questions go to the message. */
function mapFieldData(fieldData = []) {
  const out = { extra: [] };
  for (const f of fieldData) {
    const key = String(f.name || '').toLowerCase();
    const value = Array.isArray(f.values) ? f.values.join(', ') : String(f.values || '');
    if (!value) continue;
    if (['full_name', 'name', 'first_name'].includes(key)) out.name = out.name ? `${value} ${out.name}` : value;
    else if (key === 'last_name') out.name = out.name ? `${out.name} ${value}` : value;
    else if (['phone_number', 'phone', 'mobile', 'whatsapp_number'].includes(key)) out.phone = value;
    else if (key === 'email') out.email = value;
    else if (key === 'city') out.city = value;
    else out.extra.push(`${f.name.replace(/_/g, ' ')}: ${value}`);
  }
  return out;
}

async function handleLeadgen(change) {
  const value = change?.value || {};
  const pageId = String(value.page_id || '');
  const org = await Organization.findOne({ 'leadCapture.metaPageId': pageId }).select('_id +leadCapture.metaPageTokenEncrypted').lean();
  if (!org) {
    logger.warn(`[meta-leads] leadgen for unknown page ${pageId}`);
    return;
  }
  const token = decrypt(org.leadCapture.metaPageTokenEncrypted);
  let lead;
  try {
    const { data } = await graph.get(`https://graph.facebook.com/${v()}/${value.leadgen_id}`, {
      params: { access_token: token, fields: 'created_time,field_data,ad_name,campaign_name,form_id,platform' },
    });
    lead = data;
  } catch (err) {
    logger.error('[meta-leads] Could not fetch lead', { leadgenId: value.leadgen_id, error: err.response?.data?.error?.message || err.message });
    return;
  }
  const mapped = mapFieldData(lead.field_data);
  await orgService.runForOrg(org._id, () => captureLead({
    ...mapped,
    message: mapped.extra.join(' | '),
    source: lead.platform === 'ig' ? 'instagram_ads' : 'facebook_ads',
    sourceDetail: [lead.campaign_name, lead.ad_name].filter(Boolean).join(' / ') || `form ${lead.form_id || value.form_id}`,
    externalId: `meta:${value.leadgen_id}`,
  }));
}

async function handleWebhook(payload) {
  if (!payload || payload.object !== 'page') return;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'leadgen') {
        await handleLeadgen(change).catch((err) => logger.error('[meta-leads] failed', { error: err.message }));
      }
    }
  }
}

module.exports = { listPages, connectPage, disconnectPage, handleWebhook, mapFieldData, tenantContext };
