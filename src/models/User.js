const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { Schema } = mongoose;

const ROLES = ['admin', 'builder', 'broker'];

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // Defaults to true for migration safety: existing customer/staff accounts
    // remain usable, while public signup explicitly creates unverified users.
    emailVerified: { type: Boolean, default: true, index: true },
    emailVerificationTokenHash: { type: String, select: false, default: null },
    // TTL cleanup only removes unverified signup records; verified users clear this field.
    emailVerificationExpires: { type: Date, select: false, default: null },
    pendingSignup: {
      companyName: { type: String, trim: true },
      slug: { type: String, lowercase: true, trim: true },
      city: { type: String, trim: true, default: '' },
      businessType: { type: String, enum: ['broker', 'agency', 'builder', 'other'], default: 'broker' },
      phone: { type: String, trim: true, default: '' },
      plan: { type: String, default: null },
      country: { type: String, default: 'IN' },
    },
    phone: { type: String, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, default: 'broker' },

    // ---- SaaS ----
    // Company (tenant) this user belongs to. Platform super-admins have none.
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    // Permission inside the company: owner (everything) or agent (only what the owner switched on,
    // and only leads assigned to them). 'manager' is a legacy value, treated as 'agent' on read.
    orgRole: { type: String, enum: ['owner', 'agent', 'manager'], default: 'owner' },
    // Agent permission toggles (see services/saas/permissions.js). Keys that were never stored use the defaults.
    permissions: {
      type: new Schema({
        dashboard: Boolean, leads: Boolean, inbox: Boolean, whatsappLeads: Boolean, siteVisits: Boolean, followUps: Boolean, properties: Boolean,
        leadCreate: Boolean, leadImport: Boolean, leadEdit: Boolean, leadDelete: Boolean, chatReply: Boolean,
        showFullPhone: Boolean,
      }, { _id: false }),
      default: undefined,
    },
    // PropAI staff — can see every company from the Platform admin panel.
    isSuperAdmin: { type: Boolean, default: false },
    // Set when a teammate was invited with a temporary password.
    mustChangePassword: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },

    // Refresh token rotation: only a hash is ever stored.
    refreshTokenHash: { type: String, select: false, default: null },
    // Separate session for the PropAI admin panel (super-admins only).
    adminRefreshTokenHash: { type: String, select: false, default: null },
    tokenVersion: { type: Number, default: 0 }, // bumping this invalidates all outstanding refresh tokens

    // Password reset flow
    resetPasswordTokenHash: { type: String, select: false, default: null },
    resetPasswordExpires: { type: Date, select: false, default: null },

    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.index(
  { emailVerificationExpires: 1 },
  {
    expireAfterSeconds: 0,
    partialFilterExpression: { emailVerified: false },
    name: 'unverified_email_signup_ttl',
  }
);

userSchema.pre('save', async function preSave(next) {
  if (!this.isModified('passwordHash')) return next();
  // passwordHash field is set to the PLAIN password by callers (see setPassword),
  // then hashed here on save so it's never persisted in plain text.
  if (!this._plainPassword) return next();
  const salt = await bcrypt.genSalt(12);
  this.passwordHash = await bcrypt.hash(this._plainPassword, salt);
  this._plainPassword = undefined;
  next();
});

userSchema.methods.setPassword = function setPassword(plainPassword) {
  this._plainPassword = plainPassword;
  this.passwordHash = plainPassword; // placeholder, replaced by pre-save hook
};

userSchema.methods.comparePassword = function comparePassword(plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.refreshTokenHash;
  delete obj.adminRefreshTokenHash;
  delete obj.resetPasswordTokenHash;
  delete obj.resetPasswordExpires;
  delete obj.emailVerificationTokenHash;
  delete obj.emailVerificationExpires;
  delete obj.pendingSignup;
  return obj;
};

userSchema.statics.ROLES = ROLES;

module.exports = mongoose.model('User', userSchema);
