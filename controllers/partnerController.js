// controllers/partnerController.js
'use strict';

const bcrypt = require('bcrypt');
const { query, getConnection } = require('../config/db');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse pagination query params
 * @returns {{ limit: number, offset: number, page: number }}
 */
function parsePagination(reqQuery) {
  const page   = Math.max(1, parseInt(reqQuery.page)  || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(reqQuery.limit) || 20));
  const offset = (page - 1) * limit;
  // Return as strings — mysql2 pool.execute() rejects JS integers for LIMIT/OFFSET
  return { page, limit, offset, limitStr: String(limit), offsetStr: String(offset) };
}

/**
 * Build a safe date-range WHERE clause fragment.
 * Returns { clause: string, params: any[] }
 * clause will be empty string if no dates provided.
 */
function buildDateFilter(reqQuery, column) {
  const parts  = [];
  const params = [];

  if (reqQuery.from) {
    parts.push(`${column} >= ?`);
    params.push(`${reqQuery.from} 00:00:00`); // string — mysql2 safe
  }
  if (reqQuery.to) {
    parts.push(`${column} <= ?`);
    params.push(`${reqQuery.to} 23:59:59`);   // string — mysql2 safe
  }

  return {
    clause: parts.length ? parts.join(' AND ') : '',
    params,
  };
}

// ─── GET Profile ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/partner/profile/:id
 * :id = auth_id
 * Partners may only view their own profile.
 */
const getProfile = async (req, res) => {
  try {
    const { id } = req.params;

    // Prevent partners from viewing another partner's profile
    if (req.user.auth_id !== id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only view your own profile.',
      });
    }

    const rows = await query(
      `SELECT
         a.auth_id, a.username, a.email, a.mobile_number,
         a.role, a.status, a.created_date,
         o.org_id, o.org_name, o.owner_name, o.phone   AS org_phone,
         o.location, o.city, o.state, o.pincode,
         o.revenue_share, o.pan_gst, o.profile_image   AS org_image,
         o.fee_edit,
         ap.full_name, ap.profile_image
       FROM   auth a
       LEFT JOIN organizations  o  ON o.org_id   = a.org_id
       LEFT JOIN auth_profiles  ap ON ap.auth_id  = a.auth_id
       WHERE  a.auth_id = ?
       LIMIT  1`,
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Profile not found.' });
    }

    return res.status(200).json({ success: true, profile: rows[0] });
  } catch (err) {
    console.error('❌ getProfile error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ─── UPDATE Profile ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/partner/profile/:id
//
// Partner can update:
// • username
// • full_name        -> organizations.owner_name
// • mobile_number    -> organizations.phone
// • profile_image    -> organizations.profile_image
// • password
//
// Notes
// • auth.mobile_number NEVER changes
// • organization is NEVER created here
// • Uses transaction
// • Uses auth.org_id
// ─────────────────────────────────────────────────────────────────────────────

const updateProfile = async (req, res) => {
    let connection;
  
    console.log("=================================");
    console.log("req.body:", req.body);
    console.log("=================================");

    try {
        const { id } = req.params;

        // ---------------------------------------------------------------------
        // Authorization  profile_image,
        // ---------------------------------------------------------------------

        if (req.user.auth_id !== id) {
            return res.status(403).json({
                success: false,
                message: "Access denied. You can only update your own profile."
            });
        }

        const {
            username,
            full_name,
            mobile_number,
            currentPassword,
            newPassword
        } = req.body;

        connection = await getConnection();
        await connection.beginTransaction();

        // ---------------------------------------------------------------------
        // Fetch Account
        // ---------------------------------------------------------------------

        const [authRows] = await connection.execute(
            `
            SELECT
                auth_id,
                username,
                email,
                password,
                role,
                org_id
            FROM auth
            WHERE auth_id = ?
            LIMIT 1
            `,
            [id]
        );

        if (!authRows.length) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Account not found."
            });
        }

        const auth = authRows[0];

        // ---------------------------------------------------------------------
        // Fetch Organization
        // ---------------------------------------------------------------------

        const [orgRows] = await connection.execute(
            `
            SELECT
                org_id,
                owner_name,
                phone
            FROM organizations
            WHERE org_id = ?
            LIMIT 1
            `,
            [auth.org_id]
        );

        if (!orgRows.length) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Organization not found."
            });
        }

        const organization = orgRows[0];

        // ---------------------------------------------------------------------
        // Username Duplicate Validation
        // ---------------------------------------------------------------------

        if (
            username &&
            username.trim() &&
            username.trim() !== auth.username
        ) {
            const [exists] = await connection.execute(
                `
                SELECT auth_id
                FROM auth
                WHERE username = ?
                AND auth_id <> ?
                LIMIT 1
                `,
                [
                    username.trim(),
                    auth.auth_id
                ]
            );

            if (exists.length) {
                await connection.rollback();

                return res.status(409).json({
                    success: false,
                    message: "Username already exists."
                });
            }
        }

        // ---------------------------------------------------------------------
        // Phone Duplicate Validation
        // ---------------------------------------------------------------------

        if (
            mobile_number &&
            mobile_number.trim() &&
            mobile_number.trim() !== organization.phone
        ) {
            const [exists] = await connection.execute(
                `
                SELECT org_id
                FROM organizations
                WHERE phone = ?
                AND org_id <> ?
                LIMIT 1
                `,
                [
                    mobile_number.trim(),
                    auth.org_id
                ]
            );

            if (exists.length) {
                await connection.rollback();

                return res.status(409).json({
                    success: false,
                    message: "Mobile number already exists."
                });
            }
        }

        // ---------------------------------------------------------------------
        // Password Validation
        // ---------------------------------------------------------------------

        let hashedPassword = null;

        if (newPassword && newPassword.trim()) {

            if (!currentPassword || !currentPassword.trim()) {

                await connection.rollback();

                return res.status(400).json({
                    success: false,
                    message: "Current password is required."
                });

            }

            const passwordMatch = await bcrypt.compare(
                currentPassword,
                auth.password
            );

            if (!passwordMatch) {

                await connection.rollback();

                return res.status(401).json({
                    success: false,
                    message: "Current password is incorrect."
                });

            }

            if (newPassword.trim().length < 8) {

                await connection.rollback();

                return res.status(400).json({
                    success: false,
                    message: "New password must be at least 8 characters."
                });

            }

            hashedPassword = await bcrypt.hash(
                newPassword.trim(),
                12
            );
        }

        // ---------------------------------------------------------------------
        // Build AUTH Update
        // ---------------------------------------------------------------------

        const authFields = [];
        const authValues = [];

        if (
            username &&
            username.trim() &&
            username.trim() !== auth.username
        ) {
            authFields.push("username = ?");
            authValues.push(username.trim());
        }

        if (hashedPassword) {
            authFields.push("password = ?");
            authValues.push(hashedPassword);
        }

        // ---------------------------------------------------------------------
        // Build Organization Update
        // ---------------------------------------------------------------------

        const orgFields = [];
        const orgValues = [];

        if (
            full_name &&
            full_name.trim() &&
            full_name.trim() !== organization.owner_name
        ) {
            orgFields.push("owner_name = ?");
            orgValues.push(full_name.trim());
        }

        if (
            mobile_number &&
            mobile_number.trim() &&
            mobile_number.trim() !== organization.phone
        ) {
            orgFields.push("phone = ?");
            orgValues.push(mobile_number.trim());
        }

        if (authFields.length > 0) {

            authValues.push(auth.auth_id);

            await connection.execute(
                `
                UPDATE auth
                SET
                    ${authFields.join(", ")}
                WHERE auth_id = ?
                `,
                authValues
            );

        }

        // ---------------------------------------------------------------------
        // Execute Organization Update
        // ---------------------------------------------------------------------

        if (orgFields.length > 0) {

            orgValues.push(auth.org_id);

            const [result] = await connection.execute(
                `
                UPDATE organizations
                SET
                    ${orgFields.join(", ")}
                WHERE org_id = ?
                `,
                orgValues
            );

            if (result.affectedRows === 0) {

                await connection.rollback();

                return res.status(404).json({
                    success: false,
                    message: "Organization not found."
                });

            }

        }

        // ---------------------------------------------------------------------
        // Fetch Updated Profile
        // ---------------------------------------------------------------------

        const [updatedRows] = await connection.execute(
            `
            SELECT
                a.auth_id,
                a.username,
                a.email,
                a.role,
                a.org_id,
                o.owner_name,
                o.phone,
                o.profile_image
            FROM auth a
            INNER JOIN organizations o
                ON a.org_id = o.org_id
            WHERE a.auth_id = ?
            LIMIT 1
            `,
            [auth.auth_id]
        );

        await connection.commit();

        return res.status(200).json({
            success: true,
            message: "Profile updated successfully.",
            partner: {
                auth_id: updatedRows[0].auth_id,
                username: updatedRows[0].username,
                email: updatedRows[0].email,
                role: updatedRows[0].role,
                org_id: updatedRows[0].org_id,
                full_name: updatedRows[0].owner_name,
                mobile_number: updatedRows[0].phone,
                profile_image: updatedRows[0].profile_image
            }
        });

    } catch (err) {

        if (connection) {
            await connection.rollback();
        }

        console.error("❌ updateProfile error:", err);

        if (err.code === "ER_DUP_ENTRY") {

            return res.status(409).json({
                success: false,
                message: "Username or mobile number already exists."
            });

        }

        return res.status(500).json({
            success: false,
            message: "Internal server error."
        });

    } finally {

        if (connection) {
            connection.release();
        }

    }

};


// ─── GET Reports ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/partner/reports
 * Query params: page, limit, from (YYYY-MM-DD), to (YYYY-MM-DD)
 * Scoped to partner's org_id via JWT.
 */
const getReports = async (req, res) => {
  try {
    const { org_id } = req.user;
    if (!org_id) {
      return res.status(403).json({ success: false, message: 'No organisation linked to this account.' });
    }

    const { page, limit, offset, limitStr, offsetStr } = parsePagination(req.query);
    const { clause: dateClause, params: dateParams } = buildDateFilter(req.query, 'r.report_date');

    const whereClause = `p.org_id = ?${dateClause ? ' AND ' + dateClause : ''}`;
    const baseParams  = [org_id, ...dateParams];

    // ── Total count ───────────────────────────────────────────────────────
    const [{ total }] = await query(
      `SELECT COUNT(*) AS total
       FROM   reports r
       JOIN   products p ON p.machine_id = r.machine_id
       WHERE  ${whereClause}`,
      baseParams,
    );

    // ── Paginated rows ────────────────────────────────────────────────────
    const rows = await query(
      `SELECT
         r.report_id, r.report_date,
         r.height, r.weight, COALESCE(r.bmi, (r.weight / POWER(r.height/100, 2))) as bmi, r.bmi_status,
         r.ideal_weight, r.body_fat_pct, r.fat_mass,
         r.lean_body_mass, r.health_score,
         r.fee, r.payment_method, r.transaction_id,
         u.user_id, u.full_name, u.age, u.gender, u.mobile_number,
         p.machine_id, p.location AS machine_location
       FROM   reports  r
       LEFT JOIN users    u ON u.user_id    = r.user_id
       JOIN      products p ON p.machine_id = r.machine_id
       WHERE  ${whereClause}
       ORDER BY r.report_date DESC
       LIMIT  ? OFFSET ?`,
      [...baseParams, limitStr, offsetStr],
    );

    return res.status(200).json({
      success: true,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      reports: rows,
    });
  } catch (err) {
    console.error('❌ getReports error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ─── GET Report By ID ─────────────────────────────────────────────────────────

/**
 * GET /api/v1/partner/reports/:id
 * :id = report_id
 * Ensures the report belongs to a machine under the partner's org.
 */
const getReportById = async (req, res) => {
  try {
    const { org_id } = req.user;
    const { id }     = req.params;

    const rows = await query(
      `SELECT
         r.report_id, r.report_date,
         r.height, r.weight, COALESCE(r.bmi, (r.weight / POWER(r.height/100, 2))) as bmi, r.bmi_status,
         r.ideal_weight, r.body_fat_pct, r.fat_mass,
         r.lean_body_mass, r.health_score,
         r.fee, r.payment_method, r.transaction_id,
         u.user_id, u.full_name, u.age, u.gender, u.mobile_number,
         p.machine_id, p.location AS machine_location, p.org_id
       FROM   reports  r
       LEFT JOIN users    u ON u.user_id    = r.user_id
       JOIN      products p ON p.machine_id = r.machine_id
       WHERE  r.report_id = ?
       LIMIT  1`,
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Report not found.' });
    }

    if (rows[0].org_id !== org_id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    return res.status(200).json({ success: true, report: rows[0] });
  } catch (err) {
    console.error('❌ getReportById error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ─── GET Transactions ─────────────────────────────────────────────────────────

/**
 * GET /api/v1/partner/transactions
 * Query params: page, limit, from (YYYY-MM-DD), to (YYYY-MM-DD)
 * Joins order_requests → products to scope to partner's org.
 */
const getTransactions = async (req, res) => {
  try {
    const { org_id } = req.user;
    if (!org_id) {
      return res.status(403).json({ success: false, message: 'No organisation linked to this account.' });
    }

    const { page, limit, offset, limitStr, offsetStr } = parsePagination(req.query);
    const { clause: dateClause, params: dateParams } = buildDateFilter(req.query, 'o.payment_completed_at');

    const whereClause = `p.org_id = ? AND o.payment_status = 'paid'${dateClause ? ' AND ' + dateClause : ''}`;
    const baseParams  = [org_id, ...dateParams];

    // ── Total count ───────────────────────────────────────────────────────
    const [{ total }] = await query(
      `SELECT COUNT(*) AS total
       FROM   order_requests o
       JOIN   products       p ON p.machine_id = o.machine_id
       WHERE  ${whereClause}`,
      baseParams,
    );

    // ── Paginated rows ────────────────────────────────────────────────────
    const rows = await query(
      `SELECT
         o.order_id, o.mobile_number, o.machine_id,
         o.test_fee, o.payment_gateway, o.payment_method,
         o.payment_id, o.payment_status, o.order_status,
         o.report_id, o.payment_completed_at, o.scan_timestamp,
         p.location AS machine_location
       FROM   order_requests o
       JOIN   products       p ON p.machine_id = o.machine_id
       WHERE  ${whereClause}
       ORDER BY o.payment_completed_at DESC
       LIMIT  ? OFFSET ?`,
      [...baseParams, limitStr, offsetStr],
    );

    return res.status(200).json({
      success: true,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      transactions: rows,
    });
  } catch (err) {
    console.error('❌ getTransactions error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ─── GET Transaction By ID ────────────────────────────────────────────────────

/**
 * GET /api/v1/partner/transactions/:id
 * :id = order_id
 */
const getTransactionById = async (req, res) => {
  try {
    const { org_id } = req.user;
    const { id }     = req.params;

    const rows = await query(
      `SELECT
         o.order_id, o.mobile_number, o.machine_id,
         o.test_fee, o.payment_gateway, o.payment_method,
         o.payment_id, o.payment_status, o.order_status,
         o.report_id, o.payment_completed_at, o.scan_timestamp,
         o.bmi_data, o.error_message,
         p.location AS machine_location, p.org_id
       FROM   order_requests o
       JOIN   products       p ON p.machine_id = o.machine_id
       WHERE  o.order_id = ?
       LIMIT  1`,
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    if (rows[0].org_id !== org_id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    return res.status(200).json({ success: true, transaction: rows[0] });
  } catch (err) {
    console.error('❌ getTransactionById error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getProfile,
  updateProfile,
  getReports,
  getReportById,
  getTransactions,
  getTransactionById,
};