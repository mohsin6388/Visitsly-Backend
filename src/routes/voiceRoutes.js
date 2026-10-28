const express = require('express');
const { z } = require('zod');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');
const c = require('../controllers/voiceController');

const settingsSchema = z.object({
  body: z.object({
    enabled: z.boolean().optional(),
    apiKey: z.string().trim().min(10).max(300).optional(),
    agentId: z.string().trim().max(100).optional(),
    fromNumber: z.string().trim().max(20).optional(),
    autoCallNewLeads: z.boolean().optional(),
    autoCallAfterMinutes: z.number().int().min(5).max(720).optional(),
  }),
});

router.use(authenticate);
router.get('/settings', roleGuard.org('owner', 'manager'), c.getSettings);
router.patch('/settings', roleGuard.org('owner', 'manager'), validate(settingsSchema), c.updateSettings);
router.get('/calls', c.listCalls);
router.post('/call/:leadId', c.callLead);

module.exports = router;
