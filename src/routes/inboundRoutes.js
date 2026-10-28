const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const c = require('../controllers/inboundController');

// Public lead capture — keep bots from flooding a company's CRM.
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

router.get('/form/:key', c.formInfo);
router.post('/leads/:key', limiter, c.submitLead);
router.post('/google-ads/:key', c.googleAds);

module.exports = router;
