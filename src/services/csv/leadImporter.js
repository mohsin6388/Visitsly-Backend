const Papa = require('papaparse');
const Lead = require('../../models/Lead');

const HEADER_ALIASES = {
  name: ['name', 'fullname', 'customername', 'leadname', 'contactname'],
  phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'contact', 'whatsapp', 'whatsappnumber', 'mobilewhatsapp', 'whatsappmobile', 'phonewhatsapp', 'mobileno', 'phoneno'],
  email: ['email', 'emailaddress', 'mail', 'emailid', 'mailid'],
  city: ['city'],
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

function normalizeKey(key) {
  // "Mobile / WhatsApp", "Job title", "E-mail address" → mobilewhatsapp, jobtitle, emailaddress
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildHeaderMap(rawHeaders) {
  const map = {};
  const normalizedHeaders = rawHeaders.map((h) => ({ raw: h, norm: normalizeKey(h) }));
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const match = normalizedHeaders.find((h) => aliases.includes(h.norm));
    if (match) map[match.raw] = field;
  }
  return map;
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

function rowsToLeads(rawHeaders, rawRows) {
  const headerMap = buildHeaderMap(rawHeaders);
  const recognized = Object.values(headerMap);
  if (!recognized.includes('phone') && !recognized.includes('email')) {
    throw new Error('File must include at least a "Phone/Mobile/WhatsApp" or "Email" column');
  }
  return rawRows.map((rawRow, idx) => {
    const normalized = { _rowNumber: idx + 2 };
    for (const [rawHeader, field] of Object.entries(headerMap)) normalized[field] = String(rawRow[rawHeader] ?? '').trim();
    const { budgetMin, budgetMax } = normalized.budgetMin || normalized.budgetMax
      ? { budgetMin: parseBudgetToken(normalized.budgetMin), budgetMax: parseBudgetToken(normalized.budgetMax) }
      : parseBudgetRange(normalized.budget);
    const phone = (normalized.phone || '').replace(/[^\d+]/g, '');
    const email = (normalized.email || '').toLowerCase();
    return {
      rowNumber: normalized._rowNumber,
      name: fallbackName(normalized.name, email, phone),
      phone,
      email,
      city: normalized.city || '', location: normalized.location || '', budgetMin, budgetMax,
      address: normalized.address || '', jobTitle: normalized.jobTitle || '',
      occupation: normalized.occupation || '', age: normalized.age ? parseInt(normalized.age, 10) : null,
      source: normalized.source || 'file_import', notes: normalized.notes || '', requirements: normalized.requirements || '',
    };
  });
}

function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  const result = Papa.parse(text, {
    header: true, skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    transform: (value) => typeof value === 'string' ? value.trim() : value,
  });
  if (result.errors?.length) {
    const firstError = result.errors[0];
    throw new Error(`CSV parse error at row ${firstError.row + 1}: ${firstError.message}`);
  }
  return rowsToLeads(result.meta.fields || [], result.data || []);
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

function parseExcelBuffer(buffer) {
  const entries = extractZipEntries(buffer);
  const sheetPath = [...entries.keys()].find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!sheetPath || !entries.has(sheetPath)) throw new Error('Excel workbook has no readable worksheet');
  const sharedStrings = [];
  const sharedXml = entries.get('xl/sharedStrings.xml') || '';
  for (const item of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    sharedStrings.push([...item[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => xmlDecode(part[1])).join(''));
  }
  const sheetXml = entries.get(sheetPath);
  const matrix = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] || '';
      const ref = attrs.match(/\br="([A-Z]+\d+)"/i)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
      const value = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      let parsed = value == null ? '' : xmlDecode(value);
      if (type === 's' && value != null) parsed = sharedStrings[Number(value)] ?? '';
      else if (type === 'inlineStr') parsed = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => xmlDecode(part[1])).join('');
      else if (type === 'b') parsed = value === '1' ? 'TRUE' : 'FALSE';
      if (ref) row[columnIndex(ref)] = String(parsed).trim();
    }
    matrix.push(row);
  }
  if (!matrix.length) throw new Error('Excel worksheet is empty');
  const headers = matrix[0].map((v) => String(v || '').trim());
  const rows = matrix.slice(1).filter((row) => row.some((cell) => String(cell || '').trim())).map((cells) => {
    const object = {};
    headers.forEach((header, index) => { if (header) object[header] = cells[index] ?? ''; });
    return object;
  });
  if (!rows.length) throw new Error('Excel worksheet has headers but no lead rows');
  return rowsToLeads(headers, rows);
}

const EMAIL_RE = /[^\s@,;|<>()]+@[^\s@,;|<>()]+\.[^\s@,;|<>()]+/;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/;
const MAX_TEXT_ROWS = 5000;

function parseLeadText(text) {
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
    const phoneMatch = line.match(PHONE_RE);
    if (phoneMatch) {
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

function validateRow(row) {
  const errors = [];
  const phoneRaw = String(row.phone || '').trim();
  const phoneDigits = phoneRaw.replace(/\D/g, '');
  const email = String(row.email || '').trim();
  const validPhone = Boolean(phoneRaw) && phoneDigits.length >= 7 && phoneDigits.length <= 15;
  const validEmail = Boolean(email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  // A mixed contact row remains usable when one channel is bad and the other
  // is good. Import service normalizes invalid optional contact fields away.
  if (!validPhone && !validEmail) {
    if (phoneRaw) errors.push('Invalid phone number');
    if (email) errors.push('Invalid email format');
    if (!phoneRaw && !email) errors.push('At least one valid email address or phone number is required');
  }
  if (row.age !== null && row.age !== undefined && (Number.isNaN(row.age) || row.age < 0 || row.age > 120)) errors.push('Invalid age');
  return errors;
}

async function analyzeRows(ownerId, rows) {
  const phones = [...new Set(rows.map((r) => String(r.phone || '').trim()).filter(Boolean))];
  const emails = [...new Set(rows.map((r) => String(r.email || '').trim().toLowerCase()).filter(Boolean))];
  const [existingPhones, existingEmails] = await Promise.all([
    phones.length ? Lead.find({ ownerId, phone: { $in: phones } }, { phone: 1 }).lean() : [],
    emails.length ? Lead.find({ ownerId, email: { $in: emails } }, { email: 1 }).lean() : [],
  ]);
  const existingPhoneSet = new Set(existingPhones.map((l) => l.phone));
  const existingEmailSet = new Set(existingEmails.map((l) => String(l.email || '').toLowerCase()));
  const seenPhones = new Set();
  const seenEmails = new Set();

  const analyzed = rows.map((row) => {
    const errors = validateRow(row);
    const phone = String(row.phone || '').trim();
    const email = String(row.email || '').trim().toLowerCase();
    let duplicateReason = null;
    if (phone && existingPhoneSet.has(phone)) duplicateReason = 'Phone already exists in your leads';
    else if (email && existingEmailSet.has(email)) duplicateReason = 'Email already exists in your leads';
    else if (phone && seenPhones.has(phone)) duplicateReason = 'Duplicate phone number within this file';
    else if (email && seenEmails.has(email)) duplicateReason = 'Duplicate email within this file';
    if (phone) seenPhones.add(phone);
    if (email) seenEmails.add(email);

    const status = errors.length ? 'invalid' : duplicateReason ? 'duplicate' : 'valid';
    return { ...row, errors, isDuplicate: Boolean(duplicateReason), duplicateReason, status };
  });
  return {
    rows: analyzed,
    summary: {
      total: analyzed.length,
      valid: analyzed.filter((r) => r.status === 'valid').length,
      invalid: analyzed.filter((r) => r.status === 'invalid').length,
      duplicate: analyzed.filter((r) => r.status === 'duplicate').length,
      whatsappAvailable: analyzed.filter((r) => r.status === 'valid' && r.phone).length,
      emailAvailable: analyzed.filter((r) => r.status === 'valid' && r.email).length,
      bothAvailable: analyzed.filter((r) => r.status === 'valid' && r.phone && r.email).length,
    },
  };
}

module.exports = { parseCsvBuffer, parseExcelBuffer, parseLeadText, validateRow, analyzeRows };
