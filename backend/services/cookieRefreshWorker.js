const { getCookies, saveCookies, areCookiesExpired, calculateMinCookieExpiration } = require('./cookieManager');
const { loginAndSaveCookies } = require('./cookieManager');
const { apiRequest, ApiError } = require('./apiClient');
const cacheLayer = require('./cacheLayer');

/**
 * Background Cookie Refresh Worker
 * Proactively refreshes cookies before they expire to ensure fast refresh operations
 */

// Worker configuration
const WORKER_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const COOKIE_REFRESH_THRESHOLD_MS = 30 * 60 * 1000; // Refresh if expiring within 30 minutes
const MAX_CONCURRENT_LOGINS = 8; // Limit concurrent logins to avoid overload
const LOGIN_IN_PROGRESS_TTL = 5 * 60; // 5 minutes TTL for login-in-progress flag

// Track active login operations
const activeLogins = new Map();

/**
 * Generate Redis key for login-in-progress flag
 * @param {string} userId - User ID
 * @returns {string} Redis key
 */
function getLoginInProgressKey(userId) {
    const sanitized = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `user:${sanitized}:loginInProgress`;
}

/**
 * Set login-in-progress flag in Redis
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function setLoginInProgress(userId) {
    try {
        const key = getLoginInProgressKey(userId);
        await cacheLayer.set(key, '1', LOGIN_IN_PROGRESS_TTL);
    } catch (error) {
        console.warn(`⚠️ Failed to set login-in-progress flag for ${userId}:`, error.message);
    }
}

/**
 * Clear login-in-progress flag
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function clearLoginInProgress(userId) {
    try {
        const key = getLoginInProgressKey(userId);
        // Use Redis directly for simple key deletion
        if (cacheLayer.redis) {
            await cacheLayer.redis.del(key);
        } else {
            // Fallback: set with very short TTL (1 second)
            await cacheLayer.set(key, '', 1);
        }
    } catch (error) {
        console.warn(`⚠️ Failed to clear login-in-progress flag for ${userId}:`, error.message);
    }
}

/**
 * Check if login is in progress for a user
 * @param {string} userId - User ID
 * @returns {Promise<boolean>}
 */
async function isLoginInProgress(userId) {
    try {
        const key = getLoginInProgressKey(userId);
        const value = await cacheLayer.get(key);
        return value === '1' || value === 1;
    } catch (error) {
        return false;
    }
}

/**
 * Get all active admins from Firebase
 * @returns {Promise<Array>} Array of admin objects with id, phone, password
 */
async function getActiveAdmins() {
    try {
        // Use the same function as scheduledRefresh
        const scheduledRefresh = require('./scheduledRefresh');
        return await scheduledRefresh.getActiveAdmins();
    } catch (error) {
        console.error('❌ Failed to get active admins:', error.message);
        return [];
    }
}

/**
 * Check if cookies need refresh (expiring soon)
 * @param {Array} cookies - Array of cookie objects
 * @returns {boolean} True if cookies need refresh
 */
function needsRefresh(cookies) {
    if (!cookies || cookies.length === 0) {
        return true;
    }

    if (areCookiesExpired(cookies)) {
        return true;
    }

    // Check if cookies expire within threshold
    const expiration = calculateMinCookieExpiration(cookies);
    if (expiration && expiration > 0) {
        const expirationMs = expiration * 1000;
        return expirationMs < COOKIE_REFRESH_THRESHOLD_MS;
    }

    return false;
}

/**
 * Refresh cookies for a single admin
 * @param {Object} admin - Admin object with id, phone, password
 * @returns {Promise<boolean>} True if refresh was successful
 */
async function refreshCookiesForAdmin(admin) {
    const { id, phone, password } = admin;
    
    // Check if login is already in progress
    if (await isLoginInProgress(id)) {
        console.log(`⏳ Login already in progress for ${id}, skipping...`);
        return false;
    }

    // Check if we're at max concurrent logins
    if (activeLogins.size >= MAX_CONCURRENT_LOGINS) {
        console.log(`⏳ Max concurrent logins (${MAX_CONCURRENT_LOGINS}) reached, skipping ${id}...`);
        return false;
    }

    try {
        // Get current cookies
        const cookies = await getCookies(id);
        
        // Check if refresh is needed
        if (!needsRefresh(cookies)) {
            return false; // No refresh needed
        }

        // Mark login as in progress
        activeLogins.set(id, Date.now());
        await setLoginInProgress(id);

        console.log(`🔄 [Worker] Refreshing cookies for admin: ${id} (expiring soon or expired)`);
        
        // Perform login to get fresh cookies
        const freshCookies = await loginAndSaveCookies(phone, password, id);
        
        console.log(`✅ [Worker] Successfully refreshed cookies for ${id}`);
        return true;
    } catch (error) {
        console.error(`❌ [Worker] Failed to refresh cookies for ${id}:`, error.message);
        return false;
    } finally {
        // Clean up
        activeLogins.delete(id);
        await clearLoginInProgress(id);
    }
}

/**
 * Refresh cookies for all active admins (with concurrency limit)
 * @returns {Promise<Object>} Summary of refresh results
 */
async function refreshAllCookies() {
    const startTime = Date.now();
    console.log(`\n🔄 [Cookie Worker] Starting cookie refresh cycle at ${new Date().toISOString()}`);

    try {
        // Get all active admins
        const admins = await getActiveAdmins();
        
        if (admins.length === 0) {
            console.log('ℹ️ [Cookie Worker] No active admins found');
            return { refreshed: 0, skipped: 0, failed: 0 };
        }

        console.log(`📋 [Cookie Worker] Checking ${admins.length} admin(s) for cookie refresh...`);

        // Process admins in batches to respect concurrency limit
        const results = {
            refreshed: 0,
            skipped: 0,
            failed: 0
        };

        // Process in parallel batches
        const batchSize = MAX_CONCURRENT_LOGINS;
        for (let i = 0; i < admins.length; i += batchSize) {
            const batch = admins.slice(i, i + batchSize);
            
            const batchResults = await Promise.allSettled(
                batch.map(admin => refreshCookiesForAdmin(admin))
            );

            batchResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    if (result.value === true) {
                        results.refreshed++;
                    } else {
                        results.skipped++;
                    }
                } else {
                    results.failed++;
                    console.error(`❌ [Cookie Worker] Failed for ${batch[index].id}:`, result.reason?.message);
                }
            });

            // Small delay between batches to avoid overwhelming the system
            if (i + batchSize < admins.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        const duration = Date.now() - startTime;
        console.log(`\n📊 [Cookie Worker] Refresh cycle completed in ${duration}ms:`);
        console.log(`   ✅ Refreshed: ${results.refreshed}`);
        console.log(`   ⏭️  Skipped: ${results.skipped}`);
        console.log(`   ❌ Failed: ${results.failed}`);
        console.log(`✅ [Cookie Worker] Cookie refresh cycle completed at ${new Date().toISOString()}\n`);

        return results;
    } catch (error) {
        console.error('❌ [Cookie Worker] Error in refresh cycle:', error);
        return { refreshed: 0, skipped: 0, failed: 0 };
    }
}

/**
 * Start the background cookie refresh worker
 */
function startWorker() {
    console.log('🚀 [Cookie Worker] Starting background cookie refresh worker...');
    console.log(`   Interval: ${WORKER_INTERVAL_MS / 1000}s`);
    console.log(`   Refresh threshold: ${COOKIE_REFRESH_THRESHOLD_MS / 1000 / 60} minutes`);
    console.log(`   Max concurrent logins: ${MAX_CONCURRENT_LOGINS}`);

    // Run immediately on startup
    refreshAllCookies().catch(error => {
        console.error('❌ [Cookie Worker] Error in initial refresh:', error);
    });

    // Then run on interval
    const intervalId = setInterval(() => {
        refreshAllCookies().catch(error => {
            console.error('❌ [Cookie Worker] Error in scheduled refresh:', error);
        });
    }, WORKER_INTERVAL_MS);

    // Store interval ID for cleanup
    workerIntervalId = intervalId;
}

/**
 * Stop the background cookie refresh worker
 */
function stopWorker() {
    if (workerIntervalId) {
        clearInterval(workerIntervalId);
        workerIntervalId = null;
        console.log('🛑 [Cookie Worker] Background cookie refresh worker stopped');
    }
}

let workerIntervalId = null;

module.exports = {
    startWorker,
    stopWorker,
    refreshAllCookies,
    refreshCookiesForAdmin,
    isLoginInProgress,
    setLoginInProgress,
    clearLoginInProgress
};

