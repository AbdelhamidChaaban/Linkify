const browserPool = require('./browserPool');
const cacheLayer = require('./cacheLayer');
const { loginToAlfa, delay, AEFA_DASHBOARD_URL } = require('./alfaLogin');
const { setupApiCapture, waitForApiEndpoints, fetchApiDirectly } = require('./alfaApiCapture');
const { extractConsumptionCircles, extractBalanceFromHtml, extractTotalConsumptionFromHtml } = require('./alfaDataExtraction');
const { extractFromGetConsumption, extractFromGetMyServices, extractExpiration, buildAdminConsumption } = require('./alfaApiDataExtraction');
const { updateDashboardData } = require('./firebaseDbService');
const snapshotManager = require('./snapshotManager');

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
        // Returns {success, alreadyOnDashboard, sessionWasFresh}
        const loginResult = await loginToAlfa(page, phone, password, adminId);
        const alreadyOnDashboard = loginResult.alreadyOnDashboard || false;
        const sessionWasFresh = loginResult.sessionWasFresh || false;
        const needsLogin = !loginResult.success;

        // Step 3: If we have a session (fresh or refreshed), try to fetch APIs directly first (faster)
        // OPTIMIZATION: Parallel API fetching with timeouts for faster snapshot check
        if ((sessionWasFresh || !needsLogin) && apiResponses.length < 2) {
            console.log('⚡ Attempting direct API fetch for faster snapshot check...');
            try {
                // Fetch APIs directly without full page navigation (parallel with timeouts)
                const { fetchApiDirectly } = require('./alfaApiCapture');
                
                // Check what we already have
                const hasConsumption = apiResponses.find(r => r.url && r.url.includes('getconsumption') && r.data);
                const hasServices = apiResponses.find(r => r.url && r.url.includes('getmyservices') && r.data);
                
                const directApiPromises = [];
                if (!hasConsumption) {
                    directApiPromises.push(
                        Promise.race([
                            fetchApiDirectly(page, `https://www.alfa.com.lb/en/account/getconsumption?_=${Date.now()}`),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000)) // 2s timeout
                        ]).catch(() => null)
                    );
                }
                if (!hasServices) {
                    directApiPromises.push(
                        Promise.race([
                            fetchApiDirectly(page, `https://www.alfa.com.lb/en/account/manage-services/getmyservices?_=${Date.now()}`),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000)) // 2s timeout
                        ]).catch(() => null)
                    );
                }
                if (directApiPromises.length > 0) {
                    directApiPromises.push(
                        Promise.race([
                            fetchApiDirectly(page, `https://www.alfa.com.lb/en/account/getexpirydate?_=${Date.now()}`),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000)) // 2s timeout
                        ]).catch(() => null)
                    );
                }
                
                if (directApiPromises.length > 0) {
                    const directResults = await Promise.all(directApiPromises);
                    
                    // Add successful results to apiResponses (avoid duplicates)
                    directResults.forEach(result => {
                        if (result && result.data !== null && result.data !== undefined) {
                            const exists = apiResponses.find(r => r.url === result.url);
                            if (!exists) {
                                apiResponses.push(result);
                            }
                        }
                    });
                    
                    // Check if we got the essential APIs
                    const finalHasConsumption = apiResponses.find(r => r.url && r.url.includes('getconsumption') && r.data);
                    const finalHasServices = apiResponses.find(r => r.url && r.url.includes('getmyservices') && r.data);
                    
                    if (finalHasConsumption && finalHasServices) {
                        console.log('✅ Direct API fetch successful - can do snapshot check without navigation');
                    } else {
                        console.log(`⚠️ Direct API fetch incomplete (consumption: ${finalHasConsumption ? '✅' : '❌'}, services: ${finalHasServices ? '✅' : '❌'})`);
                    }
                }
            } catch (directError) {
                console.log('⚠️ Direct API fetch failed, will navigate normally:', directError.message);
            }
        }

        // Step 4: Quick snapshot check BEFORE navigation (if we have APIs from direct fetch)
        // This allows us to skip navigation entirely if no changes detected
        let shouldSkipNavigation = false;
        
        // Wait briefly for any APIs that might be captured during session verification
        // But only if we don't already have both essential APIs
        const hasConsumption = apiResponses.find(r => r.url && r.url.includes('getconsumption') && r.data);
        const hasServices = apiResponses.find(r => r.url && r.url.includes('getmyservices') && r.data);
        
        if (!hasConsumption || !hasServices) {
            console.log('⏳ Waiting for API endpoints (500ms timeout)...');
            await waitForApiEndpoints(apiResponses, ['getconsumption', 'getmyservices'], 500); // Reduced to 500ms
        }
        console.log(`📡 Captured ${apiResponses.length} API response(s) so far`);
        
        console.log('🔍 Checking for incremental update (snapshot comparison)...');
        
        try {
            const getConsumptionResponse = apiResponses.find(resp => resp.url && resp.url.includes('getconsumption'));
            const getMyServicesResponse = apiResponses.find(resp => resp.url && resp.url.includes('getmyservices'));
            
            console.log(`   - getconsumption: ${getConsumptionResponse?.data ? '✅' : '❌'}`);
            console.log(`   - getmyservices: ${getMyServicesResponse?.data ? '✅' : '❌'}`);
            
            // Check if we have the required API data
            if (!getConsumptionResponse?.data && !getMyServicesResponse?.data) {
                console.log('⚠️ API data not yet available for snapshot check, will navigate to dashboard');
            } else {
                console.log('📊 API data available, creating quick snapshot...');
                const quickData = {};
                
                // Extract essential fields from APIs
                if (getConsumptionResponse?.data) {
                    const extracted = extractFromGetConsumption(getConsumptionResponse.data);
                    if (extracted.balance) quickData.balance = extracted.balance;
                    if (extracted.totalConsumption) quickData.totalConsumption = extracted.totalConsumption;
                    if (extracted.subscribersCount !== undefined) quickData.subscribersCount = extracted.subscribersCount;
                    console.log(`   - Balance: ${quickData.balance || 'N/A'}, Consumption: ${quickData.totalConsumption || 'N/A'}, Subscribers: ${quickData.subscribersCount || 'N/A'}`);
                }
                
                if (getMyServicesResponse?.data) {
                    const extracted = extractFromGetMyServices(getMyServicesResponse.data);
                    if (extracted.subscriptionDate) quickData.subscriptionDate = extracted.subscriptionDate;
                    if (extracted.validityDate) quickData.validityDate = extracted.validityDate;
                    // Note: adminConsumption requires consumption circles, so we'll get it during full scrape
                }
                
                // Get expiration if available
                const getExpiryDateResponse = apiResponses.find(resp => resp.url && resp.url.includes('getexpirydate'));
                if (getExpiryDateResponse?.data !== undefined && getExpiryDateResponse?.data !== null) {
                    quickData.expiration = extractExpiration(getExpiryDateResponse.data);
                }
                
                // Create snapshot from quick data
                const quickSnapshot = snapshotManager.createSnapshot(quickData);
                
                if (quickSnapshot) {
                    console.log('🔍 Comparing with last snapshot...');
                    // Check for changes
                    const changeCheck = await snapshotManager.checkForChanges(cacheIdentifier, quickSnapshot);
                    
                    if (!changeCheck.hasChanges) {
                        console.log('⚡ No changes detected - skipping navigation and full scrape');
                        shouldSkipNavigation = true;
                        
                        // Close the context before returning
                        await browserPool.closeContext(context);
                        
                        // Return early with cached data structure
                        const lastSnapshot = changeCheck.lastSnapshot;
                        return {
                            success: true,
                            incremental: true,
                            noChanges: true,
                            message: 'No changes detected since last refresh',
                            timestamp: Date.now(),
                            lastUpdate: lastSnapshot?.timestamp || null,
                            data: {
                                balance: quickData.balance || null,
                                totalConsumption: quickData.totalConsumption || null,
                                subscribersCount: quickData.subscribersCount || null,
                                expiration: quickData.expiration || null,
                                subscriptionDate: quickData.subscriptionDate || null,
                                validityDate: quickData.validityDate || null
                            }
                        };
                    } else {
                        const changedFields = Object.keys(changeCheck.comparison.changes || {});
                        if (changedFields.length > 0) {
                            console.log(`📊 Changes detected in: ${changedFields.join(', ')} - proceeding with full scrape`);
                        } else {
                            console.log('📊 No previous snapshot found (first refresh) - proceeding with full scrape');
                        }
                    }
                } else {
                    console.log('⚠️ Could not create snapshot from quick data, continuing with full scrape');
                }
            }
        } catch (snapshotError) {
            // Non-critical - continue with full scrape if snapshot check fails
            console.warn('⚠️ Snapshot check failed, continuing with full scrape:', snapshotError.message);
            console.warn('   Error details:', snapshotError.stack);
        }

        // Step 5: Navigate to dashboard (only if needed - skip if snapshot check found no changes)
        if (!shouldSkipNavigation) {
            // Check for cached HTML structure
            const cachedHtml = await cacheLayer.getHtmlStructure(cacheIdentifier);
            let pageHtml = null;
            
            if (cachedHtml) {
                console.log('📄 Found cached HTML structure');
            }
            
            // Enable resource blocking for dashboard navigation
            blockState.enabled = true;
            console.log('🔄 Navigating to dashboard...');
            await page.goto(AEFA_DASHBOARD_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 15000 // Reduced from 30s to 15s for faster performance
            });

            // Get fresh HTML and cache it for next time
            try {
                if (!page.isClosed()) {
                    pageHtml = await page.content();
                    if (pageHtml) {
                        cacheLayer.setHtmlStructure(cacheIdentifier, pageHtml).catch(() => {});
                    }
                }
            } catch (e) {
                if (!e.message.includes('Execution context was destroyed') && 
                    !e.message.includes('Target closed') &&
                    !e.message.includes('Session closed')) {
                    console.warn('⚠️ Could not cache HTML structure:', e.message);
                }
            }

            // Minimal wait for page structure (optimized)
            await delay(300); // Reduced from 500ms to 300ms
        }

        // Step 6: Check for cached API structures, but always fetch fresh
        const cachedConsumption = await cacheLayer.getApiStructure(cacheIdentifier, 'getconsumption');
        const cachedServices = await cacheLayer.getApiStructure(cacheIdentifier, 'getmyservices');
        
        if (cachedConsumption || cachedServices) {
            console.log('📡 Found cached API structures (using as reference, but fetching fresh)');
        }

        // Step 7: Fetch missing APIs directly in parallel (faster than sequential)
        // OPTIMIZATION: Parallel API fetching with timeouts
        const missingApiPromises = [];
        
        let getExpiryDateResponse = apiResponses.find(resp => resp.url && resp.url.includes('getexpirydate'));
        if (!getExpiryDateResponse || getExpiryDateResponse.data === undefined || getExpiryDateResponse.data === null) {
            console.log('⚠️ getexpirydate not captured, fetching directly...');
            missingApiPromises.push(
                Promise.race([
                    fetchApiDirectly(page, `https://www.alfa.com.lb/en/account/getexpirydate?_=${Date.now()}`),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000)) // 2s timeout
                ]).then(response => {
                    if (response) {
                        apiResponses.push(response);
                        return response;
                    }
                    return null;
                }).catch(() => null)
            );
        }

        let getMyServicesResponse = apiResponses.find(resp => resp.url && resp.url.includes('getmyservices'));
        if (!getMyServicesResponse || !getMyServicesResponse.data) {
            console.log('⚠️ getmyservices not captured, fetching directly...');
            // Use timeout to prevent long waits
            missingApiPromises.push(
                Promise.race([
                    fetchApiDirectly(page, `https://www.alfa.com.lb/en/account/manage-services/getmyservices?_=${Date.now()}`),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000)) // 2s timeout
                ]).then(response => {
                    if (response) {
                        apiResponses.push(response);
                        return response;
                    }
                    return null;
                }).catch(() => null)
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
        // ALWAYS wait for circles - they're needed for the consumptions array even if API data is available
        // The circles contain important data like plan names and phone numbers that APIs don't provide
        console.log('⏳ Waiting for consumption circles to render...');
        try {
            // Wait for at least one circle to appear
            await page.waitForFunction(
                () => {
                    const circles = document.querySelectorAll('#consumptions .circle');
                    return circles.length > 0;
                },
                { timeout: 8000 } // Reduced from 15s to 8s for faster performance
            );
            console.log('✅ Consumption circles rendered');
            // Reduced delay - circles should be ready after waitForFunction
            await delay(500); // Reduced from 2s to 500ms
        } catch (e) {
            console.log('⚠️ Timeout waiting for consumption circles, proceeding anyway...');
            // Minimal delay if timeout
            await delay(500); // Reduced from 2s to 500ms
        }

        // Step 10: Extract data (always fresh from current scrape)
        // OPTIMIZATION: Parallel extraction for faster performance

        // Extract from HTML in parallel (concurrency optimization)
        const [consumptions, balanceFromHtml, totalConsumptionFromHtml] = await Promise.all([
            extractConsumptionCircles(page),
            extractBalanceFromHtml(page),
            extractTotalConsumptionFromHtml(page)
        ]);

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

        // Step 11: Save snapshot after successful data extraction
        // Only save if we have valid, complete data
        try {
            if (dashboardData && !dashboardData.error && !dashboardData.failed) {
                console.log('💾 Saving snapshot for next incremental check...');
                const saved = await snapshotManager.saveSnapshot(cacheIdentifier, dashboardData);
                if (saved) {
                    console.log('✅ Snapshot saved successfully');
                } else {
                    console.log('⚠️ Snapshot save returned false (data might be invalid)');
                }
            } else {
                console.log('⚠️ Not saving snapshot - data has errors or is incomplete');
            }
        } catch (snapshotError) {
            // Non-critical - log but don't fail
            console.warn('⚠️ Could not save snapshot (non-critical):', snapshotError.message);
        }

        // Step 12: Refresh session cookies after successful operation (non-blocking)
        // OPTIMIZATION: Moved to Step 11 parallel saves - this is now handled there
        // Session refresh is now part of the parallel save operations

        // Mark as full scrape (not incremental)
        dashboardData.incremental = false;
        dashboardData.noChanges = false;
        dashboardData.timestamp = Date.now();

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
        
        // Only delete session if it's a login/authentication error
        // Don't delete for other errors (network, parsing, etc.) - session might still be valid
        if (errorMessage.includes('Login') || 
            errorMessage.includes('login') || 
            errorMessage.includes('Invalid credentials') ||
            errorMessage.includes('CAPTCHA') ||
            errorMessage.includes('authentication')) {
            console.log('⚠️ Login/authentication error detected. Session may be invalid.');
            // Note: We don't delete the session here - let the next attempt verify it
            // If it's truly invalid, loginToAlfa will handle it
        }
        
        // Re-throw with more context
        throw new Error(`Failed to fetch Alfa data: ${errorMessage}`);
    }
}

module.exports = { fetchAlfaData };

