const { fetchAllApis, ApiError, apiRequest } = require('./apiClient');
const { getCookies, getCookiesOrLogin, loginAndSaveCookies, saveCookies, saveLastJson, getLastJson, saveLastVerified } = require('./cookieManager');
const { extractFromGetConsumption, extractFromGetMyServices, extractExpiration } = require('./alfaApiDataExtraction');
const { updateDashboardData } = require('./firebaseDbService');

const BASE_URL = 'https://www.alfa.com.lb';

/**
 * Silent cookie renewal - try to refresh cookies by calling /en/account
 * @param {Array} cookies - Current cookies
 * @param {string} userId - User ID
 * @returns {Promise<Array|null>} Fresh cookies or null if renewal failed
 */
async function trySilentCookieRenewal(cookies, userId) {
    try {
        console.log('🔄 Attempting silent cookie renewal...');
        
        // Try to call /en/account with existing cookies
        // If successful, cookies are still valid
        const response = await apiRequest('/en/account', cookies, { timeout: 5000 });
        
        // If we get here, cookies are valid - refresh them
        console.log('✅ Silent renewal successful - cookies are still valid');
        return cookies; // Cookies are still valid
    } catch (error) {
        console.log('⚠️ Silent renewal failed - cookies expired:', error.message);
        return null; // Need full login
    }
}

/**
 * Fetch Alfa dashboard data using API-first approach (NO HTML scraping)
 * @param {string} phone - Phone number
 * @param {string} password - Password
 * @param {string} adminId - Admin document ID
 * @param {string} identifier - User identifier for caching (optional, defaults to adminId)
 * @returns {Promise<Object>} Dashboard data
 */
async function fetchAlfaData(phone, password, adminId, identifier = null) {
    const userId = adminId || phone;
    
    console.log(`🚀 API-first refresh for admin: ${userId}`);
    const startTime = Date.now();

    // Step 1: Check cache (5-second window)
    const cachedData = await getLastJson(userId);
    if (cachedData) {
        console.log(`⚡ Returning cached data (${Date.now() - startTime}ms)`);
        
        // Trigger background refresh (non-blocking)
        process.nextTick(() => {
            (async () => {
                try {
                    await fetchAlfaDataInternal(phone, password, adminId, identifier, true);
                } catch (error) {
                    console.warn('⚠️ Background refresh failed (non-critical):', error.message);
                }
            })();
        });

        return {
            success: true,
            incremental: false,
            noChanges: false,
            data: cachedData,
            timestamp: Date.now(),
            cached: true
        };
    }

    // Step 2: Fetch fresh data
    return await fetchAlfaDataInternal(phone, password, adminId, identifier, false);
}

/**
 * Internal function to fetch data via API only (NO browser scraping)
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

    try {
        // Step 1: Get cookies from Redis (don't login yet - try API calls first)
        let cookies = await getCookies(userId);
        
        // If no cookies, login immediately
        if (!cookies || cookies.length === 0) {
            console.log('⚠️ No cookies found, performing login...');
            cookies = await getCookiesOrLogin(phone, password, userId);
        } else {
            console.log(`✅ Found ${cookies.length} cookies in Redis, trying API calls first...`);
        }

        // Step 2: Fetch all APIs in parallel (try with existing cookies first)
        console.log('📡 Fetching APIs in parallel...');
        let apiData;
        
        try {
            apiData = await fetchAllApis(cookies);
            
            // Check if we got at least one required API (consumption or services)
            // getexpirydate is optional, but consumption or services is required
            if (!apiData.consumption && !apiData.services) {
                // This shouldn't happen if all were 401 (should be caught above)
                // But check if we have any data at all
                throw new ApiError('No API data received - both consumption and services failed', 'Network');
            }

            // Log which APIs succeeded
            const successCount = [apiData.consumption, apiData.services, apiData.expiry].filter(Boolean).length;
            console.log(`✅ API calls successful (${successCount}/3 APIs succeeded in ${Date.now() - startTime}ms)`);
        } catch (apiError) {
            // If API calls fail (401, timeout, etc.), try silent renewal first
            if (apiError.type === 'Unauthorized') {
                console.log('⚠️ Cookies expired (401), attempting silent renewal...');
                
                // Try silent renewal (call /en/account to refresh cookies)
                const renewedCookies = await trySilentCookieRenewal(cookies, userId);
                
                if (renewedCookies) {
                    // Silent renewal successful - retry API calls
                    try {
                        apiData = await fetchAllApis(renewedCookies);
                        console.log(`✅ API calls successful after silent renewal (${Date.now() - startTime}ms)`);
                        cookies = renewedCookies; // Use renewed cookies
                    } catch (retryError) {
                        console.log('⚠️ API calls failed after silent renewal, performing full login...');
                        // Silent renewal didn't work - perform full login (force login, don't use cached cookies)
                        cookies = await loginAndSaveCookies(phone, password, userId);
                        
                        // Retry API calls after full login
                        try {
                            apiData = await fetchAllApis(cookies);
                            console.log(`✅ API calls successful after full login (${Date.now() - startTime}ms)`);
                        } catch (finalError) {
                            console.error('❌ API calls failed after full login:', finalError.message);
                            throw finalError;
                        }
                    }
                } else {
                    // Silent renewal failed - perform full login (force login, don't use cached cookies)
                    console.log('⚠️ Silent renewal failed, performing full login...');
                    cookies = await loginAndSaveCookies(phone, password, userId);
                    
                    // Retry API calls after full login
                    try {
                        apiData = await fetchAllApis(cookies);
                        console.log(`✅ API calls successful after full login (${Date.now() - startTime}ms)`);
                    } catch (finalError) {
                        console.error('❌ API calls failed after full login:', finalError.message);
                        throw finalError;
                    }
                }
            } else {
                // Non-401 error (timeout, network, etc.) - retry once
                console.error(`❌ API calls failed (${apiError.type}):`, apiError.message);
                throw apiError;
            }
        }

        // Step 3: Extract data from API responses
        const dashboardData = {};

        // Extract from getconsumption
        if (apiData.consumption) {
            const extracted = extractFromGetConsumption(apiData.consumption);
            Object.assign(dashboardData, extracted);
            if (extracted.secondarySubscribers && extracted.secondarySubscribers.length > 0) {
                console.log(`✅ Extracted ${extracted.secondarySubscribers.length} secondary subscribers`);
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

        // Step 4: Save to Redis cache
        await saveLastJson(userId, dashboardData);
        await saveLastVerified(userId);

        // Step 5: Save to Firebase (non-blocking)
        if (!background) {
            process.nextTick(() => {
                (async () => {
                    try {
                        await updateDashboardData(adminId, dashboardData);
                    } catch (firebaseError) {
                        console.warn('⚠️ Firebase save skipped (non-critical):', firebaseError?.message);
                    }
                })();
            });
        }

        const duration = Date.now() - startTime;
        console.log(`✅ API-first refresh completed in ${duration}ms`);

        return {
            success: true,
            incremental: false,
            noChanges: false,
            data: dashboardData,
            timestamp: Date.now(),
            duration: duration
        };

    } catch (error) {
        console.error('❌ API-first refresh failed:', error.message);
        console.error('Stack:', error.stack);
        
        // NO FALLBACK TO BROWSER SCRAPING - throw error instead
        throw new Error(`API-first refresh failed: ${error.message}`);
    }
}

module.exports = {
    fetchAlfaData
};
