// routes/orders.js
const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * POST /api/v1/orders/create
 * Create order from QR scan (requires authentication)
 * 
 * Flow: QR Scan → Decrypt → Store → Return data to frontend
 */
router.post('/create', authenticateToken, orderController.createOrder);

/**
 * PUT /api/v1/orders/:orderId/user
 * Update order with selected user_id
 * Called from SelectUser screen when user selects someone
 */
router.put('/:orderId/user', authenticateToken, orderController.updateOrderUser);

/**
 * GET /api/v1/orders/:orderId
 * Get order details by order_id
 */
router.get('/:orderId', authenticateToken, orderController.getOrderById);

/**
 * GET /api/v1/orders/user/:userId
 * Get all orders for a specific user
 */
router.get('/user/:userId', authenticateToken, orderController.getOrdersByUser);

module.exports = router;