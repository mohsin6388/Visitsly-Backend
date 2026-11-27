// ---- shared phone / email normaliser (identical logic on backend and frontend) ----
const DEFAULT_CC = '91';
const IN_MOBILE = /^[6-9]\d{9}$/;
const AE_MOBILE = /^5\d{8}$/; // 50 52 54 55 56 58 …
const SA_MOBILE = /^5\d{8}$/;

// Country codes accepted without "+" (length = total digits incl. country code).
const OPEN_CC = [
  ['971', [12]], ['966', [12]], ['974', [11]], ['968', [11]], ['965', [11]], ['973', [11]],
  ['44', [12, 13]], ['61', [11]], ['65', [10]], ['64', [10, 11, 12]], ['49', [11, 12, 13, 14]], ['1', [11]],
];

const DIGIT_ZEROS = [0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xe50, 0xff10];
const INVISIBLE = /[\u00A0\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u3000]/g;

function isValidEmail(value) {
  const email = String(value || '').trim();
  if (!email || email.length > 254 || /\.\./.test(email)) return false;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(email)
    && !/^\.|\.@/.test(email);
}

/** Picks the first valid email out of messy cell text ("Name <a@b.com>", "mailto:a@b.com", "a@b.com; c@d.com"). */
function extractEmail(value) {
  const text = String(value ?? '').replace(INVISIBLE, ' ').trim();
  if (!text) return '';
  const candidates = text.match(/[^\s@,;|<>()'"\[\]:]+@[^\s@,;|<>()'"\[\]]+/g) || [];
  for (const c of candidates) {
    const e = c.replace(/^mailto:/i, '').replace(/[.,;:]+$/, '').toLowerCase();
    if (isValidEmail(e)) return e;
  }
  return '';
}

/** Arabic-Indic / Devanagari / Bengali … digits -> 0-9, invisible characters removed. */
function toAscii(text) {
  let out = '';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const zero = cp > 0x7f ? DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9) : undefined;
    out += zero !== undefined ? String(cp - zero) : ch;
  }
  return out.replace(INVISIBLE, ' ');
}

/**
 * Exact decimal expansion of scientific notation ("6.388505758E9", "9,19876543210E+11") with no
 * floating-point loss. Returns { digits, padded } or null when it is not a whole number.
 * padded = zeros had to be added (the mantissa had fewer digits than the number needs).
 */
function expandScientific(input) {
  const m = String(input ?? '').trim().replace(/\s+/g, '').match(/^\+?(\d+)(?:[.,](\d+))?[eE]([+-]?\d+)$/);
  if (!m) return null;
  const intPart = m[1];
  const frac = m[2] || '';
  const exp = parseInt(m[3], 10);
  if (!Number.isFinite(exp) || exp < 0 || exp > 40) return null;
  const mantissa = intPart + frac;
  const pointPos = intPart.length + exp; // digits before the decimal point
  let digits;
  let padded = false;
  if (pointPos >= mantissa.length) {
    digits = mantissa + '0'.repeat(pointPos - mantissa.length);
    padded = pointPos > mantissa.length && /[1-9]/.test(mantissa);
  } else {
    if (/[1-9]/.test(mantissa.slice(pointPos))) return null; // has a fractional part
    digits = mantissa.slice(0, pointPos);
  }
  digits = digits.replace(/^0+(?=\d)/, '');
  return { digits, padded };
}

/** Plain-digit string for a spreadsheet numeric value ("6.388505758E9" -> "6388505758", "9876543210.0" -> "9876543210"). Other text is returned unchanged. */
function plainNumberText(value) {
  const text = String(value ?? '').trim();
  if (/^\+?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(text)) {
    const x = expandScientific(text);
    return x ? x.digits : text;
  }
  if (/^\d+\.0+$/.test(text)) return text.replace(/\.0+$/, '');
  return text;
}

const fail = (error) => ({ ok: false, phone: '', error });
const good = (phone, country, warning) => ({ ok: true, phone, country, ...(warning ? { warning } : {}) });
const LANDLINE = 'This looks like a landline — WhatsApp needs a mobile number';

/** Digits that already include a country code (came with "+" / "00", or 12+ digits). */
function fromInternational(digits) {
  if (digits.length < 8 || digits.length > 15) return fail('With country code, the number must be 8–15 digits');
  if (digits.startsWith('91')) {
    let national = digits.slice(2).replace(/^0(?=\d{10}$)/, '');
    if (IN_MOBILE.test(national)) return good(`91${national}`, 'IN');
    return fail('Indian (+91) mobile numbers have 10 digits (starting with 6, 7, 8 or 9)');
  }
  if (digits.startsWith('971')) {
    const national = digits.slice(3).replace(/^0(?=\d)/, '');
    if (AE_MOBILE.test(national)) return good(`971${national}`, 'AE');
    if (/^[2-4679]\d{7}$/.test(national)) return fail(LANDLINE);
    return fail('UAE (+971) mobile numbers have 9 digits (50, 52, 54, 55, 56, 58 …)');
  }
  if (digits.startsWith('966')) {
    const national = digits.slice(3).replace(/^0(?=\d)/, '');
    if (SA_MOBILE.test(national)) return good(`966${national}`, 'SA');
    return fail('Saudi (+966) mobile numbers have 9 digits (starting with 5)');
  }
  return good(digits, null);
}

/**
 * Turns any typed / uploaded mobile number into WhatsApp format: digits only, country code first.
 * Understands Indian (10 digit, 6-9) and UAE (05x / 5x / +971) numbers, Excel scientific notation (E+),
 * "+", "00", spaces, dashes, brackets, "'" prefixes, "tel:" / wa.me links, labels like "Mob:", local digits,
 * and cells holding several numbers ("98765 43210 / 91234 56789" -> first valid one is used).
 * Returns { ok, phone, country, warning?, error?, empty? }.
 * opts.defaultCountry: the company's country (IN / AE / SA) used for ambiguous local numbers.
 */
function normalizePhone(input, opts = {}) {
  const defaultCountry = String(opts.defaultCountry || 'IN').toUpperCase();
  const original = toAscii(input ?? '').trim();
  if (!original) return { ok: false, empty: true, phone: '', error: 'Enter a number' };

  // 1) Scientific notation (Excel "General" format on a long number).
  if (/^[+-]?\d+(?:[.,]\d+)?\s*[eE]\s*[+-]?\d+$/.test(original)) {
    const x = expandScientific(original);
    if (!x) return fail('The number is in Excel scientific format and could not be read. Format the mobile column as Text and re-upload.');
    const r = normalizePhone(x.digits, opts);
    if (r.ok && x.padded) r.warning = 'Excel showed this number in E+ format — recovered it, please double-check';
    else if (r.ok) r.warning = 'Fixed from Excel E+ format';
    return r;
  }

  // 2) Clean wrapper text: links, labels, quotes, extensions.
  let raw = original
    .replace(/^['"`‘’“”]+|['"`‘’“”]+$/g, '')
    .replace(/^(?:https?:\/\/)?(?:api\.whatsapp\.com\/send\?phone=|wa\.me\/|web\.whatsapp\.com\/send\?phone=)/i, '+')
    .replace(/^tel:/i, '')
    .replace(/^\s*(?:mobile|mob|phone|ph|tel|telephone|cell|contact|whatsapp|wa|number|no)\b\.?\s*(?:no\.?|number)?\s*[:.\-–]?\s*/i, '')
    .replace(/\b(?:ext|extn|extension|x)\.?\s*\d+\s*$/i, '')
    .replace(/\((?:o|r|m|w|h|office|home|mobile|work)\)/gi, ' ')
    .trim();
  if (/^\d+\.0+$/.test(raw)) raw = raw.replace(/\.0+$/, '');

  // 3) Words around the number ("98765 43210 (Rahul)", "9876543210 or 9123456780").
  raw = raw.replace(/\b(?:or|aur|and)\b/gi, ' / ');
  let droppedText = false;
  const kept = raw.split(/\s+/).filter((tok) => {
    if (/^[a-z().,:;\-_'"]+$/i.test(tok) && /[a-z]/i.test(tok)) { droppedText = true; return false; }
    return true;
  });
  if (droppedText && kept.join('').replace(/\D/g, '')) raw = kept.join(' ');
  if (/[a-z]/i.test(raw)) return fail('Numbers can contain digits only');

  // 4) Cell with several numbers? try each piece, first valid one wins.
  const pieces = raw.split(/\s*[\/,;|\n&]\s*/).map((p) => p.trim()).filter(Boolean);
  const bigPieces = pieces.filter((p) => p.replace(/\D/g, '').length >= 7);
  if (pieces.length > 1 && bigPieces.length >= 1) {
    let firstError = null;
    for (let i = 0; i < bigPieces.length; i += 1) {
      const r = normalizePhone(bigPieces[i], opts);
      if (r.ok) {
        r.warning = bigPieces.length === 1 ? 'Extra text in cell — number extracted'
          : i > 0 ? `First number was invalid, used number ${i + 1}` : 'Cell had multiple numbers — used the first';
        return r;
      }
      firstError = firstError || r;
    }
    return firstError;
  }
  if (droppedText) {
    const r = normalizePhone(raw, opts);
    if (r.ok && !r.warning) r.warning = 'Removed text next to the number';
    return r;
  }

  const hasPlus = /^\s*\+/.test(raw) || /^\s*\(\s*\+/.test(raw);
  const compact = raw.replace(/[\s().\-–]/g, '');
  const hasDoubleZero = !hasPlus && /^00\d/.test(compact);
  let digits = raw.replace(/\D/g, '');
  if (hasDoubleZero) digits = digits.slice(2);
  if (!digits) return fail('No digits in number');
  if (/^(\d)\1+$/.test(digits) || digits === '1234567890' || digits === '0123456789') return fail('This number looks invalid');

  if (hasPlus || hasDoubleZero) return fromInternational(digits);

  // A country picked in a dial-code selector (signup) for a country without
  // local rules below: national number → +<dialCode><number>.
  if (opts.dialCode && !['IN', 'AE', 'SA'].includes(defaultCountry)) {
    const dial = String(opts.dialCode).replace(/\D/g, '');
    if (dial && !digits.startsWith(dial)) return fromInternational(`${dial}${digits.replace(/^0+/, '')}`);
    if (dial) return fromInternational(digits);
  }

  // 5) Local formats (no country code typed).
  const tryIN = (n) => (IN_MOBILE.test(n) ? good(`91${n}`, 'IN') : null);
  const tryAE = (n) => (AE_MOBILE.test(n) ? good(`971${n}`, 'AE') : null);
  const trySA = (n) => (SA_MOBILE.test(n) ? good(`966${n}`, 'SA') : null);
  const gulf5 = defaultCountry === 'SA' ? [trySA, tryAE] : [tryAE, trySA];

  if (digits.length === 10) {
    const r = tryIN(digits);
    if (r) return r;
    if (digits.startsWith('05')) {
      for (const f of gulf5) { const g = f(digits.slice(1)); if (g) return g; }
    }
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    const r = tryIN(digits.slice(1));
    if (r) return r;
  }
  if (digits.length === 9) {
    for (const f of gulf5) { const g = f(digits); if (g) return g; }
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    const r = tryIN(digits.slice(2));
    if (r) return r;
    return fail('Indian (+91) mobile numbers have 10 digits (starting with 6, 7, 8 or 9)');
  }
  if (digits.length === 13 && digits.startsWith('910')) {
    const r = tryIN(digits.slice(3));
    if (r) return r;
  }
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('971')) return fromInternational(digits);
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('966')) return fromInternational(digits);
  const open = OPEN_CC.find(([cc, lengths]) => digits.startsWith(cc) && lengths.includes(digits.length));
  if (open) return good(digits, null);

  // 6) Nothing matched — explain why.
  if (/^0\d{8,10}$/.test(digits)) return fail(LANDLINE); // STD / landline (04…, 011…, 0522…)
  if (digits.length === 10 && !IN_MOBILE.test(digits)) {
    return fail(/^[0-5]/.test(digits) ? 'Indian mobile numbers start with 6, 7, 8 or 9' : 'This number looks invalid');
  }
  if (digits.length < 9) return fail(`Number is incomplete (${digits.length} digits). India needs 10 digits, UAE 9 (05…)`);
  return fail(`Invalid number (${digits.length} digits). India: 10 digits, UAE: 05XXXXXXXX or +971…; other countries: include + and country code.`);
}

/** Stored variants of the same number (older rows may lack the country prefix). */
function phoneVariants(phone) {
  const value = String(phone || '');
  const list = [value];
  if (value.startsWith(DEFAULT_CC) && value.length === 12) list.push(value.slice(2));
  if (value.startsWith('971') && value.length === 12) list.push(`0${value.slice(3)}`, value.slice(3));
  return list;
}

module.exports = { normalizePhone, isValidEmail, extractEmail, expandScientific, plainNumberText, phoneVariants };
