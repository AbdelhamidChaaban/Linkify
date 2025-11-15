const { fetchAllApis, ApiError, apiRequest } = require('./apiClient');
const { getCookies, getCookiesOrLogin, loginAndSaveCookies, saveCookies, saveLastJson, getLastJson, saveLastVerified } = require('./cookieManager');
const { extractFromGetConsumption, extractFromGetMyServices, extractExpiration } = require('./alfaApiDataExtraction');
const { updateDashboardData } = require('./firebaseDbService');
const { isLoginInProgress, setLoginInProgress, clearLoginInProgress } = require('./cookieRefreshWorker');

const BASE_URL = 'https://www.alfa.com.lb';

// Track active refresh operations per user
const activeRefreshes = new Map();

/**
 * Silent cookie renewal - try to refresh cookies by calling /en/account
 * @param {Array} cookies - Current cookies
 * @param {string} userId - User ID
 * @returns {Promise<Array|null>} Fresh cookies or null if renewal failed
 */
async function trySilentCookieRenewal(cookies, userId) {
    try {
        console.log(`🔄 [${userId}] Attempting silent cookie renewal...`);
        
        // Try to call /en/account with existing cookies
        // If successful, cookies are still valid
        const response = await apiRequest('/en/account', cookies, { timeout: 5000 });
        
        // If we get here, cookies are valid - refresh them
        console.log(`✅ [${userId}] Silent renewal successful - cookies are still valid`);
        return cookies; // Cookies are still valid
    } catch (error) {
        console.log(`⚠️ [${userId}] Silent renewal failed - cookies expired:`, error.message);
        return null; // Need full login
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

    // Step 1: Check cache FIRST (instant return if available)
    const cachedData = await getLastJson(userId);
    if (cachedData) {
        const cacheAge = Date.now() - (cachedData.timestamp || 0);
        console.log(`⚡ [${userId}] Returning cached data instantly (${Date.now() - startTime}ms, age: ${cacheAge}ms)`);
        
        // Trigger background refresh (non-blocking, fire-and-forget)
        process.nextTick(() => {
            (async () => {
                try {
                    await fetchAlfaDataInternal(phone, password, adminId, identifier, true);
                } catch (error) {
                    console.warn(`⚠️ [${userId}] Background refresh failed (non-critical):`, error.message);
                }
            })();
        });

        return {
            success: true,
            incremental: false,
            noChanges: false,
            data: cachedData,
            timestamp: Date.now(),
            cached: true,
            duration: Date.now() - startTime
        };
    }

    // Step 2: Check if login is in progress - if so, return cached data or wait
    if (await isLoginInProgress(userId)) {
        console.log(`⏳ [${userId}] Login in progress, checking for stale cache...`);
        
        // Try to get stale cache (even if expired)
        const staleCache = await getLastJson(userId);
        if (staleCache) {
            console.log(`⚡ [${userId}] Returning stale cache while login in progress (${Date.now() - startTime}ms)`);
            return {
                success: true,
                incremental: false,
                noChanges: false,
                data: staleCache,
                timestamp: Date.now(),
                cached: true,
                stale: true,
                duration: Date.now() - startTime
            };
        }
        
        // If no cache, wait for login to complete (with timeout)
        console.log(`⏳ [${userId}] Waiting for login to complete...`);
        const maxWait = 30000; // 30 seconds max wait
        const waitStart = Date.now();
        
        while (await isLoginInProgress(userId) && (Date.now() - waitStart) < maxWait) {
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Check cache again
            const newCache = await getLastJson(userId);
            if (newCache) {
                console.log(`⚡ [${userId}] Got fresh cache after login completed (${Date.now() - startTime}ms)`);
                return {
                    success: true,
                    incremental: false,
                    noChanges: false,
                    data: newCache,
                    timestamp: Date.now(),
                    cached: true,
                    duration: Date.now() - startTime
                };
            }
        }
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

    try {
        // Step 1: Get cookies from Redis (don't login yet - try API calls first)
        let cookies = await getCookies(userId);
        
        // Step 2: Fetch all APIs in parallel IMMEDIATELY (don't wait for login)
        // If no cookies, we'll handle 401 and login then
        let apiData;
        let apiCallStart = Date.now();
        
        if (cookies && cookies.length > 0) {
            console.log(`📡 [${userId}] Found ${cookies.length} cookies, fetching APIs in parallel...`);
            
            try {
                // Fetch all APIs in parallel (this is the key optimization)
                apiData = await fetchAllApis(cookies);
                
                // Check if we got at least one required API
                if (apiData.consumption || apiData.services) {
                    const apiDuration = Date.now() - apiCallStart;
                    const successCount = [apiData.consumption, apiData.services, apiData.expiry].filter(Boolean).length;
                    console.log(`✅ [${userId}] API calls successful (${successCount}/3 APIs in ${apiDuration}ms)`);
                } else {
                    throw new ApiError('No API data received - both consumption and services failed', 'Network');
                }
            } catch (apiError) {
                // If API calls fail (401, timeout, etc.), handle it
                if (apiError.type === 'Unauthorized') {
                    console.log(`⚠️ [${userId}] Cookies expired (401), attempting silent renewal...`);
                    
                    // Try silent renewal first (fast path)
                    const renewedCookies = await trySilentCookieRenewal(cookies, userId);
                    
                    if (renewedCookies) {
                        // Silent renewal successful - retry API calls in parallel
                        try {
                            apiCallStart = Date.now();
                            apiData = await fetchAllApis(renewedCookies);
                            const apiDuration = Date.now() - apiCallStart;
                            console.log(`✅ [${userId}] API calls successful after silent renewal (${apiDuration}ms)`);
                            cookies = renewedCookies;
                        } catch (retryError) {
                            console.log(`⚠️ [${userId}] API calls failed after silent renewal, performing full login...`);
                            // Fall through to full login
                            cookies = null;
                        }
                    } else {
                        // Silent renewal failed - need full login
                        cookies = null;
                    }
                } else {
                    // Non-401 error - throw it (timeout, network, etc.)
                    throw apiError;
                }
            }
        } else {
            console.log(`⚠️ [${userId}] No cookies found, will perform login...`);
        }

        // Step 3: If no cookies or API calls failed, perform login (background if possible)
        if (!cookies || cookies.length === 0 || !apiData) {
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
                apiData = await fetchAllApis(cookies);
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
        const dashboardData = {};

        // Extract from getconsumption
        if (apiData.consumption) {
            const extracted = extractFromGetConsumption(apiData.consumption);
            Object.assign(dashboardData, extracted);
            if (extracted.secondarySubscribers && extracted.secondarySubscribers.length > 0) {
                console.log(`✅ [${userId}] Extracted ${extracted.secondarySubscribers.length} secondary subscribers`);
            }
        }

        // Extract from getmyservices
        if (apiData.services) {
            const extracted = extractFromGetMyServices(apiData.services);
            if (extracted.subscriptionDate) {
                dashboardData.subscriptionDate = extracted.subscriptionDate;
            }
            if (extracted.validityDate) {
                dashboardData.validityDate = extracted.validityDate;
            }
        }

        // Extract expiration
        if (apiData.expiry) {
            dashboardData.expiration = extractExpiration(apiData.expiry);
        }

        // Step 5: Save to Redis cache (non-blocking)
        await saveLastJson(userId, dashboardData);
        await saveLastVerified(userId);

        // Step 6: Save to Firebase (non-blocking, fire-and-forget)
        if (!background) {
            process.nextTick(() => {
                (async () => {
                    try {
                        await updateDashboardData(adminId, dashboardData);
                    } catch (firebaseError) {
                        console.warn(`⚠️ [${userId}] Firebase save skipped (non-critical):`, firebaseError?.message);
                    }
                })();
            });
        }

        const duration = Date.now() - startTime;
        console.log(`✅ [${userId}] API-first refresh completed in ${duration}ms (login: ${loginPerformed ? 'yes' : 'no'})`);

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
        
        console.error(`❌ [${userId}] API-first refresh failed:`, error.message);
        console.error(`Stack:`, error.stack);
        
        // NO FALLBACK TO BROWSER SCRAPING - throw error instead
        throw new Error(`API-first refresh failed: ${error.message}`);
    }
}

module.exports = {
    fetchAlfaData
};
