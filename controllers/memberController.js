// controllers/memberController.js
/**
 * =============================================================================
 * Family Member Management Controller
 * 
 * Handles CRUD operations for family members (FamilyUser type users)
 * + Profile Update for logged-in SuperUser
 * 
 * - Get all family members for logged-in user
 * - Create new family member
 * - Get member by ID
 * - Update member details
 * - Delete member
 * - ✅ NEW: Update logged-in user's profile (email, profile_image, etc.)
 * 
 * All operations are scoped to the authenticated user's mobile number
 * =============================================================================
 */

const fs = require('fs');
const path = require('path');
const db = require('../config/db');

/**
 * GET /members
 * Get all family members for the authenticated user
 * ✅ Returns ALL users (SuperUser + FamilyUsers)
 */
async function getAllMembers(req, res) {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 GET ALL MEMBERS REQUEST');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        const mobileNumber = req.user.mobileNumber;
        console.log('Mobile number:', mobileNumber);
        
        const allUsers = await db.getAllUsersByMobile(mobileNumber);
        console.log('Total users found:', allUsers.length);
        
        // Sort: SuperUser first
        const sortedUsers = allUsers.sort((a, b) => {
            if (a.user_type === 'SuperUser') return -1;
            if (b.user_type === 'SuperUser') return 1;
            return 0;
        });
        
        // Format response
        const formattedMembers = sortedUsers.map(member => ({
            id: member.user_id,
            name: member.full_name,
            age: member.age,
            gender: member.gender,
            email: member.email || null,
            profileImage: member.profile_image || null,
            userType: member.user_type,
            createdAt: member.created_at,
            updatedAt: member.updated_at
        }));
        
        console.log('✅ Members retrieved successfully');
        console.log('SuperUser count:', formattedMembers.filter(m => m.userType === 'SuperUser').length);
        console.log('FamilyUser count:', formattedMembers.filter(m => m.userType === 'FamilyUser').length);
        
        return res.json({
            success: true,
            count: formattedMembers.length,
            members: formattedMembers
        });
        
    } catch (error) {
        console.error('❌ Error in getAllMembers:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve family members',
            error: error.message
        });
    }
}

/**
 * POST /members
 * Create a new family member
 * 
 * Body: { name, age, gender }
 */
async function createMember(req, res) {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('➕ CREATE MEMBER REQUEST');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        const mobileNumber = req.user.mobileNumber;
        const { name, age, gender } = req.body;
        
        console.log('Request data:', { mobileNumber, name, age, gender });
        
        // Validate input
        if (!name || !age || !gender) {
            return res.status(400).json({
                success: false,
                message: 'name, age, and gender are required'
            });
        }
        
        // Validate name
        const trimmedName = name.trim();
        if (trimmedName.length < 2) {
            return res.status(400).json({
                success: false,
                message: 'Name must be at least 2 characters long'
            });
        }
        
        if (trimmedName.length > 100) {
            return res.status(400).json({
                success: false,
                message: 'Name must be less than 100 characters'
            });
        }
        
        // Validate age
        const ageNum = parseInt(age);
        if (isNaN(ageNum) || ageNum < 1 || ageNum > 120) {
            return res.status(400).json({
                success: false,
                message: 'Age must be between 1 and 120'
            });
        }
        
        // Validate gender
        const validGenders = ['Male', 'Female', 'Other'];
        if (!validGenders.includes(gender)) {
            return res.status(400).json({
                success: false,
                message: 'Gender must be Male, Female, or Other'
            });
        }
        
        console.log('✅ Validation passed');
        
        // Check if user already exists with same name
        const existingUsers = await db.getAllUsersByMobile(mobileNumber);
        const duplicate = existingUsers.find(
            u => u.full_name.toLowerCase() === trimmedName.toLowerCase()
        );
        
        if (duplicate) {
            return res.status(409).json({
                success: false,
                message: `Family member with name "${trimmedName}" already exists`
            });
        }
        
        console.log('💾 Creating new family member...');
        
        // Create family member
        const newMember = await db.createNewUser(
            mobileNumber,
            trimmedName,
            ageNum,
            gender,
            'FamilyUser'
        );
        
        console.log('✅ Family member created:', newMember);
        
        // Get the created member details
        const memberId = newMember.user_id || newMember.id || newMember;
        const memberDetails = await db.getUserById(memberId);
        
        return res.status(201).json({
            success: true,
            message: 'Family member created successfully',
            member: {
                id: memberDetails.user_id,
                name: memberDetails.full_name,
                age: memberDetails.age,
                gender: memberDetails.gender,
                userType: memberDetails.user_type
            }
        });
        
    } catch (error) {
        console.error('❌ Error in createMember:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to create family member',
            error: error.message
        });
    }
}

/**
 * GET /members/:id
 * Get a specific family member by ID
 * ✅ Can fetch any user (SuperUser or FamilyUser)
 */
async function getMemberById(req, res) {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 GET MEMBER BY ID REQUEST');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        const mobileNumber = req.user.mobileNumber;
        const memberId = req.params.id;
        
        console.log('Request:', { mobileNumber, memberId });
        
        // Get member by ID
        const member = await db.getUserById(memberId);
        
        if (!member) {
            return res.status(404).json({
                success: false,
                message: 'Family member not found'
            });
        }
        
        // Verify member belongs to this mobile number
        if (member.mobile_number !== mobileNumber) {
            return res.status(403).json({
                success: false,
                message: 'Access denied: This family member does not belong to your account'
            });
        }
        
        console.log('✅ Member found:', member.user_id, 'Type:', member.user_type);
        
        return res.json({
            success: true,
            member: {
                id: member.user_id,
                name: member.full_name,
                age: member.age,
                gender: member.gender,
                email: member.email || null,
                profileImage: member.profile_image || null,
                userType: member.user_type,
                createdAt: member.created_at,
                updatedAt: member.updated_at
            }
        });
        
    } catch (error) {
        console.error('❌ Error in getMemberById:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve family member',
            error: error.message
        });
    }
}

/**
 * PUT /members/:id
 * Update a family member's details
 * ✅ Can update SuperUser or FamilyUser (name, age, gender)
 * ⚠️ Does NOT handle email or profile_image (use PUT /profile for that)
 */
async function updateMember(req, res) {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✏️ UPDATE MEMBER REQUEST');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        const mobileNumber = req.user.mobileNumber;
        const memberId = req.params.id;
        const { name, age, gender } = req.body;
        
        console.log('Request:', { mobileNumber, memberId, updates: { name, age, gender } });
        
        // Validate at least one field is provided
        if (!name && !age && !gender) {
            return res.status(400).json({
                success: false,
                message: 'At least one field (name, age, or gender) must be provided'
            });
        }
        
        // Get existing member
        const member = await db.getUserById(memberId);
        
        if (!member) {
            return res.status(404).json({
                success: false,
                message: 'Family member not found'
            });
        }
        
        // Verify ownership
        if (member.mobile_number !== mobileNumber) {
            return res.status(403).json({
                success: false,
                message: 'Access denied: This family member does not belong to your account'
            });
        }
        
        // Prepare update data
        const updates = [];
        const values = [];
        
        // Validate and add name
        if (name !== undefined) {
            const trimmedName = name.trim();
            if (trimmedName.length < 2) {
                return res.status(400).json({
                    success: false,
                    message: 'Name must be at least 2 characters long'
                });
            }
            if (trimmedName.length > 100) {
                return res.status(400).json({
                    success: false,
                    message: 'Name must be less than 100 characters'
                });
            }
            
            // Check for duplicate names (excluding current member)
            const existingUsers = await db.getAllUsersByMobile(mobileNumber);
            const duplicate = existingUsers.find(
                u => u.user_id !== memberId && 
                     u.full_name.toLowerCase() === trimmedName.toLowerCase()
            );
            
            if (duplicate) {
                return res.status(409).json({
                    success: false,
                    message: `Another family member with name "${trimmedName}" already exists`
                });
            }
            
            updates.push('full_name = ?');
            values.push(trimmedName);
        }
        
        // Validate and add age
        if (age !== undefined) {
            const ageNum = parseInt(age);
            if (isNaN(ageNum) || ageNum < 1 || ageNum > 120) {
                return res.status(400).json({
                    success: false,
                    message: 'Age must be between 1 and 120'
                });
            }
            updates.push('age = ?');
            values.push(ageNum);
        }
        
        // Validate and add gender
        if (gender !== undefined) {
            const validGenders = ['Male', 'Female', 'Other'];
            if (!validGenders.includes(gender)) {
                return res.status(400).json({
                    success: false,
                    message: 'Gender must be Male, Female, or Other'
                });
            }
            updates.push('gender = ?');
            values.push(gender);
        }
        
        // Add updated_at timestamp
        updates.push('updated_at = NOW()');
        
        console.log('✅ Validation passed, updating member...');
        
        // Perform update
        const updateQuery = `UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`;
        values.push(memberId);
        
        await db.query(updateQuery, values);
        
        console.log('✅ Member updated successfully');
        
        // Get updated member details
        const updatedMember = await db.getUserById(memberId);
        
        return res.json({
            success: true,
            message: 'Family member updated successfully',
            member: {
                id: updatedMember.user_id,
                name: updatedMember.full_name,
                age: updatedMember.age,
                gender: updatedMember.gender,
                userType: updatedMember.user_type
            }
        });
        
    } catch (error) {
        console.error('❌ Error in updateMember:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update family member',
            error: error.message
        });
    }
}

/**
 * DELETE /members/:id
 * Delete a family member
 */
async function deleteMember(req, res) {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🗑️ DELETE MEMBER REQUEST');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        const mobileNumber = req.user.mobileNumber;
        const memberId = req.params.id;
        
        console.log('Request:', { mobileNumber, memberId });
        
        // Get member
        const member = await db.getUserById(memberId);
        
        if (!member) {
            return res.status(404).json({
                success: false,
                message: 'Family member not found'
            });
        }
        
        // Verify ownership
        if (member.mobile_number !== mobileNumber) {
            return res.status(403).json({
                success: false,
                message: 'Access denied: This family member does not belong to your account'
            });
        }
        
        // Prevent deletion of SuperUser
        if (member.user_type === 'SuperUser') {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete: This is the primary account user'
            });
        }
        
        console.log('💾 Deleting family member...');
        
        // Hard delete
        const result = await db.query(
            'DELETE FROM users WHERE user_id = ?',
            [memberId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(500).json({
                success: false,
                message: 'Failed to delete family member'
            });
        }
        
        console.log('✅ Member deleted successfully');
        
        return res.json({
            success: true,
            message: 'Family member deleted successfully',
            deletedId: memberId
        });
        
    } catch (error) {
        console.error('❌ Error in deleteMember:', error);
        
        // Handle foreign key constraint errors
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(409).json({
                success: false,
                message: 'Cannot delete: This family member has associated reports or transactions. Contact support for assistance.'
            });
        }
        
        return res.status(500).json({
            success: false,
            message: 'Failed to delete family member',
            error: error.message
        });
    }
}

/**
 * ============================================================================
 * ✅ NEW: PUT /profile
 * Update logged-in user's profile (SuperUser)
 * 
 * Handles:
 * - Full Name
 * - Email (optional, must be unique)
 * - Age (from Date of Birth)
 * - Gender
 * - Profile Image (URL/path)
 * 
 * Body: {
 *   fullName?: string,
 *   email?: string,
 *   age?: number,
 *   gender?: 'Male' | 'Female' | 'Other',
 *   profileImage?: string
 * }
 * ============================================================================
 */
// ✅ Works with CONSISTENT random filenames + Cache-busting via timestamp

async function updateProfile(req, res) {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('👤 UPDATE PROFILE REQUEST');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const userId = req.user.userId;
        const mobileNumber = req.user.mobileNumber;
        const { fullName, email, age, gender } = req.body;

        console.log('User ID:', userId);
        console.log('Mobile:', mobileNumber);
        console.log('File received:', req.file ? req.file.filename : 'none');

        // Validation
        if (!fullName && !email && !age && !gender && !req.file) {
            return res.status(400).json({
                success: false,
                message: 'At least one field must be provided for update'
            });
        }

        // Get existing user
        const user = await db.getUserById(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Verify ownership
        if (user.mobile_number !== mobileNumber) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        console.log('✅ User verified');

        const updates = [];
        const values = [];

        // Full Name
        if (fullName !== undefined) {
            const trimmedName = fullName.trim();
            if (trimmedName.length < 2 || trimmedName.length > 255) {
                return res.status(400).json({
                    success: false,
                    message: 'Full name must be between 2 and 255 characters'
                });
            }
            updates.push('full_name = ?');
            values.push(trimmedName);
        }

        // Email
        if (email !== undefined) {
            if (email === '' || email === null) {
                updates.push('email = NULL');
            } else {
                const trimmedEmail = email.trim().toLowerCase();
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(trimmedEmail)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Invalid email format'
                    });
                }
                const existing = await db.query(
                    'SELECT user_id FROM users WHERE email = ? AND user_id != ?',
                    [trimmedEmail, userId]
                );
                if (existing.length > 0) {
                    return res.status(409).json({
                        success: false,
                        message: 'This email is already registered to another account'
                    });
                }
                updates.push('email = ?');
                values.push(trimmedEmail);
            }
        }

        // Age
        if (age !== undefined) {
            const ageNum = parseInt(age);
            if (isNaN(ageNum) || ageNum < 1 || ageNum > 120) {
                return res.status(400).json({
                    success: false,
                    message: 'Age must be between 1 and 120'
                });
            }
            updates.push('age = ?');
            values.push(ageNum);
        }

        // Gender
        if (gender !== undefined) {
            const validGenders = ['Male', 'Female', 'Other'];
            if (!validGenders.includes(gender)) {
                return res.status(400).json({
                    success: false,
                    message: 'Gender must be Male, Female, or Other'
                });
            }
            updates.push('gender = ?');
            values.push(gender);
        }

        // ============================================================================
        // ✅ PROFILE IMAGE - Consistent Random Filename + Cache-Busting
        // ============================================================================
        if (req.file) {
            // ✅ Base path (filename is always same for this user)
            const basePath = `/uploads/profiles/${userId}/${req.file.filename}`;
            
            // ✅ Add timestamp for cache-busting (URL changes but file stays same)
            const timestamp = Date.now();
            const newImagePath = `${basePath}?t=${timestamp}`;
            
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📸 PROFILE IMAGE UPDATE');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('User folder:', userId);
            console.log('Filename:', req.file.filename);
            console.log('Base path:', basePath);
            console.log('With cache-busting:', newImagePath);
            console.log('Old path in DB:', user.profile_image || 'None');
            console.log('ℹ️ Filename is CONSISTENT for this user (based on userId hash)');
            console.log('ℹ️ File auto-replaces (same filename)');
            console.log('ℹ️ Timestamp provides cache-busting');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            
            updates.push('profile_image = ?');
            values.push(newImagePath);
        }

        // Timestamp
        updates.push('updated_at = NOW()');

        // Execute update
        const updateQuery = `UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`;
        values.push(userId);

        console.log('💾 Updating database...');
        await db.query(updateQuery, values);
        
        const updatedUser = await db.getUserById(userId);
        console.log('✅ Database updated');
        console.log('New profile_image:', updatedUser.profile_image);

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ PROFILE UPDATE COMPLETED');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        return res.json({
            success: true,
            message: 'Profile updated successfully',
            data: {
                userId: updatedUser.user_id,
                fullName: updatedUser.full_name,
                email: updatedUser.email || null,
                age: updatedUser.age,
                gender: updatedUser.gender,
                profileImage: updatedUser.profile_image || null,
                mobile: updatedUser.mobile_number,
                updatedAt: updatedUser.updated_at
            }
        });

    } catch (error) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ ERROR IN UPDATE PROFILE');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);

        return res.status(500).json({
            success: false,
            message: 'Failed to update profile',
            error: error.message
        });
    }
}

/**
 * GET /profile
 * Get logged-in user's profile (optimized - no need to fetch all members)
 */
async function getMyProfile(req, res) {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('👤 GET MY PROFILE REQUEST');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        const userId = req.user.userId;
        const mobileNumber = req.user.mobileNumber;
        
        console.log('User ID:', userId);
        console.log('Mobile:', mobileNumber);
        
        // Get user by ID
        const user = await db.getUserById(userId);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        // Verify ownership
        if (user.mobile_number !== mobileNumber) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        console.log('✅ Profile retrieved:', user.full_name);
        
        return res.json({
            success: true,
            profile: {
                id: user.user_id,
                name: user.full_name,
                age: user.age,
                gender: user.gender,
                email: user.email || null,
                profileImage: user.profile_image || null,
                mobile: user.mobile_number,
                userType: user.user_type,
                createdAt: user.created_at,
                updatedAt: user.updated_at
            }
        });
        
    } catch (error) {
        console.error('❌ Error in getMyProfile:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve profile',
            error: error.message
        });
    }
}

module.exports = {
    getAllMembers,
    createMember,
    getMemberById,
    updateMember,
    deleteMember,
    updateProfile,
    getMyProfile,
};