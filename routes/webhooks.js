// routes/webhooks.js
// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: No authenticateToken middleware here.
// Razorpay calls this endpoint directly — it has no JWT.
// Security is handled by HMAC-SHA256 signature verification inside the handler.
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const router = express.Router();
const webhookController = require("../controllers/webhookController");

/**
 * POST /api/v1/webhooks/razorpay
 *
 * Razorpay dashboard setup:
 *   URL:    https://app.mysehat.ai/api/v1/webhooks/razorpay
 *   Secret: value of RAZORPAY_WEBHOOK_SECRET in your .env
 *   Events: payment.captured, payment.failed
 *
 * ⚠️ This route MUST use raw body — NOT parsed JSON.
 * The HMAC signature is computed against the raw request body.
 * We capture rawBody in app.js middleware before JSON parsing.
 */
router.post("/razorpay", webhookController.handleRazorpayWebhook);

module.exports = router;