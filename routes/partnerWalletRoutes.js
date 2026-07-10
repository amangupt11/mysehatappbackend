// routes/partnerWalletRoutes.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/authMiddleware");
const partnerWalletController = require("../controllers/partnerWalletController");

// All partner wallet routes require a valid partner JWT
router.use(authenticateToken);

/**
 * GET /api/v1/partner-wallet/balance
 * Returns wallet_balance, status, has_wallet
 */
router.get("/balance", partnerWalletController.getBalance);

/**
 * POST /api/v1/partner-wallet/recharge/create-order
 * Body: { amount: 500 }
 * Creates Razorpay order for partner wallet top-up.
 * Lazily creates empty partner_wallet row if this is the first top-up.
 */
router.post(
  "/recharge/create-order",
  partnerWalletController.createRechargeOrder,
);

/**
 * POST /api/v1/partner-wallet/recharge/verify-payment
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, cash_amount }
 * Verifies Razorpay signature and credits wallet (fast path before webhook).
 */
router.post(
  "/recharge/verify-payment",
  partnerWalletController.verifyRechargePayment,
);

/**
 * GET /api/v1/partner-wallet/transactions?limit=20&offset=0
 * Paginated ledger history (credit_purchase + kiosk_recharge rows).
 */
router.get("/transactions", partnerWalletController.getTransactions);

module.exports = router;
