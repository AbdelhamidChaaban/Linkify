const { fetchAllApis, ApiError, apiRequest } = require('./apiClient');
const { getCookies, getCookiesOrLogin, loginAndSaveCookies, saveCookies, saveLastJson, getLastJson, saveLastVerified, acquireRefreshLock, releaseRefreshLock } = require('./cookieManager');
const { extractFromGetConsumption, extractFromGetMyServices, extractExpiration } = require('./alfaApiDataExtraction');
const { updateDashboardData, getPendingSubscribers, removePendingSubscriber } = require('./firebaseDbService');
const { isLoginInProgress, setLoginInProgress, clearLoginInProgress } = require('./cookieRefreshWorker');
const { refreshCookiesKeepAlive } = require('./pseudoKeepAlive');

const BASE_URL = 'https://www.alfa.com.lb';

// Track active refresh operations per user
const activeRefreshes = new Map();

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

    // Step 1: Check cache FIRST (instant return if available)
    // For manual refresh, return cached data instantly if it exists (even if stale)
    // This prevents unnecessary logins - we'll refresh in background
    const cachedData = await getLastJson(userId, true); // allowStale = true for manual refresh
    if (cachedData && cachedData.data) {
        const cacheAge = Date.now() - (cachedData.timestamp || 0);
        const cacheAgeMinutes = Math.round(cacheAge / 60000);
        
        // Return cached data if it's less than 2 hours old (reasonable for manual refresh)
        // This is the key: manual refresh should be instant, not wait for login
        if (cacheAge < 2 * 60 * 60 * 1000) { // 2 hours
            console.log(`⚡ [${userId}] Returning cached data instantly (${Date.now() - startTime}ms, age: ${cacheAgeMinutes}min)`);
            
            // Trigger background refresh (non-blocking, fire-and-forget)
            // This ensures data is fresh for next time, but doesn't block the user
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
                data: cachedData.data, // Return the actual data, not the wrapper
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

    try {
        // Step 0: Acquire refresh lock for manual refresh (skip for background refreshes)
        if (!background) {
            refreshLockAcquired = await acquireRefreshLock(userId, 300); // 5 minute lock (2-5 min range)
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
                // For manual refresh (!background), use fewer retries for faster response
                const apiOptions = background ? {} : { maxRetries: 1 }; // Manual refresh: 1 retry instead of 2
                apiData = await fetchAllApis(cookies, apiOptions);
                
                // Check if we got at least one required API
                // Allow partial success - if at least one critical API succeeds, proceed
                const hasConsumption = apiData.consumption && Object.keys(apiData.consumption).length > 0;
                const hasServices = apiData.services && Object.keys(apiData.services).length > 0;
                const hasExpiry = apiData.expiry && Object.keys(apiData.expiry).length > 0;
                
                if (hasConsumption || hasServices) {
                    const apiDuration = Date.now() - apiCallStart;
                    const successCount = [hasConsumption, hasServices, hasExpiry].filter(Boolean).length;
                    const missing = [];
                    if (!hasConsumption) missing.push('consumption');
                    if (!hasServices) missing.push('services');
                    if (!hasExpiry) missing.push('expiry');
                    
                    if (missing.length > 0) {
                        console.log(`⚠️ [${userId}] Partial API success (${successCount}/3 APIs in ${apiDuration}ms) - missing: ${missing.join(', ')}`);
                        // Try to use cached data for missing APIs
                        const cachedData = await getLastJson(userId);
                        if (cachedData && cachedData.data) {
                            console.log(`📦 [${userId}] Using cached data to fill missing APIs...`);
                            if (!hasConsumption && cachedData.data.consumption) {
                                apiData.consumption = cachedData.data.consumption;
                                console.log(`✅ [${userId}] Filled consumption from cache`);
                            }
                            if (!hasServices && cachedData.data.services) {
                                apiData.services = cachedData.data.services;
                                console.log(`✅ [${userId}] Filled services from cache`);
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
                    // 401 Unauthorized - cookies expired, need to refresh
                    console.log(`⚠️ [${userId}] Cookies expired (401), attempting silent renewal via keep-alive...`);
                    
                    // Try silent renewal first (fast path) - uses pseudo keep-alive
                    // This works for both background and manual refresh - keep-alive is fast (5s timeout)
                    const renewalResult = await trySilentCookieRenewal(userId);
                    
                    if (renewalResult && renewalResult.success) {
                        // Silent renewal successful - get refreshed cookies and retry API calls
                        cookies = await getCookies(userId);
                        if (cookies && cookies.length > 0) {
                            try {
                                apiCallStart = Date.now();
                                apiData = await fetchAllApis(cookies, { maxRetries: 1 });
                                const apiDuration = Date.now() - apiCallStart;
                                console.log(`✅ [${userId}] API calls successful after keep-alive renewal (${apiDuration}ms)`);
                            } catch (retryError) {
                                console.log(`⚠️ [${userId}] API calls failed after keep-alive renewal, checking cached data...`);
                                // Try cached data before full login
                                const cachedData = await getLastJson(userId, true); // allowStale
                                if (cachedData && cachedData.data) {
                                    const cacheAge = Date.now() - (cachedData.timestamp || 0);
                                    const cacheAgeMinutes = Math.round(cacheAge / 60000);
                                    console.log(`📦 [${userId}] Using cached data (${cacheAgeMinutes}min old) instead of login`);
                                    // Merge with any partial API data that succeeded
                                    apiData = {
                                        consumption: apiData?.consumption || cachedData.data.consumption,
                                        services: apiData?.services || cachedData.data.services,
                                        expiry: apiData?.expiry || cachedData.data.expiry
                                    };
                                } else {
                                    cookies = null; // Fall through to full login
                                }
                            }
                        } else {
                            console.log(`⚠️ [${userId}] No cookies after keep-alive renewal, checking cached data...`);
                            // Try cached data before full login
                            const cachedData = await getLastJson(userId, true); // allowStale
                            if (cachedData && cachedData.data) {
                                const cacheAge = Date.now() - (cachedData.timestamp || 0);
                                const cacheAgeMinutes = Math.round(cacheAge / 60000);
                                console.log(`📦 [${userId}] Using cached data (${cacheAgeMinutes}min old) instead of login`);
                                // Merge with any partial API data that succeeded
                                apiData = {
                                    consumption: apiData?.consumption || cachedData.data.consumption,
                                    services: apiData?.services || cachedData.data.services,
                                    expiry: apiData?.expiry || cachedData.data.expiry
                                };
                            } else {
                                cookies = null; // Fall through to full login
                            }
                        }
                    } else {
                        // Keep-alive failed (302 redirect or timeout) - HYBRID STRATEGY: try cached data before login
                        console.log(`⚠️ [${userId}] Keep-alive failed, checking for cached data before login...`);
                        const cachedData = await getLastJson(userId, true); // allowStale for manual refresh
                        if (cachedData && cachedData.data) {
                            const cacheAge = Date.now() - (cachedData.timestamp || 0);
                            const cacheAgeMinutes = Math.round(cacheAge / 60000);
                            
                            // Use cached data if it's less than 2 hours old (reasonable for manual refresh)
                            if (cacheAge < 2 * 60 * 60 * 1000) {
                                console.log(`📦 [${userId}] Found cached data (${cacheAgeMinutes} minutes old), using it instead of login`);
                                // Merge cached data with any successful API responses (don't overwrite successful ones)
                                apiData = {
                                    consumption: apiData?.consumption || cachedData.data.consumption,
                                    services: apiData?.services || cachedData.data.services,
                                    expiry: apiData?.expiry || cachedData.data.expiry
                                };
                                console.log(`✅ [${userId}] Using cached data (stale: ${cacheAgeMinutes}min) - no login needed`);
                                // Don't set cookies = null, we'll proceed with cached data
                            } else {
                                console.log(`⚠️ [${userId}] Cached data too old (${cacheAgeMinutes}min), will perform login`);
                                cookies = null;
                            }
                        } else {
                            console.log(`⚡ [${userId}] No cached data available, performing full login...`);
                            cookies = null;
                        }
                    }
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
        // Override cached data only if API succeeded
        if (apiData.services) {
            const extracted = extractFromGetMyServices(apiData.services);
            if (extracted.subscriptionDate) {
                dashboardData.subscriptionDate = extracted.subscriptionDate;
                console.log(`✅ [${userId}] Extracted subscriptionDate from API: ${extracted.subscriptionDate}`);
            }
            if (extracted.validityDate) {
                dashboardData.validityDate = extracted.validityDate;
                console.log(`✅ [${userId}] Extracted validityDate from API: ${extracted.validityDate}`);
            }
        } else {
            // API failed - cached data already in dashboardData, but ensure dates are preserved
            console.log(`📦 [${userId}] getmyservices API failed, preserving cached dates`);
            // Dates should already be in dashboardData from cached data, but verify
            if (!dashboardData.subscriptionDate && cachedData && cachedData.data && cachedData.data.subscriptionDate) {
                dashboardData.subscriptionDate = cachedData.data.subscriptionDate;
                console.log(`✅ [${userId}] Preserved cached subscriptionDate: ${dashboardData.subscriptionDate}`);
            }
            if (!dashboardData.validityDate && cachedData && cachedData.data && cachedData.data.validityDate) {
                dashboardData.validityDate = cachedData.data.validityDate;
                console.log(`✅ [${userId}] Preserved cached validityDate: ${dashboardData.validityDate}`);
            }
        }

        // Extract expiration (with fallback to cached data)
        // Override cached data only if API succeeded with valid data
        if (apiData.expiry) {
            const extractedExpiration = extractExpiration(apiData.expiry);
            if (extractedExpiration !== null && extractedExpiration !== undefined && !isNaN(extractedExpiration) && extractedExpiration > 0) {
                dashboardData.expiration = extractedExpiration;
                console.log(`✅ [${userId}] Extracted expiration from API: ${extractedExpiration} days`);
            } else {
                // API returned invalid data (0, null, NaN), preserve cached expiration
                console.log(`⚠️ [${userId}] getexpirydate API returned invalid data, preserving cached expiration`);
                if (dashboardData.expiration === undefined && cachedData && cachedData.data && cachedData.data.expiration) {
                    dashboardData.expiration = cachedData.data.expiration;
                    console.log(`✅ [${userId}] Preserved cached expiration: ${cachedData.data.expiration} days`);
                }
            }
        } else {
            // API failed completely - expiration should already be in dashboardData from cache
            console.log(`📦 [${userId}] getexpirydate API failed, preserving cached expiration`);
            if (dashboardData.expiration === undefined && cachedData && cachedData.data && cachedData.data.expiration) {
                dashboardData.expiration = cachedData.data.expiration;
                console.log(`✅ [${userId}] Preserved cached expiration: ${dashboardData.expiration} days`);
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
        if (!background) {
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

        const duration = Date.now() - startTime;
        console.log(`✅ [${userId}] API-first refresh completed in ${duration}ms (login: ${loginPerformed ? 'yes' : 'no'})`);

        // Release refresh lock after successful refresh
        if (refreshLockAcquired) {
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
        
        // Release refresh lock on error
        if (refreshLockAcquired) {
            await releaseRefreshLock(userId).catch(() => {});
        }
        
        console.error(`❌ [${userId}] API-first refresh failed:`, error.message);
        console.error(`Stack:`, error.stack);
        
        // NO FALLBACK TO BROWSER SCRAPING - throw error instead
        throw new Error(`API-first refresh failed: ${error.message}`);
    }
}

module.exports = {
    fetchAlfaData
};
