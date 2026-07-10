// controllers/walletController.js
require("dotenv").config();
const Razorpay = require("razorpay");
const crypto = require("crypto");
const db = require("../config/db");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const REWARD_TIERS = { 100: 20, 200: 50, 500: 120, 1000: 250 };
const MIN_AMOUNT = 1;
const MAX_AMOUNT = 10000;

function getRewardAmount(cash) {
  return REWARD_TIERS[cash] !== undefined
    ? REWARD_TIERS[cash]
    : Math.floor(cash * 0.05);
}

// =============================================================================
// GET /api/v1/wallet/balance
// =============================================================================
async function getWalletBalance(req, res) {
  try {
    const mobileNumber = req.user.mobileNumber;
    console.log("💰 GET WALLET BALANCE — mobile:", mobileNumber);

    const wallet = await db.getWalletByMobile(mobileNumber);

    if (!wallet) {
      return res.status(200).json({
        success: true,
        data: {
          wallet_id: null,
          mysehat_cash: 0,
          rewards_points: 0,
          wallet_balance: 0,
          has_wallet: false,
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        wallet_id: wallet.wallet_id,
        mysehat_cash: parseFloat(wallet.mysehat_cash),
        rewards_points: parseFloat(wallet.rewards_points),
        wallet_balance: parseFloat(wallet.wallet_balance),
        has_wallet: true,
      },
    });
  } catch (error) {
    console.error("❌ getWalletBalance error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch wallet balance",
      error: error.message,
    });
  }
}

// =============================================================================
// POST /api/v1/wallet/recharge/create-order
// Body: { amount: 500 }
// =============================================================================
async function createRechargeOrder(req, res) {
  try {
    const mobileNumber = req.user.mobileNumber;
    const userId = req.user.userId;

    // ✅ FIX: Defensive body guard — req.body can be undefined if
    // Content-Type header is missing or wrong from the client
    const body = req.body || {};
    const { amount } = body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("💳 CREATE WALLET RECHARGE ORDER");
    console.log("Mobile:", mobileNumber, "| Amount:", amount);
    console.log("Raw body:", body); // ← log to diagnose future issues

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

    const rewardAmount = getRewardAmount(cashAmount);
    const amountPaise = cashAmount * 100;

    // ── Create Razorpay order ─────────────────────────────────────────────────
    const rzpOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `WALLET_${userId}_${Date.now()}`,
      notes: {
        purpose: "wallet_recharge",
        mobile_number: mobileNumber,
        user_id: userId,
        cash_amount: cashAmount,
        reward_amount: rewardAmount,
      },
    });

    console.log("✅ Razorpay order created:", rzpOrder.id);

    // ── Save recharge order to DB ─────────────────────────────────────────────
    const rechargeOrderId = await db.createRechargeOrder(
      mobileNumber,
      userId,
      cashAmount,
      rewardAmount,
      rzpOrder.id,
    );

    console.log("✅ Recharge order saved to DB:", rechargeOrderId);
    console.log("Cash:", cashAmount, "| Reward:", rewardAmount);
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
        reward_amount: rewardAmount,
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
// POST /api/v1/wallet/recharge/verify-payment
// =============================================================================
async function verifyRechargePayment(req, res) {
  try {
    const mobileNumber = req.user.mobileNumber;

    // ✅ FIX: Defensive body guard
    const body = req.body || {};
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      cash_amount,
      reward_amount,
    } = body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔐 VERIFY WALLET RECHARGE (fast path)");
    console.log("Mobile:", mobileNumber);
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

    // Backend reward recalculation — never trust frontend
    const safeRewardAmount = getRewardAmount(cashAmount);

    // ── Verify Razorpay signature ─────────────────────────────────────────────
    const body2 = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body2)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      console.error("❌ Invalid Razorpay signature");
      return res.status(400).json({
        success: false,
        message: "Payment verification failed — invalid signature",
      });
    }

    console.log("✅ Signature verified");

    // ── Check if webhook already credited wallet ──────────────────────────────
    const rechargeOrder =
      await db.getRechargeOrderByRazorpayId(razorpay_order_id);

    if (rechargeOrder && rechargeOrder.status === "paid") {
      console.log("✅ Webhook already processed — returning cached balance");
      const wallet = await db.getWalletByMobile(mobileNumber);
      return res.status(200).json({
        success: true,
        message: `Wallet recharged with ₹${cashAmount} + ₹${safeRewardAmount} reward`,
        already_credited: true,
        credited_via: rechargeOrder.credited_via,
        data: {
          transaction_id: rechargeOrder.wallet_transaction_id,
          cash_credited: cashAmount,
          reward_credited: safeRewardAmount,
          mysehat_cash: parseFloat(wallet.mysehat_cash),
          rewards_points: parseFloat(wallet.rewards_points),
          wallet_balance: parseFloat(wallet.wallet_balance),
        },
      });
    }

    // ── Idempotency check on wallet_transactions ──────────────────────────────
    const existing = await db.query(
      `SELECT transaction_id FROM wallet_transactions
       WHERE razorpay_payment_id = ? LIMIT 1`,
      [razorpay_payment_id],
    );

    if (existing.length > 0) {
      console.warn("⚠️ Payment already in wallet_transactions");
      const wallet = await db.getWalletByMobile(mobileNumber);
      return res.status(200).json({
        success: true,
        message: "Payment already processed",
        already_credited: true,
        data: {
          mysehat_cash: parseFloat(wallet.mysehat_cash),
          rewards_points: parseFloat(wallet.rewards_points),
          wallet_balance: parseFloat(wallet.wallet_balance),
        },
      });
    }

    // ── Credit wallet (fast path — webhook hasn't run yet) ────────────────────
    console.log(
      "⚡ Webhook not yet received — crediting via verify-payment (fast path)",
    );

    const result = await db.addWalletRecharge(
      mobileNumber,
      cashAmount,
      safeRewardAmount,
      razorpay_payment_id,
      razorpay_order_id,
    );

    if (rechargeOrder) {
      await db.updateRechargeOrder(razorpay_order_id, {
        status: "paid",
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        walletTransactionId: result.transactionId,
        creditedVia: "verify_api",
      });
    }

    console.log("✅ Wallet credited via verify-payment");
    console.log("New balance: ₹", result.newBalance);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    return res.status(200).json({
      success: true,
      message: `Wallet recharged with ₹${cashAmount} + ₹${safeRewardAmount} reward`,
      data: {
        transaction_id: result.transactionId,
        cash_credited: cashAmount,
        reward_credited: safeRewardAmount,
        mysehat_cash: result.newCash,
        rewards_points: result.newRewards,
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
// GET /api/v1/wallet/transactions?limit=20&offset=0
// =============================================================================
async function getWalletTransactions(req, res) {
  try {
    const mobileNumber = req.user.mobileNumber;
    const limit  = (Math.min(Math.max(1, parseInt(req.query.limit,  10) || 20), 100)) | 0;
    const offset = (Math.max(0, parseInt(req.query.offset, 10) || 0)) | 0;

    console.log("📋 GET WALLET TRANSACTIONS — mobile:", mobileNumber);

    const transactions = await db.getWalletTransactions(
      mobileNumber,
      limit,
      offset,
    );

    const formatted = transactions.map((t) => ({
      id: t.id,
      transaction_id: t.transaction_id,
      type: t.transaction_type,
      amount_rupees: parseFloat(t.amount_rupees || 0),
      credits: parseFloat(t.credits),
      balance_after: parseFloat(t.balance_after),
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
    console.error("❌ getWalletTransactions error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch wallet transactions",
      error: error.message,
    });
  }
}

module.exports = {
  getWalletBalance,
  createRechargeOrder,
  verifyRechargePayment,
  getWalletTransactions,
};
