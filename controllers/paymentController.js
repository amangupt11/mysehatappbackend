// controllers/paymentController.js
// ✅ FIXED:
//   1. expires_at enforced in createPayment
//   2. SELECT FOR UPDATE in verifyPayment — prevents duplicate reports on concurrent retries
require("dotenv").config();
const Razorpay = require("razorpay");
const crypto = require("crypto");
const db = require("../config/db");

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * POST /api/orders/:orderId/create-payment
 * Create Razorpay order for payment
 * ✅ FIXED: Allow retry after cancellation/failure
 * ✅ FIXED: Enforce expires_at
 */
async function createPayment(req, res) {
  let connection;
  try {
    const { orderId } = req.params;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("💳 CREATE RAZORPAY PAYMENT");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Order ID:", orderId);

    // 1. Get order details from database
    // ✅ FIXED: Added expires_at to SELECT
    const orderResult = await db.query(
      `SELECT order_id, user_id, mobile_number, test_fee, order_status, payment_status, expires_at
       FROM order_requests 
       WHERE order_id = ?`,
      [orderId],
    );

    console.log("Query result:", orderResult);

    const orderRows = Array.isArray(orderResult[0])
      ? orderResult[0]
      : orderResult;

    if (!orderRows || orderRows.length === 0) {
      console.error("❌ Order not found:", orderId);
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const order = orderRows[0];
    console.log("Order found:", order);
    console.log("Order status:", order.order_status);
    console.log("Payment status:", order.payment_status);
    console.log("Expires at:", order.expires_at);

    // ✅ FIXED: Check expiry BEFORE anything else
    if (new Date(order.expires_at) < new Date()) {
      console.log("❌ Order expired at:", order.expires_at);
      return res.status(400).json({
        success: false,
        message: "Order has expired. Please scan the QR code again.",
      });
    }

    // ✅ Only block if payment is ACTUALLY completed
    if (
      order.order_status === "payment_completed" &&
      order.payment_status === "paid"
    ) {
      console.log("⚠️ Payment already completed for this order");
      return res.status(400).json({
        success: false,
        message: "Payment already completed for this order",
      });
    }

    // ✅ Allow retry if payment was initiated but not completed
    if (
      order.order_status === "payment_link_generated" &&
      order.payment_status !== "paid"
    ) {
      console.log(
        "🔄 Payment was initiated but not completed - allowing retry",
      );
      console.log("Previous status will be updated with new payment attempt");
    }

    // 2. Create Razorpay order
    const amountInPaise = Math.round(order.test_fee * 100);

    const razorpayOrderOptions = {
      amount: amountInPaise,
      currency: "INR",
      receipt: orderId,
      notes: {
        order_id: orderId,
        user_id: order.user_id,
        mobile_number: order.mobile_number,
      },
    };

    console.log("Creating Razorpay order with options:", razorpayOrderOptions);

    const razorpayOrder = await razorpay.orders.create(razorpayOrderOptions);

    console.log("✅ Razorpay order created:", razorpayOrder.id);

    // 3. Update order_requests with NEW Razorpay order details
    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.execute(
      `UPDATE order_requests 
       SET pg_order_id = ?,
           pg_order_status = ?,
           order_status = 'payment_link_generated',
           payment_gateway = 'Razorpay',
           payment_link_generated_at = NOW(),
           updated_at = NOW()
       WHERE order_id = ?`,
      [razorpayOrder.id, razorpayOrder.status, orderId],
    );

    await connection.commit();

    console.log("✅ Order updated with NEW Razorpay details");
    console.log("Previous Razorpay order (if any) has been replaced");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // 4. Return Razorpay order details to frontend
    res.status(200).json({
      success: true,
      message: "Razorpay order created successfully",
      data: {
        razorpay_order_id: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        key_id: process.env.RAZORPAY_KEY_ID,
        order_id: orderId,
        test_fee: order.test_fee,
      },
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("❌ ERROR CREATING PAYMENT");
    console.error("Error:", error.message);
    console.error("Stack:", error.stack);
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    res.status(500).json({
      success: false,
      message: "Failed to create payment",
      error: error.message,
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

/**
 * POST /api/orders/:orderId/verify-payment
 * Verify Razorpay payment signature and generate report
 * ✅ FIXED: SELECT FOR UPDATE inside transaction — prevents duplicate reports
 * ✅ FIXED: rollback before all early returns inside transaction
 */
async function verifyPayment(req, res) {
  let connection;
  try {
    const { orderId } = req.params;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔐 VERIFY RAZORPAY PAYMENT");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Order ID:", orderId);
    console.log("Razorpay Order ID:", razorpay_order_id);
    console.log("Razorpay Payment ID:", razorpay_payment_id);

    // 1. Validate input
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Missing payment verification parameters",
      });
    }

    // 2. Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    const isValidSignature = expectedSignature === razorpay_signature;
    console.log("Signature valid:", isValidSignature);

    if (!isValidSignature) {
      console.error("❌ Invalid payment signature!");
      return res.status(400).json({
        success: false,
        message: "Payment verification failed - invalid signature",
      });
    }

    // 3. Fetch payment method from Razorpay (before transaction — no DB lock needed yet)
    let actualPaymentMethod = "Razorpay";
    try {
      console.log("📡 Fetching payment details from Razorpay...");
      const paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);

      console.log("Razorpay payment details:", {
        method: paymentDetails.method,
        card_id: paymentDetails.card_id,
        bank: paymentDetails.bank,
        wallet: paymentDetails.wallet,
        vpa: paymentDetails.vpa,
      });

      const methodMap = {
        card: "Card",
        netbanking: "NetBanking",
        wallet: "Wallet",
        upi: "UPI",
        emi: "Credit",
        cardless_emi: "Credit",
        paylater: "Credit",
      };

      actualPaymentMethod = methodMap[paymentDetails.method] || "Razorpay";
      console.log("✅ Mapped payment method:", actualPaymentMethod);
    } catch (fetchError) {
      console.error("⚠️ Failed to fetch payment details:", fetchError.message);
      console.log("Using fallback payment method: Razorpay");
    }

    // ✅ FIXED: Start transaction BEFORE reading order — lock row immediately
    // This prevents two concurrent verify calls from both passing the
    // 'payment_completed' check and creating duplicate reports
    connection = await db.getConnection();
    await connection.beginTransaction();

    // ✅ FIXED: SELECT FOR UPDATE — locks the row for this transaction
    // Any other concurrent verifyPayment call will block here until we commit/rollback
    const [orderRows] = await connection.execute(
      `SELECT order_id, user_id, mobile_number, machine_id, test_fee, bmi_data, order_status
       FROM order_requests 
       WHERE order_id = ? AND pg_order_id = ?
       FOR UPDATE`,
      [orderId, razorpay_order_id],
    );

    if (!orderRows || orderRows.length === 0) {
      console.error("❌ Order not found or order ID mismatch");
      await connection.rollback(); // ✅ Release lock before returning
      return res.status(404).json({
        success: false,
        message: "Order not found or order ID mismatch",
      });
    }

    const order = orderRows[0];

    // ✅ SAFE: This check is now protected by FOR UPDATE lock
    // Only one concurrent call can reach here at a time
    if (order.order_status === "payment_completed") {
      console.log("⚠️ Payment already processed for this order");
      await connection.rollback(); // ✅ Release lock before returning
      return res.status(200).json({
        success: true,
        message: "Payment already verified",
        data: { order_id: orderId, already_processed: true },
      });
    }

    console.log("Order details:", order);

    // 4. Parse BMI data
    const bmiData =
      typeof order.bmi_data === "string"
        ? JSON.parse(order.bmi_data)
        : order.bmi_data;

    console.log("BMI Data:", bmiData);

    console.log("💾 Updating order and creating report...");

    // 5. Update order status
    await connection.execute(
      `UPDATE order_requests 
       SET payment_id = ?,
           payment_status = 'paid',
           order_status = 'payment_completed',
           payment_method = ?,
           payment_completed_at = NOW(),
           updated_at = NOW()
       WHERE order_id = ?`,
      [razorpay_payment_id, actualPaymentMethod, orderId],
    );

    console.log("✅ Order status updated");

    // 6. Create report
    const reportId = await db.createReport(
      order.user_id,
      bmiData.height,
      bmiData.weight,
      bmiData.bmi,
      order.machine_id,
      order.test_fee,
      razorpay_payment_id,
      actualPaymentMethod,
    );

    console.log("✅ Report created:", reportId);

    // 7. Update order with report_id
    if (reportId) {
      await connection.execute(
        `UPDATE order_requests 
         SET report_id = ?, 
             report_generated = 1,
             report_generated_at = NOW()
         WHERE order_id = ?`,
        [reportId, orderId],
      );
      console.log("✅ Report linked to order");
    }

    await connection.commit();

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("✅ PAYMENT VERIFIED & REPORT GENERATED");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // 8. Return success
    res.status(200).json({
      success: true,
      message: "Payment verified and report generated successfully",
      data: {
        order_id: orderId,
        report_id: reportId,
        payment_id: razorpay_payment_id,
        payment_method: actualPaymentMethod,
        amount: order.test_fee,
      },
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("❌ ERROR VERIFYING PAYMENT");
    console.error("Error:", error.message);
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    res.status(500).json({
      success: false,
      message: "Failed to verify payment",
      error: error.message,
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// =============================================================================
// POST /api/v1/orders/:orderId/pay-with-wallet
// Deducts test_fee from user's wallet and generates report
// Deduction order: rewards_points first → mysehat_cash
// Uses SELECT FOR UPDATE to prevent race conditions
// =============================================================================
async function payWithWallet(req, res) {
  let connection;
  try {
    const { orderId } = req.params;
    const mobileNumber = req.user.mobileNumber;
    const userId = req.user.userId;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("💳 PAY WITH WALLET");
    console.log("Order ID:", orderId);
    console.log("Mobile:", mobileNumber);
    console.log("User ID:", userId);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // ── 1. Fetch & validate order ─────────────────────────────────────────────
    const orderRows = await db.query(
      `SELECT order_id, user_id, mobile_number, machine_id, test_fee,
              bmi_data, order_status, payment_status, expires_at
       FROM order_requests
       WHERE order_id = ?`,
      [orderId],
    );

    if (!orderRows || orderRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const order = orderRows[0];

    // ── 2. Expiry check ───────────────────────────────────────────────────────
    if (new Date(order.expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        message: "Order has expired. Please scan the QR code again.",
      });
    }

    // ── 3. Already paid check ─────────────────────────────────────────────────
    if (
      order.order_status === "payment_completed" &&
      order.payment_status === "paid"
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment already completed for this order",
      });
    }

    // ── 4. Ownership check ────────────────────────────────────────────────────
    if (order.mobile_number !== mobileNumber) {
      return res.status(403).json({
        success: false,
        message: "You are not authorised to pay for this order",
      });
    }

    const testFee = parseFloat(order.test_fee);

    // ── 5. Check wallet balance (quick pre-check before locking) ──────────────
    const wallet = await db.getWalletByMobile(mobileNumber);

    if (!wallet || parseFloat(wallet.wallet_balance) < testFee) {
      const available = wallet ? parseFloat(wallet.wallet_balance) : 0;
      return res.status(400).json({
        success: false,
        message: "Insufficient wallet balance",
        data: {
          required: testFee,
          available,
          shortfall: parseFloat((testFee - available).toFixed(2)),
        },
      });
    }

    // ── 6. Parse BMI data ─────────────────────────────────────────────────────
    const bmiData =
      typeof order.bmi_data === "string"
        ? JSON.parse(order.bmi_data)
        : order.bmi_data;

    console.log("BMI Data:", bmiData);
    console.log("Test Fee:", testFee);

    // ── 7. Deduct from wallet (handles its own transaction + row lock) ─────────
    const walletTxnId = await db.deductCredits(
      mobileNumber,
      testFee,
      orderId,
      order.machine_id,
    );

    console.log("✅ Wallet deducted. Txn ID:", walletTxnId);

    // ── 8. Create report ──────────────────────────────────────────────────────
    const reportId = await db.createReport(
      order.user_id || userId,
      bmiData.height,
      bmiData.weight,
      bmiData.bmi,
      order.machine_id,
      testFee,
      walletTxnId, // transaction_id in reports table
      "Wallet", // payment_method
    );

    console.log("✅ Report created:", reportId);

    // ── 9. Update order_requests ──────────────────────────────────────────────
    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.execute(
      `UPDATE order_requests
       SET order_status          = 'payment_completed',
           payment_status        = 'paid',
           payment_gateway       = 'Wallet',
           payment_method        = 'Wallet',
           payment_id            = ?,
           payment_completed_at  = NOW(),
           report_id             = ?,
           report_generated      = 1,
           report_generated_at   = NOW(),
           updated_at            = NOW()
       WHERE order_id = ?`,
      [walletTxnId, reportId, orderId],
    );

    await connection.commit();

    console.log("✅ Order updated — payment_gateway: Wallet");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // ── 10. Fetch updated wallet balance to return ────────────────────────────
    const updatedWallet = await db.getWalletByMobile(mobileNumber);

    return res.status(200).json({
      success: true,
      message: "Payment successful via wallet",
      data: {
        order_id: orderId,
        report_id: reportId,
        payment_method: "Wallet",
        amount_paid: testFee,
        transaction_id: walletTxnId,
        wallet: {
          mysehat_cash: parseFloat(updatedWallet.mysehat_cash),
          rewards_points: parseFloat(updatedWallet.rewards_points),
          wallet_balance: parseFloat(updatedWallet.wallet_balance),
        },
      },
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (e) {
        console.error("Rollback error", e);
      }
    }

    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("❌ ERROR IN payWithWallet");
    console.error("Error:", error.message);
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Surface insufficient balance clearly to frontend
    if (error.message.includes("Insufficient wallet balance")) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to process wallet payment",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
}

module.exports = {
  createPayment,
  verifyPayment,
  payWithWallet,
};