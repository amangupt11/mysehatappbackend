// routes/payments.js
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * POST /api/v1/orders/:orderId/create-payment
 * Create Razorpay payment order
 */
router.post('/orders/:orderId/create-payment', authenticateToken, paymentController.createPayment);

/**
 * POST /api/v1/orders/:orderId/verify-payment
 * Verify Razorpay payment and generate report
 */
router.post('/orders/:orderId/verify-payment', authenticateToken, paymentController.verifyPayment);
/**
 * POST /api/v1/orders/:orderId/pay-with-wallet
 * Pay BMI test fee directly from MySehat Wallet
 * Requires: JWT token
 */
router.post(
  '/orders/:orderId/pay-with-wallet',
  authenticateToken,
  paymentController.payWithWallet
);

module.exports = router;