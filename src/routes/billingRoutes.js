const express = require('express');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');
const c = require('../controllers/billingController');
const v = require('../validators/saasValidators');

// Billing is owner-only (managers can see the plan on /api/org).
router.use(authenticate, roleGuard.org('owner'));

router.get('/', c.getBilling);
router.get('/quote', validate(v.quoteSchema), c.getQuote);
router.post('/checkout', validate(v.checkoutSchema), c.checkout);
router.post('/verify', validate(v.verifySchema), c.verify);
router.post('/cancel', c.cancel);

module.exports = router;
