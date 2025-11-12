/**
 * Request Queue Manager
 * Prevents concurrent refresh requests for the same admin
 * Ensures only one refresh operation per admin at a time
 */

class RequestQueue {
    constructor() {
        // Map of adminId -> Promise of ongoing refresh
        this.activeRequests = new Map();
        
        // Map of adminId -> queue of pending requests
        this.pendingQueues = new Map();
        
        // Maximum concurrent requests across all admins
        this.maxConcurrent = parseInt(process.env.MAX_CONCURRENT_REFRESHES) || 5;
        this.currentConcurrent = 0;
    }

    /**
     * Execute a refresh request with queuing
     * If a request for the same admin is already in progress, deduplicate it
     * @param {string} adminId - Admin identifier
     * @param {Function} refreshFn - Function that performs the refresh
     * @returns {Promise} Result of the refresh
     */
    async execute(adminId, refreshFn) {
        const identifier = adminId || 'unknown';
        
        // Check if there's already an active request for this admin
        const activeRequest = this.activeRequests.get(identifier);
        
        if (activeRequest) {
            console.log(`⏳ Request for ${identifier} is already in progress, deduplicating (${this.activeRequests.size} active, ${this.currentConcurrent}/${this.maxConcurrent} concurrent)...`);
            
            // Return the existing promise (deduplication)
            // This means if multiple requests come for the same admin, they all wait for the same result
            try {
                return await activeRequest;
            } catch (error) {
                // If the original request failed, allow a retry
                // But only if it's still the same request (not a new one)
                if (this.activeRequests.get(identifier) === activeRequest) {
                    throw error;
                }
                // Otherwise, a new request has started, return that result
                return await this.activeRequests.get(identifier);
            }
        }

        // Check if we've hit the max concurrent limit
        if (this.currentConcurrent >= this.maxConcurrent) {
            console.log(`⏳ Max concurrent requests (${this.maxConcurrent}) reached, waiting for slot... (${this.currentConcurrent} active)`);
            
            // Wait for a slot to become available
            await this.waitForSlot();
        }

        // Create a new request promise
        const requestPromise = this._executeRequest(identifier, refreshFn);
        
        // Store it as active
        this.activeRequests.set(identifier, requestPromise);
        this.currentConcurrent++;

        try {
            const result = await requestPromise;
            return result;
        } catch (error) {
            // Log error but don't swallow it
            console.error(`❌ Request for ${identifier} failed:`, error.message);
            throw error;
        } finally {
            // Clean up
            this.activeRequests.delete(identifier);
            this.currentConcurrent--;
            
            console.log(`✅ Request for ${identifier} completed (${this.activeRequests.size} active, ${this.currentConcurrent}/${this.maxConcurrent} concurrent)`);
        }
    }

    /**
     * Execute the actual refresh request
     * @private
     */
    async _executeRequest(identifier, refreshFn) {
        try {
            console.log(`🔄 Executing refresh for ${identifier} (${this.currentConcurrent}/${this.maxConcurrent} concurrent)`);
            const result = await refreshFn();
            return result;
        } catch (error) {
            console.error(`❌ Error executing refresh for ${identifier}:`, error.message);
            throw error;
        }
    }

    /**
     * Wait for a slot to become available
     * @private
     */
    async waitForSlot() {
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                if (this.currentConcurrent < this.maxConcurrent) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100); // Check every 100ms
            
            // Timeout after 30 seconds
            setTimeout(() => {
                clearInterval(checkInterval);
                resolve(); // Resolve anyway to prevent infinite wait
            }, 30000);
        });
    }

    /**
     * Process next request in queue
     * @private
     */
    _processNextInQueue() {
        // This method is kept for future queue implementation
        // Currently using deduplication instead of queuing
    }

    /**
     * Get current queue status
     * @returns {Object} Status information
     */
    getStatus() {
        return {
            activeRequests: this.activeRequests.size,
            currentConcurrent: this.currentConcurrent,
            maxConcurrent: this.maxConcurrent,
            pendingQueues: Array.from(this.pendingQueues.entries()).map(([id, queue]) => ({
                adminId: id,
                pendingCount: queue.length
            }))
        };
    }

    /**
     * Clear all queues (useful for cleanup)
     */
    clear() {
        this.activeRequests.clear();
        this.pendingQueues.clear();
        this.currentConcurrent = 0;
    }
}

// Export singleton instance
const requestQueue = new RequestQueue();

module.exports = requestQueue;

