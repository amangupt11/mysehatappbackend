// controllers/partnerBmiReportController.js
require("dotenv").config();
const db = require("../config/db");

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * The RN client sends bt_device_name = 'QR-SCAN' when the reading was captured
 * via QR code rather than a physical Bluetooth device. Keep in sync with the
 * PartnerHomeScreen handleSave — any change requires a coordinated deploy.
 */
const QR_DEVICE_MARKER = "QR-SCAN";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── Small helpers ───────────────────────────────────────────────────────────

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/**
 * Convert a JS Date (or ISO string) → MySQL DATETIME string in IST-safe way.
 * The db pool is configured for +05:30 timezone, so ISO UTC in → correct
 * IST DATETIME out.
 */
function toMysqlDatetime(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Shape a partner_bmi_reports row for the API — parse decimals, keep nulls.
 */
function formatReportRow(r) {
  return {
    report_id: r.report_id,
    client_uuid: r.client_uuid,
    height_cm: parseFloat(r.height_cm),
    weight_kg: parseFloat(r.weight_kg),
    bmi: parseFloat(r.bmi),
    bmi_status: r.bmi_status,
    fat_percent: r.fat_percent != null ? parseFloat(r.fat_percent) : null,
    gender: r.gender,
    age: r.age,
    patient_name: r.patient_name,
    mobile: r.mobile,
    bt_device_address: r.bt_device_address,
    bt_device_name: r.bt_device_name,
    data_source: r.data_source,
    captured_at: r.captured_at,
    created_at: r.created_at,
  };
}

// =============================================================================
// POST /api/v1/partner-bmi-reports
// Body: {
//   client_uuid,               // UUID v4 — idempotency key
//   height_cm, weight_kg,      // from BMI kiosk
//   bmi, bmi_status?, fat_percent?,
//   gender, age, patient_name, mobile,
//   bt_device_address?, bt_device_name?,
//   created_at                 // ISO string — when the phone captured
// }
// Idempotent on client_uuid → 200 on duplicate, 201 on new insert.
// =============================================================================
async function create(req, res) {
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
    const {
      client_uuid,
      height_cm,
      weight_kg,
      bmi,
      bmi_status,
      fat_percent,
      gender,
      age,
      patient_name,
      mobile,
      bt_device_address,
      bt_device_name,
      created_at,
    } = body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📥 CREATE PARTNER BMI REPORT");
    console.log(
      "Partner:",
      partnerAuthId,
      "| Org:",
      orgId,
      "| UUID:",
      client_uuid,
    );

    // ── Validation: client_uuid ───────────────────────────────────────────
    if (!client_uuid || typeof client_uuid !== "string") {
      return res.status(400).json({
        success: false,
        message: "client_uuid is required",
      });
    }
    if (!UUID_V4_RE.test(client_uuid)) {
      return res.status(400).json({
        success: false,
        message: "client_uuid must be a valid UUID v4",
      });
    }

    // ── Validation: numerics ─────────────────────────────────────────────
    const heightNum = parseFloat(height_cm);
    const weightNum = parseFloat(weight_kg);
    const bmiNum = parseFloat(bmi);
    const ageNum = parseInt(age, 10);

    if (!isFiniteNumber(heightNum) || heightNum <= 0 || heightNum > 300) {
      return res.status(400).json({
        success: false,
        message: "height_cm must be between 0 and 300",
      });
    }
    if (!isFiniteNumber(weightNum) || weightNum <= 0 || weightNum > 500) {
      return res.status(400).json({
        success: false,
        message: "weight_kg must be between 0 and 500",
      });
    }
    if (!isFiniteNumber(bmiNum) || bmiNum <= 0 || bmiNum > 100) {
      return res.status(400).json({
        success: false,
        message: "bmi must be between 0 and 100",
      });
    }
    if (!Number.isFinite(ageNum) || ageNum <= 0 || ageNum > 150) {
      return res.status(400).json({
        success: false,
        message: "age must be between 1 and 150",
      });
    }

    let fatPercentNum = null;
    if (fat_percent != null && fat_percent !== "") {
      fatPercentNum = parseFloat(fat_percent);
      if (
        !isFiniteNumber(fatPercentNum) ||
        fatPercentNum < 0 ||
        fatPercentNum > 100
      ) {
        return res.status(400).json({
          success: false,
          message: "fat_percent must be between 0 and 100",
        });
      }
    }

    // ── Validation: strings ──────────────────────────────────────────────
    const genderStr = trimOrNull(gender);
    const nameStr = trimOrNull(patient_name);
    const mobileStr = trimOrNull(mobile);
    const bmiStatusStr = trimOrNull(bmi_status);

    if (!genderStr || !["Male", "Female", "Other"].includes(genderStr)) {
      return res.status(400).json({
        success: false,
        message: "gender must be Male, Female, or Other",
      });
    }
    if (!nameStr || nameStr.length > 128) {
      return res.status(400).json({
        success: false,
        message: "patient_name is required (max 128 chars)",
      });
    }
    if (!mobileStr || !/^[0-9]{10}$/.test(mobileStr)) {
      return res.status(400).json({
        success: false,
        message: "mobile must be a 10-digit number",
      });
    }

    // ── Derive data_source from device markers ──────────────────────────
    const btAddr = trimOrNull(bt_device_address);
    const btName = trimOrNull(bt_device_name);
    let dataSource;
    if (btName === QR_DEVICE_MARKER) {
      dataSource = "qr";
    } else if (btAddr) {
      dataSource = "bluetooth";
    } else {
      dataSource = "manual";
    }

    // ── captured_at: prefer client-provided, fall back to now ───────────
    let capturedAt;
    if (created_at) {
      capturedAt = toMysqlDatetime(created_at);
      if (!capturedAt) {
        return res.status(400).json({
          success: false,
          message: "created_at must be a valid ISO timestamp",
        });
      }
    } else {
      capturedAt = toMysqlDatetime(new Date());
    }

    // ── Insert (idempotent on client_uuid) ──────────────────────────────
    let result;
    try {
      result = await db.createPartnerBmiReport({
        clientUuid: client_uuid,
        partnerAuthId,
        orgId,
        heightCm: heightNum,
        weightKg: weightNum,
        bmi: bmiNum,
        bmiStatus: bmiStatusStr,
        fatPercent: fatPercentNum,
        gender: genderStr,
        age: ageNum,
        patientName: nameStr,
        mobile: mobileStr,
        btDeviceAddress: btAddr,
        btDeviceName: btName,
        dataSource,
        capturedAt,
      });
    } catch (err) {
      // Race-safety net: if a concurrent request beat the FOR UPDATE lock
      // (shouldn't happen but defence in depth), MySQL raises ER_DUP_ENTRY.
      // Fetch existing and return it as idempotent hit.
      if (err.code === "ER_DUP_ENTRY") {
        const existing = await db.getPartnerBmiReportByClientUuid(client_uuid);
        if (existing) {
          console.log(
            `♻️ ER_DUP_ENTRY race — returning existing ${existing.report_id}`,
          );
          return res.status(200).json({
            success: true,
            message: "Report already exists (idempotent hit)",
            data: {
              ...formatReportRow(existing),
              is_duplicate: true,
            },
          });
        }
      }
      throw err;
    }

    const { report, is_duplicate } = result;

    console.log(
      `${is_duplicate ? "♻️" : "✅"} Report ${is_duplicate ? "duplicated" : "created"}: ${report.report_id}`,
    );
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    return res.status(is_duplicate ? 200 : 201).json({
      success: true,
      message: is_duplicate
        ? "Report already exists (idempotent hit)"
        : "Report created",
      data: {
        ...formatReportRow(report),
        is_duplicate,
      },
    });
  } catch (error) {
    console.error("❌ createPartnerBmiReport error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to create BMI report",
      error: error.message,
    });
  }
}

// =============================================================================
// GET /api/v1/partner-bmi-reports?limit=20&offset=0
// =============================================================================
async function list(req, res) {
  try {
    const partnerAuthId = req.user.auth_id;
    const limit =
      Math.min(Math.max(1, parseInt(req.query.limit, 10) || 20), 100) | 0;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0) | 0;

    console.log(
      "📋 LIST PARTNER BMI REPORTS — auth_id:",
      partnerAuthId,
      "| limit:",
      limit,
      "| offset:",
      offset,
    );

    const reports = await db.getPartnerBmiReports(partnerAuthId, limit, offset);

    return res.status(200).json({
      success: true,
      count: reports.length,
      data: reports.map(formatReportRow),
    });
  } catch (error) {
    console.error("❌ list error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch BMI reports",
      error: error.message,
    });
  }
}

// =============================================================================
// GET /api/v1/partner-bmi-reports/:reportId
// Fetch by public report_id (PBR_MMYY_xxxxxx). Ownership-checked.
// =============================================================================
async function getById(req, res) {
  try {
    const partnerAuthId = req.user.auth_id;
    const { reportId } = req.params;

    const report = await db.getPartnerBmiReportById(reportId);
    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Report not found",
      });
    }

    if (report.partner_auth_id !== partnerAuthId) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    return res.status(200).json({
      success: true,
      data: formatReportRow(report),
    });
  } catch (error) {
    console.error("❌ getById error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch BMI report",
      error: error.message,
    });
  }
}

module.exports = {
  create,
  list,
  getById,
};