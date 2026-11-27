/* eslint-disable no-console */
/**
 * Brochure extraction validation smoke test — NO database, NO network.
 *   npm run test:brochure
 */
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
const { normaliseExtracted, parseNumber, cleanAmenities, confirmBrochureSchema } = require(path.join(ROOT, 'src/services/brochureValidation'));
let pass = 0;
const t = (name, fn) => { try { fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.stack || e.message); process.exitCode = 1; } };
const base = { projectName: 'Sky Heights', builderName: 'ABC Builders', city: 'Pune', budgetMin: 5000000, budgetMax: 9000000, sizeSqft: 1200, amenities: ['Gym', 'Pool'], parking: true };

t('projectName is required (clear error, code PROJECT_NAME_REQUIRED)', () => {
  for (const bad of [{}, { projectName: '' }, { projectName: '   ' }, { projectName: null }, { projectName: {} }, null, 'text']) {
    assert.throws(() => normaliseExtracted(bad), (e) => e.code === 'PROJECT_NAME_REQUIRED' && /project name/i.test(e.message));
  }
});
t('a clean extraction passes through unchanged, no warnings', () => {
  const { data, warnings } = normaliseExtracted(base);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(data.projectName, 'Sky Heights'); assert.strictEqual(data.budgetMin, 5000000); assert.strictEqual(data.parking, true);
  assert.strictEqual(data.reraNumber, ''); // unknown stays empty, never invented
});
t('numbers: finite and >= 0, else null; currency symbols / commas stripped', () => {
  assert.strictEqual(parseNumber('₹ 1,25,00,000').value, 12500000);
  assert.strictEqual(parseNumber('Rs. 50,00,000/-').value, 5000000);
  assert.strictEqual(parseNumber('INR 8000000').value, 8000000);
  for (const bad of [-5, NaN, Infinity, 'abc', '', null, undefined, '-100']) assert.strictEqual(parseNumber(bad).value, null, String(bad));
  const { data, warnings } = normaliseExtracted({ ...base, budgetMin: -1, budgetMax: 'n/a', sizeSqft: 'big' });
  assert.deepStrictEqual([data.budgetMin, data.budgetMax, data.sizeSqft], [null, null, null]);
  assert.ok(warnings.some((w) => /Size/.test(w)) && warnings.some((w) => /Maximum price/.test(w)));
});
t('budgetMin > budgetMax → swapped with a warning', () => {
  const { data, warnings } = normaliseExtracted({ ...base, budgetMin: 9000000, budgetMax: 5000000 });
  assert.deepStrictEqual([data.budgetMin, data.budgetMax], [5000000, 9000000]);
  assert.ok(warnings.some((w) => /swapped/.test(w)));
});
t('implausible prices are warnings (below ₹1 lakh / above ₹500 crore), never silently changed', () => {
  let r = normaliseExtracted({ ...base, budgetMin: 99999 });
  assert.ok(r.warnings.some((w) => /below ₹1 lakh/.test(w)) && r.data.budgetMin === 99999);
  r = normaliseExtracted({ ...base, budgetMin: 100000, budgetMax: 5000000000 });
  assert.deepStrictEqual(r.warnings, [], 'exactly ₹1 lakh and ₹500 crore are fine');
  r = normaliseExtracted({ ...base, budgetMax: 5000000001 });
  assert.ok(r.warnings.some((w) => /above ₹500 crore/.test(w)));
  r = normaliseExtracted({ ...base, budgetMin: 0, budgetMax: null });
  assert.deepStrictEqual(r.warnings, [], '0 / null = unknown, not flagged');
});
t('lakh / crore mistakes are flagged, not guessed', () => {
  let r = normaliseExtracted({ ...base, budgetMin: 1.5, budgetMax: 2.2 }); // "1.5 Cr" read as 1.5
  assert.deepStrictEqual([r.data.budgetMin, r.data.budgetMax], [1.5, 2.2], 'value kept as extracted');
  assert.ok(r.warnings.some((w) => /lakh or crore/.test(w)));
  r = normaliseExtracted({ ...base, budgetMin: '1.2 Cr', budgetMax: '2 crore' });
  assert.ok(r.warnings.some((w) => /lakh\/crore text/.test(w)));
  r = normaliseExtracted({ ...base, budgetMin: '85 Lakh' });
  assert.ok(r.warnings.some((w) => /lakh\/crore text/.test(w)));
});
t('amenities: array of trimmed, unique, non-empty strings (case-insensitive)', () => {
  assert.deepStrictEqual(cleanAmenities([' Gym ', 'gym', 'Pool', '', null, 5, 'Club  House']), ['Gym', 'Pool', '5', 'Club House']);
  assert.deepStrictEqual(cleanAmenities('Gym, Pool; Garden'), ['Gym', 'Pool', 'Garden']);
  assert.deepStrictEqual(cleanAmenities(null), []);
  assert.deepStrictEqual(cleanAmenities({}), []);
  assert.ok(cleanAmenities(Array.from({ length: 200 }, (_, i) => `A${i}`)).length <= 60);
});
t('parking becomes a boolean', () => {
  assert.strictEqual(normaliseExtracted({ ...base, parking: 'yes' }).data.parking, true);
  assert.strictEqual(normaliseExtracted({ ...base, parking: 'false' }).data.parking, false);
  assert.strictEqual(normaliseExtracted({ ...base, parking: undefined }).data.parking, false);
});
t('string lengths are capped; objects are never stored as text; bad maps links dropped', () => {
  const { data, warnings } = normaliseExtracted({ ...base, projectName: 'x'.repeat(500), description: 'd'.repeat(9000), builderName: { evil: 1 }, mapsLink: 'javascript:alert(1)' });
  assert.strictEqual(data.projectName.length, 150); assert.strictEqual(data.description.length, 4000);
  assert.strictEqual(data.builderName, ''); assert.strictEqual(data.mapsLink, '');
  assert.ok(warnings.some((w) => /maps link/.test(w)));
  assert.strictEqual(normaliseExtracted({ ...base, mapsLink: 'https://maps.google.com/?q=1' }).data.mapsLink, 'https://maps.google.com/?q=1');
});
t('confirm body (zod): edited fields + brochure required; bad data is rejected', () => {
  const ok = { ...base, bhk: '2,3', brochure: { url: 'https://res.cloudinary.com/x/raw/upload/a.pdf', publicId: 'p', originalName: 'a.pdf' }, images: ['https://res.cloudinary.com/x/image/upload/a.jpg'] };
  assert.ok(confirmBrochureSchema.safeParse({ body: ok }).success);
  assert.ok(confirmBrochureSchema.safeParse({ body: { ...ok, budgetMin: '' } }).success, 'empty price input → null');
  for (const bad of [{ ...ok, projectName: '   ' }, { ...ok, budgetMin: -1 }, { ...ok, brochure: undefined }, { ...ok, brochure: { url: 'nope' } }, { ...ok, images: ['x'] }, { ...ok, mapsLink: 'ftp://x' }, { ...ok, images: Array(11).fill('https://a.b/c.jpg') }]) {
    assert.ok(!confirmBrochureSchema.safeParse({ body: bad }).success, JSON.stringify(bad).slice(0, 80));
  }
});
console.log(`\n${pass} checks passed`);
