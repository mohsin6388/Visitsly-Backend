const axios = require("axios");
const env = require("../../config/env");
const tenantContext = require("../../context/tenantContext");
const Organization = require("../../models/Organization");
const WhatsAppTemplateAsset = require("../../models/WhatsAppTemplateAsset");
const logger = require("../../utils/logger");

/**
 * Per-organization WhatsApp OPENING template.
 *
 * Tenant rules enforced here:
 *   - The organization comes ONLY from tenantContext (set from the
 *     authenticated user / the lead's owner by orgService.runForOwner).
 *   - Credentials come from the same tenant-aware `env.metaWhatsapp` getter the
 *     Meta client sends with, so the template is always looked up in the SAME
 *     WhatsApp Business Account the message goes out from.
 *   - The selected template is read fresh from THAT organization's document.
 *     No env variable is ever consulted for a template name.
 *   - The template cache is keyed by organization id + WABA id.
 */

const TEMPLATE_FIELDS =
  "id,name,language,status,category,components,rejected_reason,parameter_format";
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // `${orgId}:${wabaId}` -> { at, templates }

const NAME_LIKE = new Set([
  "name",
  "first_name",
  "firstname",
  "customer_name",
  "customer",
  "lead_name",
  "client_name",
  "user_name",
]);
const SUPPORTED_BUTTONS = new Set(["QUICK_REPLY", "URL", "PHONE_NUMBER"]);

function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolves who we are working for. In SaaS mode a tenant is mandatory — we
 * never fall through to platform-level values.
 */
function currentContext() {
  const org = tenantContext.getOrg();
  if (env.saas.enabled && !org?._id) {
    throw fail(
      "TENANT_CONTEXT_MISSING",
      "Could not determine which organization this WhatsApp action belongs to. Nothing was sent.",
    );
  }
  const meta = env.metaWhatsapp; // tenant-aware getter
  return {
    org: org || null,
    orgId: org?._id ? String(org._id) : null,
    ownerId: org?.ownerUserId ? String(org.ownerUserId) : null,
    accessToken: meta.accessToken,
    businessAccountId: meta.businessAccountId,
    apiVersion: meta.apiVersion,
  };
}

function assertConnected(ctx) {
  if (!ctx.accessToken || !ctx.businessAccountId) {
    throw fail(
      "WHATSAPP_NOT_CONNECTED",
      "WhatsApp is not connected for this organization. Connect your WhatsApp Business Account first.",
    );
  }
}

function cacheKey(ctx) {
  return `${ctx.orgId || "single"}:${ctx.businessAccountId}`;
}

function clearCache(ctx = currentContext()) {
  cache.delete(cacheKey(ctx));
}

/* ------------------------------------------------------------------ */
/* Meta fetch                                                          */
/* ------------------------------------------------------------------ */

async function fetchFromMeta(ctx) {
  const all = [];
  let url = `https://graph.facebook.com/${ctx.apiVersion}/${ctx.businessAccountId}/message_templates`;
  let params = { fields: TEMPLATE_FIELDS, limit: 100 };
  for (let page = 0; url && page < 5; page += 1) {
    const response = await axios.get(url, {
      params,
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
      timeout: 15000,
    });
    all.push(...(response.data?.data || []));
    url = response.data?.paging?.next || null;
    params = undefined;
  }
  return all.map((item) => ({
    id: item.id || null,
    name: item.name,
    language: item.language,
    category: item.category || "",
    status: item.status || "UNKNOWN",
    parameterFormat: String(item.parameter_format || "POSITIONAL").toUpperCase(),
    rejectedReason:
      item.rejected_reason && item.rejected_reason !== "NONE"
        ? item.rejected_reason
        : "",
    components: item.components || [],
  }));
}

/** Templates of the CURRENT organization's WABA (cached per org + WABA). */
async function getTemplates({ force = false } = {}) {
  const ctx = currentContext();
  assertConnected(ctx);
  const key = cacheKey(ctx);
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.templates;
  try {
    const templates = await fetchFromMeta(ctx);
    cache.set(key, { at: Date.now(), templates });
    return templates;
  } catch (err) {
    if (err.code) throw err;
    const metaError = err.response?.data?.error;
    throw fail(
      "TEMPLATES_FETCH_FAILED",
      metaError?.message ||
        "Could not load templates from your WhatsApp Business Account.",
      { metaError: metaError || null },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Eligibility / variables                                             */
/* ------------------------------------------------------------------ */

function placeholders(text) {
  const keys = [];
  for (const m of String(text || "").matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

/** Variables that must be filled at send time (header text + body). */
function templateVariables(template) {
  const out = [];
  for (const c of template.components || []) {
    const type = String(c.type || "").toUpperCase();
    if (type === "HEADER" && String(c.format || "TEXT").toUpperCase() === "TEXT") {
      for (const key of placeholders(c.text)) out.push({ component: "header", key });
    }
    if (type === "BODY") {
      for (const key of placeholders(c.text)) out.push({ component: "body", key });
    }
  }
  return out;
}

function defaultSource(variable) {
  if (/^\d+$/.test(variable.key)) return variable.key === "1" ? "name" : null;
  return NAME_LIKE.has(variable.key.toLowerCase()) ? "name" : null;
}

/** Effective mapping for each variable: saved mapping, else safe default. */
function mapVariables(template, saved = []) {
  return templateVariables(template).map((v) => {
    const s = (saved || []).find(
      (x) => x.component === v.component && String(x.key) === v.key,
    );
    const source = s?.source || defaultSource(v);
    return {
      ...v,
      source,
      value: s?.value || "",
      resolved: source === "fixed" ? Boolean(s?.value) : Boolean(source),
    };
  });
}

/**
 * Decides whether a template may be used as the opening message and what it
 * needs. Only APPROVED templates are ever eligible.
 */
function analyze(template, savedVariables = []) {
  const reasons = [];
  if (String(template.status).toUpperCase() !== "APPROVED") {
    reasons.push(`Template is ${template.status}, only APPROVED templates can be used.`);
  }
  if (String(template.category).toUpperCase() === "AUTHENTICATION") {
    reasons.push("Authentication templates (OTP) cannot be used as an opening message.");
  }
  let headerFormat = null;
  for (const c of template.components || []) {
    const type = String(c.type || "").toUpperCase();
    if (type === "HEADER") {
      headerFormat = String(c.format || "TEXT").toUpperCase();
      if (!["TEXT", "IMAGE"].includes(headerFormat)) {
        reasons.push(`${headerFormat} header templates are not supported for opening messages yet.`);
      }
    } else if (type === "BUTTONS") {
      for (const b of c.buttons || []) {
        const bt = String(b.type || "").toUpperCase();
        if (!SUPPORTED_BUTTONS.has(bt)) {
          reasons.push(`Button type ${bt} is not supported for opening messages.`);
        } else if (bt === "URL" && /\{\{/.test(b.url || "")) {
          reasons.push("Buttons with a dynamic URL are not supported for opening messages.");
        }
      }
    } else if (!["BODY", "FOOTER"].includes(type)) {
      reasons.push(`Component ${type} is not supported for opening messages.`);
    }
  }
  const variables = mapVariables(template, savedVariables);
  const unresolved = variables.filter((v) => !v.resolved);
  const needsMapping = unresolved.length > 0;
  return {
    eligible: reasons.length === 0,
    reasons,
    headerFormat,
    variables,
    needsMapping,
    unresolved: unresolved.map((v) => `${v.component}:${v.key}`),
  };
}

/* ------------------------------------------------------------------ */
/* Selection (settings screen)                                         */
/* ------------------------------------------------------------------ */

async function readSelection(ctx) {
  if (!ctx.orgId) return null; // single-client (SAAS_MODE=false) handled by caller
  const doc = await Organization.findById(ctx.orgId)
    .select("whatsapp.openingTemplateName whatsapp.openingTemplateLanguage whatsapp.openingTemplateVariables")
    .lean();
  const wa = doc?.whatsapp || {};
  return {
    name: wa.openingTemplateName || null,
    language: wa.openingTemplateLanguage || null,
    variables: wa.openingTemplateVariables || [],
  };
}

/** Templates + approval status + eligibility for the Settings screen. */
async function listForCurrentOrg({ force = false } = {}) {
  const ctx = currentContext();
  const [templates, selection] = await Promise.all([
    getTemplates({ force }),
    readSelection(ctx),
  ]);
  return {
    selected: selection?.name
      ? { name: selection.name, language: selection.language }
      : null,
    templates: templates.map((t) => {
      const info = analyze(
        t,
        selection?.name === t.name && selection?.language === t.language
          ? selection.variables
          : [],
      );
      return {
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        rejectedReason: t.rejectedReason,
        components: t.components,
        eligibleForOpening: info.eligible,
        ineligibleReasons: info.reasons,
        variables: info.variables.map(({ component, key, source, value, resolved }) => ({
          component, key, source, value, resolved,
        })),
        isSelected: selection?.name === t.name && selection?.language === t.language,
      };
    }),
  };
}

/**
 * Saves the opening template for the CURRENT organization after verifying it
 * against that organization's own Meta account. Unapproved / ineligible /
 * unknown templates are rejected.
 */
async function saveSelection({ name, language, variables = [], userId = null }) {
  const ctx = currentContext();
  assertConnected(ctx);
  const templates = await getTemplates({ force: true });
  const template = templates.find((t) => t.name === name && t.language === language);
  if (!template) {
    throw fail(
      "OPENING_TEMPLATE_UNAVAILABLE",
      "This template was not found in your WhatsApp Business Account. Refresh the list and pick another template.",
    );
  }
  const info = analyze(template, variables);
  if (!info.eligible) {
    throw fail("OPENING_TEMPLATE_NOT_ELIGIBLE", info.reasons.join(" "), { reasons: info.reasons });
  }
  if (info.needsMapping) {
    throw fail(
      "OPENING_TEMPLATE_VARIABLES_MISSING",
      `Choose what to fill for variable(s): ${info.unresolved.join(", ")}.`,
      { unresolved: info.unresolved },
    );
  }
  if (info.headerFormat === "IMAGE" && ctx.ownerId) {
    const asset = await WhatsAppTemplateAsset.findOne({ ownerId: ctx.ownerId, name, language }).lean();
    if (!asset?.imageUrl) {
      throw fail(
        "OPENING_TEMPLATE_MEDIA_MISSING",
        "This template has an image header. Upload the header image for it in Template Manager first.",
      );
    }
  }
  if (!ctx.orgId) {
    throw fail("TENANT_CONTEXT_MISSING", "No organization selected.");
  }
  await Organization.updateOne(
    { _id: ctx.orgId },
    {
      $set: {
        "whatsapp.openingTemplateName": template.name,
        "whatsapp.openingTemplateLanguage": template.language,
        "whatsapp.openingTemplateId": template.id,
        "whatsapp.openingTemplateCategory": template.category,
        "whatsapp.openingTemplateVariables": info.variables.map(({ component, key, source, value }) => ({
          component, key, source, value,
        })),
        "whatsapp.openingTemplateSelectedAt": new Date(),
        "whatsapp.openingTemplateSelectedBy": userId || null,
      },
    },
  );
  require("../saas/orgService").invalidate(ctx.orgId);
  return { name: template.name, language: template.language, category: template.category };
}

async function clearSelection() {
  const ctx = currentContext();
  if (!ctx.orgId) throw fail("TENANT_CONTEXT_MISSING", "No organization selected.");
  await Organization.updateOne(
    { _id: ctx.orgId },
    {
      $set: {
        "whatsapp.openingTemplateName": null,
        "whatsapp.openingTemplateLanguage": null,
        "whatsapp.openingTemplateId": null,
        "whatsapp.openingTemplateCategory": null,
        "whatsapp.openingTemplateVariables": [],
        "whatsapp.openingTemplateSelectedAt": null,
        "whatsapp.openingTemplateSelectedBy": null,
      },
    },
  );
  require("../saas/orgService").invalidate(ctx.orgId);
}

/* ------------------------------------------------------------------ */
/* Send-time resolution                                                */
/* ------------------------------------------------------------------ */

function cleanParam(value) {
  // Meta rejects newlines / tabs / 4+ consecutive spaces inside text params.
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim()
    .slice(0, 1024);
}

function valueFor(variable, lead, org) {
  switch (variable.source) {
    case "name": return lead.name || "";
    case "phone": return lead.phone || "";
    case "email": return lead.email || "";
    case "company": return org?.name || "";
    case "fixed": return variable.value || "";
    default: return "";
  }
}

function fill(text, variables, values) {
  return String(text || "").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key) => {
    const idx = variables.findIndex((v) => v.key === key);
    return idx >= 0 ? values[idx] : "";
  });
}

/**
 * Everything needed to send the first message to `lead` for the CURRENT
 * organization. Throws a coded, organization-specific error instead of ever
 * falling back to another tenant, an env value or a plain text message.
 */
async function resolveForSend({ lead }) {
  const ctx = currentContext();
  assertConnected(ctx);

  // Hard tenant guard: the lead must belong to this organization's workspace.
  if (ctx.ownerId && lead?.ownerId && String(lead.ownerId) !== ctx.ownerId) {
    logger.error("[opening-template] Lead does not belong to the active organization", {
      organizationId: ctx.orgId, leadId: String(lead._id),
    });
    throw fail(
      "TENANT_MISMATCH",
      "This lead does not belong to the active organization. Nothing was sent.",
    );
  }

  let selection = await readSelection(ctx);
  if (!ctx.orgId) {
    // Single-client mode (SAAS_MODE=false): the selection lives in Settings.
    const settings = await require("../settings/settingsService").getOrCreateSettings();
    selection = {
      name: settings.openingTemplate?.name || null,
      language: settings.openingTemplate?.language || null,
      variables: [],
    };
  }

  if (!selection?.name || !selection?.language) {
    throw fail(
      "OPENING_TEMPLATE_MISSING",
      "No opening template is selected for this organization. Open WhatsApp → Opening template and choose an approved template.",
      { organizationId: ctx.orgId },
    );
  }

  const templates = await getTemplates();
  let template = templates.find(
    (t) => t.name === selection.name && t.language === selection.language,
  );
  // A cached copy may be stale (e.g. approved → paused): re-check once from Meta.
  if (!template || String(template.status).toUpperCase() !== "APPROVED") {
    template = (await getTemplates({ force: true })).find(
      (t) => t.name === selection.name && t.language === selection.language,
    );
  }
  if (!template || String(template.status).toUpperCase() !== "APPROVED") {
    throw fail(
      "OPENING_TEMPLATE_UNAVAILABLE",
      `Your selected opening template "${selection.name}" is ${
        template ? template.status : "no longer available"
      }. Select another approved template in WhatsApp settings. Nothing was sent.`,
      { organizationId: ctx.orgId, templateName: selection.name },
    );
  }

  const info = analyze(template, selection.variables);
  if (!info.eligible) {
    throw fail("OPENING_TEMPLATE_UNAVAILABLE", `Selected template cannot be used: ${info.reasons.join(" ")}`);
  }
  if (info.needsMapping) {
    throw fail(
      "OPENING_TEMPLATE_VARIABLES_MISSING",
      `Selected template needs a value for variable(s) ${info.unresolved.join(", ")}. Re-save the opening template.`,
    );
  }

  const components = [];
  const bodyVars = info.variables.filter((v) => v.component === "body");
  const headerVars = info.variables.filter((v) => v.component === "header");
  const named = template.parameterFormat === "NAMED";
  const toParams = (vars) =>
    vars
      .slice()
      .sort((a, b) => (named ? 0 : Number(a.key) - Number(b.key)))
      .map((v) => {
        const text = cleanParam(valueFor(v, lead, ctx.org)) || "Customer";
        return named
          ? { type: "text", parameter_name: v.key, text }
          : { type: "text", text };
      });

  if (info.headerFormat === "IMAGE") {
    const asset = ctx.ownerId
      ? await WhatsAppTemplateAsset.findOne({
          ownerId: ctx.ownerId, name: template.name, language: template.language,
        }).lean()
      : null;
    if (!asset?.imageUrl) {
      throw fail(
        "OPENING_TEMPLATE_MEDIA_MISSING",
        "Your opening template has an image header but no header image is saved for it. Upload it in Template Manager.",
      );
    }
    components.push({ type: "header", parameters: [{ type: "image", image: { link: asset.imageUrl } }] });
  } else if (headerVars.length) {
    components.push({ type: "header", parameters: toParams(headerVars) });
  }
  if (bodyVars.length) components.push({ type: "body", parameters: toParams(bodyVars) });

  // Human-readable copy of what the customer receives, for CRM history.
  const values = info.variables.map((v) => cleanParam(valueFor(v, lead, ctx.org)) || "Customer");
  const part = (type) => (template.components || []).find((c) => String(c.type).toUpperCase() === type);
  const preview = [
    part("HEADER")?.text ? `*${fill(part("HEADER").text, info.variables, values).trim()}*` : "",
    fill(part("BODY")?.text, info.variables, values).trim(),
    part("FOOTER")?.text ? `_${part("FOOTER").text.trim()}_` : "",
  ].filter(Boolean).join("\n\n") || `Template sent: ${template.name}`;

  return {
    organizationId: ctx.orgId,
    templateName: template.name,
    languageCode: template.language,
    category: template.category,
    components,
    preview,
  };
}

/** Maps a Meta send error for a missing/disabled template to our coded error. */
function translateSendError(err, selectionName) {
  const code = Number(err?.metaError?.code ?? err?.code);
  if ([132001, 132012, 132015, 132016, 132000].includes(code)) {
    try { clearCache(); } catch { /* no tenant context */ }
    return fail(
      "OPENING_TEMPLATE_UNAVAILABLE",
      `WhatsApp rejected the opening template "${selectionName}" (${err.metaError?.message || err.message}). Select another approved template in WhatsApp settings.`,
      { metaError: err.metaError || null },
    );
  }
  return err;
}

module.exports = {
  getTemplates,
  listForCurrentOrg,
  saveSelection,
  clearSelection,
  resolveForSend,
  translateSendError,
  analyze,
  clearCache,
};
