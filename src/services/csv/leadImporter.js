const Papa = require('papaparse');
const Lead = require('../../models/Lead');
const { normalizePhone, isValidEmail, extractEmail, expandScientific, plainNumberText, phoneVariants } = require('../../utils/phone');

const HEADER_ALIASES = {
  name: ['name', 'fullname', 'customername', 'leadname', 'contactname', 'clientname', 'firstname', 'personname', 'prospectname', 'buyername'],
  phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'contact', 'whatsapp', 'whatsappnumber', 'mobilewhatsapp', 'whatsappmobile', 'phonewhatsapp', 'mobileno', 'phoneno', 'contactno', 'contactnumber', 'cell', 'cellno', 'cellphone', 'mob', 'mobno', 'tel', 'telephone', 'number', 'whatsappno', 'primaryphone', 'primarymobile', 'customerphone', 'customermobile', 'customernumber', 'clientphone', 'clientmobile', 'clientnumber', 'leadphone', 'leadmobile', 'mobile1', 'phone1', 'altphone', 'alternatephone', 'alternatemobile', 'mobile2', 'phone2', 'secondaryphone', 'secondarymobile'],
  email: ['email', 'emailaddress', 'mail', 'emailid', 'mailid', 'emailaddress1', 'email1', 'workemail', 'personalemail', 'customeremail', 'clientemail', 'altemail', 'email2'],
  city: ['city', 'town'],
  location: ['location', 'area', 'locality'],
  address: ['address', 'fulladdress', 'addr', 'residentialaddress', 'officeaddress'],
  jobTitle: ['jobtitle', 'designation', 'title', 'job', 'position', 'role'],
  budget: ['budget'],
  budgetMin: ['budgetmin', 'minbudget', 'minimumbudget'],
  budgetMax: ['budgetmax', 'maxbudget', 'maximumbudget'],
  occupation: ['occupation', 'profession'],
  age: ['age'],
  source: ['leadsource', 'source'],
  notes: ['notes', 'remark', 'remarks', 'comment', 'comments'],
  requirements: ['requirements', 'requirement'],
};
const MULTI_FIELDS = new Set(['phone', 'email']); // a sheet may have several phone / email columns

function normalizeKey(key) {
  // "Mobile / WhatsApp", "Job title", "E-mail address" → mobilewhatsapp, jobtitle, emailaddress
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Header text -> internal field (exact alias first, then sensible fuzzy matches), or null. */
function classifyHeader(header) {
  const norm = normalizeKey(header).replace(/\d+$/, (d) => (d.length === 1 ? d : ''));
  const bare = norm.replace(/\d+$/, '');
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(norm) || aliases.includes(bare)) return field;
  }
  if (/mail/.test(bare)) return 'email';
  if (/(mobile|phone|whatsapp|contactno|contactnum|cellno|cellphone|mobno|telno|tele)/.test(bare)) return 'phone';
  if (/name/.test(bare) && !/(company|project|father|mother|spouse|husband|wife|business|agent|broker|nick|brand|builder|property|file|source|campaign)/.test(bare)) return 'name';
  return null;
}

/** Returns { byIndex: [field|null …] } — several phone/email columns are allowed, other fields use their first column. */
function buildHeaderMap(rawHeaders) {
  const seen = new Set();
  return rawHeaders.map((h) => {
    const field = classifyHeader(h);
    if (!field) return null;
    if (MULTI_FIELDS.has(field)) return field;
    if (seen.has(field)) return null;
    seen.add(field);
    return field;
  });
}

function parseBudgetToken(token) {
  if (token === undefined || token === null || token === '') return null;
  const str = String(token).trim().toLowerCase();
  const num = parseFloat(str.replace(/[^0-9.]/g, ''));
  if (Number.isNaN(num)) return null;
  if (str.includes('cr')) return Math.round(num * 10000000);
  if (str.includes('l')) return Math.round(num * 100000);
  return Math.round(num);
}

function parseBudgetRange(budgetStr) {
  if (!budgetStr) return { budgetMin: null, budgetMax: null };
  const parts = String(budgetStr).split(/-|to/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2) return { budgetMin: parseBudgetToken(parts[0]), budgetMax: parseBudgetToken(parts[1]) };
  const single = parseBudgetToken(parts[0]);
  return { budgetMin: single, budgetMax: single };
}

function fallbackName(name, email, phone) {
  if (String(name || '').trim()) return String(name).trim();
  if (email) return String(email).split('@')[0].replace(/[._+-]+/g, ' ').trim() || 'Email lead';
  if (phone) return `Lead ${String(phone).replace(/\D/g, '').slice(-4)}`;
  return '';
}

const cleanName = (v) => String(v || '').replace(/[\u200B-\u200F\u00A0\uFEFF]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.,;:'"_-]+|[\s,;:'"_-]+$/g, '').slice(0, 100);
const cellText = (v) => String(v ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
const looksLikeEmail = (v) => /@/.test(v);
const looksLikePhone = (v) => {
  const t = cellText(v);
  if (!t || /@/.test(t)) return false;
  if (/^[+-]?\d+(?:[.,]\d+)?\s*[eE]\s*[+-]?\d+$/.test(t)) return Boolean(expandScientific(t));
  const digits = t.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 && !/[a-z]{3,}/i.test(t);
};

/** Header-less sheet: find the phone / email / name columns by looking at the data itself. */
function sniffHeaders(matrix) {
  const sample = matrix.filter((r) => r && r.some((c) => cellText(c))).slice(0, 300);
  const width = Math.max(0, ...sample.map((r) => r.length));
  const stats = Array.from({ length: width }, () => ({ filled: 0, phone: 0, email: 0, text: 0 }));
  for (const row of sample) {
    for (let c = 0; c < width; c += 1) {
      const v = cellText(row[c]);
      if (!v) continue;
      stats[c].filled += 1;
      if (looksLikeEmail(v)) stats[c].email += 1;
      else if (looksLikePhone(v)) stats[c].phone += 1;
      else if (/[a-z\u0900-\u097F\u0600-\u06FF]/i.test(v) && !/\d{5,}/.test(v)) stats[c].text += 1;
    }
  }
  const pick = (key) => {
    let best = -1; let ratio = 0.4;
    stats.forEach((st, i) => { const r = st.filled ? st[key] / st.filled : 0; if (st[key] > 0 && r > ratio) { best = i; ratio = r; } });
    return best;
  };
  const phoneCol = pick('phone');
  const emailCol = pick('email');
  if (phoneCol < 0 && emailCol < 0) return null;
  const nameCol = stats.findIndex((st, i) => i !== phoneCol && i !== emailCol && st.filled && st.text / st.filled > 0.5);
  const headers = Array.from({ length: width }, (_, i) => (i === phoneCol ? 'Mobile' : i === emailCol ? 'Email' : i === nameCol ? 'Name' : `Column ${i + 1}`));
  // A first row without any phone / email is a header the sheet owner wrote in their own words — skip it.
  const first = matrix.findIndex((r) => r && r.some((c) => cellText(c)));
  const firstRow = matrix[first] || [];
  const headerLike = !(looksLikePhone(firstRow[phoneCol]) || looksLikeEmail(cellText(firstRow[emailCol])));
  return { headers, dataStart: headerLike ? first + 1 : first };
}

/**
 * matrix = array of rows (array of cell strings), exactly as in the sheet (row 1 = matrix[0]).
 * Finds the header row (it may not be row 1), tolerates blank rows / title rows, several phone columns,
 * swapped phone/email columns, and sheets with no header at all.
 */
function matrixToLeads(matrix, opts = {}) {
  const rows = matrix.map((r) => (Array.isArray(r) ? r.map(cellText) : []));
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 25); i += 1) {
    const map = buildHeaderMap(rows[i]);
    if (map.includes('phone') || map.includes('email')) { headerIdx = i; break; }
  }
  let headers; let dataStart;
  if (headerIdx >= 0) { headers = rows[headerIdx]; dataStart = headerIdx + 1; } else {
    const sniffed = sniffHeaders(rows);
    if (!sniffed) throw new Error('No Mobile/Phone/WhatsApp or Email column found. Add headers like "Name", "Mobile", "Email" in the first row.');
    headers = sniffed.headers; dataStart = sniffed.dataStart;
  }
  const fieldAt = buildHeaderMap(headers);
  const out = [];
  for (let i = dataStart; i < rows.length; i += 1) {
    const cells = rows[i];
    if (!cells.some((c) => c)) continue; // blank row
    const f = {}; const phones = []; const emails = [];
    fieldAt.forEach((field, col) => {
      if (!field) return;
      const v = cells[col] ?? '';
      if (field === 'phone') { if (v) phones.push(v); } else if (field === 'email') { if (v) emails.push(v); } else f[field] = v;
    });
    // Phone in the email column (or the other way round) — move it.
    const movedPhones = emails.filter((v) => !looksLikeEmail(v) && looksLikePhone(v));
    const movedEmails = phones.filter((v) => looksLikeEmail(v));
    const phoneCells = [...phones.filter((v) => !looksLikeEmail(v)), ...movedPhones];
    const emailCells = [...emails.filter((v) => looksLikeEmail(v) || !looksLikePhone(v)), ...movedEmails];
    // Choose the first phone cell that really is a valid number; otherwise keep the first (so the error is shown).
    const goodPhone = phoneCells.find((v) => normalizePhone(v, opts).ok);
    const phone = goodPhone || phoneCells[0] || '';
    const goodEmail = emailCells.map((v) => extractEmail(v)).find(Boolean);
    const email = goodEmail || String(emailCells[0] || '').toLowerCase();

    const { budgetMin, budgetMax } = f.budgetMin || f.budgetMax
      ? { budgetMin: parseBudgetToken(f.budgetMin), budgetMax: parseBudgetToken(f.budgetMax) }
      : parseBudgetRange(f.budget);
    const ageNum = f.age ? parseInt(f.age, 10) : null;
    out.push({
      rowNumber: i + 1,
      name: fallbackName(cleanName(f.name), goodEmail || '', phone),
      phone,
      email,
      city: f.city || '', location: f.location || '', budgetMin, budgetMax,
      address: f.address || '', jobTitle: f.jobTitle || '',
      occupation: f.occupation || '', age: Number.isFinite(ageNum) && ageNum >= 0 && ageNum <= 120 ? ageNum : null,
      source: f.source || 'file_import', notes: f.notes || '', requirements: f.requirements || '',
    });
  }
  if (!out.length) throw new Error('The file has headers but no contact rows.');
  return out;
}

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  const utf8 = buffer.toString('utf-8');
  return utf8.includes('\uFFFD') ? buffer.toString('latin1') : utf8.replace(/^\uFEFF/, '');
}

function parseCsvBuffer(buffer, opts = {}) {
  let text = decodeText(buffer).replace(/^\uFEFF/, '');
  text = text.replace(/^sep=.\r?\n/i, ''); // Excel adds "sep=," as the first line
  const result = Papa.parse(text, { header: false, skipEmptyLines: false });
  // Only a broken-quote file is fatal; "too few/many fields" and delimiter guesses are harmless.
  const fatal = (result.errors || []).find((e) => e.type === 'Quotes');
  if (fatal) throw new Error(`Unclosed quotes (") in CSV (row ${fatal.row + 1}). Re-save the file from Excel and upload again.`);
  return matrixToLeads(result.data || [], opts);
}

// Minimal dependency-free XLSX reader. XLSX is a ZIP archive containing XML;
// it supports standard .xlsx workbooks with a first worksheet/shared strings.
// Legacy binary .xls files are intentionally rejected with a clear message.
function extractZipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Excel file is not a valid .xlsx workbook');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Excel workbook has an invalid ZIP entry');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = require('zlib').inflateRawSync(compressed);
    else throw new Error('This Excel workbook uses an unsupported compression method');
    entries.set(name, data.toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xmlDecode(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function columnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || 'A';
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function parseSheetXml(sheetXml, sharedStrings) {
  const matrix = [];
  let autoRow = 0;
  for (const rowMatch of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNo = Number(rowMatch[1].match(/\br="(\d+)"/)?.[1]) || autoRow + 1;
    autoRow = rowNo;
    const row = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] || '';
      const ref = attrs.match(/\br="([A-Z]+\d+)"/i)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
      const value = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      let parsed = value == null ? '' : xmlDecode(value);
      if (type === 's' && value != null) parsed = sharedStrings[Number(value)] ?? '';
      else if (type === 'inlineStr') parsed = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => xmlDecode(part[1])).join('');
      else if (type === 'b') parsed = value === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e') parsed = '';
      else if (type === '' || type === 'n') parsed = plainNumberText(parsed); // 6.388505758E9 -> 6388505758 (exact)
      const col = ref ? columnIndex(ref) : row.length;
      row[col] = String(parsed).trim();
    }
    matrix[rowNo - 1] = row;
  }
  for (let i = 0; i < matrix.length; i += 1) if (!matrix[i]) matrix[i] = [];
  return matrix;
}

/** Worksheet XML paths in the order the tabs appear in Excel (hidden tabs last). */
function orderedSheetPaths(entries) {
  const wb = entries.get('xl/workbook.xml') || '';
  const rels = entries.get('xl/_rels/workbook.xml.rels') || '';
  const relMap = new Map();
  for (const r of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = r[1].match(/\bId="([^"]+)"/)?.[1];
    const target = r[1].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) relMap.set(id, target.startsWith('/') ? target.replace(/^\//, '') : `xl/${target}`);
  }
  const visible = []; const hidden = [];
  for (const sh of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const rid = sh[1].match(/\br:id="([^"]+)"/)?.[1] || sh[1].match(/\bid="([^"]+)"/)?.[1];
    const path = relMap.get(rid);
    if (!path || !entries.has(path)) continue;
    (/state="(hidden|veryHidden)"/.test(sh[1]) ? hidden : visible).push(path);
  }
  const ordered = [...visible, ...hidden];
  if (ordered.length) return ordered;
  return [...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((x, y) => parseInt(x.match(/(\d+)\.xml/)[1], 10) - parseInt(y.match(/(\d+)\.xml/)[1], 10));
}

function parseExcelBuffer(buffer, opts = {}) {
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0xd0cf11e0) {
    throw new Error('This is an old .xls file. Save it as Excel Workbook (.xlsx) and upload again.');
  }
  const entries = extractZipEntries(buffer);
  const paths = orderedSheetPaths(entries);
  if (!paths.length) throw new Error('No sheets found in the workbook');
  const sharedStrings = [];
  const sharedXml = (entries.get('xl/sharedStrings.xml') || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  for (const item of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    sharedStrings.push([...item[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => xmlDecode(part[1])).join(''));
  }
  // First sheet that really contains contacts (people often keep a notes / cover sheet first).
  let firstError = null;
  for (const path of paths) {
    const matrix = parseSheetXml(entries.get(path), sharedStrings);
    if (!matrix.some((r) => r.some((c) => String(c || '').trim()))) continue;
    try {
      return matrixToLeads(matrix, opts);
    } catch (err) {
      firstError = firstError || err;
    }
  }
  throw firstError || new Error('The Excel sheet is empty');
}

const EMAIL_RE = /[^\s@,;|<>()]+@[^\s@,;|<>()]+\.[^\s@,;|<>()]+/;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/;
const MAX_TEXT_ROWS = 5000;

function parseLeadText(text, opts = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  lines.forEach((rawLine, idx) => {
    let line = rawLine.trim();
    if (!line || rows.length >= MAX_TEXT_ROWS) return;
    if (/name/i.test(line) && /(phone|mobile|number|email)/i.test(line) && !/\d{6,}/.test(line)) return;
    line = line.replace(/^\d{1,4}[.)]\s+/, '');
    let email = '';
    const emailMatch = line.match(EMAIL_RE);
    if (emailMatch) {
      email = emailMatch[0].toLowerCase();
      line = line.replace(emailMatch[0], ' ');
    }
    let phone = '';
    const sciMatch = line.match(/\d+(?:[.,]\d+)?[eE][+-]?\d+/);
    const sci = sciMatch && expandScientific(sciMatch[0]);
    const phoneMatch = sci ? null : line.match(PHONE_RE);
    if (sci) {
      phone = sci.digits;
      line = line.replace(sciMatch[0], ' ');
    } else if (phoneMatch) {
      phone = phoneMatch[0].replace(/[^\d+]/g, '');
      line = line.replace(phoneMatch[0], ' ');
    }
    const rawName = line.replace(/[,;|\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    rows.push({
      rowNumber: idx + 1,
      name: fallbackName(rawName, email, phone),
      phone,
      email,
      city: '', location: '', budgetMin: null, budgetMax: null,
      address: '', jobTitle: '',
      occupation: '', age: null, source: 'bulk_paste', notes: '', requirements: '',
    });
  });
  return rows;
}

/**
 * channel: 'both' | 'whatsapp' | 'email' — what the user is importing the sheet for.
 * Returns { errors, warnings, phone, email } with phone already in 91XXXXXXXXXX form.
 */
function validateRow(row, channel = 'both', opts = {}) {
  const errors = [];
  const warnings = [];
  const phoneRaw = String(row.phone || '').trim();
  const emailRaw = extractEmail(row.email) || String(row.email || '').trim().toLowerCase();
  const phoneResult = phoneRaw ? normalizePhone(phoneRaw, opts) : null;
  const validPhone = Boolean(phoneResult?.ok);
  const validEmail = Boolean(emailRaw) && isValidEmail(emailRaw);

  if (channel === 'whatsapp') {
    if (!phoneRaw) errors.push('No mobile number');
    else if (!validPhone) errors.push(phoneResult.error);
  } else if (channel === 'email') {
    if (!emailRaw) errors.push('No email');
    else if (!validEmail) errors.push('Invalid email format');
  } else {
    if (!validPhone && !validEmail) {
      if (phoneRaw) errors.push(phoneResult.error);
      if (emailRaw) errors.push('Invalid email format');
      if (!phoneRaw && !emailRaw) errors.push('A mobile number or email is required');
    } else {
      if (phoneRaw && !validPhone) warnings.push(`Mobile skipped: ${phoneResult.error}`);
      if (emailRaw && !validEmail) warnings.push('Email skipped: invalid format');
    }
  }
  if (validPhone && phoneResult.warning && channel !== 'email') warnings.push(phoneResult.warning);
  return {
    errors,
    warnings,
    phone: validPhone ? phoneResult.phone : '',
    email: validEmail ? emailRaw : '',
  };
}

async function analyzeRows(ownerId, rows, channel = 'both', opts = {}) {
  const checked = rows.map((row) => ({ row, ...validateRow(row, channel, opts) }));

  // Duplicates are matched on the normalised number (so 9876543210 == 919876543210).
  const phones = [...new Set(checked.flatMap((item) => (item.phone ? phoneVariants(item.phone) : [])))];
  const emails = [...new Set(checked.map((item) => item.email).filter(Boolean))];
  const [existingPhones, existingEmails] = await Promise.all([
    phones.length ? Lead.find({ ownerId, phone: { $in: phones } }, { phone: 1 }).lean() : [],
    emails.length ? Lead.find({ ownerId, email: { $in: emails } }, { email: 1 }).lean() : [],
  ]);
  const existingPhoneSet = new Set();
  for (const lead of existingPhones) {
    const n = normalizePhone(lead.phone, opts);
    existingPhoneSet.add(n.ok ? n.phone : lead.phone);
  }
  const existingEmailSet = new Set(existingEmails.map((l) => String(l.email || '').toLowerCase()));
  const seenPhones = new Set();
  const seenEmails = new Set();

  const analyzed = checked.map(({ row, errors, warnings, phone, email }) => {
    let duplicateReason = null;
    if (!errors.length) {
      if (phone && existingPhoneSet.has(phone)) duplicateReason = 'This number is already in your contacts';
      else if (email && existingEmailSet.has(email)) duplicateReason = 'This email is already in your contacts';
      else if (phone && seenPhones.has(phone)) duplicateReason = 'This number appears twice in the file';
      else if (email && seenEmails.has(email)) duplicateReason = 'This email appears twice in the file';
      if (!duplicateReason) {
        if (phone) seenPhones.add(phone);
        if (email) seenEmails.add(email);
      }
    }
    const status = errors.length ? 'invalid' : duplicateReason ? 'duplicate' : 'valid';
    return { ...row, phone, email, rawPhone: row.phone || '', errors, warnings, isDuplicate: Boolean(duplicateReason), duplicateReason, status };
  });
  const valid = analyzed.filter((r) => r.status === 'valid');
  return {
    rows: analyzed,
    summary: {
      total: analyzed.length,
      valid: valid.length,
      invalid: analyzed.filter((r) => r.status === 'invalid').length,
      duplicate: analyzed.filter((r) => r.status === 'duplicate').length,
      whatsappAvailable: valid.filter((r) => r.phone).length,
      emailAvailable: valid.filter((r) => r.email).length,
      bothAvailable: valid.filter((r) => r.phone && r.email).length,
    },
  };
}

module.exports = { parseCsvBuffer, parseExcelBuffer, parseLeadText, validateRow, analyzeRows };
