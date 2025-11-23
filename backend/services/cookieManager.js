const cacheLayer = require('./cacheLayer');
const { loginToAlfa } = require('./alfaLogin');
const browserPool = require('./browserPool');

// Cookie TTL: 24 hours (matching session storage to prevent unnecessary logins)
// Alfa cookies may be valid for longer, but we refresh them daily at 6:00 AM
const COOKIE_TTL = 24 * 60 * 60; // 24 hours in seconds (86400)
// REMOVED: MIN_COOKIE_TTL - use actual cookie expiry from Set-Cookie headers
const LAST_JSON_TTL = 60; // 60 seconds TTL for cached data (user:{id}:lastData)
const REFRESH_BUFFER_MS = 45 * 1000; // 45 seconds before expiry (30-60s range)
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
 * Generate Redis key for cookie expiry timestamp
 * @param {string} userId - User ID
 * @returns {string} Redis key
 */
function getCookieExpiryKey(userId) {
    const sanitized = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `user:${sanitized}:cookieExpiry`;
}

/**
 * Generate Redis key for next refresh timestamp
 * @param {string} userId - User ID
 * @returns {string} Redis key
 */
function getNextRefreshKey(userId) {
    const sanitized = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `user:${sanitized}:nextRefresh`;
}

/**
 * Generate Redis key for refresh lock
 * @param {string} userId - User ID
 * @returns {string} Redis key
 */
function getRefreshLockKey(userId) {
    const sanitized = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `user:${sanitized}:refreshLock`;
}

/**
 * Acquire refresh lock (for manual refresh operations)
 * @param {string} userId - User ID
 * @param {number} ttl - Lock TTL in seconds (default: 5 minutes)
 * @returns {Promise<boolean>} True if lock acquired, false if already locked
 */
async function acquireRefreshLock(userId, ttl = 300) {
    try {
        const key = getRefreshLockKey(userId);
        // TTL: 2-5 minutes (default 5 minutes = 300s, but allow 2-5 min range)
        // Try to set lock only if it doesn't exist (NX = only set if not exists)
        const result = await cacheLayer.setNX(key, '1', ttl);
        if (result) {
            console.log(`🔒 [${userId}] Acquired refresh lock (TTL: ${ttl}s)`);
        } else {
            console.log(`⏸️ [${userId}] Refresh lock already exists, skipping...`);
        }
        return result;
    } catch (error) {
        console.warn(`⚠️ Failed to acquire refresh lock for ${userId}:`, error.message);
        return false;
    }
}

/**
 * Release refresh lock
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function releaseRefreshLock(userId) {
    try {
        const key = getRefreshLockKey(userId);
        if (cacheLayer.redis) {
            await cacheLayer.redis.del(key);
            console.log(`🔓 [${userId}] Released refresh lock`);
        }
    } catch (error) {
        console.warn(`⚠️ Failed to release refresh lock for ${userId}:`, error.message);
    }
}

/**
 * Check if refresh lock exists
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} True if lock exists
 */
async function hasRefreshLock(userId) {
    try {
        const key = getRefreshLockKey(userId);
        const value = await cacheLayer.get(key);
        return value === '1' || value === 1;
    } catch (error) {
        return false;
    }
}

/**
 * Get cookie expiry timestamp from Redis
 * @param {string} userId - User ID
 * @returns {Promise<number|null>} Expiry timestamp in milliseconds, or null
 */
async function getCookieExpiry(userId) {
    try {
        const key = getCookieExpiryKey(userId);
        const value = await cacheLayer.get(key);
        if (value) {
            return parseInt(value, 10);
        }
    } catch (error) {
        // Ignore errors
    }
    return null;
}

/**
 * Get next refresh timestamp from Redis
 * @param {string} userId - User ID
 * @returns {Promise<number|null>} Next refresh timestamp in milliseconds, or null
 */
async function getNextRefresh(userId) {
    try {
        const key = getNextRefreshKey(userId);
        const value = await cacheLayer.get(key);
        if (value) {
            return parseInt(value, 10);
        }
    } catch (error) {
        // Ignore errors
    }
    return null;
}

/**
 * Store next refresh timestamp in Redis (both individual key and sorted set)
 * @param {string} userId - User ID
 * @param {number} nextRefreshTimestamp - Next refresh timestamp in milliseconds
 * @returns {Promise<void>}
 */
async function storeNextRefresh(userId, nextRefreshTimestamp) {
    try {
        const nextRefreshKey = getNextRefreshKey(userId);
        const now = Date.now();
        const nextRefreshTtl = Math.max(60, Math.floor((nextRefreshTimestamp - now) / 1000));
        
        if (nextRefreshTtl > 0) {
            // Store in individual key
            await cacheLayer.set(nextRefreshKey, nextRefreshTimestamp.toString(), nextRefreshTtl);
            
            // Update sorted set for adaptive scheduling (refreshSchedule)
            const memberKey = `user:${String(userId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            await cacheLayer.zadd('refreshSchedule', memberKey, nextRefreshTimestamp);
            
            const nextRefreshDate = new Date(nextRefreshTimestamp);
            console.log(`📅 [${userId}] Stored next refresh at ${nextRefreshDate.toISOString()}`);
        } else {
            // Timestamp is in the past, set to now (refresh immediately)
            const immediateRefresh = Date.now();
            await cacheLayer.set(nextRefreshKey, immediateRefresh.toString(), 60);
            
            const memberKey = `user:${String(userId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            await cacheLayer.zadd('refreshSchedule', memberKey, immediateRefresh);
            
            console.log(`📅 [${userId}] Stored immediate refresh (timestamp was in past)`);
        }
    } catch (error) {
        console.error(`❌ Failed to store nextRefresh for ${userId}:`, error.message);
        throw error;
    }
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
        
        // Calculate cookie expiry timestamp (UTC)
        let cookieExpiryTimestamp = null;
        let ttl = COOKIE_TTL;
        
        if (actualExpiration && actualExpiration > 0) {
            // Calculate expiry timestamp: now + expiration seconds
            cookieExpiryTimestamp = Date.now() + (actualExpiration * 1000);
            
            // Use actual expiration for Redis TTL (no minimum enforcement)
            ttl = Math.min(actualExpiration, COOKIE_TTL); // Cap at 24h max, but use actual expiry
            const actualHours = Math.round(actualExpiration / 3600);
            const actualMinutes = Math.round((actualExpiration % 3600) / 60);
            const ttlHours = Math.round(ttl / 3600);
            const ttlMinutes = Math.round((ttl % 3600) / 60);
            console.log(`📅 Cookie expiration: ${actualHours}h ${actualMinutes}m (Alfa) → Redis TTL: ${ttlHours}h ${ttlMinutes}m (actual expiry)`);
        } else {
            // No expiration found, use default
            cookieExpiryTimestamp = Date.now() + (COOKIE_TTL * 1000);
            ttl = COOKIE_TTL;
        }
        
        // Save cookies with TTL matching shortest cookie expiry
        await cacheLayer.set(key, JSON.stringify(cookieData), ttl);
        console.log(`✅ Saved ${cookies.length} cookies to Redis for ${userId} (TTL: ${Math.round(ttl / 60)} minutes)`);
        
        // Store cookie expiry timestamp (user:{id}:cookieExpiry)
        if (cookieExpiryTimestamp) {
            const expiryKey = getCookieExpiryKey(userId);
            const expiryTtl = Math.max(60, Math.floor((cookieExpiryTimestamp - Date.now()) / 1000));
            await cacheLayer.set(expiryKey, cookieExpiryTimestamp.toString(), expiryTtl);
            
            // Calculate and store next refresh time (15 minutes before expiry)
            const nextRefreshTimestamp = cookieExpiryTimestamp - REFRESH_BUFFER_MS;
            const nextRefreshKey = getNextRefreshKey(userId);
            const nextRefreshTtl = Math.max(60, Math.floor((nextRefreshTimestamp - Date.now()) / 1000));
            if (nextRefreshTtl > 0) {
                await cacheLayer.set(nextRefreshKey, nextRefreshTimestamp.toString(), nextRefreshTtl);
                
                // Update sorted set for adaptive scheduling (refreshSchedule)
                const memberKey = `user:${String(userId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                await cacheLayer.zadd('refreshSchedule', memberKey, nextRefreshTimestamp);
                
                const nextRefreshDate = new Date(nextRefreshTimestamp);
                console.log(`📅 Scheduled next refresh for ${userId} at ${nextRefreshDate.toISOString()}`);
            }
        }
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
/**
 * Get last JSON response from Redis
 * @param {string} userId - User ID
 * @param {boolean} allowStale - If true, return cached data even if older than CACHE_WINDOW_MS (for manual refresh)
 * @returns {Promise<Object|null>} Cached JSON data or null
 */
async function getLastJson(userId, allowStale = false) {
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

        const age = Date.now() - (cached.timestamp || 0);

        // Return cached data if:
        // 1. Within cache window (5 seconds) - for background checks
        // 2. allowStale is true - for manual refresh (up to 2 hours old)
        if (age < CACHE_WINDOW_MS || (allowStale && age < 2 * 60 * 60 * 1000)) {
            if (allowStale && age >= CACHE_WINDOW_MS) {
                const ageMinutes = Math.round(age / 60000);
                console.log(`📦 Returning stale cached data (${ageMinutes}min old) for manual refresh`);
            } else {
                console.log(`⚡ Returning cached data (${age}ms old)`);
            }
            // Return the full cached object (with data and timestamp)
            return cached;
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
    getCookiesOrLogin,
    areCookiesExpired,
    calculateMinCookieExpiration,
    acquireRefreshLock,
    releaseRefreshLock,
    hasRefreshLock,
    getCookieExpiry,
    getNextRefresh,
    storeNextRefresh
};

