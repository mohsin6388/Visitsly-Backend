const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const can = require('../middlewares/can');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');

const { listFollowUps, updateFollowUp, deleteFollowUp, sendFollowUp, createForLead } = require('../controllers/followUpController');
const { listFollowUpsSchema, updateFollowUpSchema, idParamSchema } = require('../validators/followUpValidators');

router.use(authenticate, roleGuard('broker', 'admin'));

router.get('/', can.any('followUps', 'dashboard'), validate(listFollowUpsSchema), listFollowUps);
router.patch('/:id', can('followUps'), validate(updateFollowUpSchema), updateFollowUp);
router.post('/:id/send', can('followUps', 'chatReply'), validate(idParamSchema), sendFollowUp);
router.post('/lead/:id', can('followUps'), validate(idParamSchema), createForLead);
router.delete('/:id', can('followUps'), validate(idParamSchema), deleteFollowUp);

module.exports = router;
