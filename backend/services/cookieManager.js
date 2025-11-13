const cacheLayer = require('./cacheLayer');
const { loginToAlfa } = require('./alfaLogin');
const browserPool = require('./browserPool');

// Cookie TTL: 24 hours (matching session storage to prevent unnecessary logins)
// Alfa cookies may be valid for longer, but we refresh them daily at 6:00 AM
const COOKIE_TTL = 24 * 60 * 60; // 24 hours in seconds (86400)
const MIN_COOKIE_TTL = 60 * 60; // Minimum 1 hour TTL (even if cookies expire sooner, we can refresh them)
const LAST_JSON_TTL = 5 * 60; // 5 minutes in seconds
const CACHE_WINDOW_MS = 5 * 1000; // 5 seconds

/**
 * Generate Redis key for cookies
 * @param {string} userId - User ID
 * @returns {string} Redis key
 */
function getCookieKey(userId) {
    const sanitized = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `user:${sanitized}:cookies`;
}

/**
 * Generate Redis key for last JSON response
 * @param {string} userId - User ID
 * @returns {string} Redis key
 */
function getLastJsonKey(userId) {
    const sanitized = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `user:${sanitized}:lastJson`;
}

/**
 * Generate Redis key for last verified timestamp
 * @param {string} userId - User ID
 * @returns {string} Redis key
 */
function getLastVerifiedKey(userId) {
    const sanitized = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `user:${sanitized}:lastVerifiedAt`;
}

/**
 * Calculate the minimum expiration time from cookies (in seconds)
 * Returns the shortest expiration time, or null if no expiration found
 * @param {Array} cookies - Array of cookie objects
 * @returns {number|null} Minimum expiration time in seconds, or null
 */
function calculateMinCookieExpiration(cookies) {
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
        return null;
    }

    const now = Date.now();
    let minExpiration = null;

    for (const cookie of cookies) {
        if (!cookie.expires) continue;

        let expiryTime;
        if (typeof cookie.expires === 'number') {
            expiryTime = cookie.expires < 10000000000 ? cookie.expires * 1000 : cookie.expires;
        } else if (typeof cookie.expires === 'string') {
            expiryTime = new Date(cookie.expires).getTime();
        } else {
            continue;
        }

        const secondsUntilExpiry = Math.floor((expiryTime - now) / 1000);
        if (secondsUntilExpiry > 0) {
            if (minExpiration === null || secondsUntilExpiry < minExpiration) {
                minExpiration = secondsUntilExpiry;
            }
        }
    }

    return minExpiration;
}

/**
 * Save cookies to Redis
 * @param {string} userId - User ID
 * @param {Array} cookies - Array of cookie objects
 * @returns {Promise<void>}
 */
async function saveCookies(userId, cookies) {
    try {
        const key = getCookieKey(userId);
        const cookieData = {
            cookies: cookies,
            savedAt: Date.now()
        };
        
        // Calculate actual cookie expiration from Alfa
        const actualExpiration = calculateMinCookieExpiration(cookies);
        
        // Use the shorter of: actual cookie expiration or default TTL (24 hours)
        // BUT: Use minimum TTL of 1 hour to prevent cookies from disappearing too quickly
        // Even if Alfa cookies expire in 1 minute, we keep them in Redis for 1 hour
        // and refresh them before they expire
        let ttl = COOKIE_TTL;
        if (actualExpiration && actualExpiration > 0) {
            // Use actual expiration, but enforce minimum
            ttl = Math.max(Math.min(actualExpiration, COOKIE_TTL), MIN_COOKIE_TTL);
            const actualHours = Math.round(actualExpiration / 3600);
            const actualMinutes = Math.round((actualExpiration % 3600) / 60);
            const ttlHours = Math.round(ttl / 3600);
            const ttlMinutes = Math.round((ttl % 3600) / 60);
            console.log(`📅 Cookie expiration: ${actualHours}h ${actualMinutes}m (Alfa) → Redis TTL: ${ttlHours}h ${ttlMinutes}m (min ${Math.round(MIN_COOKIE_TTL / 60)}m enforced)`);
        } else {
            // No expiration found, use default
            ttl = COOKIE_TTL;
        }
        
        await cacheLayer.set(key, JSON.stringify(cookieData), ttl);
        console.log(`✅ Saved ${cookies.length} cookies to Redis for ${userId} (TTL: ${Math.round(ttl / 60)} minutes)`);
    } catch (error) {
        console.error(`❌ Failed to save cookies for ${userId}:`, error.message);
        throw error;
    }
}


/**
 * Save last JSON response to Redis
 * @param {string} userId - User ID
 * @param {Object} jsonData - JSON data to cache
 * @returns {Promise<void>}
 */
async function saveLastJson(userId, jsonData) {
    try {
        const key = getLastJsonKey(userId);
        const data = {
            data: jsonData,
            timestamp: Date.now()
        };
        await cacheLayer.set(key, JSON.stringify(data), LAST_JSON_TTL);
    } catch (error) {
        console.warn(`⚠️ Failed to save lastJson for ${userId}:`, error.message);
    }
}

/**
 * Get last JSON response from Redis if within cache window
 * @param {string} userId - User ID
 * @returns {Promise<Object|null>} Cached JSON data or null
 */
async function getLastJson(userId) {
    try {
        const key = getLastJsonKey(userId);
        const data = await cacheLayer.get(key);
        
        if (!data) {
            return null;
        }

        // Handle both string (JSON) and already-parsed object cases
        let cached;
        if (typeof data === 'string') {
            cached = JSON.parse(data);
        } else if (typeof data === 'object' && data !== null) {
            // Already parsed by Redis client
            cached = data;
        } else {
            console.warn(`⚠️ Unexpected data type for lastJson: ${typeof data}`);
            return null;
        }

        const age = Date.now() - cached.timestamp;

        // Only return if within cache window (5 seconds)
        if (age < CACHE_WINDOW_MS) {
            console.log(`⚡ Returning cached data (${age}ms old)`);
            return cached.data;
        }

        return null;
    } catch (error) {
        console.warn(`⚠️ Failed to get lastJson for ${userId}:`, error.message);
        return null;
    }
}

/**
 * Save last verified timestamp
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function saveLastVerified(userId) {
    try {
        const key = getLastVerifiedKey(userId);
        await cacheLayer.set(key, Date.now().toString(), LAST_JSON_TTL);
    } catch (error) {
        console.warn(`⚠️ Failed to save lastVerifiedAt for ${userId}:`, error.message);
    }
}

/**
 * Perform login and save cookies
 * @param {string} phone - Phone number
 * @param {string} password - Password
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of cookie objects
 */
async function loginAndSaveCookies(phone, password, userId) {
    console.log(`🔐 Logging in to get fresh cookies for ${userId}...`);
    
    let context = null;
    let page = null;

    try {
        // Get a new browser context
        const contextData = await browserPool.createContext();
        context = contextData.context;
        page = contextData.page;

        // Perform login
        const loginResult = await loginToAlfa(page, phone, password, userId);
        
        if (!loginResult.success) {
            throw new Error('Login failed');
        }

        // Get cookies after login
        const cookies = await page.cookies();
        
        if (!cookies || cookies.length === 0) {
            throw new Error('No cookies received after login');
        }

        // Save all cookies to Redis (Alfa may use various cookies for authentication)
        await saveCookies(userId, cookies);
        await saveLastVerified(userId);

        console.log(`✅ Login successful, saved ${cookies.length} cookies`);
        return cookies;
    } catch (error) {
        console.error(`❌ Login failed for ${userId}:`, error.message);
        throw error;
    } finally {
        // Clean up browser context
        if (context) {
            try {
                await browserPool.closeContext(context);
            } catch (closeError) {
                console.warn('⚠️ Error closing context:', closeError.message);
            }
        }
    }
}

/**
 * Check if cookies are expired (based on Alfa's expiration, not Redis TTL)
 * @param {Array} cookies - Array of cookie objects
 * @returns {boolean} True if cookies are expired
 */
function areCookiesExpired(cookies) {
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
        return true;
    }

    const now = Date.now();
    for (const cookie of cookies) {
        if (cookie.expires) {
            let expiryTime;
            if (typeof cookie.expires === 'number') {
                expiryTime = cookie.expires < 10000000000 ? cookie.expires * 1000 : cookie.expires;
            } else if (typeof cookie.expires === 'string') {
                expiryTime = new Date(cookie.expires).getTime();
            } else {
                continue;
            }

            // If any cookie is expired, consider all cookies expired
            if (expiryTime <= now) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Get cookies from Redis (doesn't perform login - use getCookiesOrLogin for that)
 * @param {string} userId - User ID
 * @returns {Promise<Array|null>} Array of cookie objects or null
 */
async function getCookies(userId) {
    try {
        // First, try cookieManager storage (user:{id}:cookies)
        const key = getCookieKey(userId);
        const data = await cacheLayer.get(key);
        
        if (data) {
            // Handle both string (JSON) and already-parsed object cases
            let cookieData;
            if (typeof data === 'string') {
                cookieData = JSON.parse(data);
            } else if (typeof data === 'object' && data !== null) {
                // Already parsed by Redis client
                cookieData = data;
            } else {
                console.warn(`⚠️ Unexpected data type for cookies: ${typeof data}`);
                return null;
            }

            const cookies = cookieData.cookies || null;
            if (cookies && cookies.length > 0) {
                return cookies;
            }
        }

        // Fallback: Try sessionManager storage (user:{id}:session)
        // This handles cases where cookies were saved by browser scraping flow
        try {
            const sessionManager = require('./sessionManager');
            const session = await sessionManager.getSession(userId);
            if (session && session.cookies && session.cookies.length > 0) {
                console.log(`✅ Found ${session.cookies.length} cookies in sessionManager storage for ${userId} (fallback)`);
                // Copy cookies to cookieManager storage for future use
                await saveCookies(userId, session.cookies);
                return session.cookies;
            }
        } catch (sessionError) {
            // Ignore session manager errors - it's just a fallback
        }

        return null;
    } catch (error) {
        console.warn(`⚠️ Failed to get cookies for ${userId}:`, error.message);
        return null;
    }
}

/**
 * Get cookies, performing login if necessary
 * @param {string} phone - Phone number
 * @param {string} password - Password
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of cookie objects
 */
async function getCookiesOrLogin(phone, password, userId) {
    // Try to get existing cookies first
    let cookies = await getCookies(userId);
    
    // If no cookies, perform login
    if (!cookies || cookies.length === 0) {
        console.log(`⚠️ No cookies found for ${userId}, performing login...`);
        cookies = await loginAndSaveCookies(phone, password, userId);
    } else {
        console.log(`✅ Found ${cookies.length} cookies, using them for login...`);
    }
    
    return cookies;
}

module.exports = {
    saveCookies,
    getCookies,
    saveLastJson,
    getLastJson,
    saveLastVerified,
    loginAndSaveCookies,
    getCookiesOrLogin
};

