// controllers/partnerAuthController.js
'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const {
  generateToken,
  generateRefreshToken,
  verifyRefreshToken,
} = require('../middleware/authMiddleware');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safe DB fetch — returns null instead of throwing on no-row
 * @param {string} email
 */
async function findAdminByEmail(email) {
  const rows = await query(
    `SELECT auth_id, username, email, mobile_number, password,
            role, org_id, status, otp, otp_expires_at
     FROM   auth
     WHERE  email = ?
     LIMIT  1`,
    [email],
  );
  return rows.length ? rows[0] : null;
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * POST /api/v1/partner-auth/login
 * Body: { email, password }
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // ── 1. Input validation ───────────────────────────────────────────────
    if (!email?.trim() || !password?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.',
      });
    }

    const emailLower = email.trim().toLowerCase();

    // ── 2. Fetch user ─────────────────────────────────────────────────────
    const admin = await findAdminByEmail(emailLower);

    // Constant-time guard — always compare even if user not found
    // prevents timing-based user enumeration attacks
    const dummyHash = '$2b$12$invalidsaltthatisexactly22chars..invalidhash';
    const hashToCompare = admin ? admin.password : dummyHash;
    const passwordMatch = await bcrypt.compare(password, hashToCompare);

    if (!admin || !passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // ── 3. Role check ─────────────────────────────────────────────────────
    if (admin.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Partner portal is for admin accounts only.',
      });
    }

    // ── 4. Status check ───────────────────────────────────────────────────
    if (admin.status !== 'Active') {
      return res.status(403).json({
        success: false,
        message: 'Your account has been suspended. Please contact support.',
      });
    }

    // ── 5. Generate tokens ────────────────────────────────────────────────
    const tokenPayload = {
      auth_id:  admin.auth_id,
      email:    admin.email,
      role:     admin.role,
      org_id:   admin.org_id,
      username: admin.username,
    };

    const accessToken  = generateToken(tokenPayload);        // 365d — JWT_SECRET
    const refreshToken = generateRefreshToken(tokenPayload); // 366d — JWT_REFRESH_SECRET

    console.log(`✅ Partner login: ${admin.email} (${admin.auth_id})`);

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      accessToken,
      refreshToken,
      partner: {
        auth_id:  admin.auth_id,
        username: admin.username,
        email:    admin.email,
        role:     admin.role,
        org_id:   admin.org_id,
        status:   admin.status,
      },
    });
  } catch (err) {
    console.error('❌ partnerAuth.login error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal server error. Please try again later.',
    });
  }
};

/**
 * POST /api/v1/partner-auth/refresh-token
 * Body: { refreshToken }
 */
const refreshAccessToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token is required.',
      });
    }

    // ── Verify refresh token (JWT_REFRESH_SECRET) ─────────────────────────
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired refresh token. Please log in again.',
      });
    }

    // ── Ensure admin still exists and is active ───────────────────────────
    const admin = await findAdminByEmail(decoded.email);

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Account not found. Please log in again.',
      });
    }

    if (admin.status !== 'Active') {
      return res.status(403).json({
        success: false,
        message: 'Your account has been suspended.',
      });
    }

    if (admin.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied.',
      });
    }

    // ── Issue new access token ────────────────────────────────────────────
    const tokenPayload = {
      auth_id:  admin.auth_id,
      email:    admin.email,
      role:     admin.role,
      org_id:   admin.org_id,
      username: admin.username,
    };

    const newAccessToken = generateToken(tokenPayload);

    console.log(`🔄 Token refreshed for: ${admin.email}`);

    return res.status(200).json({
      success:     true,
      message:     'Token refreshed successfully.',
      accessToken: newAccessToken,
    });
  } catch (err) {
    console.error('❌ partnerAuth.refreshToken error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal server error.',
    });
  }
};

/**
 * POST /api/v1/partner-auth/reset-password
 * Body: { resetToken, newPassword }
 *
 * resetToken is issued by generateToken() → signed with JWT_SECRET
 * So we verify it with JWT_SECRET directly — NOT JWT_REFRESH_SECRET
 */
const resetPassword = async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken?.trim() || !newPassword?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Reset token and new password are required.',
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters.',
      });
    }

    // ✅ FIX: resetToken was signed with JWT_SECRET (via generateToken)
    // so verify it with JWT_SECRET — not JWT_REFRESH_SECRET
    let decoded;
    try {
      decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired reset token. Please start over.',
      });
    }

    // ── Guard: only accept tokens issued for password reset ───────────────
    if (decoded.purpose !== 'password_reset') {
      return res.status(401).json({
        success: false,
        message: 'Invalid reset token.',
      });
    }

    // ── Hash & update password ────────────────────────────────────────────
    const hashed = await bcrypt.hash(newPassword, 12);

    await query(
      `UPDATE auth SET password = ? WHERE auth_id = ?`,
      [hashed, decoded.auth_id],
    );

    console.log(`🔑 Password reset for auth_id: ${decoded.auth_id}`);

    return res.status(200).json({
      success: true,
      message: 'Password reset successfully. Please log in with your new password.',
    });
  } catch (err) {
    console.error('❌ partnerAuth.resetPassword error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal server error.',
    });
  }
};

/**
 * POST /api/v1/partner-auth/logout
 * Protected — requires valid access token
 * Stateless: client is responsible for deleting the token
 */
const logout = async (req, res) => {
  try {
    console.log(`👋 Partner logout: ${req.user?.email}`);

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully.',
    });
  } catch (err) {
    console.error('❌ partnerAuth.logout error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal server error.',
    });
  }
};

const getMe = async (req, res) => {
  try {
    const admin = await findAdminByEmail(req.user.email);
    if (!admin) return res.status(404).json({ success: false, message: 'Account not found.' });
    return res.status(200).json({ success: true, partner: { auth_id: admin.auth_id, username: admin.username, email: admin.email, role: admin.role, org_id: admin.org_id, status: admin.status } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = {
  login,
  refreshAccessToken,
  resetPassword,
  logout,
  getMe
};