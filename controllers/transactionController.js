// controllers/transactionController.js

const db = require('../config/db');

/**
 * =============================================================================
 * TRANSACTION CONTROLLER
 * Handles fetching transaction history from reports table
 * =============================================================================
 */

/**
 * GET /api/transactions
 * Get all transactions for the authenticated user's mobile number
 * Returns only: transaction_id, report_date, fee from reports table
 */
async function getAllTransactions(req, res) {
    try {
        // ✅ Get mobile number from JWT token (camelCase)
        const mobileNumber = req.user.mobileNumber;
        
        if (!mobileNumber) {
            console.error('❌ No mobile number found in token');
            console.error('Token contents:', req.user);
            return res.status(400).json({
                success: false,
                message: 'Invalid authentication token - no mobile number found'
            });
        }
        
        console.log('💳 Fetching all transactions for mobile:', mobileNumber);
        
        // ✅ FIXED: Added INNER JOIN to users table
        const transactions = await db.query(
            `SELECT 
                r.transaction_id,
                r.report_date,
                r.fee,
                r.payment_method
             FROM reports r
             INNER JOIN users u ON r.user_id = u.user_id
             WHERE u.mobile_number = ?
             ORDER BY r.report_date DESC`,
            [mobileNumber]
        );
        
        console.log(`✅ Found ${transactions.length} transactions for ${mobileNumber}`);
        
        // Format response - only essential fields
        const formattedTransactions = transactions.map(txn => ({
            transaction_id: txn.transaction_id,
            report_date: txn.report_date,
            fee: parseFloat(txn.fee || 0),
            payment_method: txn.payment_method
        }));
        
        res.status(200).json({
            success: true,
            count: formattedTransactions.length,
            data: formattedTransactions
        });
        
    } catch (error) {
        console.error('❌ Error fetching transactions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch transactions',
            error: error.message
        });
    }
}

/**
 * GET /api/transactions/:id
 * Get a specific transaction by transaction_id
 * Validates that the transaction belongs to the authenticated user
 */
async function getTransactionById(req, res) {
    try {
        const transactionId = req.params.id;
        // ✅ Get mobile number from JWT token (camelCase)
        const mobileNumber = req.user.mobileNumber;
        
        if (!mobileNumber) {
            console.error('❌ No mobile number found in token');
            console.error('Token contents:', req.user);
            return res.status(400).json({
                success: false,
                message: 'Invalid authentication token - no mobile number found'
            });
        }
        
        console.log('💳 Fetching transaction:', transactionId, 'for mobile:', mobileNumber);
        
        // ✅ FIXED: Added mobile_number to SELECT and INNER JOIN
        const transactions = await db.query(
            `SELECT 
                r.transaction_id,
                r.report_date,
                r.fee,
                r.payment_method,
                u.mobile_number
             FROM reports r
             INNER JOIN users u ON r.user_id = u.user_id
             WHERE r.transaction_id = ?`,
            [transactionId]
        );
        
        if (transactions.length === 0) {
            console.log('⚠️ Transaction not found:', transactionId);
            return res.status(404).json({
                success: false,
                message: 'Transaction not found'
            });
        }
        
        const transaction = transactions[0];
        
        // Validate ownership - ensure transaction belongs to this mobile number
        if (transaction.mobile_number !== mobileNumber) {
            console.log('🚫 Unauthorized access attempt for transaction:', transactionId);
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to access this transaction'
            });
        }
        
        console.log('✅ Transaction found and authorized:', transactionId);
        
        // Format detailed response
        const formattedTransaction = {
            transaction_id: transaction.transaction_id,
            transaction_date: transaction.report_date,
            amount: parseFloat(transaction.fee || 0),
            payment_method: transaction.payment_method
        };
        
        res.status(200).json({
            success: true,
            data: formattedTransaction
        });
        
    } catch (error) {
        console.error('❌ Error fetching transaction by ID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch transaction',
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
    getAllTransactions,
    getTransactionById
};