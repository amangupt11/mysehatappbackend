// routes/partnerAuthRoutes.js
'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const { authenticateToken } = require('../middleware/authMiddleware');
const {
  login,
  refreshAccessToken,
  resetPassword,
  logout,
  getMe
} = require('../controllers/partnerAuthController');

const router = express.Router();

// ─── Rate Limiters ────────────────────────────────────────────────────────────

/** Strict limiter for login — 50 attempts per 15 min per IP */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again after 15 minutes.',
  },
});


/** General auth limiter — 20 requests per 15 min per IP */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please slow down.',
  },
});

// ─── Public Routes (no token required) ───────────────────────────────────────

// POST /api/v1/partner-auth/login
router.post('/login', loginLimiter, login);

// POST /api/v1/partner-auth/refresh-token
router.post('/refresh-token', authLimiter, refreshAccessToken);

// POST /api/v1/partner-auth/reset-password
router.post('/reset-password', authLimiter, resetPassword);

// ─── Protected Routes (valid access token required) ───────────────────────────

// POST /api/v1/partner-auth/logout
router.post('/logout', authenticateToken, logout);
router.get('/partner-validate', authenticateToken, getMe);

module.exports = router;