/**
 * One-time: keep existing Starter companies on what they had before the
 * Nov-2026 plan change (Starter lost bulk WhatsApp/email and went to 1 login).
 *
 *   npm run plans:grandfather            → dry run, only prints
 *   npm run plans:grandfather -- --apply → writes the overrides
 *
 * Env (optional):
 *   GRANDFATHER_USERS          logins to keep (default 3)
 *   GRANDFATHER_BULK_MESSAGES  monthly bulk messages to keep (default 2000)
 *   GRANDFATHER_BEFORE         only orgs created before this date (default 2026-11-15)
 *
 * Safe to run twice: orgs that already have `featureOverrides.grandfathered2026` are skipped.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Organization = require('../models/Organization');

const APPLY = process.argv.includes('--apply');
const USERS = Number(process.env.GRANDFATHER_USERS || 3);
const BULK = Number(process.env.GRANDFATHER_BULK_MESSAGES || 2000);
const BEFORE = new Date(process.env.GRANDFATHER_BEFORE || '2026-11-15');

(async () => {
  await connectDB();
  const orgs = await Organization.find({
    plan: 'starter',
    createdAt: { $lt: BEFORE },
    'featureOverrides.grandfathered2026': { $ne: true },
  }).select('name plan region status featureOverrides limitOverrides').lean();

  console.log(`${orgs.length} Starter compan${orgs.length === 1 ? 'y' : 'ies'} found${APPLY ? '' : ' (dry run — add --apply to write)'}`);
  for (const org of orgs) {
    const featureOverrides = { ...(org.featureOverrides || {}), bulkWhatsapp: true, emailCampaigns: true, grandfathered2026: true };
    const limitOverrides = { ...(org.limitOverrides || {}) };
    if (limitOverrides.users === undefined) limitOverrides.users = USERS;
    if (limitOverrides.bulkMessages === undefined) limitOverrides.bulkMessages = BULK;
    console.log(`- ${org.name} (${org._id}) status=${org.status} → users ${limitOverrides.users}, bulk ${limitOverrides.bulkMessages}, bulk WhatsApp + email ON`);
    if (APPLY) await Organization.updateOne({ _id: org._id }, { $set: { featureOverrides, limitOverrides } });
  }
  await mongoose.disconnect();
  console.log(APPLY ? 'Done.' : 'Nothing written.');
})().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
