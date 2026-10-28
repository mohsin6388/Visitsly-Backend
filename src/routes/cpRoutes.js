const express = require('express');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const validate = require('../middlewares/validate');
const c = require('../controllers/cpController');

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const password = z.string().min(8, 'Password kam se kam 8 characters').regex(/[0-9]/, 'Password mein ek number chahiye');

const registerSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(100),
    firmName: z.string().trim().max(120).optional(),
    phone: z.string().trim().min(10).max(20),
    email: z.string().email(),
    city: z.string().trim().max(80).optional(),
    reraNumber: z.string().trim().max(60).optional(),
    password,
  }),
});
const loginSchema = z.object({ body: z.object({ email: z.string().min(3).max(200), password: z.string().min(1) }) });
const leadSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(150),
    phone: z.string().trim().min(10).max(20),
    email: z.string().email().optional().or(z.literal('')),
    project: z.string().trim().max(150).optional(),
    budget: z.coerce.number().min(0).max(1e11).optional(),
    visitDate: z.string().max(40).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

// Channel partner (external broker) portal — /cp/:slug in the customer app.
router.get('/me', c.cpAuth, c.me);
router.get('/me/leads', c.cpAuth, c.myLeads);
router.post('/me/leads', c.cpAuth, validate(leadSchema), c.submitLead);
router.get('/me/inventory', c.cpAuth, c.inventory);

router.get('/:slug/info', c.info);
router.post('/:slug/register', limiter, validate(registerSchema), c.register);
router.post('/:slug/login', limiter, validate(loginSchema), c.login);

module.exports = router;
