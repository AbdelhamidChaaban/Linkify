/**
 * Alfa API Service for frontend-backend communication
 */
class AlfaAPIService {
    constructor() {
        this.baseURL = window.AEFA_API_URL || 'http://localhost:3000';
    }

    /**
     * Check if backend server is healthy
     * @returns {Promise<boolean>}
     */
    async checkHealth() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const response = await fetch(`${this.baseURL}/health`, {
                method: 'GET',
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            return response.ok;
        } catch (error) {
            console.error('Health check failed:', error);
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
            const response = await fetch(`${this.baseURL}/api/alfa/fetch`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    phone: phone,
                    password: password,
                    adminId: adminId
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch data');
            }

            return result.data;
        } catch (error) {
            console.error('Error fetching Alfa data:', error);
            throw error;
        }
    }
}

// Create global instance
window.AlfaAPIService = new AlfaAPIService();

