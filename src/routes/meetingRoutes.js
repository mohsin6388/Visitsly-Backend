const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const can = require('../middlewares/can');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');

const { listMeetings, createMeeting, updateMeeting, deleteMeeting, sendConfirmation, callConfirmation, confirmationStats, confirmationCalls, markConfirmation } = require('../controllers/meetingController');
const { listMeetingsSchema, createMeetingSchema, updateMeetingSchema, idParamSchema } = require('../validators/meetingValidators');

router.use(authenticate, roleGuard('broker', 'admin'));

router.get('/', can.any('siteVisits', 'dashboard', 'inbox', 'leads', 'whatsappLeads'), validate(listMeetingsSchema), listMeetings);
router.get('/confirmation-stats', roleGuard.org('owner'), confirmationStats);
router.get('/confirmation-calls', roleGuard.org('owner'), confirmationCalls);
router.post('/', can('siteVisits'), validate(createMeetingSchema), createMeeting);
router.patch('/:id', can('siteVisits'), validate(updateMeetingSchema), updateMeeting);
router.post('/:id/send-confirmation', can('siteVisits', 'chatReply'), validate(idParamSchema), sendConfirmation);
router.post('/:id/call-confirmation', roleGuard.org('owner'), validate(idParamSchema), callConfirmation);
router.post('/:id/mark-confirmation', can('siteVisits'), validate(idParamSchema), markConfirmation);
router.delete('/:id', can('siteVisits'), validate(idParamSchema), deleteMeeting);

module.exports = router;
