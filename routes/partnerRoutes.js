// routes/partnerRoutes.js
const express = require('express');
const router = express.Router();
const partnerController = require('../controllers/partnerController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Protect all routes
router.use(authenticateToken);

/**
 * GET Profile
 * api/v1/partner/profile/:id
 */
router.get('/profile/:id', partnerController.getProfile);

/**
 * UPDATE Profile (text fields only — full_name, username, mobile_number, password)
 * api/v1/partner/profile/:id
 * 
 * NOTE: Profile image updates are handled by admin.mysehat.ai
 *       (PUT https://admin.mysehat.ai/api/v1/partner/avatar)
 *       because organizations.profile_image files live on that server's disk.
 */
router.put('/profile/:id', partnerController.updateProfile);

/**
 * GET All Reports
 * api/v1/partner/reports
 */
router.get('/reports', partnerController.getReports);

/**
 * GET Report By ID
 * api/v1/partner/reports/:id
 */
router.get('/reports/:id', partnerController.getReportById);

/**
 * GET All Transactions
 * api/v1/partner/transactions
 */
router.get('/transactions', partnerController.getTransactions);

/**
 * GET Transaction By ID
 * api/v1/partner/transactions/:id
 */
router.get('/transactions/:id', partnerController.getTransactionById);

module.exports = router;