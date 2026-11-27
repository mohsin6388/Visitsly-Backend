const express = require("express");
const router = express.Router();
const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const c = require("../controllers/emailController");
const templates = require("../controllers/emailTemplateController");

const { requireFeature } = require("../services/saas/subscription");

router.use(authenticate, roleGuard("broker", "admin"), roleGuard.org("owner")); // agents have no email access

// Email sending is a paid feature (not on the free trial / Starter): reads stay
// open so the page can show an upgrade prompt, writes are blocked.
const emailFeature = requireFeature("emailCampaigns");

// Sender setup: official email → OTP → domain authentication. Owner-only (router guard above).
const { emailSetupLimiter } = require("../middlewares/rateLimit");
router.get("/status", c.status);
router.post("/sender", emailSetupLimiter, emailFeature, c.startSender);
router.post("/sender/verify", emailSetupLimiter, emailFeature, c.verifySender);
router.post("/sender/resend", emailSetupLimiter, emailFeature, c.resendSender);
router.post("/sender/check-dns", emailSetupLimiter, emailFeature, c.checkDns);
router.delete("/sender", emailSetupLimiter, c.removeSender);

// Per-email wallet
router.get("/wallet", c.getWallet);
router.get("/estimate", c.estimate);

// Templates
router.get("/templates", templates.list);
router.post("/templates", emailFeature, templates.create);
router.put("/templates/:id", emailFeature, templates.update);
router.delete("/templates/:id", templates.remove);

// Delivery details (sent / failed / din ke hisaab se)
router.get("/details", c.details);

module.exports = router;
