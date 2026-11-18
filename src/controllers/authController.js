const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const env = require('../config/env');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  generateRawToken,
} = require('../utils/tokens');
const { sendPasswordResetEmail, sendEmailVerificationEmail } = require('../services/email/mailer');
const { isDisposableEmail } = require('../services/auth/emailAddress');
const { normalizePhone, phoneVariants } = require('../utils/phone');
const Organization = require('../models/Organization');
const Settings = require('../models/Settings');
const orgService = require('../services/saas/orgService');
const { orgSummary } = require('../services/saas/orgSummary');
const { TRIAL_DAYS, PLANS } = require('../config/plans');
const isSuperAdminUser = require('../middlewares/auth').isSuperAdmin;

/** Company + plan info sent with login / me / signup (null for platform admins). */
async function orgFor(user) {
  if (!env.saas.enabled || !user.orgId) return null;
  return orgSummary(await orgService.getSnapshot(user.orgId));
}

function userJson(user) {
  return { ...user.toSafeJSON(), isSuperAdmin: false }; // admin features live in the separate admin panel
}

const REFRESH_COOKIE_NAME = 'refreshToken';

function durationToMs(value, fallback = 90 * 24 * 60 * 60 * 1000) {
  const match = String(value || '').match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * multipliers[match[2].toLowerCase()];
}

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.cookie.secure,
    sameSite: env.cookie.sameSite || 'lax',
    domain: env.cookie.domain,
    path: '/api/auth', // only sent back to auth endpoints
    maxAge: durationToMs(env.jwt.refreshExpiresIn),
  };
}

async function issueTokens(res, user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  user.refreshTokenHash = hashToken(refreshToken);
  await user.save();

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  return accessToken;
}

/**
 * POST /api/auth/login
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (env.clientEmail && normalizedEmail !== env.clientEmail) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');
  if (!user || !(await user.comparePassword(password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (user.emailVerified === false) {
    throw ApiError.forbidden('Verify your email before logging in. To get a new link, sign up again with the same email.');
  }
  if (!user.isActive) {
    throw ApiError.forbidden('This account has been deactivated');
  }
  if (env.saas.enabled && !user.orgId) {
    // PropAI staff use the separate admin panel, not the customer app.
    throw ApiError.forbidden(isSuperAdminUser(user) ? 'Platform admins must log in from the admin panel' : 'This login is not linked to any company');
  }

  const accessToken = await issueTokens(res, user);

  user.lastLoginAt = new Date();
  await user.save();

  await AuditLog.create({
    userId: user._id,
    action: 'auth.login',
    entityType: 'User',
    entityId: user._id,
    ip: req.ip,
  });

  return new ApiResponse(
    200,
    { user: userJson(user), accessToken, org: await orgFor(user) },
    'Logged in successfully'
  ).send(res);
});

/**
 * POST /api/auth/refresh
 * Rotates the refresh token on every use (reuse detection: if the incoming
 * token doesn't match the stored hash, every session for that user is killed).
 */
const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) throw ApiError.unauthorized('Missing refresh token');

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  const user = await User.findById(payload.sub).select('+refreshTokenHash');
  if (!user || !user.isActive || user.emailVerified === false || (env.clientEmail && String(user.email || '').toLowerCase() !== env.clientEmail)) {
    throw ApiError.unauthorized('Account not found, email not verified, or deactivated');
  }

  const incomingHash = hashToken(token);
  if (!user.refreshTokenHash || user.refreshTokenHash !== incomingHash) {
    // Possible token reuse/theft: invalidate all sessions for this user.
    user.tokenVersion += 1;
    user.refreshTokenHash = null;
    await user.save();
    throw ApiError.unauthorized('Refresh token invalid — please log in again');
  }

  const accessToken = await issueTokens(res, user); // rotates refresh token too

  return new ApiResponse(200, { accessToken }, 'Token refreshed').send(res);
});

/**
 * POST /api/auth/logout
 */
const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (token) {
    try {
      const payload = verifyRefreshToken(token);
      await User.findByIdAndUpdate(payload.sub, { refreshTokenHash: null });
    } catch {
      // token already invalid/expired - nothing to clean up
    }
  }
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
  return new ApiResponse(200, null, 'Logged out').send(res);
});

/**
 * POST /api/auth/forgot-password
 * Always returns a generic success message, whether or not the email exists,
 * to avoid leaking which addresses are registered.
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = env.clientEmail && email !== env.clientEmail ? null : await User.findOne({ email });

  if (user) {
    const rawToken = generateRawToken();
    user.resetPasswordTokenHash = hashToken(rawToken);
    user.resetPasswordExpires = new Date(Date.now() + env.resetTokenExpiresMin * 60 * 1000);
    await user.save();

    const resetLink = `${env.appBaseUrl}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail(user.email, resetLink).catch((err) => {
      // Log but don't fail the request just because email delivery had an issue.
      req.app.get('logger')?.error?.('Failed to send reset email', err);
    });
  }

  return new ApiResponse(
    200,
    null,
    'If an account with that email exists, a reset link has been sent.'
  ).send(res);
});

/**
 * POST /api/auth/reset-password
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  const tokenHash = hashToken(token);

  const user = await User.findOne({
    ...(env.clientEmail ? { email: env.clientEmail } : {}),
    resetPasswordTokenHash: tokenHash,
    resetPasswordExpires: { $gt: new Date() },
  }).select('+resetPasswordTokenHash +resetPasswordExpires');

  if (!user) {
    throw ApiError.badRequest('Reset link is invalid or has expired');
  }

  user.setPassword(password);
  user.resetPasswordTokenHash = null;
  user.resetPasswordExpires = null;
  user.tokenVersion += 1; // invalidate any existing sessions
  user.refreshTokenHash = null;
  await user.save();

  return new ApiResponse(200, null, 'Password reset successfully. Please log in.').send(res);
});

/**
 * GET /api/auth/me
 */
const getMe = asyncHandler(async (req, res) => {
  // actorId = the real logged-in person (req.user.id is the shared workspace id).
  const user = await User.findById(req.user.actorId || req.user.id);
  if (!user) throw ApiError.notFound('User not found');
  const org = req.org ? await orgSummary(req.org) : await orgFor(user);
  return new ApiResponse(200, {
    user: { ...userJson(user), orgRole: req.user.orgRole || user.orgRole, impersonating: !!req.user.impersonating },
    org,
  }).send(res);
});

/**
 * One account per mobile number: true when a verified user already uses this
 * number (stored in any older format) — optionally ignoring one user id.
 */
async function phoneInUse(phone, ignoreUserId = null) {
  const variants = [...new Set(phoneVariants(phone))];
  const query = {
    emailVerified: { $ne: false },
    $or: [{ phone: { $in: variants } }, { 'pendingSignup.phone': { $in: variants } }],
  };
  if (ignoreUserId) query._id = { $ne: ignoreUserId };
  return Boolean(await User.exists(query));
}

/**
 * POST /api/auth/signup — create a pending account. Workspace creation and
 * the seven-day trial only begin after the person proves they own the email.
 */
const signup = asyncHandler(async (req, res) => {
  if (!env.saas.enabled || !env.saas.signupEnabled) throw ApiError.forbidden('Signup is disabled');
  const { companyName, name, email, password, city, businessType, plan, country } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  // Normalise the mobile number so the same number can't be registered twice.
  const parsedPhone = normalizePhone(req.body.phone, { defaultCountry: String(country || 'IN').toUpperCase() });
  if (!parsedPhone.ok) throw ApiError.badRequest('Enter a valid mobile number.');
  const phone = parsedPhone.phone;

  if (isDisposableEmail(normalizedEmail)) {
    throw ApiError.badRequest('Temporary email addresses are not allowed. Use an email you can verify.');
  }
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    if (existingUser.emailVerified === false) {
      throw ApiError.conflict('Email verification pending. Resend the verification link.');
    }
    throw ApiError.conflict('This email is already registered. Log in instead.');
  }
  if (await phoneInUse(phone)) {
    throw ApiError.conflict('This mobile number is already registered. Log in instead.');
  }

  const rawToken = generateRawToken();
  const baseSlug = Organization.slugify(companyName);
  const pendingPlan = plan && PLANS[plan]?.public ? plan : null;
  const user = new User({
    name,
    email: normalizedEmail,
    phone,
    role: 'broker',
    orgRole: 'owner',
    emailVerified: false,
    emailVerificationTokenHash: hashToken(rawToken),
    emailVerificationExpires: new Date(Date.now() + env.emailVerificationExpiresHours * 60 * 60 * 1000),
    pendingSignup: {
      companyName,
      slug: `${baseSlug}-${generateRawToken().slice(0, 6)}`,
      city: city || '',
      businessType: businessType || 'broker',
      phone: phone || '',
      plan: pendingPlan,
      country: String(country || 'IN').toUpperCase().slice(0, 8),
    },
  });
  user.setPassword(password);

  try {
    await user.save();
    const verificationLink = `${env.appBaseUrl.replace(/\/$/, '')}/verify-email?token=${rawToken}`;
    await sendEmailVerificationEmail(normalizedEmail, verificationLink);
  } catch (err) {
    // Don't leave an unusable pending account when the mail provider rejects
    // the request. Duplicate-key races are still surfaced by the API handler.
    await User.deleteOne({ _id: user._id }).catch(() => {});
    if (err?.code === 'BREVO_NOT_CONFIGURED' || String(err?.code || '').startsWith('BREVO_')) {
      throw new ApiError(503, 'We could not send the verification email. Please try again shortly.');
    }
    throw err;
  }

  return new ApiResponse(
    201,
    { email: normalizedEmail, verificationRequired: true, expiresInHours: env.emailVerificationExpiresHours },
    `Verification email sent. Your ${TRIAL_DAYS}-day free trial starts once you verify.`
  ).send(res);
});

/**
 * POST /api/auth/verify-email — consume a one-time token and create the tenant.
 * The token is atomically consumed before creating records to prevent parallel
 * requests from creating duplicate workspaces.
 */
const verifyEmail = asyncHandler(async (req, res) => {
  const rawToken = String(req.body.token || '').trim();
  if (!rawToken) throw ApiError.badRequest('Verification token is missing');

  const user = await User.findOneAndUpdate(
    {
      emailVerificationTokenHash: hashToken(rawToken),
      emailVerificationExpires: { $gt: new Date() },
      emailVerified: false,
      'pendingSignup.companyName': { $exists: true, $ne: '' },
    },
    // Keep a short cleanup window during provisioning. If workspace creation
    // fails, the user can request a fresh link; otherwise TTL removes the stale row.
    { $set: { emailVerificationTokenHash: null, emailVerificationExpires: new Date(Date.now() + 15 * 60 * 1000) } },
    { new: true, runValidators: true }
  ).select('+emailVerificationTokenHash +emailVerificationExpires');

  if (!user) {
    throw ApiError.badRequest('This verification link is invalid or expired. Request a new one.');
  }

  const pending = user.pendingSignup;
  if (pending?.phone && (await phoneInUse(pending.phone, user._id))) {
    await User.deleteOne({ _id: user._id }).catch(() => {});
    throw ApiError.conflict('This mobile number is already registered. Log in instead.');
  }
  let org = null;
  try {
    let slug = pending.slug || Organization.slugify(pending.companyName);
    if (await Organization.exists({ slug })) slug = `${Organization.slugify(pending.companyName)}-${generateRawToken().slice(0, 8)}`;

    org = await Organization.create({
      name: pending.companyName,
      slug,
      ownerUserId: user._id,
      city: pending.city || '',
      businessType: pending.businessType || 'broker',
      billingEmail: user.email,
      phone: pending.phone || user.phone || '',
      plan: 'trial',
      status: 'trialing',
      country: pending.country || 'IN',
      currency: require('../config/pricing').currencyForCountry(pending.country || 'IN'),
      trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
      pendingPlan: pending.plan && PLANS[pending.plan]?.public ? pending.plan : null,
      onboarding: { companyDone: true },
    });

    await Settings.create({
      orgId: org._id,
      companyName: pending.companyName,
      openingText: `Hi! Thank you for your interest in ${pending.companyName}. I can help with your property search. What kind of property are you looking for?`,
      referral: { enabled: false },
    });

    const completed = await User.updateOne(
      { _id: user._id, emailVerified: false, orgId: null },
      {
        $set: {
          orgId: org._id,
          emailVerified: true,
          emailVerificationTokenHash: null,
          emailVerificationExpires: null,
        },
        $unset: { pendingSignup: '' },
      }
    );
    if (!completed.modifiedCount) throw new Error('Could not finalize verified signup');
  } catch (err) {
    // Leave the pending signup available for a fresh verification link/retry.
    if (org) {
      await Settings.deleteOne({ orgId: org._id }).catch(() => {});
      await Organization.deleteOne({ _id: org._id }).catch(() => {});
    }
    throw err;
  }

  await AuditLog.create({
    orgId: org._id,
    userId: user._id,
    action: 'auth.signup',
    entityType: 'Organization',
    entityId: org._id,
    ip: req.ip,
  });

  return new ApiResponse(
    200,
    { email: user.email, verified: true, trialDays: TRIAL_DAYS },
    `Email verified. Your ${TRIAL_DAYS}-day free trial has started. Log in to continue.`
  ).send(res);
});

/** POST /api/auth/resend-verification — generic response prevents email enumeration. */
const resendVerification = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const genericMessage = 'If verification is pending for this email, a new link has been sent.';
  const user = await User.findOne({ email, emailVerified: false, 'pendingSignup.companyName': { $exists: true, $ne: '' } })
    .select('+emailVerificationTokenHash +emailVerificationExpires');

  if (user) {
    const rawToken = generateRawToken();
    user.emailVerificationTokenHash = hashToken(rawToken);
    user.emailVerificationExpires = new Date(Date.now() + env.emailVerificationExpiresHours * 60 * 60 * 1000);
    await user.save();
    const verificationLink = `${env.appBaseUrl.replace(/\/$/, '')}/verify-email?token=${rawToken}`;
    await sendEmailVerificationEmail(user.email, verificationLink);
  }

  return new ApiResponse(200, null, genericMessage).send(res);
});

/** POST /api/auth/change-password — logged-in user changes own password. */
const changePassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.actorId || req.user.id).select('+passwordHash');
  if (!user || !(await user.comparePassword(req.body.currentPassword))) {
    throw ApiError.badRequest('Current password is incorrect');
  }
  user.setPassword(req.body.newPassword);
  user.mustChangePassword = false;
  await user.save();
  return new ApiResponse(200, null, 'Password changed').send(res);
});

/**
 * PATCH /api/auth/profile
 * Updates the logged-in user's own name/email/phone (used by the Profile
 * page). Email changes are checked for uniqueness against other accounts.
 */
const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, phone } = req.body;

  const user = await User.findById(req.user.actorId || req.user.id);
  if (!user) throw ApiError.notFound('User not found');

  if (email && env.clientEmail && email.toLowerCase() !== env.clientEmail) {
    throw ApiError.badRequest('Login email is locked for this single-client deployment. Update CLIENT_EMAIL on the backend and reseed/reconcile the account to change it.');
  }

  if (email && email.toLowerCase() !== user.email) {
    throw ApiError.badRequest('Changing the login email needs verification. Please contact support.');
  }

  if (name !== undefined) user.name = name;
  if (phone !== undefined) {
    const parsed = normalizePhone(phone, { defaultCountry: req.org?.country || 'IN' });
    if (!parsed.ok) throw ApiError.badRequest('Enter a valid mobile number.');
    if (parsed.phone !== user.phone && (await phoneInUse(parsed.phone, user._id))) {
      throw ApiError.conflict('This mobile number is already registered.');
    }
    user.phone = parsed.phone;
  }

  await user.save();

  await AuditLog.create({
    userId: user._id,
    action: 'auth.updateProfile',
    entityType: 'User',
    entityId: user._id,
    ip: req.ip,
  });

  return new ApiResponse(200, { user: userJson(user) }, 'Profile updated').send(res);
});

module.exports = {
  signup,
  verifyEmail,
  resendVerification,
  changePassword,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  getMe,
  updateProfile,
};
