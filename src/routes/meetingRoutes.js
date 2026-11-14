const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');

const { listMeetings, createMeeting, updateMeeting, deleteMeeting, sendConfirmation, callConfirmation, confirmationStats, markConfirmation } = require('../controllers/meetingController');
const { listMeetingsSchema, createMeetingSchema, updateMeetingSchema, idParamSchema } = require('../validators/meetingValidators');

router.use(authenticate, roleGuard('broker', 'admin'));

router.get('/', validate(listMeetingsSchema), listMeetings);
router.get('/confirmation-stats', confirmationStats);
router.post('/', validate(createMeetingSchema), createMeeting);
router.patch('/:id', validate(updateMeetingSchema), updateMeeting);
router.post('/:id/send-confirmation', validate(idParamSchema), sendConfirmation);
router.post('/:id/call-confirmation', validate(idParamSchema), callConfirmation);
router.post('/:id/mark-confirmation', validate(idParamSchema), markConfirmation);
router.delete('/:id', validate(idParamSchema), deleteMeeting);

module.exports = router;
