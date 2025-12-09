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
        // Increased for high concurrency - API calls are fast and parallel
        this.maxConcurrent = parseInt(process.env.MAX_CONCURRENT_REFRESHES) || 20;
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
        
        // CRITICAL: Atomic check-and-set to prevent race conditions
        // Check if there's already an active request for this admin
        let activeRequest = this.activeRequests.get(identifier);
        
        if (activeRequest) {
            // Check if the request has been stuck for more than 5 minutes (300 seconds)
            // If so, clear it and allow a new request
            const requestAge = Date.now() - (activeRequest.startTime || 0);
            const maxAge = 5 * 60 * 1000; // 5 minutes
            
            if (requestAge > maxAge) {
                console.log(`⚠️ [Queue] Request for ${identifier} has been stuck for ${Math.round(requestAge / 1000)}s, clearing and allowing new request...`);
                this.activeRequests.delete(identifier);
                this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
                activeRequest = null; // Clear so we can proceed
            } else {
                console.log(`⏳ [Queue] Request for ${identifier} is already in progress, deduplicating (${this.activeRequests.size} active, ${this.currentConcurrent}/${this.maxConcurrent} concurrent)...`);
                
                // Return the existing promise (deduplication)
                // This means if multiple requests come for the same admin, they all wait for the same result
                try {
                    return await activeRequest.promise;
                } catch (error) {
                    // If the original request failed, allow a retry
                    // But only if it's still the same request (not a new one)
                    const currentRequest = this.activeRequests.get(identifier);
                    if (currentRequest === activeRequest) {
                        throw error;
                    }
                    // Otherwise, a new request has started, return that result
                    if (currentRequest) {
                        return await currentRequest.promise;
                    }
                    // If no current request, fall through to create a new one
                }
            }
        }
        
        // Double-check after potential async operations (defensive programming)
        if (!activeRequest) {
            activeRequest = this.activeRequests.get(identifier);
            if (activeRequest) {
                console.log(`⏳ [Queue] Another request started for ${identifier} while we were waiting, deduplicating...`);
                try {
                    return await activeRequest.promise;
                } catch (error) {
                    // Fall through to create new request if this one failed
                }
            }
        }

        // Check if we've hit the max concurrent limit
        if (this.currentConcurrent >= this.maxConcurrent) {
            console.log(`⏳ Max concurrent requests (${this.maxConcurrent}) reached, waiting for slot... (${this.currentConcurrent} active)`);
            
            // Wait for a slot to become available
            await this.waitForSlot();
        }

        // CRITICAL: Final check before creating new request (prevent race condition)
        // Another request might have started while we were waiting for a slot
        const finalCheck = this.activeRequests.get(identifier);
        if (finalCheck) {
            console.log(`⏳ [Queue] Another request started for ${identifier} while waiting for slot, deduplicating...`);
            try {
                return await finalCheck.promise;
            } catch (error) {
                // Fall through if that request failed
            }
        }
        
        // Create a new request promise with timeout
        const requestWrapper = {
            promise: this._executeRequest(identifier, refreshFn),
            startTime: Date.now()
        };
        
        // Add timeout to prevent stuck requests (5 minutes max)
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Request timeout after 5 minutes`));
            }, 5 * 60 * 1000); // 5 minutes
        });
        
        const requestPromise = Promise.race([requestWrapper.promise, timeoutPromise]);
        
        // CRITICAL: Atomic set - check one more time before setting (defensive)
        const lastCheck = this.activeRequests.get(identifier);
        if (lastCheck) {
            console.log(`⏳ [Queue] Another request started for ${identifier} at the last moment, deduplicating...`);
            try {
                return await lastCheck.promise;
            } catch (error) {
                // Fall through if that request failed
            }
        }
        
        // Store it as active (now we're sure no other request exists)
        this.activeRequests.set(identifier, requestWrapper);
        this.currentConcurrent++;
        console.log(`🔄 [Queue] Starting new request for ${identifier} (${this.currentConcurrent}/${this.maxConcurrent} concurrent)`);

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
            this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
            
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
            }, 50); // Check every 50ms for faster response
            
            // Timeout after 10 seconds (reduced from 30s since API calls are fast)
            setTimeout(() => {
                clearInterval(checkInterval);
                resolve(); // Resolve anyway to prevent infinite wait
            }, 10000);
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

    /**
     * Clear a specific admin's stuck request
     * @param {string} adminId - Admin identifier
     */
    clearRequest(adminId) {
        const identifier = adminId || 'unknown';
        if (this.activeRequests.has(identifier)) {
            console.log(`🧹 Clearing stuck request for ${identifier}`);
            this.activeRequests.delete(identifier);
            this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
            return true;
        }
        return false;
    }
}

// Export singleton instance
const requestQueue = new RequestQueue();

module.exports = requestQueue;

