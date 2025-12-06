const axios = require('axios');
const { formatCookiesForHeader } = require('./apiClient');
const cheerio = require('cheerio');
const browserPool = require('./browserPool');
const cacheLayer = require('./cacheLayer');

const BASE_URL = 'https://www.alfa.com.lb';
const USHARE_BASE_URL = `${BASE_URL}/en/account/manage-services/ushare`;
const USHARE_CACHE_TTL = 2 * 60; // 2 minutes cache TTL (reduced to ensure fresher data)

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get cached Ushare HTML subscriber data
 * @param {string} adminPhone - Admin phone number
 * @returns {Promise<Object|null>} Cached subscriber data or null
 */
async function getCachedUshareData(adminPhone) {
    try {
        const key = `ushare:${adminPhone}`;
        const data = await cacheLayer.get(key);
        if (data) {
            const cached = typeof data === 'string' ? JSON.parse(data) : data;
            const age = Date.now() - (cached.timestamp || 0);
            const ageMinutes = Math.round(age / 60000);
            // Return cached data if less than 5 minutes old
            if (age < USHARE_CACHE_TTL * 1000) {
                console.log(`⚡ [Ushare HTML] Using cached subscriber data (${ageMinutes}min old)`);
                return cached.data;
            }
        }
        return null;
    } catch (error) {
        console.warn(`⚠️ [Ushare HTML] Failed to get cached data:`, error.message);
        return null;
    }
}

/**
 * Save Ushare HTML subscriber data to cache
 * @param {string} adminPhone - Admin phone number
 * @param {Object} subscriberData - Parsed subscriber data
 */
async function saveCachedUshareData(adminPhone, subscriberData) {
    try {
        const key = `ushare:${adminPhone}`;
        const data = {
            data: subscriberData,
            timestamp: Date.now()
        };
        await cacheLayer.set(key, JSON.stringify(data), USHARE_CACHE_TTL);
    } catch (error) {
        console.warn(`⚠️ [Ushare HTML] Failed to save cached data:`, error.message);
    }
}

/**
 * Try to fetch Ushare HTML using HTTP request (faster than Puppeteer)
 * @param {string} adminPhone - Admin phone number
 * @param {Array} cookies - Array of cookie objects
 * @returns {Promise<{success: boolean, data: Object|null, error: string|null}>}
 */
async function fetchUshareHtmlHttp(adminPhone, cookies) {
    try {
        const url = `${USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        const cookieHeader = formatCookiesForHeader(cookies);
        
        const response = await axios.get(url, {
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.alfa.com.lb/en/account'
            },
            timeout: 5000, // 5 second timeout (faster fallback to Puppeteer)
            maxRedirects: 5,
            validateStatus: (status) => status < 400 // Accept 3xx redirects
        });
        
        // Check if redirected to login
        if (response.request.res.responseUrl && response.request.res.responseUrl.includes('/login')) {
            return {
                success: false,
                data: null,
                error: 'Redirected to login - cookies expired'
            };
        }
        
        // Parse HTML with Cheerio
        const $ = cheerio.load(response.data);
        
        // Find all subscriber cards
        const subscriberCards = $('#ushare-numbers .col-sm-4');
        const subscribers = [];
        let activeCount = 0;
        let requestedCount = 0;
        
        subscriberCards.each((index, element) => {
            const $card = $(element);
            
            // Find status (Active or Requested)
            let statusText = '';
            const allH4 = $card.find('h4');
            
            allH4.each((idx, el) => {
                const $h4 = $(el);
                if (!$h4.hasClass('capacity') && !$h4.attr('id')) {
                    const text = $h4.text().trim();
                    if (text === 'Active' || text === 'Requested') {
                        statusText = text;
                        return false;
                    }
                }
            });
            
            const isActive = statusText === 'Active';
            const isRequested = statusText === 'Requested';
            
            if (isActive) activeCount++;
            else if (isRequested) requestedCount++;
            
            // Find phone number
            const phoneElement = $card.find('h2');
            let phoneNumber = phoneElement.text().trim();
            
            if (!phoneNumber || phoneNumber.length < 8) {
                const capacityElement = $card.find('h4.italic.capacity');
                const capacityId = capacityElement.attr('id');
                if (capacityId && capacityId.length >= 8) {
                    phoneNumber = capacityId;
                }
            }
            
            // Extract consumption data
            const capacityElement = $card.find('h4.italic.capacity');
            const dataVal = capacityElement.attr('data-val');
            const dataQuota = capacityElement.attr('data-quota');
            
            const usedConsumption = dataVal ? parseFloat(dataVal) : 0;
            const totalQuota = dataQuota ? parseFloat(dataQuota) : 0;
            
            if (phoneNumber && phoneNumber.length >= 8) {
                const cleanPhone = phoneNumber.replace(/^961/, '');
                
                subscribers.push({
                    phoneNumber: cleanPhone,
                    fullPhoneNumber: phoneNumber,
                    status: isActive ? 'Active' : (isRequested ? 'Requested' : 'Unknown'),
                    usedConsumption: usedConsumption,
                    totalQuota: totalQuota,
                    consumptionText: `${usedConsumption} / ${totalQuota} GB`
                });
            }
        });
        
        const totalCount = subscribers.length;
        
        if (totalCount > 0) {
            console.log(`✅ [Ushare HTML HTTP] Successfully parsed ${totalCount} subscribers (${activeCount} Active, ${requestedCount} Requested) for admin ${adminPhone}`);
        } else {
            console.log(`⚠️ [Ushare HTML HTTP] No subscribers found for admin ${adminPhone}`);
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
        // HTTP request failed - will fallback to Puppeteer
        return {
            success: false,
            data: null,
            error: error.message || 'HTTP request failed'
        };
    }
}

/**
 * Fetch and parse ushare HTML page to extract subscriber information
 * Tries HTTP request first (fast), falls back to Puppeteer if needed
 * @param {string} adminPhone - Admin phone number (8 digits)
 * @param {Array} cookies - Array of cookie objects
 * @param {boolean} useCache - Whether to use cached data if available (default: true)
 * @returns {Promise<{success: boolean, data: {subscribers: Array, activeCount: number, requestedCount: number, totalCount: number} | null, error: string | null}>}
 */
async function fetchUshareHtml(adminPhone, cookies, useCache = true) {
    // OPTIMIZATION 6: Check cache first (avoids waiting for HTML fetch)
    if (useCache) {
        const cachedData = await getCachedUshareData(adminPhone);
        if (cachedData) {
            return {
                success: true,
                data: cachedData,
                error: null
            };
        }
    }
    
    // OPTIMIZATION 6: Try HTTP request first (much faster than Puppeteer)
    console.log(`🌐 [Ushare HTML] Attempting HTTP request first (faster than Puppeteer)...`);
    const httpResult = await fetchUshareHtmlHttp(adminPhone, cookies);
    if (httpResult.success && httpResult.data) {
        // Save to cache for next time
        await saveCachedUshareData(adminPhone, httpResult.data);
        return httpResult;
    }
    
    // HTTP failed - fallback to Puppeteer (slower but more reliable)
    console.log(`🔄 [Ushare HTML] HTTP request failed (${httpResult.error}), falling back to Puppeteer...`);
    
    let page = null;
    let context = null;
    try {
        const url = `${USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        console.log(`🌐 [Ushare HTML] Fetching HTML from ushare page with Puppeteer: ${url}`);
        
        // OPTIMIZATION 5: Reuse browser context (pre-warmed)
        const contextData = await browserPool.createContext();
        context = contextData.context;
        page = contextData.page;
        
        // OPTIMIZATION 1: Disable unnecessary resources to speed up page load
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            const url = req.url();
            
            // Block images, fonts, stylesheets, media (keep only document, script, xhr)
            if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
                req.abort();
            } else if (url.includes('.css') || url.includes('.woff') || url.includes('.png') || url.includes('.jpg') || url.includes('.gif')) {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        // Set cookies before navigation
        if (cookies && cookies.length > 0) {
            await page.setCookie(...cookies);
            console.log(`✅ [Ushare HTML] Injected ${cookies.length} cookies`);
        }
        
        // OPTIMIZATION 2: Use faster navigation and reduced timeout
        await page.goto(url, {
            waitUntil: 'domcontentloaded', // Faster than 'networkidle'
            timeout: 20000 // Reduced from 30s to 20s
        });
        
        // OPTIMIZATION 2: Wait for subscriber container with reduced timeout
        try {
            await page.waitForSelector('#ushare-numbers .col-sm-4', {
                timeout: 10000 // Reduced from 15s to 10s
            });
            console.log(`✅ [Ushare HTML] Subscriber container found`);
        } catch (selectorError) {
            const currentUrl = page.url();
            if (currentUrl.includes('/login')) {
                console.log(`⚠️ [Ushare HTML] Redirected to login, cookies expired`);
                return {
                    success: false,
                    data: null,
                    error: 'Redirected to login - cookies expired'
                };
            }
            console.log(`⚠️ [Ushare HTML] Subscriber container not found, but continuing...`);
        }
        
        // OPTIMIZATION 2: Reduced wait time from 2s to 500ms
        await delay(500); // Reduced from 2000ms
        
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
        
        const subscriberData = {
            subscribers: subscribers,
            activeCount: activeCount,
            requestedCount: requestedCount,
            totalCount: totalCount
        };
        
        // OPTIMIZATION: Cache parsed subscriber data for next time
        await saveCachedUshareData(adminPhone, subscriberData);
        
        return {
            success: true,
            data: subscriberData,
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

