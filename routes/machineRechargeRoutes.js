// routes/machineRechargeRoutes.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/authMiddleware");
const machineRechargeController = require("../controllers/machineRechargeController");

// All machine recharge routes require a valid partner JWT
router.use(authenticateToken);

/**
 * POST /api/v1/machine-recharge/initiate
 * Body: { bt_device_address, bt_device_name?, amount_rupees }
 * Creates machine_recharges row (bt_status='initiated'). NO wallet debit.
 * Returns recharge_id for the app to use in /confirm or /fail.
 */
router.post("/initiate", machineRechargeController.initiate);

/**
 * POST /api/v1/machine-recharge/:rechargeId/confirm
 * Called by the app after BT ACK is received from the kiosk.
 * Atomic: ack_received + ledger debit + wallet balance update.
 */
router.post("/:rechargeId/confirm", machineRechargeController.confirm);

/**
 * POST /api/v1/machine-recharge/:rechargeId/fail
 * Body: { bt_status: 'ack_timeout' | 'failed', error_message? }
 * Called on BT timeout / error. NO wallet debit, partner protected.
 */
router.post("/:rechargeId/fail", machineRechargeController.fail);

/**
 * GET /api/v1/machine-recharge?limit=20&offset=0
 * Paginated recharge history for the logged-in partner (all statuses).
 */
router.get("/", machineRechargeController.list);

/**
 * GET /api/v1/machine-recharge/:rechargeId
 * Single recharge detail. Ownership-checked.
 */
router.get("/:rechargeId", machineRechargeController.getById);

module.exports = router;
