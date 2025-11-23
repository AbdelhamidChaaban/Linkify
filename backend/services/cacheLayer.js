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
     * Set key only if it doesn't exist (NX = Not eXists)
     * @param {string} key - Redis key
     * @param {string} value - Value to set
     * @param {number} ttl - TTL in seconds
     * @returns {Promise<boolean>} True if key was set (didn't exist), false if key already exists
     */
    async setNX(key, value, ttl) {
        if (!this.enabled || !this.redis) {
            return false;
        }

        try {
            // Check if key exists first
            const exists = await this.redis.exists(key);
            if (exists === 1) {
                return false; // Key already exists
            }

            // Set the key with TTL
            if (ttl && ttl > 0) {
                await this.redis.setex(key, ttl, value);
            } else {
                await this.redis.set(key, value);
            }
            return true; // Key was set successfully
        } catch (error) {
            console.warn(`⚠️ Redis setNX error for ${key}:`, error.message);
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
     * Add member to sorted set (or update score if exists)
     * @param {string} key - Sorted set key
     * @param {string} member - Member to add
     * @param {number} score - Score (timestamp)
     * @returns {Promise<boolean>} Success status
     */
    async zadd(key, member, score) {
        if (!this.enabled || !this.redis) {
            return false;
        }

        try {
            // Upstash Redis zadd format: zadd(key, { score, member })
            // The @upstash/redis client uses object format
            await this.redis.zadd(key, { score, member });
            return true;
        } catch (error) {
            console.warn(`⚠️ Redis zadd error for ${key}:`, error.message);
            return false;
        }
    }

    /**
     * Remove member from sorted set
     * @param {string} key - Sorted set key
     * @param {string} member - Member to remove
     * @returns {Promise<boolean>} Success status
     */
    async zrem(key, member) {
        if (!this.enabled || !this.redis) {
            return false;
        }

        try {
            // Upstash Redis zrem format: zrem(key, member)
            await this.redis.zrem(key, member);
            return true;
        } catch (error) {
            console.warn(`⚠️ Redis zrem error for ${key}:`, error.message);
            return false;
        }
    }

    /**
     * Get range from sorted set with scores
     * @param {string} key - Sorted set key
     * @param {number} start - Start index
     * @param {number} stop - Stop index
     * @param {boolean} withScores - Include scores in result
     * @returns {Promise<Array>} Array of members (and scores if withScores=true)
     */
    async zrange(key, start, stop, withScores = false) {
        if (!this.enabled || !this.redis) {
            return [];
        }

        try {
            if (withScores) {
                // Upstash Redis zrange with scores: zrange(key, start, stop, { withScores: true })
                const result = await this.redis.zrange(key, start, stop, { withScores: true });
                // Upstash returns object with member as key and score as value
                if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
                    // Convert object to array of [member, score] pairs
                    return Object.entries(result).map(([member, score]) => [member, parseFloat(score)]);
                } else if (Array.isArray(result)) {
                    // Handle array format (alternating member/score)
                    const pairs = [];
                    for (let i = 0; i < result.length; i += 2) {
                        if (i + 1 < result.length) {
                            pairs.push([result[i], parseFloat(result[i + 1])]);
                        }
                    }
                    return pairs;
                }
                return [];
            } else {
                return await this.redis.zrange(key, start, stop);
            }
        } catch (error) {
            console.warn(`⚠️ Redis zrange error for ${key}:`, error.message);
            return [];
        }
    }

    /**
     * Get range from sorted set by score
     * @param {string} key - Sorted set key
     * @param {number|string} min - Minimum score (-inf for negative infinity)
     * @param {number|string} max - Maximum score (+inf for positive infinity)
     * @param {boolean} withScores - Include scores in result
     * @returns {Promise<Array>} Array of members (and scores if withScores=true)
     */
    async zrangebyscore(key, min, max, withScores = false) {
        if (!this.enabled || !this.redis) {
            return [];
        }

        try {
            // Try ZRANGE with BYSCORE option first
            try {
                if (withScores) {
                    const result = await this.redis.zrange(key, min, max, { 
                        byScore: true, 
                        withScores: true 
                    });
                    
                    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
                        return Object.entries(result).map(([member, score]) => [member, parseFloat(score)]);
                    } else if (Array.isArray(result)) {
                        const pairs = [];
                        for (let i = 0; i < result.length; i += 2) {
                            if (i + 1 < result.length) {
                                pairs.push([result[i], parseFloat(result[i + 1])]);
                            }
                        }
                        return pairs;
                    }
                    return [];
                } else {
                    return await this.redis.zrange(key, min, max, { byScore: true });
                }
            } catch (e1) {
                // Fallback: Get all members and filter by score
                // This is less efficient but works if sorted set operations aren't fully supported
                const allMembers = await this.redis.zrange(key, 0, -1, { withScores: true });
                const filtered = [];
                
                if (Array.isArray(allMembers)) {
                    for (let i = 0; i < allMembers.length; i += 2) {
                        if (i + 1 < allMembers.length) {
                            const member = allMembers[i];
                            const score = parseFloat(allMembers[i + 1]);
                            const minNum = min === '-inf' ? -Infinity : parseFloat(min);
                            const maxNum = max === '+inf' ? Infinity : parseFloat(max);
                            
                            if (score >= minNum && score <= maxNum) {
                                if (withScores) {
                                    filtered.push([member, score]);
                                } else {
                                    filtered.push(member);
                                }
                            }
                        }
                    }
                } else if (typeof allMembers === 'object' && allMembers !== null) {
                    for (const [member, scoreStr] of Object.entries(allMembers)) {
                        const score = parseFloat(scoreStr);
                        const minNum = min === '-inf' ? -Infinity : parseFloat(min);
                        const maxNum = max === '+inf' ? Infinity : parseFloat(max);
                        
                        if (score >= minNum && score <= maxNum) {
                            if (withScores) {
                                filtered.push([member, score]);
                            } else {
                                filtered.push(member);
                            }
                        }
                    }
                }
                
                return filtered;
            }
        } catch (error) {
            console.warn(`⚠️ Redis zrangebyscore error for ${key}:`, error.message);
            return [];
        }
    }

    /**
     * Get score of member in sorted set
     * @param {string} key - Sorted set key
     * @param {string} member - Member
     * @returns {Promise<number|null>} Score or null
     */
    async zscore(key, member) {
        if (!this.enabled || !this.redis) {
            return null;
        }

        try {
            // Upstash Redis zscore format: zscore(key, member)
            const score = await this.redis.zscore(key, member);
            return score !== null ? parseFloat(score) : null;
        } catch (error) {
            console.warn(`⚠️ Redis zscore error for ${key}:`, error.message);
            return null;
        }
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



