// middleware/authMiddleware.js
require('dotenv').config();
const jwt = require('jsonwebtoken');

/**
 * Middleware to verify JWT token
 * Add this to routes that require authentication
 */
const authenticateToken = (req, res, next) => {
    try {
        // Get token from header
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Access token is required'
            });
        }

        // Verify token
        jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
            if (err) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid or expired token'
                });
            }

            // Add user to request object
            req.user = user;
            next();
        });
    } catch (error) {
        console.error('Auth Middleware Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Authentication failed',
            error: error.message
        });
    }
};

/**
 * Middleware to optionally authenticate
 * User data will be available if valid token is provided
 * But route will work even without token
 */
const optionalAuth = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return next();
        }

        jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
            if (!err) {
                req.user = user;
            }
            next();
        });
    } catch (error) {
        next();
    }
};

/**
 * Generate JWT token for user
 * @param {Object} payload - User data to encode in token
 * @param {string} expiresIn - Token expiry time (default: 365 days)
 * @returns {string} JWT token  '30s' '15m' '365d'
 */
const generateToken = (payload, expiresIn = '365d') => {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is not configured');
    }

    return jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: expiresIn
    });
};

/**
 * Generate refresh token (longer expiry)
 * @param {Object} payload - User data to encode in token
 * @returns {string} Refresh token
 */
const generateRefreshToken = (payload) => {
    if (!process.env.JWT_REFRESH_SECRET) {
        throw new Error('JWT_REFRESH_SECRET is not configured');
    }

    return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
        expiresIn: '366d'
    });
};

/**
 * Verify refresh token
 * @param {string} token - Refresh token to verify
 * @returns {Object} Decoded token payload
 */
const verifyRefreshToken = (token) => {
    if (!process.env.JWT_REFRESH_SECRET) {
        throw new Error('JWT_REFRESH_SECRET is not configured');
    }

    return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
};

module.exports = {
    authenticateToken,
    optionalAuth,
    generateToken,
    generateRefreshToken,
    verifyRefreshToken
};