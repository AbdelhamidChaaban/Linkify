const { Redis } = require('@upstash/redis');

/**
 * Cache Layer using Upstash Redis
 * Handles caching of HTML/JSON responses to avoid redundant scraping
 */
class CacheLayer {
    constructor() {
        this.redis = null;
        this.enabled = false;
        // Cache TTL: 24 hours (for scheduled refresh at 6:00 AM daily)
        // This ensures HTML and JSON structures persist until the next scheduled refresh
        const cacheTTLHours = parseInt(process.env.CACHE_TTL_HOURS) || 24;
        this.cacheTTL = cacheTTLHours * 60 * 60; // Convert to seconds (86400 for 24 hours)
        this.initialize();
    }

    /**
     * Get cache TTL in seconds
     * @returns {number}
     */
    getTTL() {
        return this.cacheTTL;
    }

    /**
     * Get cached HTML structure for a user
     * Used during scraping to skip page loading if structure hasn't changed
     * @param {string} identifier - User identifier
     * @returns {Promise<string|null>} Cached HTML or null
     */
    async getHtmlStructure(identifier) {
        if (!this.enabled || !this.redis) {
            return null;
        }

        try {
            const key = this.generateKey(identifier, 'html');
            const cached = await this.redis.get(key);
            
            if (!cached) {
                return null;
            }

            // Return HTML string
            return typeof cached === 'string' ? cached : JSON.stringify(cached);
        } catch (error) {
            console.warn(`⚠️ Redis get HTML error for ${identifier}:`, error.message);
            return null;
        }
    }

    /**
     * Cache HTML structure for a user
     * @param {string} identifier - User identifier
     * @param {string} html - HTML content
     * @returns {Promise<boolean>} Success status
     */
    async setHtmlStructure(identifier, html) {
        if (!this.enabled || !this.redis) {
            return false;
        }

        if (!html || typeof html !== 'string') {
            return false;
        }

        try {
            const key = this.generateKey(identifier, 'html');
            // SETEX automatically overwrites existing key, so no need to delete first
            // This ensures we always have the latest HTML structure
            await this.redis.setex(key, this.cacheTTL, html);
            return true;
        } catch (error) {
            console.warn(`⚠️ Redis set HTML error for ${identifier}:`, error.message);
            return false;
        }
    }

    /**
     * Get cached API response structure
     * @param {string} identifier - User identifier
     * @param {string} apiName - API name (e.g., 'getconsumption', 'getmyservices')
     * @returns {Promise<Object|null>} Cached API response or null
     */
    async getApiStructure(identifier, apiName) {
        if (!this.enabled || !this.redis) {
            return null;
        }

        try {
            const key = this.generateKey(identifier, `api:${apiName}`);
            const cached = await this.redis.get(key);
            
            if (!cached) {
                return null;
            }

            // Parse JSON
            if (typeof cached === 'string') {
                try {
                    return JSON.parse(cached);
                } catch (e) {
                    return null;
                }
            } else if (typeof cached === 'object' && cached !== null) {
                return cached;
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Cache API response structure
     * @param {string} identifier - User identifier
     * @param {string} apiName - API name
     * @param {Object} apiData - API response data
     * @returns {Promise<boolean>} Success status
     */
    async setApiStructure(identifier, apiName, apiData) {
        if (!this.enabled || !this.redis) {
            return false;
        }

        if (!apiData || typeof apiData !== 'object') {
            return false;
        }

        try {
            const key = this.generateKey(identifier, `api:${apiName}`);
            const value = JSON.stringify(apiData);
            // SETEX automatically overwrites existing key, so no need to delete first
            // This ensures we always have the latest API structure
            await this.redis.setex(key, this.cacheTTL, value);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Initialize Redis connection
     */
    initialize() {
        try {
            const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
            const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

            if (!upstashUrl || !upstashToken) {
                console.warn('⚠️ Upstash Redis credentials not found. Caching disabled.');
                console.warn('   Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env');
                this.enabled = false;
                return;
            }

            this.redis = new Redis({
                url: upstashUrl,
                token: upstashToken,
            });

            this.enabled = true;
            console.log('✅ Redis cache layer initialized');
        } catch (error) {
            console.warn('⚠️ Failed to initialize Redis cache:', error.message);
            console.warn('   Continuing without cache - all requests will scrape');
            this.enabled = false;
        }
    }

    /**
     * Generate cache key for user
     * @param {string} identifier - User identifier (phone or adminId)
     * @param {string} type - Cache type ('data' or 'lastRefresh')
     * @returns {string} Formatted cache key
     */
    generateKey(identifier, type = 'data') {
        // Sanitize identifier to ensure valid Redis key
        const sanitized = String(identifier).replace(/[^a-zA-Z0-9_-]/g, '_');
        return `user:${sanitized}:${type}`;
    }

    /**
     * Generic get method for Redis keys
     * @param {string} key - Redis key
     * @returns {Promise<string|Object|null>} Value or null
     */
    async get(key) {
        if (!this.enabled || !this.redis) {
            return null;
        }

        try {
            const value = await this.redis.get(key);
            return value;
        } catch (error) {
            console.warn(`⚠️ Redis get error for ${key}:`, error.message);
            return null;
        }
    }

    /**
     * Generic set method for Redis keys
     * @param {string} key - Redis key
     * @param {string} value - Value to set
     * @param {number} ttl - TTL in seconds
     * @returns {Promise<boolean>} Success status
     */
    async set(key, value, ttl) {
        if (!this.enabled || !this.redis) {
            return false;
        }

        try {
            if (ttl && ttl > 0) {
                await this.redis.setex(key, ttl, value);
            } else {
                await this.redis.set(key, value);
            }
            return true;
        } catch (error) {
            console.warn(`⚠️ Redis set error for ${key}:`, error.message);
            return false;
        }
    }

    /**
     * Get last refresh timestamp
     * @param {string} identifier - User identifier
     * @returns {Promise<number|null>} Timestamp or null
     */
    async getLastRefresh(identifier) {
        if (!this.enabled || !this.redis) {
            return null;
        }

        try {
            const key = this.generateKey(identifier, 'lastRefresh');
            const timestamp = await this.redis.get(key);
            
            // Handle both string and number responses
            if (!timestamp) {
                return null;
            }
            
            if (typeof timestamp === 'string') {
                return parseInt(timestamp, 10);
            } else if (typeof timestamp === 'number') {
                return timestamp;
            } else {
                return null;
            }
        } catch (error) {
            return null;
        }
    }

    /**
     * Set last refresh timestamp
     * @param {string} identifier - User identifier
     * @returns {Promise<boolean>} Success status
     */
    async setLastRefresh(identifier) {
        if (!this.enabled || !this.redis) {
            return false;
        }

        try {
            const key = this.generateKey(identifier, 'lastRefresh');
            await this.redis.setex(key, this.cacheTTL, Date.now().toString());
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Delete cached structures for user
     * @param {string} identifier - User identifier
     * @returns {Promise<boolean>} Success status
     */
    async delete(identifier) {
        if (!this.enabled || !this.redis) {
            return false;
        }

        try {
            const htmlKey = this.generateKey(identifier, 'html');
            const consumptionKey = this.generateKey(identifier, 'api:getconsumption');
            const servicesKey = this.generateKey(identifier, 'api:getmyservices');
            const refreshKey = this.generateKey(identifier, 'lastRefresh');
            
            await this.redis.del(htmlKey);
            await this.redis.del(consumptionKey);
            await this.redis.del(servicesKey);
            await this.redis.del(refreshKey);
            
            console.log(`🗑️ Deleted cached structures for ${identifier}`);
            return true;
        } catch (error) {
            console.warn(`⚠️ Redis delete error for ${identifier}:`, error.message);
            return false;
        }
    }

    /**
     * Check if cache is enabled and available
     * @returns {boolean}
     */
    isAvailable() {
        return this.enabled && this.redis !== null;
    }

    /**
     * Get cache statistics (for debugging)
     * @param {string} identifier - User identifier
     * @returns {Promise<Object>} Cache stats
     */
    async getStats(identifier) {
        if (!this.enabled || !this.redis) {
            return { enabled: false, available: false };
        }

        try {
            const lastRefresh = await this.getLastRefresh(identifier);
            const hasHtml = await this.redis.exists(this.generateKey(identifier, 'html'));
            const hasConsumption = await this.redis.exists(this.generateKey(identifier, 'api:getconsumption'));
            const hasServices = await this.redis.exists(this.generateKey(identifier, 'api:getmyservices'));

            return {
                enabled: true,
                available: true,
                hasHtml: hasHtml === 1,
                hasConsumption: hasConsumption === 1,
                hasServices: hasServices === 1,
                lastRefresh: lastRefresh,
                age: lastRefresh ? Date.now() - lastRefresh : null,
                ttl: this.cacheTTL
            };
        } catch (error) {
            return {
                enabled: true,
                available: false,
                error: error.message
            };
        }
    }
}

// Export singleton instance
const cacheLayer = new CacheLayer();

module.exports = cacheLayer;



