// routes/wallet.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/authMiddleware");
const walletController = require("../controllers/walletController");

// All wallet routes require JWT
router.use(authenticateToken);

/**
 * GET /api/v1/wallet/balance
 * Returns mysehat_cash, rewards_points, wallet_balance
 */
router.get("/balance", walletController.getWalletBalance);

/**
 * POST /api/v1/wallet/recharge/create-order
 * Body: { amount: 500 }
 * Creates Razorpay order for wallet top-up
 */
router.post("/recharge/create-order", walletController.createRechargeOrder);

/**
 * POST /api/v1/wallet/recharge/verify-payment
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature,
 *         cash_amount, reward_amount }
 * Verifies payment signature and credits wallet
 */
router.post("/recharge/verify-payment", walletController.verifyRechargePayment);

/**
 * GET /api/v1/wallet/transactions?limit=20&offset=0
 * Paginated wallet transaction history
 */
router.get("/transactions", walletController.getWalletTransactions);

module.exports = router;