const { fetchAllApis, ApiError, apiRequest } = require('./apiClient');
const { getCookies, getCookiesOrLogin, loginAndSaveCookies, saveCookies, saveLastJson, getLastJson, saveLastVerified, acquireRefreshLock, releaseRefreshLock, getCookieExpiry, areCookiesExpired } = require('./cookieManager');
const { extractFromGetConsumption, extractFromGetMyServices, extractExpiration } = require('./alfaApiDataExtraction');
const { updateDashboardData, getPendingSubscribers, removePendingSubscriber } = require('./firebaseDbService');
const { isLoginInProgress, setLoginInProgress, clearLoginInProgress } = require('./cookieRefreshWorker');
const { refreshCookiesKeepAlive } = require('./pseudoKeepAlive');
const { getAdminData } = require('./firebaseDbService');

const BASE_URL = 'https://www.alfa.com.lb';

// Track active refresh operations per user
const activeRefreshes = new Map();

// Semaphore for background refreshes to prevent API overload
const MAX_CONCURRENT_BACKGROUND_REFRESHES = 5; // Max 5 concurrent background refreshes
const activeBackgroundRefreshes = new Set();
const backgroundRefreshQueue = [];

/**
 * Acquire a slot for background refresh (with queue)
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} True if slot acquired immediately, Promise resolves when slot available
 */
async function acquireBackgroundRefreshSlot(userId) {
    if (activeBackgroundRefreshes.size < MAX_CONCURRENT_BACKGROUND_REFRESHES) {
        activeBackgroundRefreshes.add(userId);
        return true;
    }
    
    // Queue the request - wait for slot to become available
    return new Promise((resolve) => {
        backgroundRefreshQueue.push({ userId, resolve });
        console.log(`⏳ [${userId}] Background refresh queued (${activeBackgroundRefreshes.size}/${MAX_CONCURRENT_BACKGROUND_REFRESHES} active, ${backgroundRefreshQueue.length} queued)`);
    });
}

/**
 * Release a background refresh slot and process queue
 * @param {string} userId - User ID
 */
function releaseBackgroundRefreshSlot(userId) {
    activeBackgroundRefreshes.delete(userId);
    
    // Process queue
    while (backgroundRefreshQueue.length > 0 && activeBackgroundRefreshes.size < MAX_CONCURRENT_BACKGROUND_REFRESHES) {
        const queued = backgroundRefreshQueue.shift();
        activeBackgroundRefreshes.add(queued.userId);
        queued.resolve(true);
    }
}

/**
 * Perform auto-login for a user (used when cookies expired or keep-alive fails)
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function performAutoLogin(userId) {
    // Get admin credentials from Firebase
    const adminData = await getAdminData(userId);
    if (!adminData || !adminData.phone || !adminData.password) {
        throw new Error('Admin not found or missing credentials for auto-login');
    }
    
    // Perform auto-login
    await loginAndSaveCookies(adminData.phone, adminData.password, userId);
    console.log(`✅ [${userId}] Auto-login successful`);
}

/**
 * Silent cookie renewal - try to refresh cookies using pseudo keep-alive
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} True if renewal was successful
 */
async function trySilentCookieRenewal(userId) {
    try {
        console.log(`🔄 [${userId}] Attempting silent cookie renewal via keep-alive...`);
        
        // Use pseudo keep-alive to refresh cookies
        // Returns {success: boolean, needsRefresh: boolean}
        const result = await refreshCookiesKeepAlive(userId);
        
        if (result && result.success) {
            console.log(`✅ [${userId}] Silent renewal successful via keep-alive`);
            return result;
        } else {
            console.log(`⚠️ [${userId}] Silent renewal failed - ${result?.needsRefresh ? 'cookies expired' : 'network error'}`);
            return result || { success: false, needsRefresh: true };
        }
    } catch (error) {
        console.log(`⚠️ [${userId}] Silent renewal error:`, error.message);
        return { success: false, needsRefresh: true };
    }
}

/**
 * Fetch Alfa dashboard data using API-first approach (NO HTML scraping)
 * Optimized for high concurrency and speed
 * @param {string} phone - Phone number
 * @param {string} password - Password
 * @param {string} adminId - Admin document ID
 * @param {string} identifier - User identifier for caching (optional, defaults to adminId)
 * @returns {Promise<Object>} Dashboard data
 */
async function fetchAlfaData(phone, password, adminId, identifier = null) {
    const userId = adminId || phone;
    const startTime = Date.now();
    
    console.log(`🚀 [${userId}] API-first refresh requested`);

    // Step 1: Check cache FIRST (instant return if available and fresh)
    // IMPROVEMENT: Return immediately if cache is < 1 minute old (very fresh)
    const cachedData = await getLastJson(userId, true); // allowStale = true for manual refresh
    if (cachedData && cachedData.data) {
        const cacheAge = Date.now() - (cachedData.timestamp || 0);
        const cacheAgeMinutes = Math.round(cacheAge / 60000);
        const cacheAgeSeconds = Math.round(cacheAge / 1000);
        
        // IMPROVEMENT: Return immediately if cache is < 1 minute old (very fresh)
        if (cacheAge < 60 * 1000) { // 1 minute
            console.log(`⚡ [${userId}] Returning fresh cached data instantly (${Date.now() - startTime}ms, age: ${cacheAgeSeconds}s)`);
            
            // IMPROVEMENT: Rate-limited background refresh to prevent API overload
            // Delay background refresh by a random amount (0-5s) to stagger concurrent requests
            const delay = Math.floor(Math.random() * 5000);
            setTimeout(() => {
                (async () => {
                    try {
                        await fetchAlfaDataInternal(phone, password, adminId, identifier, true);
                    } catch (error) {
                        console.warn(`⚠️ [${userId}] Background refresh failed (non-critical):`, error.message);
                    }
                })();
            }, delay);

            return {
                success: true,
                incremental: false,
                noChanges: false,
                data: cachedData.data,
                timestamp: Date.now(),
                cached: true,
                duration: Date.now() - startTime
            };
        }
        
        // Return cached data if it's less than 2 hours old (reasonable for manual refresh)
        if (cacheAge < 2 * 60 * 60 * 1000) { // 2 hours
            console.log(`⚡ [${userId}] Returning cached data instantly (${Date.now() - startTime}ms, age: ${cacheAgeMinutes}min)`);
            
            // IMPROVEMENT: Rate-limited background refresh to prevent API overload
            // Delay background refresh by a random amount (0-10s) to stagger concurrent requests
            const delay = Math.floor(Math.random() * 10000);
            setTimeout(() => {
                (async () => {
                    try {
                        await fetchAlfaDataInternal(phone, password, adminId, identifier, true);
                    } catch (error) {
                        console.warn(`⚠️ [${userId}] Background refresh failed (non-critical):`, error.message);
                    }
                })();
            }, delay);

            return {
                success: true,
                incremental: false,
                noChanges: false,
                data: cachedData.data,
                timestamp: Date.now(),
                cached: true,
                duration: Date.now() - startTime
            };
        } else {
            console.log(`⚠️ [${userId}] Cached data too old (${cacheAgeMinutes}min), will fetch fresh data`);
        }
    }

    // Step 2: Check if login is in progress - if so, return cached data immediately (don't wait)
    if (await isLoginInProgress(userId)) {
        console.log(`⏳ [${userId}] Login in progress, returning cached data immediately...`);
        
        // Always return cached data if available (even if stale) - don't wait for login
        const staleCache = await getLastJson(userId, true); // allowStale = true
        if (staleCache && staleCache.data) {
            const cacheAge = Date.now() - (staleCache.timestamp || 0);
            const cacheAgeMinutes = Math.round(cacheAge / 60000);
            console.log(`⚡ [${userId}] Returning cached data while login in progress (age: ${cacheAgeMinutes}min, instant response)`);
            return {
                success: true,
                incremental: false,
                noChanges: false,
                data: staleCache.data, // Return the actual data, not the wrapper
                timestamp: Date.now(),
                cached: true,
                stale: true,
                duration: Date.now() - startTime
            };
        }
        
        // If no cache at all, proceed with fresh fetch (don't wait for worker login)
        console.log(`⚠️ [${userId}] No cached data available, proceeding with fresh fetch (not waiting for worker)`);
    }

    // Step 3: Fetch fresh data (no cache or login not in progress)
    return await fetchAlfaDataInternal(phone, password, adminId, identifier, false);
}

/**
 * Internal function to fetch data via API only (NO browser scraping)
 * Fully optimized for parallel execution and speed
 * @param {string} phone - Phone number
 * @param {string} password - Password
 * @param {string} adminId - Admin document ID
 * @param {string} identifier - Cache identifier
 * @param {boolean} background - Whether this is a background refresh
 * @returns {Promise<Object>} Dashboard data
 */
async function fetchAlfaDataInternal(phone, password, adminId, identifier, background = false) {
    const userId = adminId || phone;
    const startTime = Date.now();
    let loginPerformed = false;
    let refreshLockAcquired = false;
    let backgroundSlotAcquired = false;
    let apiData = null;
    let cookies = null;

    try {
        // IMPROVEMENT: For background refreshes, acquire semaphore slot to prevent API overload
        if (background) {
            // Wait for slot (may be queued)
            await acquireBackgroundRefreshSlot(userId);
            backgroundSlotAcquired = true;
            console.log(`🔄 [${userId}] Background refresh started (${activeBackgroundRefreshes.size}/${MAX_CONCURRENT_BACKGROUND_REFRESHES} active)`);
        }
        // Step 0: Acquire refresh lock for manual refresh (skip for background refreshes)
        if (!background) {
            refreshLockAcquired = await acquireRefreshLock(userId, 60); // Short lock (60s) for manual refresh
            if (!refreshLockAcquired) {
                // Lock already exists (worker is refreshing), serve cached lastData instantly
                console.log(`⏸️ [${userId}] Refresh lock exists (worker active), serving cached lastData instantly...`);
                const cachedData = await getLastJson(userId, true); // allowStale for instant response
                if (cachedData && cachedData.data) {
                    const cacheAge = Date.now() - (cachedData.timestamp || 0);
                    const cacheAgeMinutes = Math.round(cacheAge / 60000);
                    console.log(`⚡ [${userId}] Returning cached data instantly (worker busy, age: ${cacheAgeMinutes}min)`);
                    return {
                        success: true,
                        incremental: false,
                        noChanges: false,
                        data: cachedData.data, // Return the actual data, not the wrapper
                        timestamp: Date.now(),
                        cached: true,
                        stale: cacheAge > 60000, // Mark as stale if older than 1 minute
                        duration: Date.now() - startTime
                    };
                }
                // If no cached data at all, proceed with fresh fetch (don't wait for worker)
                console.log(`⚠️ [${userId}] No cached data available, proceeding with fresh fetch (not waiting for worker)`);
            }
        }

        // MANUAL REFRESH PATH (API-first, lightweight)
        if (!background) {
            // Step 1: Get cookies from Redis (don't check expiry yet - try APIs first)
            let cookies = await getCookies(userId);
            const cookieExpiry = await getCookieExpiry(userId);
            const now = Date.now();
            
            // Step 2: Try APIs immediately with current cookies (if available)
            let apiCallStart = Date.now();
            
            if (cookies && cookies.length > 0) {
                // Check Redis expiry - if still valid, don't mark as expired prematurely
                const expiryFromRedis = cookieExpiry && cookieExpiry <= now;
                if (!expiryFromRedis) {
                    console.log(`📡 [${userId}] Manual refresh: Using cached cookies (expiry: ${cookieExpiry ? new Date(cookieExpiry).toISOString() : 'N/A'}), fetching APIs...`);
                    
                    try {
                        // Fetch all APIs in parallel (fast path - 2-3s)
                        apiData = await fetchAllApis(cookies, { maxRetries: 1 }); // 1 retry for speed
                        
                        // Check if APIs succeeded
                        const hasConsumption = apiData.consumption && Object.keys(apiData.consumption).length > 0;
                        const hasServices = apiData.services && Object.keys(apiData.services).length > 0;
                        const hasExpiry = apiData.expiry !== null && apiData.expiry !== undefined;
                        
                        if (hasConsumption || hasServices || hasExpiry) {
                            // APIs succeeded - fast path (2-3s)
                            const apiDuration = Date.now() - apiCallStart;
                            const successCount = [hasConsumption, hasServices, hasExpiry].filter(Boolean).length;
                            console.log(`✅ [${userId}] Manual refresh: APIs succeeded (${successCount}/3 in ${apiDuration}ms) - Manual refresh used cached cookies`);
                            
                            // Release lock quickly (don't block scheduler)
                            if (refreshLockAcquired) {
                                await releaseRefreshLock(userId).catch(() => {});
                            }
                            
                            // Continue to data extraction (will be handled below)
                            // Skip to Step 4 (data extraction)
                        } else {
                            // All APIs failed - check error type
                            const hasUnauthorized = apiData._apiErrors && Object.values(apiData._apiErrors).some(err => err === 'Unauthorized');
                            if (hasUnauthorized) {
                                console.log(`⚠️ [${userId}] Manual refresh: APIs returned 401, trying keep-alive...`);
                                // Fall through to keep-alive
                            } else {
                                // Timeout/network error - use cached data
                                console.log(`⚠️ [${userId}] Manual refresh: API timeouts, using cached data`);
                                const cachedData = await getLastJson(userId, true);
                                if (cachedData && cachedData.data) {
                                    // Release lock quickly
                                    if (refreshLockAcquired) {
                                        await releaseRefreshLock(userId).catch(() => {});
                                    }
                                    // Return cached data
                                    return {
                                        success: true,
                                        incremental: false,
                                        noChanges: false,
                                        data: cachedData.data,
                                        timestamp: Date.now(),
                                        cached: true,
                                        duration: Date.now() - startTime
                                    };
                                }
                                // No cache - fall through to keep-alive
                            }
                        }
                    } catch (apiError) {
                        // API call failed - check error type
                        if (apiError.type === 'Unauthorized' || apiError.response?.status === 401) {
                            console.log(`⚠️ [${userId}] Manual refresh: APIs returned 401, trying keep-alive...`);
                            // Fall through to keep-alive
                        } else {
                            // Other error - use cached data if available
                            console.log(`⚠️ [${userId}] Manual refresh: API error (${apiError.type}), using cached data`);
                            const cachedData = await getLastJson(userId, true);
                            if (cachedData && cachedData.data) {
                                // Release lock quickly
                                if (refreshLockAcquired) {
                                    await releaseRefreshLock(userId).catch(() => {});
                                }
                                return {
                                    success: true,
                                    incremental: false,
                                    noChanges: false,
                                    data: cachedData.data,
                                    timestamp: Date.now(),
                                    cached: true,
                                    duration: Date.now() - startTime
                                };
                            }
                            // No cache - fall through to keep-alive
                        }
                    }
                } else {
                    // Redis expiry says expired - but try APIs first anyway (might still work)
                    console.log(`⚠️ [${userId}] Manual refresh: Redis expiry indicates expired, but trying APIs first...`);
                    try {
                        apiData = await fetchAllApis(cookies, { maxRetries: 1 });
                        const hasConsumption = apiData.consumption && Object.keys(apiData.consumption).length > 0;
                        const hasServices = apiData.services && Object.keys(apiData.services).length > 0;
                        if (hasConsumption || hasServices) {
                            // APIs worked despite expiry - fast path
                            const apiDuration = Date.now() - apiCallStart;
                            console.log(`✅ [${userId}] Manual refresh: APIs succeeded despite expiry (${apiDuration}ms) - Manual refresh used cached cookies`);
                            if (refreshLockAcquired) {
                                await releaseRefreshLock(userId).catch(() => {});
                            }
                            // Continue to data extraction
                        } else {
                            // APIs failed - try keep-alive
                            console.log(`⚠️ [${userId}] Manual refresh: APIs failed, trying keep-alive...`);
                        }
                    } catch (apiError) {
                        // APIs failed - try keep-alive
                        console.log(`⚠️ [${userId}] Manual refresh: APIs failed (${apiError.type}), trying keep-alive...`);
                    }
                }
            } else {
                // No cookies - must login
                console.log(`⚠️ [${userId}] Manual refresh: No cookies found, performing login...`);
            }
            
            // Step 3: If APIs failed with 401/302, try keep-alive (only for manual refresh)
            if (!apiData || (!apiData.consumption && !apiData.services)) {
                if (cookies && cookies.length > 0) {
                    console.log(`🔄 [${userId}] Manual refresh: Trying keep-alive...`);
                    const keepAliveResult = await trySilentCookieRenewal(userId);
                    
                    if (keepAliveResult && keepAliveResult.success) {
                        // Keep-alive succeeded - retry APIs
                        console.log(`✅ [${userId}] Manual refresh: Keep-alive succeeded, retrying APIs...`);
                        cookies = await getCookies(userId);
                        apiCallStart = Date.now();
                        try {
                            apiData = await fetchAllApis(cookies, { maxRetries: 1 });
                            const apiDuration = Date.now() - apiCallStart;
                            console.log(`✅ [${userId}] Manual refresh: APIs succeeded after keep-alive (${apiDuration}ms) - Manual refresh required keep-alive`);
                            
                            // Release lock quickly
                            if (refreshLockAcquired) {
                                await releaseRefreshLock(userId).catch(() => {});
                                refreshLockAcquired = false; // Mark as released
                            }
                            
                            // Ensure apiData is initialized
                            if (!apiData) {
                                apiData = {};
                            }
                            
                            // Continue to data extraction
                        } catch (retryError) {
                            console.log(`⚠️ [${userId}] Manual refresh: APIs still failed after keep-alive, performing login...`);
                            // Fall through to login
                        }
                    } else {
                        // Keep-alive failed - perform full login
                        console.log(`⚠️ [${userId}] Manual refresh: Keep-alive failed, performing login...`);
                    }
                }
            }
            
            // Step 4: If still no data, perform full login (only when absolutely necessary)
            if (!apiData || (!apiData.consumption && !apiData.services)) {
                console.log(`🔐 [${userId}] Manual refresh: Performing full login (required login)`);
                
                // Get admin credentials from Firebase
                const adminData = await getAdminData(userId);
                if (!adminData || !adminData.phone || !adminData.password) {
                    throw new Error('Admin not found or missing credentials for auto-login');
                }
                
                // Perform full login
                await loginAndSaveCookies(adminData.phone, adminData.password, userId);
                cookies = await getCookies(userId);
                loginPerformed = true;
                
                // Fetch APIs with fresh cookies
                apiCallStart = Date.now();
                apiData = await fetchAllApis(cookies, { maxRetries: 1 });
                const apiDuration = Date.now() - apiCallStart;
                console.log(`✅ [${userId}] Manual refresh: APIs succeeded after login (${apiDuration}ms) - Manual refresh required login`);
                
                // Release lock quickly (don't block scheduler)
                if (refreshLockAcquired) {
                    await releaseRefreshLock(userId).catch(() => {});
                    refreshLockAcquired = false; // Mark as released to prevent double release
                }
            }
            
            // Ensure apiData is initialized (safety check)
            if (!apiData) {
                apiData = {};
            }
            
            // Continue to data extraction (Step 4 below)
        } else {
            // BACKGROUND REFRESH PATH (existing logic for scheduler)
            // Step 1: Check cookie expiry from Redis FIRST (before attempting API calls)
            const cookieExpiry = await getCookieExpiry(userId);
            const now = Date.now();
            
            // Step 2: Get cookies from Redis
            cookies = await getCookies(userId);
            
            // Step 3: Check if cookies are expired (multiple checks for reliability)
            const expiryFromRedis = cookieExpiry && cookieExpiry <= now;
            const cookiesMissing = !cookies || cookies.length === 0;
            const cookiesExpiredByCheck = cookies && cookies.length > 0 && areCookiesExpired(cookies);
            const cookiesExpired = expiryFromRedis || cookiesMissing || cookiesExpiredByCheck;
            
            // Step 4: If cookies expired → perform auto-login immediately (before any API calls)
            if (cookiesExpired) {
                console.log(`⚠️ [${userId}] Cookies expired or missing, performing auto-login...`);
                
                // Get admin credentials from Firebase
                const adminData = await getAdminData(userId);
                if (!adminData || !adminData.phone || !adminData.password) {
                    throw new Error('Admin not found or missing credentials for auto-login');
                }
                
                // Perform auto-login
                try {
                    await loginAndSaveCookies(adminData.phone, adminData.password, userId);
                    // Get fresh cookies after login
                    cookies = await getCookies(userId);
                    loginPerformed = true;
                    console.log(`✅ [${userId}] Auto-login successful, got ${cookies?.length || 0} fresh cookies`);
                } catch (loginError) {
                    console.error(`❌ [${userId}] Auto-login failed:`, loginError.message);
                    throw new Error(`Auto-login failed: ${loginError.message}`);
                }
            }
            
            // Step 4: Fetch all APIs in parallel IMMEDIATELY (with fresh cookies if login was performed)
            let apiCallStart = Date.now();
            
            if (cookies && cookies.length > 0) {
                console.log(`📡 [${userId}] Found ${cookies.length} cookies, fetching APIs in parallel...`);
                
                try {
                    // Fetch all APIs in parallel
                    apiData = await fetchAllApis(cookies, {});
                    
                    // CRITICAL: Check if getconsumption returned 401 (even if other APIs succeeded)
                    const consumptionFailed = !apiData.consumption || Object.keys(apiData.consumption || {}).length === 0;
                    const consumptionUnauthorized = apiData._apiErrors && apiData._apiErrors.consumption === 'Unauthorized';
                    
                    // Check if we need to retry getconsumption due to 401
                    if (consumptionFailed && consumptionUnauthorized) {
                        console.log(`⚠️ [${userId}] getconsumption returned 401 Unauthorized, performing auto-login and retrying...`);
                        
                        // Perform auto-login immediately
                        await performAutoLogin(userId);
                        cookies = await getCookies(userId);
                        loginPerformed = true;
                        
                        // Retry getconsumption specifically with fresh cookies
                        console.log(`🔄 [${userId}] Retrying getconsumption API with fresh cookies...`);
                        try {
                            const consumptionRetry = await apiRequest('/en/account/getconsumption', cookies, { timeout: 5000, maxRetries: 2 });
                            if (consumptionRetry && Object.keys(consumptionRetry).length > 0) {
                                apiData.consumption = consumptionRetry;
                                apiData._apiSuccess = apiData._apiSuccess || {};
                                apiData._apiSuccess.consumption = true;
                                apiData._apiErrors = apiData._apiErrors || {};
                                apiData._apiErrors.consumption = null; // Clear error
                                console.log(`✅ [${userId}] getconsumption succeeded after auto-login retry`);
                            } else {
                                console.error(`❌ [${userId}] getconsumption still failed after auto-login retry`);
                            }
                        } catch (retryError) {
                            console.error(`❌ [${userId}] getconsumption retry failed:`, retryError.message);
                        }
                    }
                
                // Check if we got at least one required API
                // Allow partial success - if at least one critical API succeeds, proceed
                const hasConsumption = apiData.consumption && Object.keys(apiData.consumption).length > 0;
                const hasServices = apiData.services && Object.keys(apiData.services).length > 0;
                // CRITICAL: getexpirydate returns a number, not an object - check for number or valid value
                const hasExpiry = apiData.expiry !== null && apiData.expiry !== undefined && (typeof apiData.expiry === 'number' || (typeof apiData.expiry === 'object' && Object.keys(apiData.expiry).length > 0));
                
                // CRITICAL: If getconsumption is still missing, check for cached data before proceeding
                if (!hasConsumption) {
                    const cachedData = await getLastJson(userId);
                    if (cachedData && cachedData.data && cachedData.data.consumption) {
                        console.log(`📦 [${userId}] getconsumption failed, using cached consumption data (CRITICAL for status)`);
                        apiData.consumption = cachedData.data.consumption;
                        // Mark as successful from cache (for status tracking)
                        apiData._apiSuccess = apiData._apiSuccess || {};
                        apiData._apiSuccess.consumption = true; // Mark as "successful" since we have cached data
                        apiData._apiErrors = apiData._apiErrors || {};
                        apiData._apiErrors.consumption = null; // Clear error
                    } else {
                        console.error(`❌ [${userId}] CRITICAL: getconsumption failed and no cached data available - admin may become inactive!`);
                    }
                }
                
                if (hasConsumption || hasServices) {
                    const apiDuration = Date.now() - apiCallStart;
                    const successCount = [hasConsumption, hasServices, hasExpiry].filter(Boolean).length;
                    const missing = [];
                    if (!hasConsumption) missing.push('consumption');
                    if (!hasServices) missing.push('services');
                    if (!hasExpiry) missing.push('expiry');
                    
                    if (missing.length > 0) {
                        console.log(`⚠️ [${userId}] Partial API success (${successCount}/3 APIs in ${apiDuration}ms) - missing: ${missing.join(', ')}`);
                        // Try to use cached data for missing APIs (except consumption, already handled above)
                        const cachedData = await getLastJson(userId);
                        if (cachedData && cachedData.data) {
                            console.log(`📦 [${userId}] Using cached data to fill missing APIs...`);
                            if (!hasServices && cachedData.data.services) {
                                apiData.services = cachedData.data.services;
                                console.log(`✅ [${userId}] Filled services from cache`);
                            }
                            // CRITICAL: Also fill expiry from cache if API failed
                            if (!hasExpiry && cachedData.data.expiration !== undefined && cachedData.data.expiration !== null) {
                                // Note: expiration is stored as a number in dashboardData, but we need to check if it's valid
                                const cachedExpiration = cachedData.data.expiration;
                                if (typeof cachedExpiration === 'number' && !isNaN(cachedExpiration) && cachedExpiration > 0) {
                                    // Store as a number (getexpirydate returns a number)
                                    apiData.expiry = cachedExpiration;
                                    console.log(`✅ [${userId}] Filled expiry from cache: ${cachedExpiration} days`);
                                } else {
                                    console.log(`⚠️ [${userId}] Cached expiration is invalid (${cachedExpiration}), not filling from cache`);
                                }
                            }
                        }
                    } else {
                        console.log(`✅ [${userId}] API calls successful (${successCount}/3 APIs in ${apiDuration}ms)`);
                    }
                } else {
                    // Both critical APIs failed - this will be caught by the catch block below
                    const apiDuration = Date.now() - apiCallStart;
                    console.log(`⚠️ [${userId}] Both consumption and services failed (${apiDuration}ms)`);
                    throw new ApiError('No API data received - both consumption and services failed', 'Network');
                }
            } catch (apiError) {
                // If API calls fail, check the error type
                if (apiError.type === 'Unauthorized') {
                    // 401 Unauthorized - cookies expired, perform auto-login immediately (no keep-alive attempt)
                    console.log(`⚠️ [${userId}] Cookies expired (401), performing auto-login immediately...`);
                    
                    // Perform auto-login immediately (don't try keep-alive first - 401 means cookies are definitely expired)
                    await performAutoLogin(userId);
                    cookies = await getCookies(userId);
                    loginPerformed = true;
                    
                    // Retry API calls with fresh cookies
                    apiCallStart = Date.now();
                    apiData = await fetchAllApis(cookies, { maxRetries: 1 });
                    const apiDuration = Date.now() - apiCallStart;
                    console.log(`✅ [${userId}] API calls successful after auto-login (${apiDuration}ms)`);
                } else if (apiError.type === 'Timeout' || apiError.message.includes('timeout') || apiError.message.includes('No API data received')) {
                    // Timeout error or all APIs failed - network is slow, but cookies might still be valid
                    // Try to use cached data instead of failing
                    console.log(`⚠️ [${userId}] API timeouts/all failed detected, checking for cached data...`);
                    const cachedData = await getLastJson(userId);
                    if (cachedData && cachedData.data) {
                        const cacheAge = Date.now() - (cachedData.timestamp || 0);
                        const cacheAgeMinutes = Math.round(cacheAge / 60000);
                        console.log(`📦 [${userId}] Using cached data (${cacheAgeMinutes} minutes old) due to API timeouts`);
                        // Merge cached data with any successful API responses (don't overwrite successful ones)
                        apiData = {
                            consumption: apiData?.consumption || cachedData.data.consumption,
                            services: apiData?.services || cachedData.data.services,
                            expiry: apiData?.expiry || cachedData.data.expiry
                        };
                        console.log(`✅ [${userId}] Proceeding with cached data (stale: ${cacheAgeMinutes}min)`);
                    } else {
                        // No cache available - this is a real failure, but don't throw yet
                        // Let it fall through to login attempt
                        console.error(`❌ [${userId}] API timeouts and no cached data available - will attempt login`);
                        cookies = null; // Force login to get fresh data
                    }
                } else {
                    // Other network/server errors - try cache first, then login
                    console.log(`⚠️ [${userId}] Network error (${apiError.type}), checking for cached data...`);
                    const cachedData = await getLastJson(userId);
                    if (cachedData && cachedData.data) {
                        const cacheAge = Date.now() - (cachedData.timestamp || 0);
                        const cacheAgeMinutes = Math.round(cacheAge / 60000);
                        console.log(`📦 [${userId}] Using cached data (${cacheAgeMinutes} minutes old) due to network error`);
                        // Merge cached data with any successful API responses (don't overwrite successful ones)
                        apiData = {
                            consumption: apiData?.consumption || cachedData.data.consumption,
                            services: apiData?.services || cachedData.data.services,
                            expiry: apiData?.expiry || cachedData.data.expiry
                        };
                        console.log(`✅ [${userId}] Proceeding with cached data (stale: ${cacheAgeMinutes}min)`);
                    } else {
                        // No cache - force login
                        console.error(`❌ [${userId}] Network error and no cached data - will attempt login`);
                        cookies = null;
                    }
                }
            }
            } else {
                console.log(`⚠️ [${userId}] No cookies found, will perform login...`);
            }
            
            // Ensure apiData is initialized (safety check)
            if (!apiData) {
                apiData = {};
            }
        }

        // Step 3: If no cookies or API calls failed, perform login (ONLY if we don't already have valid apiData)
        // Skip this if manual refresh already succeeded (has apiData with consumption or services)
        const hasValidApiData = apiData && (apiData.consumption || apiData.services);
        // Only login if we DON'T have valid API data AND we need cookies
        if (!hasValidApiData && (!cookies || cookies.length === 0)) {
            // Mark login as in progress
            await setLoginInProgress(userId);
            
            try {
                console.log(`🔐 [${userId}] Performing login to get fresh cookies...`);
                const loginStart = Date.now();
                cookies = await loginAndSaveCookies(phone, password, userId);
                loginPerformed = true;
                const loginDuration = Date.now() - loginStart;
                console.log(`✅ [${userId}] Login completed in ${loginDuration}ms`);
                
                // Now fetch APIs in parallel with fresh cookies
                apiCallStart = Date.now();
                const apiOptions = background ? {} : { maxRetries: 1 }; // Manual refresh: fewer retries
                apiData = await fetchAllApis(cookies, apiOptions);
                const apiDuration = Date.now() - apiCallStart;
                const successCount = [apiData.consumption, apiData.services, apiData.expiry].filter(Boolean).length;
                console.log(`✅ [${userId}] API calls successful after login (${successCount}/3 APIs in ${apiDuration}ms)`);
            } catch (loginError) {
                console.error(`❌ [${userId}] Login or API calls failed:`, loginError.message);
                throw loginError;
            } finally {
                // Clear login-in-progress flag
                await clearLoginInProgress(userId);
            }
        }

        // Step 4: Extract data from API responses (parallel processing)
        // CRITICAL: Start with cached data to preserve ALL fields (prevents admins becoming inactive)
        const cachedData = await getLastJson(userId, true); // allowStale for fallback
        const dashboardData = cachedData && cachedData.data ? { ...cachedData.data } : {};
        
        console.log(`📦 [${userId}] Starting with cached data: ${Object.keys(dashboardData).length} fields`);

        // Extract from getconsumption (override cached data only if API succeeded)
        // CRITICAL: primaryData is required for status determination - must be preserved at all costs
        if (apiData.consumption) {
            const extracted = extractFromGetConsumption(apiData.consumption);
            // Merge extracted data (overrides cached data for these fields)
            Object.assign(dashboardData, extracted);
            if (extracted.secondarySubscribers && extracted.secondarySubscribers.length > 0) {
                console.log(`✅ [${userId}] Extracted ${extracted.secondarySubscribers.length} secondary subscribers from API`);
            }
        } else {
            // API failed - CRITICAL: Must preserve primaryData from cache to prevent admin becoming inactive
            console.log(`📦 [${userId}] getconsumption API failed, preserving cached consumption data (CRITICAL for status)`);
            
            // Check if we have cached consumption data (either in dashboardData or cachedData.data.consumption)
            const cachedConsumption = dashboardData.consumption || (cachedData && cachedData.data && cachedData.data.consumption);
            
            if (cachedConsumption) {
                // Re-extract to ensure primaryData is set (needed for status determination)
                const extracted = extractFromGetConsumption(cachedConsumption);
                // CRITICAL: Always set primaryData if missing (prevents admin becoming inactive)
                if (!dashboardData.primaryData) {
                    dashboardData.primaryData = extracted.primaryData;
                    console.log(`✅ [${userId}] Restored primaryData from cached consumption (CRITICAL for status)`);
                }
                // Merge all consumption fields (preserve existing, fill missing)
                if (!dashboardData.balance && extracted.balance) dashboardData.balance = extracted.balance;
                if (!dashboardData.totalConsumption && extracted.totalConsumption) dashboardData.totalConsumption = extracted.totalConsumption;
                if (!dashboardData.adminConsumption && extracted.adminConsumption) dashboardData.adminConsumption = extracted.adminConsumption;
                if (!dashboardData.secondarySubscribers && extracted.secondarySubscribers) dashboardData.secondarySubscribers = extracted.secondarySubscribers;
                if (!dashboardData.subscribersCount && extracted.subscribersCount) dashboardData.subscribersCount = extracted.subscribersCount;
            } else if (dashboardData.primaryData) {
                // primaryData exists in cached dashboardData, keep it
                console.log(`✅ [${userId}] Preserved existing primaryData from cached dashboardData`);
            } else {
                // No cached consumption data at all - this is a problem
                console.error(`❌ [${userId}] CRITICAL: No cached consumption data available - admin may become inactive!`);
            }
        }

        // Extract from getmyservices (CRITICAL: Subscription Date and Validity Date)
        // Override cached data only if API succeeded with valid dates
        if (apiData.services) {
            const extracted = extractFromGetMyServices(apiData.services);
            // Only set dates if they are valid (not null, not undefined, not empty, not NaN)
            if (extracted.subscriptionDate && typeof extracted.subscriptionDate === 'string' && extracted.subscriptionDate.trim() && !extracted.subscriptionDate.includes('NaN')) {
                dashboardData.subscriptionDate = extracted.subscriptionDate;
                console.log(`✅ [${userId}] Extracted subscriptionDate from API: ${extracted.subscriptionDate}`);
            } else if (extracted.subscriptionDate) {
                console.log(`⚠️ [${userId}] Invalid subscriptionDate from API (${extracted.subscriptionDate}), preserving cached value`);
            }
            if (extracted.validityDate && typeof extracted.validityDate === 'string' && extracted.validityDate.trim() && !extracted.validityDate.includes('NaN')) {
                dashboardData.validityDate = extracted.validityDate;
                console.log(`✅ [${userId}] Extracted validityDate from API: ${extracted.validityDate}`);
            } else if (extracted.validityDate) {
                console.log(`⚠️ [${userId}] Invalid validityDate from API (${extracted.validityDate}), preserving cached value`);
            }
        } else {
            // API failed - preserve dates from cached data (CRITICAL: prevent NaN/NaN/NaN in frontend)
            console.log(`📦 [${userId}] getmyservices API failed, preserving cached dates`);
            
            // CRITICAL: Always check cachedData.data for dates, even if dashboardData is empty
            // This ensures dates are preserved even when cachedData.data has 0 fields initially
            if (cachedData && cachedData.data) {
                // Preserve subscriptionDate from cache (only if valid and not already set)
                if (!dashboardData.subscriptionDate && cachedData.data.subscriptionDate) {
                    const cachedSubDate = cachedData.data.subscriptionDate;
                    // Validate: must be a string in DD/MM/YYYY format, not null/undefined/NaN
                    if (typeof cachedSubDate === 'string' && cachedSubDate.trim() && !cachedSubDate.includes('NaN')) {
                        dashboardData.subscriptionDate = cachedSubDate;
                        console.log(`✅ [${userId}] Preserved cached subscriptionDate: ${dashboardData.subscriptionDate}`);
                    }
                }
                
                // Preserve validityDate from cache (only if valid and not already set)
                if (!dashboardData.validityDate && cachedData.data.validityDate) {
                    const cachedValDate = cachedData.data.validityDate;
                    // Validate: must be a string in DD/MM/YYYY format, not null/undefined/NaN
                    if (typeof cachedValDate === 'string' && cachedValDate.trim() && !cachedValDate.includes('NaN')) {
                        dashboardData.validityDate = cachedValDate;
                        console.log(`✅ [${userId}] Preserved cached validityDate: ${dashboardData.validityDate}`);
                    }
                }
            }
            
            // Also check if dates exist in dashboardData but are invalid (NaN)
            if (dashboardData.subscriptionDate && (dashboardData.subscriptionDate.includes('NaN') || dashboardData.subscriptionDate === 'NaN/NaN/NaN')) {
                console.log(`⚠️ [${userId}] Invalid subscriptionDate detected (NaN), removing it`);
                delete dashboardData.subscriptionDate;
                // Try to restore from cache
                if (cachedData && cachedData.data && cachedData.data.subscriptionDate) {
                    const cachedSubDate = cachedData.data.subscriptionDate;
                    if (typeof cachedSubDate === 'string' && cachedSubDate.trim() && !cachedSubDate.includes('NaN')) {
                        dashboardData.subscriptionDate = cachedSubDate;
                        console.log(`✅ [${userId}] Restored valid subscriptionDate from cache: ${dashboardData.subscriptionDate}`);
                    }
                }
            }
            
            if (dashboardData.validityDate && (dashboardData.validityDate.includes('NaN') || dashboardData.validityDate === 'NaN/NaN/NaN')) {
                console.log(`⚠️ [${userId}] Invalid validityDate detected (NaN), removing it`);
                delete dashboardData.validityDate;
                // Try to restore from cache
                if (cachedData && cachedData.data && cachedData.data.validityDate) {
                    const cachedValDate = cachedData.data.validityDate;
                    if (typeof cachedValDate === 'string' && cachedValDate.trim() && !cachedValDate.includes('NaN')) {
                        dashboardData.validityDate = cachedValDate;
                        console.log(`✅ [${userId}] Restored valid validityDate from cache: ${dashboardData.validityDate}`);
                    }
                }
            }
        }

        // Extract expiration (with fallback to cached data)
        // CRITICAL: Never display 0 - always preserve last valid expiration from cache
        // CRITICAL: getexpirydate API can return null (failed), 0 (invalid), or a number (valid)
        if (apiData.expiry !== null && apiData.expiry !== undefined) {
            // API returned something (could be 0, number, or object)
            const extractedExpiration = extractExpiration(apiData.expiry);
            if (extractedExpiration !== null && extractedExpiration !== undefined && !isNaN(extractedExpiration) && extractedExpiration > 0) {
                // Valid expiration from API
                dashboardData.expiration = extractedExpiration;
                console.log(`✅ [${userId}] Extracted expiration from API: ${extractedExpiration} days`);
            } else {
                // API returned invalid data (0, null, NaN, or empty object)
                console.log(`⚠️ [${userId}] getexpirydate API returned invalid data (${apiData.expiry}), preserving cached expiration`);
                // CRITICAL: Always preserve cached expiration when API returns invalid data
                // Check if we already have a valid expiration from cache (initialized in dashboardData)
                if (dashboardData.expiration === undefined || dashboardData.expiration === null || dashboardData.expiration === 0 || isNaN(dashboardData.expiration)) {
                    // Current expiration is invalid, try to restore from cache
                    if (cachedData && cachedData.data && cachedData.data.expiration) {
                        const cachedExpiration = cachedData.data.expiration;
                        // Validate cached expiration is valid (> 0, not NaN)
                        if (typeof cachedExpiration === 'number' && !isNaN(cachedExpiration) && cachedExpiration > 0) {
                            dashboardData.expiration = cachedExpiration;
                            console.log(`✅ [${userId}] Preserved cached expiration: ${cachedExpiration} days`);
                        } else {
                            console.log(`⚠️ [${userId}] Cached expiration is also invalid (${cachedExpiration}), keeping it but logging warning`);
                            // Keep the invalid cached value rather than deleting (better than 0)
                            dashboardData.expiration = cachedExpiration;
                        }
                    } else {
                        console.log(`⚠️ [${userId}] No cached expiration available, expiration will be missing`);
                        // Don't delete - let it be undefined rather than 0
                    }
                } else {
                    // dashboardData.expiration is already valid (from cache initialization), keep it
                    console.log(`✅ [${userId}] Keeping existing valid expiration from cache: ${dashboardData.expiration} days`);
                }
            }
        } else {
            // API failed completely (401, timeout, network error, etc.) - preserve cached expiration
            console.log(`📦 [${userId}] getexpirydate API failed (returned null/undefined), preserving cached expiration`);
            // CRITICAL: Always check cachedData.data for expiration, even if dashboardData is empty
            // But first check if dashboardData already has a valid expiration (from initialization)
            if (dashboardData.expiration === undefined || dashboardData.expiration === null || dashboardData.expiration === 0 || isNaN(dashboardData.expiration)) {
                // Current expiration is invalid or missing, try to restore from cache
                if (cachedData && cachedData.data && cachedData.data.expiration) {
                    const cachedExpiration = cachedData.data.expiration;
                    // Validate cached expiration is valid (> 0, not NaN)
                    if (typeof cachedExpiration === 'number' && !isNaN(cachedExpiration) && cachedExpiration > 0) {
                        dashboardData.expiration = cachedExpiration;
                        console.log(`✅ [${userId}] Preserved cached expiration after API failure: ${cachedExpiration} days`);
                    } else {
                        console.log(`⚠️ [${userId}] Cached expiration is invalid (${cachedExpiration}), keeping it but logging warning`);
                        // Keep the invalid cached value rather than deleting (better than 0)
                        dashboardData.expiration = cachedExpiration;
                    }
                } else {
                    console.log(`⚠️ [${userId}] No cached expiration available after API failure, expiration will be missing`);
                    // Don't set to 0 - let it be undefined
                }
            } else {
                // dashboardData.expiration is already valid (from cache initialization), keep it
                console.log(`✅ [${userId}] Keeping existing valid expiration from cache after API failure: ${dashboardData.expiration} days`);
            }
        }
        
        // CRITICAL: Final validation - ensure expiration is never 0, null, undefined, or NaN
        if (dashboardData.expiration !== undefined && dashboardData.expiration !== null) {
            if (dashboardData.expiration === 0 || isNaN(dashboardData.expiration)) {
                console.log(`⚠️ [${userId}] Final validation: Invalid expiration detected (${dashboardData.expiration}), removing it`);
                delete dashboardData.expiration;
            }
        }
        
        // CRITICAL: Ensure all critical fields are preserved from cache to prevent status changes
        // primaryData is THE most critical field - without it, admin becomes inactive
        if (cachedData && cachedData.data) {
            // CRITICAL: primaryData must exist for status determination
            if (!dashboardData.primaryData) {
                // Try to get primaryData from cached dashboardData
                if (cachedData.data.primaryData) {
                    dashboardData.primaryData = cachedData.data.primaryData;
                    console.log(`✅ [${userId}] Restored primaryData from cached dashboardData (CRITICAL for status)`);
                } else if (cachedData.data.consumption) {
                    // Extract primaryData from cached consumption data
                    const extracted = extractFromGetConsumption(cachedData.data.consumption);
                    if (extracted.primaryData) {
                        dashboardData.primaryData = extracted.primaryData;
                        console.log(`✅ [${userId}] Extracted primaryData from cached consumption (CRITICAL for status)`);
                    }
                }
            }
            
            // Preserve other critical fields that might be missing
            const criticalFields = ['balance', 'totalConsumption', 'adminConsumption', 'secondarySubscribers', 'subscribersCount'];
            for (const field of criticalFields) {
                if (dashboardData[field] === undefined || dashboardData[field] === null) {
                    if (cachedData.data[field] !== undefined && cachedData.data[field] !== null) {
                        dashboardData[field] = cachedData.data[field];
                        console.log(`✅ [${userId}] Preserved cached ${field}`);
                    }
                }
            }
        }
        
        // FINAL CHECK: Ensure primaryData exists - if not, admin will become inactive
        if (!dashboardData.primaryData) {
            console.error(`❌ [${userId}] CRITICAL WARNING: primaryData is missing - admin will be marked inactive!`);
            console.error(`   Available fields: ${Object.keys(dashboardData).join(', ')}`);
            console.error(`   Cached data exists: ${!!cachedData}`);
            console.error(`   Cached data fields: ${cachedData && cachedData.data ? Object.keys(cachedData.data).join(', ') : 'none'}`);
        } else {
            console.log(`✅ [${userId}] primaryData verified: ${typeof dashboardData.primaryData === 'object' ? 'object' : typeof dashboardData.primaryData}`);
        }

        // Step 5: Save to Redis cache (non-blocking)
        await saveLastJson(userId, dashboardData);
        await saveLastVerified(userId);

        // Step 6: Save to Firebase (non-blocking, fire-and-forget)
        // CRITICAL: Only save to Firebase if we have valid primaryData (prevents admins becoming inactive)
        // For background refreshes, only save if APIs succeeded (don't overwrite good data with bad data)
        const hasValidPrimaryData = dashboardData.primaryData && typeof dashboardData.primaryData === 'object' && Object.keys(dashboardData.primaryData).length > 0;
        const hasApiData = apiData && (apiData.consumption || apiData.services || apiData.expiry);
        
        // Determine if we should save to Firebase:
        // 1. Manual refresh: Always save if primaryData exists (user expects update)
        // 2. Background refresh: Only save if APIs succeeded AND primaryData exists (don't overwrite good data with bad)
        const shouldSaveToFirebase = hasValidPrimaryData && (!background || hasApiData);
        
        if (!background || shouldSaveToFirebase) {
            if (!hasValidPrimaryData) {
                console.warn(`⚠️ [${userId}] Skipping Firebase save - primaryData missing (would mark admin inactive)`);
            } else if (background && !hasApiData) {
                console.warn(`⚠️ [${userId}] Skipping Firebase save for background refresh - APIs failed (preserving existing good data)`);
            } else {
                process.nextTick(() => {
                    (async () => {
                        try {
                            await updateDashboardData(adminId, dashboardData);
                            
                            // Check if any pending subscribers are now confirmed (appear in API response)
                            const pendingSubscribers = await getPendingSubscribers(adminId);
                            if (pendingSubscribers.length > 0 && dashboardData.secondarySubscribers) {
                                const confirmedPhones = (dashboardData.secondarySubscribers || []).map(s => s.phoneNumber);
                                for (const pending of pendingSubscribers) {
                                    if (confirmedPhones.includes(pending.phone)) {
                                        // Subscriber accepted invitation, remove from pending
                                        await removePendingSubscriber(adminId, pending.phone);
                                        console.log(`✅ [${userId}] Pending subscriber ${pending.phone} is now confirmed`);
                                    }
                                }
                            }
                        } catch (firebaseError) {
                            console.warn(`⚠️ [${userId}] Firebase save skipped (non-critical):`, firebaseError?.message);
                        }
                    })();
                });
            }
        }

        const duration = Date.now() - startTime;
        console.log(`✅ [${userId}] API-first refresh completed in ${duration}ms (login: ${loginPerformed ? 'yes' : 'no'})`);

        // Lock is already released in manual refresh path (for speed)
        // Only release here if it wasn't released earlier (background refresh)
        if (refreshLockAcquired && background) {
            await releaseRefreshLock(userId).catch(() => {});
        }

        return {
            success: true,
            incremental: false,
            noChanges: false,
            data: dashboardData,
            timestamp: Date.now(),
            duration: duration,
            loginPerformed: loginPerformed
        };

    } catch (error) {
        // Clear login-in-progress flag on error
        await clearLoginInProgress(userId).catch(() => {});
        
        // Release refresh lock on error (manual refresh only - background doesn't use lock)
        if (refreshLockAcquired && !background) {
            await releaseRefreshLock(userId).catch(() => {});
        }
        
        console.error(`❌ [${userId}] API-first refresh failed:`, error.message);
        console.error(`Stack:`, error.stack);
        
        // NO FALLBACK TO BROWSER SCRAPING - throw error instead
        throw new Error(`API-first refresh failed: ${error.message}`);
    } finally {
        // Always release lock for manual refresh (if still held - safety net)
        if (refreshLockAcquired && !background) {
            await releaseRefreshLock(userId).catch(() => {});
        }
        
        // IMPROVEMENT: Release background refresh slot
        if (background && backgroundSlotAcquired) {
            releaseBackgroundRefreshSlot(userId);
        }
    }
}

module.exports = {
    fetchAlfaData
};
