const cron = require('node-cron');
const { getFirestore, collection, query, where, getDocs } = require('firebase/firestore');
const { fetchAlfaData } = require('./alfaService');
const { updateDashboardData } = require('./firebaseDbService');
const { getSession, deleteSession } = require('./sessionManager');
const snapshotManager = require('./snapshotManager');
const cacheLayer = require('./cacheLayer');

// Get Firebase instance from firebaseDbService
// We'll need to access the db instance, so let's create our own query function
let db = null;
let app = null;

/**
 * Initialize Firebase for scheduled refresh
 * This uses the same config as firebaseDbService
 */
function initializeFirebase() {
    try {
        const { initializeApp } = require("firebase/app");
        const { getFirestore } = require("firebase/firestore");
        
        const firebaseConfig = {
            apiKey: process.env.FIREBASE_API_KEY,
            authDomain: process.env.FIREBASE_AUTH_DOMAIN,
            projectId: process.env.FIREBASE_PROJECT_ID,
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
            messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
            appId: process.env.FIREBASE_APP_ID,
            measurementId: process.env.FIREBASE_MEASUREMENT_ID
        };

        // Check if Firebase is disabled
        if (process.env.DISABLE_FIREBASE === 'true') {
            console.log('ℹ️ Firebase is disabled, scheduled refresh will not work');
            return false;
        }

        // Check required env vars
        const requiredEnvVars = ['FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_PROJECT_ID'];
        const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
        
        if (missingVars.length > 0) {
            console.warn('⚠️ Missing required Firebase environment variables for scheduled refresh:', missingVars.join(', '));
            return false;
        }

        app = initializeApp(firebaseConfig, 'scheduled-refresh');
        db = getFirestore(app);
        console.log('✅ Firebase initialized for scheduled refresh');
        return true;
    } catch (error) {
        console.error('❌ Error initializing Firebase for scheduled refresh:', error.message);
        return false;
    }
}

/**
 * Get all admins from Firestore (regardless of status)
 * @returns {Promise<Array>} Array of all admin objects with id, phone, password
 */
async function getAllAdmins() {
    if (!db) {
        console.warn('⚠️ Firebase not initialized, cannot query admins');
        return [];
    }

    try {
        const adminsCollection = collection(db, 'admins');
        const snapshot = await getDocs(adminsCollection);
        
        const allAdmins = [];
        
        snapshot.forEach((doc) => {
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
                console.warn(`⚠️ Admin ${adminId} (${data.name || 'unnamed'}) is missing phone or password`);
            }
        });
        
        // Only log if count changed (to avoid spam when called frequently)
        // Store last count in module-level variable
        if (typeof getAllAdmins.lastCount === 'undefined' || getAllAdmins.lastCount !== allAdmins.length) {
            console.log(`📋 Found ${allAdmins.length} admin(s) total`);
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
 * Status is stored in alfaData.status or directly on the admin document
 */
async function getActiveAdmins() {
    if (!db) {
        console.warn('⚠️ Firebase not initialized, cannot query active admins');
        return [];
    }

    try {
        const adminsCollection = collection(db, 'admins');
        
        // Query for admins where status is 'active' (case-insensitive)
        // Status can be in alfaData.status or directly on the document
        // We'll get all admins and filter in memory since Firestore doesn't support nested field queries easily
        const snapshot = await getDocs(adminsCollection);
        
        const activeAdmins = [];
        
        snapshot.forEach((doc) => {
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
    
    console.log(`\n✅ [Scheduled Refresh] Daily refresh completed at ${new Date().toISOString()}\n`);
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
    manualRefresh
};

