// routes/transaction.js
const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Protect all routes
router.use(authenticateToken);

// Transaction Routes
router.get('/', transactionController.getAllTransactions);        
router.get('/:id', transactionController.getTransactionById);      

module.exports = router;