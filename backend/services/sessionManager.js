const cacheLayer = require('./cacheLayer');

// Session expiry: 30 days (sessions should persist indefinitely unless they fail)
// This ensures sessions persist for a very long time
// Can be overridden via SESSION_EXPIRY_HOURS env var
const SESSION_EXPIRY_HOURS = parseInt(process.env.SESSION_EXPIRY_HOURS) || 720; // 30 days = 720 hours
const SESSION_TTL = SESSION_EXPIRY_HOURS * 60 * 60; // Convert to seconds (2592000 for 30 days)

/**
 * Generate Redis key for session
 * @param {string} adminId - Admin ID
 * @returns {string} Redis key
 */
function generateSessionKey(adminId) {
    const sanitized = String(adminId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `user:${sanitized}:session`;
}

/**
 * Check if cookies are actually expired (not just expiring soon)
 * We only mark as expired if cookies are actually past their expiry date
 * Sessions should persist indefinitely unless they actually fail
 * @param {Array} cookies - Array of cookie objects
 * @returns {boolean} True if cookies are actually expired (not just expiring soon)
 */
function areCookiesExpiring(cookies) {
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
        return true; // No cookies = expired
    }

    const now = Date.now();

    // Check each cookie's expiration
    for (const cookie of cookies) {
        if (cookie.expires) {
            // Cookie expiration can be:
            // - Unix timestamp (seconds)
            // - Unix timestamp (milliseconds)
            // - Date string
            let expiryTime;
            
            if (typeof cookie.expires === 'number') {
                // If it's a number, check if it's seconds or milliseconds
                expiryTime = cookie.expires < 10000000000 ? cookie.expires * 1000 : cookie.expires;
            } else if (typeof cookie.expires === 'string') {
                expiryTime = new Date(cookie.expires).getTime();
            } else {
                continue; // Skip if we can't parse
            }

            // Only return true if cookie is ACTUALLY expired (past expiry date)
            // Don't check for "expiring soon" - we want sessions to persist
            const timeUntilExpiry = expiryTime - now;
            if (timeUntilExpiry <= 0) {
                return true; // Already expired
            }
            // Don't check for "expiring soon" - let sessions persist until they actually expire
        }
    }

    return false; // Cookies are still valid (not expired)
}

/**
 * Get saved session for an admin from Redis
 * @param {string} adminId - Admin ID (phone number or document ID)
 * @returns {Promise<{cookies: Array, tokens: Object, savedAt: number, needsRefresh: boolean} | null>}
 */
async function getSession(adminId) {
    // Fallback to null if Redis is not available
    if (!cacheLayer.isAvailable()) {
        console.log('⚠️ Redis not available, cannot retrieve session');
        return null;
    }

    try {
        const key = generateSessionKey(adminId);
        // Access Redis instance from cacheLayer
        if (!cacheLayer.redis) {
            return null;
        }
        const cached = await cacheLayer.redis.get(key);
        
        if (!cached) {
            return null;
        }

        // Parse JSON session data
        let sessionData;
        if (typeof cached === 'string') {
            try {
                sessionData = JSON.parse(cached);
            } catch (parseError) {
                console.warn(`⚠️ Failed to parse session data for ${adminId}:`, parseError.message);
                return null;
            }
        } else if (typeof cached === 'object' && cached !== null) {
            sessionData = cached;
        } else {
            return null;
        }

        // Validate session structure
        if (!sessionData.cookies || !Array.isArray(sessionData.cookies)) {
            console.warn(`⚠️ Invalid session structure for ${adminId}`);
            return null;
        }

        // Don't return failed or partial sessions
        if (sessionData.failed || sessionData.error) {
            console.log(`⚠️ Session for ${adminId} is marked as failed, ignoring`);
            return null;
        }

        // Only mark as needsRefresh if cookies are ACTUALLY expired (not just expiring soon)
        // Sessions should persist indefinitely unless they actually fail
        const needsRefresh = areCookiesExpiring(sessionData.cookies);
        
        if (needsRefresh) {
            console.log(`⚠️ Session for ${adminId} has expired cookies, will refresh on next use`);
        }

        console.log(`✅ Retrieved session from Redis for ${adminId} (${sessionData.cookies.length} cookies${needsRefresh ? ', expired - will refresh' : ', valid'})`);
        return {
            cookies: sessionData.cookies,
            tokens: sessionData.tokens || {},
            savedAt: sessionData.savedAt || sessionData.timestamp,
            needsRefresh: needsRefresh
        };
    } catch (error) {
        // Redis errors should not crash - fallback to login
        console.warn(`⚠️ Redis get session error for ${adminId}:`, error.message);
        return null;
    }
}

/**
 * Delete session for an admin from Redis
 * @param {string} adminId - Admin ID
 * @returns {Promise<boolean>} Success status
 */
async function deleteSession(adminId) {
    if (!cacheLayer.isAvailable()) {
        return false;
    }

    try {
        const key = generateSessionKey(adminId);
        if (!cacheLayer.redis) {
            return false;
        }

        await cacheLayer.redis.del(key);
        return true;
    } catch (error) {
        console.warn(`⚠️ Redis delete session error for ${adminId}:`, error.message);
        return false;
    }
}

/**
 * Save session for an admin to Redis
 * @param {string} adminId - Admin ID
 * @param {Array} cookies - Array of cookie objects
 * @param {Object} tokens - Optional tokens object
 */
async function saveSession(adminId, cookies, tokens = {}) {
    // Don't cache failed or partial sessions
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
        console.log(`⚠️ Not saving invalid session for ${adminId}`);
        return;
    }

    // Fallback to in-memory if Redis is not available
    if (!cacheLayer.isAvailable()) {
        console.warn('⚠️ Redis not available, session will not persist across restarts');
        return;
    }

    try {
        const key = generateSessionKey(adminId);
        
        // Delete old session first to prevent Redis from growing with useless data
        // This ensures we only keep the latest session for each user
        try {
            await cacheLayer.redis.del(key);
        } catch (delError) {
            // Ignore delete errors - key might not exist
        }
        
        const sessionData = {
            cookies: cookies,
            tokens: tokens,
            savedAt: Date.now(),
            timestamp: Date.now() // For backward compatibility
        };

        const value = JSON.stringify(sessionData);

        // Always use SETEX with 24-hour TTL
        await cacheLayer.redis.setex(key, SESSION_TTL, value);
        const hours = Math.round(SESSION_TTL / (60 * 60));
        console.log(`✅ Session saved to Redis for ${adminId} (TTL: ${hours} hours, ${cookies.length} cookies, old session deleted)`);
    } catch (error) {
        // Redis errors should not crash - log and continue
        console.warn(`⚠️ Redis save session error for ${adminId}:`, error.message);
        // Don't throw - session save failure shouldn't break the login flow
    }
}

/**
 * Delete session for an admin from Redis
 * @param {string} adminId - Admin ID
 */
async function deleteSession(adminId) {
    if (!cacheLayer.isAvailable()) {
        return;
    }

    try {
        const key = generateSessionKey(adminId);
        await cacheLayer.redis.del(key);
        console.log(`✅ Session deleted from Redis for ${adminId}`);
    } catch (error) {
        console.warn(`⚠️ Redis delete session error for ${adminId}:`, error.message);
    }
}

/**
 * Clean up old/invalid sessions for a user
 * This is called automatically when saving new sessions, but can be called manually
 * @param {string} adminId - Admin ID
 * @returns {Promise<boolean>} Success status
 */
async function cleanupOldSession(adminId) {
    if (!cacheLayer.isAvailable()) {
        return false;
    }

    try {
        const key = generateSessionKey(adminId);
        // Check if session exists and is old/invalid
        const session = await cacheLayer.redis.get(key);
        if (session) {
            try {
                const sessionData = typeof session === 'string' ? JSON.parse(session) : session;
                // Delete if session is marked as failed or has error
                if (sessionData.failed || sessionData.error) {
                    await cacheLayer.redis.del(key);
                    console.log(`🗑️ Cleaned up invalid session for ${adminId}`);
                    return true;
                }
            } catch (parseError) {
                // If we can't parse, delete it as it's corrupted
                await cacheLayer.redis.del(key);
                console.log(`🗑️ Cleaned up corrupted session for ${adminId}`);
                return true;
            }
        }
        return false;
    } catch (error) {
        console.warn(`⚠️ Error cleaning up session for ${adminId}:`, error.message);
        return false;
    }
}

/**
 * Check if session exists in Redis
 * @param {string} adminId - Admin ID
 * @returns {Promise<boolean>}
 */
async function hasSession(adminId) {
    if (!cacheLayer.isAvailable()) {
        return false;
    }

    try {
        const key = generateSessionKey(adminId);
        if (!cacheLayer.redis) {
            return false;
        }
        const exists = await cacheLayer.redis.exists(key);
        return exists === 1;
    } catch (error) {
        return false;
    }
}

module.exports = {
    getSession,
    saveSession,
    deleteSession,
    hasSession,
    cleanupOldSession
};

