const express = require('express');
const { z } = require('zod');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');
const c = require('../controllers/reportsController');

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date YYYY-MM-DD format mein ho');
const budgetSchema = z.object({
  body: z.object({
    enabled: z.boolean().optional(),
    amount: z.coerce.number().min(0).max(100000000).optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    period: z.enum(['month', 'custom']).optional(),
    startDate: date.nullable().optional(),
    endDate: date.nullable().optional(),
    thresholds: z.array(z.coerce.number().int().min(1).max(200)).max(6).optional(),
    alertPhone: z.string().trim().max(20).optional(),
    pauseCampaignsAtLimit: z.boolean().optional(),
    rates: z
      .object({
        marketing: z.coerce.number().min(0).max(1000).optional(),
        utility: z.coerce.number().min(0).max(1000).optional(),
        authentication: z.coerce.number().min(0).max(1000).optional(),
        service: z.coerce.number().min(0).max(1000).optional(),
        voicePerMinute: z.coerce.number().min(0).max(1000).optional(),
      })
      .optional(),
  }),
});

// Reports compare the whole team, so owners and managers only.
router.use(authenticate, roleGuard.org('owner', 'manager'));
router.get('/', c.getReport);
router.get('/budget', c.getBudget);
router.patch('/budget', validate(budgetSchema), c.updateBudget);
router.post('/budget/send', c.sendBudgetReport);

module.exports = router;
