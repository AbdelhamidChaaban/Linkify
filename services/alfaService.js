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
    
    const browser = await puppeteer.launch({ 
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

    try {
        // Step 1: Login
        await loginToAlfa(page, phone, password, adminId);

        // Step 2: Set up API capture BEFORE navigating
        const apiResponses = await setupApiCapture(page);

        // Step 3: Navigate to dashboard
        console.log('🔄 Navigating to dashboard...');
        await page.goto(AEFA_DASHBOARD_URL, {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        await delay(5000);

        // Wait for consumption container
        try {
            await page.waitForSelector('#consumption-container', { timeout: 10000 });
            await delay(2000);
        } catch (e) {
            console.log('⚠️ #consumption-container not found');
        }

        // Step 4: Wait for API endpoints
        await waitForApiEndpoints(apiResponses, ['getconsumption', 'getmyservices'], 15000);

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
        console.log('📊 Extracting dashboard data...');

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

        // Step 7: Save to Firebase
        await updateDashboardData(adminId, dashboardData);

        console.log('✅ Dashboard data saved to database');

        await browser.close();
        return dashboardData;
    } catch (error) {
        await browser.close();
        throw error;
    }
}

module.exports = { fetchAlfaData };

