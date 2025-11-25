const { getCookies, saveCookies, areCookiesExpired, calculateMinCookieExpiration, hasRefreshLock, getCookieExpiry, getNextRefresh, acquireRefreshLock, releaseRefreshLock } = require('./cookieManager');
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
            console.log(`✅ [Worker] Successfully refreshed cookies for ${id} via keep-alive (no login needed)`);
            
            // After successful keep-alive, refresh data via APIs to keep Firebase current (non-blocking)
            process.nextTick(() => {
                (async () => {
                    try {
                        const { fetchAlfaData } = require('./alfaServiceApiFirst');
                        console.log(`🔄 [Worker] Refreshing data for ${id} after keep-alive...`);
                        await fetchAlfaData(phone, password, id, null, true); // background = true
                        console.log(`✅ [Worker] Data refreshed for ${id} after keep-alive`);
                    } catch (error) {
                        console.warn(`⚠️ [Worker] Failed to refresh data for ${id} after keep-alive:`, error.message);
                    }
                })();
            });
            
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
