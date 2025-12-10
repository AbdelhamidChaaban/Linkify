const { fetchAllApis, ApiError, apiRequest } = require('./apiClient');
const { getCookies, getCookiesOrLogin, loginAndSaveCookies, saveCookies, saveLastJson, getLastJson, saveLastVerified, acquireRefreshLock, releaseRefreshLock, getCookieExpiry, areCookiesExpired } = require('./cookieManager');
const { extractFromGetConsumption, extractFromGetMyServices, extractExpiration } = require('./alfaApiDataExtraction');
const { updateDashboardData, getPendingSubscribers, removePendingSubscriber, getFullAdminData, addRemovedActiveSubscriber } = require('./firebaseDbService');
const { isLoginInProgress, setLoginInProgress, clearLoginInProgress } = require('./cookieRefreshWorker');
const { refreshCookiesKeepAlive } = require('./pseudoKeepAlive');
const { getAdminData } = require('./firebaseDbService');
const { fetchUshareHtml } = require('./ushareHtmlParser');

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
 * Fetch all four data sources in parallel (3 APIs + Ushare HTML)
 * @param {string} phone - Admin phone number
 * @param {Array} cookies - Cookie array
 * @param {Object} cachedData - Cached data to use as fallback (optional)
 * @returns {Promise<Object>} Unified data object with all sources
 */
async function fetchAllDataSources(phone, cookies, cachedData = null) {
    const startTime = Date.now();
    const results = {
        expiry: null,
        consumption: null,
        services: null,
        ushare: null,
        _apiSuccess: {},
        _apiErrors: {},
        _ushareSuccess: false,
        _ushareError: null
    };
    
    // Start all 4 sources in parallel
    const expiryPromise = apiRequest('/en/account/getexpirydate', cookies, { timeout: 5000, maxRetries: 0 })
        .then(data => ({ success: true, data, error: null }))
        .catch(error => ({ success: false, data: null, error }));
    
    const consumptionPromise = apiRequest('/en/account/getconsumption', cookies, { timeout: 15000, maxRetries: 1 })
        .then(data => ({ success: true, data, error: null }))
        .catch(error => ({ success: false, data: null, error }));
    
    // CRITICAL: Enforce strict 9-second timeout for getmyservices
    // Use Promise.race to ensure it never takes more than 9 seconds
    const servicesTimeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
            resolve({ success: false, data: null, error: { type: 'Timeout', message: 'Request timeout after 9000ms - using cached data' }, _timedOut: true });
        }, 9000);
    });
    
    const servicesApiPromise = apiRequest('/en/account/manage-services/getmyservices', cookies, { timeout: 10000, maxRetries: 0 })
        .then(data => ({ success: true, data, error: null, _timedOut: false }))
        .catch(error => ({ success: false, data: null, error, _timedOut: false }));
    
    // Race between API call and 9-second timeout - timeout always wins if API takes >9s
    const servicesPromise = Promise.race([servicesApiPromise, servicesTimeoutPromise]);
    
    // OPTIMIZATION: Use cache for Ushare HTML (avoids waiting ~20s)
    // Cache is checked inside fetchUshareHtml, so we can start it in parallel
    // NOTE: Set useCache = false for manual refreshes to ensure fresh data (subscribers can change quickly)
    const usharePromise = fetchUshareHtml(phone, cookies, false) // useCache = false to get fresh data
        .then(result => ({ success: result.success, data: result.data, error: result.error ? new Error(result.error) : null }))
        .catch(error => ({ success: false, data: null, error }));
    
    // Wait for all 3 APIs to complete first (they're fast, ~1-5 seconds)
    const [expiryResult, consumptionResult, servicesResult] = await Promise.allSettled([
        expiryPromise,
        consumptionPromise,
        servicesPromise
    ]);
    
    // Process API results to extract error types
    const expiryError = expiryResult.status === 'fulfilled' ? expiryResult.value.error : expiryResult.reason;
    const consumptionError = consumptionResult.status === 'fulfilled' ? consumptionResult.value.error : consumptionResult.reason;
    const servicesError = servicesResult.status === 'fulfilled' ? servicesResult.value.error : servicesResult.reason;
    
    // CRITICAL: Check if all 3 APIs failed with 401 Unauthorized
    // If so, skip Ushare HTML (don't wait for it) and return immediately to proceed to login
    // Note: All promises are wrapped in .catch() so they always fulfill, never reject
    const expiryFailed = expiryResult.status === 'fulfilled' && !expiryResult.value.success;
    const consumptionFailed = consumptionResult.status === 'fulfilled' && !consumptionResult.value.success;
    const servicesFailed = servicesResult.status === 'fulfilled' && !servicesResult.value.success;
    
    const expiryUnauthorized = expiryFailed && (expiryError?.type === 'Unauthorized' || expiryError?.type === 'Redirect');
    const consumptionUnauthorized = consumptionFailed && (consumptionError?.type === 'Unauthorized' || consumptionError?.type === 'Redirect');
    const servicesUnauthorized = servicesFailed && (servicesError?.type === 'Unauthorized' || servicesError?.type === 'Redirect');
    
    const allApisUnauthorized = expiryUnauthorized && consumptionUnauthorized && servicesUnauthorized;
    
    if (allApisUnauthorized) {
        // All 3 APIs failed with 401 - skip Ushare HTML and return immediately
        // This saves ~22 seconds (Ushare HTML timeout) and allows immediate login
        console.log(`⚡ All 3 APIs returned 401 Unauthorized - skipping Ushare HTML fetch to proceed immediately to login`);
        results._apiSuccess.expiry = false;
        results._apiSuccess.consumption = false;
        results._apiSuccess.services = false;
        results._apiErrors.expiry = expiryError?.type || 'Unauthorized';
        results._apiErrors.consumption = consumptionError?.type || 'Unauthorized';
        results._apiErrors.services = servicesError?.type || 'Unauthorized';
        results._ushareSuccess = false;
        results._ushareError = 'Skipped - all APIs unauthorized';
        
        const totalDuration = Date.now() - startTime;
        console.log(`📊 All sources fetched: 0/3 APIs (all 401), 0/1 HTML (skipped) in ${totalDuration}ms`);
        return results;
    }
    
    // Check if any API indicates expired cookies (even if not all 401)
    // If so, skip Puppeteer for Ushare HTML (it will just redirect to login, wasting time)
    const anyApiUnauthorized = expiryUnauthorized || consumptionUnauthorized || servicesUnauthorized;
    const anyApiTimeout = (expiryFailed && expiryError?.type === 'Timeout') || 
                          (servicesFailed && servicesError?.type === 'Timeout') ||
                          (consumptionFailed && consumptionError?.type === 'Timeout');
    
    // If cookies appear expired (any 401) or all APIs timed out, skip Puppeteer for Ushare HTML
    // HTTP request might still work, but Puppeteer will definitely redirect to login
    if (anyApiUnauthorized) {
        console.log(`⚡ Detected expired cookies (API returned 401) - will skip Puppeteer fallback for Ushare HTML if HTTP fails`);
    }
    
    // Not all APIs failed with 401 - wait for Ushare HTML to complete (or timeout)
    // Wrap in Promise.allSettled to get proper result structure
    const [ushareResultSettled] = await Promise.allSettled([usharePromise]);
    const ushareResult = ushareResultSettled;
    
    // Process getexpirydate
    const expiryStartTime = Date.now();
    if (expiryResult.status === 'fulfilled' && expiryResult.value.success) {
        const duration = Date.now() - expiryStartTime;
        if (duration > 5000) {
            // Took more than 5 seconds - skip and use cached data
            console.log(`⏱️ API getexpirydate took ${duration}ms (>5s), skipping and using cached data`);
            results._apiSuccess.expiry = false;
            results._apiErrors.expiry = 'Timeout';
            // Use cached expiry if available
            if (cachedData && cachedData.data && cachedData.data.expiration !== undefined && cachedData.data.expiration !== null) {
                const cachedExpiration = cachedData.data.expiration;
                if (typeof cachedExpiration === 'number' && !isNaN(cachedExpiration) && cachedExpiration > 0) {
                    // Convert cached expiration (days) to API format (number)
                    results.expiry = cachedExpiration;
                    console.log(`✅ Using cached expiration: ${cachedExpiration} days`);
                }
            }
        } else {
            results.expiry = expiryResult.value.data;
            results._apiSuccess.expiry = true;
            results._apiErrors.expiry = null;
            console.log(`✅ API getexpirydate succeeded (${duration}ms)`);
        }
    } else {
        const error = expiryResult.status === 'fulfilled' ? expiryResult.value.error : expiryResult.reason;
        results._apiSuccess.expiry = false;
        results._apiErrors.expiry = error?.type || 'Unknown';
        const duration = Date.now() - expiryStartTime;
        
        if (error?.type === 'Timeout' || duration > 5000) {
            console.log(`⏱️ API getexpirydate timed out (>5s), using cached data`);
        } else {
            console.log(`❌ API getexpirydate failed: ${error?.type || 'Unknown'} (${duration}ms)`);
        }
        
        // Use cached expiry if available (for timeout or other errors)
        if (cachedData && cachedData.data && cachedData.data.expiration !== undefined && cachedData.data.expiration !== null) {
            const cachedExpiration = cachedData.data.expiration;
            if (typeof cachedExpiration === 'number' && !isNaN(cachedExpiration) && cachedExpiration > 0) {
                results.expiry = cachedExpiration;
                console.log(`✅ Using cached expiration after API failure: ${cachedExpiration} days`);
            }
        }
    }
    
    // Process getconsumption
    const consumptionStartTime = Date.now();
    if (consumptionResult.status === 'fulfilled' && consumptionResult.value.success) {
        results.consumption = consumptionResult.value.data;
        results._apiSuccess.consumption = true;
        results._apiErrors.consumption = null;
        const duration = Date.now() - consumptionStartTime;
        console.log(`✅ API getconsumption succeeded (${duration}ms)`);
    } else {
        const error = consumptionResult.status === 'fulfilled' ? consumptionResult.value.error : consumptionResult.reason;
        results._apiSuccess.consumption = false;
        results._apiErrors.consumption = error?.type || 'Unknown';
        const duration = Date.now() - consumptionStartTime;
        console.log(`❌ API getconsumption failed: ${error?.type || 'Unknown'} (${duration}ms)`);
        
        // Retry once if not Unauthorized
        if (error?.type !== 'Unauthorized' && error?.type !== 'Redirect') {
            try {
                const retryStart = Date.now();
                const retryData = await apiRequest('/en/account/getconsumption', cookies, { timeout: 15000, maxRetries: 0 });
                results.consumption = retryData;
                results._apiSuccess.consumption = true;
                results._apiErrors.consumption = null;
                const retryDuration = Date.now() - retryStart;
                console.log(`✅ API getconsumption retry succeeded (${retryDuration}ms)`);
            } catch (retryError) {
                results._apiErrors.consumption = retryError?.type || 'Unknown';
                console.log(`❌ API getconsumption retry failed: ${retryError?.type || 'Unknown'}`);
            }
        }
    }
    
    // Process getmyservices
    // CRITICAL: Check if Promise.race timeout won (9-second timeout)
    if (servicesResult.status === 'fulfilled' && servicesResult.value._timedOut) {
        // Timeout won - API took more than 9 seconds
        const cacheAge = cachedData && cachedData.timestamp ? Math.round((Date.now() - cachedData.timestamp) / 60000) : 'unknown';
        const cacheTime = cachedData && cachedData.timestamp ? new Date(cachedData.timestamp).toLocaleTimeString() : 'unknown';
        console.log(`⏱️ API getmyservices timed out (>9s), using cached data from ${cacheTime} (${cacheAge}min ago)`);
        results._apiSuccess.services = false;
        results._apiErrors.services = 'Timeout';
        // Use cached services if available (raw API response)
        if (cachedData && cachedData.data && cachedData.data.services) {
            results.services = cachedData.data.services;
            console.log(`✅ Using cached services API response`);
        } else {
            // If no raw services, we'll use extracted dates from dashboardData later in data extraction
            console.log(`⚠️ No cached services API response, will use extracted dates from dashboardData`);
        }
    } else if (servicesResult.status === 'fulfilled' && servicesResult.value.success) {
        // API succeeded within 9 seconds - use the data
        results.services = servicesResult.value.data;
        results._apiSuccess.services = true;
        results._apiErrors.services = null;
        console.log(`✅ API getmyservices succeeded`);
    } else {
        // API failed (not timeout, but other error)
        const error = servicesResult.status === 'fulfilled' ? servicesResult.value.error : servicesResult.reason;
        results._apiSuccess.services = false;
        results._apiErrors.services = error?.type || 'Unknown';
        
        const cacheAge = cachedData && cachedData.timestamp ? Math.round((Date.now() - cachedData.timestamp) / 60000) : 'unknown';
        const cacheTime = cachedData && cachedData.timestamp ? new Date(cachedData.timestamp).toLocaleTimeString() : 'unknown';
        console.log(`❌ API getmyservices failed: ${error?.type || 'Unknown'}, using cached data from ${cacheTime} (${cacheAge}min ago)`);
        
        // Use cached services if available (for timeout or other errors)
        // Check for raw services API response in cache
        if (cachedData && cachedData.data && cachedData.data.services) {
            results.services = cachedData.data.services;
            console.log(`✅ Using cached services API response after API failure`);
        } else {
            // If no raw services, we'll use extracted dates from dashboardData later in data extraction
            console.log(`⚠️ No cached services API response, will use extracted dates from dashboardData`);
        }
    }
    
    // Process Ushare HTML
    const ushareStartTime = Date.now();
    // ushareResult is now from Promise.allSettled, so it has .status and .value/.reason
    if (ushareResult.status === 'fulfilled' && ushareResult.value && ushareResult.value.success) {
        results.ushare = ushareResult.value.data;
        results._ushareSuccess = true;
        results._ushareError = null;
        const duration = Date.now() - ushareStartTime;
        const subscriberCount = results.ushare?.totalCount || 0;
        const activeCount = results.ushare?.activeCount || 0;
        const requestedCount = results.ushare?.requestedCount || 0;
        console.log(`✅ Ushare HTML parsed successfully: ${subscriberCount} subscribers (${activeCount} Active, ${requestedCount} Requested) (${duration}ms)`);
    } else {
        const error = ushareResult.status === 'fulfilled' ? (ushareResult.value?.error || ushareResult.value) : ushareResult.reason;
        results._ushareSuccess = false;
        results._ushareError = error?.message || error?.toString() || 'Unknown error';
        const duration = Date.now() - ushareStartTime;
        console.log(`❌ Ushare HTML fetch failed: ${results._ushareError} (${duration}ms)`);
        
        // Skip retry if both HTTP and Puppeteer already failed (retry would just waste more time)
        // Only retry if it was a quick timeout that might succeed on retry
        const isQuickTimeout = duration < 5000; // If first attempt failed quickly (<5s), might be transient
        const isNavigationTimeout = error?.message?.includes('Navigation timeout');
        const isHttpTimeout = error?.message?.includes('HTTP request timeout');
        
        // Only retry if:
        // 1. It was a quick failure (might be transient network issue)
        // 2. OR it was a Puppeteer navigation timeout (HTTP might work on retry)
        // Skip retry if HTTP already timed out (15s) - retrying would just waste more time
        if (isQuickTimeout || (isNavigationTimeout && !isHttpTimeout)) {
            console.log(`🔄 Retrying Ushare HTML fetch (quick failure or navigation timeout - HTTP might work)...`);
            try {
                const retryStart = Date.now();
                // Force HTTP-only retry (skip Puppeteer if HTTP already tried)
                const retryResult = await fetchUshareHtml(phone, cookies, false); // Don't use cache on retry
                const retryDuration = Date.now() - retryStart;
                if (retryResult.success && retryResult.data) {
                    results.ushare = retryResult.data;
                    results._ushareSuccess = true;
                    results._ushareError = null;
                    const subscriberCount = results.ushare?.totalCount || 0;
                    const activeCount = results.ushare?.activeCount || 0;
                    const requestedCount = results.ushare?.requestedCount || 0;
                    const totalUshareTime = duration + retryDuration;
                    console.log(`✅ Ushare HTML retry succeeded: ${subscriberCount} subscribers (${activeCount} Active, ${requestedCount} Requested) (${retryDuration}ms)`);
                    console.log(`   ⏱️ Total Ushare HTML time: ${totalUshareTime}ms (first attempt: ${duration}ms, retry: ${retryDuration}ms)`);
                } else {
                    console.log(`❌ Ushare HTML retry failed: ${retryResult.error || 'Unknown error'} (${retryDuration}ms) - skipping further retries`);
                }
            } catch (retryError) {
                const retryDuration = Date.now() - retryStart;
                console.log(`❌ Ushare HTML retry failed: ${retryError.message || 'Unknown error'} (${retryDuration}ms) - skipping further retries`);
            }
        } else {
            console.log(`⏭️ Skipping Ushare HTML retry (already tried both HTTP and Puppeteer, would waste time)`);
        }
    }
    
    const totalDuration = Date.now() - startTime;
    const successCount = [results._apiSuccess.expiry, results._apiSuccess.consumption, results._apiSuccess.services].filter(Boolean).length;
    console.log(`📊 All sources fetched: ${successCount}/3 APIs, ${results._ushareSuccess ? '1' : '0'}/1 HTML in ${totalDuration}ms`);
    
    return results;
}

/**
 * Retry failed APIs with longer timeout (20s)
 * Only retries APIs that failed (not ones that succeeded or returned 401)
 * CRITICAL: Skip redundant retries for getmyservices and getexpirydate - use cached data instead
 * @param {Array} cookies - Cookie array
 * @param {Object} previousApiData - Previous API results with _apiErrors
 * @param {Object} cachedData - Cached data to use as fallback (optional)
 * @returns {Promise<Object>} Updated API data with retried results
 */
async function retryFailedApisWithLongTimeout(cookies, previousApiData, cachedData = null) {
    const endpoints = [
        { key: 'expiry', path: '/en/account/getexpirydate', timeout: 20000, skipRetry: true }, // Skip retry, use cached
        { key: 'services', path: '/en/account/manage-services/getmyservices', timeout: 20000, skipRetry: true }, // Skip retry, use cached
        { key: 'consumption', path: '/en/account/getconsumption', timeout: 20000, skipRetry: false } // Allow retry
    ];
    
    const retryPromises = [];
    const apiErrors = previousApiData._apiErrors || {};
    const apiSuccess = previousApiData._apiSuccess || {};
    
    // Only retry APIs that failed (not Unauthorized - those need login, not successful ones)
    endpoints.forEach(endpoint => {
        const error = apiErrors[endpoint.key];
        const hasData = previousApiData[endpoint.key] && Object.keys(previousApiData[endpoint.key] || {}).length > 0;
        
        // Skip redundant retries for getmyservices and getexpirydate - use cached data instead
        if (endpoint.skipRetry && !hasData && !apiSuccess[endpoint.key] && error && error !== 'Unauthorized' && error !== 'Redirect') {
            console.log(`⏭️ Skipped redundant ${endpoint.key} retry, using cached data`);
            // Use cached data if available
            if (cachedData && cachedData.data) {
                if (endpoint.key === 'expiry' && cachedData.data.expiration !== undefined && cachedData.data.expiration !== null) {
                    const cachedExpiration = cachedData.data.expiration;
                    if (typeof cachedExpiration === 'number' && !isNaN(cachedExpiration) && cachedExpiration > 0) {
                        previousApiData.expiry = cachedExpiration;
                        console.log(`✅ Using cached expiration: ${cachedExpiration} days`);
                    }
                } else if (endpoint.key === 'services' && cachedData.data.services) {
                    previousApiData.services = cachedData.data.services;
                    console.log(`✅ Using cached services API response`);
                }
            }
            return; // Skip retry
        }
        
        // Retry if failed and not Unauthorized (timeout/network errors) and not skipped
        if (!hasData && !apiSuccess[endpoint.key] && error && error !== 'Unauthorized' && error !== 'Redirect' && !endpoint.skipRetry) {
            retryPromises.push(
                apiRequest(endpoint.path, cookies, { timeout: endpoint.timeout, maxRetries: 0 })
                    .then(data => ({ key: endpoint.key, data, success: true }))
                    .catch(error => ({ key: endpoint.key, error, success: false }))
            );
        }
    });
    
    if (retryPromises.length === 0) {
        return previousApiData; // Nothing to retry
    }
    
    console.log(`🔄 Retrying ${retryPromises.length} failed API(s) with 20s timeout...`);
    const retryResults = await Promise.allSettled(retryPromises);
    
    // Update previousApiData with retry results
    const updatedApiData = { ...previousApiData };
    updatedApiData._apiSuccess = { ...previousApiData._apiSuccess };
    updatedApiData._apiErrors = { ...previousApiData._apiErrors };
    
    retryResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.success) {
            updatedApiData[result.value.key] = result.value.data;
            updatedApiData._apiSuccess[result.value.key] = true;
            updatedApiData._apiErrors[result.value.key] = null;
            console.log(`✅ API ${result.value.key} retry succeeded`);
        } else {
            const error = result.status === 'fulfilled' ? result.value.error : result.reason;
            updatedApiData._apiErrors[result.value.key] = error?.type || 'Unknown';
            console.log(`❌ API ${result.value.key} retry failed: ${error?.type || 'Unknown'}`);
        }
    });
    
    return updatedApiData;
}

/**
 * Retry only failed APIs after login (don't re-run successful ones)
 * @param {Array} cookies - Fresh cookies after login
 * @param {Object} previousApiData - Previous API results
 * @returns {Promise<Object>} Updated API data with retried results
 */
async function retryOnlyFailedApis(cookies, previousApiData) {
    const endpoints = [
        { key: 'expiry', path: '/en/account/getexpirydate', timeout: 6000 },
        { key: 'services', path: '/en/account/manage-services/getmyservices', timeout: 20000 },
        { key: 'consumption', path: '/en/account/getconsumption', timeout: 15000 }
    ];
    
    const retryPromises = [];
    const apiSuccess = previousApiData._apiSuccess || {};
    
    // Only retry APIs that failed (don't re-run successful ones)
    endpoints.forEach(endpoint => {
        if (!apiSuccess[endpoint.key]) {
            retryPromises.push(
                apiRequest(endpoint.path, cookies, { timeout: endpoint.timeout, maxRetries: 0 })
                    .then(data => ({ key: endpoint.key, data, success: true }))
                    .catch(error => ({ key: endpoint.key, error, success: false }))
            );
        }
    });
    
    if (retryPromises.length === 0) {
        return previousApiData; // All APIs already succeeded
    }
    
    console.log(`🔄 Retrying ${retryPromises.length} failed API(s) after login...`);
    const retryResults = await Promise.allSettled(retryPromises);
    
    // Update previousApiData with retry results
    const updatedApiData = { ...previousApiData };
    updatedApiData._apiSuccess = { ...previousApiData._apiSuccess };
    updatedApiData._apiErrors = { ...previousApiData._apiErrors };
    
    retryResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.success) {
            updatedApiData[result.value.key] = result.value.data;
            updatedApiData._apiSuccess[result.value.key] = true;
            updatedApiData._apiErrors[result.value.key] = null;
            console.log(`✅ API ${result.value.key} succeeded after login`);
        } else {
            const error = result.status === 'fulfilled' ? result.value.error : result.reason;
            updatedApiData._apiErrors[result.value.key] = error?.type || 'Unknown';
            console.log(`❌ API ${result.value.key} still failed after login: ${error?.type || 'Unknown'}`);
        }
    });
    
    return updatedApiData;
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
            // Reduced logging for background refreshes - only log if there's an issue
        }
        // Step 0: Acquire refresh lock for manual refresh (skip for background refreshes)
        if (!background) {
            // CRITICAL: Use longer lock (5 minutes) to prevent concurrent logins
            // Login can take 10-30 seconds, and we want to prevent other requests from starting login
            refreshLockAcquired = await acquireRefreshLock(userId, 300); // 5 minute lock to prevent concurrent logins
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
            // ========== MANUAL REFRESH START ==========
            console.log(`\n${'='.repeat(80)}`);
            console.log(`🔄 MANUAL REFRESH STARTED for ${userId} at ${new Date().toISOString()}`);
            console.log(`${'='.repeat(80)}\n`);
            
            // Step 1: Get cookies from Redis and check if they need proactive keep-alive
            let cookies = await getCookies(userId);
            const cookieExpiry = await getCookieExpiry(userId);
            const now = Date.now();
            
            // PROACTIVE KEEP-ALIVE: If cookies are about to expire (within 30 minutes), extend them NOW
            // This prevents the "cookies expired" scenario and ensures keep-alive does its job
            // BUT: Skip keep-alive if cookies expire in < 5 minutes (too risky, just let APIs fail and do login)
            if (cookieExpiry && cookies && cookies.length > 0) {
                const timeUntilExpiry = cookieExpiry - now;
                const thirtyMinutes = 30 * 60 * 1000; // 30 minutes in milliseconds
                const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds
                
                if (timeUntilExpiry > fiveMinutes && timeUntilExpiry <= thirtyMinutes) {
                    // Cookies expire in 5-30 minutes - proactively extend them (but with short timeout)
                    console.log(`🔔 [${userId}] Cookies expire in ${Math.round(timeUntilExpiry / 60000)} minutes - proactively extending via keep-alive...`);
                    
                    // Add short timeout to keep-alive (max 5 seconds) - don't let it block refresh
                    const keepAlivePromise = trySilentCookieRenewal(userId);
                    const timeoutPromise = new Promise((resolve) => {
                        setTimeout(() => {
                            resolve({ success: false, needsRefresh: false, timeout: true });
                        }, 5000); // 5 second timeout (reduced from 10s)
                    });
                    
                    const keepAliveResult = await Promise.race([keepAlivePromise, timeoutPromise]);
                    
                    if (keepAliveResult.timeout) {
                        console.log(`⚠️ [${userId}] Proactive keep-alive timed out after 5s, continuing with refresh (won't block)`);
                    } else if (keepAliveResult && keepAliveResult.success) {
                        // Keep-alive succeeded - get fresh cookies and expiry
                        cookies = await getCookies(userId);
                        const newExpiry = await getCookieExpiry(userId);
                        const newTimeUntilExpiry = newExpiry ? newExpiry - Date.now() : null;
                        console.log(`✅ [${userId}] Proactive keep-alive succeeded, cookies extended${newTimeUntilExpiry ? ` (new expiry: ${Math.round(newTimeUntilExpiry / 60000)} minutes)` : ''}`);
                    } else {
                        // Keep-alive failed - cookies might be expired, but continue anyway
                        // The API calls will fail and trigger login if needed
                        console.log(`⚠️ [${userId}] Proactive keep-alive failed, but continuing with existing cookies (APIs will determine if login needed)`);
                    }
                } else if (timeUntilExpiry <= fiveMinutes) {
                    // Cookies expire in < 5 minutes - skip keep-alive, let APIs fail and do login immediately
                    console.log(`⚠️ [${userId}] Cookies expire in ${Math.round(timeUntilExpiry / 60000)} minutes (< 5 min), skipping keep-alive (will login if APIs fail)`);
                } else if (timeUntilExpiry > thirtyMinutes) {
                    // Cookies are still fresh (>30 minutes) - no need for keep-alive
                    console.log(`✅ [${userId}] Cookies are fresh (expire in ${Math.round(timeUntilExpiry / 60000)} minutes), no keep-alive needed`);
                }
            }
            
            // Step 2: Fetch all four sources in parallel
            let refreshStart = Date.now();
            const hasAccountCookie = cookies && cookies.some(c => c.name === '__ACCOUNT');
            
            if (cookies && cookies.length > 0) {
                // Check Redis expiry - if still valid, don't mark as expired prematurely
                const expiryFromRedis = cookieExpiry && cookieExpiry <= now;
                if (!expiryFromRedis) {
                    if (hasAccountCookie) {
                        console.log(`📡 [${userId}] Using cached __ACCOUNT cookie, fetching all sources...`);
                    } else {
                        console.log(`📡 [${userId}] Using cached cookies, fetching all sources...`);
                    }
                    
                    try {
                        // Get cached data first to use as fallback for slow APIs
                        const cachedDataForFallback = await getLastJson(userId, true);
                        
                        // Fetch all four sources in parallel (3 APIs + Ushare HTML)
                        apiData = await fetchAllDataSources(phone, cookies, cachedDataForFallback);
                        
                        // Check if all three APIs returned 401/302 (need login)
                        const apiErrors = apiData._apiErrors || {};
                        const allUnauthorized = apiErrors.consumption === 'Unauthorized' && 
                                               apiErrors.services === 'Unauthorized' && 
                                               apiErrors.expiry === 'Unauthorized';
                        
                        if (allUnauthorized) {
                            // All APIs returned 401 - cookies expired, will try keep-alive/login
                            console.log(`⚠️ [${userId}] All APIs returned 401, will try keep-alive...`);
                            // Fall through to keep-alive/login
                        } else {
                            // At least one API succeeded or failed with timeout/network error
                            // Proceed with available data (some sources may have failed, but we have partial data)
                            const refreshDuration = Date.now() - refreshStart;
                            console.log(`✅ [${userId}] Manual refresh succeeded with cached __ACCOUNT (${refreshDuration}ms)`);
                            
                            // Release lock quickly
                            if (refreshLockAcquired) {
                                await releaseRefreshLock(userId).catch(() => {});
                                refreshLockAcquired = false;
                            }
                            
                            // Continue to data extraction
                        }
                    } catch (apiError) {
                        // fetchAllDataSources failed completely
                        if (apiError.type === 'Unauthorized' || apiError.response?.status === 401) {
                            console.log(`⚠️ [${userId}] All APIs returned 401, will try keep-alive...`);
                            // Fall through to keep-alive
                        } else {
                            // Other error - use cached data if available
                            console.log(`⚠️ [${userId}] Error fetching sources (${apiError.type || apiError.message}), using cached data`);
                            const cachedData = await getLastJson(userId, true);
                            if (cachedData && cachedData.data) {
                                if (refreshLockAcquired) {
                                    await releaseRefreshLock(userId).catch(() => {});
                                    refreshLockAcquired = false;
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
                    // Redis expiry says expired - but try all sources first anyway (might still work)
                    console.log(`⚠️ [${userId}] Redis expiry indicates expired, but trying all sources first...`);
                    try {
                        // Get cached data first to use as fallback for slow APIs
                        const cachedDataForFallback = await getLastJson(userId, true);
                        apiData = await fetchAllDataSources(phone, cookies, cachedDataForFallback);
                        
                        // Check if all three APIs returned 401
                        const apiErrors = apiData._apiErrors || {};
                        const allUnauthorized = apiErrors.consumption === 'Unauthorized' && 
                                               apiErrors.services === 'Unauthorized' && 
                                               apiErrors.expiry === 'Unauthorized';
                        
                        if (allUnauthorized) {
                            console.log(`⚠️ [${userId}] All APIs returned 401, will try keep-alive...`);
                        } else {
                            // At least one source succeeded - proceed
                            const refreshDuration = Date.now() - refreshStart;
                            console.log(`✅ [${userId}] Manual refresh succeeded with cached __ACCOUNT (${refreshDuration}ms)`);
                            if (refreshLockAcquired) {
                                await releaseRefreshLock(userId).catch(() => {});
                                refreshLockAcquired = false;
                            }
                            // Continue to data extraction
                        }
                    } catch (apiError) {
                        console.log(`⚠️ [${userId}] Sources failed (${apiError.type || apiError.message}), will try keep-alive...`);
                    }
                }
            } else {
                // No cookies - must login
                console.log(`⚠️ [${userId}] No cookies found, will perform login...`);
            }
            
            // Step 3: If all APIs returned 401/302, try keep-alive then login
            const hasConsumption = apiData && apiData.consumption && Object.keys(apiData.consumption || {}).length > 0;
            const hasServices = apiData && apiData.services && Object.keys(apiData.services || {}).length > 0;
            const hasExpiry = apiData && apiData.expiry !== null && apiData.expiry !== undefined;
            const hasAnyData = hasConsumption || hasServices || hasExpiry;
            
            if (!hasAnyData && cookies && cookies.length > 0) {
                const apiErrors = apiData?._apiErrors || {};
                const allUnauthorized = apiErrors.consumption === 'Unauthorized' && 
                                       apiErrors.services === 'Unauthorized' && 
                                       apiErrors.expiry === 'Unauthorized';
                
                if (allUnauthorized) {
                    // All APIs returned 401 - try keep-alive first
                    console.log(`🔄 [${userId}] Trying keep-alive...`);
                    const keepAliveResult = await trySilentCookieRenewal(userId);
                    
                    if (keepAliveResult && keepAliveResult.success) {
                        // Keep-alive succeeded - retry all sources
                        console.log(`✅ [${userId}] Keep-alive succeeded, retrying all sources...`);
                        cookies = await getCookies(userId);
                        refreshStart = Date.now();
                        try {
                            // Get cached data first to use as fallback for slow APIs
                            const cachedDataForFallback = await getLastJson(userId, true);
                            apiData = await fetchAllDataSources(phone, cookies, cachedDataForFallback);
                            
                            // Check if still all 401
                            const apiErrors = apiData._apiErrors || {};
                            const stillAllUnauthorized = apiErrors.consumption === 'Unauthorized' && 
                                                       apiErrors.services === 'Unauthorized' && 
                                                       apiErrors.expiry === 'Unauthorized';
                            
                            if (!stillAllUnauthorized) {
                                const refreshDuration = Date.now() - refreshStart;
                                console.log(`✅ [${userId}] Manual refresh succeeded with cached __ACCOUNT (${refreshDuration}ms)`);
                                
                                if (refreshLockAcquired) {
                                    await releaseRefreshLock(userId).catch(() => {});
                                    refreshLockAcquired = false;
                                }
                            } else {
                                // Still all 401 - fall through to login
                                console.log(`⚠️ [${userId}] All APIs still returned 401 after keep-alive, will perform login...`);
                            }
                        } catch (retryError) {
                            console.log(`⚠️ [${userId}] Sources still failed after keep-alive, will perform login...`);
                        }
                    } else {
                        // Keep-alive failed - fall through to login
                        console.log(`⚠️ [${userId}] Keep-alive failed, will perform login...`);
                    }
                }
            }
            
            // Step 4: If still no data AND all APIs returned 401/302, perform full login
            const stillHasConsumption = apiData && apiData.consumption && Object.keys(apiData.consumption || {}).length > 0;
            const stillHasServices = apiData && apiData.services && Object.keys(apiData.services || {}).length > 0;
            const stillHasExpiry = apiData && apiData.expiry !== null && apiData.expiry !== undefined;
            const stillHasAnyData = stillHasConsumption || stillHasServices || stillHasExpiry;
            
            if (!stillHasAnyData) {
                const apiErrors = apiData?._apiErrors || {};
                const stillAllUnauthorized = apiErrors.consumption === 'Unauthorized' && 
                                           apiErrors.services === 'Unauthorized' && 
                                           apiErrors.expiry === 'Unauthorized';
                
                if (stillAllUnauthorized) {
                    console.log(`🔐 [${userId}] Manual refresh required login`);
                    
                    // Get admin credentials from Firebase
                    const adminData = await getAdminData(userId);
                    if (!adminData || !adminData.phone || !adminData.password) {
                        throw new Error('Admin not found or missing credentials for auto-login');
                    }
                    
                    // Perform full login - use cookies returned directly
                    const loginCookies = await loginAndSaveCookies(adminData.phone, adminData.password, userId);
                    if (loginCookies && loginCookies.length > 0) {
                        cookies = loginCookies;
                        loginPerformed = true;
                        console.log(`✅ [${userId}] Full login successful, using ${cookies.length} cookies from login`);
                    } else {
                        // Fallback: Try to retrieve from Redis
                        cookies = await getCookies(userId);
                        if (!cookies || cookies.length === 0) {
                            throw new Error('Cookies not found after login - login may have failed or Redis is not available');
                        }
                        loginPerformed = true;
                        console.log(`✅ [${userId}] Full login successful, retrieved ${cookies.length} cookies from Redis (fallback)`);
                    }
                    
                    // Retry all sources after login
                    refreshStart = Date.now();
                    // Get cached data first to use as fallback for slow APIs
                    const cachedDataForFallback = await getLastJson(userId, true);
                    apiData = await fetchAllDataSources(phone, cookies, cachedDataForFallback);
                    const refreshDuration = Date.now() - refreshStart;
                    
                    const finalHasConsumption = apiData.consumption && Object.keys(apiData.consumption || {}).length > 0;
                    const finalHasServices = apiData.services && Object.keys(apiData.services || {}).length > 0;
                    const finalHasExpiry = apiData.expiry !== null && apiData.expiry !== undefined;
                    const finalHasUshare = apiData.ushare && apiData.ushare.totalCount !== undefined;
                    
                    if (finalHasConsumption || finalHasServices || finalHasExpiry || finalHasUshare) {
                        console.log(`✅ [${userId}] Login completed, sources succeeded (${refreshDuration}ms)`);
                    } else {
                        console.log(`⚠️ [${userId}] Login completed but sources still failed (${refreshDuration}ms)`);
                    }
                    
                    // Release lock quickly
                    if (refreshLockAcquired) {
                        await releaseRefreshLock(userId).catch(() => {});
                        refreshLockAcquired = false;
                    }
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
                    // loginAndSaveCookies returns cookies directly - use them!
                    const loginCookies = await loginAndSaveCookies(adminData.phone, adminData.password, userId);
                    if (loginCookies && loginCookies.length > 0) {
                        cookies = loginCookies;
                        loginPerformed = true;
                        console.log(`✅ [${userId}] Auto-login successful, got ${cookies.length} cookies from login`);
                    } else {
                        // Fallback: Try to retrieve from Redis
                        cookies = await getCookies(userId);
                        if (!cookies || cookies.length === 0) {
                            throw new Error('Cookies not found after auto-login - login may have failed or Redis is not available');
                        }
                        loginPerformed = true;
                        console.log(`✅ [${userId}] Auto-login successful, retrieved ${cookies.length} cookies from Redis (fallback)`);
                    }
                } catch (loginError) {
                    console.error(`❌ [${userId}] Auto-login failed:`, loginError.message);
                    throw new Error(`Auto-login failed: ${loginError.message}`);
                }
            }
            
            // Step 4: Fetch all four sources in parallel IMMEDIATELY (with fresh cookies if login was performed)
            let refreshStart = Date.now();
            
            if (cookies && cookies.length > 0) {
                console.log(`📡 [${userId}] Found ${cookies.length} cookies, fetching all sources in parallel...`);
                
                try {
                    // Get cached data first to use as fallback for slow APIs
                    const cachedDataForFallback = await getLastJson(userId);
                    
                    // Fetch all four sources in parallel (3 APIs + Ushare HTML)
                    apiData = await fetchAllDataSources(phone, cookies, cachedDataForFallback);
                    
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
                    
                    // Retry all sources with fresh cookies
                    refreshStart = Date.now();
                    // Get cached data first to use as fallback for slow APIs
                    const cachedDataForFallback = await getLastJson(userId);
                    apiData = await fetchAllDataSources(phone, cookies, cachedDataForFallback);
                    const refreshDuration = Date.now() - refreshStart;
                    console.log(`✅ [${userId}] Sources successful after auto-login (${refreshDuration}ms)`);
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
                // loginAndSaveCookies returns the cookies directly - use them!
                // This avoids dependency on Redis being immediately available after login
                const loginCookies = await loginAndSaveCookies(phone, password, userId);
                loginPerformed = true;
                const loginDuration = Date.now() - loginStart;
                console.log(`✅ [${userId}] Login completed in ${loginDuration}ms`);
                
                // Use cookies returned directly from login (they're already saved to Redis if available)
                // Fallback to retrieving from Redis if login didn't return cookies (shouldn't happen)
                if (loginCookies && loginCookies.length > 0) {
                    cookies = loginCookies;
                    console.log(`✅ [${userId}] Using ${cookies.length} cookies from login (already saved to Redis if available)`);
                } else {
                    // Fallback: Try to retrieve from Redis (in case Redis save succeeded but return failed)
                    console.log(`⚠️ [${userId}] Login didn't return cookies, trying to retrieve from Redis...`);
                    cookies = await getCookies(userId);
                    if (!cookies || cookies.length === 0) {
                        throw new Error('Cookies not found after login - login may have failed or Redis is not available');
                    }
                    console.log(`✅ [${userId}] Retrieved ${cookies.length} cookies from Redis (fallback)`);
                }
                
                // Now fetch all sources in parallel with fresh cookies
                refreshStart = Date.now();
                // Get cached data first to use as fallback for slow APIs
                const cachedDataForFallback = await getLastJson(userId);
                const apiCallStart = Date.now(); // Track API call start time for duration calculation
                apiData = await fetchAllDataSources(phone, cookies, cachedDataForFallback);
                
                // Extract ushare HTML data from apiData (fetchAllDataSources already includes it)
                let ushareData = apiData.ushare || null;
                
                // If ushare data is missing or failed, only retry if it was a quick failure
                // Don't retry if both HTTP and Puppeteer already timed out (would waste time)
                if (!ushareData || !apiData._ushareSuccess) {
                    const error = apiData._ushareError || 'Unknown error';
                    const errorMessage = error?.message || error?.toString() || 'Unknown error';
                    console.log(`⚠️ [${userId}] Ushare HTML fetch failed: ${errorMessage}`);
                    
                    // Only retry if it was a quick failure (might be transient)
                    // Skip retry if HTTP already timed out (15s) - retrying would waste more time
                    const isQuickFailure = errorMessage.includes('Navigation timeout') && !errorMessage.includes('HTTP request timeout');
                    
                    if (isQuickFailure) {
                        console.log(`🔄 [${userId}] Retrying Ushare HTML fetch (quick failure - might succeed on retry)...`);
                        try {
                            const retryResult = await fetchUshareHtml(phone, cookies, false); // Don't use cache
                            if (retryResult.success && retryResult.data) {
                                ushareData = retryResult.data;
                                apiData.ushare = ushareData; // Update apiData with retry result
                                console.log(`✅ [${userId}] Ushare HTML retry succeeded: ${ushareData.totalCount} subscribers (${ushareData.activeCount} Active, ${ushareData.requestedCount} Requested)`);
                            } else {
                                console.log(`⚠️ [${userId}] Ushare HTML retry also failed: ${retryResult.error || 'Unknown error'} - using cached data if available`);
                            }
                        } catch (retryError) {
                            console.log(`⚠️ [${userId}] Ushare HTML retry error: ${retryError.message || 'Unknown error'} - using cached data if available`);
                        }
                    } else {
                        console.log(`⏭️ [${userId}] Skipping Ushare HTML retry (already tried both methods, would waste time) - using cached data if available`);
                    }
                } else {
                    console.log(`✅ [${userId}] Ushare HTML parsed: ${ushareData.totalCount} subscribers (${ushareData.activeCount} Active, ${ushareData.requestedCount} Requested)`);
                }
                
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
        
        // CRITICAL: Always try to get last known data from Firebase for expiration/dates fallback
        // This ensures we have expiration/dates even if Redis cache is empty or expired
        let firebaseData = null;
        try {
            firebaseData = await getAdminData(userId);
            // CRITICAL: Only use Firebase expiration if it's valid (> 0, not 0)
            if (firebaseData && firebaseData.expiration) {
                if (firebaseData.expiration > 0 && !isNaN(firebaseData.expiration)) {
                    console.log(`📦 [${userId}] Retrieved expiration from Firebase: ${firebaseData.expiration} days`);
                } else {
                    // Firebase has invalid expiration (0 or NaN) - ignore it
                    console.log(`⚠️ [${userId}] Firebase has invalid expiration (${firebaseData.expiration}), ignoring it`);
                    firebaseData.expiration = null; // Clear invalid expiration
                }
            }
        } catch (error) {
            console.warn(`⚠️ [${userId}] Failed to get Firebase data for expiration/dates fallback:`, error.message);
        }
        
        // CRITICAL: Initialize dashboardData from cache, but NEVER copy expiration if it's 0 or invalid
        // This prevents expiration from being set to 0 in the first place
        // Also ensure dates are preserved if they're valid
        const dashboardData = {};
        if (cachedData && cachedData.data) {
            // Copy all fields EXCEPT expiration if it's invalid
            for (const key in cachedData.data) {
                if (key === 'expiration') {
                    // Only copy expiration if it's valid (> 0, not NaN)
                    const expiration = cachedData.data.expiration;
                    if (typeof expiration === 'number' && !isNaN(expiration) && expiration > 0) {
                        dashboardData.expiration = expiration;
                    } else {
                        console.log(`⚠️ [${userId}] Skipping invalid expiration (${expiration}) from cached data initialization`);
                    }
                } else {
                    // Copy all other fields, including subscriptionDate and validityDate
                    dashboardData[key] = cachedData.data[key];
                }
            }
            
            // Log what dates we have from cache
            if (dashboardData.subscriptionDate || dashboardData.validityDate) {
                console.log(`📦 [${userId}] Initialized dates from cache: subscriptionDate=${dashboardData.subscriptionDate || 'none'}, validityDate=${dashboardData.validityDate || 'none'}`);
            }
        }
        
        // CRITICAL: If no cached expiration but Firebase has one, use it
        if ((!dashboardData.expiration || dashboardData.expiration === undefined || dashboardData.expiration === null) && firebaseData && firebaseData.expiration && firebaseData.expiration > 0) {
            dashboardData.expiration = firebaseData.expiration;
            console.log(`✅ [${userId}] Initialized expiration from Firebase: ${firebaseData.expiration} days`);
        }
        
        // CRITICAL: Filter out invalid dates (NaN) immediately when initializing from cache
        // This prevents displaying NaN/NaN/NaN when API fails
        if (dashboardData.subscriptionDate && (dashboardData.subscriptionDate.includes('NaN') || dashboardData.subscriptionDate === 'NaN/NaN/NaN')) {
            console.log(`⚠️ [${userId}] Removing invalid subscriptionDate from cached data (NaN)`);
            delete dashboardData.subscriptionDate;
        }
        if (dashboardData.validityDate && (dashboardData.validityDate.includes('NaN') || dashboardData.validityDate === 'NaN/NaN/NaN')) {
            console.log(`⚠️ [${userId}] Removing invalid validityDate from cached data (NaN)`);
            delete dashboardData.validityDate;
        }
        
        const cachedFieldsCount = Object.keys(dashboardData).length;
        console.log(`📦 [${userId}] Starting with cached data: ${cachedFieldsCount} fields`);
        if (cachedFieldsCount === 0) {
            console.log(`⚠️ [${userId}] WARNING: Cached data is empty (0 fields) - will rely on Firebase for expiration fallback`);
        }

        // Extract from getconsumption (override cached data only if API succeeded)
        // CRITICAL: primaryData is required for status determination - must be preserved at all costs
        if (apiData.consumption) {
            const extracted = extractFromGetConsumption(apiData.consumption);
            // Merge extracted data (overrides cached data for these fields)
            // CRITICAL: Don't overwrite with null/undefined values - preserve existing if extracted is null
            if (extracted.primaryData) {
                dashboardData.primaryData = extracted.primaryData;
            }
            if (extracted.balance) {
                dashboardData.balance = extracted.balance;
            }
            if (extracted.totalConsumption) {
                dashboardData.totalConsumption = extracted.totalConsumption;
                console.log(`✅ [${userId}] Set totalConsumption from API: ${extracted.totalConsumption}`);
            } else {
                console.warn(`⚠️ [${userId}] WARNING: extracted.totalConsumption is missing! extracted object keys:`, Object.keys(extracted));
            }
            if (extracted.adminConsumption) {
                dashboardData.adminConsumption = extracted.adminConsumption;
            }
            if (extracted.secondarySubscribers && extracted.secondarySubscribers.length > 0) {
                dashboardData.secondarySubscribers = extracted.secondarySubscribers;
                console.log(`✅ [${userId}] Extracted ${extracted.secondarySubscribers.length} secondary subscribers from API`);
            }
            // Also set subscribersCount if not already set from ushare HTML
            if (!dashboardData.subscribersCount && extracted.subscribersCount) {
                dashboardData.subscribersCount = extracted.subscribersCount;
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
                if (!dashboardData.subscribersCount && extracted.subscribersCount) {
                    dashboardData.subscribersCount = extracted.subscribersCount;
                    // If ushare HTML failed, set activeCount = totalCount (all are active) and requestedCount = 0
                    if (!dashboardData.subscribersActiveCount) {
                        dashboardData.subscribersActiveCount = extracted.subscribersCount;
                    }
                    if (!dashboardData.subscribersRequestedCount) {
                        dashboardData.subscribersRequestedCount = 0;
                    }
                }
            } else if (dashboardData.primaryData) {
                // primaryData exists in cached dashboardData, keep it
                console.log(`✅ [${userId}] Preserved existing primaryData from cached dashboardData`);
            } else {
                // No cached consumption data at all - this is a problem
                console.error(`❌ [${userId}] CRITICAL: No cached consumption data available - admin may become inactive!`);
            }
        }
        
        // CRITICAL: Override subscriber data from ushare HTML page (more accurate than getconsumption)
        // This gives us Active vs Requested status and accurate consumption per subscriber
        // ALWAYS use Ushare HTML data when available (even if 0 subscribers) - it's the source of truth
        if (apiData.ushare) {
            // Ushare HTML was fetched (successfully or returned empty)
            if (apiData.ushare.subscribers && apiData.ushare.subscribers.length > 0) {
                console.log(`\n🎯 [${userId}] ✅ USING USHARE HTML PAGE DATA (NOT getconsumption API)`);
                console.log(`   📊 Subscribers: ${apiData.ushare.totalCount} total (${apiData.ushare.activeCount} Active, ${apiData.ushare.requestedCount} Requested)`);
                
                // Update subscribers count with Active/Requested breakdown
                dashboardData.subscribersCount = apiData.ushare.totalCount;
                dashboardData.subscribersActiveCount = apiData.ushare.activeCount;
                dashboardData.subscribersRequestedCount = apiData.ushare.requestedCount;
                
                // Convert ushare subscribers to secondarySubscribers format
                // Keep consumption in GB (don't convert to MB) since frontend expects GB
                const secondarySubscribers = apiData.ushare.subscribers.map(sub => {
                    return {
                        phoneNumber: sub.phoneNumber,
                        fullPhoneNumber: sub.fullPhoneNumber,
                        consumption: sub.usedConsumption, // In GB (from data-val)
                        consumptionUnit: 'GB',
                        quota: sub.totalQuota, // In GB (from data-quota)
                        quotaUnit: 'GB',
                        status: sub.status, // 'Active' or 'Requested'
                        consumptionText: sub.consumptionText // "0.48 / 30 GB"
                    };
                });
                
                dashboardData.secondarySubscribers = secondarySubscribers;
                console.log(`   ✅ Updated ${secondarySubscribers.length} subscribers from ushare HTML page\n`);
                
                // DETECT SUBSCRIBERS REMOVED DIRECTLY FROM ALFA WEBSITE
                // Compare current subscribers with previous ones to find missing Active subscribers
                const previousAdminData = await getFullAdminData(adminId);
                const previousSecondarySubscribers = previousAdminData?.alfaData?.secondarySubscribers || [];
                
                if (previousSecondarySubscribers.length > 0) {
                    const currentPhoneNumbers = new Set(secondarySubscribers.map(sub => sub.phoneNumber));
                    const removedActiveSubscribers = [];
                    
                    previousSecondarySubscribers.forEach(prevSub => {
                        // Only check Active subscribers (Requested subscribers disappear naturally)
                        if (prevSub.status === 'Active' && !currentPhoneNumbers.has(prevSub.phoneNumber)) {
                            // This Active subscriber was in the previous list but is now missing
                            // It was removed directly from Alfa website
                            removedActiveSubscribers.push({
                                phoneNumber: prevSub.phoneNumber,
                                fullPhoneNumber: prevSub.fullPhoneNumber || prevSub.phoneNumber,
                                consumption: prevSub.consumption || 0,
                                limit: prevSub.quota || prevSub.limit || 0
                            });
                        }
                    });
                    
                    // Add removed Active subscribers to Firebase (so they show as "Out" in view details)
                    if (removedActiveSubscribers.length > 0) {
                        console.log(`   🔍 Detected ${removedActiveSubscribers.length} Active subscriber(s) removed directly from Alfa website:`);
                        for (const removedSub of removedActiveSubscribers) {
                            console.log(`      ➖ ${removedSub.phoneNumber} (was Active, now missing from HTML)`);
                            await addRemovedActiveSubscriber(adminId, removedSub).catch(error => {
                                console.error(`      ❌ Failed to add removed subscriber ${removedSub.phoneNumber}:`, error.message);
                            });
                        }
                    }
                }
            } else {
                // Ushare HTML returned 0 subscribers (valid - admin may have removed all subscribers)
                console.log(`\n🎯 [${userId}] ✅ USING USHARE HTML PAGE DATA: 0 subscribers (all removed)`);
                dashboardData.subscribersCount = 0;
                dashboardData.subscribersActiveCount = 0;
                dashboardData.subscribersRequestedCount = 0;
                dashboardData.secondarySubscribers = [];
                console.log(`   ✅ Updated subscriber counts from ushare HTML page: 0 total (0 Active, 0 Requested)\n`);
                
                // DETECT SUBSCRIBERS REMOVED DIRECTLY FROM ALFA WEBSITE
                // If all subscribers are gone, check if there were Active subscribers before
                const previousAdminData = await getFullAdminData(adminId);
                const previousSecondarySubscribers = previousAdminData?.alfaData?.secondarySubscribers || [];
                
                if (previousSecondarySubscribers.length > 0) {
                    const removedActiveSubscribers = [];
                    
                    previousSecondarySubscribers.forEach(prevSub => {
                        // Only check Active subscribers (Requested subscribers disappear naturally)
                        if (prevSub.status === 'Active') {
                            removedActiveSubscribers.push({
                                phoneNumber: prevSub.phoneNumber,
                                fullPhoneNumber: prevSub.fullPhoneNumber || prevSub.phoneNumber,
                                consumption: prevSub.consumption || 0,
                                limit: prevSub.quota || prevSub.limit || 0
                            });
                        }
                    });
                    
                    // Add all removed Active subscribers to Firebase
                    if (removedActiveSubscribers.length > 0) {
                        console.log(`   🔍 Detected ${removedActiveSubscribers.length} Active subscriber(s) removed directly from Alfa website (all subscribers removed):`);
                        for (const removedSub of removedActiveSubscribers) {
                            console.log(`      ➖ ${removedSub.phoneNumber} (was Active, now missing from HTML)`);
                            await addRemovedActiveSubscriber(adminId, removedSub).catch(error => {
                                console.error(`      ❌ Failed to add removed subscriber ${removedSub.phoneNumber}:`, error.message);
                            });
                        }
                    }
                }
            }
        } else {
            // Ushare HTML fetch completely failed - DO NOT use stale data from getconsumption
            // Only use getconsumption data if we have no other option, but warn about it
            console.log(`\n⚠️ [${userId}] ⚠️ USHARE HTML FETCH FAILED - Cannot determine accurate subscriber counts`);
            console.log(`   ⚠️ Subscriber counts may be stale if changes were made directly on Alfa website`);
            console.log(`   ⚠️ Falling back to getconsumption API data (may not reflect recent changes)\n`);
            
            // Only use getconsumption data if we don't have any subscriber data at all
            // But don't override if we already have counts (they might be from a previous successful Ushare HTML fetch)
            if (!dashboardData.subscribersCount && !dashboardData.subscribersActiveCount && !dashboardData.subscribersRequestedCount) {
                // No subscriber data at all - use getconsumption as last resort
                if (dashboardData.subscribersCount && (!dashboardData.subscribersActiveCount || dashboardData.subscribersActiveCount === undefined)) {
                    // Assume all subscribers are active if we can't determine from ushare HTML
                    dashboardData.subscribersActiveCount = dashboardData.subscribersCount;
                    dashboardData.subscribersRequestedCount = 0;
                    if (!background) {
                        console.log(`📊 [${userId}] Set default counts from getconsumption: activeCount=${dashboardData.subscribersActiveCount}, requestedCount=0 (ushare HTML unavailable)`);
                    }
                }
            } else {
                // We have some subscriber data - keep it but warn
                if (!background) {
                    console.log(`⚠️ [${userId}] Keeping existing subscriber counts (may be stale): ${dashboardData.subscribersCount || 0} total`);
                }
            }
        }

        // Extract from getmyservices (CRITICAL: Subscription Date and Validity Date)
        // CRITICAL: If API failed or returned invalid data, ALWAYS use cached dates
        let apiServicesFailed = !apiData.services || 
                                  apiData.services === null || 
                                  apiData.services === undefined ||
                                  (typeof apiData.services === 'object' && Object.keys(apiData.services).length === 0);
        
        if (!apiServicesFailed) {
            // API returned something - try to extract dates
            console.log(`🔍 [${userId}] Extracting dates from getmyservices API response...`);
            const extracted = extractFromGetMyServices(apiData.services);
            console.log(`🔍 [${userId}] Extraction result: subscriptionDate=${extracted.subscriptionDate || 'null'}, validityDate=${extracted.validityDate || 'null'}`);
            
            let hasValidDates = false;
            
            // Only set dates if they are valid (not null, not undefined, not empty, not NaN)
            if (extracted.subscriptionDate && typeof extracted.subscriptionDate === 'string' && extracted.subscriptionDate.trim() && !extracted.subscriptionDate.includes('NaN')) {
                dashboardData.subscriptionDate = extracted.subscriptionDate;
                console.log(`✅ [${userId}] Extracted subscriptionDate from API: ${extracted.subscriptionDate}`);
                hasValidDates = true;
            } else {
                console.log(`⚠️ [${userId}] subscriptionDate extraction failed: ${extracted.subscriptionDate || 'null/empty'}`);
            }
            
            if (extracted.validityDate && typeof extracted.validityDate === 'string' && extracted.validityDate.trim() && !extracted.validityDate.includes('NaN')) {
                dashboardData.validityDate = extracted.validityDate;
                console.log(`✅ [${userId}] Extracted validityDate from API: ${extracted.validityDate}`);
                hasValidDates = true;
            } else {
                console.log(`⚠️ [${userId}] validityDate extraction failed: ${extracted.validityDate || 'null/empty'}`);
            }
            
            // If API returned invalid dates, treat as failed and use cached
            if (!hasValidDates) {
                if (extracted.subscriptionDate || extracted.validityDate) {
                    console.log(`⚠️ [${userId}] getmyservices API returned invalid dates (subscriptionDate: ${extracted.subscriptionDate || 'null'}, validityDate: ${extracted.validityDate || 'null'}), using cached dates`);
                } else {
                    console.log(`⚠️ [${userId}] getmyservices API returned no dates (both null), using cached dates`);
                }
                apiServicesFailed = true; // Treat as failed to use cached data
            }
        }
        
        // If API failed or returned invalid data, preserve existing dates (NEVER delete valid dates)
        if (apiServicesFailed) {
            console.log(`📦 [${userId}] getmyservices API failed or returned invalid data (timeout >9s or any failure), using cached dates`);
            
            // CRITICAL: When API fails, ALWAYS preserve existing dates from dashboardData
            // dashboardData was already initialized from cachedData.data, so dates should already be there
            // NEVER delete dates unless they're invalid (NaN or empty)
            
            // Helper function to get cached date with age logging
            const getCachedDate = (dateType) => {
                // First try Redis cache
                if (cachedData && cachedData.data && cachedData.data[dateType]) {
                    const cachedDate = cachedData.data[dateType];
                    if (typeof cachedDate === 'string' && cachedDate.trim() && !cachedDate.includes('NaN')) {
                        const cacheAge = cachedData.timestamp ? Math.round((Date.now() - cachedData.timestamp) / 60000) : 'unknown';
                        const cacheDate = cachedData.timestamp ? new Date(cachedData.timestamp).toISOString().split('T')[0] : 'unknown';
                        console.log(`✅ [${userId}] Using cached ${dateType} from Redis: ${cachedDate} (cached ${cacheAge}min ago, ${cacheDate})`);
                        return cachedDate;
                    }
                }
                
                // Then try Firestore cached dates with timestamps
                if (firebaseData && firebaseData._cachedDates && firebaseData._cachedDates[dateType]) {
                    const cached = firebaseData._cachedDates[dateType];
                    if (cached.value && typeof cached.value === 'string' && cached.value.trim() && !cached.value.includes('NaN')) {
                        const cacheAge = cached.timestamp ? Math.round((Date.now() - cached.timestamp) / 60000) : 'unknown';
                        const cacheDate = cached.date || (cached.timestamp ? new Date(cached.timestamp).toISOString().split('T')[0] : 'unknown');
                        console.log(`✅ [${userId}] Using cached ${dateType} from Firestore: ${cached.value} (cached ${cacheAge}min ago, ${cacheDate})`);
                        return cached.value;
                    }
                }
                
                return null;
            };
            
            // Check subscriptionDate - only remove if invalid, otherwise keep existing or get from cache
            if (dashboardData.subscriptionDate) {
                if (dashboardData.subscriptionDate.includes('NaN') || !dashboardData.subscriptionDate.trim()) {
                    // Invalid date - remove it and try to get from cache
                    delete dashboardData.subscriptionDate;
                    console.log(`⚠️ [${userId}] Removed invalid subscriptionDate (NaN or empty)`);
                    const cachedSubDate = getCachedDate('subscriptionDate');
                    if (cachedSubDate) {
                        dashboardData.subscriptionDate = cachedSubDate;
                    }
                } else {
                    // Valid date - keep it
                    console.log(`✅ [${userId}] Preserving existing subscriptionDate: ${dashboardData.subscriptionDate}`);
                }
            } else {
                // No subscriptionDate in dashboardData - try to get from cache
                const cachedSubDate = getCachedDate('subscriptionDate');
                if (cachedSubDate) {
                    dashboardData.subscriptionDate = cachedSubDate;
                } else {
                    console.log(`⚠️ [${userId}] No cached subscriptionDate available`);
                }
            }
            
            // Check validityDate - only remove if invalid, otherwise keep existing or get from cache
            if (dashboardData.validityDate) {
                if (dashboardData.validityDate.includes('NaN') || !dashboardData.validityDate.trim()) {
                    // Invalid date - remove it and try to get from cache
                    delete dashboardData.validityDate;
                    console.log(`⚠️ [${userId}] Removed invalid validityDate (NaN or empty)`);
                    const cachedValDate = getCachedDate('validityDate');
                    if (cachedValDate) {
                        dashboardData.validityDate = cachedValDate;
                    }
                } else {
                    // Valid date - keep it
                    console.log(`✅ [${userId}] Preserving existing validityDate: ${dashboardData.validityDate}`);
                }
            } else {
                // No validityDate in dashboardData - try to get from cache
                const cachedValDate = getCachedDate('validityDate');
                if (cachedValDate) {
                    dashboardData.validityDate = cachedValDate;
                } else {
                    console.log(`⚠️ [${userId}] No cached validityDate available`);
                }
            }
        }

        // Extract expiration (with fallback to cached data)
        // CRITICAL: Never display 0 - always preserve last valid expiration from cache
        // CRITICAL: getexpirydate API can return null (failed), 0 (invalid), or a number (valid)
        // CRITICAL: If API failed or returned invalid data, ALWAYS use cached expiration
        let apiExpiryFailed = !apiData.expiry || 
                                 apiData.expiry === null || 
                                 apiData.expiry === undefined ||
                                 (typeof apiData.expiry === 'number' && (apiData.expiry === 0 || isNaN(apiData.expiry))) ||
                                 (typeof apiData.expiry === 'object' && Object.keys(apiData.expiry).length === 0);
        
        if (!apiExpiryFailed) {
            // API returned something that might be valid - try to extract
            const extractedExpiration = extractExpiration(apiData.expiry);
            if (extractedExpiration !== null && extractedExpiration !== undefined && !isNaN(extractedExpiration) && extractedExpiration > 0) {
                // Valid expiration from API
                dashboardData.expiration = extractedExpiration;
                console.log(`✅ [${userId}] Extracted expiration from API: ${extractedExpiration} days`);
            } else {
                // API returned invalid data (0, null, NaN, or empty object) - use cached
                console.log(`⚠️ [${userId}] getexpirydate API returned invalid data (${apiData.expiry}), using cached expiration`);
                apiExpiryFailed = true; // Treat as failed to use cached data
            }
        }
        
        // If API failed or returned invalid data, use cached expiration
        if (apiExpiryFailed) {
            console.log(`📦 [${userId}] getexpirydate API failed or returned invalid data, using cached expiration`);
            
            // Helper function to get cached expiration with age logging
            const getCachedExpiration = () => {
                // First try Redis cache
                if (cachedData && cachedData.data && cachedData.data.expiration !== undefined && cachedData.data.expiration !== null) {
                    const cachedExpiration = cachedData.data.expiration;
                    // Validate cached expiration is valid (> 0, not NaN, not 0)
                    if (typeof cachedExpiration === 'number' && !isNaN(cachedExpiration) && cachedExpiration > 0) {
                        const cacheAge = cachedData.timestamp ? Math.round((Date.now() - cachedData.timestamp) / 60000) : 'unknown';
                        const cacheDate = cachedData.timestamp ? new Date(cachedData.timestamp).toISOString().split('T')[0] : 'unknown';
                        console.log(`✅ [${userId}] Using cached expiration from Redis: ${cachedExpiration} days (cached ${cacheAge}min ago, ${cacheDate})`);
                        return cachedExpiration;
                    }
                }
                
                // Then try Firestore cached expiration with timestamp
                if (firebaseData && firebaseData._cachedExpiration) {
                    const cached = firebaseData._cachedExpiration;
                    if (cached.value && typeof cached.value === 'number' && !isNaN(cached.value) && cached.value > 0) {
                        const cacheAge = cached.timestamp ? Math.round((Date.now() - cached.timestamp) / 60000) : 'unknown';
                        const cacheDate = cached.date || (cached.timestamp ? new Date(cached.timestamp).toISOString().split('T')[0] : 'unknown');
                        console.log(`✅ [${userId}] Using cached expiration from Firestore: ${cached.value} days (cached ${cacheAge}min ago, ${cacheDate})`);
                        return cached.value;
                    }
                }
                
                // Fallback to old Firebase expiration field (backward compatibility)
                if (firebaseData && firebaseData.expiration && firebaseData.expiration > 0) {
                    console.log(`✅ [${userId}] Using expiration from Firebase (legacy field): ${firebaseData.expiration} days`);
                    return firebaseData.expiration;
                }
                
                return null;
            };
            
            // CRITICAL: Always use cached expiration when API fails
            const cachedExpiration = getCachedExpiration();
            if (cachedExpiration) {
                dashboardData.expiration = cachedExpiration;
            } else {
                // No valid expiration anywhere - ensure it's undefined, not 0
                console.log(`⚠️ [${userId}] No cached expiration available anywhere, expiration will be missing (not 0)`);
                delete dashboardData.expiration; // Always delete to ensure it's undefined, not 0
            }
        }
        
        // CRITICAL: Final validation - ensure expiration is NEVER 0, null, undefined, or NaN
        // This is the last line of defense - if expiration is 0, delete it
        if (dashboardData.expiration !== undefined && dashboardData.expiration !== null) {
            if (dashboardData.expiration === 0 || isNaN(dashboardData.expiration) || (typeof dashboardData.expiration === 'number' && dashboardData.expiration <= 0)) {
                console.log(`⚠️ [${userId}] Final validation: Invalid expiration detected (${dashboardData.expiration}), removing it`);
                delete dashboardData.expiration;
            }
        }
        
        // CRITICAL: Double-check - if expiration is still 0 after all processing, force delete
        if (dashboardData.expiration === 0) {
            console.log(`❌ [${userId}] CRITICAL: Expiration is still 0 after all processing, forcing deletion`);
            delete dashboardData.expiration;
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
            const criticalFields = ['balance', 'totalConsumption', 'adminConsumption', 'secondarySubscribers', 'subscribersCount', 'subscribersActiveCount', 'subscribersRequestedCount'];
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

        // FINAL CLEANUP: Remove any invalid dates before saving (CRITICAL: prevent NaN/NaN/NaN in Firebase)
        if (dashboardData.subscriptionDate && (dashboardData.subscriptionDate.includes('NaN') || dashboardData.subscriptionDate === 'NaN/NaN/NaN')) {
            console.log(`⚠️ [${userId}] FINAL CLEANUP: Removing invalid subscriptionDate before save`);
            delete dashboardData.subscriptionDate;
        }
        if (dashboardData.validityDate && (dashboardData.validityDate.includes('NaN') || dashboardData.validityDate === 'NaN/NaN/NaN')) {
            console.log(`⚠️ [${userId}] FINAL CLEANUP: Removing invalid validityDate before save`);
            delete dashboardData.validityDate;
        }
        
        // Step 5: Log unified summary of refresh
        const expiryStatus = dashboardData.expiration !== undefined && dashboardData.expiration !== null ? `${dashboardData.expiration} days` : 'failed';
        const consumptionStatus = dashboardData.totalConsumption !== undefined ? `${dashboardData.totalConsumption} GB` : 'failed';
        const validityStatus = dashboardData.validityDate || 'failed';
        const subscriptionStatus = dashboardData.subscriptionDate || 'failed';
        const subscribersCount = dashboardData.subscribersCount !== undefined ? dashboardData.subscribersCount : 'failed';
        console.log(`📊 Refresh completed: expiry=${expiryStatus}, consumption=${consumptionStatus}, validity=${validityStatus}, subscription=${subscriptionStatus}, subscribers=${subscribersCount}`);

        // Step 6: Save to Redis cache (non-blocking)
        // CRITICAL: Also store raw API responses for timeout fallback
        // CRITICAL: NEVER save expiration = 0 to cache - if it's 0, don't include it
        const dataToCache = { ...dashboardData };
        
        // Remove expiration if it's 0 or invalid before saving to cache
        if (dataToCache.expiration === 0 || isNaN(dataToCache.expiration) || (typeof dataToCache.expiration === 'number' && dataToCache.expiration <= 0)) {
            delete dataToCache.expiration;
            console.log(`⚠️ [${userId}] Removed invalid expiration (${dataToCache.expiration}) before saving to cache`);
        }
        
        // Store raw API responses if available (for timeout fallback)
        dataToCache.services = apiData.services || (cachedData && cachedData.data && cachedData.data.services) || null;
        dataToCache.expiry = apiData.expiry !== null && apiData.expiry !== undefined ? apiData.expiry : (cachedData && cachedData.data && cachedData.data.expiry !== undefined ? cachedData.data.expiry : null);
        dataToCache.consumption = apiData.consumption || (cachedData && cachedData.data && cachedData.data.consumption) || null;
        
        await saveLastJson(userId, dataToCache);
        await saveLastVerified(userId);

        // Step 7: Save to Firebase (non-blocking, fire-and-forget)
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
        
        // Add completion marker for manual refresh (only for manual, not background)
        if (!background) {
            console.log(`✅ [${userId}] API-first refresh completed in ${duration}ms (login: ${loginPerformed ? 'yes' : 'no'})`);
            console.log(`\n${'='.repeat(80)}`);
            console.log(`✅ MANUAL REFRESH COMPLETED for ${userId} in ${duration}ms`);
            console.log(`${'='.repeat(80)}\n`);
        }

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
