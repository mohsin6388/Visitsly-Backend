const express = require('express');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');
const c = require('../controllers/orgController');
const v = require('../validators/saasValidators');
const g = require('../controllers/growthController');
const cp = require('../controllers/cpController');
const { z } = require('zod');

const oid = z.string().regex(/^[a-f\d]{24}$/i);
const s = {
  sources: z.object({ body: z.object({ autoWhatsapp: z.boolean().optional(), regenerateKey: z.boolean().optional() }) }),
  metaPages: z.object({ body: z.object({ userAccessToken: z.string().min(20) }) }),
  metaConnect: z.object({ body: z.object({ pageId: z.string().regex(/^\d+$/), pageToken: z.string().min(20).optional(), pageName: z.string().max(150).optional() }) }),
  routing: z.object({ body: z.object({ mode: z.enum(['off', 'round_robin']).optional(), agentIds: z.array(oid).max(200).optional(), agentsSeeOnlyAssigned: z.boolean().optional() }) }),
  assign: z.object({ body: z.object({ leadIds: z.array(oid).min(1).max(5000), userId: oid.nullable() }) }),
  weekly: z.object({ body: z.object({ enabled: z.boolean().optional(), phone: z.string().max(20).nullable().optional() }) }),
  number: z.object({ body: z.object({ label: z.string().max(40).optional(), accessToken: z.string().min(20).optional(), phoneNumberId: z.string().regex(/^\d+$/), businessAccountId: z.string().regex(/^\d+$/).optional() }) }),
  cpSettings: z.object({ body: z.object({ enabled: z.boolean().optional(), defaultCommissionPct: z.number().min(0).max(20).optional(), leadProtectionDays: z.number().int().min(7).max(365).optional(), autoApprove: z.boolean().optional() }) }),
  cpUpdate: z.object({ params: z.object({ id: oid }), body: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional(), commissionPct: z.number().min(0).max(20).nullable().optional() }) }),
  deal: z.object({ params: z.object({ leadId: oid }), body: z.object({ dealValue: z.number().min(0).max(1e11).optional(), bookedAt: z.string().optional(), undo: z.boolean().optional() }) }),
};

router.use(authenticate);

const managers = roleGuard.org('owner', 'manager');

router.get('/', c.getOrg);
router.patch('/', managers, validate(v.updateOrgSchema), c.updateOrg);
router.patch('/onboarding', validate(v.onboardingSchema), c.updateOnboarding);

router.get('/whatsapp', c.getWhatsapp);
router.post('/whatsapp/embedded-signup', managers, validate(v.embeddedSignupSchema), c.connectEmbedded); // backward-compatible legacy flow
router.post('/whatsapp/embedded-signup/prepare', managers, validate(v.embeddedSignupPrepareSchema), c.prepareEmbeddedSignup);
router.post('/whatsapp/embedded-signup/complete', managers, validate(v.embeddedSignupCompleteSchema), c.completeEmbeddedSignup);
router.post('/whatsapp/manual', managers, validate(v.manualConnectSchema), c.connectManual);
router.post('/whatsapp/disconnect', managers, c.disconnectWhatsapp);
router.patch('/whatsapp/opening-template', managers, validate(v.openingTemplateSchema), c.updateOpeningTemplate);

router.post('/whatsapp/numbers', managers, validate(s.number), c.addNumber);
router.delete('/whatsapp/numbers/:phoneNumberId', managers, c.removeNumber);

// Lead sources (website form, hosted form, portals, Google Ads, Meta Lead Ads)
router.get('/lead-sources', managers, g.getLeadSources);
router.patch('/lead-sources', managers, validate(s.sources), g.updateLeadSources);
router.post('/lead-sources/meta/pages', managers, validate(s.metaPages), g.metaPages);
router.post('/lead-sources/meta/connect', managers, validate(s.metaConnect), g.metaConnect);
router.post('/lead-sources/meta/disconnect', managers, g.metaDisconnect);

// Lead routing
router.get('/routing', managers, g.getRouting);
router.patch('/routing', managers, validate(s.routing), g.updateRouting);
router.post('/routing/assign', managers, validate(s.assign), g.assignLeads);
router.post('/routing/distribute', managers, g.distributeUnassigned);

router.patch('/weekly-report', managers, validate(s.weekly), g.updateWeeklyReport);

// Channel partners (builders)
router.get('/channel-partners', managers, cp.listPartners);
router.patch('/channel-partners/settings', managers, validate(s.cpSettings), cp.updateSettings);
router.patch('/channel-partners/:id', managers, validate(s.cpUpdate), cp.updatePartner);
router.post('/deals/:leadId', managers, validate(s.deal), cp.markBooked);

// Requests to PropAI (add-ons, Enterprise, white-label, AI calling)
router.get('/requests', managers, g.listMyRequests);
router.post('/requests', managers, validate(v.customerRequestSchema), g.createRequest);

router.get('/team', managers, c.listTeam);
router.post('/team', managers, validate(v.inviteSchema), c.inviteMember);
router.patch('/team/:id', managers, validate(v.updateMemberSchema), c.updateMember);
router.post('/team/:id/reset-password', managers, validate(v.memberIdSchema), c.resetMemberPassword);

module.exports = router;
