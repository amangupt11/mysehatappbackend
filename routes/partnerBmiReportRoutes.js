// routes/partnerBmiReportRoutes.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/authMiddleware");
const partnerBmiReportController = require("../controllers/partnerBmiReportController");

// All BMI report routes require a valid partner JWT
router.use(authenticateToken);

/**
 * POST /api/v1/partner-bmi-reports
 * Body: {
 *   client_uuid,             // UUID v4 — idempotency key (required)
 *   height_cm, weight_kg,    // from BMI kiosk (required)
 *   bmi,                     // computed on phone (required)
 *   bmi_status?,             // "Normal", "Overweight", etc.
 *   fat_percent?,            // computed from height + weight + age + gender
 *   gender, age, patient_name, mobile,  // required
 *   bt_device_address?,      // MAC when captured via Bluetooth
 *   bt_device_name?,         // "QR-SCAN" marks a QR capture
 *   created_at               // ISO string — phone's capture time
 * }
 *
 * Idempotent on client_uuid:
 *   • First POST → 201 Created (data.is_duplicate = false)
 *   • Repeat POST with same UUID → 200 OK, returns existing (is_duplicate = true)
 * The RN sync manager relies on this — safe to retry same row after network flakes.
 */
router.post("/", partnerBmiReportController.create);

/**
 * GET /api/v1/partner-bmi-reports?limit=20&offset=0
 * Paginated list for the logged-in partner. Newest first.
 * Limit capped at 100.
 */
router.get("/", partnerBmiReportController.list);

/**
 * GET /api/v1/partner-bmi-reports/:reportId
 * Single report by public report_id (PBR_MMYY_xxxxxx). Ownership-checked.
 */
router.get("/:reportId", partnerBmiReportController.getById);

module.exports = router;