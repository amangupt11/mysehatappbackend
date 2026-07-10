// controllers/machineRechargeController.js
require("dotenv").config();
const db = require("../config/db");

const MIN_AMOUNT = 1;
const MAX_AMOUNT = 50000; // same ceiling as wallet top-up

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Format a machine_recharges row for API response (parse decimals, normalize nulls).
 */
function formatRechargeRow(r) {
  return {
    recharge_id: r.recharge_id,
    bt_device_address: r.bt_device_address,
    bt_device_name: r.bt_device_name,
    amount_rupees: parseFloat(r.amount_rupees),
    unit_price_snapshot: parseFloat(r.unit_price_snapshot),
    units_sent: parseFloat(r.units_sent),
    bt_status: r.bt_status,
    bt_ack_at: r.bt_ack_at,
    error_message: r.error_message,
    wallet_transaction_id: r.wallet_transaction_id || null,
    created_at: r.created_at,
  };
}

/**
 * Fetch the org's unit_price (₹ per unit). Used to compute units_sent at
 * initiate time and snapshot into the row for historical accuracy.
 */
async function getOrgUnitPrice(orgId) {
  const rows = await db.query(
    `SELECT unit_price FROM organizations WHERE org_id = ? LIMIT 1`,
    [orgId],
  );
  return rows.length > 0 ? parseFloat(rows[0].unit_price) : null;
}

// =============================================================================
// POST /api/v1/machine-recharge/initiate
// Body: { bt_device_address, bt_device_name?, amount_rupees }
// Creates machine_recharges row with bt_status='initiated'. NO wallet debit.
// =============================================================================
async function initiate(req, res) {
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
    const { bt_device_address, bt_device_name, amount_rupees } = body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔌 INITIATE MACHINE RECHARGE");
    console.log(
      "Partner:",
      partnerAuthId,
      "| Device:",
      bt_device_address,
      "| Amount:",
      amount_rupees,
    );

    // ── Validate ──────────────────────────────────────────────────────────────
    if (!bt_device_address?.trim()) {
      return res.status(400).json({
        success: false,
        message: "bt_device_address is required",
      });
    }

    if (amount_rupees === undefined || amount_rupees === null) {
      return res.status(400).json({
        success: false,
        message: "amount_rupees is required",
      });
    }

    const amount = parseInt(amount_rupees, 10);
    if (!amount || isNaN(amount)) {
      return res.status(400).json({
        success: false,
        message: "amount_rupees must be a valid number",
      });
    }

    if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
      return res.status(400).json({
        success: false,
        message: `Amount must be between ₹${MIN_AMOUNT} and ₹${MAX_AMOUNT}`,
      });
    }

    // ── Fetch org's unit_price ───────────────────────────────────────────────
    const unitPrice = await getOrgUnitPrice(orgId);
    if (!unitPrice || unitPrice <= 0) {
      return res.status(400).json({
        success: false,
        message:
          "Unit price not configured for your organisation. Please contact support.",
      });
    }

    // ── Pre-check wallet (atomic check still happens at confirm) ─────────────
    const wallet = await db.getPartnerWalletByAuthId(partnerAuthId);
    if (!wallet) {
      return res.status(400).json({
        success: false,
        message: "No wallet found. Please top-up your wallet first.",
      });
    }

    if (wallet.status !== "active") {
      return res.status(400).json({
        success: false,
        message: `Wallet is ${wallet.status} — cannot recharge`,
      });
    }

    const balance = parseFloat(wallet.wallet_balance);
    if (balance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient wallet balance",
        data: {
          required: amount,
          available: balance,
          shortfall: parseFloat((amount - balance).toFixed(2)),
        },
      });
    }

    // ── Compute units, create row ────────────────────────────────────────────
    const unitsSent = parseFloat((amount / unitPrice).toFixed(2));

    const rechargeId = await db.createMachineRecharge(
      partnerAuthId,
      wallet.partner_wallet_id,
      orgId,
      bt_device_address.trim(),
      bt_device_name?.trim() || null,
      amount,
      unitPrice,
      unitsSent,
    );

    console.log(
      `✅ Recharge initiated ${rechargeId} — ₹${amount} (${unitsSent} units @ ₹${unitPrice}/unit)`,
    );
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    return res.status(201).json({
      success: true,
      message:
        "Recharge initiated. Send BT command, then call /confirm on ACK or /fail on timeout.",
      data: {
        recharge_id: rechargeId,
        amount_rupees: amount,
        unit_price_snapshot: unitPrice,
        units_sent: unitsSent,
        bt_status: "initiated",
      },
    });
  } catch (error) {
    console.error("❌ initiate error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to initiate recharge",
      error: error.message,
    });
  }
}

// =============================================================================
// POST /api/v1/machine-recharge/:rechargeId/confirm
// App calls this after BT ACK. Atomic: marks ack_received + debits wallet.
// =============================================================================
async function confirm(req, res) {
  try {
    const partnerAuthId = req.user.auth_id;
    const { rechargeId } = req.params;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("✅ CONFIRM MACHINE RECHARGE (BT ACK received)");
    console.log("Partner:", partnerAuthId, "| Recharge:", rechargeId);

    // ── Ownership check ──────────────────────────────────────────────────────
    const recharge = await db.getMachineRechargeById(rechargeId);
    if (!recharge) {
      return res.status(404).json({
        success: false,
        message: "Recharge not found",
      });
    }

    if (recharge.partner_auth_id !== partnerAuthId) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    // ── Atomic confirm (all safety checks inside the transaction) ────────────
    let result;
    try {
      result = await db.confirmMachineRecharge(rechargeId);
    } catch (err) {
      const msg = err.message || "";

      // Map known business errors to 4xx
      if (msg.includes("not in initiated") || msg.includes("Cannot confirm")) {
        return res.status(409).json({ success: false, message: msg });
      }
      if (msg.includes("Insufficient")) {
        return res.status(400).json({ success: false, message: msg });
      }
      if (msg.includes("cannot debit") || msg.includes("not found")) {
        return res.status(400).json({ success: false, message: msg });
      }
      throw err; // unexpected → 500 below
    }

    console.log(
      `✅ Wallet debited ₹${result.amountDebited} → new balance ₹${result.newBalance}`,
    );
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    return res.status(200).json({
      success: true,
      message: "Recharge confirmed",
      data: {
        recharge_id: rechargeId,
        transaction_id: result.transactionId,
        amount_debited: result.amountDebited,
        units_sent: result.unitsSent,
        wallet_balance: result.newBalance,
        bt_status: "ack_received",
      },
    });
  } catch (error) {
    console.error("❌ confirm error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to confirm recharge",
      error: error.message,
    });
  }
}

// =============================================================================
// POST /api/v1/machine-recharge/:rechargeId/fail
// Body: { bt_status: 'ack_timeout' | 'failed', error_message? }
// App calls this on BT timeout / error. NO wallet debit.
// =============================================================================
async function fail(req, res) {
  try {
    const partnerAuthId = req.user.auth_id;
    const { rechargeId } = req.params;

    const body = req.body || {};
    const { bt_status, error_message } = body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`⚠️ FAIL MACHINE RECHARGE (${bt_status})`);
    console.log("Partner:", partnerAuthId, "| Recharge:", rechargeId);

    if (!["ack_timeout", "failed"].includes(bt_status)) {
      return res.status(400).json({
        success: false,
        message: "bt_status must be 'ack_timeout' or 'failed'",
      });
    }

    // ── Ownership check ──────────────────────────────────────────────────────
    const recharge = await db.getMachineRechargeById(rechargeId);
    if (!recharge) {
      return res.status(404).json({
        success: false,
        message: "Recharge not found",
      });
    }

    if (recharge.partner_auth_id !== partnerAuthId) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    // ── Mark failed ──────────────────────────────────────────────────────────
    try {
      await db.failMachineRecharge(
        rechargeId,
        bt_status,
        error_message?.trim() || null,
      );
    } catch (err) {
      if (
        err.message.includes("not in initiated") ||
        err.message.includes("Cannot mark")
      ) {
        return res.status(409).json({ success: false, message: err.message });
      }
      throw err;
    }

    console.log(`⚠️ Recharge marked ${bt_status}: ${rechargeId}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    return res.status(200).json({
      success: true,
      message: `Recharge marked ${bt_status}`,
      data: {
        recharge_id: rechargeId,
        bt_status,
        wallet_balance_unchanged: true,
      },
    });
  } catch (error) {
    console.error("❌ fail error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to mark recharge failed",
      error: error.message,
    });
  }
}

// =============================================================================
// GET /api/v1/machine-recharge?limit=20&offset=0
// =============================================================================
async function list(req, res) {
  try {
    const partnerAuthId = req.user.auth_id;
    const limit =
      Math.min(Math.max(1, parseInt(req.query.limit, 10) || 20), 100) | 0;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0) | 0;

    console.log("📋 LIST MACHINE RECHARGES — auth_id:", partnerAuthId);

    const recharges = await db.getMachineRechargesByPartner(
      partnerAuthId,
      limit,
      offset,
    );

    return res.status(200).json({
      success: true,
      count: recharges.length,
      data: recharges.map(formatRechargeRow),
    });
  } catch (error) {
    console.error("❌ list error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch recharges",
      error: error.message,
    });
  }
}

// =============================================================================
// GET /api/v1/machine-recharge/:rechargeId
// =============================================================================
async function getById(req, res) {
  try {
    const partnerAuthId = req.user.auth_id;
    const { rechargeId } = req.params;

    const recharge = await db.getMachineRechargeById(rechargeId);
    if (!recharge) {
      return res.status(404).json({
        success: false,
        message: "Recharge not found",
      });
    }

    if (recharge.partner_auth_id !== partnerAuthId) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    return res.status(200).json({
      success: true,
      data: formatRechargeRow(recharge),
    });
  } catch (error) {
    console.error("❌ getById error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch recharge",
      error: error.message,
    });
  }
}

module.exports = {
  initiate,
  confirm,
  fail,
  list,
  getById,
};
