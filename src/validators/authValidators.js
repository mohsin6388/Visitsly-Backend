const { z } = require('zod');
const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
  }),
});

const verifyEmailSchema = z.object({
  body: z.object({
    token: z.string().min(20, 'Invalid verification token').max(200),
  }),
});

const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
  }),
});

const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(10, 'Invalid or missing reset token'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Password must contain an uppercase letter')
      .regex(/[0-9]/, 'Password must contain a number'),
  }),
});

const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Name must be at least 2 characters').max(100).optional(),
    email: z.string().email('Invalid email address').optional(),
    phone: z.string().min(7).max(20).optional(),
  }),
});

const strongPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a number');

const signupSchema = z.object({
  body: z.object({
    // Only mobile, email and password are asked at signup. Company, name,
    // city, country and business type are collected by the onboarding wizard;
    // the fields stay optional here so older clients keep working.
    email: z.string().email('Invalid email address'),
    // Full international format ("+971501234567"). A number without "+" is
    // read using `country` (the detected country) as its default region.
    phone: z.string().trim().min(6, 'Enter a valid mobile number').max(24),
    password: strongPassword,
    companyName: z.string().trim().max(120).optional().or(z.literal('')),
    name: z.string().trim().max(100).optional().or(z.literal('')),
    city: z.string().trim().max(80).optional(),
    businessType: z.enum(['broker', 'agency', 'builder', 'other']).optional(),
    plan: z.string().max(30).optional(),
    // Detected country (IP / browser). Used as the default region for the
    // phone number and the provisional company country.
    country: z.string().trim().toUpperCase().max(8).optional(),
  }),
});

const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1),
    newPassword: strongPassword,
  }),
});

module.exports = {
  signupSchema,
  changePasswordSchema,
  loginSchema,
  forgotPasswordSchema,
  verifyEmailSchema,
  resetPasswordSchema,
  updateProfileSchema,
};
