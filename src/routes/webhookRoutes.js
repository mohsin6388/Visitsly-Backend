const express = require("express");
const router = express.Router();
const brevoWebhook = require("../controllers/brevoWebhookController");

// Public provider callback; protected by the configured secret header in Brevo.
router.post("/brevo", brevoWebhook.handler);
// Razorpay subscription events (HMAC-verified with RAZORPAY_WEBHOOK_SECRET).
router.post("/razorpay", require("../controllers/billingController").razorpayWebhook);
// Meta Lead Ads (Facebook / Instagram forms) — Page webhook, field "leadgen".
const inbound = require("../controllers/inboundController");
router.get("/meta-leads", inbound.metaLeadsVerify);
router.post("/meta-leads", require("../middlewares/verifyMetaSignature"), inbound.metaLeadsReceive);
// Voice-AI call results (Bolna execution webhook).
router.post("/voice/:key", require("../controllers/voiceController").webhook);
module.exports = router;
