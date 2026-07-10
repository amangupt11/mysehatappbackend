// config/db.js
require("dotenv").config();
const mysql = require("mysql2/promise");

// ─── Connection Pool ──────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  timezone: "+05:30", // IST — converts JS Date objects correctly
});

// ─── Base query helper ────────────────────────────────────────────────────────
async function query(sql, params) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (error) {
    console.error("Database query error:", error);
    throw error;
  }
}

// =============================================================================
// WALLET ID GENERATOR
// =============================================================================

function generateWalletId() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no confusing chars
  let result = "WLT_";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// =============================================================================
// RECHARGE ORDER ID GENERATOR
// =============================================================================

function generateRechargeOrderId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const random = Math.floor(Math.random() * 999999)
    .toString()
    .padStart(6, "0");
  return `WRO${mm}${yy}${random}`;
}

// =============================================================================
// REWARD TIER CALCULATOR
// Hardcoded tiers matching WalletScreen UI
// =============================================================================

const REWARD_TIERS = { 100: 20, 200: 50, 500: 120, 1000: 250 };

function calculateRewardAmount(cashAmount) {
  return REWARD_TIERS[cashAmount] !== undefined
    ? REWARD_TIERS[cashAmount]
    : Math.floor(cashAmount * 0.05);
}

// =============================================================================
// USER MANAGEMENT
// =============================================================================

async function getAllUsersByMobile(mobileNumber) {
  return await query(
    `SELECT user_id, mobile_number, full_name, email, age, gender,
            profile_image, user_type
     FROM users
     WHERE mobile_number = ?
     ORDER BY user_type DESC, created_at ASC`,
    [mobileNumber],
  );
}

async function getUserById(userId) {
  const users = await query(
    `SELECT user_id, mobile_number, full_name, email, age, gender,
            profile_image, user_type
     FROM users WHERE user_id = ?`,
    [userId],
  );
  return users.length > 0 ? users[0] : null;
}

async function createNewUser(
  mobileNumber,
  fullName,
  age,
  gender,
  userType = null,
) {
  try {
    console.log("Creating new user:", {
      mobileNumber,
      fullName,
      age,
      gender,
      userType,
    });

    let finalUserType = userType;
    if (!finalUserType) {
      const existingUsers = await query(
        "SELECT COUNT(*) as count FROM users WHERE mobile_number = ?",
        [mobileNumber],
      );
      finalUserType = existingUsers[0].count === 0 ? "SuperUser" : "FamilyUser";
      console.log(`Auto-determined user type: ${finalUserType}`);
    }

    await query(
      "INSERT INTO users (mobile_number, full_name, age, gender, user_type) VALUES (?, ?, ?, ?, ?)",
      [mobileNumber, fullName, age, gender, finalUserType],
    );

    const users = await query(
      `SELECT user_id FROM users
       WHERE mobile_number = ? AND full_name = ?
       ORDER BY created_at DESC LIMIT 1`,
      [mobileNumber, fullName],
    );

    if (users.length === 0)
      throw new Error("Failed to retrieve newly created user");

    console.log("User created:", users[0].user_id, "| Type:", finalUserType);
    return users[0];
  } catch (error) {
    console.error("Error creating new user:", error);
    throw error;
  }
}

// =============================================================================
// REPORT MANAGEMENT
// =============================================================================

function calculateBmiStatus(bmi) {
  if (bmi < 18.5) return "Underweight";
  if (bmi < 25) return "Normal";
  if (bmi < 30) return "Overweight";
  return "Obese";
}

async function createReport(
  userId,
  height,
  weight,
  bmi,
  machineId,
  fee,
  transactionId,
  paymentMethod,
) {
  try {
    console.log("Creating report:", {
      userId,
      height,
      weight,
      bmi,
      machineId,
      fee,
      transactionId,
      paymentMethod,
    });

    const bmiStatus = calculateBmiStatus(bmi);

    await query(
      `INSERT INTO reports
         (user_id, report_date, height, weight, bmi_status, machine_id,
          fee, transaction_id, payment_method)
       VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        height,
        weight,
        bmiStatus,
        machineId,
        fee,
        transactionId,
        paymentMethod,
      ],
    );

    const reports = await query(
      `SELECT report_id FROM reports
       WHERE user_id = ? AND machine_id = ?
       ORDER BY report_date DESC LIMIT 1`,
      [userId, machineId],
    );

    const reportId = reports.length > 0 ? reports[0].report_id : null;
    console.log("Report created:", reportId);
    return reportId;
  } catch (error) {
    console.error("Error creating report:", error.message);
    throw error;
  }
}

// =============================================================================
// DEMOGRAPHICS HELPERS
// =============================================================================

async function hasDemographics(mobileNumber) {
  try {
    const users = await query(
      `SELECT user_id FROM users
       WHERE mobile_number = ? AND full_name != 'Unknown'`,
      [mobileNumber],
    );
    const result = users.length > 0;
    console.log("hasDemographics:", { mobileNumber, result });
    return result;
  } catch (error) {
    console.error("Error checking demographics:", error);
    return false;
  }
}

async function updateUserDemographics(userId, name, age, gender) {
  try {
    console.log("Updating demographics:", { userId, name, age, gender });
    await query(
      `UPDATE users SET full_name = ?, age = ?, gender = ? WHERE user_id = ?`,
      [name, age, gender, userId],
    );
    console.log("Demographics updated for user:", userId);
  } catch (error) {
    console.error("Error updating demographics:", error);
    throw error;
  }
}

// =============================================================================
// WALLET — READ
// =============================================================================

/**
 * Get wallet by mobile number
 * Returns null if wallet doesn't exist yet
 */
async function getWalletByMobile(mobileNumber) {
  const rows = await query(
    `SELECT wallet_id, mobile_number, wallet_balance,
            mysehat_cash, rewards_points, created_at, updated_at
     FROM mobile_wallets
     WHERE mobile_number = ?`,
    [mobileNumber],
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Get paginated wallet transaction history
 */
// ✅ NEW
async function getWalletTransactions(mobileNumber, limit = 20, offset = 0) {
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 500)) | 0;
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0) | 0;

  return await query(
    `SELECT id, transaction_type, amount_rupees, credits, balance_after,
            transaction_id, razorpay_payment_id, description, created_at
     FROM wallet_transactions
     WHERE mobile_number = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [mobileNumber],
  );
}

// =============================================================================
// WALLET — WRITE: addWalletRecharge
// Credits wallet after successful Razorpay payment
// Keeps mysehat_cash and rewards_points in SEPARATE buckets
// wallet_balance = mysehat_cash + rewards_points (always in sync)
// =============================================================================

async function addWalletRecharge(
  mobileNumber,
  cashAmount,
  rewardAmount,
  razorpayPaymentId,
  razorpayOrderId = null,
) {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── 1. Lock or create wallet ──────────────────────────────────────────────
    const [walletRows] = await connection.execute(
      `SELECT wallet_id, wallet_balance, mysehat_cash, rewards_points
       FROM mobile_wallets
       WHERE mobile_number = ?
       FOR UPDATE`,
      [mobileNumber],
    );

    let wallet;
    if (walletRows.length === 0) {
      const walletId = generateWalletId();
      await connection.execute(
        `INSERT INTO mobile_wallets
           (wallet_id, mobile_number, wallet_balance, mysehat_cash, rewards_points)
         VALUES (?, ?, 0.00, 0.00, 0.00)`,
        [walletId, mobileNumber],
      );
      wallet = {
        wallet_id: walletId,
        wallet_balance: 0,
        mysehat_cash: 0,
        rewards_points: 0,
      };
    } else {
      wallet = walletRows[0];
    }

    const newCash = parseFloat(
      (parseFloat(wallet.mysehat_cash) + cashAmount).toFixed(2),
    );
    const newRewards = parseFloat(
      (parseFloat(wallet.rewards_points) + rewardAmount).toFixed(2),
    );
    const newBalance = parseFloat((newCash + newRewards).toFixed(2));

    console.log("💰 addWalletRecharge:", {
      mobileNumber,
      cashAmount,
      rewardAmount,
      newCash,
      newRewards,
      newBalance,
    });

    // ── 2. Update wallet buckets ──────────────────────────────────────────────
    await connection.execute(
      `UPDATE mobile_wallets
       SET mysehat_cash   = ?,
           rewards_points = ?,
           wallet_balance = ?,
           updated_at     = NOW()
       WHERE wallet_id = ?`,
      [newCash, newRewards, newBalance, wallet.wallet_id],
    );

    // ── 3. Log cash transaction (only if cashAmount > 0) ─────────────────────
    const cashTxnId = `TXN_CREDIT_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (cashAmount > 0) {
      await connection.execute(
        `INSERT INTO wallet_transactions
           (wallet_id, mobile_number, transaction_type, amount_rupees, credits,
            balance_after, transaction_id, razorpay_payment_id, razorpay_order_id,
            amount_paid, description)
         VALUES (?, ?, 'credit_purchase', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          wallet.wallet_id,
          mobileNumber,
          cashAmount, // amount_rupees
          cashAmount, // credits
          newBalance,
          cashTxnId,
          razorpayPaymentId,
          razorpayOrderId,
          cashAmount,
          `Wallet recharge - ₹${cashAmount}`,
        ],
      );
    }

    // ── 4. Log reward transaction (only if rewardAmount > 0) ─────────────────
    if (rewardAmount > 0) {
      const rewardTxnId = `TXN_REWARD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      await connection.execute(
        `INSERT INTO wallet_transactions
           (wallet_id, mobile_number, transaction_type, amount_rupees, credits,
            balance_after, transaction_id, razorpay_payment_id, razorpay_order_id,
            amount_paid, description)
         VALUES (?, ?, 'credit_purchase', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          wallet.wallet_id,
          mobileNumber,
          0, // amount_rupees = 0 (reward is free)
          rewardAmount, // credits = reward value
          newBalance,
          rewardTxnId,
          razorpayPaymentId,
          razorpayOrderId,
          0,
          cashAmount > 0
            ? `Reward bonus for ₹${cashAmount} recharge`
            : `Reward credits - ${rewardAmount} credits`,
        ],
      );
    }

    await connection.commit();

    console.log(
      `✅ addWalletRecharge complete — Cash: ₹${newCash} | Rewards: ₹${newRewards} | Total: ₹${newBalance}`,
    );
    return { transactionId: cashTxnId, newBalance, newCash, newRewards };
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (e) {
        console.error("Rollback failed:", e);
      }
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

// =============================================================================
// WALLET — WRITE: deductCredits
// Deducts BMI test fee from wallet
// Deduction order: rewards_points first → then mysehat_cash
// Uses SELECT FOR UPDATE to prevent race conditions
// =============================================================================

async function deductCredits(mobileNumber, amountToDeduct, orderId, machineId) {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── 1. Lock wallet row ────────────────────────────────────────────────────
    const [walletRows] = await connection.execute(
      `SELECT wallet_id, wallet_balance, mysehat_cash, rewards_points
       FROM mobile_wallets
       WHERE mobile_number = ?
       FOR UPDATE`,
      [mobileNumber],
    );

    if (walletRows.length === 0) {
      throw new Error("Wallet not found for this mobile number");
    }

    const wallet = walletRows[0];
    const currentBalance = parseFloat(wallet.wallet_balance);
    const currentRewards = parseFloat(wallet.rewards_points);
    const currentCash = parseFloat(wallet.mysehat_cash);

    console.log("💰 deductCredits:", {
      mobileNumber,
      amountToDeduct,
      currentBalance,
      currentRewards,
      currentCash,
    });

    // ── 2. Sufficient balance check ───────────────────────────────────────────
    if (currentBalance < amountToDeduct) {
      throw new Error(
        `Insufficient wallet balance. Available: ₹${currentBalance}, Required: ₹${amountToDeduct}`,
      );
    }

    // ── 3. Deduction logic: rewards first, then cash ──────────────────────────
    let rewardsDeducted = 0;
    let cashDeducted = 0;
    let remaining = amountToDeduct;

    if (currentRewards >= remaining) {
      rewardsDeducted = remaining;
      remaining = 0;
    } else {
      rewardsDeducted = currentRewards;
      remaining -= currentRewards;
      cashDeducted = remaining;
      remaining = 0;
    }

    const newRewards = parseFloat(
      (currentRewards - rewardsDeducted).toFixed(2),
    );
    const newCash = parseFloat((currentCash - cashDeducted).toFixed(2));
    const newBalance = parseFloat((newCash + newRewards).toFixed(2));

    console.log("💸 Deduction breakdown:", {
      rewardsDeducted,
      cashDeducted,
      newRewards,
      newCash,
      newBalance,
    });

    // ── 4. Update wallet ──────────────────────────────────────────────────────
    const [updateResult] = await connection.execute(
      `UPDATE mobile_wallets
       SET wallet_balance  = ?,
           mysehat_cash    = ?,
           rewards_points  = ?,
           updated_at      = NOW()
       WHERE wallet_id = ?`,
      [newBalance, newCash, newRewards, wallet.wallet_id],
    );

    if (updateResult.affectedRows !== 1) {
      throw new Error("Failed to update wallet balance");
    }

    // ── 5. Log wallet_transaction ─────────────────────────────────────────────
    const transactionId = `TXN_USE_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const [insertResult] = await connection.execute(
      `INSERT INTO wallet_transactions
         (wallet_id, mobile_number, transaction_type, amount_rupees, credits,
          balance_after, transaction_id, machine_id, actual_fee_rupees,
          amount_paid, description)
       VALUES (?, ?, 'credit_usage', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        wallet.wallet_id,
        mobileNumber,
        amountToDeduct, // amount_rupees
        amountToDeduct, // credits debited
        newBalance,
        transactionId,
        machineId,
        amountToDeduct, // actual_fee_rupees
        amountToDeduct, // amount_paid
        `BMI test payment - Order ${orderId}`,
      ],
    );

    if (insertResult.affectedRows !== 1) {
      throw new Error("Failed to log wallet transaction");
    }

    await connection.commit();

    console.log(`✅ Deducted ₹${amountToDeduct} — New balance: ₹${newBalance}`);
    return transactionId;
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (e) {
        console.error("Rollback failed:", e);
      }
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

// =============================================================================
// WALLET — RECHARGE ORDER TRACKING
// =============================================================================

async function createRechargeOrder(
  mobileNumber,
  userId,
  cashAmount,
  rewardAmount,
  razorpayOrderId,
) {
  const rechargeOrderId = generateRechargeOrderId();
  const totalAmount = parseFloat((cashAmount + rewardAmount).toFixed(2));

  await query(
    `INSERT INTO wallet_recharge_orders
       (recharge_order_id, mobile_number, user_id, cash_amount, reward_amount,
        total_amount, razorpay_order_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      rechargeOrderId,
      mobileNumber,
      userId || null,
      cashAmount,
      rewardAmount,
      totalAmount,
      razorpayOrderId,
    ],
  );

  console.log("✅ Recharge order created:", rechargeOrderId);
  return rechargeOrderId;
}

async function updateRechargeOrder(
  razorpayOrderId,
  {
    status,
    razorpayPaymentId = null,
    razorpaySignature = null,
    walletTransactionId = null,
    creditedVia = null,
    errorMessage = null,
    webhookReceivedAt = null,
  },
) {
  await query(
    `UPDATE wallet_recharge_orders
     SET status                = ?,
         razorpay_payment_id   = COALESCE(?, razorpay_payment_id),
         razorpay_signature    = COALESCE(?, razorpay_signature),
         wallet_transaction_id = COALESCE(?, wallet_transaction_id),
         credited_via          = COALESCE(?, credited_via),
         error_message         = COALESCE(?, error_message),
         webhook_received_at   = COALESCE(?, webhook_received_at),
         updated_at            = NOW()
     WHERE razorpay_order_id = ?`,
    [
      status,
      razorpayPaymentId,
      razorpaySignature,
      walletTransactionId,
      creditedVia,
      errorMessage,
      webhookReceivedAt,
      razorpayOrderId,
    ],
  );
}

async function getRechargeOrderByRazorpayId(razorpayOrderId) {
  const rows = await query(
    `SELECT * FROM wallet_recharge_orders
     WHERE razorpay_order_id = ? LIMIT 1`,
    [razorpayOrderId],
  );
  return rows.length > 0 ? rows[0] : null;
}

// =============================================================================
// WEBHOOK IDEMPOTENCY
// =============================================================================

async function isWebhookAlreadyProcessed(eventId) {
  const rows = await query(
    `SELECT id FROM webhook_events WHERE event_id = ? LIMIT 1`,
    [eventId],
  );
  return rows.length > 0;
}

async function recordWebhookEvent(
  eventId,
  eventType,
  entityId,
  payload,
  status = "processed",
  errorMessage = null,
) {
  try {
    await query(
      `INSERT INTO webhook_events
         (event_id, event_type, entity_id, payload, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status)`,
      [
        eventId,
        eventType,
        entityId,
        JSON.stringify(payload),
        status,
        errorMessage,
      ],
    );
  } catch (err) {
    // Non-fatal — log but don't crash webhook handler
    console.error("⚠️ Failed to record webhook event:", err.message);
  }
}

// =============================================================================
// REWARD CREDITS (called from waAuthController.completeProfile)
// Uses addWalletRecharge with rewardAmount only (cashAmount = 0)
// =============================================================================

async function giveRewardCredits(mobileNumber, credits) {
  try {
    console.log("🎁 giveRewardCredits:", { mobileNumber, credits });

    const result = await addWalletRecharge(
      mobileNumber,
      0, // cashAmount = 0 (reward is free)
      credits, // rewardAmount = bonus credits
      "REWARD_DEMOGRAPHICS", // special payment ID to identify rewards
      null, // no razorpay order ID
    );

    console.log("✅ Reward credits added. New balance:", result.newBalance);
    return result.transactionId;
  } catch (error) {
    console.error("❌ giveRewardCredits error:", error.message);
    throw error;
  }
}

// =============================================================================
// PARTNER STACK — ATOMIC COUNTER (race-safe, used by MMYY-scoped IDs)
// =============================================================================

/**
 * Atomic counter using InnoDB row-lock via INSERT…ON DUPLICATE KEY UPDATE.
 * Safe under concurrent calls — MySQL guarantees only one increment wins per row.
 * Used by PWR_MMYY_xxxxxx and MRC_MMYY_xxxxxx generators.
 */
async function nextSequence(seqName, period) {
  await query(
    `INSERT INTO partner_id_sequences (seq_name, period, current_value)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE current_value = current_value + 1`,
    [seqName, period],
  );

  const rows = await query(
    `SELECT current_value FROM partner_id_sequences
     WHERE seq_name = ? AND period = ?
     LIMIT 1`,
    [seqName, period],
  );

  return rows[0].current_value;
}

// =============================================================================
// PARTNER WALLET — ID GENERATORS
// =============================================================================

/** PWL-XXXXXXXX — 8 random chars, no confusable 0/O/1/I/L. Synchronous. */
function generatePartnerWalletId() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let result = "PWL-";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** PWR_MMYY_xxxxxx — sequential, race-safe via atomic counter. */
async function generatePartnerRechargeOrderId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const seq = await nextSequence("partner_recharge_orders", `${mm}${yy}`);
  return `PWR_${mm}${yy}_${String(seq).padStart(6, "0")}`;
}

/** PWT_<PREFIX>_<ts>_<rand9> — high-volume correlation ID, no counter needed. */
function generatePartnerTransactionId(prefix = "CREDIT") {
  return `PWT_${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// =============================================================================
// PARTNER WALLET — READ
// =============================================================================

/** Get partner wallet by auth_id. Returns null if wallet doesn't exist yet. */
async function getPartnerWalletByAuthId(partnerAuthId) {
  const rows = await query(
    `SELECT partner_wallet_id, partner_auth_id, org_id, mobile_number,
            wallet_balance, status, created_at, updated_at
     FROM   partner_wallets
     WHERE  partner_auth_id = ?
     LIMIT  1`,
    [partnerAuthId],
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Paginated ledger for one partner wallet, newest first. */
async function getPartnerWalletTransactions(
  partnerWalletId,
  limit = 20,
  offset = 0,
) {
  const safeLimit = String(
    Math.max(1, Math.min(parseInt(limit, 10) || 20, 100)),
  );
  const safeOffset = String(Math.max(0, parseInt(offset, 10) || 0));

  return await query(
    `SELECT id, transaction_id, transaction_type, amount_rupees, balance_after,
            reference_id, razorpay_payment_id, description, created_at
     FROM   partner_wallet_transactions
     WHERE  partner_wallet_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [partnerWalletId],
  );
}

// =============================================================================
// PARTNER WALLET — WRITE: addPartnerWalletRecharge
// Credits partner wallet after successful Razorpay top-up.
// - Lazily creates wallet if missing (mirrors user-side addWalletRecharge)
// - SELECT FOR UPDATE prevents race conditions
// - Atomic: balance update + ledger row in one transaction
// =============================================================================

async function addPartnerWalletRecharge(
  partnerAuthId,
  orgId,
  mobileNumber,
  cashAmount,
  razorpayPaymentId,
  razorpayOrderId = null,
) {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── 1. Lock or create wallet ──────────────────────────────────────────────
    const [walletRows] = await connection.execute(
      `SELECT partner_wallet_id, wallet_balance, status
       FROM partner_wallets
       WHERE partner_auth_id = ?
       FOR UPDATE`,
      [partnerAuthId],
    );

    let wallet;
    if (walletRows.length === 0) {
      const partnerWalletId = generatePartnerWalletId();
      await connection.execute(
        `INSERT INTO partner_wallets
           (partner_wallet_id, partner_auth_id, org_id, mobile_number,
            wallet_balance, status)
         VALUES (?, ?, ?, ?, 0.00, 'active')`,
        [partnerWalletId, partnerAuthId, orgId, mobileNumber],
      );
      wallet = {
        partner_wallet_id: partnerWalletId,
        wallet_balance: 0,
        status: "active",
      };
      console.log("✅ Partner wallet created:", partnerWalletId);
    } else {
      wallet = walletRows[0];
      if (wallet.status !== "active") {
        throw new Error(`Partner wallet is ${wallet.status} — cannot credit`);
      }
    }

    const newBalance = parseFloat(
      (parseFloat(wallet.wallet_balance) + cashAmount).toFixed(2),
    );

    console.log("💰 addPartnerWalletRecharge:", {
      partnerAuthId,
      cashAmount,
      newBalance,
    });

    // ── 2. Look up our recharge_order_id for the ledger reference ─────────────
    let referenceId = null;
    if (razorpayOrderId) {
      const [orderRows] = await connection.execute(
        `SELECT recharge_order_id FROM partner_wallet_recharge_orders
         WHERE razorpay_order_id = ? LIMIT 1`,
        [razorpayOrderId],
      );
      if (orderRows.length > 0) {
        referenceId = orderRows[0].recharge_order_id;
      }
    }

    // ── 3. Update balance ─────────────────────────────────────────────────────
    await connection.execute(
      `UPDATE partner_wallets
       SET wallet_balance = ?,
           updated_at     = NOW()
       WHERE partner_wallet_id = ?`,
      [newBalance, wallet.partner_wallet_id],
    );

    // ── 4. Insert ledger entry ────────────────────────────────────────────────
    const transactionId = generatePartnerTransactionId("CREDIT");

    await connection.execute(
      `INSERT INTO partner_wallet_transactions
         (transaction_id, partner_wallet_id, partner_auth_id, transaction_type,
          amount_rupees, balance_after, reference_id, razorpay_payment_id, description)
       VALUES (?, ?, ?, 'credit_purchase', ?, ?, ?, ?, ?)`,
      [
        transactionId,
        wallet.partner_wallet_id,
        partnerAuthId,
        cashAmount,
        newBalance,
        referenceId,
        razorpayPaymentId,
        `Wallet top-up - ₹${cashAmount}`,
      ],
    );

    await connection.commit();

    console.log(
      `✅ Partner wallet credited ₹${cashAmount} — New balance: ₹${newBalance}`,
    );

    return {
      transactionId,
      partnerWalletId: wallet.partner_wallet_id,
      newBalance,
    };
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (e) {
        console.error("Rollback failed:", e);
      }
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

// =============================================================================
// PARTNER WALLET — RECHARGE ORDER TRACKING
// =============================================================================

async function createPartnerRechargeOrder(
  partnerWalletId,
  partnerAuthId,
  mobileNumber,
  amount,
  razorpayOrderId,
) {
  // ⚠️ Now async because the ID generator uses an atomic counter
  const rechargeOrderId = await generatePartnerRechargeOrderId();

  await query(
    `INSERT INTO partner_wallet_recharge_orders
       (recharge_order_id, partner_wallet_id, partner_auth_id, mobile_number,
        amount, razorpay_order_id, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [
      rechargeOrderId,
      partnerWalletId,
      partnerAuthId,
      mobileNumber,
      amount,
      razorpayOrderId,
    ],
  );

  console.log("✅ Partner recharge order created:", rechargeOrderId);
  return rechargeOrderId;
}

async function updatePartnerRechargeOrder(
  razorpayOrderId,
  {
    status,
    razorpayPaymentId = null,
    razorpaySignature = null,
    walletTransactionId = null,
    creditedVia = null,
    errorMessage = null,
    webhookReceivedAt = null,
  },
) {
  await query(
    `UPDATE partner_wallet_recharge_orders
     SET status                = ?,
         razorpay_payment_id   = COALESCE(?, razorpay_payment_id),
         razorpay_signature    = COALESCE(?, razorpay_signature),
         wallet_transaction_id = COALESCE(?, wallet_transaction_id),
         credited_via          = COALESCE(?, credited_via),
         error_message         = COALESCE(?, error_message),
         webhook_received_at   = COALESCE(?, webhook_received_at),
         updated_at            = NOW()
     WHERE razorpay_order_id = ?`,
    [
      status,
      razorpayPaymentId,
      razorpaySignature,
      walletTransactionId,
      creditedVia,
      errorMessage,
      webhookReceivedAt,
      razorpayOrderId,
    ],
  );
}

async function getPartnerRechargeOrderByRazorpayId(razorpayOrderId) {
  const rows = await query(
    `SELECT * FROM partner_wallet_recharge_orders
     WHERE razorpay_order_id = ? LIMIT 1`,
    [razorpayOrderId],
  );
  return rows.length > 0 ? rows[0] : null;
}

// =============================================================================
// MACHINE RECHARGE — ID GENERATOR
// =============================================================================

/** MRC_MMYY_xxxxxx — sequential, race-safe via shared atomic counter. */
async function generateMachineRechargeId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const seq = await nextSequence("machine_recharges", `${mm}${yy}`);
  return `MRC_${mm}${yy}_${String(seq).padStart(6, "0")}`;
}

// =============================================================================
// MACHINE RECHARGE — CREATE (initiate, NO wallet debit)
// =============================================================================

/**
 * Logs the recharge attempt before any BT communication.
 * Returns the recharge_id, which the app uses to later call confirm/fail.
 * bt_status starts as 'initiated'. Wallet is NOT touched here.
 */
async function createMachineRecharge(
  partnerAuthId,
  partnerWalletId,
  orgId,
  btDeviceAddress,
  btDeviceName,
  amountRupees,
  unitPriceSnapshot,
  unitsSent,
) {
  const rechargeId = await generateMachineRechargeId();

  await query(
    `INSERT INTO machine_recharges
       (recharge_id, partner_auth_id, partner_wallet_id, org_id,
        bt_device_address, bt_device_name,
        amount_rupees, unit_price_snapshot, units_sent,
        bt_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'initiated')`,
    [
      rechargeId,
      partnerAuthId,
      partnerWalletId,
      orgId,
      btDeviceAddress,
      btDeviceName || null,
      amountRupees,
      unitPriceSnapshot,
      unitsSent,
    ],
  );

  console.log("✅ Machine recharge initiated:", rechargeId);
  return rechargeId;
}

// =============================================================================
// MACHINE RECHARGE — CONFIRM (BT ACK received, debit wallet atomically)
//
// THIS IS THE CRITICAL SAFETY FUNCTION.
// All checks happen inside ONE transaction with FOR UPDATE row locks:
//   1. Recharge must exist AND be in 'initiated' state (idempotency)
//   2. Wallet must exist AND be 'active'
//   3. Wallet balance must be ≥ amount (cannot go negative)
// If ANY check fails → throw → rollback → wallet untouched.
// Concurrent confirms on the same recharge: only one wins, other throws.
// Concurrent confirms on different recharges of same wallet: serialize on wallet lock.
// =============================================================================

async function confirmMachineRecharge(rechargeId) {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── 1. Lock the recharge row + idempotency guard ─────────────────────────
    const [rechargeRows] = await connection.execute(
      `SELECT recharge_id, partner_auth_id, partner_wallet_id, org_id,
              bt_device_address, bt_device_name,
              amount_rupees, unit_price_snapshot, units_sent, bt_status
       FROM   machine_recharges
       WHERE  recharge_id = ?
       FOR UPDATE`,
      [rechargeId],
    );

    if (rechargeRows.length === 0) {
      throw new Error(`Machine recharge not found: ${rechargeId}`);
    }

    const recharge = rechargeRows[0];

    if (recharge.bt_status !== "initiated") {
      throw new Error(
        `Cannot confirm — recharge is in state '${recharge.bt_status}', expected 'initiated'`,
      );
    }

    // ── 2. Lock the wallet + verify status + check balance ───────────────────
    const [walletRows] = await connection.execute(
      `SELECT partner_wallet_id, wallet_balance, status
       FROM   partner_wallets
       WHERE  partner_wallet_id = ?
       FOR UPDATE`,
      [recharge.partner_wallet_id],
    );

    if (walletRows.length === 0) {
      throw new Error(
        `Partner wallet not found: ${recharge.partner_wallet_id}`,
      );
    }

    const wallet = walletRows[0];
    if (wallet.status !== "active") {
      throw new Error(`Partner wallet is ${wallet.status} — cannot debit`);
    }

    const amount = parseFloat(recharge.amount_rupees);
    const currentBalance = parseFloat(wallet.wallet_balance);

    if (currentBalance < amount) {
      throw new Error(
        `Insufficient wallet balance. Required ₹${amount}, available ₹${currentBalance}`,
      );
    }

    const newBalance = parseFloat((currentBalance - amount).toFixed(2));

    console.log("💳 confirmMachineRecharge:", {
      rechargeId,
      amount,
      newBalance,
    });

    // ── 3. Update recharge row → ack_received ────────────────────────────────
    await connection.execute(
      `UPDATE machine_recharges
       SET bt_status  = 'ack_received',
           bt_ack_at  = NOW(),
           updated_at = NOW()
       WHERE recharge_id = ?`,
      [rechargeId],
    );

    // ── 4. Insert ledger debit ───────────────────────────────────────────────
    const transactionId = generatePartnerTransactionId("DEBIT");

    await connection.execute(
      `INSERT INTO partner_wallet_transactions
         (transaction_id, partner_wallet_id, partner_auth_id, transaction_type,
          amount_rupees, balance_after, reference_id, description)
       VALUES (?, ?, ?, 'kiosk_recharge', ?, ?, ?, ?)`,
      [
        transactionId,
        recharge.partner_wallet_id,
        recharge.partner_auth_id,
        amount,
        newBalance,
        rechargeId,
        `Kiosk recharge: ${parseFloat(recharge.units_sent)} units to ${recharge.bt_device_name || recharge.bt_device_address}`,
      ],
    );

    // ── 5. Decrement wallet balance ──────────────────────────────────────────
    await connection.execute(
      `UPDATE partner_wallets
       SET wallet_balance = ?,
           updated_at     = NOW()
       WHERE partner_wallet_id = ?`,
      [newBalance, recharge.partner_wallet_id],
    );

    // ── 6. Link recharge row → ledger transaction ────────────────────────────
    await connection.execute(
      `UPDATE machine_recharges
       SET wallet_transaction_id = ?
       WHERE recharge_id = ?`,
      [transactionId, rechargeId],
    );

    await connection.commit();

    console.log(
      `✅ Machine recharge confirmed ${rechargeId} → ₹${amount} debited. New balance: ₹${newBalance}`,
    );

    return {
      transactionId,
      newBalance,
      amountDebited: amount,
      unitsSent: parseFloat(recharge.units_sent),
    };
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (e) {
        console.error("Rollback failed:", e);
      }
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

// =============================================================================
// MACHINE RECHARGE — FAIL (BT timeout or error, NO wallet debit)
// =============================================================================

/**
 * Marks the recharge as ack_timeout or failed.
 * Wallet is never touched. Idempotency: only acts if currently 'initiated'.
 */
async function failMachineRecharge(rechargeId, btStatus, errorMessage = null) {
  if (!["ack_timeout", "failed"].includes(btStatus)) {
    throw new Error(
      `Invalid bt_status: ${btStatus}. Must be ack_timeout or failed.`,
    );
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT bt_status FROM machine_recharges
       WHERE recharge_id = ?
       FOR UPDATE`,
      [rechargeId],
    );

    if (rows.length === 0) {
      throw new Error(`Machine recharge not found: ${rechargeId}`);
    }

    if (rows[0].bt_status !== "initiated") {
      throw new Error(
        `Cannot mark ${btStatus} — recharge is in state '${rows[0].bt_status}', expected 'initiated'`,
      );
    }

    await connection.execute(
      `UPDATE machine_recharges
       SET bt_status     = ?,
           error_message = ?,
           updated_at    = NOW()
       WHERE recharge_id = ?`,
      [btStatus, errorMessage, rechargeId],
    );

    await connection.commit();

    console.log(`⚠️ Machine recharge marked ${btStatus}: ${rechargeId}`);
    return { status: btStatus };
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (e) {
        console.error("Rollback failed:", e);
      }
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

// =============================================================================
// MACHINE RECHARGE — READ
// =============================================================================

async function getMachineRechargeById(rechargeId) {
  const rows = await query(
    `SELECT id, recharge_id, partner_auth_id, partner_wallet_id, org_id,
            bt_device_address, bt_device_name,
            amount_rupees, unit_price_snapshot, units_sent,
            bt_status, bt_ack_at, error_message,
            wallet_transaction_id, created_at, updated_at
     FROM   machine_recharges
     WHERE  recharge_id = ?
     LIMIT  1`,
    [rechargeId],
  );
  return rows.length > 0 ? rows[0] : null;
}

async function getMachineRechargesByPartner(
  partnerAuthId,
  limit = 20,
  offset = 0,
) {
  const safeLimit = String(
    Math.max(1, Math.min(parseInt(limit, 10) || 20, 100)),
  );
  const safeOffset = String(Math.max(0, parseInt(offset, 10) || 0));

  return await query(
    `SELECT id, recharge_id, bt_device_address, bt_device_name,
            amount_rupees, unit_price_snapshot, units_sent,
            bt_status, bt_ack_at, error_message,
            wallet_transaction_id, created_at
     FROM   machine_recharges
     WHERE  partner_auth_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [partnerAuthId],
  );
}

// =============================================================================
// PARTNER BMI REPORTS — ID GENERATOR
// =============================================================================

/** PBR_MMYY_xxxxxx — sequential, race-safe via shared atomic counter. */
async function generatePartnerBmiReportId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const seq = await nextSequence("partner_bmi_reports", `${mm}${yy}`);
  return `PBR_${mm}${yy}_${String(seq).padStart(6, "0")}`;
}

// =============================================================================
// PARTNER BMI REPORTS — CREATE (idempotent on client_uuid)
// =============================================================================

/**
 * Insert a new BMI report from a partner's kiosk save.
 *   • Idempotency: if client_uuid already exists → returns EXISTING row with
 *     is_duplicate=true. No new insert, no error. Safe for RN retries.
 *   • Race-safe: SELECT ... FOR UPDATE gap-locks the client_uuid range so
 *     two concurrent POSTs of the same UUID can't both insert.
 *   • Sequential report_id via nextSequence().
 *
 * Called by controllers/partnerBmiReportController.create.
 */
async function createPartnerBmiReport({
  clientUuid,
  partnerAuthId,
  orgId,
  heightCm,
  weightKg,
  bmi,
  bmiStatus,
  fatPercent,
  gender,
  age,
  patientName,
  mobile,
  btDeviceAddress,
  btDeviceName,
  dataSource,
  capturedAt,
}) {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── 1. Idempotency check — has this client_uuid been seen? ───────────────
    const [existing] = await connection.execute(
      `SELECT id, report_id, client_uuid, partner_auth_id, org_id,
              height_cm, weight_kg, bmi, bmi_status, fat_percent,
              gender, age, patient_name, mobile,
              bt_device_address, bt_device_name, data_source,
              captured_at, created_at, updated_at
       FROM   partner_bmi_reports
       WHERE  client_uuid = ?
       FOR UPDATE`,
      [clientUuid],
    );

    if (existing.length > 0) {
      await connection.commit();
      console.log(
        `♻️ Idempotent hit — returning existing report ${existing[0].report_id}`,
      );
      return { report: existing[0], is_duplicate: true };
    }

    // ── 2. Generate report_id + insert ───────────────────────────────────────
    const reportId = await generatePartnerBmiReportId();

    await connection.execute(
      `INSERT INTO partner_bmi_reports
         (report_id, client_uuid, partner_auth_id, org_id,
          height_cm, weight_kg, bmi, bmi_status, fat_percent,
          gender, age, patient_name, mobile,
          bt_device_address, bt_device_name, data_source,
          captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reportId,
        clientUuid,
        partnerAuthId,
        orgId,
        heightCm,
        weightKg,
        bmi,
        bmiStatus,
        fatPercent,
        gender,
        age,
        patientName,
        mobile,
        btDeviceAddress,
        btDeviceName,
        dataSource,
        capturedAt,
      ],
    );

    // ── 3. Fetch the inserted row to return it ───────────────────────────────
    const [inserted] = await connection.execute(
      `SELECT id, report_id, client_uuid, partner_auth_id, org_id,
              height_cm, weight_kg, bmi, bmi_status, fat_percent,
              gender, age, patient_name, mobile,
              bt_device_address, bt_device_name, data_source,
              captured_at, created_at, updated_at
       FROM   partner_bmi_reports
       WHERE  client_uuid = ?`,
      [clientUuid],
    );

    await connection.commit();

    console.log(`✅ Partner BMI report created: ${reportId}`);
    return { report: inserted[0], is_duplicate: false };
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (e) {
        console.error("Rollback failed:", e);
      }
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

// =============================================================================
// PARTNER BMI REPORTS — READ
// =============================================================================

/**
 * Look up an existing report by client_uuid.
 * Used by the controller's ER_DUP_ENTRY race safety net.
 */
async function getPartnerBmiReportByClientUuid(clientUuid) {
  const rows = await query(
    `SELECT id, report_id, client_uuid, partner_auth_id, org_id,
            height_cm, weight_kg, bmi, bmi_status, fat_percent,
            gender, age, patient_name, mobile,
            bt_device_address, bt_device_name, data_source,
            captured_at, created_at, updated_at
     FROM   partner_bmi_reports
     WHERE  client_uuid = ?
     LIMIT  1`,
    [clientUuid],
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Get a single report by its public report_id (PBR_MMYY_xxxxxx). */
async function getPartnerBmiReportById(reportId) {
  const rows = await query(
    `SELECT id, report_id, client_uuid, partner_auth_id, org_id,
            height_cm, weight_kg, bmi, bmi_status, fat_percent,
            gender, age, patient_name, mobile,
            bt_device_address, bt_device_name, data_source,
            captured_at, created_at, updated_at
     FROM   partner_bmi_reports
     WHERE  report_id = ?
     LIMIT  1`,
    [reportId],
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Paginated report list for one partner, newest first. */
async function getPartnerBmiReports(partnerAuthId, limit = 20, offset = 0) {
  const safeLimit = String(
    Math.max(1, Math.min(parseInt(limit, 10) || 20, 100)),
  );
  const safeOffset = String(Math.max(0, parseInt(offset, 10) || 0));

  return await query(
    `SELECT id, report_id, client_uuid,
            height_cm, weight_kg, bmi, bmi_status, fat_percent,
            gender, age, patient_name, mobile,
            bt_device_address, bt_device_name, data_source,
            captured_at, created_at
     FROM   partner_bmi_reports
     WHERE  partner_auth_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [partnerAuthId],
  );
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // ── Core ────────────────────────────────────────────────────────────────────
  query,
  pool,
  getConnection: async () => await pool.getConnection(),

  // ── User management ─────────────────────────────────────────────────────────
  getAllUsersByMobile,
  getUserById,
  createNewUser,
  createReport,

  // ── Demographics ────────────────────────────────────────────────────────────
  hasDemographics,
  updateUserDemographics,
  giveRewardCredits, // uses addWalletRecharge internally

  // ── Wallet — read ───────────────────────────────────────────────────────────
  getWalletByMobile,
  getWalletTransactions,

  // ── Wallet — write ──────────────────────────────────────────────────────────
  addWalletRecharge, // recharge (cash + reward, separate buckets)
  deductCredits, // BMI payment (rewards first → cash)
  calculateRewardAmount, // reward tier lookup

  // ── Recharge order tracking ─────────────────────────────────────────────────
  generateRechargeOrderId,
  createRechargeOrder,
  updateRechargeOrder,
  getRechargeOrderByRazorpayId,

  // ── Webhook idempotency ──────────────────────────────────────────────────────
  isWebhookAlreadyProcessed,
  recordWebhookEvent,

  // ── Partner Stack — atomic counter (shared, used by Machine Recharge too) ─
  nextSequence,

  // ── Partner Wallet — ID generators ────────────────────────────────────────
  generatePartnerWalletId,
  generatePartnerRechargeOrderId,
  generatePartnerTransactionId,

  // ── Partner Wallet — read ─────────────────────────────────────────────────
  getPartnerWalletByAuthId,
  getPartnerWalletTransactions,

  // ── Partner Wallet — write ────────────────────────────────────────────────
  addPartnerWalletRecharge,

  // ── Partner Wallet — recharge order tracking ──────────────────────────────
  createPartnerRechargeOrder,
  updatePartnerRechargeOrder,
  getPartnerRechargeOrderByRazorpayId,

  // ── Machine Recharge — ID generator ───────────────────────────────────────
  generateMachineRechargeId,

  // ── Machine Recharge — state machine ──────────────────────────────────────
  createMachineRecharge,
  confirmMachineRecharge,
  failMachineRecharge,

  // ── Machine Recharge — read ───────────────────────────────────────────────
  getMachineRechargeById,
  getMachineRechargesByPartner,

  // ── Partner BMI Reports — ID generator ────────────────────────────────────
  generatePartnerBmiReportId,
 
  // ── Partner BMI Reports — write ───────────────────────────────────────────
  createPartnerBmiReport,
 
  // ── Partner BMI Reports — read ────────────────────────────────────────────
  getPartnerBmiReportByClientUuid,
  getPartnerBmiReportById,
  getPartnerBmiReports,
};
