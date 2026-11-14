/**
 * One-time migration: turns the existing single-client deployment
 * (Agarwal Homez) into the FIRST company of the multi-tenant SaaS.
 *
 *   npm run saas:migrate
 *
 * Env (optional):
 *   MIGRATE_ORG_NAME      company name (default: Settings.companyName or CLIENT_NAME)
 *   MIGRATE_PLAN          starter | growth | builder | enterprise (default starter)
 *   MIGRATE_PRICE         custom monthly price in INR, e.g. 3500 (founding client)
 *   MIGRATE_PAID_DAYS     days the current paid period lasts (default 90)
 *
 * Safe to run twice — it does nothing if the owner already has a company.
 * Existing leads, chats, campaigns, properties stay exactly where they are:
 * they're stored under the owner's user id, which becomes the workspace id.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const env = require('../config/env');
const User = require('../models/User');
const Organization = require('../models/Organization');
const Settings = require('../models/Settings');
const { encrypt } = require('../utils/crypto');

(async () => {
  await connectDB();

  const clientEmail = String(process.env.CLIENT_EMAIL || '').trim().toLowerCase();
  let owner = null;
  if (clientEmail) owner = await User.findOne({ email: clientEmail });
  if (!owner && process.env.DEFAULT_LEAD_OWNER_ID) owner = await User.findById(process.env.DEFAULT_LEAD_OWNER_ID);
  if (!owner) owner = await User.findOne({ role: { $in: ['broker', 'builder', 'admin'] }, isActive: true }).sort({ createdAt: 1 });
  if (!owner) throw new Error('No existing user found to become the company owner. Set CLIENT_EMAIL.');

  if (owner.orgId && (await Organization.exists({ _id: owner.orgId }))) {
    console.log(`Owner ${owner.email} already belongs to a company — nothing to do.`);
    await mongoose.disconnect();
    return process.exit(0);
  }

  const legacySettings = await Settings.findOne({ orgId: null });
  const name = process.env.MIGRATE_ORG_NAME || legacySettings?.companyName || process.env.CLIENT_NAME || 'My Company';
  const plan = process.env.MIGRATE_PLAN || 'starter';
  const paidDays = parseInt(process.env.MIGRATE_PAID_DAYS || '90', 10);
  const meta = env.platformMeta;

  const whatsapp = meta.accessToken && meta.phoneNumberId
    ? {
        status: 'connected',
        connectedVia: 'manual',
        phoneNumberId: String(meta.phoneNumberId),
        businessAccountId: meta.businessAccountId ? String(meta.businessAccountId) : null,
        accessTokenEncrypted: encrypt(meta.accessToken),
        openingTemplateName: legacySettings?.openingTemplate?.name || meta.openingTemplateName || null,
        openingTemplateLanguage: legacySettings?.openingTemplate?.language || meta.openingTemplateLanguage || null,
        connectedAt: new Date(),
      }
    : { status: 'not_connected' };

  let slug = Organization.slugify(name);
  if (await Organization.exists({ slug })) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

  const org = await Organization.create({
    name,
    slug,
    ownerUserId: owner._id,
    billingEmail: owner.email,
    phone: owner.phone || '',
    plan,
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + paidDays * 24 * 60 * 60 * 1000),
    priceOverride: process.env.MIGRATE_PRICE ? Number(process.env.MIGRATE_PRICE) : null,
    notes: 'Migrated from the single-client deployment (founding client).',
    whatsapp,
    onboarding: { companyDone: true, whatsappDone: whatsapp.status === 'connected', contactsDone: true, propertiesDone: true },
    razorpay: { setupFeePaid: true },
  });

  owner.orgId = org._id;
  owner.orgRole = 'owner';
  if (owner.role === 'admin') owner.role = 'broker';
  await owner.save();

  // Every other existing login joins the same company as a manager.
  const others = await User.updateMany(
    { _id: { $ne: owner._id }, orgId: null, isSuperAdmin: { $ne: true } },
    { $set: { orgId: org._id, orgRole: 'manager' } }
  );

  if (legacySettings) {
    legacySettings.orgId = org._id;
    if (!legacySettings.companyName) legacySettings.companyName = name;
    await legacySettings.save();
  } else {
    await Settings.create({ orgId: org._id, companyName: name });
  }

  console.log(`Company "${name}" created (${org._id}) on plan ${plan}, owner ${owner.email}.`);
  console.log(`WhatsApp: ${whatsapp.status}${whatsapp.phoneNumberId ? ` (Phone Number ID ${whatsapp.phoneNumberId})` : ''}.`);
  console.log(`${others.modifiedCount} other user(s) added as managers.`);
  console.log('You can now remove META_WHATSAPP_ACCESS_TOKEN / PHONE_NUMBER_ID / BUSINESS_ACCOUNT_ID from .env — the token is stored encrypted on the company.');
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('[saas:migrate] Failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
