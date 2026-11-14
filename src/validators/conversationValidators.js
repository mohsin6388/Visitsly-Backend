const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const isoDate = z.string().max(40).optional();

const FILTERS = ['unread', 'needs_reply', 'manual', 'direct', 'campaign', 'hot', 'warm', 'cold', 'site_visit', 'closed', 'lost'];

const listConversationsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    filter: z.enum(FILTERS).optional().or(z.literal('').transform(() => undefined)),
    search: z.string().max(120).optional(),
    before: isoDate,
    leadId: objectId.optional(),
    ownerId: objectId.optional(),
  }),
});

const getConversationSchema = z.object({
  params: z.object({ id: objectId }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).default(40),
    before: isoDate,
    page: z.coerce.number().int().min(1).optional(),
    ownerId: objectId.optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: objectId }),
  query: z.object({ ownerId: objectId.optional() }).optional(),
});

const mediaParamSchema = z.object({
  params: z.object({ id: objectId, messageId: objectId }),
  query: z.object({ download: z.string().optional(), ownerId: objectId.optional() }).optional(),
});

const sendManualReplySchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ text: z.string().trim().min(1, 'Message likhein').max(4096, 'Message bahut lamba hai (4096 characters tak)') }),
});

const propertyMediaSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ propertyId: objectId, kind: z.enum(['brochure', 'photos']) }),
});

module.exports = {
  listConversationsSchema,
  getConversationSchema,
  idParamSchema,
  mediaParamSchema,
  sendManualReplySchema,
  propertyMediaSchema,
};
