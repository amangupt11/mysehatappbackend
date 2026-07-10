// controllers/reportController.js

const db = require('../config/db');

/**
 * =============================================================================
 * REPORT CONTROLLER
 * Handles fetching and managing BMI reports for authenticated users
 * =============================================================================
 */

/**
 * GET /api/reports
 * Get all reports for the authenticated user's mobile number
 * Includes reports for SuperUser and all FamilyUsers
 */
async function getAllReports(req, res) {
    try {
        // ✅ FIXED: JWT contains 'mobileNumber' (camelCase), not 'mobile_number'
        const mobileNumber = req.user.mobileNumber;
        
        if (!mobileNumber) {
            console.error('❌ No mobile number found in token');
            console.error('Token contents:', req.user);
            return res.status(400).json({
                success: false,
                message: 'Invalid authentication token - no mobile number found'
            });
        }
        
        console.log('📊 Fetching all reports for mobile:', mobileNumber);
        
        // Single optimized query with JOIN - fetch ALL fields from reports table
        const reports = await db.query(
            `SELECT 
                r.report_id,
                r.user_id,
                r.report_date,
                r.machine_id,
                r.fee,
                r.transaction_id,
                r.payment_method,
                r.height,
                r.weight,
                r.bmi,
                r.bmi_status,
                r.ideal_weight,
                r.body_fat_pct,
                r.fat_mass,
                r.lean_body_mass,
                r.health_score,
                r.created_at,
                r.updated_at,
                u.full_name,
                u.age,
                u.gender,
                u.user_type
             FROM reports r
             INNER JOIN users u ON r.user_id = u.user_id
             WHERE u.mobile_number = ?
             ORDER BY r.report_date DESC`,
            [mobileNumber]
        );
        
        console.log(`✅ Found ${reports.length} reports for ${mobileNumber}`);
        
        // Just format the data, no calculations
        const formattedReports = reports.map(report => ({
            report_id: report.report_id,
            user_id: report.user_id,
            user_name: report.full_name,
            age: report.age,
            gender: report.gender,
            user_type: report.user_type,
            report_date: report.report_date,
            machine_id: report.machine_id,
            payment_details: {
                fee: parseFloat(report.fee || 0),
                transaction_id: report.transaction_id,
                payment_method: report.payment_method
            },
            vitals: {
                height: parseFloat(report.height),
                weight: parseFloat(report.weight),
                bmi: parseFloat(report.bmi),
                bmi_status: report.bmi_status,
                ideal_weight: parseFloat(report.ideal_weight),
                body_fat_pct: parseFloat(report.body_fat_pct),
                fat_mass: parseFloat(report.fat_mass),
                lean_body_mass: parseFloat(report.lean_body_mass),
                health_score: parseFloat(report.health_score)
            },
            created_at: report.created_at,
            updated_at: report.updated_at
        }));
        
        res.status(200).json({
            success: true,
            count: formattedReports.length,
            data: formattedReports
        });
        
    } catch (error) {
        console.error('❌ Error fetching reports:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch reports',
            error: error.message
        });
    }
}

/**
 * GET /api/reports/:id
 * Get a specific report by report_id
 * Validates that the report belongs to the authenticated user
 */
async function getReportById(req, res) {
    try {
        const reportId = req.params.id;
        // ✅ FIXED: JWT contains 'mobileNumber' (camelCase), not 'mobile_number'
        const mobileNumber = req.user.mobileNumber;
        
        if (!mobileNumber) {
            console.error('❌ No mobile number found in token');
            console.error('Token contents:', req.user);
            return res.status(400).json({
                success: false,
                message: 'Invalid authentication token - no mobile number found'
            });
        }
        
        console.log('📄 Fetching report:', reportId, 'for mobile:', mobileNumber);
        
        // Fetch report with ownership validation - ALL fields from reports table
        const reports = await db.query(
            `SELECT 
                r.report_id,
                r.user_id,
                r.report_date,
                r.machine_id,
                r.fee,
                r.transaction_id,
                r.payment_method,
                r.height,
                r.weight,
                r.bmi,
                r.bmi_status,
                r.ideal_weight,
                r.body_fat_pct,
                r.fat_mass,
                r.lean_body_mass,
                r.health_score,
                r.created_at,
                r.updated_at,
                u.full_name,
                u.age,
                u.gender,
                u.user_type,
                u.mobile_number
             FROM reports r
             INNER JOIN users u ON r.user_id = u.user_id
             WHERE r.report_id = ?`,
            [reportId]
        );
        
        if (reports.length === 0) {
            console.log('⚠️ Report not found:', reportId);
            return res.status(404).json({
                success: false,
                message: 'Report not found'
            });
        }
        
        const report = reports[0];
        
        // Validate ownership - ensure report belongs to this mobile number
        if (report.mobile_number !== mobileNumber) {
            console.log('🚫 Unauthorized access attempt for report:', reportId);
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to access this report'
            });
        }
        
        console.log('✅ Report found and authorized:', reportId);
        
        // Format response - NO CALCULATIONS, just raw data from database
        const formattedReport = {
            report_id: report.report_id,
            user_id: report.user_id,
            user_details: {
                name: report.full_name,
                age: report.age,
                gender: report.gender,
                user_type: report.user_type
            },
            vitals: {
                height: parseFloat(report.height),
                weight: parseFloat(report.weight),
                bmi: parseFloat(report.bmi),
                bmi_status: report.bmi_status,
                ideal_weight: parseFloat(report.ideal_weight),
                body_fat_pct: parseFloat(report.body_fat_pct),
                fat_mass: parseFloat(report.fat_mass),
                lean_body_mass: parseFloat(report.lean_body_mass),
                health_score: parseFloat(report.health_score)
            },
            machine_id: report.machine_id,
            payment_details: {
                fee: parseFloat(report.fee || 0),
                transaction_id: report.transaction_id,
                payment_method: report.payment_method
            },
            report_date: report.report_date,
            created_at: report.created_at,
            updated_at: report.updated_at
        };
        
        res.status(200).json({
            success: true,
            data: formattedReport
        });
        
    } catch (error) {
        console.error('❌ Error fetching report by ID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch report',
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
    getAllReports,
    getReportById
};