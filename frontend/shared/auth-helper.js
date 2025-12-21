/**
 * Authentication Helper for JWT Tokens
 * Provides utilities for getting Firebase ID tokens for JWT authentication
 */

class AuthHelper {
    /**
     * Get current user's Firebase ID token
     * @param {boolean} forceRefresh - Force token refresh
     * @returns {Promise<string|null>} ID token or null if not authenticated
     */
    static async getIdToken(forceRefresh = false) {
        try {
            // Check if Firebase Auth is available
            if (typeof auth === 'undefined' || !auth) {
                console.warn('⚠️ Firebase Auth is not available');
                return null;
            }
            
            if (!auth.currentUser) {
                console.warn('⚠️ No authenticated user found');
                return null;
            }
            
            // Get the ID token (force refresh if requested)
            const token = await auth.currentUser.getIdToken(forceRefresh);
            if (token) {
                console.log(`✅ Firebase ID token retrieved${forceRefresh ? ' (forced refresh)' : ''}`);
            }
            return token;
        } catch (error) {
            console.error('❌ Error getting ID token:', error);
            // If token expired, try refreshing once
            if (error.code === 'auth/user-token-expired' && !forceRefresh) {
                console.log('🔄 Token expired, attempting refresh...');
                try {
                    const refreshedToken = await auth.currentUser.getIdToken(true);
                    return refreshedToken;
                } catch (refreshError) {
                    console.error('❌ Failed to refresh token:', refreshError);
                    return null;
                }
            }
            return null;
        }
    }
    
    /**
     * Get ID token, refreshing if necessary
     * @param {boolean} forceRefresh - Force token refresh
     * @returns {Promise<string|null>} ID token
     */
    static async getIdTokenResult(forceRefresh = false) {
        try {
            if (typeof auth === 'undefined' || !auth || !auth.currentUser) {
                return null;
            }
            
            const tokenResult = await auth.currentUser.getIdTokenResult(forceRefresh);
            return tokenResult;
        } catch (error) {
            console.error('❌ Error getting ID token result:', error);
            return null;
        }
    }
    
    /**
     * Check if user is authenticated
     * @returns {boolean} True if user is authenticated
     */
    static isAuthenticated() {
        return typeof auth !== 'undefined' && auth && auth.currentUser !== null;
    }
    
    /**
     * Get current user ID
     * @returns {string|null} User ID or null
     */
    static getUserId() {
        if (typeof auth !== 'undefined' && auth && auth.currentUser) {
            return auth.currentUser.uid;
        }
        return null;
    }
}

// Export for use in other scripts
window.AuthHelper = AuthHelper;

