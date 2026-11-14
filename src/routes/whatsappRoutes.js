const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const verifyMetaSignature = require('../middlewares/verifyMetaSignature');

// Test sends are an external side effect. Keep the feature useful for setup
// while limiting accidental/repeated sends per company workspace.
const testMessageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.org?._id || req.user?.actorId || 'authenticated'),
  message: { success: false, message: 'Too many test messages. Try again in 15 minutes.' },
});

const {
  verifyWebhook,
  receiveWebhook,
  receiveForwardedWebhook,
  sendTest,
  sendTestTemplate,
  getStatus,
  diagnostics,
  repairSubscription,
  disconnect,
  reconnect,
  listApprovedTemplates,
  listAllTemplates,
  createTemplate,
  deleteTemplate,
} = require('../controllers/whatsappController');

// Public — these are the URLs registered in the Meta App Dashboard under
// WhatsApp -> Configuration -> Webhook, e.g.
//   https://your-domain.com/api/whatsapp/webhook
// No auth middleware: Meta calls these directly and can't send our
// JWT/cookies. GET is the one-time verify handshake; POST is every real
// event delivery afterwards (both checked/secured on Meta's side via the
// verify token + optional X-Hub-Signature-256 app-secret check).
router.get('/webhook', verifyWebhook);
router.post('/webhook', verifyMetaSignature, receiveWebhook);
router.post('/webhook/forward', receiveForwardedWebhook);

router.get('/status', authenticate, roleGuard('broker', 'admin'), getStatus);
router.get('/templates', authenticate, roleGuard('broker', 'admin'), listApprovedTemplates);
router.get('/templates/all', authenticate, roleGuard('broker', 'admin'), listAllTemplates);
router.post('/templates', authenticate, roleGuard('broker', 'admin'), roleGuard.org('owner', 'manager'), createTemplate);
router.delete('/templates/:name', authenticate, roleGuard('broker', 'admin'), roleGuard.org('owner', 'manager'), deleteTemplate);
router.get('/diagnostics', authenticate, roleGuard('broker', 'admin'), diagnostics);
router.post('/repair-subscription', authenticate, roleGuard('broker'), roleGuard.org('owner', 'manager'), repairSubscription);
router.post('/send-test', authenticate, roleGuard('broker'), testMessageLimiter, sendTest);
router.post('/send-test-template', authenticate, roleGuard('broker'), testMessageLimiter, sendTestTemplate);
router.post('/disconnect', authenticate, roleGuard('broker', 'builder'), disconnect);
router.post('/reconnect', authenticate, roleGuard('broker', 'builder'), reconnect);

module.exports = router;
