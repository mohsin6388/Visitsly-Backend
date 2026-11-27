const express = require('express');
const multer = require('multer');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const can = require('../middlewares/can');
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
    if (blocked) return cb(ApiError.badRequest('This file type can’t be sent on WhatsApp'));
    cb(null, true);
  },
});

// Conversations belong to brokers; admins can inspect via ?ownerId=.
router.use(authenticate, roleGuard('broker', 'admin'));
// Chats are shown on the Inbox and on the WhatsApp leads page.
const CHAT_READ = ['inbox', 'whatsappLeads'];

router.get('/', can.any(...CHAT_READ), validate(v.listConversationsSchema), c.listConversations);
router.get('/counts', can.any(...CHAT_READ), c.filterCounts);
router.get('/:id', can.any(...CHAT_READ), validate(v.getConversationSchema), c.getConversation);
router.get('/:id/media/:messageId', can.any(...CHAT_READ), validate(v.mediaParamSchema), c.getMedia);
router.post('/:id/messages', can('chatReply'), validate(v.sendManualReplySchema), c.sendManualReply);
router.post('/:id/media', can('chatReply'), validate(v.idParamSchema), uploadChatFile.single('file'), c.sendMediaReply);
router.post('/:id/property-media', can('chatReply'), validate(v.propertyMediaSchema), c.sendPropertyMedia);
router.patch('/:id/language', can('chatReply'), validate(v.setLanguageSchema), c.setConversationLanguage);
router.post('/:id/takeover', can('chatReply'), validate(v.idParamSchema), c.takeOverChat);
router.post('/:id/resume-ai', can('chatReply'), validate(v.idParamSchema), c.resumeAI);
router.post('/:id/read', can.any(...CHAT_READ), validate(v.idParamSchema), c.markRead);
router.post('/:id/close', can('chatReply'), validate(v.idParamSchema), c.closeConversation);
router.post('/:id/reopen', can('chatReply'), validate(v.idParamSchema), c.reopenConversation);

module.exports = router;
