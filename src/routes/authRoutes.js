const express = require('express');
const router = express.Router();

const {
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
} = require('../controllers/authController');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/auth');
const { authLimiter } = require('../middlewares/rateLimit');
const {
  signupSchema,
  changePasswordSchema,
  loginSchema,
  forgotPasswordSchema,
  verifyEmailSchema,
  resetPasswordSchema,
  updateProfileSchema,
} = require('../validators/authValidators');

// SaaS: public self-serve signup starts a free trial (SIGNUP_ENABLED=false to turn off).
router.post('/signup', authLimiter, validate(signupSchema), signup);
router.post('/verify-email', authLimiter, validate(verifyEmailSchema), verifyEmail);
router.post('/resend-verification', authLimiter, validate(forgotPasswordSchema), resendVerification);
router.post('/change-password', authenticate, validate(changePasswordSchema), changePassword);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), resetPassword);
router.get('/me', authenticate, getMe);
router.patch('/profile', authenticate, validate(updateProfileSchema), updateProfile);

module.exports = router;
