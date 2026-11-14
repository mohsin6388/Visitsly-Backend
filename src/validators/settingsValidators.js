const { z } = require('zod');

const updateSettingsSchema = z.object({
  body: z.object({
    companyName: z.string().max(150).optional(),
    logoUrl: z.string().max(500).optional(),
    geminiApiKey: z.string().max(200).optional(), // send '' to clear
    businessHours: z
      .object({
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      })
      .optional(),
    workingDays: z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).optional(),
    greetingMessage: z.string().max(500).optional(),
    openingText: z.string().max(500).optional(),
    aiPaused: z.boolean().optional(),
    autoReplyEnabled: z.boolean().optional(),
    leadAlertPhone: z.string().max(120).optional(), // one or more numbers, comma separated
    leadAlertLevel: z.enum(['hot', 'hot_warm']).optional(),
    alertOn: z
      .object({
        hotLead: z.boolean().optional(),
        visitBooked: z.boolean().optional(),
        visitConfirmed: z.boolean().optional(),
      })
      .optional(),
    alertTemplate: z
      .object({
        name: z.string().max(150).optional(),
        language: z.string().max(20).optional(),
        variableCount: z.number().int().min(0).max(5).optional(),
      })
      .optional(),
    aiReplyDelaySeconds: z.number().int().min(1).max(30).optional(),
    whatsappDisconnected: z.boolean().optional(),
    dailyReportEnabled: z.boolean().optional(),
    dailyReportPhone: z.string().max(20).optional(), // send '' to clear
    dailyReportTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    referral: z
      .object({
        enabled: z.boolean().optional(),
        personName: z.string().max(80).optional(),
        contactNumber: z.string().max(20).optional(), // send '' to clear
      })
      .optional(),
    visitConfirm: z
      .object({
        enabled: z.boolean().optional(),
        hoursBefore: z.number().int().min(1).max(72).optional(),
        templateName: z.string().max(150).optional(),
        templateLanguage: z.string().max(20).optional(),
        templateVariableCount: z.number().int().min(0).max(4).optional(),
        callEnabled: z.boolean().optional(),
        callAfterHours: z.number().int().min(1).max(24).optional(),
        mode: z.enum(['call_first', 'whatsapp_first']).optional(),
        callDelayMinutes: z.number().int().min(0).max(1440).optional(),
        callStartHour: z.number().int().min(0).max(23).optional(),
        callEndHour: z.number().int().min(1).max(24).optional(),
        callRetries: z.number().int().min(0).max(2).optional(),
      })
      .optional(),
    followUp: z
      .object({
        mode: z.enum(['manual', 'remind', 'auto']).optional(),
        timezone: z.string().max(60).optional(),
        messages: z.array(z.string().max(600)).max(6).optional(),
        gapsDays: z.array(z.number().int().min(1).max(60)).max(6).optional(),
        startHour: z.number().int().min(0).max(23).optional(),
        endHour: z.number().int().min(1).max(24).optional(),
        templateName: z.string().max(150).optional(),
        templateLanguage: z.string().max(20).optional(),
        templateVariableCount: z.number().int().min(0).max(2).optional(),
        useAiDate: z.boolean().optional(),
        reengage: z
          .object({
            enabled: z.boolean().optional(),
            gapsDays: z.array(z.number().int().min(1).max(120)).max(4).optional(),
            message: z.string().max(600).optional(),
          })
          .optional(),
      })
      .optional(),
    openingTemplate: z
      .object({
        name: z.string().max(150).optional(),
        language: z.string().max(20).optional(),
      })
      .optional(),
  }),
});

module.exports = { updateSettingsSchema };
