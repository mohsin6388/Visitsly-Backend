const express = require('express');
const multer = require('multer');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');
const ApiError = require('../utils/ApiError');
const c = require('../controllers/conversationController');
const v = require('../validators/conversationValidators');

// Chat attachments: up to 100 MB (WhatsApp's document limit); per-type limits
// (5 MB photo, 16 MB video) are checked in the media service.
const uploadChatFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const blocked = /\.(exe|bat|cmd|sh|js|msi|apk|dll|scr)$/i.test(file.originalname || '');
    if (blocked) return cb(ApiError.badRequest('Ye file type WhatsApp par nahi bhej sakte'));
    cb(null, true);
  },
});

// Conversations belong to brokers; admins can inspect via ?ownerId=.
router.use(authenticate, roleGuard('broker', 'admin'));

router.get('/', validate(v.listConversationsSchema), c.listConversations);
router.get('/counts', c.filterCounts);
router.get('/:id', validate(v.getConversationSchema), c.getConversation);
router.get('/:id/media/:messageId', validate(v.mediaParamSchema), c.getMedia);
router.post('/:id/messages', validate(v.sendManualReplySchema), c.sendManualReply);
router.post('/:id/media', validate(v.idParamSchema), uploadChatFile.single('file'), c.sendMediaReply);
router.post('/:id/property-media', validate(v.propertyMediaSchema), c.sendPropertyMedia);
router.post('/:id/takeover', validate(v.idParamSchema), c.takeOverChat);
router.post('/:id/resume-ai', validate(v.idParamSchema), c.resumeAI);
router.post('/:id/read', validate(v.idParamSchema), c.markRead);
router.post('/:id/close', validate(v.idParamSchema), c.closeConversation);
router.post('/:id/reopen', validate(v.idParamSchema), c.reopenConversation);

module.exports = router;
