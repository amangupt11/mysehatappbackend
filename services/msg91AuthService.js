// services/msg91AuthService.js - WhatsApp OTP widget verification with TEST MODE
const axios = require('axios');
require('dotenv').config();

const VERIFY_URL =
  process.env.MSG91_VERIFY_URL ||
  'https://control.msg91.com/api/v5/widget/verifyAccessToken';

// ============================================================================
// 🧪 TEST MODE CONFIGURATION - FOR GOOGLE PLAY CONSOLE TESTING
// ============================================================================
const TEST_MODE_ENABLED = process.env.ENABLE_TEST_AUTH === 'true';
const TEST_MOBILE = '919876543210'; // Test mobile with country code
const TEST_OTP = '654321'; // Test OTP code

/**
 * Check if this is a test authentication request
 */
function isTestRequest(mobile, otp = null) {
  if (!TEST_MODE_ENABLED) {
    return false;
  }
  
  // Clean the mobile number for comparison
  const cleanMobile = mobile.toString().replace(/\D/g, '');
  const fullMobile = cleanMobile.startsWith('91') ? cleanMobile : '91' + cleanMobile;
  
  // Check if it's the test mobile
  const isTestMobile = fullMobile === TEST_MOBILE;
  
  // If OTP is provided, also verify it matches
  if (otp !== null) {
    return isTestMobile && otp === TEST_OTP;
  }
  
  return isTestMobile;
}

/**
 * Generate a fake MSG91 access token for test mode
 * This mimics the structure of a real MSG91 token
 */
function generateTestAccessToken() {
  const header = Buffer.from(JSON.stringify({
    typ: 'JWT',
    alg: 'HS256'
  })).toString('base64');
  
  const payload = Buffer.from(JSON.stringify({
    requestId: 'TEST_' + Date.now(),
    companyId: 999999,
    mobile: TEST_MOBILE,
    testMode: true,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  })).toString('base64');
  
  const signature = 'TEST_SIGNATURE_' + Date.now();
  
  return `${header}.${payload}.${signature}`;
}

/**
 * Verify access token from MSG91 WhatsApp OTP widget.
 * Called AFTER the user successfully enters OTP in the widget.
 * 
 * 🧪 TEST MODE: If mobile is 9876543210, bypass MSG91 and return success
 */
async function verifyAccessToken(accessToken, mobile = null) {
  try {
    // ============================================================================
    // 🧪 TEST MODE BYPASS
    // ============================================================================
    if (TEST_MODE_ENABLED && mobile) {
      const cleanMobile = mobile.toString().replace(/\D/g, '');
      const fullMobile = cleanMobile.startsWith('91') ? cleanMobile : '91' + cleanMobile;
      
      if (fullMobile === TEST_MOBILE) {
        console.log('🧪 TEST MODE: Bypassing MSG91 verification for test user');
        console.log('Test Mobile:', TEST_MOBILE);
        console.log('Test Access Token:', accessToken.substring(0, 50) + '...');
        
        // Check if this is a test token
        const isTestToken = accessToken.includes('TEST_') || accessToken.startsWith('test_');
        
        if (isTestToken) {
          return {
            success: true,
            verified: true,
            message: 'Test authentication successful',
            testMode: true,
            raw: {
              type: 'success',
              message: 'Test mode - authentication bypassed',
              verified: true,
              testUser: true
            },
          };
        }
      }
    }
    
    // ============================================================================
    // PRODUCTION MODE: Normal MSG91 verification
    // ============================================================================
    const authKey = process.env.MSG91_AUTH_KEY || process.env.MSG91_OTP_KEY;

    if (!authKey) {
      throw new Error('MSG91_AUTH_KEY (or MSG91_OTP_KEY) is not configured');
    }

    if (!accessToken) {
      return {
        success: false,
        verified: false,
        message: 'Access token is required',
      };
    }

    console.log('🔐 Verifying MSG91 access token...');
    
    // Call MSG91 server-side verify API
    const response = await axios.post(
      VERIFY_URL,
      {
        authkey: authKey,
        'access-token': accessToken,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );

    const data = response.data || {};

    // ⚠️ Adjust this condition if MSG91 returns a slightly different structure
    const isSuccess =
      (data.type && data.type.toLowerCase() === 'success') ||
      data.verified === true ||
      data.isVerified === true;

    if (!isSuccess) {
      return {
        success: false,
        verified: false,
        message: data.message || 'MSG91 verification failed',
        raw: data,
      };
    }

    console.log('✅ MSG91 token verified successfully');
    
    return {
      success: true,
      verified: true,
      message: 'MSG91 token verified successfully',
      raw: data,
    };
  } catch (error) {
    console.error('MSG91 verifyAccessToken error:', error.message);

    return {
      success: false,
      verified: false,
      message: 'Failed to verify access token with MSG91',
      error: error.message,
    };
  }
}

/**
 * Basic mobile validation for India numbers.
 * Accepts 10-digit numbers starting with 6–9.
 */
function validateMobileNumber(mobile) {
  if (!mobile) {
    return {
      valid: false,
      message: 'Mobile number is required',
    };
  }

  const cleanMobile = mobile.toString().replace(/\D/g, '');

  if (!/^[6-9]\d{9}$/.test(cleanMobile)) {
    return {
      valid: false,
      message: 'Invalid mobile number format (must be 10 digits starting with 6-9)',
    };
  }

  const fullMobile = '91' + cleanMobile;
  
  // 🧪 Check if this is a test mobile
  const isTest = TEST_MODE_ENABLED && fullMobile === TEST_MOBILE;

  return {
    valid: true,
    mobile: fullMobile,
    isTestMobile: isTest, // Flag to indicate this is a test mobile
  };
}

/**
 * 🧪 Verify test OTP for test mobile number
 * Returns true if mobile and OTP match test credentials
 */
function verifyTestOTP(mobile, otp) {
  if (!TEST_MODE_ENABLED) {
    return false;
  }
  
  const cleanMobile = mobile.toString().replace(/\D/g, '');
  const fullMobile = cleanMobile.startsWith('91') ? cleanMobile : '91' + cleanMobile;
  
  return fullMobile === TEST_MOBILE && otp === TEST_OTP;
}

module.exports = {
  verifyAccessToken,
  validateMobileNumber,
  isTestRequest,
  generateTestAccessToken,
  verifyTestOTP,
  TEST_MODE_ENABLED,
  TEST_MOBILE,
  TEST_OTP,
};