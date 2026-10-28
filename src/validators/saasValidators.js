const { z } = require('zod');

const orgRoles = z.enum(['manager', 'agent']);
const planCode = z.enum(['starter', 'growth', 'builder', 'enterprise']);
const cycle = z.enum(['monthly', 'annual']);

const updateOrgSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(120).optional(),
    city: z.string().trim().max(80).optional(),
    businessType: z.enum(['broker', 'agency', 'builder', 'other']).optional(),
    gstin: z.string().trim().max(20).optional(),
    billingEmail: z.string().email().optional().or(z.literal('')),
    phone: z.string().trim().max(20).optional(),
  }),
});

const onboardingSchema = z.object({
  // Completion flags are server-owned and set from actual connection/data events.
  // The client may only choose whether to hide the compact checklist.
  body: z.object({ dismissed: z.boolean().optional() }),
});

const embeddedSignupPrepareSchema = z.object({
  body: z.object({
    code: z.string().trim().min(5).max(4096),
    wabaId: z.string().trim().regex(/^\d+$/, 'Invalid WABA ID'),
    phoneNumberId: z.string().trim().regex(/^\d+$/, 'Invalid Phone Number ID').optional(),
    eventType: z.enum(['FINISH', 'FINISH_ONLY_WABA', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING']).optional(),
  }),
});

const embeddedSignupCompleteSchema = z.object({
  body: z.object({
    attemptId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid or expired connection attempt'),
    phoneNumberId: z.string().trim().regex(/^\d+$/, 'Invalid Phone Number ID'),
    pin: z.string().regex(/^\d{6}$/, 'Registration PIN must be exactly 6 digits'),
  }),
});

const embeddedSignupSchema = z.object({
  body: z.object({
    code: z.string().min(5),
    wabaId: z.string().regex(/^\d+$/, 'Invalid WABA ID'),
    phoneNumberId: z.string().regex(/^\d+$/, 'Invalid Phone Number ID'),
    pin: z.string().regex(/^\d{6}$/, 'Registration PIN must be exactly 6 digits'),
  }),
});

const manualConnectSchema = z.object({
  body: z.object({
    accessToken: z.string().trim().min(20, 'Access token looks too short'),
    phoneNumberId: z.string().trim().regex(/^\d+$/, 'Phone Number ID sirf digits hota hai'),
    businessAccountId: z.string().trim().regex(/^\d+$/, 'WABA ID sirf digits hota hai'),
  }),
});

const openingTemplateSchema = z.object({
  body: z.object({
    name: z.string().trim().max(512).nullable().optional(),
    language: z.string().trim().max(15).nullable().optional(),
  }),
});

const inviteSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(100),
    email: z.string().email(),
    phone: z.string().trim().max(20).optional(),
    orgRole: orgRoles.default('agent'),
    password: z
      .string()
      .min(8)
      .regex(/[A-Z]/, 'Password must contain an uppercase letter')
      .regex(/[0-9]/, 'Password must contain a number')
      .optional(),
  }),
});

const updateMemberSchema = z.object({
  params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) }),
  body: z.object({
    name: z.string().trim().min(2).max(100).optional(),
    orgRole: orgRoles.optional(),
    isActive: z.boolean().optional(),
  }),
});

const memberIdSchema = z.object({ params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) }) });

const checkoutSchema = z.object({
  body: z.object({ plan: planCode, cycle: cycle.default('monthly') }),
});

const quoteSchema = z.object({
  query: z.object({ plan: planCode, cycle: cycle.default('monthly') }),
});

const verifySchema = z.object({
  body: z.object({
    razorpay_payment_id: z.string().min(5),
    razorpay_subscription_id: z.string().min(5),
    razorpay_signature: z.string().min(10),
  }),
});

const limitValue = z.union([z.number().int().min(0), z.null()]).optional();

const platformUpdateSchema = z.object({
  params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) }),
  body: z.object({
    plan: z.enum(['trial', 'starter', 'growth', 'builder', 'enterprise']).optional(),
    billingCycle: cycle.optional(),
    status: z.enum(['trialing', 'active', 'past_due', 'suspended', 'cancelled']).optional(),
    suspendedReason: z.string().max(300).optional(),
    extendTrialDays: z.number().int().min(1).max(365).optional(),
    currentPeriodEnd: z.string().optional(),
    limitOverrides: z
      .object({
        users: limitValue,
        contacts: limitValue,
        aiConversations: limitValue,
        whatsappNumbers: limitValue,
        campaignsPerMonth: limitValue,
      })
      .nullable()
      .optional(),
    priceOverride: z.number().int().min(0).nullable().optional(),
    notes: z.string().max(5000).optional(),
    addons: z.object({
      extraUsers: z.number().int().min(0).max(1000).optional(),
      extraNumbers: z.number().int().min(0).max(50).optional(),
      aiPacks: z.number().int().min(0).max(1000).optional(),
    }).optional(),
    branding: z.object({
      productName: z.string().max(60).optional(),
      logoUrl: z.string().max(500).optional(),
      primaryColor: z.string().regex(/^(#[0-9a-fA-F]{6})?$/).optional(),
      customDomain: z.string().max(200).regex(/^([a-z0-9-]+\.)+[a-z]{2,}$|^$/i, 'Domain jaise crm.company.com').optional(),
    }).optional(),
  }),
});

const adminCreateSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(100),
    email: z.string().email(),
    password: z.string().min(10, 'Admin password kam se kam 10 characters').regex(/[A-Z]/).regex(/[0-9]/),
  }),
});

const adminUpdateSchema = z.object({
  params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) }),
  body: z.object({ name: z.string().trim().min(2).max(100).optional(), isActive: z.boolean().optional() }),
});

const requestUpdateSchema = z.object({
  params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) }),
  body: z.object({ status: z.enum(['open', 'done', 'rejected']).optional(), adminNote: z.string().max(1000).optional() }),
});

const customerRequestSchema = z.object({
  body: z.object({
    type: z.enum(['addon', 'enterprise', 'white_label', 'voice', 'support', 'other']),
    addon: z.enum(['extraUser', 'extraNumber', 'extraAiConversations', 'voiceMinute', 'leadRevival']).optional(),
    quantity: z.number().int().min(1).max(1000).optional(),
    message: z.string().max(2000).optional(),
  }),
});

const offlinePaymentSchema = z.object({
  params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) }),
  body: z.object({
    plan: z.enum(['starter', 'growth', 'builder', 'enterprise']).optional(),
    cycle: cycle.default('monthly'),
    amount: z.number().min(0),
    note: z.string().max(300).optional(),
    includesSetup: z.boolean().optional(),
  }),
});

const orgListSchema = z.object({
  query: z.object({
    status: z.enum(['trialing', 'active', 'past_due', 'suspended', 'cancelled']).optional(),
    plan: z.string().max(30).optional(),
    search: z.string().max(100).optional(),
  }),
});

module.exports = {
  adminCreateSchema,
  adminUpdateSchema,
  requestUpdateSchema,
  customerRequestSchema,
  updateOrgSchema,
  onboardingSchema,
  embeddedSignupSchema,
  embeddedSignupPrepareSchema,
  embeddedSignupCompleteSchema,
  manualConnectSchema,
  openingTemplateSchema,
  inviteSchema,
  updateMemberSchema,
  memberIdSchema,
  checkoutSchema,
  quoteSchema,
  verifySchema,
  platformUpdateSchema,
  offlinePaymentSchema,
  orgListSchema,
};
