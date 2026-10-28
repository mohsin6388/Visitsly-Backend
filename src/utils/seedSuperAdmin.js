/**
 * Creates (or promotes) a PropAI platform super-admin login.
 *   SUPER_ADMIN_EMAIL=you@deific.in SUPER_ADMIN_PASSWORD='...' npm run seed:superadmin
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');

(async () => {
  const email = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.SUPER_ADMIN_PASSWORD || '');
  if (!email) throw new Error('Set SUPER_ADMIN_EMAIL');
  await connectDB();
  let user = await User.findOne({ email });
  if (user) {
    user.isSuperAdmin = true;
    await user.save();
    console.log(`${email} is now a platform super-admin.`);
  } else {
    if (password.length < 12) throw new Error('Set SUPER_ADMIN_PASSWORD (12+ characters) to create a new login');
    user = new User({ name: process.env.SUPER_ADMIN_NAME || 'PropAI Admin', email, role: 'admin', isSuperAdmin: true, orgId: null });
    user.setPassword(password);
    await user.save();
    console.log(`Super-admin ${email} created.`);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('[seed:superadmin] Failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
