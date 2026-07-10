// routes/waAuthRoutes.js
const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/authMiddleware');
const waAuthController = require('../controllers/waAuthController');

router.post('/verify-login', waAuthController.verifyLogin);
router.post('/refresh-token', waAuthController.refreshToken);
router.get( '/validate', authenticateToken, waAuthController.validateToken);
router.post('/logout', authenticateToken, waAuthController.logout);
router.post('/complete-profile', authenticateToken, waAuthController.completeProfile);

module.exports = router;