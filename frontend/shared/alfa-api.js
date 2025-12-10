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
     * Fetch Alfa dashboard data
     * @param {string} phone - Phone number
     * @param {string} password - Password
     * @param {string} adminId - Admin document ID
     * @returns {Promise<Object>} Dashboard data
     */
    async fetchDashboardData(phone, password, adminId) {
        try {
            // OPTIONAL: Check backend health first (but don't block if it times out)
            // Render.com free tier has cold starts, so health check may timeout even if backend is working
            // We'll try the actual API call anyway - if backend is down, the API call will fail with a better error
            const isHealthy = await this.checkHealth();
            if (!isHealthy) {
                console.warn('⚠️ Health check failed or timed out, but proceeding with API call anyway (Render.com may be cold starting)');
                // Don't throw - continue with API call anyway
                // If backend is actually down, the API call will fail with a more specific error
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
                let errorDetails = null;
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.error || errorMessage;
                    errorDetails = errorData.details;
                    
                    // Log full error details for debugging
                    if (errorDetails) {
                        console.error('Backend error details:', errorDetails);
                    }
                } catch (e) {
                    // If response is not JSON, try to get text
                    try {
                        const text = await response.text();
                        if (text) {
                            errorMessage = text.substring(0, 200);
                        }
                    } catch (e2) {
                        // Ignore
                    }
                }
                
                // Create error with more context
                const error = new Error(errorMessage);
                if (errorDetails) {
                    error.details = errorDetails;
                }
                throw error;
            }

            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch data');
            }

            // Backend response structure:
            // - result.data = the entire result from fetchAlfaData (includes data, timestamp, etc.)
            // - result.timestamp = timestamp from fetchAlfaData or Date.now()
            // We need to extract the actual dashboard data and timestamp
            const fetchResult = result.data || result;
            const dashboardData = fetchResult.data || fetchResult;
            const refreshTimestamp = result.timestamp || fetchResult.timestamp || Date.now();

            // Return both data and timestamp (timestamp is when the refresh happened)
            return {
                data: dashboardData,
                timestamp: refreshTimestamp
            };
        } catch (error) {
            console.error('Error fetching Alfa data:', error);
            console.error('Error type:', typeof error);
            console.error('Error message:', error?.message);
            console.error('Error name:', error?.name);
            console.error('Error stack:', error?.stack);
            
            // Provide more helpful error messages
            if (error.name === 'AbortError' || error?.message?.includes('timeout')) {
                throw new Error('Request timed out. The operation is taking too long. Please try again.');
            } else if (error?.message?.includes('Failed to fetch') || error?.message?.includes('NetworkError')) {
                throw new Error('Cannot connect to backend server. Please make sure the server is running on ' + this.baseURL);
            }
            
            // Ensure we always throw an Error object with a message
            if (!error || !error.message) {
                throw new Error('Unknown error occurred. Check the backend console for details.');
            }
            
            throw error;
        }
    }
}

// Create global instance
window.AlfaAPIService = new AlfaAPIService();

