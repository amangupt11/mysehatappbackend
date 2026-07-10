// controllers/partnerWalletController.js
require("dotenv").config();
const Razorpay = require("razorpay");
const crypto = require("crypto");
const db = require("../config/db");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const MIN_AMOUNT = 1;
const MAX_AMOUNT = 50000; // partners recharge larger amounts than end users

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Get partner mobile number from organizations table.
 * JWT contains org_id but not mobile number.
 * We resolve the phone using organizations.org_id.
 */
async function getPartnerMobile(orgId) {
  const rows = await db.query(
    `SELECT phone FROM organizations WHERE org_id = ? LIMIT 1`,
    [orgId],
  );
  return rows.length > 0 ? rows[0].phone : null;
}

/**
 * Get or create partner wallet.
 * partner_wallet_recharge_orders.partner_wallet_id is NOT NULL, so we must
 * have a wallet row before creating the recharge order. We create an empty
 * wallet (balance=0) on the partner's first "Add credit" attempt.
 */
async function ensurePartnerWallet(partnerAuthId, orgId, mobileNumber) {
  const existing = await db.getPartnerWalletByAuthId(partnerAuthId);
  if (existing) return existing;

  const partnerWalletId = db.generatePartnerWalletId();
  await db.query(
    `INSERT INTO partner_wallets
       (partner_wallet_id, partner_auth_id, org_id, mobile_number,
        wallet_balance, status)
     VALUES (?, ?, ?, ?, 0.00, 'active')`,
    [partnerWalletId, partnerAuthId, orgId, mobileNumber],
  );

  console.log("✅ Partner wallet created (empty):", partnerWalletId);
  return await db.getPartnerWalletByAuthId(partnerAuthId);
}

// =============================================================================
// GET /api/v1/partner-wallet/balance
// =============================================================================
async function getBalance(req, res) {
  try {
    const partnerAuthId = req.user.auth_id;

    console.log("💰 GET PARTNER WALLET BALANCE — auth_id:", partnerAuthId);

    const wallet = await db.getPartnerWalletByAuthId(partnerAuthId);

    if (!wallet) {
      return res.status(200).json({
        success: true,
        data: {
          partner_wallet_id: null,
          wallet_balance: 0,
          status: "active",
          has_wallet: false,
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        partner_wallet_id: wallet.partner_wallet_id,
        wallet_balance: parseFloat(wallet.wallet_balance),
        status: wallet.status,
        has_wallet: true,
      },
    });
  } catch (error) {
    console.error("❌ getBalance error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch wallet balance",
      error: error.message,
    });
  }
}

// =============================================================================
// POST /api/v1/partner-wallet/recharge/create-order
// Body: { amount: 500 }
// =============================================================================
async function createRechargeOrder(req, res) {
  try {
    const partnerAuthId = req.user.auth_id;
    const orgId = req.user.org_id;

    if (!orgId) {
      return res.status(403).json({
        success: false,
        message: "No organisation linked to this account.",
      });
    }

    const body = req.body || {};
    const { amount } = body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("💳 CREATE PARTNER WALLET RECHARGE ORDER");
    console.log(
      "Partner:",
      partnerAuthId,
      "| Org:",
      orgId,
      "| Amount:",
      amount,
    );
    console.log("Raw body:", body);

    // ── Validate ──────────────────────────────────────────────────────────────
    if (amount === undefined || amount === null) {
      return res.status(400).json({
        success: false,
        message: "amount is required in request body",
      });
    }

    const cashAmount = parseInt(amount, 10);

    if (!cashAmount || isNaN(cashAmount)) {
      return res.status(400).json({
        success: false,
        message: "amount must be a valid number",
      });
    }

    if (cashAmount < MIN_AMOUNT || cashAmount > MAX_AMOUNT) {
      return res.status(400).json({
        success: false,
        message: `Amount must be between ₹${MIN_AMOUNT} and ₹${MAX_AMOUNT}`,
      });
    }

    // ── Resolve partner identity ──────────────────────────────────────────────
    const mobileNumber = await getPartnerMobile(orgId);
    if (!mobileNumber) {
      return res.status(404).json({
        success: false,
        message: "Partner account not found",
      });
    }

    // ── Ensure wallet exists (creates empty wallet if first top-up) ──────────
    const wallet = await ensurePartnerWallet(
      partnerAuthId,
      orgId,
      mobileNumber,
    );

    const amountPaise = cashAmount * 100;

    // ── Create Razorpay order ────────────────────────────────────────────────
    const rzpOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `PWALLET_${partnerAuthId}_${Date.now()}`,
      notes: {
        purpose: "partner_wallet_recharge",
        partner_auth_id: partnerAuthId,
        org_id: orgId,
        mobile_number: mobileNumber,
        cash_amount: cashAmount,
      },
    });

    console.log("✅ Razorpay order created:", rzpOrder.id);

    // ── Save recharge order ──────────────────────────────────────────────────
    const rechargeOrderId = await db.createPartnerRechargeOrder(
      wallet.partner_wallet_id,
      partnerAuthId,
      mobileNumber,
      cashAmount,
      rzpOrder.id,
    );

    console.log("✅ Partner recharge order saved:", rechargeOrderId);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    return res.status(200).json({
      success: true,
      message: "Recharge order created",
      data: {
        razorpay_order_id: rzpOrder.id,
        recharge_order_id: rechargeOrderId,
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
        key_id: process.env.RAZORPAY_KEY_ID,
        cash_amount: cashAmount,
      },
    });
  } catch (error) {
    console.error("❌ createRechargeOrder error:", error.message);
    console.error("Stack:", error.stack);
    return res.status(500).json({
      success: false,
      message: "Failed to create recharge order",
      error: error.message,
    });
  }
}

// =============================================================================
// POST /api/v1/partner-wallet/recharge/verify-payment
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, cash_amount }
// =============================================================================
async function verifyRechargePayment(req, res) {
  try {
    const partnerAuthId = req.user.auth_id;
    const orgId = req.user.org_id;

    const body = req.body || {};
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      cash_amount,
    } = body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔐 VERIFY PARTNER WALLET RECHARGE (fast path)");
    console.log("Partner:", partnerAuthId);
    console.log("Razorpay Order:", razorpay_order_id);
    console.log("Razorpay Payment:", razorpay_payment_id);

    // ── Validate ──────────────────────────────────────────────────────────────
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message:
          "razorpay_order_id, razorpay_payment_id and razorpay_signature are required",
      });
    }

    const cashAmount = parseInt(cash_amount, 10);
    if (
      !cashAmount ||
      isNaN(cashAmount) ||
      cashAmount < MIN_AMOUNT ||
      cashAmount > MAX_AMOUNT
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid cash_amount",
      });
    }

    // ── Verify Razorpay signature ────────────────────────────────────────────
    const sigBody = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(sigBody)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      console.error("❌ Invalid Razorpay signature");
      return res.status(400).json({
        success: false,
        message: "Payment verification failed — invalid signature",
      });
    }

    console.log("✅ Signature verified");

    // ── Dual-credit guard: was webhook already processed? ────────────────────
    const rechargeOrder =
      await db.getPartnerRechargeOrderByRazorpayId(razorpay_order_id);

    if (rechargeOrder && rechargeOrder.status === "paid") {
      console.log("✅ Webhook already processed — returning cached balance");
      const wallet = await db.getPartnerWalletByAuthId(partnerAuthId);
      return res.status(200).json({
        success: true,
        message: `Wallet recharged with ₹${cashAmount}`,
        already_credited: true,
        credited_via: rechargeOrder.credited_via,
        data: {
          transaction_id: rechargeOrder.wallet_transaction_id,
          cash_credited: cashAmount,
          wallet_balance: parseFloat(wallet.wallet_balance),
        },
      });
    }

    // ── Idempotency check on ledger ──────────────────────────────────────────
    const existing = await db.query(
      `SELECT transaction_id FROM partner_wallet_transactions
       WHERE razorpay_payment_id = ? LIMIT 1`,
      [razorpay_payment_id],
    );

    if (existing.length > 0) {
      console.warn("⚠️ Payment already in partner_wallet_transactions");
      const wallet = await db.getPartnerWalletByAuthId(partnerAuthId);
      return res.status(200).json({
        success: true,
        message: "Payment already processed",
        already_credited: true,
        data: {
          wallet_balance: parseFloat(wallet.wallet_balance),
        },
      });
    }

    // ── Resolve partner identity (needed for lazy wallet creation if any) ────
    const mobileNumber = await getPartnerMobile(orgId);
    if (!mobileNumber) {
      return res.status(404).json({
        success: false,
        message: "Partner account not found",
      });
    }

    // ── Credit wallet (fast path — webhook hasn't run yet) ───────────────────
    console.log(
      "⚡ Webhook not yet received — crediting via verify-payment (fast path)",
    );

    const result = await db.addPartnerWalletRecharge(
      partnerAuthId,
      orgId,
      mobileNumber,
      cashAmount,
      razorpay_payment_id,
      razorpay_order_id,
    );

    // ── Update recharge order ────────────────────────────────────────────────
    if (rechargeOrder) {
      await db.updatePartnerRechargeOrder(razorpay_order_id, {
        status: "paid",
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        walletTransactionId: result.transactionId,
        creditedVia: "verify_api",
      });
    }

    console.log("✅ Partner wallet credited via verify-payment");
    console.log("New balance: ₹", result.newBalance);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    return res.status(200).json({
      success: true,
      message: `Wallet recharged with ₹${cashAmount}`,
      data: {
        transaction_id: result.transactionId,
        cash_credited: cashAmount,
        wallet_balance: result.newBalance,
      },
    });
  } catch (error) {
    console.error("❌ verifyRechargePayment error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to verify recharge payment",
      error: error.message,
    });
  }
}

// =============================================================================
// GET /api/v1/partner-wallet/transactions?limit=20&offset=0
// =============================================================================
async function getTransactions(req, res) {
  try {
    const partnerAuthId = req.user.auth_id;
    const limit =
      Math.min(Math.max(1, parseInt(req.query.limit, 10) || 20), 100) | 0;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0) | 0;

    console.log("📋 GET PARTNER WALLET TRANSACTIONS — auth_id:", partnerAuthId);

    const wallet = await db.getPartnerWalletByAuthId(partnerAuthId);
    if (!wallet) {
      return res.status(200).json({
        success: true,
        count: 0,
        data: [],
      });
    }

    const transactions = await db.getPartnerWalletTransactions(
      wallet.partner_wallet_id,
      limit,
      offset,
    );

    const formatted = transactions.map((t) => ({
      id: t.id,
      transaction_id: t.transaction_id,
      type: t.transaction_type,
      amount_rupees: parseFloat(t.amount_rupees || 0),
      balance_after: parseFloat(t.balance_after),
      reference_id: t.reference_id,
      description: t.description,
      razorpay_payment_id: t.razorpay_payment_id || null,
      created_at: t.created_at,
    }));

    return res.status(200).json({
      success: true,
      count: formatted.length,
      data: formatted,
    });
  } catch (error) {
    console.error("❌ getTransactions error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch transactions",
      error: error.message,
    });
  }
}

module.exports = {
  getBalance,
  createRechargeOrder,
  verifyRechargePayment,
  getTransactions,
};
