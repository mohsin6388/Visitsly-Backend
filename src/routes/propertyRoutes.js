const express = require("express");
const router = express.Router();

const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const can = require("../middlewares/can");
const validate = require("../middlewares/validate");
const { uploadCsv, uploadBrochure } = require("../middlewares/upload");

const {
  previewImport,
  confirmImport,
  uploadBrochureAndImages,
  extractBrochureForReview,
  confirmBrochureProperty,
  createProperty,
  listProperties,
  getProperty,
  updateProperty,
  deleteProperty,
  bulkDeleteProperties,
  exportProperties,
} = require("../controllers/propertyController");

const {
  createPropertySchema,
  updatePropertySchema,
  listPropertiesQuerySchema,
  idParamSchema,
  bulkDeleteSchema,
  importConfirmSchema,
} = require("../validators/propertyValidators");

const { confirmBrochureSchema } = require("../services/brochureValidation");
const { requireFeature } = require("../services/saas/subscription");

router.use(authenticate);
// Agents: the Properties page (view) and the property picker in chats are read-only.
// Adding, editing, importing, exporting and deleting inventory is Owner-only.
const ownerOnly = roleGuard.org("owner");
const propertyRead = can.any("properties", "chatReply");

// Inventory Management (Builder Pro+): bulk import / export / bulk delete.
// Adding and editing single properties stays on every plan — the AI agent
// needs them to answer buyers.
const inventoryFeature = requireFeature("inventory");

router.post(
  "/brochure",
  ownerOnly,
  uploadBrochure.fields([
    {
      name: "brochure",
      maxCount: 1,
    },
    {
      name: "images",
      maxCount: 10,
    },
  ]),
  uploadBrochureAndImages,
);

// Review flow: extract first (nothing is saved), then confirm the edited details.
router.post(
  "/brochure/extract",
  ownerOnly,
  uploadBrochure.fields([
    { name: "brochure", maxCount: 1 },
    { name: "images", maxCount: 10 },
  ]),
  extractBrochureForReview,
);
router.post("/brochure/confirm", ownerOnly, validate(confirmBrochureSchema), confirmBrochureProperty);

// IMPORTANT: specific/static paths (import/*, export, bulk-delete) must be
// registered BEFORE the generic "/:id" route below, otherwise Express would
// match e.g. GET /export against the "/:id" handler with id="export".

// Write access: builders and admins only.
router.post(
  "/import/preview",
  ownerOnly,
  inventoryFeature,
  uploadCsv.single("file"),
  previewImport,
);
router.post(
  "/import/confirm",
  ownerOnly,
  inventoryFeature,
  validate(importConfirmSchema),
  confirmImport,
);
router.get("/export", ownerOnly, roleGuard("builder", "admin"), inventoryFeature, exportProperties);
router.post(
  "/bulk-delete",
  ownerOnly,
  inventoryFeature,
  validate(bulkDeleteSchema),
  bulkDeleteProperties,
);
router.post(
  "/",
  ownerOnly,
  validate(createPropertySchema),
  createProperty,
);

// Read access: builders (own inventory), admins (any), AND brokers (read-only,
// active listings only) — brokers need this to browse/match properties for leads.
router.get(
  "/",
  propertyRead,
  validate(listPropertiesQuerySchema),
  listProperties,
);
router.get(
  "/:id",
  propertyRead,
  validate(idParamSchema),
  getProperty,
);

router.patch(
  "/:id",
  ownerOnly,
  validate(updatePropertySchema),
  updateProperty,
);
router.delete(
  "/:id",
  ownerOnly,
  validate(idParamSchema),
  deleteProperty,
);

module.exports = router;
