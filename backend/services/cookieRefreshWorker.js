const { getCookies, saveCookies, areCookiesExpired, calculateMinCookieExpiration, hasRefreshLock, getCookieExpiry, getNextRefresh, acquireRefreshLock, releaseRefreshLock } = require('./cookieManager');
const { loginAndSaveCookies } = require('./cookieManager');
const { apiRequest, ApiError } = require('./apiClient');
const cacheLayer = require('./cacheLayer');
const { refreshCookiesKeepAlive } = require('./pseudoKeepAlive');
const { getAdminData } = require('./firebaseDbService');

/**
 * Adaptive Cookie Refresh Worker
 * Proactively refreshes cookies based on actual expiry times, not fixed intervals
 */

// Worker configuration
const COOKIE_REFRESH_THRESHOLD_MS = 30 * 60 * 1000; // Refresh if expiring within 30 minutes
const REFRESH_BUFFER_MS = 30 * 1000; // Refresh 30 seconds before expiry
const MAX_CONCURRENT_REFRESHES = 5; // Max concurrent refreshes (global semaphore)
const MAX_CONCURRENT_LOGINS = 5; // Max concurrent full logins (same as refreshes)
const ADMINS_PER_MINUTE = 10; // Stagger execution: refresh 10 admins per minute
const DELAY_BETWEEN_ADMINS_MS = (60 * 1000) / ADMINS_PER_MINUTE; // 6 seconds between each admin
const LOGIN_IN_PROGRESS_TTL = 5 * 60; // 5 minutes TTL for login-in-progress flag
const MIN_SLEEP_MS = 10 * 1000; // Minimum 10 seconds (only for safety, not enforced for expiry-driven scheduling)
const MAX_SLEEP_MS = 60 * 60 * 1000; // Maximum 60 minutes (safety cap, but expiry-driven takes priority)
const BATCH_SIZE = 5; // Process 5 admins per batch (matches MAX_CONCURRENT_REFRESHES)

// Health tracking for backoff and throttling
let consecutiveFailures = 0;
let lastFailureTime = 0;
const BACKOFF_BASE_MS = 60 * 1000; // 1 minute base backoff
const MAX_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes max backoff

// Health-aware throttling: adjust concurrency based on failure rate
const BASE_ADMINS_PER_MINUTE = 10; // Base rate: refresh 10 admins per minute
const MIN_ADMINS_PER_MINUTE = 3; // Minimum rate during high failure periods
let currentAdminsPerMinute = BASE_ADMINS_PER_MINUTE; // Dynamic rate based on health

// Failure rate tracking for health-aware throttling
const FAILURE_RATE_WINDOW = 20; // Track last 20 refresh attempts
const failureHistory = []; // Array of { success: boolean, timestamp: number }
const HIGH_FAILURE_THRESHOLD = 0.5; // If >50% failures, reduce concurrency
const LOW_FAILURE_THRESHOLD = 0.2; // If <20% failures, increase concurrency

// Track active login operations
const activeLogins = new Map();
// Global semaphore for concurrent refreshes (max 5)
const activeRefreshes = new Set(); // Track admin IDs currently being refreshed
let workerTimeoutId = null;
let isRunning = false;

/**
 * Update failure rate tracking and adjust concurrency dynamically
 * @param {boolean} success - Whether the refresh succeeded
 */
function updateFailureRate(success) {
    const now = Date.now();
    failureHistory.push({ success, timestamp: now });
    
    // Keep only last FAILURE_RATE_WINDOW entries
    if (failureHistory.length > FAILURE_RATE_WINDOW) {
        failureHistory.shift();
    }
    
    // Calculate current failure rate
    if (failureHistory.length >= 10) {
        const failures = failureHistory.filter(h => !h.success).length;
        const failureRate = failures / failureHistory.length;
        
        // Adjust concurrency based on failure rate
        if (failureRate > HIGH_FAILURE_THRESHOLD) {
            // High failure rate - reduce concurrency
            currentAdminsPerMinute = Math.max(MIN_ADMINS_PER_MINUTE, Math.floor(currentAdminsPerMinute * 0.7));
            console.log(`⚠️ [Cookie Worker] High failure rate (${(failureRate * 100).toFixed(1)}%), reducing concurrency to ${currentAdminsPerMinute} admins/min`);
        } else if (failureRate < LOW_FAILURE_THRESHOLD) {
            // Low failure rate - increase concurrency gradually
            currentAdminsPerMinute = Math.min(BASE_ADMINS_PER_MINUTE, Math.floor(currentAdminsPerMinute * 1.2));
            console.log(`✅ [Cookie Worker] Low failure rate (${(failureRate * 100).toFixed(1)}%), increasing concurrency to ${currentAdminsPerMinute} admins/min`);
        }
    }
}

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
 * Get all admins from Firebase (regardless of status)
 * @returns {Promise<Array>} Array of all admin objects with id, phone, password
 */
async function getAllAdmins() {
    try {
        const scheduledRefresh = require('./scheduledRefresh');
        return await scheduledRefresh.getAllAdmins();
    } catch (error) {
        console.error('❌ Failed to get all admins:', error.message);
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
/**
 * Acquire global semaphore slot for concurrent refresh (max 5)
 * @returns {Promise<boolean>} True if slot acquired, false if at max capacity
 */
async function acquireRefreshSlot(adminId) {
    if (activeRefreshes.size >= MAX_CONCURRENT_REFRESHES) {
        return false;
    }
    activeRefreshes.add(adminId);
    return true;
}

/**
 * Release global semaphore slot
 * @param {string} adminId - Admin ID
 */
function releaseRefreshSlot(adminId) {
    activeRefreshes.delete(adminId);
}

async function refreshCookiesForAdmin(admin) {
    const { id, phone, password } = admin;
    const startTime = Date.now();
    let refreshLockAcquired = false;
    let refreshSlotAcquired = false;
    let phase = 'initialization';
    const logData = {
        adminId: id,
        startTime,
        phases: [],
        outcomes: {},
        sessionFix: 'none',
        nextRefresh: null
    };
    
    try {
        // STEP 1: Acquire per-admin Redis lock (TTL 300s)
        refreshLockAcquired = await acquireRefreshLock(id, 300);
        if (!refreshLockAcquired) {
            // Lock already exists (manual refresh or another worker instance)
            logData.phases.push({ phase: 'lock-check', duration: Date.now() - startTime, outcome: 'skipped-lock-exists' });
            return { success: false, method: null, expiry: null, skipped: true, reason: 'lock-exists' };
        }
        logData.phases.push({ phase: 'lock-acquired', duration: Date.now() - startTime });
        
        // STEP 2: Acquire global semaphore slot (max 5 concurrent)
        refreshSlotAcquired = await acquireRefreshSlot(id);
        if (!refreshSlotAcquired) {
            // At max concurrency, release lock and skip
            await releaseRefreshLock(id);
            logData.phases.push({ phase: 'semaphore-check', duration: Date.now() - startTime, outcome: 'skipped-max-concurrency' });
            return { success: false, method: null, expiry: null, skipped: true, reason: 'max-concurrency' };
        }
        logData.phases.push({ phase: 'semaphore-acquired', duration: Date.now() - startTime });
        
        // STEP 3: Check if login is already in progress (idempotent check)
        if (await isLoginInProgress(id)) {
            releaseRefreshSlot(id);
            await releaseRefreshLock(id);
            logData.phases.push({ phase: 'login-check', duration: Date.now() - startTime, outcome: 'skipped-login-in-progress' });
            return { success: false, method: null, expiry: null, skipped: true, reason: 'login-in-progress' };
        }
        
        phase = 'cookie-check';
        const cookieCheckStart = Date.now();
        
        // STEP 1: Check cookie expiry from Redis FIRST (before getting cookies)
        const cookieExpiry = await getCookieExpiry(id);
        const now = Date.now();
        const shouldRefreshByExpiry = cookieExpiry && cookieExpiry <= now;
        
        // Get current cookies
        const cookies = await getCookies(id);
        const nextRefresh = await getNextRefresh(id);
        const shouldRefreshBySchedule = nextRefresh && nextRefresh <= now;
        const cookiesExpired = !cookies || cookies.length === 0 || areCookiesExpired(cookies);
        
        logData.phases.push({ phase: 'cookie-check', duration: Date.now() - cookieCheckStart });
        
        // CRITICAL: If cookies already expired at execution time (from Redis cookieExpiry) → skip keep-alive and perform full login immediately
        // This ensures we never attempt keep-alive on expired cookies
        if (shouldRefreshByExpiry || cookiesExpired) {
            // Cookies expired - skip keep-alive, go straight to login
            phase = 'full-login';
            logData.sessionFix = 'full-login';
            console.log(`🔄 [Worker] Refreshing cookies for admin: ${id} (cookies expired, performing full login immediately)`);
            
            // CRITICAL: For expired cookies, wait for login slot if max concurrency reached (don't just schedule)
            // Wait up to 10 seconds for a slot to become available
            let waitStart = Date.now();
            const maxWaitTime = 10000; // 10 seconds max wait
            while (activeLogins.size >= MAX_CONCURRENT_LOGINS) {
                const waitTime = Date.now() - waitStart;
                if (waitTime >= maxWaitTime) {
                    // Timeout waiting for slot - this is rare, but log it
                    console.log(`⚠️ [Worker] ${id}: Timeout waiting for login slot after ${waitTime}ms, rescheduling for immediate retry`);
                    const { storeNextRefresh } = require('./cookieManager');
                    await storeNextRefresh(id, Date.now() + 5000); // Reschedule 5s in future for immediate retry
                    logData.phases.push({ phase: 'full-login', duration: Date.now() - startTime, outcome: 'timeout-waiting-slot-rescheduled' });
                    logData.nextRefresh = await getNextRefresh(id);
                    return { success: false, method: null, expiry: null, scheduled: true, reason: 'timeout-waiting-slot', logData };
                }
                // Wait 500ms before checking again
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            // Acquired login slot - proceed with login
            activeLogins.set(id, Date.now());
            await setLoginInProgress(id);
            const loginStart = Date.now();
            
            try {
                await loginAndSaveCookies(phone, password, id);
                const expiry = await getCookieExpiry(id);
                logData.nextRefresh = await getNextRefresh(id);
                logData.phases.push({ phase: 'full-login', duration: Date.now() - loginStart, outcome: 'success' });
                logData.outcomes.login = { success: true, duration: Date.now() - loginStart };
                
                console.log(`✅ [Worker] Successfully refreshed cookies for ${id} via full login (cookies expired)`);
                
                // After successful login, refresh data via APIs to keep Firebase current (non-blocking)
                process.nextTick(() => {
                    (async () => {
                        try {
                            const { fetchAlfaData } = require('./alfaServiceApiFirst');
                            console.log(`🔄 [Worker] Refreshing data for ${id} after login...`);
                            await fetchAlfaData(phone, password, id, null, true); // background = true
                            console.log(`✅ [Worker] Data refreshed for ${id} after login`);
                        } catch (error) {
                            console.warn(`⚠️ [Worker] Failed to refresh data for ${id} after login:`, error.message);
                        }
                    })();
                });
                
                return { success: true, method: 'full-login', expiry, logData };
            } finally {
                activeLogins.delete(id);
                await clearLoginInProgress(id);
            }
        }
        
        // Cookies not expired yet - check if scheduled refresh time has passed
        if (!shouldRefreshBySchedule) {
            // Not scheduled yet - skip (expiry-driven scheduling will wake up at the right time)
            const expiry = cookieExpiry || calculateCookieExpiry(cookies);
            logData.phases.push({ phase: 'cookie-check', duration: Date.now() - cookieCheckStart, outcome: 'not-scheduled' });
            return { success: false, method: null, expiry, logData };
        }

        // Scheduled refresh time has passed, but cookies are still valid - try keep-alive first
        console.log(`🔄 [Worker] Refreshing cookies for admin: ${id} (scheduled refresh, cookies still valid - trying keep-alive first)`);
        
        // STEP 4: Try lightweight pseudo keep-alive first (cookies not expired yet)
        phase = 'keep-alive';
        const keepAliveStart = Date.now();
        const keepAliveResult = await refreshCookiesKeepAlive(id);
        const keepAliveDuration = Date.now() - keepAliveStart;
        logData.phases.push({ phase: 'keep-alive', duration: keepAliveDuration });
        
        if (keepAliveResult.success) {
            const expiry = await getCookieExpiry(id);
            logData.nextRefresh = await getNextRefresh(id);
            logData.sessionFix = 'keep-alive';
            logData.outcomes.keepAlive = { success: true, duration: keepAliveDuration };
            logData.phases.push({ phase: 'keep-alive', duration: keepAliveDuration, outcome: 'success' });
            console.log(`✅ [Worker] Successfully extended cookies for ${id} via keep-alive (no login needed, no refresh triggered)`);
            
            // CRITICAL: Keep-alive is NOT a refresh - it only extends __ACCOUNT cookie validity
            // Do NOT trigger data refresh after keep-alive - that's a separate operation
            
            return { success: true, method: 'keep-alive', expiry, logData };
        }

        // STEP 5: Keep-alive failed - check if it's a 302/401 (cookies expired during keep-alive)
        if (keepAliveResult.needsRefresh) {
            // Cookies expired (302 redirect or 401) - perform full login immediately
            phase = 'full-login';
            logData.sessionFix = 'full-login';
            logData.outcomes.keepAlive = { success: false, duration: keepAliveDuration, reason: '302-401-expired' };
            console.log(`⚠️ [Worker] Keep-alive detected expired cookies (302/401) for ${id}, performing full login immediately...`);
            
            // CRITICAL: For expired cookies, wait for login slot if max concurrency reached (don't just schedule)
            // Wait up to 10 seconds for a slot to become available
            let waitStart = Date.now();
            const maxWaitTime = 10000; // 10 seconds max wait
            while (activeLogins.size >= MAX_CONCURRENT_LOGINS) {
                const waitTime = Date.now() - waitStart;
                if (waitTime >= maxWaitTime) {
                    // Timeout waiting for slot - this is rare, but log it
                    console.log(`⚠️ [Worker] ${id}: Timeout waiting for login slot after ${waitTime}ms, rescheduling for immediate retry`);
                    const { storeNextRefresh } = require('./cookieManager');
                    await storeNextRefresh(id, Date.now() + 5000); // Reschedule 5s in future for immediate retry
                    logData.phases.push({ phase: 'full-login', duration: Date.now() - startTime, outcome: 'timeout-waiting-slot-rescheduled' });
                    logData.nextRefresh = await getNextRefresh(id);
                    return { success: false, method: null, expiry: null, scheduled: true, reason: 'timeout-waiting-slot', logData };
                }
                // Wait 500ms before checking again
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            // Acquired login slot - proceed with login
            activeLogins.set(id, Date.now());
            await setLoginInProgress(id);
            const loginStart = Date.now();
            
            try {
                await loginAndSaveCookies(phone, password, id);
                const expiry = await getCookieExpiry(id);
                logData.nextRefresh = await getNextRefresh(id);
                logData.phases.push({ phase: 'full-login', duration: Date.now() - loginStart, outcome: 'success' });
                logData.outcomes.login = { success: true, duration: Date.now() - loginStart };
                console.log(`✅ [Worker] Successfully refreshed cookies for ${id} via full login (cookies expired during keep-alive)`);
                return { success: true, method: 'full-login', expiry, logData };
            } finally {
                activeLogins.delete(id);
                await clearLoginInProgress(id);
            }
        }

        // STEP 6: Keep-alive failed (timeout/network) - check if cookies are still valid before forcing login
        // If cookies are still valid (not expired), reschedule refresh instead of forcing login
        const currentCookieExpiry = await getCookieExpiry(id);
        const currentTime = Date.now();
        const cookiesStillValid = currentCookieExpiry && currentCookieExpiry > currentTime;
        
        if (cookiesStillValid) {
            // Cookies are still valid - keep-alive failed due to network/timeout, not expired cookies
            // Reschedule refresh for a short time in the future (30 seconds) instead of forcing login
            console.log(`⚠️ [Worker] Keep-alive failed (timeout/network) for ${id}, but cookies are still valid (expires ${new Date(currentCookieExpiry).toISOString()})`);
            console.log(`   Rescheduling refresh in 30 seconds instead of forcing login...`);
            
            const { storeNextRefresh } = require('./cookieManager');
            const rescheduleTime = currentTime + (30 * 1000); // 30 seconds from now
            await storeNextRefresh(id, rescheduleTime);
            
            const expiry = currentCookieExpiry;
            logData.nextRefresh = rescheduleTime;
            logData.outcomes.keepAlive = { success: false, duration: keepAliveDuration, reason: 'timeout-network-rescheduled' };
            logData.phases.push({ phase: 'keep-alive', duration: keepAliveDuration, outcome: 'rescheduled-valid-cookies' });
            
            console.log(`✅ [Worker] Rescheduled refresh for ${id} at ${new Date(rescheduleTime).toISOString()} (cookies still valid)`);
            return { success: false, method: null, expiry, scheduled: true, reason: 'keep-alive-timeout-rescheduled', logData };
        }
        
        // Cookies expired or can't determine validity - perform full login
        phase = 'full-login';
        logData.sessionFix = 'full-login';
        logData.outcomes.keepAlive = { success: false, duration: keepAliveDuration, reason: 'timeout-network-expired' };
        console.log(`⚠️ [Worker] Keep-alive failed for ${id}, cookies expired or validity unknown, performing full login...`);
        
        // Wait for login slot if max concurrency reached (up to 10 seconds)
        let waitStart = Date.now();
        const maxWaitTime = 10000; // 10 seconds max wait
        while (activeLogins.size >= MAX_CONCURRENT_LOGINS) {
            const waitTime = Date.now() - waitStart;
            if (waitTime >= maxWaitTime) {
                // Timeout waiting for slot
                console.log(`⚠️ [Worker] ${id}: Timeout waiting for login slot after ${waitTime}ms, rescheduling for immediate retry`);
                const { storeNextRefresh } = require('./cookieManager');
                await storeNextRefresh(id, Date.now() + 5000); // Reschedule 5s in future for immediate retry
                logData.phases.push({ phase: 'full-login', duration: Date.now() - startTime, outcome: 'timeout-waiting-slot-rescheduled' });
                return { success: false, method: null, expiry: null, scheduled: true, reason: 'timeout-waiting-slot', logData };
            }
            // Wait 500ms before checking again
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        activeLogins.set(id, Date.now());
        await setLoginInProgress(id);
        const loginStart = Date.now();

        try {
            await loginAndSaveCookies(phone, password, id);
            const expiry = await getCookieExpiry(id);
            logData.nextRefresh = await getNextRefresh(id);
            logData.phases.push({ phase: 'full-login', duration: Date.now() - loginStart, outcome: 'success' });
            logData.outcomes.login = { success: true, duration: Date.now() - loginStart };
            console.log(`✅ [Worker] Successfully refreshed cookies for ${id} via full login (keep-alive failed, cookies expired)`);
            return { success: true, method: 'full-login', expiry, logData };
        } finally {
            activeLogins.delete(id);
            await clearLoginInProgress(id);
        }
    } catch (error) {
        const endTime = Date.now();
        logData.phases.push({ phase, duration: endTime - startTime, outcome: 'error', error: error.message });
        console.error(`❌ [Worker] Failed to refresh cookies for ${id} (${endTime - startTime}ms, phase: ${phase}):`, error.message);
        return { success: false, method: null, expiry: null, error: error.message, logData };
    } finally {
        // ALWAYS release locks and slots in finally block
        if (refreshSlotAcquired) {
            releaseRefreshSlot(id);
        }
        if (refreshLockAcquired) {
            await releaseRefreshLock(id);
        }
        const endTime = Date.now();
        logData.endTime = endTime;
        logData.totalDuration = endTime - startTime;
        
        // Log comprehensive refresh summary
        if (logData.phases.length > 0) {
            console.log(`📊 [Worker] Refresh summary for ${id}: ${logData.totalDuration}ms, phases: ${logData.phases.map(p => `${p.phase}(${p.duration}ms)`).join(' → ')}, sessionFix: ${logData.sessionFix}`);
        }
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

                // Add to refresh list if scheduled time has passed
                const scheduledTime = Math.round(score);
                if (scheduledTime <= now) {
                    // Also check if cookies are expired (even if nextRefresh hasn't passed)
                    // This ensures we catch admins with expired cookies even if scheduling was off
                    const cookies = await getCookies(admin.id);
                    const cookieExpiry = await getCookieExpiry(admin.id);
                    const cookiesExpired = !cookies || cookies.length === 0 || 
                                          (cookieExpiry && cookieExpiry <= now) ||
                                          areCookiesExpired(cookies);
                    
                    if (cookiesExpired || scheduledTime <= now) {
                        adminsToRefresh.push({ 
                            admin, 
                            scheduledTime: scheduledTime 
                        });
                    }
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
/**
 * Track circuit breaker per admin (failCount in Redis)
 * @param {string} adminId - Admin ID
 * @param {boolean} success - Whether refresh succeeded
 */
async function updateCircuitBreaker(adminId, success) {
    try {
        const failCountKey = `user:${String(adminId).replace(/[^a-zA-Z0-9_-]/g, '_')}:failCount`;
        const failWindowKey = `user:${String(adminId).replace(/[^a-zA-Z0-9_-]/g, '_')}:failWindow`;
        
        if (success) {
            // Reset fail count on success
            await cacheLayer.set(failCountKey, '0', 600); // 10 min TTL
            await cacheLayer.del(failWindowKey);
        } else {
            // Increment fail count
            const currentCount = await cacheLayer.get(failCountKey);
            const failCount = (currentCount ? parseInt(currentCount) : 0) + 1;
            const now = Date.now();
            
            // Get fail window start
            const windowStart = await cacheLayer.get(failWindowKey);
            if (!windowStart) {
                // Start new 10-minute window
                await cacheLayer.set(failWindowKey, now.toString(), 600);
            } else {
                const windowStartTime = parseInt(windowStart);
                // If window expired (>10 min), reset
                if (now - windowStartTime > 10 * 60 * 1000) {
                    await cacheLayer.set(failCountKey, '1', 600);
                    await cacheLayer.set(failWindowKey, now.toString(), 600);
                    return;
                }
            }
            
            await cacheLayer.set(failCountKey, failCount.toString(), 600);
            
            // If failCount >= 3 in 10 minutes, backoff nextRefresh by +2 minutes
            if (failCount >= 3) {
                const nextRefresh = await getNextRefresh(adminId);
                if (nextRefresh) {
                    const backoffNextRefresh = nextRefresh + (2 * 60 * 1000); // +2 minutes
                    const { storeNextRefresh } = require('./cookieManager');
                    await storeNextRefresh(adminId, backoffNextRefresh);
                    console.log(`⚠️ [Circuit Breaker] ${adminId}: ${failCount} failures in 10min, backing off nextRefresh by +2min`);
                }
            }
        }
    } catch (error) {
        console.warn(`⚠️ Failed to update circuit breaker for ${adminId}:`, error.message);
    }
}

async function refreshCookiesBatch(adminsToRefresh) {
    const startTime = Date.now();
    const results = {
        refreshed: 0,
        refreshedKeepAlive: 0,
        refreshedFullLogin: 0,
        skipped: 0,
        skippedLock: 0,
        skippedMaxConcurrency: 0,
        failed: 0
    };

    // Separate expired cookies (needs immediate retry) from regular admins
    const expiredAdmins = [];
    const regularAdmins = [];
    
    // First, check which admins have expired cookies
    for (const { admin } of adminsToRefresh) {
        const cookies = await getCookies(admin.id);
        const cookieExpiry = await getCookieExpiry(admin.id);
        const now = Date.now();
        const isExpired = !cookies || cookies.length === 0 || 
                         (cookieExpiry && cookieExpiry <= now) ||
                         areCookiesExpired(cookies);
        
        if (isExpired) {
            expiredAdmins.push({ admin });
        } else {
            regularAdmins.push({ admin });
        }
    }
    
    // Process expired admins first (priority), then regular admins
    const allAdminsToProcess = [...expiredAdmins, ...regularAdmins].slice(0, MAX_CONCURRENT_REFRESHES);
    
    // Process in parallel (max 5 concurrent)
    const batchPromises = allAdminsToProcess.map(async ({ admin }) => {
        try {
            const result = await refreshCookiesForAdmin(admin);
            
            // Update circuit breaker
            await updateCircuitBreaker(admin.id, result.success);
            
            // Update failure rate tracking for health-aware throttling
            if (result.success) {
                updateFailureRate(true);
                results.refreshed++;
                if (result.method === 'keep-alive') {
                    results.refreshedKeepAlive++;
                } else if (result.method === 'full-login') {
                    results.refreshedFullLogin++;
                }
            } else if (result.skipped) {
                // Skipped (lock exists, max concurrency, etc.) - not a failure
                results.skipped++;
                if (result.reason === 'lock-exists') {
                    results.skippedLock++;
                } else if (result.reason === 'max-concurrency' || result.reason === 'max-concurrency-expired') {
                    results.skippedMaxConcurrency++;
                }
            } else {
                // Actual failure
                updateFailureRate(false);
                results.failed++;
            }
        } catch (error) {
            // Exception during refresh - actual failure
            updateFailureRate(false);
            await updateCircuitBreaker(admin.id, false);
            results.failed++;
            console.error(`❌ [Cookie Worker] Failed for ${admin.id}:`, error.message);
        }
    });

    await Promise.all(batchPromises);
    
    // SECOND PASS: Process expired admins that were scheduled for immediate retry
    const expiredRetryAdmins = [];
    for (const { admin } of adminsToRefresh) {
        if (expiredAdmins.find(e => e.admin.id === admin.id)) {
            // Check if this expired admin was scheduled for immediate retry
            const nextRefresh = await getNextRefresh(admin.id);
            const now = Date.now();
            // If scheduled within last 5 seconds, retry now
            if (nextRefresh && nextRefresh <= now + 5000 && nextRefresh > now - 10000) {
                expiredRetryAdmins.push({ admin });
            }
        }
    }
    
    // Process expired retry admins if we have capacity
    if (expiredRetryAdmins.length > 0 && activeLogins.size < MAX_CONCURRENT_LOGINS) {
        console.log(`🔄 [Cookie Worker] Processing ${expiredRetryAdmins.length} expired admin(s) in second pass...`);
        const retryPromises = expiredRetryAdmins.slice(0, MAX_CONCURRENT_LOGINS - activeLogins.size).map(async ({ admin }) => {
            try {
                const result = await refreshCookiesForAdmin(admin);
                await updateCircuitBreaker(admin.id, result.success);
                
                if (result.success) {
                    updateFailureRate(true);
                    results.refreshed++;
                    if (result.method === 'keep-alive') {
                        results.refreshedKeepAlive++;
                    } else if (result.method === 'full-login') {
                        results.refreshedFullLogin++;
                    }
                } else if (result.skipped) {
                    results.skipped++;
                } else {
                    updateFailureRate(false);
                    results.failed++;
                }
            } catch (error) {
                updateFailureRate(false);
                await updateCircuitBreaker(admin.id, false);
                results.failed++;
                console.error(`❌ [Cookie Worker] Retry failed for ${admin.id}:`, error.message);
            }
        });
        
        await Promise.all(retryPromises);
    }

    const duration = Date.now() - startTime;
    const failureRate = failureHistory.length > 0 ? (failureHistory.filter(h => !h.success).length / failureHistory.length) : 0;
    
    console.log(`\n📊 [Cookie Worker] Batch completed in ${duration}ms:`);
    console.log(`   ✅ Refreshed: ${results.refreshed} (${results.refreshedKeepAlive} keep-alive, ${results.refreshedFullLogin} full login)`);
    console.log(`   ⏭️  Skipped: ${results.skipped} (${results.skippedLock} lock, ${results.skippedMaxConcurrency} max-concurrency)`);
    console.log(`   ❌ Failed: ${results.failed}`);
    console.log(`   📈 Failure rate: ${(failureRate * 100).toFixed(1)}% (last ${failureHistory.length} refreshes)`);
    console.log(`   🔄 Concurrent capacity: ${activeRefreshes.size}/${MAX_CONCURRENT_REFRESHES} refreshes, ${activeLogins.size}/${MAX_CONCURRENT_LOGINS} logins`);
    
    // Health-aware throttling: If failure rate >40% across last 20 refreshes, reduce global concurrency from 5 → 3
    if (failureRate > 0.4 && failureHistory.length >= 20) {
        const oldConcurrency = MAX_CONCURRENT_REFRESHES;
        // Note: We can't change MAX_CONCURRENT_REFRESHES at runtime, but we can log a warning
        // The actual throttling is handled by the semaphore and failure rate tracking
        console.log(`⚠️ [Cookie Worker] High failure rate (${(failureRate * 100).toFixed(1)}%), consider reducing concurrency from ${oldConcurrency} → 3`);
    } else if (failureRate < 0.2 && failureHistory.length >= 20) {
        console.log(`✅ [Cookie Worker] Low failure rate (${(failureRate * 100).toFixed(1)}%), system is stable`);
    }
    
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
    // Only apply backoff if there are no scheduled refreshes, or if backoff is shorter than next refresh
    if (consecutiveFailures > 0) {
        const backoffMs = Math.min(
            BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - 1),
            MAX_BACKOFF_MS
        );
        
        // Check if we have scheduled refreshes (expiry-driven takes priority)
        try {
            const sortedSetResult = await cacheLayer.zrange('refreshSchedule', 0, 0, true);
            if (sortedSetResult && sortedSetResult.length > 0) {
                const [, score] = sortedSetResult[0];
                const now = Date.now();
                const timeUntilRefresh = Math.round(score) - now;
                
                // Use the shorter of backoff or time until refresh (expiry-driven takes priority)
                if (timeUntilRefresh > 0 && timeUntilRefresh < backoffMs) {
                    // Next refresh is sooner than backoff - use expiry-driven scheduling
                    const sleepMs = Math.max(1000, timeUntilRefresh); // Minimum 1s
                    const sleepSeconds = Math.round(sleepMs / 1000);
                    console.log(`⏰ [Cookie Worker] Next refresh in ${sleepSeconds}s (expiry-driven, ignoring backoff)`);
                    return sleepMs;
                }
            }
        } catch (error) {
            // If sorted set query fails, apply backoff
        }
        
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
            
            // Expiry-driven: sleep until refresh time (minimum 1s for immediate processing)
            const sleepMs = Math.max(1000, timeUntilRefresh);
            const sleepSeconds = Math.round(sleepMs / 1000);
            const sleepMinutes = Math.round(sleepMs / 60000);
            const nextRefreshDate = new Date(earliestRefresh);
            console.log(`⏰ [Cookie Worker] Next refresh in ${sleepSeconds}s (${sleepMinutes}min) - expiry-driven (earliest: ${nextRefreshDate.toISOString()})`);
            return sleepMs;
        }

        const [, score] = earliest;
        const now = Date.now();
        const timeUntilRefresh = Math.round(score) - now;

        // Expiry-driven scheduling: sleep until refresh time (no MIN_SLEEP_MS enforcement)
        if (timeUntilRefresh <= 0) {
            // Already past due - process immediately
            console.log(`⏰ [Cookie Worker] Refresh is past due, processing immediately`);
            return 1000; // 1 second (immediate processing)
        }

        // Sleep until refresh time (minimum 1s for immediate processing, no maximum cap for expiry-driven)
        const sleepMs = Math.max(1000, timeUntilRefresh); // Minimum 1s, but use actual time until refresh
        const sleepSeconds = Math.round(sleepMs / 1000);
        const sleepMinutes = Math.round(sleepMs / 60000);
        const nextRefreshDate = new Date(Math.round(score));
        console.log(`⏰ [Cookie Worker] Next refresh in ${sleepSeconds}s (${sleepMinutes}min) - expiry-driven (earliest: ${nextRefreshDate.toISOString()})`);
        
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
        console.log(`⏰ [Cookie Worker] Next cycle in ${sleepSeconds}s (${sleepMinutes}min) - expiry-driven scheduling`);

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
 * Calculate milliseconds until next 6 AM
 * @returns {number} Milliseconds until next 6 AM
 */
function getMsUntil6AM() {
    const now = new Date();
    const next6AM = new Date();
    next6AM.setHours(6, 0, 0, 0);
    
    // If it's already past 6 AM today, schedule for tomorrow
    if (now >= next6AM) {
        next6AM.setDate(next6AM.getDate() + 1);
    }
    
    return next6AM.getTime() - now.getTime();
}

/**
 * Perform daily cookie check at 6 AM
 * Attempts to reuse existing cookies (kept alive overnight) instead of forcing full login
 * Only performs login if cookies are invalid
 */
async function performDailyLogin() {
    console.log('🌅 [Cookie Worker] Performing 6:00 AM cookie check...');
    
    try {
        const admins = await getAllAdmins();
        
        if (!admins || admins.length === 0) {
            console.log('⚠️ [Cookie Worker] No admins found for 6 AM check');
            return;
        }
        
        console.log(`📋 [Cookie Worker] 6 AM check: ${admins.length} admins to process`);
        
        let cookiesReused = 0;
        let loginsPerformed = 0;
        
        // Process admins in batches to avoid overwhelming the system
        for (let i = 0; i < admins.length; i += BATCH_SIZE) {
            const batch = admins.slice(i, i + BATCH_SIZE);
            
            await Promise.allSettled(
                batch.map(async (admin) => {
                    try {
                        if (!admin.phone || !admin.password) {
                            console.warn(`⚠️ [Cookie Worker] Skipping admin ${admin.id}: missing credentials`);
                            return;
                        }
                        
                        // STEP 1: Retrieve cookies from Redis
                        const cookies = await getCookies(admin.id);
                        
                        // STEP 2: Check __ACCOUNT cookie expiry and validity
                        let cookiesValid = false;
                        let cookieExpiry = null;
                        
                        if (cookies && cookies.length > 0) {
                            // Check if __ACCOUNT cookie exists
                            const accountCookie = cookies.find(c => c.name === '__ACCOUNT');
                            if (accountCookie) {
                                cookieExpiry = await getCookieExpiry(admin.id);
                                const now = Date.now();
                                
                                // Check if cookie is expired
                                if (cookieExpiry && cookieExpiry > now) {
                                    // Cookie not expired yet - try lightweight request to verify
                                    console.log(`🔍 [6 AM] ${admin.id}: Checking cookie validity (expires: ${new Date(cookieExpiry).toISOString()})...`);
                                    
                                    const keepAliveResult = await refreshCookiesKeepAlive(admin.id);
                                    if (keepAliveResult.success) {
                                        cookiesValid = true;
                                        cookiesReused++;
                                        const updatedExpiry = await getCookieExpiry(admin.id);
                                        const expiryDate = updatedExpiry ? new Date(updatedExpiry).toISOString() : 'unknown';
                                        console.log(`✅ [6 AM] ${admin.id}: Cookie check succeeded, continuing with existing cookies (expiry: ${expiryDate})`);
                                    } else {
                                        console.log(`⚠️ [6 AM] ${admin.id}: Cookie check failed (${keepAliveResult.error || 'invalid'}), performing full login`);
                                    }
                                } else {
                                    console.log(`⚠️ [6 AM] ${admin.id}: Cookie expired (expiry: ${cookieExpiry ? new Date(cookieExpiry).toISOString() : 'unknown'}), performing full login`);
                                }
                            } else {
                                console.log(`⚠️ [6 AM] ${admin.id}: No __ACCOUNT cookie found, performing full login`);
                            }
                        } else {
                            console.log(`⚠️ [6 AM] ${admin.id}: No cookies found, performing full login`);
                        }
                        
                        // STEP 3: If cookies invalid, perform full login
                        if (!cookiesValid) {
                            console.log(`🔐 [6 AM] ${admin.id}: Cookie check failed, performing full login...`);
                            await loginAndSaveCookies(admin.phone, admin.password, admin.id);
                            loginsPerformed++;
                            const newExpiry = await getCookieExpiry(admin.id);
                            const expiryDate = newExpiry ? new Date(newExpiry).toISOString() : 'unknown';
                            console.log(`✅ [6 AM] ${admin.id}: Cookie check failed, performed full login (new expiry: ${expiryDate})`);
                        }
                    } catch (error) {
                        console.error(`❌ [Cookie Worker] 6 AM check failed for admin ${admin.id}:`, error.message);
                    }
                })
            );
            
            // Small delay between batches
            if (i + BATCH_SIZE < admins.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        console.log(`✅ [Cookie Worker] 6 AM check completed: ${cookiesReused} reused cookies, ${loginsPerformed} full logins`);
    } catch (error) {
        console.error('❌ [Cookie Worker] Error in 6 AM check:', error);
    }
}

/**
 * Schedule next daily login at 6 AM
 */
function scheduleNextDailyLogin() {
    const msUntil6AM = getMsUntil6AM();
    const hoursUntil6AM = Math.round(msUntil6AM / (1000 * 60 * 60) * 10) / 10;
    
    console.log(`📅 [Cookie Worker] Next daily login scheduled in ${hoursUntil6AM} hours (at 6 AM)`);
    
    setTimeout(async () => {
        await performDailyLogin();
        scheduleNextDailyLogin(); // Schedule next day
    }, msUntil6AM);
}

// Silent keep-alive scheduler - dynamic scheduling based on __ACCOUNT expiry
let keepAliveTimeoutId = null;
const KEEP_ALIVE_BUFFER_MS = 20 * 60 * 1000; // 20 minutes before expiry

// Track last scheduled keep-alive times per admin (to avoid duplicate logs)
// Map<adminId, { nextKeepAliveUTC: number, expiryUTC: number }>
const lastScheduledKeepAlive = new Map();
let lastEarliestScheduledUTC = null; // Track last earliest scheduled time

/**
 * Convert UTC timestamp to Lebanon local time (EET/EEST)
 * Lebanon uses EET (UTC+2) in winter and EEST (UTC+3) in summer
 * @param {number} utcTimestamp - UTC timestamp in milliseconds
 * @returns {string} Formatted date string in Lebanon timezone
 */
function formatLebanonTime(utcTimestamp) {
    // Use Intl.DateTimeFormat to handle timezone conversion
    // Lebanon timezone: Asia/Beirut
    const date = new Date(utcTimestamp);
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Beirut',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(date);
}

/**
 * Format timestamp in both UTC and Lebanon time for logging
 * @param {number} utcTimestamp - UTC timestamp in milliseconds
 * @returns {string} Formatted string with both UTC and Lebanon time
 */
function formatTimeForLogging(utcTimestamp) {
    const utcDate = new Date(utcTimestamp);
    const utcStr = utcDate.toISOString().replace('T', ' ').replace('Z', ' UTC');
    const lebanonStr = formatLebanonTime(utcTimestamp);
    return `${utcStr} (${lebanonStr} Lebanon time)`;
}

/**
 * Perform silent keep-alive ping for a single admin
 * @param {string} userId - User ID
 * @returns {Promise<{success: boolean, newExpiry: number|null}>} Result with success and new expiry
 */
async function performSilentKeepAlive(userId) {
    try {
        const cookies = await getCookies(userId);
        if (!cookies || cookies.length === 0) {
            console.log(`❌ [Keep-Alive] ${userId}: No cookies found, triggering auto-login...`);
            return await triggerAutoLogin(userId);
        }

        // Check if __ACCOUNT cookie exists
        const hasAccountCookie = cookies.some(c => c.name === '__ACCOUNT');
        if (!hasAccountCookie) {
            console.log(`❌ [Keep-Alive] ${userId}: No __ACCOUNT cookie found, triggering auto-login...`);
            return await triggerAutoLogin(userId);
        }

        // Use existing pseudoKeepAlive function
        const result = await refreshCookiesKeepAlive(userId);
        
        if (result.success) {
            const newExpiryUTC = await getCookieExpiry(userId);
            if (newExpiryUTC) {
                const newTimeUntilExpiry = Math.round((newExpiryUTC - Date.now()) / 60000);
                const expiryStr = formatTimeForLogging(newExpiryUTC);
                console.log(`✅ [Keep-Alive] ${userId}: Extended (expires in ${newTimeUntilExpiry} min, until ${expiryStr})`);
                
                // Clear last scheduled time for this admin so it gets logged when rescheduled
                // (the expiry changed, so next keep-alive time will change)
                lastScheduledKeepAlive.delete(userId);
            } else {
                console.log(`✅ [Keep-Alive] ${userId}: Extended`);
            }
            return { success: true, newExpiry: newExpiryUTC };
        } else {
            // Keep-alive failed - trigger auto-login immediately
            const reason = result.needsRefresh ? 'expired' : 'timeout';
            console.log(`❌ [Keep-Alive] ${userId}: Failed (${reason}), triggering auto-login...`);
            return await triggerAutoLogin(userId);
        }
    } catch (error) {
        console.log(`❌ [Keep-Alive] ${userId}: Failed (${error.message}), triggering auto-login...`);
        return await triggerAutoLogin(userId);
    }
}

/**
 * Trigger auto-login for an admin when keep-alive fails
 * @param {string} userId - User ID
 * @returns {Promise<{success: boolean, newExpiry: number|null, autoLogin: boolean}>}
 */
async function triggerAutoLogin(userId) {
    try {
        // Get admin credentials from Firebase
        const adminData = await getAdminData(userId);
        if (!adminData || !adminData.phone || !adminData.password) {
            console.error(`❌ [Keep-Alive] ${userId}: Auto-login failed - admin credentials not found`);
            return { success: false, newExpiry: null };
        }
        
        // Perform full login immediately
        await loginAndSaveCookies(adminData.phone, adminData.password, userId);
        
        // Get new expiry after login
        const newExpiryUTC = await getCookieExpiry(userId);
        if (newExpiryUTC) {
            const newTimeUntilExpiry = Math.round((newExpiryUTC - Date.now()) / 60000);
            const expiryStr = formatTimeForLogging(newExpiryUTC);
            console.log(`✅ [Keep-Alive] ${userId}: Auto-login successful (expires in ${newTimeUntilExpiry} min, until ${expiryStr})`);
            
            // Clear last scheduled time so it gets logged when rescheduled
            lastScheduledKeepAlive.delete(userId);
            
            return { success: true, newExpiry: newExpiryUTC, autoLogin: true };
        } else {
            console.log(`✅ [Keep-Alive] ${userId}: Auto-login successful`);
            return { success: true, newExpiry: null, autoLogin: true };
        }
    } catch (loginError) {
        console.error(`❌ [Keep-Alive] ${userId}: Auto-login failed - ${loginError.message}`);
        return { success: false, newExpiry: null };
    }
}

/**
 * Calculate next keep-alive time for an admin
 * Returns: __ACCOUNT expiryUTC - 20 minutes (dynamic scheduling in UTC)
 * All scheduling math uses UTC timestamps
 * @param {string} userId - User ID
 * @returns {Promise<number|null>} Next keep-alive UTC timestamp in ms, or null if no cookies
 */
async function calculateNextKeepAliveTime(userId) {
    try {
        // Get __ACCOUNT expiryUTC from Redis (stored as UTC timestamp)
        const expiryUTC = await getCookieExpiry(userId);
        if (!expiryUTC) {
            return null; // No expiry info, skip
        }

        const nowUTC = Date.now(); // Current UTC timestamp
        const ttlMs = expiryUTC - nowUTC;
        
        if (ttlMs <= 0) {
            return null; // Already expired
        }

        // Calculate keep-alive trigger: expiryUTC - 20 minutes (all in UTC)
        // Example: if expiryUTC = 2025-12-01T14:26:00Z, schedule keep-alive at 2025-12-01T14:06:00Z
        const nextKeepAliveUTC = expiryUTC - KEEP_ALIVE_BUFFER_MS;
        
        // Ensure it's in the future (at least 1 minute from now)
        const minDelay = 60 * 1000; // 1 minute
        if (nextKeepAliveUTC <= nowUTC + minDelay) {
            // If keep-alive time is too soon or in the past, schedule for 1 minute from now (UTC)
            return nowUTC + minDelay;
        }
        
        return nextKeepAliveUTC;
    } catch (error) {
        return null;
    }
}

/**
 * Run silent keep-alive for admins whose keep-alive time has arrived
 * Only processes admins scheduled for keep-alive at this time (dynamic scheduling)
 */
async function runSilentKeepAliveCycle() {
    try {
        const admins = await getAllAdmins();
        
        if (!admins || admins.length === 0) {
            scheduleNextKeepAlive();
            return;
        }

        const nowUTC = Date.now(); // Current UTC timestamp
        const adminsToKeepAlive = [];
        const adminsNeedingLogin = [];
        
        // Find admins whose keep-alive time has arrived OR who need login (expired/missing cookies)
        for (const admin of admins) {
            const cookies = await getCookies(admin.id);
            const cookieExpiry = await getCookieExpiry(admin.id);
            
            // Check if cookies are expired or missing
            const cookiesExpired = !cookieExpiry || cookieExpiry <= nowUTC;
            const cookiesMissing = !cookies || cookies.length === 0;
            const hasAccountCookie = cookies && cookies.some(c => c.name === '__ACCOUNT');
            
            if (cookiesMissing || cookiesExpired || !hasAccountCookie) {
                // Cookies expired or missing - need proactive login
                adminsNeedingLogin.push(admin);
                continue;
            }
            
            // Cookies exist and are valid - check if keep-alive time has arrived
            const nextKeepAliveUTC = await calculateNextKeepAliveTime(admin.id);
            if (nextKeepAliveUTC && nextKeepAliveUTC <= nowUTC + 60000) { // Within 1 minute tolerance
                adminsToKeepAlive.push(admin);
            }
        }
        
        // PROACTIVE LOGIN: Perform login for admins with expired/missing cookies
        if (adminsNeedingLogin.length > 0) {
            console.log(`🔐 [Keep-Alive] Detected ${adminsNeedingLogin.length} admin(s) with expired/missing cookies - performing proactive login...`);
            
            let loginSuccessCount = 0;
            let loginFailCount = 0;
            
            await Promise.allSettled(
                adminsNeedingLogin.map(async (admin) => {
                    try {
                        console.log(`🔐 [Keep-Alive] Performing proactive login for ${admin.id}...`);
                        await loginAndSaveCookies(admin.phone, admin.password, admin.id);
                        loginSuccessCount++;
                        console.log(`✅ [Keep-Alive] Proactive login SUCCESS for ${admin.id} - cookies refreshed`);
                    } catch (error) {
                        loginFailCount++;
                        console.error(`❌ [Keep-Alive] Proactive login FAILED for ${admin.id}: ${error.message}`);
                    }
                })
            );
            
            console.log(`📊 [Keep-Alive] Proactive login completed: ${loginSuccessCount} succeeded, ${loginFailCount} failed`);
        }
        
        if (adminsToKeepAlive.length === 0) {
            // No admins to keep-alive, silently reschedule (no log spam)
            scheduleNextKeepAlive();
            return;
        }

        console.log(`🔔 [Keep-Alive] Executing keep-alive for ${adminsToKeepAlive.length} admin(s)...`);
        
        let successCount = 0;
        let failCount = 0;
        let autoLoginCount = 0;
        
        // Process scheduled admins in parallel (lightweight operation)
        await Promise.allSettled(
            adminsToKeepAlive.map(async (admin) => {
                const result = await performSilentKeepAlive(admin.id);
                if (result.success) {
                    successCount++;
                    if (result.autoLogin) {
                        autoLoginCount++;
                    }
                } else {
                    failCount++;
                }
            })
        );
        
        const summaryParts = [`${successCount} SUCCESS`];
        if (autoLoginCount > 0) {
            summaryParts.push(`${autoLoginCount} via auto-login`);
        }
        if (failCount > 0) {
            summaryParts.push(`${failCount} FAILED`);
        }
        console.log(`✅ [Keep-Alive] Completed: ${summaryParts.join(', ')}`);
        
    } catch (error) {
        console.error(`❌ [Keep-Alive] Error in keep-alive cycle:`, error.message);
    } finally {
        // Always reschedule next keep-alive cycle (finds earliest next time across all admins)
        scheduleNextKeepAlive();
    }
}

/**
 * Schedule next silent keep-alive cycle
 * Finds the earliest next keep-alive time across all admins (dynamic scheduling)
 */
async function scheduleNextKeepAlive() {
    try {
        // Clear any existing timeout
        if (keepAliveTimeoutId) {
            clearTimeout(keepAliveTimeoutId);
            keepAliveTimeoutId = null;
        }
        
        const admins = await getAllAdmins();
        
        if (!admins || admins.length === 0) {
            // No admins, schedule check in 1 hour (fallback)
            // Only log if this is a change (first time or after having admins)
            if (lastEarliestScheduledUTC !== null) {
                console.log(`📅 [Keep-Alive] No admins found, next check scheduled in 1 hour`);
            }
            lastEarliestScheduledUTC = null; // Reset tracking
            const delay = 60 * 60 * 1000;
            keepAliveTimeoutId = setTimeout(() => runSilentKeepAliveCycle(), delay);
            return;
        }

        // Calculate next keep-alive time for each admin (based on __ACCOUNT expiryUTC - 20 minutes)
        // All times are in UTC
        const nextTimes = [];
        const adminSchedules = [];
        const nowUTC = Date.now(); // Current UTC timestamp
        
        // Process all admins (including inactive ones) - keep-alive should cover all admins with cookies
        let adminsWithCookies = 0;
        let adminsWithoutCookies = 0;
        let adminsWithoutAccountCookie = 0;
        
        for (const admin of admins) {
            const cookies = await getCookies(admin.id);
            if (!cookies || cookies.length === 0) {
                adminsWithoutCookies++;
                continue; // Skip admins without cookies (can't keep-alive what doesn't exist)
            }
            
            adminsWithCookies++;
            const hasAccountCookie = cookies.some(c => c.name === '__ACCOUNT');
            if (!hasAccountCookie) {
                adminsWithoutAccountCookie++;
                continue; // Skip admins without __ACCOUNT cookie (can't keep-alive)
            }
            
            const nextKeepAliveUTC = await calculateNextKeepAliveTime(admin.id);
            if (nextKeepAliveUTC) {
                nextTimes.push(nextKeepAliveUTC);
                const expiryUTC = await getCookieExpiry(admin.id);
                const expiryStr = expiryUTC ? formatTimeForLogging(expiryUTC) : 'unknown';
                const nextKeepAliveStr = formatTimeForLogging(nextKeepAliveUTC);
                const adminDelay = Math.round((nextKeepAliveUTC - nowUTC) / (60 * 1000));
                adminSchedules.push({ adminId: admin.id, nextKeepAliveUTC, expiryUTC, expiryStr, nextKeepAliveStr, adminDelay });
            }
        }
        
        // Log statistics for debugging (only when schedules change)
        if (nextTimes.length === 0) {
            // No admins with valid __ACCOUNT cookies, schedule check in 1 hour (fallback)
            // Only log if this is a change (first time or after having valid cookies)
            if (lastEarliestScheduledUTC !== null) {
                console.log(`📅 [Keep-Alive] No admins with __ACCOUNT cookies, next check scheduled in 1 hour`);
            }
            lastEarliestScheduledUTC = null; // Reset tracking
            const delay = 60 * 60 * 1000;
            keepAliveTimeoutId = setTimeout(() => runSilentKeepAliveCycle(), delay);
            return;
        }

        // Find earliest next keep-alive time (all in UTC)
        const earliestNextUTC = Math.min(...nextTimes);
        
        // CRITICAL: Also check for expired cookies periodically (every 5 minutes)
        // This ensures we catch expired cookies quickly and perform proactive login
        const EXPIRED_COOKIE_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
        const delayToNextKeepAlive = Math.max(0, earliestNextUTC - nowUTC);
        const delay = Math.min(delayToNextKeepAlive, EXPIRED_COOKIE_CHECK_INTERVAL);
        
        const delayMinutes = Math.round(delay / (60 * 1000));
        const delayHours = Math.round(delay / (60 * 60 * 1000) * 10) / 10;
        const earliestStr = formatTimeForLogging(earliestNextUTC);
        
        // Check if scheduled times have changed (only log when changed)
        let hasChanges = false;
        const changedSchedules = [];
        const currentAdminIds = new Set(adminSchedules.map(s => s.adminId));
        
        // Clean up tracking for admins that no longer have valid cookies
        for (const [adminId] of lastScheduledKeepAlive) {
            if (!currentAdminIds.has(adminId)) {
                lastScheduledKeepAlive.delete(adminId);
            }
        }
        
        for (const schedule of adminSchedules) {
            const lastScheduled = lastScheduledKeepAlive.get(schedule.adminId);
            
            // Check if this admin's schedule changed
            const scheduleChanged = !lastScheduled || 
                                   lastScheduled.nextKeepAliveUTC !== schedule.nextKeepAliveUTC ||
                                   lastScheduled.expiryUTC !== schedule.expiryUTC;
            
            if (scheduleChanged) {
                hasChanges = true;
                changedSchedules.push(schedule);
                // Update last scheduled time for this admin
                lastScheduledKeepAlive.set(schedule.adminId, {
                    nextKeepAliveUTC: schedule.nextKeepAliveUTC,
                    expiryUTC: schedule.expiryUTC
                });
            }
        }
        
        // Check if earliest scheduled time changed
        const earliestTimeChanged = lastEarliestScheduledUTC !== earliestNextUTC;
        if (earliestTimeChanged) {
            hasChanges = true;
            lastEarliestScheduledUTC = earliestNextUTC;
        }
        
        // Only log if schedules changed
        if (hasChanges) {
            keepAliveTimeoutId = setTimeout(() => runSilentKeepAliveCycle(), delay);
            
            // Consolidated logging: one line with all changed schedules
            if (changedSchedules.length > 0) {
                // Build consolidated schedule summary
                const scheduleParts = changedSchedules.map(schedule => {
                    const scheduleStr = formatTimeForLogging(schedule.nextKeepAliveUTC);
                    const adminDelay = Math.round((schedule.nextKeepAliveUTC - nowUTC) / (60 * 1000));
                    return `${schedule.adminId} → ${scheduleStr} (in ${adminDelay} min)`;
                });
                
                const delayStr = delayMinutes < 60 
                    ? `${delayMinutes} min` 
                    : `${delayHours} hours`;
                
                console.log(`📅 [Keep-Alive] Scheduled: ${scheduleParts.join(', ')} | Next cycle in ${delayStr} (at ${earliestStr})`);
            } else if (earliestTimeChanged) {
                // Only earliest time changed (no individual admin changes)
                const delayStr = delayMinutes < 60 
                    ? `${delayMinutes} min` 
                    : `${delayHours} hours`;
                console.log(`📅 [Keep-Alive] Next cycle scheduled in ${delayStr} (at ${earliestStr})`);
            }
        } else {
            // No changes, but still schedule the next cycle (silently)
            keepAliveTimeoutId = setTimeout(() => runSilentKeepAliveCycle(), delay);
        }
        
    } catch (error) {
        console.error(`❌ [Keep-Alive] Error scheduling next keep-alive:`, error.message);
        // Fallback: schedule in 1 hour
        const delay = 60 * 60 * 1000;
        keepAliveTimeoutId = setTimeout(() => runSilentKeepAliveCycle(), delay);
    }
}

/**
 * Start the adaptive cookie refresh worker
 */
function startWorker() {
    console.log('🚀 [Cookie Worker] Starting adaptive cookie refresh worker...');
    console.log(`   Daily login: 6 AM (proactive __ACCOUNT refresh)`);
    console.log(`   Silent keep-alive: Every 30-45 min or before expiry`);
    console.log(`   Max concurrent logins: ${MAX_CONCURRENT_LOGINS}`);
    console.log(`   Batch size: ${BATCH_SIZE} admins`);

    // Schedule daily login at 6 AM
    scheduleNextDailyLogin();
    
    // Start silent keep-alive cycle
    scheduleNextKeepAlive();
    
    // Note: We no longer run minute-by-minute refresh cycles
    // All refreshes are now driven by:
    // 1. Daily login at 6 AM (proactive)
    // 2. Manual refresh requests (on-demand)
    // 3. Cookie expiry-driven refreshes (when __ACCOUNT expires)
    // 4. Silent keep-alive pings (every 30-45 min or before expiry)
}

/**
 * Stop the adaptive cookie refresh worker
 */
function stopWorker() {
    if (workerTimeoutId) {
        clearTimeout(workerTimeoutId);
        workerTimeoutId = null;
    }
    if (keepAliveTimeoutId) {
        clearTimeout(keepAliveTimeoutId);
        keepAliveTimeoutId = null;
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
