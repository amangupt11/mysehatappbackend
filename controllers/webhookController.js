// controllers/webhookController.js
// ─────────────────────────────────────────────────────────────────────────────
// Handles ALL incoming Razorpay webhooks
// Currently handles:
//   payment.captured  → wallet recharge credit (USER + PARTNER)
//   payment.failed    → mark recharge failed   (USER + PARTNER)
// Routes by which table holds the razorpay_order_id:
//   1. partner_wallet_recharge_orders → partner credit
//   2. wallet_recharge_orders         → user credit (existing flow)
//   3. neither                        → "may be BMI payment", skip
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const crypto = require("crypto");
const db = require("../config/db");

// ─────────────────────────────────────────────────────────────────────────────
// Verify Razorpay webhook signature
// ─────────────────────────────────────────────────────────────────────────────
function verifyWebhookSignature(rawBody, signature) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    throw new Error("RAZORPAY_WEBHOOK_SECRET not configured");
  }

  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature, "hex"),
    Buffer.from(signature, "hex"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/webhooks/razorpay
// ─────────────────────────────────────────────────────────────────────────────
async function handleRazorpayWebhook(req, res) {
  // Respond 200 immediately — Razorpay retries on slow ack
  res.status(200).json({ success: true, received: true });

  const signature = req.headers["x-razorpay-signature"];
  const eventId = req.headers["x-razorpay-event-id"];

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🔔 RAZORPAY WEBHOOK RECEIVED");
  console.log("Event ID:", eventId);
  console.log("Signature:", signature?.substring(0, 20) + "...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (!signature) {
    console.error("❌ Webhook missing signature header");
    return;
  }

  let isValid = false;
  try {
    isValid = verifyWebhookSignature(req.rawBody, signature);
  } catch (err) {
    console.error("❌ Signature verification error:", err.message);
    return;
  }

  if (!isValid) {
    console.error("❌ Invalid webhook signature — ignoring");
    return;
  }

  console.log("✅ Webhook signature verified");

  let payload;
  try {
    payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (err) {
    console.error("❌ Failed to parse webhook body:", err.message);
    return;
  }

  const eventType = payload?.event;
  console.log("Event type:", eventType);

  // Idempotency check
  if (eventId) {
    const alreadyProcessed = await db.isWebhookAlreadyProcessed(eventId);
    if (alreadyProcessed) {
      console.log("⚠️ Webhook already processed — skipping:", eventId);
      return;
    }
  }

  try {
    switch (eventType) {
      case "payment.captured":
        await handlePaymentCaptured(payload, eventId);
        break;
      case "payment.failed":
        await handlePaymentFailed(payload, eventId);
        break;
      default:
        console.log("ℹ️ Unhandled webhook event type:", eventType);
        if (eventId) {
          await db.recordWebhookEvent(
            eventId,
            eventType,
            null,
            payload,
            "skipped",
          );
        }
    }
  } catch (err) {
    console.error("❌ Webhook handler error:", err.message);
    console.error(err.stack);
    if (eventId) {
      await db.recordWebhookEvent(
        eventId,
        eventType,
        null,
        payload,
        "failed",
        err.message,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// payment.captured — route by which table owns the order
// ─────────────────────────────────────────────────────────────────────────────
async function handlePaymentCaptured(payload, eventId) {
  const payment = payload?.payload?.payment?.entity;
  const razorpayOrderId = payment?.order_id;
  const razorpayPaymentId = payment?.id;
  const amountPaise = payment?.amount;

  console.log(
    "💰 payment.captured —",
    razorpayPaymentId,
    "| Order:",
    razorpayOrderId,
  );

  if (!razorpayOrderId || !razorpayPaymentId) {
    console.error("❌ Missing order_id or payment_id in webhook payload");
    return;
  }

  // ── Try partner wallet first ────────────────────────────────────────────────
  const partnerOrder =
    await db.getPartnerRechargeOrderByRazorpayId(razorpayOrderId);
  if (partnerOrder) {
    return await handlePartnerPaymentCaptured(
      payload,
      eventId,
      partnerOrder,
      razorpayOrderId,
      razorpayPaymentId,
      amountPaise,
    );
  }

  // ── Fall back to user wallet (existing logic, unchanged) ────────────────────
  const rechargeOrder = await db.getRechargeOrderByRazorpayId(razorpayOrderId);

  if (!rechargeOrder) {
    console.log(
      "ℹ️ No wallet recharge order found for Razorpay order:",
      razorpayOrderId,
    );
    console.log("ℹ️ This may be a BMI payment — skipping wallet credit");
    if (eventId) {
      await db.recordWebhookEvent(
        eventId,
        "payment.captured",
        razorpayPaymentId,
        payload,
        "skipped",
      );
    }
    return;
  }

  console.log("✅ Found user recharge order:", rechargeOrder.recharge_order_id);
  console.log("Mobile:", rechargeOrder.mobile_number);
  console.log("Cash amount: ₹", rechargeOrder.cash_amount);
  console.log("Reward amount: ₹", rechargeOrder.reward_amount);
  console.log("Current status:", rechargeOrder.status);

  // Idempotency
  if (rechargeOrder.status === "paid") {
    console.log(
      "⚠️ User recharge already credited (via verify-payment API) — skipping",
    );
    if (eventId) {
      await db.recordWebhookEvent(
        eventId,
        "payment.captured",
        razorpayPaymentId,
        payload,
        "skipped",
      );
    }
    return;
  }

  // Verify amount matches
  const expectedPaise = Math.round(parseFloat(rechargeOrder.cash_amount) * 100);
  if (amountPaise !== expectedPaise) {
    const errMsg = `Amount mismatch: expected ${expectedPaise} paise, got ${amountPaise}`;
    console.error("❌", errMsg);
    await db.updateRechargeOrder(razorpayOrderId, {
      status: "failed",
      errorMessage: errMsg,
    });
    if (eventId) {
      await db.recordWebhookEvent(
        eventId,
        "payment.captured",
        razorpayPaymentId,
        payload,
        "failed",
        errMsg,
      );
    }
    return;
  }

  console.log("💳 Crediting user wallet via webhook...");

  const result = await db.addWalletRecharge(
    rechargeOrder.mobile_number,
    parseFloat(rechargeOrder.cash_amount),
    parseFloat(rechargeOrder.reward_amount),
    razorpayPaymentId,
    razorpayOrderId,
  );

  console.log("✅ User wallet credited via webhook!");
  console.log("New balance: ₹", result.newBalance);

  await db.updateRechargeOrder(razorpayOrderId, {
    status: "paid",
    razorpayPaymentId,
    walletTransactionId: result.transactionId,
    creditedVia: "webhook",
    webhookReceivedAt: new Date(),
  });

  if (eventId) {
    await db.recordWebhookEvent(
      eventId,
      "payment.captured",
      razorpayPaymentId,
      payload,
      "processed",
    );
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ USER WEBHOOK PROCESSING COMPLETE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

// ─────────────────────────────────────────────────────────────────────────────
// payment.captured for PARTNER WALLET
// ─────────────────────────────────────────────────────────────────────────────
async function handlePartnerPaymentCaptured(
  payload,
  eventId,
  partnerOrder,
  razorpayOrderId,
  razorpayPaymentId,
  amountPaise,
) {
  console.log(
    "✅ Found PARTNER recharge order:",
    partnerOrder.recharge_order_id,
  );
  console.log("Partner:", partnerOrder.partner_auth_id);
  console.log("Mobile:", partnerOrder.mobile_number);
  console.log("Amount: ₹", partnerOrder.amount);
  console.log("Current status:", partnerOrder.status);

  // Idempotency — already credited via verify-payment API?
  if (partnerOrder.status === "paid") {
    console.log(
      "⚠️ Partner recharge already credited (via verify-payment API) — skipping",
    );
    if (eventId) {
      await db.recordWebhookEvent(
        eventId,
        "payment.captured",
        razorpayPaymentId,
        payload,
        "skipped",
      );
    }
    return;
  }

  // Verify amount matches (in paise — no float math)
  const expectedPaise = Math.round(parseFloat(partnerOrder.amount) * 100);
  if (amountPaise !== expectedPaise) {
    const errMsg = `Amount mismatch: expected ${expectedPaise} paise, got ${amountPaise}`;
    console.error("❌", errMsg);
    await db.updatePartnerRechargeOrder(razorpayOrderId, {
      status: "failed",
      errorMessage: errMsg,
    });
    if (eventId) {
      await db.recordWebhookEvent(
        eventId,
        "payment.captured",
        razorpayPaymentId,
        payload,
        "failed",
        errMsg,
      );
    }
    return;
  }

  // Fetch wallet to get org_id (addPartnerWalletRecharge needs it; wallet exists
  // because create-order ensures it)
  const wallet = await db.getPartnerWalletByAuthId(
    partnerOrder.partner_auth_id,
  );
  if (!wallet) {
    const errMsg = "Partner wallet missing — cannot credit via webhook";
    console.error("❌", errMsg);
    if (eventId) {
      await db.recordWebhookEvent(
        eventId,
        "payment.captured",
        razorpayPaymentId,
        payload,
        "failed",
        errMsg,
      );
    }
    return;
  }

  console.log("💳 Crediting partner wallet via webhook...");

  const result = await db.addPartnerWalletRecharge(
    partnerOrder.partner_auth_id,
    wallet.org_id,
    wallet.mobile_number,
    parseFloat(partnerOrder.amount),
    razorpayPaymentId,
    razorpayOrderId,
  );

  console.log("✅ Partner wallet credited via webhook!");
  console.log("New balance: ₹", result.newBalance);
  console.log("Transaction ID:", result.transactionId);

  await db.updatePartnerRechargeOrder(razorpayOrderId, {
    status: "paid",
    razorpayPaymentId,
    walletTransactionId: result.transactionId,
    creditedVia: "webhook",
    webhookReceivedAt: new Date(),
  });

  if (eventId) {
    await db.recordWebhookEvent(
      eventId,
      "payment.captured",
      razorpayPaymentId,
      payload,
      "processed",
    );
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ PARTNER WEBHOOK PROCESSING COMPLETE");
  console.log("Recharge order:", partnerOrder.recharge_order_id);
  console.log("Wallet balance: ₹", result.newBalance);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

// ─────────────────────────────────────────────────────────────────────────────
// payment.failed — route by which table owns the order
// ─────────────────────────────────────────────────────────────────────────────
async function handlePaymentFailed(payload, eventId) {
  const payment = payload?.payload?.payment?.entity;
  const razorpayOrderId = payment?.order_id;
  const razorpayPaymentId = payment?.id;
  const errorDesc = payment?.error_description || "Payment failed";

  console.log(
    "❌ payment.failed —",
    razorpayPaymentId,
    "| Order:",
    razorpayOrderId,
  );

  if (!razorpayOrderId) return;

  // ── Try partner wallet first ────────────────────────────────────────────────
  const partnerOrder =
    await db.getPartnerRechargeOrderByRazorpayId(razorpayOrderId);
  if (partnerOrder) {
    return await handlePartnerPaymentFailed(
      payload,
      eventId,
      partnerOrder,
      razorpayOrderId,
      razorpayPaymentId,
      errorDesc,
    );
  }

  // ── Fall back to user wallet (existing logic) ───────────────────────────────
  const rechargeOrder = await db.getRechargeOrderByRazorpayId(razorpayOrderId);
  if (!rechargeOrder) {
    console.log("ℹ️ Not a wallet recharge — skipping");
    return;
  }

  if (rechargeOrder.status !== "paid") {
    await db.updateRechargeOrder(razorpayOrderId, {
      status: "failed",
      razorpayPaymentId,
      errorMessage: errorDesc,
    });
    console.log(
      "✅ User recharge order marked failed:",
      rechargeOrder.recharge_order_id,
    );
  }

  if (eventId) {
    await db.recordWebhookEvent(
      eventId,
      "payment.failed",
      razorpayPaymentId,
      payload,
      "processed",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// payment.failed for PARTNER WALLET
// ─────────────────────────────────────────────────────────────────────────────
async function handlePartnerPaymentFailed(
  payload,
  eventId,
  partnerOrder,
  razorpayOrderId,
  razorpayPaymentId,
  errorDesc,
) {
  console.log(
    "✅ Found PARTNER recharge order:",
    partnerOrder.recharge_order_id,
  );

  // Only mark failed if not already paid (preserves successful credit if a
  // late .failed event arrives after .captured)
  if (partnerOrder.status !== "paid") {
    await db.updatePartnerRechargeOrder(razorpayOrderId, {
      status: "failed",
      razorpayPaymentId,
      errorMessage: errorDesc,
    });
    console.log(
      "✅ Partner recharge order marked failed:",
      partnerOrder.recharge_order_id,
    );
  } else {
    console.log("⚠️ Partner recharge already paid — not overwriting");
  }

  if (eventId) {
    await db.recordWebhookEvent(
      eventId,
      "payment.failed",
      razorpayPaymentId,
      payload,
      "processed",
    );
  }
}

module.exports = { handleRazorpayWebhook };
