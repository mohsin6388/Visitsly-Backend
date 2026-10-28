const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const { toWhatsAppNumber } = require("../whatsapp/metaWhatsappClient");

function fallbackName(row, phone) {
  const name = String(row.name || "").trim();
  if (name) return name;
  if (row.email) return String(row.email).split("@")[0].replace(/[._+-]+/g, " ").trim() || "Email lead";
  if (phone) return `Lead ${String(phone).slice(-4)}`;
  return "New lead";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalizes mixed-channel contact rows and checks duplicates in the database
 * and inside this request before writing. A bad phone never discards a valid
 * email address on the same row (and vice versa). The partial phone index is
 * the final race-condition guard for simultaneous phone duplicates.
 */
async function importLeadRows(ownerId, rows) {
  const normalized = [];
  let invalid = 0;
  let skipped = 0;

  for (const row of rows || []) {
    let phone = null;
    const rawPhone = String(row.phone || "").trim();
    let email = String(row.email || "").trim().toLowerCase();

    if (email && !EMAIL_RE.test(email)) email = "";
    if (rawPhone) {
      try {
        phone = toWhatsAppNumber(rawPhone);
      } catch {
        phone = null; // Keep a valid email contact, if present.
      }
    }

    if (!phone && !email) {
      invalid += 1;
      continue;
    }
    normalized.push({ row, phone, email: email || null });
  }

  if (!normalized.length) return { inserted: [], skipped, invalid, existingIds: [] };

  const phones = [...new Set(normalized.map((item) => item.phone).filter(Boolean))];
  const emails = [...new Set(normalized.map((item) => item.email).filter(Boolean))];
  const [existingPhoneRows, existingEmailRows] = await Promise.all([
    phones.length ? Lead.find({ ownerId, phone: { $in: phones } }, { phone: 1 }).lean() : [],
    emails.length ? Lead.find({ ownerId, email: { $in: emails } }, { email: 1 }).lean() : [],
  ]);
  // Contacts already in Upload Data: not re-inserted, but returned so a bulk
  // upload can still build an audience from the whole sheet.
  const existingIds = [...new Set([...existingPhoneRows, ...existingEmailRows].map((lead) => String(lead._id)))];
  const seenPhones = new Set(existingPhoneRows.map((lead) => lead.phone));
  const seenEmails = new Set(existingEmailRows.map((lead) => String(lead.email || "").toLowerCase()));
  const docs = [];

  for (const item of normalized) {
    const phone = item.phone;
    const email = item.email;
    if ((phone && seenPhones.has(phone)) || (email && seenEmails.has(email))) {
      skipped += 1;
      continue;
    }
    if (phone) seenPhones.add(phone);
    if (email) seenEmails.add(email);
    const row = item.row;
    docs.push({
      ownerId,
      name: fallbackName({ ...row, email }, phone),
      phone,
      email: email || undefined,
      city: row.city || undefined,
      location: row.location || undefined,
      address: row.address || undefined,
      jobTitle: row.jobTitle || undefined,
      importFile: String(row.importFile || "").trim().slice(0, 200) || null,
      budgetMin: row.budgetMin ?? null,
      budgetMax: row.budgetMax ?? null,
      occupation: row.occupation || undefined,
      age: row.age ?? null,
      source: row.source || "csv_import",
      notes: row.notes || undefined,
      requirements: row.requirements || undefined,
    });
  }

  if (!docs.length) return { inserted: [], skipped, invalid, existingIds };

  // SaaS plan limit: import only as many contacts as the plan still allows.
  let skippedByLimit = 0;
  const { remainingFor, assertWithinLimit } = require("../saas/subscription");
  const currentCount = await Lead.countDocuments({ ownerId });
  const remaining = remainingFor("contacts", currentCount);
  if (remaining <= 0) assertWithinLimit("contacts", currentCount, docs.length);
  if (docs.length > remaining) {
    skippedByLimit = docs.length - remaining;
    docs.length = remaining;
  }

  let inserted = [];
  try {
    inserted = await Lead.insertMany(docs, { ordered: false });
  } catch (err) {
    if (err.writeErrors) {
      inserted = err.insertedDocs || [];
      skipped += err.writeErrors.length;
    } else {
      throw err;
    }
  }

  // Only phone-capable leads need a WhatsApp Conversation. Email-only leads
  // remain valid CRM contacts but do not acquire an unserviceable WA queue job.
  const whatsappLeads = inserted.filter((lead) => Boolean(lead.phone));
  if (whatsappLeads.length) {
    try {
      await Conversation.insertMany(
        whatsappLeads.map((lead) => ({ leadId: lead._id, ownerId: lead.ownerId })),
        { ordered: false },
      );
    } catch (err) {
      if (!err.writeErrors) throw err; // Duplicate shells are harmless only for duplicate-key errors.
    }
  }

  return { inserted, skipped: skipped + skippedByLimit, invalid, existingIds, skippedByLimit };
}

module.exports = { importLeadRows };
