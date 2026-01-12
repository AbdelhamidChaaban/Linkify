const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middleware/auth');

// Import Firebase Admin SDK
let adminDb = null;
function getAdminDb() {
    if (adminDb) return adminDb;
    
    try {
        const admin = require('firebase-admin');
        
        if (admin.apps.length === 0) {
            const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
                ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
                : null;
            
            if (!serviceAccount) {
                return null;
            }
            
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        
        adminDb = admin.firestore();
        return adminDb;
    } catch (error) {
        console.error('Error initializing Firebase Admin:', error.message);
        return null;
    }
}

/**
 * Create a new admin (enforces admin limit)
 * POST /api/admins
 */
router.post('/', authenticateJWT, async (req, res) => {
    try {
        const userId = req.userId; // From JWT token (Firebase UID)
        let { name, phone, type, password, quota, notUShare } = req.body;

        // Validate required fields
        if (!name || !phone || !type || !password) {
            return res.status(400).json({
                success: false,
                error: 'Name, phone, type, and password are required'
            });
        }
        
        // Normalize phone number: Remove spaces and Lebanon country code (+961 or 961)
        phone = phone.trim().replace(/\s+/g, ''); // Remove spaces first
        
        // Handle +961 prefix (e.g., "+96171935446")
        if (phone.startsWith('+961')) {
            phone = phone.substring(4); // Remove "+961"
        }
        // Handle 961 prefix (e.g., "96171935446")
        else if (phone.startsWith('961') && phone.length >= 11) {
            phone = phone.substring(3); // Remove "961"
        }
        
        // Remove any remaining non-digit characters
        phone = phone.replace(/\D/g, '');

        // Validate quota - only required for Open admins, not Closed
        let quotaNum = 0;
        if (type === 'Closed') {
            // Closed admins don't have quota - set to 0
            quotaNum = 0;
        } else {
            // Open admins require quota
            quotaNum = parseInt(quota) || 0;
            if (isNaN(quotaNum) || quotaNum < 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Quota must be a valid number (0 or greater)'
                });
            }
        }

        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({
                success: false,
                error: 'Database not available'
            });
        }

        const admin = require('firebase-admin');

        // Check user's admin limit
        const userRef = adminDbInstance.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        const userData = userDoc.data();
        
        // Check if user is blocked
        if (userData.isBlocked === true) {
            return res.status(403).json({
                success: false,
                error: 'Your account has been blocked. Please contact support.'
            });
        }

        // Get current admin count for this user
        const currentAdminCount = userData.adminCount !== undefined ? userData.adminCount : 0;
        const adminLimit = userData.adminLimit;

        // Enforce admin limit (if limit is set)
        if (adminLimit !== null && adminLimit !== undefined) {
            if (currentAdminCount >= adminLimit) {
                return res.status(403).json({
                    success: false,
                    error: `You have reached your admin limit (${adminLimit}). Please contact support to increase your limit.`,
                    adminLimit: adminLimit,
                    currentCount: currentAdminCount
                });
            }
        }

        // Create admin document
        const adminData = {
            name: name.trim(),
            phone: phone.trim(),
            type: type,
            status: type === 'Open' ? 'Open (Admin)' : 'Closed (Admin)',
            quota: quotaNum,
            notUShare: notUShare === true,
            password: password, // Note: In production, consider hashing this
            userId: userId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const adminRef = await adminDbInstance.collection('admins').add(adminData);
        const newAdminId = adminRef.id;

        // Update user's admin count atomically
        await userRef.update({
            adminCount: currentAdminCount + 1,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`✅ [Admin Creation] Created admin ${newAdminId} for user ${userId} (${currentAdminCount + 1}/${adminLimit !== null ? adminLimit : 'unlimited'})`);

        res.json({
            success: true,
            adminId: newAdminId,
            message: 'Admin created successfully'
        });

    } catch (error) {
        console.error('❌ Error creating admin:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to create admin'
        });
    }
});

/**
 * Update an existing admin
 * PUT /api/admins/:adminId
 */
router.put('/:adminId', authenticateJWT, async (req, res) => {
    try {
        const userId = req.userId;
        const { adminId } = req.params;
        let { name, phone, type, password, quota, notUShare } = req.body;

        // Validate required fields
        if (!name || !phone || !type) {
            return res.status(400).json({
                success: false,
                error: 'Name, phone, and type are required'
            });
        }
        
        // Normalize phone number: Remove spaces and Lebanon country code (+961 or 961)
        phone = phone.trim().replace(/\s+/g, ''); // Remove spaces first
        
        // Handle +961 prefix (e.g., "+96171935446")
        if (phone.startsWith('+961')) {
            phone = phone.substring(4); // Remove "+961"
        }
        // Handle 961 prefix (e.g., "96171935446")
        else if (phone.startsWith('961') && phone.length >= 11) {
            phone = phone.substring(3); // Remove "961"
        }
        
        // Remove any remaining non-digit characters
        phone = phone.replace(/\D/g, '');

        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({
                success: false,
                error: 'Database not available'
            });
        }

        const admin = require('firebase-admin');

        // Verify admin exists and belongs to user
        const adminRef = adminDbInstance.collection('admins').doc(adminId);
        const adminDoc = await adminRef.get();

        if (!adminDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Admin not found'
            });
        }

        const adminData = adminDoc.data();
        if (adminData.userId !== userId) {
            return res.status(403).json({
                success: false,
                error: 'You do not have permission to update this admin'
            });
        }

        // Update admin data
        const updateData = {
            name: name.trim(),
            phone: phone.trim(),
            type: type,
            status: type === 'Open' ? 'Open (Admin)' : 'Closed (Admin)',
            quota: parseInt(quota) || 0,
            notUShare: notUShare === true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // Only update password if provided
        if (password && password.trim()) {
            updateData.password = password.trim();
        }

        await adminRef.update(updateData);

        console.log(`✅ [Admin Update] Updated admin ${adminId} for user ${userId}`);

        res.json({
            success: true,
            message: 'Admin updated successfully'
        });

    } catch (error) {
        console.error('❌ Error updating admin:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to update admin'
        });
    }
});

/**
 * Delete an admin
 * DELETE /api/admins/:adminId
 */
router.delete('/:adminId', authenticateJWT, async (req, res) => {
    try {
        const userId = req.userId;
        const { adminId } = req.params;

        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({
                success: false,
                error: 'Database not available'
            });
        }

        const admin = require('firebase-admin');

        // Verify admin exists and belongs to user
        const adminRef = adminDbInstance.collection('admins').doc(adminId);
        const adminDoc = await adminRef.get();

        if (!adminDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Admin not found'
            });
        }

        const adminData = adminDoc.data();
        if (adminData.userId !== userId) {
            return res.status(403).json({
                success: false,
                error: 'You do not have permission to delete this admin'
            });
        }

        // Delete admin
        await adminRef.delete();

        // Update user's admin count atomically
        const userRef = adminDbInstance.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (userDoc.exists) {
            const userData = userDoc.data();
            const currentAdminCount = userData.adminCount !== undefined ? userData.adminCount : 0;
            const newAdminCount = Math.max(0, currentAdminCount - 1); // Ensure it doesn't go below 0

            await userRef.update({
                adminCount: newAdminCount,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log(`✅ [Admin Deletion] Deleted admin ${adminId} for user ${userId} (${newAdminCount} remaining)`);
        }

        res.json({
            success: true,
            message: 'Admin deleted successfully'
        });

    } catch (error) {
        console.error('❌ Error deleting admin:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to delete admin'
        });
    }
});

module.exports = router;

