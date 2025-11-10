const browserPool = require('./browserPool');
const cacheLayer = require('./cacheLayer');
const { loginToAlfa, delay, AEFA_DASHBOARD_URL } = require('./alfaLogin');
const { setupApiCapture, waitForApiEndpoints, fetchApiDirectly } = require('./alfaApiCapture');
const { extractConsumptionCircles, extractBalanceFromHtml, extractTotalConsumptionFromHtml } = require('./alfaDataExtraction');
const { extractFromGetConsumption, extractFromGetMyServices, extractExpiration, buildAdminConsumption } = require('./alfaApiDataExtraction');
const { updateDashboardData } = require('./firebaseDbService');

/**
 * Fetch Alfa dashboard data for an admin
 * Always performs fresh scrape, but uses Redis to cache intermediate structures for performance
 * @param {string} phone - Phone number
 * @param {string} password - Password
 * @param {string} adminId - Admin document ID
 * @param {string} identifier - User identifier for caching (optional, defaults to adminId)
 * @returns {Promise<Object>} Dashboard data
 */
async function fetchAlfaData(phone, password, adminId, identifier = null) {
    const cacheIdentifier = identifier || adminId || phone;
    console.log(`🚀 Creating browser context for admin: ${adminId || phone}`);
    
    let context = null;
    let page = null;
    
    try {
        // Get a new isolated browser context from the pool
        const contextData = await browserPool.createContext();
        context = contextData.context;
        page = contextData.page;
        
        // IMPORTANT: Check for session BEFORE setting up request interception
        // This ensures session is injected before any navigation
        const { getSession } = require('./sessionManager');
        const savedSession = await getSession(adminId || phone);
        
        if (savedSession && savedSession.cookies && savedSession.cookies.length > 0) {
            console.log('🔑 Injecting session cookies before navigation...');
            try {
                await page.setCookie(...savedSession.cookies);
                console.log(`✅ Injected ${savedSession.cookies.length} cookies from Redis session`);
            } catch (cookieError) {
                console.warn('⚠️ Error injecting cookies, will login:', cookieError.message);
            }
        }
        
        // Page is already configured by browserPool, but we can add request interception here

        // Block unnecessary resources to speed up loading
        // Only block during dashboard navigation, not during login
        const blockState = { enabled: false };
        
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = request.url();
            const resourceType = request.resourceType();
            const method = request.method();
            
            // Only block resources after login (during dashboard navigation)
            if (!blockState.enabled) {
                request.continue();
                return;
            }
            
            // CRITICAL: Allow essential API endpoints (NEVER block these)
            if (url.includes('/en/account/getconsumption') ||
                url.includes('/en/account/manage-services/getmyservices') ||
                url.includes('/en/account/getexpirydate') ||
                url.includes('/en/account/getlastrecharge')) {
                request.continue();
                return;
            }
            
            // CRITICAL: Allow the main dashboard page
            if (url === 'https://www.alfa.com.lb/en/account' || 
                url === 'https://www.alfa.com.lb/en/account/') {
                request.continue();
                return;
            }
            
            // Block ALL analytics and tracking
            if (url.includes('google-analytics.com') || 
                url.includes('googletagmanager.com') ||
                url.includes('facebook.com/tr') ||
                url.includes('facebook.com/privacy_sandbox') ||
                url.includes('facebook.net') ||
                url.includes('connect.facebook.net') ||
                url.includes('doubleclick.net') ||
                url.includes('googleadservices.com') ||
                url.includes('analytics') ||
                url.includes('gtm') ||
                url.includes('tracking')) {
                request.abort();
                return;
            }
            
            // Block ALL images (except data URLs)
            if (resourceType === 'image' || 
                url.includes('.png') || 
                url.includes('.jpg') || 
                url.includes('.jpeg') || 
                url.includes('.gif') || 
                url.includes('.svg') || 
                url.includes('.webp') ||
                url.includes('/Images/') ||
                url.includes('/images/')) {
                if (!url.startsWith('data:')) {
                    request.abort();
                    return;
                }
            }
            
            // Block ALL fonts
            if (resourceType === 'font' || 
                url.includes('fonts.googleapis.com') || 
                url.includes('fonts.gstatic.com') ||
                url.includes('.woff') ||
                url.includes('.woff2') ||
                url.includes('.ttf') ||
                url.includes('.eot')) {
                request.abort();
                return;
            }
            
            // Block ALL stylesheets
            if (resourceType === 'stylesheet' || 
                url.includes('.css') ||
                url.includes('/css/') ||
                url.includes('/content/css/')) {
                request.abort();
                return;
            }
            
            // Block non-essential scripts, but allow scripts needed for rendering circles
            if (resourceType === 'script') {
                // Block webchat, chatbot, jqueryval, and external scripts
                if (url.includes('webchat') || 
                    url.includes('chatbot') ||
                    url.includes('jqueryval') ||
                    url.includes('bundles/') ||
                    !url.includes('alfa.com.lb')) {
                    request.abort();
                    return;
                }
                // Allow scripts from alfa.com.lb that might be needed for rendering circles
                // We need to allow scripts during the rendering phase
                if (url.includes('/content/scripts/')) {
                    // Allow scripts during rendering phase (after login)
                    request.continue();
                    return;
                }
                // Allow other alfa.com.lb scripts
                request.continue();
                return;
            }
            
            // Allow XHR and fetch requests ONLY for essential API endpoints
            if (resourceType === 'xhr' || resourceType === 'fetch') {
                // Only allow essential API endpoints
                if (url.includes('/en/account/getconsumption') ||
                    url.includes('/en/account/manage-services/getmyservices') ||
                    url.includes('/en/account/getexpirydate') ||
                    url.includes('/en/account/getlastrecharge')) {
                    request.continue();
                    return;
                } else {
                    // Block all other XHR/fetch requests (analytics, tracking, etc.)
                    request.abort();
                    return;
                }
            }
            
            // Allow document requests (HTML pages)
            if (resourceType === 'document') {
                request.continue();
                return;
            }
            
            // Block everything else by default
            request.abort();
        });

        // Step 1: Set up API capture BEFORE login/navigation
        // This ensures we capture all API calls, even during session verification
        const apiResponses = await setupApiCapture(page);

        // Step 2: Login (resources not blocked during login)
        // Returns {success, alreadyOnDashboard} - if alreadyOnDashboard is true, we skip redundant navigation
        const loginResult = await loginToAlfa(page, phone, password, adminId);
        const alreadyOnDashboard = loginResult.alreadyOnDashboard || false;

        // Step 3: Check for cached HTML structure to potentially skip page load
        const cachedHtml = await cacheLayer.getHtmlStructure(cacheIdentifier);
        let pageHtml = null;
        
        if (cachedHtml) {
            console.log('📄 Found cached HTML structure, using it to skip page load');
            // Still navigate to get fresh data, but we can use cached structure for parsing hints
            // For now, we'll still navigate but cache can help with parsing optimization
        }
        
        // Step 4: Always navigate to dashboard (even if already there from session verification)
        // This ensures APIs are properly triggered and captured
        // Enable resource blocking for dashboard navigation
        blockState.enabled = true;
        console.log('🔄 Navigating to dashboard (always fresh)...');
        await page.goto(AEFA_DASHBOARD_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        // Get fresh HTML and cache it for next time
        // Only try if page is still valid (not destroyed)
        try {
            // Check if page is still valid before getting content
            if (!page.isClosed()) {
                pageHtml = await page.content();
                // Cache HTML structure (non-blocking)
                if (pageHtml) {
                    cacheLayer.setHtmlStructure(cacheIdentifier, pageHtml).catch(() => {});
                }
            }
        } catch (e) {
            // Silently ignore - HTML caching is optional
            // Only log if it's not a context destroyed error (which is expected sometimes)
            if (!e.message.includes('Execution context was destroyed') && 
                !e.message.includes('Target closed') &&
                !e.message.includes('Session closed')) {
                console.warn('⚠️ Could not cache HTML structure:', e.message);
            }
        }

        // Minimal wait for page structure
        await delay(1000);

        // Step 5: Check for cached API structures, but always fetch fresh
        // Cache can help identify which APIs to prioritize, but we always fetch fresh
        const cachedConsumption = await cacheLayer.getApiStructure(cacheIdentifier, 'getconsumption');
        const cachedServices = await cacheLayer.getApiStructure(cacheIdentifier, 'getmyservices');
        
        if (cachedConsumption || cachedServices) {
            console.log('📡 Found cached API structures (using as reference, but fetching fresh)');
        }

        // Step 6: Wait for API endpoints with reduced timeout (APIs are more important than HTML)
        // Don't wait too long - we can fetch them directly if needed
        await waitForApiEndpoints(apiResponses, ['getconsumption', 'getmyservices'], 5000);

        // Step 7: Fetch missing APIs directly in parallel (faster than sequential)
        const missingApiPromises = [];
        
        let getExpiryDateResponse = apiResponses.find(resp => resp.url && resp.url.includes('getexpirydate'));
        if (!getExpiryDateResponse || getExpiryDateResponse.data === undefined || getExpiryDateResponse.data === null) {
            console.log('⚠️ getexpirydate not captured, fetching directly...');
            missingApiPromises.push(
                fetchApiDirectly(page, `https://www.alfa.com.lb/en/account/getexpirydate?_=${Date.now()}`)
                    .then(response => {
                        if (response) {
                            apiResponses.push(response);
                            return response;
                        }
                        return null;
                    })
            );
        }

        let getMyServicesResponse = apiResponses.find(resp => resp.url && resp.url.includes('getmyservices'));
        if (!getMyServicesResponse || !getMyServicesResponse.data) {
            console.log('⚠️ getmyservices not captured, fetching directly...');
            missingApiPromises.push(
                fetchApiDirectly(page, `https://www.alfa.com.lb/en/account/manage-services/getmyservices?_=${Date.now()}`)
                    .then(response => {
                        if (response) {
                            apiResponses.push(response);
                            return response;
                        }
                        return null;
                    })
            );
        }
        
        // Wait for all missing APIs in parallel (much faster)
        if (missingApiPromises.length > 0) {
            const results = await Promise.all(missingApiPromises);
            // Update references if needed
            if (!getExpiryDateResponse) {
                getExpiryDateResponse = results.find(r => r && r.url && r.url.includes('getexpirydate'));
            }
            if (!getMyServicesResponse) {
                getMyServicesResponse = results.find(r => r && r.url && r.url.includes('getmyservices'));
            }
        }

        // Step 8: Cache API responses for next scraping cycle (non-blocking)
        // This helps speed up future scrapes by providing structure hints
        // getMyServicesResponse already declared above, just get getConsumptionResponse
        const getConsumptionResponse = apiResponses.find(resp => resp.url && resp.url.includes('getconsumption'));
        
        if (getConsumptionResponse?.data) {
            cacheLayer.setApiStructure(cacheIdentifier, 'getconsumption', getConsumptionResponse.data).catch(() => {});
        }
        if (getMyServicesResponse?.data) {
            cacheLayer.setApiStructure(cacheIdentifier, 'getmyservices', getMyServicesResponse.data).catch(() => {});
        }

        // Step 9: Wait for consumption circles to render (they're rendered dynamically by JavaScript)
        // Only wait if we need HTML data - if we have all API data, we can skip this
        const hasAllApiData = getConsumptionResponse?.data && getMyServicesResponse?.data;
        
        if (!hasAllApiData) {
            console.log('⏳ Waiting for consumption circles to render...');
            try {
                // Wait for at least one circle to appear
                await page.waitForFunction(
                    () => {
                        const circles = document.querySelectorAll('#consumptions .circle');
                        return circles.length > 0;
                    },
                    { timeout: 8000 } // Reduced from 15s to 8s
                );
                console.log('✅ Consumption circles rendered');
                // Minimal delay for rendering
                await delay(1000);
            } catch (e) {
                console.log('⚠️ Timeout waiting for consumption circles, proceeding with API data...');
            }
        } else {
            console.log('✅ All API data available, skipping HTML wait');
            // Still try to get circles quickly if possible, but don't wait long
            await delay(500);
        }

        // Step 10: Extract data (always fresh from current scrape)

        // Extract from HTML
        const consumptions = await extractConsumptionCircles(page);
        const balanceFromHtml = await extractBalanceFromHtml(page);
        const totalConsumptionFromHtml = await extractTotalConsumptionFromHtml(page);

        // Extract from API
        const dashboardData = {
            apiResponses: apiResponses,
            consumptions: consumptions
        };

        // Extract from getconsumption API (getConsumptionResponse already declared above)
        if (getConsumptionResponse && getConsumptionResponse.data) {
            const extracted = extractFromGetConsumption(getConsumptionResponse.data);
            Object.assign(dashboardData, extracted);
        }

        // Extract from getmyservices API
        if (getMyServicesResponse && getMyServicesResponse.data) {
            const extracted = extractFromGetMyServices(getMyServicesResponse.data);
            if (extracted.adminConsumptionTemplate) {
                dashboardData.adminConsumptionTemplate = extracted.adminConsumptionTemplate;
                dashboardData.adminConsumption = buildAdminConsumption(extracted.adminConsumptionTemplate, consumptions);
            }
            if (extracted.subscriptionDate) dashboardData.subscriptionDate = extracted.subscriptionDate;
            if (extracted.validityDate) dashboardData.validityDate = extracted.validityDate;
        }

        // Extract expiration
        if (getExpiryDateResponse && getExpiryDateResponse.data !== undefined && getExpiryDateResponse.data !== null) {
            dashboardData.expiration = extractExpiration(getExpiryDateResponse.data);
        }

        // Fallback to HTML if API data not available
        if (!dashboardData.balance && balanceFromHtml) {
            dashboardData.balance = balanceFromHtml;
        }
        if (!dashboardData.totalConsumption && totalConsumptionFromHtml) {
            dashboardData.totalConsumption = totalConsumptionFromHtml;
        }

        // Step 7: Save to Firebase (completely non-blocking - fire and forget)
        // Use process.nextTick to ensure it runs after the response is sent
        process.nextTick(() => {
            (async () => {
                try {
                    await updateDashboardData(adminId, dashboardData);
                } catch (firebaseError) {
                    // Silently ignore - Firebase is optional, data was fetched successfully
                    console.warn('⚠️ Firebase save skipped (non-critical):', firebaseError?.message || String(firebaseError));
                }
            })().catch((err) => {
                // Ignore any unhandled promise rejections from Firebase
                console.warn('⚠️ Firebase promise rejection (ignored):', err?.message || String(err));
            });
        });

        // Close the context (browser stays alive for reuse)
        await browserPool.closeContext(context);
        return dashboardData;
    } catch (error) {
        // Ensure context is closed even if error occurs
        if (context) {
            try {
                await browserPool.closeContext(context);
            } catch (closeError) {
                console.error('Error closing browser context:', closeError);
            }
        }
        
        // Provide more detailed error information
        const errorMessage = error.message || String(error);
        console.error(`❌ Error fetching Alfa data for ${adminId || phone}:`, errorMessage);
        console.error('Stack trace:', error.stack);
        
        // Re-throw with more context
        throw new Error(`Failed to fetch Alfa data: ${errorMessage}`);
    }
}

module.exports = { fetchAlfaData };

