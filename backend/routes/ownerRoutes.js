const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { authenticateJWT } = require('../middleware/auth');

// Simple in-memory cache for owner panel users (30 minute TTL)
// Extended cache time to minimize slow Firestore queries (which take ~20s)
let usersCache = null;
let usersCacheTimestamp = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes (extended due to slow Firestore queries)

// Import Firebase Admin SDK for owner operations
// Reuse the same Admin SDK instance from firebaseDbService to avoid conflicts
let adminDb = null;

function getAdminDb() {
    if (adminDb) return adminDb;
    
    try {
        const admin = require('firebase-admin');
        
        // Check if Firebase Admin is already initialized (from firebaseDbService or auth middleware)
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
        
        // Get the default app (reuse existing initialization)
        adminDb = admin.firestore();
        
        return adminDb;
    } catch (error) {
        console.error('Error initializing Firebase Admin:', error.message);
        return null;
    }
}

// Owner credentials from environment variables
const OWNER_USERNAME = process.env.OWNER_USERNAME || '';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
// Use the same JWT_SECRET as the auth middleware (no need for separate config)
const JWT_SECRET = process.env.JWT_SECRET || process.env.FIREBASE_API_KEY || 'fallback-secret-change-in-production';

// Owner login endpoint (no authentication required)
router.post('/owner/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!OWNER_USERNAME || !OWNER_PASSWORD) {
            return res.status(500).json({ error: 'Owner credentials not configured' });
        }
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }
        
        // Verify credentials
        if (username !== OWNER_USERNAME || password !== OWNER_PASSWORD) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        
        // Generate JWT token for owner
        const token = jwt.sign(
            { 
                type: 'owner',
                username: username,
                iat: Math.floor(Date.now() / 1000)
            },
            JWT_SECRET,
            { expiresIn: '24h' } // Token expires in 24 hours
        );
        
        res.json({ 
            success: true,
            token,
            message: 'Owner login successful'
        });
        
    } catch (error) {
        console.error('Owner login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Middleware to check if request is from owner (using owner JWT token)
function checkOwner(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    const token = authHeader.substring(7);
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Check if token is owner type
        if (decoded.type !== 'owner') {
            return res.status(403).json({ error: 'Forbidden: Owner access required' });
        }
        
        // Attach owner info to request
        req.owner = decoded;
        next();
        
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired. Please login again.' });
        }
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// Get all users with their stats
router.get('/owner/users', checkOwner, async (req, res) => {
    try {
        // Check cache first
        const now = Date.now();
        if (usersCache && (now - usersCacheTimestamp) < CACHE_TTL_MS) {
            console.log('📊 [Owner Panel] Returning cached users data');
            return res.json({ users: usersCache });
        }
        
        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({ error: 'Firebase Admin not initialized' });
        }
        
        console.log('📊 [Owner Panel] Fetching users data from Firestore...');
        const startTime = Date.now();
        
        // OPTIMIZATION: Only fetch users collection (removed admins collection fetch for speed)
        // Admin count should be stored in user document and updated when admins are created/deleted
        const queryStartTime = Date.now();
        
        let usersSnapshot;
        try {
            usersSnapshot = await adminDbInstance.collection('users').limit(1000).get();
        } catch (queryError) {
            console.error('❌ Firestore query error:', queryError.message);
            throw queryError;
        }
        
        const queryDuration = Date.now() - queryStartTime;
        console.log(`⏱️ [Owner Panel] Query completed in ${queryDuration}ms (${usersSnapshot.size} users)`);
        
        // Warn if queries are taking too long
        if (queryDuration > 5000) {
            console.warn(`⚠️ [Owner Panel] Slow Firestore query detected (${queryDuration}ms). This may indicate network latency or Firestore region mismatch.`);
        }
        
        // Process users efficiently - extract only needed fields
        const processStartTime = Date.now();
        const users = [];
        usersSnapshot.forEach(userDoc => {
            const userData = userDoc.data();
            const userId = userDoc.id;
            
            // Extract only needed fields (avoid processing unnecessary data)
            // Use adminCount from user document if available, otherwise 0
            users.push({
                id: userId,
                email: userData.email || '',
                name: userData.name || '',
                phone: userData.phone || '',
                createdAt: userData.createdAt?.toDate?.() || userData.createdAt || null,
                adminLimit: userData.adminLimit !== undefined ? userData.adminLimit : null,
                isBlocked: userData.isBlocked === true,
                adminCount: userData.adminCount !== undefined ? userData.adminCount : 0 // Use stored count or default to 0
            });
        });
        
        // Sort by creation date (newest first) - optimized comparison
        users.sort((a, b) => {
            if (!a.createdAt) return 1;
            if (!b.createdAt) return -1;
            const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : (typeof a.createdAt === 'number' ? a.createdAt : 0);
            const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : (typeof b.createdAt === 'number' ? b.createdAt : 0);
            return bTime - aTime;
        });
        const processDuration = Date.now() - processStartTime;
        console.log(`⏱️ [Owner Panel] Users processed in ${processDuration}ms`);
        
        const duration = Date.now() - startTime;
        console.log(`✅ [Owner Panel] Fetched ${users.length} users in ${duration}ms total`);
        
        // Update cache
        usersCache = users;
        usersCacheTimestamp = Date.now();
        
        res.json({ users });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Update user admin limit
router.put('/owner/users/:userId/admin-limit', checkOwner, async (req, res) => {
    try {
        const { userId } = req.params;
        const { adminLimit } = req.body;
        
        if (adminLimit !== null && (typeof adminLimit !== 'number' || adminLimit < 0)) {
            return res.status(400).json({ error: 'Invalid admin limit. Must be a positive number or null for unlimited.' });
        }
        
        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({ error: 'Firebase Admin not initialized' });
        }
        
        const updateStartTime = Date.now();
        const admin = require('firebase-admin');
        const userRef = adminDbInstance.collection('users').doc(userId);
        
        // Check if user document exists first
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            console.warn(`⚠️ [Owner Panel] User ${userId} not found in Firestore when updating admin limit`);
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Update admin limit
        await userRef.update({
            adminLimit: adminLimit === null ? admin.firestore.FieldValue.delete() : adminLimit,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        const updateDuration = Date.now() - updateStartTime;
        console.log(`✅ [Owner Panel] Admin limit updated for user ${userId} to ${adminLimit === null ? 'unlimited' : adminLimit} in ${updateDuration}ms`);
        
        // Invalidate cache
        usersCache = null;
        usersCacheTimestamp = 0;
        
        res.json({ success: true, adminLimit });
    } catch (error) {
        console.error('❌ Error updating admin limit:', error);
        console.error('   Error code:', error.code);
        console.error('   Error message:', error.message);
        res.status(500).json({ error: 'Failed to update admin limit: ' + (error.message || 'Unknown error') });
    }
});

// Block/unblock user
router.put('/owner/users/:userId/block', checkOwner, async (req, res) => {
    try {
        const { userId } = req.params;
        const { isBlocked } = req.body;
        
        if (typeof isBlocked !== 'boolean') {
            return res.status(400).json({ error: 'Invalid isBlocked value. Must be a boolean.' });
        }
        
        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({ error: 'Firebase Admin not initialized' });
        }
        
        const updateStartTime = Date.now();
        const admin = require('firebase-admin');
        const userRef = adminDbInstance.collection('users').doc(userId);
        
        // Check if user document exists first
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            console.warn(`⚠️ [Owner Panel] User ${userId} not found in Firestore`);
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Update blocked status
        await userRef.update({
            isBlocked: isBlocked,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        const updateDuration = Date.now() - updateStartTime;
        console.log(`✅ [Owner Panel] Block status updated for user ${userId} (${isBlocked ? 'blocked' : 'unblocked'}) in ${updateDuration}ms`);
        
        // Invalidate cache
        usersCache = null;
        usersCacheTimestamp = 0;
        
        res.json({ success: true, isBlocked });
    } catch (error) {
        console.error('❌ Error updating block status:', error);
        console.error('   Error code:', error.code);
        console.error('   Error message:', error.message);
        res.status(500).json({ error: 'Failed to update block status: ' + (error.message || 'Unknown error') });
    }
});

// Get user revenue (from profit engine or action logs)
router.get('/owner/users/:userId/revenue', checkOwner, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({ error: 'Firebase Admin not initialized' });
        }
        
        // This is a placeholder - adjust based on how you track revenue
        // You might want to calculate from profit engine data, action logs, or a separate revenue collection
        let revenue = 0;
        
        // Example: Calculate from action logs if you track revenue there
        // For now, return 0 - you'll need to implement your revenue calculation logic
        
        res.json({ userId, revenue });
    } catch (error) {
        console.error('Error fetching revenue:', error);
        res.status(500).json({ error: 'Failed to fetch revenue' });
    }
});

/**
 * Recalculate admin counts for all users
 * POST /api/owner/recalculate-admin-counts
 */
router.post('/owner/recalculate-admin-counts', checkOwner, async (req, res) => {
    try {
        console.log('🔄 [Owner Panel] Recalculating admin counts for all users...');
        const startTime = Date.now();
        
        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({
                success: false,
                error: 'Database not available'
            });
        }
        
        const admin = require('firebase-admin');
        
        // Fetch all users
        const usersSnapshot = await adminDbInstance.collection('users').limit(1000).get();
        console.log(`📊 [Owner Panel] Found ${usersSnapshot.size} users to process`);
        
        // Fetch all admins and group by userId
        const adminsSnapshot = await adminDbInstance.collection('admins').limit(10000).get();
        console.log(`📊 [Owner Panel] Found ${adminsSnapshot.size} admins to process`);
        
        // Count admins per user
        const adminCountMap = {};
        adminsSnapshot.forEach(adminDoc => {
            const adminData = adminDoc.data();
            const userId = adminData.userId;
            if (userId) {
                adminCountMap[userId] = (adminCountMap[userId] || 0) + 1;
            }
        });
        
        console.log(`📊 [Owner Panel] Admin counts calculated for ${Object.keys(adminCountMap).length} users`);
        
        // Update each user's adminCount
        const batch = adminDbInstance.batch();
        let updateCount = 0;
        
        usersSnapshot.forEach(userDoc => {
            const userId = userDoc.id;
            const userData = userDoc.data();
            const actualCount = adminCountMap[userId] || 0;
            const currentCount = userData.adminCount !== undefined ? userData.adminCount : 0;
            
            // Only update if the count is different
            if (actualCount !== currentCount) {
                const userRef = adminDbInstance.collection('users').doc(userId);
                batch.update(userRef, {
                    adminCount: actualCount,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                updateCount++;
                console.log(`  📝 [Owner Panel] Updating user ${userId}: ${currentCount} → ${actualCount}`);
            }
        });
        
        if (updateCount > 0) {
            await batch.commit();
            console.log(`✅ [Owner Panel] Updated admin counts for ${updateCount} users`);
        } else {
            console.log(`ℹ️ [Owner Panel] All admin counts are already up to date`);
        }
        
        // Invalidate cache
        usersCache = null;
        usersCacheTimestamp = 0;
        
        const duration = Date.now() - startTime;
        console.log(`✅ [Owner Panel] Recalculation completed in ${duration}ms`);
        
        res.json({
            success: true,
            message: `Recalculated admin counts for ${updateCount} users`,
            updated: updateCount,
            total: usersSnapshot.size
        });
        
    } catch (error) {
        console.error('❌ Error recalculating admin counts:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to recalculate admin counts'
        });
    }
});

// Get pending approval users (users where isApproved !== true)
router.get('/owner/pending-approvals', checkOwner, async (req, res) => {
    try {
        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({ error: 'Firebase Admin not initialized' });
        }
        
        console.log('📋 [Owner Panel] Fetching pending approval users...');
        
        // Fetch all users and filter for pending approvals (isApproved !== true)
        // Firestore doesn't allow != queries with orderBy without composite index
        const usersSnapshot = await adminDbInstance.collection('users')
            .limit(1000)
            .get();
        
        const pendingUsers = [];
        usersSnapshot.forEach(userDoc => {
            const userData = userDoc.data();
            // Filter for users where isApproved is not true (includes false, null, undefined)
            if (userData.isApproved !== true) {
                pendingUsers.push({
                    id: userDoc.id,
                    email: userData.email || '',
                    name: userData.name || '',
                    phone: userData.phone || '',
                    createdAt: userData.createdAt?.toDate?.() || userData.createdAt || null,
                    isApproved: userData.isApproved === true
                });
            }
        });
        
        // Sort by creation date (newest first)
        pendingUsers.sort((a, b) => {
            if (!a.createdAt) return 1;
            if (!b.createdAt) return -1;
            const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : (typeof a.createdAt === 'number' ? a.createdAt : 0);
            const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : (typeof b.createdAt === 'number' ? b.createdAt : 0);
            return bTime - aTime;
        });
        
        console.log(`✅ [Owner Panel] Found ${pendingUsers.length} pending approval users`);
        
        res.json({ success: true, users: pendingUsers });
    } catch (error) {
        console.error('❌ Error fetching pending approvals:', error);
        res.status(500).json({ error: 'Failed to fetch pending approvals' });
    }
});

// Get approved users (users where isApproved === true)
router.get('/owner/approved-users', checkOwner, async (req, res) => {
    try {
        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({ error: 'Firebase Admin not initialized' });
        }
        
        console.log('📋 [Owner Panel] Fetching approved users...');
        
        // Fetch all users and filter for approved users (isApproved === true)
        const usersSnapshot = await adminDbInstance.collection('users')
            .limit(1000)
            .get();
        
        const approvedUsers = [];
        usersSnapshot.forEach(userDoc => {
            const userData = userDoc.data();
            // Filter for users where isApproved is true
            if (userData.isApproved === true) {
                approvedUsers.push({
                    id: userDoc.id,
                    email: userData.email || '',
                    name: userData.name || '',
                    phone: userData.phone || '',
                    createdAt: userData.createdAt?.toDate?.() || userData.createdAt || null
                });
            }
        });
        
        // Sort by creation date (newest first)
        approvedUsers.sort((a, b) => {
            if (!a.createdAt) return 1;
            if (!b.createdAt) return -1;
            const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : (typeof a.createdAt === 'number' ? a.createdAt : 0);
            const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : (typeof b.createdAt === 'number' ? b.createdAt : 0);
            return bTime - aTime;
        });
        
        console.log(`✅ [Owner Panel] Found ${approvedUsers.length} approved users`);
        
        res.json({ success: true, users: approvedUsers });
    } catch (error) {
        console.error('❌ Error fetching approved users:', error);
        res.status(500).json({ error: 'Failed to fetch approved users' });
    }
});

// Approve user (set isApproved to true)
router.put('/owner/users/:userId/approve', checkOwner, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({ error: 'Firebase Admin not initialized' });
        }
        
        const admin = require('firebase-admin');
        const userRef = adminDbInstance.collection('users').doc(userId);
        
        // Check if user exists
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Update isApproved to true
        await userRef.update({
            isApproved: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Invalidate cache
        usersCache = null;
        usersCacheTimestamp = 0;
        
        console.log(`✅ [Owner Panel] User ${userId} approved`);
        
        res.json({ success: true, message: 'User approved successfully' });
    } catch (error) {
        console.error('❌ Error approving user:', error);
        res.status(500).json({ error: 'Failed to approve user' });
    }
});

// Reject user (DELETE the account completely)
router.put('/owner/users/:userId/reject', checkOwner, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({ error: 'Firebase Admin not initialized' });
        }
        
        const admin = require('firebase-admin');
        
        // Check if user document exists
        const userRef = adminDbInstance.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Delete the Firebase Auth user
        try {
            await admin.auth().deleteUser(userId);
            console.log(`✅ [Owner Panel] Firebase Auth user ${userId} deleted`);
        } catch (authError) {
            console.warn(`⚠️ [Owner Panel] Could not delete Firebase Auth user ${userId}:`, authError.message);
            // Continue to delete Firestore document even if auth deletion fails
        }
        
        // Delete the Firestore user document
        await userRef.delete();
        console.log(`✅ [Owner Panel] Firestore user document ${userId} deleted`);
        
        // Invalidate cache
        usersCache = null;
        usersCacheTimestamp = 0;
        
        console.log(`✅ [Owner Panel] User ${userId} rejected and account deleted`);
        
        res.json({ success: true, message: 'User rejected and account deleted successfully' });
    } catch (error) {
        console.error('❌ Error rejecting user:', error);
        res.status(500).json({ error: 'Failed to reject user' });
    }
});

// Delete user (DELETE the account completely - same as reject, but for approved users)
router.delete('/owner/users/:userId', checkOwner, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const adminDbInstance = getAdminDb();
        if (!adminDbInstance) {
            return res.status(500).json({ error: 'Firebase Admin not initialized' });
        }
        
        const admin = require('firebase-admin');
        
        // Check if user document exists
        const userRef = adminDbInstance.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Delete the Firebase Auth user
        try {
            await admin.auth().deleteUser(userId);
            console.log(`✅ [Owner Panel] Firebase Auth user ${userId} deleted`);
        } catch (authError) {
            console.warn(`⚠️ [Owner Panel] Could not delete Firebase Auth user ${userId}:`, authError.message);
            // Continue to delete Firestore document even if auth deletion fails
        }
        
        // Delete the Firestore user document
        await userRef.delete();
        console.log(`✅ [Owner Panel] Firestore user document ${userId} deleted`);
        
        // Invalidate cache
        usersCache = null;
        usersCacheTimestamp = 0;
        
        console.log(`✅ [Owner Panel] User ${userId} deleted`);
        
        res.json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
        console.error('❌ Error deleting user:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

module.exports = router;
