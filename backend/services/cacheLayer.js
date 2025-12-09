const Redis = require('ioredis');
const path = require('path');
const fs = require('fs');

// Load environment variables if not already loaded
if (!process.env.REDIS_HOST && !process.env.REDIS_PASSWORD) {
    const backendEnvPath = path.join(__dirname, '.env');
    const rootEnvPath = path.join(__dirname, '..', '.env');
    
    if (fs.existsSync(backendEnvPath)) {
        require('dotenv').config({ path: backendEnvPath });
    } else if (fs.existsSync(rootEnvPath)) {
        require('dotenv').config({ path: rootEnvPath });
    } else {
        require('dotenv').config();
    }
}

/**
 * Cache Layer using Redis Cloud
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
            // Force reload environment variables
            const backendEnvPath = path.join(__dirname, '.env');
            const rootEnvPath = path.join(__dirname, '..', '.env');
            if (fs.existsSync(backendEnvPath)) {
                require('dotenv').config({ path: backendEnvPath, override: true });
            } else if (fs.existsSync(rootEnvPath)) {
                require('dotenv').config({ path: rootEnvPath, override: true });
            }

            const redisHost = process.env.REDIS_HOST;
            const redisPort = parseInt(process.env.REDIS_PORT) || 6379;
            const redisPassword = process.env.REDIS_PASSWORD;

            console.log(`🔍 [Redis Init] Environment check:`);
            console.log(`   REDIS_HOST: ${redisHost ? redisHost.substring(0, 30) + '...' : 'NOT SET'}`);
            console.log(`   REDIS_PORT: ${redisPort || 'NOT SET'}`);
            console.log(`   REDIS_PASSWORD: ${redisPassword ? 'SET (' + redisPassword.length + ' chars)' : 'NOT SET'}`);

            // CRITICAL: Check for Upstash environment variables (should NOT exist)
            // Just warn - don't block initialization. The Redis client will use REDIS_HOST/PORT/PASSWORD
            if (process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_TOKEN) {
                console.warn(`⚠️ Upstash environment variables detected but will be ignored.`);
                console.warn(`   We're using Redis Cloud (REDIS_HOST/REDIS_PORT/REDIS_PASSWORD) instead.`);
                console.warn(`   To remove this warning, delete UPSTASH_* variables from .env file.`);
            }

            if (!redisHost || !redisPassword) {
                console.warn('⚠️ Redis Cloud credentials not found. Caching disabled.');
                console.warn('   Set REDIS_HOST, REDIS_PORT, and REDIS_PASSWORD in .env');
                this.enabled = false;
                return;
            }

            // Verify host is NOT Upstash
            if (redisHost.includes('upstash')) {
                console.error(`❌ CRITICAL: REDIS_HOST contains 'upstash'! This is wrong!`);
                console.error(`   Current REDIS_HOST: ${redisHost}`);
                console.error(`   This should be a Redis Cloud hostname, not Upstash!`);
                this.enabled = false;
                return;
            }

            // Redis Cloud connection configuration
            // Redis Cloud may require TLS - configured via REDIS_TLS environment variable
            // Set REDIS_TLS=true in .env if your Redis Cloud instance requires TLS
            const useTLS = process.env.REDIS_TLS === 'true' || process.env.REDIS_TLS === '1';
            
            const redisConfig = {
                host: redisHost,
                port: redisPort,
                password: redisPassword,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                },
                maxRetriesPerRequest: 3,
                enableReadyCheck: true,
                connectTimeout: 10000,
                lazyConnect: false, // Auto-connect on creation
            };
            
            // Add TLS configuration if enabled
            if (useTLS) {
                redisConfig.tls = {}; // Redis Cloud TLS configuration
                console.log('🔒 Redis Cloud: TLS enabled');
            } else {
                console.log('🔓 Redis Cloud: TLS disabled (standard connection)');
            }
            
            this.redis = new Redis(redisConfig);

            // Verify connection configuration immediately
            console.log(`🔍 Redis Client Configuration:`);
            console.log(`   Host: ${this.redis.options.host}`);
            console.log(`   Port: ${this.redis.options.port}`);
            console.log(`   Using TLS: ${useTLS ? 'YES' : 'NO'}`);

            // Handle connection events
            this.redis.on('connect', () => {
                console.log(`🔄 Connecting to Redis Cloud at ${this.redis.options.host}:${this.redis.options.port}...`);
            });

            this.redis.on('ready', () => {
                this.enabled = true;
                console.log(`✅ Redis cache layer initialized (Redis Cloud) - Connected to ${this.redis.options.host}:${this.redis.options.port}`);
            });

            this.redis.on('error', (error) => {
                // Check if error is from Upstash (shouldn't happen)
                if (error.message && error.message.includes('upstash.com')) {
                    console.error(`❌ CRITICAL: Upstash error in Redis connection!`);
                    console.error(`   Current Redis host: ${this.redis?.options?.host}`);
                    console.error(`   Current Redis port: ${this.redis?.options?.port}`);
                    console.error(`   Error: ${error.message}`);
                }
                console.warn('⚠️ Redis Client Error:', error.message);
                if (!this.enabled) {
                    // Only log on first error if not enabled yet
                    console.warn('   Continuing without cache - all requests will scrape');
                }
            });

            this.redis.on('close', () => {
                console.warn('⚠️ Redis connection closed');
                this.enabled = false;
            });

            // Set enabled to true initially (will be set on ready event)
            // This allows operations to queue while connecting
            this.enabled = true;
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
            // Check if error is from Upstash (shouldn't happen with Redis Cloud)
            const errorStr = JSON.stringify(error) + ' ' + (error.message || '') + ' ' + (error.stack || '');
            if (errorStr.toLowerCase().includes('upstash')) {
                console.error(`❌ CRITICAL: Upstash error detected in get()!`);
                console.error(`   Key: ${key}`);
                console.error(`   Current Redis host: ${this.redis?.options?.host}`);
                console.error(`   Current Redis port: ${this.redis?.options?.port}`);
                console.error(`   Error message: ${error.message}`);
                console.error(`   Full error object:`, error);
            }
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
            // Check if error is from Upstash (shouldn't happen with Redis Cloud)
            const errorStr = JSON.stringify(error) + ' ' + (error.message || '') + ' ' + (error.stack || '');
            if (errorStr.toLowerCase().includes('upstash')) {
                console.error(`❌ CRITICAL: Upstash error in set()!`);
                console.error(`   Key: ${key}`);
                console.error(`   Current Redis host: ${this.redis?.options?.host}`);
                console.error(`   Current Redis port: ${this.redis?.options?.port}`);
                console.error(`   Error message: ${error.message}`);
                console.error(`   Full error object:`, error);
            }
            console.warn(`⚠️ Redis set error for ${key}:`, error.message);
            return false;
        }
    }

    /**
     * Generic delete method for Redis keys
     * @param {string} key - Redis key to delete
     * @returns {Promise<boolean>} Success status
     */
    async del(key) {
        if (!this.enabled || !this.redis) {
            return false;
        }

        try {
            await this.redis.del(key);
            return true;
        } catch (error) {
            console.warn(`⚠️ Redis del error for ${key}:`, error.message);
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
            // Use SET with NX (only set if not exists) and EX (expire) options
            if (ttl && ttl > 0) {
                const result = await this.redis.set(key, value, 'EX', ttl, 'NX');
                return result === 'OK'; // Returns 'OK' if set, null if key exists
            } else {
                const result = await this.redis.set(key, value, 'NX');
                return result === 'OK';
            }
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
            // ioredis zadd format: zadd(key, score, member) or zadd(key, [score, member])
            await this.redis.zadd(key, score, member);
            return true;
        } catch (error) {
            // Check if error is from Upstash
            const errorStr = JSON.stringify(error) + ' ' + (error.message || '') + ' ' + (error.stack || '');
            if (errorStr.toLowerCase().includes('upstash')) {
                console.error(`❌ CRITICAL: Upstash error in zadd()!`);
                console.error(`   Key: ${key}, Member: ${member}`);
                console.error(`   Current Redis host: ${this.redis?.options?.host}`);
                console.error(`   Current Redis port: ${this.redis?.options?.port}`);
                console.error(`   Error message: ${error.message}`);
                console.error(`   Full error object:`, error);
            }
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
            // ioredis zrem format: zrem(key, member)
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
                // ioredis zrange with scores: zrange(key, start, stop, 'WITHSCORES')
                const result = await this.redis.zrange(key, start, stop, 'WITHSCORES');
                // ioredis returns array with alternating [member, score, member, score, ...]
                if (Array.isArray(result)) {
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
            if (withScores) {
                // ioredis zrangebyscore with scores: zrangebyscore(key, min, max, 'WITHSCORES')
                const result = await this.redis.zrangebyscore(key, min, max, 'WITHSCORES');
                // ioredis returns array with alternating [member, score, member, score, ...]
                if (Array.isArray(result)) {
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
                return await this.redis.zrangebyscore(key, min, max);
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
            // ioredis zscore format: zscore(key, member)
            const score = await this.redis.zscore(key, member);
            return score !== null && score !== undefined ? parseFloat(score) : null;
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



