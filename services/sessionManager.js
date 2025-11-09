// In-memory session storage for cookies
const memorySessions = new Map();
const SESSION_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get saved session for an admin
 * @param {string} adminId - Admin ID (phone number or document ID)
 * @returns {Promise<{cookies: Array} | null>}
 */
async function getSession(adminId) {
    try {
        const session = memorySessions.get(adminId);
        
        if (!session) {
            return null;
        }
        
        // Check if session expired
        if (Date.now() - session.timestamp > SESSION_EXPIRY) {
            memorySessions.delete(adminId);
            return null;
        }
        
        return {
            cookies: session.cookies,
            tokens: session.tokens || {}
        };
    } catch (error) {
        console.error('❌ Error getting session:', error);
        return null;
    }
}

/**
 * Save session for an admin
 * @param {string} adminId - Admin ID
 * @param {Array} cookies - Array of cookie objects
 * @param {Object} tokens - Optional tokens object
 */
async function saveSession(adminId, cookies, tokens = {}) {
    try {
        memorySessions.set(adminId, {
            cookies: cookies || [],
            tokens: tokens,
            timestamp: Date.now()
        });
        console.log(`✅ Session saved for admin: ${adminId}`);
    } catch (error) {
        console.error('❌ Error saving session:', error);
        throw error;
    }
}

/**
 * Delete session for an admin
 * @param {string} adminId - Admin ID
 */
async function deleteSession(adminId) {
    try {
        memorySessions.delete(adminId);
        console.log(`✅ Session deleted for admin: ${adminId}`);
    } catch (error) {
        console.error('❌ Error deleting session:', error);
    }
}

module.exports = {
    getSession,
    saveSession,
    deleteSession
};

