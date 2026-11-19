const express = require("express");
const router = express.Router();
const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const c = require("../controllers/emailController");
const templates = require("../controllers/emailTemplateController");

const { requireFeature } = require("../services/saas/subscription");

router.use(authenticate, roleGuard("broker", "admin"));

// Email sending is a paid feature (not on the free trial / Starter): reads stay
// open so the page can show an upgrade prompt, writes are blocked.
const emailFeature = requireFeature("emailCampaigns");

// Client ka apna official email (sirf owner/manager badal sakte hain)
router.get("/account", c.getAccount);
router.put("/account", roleGuard.org("owner", "manager"), emailFeature, c.saveAccount);
router.post("/account/test", roleGuard.org("owner", "manager"), emailFeature, c.testAccount);
router.delete("/account", roleGuard.org("owner", "manager"), c.removeAccount);

// Templates
router.get("/templates", templates.list);
router.post("/templates", emailFeature, templates.create);
router.put("/templates/:id", emailFeature, templates.update);
router.delete("/templates/:id", templates.remove);

// Delivery details (sent / failed / din ke hisaab se)
router.get("/details", c.details);

module.exports = router;
