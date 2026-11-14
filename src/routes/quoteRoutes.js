const express = require('express');
const { z } = require('zod');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const c = require('../controllers/quoteController');

const money = z.coerce.number().min(0).max(1e11);
const pricing = z.object({
  ratePerSqft: money.optional(),
  baseAmount: money.optional(),
  items: z.array(z.object({ label: z.string().max(80), amount: money, taxable: z.boolean().optional() })).max(20).optional(),
  discount: money.optional(),
  gstPct: z.coerce.number().min(0).max(28).optional(),
  stampDutyPct: z.coerce.number().min(0).max(15).optional(),
  registrationPct: z.coerce.number().min(0).max(5).optional(),
});
const unit = z.object({
  tower: z.string().max(20).optional(),
  unitNo: z.string().max(20).optional(),
  floor: z.string().max(10).optional(),
  bhk: z.string().max(10).optional(),
  areaSqft: z.coerce.number().min(0).max(1e6).optional(),
  facing: z.string().max(30).optional(),
});
const plan = z.array(z.object({ milestone: z.string().max(100), pct: z.coerce.number().min(0).max(100) })).max(20).optional();

const quoteSchema = z.object({
  body: z.object({
    leadId: z.string().regex(/^[a-f\d]{24}$/i).optional().nullable(),
    propertyId: z.string().regex(/^[a-f\d]{24}$/i).optional().nullable(),
    customer: z.object({ name: z.string().max(150).optional(), phone: z.string().max(20).optional(), email: z.string().max(200).optional() }).optional(),
    project: z.string().trim().min(1, 'Project ka naam chahiye').max(150),
    unit: unit.optional(),
    pricing,
    paymentPlan: plan,
    validTill: z.string().optional(),
    notes: z.string().max(2000).optional(),
  }).refine((b) => (b.pricing.ratePerSqft && b.unit?.areaSqft) || b.pricing.baseAmount, { message: 'Rate x area ya base amount chahiye', path: ['pricing'] }),
});
const previewSchema = z.object({ body: z.object({ unit: unit.optional(), pricing, paymentPlan: plan }) });

// Public PDF link (shared on WhatsApp / email) — token is the secret.
router.get('/public/:token', c.publicPdf);

router.use(authenticate);
router.get('/', c.list);
router.post('/preview', validate(previewSchema), c.preview);
router.post('/', validate(quoteSchema), c.create);
router.delete('/:id', c.remove);
router.post('/:id/send-whatsapp', c.sendWhatsapp);

module.exports = router;
