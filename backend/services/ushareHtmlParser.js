const axios = require('axios');
const { formatCookiesForHeader } = require('./apiClient');
const cheerio = require('cheerio');
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
 * Fetch Ushare HTML using HTTP request (stateless - no Puppeteer)
 * Parses HTML server-side using cheerio
 * @param {string} adminPhone - Admin phone number
 * @param {Array} cookies - Array of cookie objects
 * @returns {Promise<{success: boolean, data: Object|null, error: string|null}>}
 */
async function fetchUshareHtmlHttp(adminPhone, cookies) {
    try {
        const url = `${USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        const cookieHeader = formatCookiesForHeader(cookies);
        
        // Use connection pooling for better performance (reuse connections)
        const https = require('https');
        const httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 50,
            maxFreeSockets: 10,
            timeout: 60000
        });
        
        const response = await axios.get(url, {
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.alfa.com.lb/en/account'
            },
            timeout: 20000, // 20 second timeout (Alfa's servers are very slow)
            maxRedirects: 5,
            validateStatus: (status) => status < 400, // Accept 3xx redirects
            httpsAgent: httpsAgent // Use connection pooling for better performance
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
            
            // Normalize phone number: remove non-digits and pad to 8 digits
            let cleanPhone = phoneNumber.replace(/^961/, '').replace(/\D/g, '');
            cleanPhone = cleanPhone.padStart(8, '0');
            
            // Extract consumption data
            const capacityElement = $card.find('h4.italic.capacity');
            const dataVal = capacityElement.attr('data-val');
            const dataQuota = capacityElement.attr('data-quota');
            
            const usedConsumption = dataVal ? parseFloat(dataVal) : 0;
            const totalQuota = dataQuota ? parseFloat(dataQuota) : 0;
            
            if (phoneNumber && phoneNumber.length >= 8) {
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
            // HTTP request failed - will return error (stateless backend)
        let errorMessage = 'HTTP request failed';
        if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
            errorMessage = `HTTP request timeout (${error.config?.timeout || 15000}ms exceeded) - Alfa website is slow`;
        } else if (error.response) {
            errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
        } else if (error.message) {
            errorMessage = error.message;
        }
        
        return {
            success: false,
            data: null,
            error: errorMessage
        };
    }
}

/**
 * Fetch and parse ushare HTML page to extract subscriber information
 * Uses HTTP request only (no Puppeteer - stateless backend)
 * @param {string} adminPhone - Admin phone number (8 digits)
 * @param {Array} cookies - Array of cookie objects
 * @param {boolean} useCache - Whether to use cached data if available (default: true)
 * @returns {Promise<{success: boolean, data: {subscribers: Array, activeCount: number, requestedCount: number, totalCount: number} | null, error: string | null}>}
 */
async function fetchUshareHtml(adminPhone, cookies, useCache = true) {
    // Check cache first (avoids waiting for HTML fetch)
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
    
    // Try HTTP request (stateless - no Puppeteer)
    console.log(`🌐 [Ushare HTML] Fetching subscriber data via HTTP...`);
    const httpResult = await fetchUshareHtmlHttp(adminPhone, cookies);
    if (httpResult.success && httpResult.data) {
        // Save to cache for next time
        await saveCachedUshareData(adminPhone, httpResult.data);
        return httpResult;
    }
    
    // HTTP failed - return error (no Puppeteer fallback - stateless backend)
    console.log(`❌ [Ushare HTML] HTTP request failed: ${httpResult.error}`);
    return {
        success: false,
        data: null,
        error: httpResult.error || 'Failed to fetch Ushare HTML'
    };
}

/**
 * Invalidate cached Ushare HTML data for an admin
 * @param {string} adminPhone - Admin phone number
 */
async function invalidateUshareCache(adminPhone) {
    try {
        const key = `ushare:${adminPhone}`;
        await cacheLayer.delete(key);
        console.log(`🗑️ [Ushare HTML] Invalidated cache for admin ${adminPhone}`);
    } catch (error) {
        console.warn(`⚠️ [Ushare HTML] Failed to invalidate cache:`, error.message);
    }
}

module.exports = {
    fetchUshareHtml,
    invalidateUshareCache
};

