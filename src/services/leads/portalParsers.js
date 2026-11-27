/**
 * Parses lead-notification emails from Indian property portals and turns
 * them into { name, phone, email, project, source, message }.
 *
 * Portals change their templates often, so this is deliberately tolerant:
 * it looks for labelled fields first ("Name:", "Mobile:", "Email:",
 * "Project:"), then falls back to the first Indian mobile / email found.
 */
const PORTALS = [
  { source: '99acres', test: /99acres/i },
  { source: 'magicbricks', test: /magicbricks/i },
  { source: 'housing', test: /housing\.com|housing\s+(?:demand|leads?)|proptiger/i },
  { source: 'nobroker', test: /nobroker/i },
  { source: 'commonfloor', test: /commonfloor/i },
  { source: 'squareyards', test: /square\s?yards/i },
];

function stripHtml(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' : ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n');
}

function labelled(text, labels) {
  for (const label of labels) {
    const m = text.match(new RegExp(`(?:^|\\n|\\s)${label}\\s*[:\\-]+\\s*([^\\n]{1,120})`, 'i'));
    if (m) {
      const value = m[1].replace(/\s*:\s*$/, '').trim();
      if (value) return value;
    }
  }
  return null;
}

const MOBILE = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PORTAL_EMAIL = /@(99acres|magicbricks|housing|proptiger|nobroker|commonfloor|squareyards|naukri|infoedge)\./i;

function parsePortalEmail({ from = '', subject = '', text = '', html = '' }) {
  const body = `${text || ''}\n${stripHtml(html)}`;
  const all = `${from}\n${subject}\n${body}`;
  const portal = PORTALS.find((p) => p.test.test(all));
  const source = portal ? portal.source : 'email_lead';

  const name = labelled(body, ['Name', 'Buyer Name', 'Customer Name', 'Contact Person', 'Sender Name', 'Lead Name']);
  let phone = labelled(body, ['Mobile', 'Mobile No\\.?', 'Mobile Number', 'Phone', 'Phone No\\.?', 'Contact No\\.?', 'Contact Number', 'Contact']);
  if (phone) phone = (phone.match(MOBILE) || [null])[0];
  if (!phone) phone = (body.match(MOBILE) || [null])[0];

  let email = labelled(body, ['Email', 'Email ID', 'E-mail', 'Email Address']);
  if (email) email = (email.match(EMAIL) || [null])[0];
  if (!email) {
    const candidates = body.match(new RegExp(EMAIL.source, 'gi')) || [];
    email = candidates.find((e) => !PORTAL_EMAIL.test(e)) || null;
  }

  const project = labelled(body, ['Project', 'Project Name', 'Property', 'Property Name', 'Listing', 'Society', 'Interested In']);
  const message = labelled(body, ['Message', 'Query', 'Requirement', 'Comments?']);
  const city = labelled(body, ['City', 'Location']);

  return {
    source,
    name: name && !EMAIL.test(name) ? name.replace(/\s{2,}/g, ' ') : null,
    phone,
    email,
    project,
    city,
    message,
    sourceDetail: subject ? String(subject).slice(0, 150) : null,
  };
}

module.exports = { parsePortalEmail, stripHtml };
