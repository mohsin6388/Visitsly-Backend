const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');

const { listFollowUps, updateFollowUp, deleteFollowUp, sendFollowUp, createForLead } = require('../controllers/followUpController');
const { listFollowUpsSchema, updateFollowUpSchema, idParamSchema } = require('../validators/followUpValidators');

router.use(authenticate, roleGuard('broker', 'admin'));

router.get('/', validate(listFollowUpsSchema), listFollowUps);
router.patch('/:id', validate(updateFollowUpSchema), updateFollowUp);
router.post('/:id/send', validate(idParamSchema), sendFollowUp);
router.post('/lead/:id', validate(idParamSchema), createForLead);
router.delete('/:id', validate(idParamSchema), deleteFollowUp);

module.exports = router;
