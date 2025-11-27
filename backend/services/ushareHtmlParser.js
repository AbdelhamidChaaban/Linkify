const axios = require('axios');
const { formatCookiesForHeader } = require('./apiClient');
const cheerio = require('cheerio');
const browserPool = require('./browserPool');

const BASE_URL = 'https://www.alfa.com.lb';
const USHARE_BASE_URL = `${BASE_URL}/en/account/manage-services/ushare`;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch and parse ushare HTML page to extract subscriber information
 * Uses Puppeteer to navigate to the page (required for proper authentication)
 * @param {string} adminPhone - Admin phone number (8 digits)
 * @param {Array} cookies - Array of cookie objects
 * @returns {Promise<{success: boolean, data: {subscribers: Array, activeCount: number, requestedCount: number, totalCount: number} | null, error: string | null}>}
 */
async function fetchUshareHtml(adminPhone, cookies) {
    let page = null;
    let context = null;
    try {
        const url = `${USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        console.log(`🌐 [Ushare HTML] Fetching HTML from ushare page: ${url}`);
        
        // Use Puppeteer to navigate to the ushare page (required for proper authentication)
        // Create a browser context (reuses browser instance)
        const contextData = await browserPool.createContext();
        context = contextData.context;
        page = contextData.page; // createContext already creates a page
        
        // Set cookies before navigation
        if (cookies && cookies.length > 0) {
            await page.setCookie(...cookies);
            console.log(`✅ [Ushare HTML] Injected ${cookies.length} cookies`);
        }
        
        // Navigate to ushare page
        // Use 'domcontentloaded' for faster initial load, then wait for specific content
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000 // 30 seconds timeout
        });
        
        // Wait for the subscriber container to appear (this is what we actually need)
        // This is more reliable than waiting for network idle
        try {
            await page.waitForSelector('#ushare-numbers .col-sm-4', {
                timeout: 15000 // Wait up to 15 seconds for subscriber cards to appear
            });
            console.log(`✅ [Ushare HTML] Subscriber container found`);
        } catch (selectorError) {
            // If selector not found, check if we're on login page
            const currentUrl = page.url();
            if (currentUrl.includes('/login')) {
                console.log(`⚠️ [Ushare HTML] Redirected to login, cookies expired`);
                return {
                    success: false,
                    data: null,
                    error: 'Redirected to login - cookies expired'
                };
            }
            // If not login, might be empty page or slow loading - continue anyway
            console.log(`⚠️ [Ushare HTML] Subscriber container not found, but continuing...`);
        }
        
        // Additional short wait to ensure any remaining dynamic content is loaded
        await delay(2000); // Wait 2 seconds for any remaining JavaScript to execute
        
        // Check if redirected to login
        const currentUrl = page.url();
        if (currentUrl.includes('/login')) {
            console.log(`⚠️ [Ushare HTML] Redirected to login, cookies expired`);
            return {
                success: false,
                data: null,
                error: 'Redirected to login - cookies expired'
            };
        }
        
        // Get HTML content
        const html = await page.content();
        const $ = cheerio.load(html);
        
        // Find all subscriber cards (div.col-sm-4 inside #ushare-numbers)
        const subscriberCards = $('#ushare-numbers .col-sm-4');
        const subscribers = [];
        let activeCount = 0;
        let requestedCount = 0;
        
        subscriberCards.each((index, element) => {
            const $card = $(element);
            
            // Find status (Active or Requested) - it's the first h4.italic that is NOT the capacity one
            // Structure: <h4 class="italic">Active</h4> (status)
            //           <h2>96171821259</h2> (phone number)
            //           <h4 class="italic capacity" id="..." data-val="..." data-quota="...">30 GB</h4> (consumption)
            let statusText = '';
            const allH4 = $card.find('h4');
            
            // Find the status h4 (first one that doesn't have class "capacity" and doesn't have id)
            allH4.each((idx, el) => {
                const $h4 = $(el);
                if (!$h4.hasClass('capacity') && !$h4.attr('id')) {
                    const text = $h4.text().trim();
                    if (text === 'Active' || text === 'Requested') {
                        statusText = text;
                        return false; // Break
                    }
                }
            });
            
            const isActive = statusText === 'Active';
            const isRequested = statusText === 'Requested';
            
            if (isActive) {
                activeCount++;
            } else if (isRequested) {
                requestedCount++;
            }
            
            // Find subscriber phone number from h2 element
            const phoneElement = $card.find('h2');
            let phoneNumber = phoneElement.text().trim();
            
            // If phone number not found in h2, try to get from capacity id attribute
            if (!phoneNumber || phoneNumber.length < 8) {
                const capacityElement = $card.find('h4.italic.capacity');
                const capacityId = capacityElement.attr('id');
                if (capacityId && capacityId.length >= 8) {
                    phoneNumber = capacityId;
                }
            }
            
            // Extract consumption data from capacity element
            const capacityElement = $card.find('h4.italic.capacity');
            const dataVal = capacityElement.attr('data-val'); // Used consumption in GB
            const dataQuota = capacityElement.attr('data-quota'); // Total quota in GB
            
            // Parse consumption values
            const usedConsumption = dataVal ? parseFloat(dataVal) : 0;
            const totalQuota = dataQuota ? parseFloat(dataQuota) : 0;
            
            if (phoneNumber && phoneNumber.length >= 8) {
                // Remove 961 prefix if present to get 8-digit number
                const cleanPhone = phoneNumber.replace(/^961/, '');
                
                subscribers.push({
                    phoneNumber: cleanPhone,
                    fullPhoneNumber: phoneNumber, // Keep full number with prefix
                    status: isActive ? 'Active' : (isRequested ? 'Requested' : 'Unknown'),
                    usedConsumption: usedConsumption, // In GB
                    totalQuota: totalQuota, // In GB
                    consumptionText: `${usedConsumption} / ${totalQuota} GB`
                });
            }
        });
        
        const totalCount = subscribers.length;
        
        // Always log success/failure (important for debugging)
        if (totalCount > 0) {
            console.log(`✅ [Ushare HTML] Successfully parsed ${totalCount} subscribers (${activeCount} Active, ${requestedCount} Requested) for admin ${adminPhone}`);
        } else {
            console.log(`⚠️ [Ushare HTML] No subscribers found on ushare page for admin ${adminPhone}`);
        }
        
        return {
            success: true,
            data: {
                subscribers: subscribers,
                activeCount: activeCount,
                requestedCount: requestedCount,
                totalCount: totalCount
            },
            error: null
        };
        
    } catch (error) {
        console.error(`❌ [Ushare HTML] Error fetching/parsing:`, error.message);
        return {
            success: false,
            data: null,
            error: error.message || 'Unknown error'
        };
    } finally {
        // Always close the page and context
        if (page) {
            try {
                await page.close();
            } catch (closeError) {
                console.warn(`⚠️ [Ushare HTML] Error closing page:`, closeError.message);
            }
        }
        if (context) {
            try {
                await browserPool.closeContext(context);
            } catch (closeError) {
                console.warn(`⚠️ [Ushare HTML] Error closing context:`, closeError.message);
            }
        }
    }
}

module.exports = {
    fetchUshareHtml
};

