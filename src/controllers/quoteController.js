const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Quote = require('../models/Quote');
const Lead = require('../models/Lead');
const Organization = require('../models/Organization');
const tenantContext = require('../context/tenantContext');
const svc = require('../services/quotes/quoteService');
const metaWhatsappClient = require('../services/whatsapp/metaWhatsappClient');
const { recordOutboundMessage } = require('../services/whatsapp/messageStore');
const Conversation = require('../models/Conversation');

function publicPdfUrl(req, quote) {
  const base = (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '').replace(/\/api$/, '');
  return `${base}/api/quotes/public/${quote.token}.pdf`;
}

function view(req, q) {
  const o = q.toObject ? q.toObject() : q;
  return { ...o, pdfUrl: publicPdfUrl(req, o) };
}

const list = asyncHandler(async (req, res) => {
  const filter = { ownerId: req.user.id };
  if (req.query.leadId) filter.leadId = req.query.leadId;
  const items = await Quote.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  return new ApiResponse(200, { items: items.map((q) => view(req, q)) }).send(res);
});

const create = asyncHandler(async (req, res) => {
  const b = req.body;
  let customer = b.customer || {};
  if (b.leadId) {
    const lead = await Lead.findOne({ _id: b.leadId, ownerId: req.user.id }).lean();
    if (!lead) throw ApiError.notFound('Lead not found');
    customer = { name: customer.name || lead.name, phone: customer.phone || lead.phone, email: customer.email || lead.email };
  }
  const totals = svc.computeTotals(b.pricing, b.unit);
  const quote = await Quote.create({
    ownerId: req.user.id,
    number: await svc.nextNumber(req.user.id),
    token: svc.newToken(),
    leadId: b.leadId || null,
    propertyId: b.propertyId || null,
    customer,
    project: b.project,
    unit: b.unit || {},
    pricing: b.pricing || {},
    totals,
    paymentPlan: svc.planWithAmounts(b.paymentPlan, totals),
    validTill: b.validTill || new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
    notes: b.notes || '',
    createdBy: req.user.actorId,
  });
  return new ApiResponse(201, { quote: view(req, quote) }, `Cost sheet ${quote.number} ban gaya`).send(res);
});

/** POST /api/quotes/preview — live totals while typing (nothing saved). */
const preview = asyncHandler(async (req, res) => {
  const totals = svc.computeTotals(req.body.pricing, req.body.unit);
  return new ApiResponse(200, { totals, paymentPlan: svc.planWithAmounts(req.body.paymentPlan, totals) }).send(res);
});

const remove = asyncHandler(async (req, res) => {
  await Quote.deleteOne({ _id: req.params.id, ownerId: req.user.id });
  return new ApiResponse(200, null, 'Deleted').send(res);
});

async function companyFor(ownerId) {
  const org = tenantContext.getOrg() || (await Organization.findOne({ ownerUserId: ownerId }).lean());
  return { name: org?.branding?.productName || org?.name || '', city: org?.city || '', phone: org?.phone || '' };
}

/** GET /api/quotes/public/:token.pdf — public link (WhatsApp document / share). */
const publicPdf = async (req, res, next) => {
  try {
    const token = String(req.params.token || '').replace(/\.pdf$/, '');
    if (!/^[a-f0-9]{32}$/.test(token)) return res.sendStatus(404);
    const quote = await Quote.findOne({ token });
    if (!quote) return res.sendStatus(404);
    if (!quote.viewedAt) Quote.updateOne({ _id: quote._id }, { $set: { viewedAt: new Date() } }).catch(() => {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${quote.number}.pdf"`);
    svc.renderPdf(quote, await companyFor(quote.ownerId), res);
  } catch (err) {
    next(err);
  }
};

/** POST /api/quotes/:id/send-whatsapp — sends the PDF in the lead's chat. */
const sendWhatsapp = asyncHandler(async (req, res) => {
  const quote = await Quote.findOne({ _id: req.params.id, ownerId: req.user.id });
  if (!quote) throw ApiError.notFound('Quote not found');
  const phone = quote.customer?.phone;
  if (!phone) throw ApiError.badRequest('Customer ka phone number nahi hai');
  const conversation = quote.leadId ? await Conversation.findOne({ leadId: quote.leadId }) : null;
  if (conversation && !metaWhatsappClient.isWithin24HourWindow(conversation.lastInboundAt)) {
    throw ApiError.badRequest('Customer ne pichhle 24 ghante mein reply nahi kiya — WhatsApp rule ke hisaab se pehle template bhejein, ya PDF link copy karke share karein.');
  }
  const caption = `${quote.project} — cost sheet ${quote.number}. All-inclusive Rs. ${Number(quote.totals.grandTotal).toLocaleString('en-IN')}`;
  const sent = await tenantContext.runWithNumber(conversation?.phoneNumberId, () =>
    metaWhatsappClient.sendDocumentMessage({ phone, documentUrl: publicPdfUrl(req, quote), filename: `${quote.number}.pdf`, caption }));
  quote.sentAt = new Date();
  await quote.save();
  if (conversation) {
    await recordOutboundMessage({ conversationId: conversation._id, leadId: quote.leadId, text: `📄 ${caption}`, sender: 'broker', whatsappMessageId: sent.messageId }).catch(() => {});
  }
  return new ApiResponse(200, { quote: view(req, quote) }, 'Cost sheet WhatsApp par bhej di').send(res);
});

module.exports = { list, create, preview, remove, publicPdf, sendWhatsapp };
