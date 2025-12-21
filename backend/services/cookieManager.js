const cacheLayer = require('./cacheLayer');
const { loginToAlfa } = require('./alfaLogin');
const browserPool = require('./browserPool');

// Cookie TTL: 24 hours (matching session storage to prevent unnecessary logins)
// Alfa cookies may be valid for longer, but we refresh them daily at 6:00 AM
const COOKIE_TTL = 24 * 60 * 60; // 24 hours in seconds (86400)
// REMOVED: MIN_COOKIE_TTL - use actual cookie expiry from Set-Cookie headers
const LAST_JSON_TTL = 60; // 60 seconds TTL for cached data (user:{id}:lastData)
const REFRESH_BUFFER_MS = 30 * 1000; // Default 30 seconds before expiry
const MIN_REFRESH_BUFFER_MS = 10 * 1000; // Minimum 10 seconds
const MAX_REFRESH_BUFFER_MS = 30 * 1000; // Maximum 30 seconds

/**
 * Calculate dynamic refresh buffer based on cookie lifetime
 * Returns 20% of remaining time, clamped between MIN and MAX
 * @param {number} cookieExpiry - Cookie expiry timestamp (ms)
 * @param {number} now - Current timestamp (ms)
 * @returns {number} Refresh buffer in milliseconds
 */
function calculateDynamicRefreshBuffer(cookieExpiry, now) {
    if (!cookieExpiry || cookieExpiry <= now) {
        return REFRESH_BUFFER_MS; // Default if expired or invalid
    }
    
    const remainingTime = cookieExpiry - now;
    const dynamicBuffer = Math.floor(remainingTime * 0.2); // 20% of remaining time
    
    // Clamp between MIN and MAX
    return Math.max(MIN_REFRESH_BUFFER_MS, Math.min(MAX_REFRESH_BUFFER_MS, dynamicBuffer));
}
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
        
        // Get cookie expiry to ensure nextRefresh is BEFORE expiry
        const cookieExpiry = await getCookieExpiry(userId);
        
        // CRITICAL: Ensure nextRefresh is always BEFORE expiry (never at or after)
        let finalNextRefresh = nextRefreshTimestamp;
        if (cookieExpiry) {
            // IMPROVEMENT: Use dynamic refresh buffer (20% of remaining time, clamped 10-30s)
            const dynamicBuffer = calculateDynamicRefreshBuffer(cookieExpiry, now);
            const minNextRefresh = cookieExpiry - dynamicBuffer;
            if (finalNextRefresh >= cookieExpiry) {
                // nextRefresh is at or after expiry - set to dynamic buffer before expiry
                finalNextRefresh = minNextRefresh;
                console.log(`⚠️ [${userId}] Adjusted nextRefresh to be BEFORE expiry (was at/after expiry)`);
            } else if (finalNextRefresh > minNextRefresh) {
                // nextRefresh is too close to expiry - set to dynamic buffer before expiry
                finalNextRefresh = minNextRefresh;
                const dynamicBuffer = calculateDynamicRefreshBuffer(cookieExpiry, now);
                console.log(`⚠️ [${userId}] Adjusted nextRefresh to be ${Math.round(dynamicBuffer/1000)}s before expiry (dynamic buffer)`);
            }
        }
        
        // Clamp to now+10s minimum (never schedule in the past, minimum 10s in future)
        const minNextRefresh = now + (10 * 1000); // 10 seconds minimum
        if (finalNextRefresh < minNextRefresh) {
            finalNextRefresh = minNextRefresh;
        }
        
        // Prevent double scheduling: check if current nextRefresh differs by <5s
        const currentNextRefresh = await getNextRefresh(userId);
        if (currentNextRefresh) {
            const diff = Math.abs(finalNextRefresh - currentNextRefresh);
            if (diff < 5000) {
                // Less than 5s difference - skip update to prevent double scheduling
                console.log(`⏭️ [${userId}] Skipping nextRefresh update (diff: ${diff}ms < 5s threshold)`);
                return;
            }
        }
        
        const nextRefreshTtl = Math.max(60, Math.floor((finalNextRefresh - now) / 1000));
        if (nextRefreshTtl > 0) {
            // Store in individual key
            await cacheLayer.set(nextRefreshKey, finalNextRefresh.toString(), nextRefreshTtl);
            
            // Update sorted set for adaptive scheduling (refreshSchedule)
            const memberKey = `user:${String(userId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            await cacheLayer.zadd('refreshSchedule', memberKey, finalNextRefresh);
            
            const nextRefreshDate = new Date(finalNextRefresh);
            if (cookieExpiry) {
                const timeUntilExpiry = Math.round((cookieExpiry - finalNextRefresh) / 1000);
                console.log(`📅 [${userId}] Stored next refresh at ${nextRefreshDate.toISOString()} (${timeUntilExpiry}s before expiry)`);
            } else {
                console.log(`📅 [${userId}] Stored next refresh at ${nextRefreshDate.toISOString()}`);
            }
        } else {
            // Timestamp is in the past, set to now+10s (minimum future time)
            const immediateRefresh = now + (10 * 1000);
            await cacheLayer.set(nextRefreshKey, immediateRefresh.toString(), 60);
            
            const memberKey = `user:${String(userId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            await cacheLayer.zadd('refreshSchedule', memberKey, immediateRefresh);
            
            console.log(`📅 [${userId}] Stored immediate refresh (timestamp was in past, set to now+10s)`);
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
 * Filter cookies to only keep long-lived authentication cookies
 * CRITICAL: Only save __ACCOUNT cookies (long-lived, 72 hours), exclude ASP.NET session cookies (short-lived)
 * @param {Array} cookies - Array of cookie objects
 * @returns {Array} Filtered array of cookies
 */
function filterCookies(cookies) {
    if (!cookies || !Array.isArray(cookies)) {
        return [];
    }
    
    // CRITICAL: Only keep __ACCOUNT cookies (long-lived authentication cookies)
    // Exclude ASP.NET session cookies (they expire quickly and cause issues)
    const allowedCookies = cookies.filter(cookie => {
        const name = cookie.name || '';
        // Keep __ACCOUNT cookie (long-lived, 72 hours)
        if (name === '__ACCOUNT') {
            return true;
        }
        // Exclude ASP.NET session cookies (they expire quickly)
        if (name.startsWith('ASP.NET_')) {
            return false;
        }
        // Exclude other short-lived session cookies
        if (name.includes('Session') || name.includes('SESSION') || name.includes('session')) {
            return false;
        }
        // Keep other authentication cookies that might be needed (be conservative)
        return true;
    });
    
    if (allowedCookies.length !== cookies.length) {
        const excluded = cookies.length - allowedCookies.length;
        console.log(`🔍 [Cookie Filter] Filtered ${excluded} cookie(s) (kept ${allowedCookies.length} long-lived cookies, excluded ASP.NET/session cookies)`);
    }
    
    // CRITICAL: Ensure __ACCOUNT cookie exists
    const hasAccountCookie = allowedCookies.some(c => c.name === '__ACCOUNT');
    if (!hasAccountCookie && cookies.length > 0) {
        console.warn(`⚠️ [Cookie Filter] WARNING: No __ACCOUNT cookie found after filtering! Original cookies: ${cookies.map(c => c.name).join(', ')}`);
    }
    
    return allowedCookies;
}

/**
 * Save cookies to Redis
 * CRITICAL: Only saves __ACCOUNT cookies (long-lived), excludes ASP.NET session cookies
 * @param {string} userId - User ID
 * @param {Array} cookies - Array of cookie objects
 * @returns {Promise<void>}
 */
async function saveCookies(userId, cookies) {
    try {
        // CRITICAL: Filter cookies to only keep long-lived __ACCOUNT cookies
        const filteredCookies = filterCookies(cookies);
        
        if (filteredCookies.length === 0) {
            console.error(`❌ [${userId}] No cookies to save after filtering! Original: ${cookies.length} cookie(s)`);
            throw new Error('No valid cookies to save (missing __ACCOUNT cookie)');
        }
        
        const key = getCookieKey(userId);
        const cookieData = {
            cookies: filteredCookies, // Use filtered cookies
            savedAt: Date.now()
        };
        
        // Calculate actual cookie expiration from Alfa (use filtered cookies)
        // CRITICAL: Use __ACCOUNT cookie expiry (72 hours), not ASP.NET session cookie expiry
        const actualExpiration = calculateMinCookieExpiration(filteredCookies);
        
        // Calculate cookie expiry timestamp in UTC (expiryUTC)
        // All expiry calculations use UTC timestamps
        let cookieExpiryTimestamp = null; // This is expiryUTC (UTC timestamp in milliseconds)
        let ttl = COOKIE_TTL;
        
        if (actualExpiration && actualExpiration > 0) {
            // Calculate expiryUTC timestamp: now (UTC) + expiration seconds
            // Date.now() returns UTC timestamp, so cookieExpiryTimestamp is in UTC
            cookieExpiryTimestamp = Date.now() + (actualExpiration * 1000);
            
            // Use actual expiration for Redis TTL (no minimum enforcement)
            // Handle short-lived cookies (e.g., 60 seconds) correctly
            ttl = Math.min(actualExpiration, COOKIE_TTL); // Cap at 24h max, but use actual expiry
            
            // Log expiration details (handle both short and long-lived cookies)
            if (actualExpiration < 120) {
                // Short-lived cookie (e.g., 60 seconds)
                console.log(`📅 Cookie expiration: ${actualExpiration}s (Alfa) → Redis TTL: ${ttl}s (short-lived cookie)`);
            } else {
                const actualHours = Math.round(actualExpiration / 3600);
                const actualMinutes = Math.round((actualExpiration % 3600) / 60);
                const ttlHours = Math.round(ttl / 3600);
                const ttlMinutes = Math.round((ttl % 3600) / 60);
                console.log(`📅 Cookie expiration: ${actualHours}h ${actualMinutes}m (Alfa) → Redis TTL: ${ttlHours}h ${ttlMinutes}m (actual expiry)`);
            }
        } else {
            // No expiration found, use default
            cookieExpiryTimestamp = Date.now() + (COOKIE_TTL * 1000);
            ttl = COOKIE_TTL;
            console.log(`⚠️ [${userId}] No cookie expiration found, using default TTL: ${COOKIE_TTL}s`);
        }
        
        // Save cookies with TTL matching shortest cookie expiry
        // Check if Redis is available before attempting save
        if (!cacheLayer.isAvailable()) {
            console.warn(`⚠️ Redis not available - cookies will not persist for ${userId} (available in memory for this request only)`);
        } else {
            const saveResult = await cacheLayer.set(key, JSON.stringify(cookieData), ttl);
            if (saveResult) {
                const accountCookie = filteredCookies.find(c => c.name === '__ACCOUNT');
                const accountInfo = accountCookie ? ` (__ACCOUNT cookie saved)` : ` (⚠️ no __ACCOUNT cookie!)`;
                console.log(`✅ Saved ${filteredCookies.length} cookie(s) to Redis for ${userId} (TTL: ${Math.round(ttl / 60)} minutes)${accountInfo}`);
            } else {
                console.warn(`⚠️ Failed to save cookies to Redis for ${userId} - Redis may not be available`);
            }
        }
        
        // Store cookie expiry timestamp (user:{id}:cookieExpiry)
        // Only save expiry/refresh schedule if Redis is available
        if (cookieExpiryTimestamp && cacheLayer.isAvailable()) {
            const expiryKey = getCookieExpiryKey(userId);
            const expiryTtl = Math.max(60, Math.floor((cookieExpiryTimestamp - Date.now()) / 1000));
            await cacheLayer.set(expiryKey, cookieExpiryTimestamp.toString(), expiryTtl);
            
            // IMPROVEMENT: Calculate dynamic refresh buffer (20% of remaining time, clamped 10-30s)
            const now = Date.now();
            const dynamicBuffer = calculateDynamicRefreshBuffer(cookieExpiryTimestamp, now);
            let nextRefreshTimestamp = cookieExpiryTimestamp - dynamicBuffer;
            
            // CRITICAL: Ensure nextRefresh is always BEFORE expiry (never at or after)
            if (nextRefreshTimestamp >= cookieExpiryTimestamp) {
                // Safety check: set to dynamic buffer before expiry
                const dynamicBuffer = calculateDynamicRefreshBuffer(cookieExpiryTimestamp, now);
                nextRefreshTimestamp = cookieExpiryTimestamp - dynamicBuffer;
            }
            
            // Clamp to now+10s minimum (never schedule in the past, minimum 10s in future)
            const minNextRefresh = now + (10 * 1000); // 10 seconds minimum
            if (nextRefreshTimestamp < minNextRefresh) {
                nextRefreshTimestamp = minNextRefresh;
            }
            
            const nextRefreshKey = getNextRefreshKey(userId);
            const nextRefreshTtl = Math.max(60, Math.floor((nextRefreshTimestamp - Date.now()) / 1000));
            if (nextRefreshTtl > 0) {
                await cacheLayer.set(nextRefreshKey, nextRefreshTimestamp.toString(), nextRefreshTtl);
                
                // Update sorted set for adaptive scheduling (refreshSchedule)
                const memberKey = `user:${String(userId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                await cacheLayer.zadd('refreshSchedule', memberKey, nextRefreshTimestamp);
                
                const nextRefreshDate = new Date(nextRefreshTimestamp);
                const timeUntilExpiry = Math.round((cookieExpiryTimestamp - nextRefreshTimestamp) / 1000);
                console.log(`📅 Scheduled next refresh for ${userId} at ${nextRefreshDate.toISOString()} (${timeUntilExpiry}s before expiry)`);
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
    const timestamp = new Date().toISOString();
    console.log(`🔐 [${timestamp}] Logging in to get fresh cookies for ${userId}...`);
    
    const { loginViaHttp, loginToAlfa } = require('./alfaLogin');
    const { solveCaptcha, isCaptchaServiceAvailable } = require('./captchaService');
    let context = null;
    let page = null;

    try {
        // OPTIMIZATION: Try fast HTTP login first (2-5s vs 10-20s with Puppeteer)
        console.log(`⚡ [Fast Login] Attempting HTTP-based login first...`);
        const httpResult = await loginViaHttp(phone, password, userId);
        
        if (httpResult.success && httpResult.cookies && httpResult.cookies.length > 0) {
            // Check if __ACCOUNT cookie is present (critical for long-lived sessions)
            const hasAccountCookie = httpResult.cookies.some(c => c.name === '__ACCOUNT');
            
            if (!hasAccountCookie) {
                console.log(`⚠️ [Fast Login] HTTP login got ${httpResult.cookies.length} cookies but missing __ACCOUNT cookie, falling back to Puppeteer for complete session...`);
                httpResult.fallback = true; // Force fallback
            } else {
                // HTTP login succeeded and has __ACCOUNT cookie!
                console.log(`✅ [Fast Login] HTTP login successful! Saving ${httpResult.cookies.length} cookies (including __ACCOUNT)...`);
                
                // Save all cookies to Redis
                await saveCookies(userId, httpResult.cookies);
                await saveLastVerified(userId);
                
                console.log(`✅ Login successful via HTTP, saved ${httpResult.cookies.length} cookies`);
                return httpResult.cookies;
            }
        }
        
        // HTTP login failed or CAPTCHA detected
        const needsCaptcha = httpResult.needsCaptcha === true;
        const fallbackReason = needsCaptcha ? 'CAPTCHA detected' : 'HTTP login failed';
        
        // Try CAPTCHA service first (if available)
        if (needsCaptcha && isCaptchaServiceAvailable()) {
            console.log(`🔧 [LoginFallback] Attempting CAPTCHA solving service for admin ${userId} (${phone})...`);
            try {
                const captchaResult = await solveCaptcha(userId, phone, null, { httpResult });
                if (captchaResult.success && captchaResult.cookies) {
                    console.log(`✅ [LoginFallback] CAPTCHA solved successfully via service`);
                    await saveCookies(userId, captchaResult.cookies);
                    await saveLastVerified(userId);
                    return captchaResult.cookies;
                }
                console.log(`⚠️ [LoginFallback] CAPTCHA service failed, falling back to Puppeteer`);
            } catch (captchaError) {
                console.warn(`⚠️ [LoginFallback] CAPTCHA service error: ${captchaError.message}, falling back to Puppeteer`);
            }
        }
        
        // Fallback to Puppeteer (for CAPTCHA or if HTTP fails)
        // TODO: Remove Puppeteer fallback once captchaService.js is fully implemented and tested
        const timestamp2 = new Date().toISOString();
        console.log(`⚠️ [LoginFallback] [${timestamp2}] Puppeteer triggered for admin ${userId} (${phone}) - Reason: ${fallbackReason}`);
        console.log(`   TODO: Remove Puppeteer once captchaService.js is implemented`);
        
        const contextData = await browserPool.getOrCreateContext();
        context = contextData.context;
        page = contextData.page;

        // Perform login with Puppeteer
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

        const timestamp3 = new Date().toISOString();
        console.log(`✅ [LoginFallback] [${timestamp3}] Login successful via Puppeteer for admin ${userId} (${phone}), saved ${cookies.length} cookies`);
        console.log(`   TODO: Remove Puppeteer once captchaService.js is fully implemented`);
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
    storeNextRefresh,
    filterCookies // Export for testing
};

