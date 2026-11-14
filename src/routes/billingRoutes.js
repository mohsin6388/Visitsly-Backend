const express = require('express');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');
const c = require('../controllers/billingController');
const v = require('../validators/saasValidators');
const { z } = require('zod');

// Billing is owner-only (managers can see the plan on /api/org).
router.use(authenticate, roleGuard.org('owner'));

router.get('/', c.getBilling);
router.get('/quote', validate(v.quoteSchema), c.getQuote);
router.post('/checkout', validate(v.checkoutSchema), c.checkout);
router.post('/verify', validate(v.verifySchema), c.verify);
router.post('/cancel', c.cancel);
router.post('/addon-checkout', validate(z.object({ body: z.object({ addon: z.enum(['extraUser', 'extraNumber', 'extraAiConversations', 'voiceMinute', 'leadRevival']), quantity: z.coerce.number().int().min(1).max(50000).default(1) }) })), c.addonCheckout);
router.post('/addon-verify', validate(z.object({ body: z.object({ razorpay_order_id: z.string().min(5), razorpay_payment_id: z.string().min(5), razorpay_signature: z.string().min(10) }) })), c.addonVerify);

module.exports = router;
