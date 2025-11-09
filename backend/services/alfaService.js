const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { loginToAlfa, delay, AEFA_DASHBOARD_URL } = require('./alfaLogin');
const { setupApiCapture, waitForApiEndpoints, fetchApiDirectly } = require('./alfaApiCapture');
const { extractConsumptionCircles, extractBalanceFromHtml, extractTotalConsumptionFromHtml } = require('./alfaDataExtraction');
const { extractFromGetConsumption, extractFromGetMyServices, extractExpiration, buildAdminConsumption } = require('./alfaApiDataExtraction');
const { updateDashboardData } = require('./firebaseDbService');

puppeteer.use(StealthPlugin());

/**
 * Fetch Alfa dashboard data for an admin
 * @param {string} phone - Phone number
 * @param {string} password - Password
 * @param {string} adminId - Admin document ID
 * @returns {Promise<Object>} Dashboard data
 */
async function fetchAlfaData(phone, password, adminId) {
    console.log(`🚀 Starting browser for admin: ${adminId || phone}`);
    
    let browser = null;
    
    try {
        browser = await puppeteer.launch({ 
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--window-size=1920,1080'
            ]
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(40000);

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
            
            // Block non-essential scripts
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
                // Allow only essential scripts from alfa.com.lb (app.js, common.js might be needed)
                // But we'll block them too since we don't need JS execution for data extraction
                if (url.includes('/content/scripts/')) {
                    request.abort();
                    return;
                }
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

        // Step 1: Login (resources not blocked during login)
        await loginToAlfa(page, phone, password, adminId);

        // Step 2: Set up API capture BEFORE navigating
        const apiResponses = await setupApiCapture(page);

        // Step 3: Enable resource blocking for dashboard navigation
        blockState.enabled = true;
        console.log('🔄 Navigating to dashboard...');
        await page.goto(AEFA_DASHBOARD_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        // Wait just for the page structure, not all resources
        await delay(2000);

        // Wait for consumption container (reduced timeout)
        try {
            await page.waitForSelector('#consumption-container', { timeout: 5000 });
        } catch (e) {
            console.log('⚠️ #consumption-container not found');
        }

        // Step 4: Wait for API endpoints (reduced wait time)
        await waitForApiEndpoints(apiResponses, ['getconsumption', 'getmyservices'], 10000);

        // Step 5: Fetch missing APIs directly if needed
        let getExpiryDateResponse = apiResponses.find(resp => resp.url && resp.url.includes('getexpirydate'));
        if (!getExpiryDateResponse || getExpiryDateResponse.data === undefined || getExpiryDateResponse.data === null) {
            console.log('⚠️ getexpirydate not captured, fetching directly...');
            const expiryResponse = await fetchApiDirectly(page, `https://www.alfa.com.lb/en/account/getexpirydate?_=${Date.now()}`);
            if (expiryResponse) {
                apiResponses.push(expiryResponse);
                getExpiryDateResponse = expiryResponse;
            }
        }

        let getMyServicesResponse = apiResponses.find(resp => resp.url && resp.url.includes('getmyservices'));
        if (!getMyServicesResponse || !getMyServicesResponse.data) {
            console.log('⚠️ getmyservices not captured, fetching directly...');
            const servicesResponse = await fetchApiDirectly(page, `https://www.alfa.com.lb/en/account/manage-services/getmyservices?_=${Date.now()}`);
            if (servicesResponse) {
                apiResponses.push(servicesResponse);
                getMyServicesResponse = servicesResponse;
            }
        }

        // Step 6: Extract data

        // Extract from HTML
        const consumptions = await extractConsumptionCircles(page);
        const balanceFromHtml = await extractBalanceFromHtml(page);
        const totalConsumptionFromHtml = await extractTotalConsumptionFromHtml(page);

        // Extract from API
        const dashboardData = {
            apiResponses: apiResponses,
            consumptions: consumptions
        };

        // Extract from getconsumption API
        const getConsumptionResponse = apiResponses.find(resp => resp.url && resp.url.includes('getconsumption'));
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

        await browser.close();
        return dashboardData;
    } catch (error) {
        // Ensure browser is closed even if error occurs
        if (browser) {
            try {
                await browser.close();
            } catch (closeError) {
                console.error('Error closing browser:', closeError);
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

