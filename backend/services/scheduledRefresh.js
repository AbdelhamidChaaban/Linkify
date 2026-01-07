const cron = require('node-cron');
// MIGRATED: Using API-first service (no Puppeteer) instead of legacy alfaService.js
const { fetchAlfaData } = require('./alfaServiceApiFirst');
const { updateDashboardData } = require('./firebaseDbService');
const { getSession, deleteSession } = require('./sessionManager');
const snapshotManager = require('./snapshotManager');
const cacheLayer = require('./cacheLayer');
const { checkForNotifications, sendPushNotifications } = require('../routes/pushRoutes');

// Firebase Admin SDK instance (bypasses security rules)
let db = null;

/**
 * Initialize Firebase Admin SDK for scheduled refresh
 * Uses Admin SDK to bypass Firestore security rules
 */
function initializeFirebase() {
    try {
        const admin = require('firebase-admin');
        
        // Check if Firebase is disabled
        if (process.env.DISABLE_FIREBASE === 'true') {
            console.log('ℹ️ Firebase is disabled, scheduled refresh will not work');
            return false;
        }

        // Check if Admin SDK is already initialized
        if (admin.apps && admin.apps.length > 0) {
            // Use existing Admin SDK instance
            db = admin.firestore();
            console.log('✅ Firebase Admin SDK already initialized, using existing instance for scheduled refresh');
            return true;
        }

        // Try to initialize Admin SDK if service account is available
        const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
            ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
            : null;
        
        if (!serviceAccount) {
            console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT_KEY not found. Scheduled refresh requires Admin SDK.');
            console.warn('   Please set FIREBASE_SERVICE_ACCOUNT_KEY environment variable in Render.');
            return false;
        }

        // Initialize Admin SDK
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        
        db = admin.firestore();
        console.log('✅ Firebase Admin SDK initialized for scheduled refresh');
        return true;
    } catch (error) {
        console.error('❌ Error initializing Firebase Admin SDK for scheduled refresh:', error.message);
        if (error.message.includes('JSON')) {
            console.error('   ⚠️ FIREBASE_SERVICE_ACCOUNT_KEY may be invalid JSON. Make sure it\'s minified on a single line.');
        }
        return false;
    }
}

/**
 * Get all admins from Firestore (regardless of status)
 * Uses Admin SDK to bypass security rules
 * @returns {Promise<Array>} Array of all admin objects with id, phone, password
 */
async function getAllAdmins() {
    if (!db) {
        console.warn('⚠️ Firebase Admin SDK not initialized, cannot query admins');
        return [];
    }

    try {
        const snapshot = await db.collection('admins').get();
        
        const allAdmins = [];
        let totalDocs = 0;
        let missingPhoneOrPassword = 0;
        
        snapshot.docs.forEach((doc) => {
            totalDocs++;
            const data = doc.data();
            const adminId = doc.id;
            
            // Get phone and password
            const phone = data.phone || '';
            const password = data.password || '';
            
            if (phone && password) {
                allAdmins.push({
                    id: adminId,
                    phone: phone,
                    password: password,
                    name: data.name || phone
                });
            } else {
                missingPhoneOrPassword++;
                console.warn(`⚠️ Admin ${adminId} (${data.name || 'unnamed'}) is missing phone or password`);
            }
        });
        
        // Only log if count changed (to avoid spam when called frequently)
        // Store last count in module-level variable
        if (typeof getAllAdmins.lastCount === 'undefined' || getAllAdmins.lastCount !== allAdmins.length) {
            if (totalDocs === 0) {
                console.log(`📋 Found 0 admin(s) total (0 documents in Firestore)`);
            } else if (allAdmins.length === 0 && totalDocs > 0) {
                console.log(`⚠️ Found 0 valid admin(s) out of ${totalDocs} document(s) (all missing phone/password)`);
            } else {
                console.log(`📋 Found ${allAdmins.length} valid admin(s) total${totalDocs > allAdmins.length ? ` (${totalDocs - allAdmins.length} skipped - missing phone/password)` : ''}`);
            }
            getAllAdmins.lastCount = allAdmins.length;
        }
        
        return allAdmins;
    } catch (error) {
        console.error('❌ Error querying all admins:', error.message);
        console.error('Stack:', error.stack);
        return [];
    }
}

/**
 * Get all active admins from Firestore
 * Uses Admin SDK to bypass security rules
 * Status is stored in alfaData.status or directly on the admin document
 */
async function getActiveAdmins() {
    if (!db) {
        console.warn('⚠️ Firebase Admin SDK not initialized, cannot query active admins');
        return [];
    }

    try {
        // Query for admins where status is 'active' (case-insensitive)
        // Status can be in alfaData.status or directly on the document
        // We'll get all admins and filter in memory since Firestore doesn't support nested field queries easily
        const snapshot = await db.collection('admins').get();
        
        const activeAdmins = [];
        
        snapshot.docs.forEach((doc) => {
            const data = doc.data();
            const adminId = doc.id;
            
            // Check status using the same logic as frontend (insights.js line 129)
            // Status is 'inactive' only if data.status contains 'inactive' (case-insensitive)
            // Otherwise, it's 'active'
            let statusValue = null;
            
            // Check direct status field first
            if (data.status) {
                statusValue = data.status;
            }
            // Check in alfaData.status as fallback
            else if (data.alfaData && data.alfaData.status) {
                statusValue = data.alfaData.status;
            }
            
            // Determine if admin is active (same logic as frontend)
            // If status contains 'inactive' (case-insensitive), it's inactive
            // Otherwise, it's active
            const isInactive = statusValue && statusValue.toLowerCase().includes('inactive');
            const isActive = !isInactive; // Active if not inactive
            
            // If admin is active, include in refresh list
            if (isActive) {
                // Get phone and password
                const phone = data.phone || '';
                const password = data.password || '';
                
                if (phone && password) {
                    activeAdmins.push({
                        id: adminId,
                        phone: phone,
                        password: password,
                        name: data.name || phone
                    });
                } else {
                    console.warn(`⚠️ Admin ${adminId} (${data.name || 'unnamed'}) is active but missing phone or password`);
                }
            }
        });
        
        console.log(`📋 Found ${activeAdmins.length} active admin(s) for scheduled refresh`);
        return activeAdmins;
    } catch (error) {
        console.error('❌ Error querying active admins:', error.message);
        console.error('Stack:', error.stack);
        return [];
    }
}

/**
 * Refresh a single admin's data
 */
async function refreshAdmin(admin) {
    const { id, phone, password, name } = admin;
    
    try {
        console.log(`🔄 [Scheduled Refresh] Refreshing admin: ${name} (${id})`);
        
        const startTime = Date.now();
        const data = await fetchAlfaData(phone, password, id, id);
        const duration = Date.now() - startTime;
        
        console.log(`✅ [Scheduled Refresh] Successfully refreshed ${name} in ${duration}ms`);
        
        return {
            success: true,
            adminId: id,
            name: name,
            duration: duration
        };
    } catch (error) {
        console.error(`❌ [Scheduled Refresh] Failed to refresh ${name} (${id}):`, error.message);
        return {
            success: false,
            adminId: id,
            name: name,
            error: error.message
        };
    }
}

/**
 * Delete old sessions for all active admins before refresh
 * This ensures fresh sessions are stored during the refresh
 */
async function deleteOldSessionsForActiveAdmins(activeAdmins) {
    console.log(`🗑️ [Scheduled Refresh] Deleting old sessions for ${activeAdmins.length} active admin(s)...`);
    
    const deletePromises = activeAdmins.map(async (admin) => {
        try {
            await deleteSession(admin.id);
            return { adminId: admin.id, success: true };
        } catch (error) {
            console.warn(`⚠️ [Scheduled Refresh] Failed to delete session for ${admin.name} (${admin.id}):`, error.message);
            return { adminId: admin.id, success: false, error: error.message };
        }
    });
    
    const deleteResults = await Promise.all(deletePromises);
    const successful = deleteResults.filter(r => r.success).length;
    
    console.log(`✅ [Scheduled Refresh] Deleted old sessions for ${successful}/${activeAdmins.length} admin(s)`);
}

/**
 * Refresh all active admins in parallel (one shot)
 */
async function refreshAllActiveAdmins() {
    console.log('\n⏰ [Scheduled Refresh] Starting daily refresh at 6:00 AM...');
    console.log(`📅 [Scheduled Refresh] Date: ${new Date().toISOString()}`);
    
    // Get all active admins
    const activeAdmins = await getActiveAdmins();
    
    if (activeAdmins.length === 0) {
        console.log('ℹ️ [Scheduled Refresh] No active admins found to refresh');
        return;
    }
    
    console.log(`🔄 [Scheduled Refresh] Refreshing ${activeAdmins.length} admin(s) in parallel...`);
    
    // Step 1: Delete old sessions before refresh (ensures fresh sessions are stored)
    await deleteOldSessionsForActiveAdmins(activeAdmins);
    
    // Step 2: Refresh all admins in parallel (truly parallel, not sequential)
    const refreshPromises = activeAdmins.map(admin => refreshAdmin(admin));
    const results = await Promise.all(refreshPromises);
    
    // Summary
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`\n📊 [Scheduled Refresh] Summary:`);
    console.log(`   ✅ Successful: ${successful}/${activeAdmins.length}`);
    console.log(`   ❌ Failed: ${failed}/${activeAdmins.length}`);
    
    if (failed > 0) {
        console.log(`\n❌ [Scheduled Refresh] Failed admins:`);
        results.filter(r => !r.success).forEach(r => {
            console.log(`   - ${r.name} (${r.adminId}): ${r.error}`);
        });
    }
    
    console.log(`\n✅ [Scheduled Refresh] Daily refresh completed at ${new Date().toISOString()}`);
    
    // Step 3: Check and send push notifications for all affected users
    try {
        console.log('\n📢 [Notifications] Checking for notifications after refresh...');
        const admin = require('firebase-admin');
        
        // Get all unique userIds from refreshed admins
        const userIds = new Set();
        for (const adminInfo of activeAdmins) {
            try {
                const adminDoc = await db.collection('admins').doc(adminInfo.id).get();
                if (adminDoc.exists) {
                    const data = adminDoc.data();
                    if (data.userId) {
                        userIds.add(data.userId);
                    }
                }
            } catch (error) {
                console.warn(`⚠️ [Notifications] Error getting userId for admin ${adminInfo.id}:`, error.message);
            }
        }
        
        if (userIds.size > 0) {
            console.log(`📢 [Notifications] Checking notifications for ${userIds.size} user(s)...`);
            
            // Check notifications for each user
            const notificationPromises = Array.from(userIds).map(async (userId) => {
                try {
                    const notifications = await checkForNotifications(userId);
                    if (notifications.length > 0) {
                        await sendPushNotifications(userId, notifications);
                        console.log(`✅ [Notifications] Sent ${notifications.length} notification(s) to user ${userId}`);
                        return { userId, count: notifications.length };
                    }
                    return { userId, count: 0 };
                } catch (error) {
                    console.error(`❌ [Notifications] Error checking notifications for user ${userId}:`, error.message);
                    return { userId, count: 0, error: error.message };
                }
            });
            
            const notificationResults = await Promise.all(notificationPromises);
            const totalNotifications = notificationResults.reduce((sum, r) => sum + r.count, 0);
            console.log(`📢 [Notifications] Total notifications sent: ${totalNotifications}`);
        } else {
            console.log('ℹ️ [Notifications] No users found to check notifications');
        }
    } catch (error) {
        console.error('❌ [Notifications] Error during notification check:', error.message);
        // Don't fail the refresh if notification check fails
    }
    
    console.log('');
}

/**
 * Start the scheduled refresh task
 * Runs daily at 6:00 AM
 */
function startScheduledRefresh() {
    // Check if scheduled refresh is disabled
    if (process.env.DISABLE_SCHEDULED_REFRESH === 'true') {
        console.log('ℹ️ Scheduled refresh is disabled via DISABLE_SCHEDULED_REFRESH env var');
        return null;
    }
    
    // Initialize Firebase
    if (!initializeFirebase()) {
        console.warn('⚠️ Cannot start scheduled refresh: Firebase not initialized');
        return null;
    }
    
    // Schedule task to run daily at 6:00 AM
    // Cron format: minute hour day month day-of-week
    // '0 6 * * *' means: at minute 0 of hour 6, every day
    const cronExpression = '0 6 * * *';
    
    console.log('⏰ [Scheduled Refresh] Setting up daily refresh at 6:00 AM...');
    
    const task = cron.schedule(cronExpression, async () => {
        await refreshAllActiveAdmins();
    }, {
        scheduled: true,
        timezone: process.env.TZ || 'UTC' // Use TZ env var or default to UTC
    });
    
    console.log(`✅ [Scheduled Refresh] Scheduled refresh configured to run daily at 6:00 AM (${process.env.TZ || 'UTC'} timezone)`);
    
    // Log next run time
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setHours(6, 0, 0, 0);
    if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1);
    }
    console.log(`📅 [Scheduled Refresh] Next refresh scheduled for: ${nextRun.toISOString()}`);
    
    return task;
}

/**
 * Cleanup removed subscribers for admins whose validity date matches today
 * Runs daily at 00:00:00 to clear removedActiveSubscribers (billing cycle reset)
 */
async function cleanupRemovedSubscribers() {
    console.log('\n🧹 [Cleanup] Starting daily cleanup of removed subscribers at 00:00...');
    console.log(`📅 [Cleanup] Date: ${new Date().toISOString()}`);
    
    if (!db || !app) {
        if (!initializeFirebase()) {
            console.warn('⚠️ [Cleanup] Cannot run cleanup: Firebase not initialized');
            return;
        }
    }
    
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().split('T')[0]; // Format: "YYYY-MM-DD"
        
        // Get all admins
        const allAdmins = await getActiveAdmins();
        
        if (allAdmins.length === 0) {
            console.log('ℹ️ [Cleanup] No admins found to process');
            return;
        }
        
        console.log(`🔄 [Cleanup] Checking ${allAdmins.length} admin(s) for validity date cleanup...`);
        
        let cleanedCount = 0;
        let skippedCount = 0;
        
        for (const admin of allAdmins) {
            try {
                const adminDocRef = db.collection('admins').doc(admin.id);
                const adminDoc = await adminDocRef.get();
                
                if (!adminDoc.exists) {
                    continue;
                }
                
                const data = adminDoc.data();
                const validityDateStr = data.alfaData?.validityDate || 
                                      data._cachedDates?.validityDate?.value;
                
                if (!validityDateStr || typeof validityDateStr !== 'string') {
                    continue;
                }
                
                // Parse validity date
                const dateMatch = validityDateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
                if (!dateMatch) {
                    continue;
                }
                
                const [, day, month, year] = dateMatch;
                const validityDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
                validityDate.setHours(0, 0, 0, 0);
                
                // Calculate the day AFTER validity date (cleanup day)
                const cleanupDate = new Date(validityDate);
                cleanupDate.setDate(cleanupDate.getDate() + 1);
                
                // Check if today is the day AFTER validity date (cleanup should happen at 00:00)
                if (cleanupDate.getTime() === today.getTime()) {
                    const lastCleanupDate = data._lastRemovedCleanupDate || null;
                    const removedActiveSubscribers = Array.isArray(data.removedActiveSubscribers) ? data.removedActiveSubscribers : [];
                    const removedSubscribers = Array.isArray(data.removedSubscribers) ? data.removedSubscribers : [];
                    
                    // Only cleanup if not already done today
                    if (lastCleanupDate !== todayStr && (removedActiveSubscribers.length > 0 || removedSubscribers.length > 0)) {
                        console.log(`🔄 [Cleanup] Cleaning up removed subscribers for admin ${admin.id} (${admin.name || admin.phone || 'Unknown'})`);
                        console.log(`   [Cleanup] Validity date: ${validityDateStr} (ended yesterday), Removed subscribers: ${removedActiveSubscribers.length}`);
                        
                        // Clear removed subscribers
                        await adminDocRef.set({
                            removedActiveSubscribers: [],
                            removedSubscribers: [],
                            _lastRemovedCleanupDate: todayStr
                        }, { merge: true });
                        
                        console.log(`   [Cleanup] Removed subscribers cleared for admin ${admin.id} at 00:00`);
                        cleanedCount++;
                    } else if (lastCleanupDate === todayStr) {
                        skippedCount++;
                    }
                }
            } catch (error) {
                console.warn(`⚠️ [Cleanup] Failed to cleanup admin ${admin.id}:`, error.message);
            }
        }
        
        console.log(`✅ [Cleanup] Cleanup completed: ${cleanedCount} admin(s) cleaned, ${skippedCount} already cleaned today`);
        console.log(`\n✅ [Cleanup] Daily cleanup completed at ${new Date().toISOString()}\n`);
    } catch (error) {
        console.error('❌ [Cleanup] Error during cleanup:', error.message);
    }
}

/**
 * Start the scheduled cleanup task
 * Runs daily at 00:00:00
 */
function startScheduledCleanup() {
    // Check if scheduled cleanup is disabled
    if (process.env.DISABLE_SCHEDULED_CLEANUP === 'true') {
        console.log('ℹ️ Scheduled cleanup is disabled via DISABLE_SCHEDULED_CLEANUP env var');
        return null;
    }
    
    // Initialize Firebase
    if (!initializeFirebase()) {
        console.warn('⚠️ Cannot start scheduled cleanup: Firebase not initialized');
        return null;
    }
    
    // Schedule task to run daily at 00:00:00
    // Cron format: minute hour day month day-of-week
    // '0 0 * * *' means: at minute 0 of hour 0, every day
    const cronExpression = '0 0 * * *';
    
    console.log('⏰ [Cleanup] Setting up daily cleanup at 00:00:00...');
    
    const task = cron.schedule(cronExpression, async () => {
        await cleanupRemovedSubscribers();
    }, {
        scheduled: true,
        timezone: process.env.TZ || 'UTC' // Use TZ env var or default to UTC
    });
    
    console.log(`✅ [Cleanup] Scheduled cleanup configured to run daily at 00:00:00 (${process.env.TZ || 'UTC'} timezone)`);
    
    // Log next run time
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setHours(0, 0, 0, 0);
    if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1);
    }
    console.log(`📅 [Cleanup] Next cleanup scheduled for: ${nextRun.toISOString()}`);
    
    return task;
}

/**
 * Manually trigger refresh (for testing)
 */
async function manualRefresh() {
    console.log('🔧 [Scheduled Refresh] Manual refresh triggered');
    await refreshAllActiveAdmins();
}

module.exports = {
    startScheduledRefresh,
    refreshAllActiveAdmins,
    getActiveAdmins,
    getAllAdmins,
    manualRefresh,
    startScheduledCleanup,
    cleanupRemovedSubscribers
};

