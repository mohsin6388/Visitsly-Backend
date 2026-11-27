const express = require("express");
const router = express.Router();
const brevoWebhook = require("../controllers/brevoWebhookController");

// Public provider callback; protected by the configured secret header in Brevo.
router.post("/brevo", brevoWebhook.handler);
// One-click unsubscribe link in bulk emails (public; HMAC-signed token).
router.get("/email-unsubscribe/:token", require("../controllers/emailController").unsubscribe);
router.post("/email-unsubscribe/:token", require("../controllers/emailController").unsubscribe);
// Razorpay subscription events (HMAC-verified with RAZORPAY_WEBHOOK_SECRET).
router.post("/razorpay", require("../controllers/billingController").razorpayWebhook);
// Meta Lead Ads (Facebook / Instagram forms) — Page webhook, field "leadgen".
const inbound = require("../controllers/inboundController");
router.get("/meta-leads", inbound.metaLeadsVerify);
router.post("/meta-leads", require("../middlewares/verifyMetaSignature"), inbound.metaLeadsReceive);
// AI calling (Plivo): call events + ElevenLabs audio clips played on the call.
const voiceController = require("../controllers/voiceController");
router.post("/voice/plivo/:event/:callId", voiceController.plivoWebhook);
router.get("/voice/plivo/:event/:callId", voiceController.plivoWebhook);
router.get("/voice/audio/:file", voiceController.audio);
module.exports = router;
