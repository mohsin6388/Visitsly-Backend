const express = require('express');
const router = express.Router();

router.use('/auth', require('./authRoutes'));
router.use('/uploads', require('./uploadRoutes'));
router.use('/email', require('./emailRoutes'));
router.use('/webhooks', require('./webhookRoutes'));
router.use('/leads', require('./leadRoutes'));
router.use('/audiences', require('./audienceRoutes'));
router.use('/campaigns', require('./campaignRoutes'));
router.use('/outreach', require('./outreachRoutes'));
router.use('/properties', require('./propertyRoutes'));
router.use('/sites', require('./siteRoutes'));
router.use('/whatsapp', require('./whatsappRoutes'));
router.use('/conversations', require('./conversationRoutes'));
router.use('/meetings', require('./meetingRoutes'));
router.use('/followups', require('./followupRoutes'));
router.use('/settings', require('./settingsRoutes'));
router.use('/analytics', require('./analyticsRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/audit-logs', require('./auditLogRoutes'));

// ---- SaaS ----
router.use('/org', require('./orgRoutes'));
router.use('/billing', require('./billingRoutes'));
router.use('/admin-auth', require('./adminAuthRoutes'));
router.use('/inbound', require('./inboundRoutes'));
router.use('/reports', require('./reportsRoutes'));
router.use('/quotes', require('./quoteRoutes'));
router.use('/cp', require('./cpRoutes'));
router.use('/voice', require('./voiceRoutes'));
router.use('/platform', require('./platformRoutes'));
router.get('/public/plans', require('../controllers/billingController').listPlans);
router.get('/public/branding', require('../controllers/billingController').branding);

router.get('/health', (req, res) => res.json({ success: true, message: 'API is healthy' }));

module.exports = router;
