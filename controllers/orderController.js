// controllers/orderController.js
const db = require('../config/db');
const { decryptVitals } = require('../utils/encryption');

/**
 * =============================================================================
 * ORDER CONTROLLER (SIMPLIFIED - NO RAZORPAY)
 * Handles QR scan, decrypt, store data, return to frontend
 * =============================================================================
 */

/**
 * POST /api/orders/create
 * Create order from QR scan
 * 
 * Request Body:
 * {
 *   "timestamp": "2025-12-30T10:53:15.000Z",
 *   "user_id": "UID1225-000017",
 *   "raw_payload": "Base64+XOR encrypted string",
 *   "mobile_number": "918604485702"
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "order_id": "ORD_1225_000042",
 *     "height": 165,
 *     "weight": 49.6,
 *     "bmi": 18.2,
 *     "machine_id": "MCH001",
 *     "test_fee": 199
 *   }
 * }
 */
async function createOrder(req, res) {
    let connection;
    try {
        const { timestamp, user_id, raw_payload, mobile_number } = req.body;
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 ORDER CREATION - QR SCAN');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Mobile:', mobile_number);
        console.log('User ID (optional):', user_id || 'NOT PROVIDED - will be set later');
        console.log('Timestamp:', timestamp);
        console.log('Raw Payload (first 50 chars):', raw_payload?.substring(0, 50) + '...');
        
        // 1. Validate input (user_id is now OPTIONAL)
        if (!timestamp || !raw_payload || !mobile_number) {
            console.error('❌ Missing required fields');
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: timestamp, raw_payload, mobile_number'
            });
        }
        
        // 2. Decrypt BMI data using XOR encryption
        console.log('🔓 Decrypting BMI data...');
        
        let vitals;
        let decryptedPayload;
        
        try {
            vitals = decryptVitals(raw_payload);
            decryptedPayload = vitals.plainText;
            
            console.log('✅ Decryption successful!');
            console.log('Plain text:', decryptedPayload);
            console.log('Height:', vitals.height, 'cm');
            console.log('Weight:', vitals.weight, 'kg');
            console.log('BMI:', vitals.bmi);
            console.log('Device ID:', vitals.deviceId);
            
        } catch (error) {
            console.error('❌ Decryption failed:', error.message);
            if (error.payload) {
                console.error('Decrypted payload:', error.payload);
            }
            return res.status(400).json({
                success: false,
                message: 'Invalid encrypted payload',
                error: error.message
            });
        }

        // 3. Fetch test fee from products table
        console.log('💰 Fetching test fee for machine:', vitals.deviceId);
        
        const products = await db.query(
            'SELECT fee FROM products WHERE machine_id = ? AND status = "Active"',
            [vitals.deviceId]
        );
        
        if (products.length === 0) {
            console.error('❌ Machine not found:', vitals.deviceId);
            return res.status(404).json({
                success: false,
                message: `Machine ${vitals.deviceId} not found or inactive`
            });
        }
        
        const testFee = parseFloat(products[0].fee);
        console.log('✅ Test fee:', testFee);
        
        // 4. Create BMI data object formatted for reports table DECIMAL(5,2)
        const bmiData = {
            height: parseFloat(vitals.height.toFixed(2)),
            weight: parseFloat(vitals.weight.toFixed(2)),
            bmi: parseFloat(vitals.bmi.toFixed(2)),
            machine_id: vitals.deviceId
        };
        
        console.log('✅ BMI Data:', bmiData);
        
        // 5. Start database transaction
        connection = await db.getConnection();
        await connection.beginTransaction();
        
        console.log('💾 Storing order in database...');
        
        // ✅ FIXED: Pass JS Date object directly instead of a formatted UTC string.
        // mysql2 (with timezone: '+05:30' in pool config) will correctly convert
        // the UTC Date to IST before storing — no more -5:30 hour offset.
        const scanDate = new Date(timestamp);
        
        console.log('Scan Date (UTC internally):', scanDate.toISOString());
        console.log('Will be stored as IST by mysql2 + pool timezone config');
        
        // 6. Insert into order_requests table
        await connection.execute(
            `INSERT INTO order_requests (
                user_id,
                mobile_number,
                machine_id,
                raw_payload,
                decrypted_payload,
                bmi_data,
                test_fee,
                order_status,
                scan_timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
            [
                user_id || null,
                mobile_number,
                vitals.deviceId,
                raw_payload,
                decryptedPayload,
                JSON.stringify(bmiData),
                testFee,
                scanDate  // ✅ FIXED: JS Date object (was: manually formatted UTC string)
            ]
        );
        
        // 7. Get the auto-generated order_id from trigger
        const [orderRows] = await connection.execute(
            `SELECT order_id, expires_at 
             FROM order_requests 
             WHERE mobile_number = ? 
             ORDER BY created_at DESC LIMIT 1`,
            [mobile_number]
        );
        
        if (orderRows.length === 0) {
            throw new Error('Failed to retrieve generated order_id');
        }
        
        const orderId = orderRows[0].order_id;
        const expiresAt = orderRows[0].expires_at;
        
        // 8. Commit transaction
        await connection.commit();
        
        console.log('✅ Order created successfully!');
        console.log('Order ID:', orderId);
        console.log('Expires at:', expiresAt);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        // 9. Return response to frontend
        res.status(200).json({
            success: true,
            message: 'Order created successfully',
            data: {
                order_id: orderId,
                height: bmiData.height,
                weight: bmiData.weight,
                bmi: bmiData.bmi,
                machine_id: vitals.deviceId,
                test_fee: testFee,
                expires_at: expiresAt
            }
        });
        
    } catch (error) {
        if (connection) {
            await connection.rollback();
            console.error('🔄 Transaction rolled back');
        }
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ ERROR CREATING ORDER');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        res.status(500).json({
            success: false,
            message: 'Failed to create order',
            error: error.message
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

/**
 * GET /api/orders/:orderId
 * Get order details by order_id
 */
async function getOrderById(req, res) {
    try {
        const { orderId } = req.params;
        
        console.log('📋 Fetching order:', orderId);
        
        const orders = await db.query(
            `SELECT 
                o.*,
                u.full_name
             FROM order_requests o
             LEFT JOIN users u ON o.user_id = u.user_id
             WHERE o.order_id = ?`,
            [orderId]
        );
        
        if (orders.length === 0) {
            console.log('❌ Order not found:', orderId);
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }
        
        const order = orders[0];
        
        // Parse JSON fields
        if (order.bmi_data && typeof order.bmi_data === 'string') {
            order.bmi_data = JSON.parse(order.bmi_data);
        }
        if (order.webhook_payload && typeof order.webhook_payload === 'string') {
            order.webhook_payload = JSON.parse(order.webhook_payload);
        }
        
        console.log('✅ Order found:', orderId);
        
        res.status(200).json({
            success: true,
            data: order
        });
        
    } catch (error) {
        console.error('❌ Error fetching order:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch order',
            error: error.message
        });
    }
}

/**
 * GET /api/orders/user/:userId
 * Get all orders for a specific user
 */
async function getOrdersByUser(req, res) {
    try {
        const { userId } = req.params;
        
        console.log('📋 Fetching orders for user:', userId);
        
        const orders = await db.query(
            `SELECT 
                o.order_id,
                o.machine_id,
                o.test_fee,
                o.order_status,
                o.payment_status,
                o.scan_timestamp,
                o.payment_completed_at,
                o.expires_at,
                o.bmi_data
             FROM order_requests o
             WHERE o.user_id = ?
             ORDER BY o.scan_timestamp DESC`,
            [userId]
        );
        
        // Parse JSON fields
        orders.forEach(order => {
            if (order.bmi_data && typeof order.bmi_data === 'string') {
                order.bmi_data = JSON.parse(order.bmi_data);
            }
        });
        
        console.log(`✅ Found ${orders.length} orders for user:`, userId);
        
        res.status(200).json({
            success: true,
            count: orders.length,
            data: orders
        });
        
    } catch (error) {
        console.error('❌ Error fetching user orders:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch orders',
            error: error.message
        });
    }
}

/**
 * PUT /api/orders/:orderId/user
 * Update order with selected user_id
 */
async function updateOrderUser(req, res) {
    try {
        const { orderId } = req.params;
        const { user_id } = req.body;
        
        console.log('👤 Updating order with selected user');
        console.log('Order ID:', orderId);
        console.log('Selected User ID:', user_id);
        
        if (!user_id) {
            return res.status(400).json({
                success: false,
                message: 'user_id is required'
            });
        }
        
        const result = await db.query(
            'UPDATE order_requests SET user_id = ? WHERE order_id = ?',
            [user_id, orderId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }
        
        console.log('✅ Order updated with user_id:', user_id);
        
        res.status(200).json({
            success: true,
            message: 'Order updated successfully',
            data: {
                order_id: orderId,
                user_id: user_id
            }
        });
        
    } catch (error) {
        console.error('❌ Error updating order user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update order',
            error: error.message
        });
    }
}

/**
 * =============================================================================
 * EXPORTS
 * =============================================================================
 */

module.exports = {
    createOrder,
    updateOrderUser,
    getOrderById,
    getOrdersByUser
};