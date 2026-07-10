// routes/reports.js 
const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Protect all routes
router.use(authenticateToken);

// Report Routes
router.get('/', reportController.getAllReports);        
router.get('/:id', reportController.getReportById);      

module.exports = router;