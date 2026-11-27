const express = require('express');
const router = express.Router();
const adminAuth = require('../middlewares/adminAuth');
const validate = require('../middlewares/validate');
const c = require('../controllers/platformController');
const v = require('../validators/saasValidators');

// PropAI staff only — separate admin panel token required.
router.use(adminAuth);

router.get('/stats', c.stats);
router.get('/orgs', validate(v.orgListSchema), c.listOrgs);
router.get('/orgs/:id', c.getOrgDetail);
router.patch('/orgs/:id', validate(v.platformUpdateSchema), c.updateOrg);
router.get('/orgs/:id/email', c.emailOverview);
router.post('/orgs/:id/email-credit', c.emailCredit);
router.post('/orgs/:id/email-unpause', c.emailUnpause);
router.post('/orgs/:id/payments', validate(v.offlinePaymentSchema), c.recordPayment);
router.post('/orgs/:id/support-session', c.supportSession);
router.get('/payments', c.listPayments);
router.get('/payments/:id/pdf', c.paymentPdf);
router.get('/admins', c.listAdmins);
router.post('/admins', validate(v.adminCreateSchema), c.createAdmin);
router.patch('/admins/:id', validate(v.adminUpdateSchema), c.updateAdmin);
router.get('/requests', c.listRequests);
router.patch('/requests/:id', validate(v.requestUpdateSchema), c.updateRequest);
router.get('/activity', c.activity);
router.get('/revenue', c.revenue);

// Coupons + plan offers (audit-logged in the controller).
router.get('/coupons', c.listCoupons);
router.post('/coupons', validate(v.couponCreateSchema), c.createCoupon);
router.patch('/coupons/:id', validate(v.couponUpdateSchema), c.updateCoupon);
router.post('/coupons/:id/disable', c.disableCoupon);
router.get('/coupons/:id/redemptions', c.couponRedemptions);
router.get('/plan-offers', c.listPlanOffers);
router.put('/plan-offers', validate(v.planOfferSetSchema), c.setPlanOffer);
router.delete('/plan-offers/:id', c.clearPlanOffer);

module.exports = router;
