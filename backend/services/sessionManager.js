const cacheLayer = require('./cacheLayer');

// Session expiry: default 30 days, configurable via SESSION_EXPIRY_DAYS env var
// Set to 0 or -1 for no expiration (sessions never expire)
const SESSION_EXPIRY_DAYS = parseInt(process.env.SESSION_EXPIRY_DAYS);
let SESSION_TTL = 0; // Default: no expiration
if (SESSION_EXPIRY_DAYS && SESSION_EXPIRY_DAYS > 0) {
    SESSION_TTL = SESSION_EXPIRY_DAYS * 24 * 60 * 60; // Convert to seconds
}

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
 * Get saved session for an admin from Redis
 * @param {string} adminId - Admin ID (phone number or document ID)
 * @returns {Promise<{cookies: Array, tokens: Object} | null>}
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

        console.log(`✅ Retrieved session from Redis for ${adminId} (${sessionData.cookies.length} cookies)`);
        return {
            cookies: sessionData.cookies,
            tokens: sessionData.tokens || {},
            savedAt: sessionData.savedAt || sessionData.timestamp
        };
    } catch (error) {
        // Redis errors should not crash - fallback to login
        console.warn(`⚠️ Redis get session error for ${adminId}:`, error.message);
        return null;
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

        if (SESSION_TTL === 0) {
            // No expiration - use SET
            await cacheLayer.redis.set(key, value);
            console.log(`✅ Session saved to Redis for ${adminId} (no expiration, ${cookies.length} cookies, old session deleted)`);
        } else {
            // With TTL - use SETEX
            await cacheLayer.redis.setex(key, SESSION_TTL, value);
            const days = Math.round(SESSION_TTL / (24 * 60 * 60));
            console.log(`✅ Session saved to Redis for ${adminId} (TTL: ${days} days, ${cookies.length} cookies, old session deleted)`);
        }
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

