const express = require('express');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const { getReport } = require('../controllers/reportsController');

// Reports compare the whole team, so owners and managers only.
router.get('/', authenticate, roleGuard.org('owner', 'manager'), getReport);

module.exports = router;
