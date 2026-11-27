const express = require('express');
const { z } = require('zod');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');
const c = require('../controllers/voiceController');

const settingsSchema = z.object({
  body: z.object({
    autoCallNewLeads: z.boolean().optional(),
    autoCallAfterMinutes: z.number().int().min(5).max(720).optional(),
    script: z.string().max(4000).optional(),
    paused: z.boolean().optional(),
  }),
});

const { requireFeature } = require('../services/saas/subscription');

router.use(authenticate);
// AI calling is a paid-plan feature (never on the free trial). Reads stay
// open so the page can show usage and an upgrade prompt.
const calling = requireFeature('aiCalling');
router.get('/settings', roleGuard.org('owner'), c.getSettings);
router.patch('/settings', roleGuard.org('owner'), calling, validate(settingsSchema), c.updateSettings);
router.get('/calls', roleGuard.org('owner'), c.listCalls);
const managers = roleGuard.org('owner');
const oid = z.string().regex(/^[a-f\d]{24}$/i);
router.get('/history', managers, c.history);
router.delete('/history/:id', managers, validate(z.object({ params: z.object({ id: oid }) })), c.deleteCall);
router.delete('/history', managers, c.clearHistory);
router.get('/leads', managers, c.callableLeads);
// One batch = max 100 contacts (BULK_BATCH_MAX in voiceService).
router.post('/queue', managers, calling, validate(z.object({ body: z.object({ leadIds: z.array(oid).min(1).max(100, 'You can add up to 100 contacts to AI calling at a time') }) })), c.queueLeads);
router.post('/queue/cancel', managers, validate(z.object({ body: z.object({ leadIds: z.array(oid).max(5000).optional() }) })), c.cancelQueue);
router.post('/call/:leadId', roleGuard.org('owner'), calling, c.callLead);
router.post('/test-call', roleGuard.org('owner'), calling, validate(z.object({ body: z.object({ phone: z.string().trim().min(10).max(20), kind: z.enum(['lead', 'visit']).optional() }) })), c.testCall);

module.exports = router;
