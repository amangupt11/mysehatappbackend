// controllers/waAuthController.js
require('dotenv').config();

const msg91AuthService = require('../services/msg91AuthService');
const {
  generateToken,
  generateRefreshToken,
  verifyRefreshToken,
} = require('../middleware/authMiddleware');
const db = require('../config/db');

/**
 * POST /api/wa-auth/verify-login
 * Main WhatsApp OTP Login Endpoint (MSG91 widget) + TEST MODE
 * ✅ FINAL FIX: Prevents duplicate user creation
 */
const verifyLogin = async (req, res) => {
  try {
    const { mobile, accessToken } = req.body || {};

    if (!mobile || !accessToken) {
      return res.status(400).json({
        success: false,
        message: 'mobile and accessToken are required',
      });
    }

    // 1) Validate mobile format
    const validation = msg91AuthService.validateMobileNumber(mobile);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.message || 'Invalid mobile number',
      });
    }

    const mobileNumber = validation.mobile;
    const isTestMobile = validation.isTestMobile || false;

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔐 LOGIN ATTEMPT');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Mobile:', mobileNumber);
    console.log('Test Mode:', isTestMobile ? '🧪 YES' : '❌ NO');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // 2) Verify MSG91 access token (server-side) OR test token
    const verificationResult = await msg91AuthService.verifyAccessToken(
      accessToken,
      mobileNumber
    );

    if (!verificationResult.success || !verificationResult.verified) {
      console.error('❌ Verification failed:', verificationResult);
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired OTP token',
        error: verificationResult.message,
      });
    }

    if (isTestMobile) {
      console.log('✅ TEST MODE: Token verified for test user');
    } else {
      console.log('✅ PRODUCTION: MSG91 token verified');
    }

    // 3) Upsert into user_auth table for audit/logging
    try {
      await db.query(
        `INSERT INTO user_auth 
           (mobile_number, msg91_access_token, channel, provider, msg91_verified, msg91_verified_at)
         VALUES 
           (?, ?, ?, ?, 1, NOW())
         ON DUPLICATE KEY UPDATE
           msg91_access_token = VALUES(msg91_access_token),
           msg91_verified = 1,
           msg91_verified_at = NOW(),
           channel = VALUES(channel),
           provider = VALUES(provider),
           created_date = CURRENT_TIMESTAMP`,
        [
          mobileNumber,
          accessToken,
          'whatsapp',
          isTestMobile ? 'test_mode' : 'msg91_widget',
        ]
      );
      console.log('🗄  user_auth upserted for', mobileNumber);
    } catch (logErr) {
      console.error('⚠️ Failed to write user_auth record:', logErr.message);
      // Do NOT block login just because logging failed
    }

    // ============================================================================
    // ✅ CRITICAL FIX: First check if ANY user exists for this mobile
    // ============================================================================
    console.log('🔍 Checking for existing users...');
    const existingUsers = await db.getAllUsersByMobile(mobileNumber);

    let requiresProfileSetup = false;
    let primaryUser = null;

    if (!existingUsers || existingUsers.length === 0) {
      // ============================================================================
      // ✅ TRULY NEW USER - Create first time
      // ============================================================================
      console.log('🆕 No existing users found - creating new user');

      if (isTestMobile) {
        console.log('🧪 TEST MODE: Creating test user with pre-filled profile');
        const created = await db.createNewUser(
          mobileNumber,
          'Google Play Tester',
          25,
          'Male',
          'SuperUser'
        );

        const newUserId =
          typeof created === 'object'
            ? created.userId || created.user_id
            : created;

        primaryUser = {
          user_id: newUserId,
          mobile_number: mobileNumber,
          full_name: 'Google Play Tester',
          age: 25,
          gender: 'Male',
          user_type: 'SuperUser',
        };

        requiresProfileSetup = false;
        console.log('✅ Test user created with ID:', newUserId);
      } else {
        console.log('🆕 Creating new user with placeholder data');
        const created = await db.createNewUser(
          mobileNumber,
          'Unknown',
          30,
          'Other',
          'SuperUser'
        );

        const newUserId =
          typeof created === 'object'
            ? created.userId || created.user_id
            : created;

        primaryUser = {
          user_id: newUserId,
          mobile_number: mobileNumber,
          full_name: 'Unknown',
          age: 30,
          gender: 'Other',
          user_type: 'SuperUser',
        };

        requiresProfileSetup = true;
        console.log('✅ New user created with ID:', newUserId);
      }
    } else {
      // ============================================================================
      // ✅ EXISTING USER - Find and use SuperUser
      // ============================================================================
      console.log('✅ Found', existingUsers.length, 'existing user(s)');

      existingUsers.forEach(u => {
        console.log(`   - ${u.user_id}: ${u.full_name} (${u.user_type})`);
      });

      const superUsers = existingUsers.filter(u => u.user_type === 'SuperUser');

      if (superUsers.length === 0) {
        console.error('❌ CRITICAL: No SuperUser found for mobile:', mobileNumber);
        return res.status(500).json({
          success: false,
          message: 'Database error: No SuperUser found for this mobile number. Please contact support.',
        });
      }

      if (superUsers.length > 1) {
        console.warn('⚠️ WARNING: Multiple SuperUsers found:', superUsers.length);
        superUsers.forEach(u => {
          console.warn(`   - ${u.user_id} created at ${u.created_at}`);
        });
      }

      // Use the NEWEST SuperUser
      superUsers.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      primaryUser = superUsers[0];

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('✅ Using SuperUser:');
      console.log('   ID:', primaryUser.user_id);
      console.log('   Name:', primaryUser.full_name);
      console.log('   Age:', primaryUser.age);
      console.log('   Gender:', primaryUser.gender);
      console.log('   Created:', primaryUser.created_at);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      const hasDemo = await db.hasDemographics(mobileNumber);
      requiresProfileSetup = !hasDemo;
      console.log('Profile complete:', hasDemo ? 'YES' : 'NO');
    }

    // 5) Load all users for this mobile -> family members
    const allUsers = await db.getAllUsersByMobile(mobileNumber);
    const familyMembers =
      allUsers?.filter(u => u.user_id !== primaryUser.user_id) || [];

    console.log('Family members:', familyMembers.length);

    // 6) Generate JWT tokens with SuperUser ID
    const accessJwt = generateToken({
      userId: primaryUser.user_id,
      mobileNumber: primaryUser.mobile_number,
    });

    const refreshJwt = generateRefreshToken({
      userId: primaryUser.user_id,
      mobileNumber: primaryUser.mobile_number,
    });

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ LOGIN SUCCESSFUL');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('JWT User ID:', primaryUser.user_id);
    console.log('JWT Mobile:', primaryUser.mobile_number);
    console.log('Requires Profile Setup:', requiresProfileSetup);
    console.log('Test Mode:', isTestMobile ? '🧪 YES' : '❌ NO');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return res.json({
      success: true,
      message: 'Login successful',
      accessToken: accessJwt,
      refreshToken: refreshJwt,
      requiresProfileSetup,
      testMode: isTestMobile,
      user: {
        user_id: primaryUser.user_id,
        mobile_number: primaryUser.mobile_number,
        full_name: primaryUser.full_name,
        age: primaryUser.age,
        gender: primaryUser.gender,
        user_type: primaryUser.user_type,
      },
      familyMembers,
    });
  } catch (error) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ ERROR IN /wa-auth/verify-login');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('Error:', error);
    console.error('Stack:', error.stack);

    return res.status(500).json({
      success: false,
      message: 'Internal server error during login',
      error: error.message,
    });
  }
};

/**
 * POST /api/wa-auth/refresh-token
 * Refresh access token using refresh token
 * ✅ FIX: Now rotates refresh token on every refresh
 */
const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body || {};

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: 'refreshToken is required',
      });
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      console.error('❌ Invalid refresh token:', err.message);
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired refresh token',
      });
    }

    const payload = {
      userId: decoded.userId,
      mobileNumber: decoded.mobileNumber,
    };

    // ✅ FIX: Issue both a new access token AND a new refresh token (rotation)
    const newAccessToken = generateToken(payload);
    const newRefreshToken = generateRefreshToken(payload);

    console.log('✅ Tokens refreshed for user:', decoded.userId);

    return res.json({
      success: true,
      message: 'Tokens refreshed',
      accessToken: newAccessToken,
      refreshToken: newRefreshToken, // ✅ ADDED: Rotate refresh token
    });
  } catch (error) {
    console.error('❌ Error in /wa-auth/refresh-token:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error during token refresh',
      error: error.message,
    });
  }
};

/**
 * GET /api/auth/validate
 * Validate if user's token is still valid
 */
const validateToken = async (req, res) => {
  try {
    return res.json({
      success: true,
      message: 'Token is valid',
      userId: req.user.userId,
    });
  } catch (error) {
    console.error('❌ Token validation error:', error);
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }
};

/**
 * POST /api/wa-auth/logout
 * Simple logout endpoint (client should discard tokens)
 */
const logout = async (req, res) => {
  try {
    return res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    console.error('❌ Logout error:', error);
    return res.status(500).json({
      success: false,
      message: 'Logout failed',
      error: error.message,
    });
  }
};

/**
 * POST /api/wa-auth/complete-profile
 * Complete user profile after first login
 */
const completeProfile = async (req, res) => {
  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📝 COMPLETE PROFILE REQUEST');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const { fullName, age, gender } = req.body || {};
    const userId = req.user.userId;
    const mobileNumber = req.user.mobileNumber;

    console.log('User ID:', userId);
    console.log('Mobile:', mobileNumber);
    console.log('New Profile:', { fullName, age, gender });

    // Validate input
    if (!fullName || !age || !gender) {
      return res.status(400).json({
        success: false,
        message: 'fullName, age, and gender are required',
      });
    }

    const ageNum = parseInt(age);
    if (isNaN(ageNum) || ageNum < 1 || ageNum > 120) {
      return res.status(400).json({
        success: false,
        message: 'Age must be between 1 and 120',
      });
    }

    if (!['Male', 'Female', 'Other'].includes(gender)) {
      return res.status(400).json({
        success: false,
        message: 'Gender must be Male, Female, or Other',
      });
    }

    console.log('✅ Validation passed');

    console.log('💾 Updating user demographics...');
    await db.updateUserDemographics(userId, fullName, ageNum, gender);
    console.log('✅ Demographics updated');

    try {
      console.log('🎁 Giving reward credits...');
      const rewardCredits = 5;
      await db.giveRewardCredits(mobileNumber, rewardCredits);
      console.log(`✅ Gave ${rewardCredits} reward credits`);
    } catch (rewardError) {
      console.error('⚠️ Failed to give reward credits:', rewardError.message);
    }

    const user = await db.getUserById(userId);

    if (!user) {
      throw new Error('User not found after update');
    }

    console.log('✅ Profile completed successfully');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return res.json({
      success: true,
      message: 'Profile completed successfully',
      data: {
        userId: user.user_id,
        mobile: user.mobile_number,
        fullName: user.full_name,
        age: user.age,
        gender: user.gender,
      },
    });
  } catch (error) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ ERROR IN /wa-auth/complete-profile');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);

    return res.status(500).json({
      success: false,
      message: 'Internal server error during profile completion',
      error: error.message,
    });
  }
};

module.exports = {
  verifyLogin,
  refreshToken,
  validateToken,
  logout,
  completeProfile,
};