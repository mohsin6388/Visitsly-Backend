const Settings = require('../../models/Settings');
const { encrypt, decrypt } = require('../../utils/crypto');
const tenantContext = require('../../context/tenantContext');

/**
 * Multi-tenant: one Settings document per company, picked from the current
 * tenant context. Outside a tenant (legacy single-client mode) the old
 * single document (no orgId) is used.
 */
function scope(orgId) {
  const id = orgId || tenantContext.orgId();
  return id ? { orgId: id } : {};
}

function defaultsFor(orgId) {
  const org = tenantContext.getOrg();
  const name = org && String(org._id) === String(orgId || org._id) ? org.name : '';
  return {
    ...(orgId ? { orgId } : {}),
    companyName: name || '',
    openingText: name
      ? `Namaste! Thank you for your interest in ${name}. Main aapki property search mein help kar sakta/sakti hoon. Aap kis type ki property dekh rahe hain?`
      : '',
  };
}

/**
 * Single-tenant deployment — there is exactly ONE Settings document for the
 * whole app (no organizationId scoping). Lazily created on first access.
 */
async function getOrCreateSettings(orgId) {
  const filter = scope(orgId);
  let settings = await Settings.findOne(filter);
  if (!settings) {
    try {
      settings = await Settings.create(defaultsFor(filter.orgId));
    } catch (err) {
      if (err.code !== 11000) throw err;
      settings = await Settings.findOne(filter); // lost a creation race
    }
  }
  return settings;
}

/** Public-safe settings (never exposes the raw Gemini key, only whether one is set). */
async function getPublicSettings(orgId) {
  const settings = await getOrCreateSettings(orgId);
  const withKey = await Settings.findOne(scope(orgId)).select('+geminiApiKeyEncrypted');

  return {
    ...settings.toObject(),
    geminiApiKeyEncrypted: undefined,
    geminiKeyConfigured: !!withKey?.geminiApiKeyEncrypted,
  };
}

async function updateSettings(updates, orgId) {
  const settings = await getOrCreateSettings(orgId);

  const { geminiApiKey, ...rest } = updates;
  Object.assign(settings, rest);

  if (geminiApiKey !== undefined) {
    settings.geminiApiKeyEncrypted = geminiApiKey ? encrypt(geminiApiKey) : null;
  }

  await settings.save();
  return getPublicSettings(orgId);
}

/**
 * Returns the configured Gemini key, falling back to the platform-wide
 * GEMINI_API_KEY env var so the product works out-of-the-box before the
 * broker/builder has configured their own key in Settings.
 */
async function getGeminiKey(orgId) {
  const settings = await Settings.findOne(scope(orgId)).select('+geminiApiKeyEncrypted');
  const configuredKey = settings ? decrypt(settings.geminiApiKeyEncrypted) : null;
  return configuredKey || process.env.GEMINI_API_KEY || null;
}

module.exports = { getOrCreateSettings, getPublicSettings, updateSettings, getGeminiKey };
