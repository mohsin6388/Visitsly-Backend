const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');

const { getSettings, updateSettings, pauseAI, resumeAI, sendDailyReportNow, sendTestAlert, improveAssistantPrompt } = require('../controllers/settingsController');
const { updateSettingsSchema, improvePromptSchema } = require('../validators/settingsValidators');

// Settings belong to the org — builders and brokers each manage their own; admin is org-less (skips this module).
router.use(authenticate, roleGuard('broker', 'builder'), roleGuard.orgWrite('owner')); // SaaS: agents can read but not change settings

router.get('/', getSettings);
router.patch('/', validate(updateSettingsSchema), updateSettings);
router.post('/ai/pause', pauseAI);
router.post('/ai/resume', resumeAI);
router.post('/daily-report/send-now', sendDailyReportNow);
router.post('/test-alert', sendTestAlert);
router.post('/assistant/improve', validate(improvePromptSchema), improveAssistantPrompt);

module.exports = router;
