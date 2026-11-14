const express = require("express");
const router = express.Router();
const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const c = require("../controllers/emailController");
const templates = require("../controllers/emailTemplateController");

router.use(authenticate, roleGuard("broker", "admin"));

// Client ka apna official email (sirf owner/manager badal sakte hain)
router.get("/account", c.getAccount);
router.put("/account", roleGuard.org("owner", "manager"), c.saveAccount);
router.post("/account/test", roleGuard.org("owner", "manager"), c.testAccount);
router.delete("/account", roleGuard.org("owner", "manager"), c.removeAccount);

// Templates
router.get("/templates", templates.list);
router.post("/templates", templates.create);
router.put("/templates/:id", templates.update);
router.delete("/templates/:id", templates.remove);

// Delivery details (sent / failed / din ke hisaab se)
router.get("/details", c.details);

module.exports = router;
