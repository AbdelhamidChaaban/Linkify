const cacheLayer = require('./cacheLayer');
// MIGRATED: Using API-first service (no Puppeteer) instead of legacy alfaService.js
const { fetchAlfaData } = require('./alfaServiceApiFirst');

/**
 * Cache Pre-Warmer Service
 * Automatically refreshes cached data before it expires to ensure fresh data is always available
 */
class CachePreWarmer {
    constructor() {
        this.preWarmQueue = new Map(); // Track users being pre-warmed
        this.preWarmInterval = null;
        this.isRunning = false;
    }

    /**
     * Start the pre-warming service
     * Checks for stale cache entries and refreshes them in the background
     */
    start() {
        if (this.isRunning) {
            console.log('⚠️ Cache pre-warmer is already running');
            return;
        }

        if (!cacheLayer.isAvailable()) {
            console.log('⚠️ Cache not available, pre-warmer disabled');
            return;
        }

        this.isRunning = true;
        // Check every 2 minutes for cache entries that need pre-warming
        this.preWarmInterval = setInterval(() => {
            this.checkAndPreWarm().catch(err => {
                console.error('⚠️ Error in cache pre-warmer:', err.message);
            });
        }, 2 * 60 * 1000); // 2 minutes

        console.log('✅ Cache pre-warmer started (checks every 2 minutes)');
    }

    /**
     * Stop the pre-warming service
     */
    stop() {
        if (this.preWarmInterval) {
            clearInterval(this.preWarmInterval);
            this.preWarmInterval = null;
        }
        this.isRunning = false;
        console.log('🛑 Cache pre-warmer stopped');
    }

    /**
     * Check for cache entries that need pre-warming and refresh them
     * Note: This requires a list of active users - for now, we'll pre-warm on-demand
     */
    async checkAndPreWarm() {
        // This would require tracking active users
        // For now, pre-warming happens on-demand when cache is accessed
        // See shouldPreWarm() method in cacheLayer
    }

    /**
     * Pre-warm cache for a specific user
     * @param {string} identifier - User identifier
     * @param {string} phone - Phone number
     * @param {string} password - Password
     * @returns {Promise<boolean>} Success status
     */
    async preWarmUser(identifier, phone, password) {
        // Check if already pre-warming this user
        if (this.preWarmQueue.has(identifier)) {
            console.log(`⏭️ Already pre-warming cache for ${identifier}`);
            return false;
        }

        // Check if pre-warming is needed
        const shouldPreWarm = await cacheLayer.shouldPreWarm(identifier);
        if (!shouldPreWarm) {
            return false; // Not needed
        }

        // Mark as being pre-warmed
        this.preWarmQueue.set(identifier, Date.now());

        try {
            console.log(`🔄 Pre-warming cache for ${identifier}...`);
            
            // Fetch fresh data in background (non-blocking)
            const data = await fetchAlfaData(phone, password, identifier);
            
            // Update cache with fresh data
            await cacheLayer.set(identifier, {
                success: true,
                data: data,
                duration: 0 // Pre-warm doesn't count as a request
            });

            console.log(`✅ Cache pre-warmed for ${identifier}`);
            return true;
        } catch (error) {
            console.warn(`⚠️ Failed to pre-warm cache for ${identifier}:`, error.message);
            return false;
        } finally {
            // Remove from queue after 5 minutes (prevent stuck entries)
            setTimeout(() => {
                this.preWarmQueue.delete(identifier);
            }, 5 * 60 * 1000);
        }
    }

    /**
     * Check if a user is currently being pre-warmed
     * @param {string} identifier - User identifier
     * @returns {boolean}
     */
    isPreWarming(identifier) {
        return this.preWarmQueue.has(identifier);
    }
}

// Export singleton instance
const cachePreWarmer = new CachePreWarmer();

module.exports = cachePreWarmer;

