const { getCookies, saveCookies, areCookiesExpired, calculateMinCookieExpiration, hasRefreshLock, getCookieExpiry, getNextRefresh } = require('./cookieManager');
const { loginAndSaveCookies } = require('./cookieManager');
const { apiRequest, ApiError } = require('./apiClient');
const cacheLayer = require('./cacheLayer');
const { refreshCookiesKeepAlive } = require('./pseudoKeepAlive');

/**
 * Adaptive Cookie Refresh Worker
 * Proactively refreshes cookies based on actual expiry times, not fixed intervals
 */

// Worker configuration
const COOKIE_REFRESH_THRESHOLD_MS = 30 * 60 * 1000; // Refresh if expiring within 30 minutes
const REFRESH_BUFFER_MS = 15 * 60 * 1000; // Refresh 15 minutes before expiry
const MAX_CONCURRENT_LOGINS = 3; // Max concurrent full logins (keep-alive doesn't count)
const ADMINS_PER_MINUTE = 10; // Stagger execution: refresh 10 admins per minute
const DELAY_BETWEEN_ADMINS_MS = (60 * 1000) / ADMINS_PER_MINUTE; // 6 seconds between each admin
const LOGIN_IN_PROGRESS_TTL = 5 * 60; // 5 minutes TTL for login-in-progress flag
const MIN_SLEEP_MS = 5 * 60 * 1000; // Minimum 5 minutes between cycles
const MAX_SLEEP_MS = 30 * 60 * 1000; // Maximum 30 minutes between cycles
const BATCH_SIZE = 10; // Process 10 admins per batch

// Health tracking for backoff
let consecutiveFailures = 0;
let lastFailureTime = 0;
const BACKOFF_BASE_MS = 60 * 1000; // 1 minute base backoff
const MAX_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes max backoff

// Track active login operations
const activeLogins = new Map();
let workerTimeoutId = null;
let isRunning = false;

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
        if (cacheLayer.redis) {
            await cacheLayer.redis.del(key);
        } else {
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

// Cookie expiry and next refresh functions are imported from cookieManager.js

/**
 * Get all active admins from Firebase
 * @returns {Promise<Array>} Array of admin objects with id, phone, password
 */
async function getActiveAdmins() {
    try {
        const scheduledRefresh = require('./scheduledRefresh');
        return await scheduledRefresh.getActiveAdmins();
    } catch (error) {
        console.error('❌ Failed to get active admins:', error.message);
        return [];
    }
}

/**
 * Calculate when cookies expire
 * @param {Array} cookies - Array of cookie objects
 * @returns {number|null} Expiry timestamp in milliseconds, or null
 */
function calculateCookieExpiry(cookies) {
    if (!cookies || cookies.length === 0) {
        return null;
    }

    const expiration = calculateMinCookieExpiration(cookies);
    if (expiration && expiration > 0) {
        const now = Date.now();
        const expiryTimestamp = now + (expiration * 1000);
        return expiryTimestamp;
    }

    return null;
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
 * @returns {Promise<{success: boolean, method: 'keep-alive'|'full-login'|null, expiry: number|null}>} Result with method used and expiry
 */
async function refreshCookiesForAdmin(admin) {
    const { id, phone, password } = admin;
    
    // PRIORITY: Check if manual refresh is in progress (has refresh lock)
    if (await hasRefreshLock(id)) {
        return { success: false, method: null, expiry: null };
    }
    
    // Check if login is already in progress
    if (await isLoginInProgress(id)) {
        return { success: false, method: null, expiry: null };
    }

    try {
        // Get current cookies
        const cookies = await getCookies(id);
        
        // Check if refresh is needed
        // Only refresh if cookies are actually expired or scheduled time has passed
        const nextRefresh = await getNextRefresh(id);
        const cookieExpiry = await getCookieExpiry(id);
        const now = Date.now();
        const shouldRefreshBySchedule = nextRefresh && nextRefresh <= now; // Only if time has passed (not "soon")
        const shouldRefreshByExpiry = cookieExpiry && cookieExpiry <= now; // Only if actually expired (not "expiring soon")
        const cookiesExpired = !cookies || cookies.length === 0 || areCookiesExpired(cookies);
        
        // Refresh if:
        // 1. Cookies are actually expired (cookiesExpired or needsRefresh check)
        // 2. Scheduled refresh time has passed (not "soon")
        // 3. Cookie expiry has passed (actually expired, not "expiring soon")
        if (!cookiesExpired && !needsRefresh(cookies) && !shouldRefreshBySchedule && !shouldRefreshByExpiry) {
            // Cookies are still valid and not scheduled for refresh yet
            const expiry = cookieExpiry || calculateCookieExpiry(cookies);
            return { success: false, method: null, expiry };
        }

        console.log(`🔄 [Worker] Refreshing cookies for admin: ${id} (expiring soon or expired)`);
        
        // STEP 1: Try lightweight pseudo keep-alive first (no Puppeteer)
        const keepAliveResult = await refreshCookiesKeepAlive(id);
        
        if (keepAliveResult.success) {
            // Expiry is already stored by saveCookies in refreshCookiesKeepAlive
            const expiry = await getCookieExpiry(id);
            console.log(`✅ [Worker] Successfully refreshed cookies for ${id} via keep-alive (no login needed)`);
            return { success: true, method: 'keep-alive', expiry };
        }

        // STEP 2: Keep-alive failed - check if it's a 302 (cookies expired)
        // If needsRefresh is true, cookies are expired but we should schedule refresh, not immediately login
        if (keepAliveResult.needsRefresh) {
            // Cookies expired (302 redirect) - refreshSchedule already updated by refreshCookiesKeepAlive
            // Don't immediately login - the worker will refresh it in the next cycle, or manual refresh will handle it
            console.log(`⚠️ [Worker] Keep-alive marked ${id} for refresh (cookies expired), refreshSchedule updated (no immediate login)`);
            const expiry = await getCookieExpiry(id);
            // Return success: false but scheduled: true to indicate it's scheduled (not a failure)
            return { success: false, method: null, expiry, scheduled: true };
        }

        // STEP 3: Keep-alive failed (timeout/network) - fall back to full Puppeteer login
        console.log(`⚠️ [Worker] Keep-alive failed for ${id}, falling back to full login...`);
        
        // Check if we're at max concurrent logins (only for full logins)
        if (activeLogins.size >= MAX_CONCURRENT_LOGINS) {
            return { success: false, method: null, expiry: null };
        }

        // Mark login as in progress
        activeLogins.set(id, Date.now());
        await setLoginInProgress(id);

        try {
            // Perform full Puppeteer login to get fresh cookies
            // saveCookies in loginAndSaveCookies already stores expiry, nextRefresh, and updates sorted set
            await loginAndSaveCookies(phone, password, id);
            
            // Get stored expiry
            const expiry = await getCookieExpiry(id);
            
            console.log(`✅ [Worker] Successfully refreshed cookies for ${id} via full login`);
            return { success: true, method: 'full-login', expiry };
        } finally {
            // Clean up
            activeLogins.delete(id);
            await clearLoginInProgress(id);
        }
    } catch (error) {
        console.error(`❌ [Worker] Failed to refresh cookies for ${id}:`, error.message);
        return { success: false, method: null, expiry: null };
    }
}

/**
 * Get admins that need refresh using Redis sorted set (with fallback to individual keys)
 * Uses ZRANGEBYSCORE to get all users expiring within 60 seconds
 * Falls back to querying individual nextRefresh keys if sorted set is unavailable
 * @returns {Promise<Array<{admin: Object, scheduledTime: number}>>} Array of admins with scheduled refresh times
 */
async function getAdminsNeedingRefresh() {
    const now = Date.now();
    // Only refresh what's actually expired (nextRefresh <= now), not "expiring soon"
    const adminsToRefresh = [];

        try {
        // Try sorted set first (most efficient)
        // Only get admins where nextRefresh has actually passed (not "soon")
        let members = [];
        try {
            members = await cacheLayer.zrangebyscore('refreshSchedule', '-inf', now, true);
        } catch (e) {
            // Sorted set query failed, will use fallback
            console.warn('⚠️ [Cookie Worker] Sorted set query failed, using fallback:', e.message);
        }
        
        if (members && members.length > 0) {
            // Get all active admins to map member keys to admin objects
            const allAdmins = await getActiveAdmins();
            const adminMap = new Map();
            for (const admin of allAdmins) {
                const memberKey = `user:${String(admin.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                adminMap.set(memberKey, admin);
            }

            // Process each member from sorted set
            for (const [memberKey, score] of members) {
                const admin = adminMap.get(memberKey);
                if (!admin) {
                    // Admin not found in active list, remove from sorted set
                    await cacheLayer.zrem('refreshSchedule', memberKey);
                    continue;
                }

                // Skip if manual refresh is in progress (check refreshLock)
                if (await hasRefreshLock(admin.id)) {
                    continue;
                }

                // Add to refresh list (only if scheduled time has actually passed)
                const scheduledTime = Math.round(score);
                if (scheduledTime <= now) {
                    adminsToRefresh.push({ 
                        admin, 
                        scheduledTime: scheduledTime 
                    });
                }
            }
        }
        
        // Fallback: Only check individual keys if sorted set is empty or failed
        // This prevents scanning all admins every cycle - only use when sorted set is unavailable
        if (adminsToRefresh.length === 0) {
            console.log('ℹ️ [Cookie Worker] Sorted set empty, checking individual keys as fallback (limited scan)');
            const allAdmins = await getActiveAdmins();
            
            // Limit fallback scan to prevent processing all admins unnecessarily
            // Only check admins that might need refresh (have cookies or nextRefresh set)
            for (const admin of allAdmins) {
                // Skip if manual refresh is in progress
                if (await hasRefreshLock(admin.id)) {
                    continue;
                }

                // Get nextRefresh timestamp from individual key
                const nextRefresh = await getNextRefresh(admin.id);
                
                // Also check cookieExpiry to catch expired cookies
                const cookieExpiry = await getCookieExpiry(admin.id);
                const cookies = await getCookies(admin.id);
                
                // Refresh if:
                // 1. No cookies exist
                // 2. nextRefresh is in the past (actually expired, not "soon")
                // 3. Cookie expiry is in the past (actually expired, not "expiring soon")
                // 4. Cookies are actually expired (areCookiesExpired check)
                let shouldRefresh = false;
                
                if (!cookies || cookies.length === 0) {
                    shouldRefresh = true;
                } else if (nextRefresh && nextRefresh <= now) {
                    // Only refresh if scheduled time has passed (not "soon")
                    shouldRefresh = true;
                } else if (cookieExpiry && cookieExpiry <= now) {
                    // Only refresh if actually expired (not "expiring soon")
                    shouldRefresh = true;
                } else if (areCookiesExpired(cookies)) {
                    // Cookies are actually expired
                    shouldRefresh = true;
                }
                
                if (shouldRefresh) {
                    const scheduledTime = nextRefresh || cookieExpiry || now;
                    adminsToRefresh.push({ 
                        admin, 
                        scheduledTime: Math.max(now, scheduledTime) 
                    });
                }
            }
        }

        // Sort by scheduled time (earliest first)
        adminsToRefresh.sort((a, b) => a.scheduledTime - b.scheduledTime);
        
        if (adminsToRefresh.length > 0) {
            console.log(`📋 [Cookie Worker] Found ${adminsToRefresh.length} admin(s) needing refresh (expired or no cookies)`);
        }
        
        return adminsToRefresh;
    } catch (error) {
        console.error('❌ [Cookie Worker] Error querying refresh schedule:', error.message);
        return [];
    }
}

/**
 * Refresh cookies in batches with staggered execution
 * @param {Array<{admin: Object, scheduledTime: number}>} adminsToRefresh - Admins to refresh
 * @returns {Promise<Object>} Summary of refresh results
 */
async function refreshCookiesBatch(adminsToRefresh) {
    const startTime = Date.now();
    const results = {
        refreshed: 0,
        refreshedKeepAlive: 0,
        refreshedFullLogin: 0,
        skipped: 0,
        failed: 0
    };

    // Process in batches
    for (let i = 0; i < adminsToRefresh.length; i += BATCH_SIZE) {
        const batch = adminsToRefresh.slice(i, i + BATCH_SIZE);
        
        // Process batch in parallel (with concurrency limit)
        const batchPromises = batch.map(async ({ admin }) => {
            // Double-check lock
            if (await hasRefreshLock(admin.id)) {
                results.skipped++;
                return;
            }

            try {
                const result = await refreshCookiesForAdmin(admin);
                if (result.success) {
                    results.refreshed++;
                    if (result.method === 'keep-alive') {
                        results.refreshedKeepAlive++;
                    } else if (result.method === 'full-login') {
                        results.refreshedFullLogin++;
                    }
                } else if (result.scheduled) {
                    // Scheduled for refresh (302 redirect) - not a failure, just scheduled for next cycle
                    // Count as skipped (not processed this cycle) but refreshSchedule is updated
                    results.skipped++;
                    console.log(`⏭️ [Cookie Worker] ${admin.id} scheduled for refresh (cookies expired, refreshSchedule updated)`);
                } else {
                    // Not scheduled and not successful - count as skipped
                    results.skipped++;
                }
            } catch (error) {
                results.failed++;
                console.error(`❌ [Cookie Worker] Failed for ${admin.id}:`, error.message);
            }
        });

        await Promise.all(batchPromises);

        // Stagger between batches (except last batch)
        if (i + BATCH_SIZE < adminsToRefresh.length) {
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_ADMINS_MS * BATCH_SIZE));
        }
    }

    const duration = Date.now() - startTime;
    console.log(`\n📊 [Cookie Worker] Batch completed in ${duration}ms:`);
    console.log(`   ✅ Refreshed: ${results.refreshed} (${results.refreshedKeepAlive} keep-alive, ${results.refreshedFullLogin} full login)`);
    console.log(`   ⏭️  Skipped: ${results.skipped}`);
    console.log(`   ❌ Failed: ${results.failed}`);

    return results;
}

/**
 * Calculate next sleep duration based on earliest refresh in sorted set
 * Queries refreshSchedule for earliest nextRefresh, sleeps until that time
 * Applies health-aware exponential backoff if Alfa server is slow/unreachable
 * @param {number} consecutiveFailures - Number of consecutive failures
 * @returns {Promise<number>} Sleep duration in milliseconds
 */
async function calculateNextSleep(consecutiveFailures) {
    // Health-aware exponential backoff if Alfa server is slow/unreachable
    if (consecutiveFailures > 0) {
        const backoffMs = Math.min(
            BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - 1),
            MAX_BACKOFF_MS
        );
        const backoffMinutes = Math.round(backoffMs / 60000);
        console.log(`⚠️ [Cookie Worker] Health-aware backoff: ${backoffMinutes} minute(s) (${consecutiveFailures} consecutive failures)`);
        return backoffMs;
    }

    try {
        // Query refreshSchedule sorted set for earliest nextRefresh (ZRANGE refreshSchedule 0 0 WITHSCORES)
        let earliest = null;
        try {
            const sortedSetResult = await cacheLayer.zrange('refreshSchedule', 0, 0, true);
            if (sortedSetResult && sortedSetResult.length > 0) {
                earliest = sortedSetResult[0];
            }
        } catch (e) {
            // Sorted set not available, fall back to individual keys
        }

        if (!earliest) {
            // Fallback: Query all active admins and find earliest nextRefresh
            const allAdmins = await getActiveAdmins();
            let earliestRefresh = null;
            
            for (const admin of allAdmins) {
                const nextRefresh = await getNextRefresh(admin.id);
                if (nextRefresh && (!earliestRefresh || nextRefresh < earliestRefresh)) {
                    earliestRefresh = nextRefresh;
                }
            }
            
            if (!earliestRefresh) {
                // No scheduled refreshes, sleep longer (eliminate blind 3-min cycles)
                console.log(`⏰ [Cookie Worker] No scheduled refreshes, sleeping ${MAX_SLEEP_MS / 60000} minutes`);
                return MAX_SLEEP_MS;
            }
            
            const now = Date.now();
            const timeUntilRefresh = earliestRefresh - now;
            const sleepMs = Math.max(MIN_SLEEP_MS, Math.min(timeUntilRefresh, MAX_SLEEP_MS));
            const sleepMinutes = Math.round(sleepMs / 60000);
            console.log(`⏰ [Cookie Worker] Next refresh in ${sleepMinutes} minute(s) (earliest: ${new Date(earliestRefresh).toISOString()})`);
            return sleepMs;
        }

        const [, score] = earliest;
        const now = Date.now();
        const timeUntilRefresh = Math.round(score) - now;

        // Sleep until refresh time, but with min/max bounds
        const sleepMs = Math.max(MIN_SLEEP_MS, Math.min(timeUntilRefresh, MAX_SLEEP_MS));
        const sleepMinutes = Math.round(sleepMs / 60000);
        const nextRefreshDate = new Date(Math.round(score));
        console.log(`⏰ [Cookie Worker] Next refresh in ${sleepMinutes} minute(s) (earliest: ${nextRefreshDate.toISOString()})`);
        
        return sleepMs;
    } catch (error) {
        console.warn(`⚠️ [Cookie Worker] Error calculating next sleep:`, error.message);
        // Fallback to minimum sleep
        return MIN_SLEEP_MS;
    }
}

/**
 * Main adaptive refresh cycle
 * Queries refreshSchedule for earliest nextRefresh, sleeps until that time
 * At refresh time, tries pseudo keep-alive first, falls back to full login only if needed
 */
async function adaptiveRefreshCycle() {
    if (isRunning) {
        console.log('⏸️ [Cookie Worker] Cycle already running, skipping...');
        return;
    }

    isRunning = true;
    const cycleStart = Date.now();
    
    try {
        console.log(`\n🔄 [Cookie Worker] Starting adaptive refresh cycle at ${new Date().toISOString()}`);

        // Get admins that need refresh (from refreshSchedule sorted set or individual keys)
        const adminsToRefresh = await getAdminsNeedingRefresh();
        
        if (adminsToRefresh.length === 0) {
            console.log('ℹ️ [Cookie Worker] No admins need refresh at this time');
            consecutiveFailures = 0; // Reset on success
            return;
        }

        console.log(`📋 [Cookie Worker] Found ${adminsToRefresh.length} admin(s) needing refresh`);

        // Refresh in batches with pseudo keep-alive first, full login as fallback
        const results = await refreshCookiesBatch(adminsToRefresh);

        // Track health for adaptive backoff
        if (results.failed > results.refreshed) {
            consecutiveFailures++;
            lastFailureTime = Date.now();
            console.log(`⚠️ [Cookie Worker] Health check: ${results.failed} failures, ${results.refreshed} successes - will apply backoff`);
        } else {
            consecutiveFailures = 0; // Reset on success
        }

        const cycleDuration = Date.now() - cycleStart;
        console.log(`✅ [Cookie Worker] Adaptive refresh cycle completed in ${cycleDuration}ms`);
        console.log(`   📊 Keep-alive: ${results.refreshedKeepAlive}, Full login: ${results.refreshedFullLogin}, Skipped: ${results.skipped}, Failed: ${results.failed}`);

    } catch (error) {
        consecutiveFailures++;
        lastFailureTime = Date.now();
        console.error('❌ [Cookie Worker] Error in adaptive refresh cycle:', error);
    } finally {
        isRunning = false;
    }
}

/**
 * Schedule next refresh cycle
 * Uses sorted set to find earliest refresh time
 */
async function scheduleNextCycle() {
    // Clear any existing timeout
    if (workerTimeoutId) {
        clearTimeout(workerTimeoutId);
    }

    try {
        // Calculate next sleep based on sorted set
        const sleepMs = await calculateNextSleep(consecutiveFailures);

        const sleepSeconds = Math.round(sleepMs / 1000);
        const sleepMinutes = Math.round(sleepMs / 60000);
        console.log(`⏰ [Cookie Worker] Next cycle in ${sleepMinutes} minute(s) (${sleepSeconds}s)`);

        // Schedule next cycle
        workerTimeoutId = setTimeout(async () => {
            await adaptiveRefreshCycle();
            scheduleNextCycle(); // Schedule next cycle
        }, sleepMs);

    } catch (error) {
        console.error('❌ [Cookie Worker] Error scheduling next cycle:', error);
        // Fallback: schedule after minimum sleep
        workerTimeoutId = setTimeout(async () => {
            await adaptiveRefreshCycle();
            scheduleNextCycle();
        }, MIN_SLEEP_MS);
    }
}

/**
 * Start the adaptive cookie refresh worker
 */
function startWorker() {
    console.log('🚀 [Cookie Worker] Starting adaptive cookie refresh worker...');
    console.log(`   Refresh threshold: ${COOKIE_REFRESH_THRESHOLD_MS / 1000 / 60} minutes`);
    console.log(`   Refresh buffer: ${REFRESH_BUFFER_MS / 1000 / 60} minutes before expiry`);
    console.log(`   Max concurrent logins: ${MAX_CONCURRENT_LOGINS}`);
    console.log(`   Batch size: ${BATCH_SIZE} admins`);
    console.log(`   Stagger: ${ADMINS_PER_MINUTE} admins per minute`);

    // Run initial cycle
    adaptiveRefreshCycle().then(() => {
        scheduleNextCycle();
    }).catch(error => {
        console.error('❌ [Cookie Worker] Error in initial cycle:', error);
        scheduleNextCycle();
    });
}

/**
 * Stop the adaptive cookie refresh worker
 */
function stopWorker() {
    if (workerTimeoutId) {
        clearTimeout(workerTimeoutId);
        workerTimeoutId = null;
    }
    isRunning = false;
    console.log('🛑 [Cookie Worker] Adaptive cookie refresh worker stopped');
}

/**
 * Refresh cookies for all active admins (legacy function for compatibility)
 * @returns {Promise<Object>} Summary of refresh results
 */
async function refreshAllCookies() {
    const adminsToRefresh = await getAdminsNeedingRefresh();
    const admins = adminsToRefresh.map(item => item.admin);
    
    if (admins.length === 0) {
        return { refreshed: 0, skipped: 0, failed: 0 };
    }

    const results = await refreshCookiesBatch(adminsToRefresh);
    return {
        refreshed: results.refreshed,
        skipped: results.skipped,
        failed: results.failed
    };
}

module.exports = {
    startWorker,
    stopWorker,
    refreshAllCookies,
    refreshCookiesForAdmin,
    isLoginInProgress,
    setLoginInProgress,
    clearLoginInProgress
};
