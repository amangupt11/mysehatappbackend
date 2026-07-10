//config/db.js
require("dotenv").config();
const mysql = require("mysql2/promise");

// Create a connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  timezone: '+05:30', // ✅ ADDED: tells mysql2 to convert JS Date objects to IST
});

// Helper function to execute queries
async function query(sql, params) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (error) {
    console.error("Database query error:", error);
    throw error;
  }
}

// Generate random wallet ID
function generateWalletId() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // Excluding confusing chars
  let result = "WLT_";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// User Management
async function getAllUsersByMobile(mobileNumber) {
  return await query(
    "SELECT user_id, mobile_number, full_name, email, age, gender, profile_image, user_type FROM users WHERE mobile_number = ? ORDER BY user_type DESC, created_at ASC",
    [mobileNumber],
  );
}

// Get user by ID
async function getUserById(userId) {
  const users = await query(
    "SELECT user_id, mobile_number, full_name, email, age, gender, profile_image, user_type FROM users WHERE user_id = ?",
    [userId],
  );
  return users.length > 0 ? users[0] : null;
}

// Mobile Wallet: Add credits to user's wallet
async function addCredits(
  mobileNumber,
  creditsToAdd,
  razorpayPaymentId,
  amountPaid,
  description = null,
) {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query("SET SESSION autocommit = 0");
    await connection.beginTransaction();

    console.log("Starting addCredits transaction:", {
      mobileNumber,
      creditsToAdd,
      razorpayPaymentId,
      amountPaid,
    });

    // Get or create wallet with row lock
    const [walletRows] = await connection.execute(
      "SELECT wallet_id, wallet_balance FROM mobile_wallets WHERE mobile_number = ? FOR UPDATE",
      [mobileNumber],
    );

    let wallet;
    let newBalance;

    if (walletRows.length === 0) {
      // Create wallet if doesn't exist
      const walletId = generateWalletId();
      await connection.execute(
        "INSERT INTO mobile_wallets (wallet_id, mobile_number, wallet_balance) VALUES (?, ?, 0.00)",
        [walletId, mobileNumber],
      );
      wallet = { wallet_id: walletId, wallet_balance: 0.0 };
      newBalance = creditsToAdd;
    } else {
      wallet = walletRows[0];
      const currentBalance = parseFloat(wallet.wallet_balance);
      newBalance = currentBalance + creditsToAdd;
    }

    // Update wallet balance
    const [updateResult] = await connection.execute(
      "UPDATE mobile_wallets SET wallet_balance = ? WHERE wallet_id = ?",
      [newBalance, wallet.wallet_id],
    );

    if (updateResult.affectedRows !== 1) {
      throw new Error("Failed to update wallet balance");
    }

    // Generate unique transaction ID
    const transactionId = `TXN_CREDIT_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Record wallet transaction
    const transactionDesc = description || `Wallet recharge - ₹${amountPaid}`;

    const [insertResult] = await connection.execute(
      `INSERT INTO wallet_transactions 
             (wallet_id, mobile_number, transaction_type, credits, balance_after, transaction_id, razorpay_payment_id, amount_paid, description) 
             VALUES (?, ?, 'credit_purchase', ?, ?, ?, ?, ?, ?)`,
      [
        wallet.wallet_id,
        mobileNumber,
        creditsToAdd,
        newBalance,
        transactionId,
        razorpayPaymentId,
        amountPaid,
        transactionDesc,
      ],
    );

    if (insertResult.affectedRows !== 1) {
      throw new Error("Failed to record wallet transaction");
    }

    await connection.commit();
    console.log(
      `Credits added successfully: ${creditsToAdd} to mobile ${mobileNumber}, new balance: ${newBalance}`,
    );
    return transactionId;
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rbErr) {
        console.error("Rollback failed", rbErr);
      }
    }
    throw error;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// Calculate BMI status
function calculateBmiStatus(bmi) {
  if (bmi < 18.5) return "Underweight";
  if (bmi < 25) return "Normal";
  if (bmi < 30) return "Overweight";
  return "Obese";
}

// Create new user
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

    // Determine user type: explicit or auto-detect
    let finalUserType = userType;
    if (!finalUserType) {
      const existingUsers = await query(
        "SELECT COUNT(*) as count FROM users WHERE mobile_number = ?",
        [mobileNumber],
      );
      finalUserType = existingUsers[0].count === 0 ? "SuperUser" : "FamilyUser";
      console.log(
        `Auto-determined user type: ${finalUserType} (existing users: ${existingUsers[0].count})`,
      );
    } else {
      console.log(`Using explicit user type: ${finalUserType}`);
    }

    await query(
      "INSERT INTO users (mobile_number, full_name, age, gender, user_type) VALUES (?, ?, ?, ?, ?)",
      [mobileNumber, fullName, age, gender, finalUserType],
    );

    const users = await query(
      "SELECT user_id FROM users WHERE mobile_number = ? AND full_name = ? ORDER BY created_at DESC LIMIT 1",
      [mobileNumber, fullName],
    );

    if (users.length === 0) {
      throw new Error("Failed to retrieve newly created user");
    }

    console.log(
      "User created successfully:",
      users[0].user_id,
      "Type:",
      finalUserType,
    );
    return users[0];
  } catch (error) {
    console.error("Error creating new user:", error);
    throw error;
  }
}

// Report Management
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

    // Insert the report
    await query(
      `INSERT INTO reports (user_id, report_date, height, weight, bmi_status, machine_id, fee, transaction_id, payment_method)
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

    // Fetch the generated report_id (created by trigger)
    const reports = await query(
      `SELECT report_id FROM reports 
             WHERE user_id = ? AND machine_id = ? 
             ORDER BY report_date DESC LIMIT 1`,
      [userId, machineId],
    );

    const reportId = reports.length > 0 ? reports[0].report_id : null;

    console.log("Report created successfully:", reportId);

    return reportId;
  } catch (error) {
    console.error("Error creating report:", {
      error: error.message,
      params: {
        userId,
        height,
        weight,
        bmiStatus: calculateBmiStatus(bmi),
        machineId,
        fee,
        transactionId,
        paymentMethod,
      },
    });
    throw error;
  }
}

/**
 * Check if user has provided real demographics
 * Returns true if user has real data (full_name != 'Unknown')
 */
async function hasDemographics(mobileNumber) {
  try {
    const users = await query(
      `SELECT user_id FROM users 
             WHERE mobile_number = ? 
             AND full_name != 'Unknown'`,
      [mobileNumber],
    );
    const hasDemographics = users.length > 0;
    console.log("hasDemographics check:", { mobileNumber, hasDemographics });
    return hasDemographics;
  } catch (error) {
    console.error("Error checking demographics:", error);
    return false;
  }
}

/**
 * Update user from dummy data to real demographics
 */
async function updateUserDemographics(userId, name, age, gender) {
  try {
    console.log("Updating user demographics:", { userId, name, age, gender });

    await query(
      `UPDATE users 
             SET full_name = ?, age = ?, gender = ? 
             WHERE user_id = ?`,
      [name, age, gender, userId],
    );

    console.log("Demographics updated successfully for user:", userId);
  } catch (error) {
    console.error("Error updating demographics:", error);
    throw error;
  }
}

/**
 * Give reward credits to user for providing demographics
 * Uses existing wallet system
 */
async function giveRewardCredits(mobileNumber, credits, machineId = null) {
  try {
    console.log("Giving reward credits:", { mobileNumber, credits });

    // Use existing addCredits function with special reward payment ID
    const transactionId = await addCredits(
      mobileNumber,
      credits,
      "REWARD_DEMOGRAPHICS", // Special payment ID to identify rewards
      0, // Amount paid = 0 (it's a reward)
      `Reward for providing demographics - ${credits} credits for next BMI free`,
    );

    console.log("Reward credits added successfully:", transactionId);
    return transactionId;
  } catch (error) {
    console.error("Error giving reward credits:", error);
    throw error;
  }
}

// Export functions
module.exports = {
  query,
  pool, // ✅ ADD THIS - Export the pool
  getConnection: async () => await pool.getConnection(), // ✅ ADD THIS - Export getConnection function
  getAllUsersByMobile,
  getUserById,
  createNewUser,
  createReport,

  // Mobile Wallet functions
  addCredits,
  generateWalletId,

  // NEW: First-time user flow functions
  hasDemographics,
  updateUserDemographics,
  giveRewardCredits,
};
