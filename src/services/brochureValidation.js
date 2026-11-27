/**
 * Validation + normalisation of the JSON that Gemini extracts from a brochure
 * (and of the owner-edited copy sent back to /properties/brochure/confirm).
 *
 * Rules (never invent data — unknown stays null/empty):
 *  - projectName is required.
 *  - budgetMin / budgetMax / sizeSqft → finite number >= 0, else null.
 *  - budgetMin > budgetMax → swapped, with a warning.
 *  - implausible prices (INR: < ₹1 lakh or > ₹500 crore) → warning only.
 *  - lakh / crore text or tiny numbers that look like lakh/crore → warning, never guessed.
 *  - amenities → array of trimmed, unique strings.
 */
const { z } = require("zod");

const LAKH = 100000;
const CRORE = 10000000;
const MIN_PLAUSIBLE_INR = 1 * LAKH;
const MAX_PLAUSIBLE_INR = 500 * CRORE;

const LIMITS = {
  projectName: 150, builderName: 150, propertyType: 60, bhk: 30, location: 150, city: 100,
  reraNumber: 60, nearbyMetro: 150, nearbySchool: 150, nearbyHospital: 150, mapsLink: 500,
  description: 4000, amenity: 60, amenities: 60,
};

const money = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

function cleanString(value, max) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/** → { value:number|null, unitHint:boolean } — strips ₹/Rs/INR/AED/$ and thousands separators. */
function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === "") return { value: null, unitHint: false };
  if (typeof raw === "number") return { value: Number.isFinite(raw) && raw >= 0 ? raw : null, unitHint: false };
  const text = String(raw).trim();
  const unitHint = /\b(lakhs?|lacs?|crores?|cr|l)\b|\d\s*(cr|l)\b/i.test(text);
  const stripped = text.replace(/[₹$€£]|\b(rs\.?|inr|aed|usd)\b/gi, "").replace(/,/g, "");
  const match = stripped.match(/-?\d+(\.\d+)?/);
  if (!match) return { value: null, unitHint };
  const n = Number(match[0]);
  return { value: Number.isFinite(n) && n >= 0 ? n : null, unitHint };
}

function cleanAmenities(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]/) : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = cleanString(item, LIMITS.amenity);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= LIMITS.amenities) break;
  }
  return out;
}

function toBool(v) {
  if (typeof v === "string") return /^(true|yes|y|1)$/i.test(v.trim());
  return Boolean(v);
}

function priceWarnings(label, value, currency, warnings) {
  if (value === null || value === 0 || currency !== "INR") return;
  if (value < MIN_PLAUSIBLE_INR) {
    const lakhHint = value < 1000 ? " It may be written in lakh or crore — please enter the full amount in rupees." : "";
    warnings.push(`${label} (${money(value)}) is below ₹1 lakh, which is unusual for a property.${lakhHint}`);
  } else if (value > MAX_PLAUSIBLE_INR) {
    warnings.push(`${label} (${money(value)}) is above ₹500 crore, which looks too high. Please check it.`);
  }
}

/**
 * @param {object} raw     Extracted (or edited) fields
 * @param {{currency?:string}} [opts]
 * @returns {{ data: object, warnings: string[] }}
 * @throws {Error} with .code = "PROJECT_NAME_REQUIRED" when no project name
 */
function normaliseExtracted(raw, { currency = "INR" } = {}) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const warnings = [];

  const projectName = cleanString(src.projectName, LIMITS.projectName);
  if (!projectName) {
    const err = new Error("Could not detect the project name. Please enter it, or upload a brochure with clear project details.");
    err.code = "PROJECT_NAME_REQUIRED";
    throw err;
  }

  const min = parseNumber(src.budgetMin);
  const max = parseNumber(src.budgetMax);
  const size = parseNumber(src.sizeSqft);
  let budgetMin = min.value;
  let budgetMax = max.value;
  if (min.unitHint || max.unitHint) {
    warnings.push("The price contained lakh/crore text. Values were not converted — please check the amounts are in full rupees.");
  }
  if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) {
    [budgetMin, budgetMax] = [budgetMax, budgetMin];
    warnings.push("Minimum price was higher than maximum price, so they were swapped.");
  }
  priceWarnings("Minimum price", budgetMin, currency, warnings);
  priceWarnings("Maximum price", budgetMax, currency, warnings);
  if (src.sizeSqft !== null && src.sizeSqft !== undefined && src.sizeSqft !== "" && size.value === null) {
    warnings.push("Size could not be read as a number, so it was left empty.");
  }
  for (const [label, parsed, rawVal] of [["Minimum price", min, src.budgetMin], ["Maximum price", max, src.budgetMax]]) {
    if (parsed.value === null && rawVal !== null && rawVal !== undefined && rawVal !== "") {
      warnings.push(`${label} could not be read as a number, so it was left empty.`);
    }
  }

  const mapsLink = cleanString(src.mapsLink, LIMITS.mapsLink);
  let safeMapsLink = "";
  if (mapsLink) {
    if (/^https?:\/\//i.test(mapsLink)) safeMapsLink = mapsLink;
    else warnings.push("The maps link is not a valid URL, so it was removed.");
  }

  const data = {
    projectName,
    builderName: cleanString(src.builderName, LIMITS.builderName),
    propertyType: cleanString(src.propertyType, LIMITS.propertyType),
    bhk: cleanString(src.bhk, LIMITS.bhk),
    location: cleanString(src.location, LIMITS.location),
    city: cleanString(src.city, LIMITS.city),
    budgetMin,
    budgetMax,
    sizeSqft: size.value,
    amenities: cleanAmenities(src.amenities),
    parking: toBool(src.parking),
    reraNumber: cleanString(src.reraNumber, LIMITS.reraNumber),
    nearbyMetro: cleanString(src.nearbyMetro, LIMITS.nearbyMetro),
    nearbySchool: cleanString(src.nearbySchool, LIMITS.nearbySchool),
    nearbyHospital: cleanString(src.nearbyHospital, LIMITS.nearbyHospital),
    mapsLink: safeMapsLink,
    description: cleanString(src.description, LIMITS.description),
  };
  return { data, warnings };
}

/* ---------------- confirm body (owner-edited) ---------------- */
const nullableNumber = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.number().finite().nonnegative().nullable());
const str = (max) => z.preprocess((v) => (v === null || v === undefined ? "" : v), z.string().max(max));

const confirmBrochureSchema = z.object({
  body: z.object({
    projectName: z.string().trim().min(1, "Project name is required").max(LIMITS.projectName),
    builderName: str(LIMITS.builderName).optional(),
    propertyType: str(LIMITS.propertyType).optional(),
    bhk: str(LIMITS.bhk).optional(),
    location: str(LIMITS.location).optional(),
    city: str(LIMITS.city).optional(),
    budgetMin: nullableNumber.optional(),
    budgetMax: nullableNumber.optional(),
    sizeSqft: nullableNumber.optional(),
    amenities: z.array(z.string().max(LIMITS.amenity)).max(LIMITS.amenities).optional(),
    parking: z.boolean().optional(),
    reraNumber: str(LIMITS.reraNumber).optional(),
    nearbyMetro: str(LIMITS.nearbyMetro).optional(),
    nearbySchool: str(LIMITS.nearbySchool).optional(),
    nearbyHospital: str(LIMITS.nearbyHospital).optional(),
    mapsLink: z.preprocess((v) => (v === null || v === undefined ? "" : v), z.string().max(LIMITS.mapsLink).refine((v) => v === "" || /^https?:\/\//i.test(v), "Must be a valid URL")).optional(),
    description: str(LIMITS.description).optional(),
    brochure: z.object({
      url: z.string().url("Brochure URL is invalid"),
      publicId: z.string().max(300).optional().nullable(),
      originalName: z.string().max(300).optional().nullable(),
    }),
    images: z.array(z.string().url("Each image must be a valid URL")).max(10).optional(),
  }),
});

module.exports = { normaliseExtracted, parseNumber, cleanAmenities, confirmBrochureSchema, MIN_PLAUSIBLE_INR, MAX_PLAUSIBLE_INR };
