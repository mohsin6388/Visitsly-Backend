const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const can = require('../middlewares/can');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');
const { uploadCsv } = require('../middlewares/upload');

const {
  previewImport,
  previewText,
  confirmImport,
  startConversations,
  createLead,
  listLeads,
  listImportFiles,
  getLead,
  updateLead,
  deleteLead,
  bulkDeleteLeads,
  updateTags,
  exportLeads,
} = require('../controllers/leadController');

const {
  createLeadSchema,
  updateLeadSchema,
  listLeadsQuerySchema,
  idParamSchema,
  bulkDeleteSchema,
  tagsUpdateSchema,
  importConfirmSchema,
  parseTextSchema,
  startConversationsSchema,
} = require('../validators/leadValidators');

// Leads are owned by brokers; admins can view/manage across brokers via ?ownerId=.
// Builders don't touch this resource directly.
router.use(authenticate, roleGuard('broker', 'admin'));
// Reading leads is allowed for an agent who has any page that shows leads (Leads, WhatsApp leads, Inbox, Site visits, Follow-ups, Dashboard).
const LEAD_READ = ['leads', 'whatsappLeads', 'inbox', 'siteVisits', 'followUps', 'dashboard'];

router.post('/import/preview', can('leadImport'), uploadCsv.single('file'), previewImport);
router.post('/import/parse-text', can('leadImport'), validate(parseTextSchema), previewText);
router.post('/import/confirm', can('leadImport'), validate(importConfirmSchema), confirmImport);
router.post('/start-conversations', can('chatReply'), validate(startConversationsSchema), startConversations);

router.get('/export', roleGuard.org('owner'), exportLeads); // SaaS: agents can't export the database
router.get('/import-files', can.any('leads', 'whatsappLeads'), listImportFiles);
router.post('/bulk-delete', can('leadDelete'), validate(bulkDeleteSchema), bulkDeleteLeads);

router.get('/', can.any(...LEAD_READ), validate(listLeadsQuerySchema), listLeads);
router.post('/', can('leadCreate'), validate(createLeadSchema), createLead);
router.get('/:id', can.any(...LEAD_READ), validate(idParamSchema), getLead);
router.patch('/:id', can('leadEdit'), validate(updateLeadSchema), updateLead);
router.delete('/:id', can('leadDelete'), validate(idParamSchema), deleteLead);
router.post('/:id/tags', can('leadEdit'), validate(tagsUpdateSchema), updateTags);

module.exports = router;
