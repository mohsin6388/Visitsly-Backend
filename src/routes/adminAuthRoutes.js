const express = require('express');
const router = express.Router();
const c = require('../controllers/adminAuthController');
const adminAuth = require('../middlewares/adminAuth');
const validate = require('../middlewares/validate');
const { authLimiter } = require('../middlewares/rateLimit');
const { loginSchema, changePasswordSchema } = require('../validators/authValidators');

// Separate PropAI admin panel login (super-admins only).
router.post('/login', authLimiter, validate(loginSchema), c.login);
router.post('/refresh', c.refresh);
router.post('/logout', c.logout);
router.get('/me', adminAuth, c.me);
router.post('/change-password', adminAuth, validate(changePasswordSchema), c.changePassword);

module.exports = router;
