// Use puppeteer (full package with bundled Chromium)
// puppeteer-extra wraps it to add stealth capabilities
const puppeteerBase = require('puppeteer');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');

// Set Puppeteer cache directory to node_modules/.cache/puppeteer
// This ensures Chromium persists from build to runtime on Render.com
if (!process.env.PUPPETEER_CACHE_DIR) {
    const cacheDir = path.join(__dirname, '..', 'node_modules', '.cache', 'puppeteer');
    process.env.PUPPETEER_CACHE_DIR = cacheDir;
}

// Apply stealth plugin
puppeteerExtra.use(StealthPlugin());

// Export puppeteer-extra for use
// We'll explicitly set executablePath to force use of bundled Chromium
const puppeteer = puppeteerExtra;

/**
 * Browser Pool Manager
 * Manages a persistent browser instance that is reused across all requests.
 * Each request gets its own isolated browser context for session isolation.
 */
class BrowserPool {
    constructor() {
        this.browser = null;
        this.isInitializing = false;
        this.isShuttingDown = false;
        this.activeContexts = new Set();
        this.initPromise = null;
        this.MAX_CONTEXTS = 15; // Increased to 15 for concurrent refreshes (was 5)
        this.preWarmedContexts = []; // Pre-warmed contexts for faster login
        this.preWarmPromise = null;
        this.contextQueue = []; // Queue for waiting requests when limit reached
        this.MAX_QUEUE_WAIT = 30000; // Max 30 seconds to wait for a context
    }

    /**
     * Initialize the browser instance (singleton pattern)
     * @returns {Promise<Browser>} The browser instance
     */
    async initialize() {
        // If already initialized, return existing browser
        if (this.browser) {
            return this.browser;
        }

        // If currently initializing, wait for that promise
        if (this.isInitializing && this.initPromise) {
            return this.initPromise;
        }

        // Start initialization
        this.isInitializing = true;
        this.initPromise = this._launchBrowser();

        try {
            this.browser = await this.initPromise;
            this.isInitializing = false;
            console.log('✅ Browser pool initialized successfully');
            
            // IMPROVEMENT: Pre-warm browser contexts for faster login
            this.preWarmContexts();
            
            return this.browser;
        } catch (error) {
            this.isInitializing = false;
            this.initPromise = null;
            console.error('❌ Failed to initialize browser pool:', error);
            throw error;
        }
    }

    /**
     * Launch the browser with optimized settings
     * 
     * NOTE: Uses puppeteer (full package) which automatically bundles Chromium.
     * We explicitly set executablePath to force use of bundled Chromium,
     * preventing puppeteer-extra from using puppeteer-core cache paths.
     * 
     * @private
     */
    async _launchBrowser() {
        console.log('🚀 Launching persistent browser instance...');
        
        // Try to get executablePath from bundled puppeteer
        let executablePath = null;
        try {
            executablePath = puppeteerBase.executablePath();
            console.log(`📦 Bundled Chromium path: ${executablePath ? executablePath.substring(0, 80) + '...' : 'NOT FOUND'}`);
        } catch (error) {
            console.warn(`⚠️ Could not get executable path: ${error.message}`);
            console.warn(`   Will attempt launch without explicit path`);
        }
        
        const launchOptions = {
            headless: true,
            // Render.com-compatible args
            args: [
                '--no-sandbox',                    // Required for Render.com
                '--disable-setuid-sandbox',        // Required for Render.com
                '--disable-dev-shm-usage',         // Prevents /dev/shm issues on Render.com
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--window-size=1920,1080',
                '--disable-gpu',                   // Useful for server environments
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
                '--disable-ipc-flooding-protection'
            ]
        };
        
        // Only set executablePath if we successfully got it
        if (executablePath) {
            launchOptions.executablePath = executablePath;
        }
        
        const browser = await puppeteer.launch(launchOptions);
        
        // Handle browser disconnection
        browser.on('disconnected', () => {
            console.warn('⚠️ Browser disconnected unexpectedly');
            this.browser = null;
            this.isInitializing = false;
            this.initPromise = null;
        });

        return browser;
    }

    /**
     * Pre-warm browser contexts for faster login (non-blocking)
     * Creates 2 pre-warmed contexts that can be reused
     */
    async preWarmContexts() {
        if (this.preWarmPromise) {
            return this.preWarmPromise;
        }
        
        this.preWarmPromise = (async () => {
            try {
                if (!this.browser || this.preWarmedContexts.length >= 2) {
                    return; // Already pre-warmed or browser not ready
                }
                
                // Pre-warm 2 contexts (non-blocking, fire-and-forget)
                for (let i = 0; i < 2 && this.preWarmedContexts.length < 2; i++) {
                    try {
                        const context = await this.browser.createBrowserContext();
                        const page = await context.newPage();
                        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                        await page.setViewport({ width: 1920, height: 1080 });
                        page.setDefaultNavigationTimeout(60000);
                        page.setDefaultTimeout(40000);
                        
                        this.preWarmedContexts.push({ context, page });
                        console.log(`🔥 Pre-warmed browser context ${i + 1}/2`);
                    } catch (error) {
                        console.warn(`⚠️ Failed to pre-warm context ${i + 1}:`, error.message);
                    }
                }
            } catch (error) {
                console.warn(`⚠️ Pre-warming failed:`, error.message);
            }
        })();
        
        return this.preWarmPromise;
    }

    /**
     * Get a pre-warmed context if available, otherwise create a new one
     * @returns {Promise<Object>} Object containing context and page
     */
    async getOrCreateContext() {
        // Try to use a pre-warmed context first
        if (this.preWarmedContexts.length > 0) {
            const preWarmed = this.preWarmedContexts.pop();
            this.activeContexts.add(preWarmed.context);
            console.log(`⚡ Reusing pre-warmed browser context (${this.activeContexts.size}/${this.MAX_CONTEXTS} active)`);
            
            // Replenish pre-warmed pool in background
            this.preWarmContexts();
            
            return {
                context: preWarmed.context,
                page: preWarmed.page,
                contextId: preWarmed.context.id || Date.now()
            };
        }
        
        // No pre-warmed context available, create new one
        return await this.createContext();
    }

    /**
     * Process the context queue when a context becomes available
     * @private
     */
    _processContextQueue() {
        // Process queue if we have capacity and waiting requests
        while (this.contextQueue.length > 0 && this.activeContexts.size < this.MAX_CONTEXTS) {
            const queueEntry = this.contextQueue.shift();
            clearTimeout(queueEntry.timeout);
            
            // Try to create context for this queued request
            this._createContextInternal()
                .then(contextData => {
                    queueEntry.resolve(contextData);
                })
                .catch(error => {
                    queueEntry.reject(error);
                });
        }
    }

    /**
     * Internal method to create a context (without queue check)
     * @private
     * @returns {Promise<Object>} Object containing context and page
     */
    async _createContextInternal() {
        // Ensure browser is initialized
        if (!this.browser) {
            await this.initialize();
        }

        // Verify browser is still connected
        if (!this.browser.isConnected()) {
            console.warn('⚠️ Browser disconnected, reinitializing...');
            this.browser = null;
            await this.initialize();
        }

        try {
            // Create a new context for this request (session isolation)
            const context = await this.browser.createBrowserContext();
            const page = await context.newPage();

            // Configure page settings
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1920, height: 1080 });
            page.setDefaultNavigationTimeout(60000);
            page.setDefaultTimeout(40000);

            // Track active context
            this.activeContexts.add(context);

            console.log(`📄 Created new browser context from pool (reusing browser, ${this.activeContexts.size}/${this.MAX_CONTEXTS} active contexts)`);

            return {
                context,
                page,
                contextId: context.id || Date.now()
            };
        } catch (error) {
            console.error('❌ Failed to create browser context:', error);
            throw error;
        }
    }

    /**
     * Create a new browser context for session isolation
     * Max 15 concurrent contexts (increased from 5 for concurrent refreshes)
     * @returns {Promise<Object>} Object containing context and page
     */
    async createContext() {
        if (this.isShuttingDown) {
            throw new Error('Browser pool is shutting down');
        }

        // IMPROVEMENT: Queue mechanism instead of throwing error immediately
        // Wait for a context to become available if limit is reached
        if (this.activeContexts.size >= this.MAX_CONTEXTS) {
            console.log(`⏳ Max browser contexts (${this.MAX_CONTEXTS}) reached, waiting for available context...`);
            
            return new Promise((resolve, reject) => {
                const queueEntry = {
                    resolve,
                    reject,
                    startTime: Date.now()
                };
                
                this.contextQueue.push(queueEntry);
                
                // Set timeout to prevent indefinite waiting
                const timeout = setTimeout(() => {
                    const index = this.contextQueue.indexOf(queueEntry);
                    if (index !== -1) {
                        this.contextQueue.splice(index, 1);
                        reject(new Error(`Timeout waiting for browser context after ${this.MAX_QUEUE_WAIT}ms`));
                    }
                }, this.MAX_QUEUE_WAIT);
                
                // Store timeout ID for cleanup
                queueEntry.timeout = timeout;
                
                // Try to process queue immediately (in case context was freed)
                this._processContextQueue();
            });
        }

        // Use internal method to create context
        return await this._createContextInternal();
    }

    /**
     * Close a browser context
     * @param {Object} context - The browser context to close
     */
    async closeContext(context) {
        if (!context) {
            return;
        }

        try {
            // Remove from tracking
            if (this.activeContexts.has(context)) {
                this.activeContexts.delete(context);
            }

            // Close the context (this closes all pages in the context)
            await context.close();

            console.log(`🔒 Closed browser context (${this.activeContexts.size} active)`);
            
            // IMPROVEMENT: Process queue when context is freed
            this._processContextQueue();
        } catch (error) {
            console.error('⚠️ Error closing browser context:', error);
            // Don't throw - context might already be closed
            
            // Still process queue even if close failed
            this._processContextQueue();
        }
    }

    /**
     * Get the number of active contexts
     * @returns {number}
     */
    getActiveContextCount() {
        return this.activeContexts.size;
    }

    /**
     * Check if browser is initialized
     * @returns {boolean}
     */
    isInitialized() {
        return this.browser !== null && this.browser.isConnected();
    }

    /**
     * Gracefully shutdown the browser pool
     * Closes all active contexts and then closes the browser
     */
    async shutdown() {
        if (this.isShuttingDown) {
            return;
        }

        this.isShuttingDown = true;
        console.log('🛑 Shutting down browser pool...');

        // Close all active contexts first
        const contextsToClose = Array.from(this.activeContexts);
        const closePromises = contextsToClose.map(context => this.closeContext(context));

        try {
            await Promise.allSettled(closePromises);
            console.log(`✅ Closed ${contextsToClose.length} active contexts`);
        } catch (error) {
            console.error('⚠️ Error closing some contexts:', error);
        }

        // Close the browser
        if (this.browser) {
            try {
                await this.browser.close();
                console.log('✅ Browser closed successfully');
            } catch (error) {
                console.error('⚠️ Error closing browser:', error);
            }
            this.browser = null;
        }

        this.activeContexts.clear();
        this.isInitializing = false;
        this.initPromise = null;
        console.log('✅ Browser pool shutdown complete');
    }

    /**
     * Restart the browser (useful for recovery)
     */
    async restart() {
        console.log('🔄 Restarting browser pool...');
        await this.shutdown();
        this.isShuttingDown = false;
        await this.initialize();
    }
}

// Export singleton instance
const browserPool = new BrowserPool();

module.exports = browserPool;

