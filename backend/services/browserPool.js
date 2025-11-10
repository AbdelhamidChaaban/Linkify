const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Apply stealth plugin
puppeteer.use(StealthPlugin());

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
     * @private
     */
    async _launchBrowser() {
        console.log('🚀 Launching persistent browser instance...');
        
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--window-size=1920,1080',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
                '--disable-ipc-flooding-protection'
            ]
        });

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
     * Create a new browser context for session isolation
     * @returns {Promise<Object>} Object containing context and page
     */
    async createContext() {
        if (this.isShuttingDown) {
            throw new Error('Browser pool is shutting down');
        }

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
            // This reuses the existing browser instance - no new browser launch!
            // The browser was launched once on server startup and is reused here
            const context = await this.browser.createBrowserContext();
            const page = await context.newPage();

            // Configure page settings
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1920, height: 1080 });
            page.setDefaultNavigationTimeout(60000);
            page.setDefaultTimeout(40000);

            // Track active context
            this.activeContexts.add(context);

            console.log(`📄 Created new browser context from pool (reusing browser, ${this.activeContexts.size} active contexts)`);

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
        } catch (error) {
            console.error('⚠️ Error closing browser context:', error);
            // Don't throw - context might already be closed
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

