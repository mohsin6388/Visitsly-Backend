const express = require('express');
const router = express.Router();
const { z } = require('zod');

const authenticate = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { uploadBrochure } = require('../middlewares/upload');
const { listSites, uploadSiteBrochure, updateSite, removeBrochure, removeImage } = require('../controllers/siteController');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const updateSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    name: z.string().trim().min(1).max(150).optional(),
    city: z.string().trim().max(100).optional(),
    location: z.string().trim().max(150).optional(),
    description: z.string().trim().max(4000).optional(),
    mapsLink: z.string().trim().max(500).optional(),
  }),
});
const brochureParams = z.object({ params: z.object({ id: objectId, brochureId: objectId }) });
const imageSchema = z.object({ params: z.object({ id: objectId }), body: z.object({ url: z.string().url() }) });

const { requireFeature } = require('../services/saas/subscription');

// Multi-Project Bot (Builder Pro+): project sites with brochures, maps and
// photos the AI answers from. Listing stays open (upgrade prompt in the UI).
const multiProject = requireFeature('multiProjectBot');

router.use(authenticate);
// Agents can only read sites (Properties page, chat property picker); changes are Owner-only.
const ownerOnly = require('../middlewares/roleGuard').org('owner');
const can = require('../middlewares/can');

router.get('/', can.any('properties', 'chatReply'), listSites);
router.post('/brochure', ownerOnly, multiProject, uploadBrochure.fields([{ name: 'brochure', maxCount: 1 }, { name: 'images', maxCount: 10 }]), uploadSiteBrochure);
router.patch('/:id', ownerOnly, multiProject, validate(updateSchema), updateSite);
// Deleting stays allowed so a downgraded company can still clean up.
router.delete('/:id/brochures/:brochureId', ownerOnly, validate(brochureParams), removeBrochure);
router.delete('/:id/images', ownerOnly, validate(imageSchema), removeImage);

module.exports = router;
