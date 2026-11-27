const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const can = require('../middlewares/can');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');

const {
  getDashboardSummary,
  getTimeseries,
  getFunnel,
  getLeadSources,
  getPropertyPerformance,
} = require('../controllers/analyticsController');

const { dashboardQuerySchema, rangeQuerySchema } = require('../validators/analyticsValidators');
const { getMetaBilling } = require('../controllers/metaBillingController');
const { z } = require('zod');

const metaBillingSchema = z.object({
  query: z.object({
    range: z.enum(['this_month', 'last_month', '30d', '7d']).optional(),
    ownerId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  }),
});

// Admins, brokers and builders all have a dashboard; scoping happens inside the controller.
router.use(authenticate, roleGuard('admin', 'broker', 'builder'));

router.get('/dashboard', can('dashboard'), validate(dashboardQuerySchema), getDashboardSummary);
router.get('/timeseries', can('dashboard'), validate(rangeQuerySchema), getTimeseries);
router.get('/funnel', can('dashboard'), validate(dashboardQuerySchema), getFunnel);
router.get('/lead-sources', roleGuard.org('owner'), validate(dashboardQuerySchema), getLeadSources);
router.get('/source-performance', roleGuard.org('owner'), require('../controllers/analyticsController').getSourcePerformance);
router.get('/meta-billing', roleGuard.org('owner'), roleGuard('admin', 'broker'), validate(metaBillingSchema), getMetaBilling);
router.get('/property-performance', roleGuard.org('owner'), validate(dashboardQuerySchema), getPropertyPerformance);

module.exports = router;
