const { z } = require('zod');
const Lead = require('../models/Lead');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const leadFieldsSchema = z.object({
    name: z.string().trim().max(150).optional().or(z.literal('')), 
    phone: z.string().max(30).optional().or(z.literal('')),
    email: z.string().email().optional().or(z.literal('')),
    city: z.string().max(100).optional(),
    location: z.string().max(150).optional(),
    address: z.string().max(300).optional(),
    jobTitle: z.string().max(120).optional(),
    budgetMin: z.number().nonnegative().nullable().optional(),
    budgetMax: z.number().nonnegative().nullable().optional(),
    occupation: z.string().max(100).optional(),
    age: z.number().int().min(0).max(120).nullable().optional(),
    source: z.string().max(50).optional(),
    notes: z.string().max(2000).optional(),
    requirements: z.string().max(2000).optional(),
    tags: z.array(z.string().max(40)).optional(),
    status: z.enum(Lead.STATUSES).optional(),
});

const createLeadSchema = z.object({
  body: leadFieldsSchema.refine(
    (b) => Boolean(String(b.phone || '').trim() || String(b.email || '').trim()),
    { message: 'Phone or email is required' },
  ),
});

const updateLeadSchema = z.object({
  params: z.object({ id: objectId }),
  body: leadFieldsSchema.partial(),
});

const listLeadsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(20),
    search: z.string().optional(),
    status: z.enum(Lead.STATUSES).optional(),
    city: z.string().optional(),
    tag: z.string().optional(),
    source: z.string().max(60).optional(),
    assignedTo: z.string().max(30).optional(), // me | none | <userId>
    channel: z.enum(['whatsapp', 'email']).optional(),
    delivery: z.enum(['sent', 'unsent']).optional(),
    qualifiedOnly: z.enum(['0', '1', 'true', 'false']).optional(),
    // Qualified Leads tabs: all (score > 30), hot (score > 60), visit (site visit booked)
    stage: z.enum(['all', 'hot', 'visit']).optional(),
    // WhatsApp → Leads / Email → Leads: only leads that replied on that channel
    replyChannel: z.enum(['whatsapp', 'email']).optional(),
    ids: z.string().max(60000).optional(),
    // Contacts sheet in bulk messaging: filter by uploaded sheet, and ask for
    // just the ordered ids so "Sr. no. 1 to 200" can be selected across pages.
    file: z.string().max(200).optional(),
    idsOnly: z.enum(['0', '1', 'true', 'false']).optional(),
    sortBy: z.enum(['createdAt', 'updatedAt', 'name', 'leadScore']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});

const bulkDeleteSchema = z.object({
  body: z.object({
    ids: z.array(objectId).min(1, 'At least one id is required'),
  }),
});

const tagsUpdateSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    add: z.array(z.string().max(40)).optional(),
    remove: z.array(z.string().max(40)).optional(),
  }),
});

// Rows coming back from the client after they reviewed the /import/preview response.
const importRowSchema = z.object({
  name: z.string().optional().default(''),
  phone: z.string().optional().default(''),
  email: z.string().optional().default(''),
  city: z.string().optional().default(''),
  location: z.string().optional().default(''),
  address: z.string().max(300).optional().default(''),
  jobTitle: z.string().max(120).optional().default(''),
  importFile: z.string().max(200).optional().default(''),
  budgetMin: z.number().nullable().optional(),
  budgetMax: z.number().nullable().optional(),
  occupation: z.string().optional().default(''),
  age: z.number().nullable().optional(),
  source: z.string().optional().default('csv_import'),
  notes: z.string().optional().default(''),
  requirements: z.string().optional().default(''),
}).refine((r) => Boolean(String(r.phone || '').trim() || String(r.email || '').trim()), { message: 'At least one email or phone is required' });

const importConfirmSchema = z.object({
  body: z.object({
    rows: z.array(importRowSchema).min(1, 'No rows to import'),
  }),
});

// "Paste karke bulk add" — name/phone/email ki lines
const parseTextSchema = z.object({
  body: z.object({
    text: z.string().min(1, 'Paste some leads first').max(500000),
  }),
});

const startConversationsSchema = z.object({
  body: z.object({
    leadIds: z.array(objectId).min(1, 'At least one leadId is required'),
  }),
});

module.exports = {
  createLeadSchema,
  updateLeadSchema,
  listLeadsQuerySchema,
  idParamSchema,
  bulkDeleteSchema,
  tagsUpdateSchema,
  importRowSchema,
  importConfirmSchema,
  parseTextSchema,
  startConversationsSchema,
};
