/**
 * Alfa API Service for frontend-backend communication
 */
class AlfaAPIService {
    constructor() {
        // Use window.AEFA_API_URL if set and valid, otherwise detect from current window location
        // This ensures it works regardless of what port the server is running on
        if (window.AEFA_API_URL && 
            window.AEFA_API_URL !== 'https://your-backend-url.onrender.com' &&
            !window.AEFA_API_URL.includes('your-backend-url')) {
            this.baseURL = window.AEFA_API_URL;
        } else {
            // Placeholder URL detected or not set - warn and use same origin (for local dev only)
            if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
                console.error('❌ Backend URL not configured! Please update frontend/config.js with your Render.com backend URL.');
                console.error('   Current value:', window.AEFA_API_URL || 'not set');
                console.error('   Frontend URL:', window.location.origin);
                console.error('   ⚠️ API calls will fail - update config.js now!');
            }
            // Use the same origin as the current page (same host and port)
            // This way it automatically works on any port (3000, 3001, etc.) for local dev
            this.baseURL = window.location.origin;
        }
    }

    /**
     * Check if backend server is healthy
     * @returns {Promise<boolean>}
     */
    async checkHealth() {
        try {
            const controller = new AbortController();
            // Increased timeout to 15s to handle Render.com cold starts
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            
            const response = await fetch(`${this.baseURL}/health`, {
                method: 'GET',
                signal: controller.signal,
                // Add mode and credentials for cross-origin requests
                mode: 'cors',
                credentials: 'omit'
            });
            
            clearTimeout(timeoutId);
            return response.ok;
        } catch (error) {
            // Don't log AbortError as error - it's just a timeout
            if (error.name !== 'AbortError') {
                console.error('Health check failed:', error);
            } else {
                console.warn('Health check timed out (backend may be starting up)');
            }
            return false;
        }
    }

    /**
     * Get authentication headers with JWT token
     * @returns {Promise<Object>} Headers object with Authorization
     */
    async getAuthHeaders(forceRefresh = false) {
        const headers = {
            'Content-Type': 'application/json'
        };
        
        // Get Firebase ID token
        if (window.AuthHelper) {
            let token = await window.AuthHelper.getIdToken(forceRefresh);
            
            // If no token and not forcing refresh, try forcing a refresh
            if (!token && !forceRefresh) {
                console.warn('⚠️ No token found, attempting to force refresh...');
                token = await window.AuthHelper.getIdToken(true);
            }
            
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            } else {
                console.error('❌ Failed to get Firebase ID token. User may not be authenticated.');
                throw new Error('Authentication required. Please log in again.');
            }
        } else {
            console.error('❌ AuthHelper not available. Firebase auth may not be initialized.');
            throw new Error('Authentication required. Please log in again.');
        }
        
        return headers;
    }

    /**
     * Make authenticated API request
     * @param {string} endpoint - API endpoint (relative to baseURL)
     * @param {Object} options - Fetch options
     * @returns {Promise<Response>} Fetch response
     */
    async authenticatedRequest(endpoint, options = {}) {
        const headers = await this.getAuthHeaders();
        const url = endpoint.startsWith('http') ? endpoint : `${this.baseURL}${endpoint}`;
        
        return fetch(url, {
            ...options,
            headers: {
                ...headers,
                ...(options.headers || {})
            }
        });
    }

    // ===== NEW METHODS FOR JWT-PROTECTED ROUTES =====

    /**
     * Refresh admin data using new JWT-protected endpoint
     * @param {string} adminId - Admin document ID
     * @returns {Promise<Object>} Dashboard data with aggregated results
     */
    async refreshAdmin(adminId) {
        try {
            const response = await this.authenticatedRequest(
                `/api/refreshAdmins?adminId=${encodeURIComponent(adminId)}`,
                { method: 'GET' }
            );

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Failed to refresh admin');
            }

            // Return normalized data
            return {
                success: true,
                data: result.data,
                timestamp: result.data.timestamp || Date.now()
            };
        } catch (error) {
            console.error('Error refreshing admin:', error);
            throw error;
        }
    }

    /**
     * Get consumption data
     * @param {string} adminId - Admin document ID
     * @returns {Promise<Object>} Consumption data
     */
    async getConsumption(adminId) {
        const response = await this.authenticatedRequest(
            `/api/getconsumption?adminId=${encodeURIComponent(adminId)}`,
            { method: 'GET' }
        );
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Failed to get consumption');
        }
        
        return result.data;
    }

    /**
     * Get expiry date
     * @param {string} adminId - Admin document ID
     * @returns {Promise<Object>} Expiry data
     */
    async getExpiryDate(adminId) {
        const response = await this.authenticatedRequest(
            `/api/getexpirydate?adminId=${encodeURIComponent(adminId)}`,
            { method: 'GET' }
        );
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Failed to get expiry date');
        }
        
        return result.data;
    }

    /**
     * Get services data
     * @param {string} adminId - Admin document ID
     * @returns {Promise<Object>} Services data
     */
    async getServices(adminId) {
        const response = await this.authenticatedRequest(
            `/api/getmyservices?adminId=${encodeURIComponent(adminId)}`,
            { method: 'GET' }
        );
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Failed to get services');
        }
        
        return result.data;
    }

    /**
     * Get Ushare HTML data
     * @param {string} adminId - Admin document ID
     * @param {boolean} useQueue - Whether to use background queue if HTTP fails
     * @returns {Promise<Object>} Ushare data or job info
     */
    async getUshare(adminId, useQueue = true) {
        const response = await this.authenticatedRequest(
            `/api/ushare?adminId=${encodeURIComponent(adminId)}&useQueue=${useQueue}`,
            { method: 'GET' }
        );
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Failed to get Ushare data');
        }
        
        // Check if job was queued
        if (result.jobId) {
            return {
                queued: true,
                jobId: result.jobId,
                status: result.status,
                message: result.message
            };
        }
        
        return result.data;
    }

    /**
     * Add subscriber
     * @param {string} adminId - Admin document ID
     * @param {string} subscriberNumber - Subscriber phone number
     * @param {number} quota - Quota in GB
     * @returns {Promise<Object>} Result
     */
    async addSubscriber(adminId, subscriberNumber, quota) {
        const response = await this.authenticatedRequest('/api/addSubscriber', {
            method: 'POST',
            body: JSON.stringify({ adminId, subscriberNumber, quota })
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Failed to add subscriber');
        }
        
        return result.data;
    }

    /**
     * Edit subscriber quota
     * @param {string} adminId - Admin document ID
     * @param {string} subscriberNumber - Subscriber phone number
     * @param {number} quota - New quota in GB
     * @returns {Promise<Object>} Result
     */
    async editSubscriber(adminId, subscriberNumber, quota) {
        const response = await this.authenticatedRequest('/api/editSubscriber', {
            method: 'PUT',
            body: JSON.stringify({ adminId, subscriberNumber, quota })
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Failed to edit subscriber');
        }
        
        return result.data;
    }

    /**
     * Remove subscriber
     * @param {string} adminId - Admin document ID
     * @param {string} subscriberNumber - Subscriber phone number
     * @param {boolean} pending - Whether to remove pending subscribers
     * @returns {Promise<Object>} Result
     */
    async removeSubscriber(adminId, subscriberNumber, pending = true) {
        const params = new URLSearchParams({
            adminId,
            subscriberNumber,
            pending: pending.toString()
        });
        
        const response = await this.authenticatedRequest(
            `/api/removeSubscriber?${params}`,
            { method: 'DELETE' }
        );
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Failed to remove subscriber');
        }
        
        return result.data;
    }

    /**
     * Fetch Alfa dashboard data (LEGACY - maintained for backward compatibility)
     * Tries new JWT endpoint first, falls back to legacy endpoint
     * @param {string} phone - Phone number (optional for new endpoint)
     * @param {string} password - Password (optional for new endpoint)
     * @param {string} adminId - Admin document ID
     * @returns {Promise<Object>} Dashboard data
     */
    async fetchDashboardData(phone, password, adminId) {
        // Try new endpoint first if we have a token
        if (window.AuthHelper) {
            const token = await window.AuthHelper.getIdToken();
            if (token && adminId) {
                try {
                    console.log('🔄 Using new JWT-protected refresh endpoint');
                    const result = await this.refreshAdmin(adminId);
                    // Return processed data directly (backend already processes it)
                    if (result.data) {
                        const aggregated = result.data;
                        
                        // Backend now processes the data and includes it at root level
                        // Remove internal fields (_summary, apis) before returning
                        const legacyData = { ...aggregated };
                        delete legacyData.apis; // Keep for debugging but don't need it in legacyData
                        delete legacyData.summary; // Keep for debugging but don't need it in legacyData
                        delete legacyData.adminId; // Don't need adminId in legacyData
                        delete legacyData.duration; // Don't need duration in legacyData
                        
                        return {
                            data: legacyData,
                            timestamp: aggregated.timestamp || result.timestamp || Date.now()
                        };
                    }
                    return result;
                } catch (error) {
                    // Only fall back if it's a real error (not just slow/timeout)
                    // Timeouts should be handled by the backend, not cause fallback here
                    if (error.message && error.message.includes('timeout')) {
                        console.warn('⚠️ New endpoint timed out, but data may still be processing. Not falling back to legacy endpoint.');
                        // Re-throw so caller can handle timeout appropriately
                        throw error;
                    }
                    console.warn('⚠️ New endpoint failed, falling back to legacy:', error);
                    // Fall through to legacy endpoint only for non-timeout errors
                }
            }
        }
        
        // Fallback to legacy endpoint
        try {
            // OPTIONAL: Check backend health first (but don't block if it times out)
            const isHealthy = await this.checkHealth();
            if (!isHealthy) {
                console.warn('⚠️ Health check failed or timed out, but proceeding with API call anyway');
            }

            // Create abort controller for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes timeout
            
            const response = await fetch(`${this.baseURL}/api/alfa/fetch`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    phone: phone,
                    password: password,
                    adminId: adminId
                }),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            if (!response.ok) {
                let errorMessage = `HTTP ${response.status}: Internal Server Error`;
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.error || errorMessage;
                } catch (e) {
                    // Ignore parse errors
                }
                throw new Error(errorMessage);
            }

            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch data');
            }

            const fetchResult = result.data || result;
            const dashboardData = fetchResult.data || fetchResult;
            const refreshTimestamp = result.timestamp || fetchResult.timestamp || Date.now();

            return {
                data: dashboardData,
                timestamp: refreshTimestamp
            };
        } catch (error) {
            console.error('Error fetching Alfa data:', error);
            
            if (error.name === 'AbortError' || error?.message?.includes('timeout')) {
                throw new Error('Request timed out. The operation is taking too long. Please try again.');
            } else if (error?.message?.includes('Failed to fetch') || error?.message?.includes('NetworkError')) {
                throw new Error('Cannot connect to backend server. Please make sure the server is running on ' + this.baseURL);
            }
            
            throw error;
        }
    }
}

// Create global instance
window.AlfaAPIService = new AlfaAPIService();

