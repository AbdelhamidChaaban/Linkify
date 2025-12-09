// Load environment variables first
// Try to load from backend folder first, then from parent directory (root)
const path = require('path');
const fs = require('fs');

const backendEnvPath = path.join(__dirname, '.env');
const rootEnvPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(backendEnvPath)) {
    require('dotenv').config({ path: backendEnvPath });
} else if (fs.existsSync(rootEnvPath)) {
    require('dotenv').config({ path: rootEnvPath });
} else {
    // Try default location (current directory)
    require('dotenv').config();
    console.log('⚠️  No .env file found in backend/ or root/. Using default dotenv behavior.');
}

// Suppress PM2 pidusage errors on Windows (wmic not available)
// These errors don't affect functionality but clutter logs
if (process.platform === 'win32') {
    const originalEmit = process.emit;
    process.emit = function(event, error) {
        if (event === 'uncaughtException' && error && error.message) {
            if (error.message.includes('wmic') || 
                error.message.includes('spawn wmic') ||
                error.message.includes('pidusage')) {
                // Silently ignore wmic/pidusage errors - monitoring is not critical
                return false;
            }
        }
        return originalEmit.apply(process, arguments);
    };
}

const express = require('express');
const cors = require('cors');

// Load services - Use API-first approach
const { fetchAlfaData } = require('./services/alfaServiceApiFirst');
const browserPool = require('./services/browserPool');
const cacheLayer = require('./services/cacheLayer');
const scheduledRefresh = require('./services/scheduledRefresh');
const cookieRefreshWorker = require('./services/cookieRefreshWorker');
const { addSubscriber } = require('./services/alfaAddSubscriber');
const { editSubscriber } = require('./services/alfaEditSubscriber');
const { removeSubscriber } = require('./services/alfaRemoveSubscriber');
const { getAdminData, getFullAdminData, getBalanceHistory } = require('./services/firebaseDbService');
const { prepareEditSession, getActiveSession, closeSession } = require('./services/ushareEditSession');

const app = express();
// Parse PORT as integer and validate range (0-65535)
// Render.com automatically sets PORT environment variable
const PORT = (() => {
    const envPort = process.env.PORT;
    if (!envPort) {
        console.warn(`⚠️  PORT environment variable not set, using default 10000`);
        return 10000; // Render.com default or set in environment
    }
    const parsed = parseInt(envPort, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > 65535) {
        console.warn(`⚠️  Invalid PORT value "${envPort}", using default 10000`);
        return 10000;
    }
    console.log(`📡 Using PORT: ${parsed}`);
    return parsed;
})();

// Function to find available port
function findAvailablePort(startPort) {
    return new Promise((resolve, reject) => {
        // Ensure startPort is a number
        const port = typeof startPort === 'number' ? startPort : parseInt(startPort, 10) || 3000;
        if (port < 0 || port > 65535) {
            reject(new Error(`Invalid port number: ${port}. Must be between 0 and 65535.`));
            return;
        }
        const server = require('net').createServer();
        server.listen(port, () => {
            const actualPort = server.address().port;
            server.close(() => resolve(actualPort));
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                // Try next port
                findAvailablePort(port + 1).then(resolve).catch(reject);
            } else {
                reject(err);
            }
        });
    });
}

// Middleware
// CORS configuration - Allow requests from Vercel and localhost
app.use(cors({
    origin: [
        /\.vercel\.app$/,  // All Vercel deployments
        /\.onrender\.com$/,  // All Render deployments (for testing)
        'http://localhost:3000',
        'http://localhost:8080',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:8080'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Import request queue for handling concurrent requests
const requestQueue = require('./services/requestQueue');

// Health check (before static files to avoid conflicts)
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        browserPool: {
            initialized: browserPool.isInitialized(),
            activeContexts: browserPool.getActiveContextCount()
        },
        cache: {
            enabled: cacheLayer.isAvailable(),
            ttl: cacheLayer.getTTL(),
            ttlMinutes: Math.round(cacheLayer.getTTL() / 60)
        }
    });
});

// Cache management endpoint (optional - for debugging/admin)
app.delete('/api/cache/:identifier', async (req, res) => {
    try {
        const { identifier } = req.params;
        const deleted = await cacheLayer.delete(identifier);
        
        res.json({
            success: deleted,
            message: deleted ? `Cache cleared for ${identifier}` : `Failed to clear cache for ${identifier}`
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error?.message || 'Unknown error occurred'
        });
    }
});

// Get cache stats (optional - for debugging)
app.get('/api/cache/:identifier/stats', async (req, res) => {
    try {
        const { identifier } = req.params;
        const stats = await cacheLayer.getStats(identifier);
        res.json(stats);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error?.message || 'Unknown error occurred'
        });
    }
});

// Fetch Alfa dashboard data (with incremental scraping support)
app.post('/api/alfa/fetch', async (req, res) => {
    try {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`🔵 [API] /api/alfa/fetch request received at ${new Date().toISOString()}`);
        console.log(`   Body keys: ${Object.keys(req.body).join(', ')}`);
        console.log(`${'='.repeat(80)}\n`);
        
        const { phone, password, adminId } = req.body;

        if (!phone || !password) {
            console.log(`⚠️ [API] Missing phone or password in request`);
            return res.status(400).json({
                success: false,
                error: 'Phone and password are required'
            });
        }

        const identifier = adminId || phone;
        console.log(`[${new Date().toISOString()}] 🔵 [API] Fetching Alfa data for admin: ${identifier}`);

        // CRITICAL: Check for existing refresh lock BEFORE processing to prevent concurrent logins
        const { hasRefreshLock, getLastJson } = require('./services/cookieManager');
        const existingLock = await hasRefreshLock(identifier);
        
        if (existingLock) {
            console.log(`⏸️ [API] Refresh already in progress for ${identifier}, returning cached data...`);
            const cachedData = await getLastJson(identifier, true); // allowStale for instant response
            if (cachedData && cachedData.data) {
                const cacheAge = Date.now() - (cachedData.timestamp || 0);
                const cacheAgeMinutes = Math.round(cacheAge / 60000);
                console.log(`⚡ [API] Returning cached data (refresh in progress, age: ${cacheAgeMinutes}min)`);
                return res.json({
                    success: true,
                    incremental: false,
                    noChanges: false,
                    data: cachedData.data,
                    timestamp: Date.now(),
                    cached: true,
                    stale: cacheAge > 60000,
                    refreshInProgress: true,
                    message: 'Refresh already in progress, returning cached data'
                });
            }
            // If no cached data, continue with refresh (but requestQueue will deduplicate)
        }

        // Use request queue to prevent concurrent refreshes for the same admin
        const startTime = Date.now();
        const data = await requestQueue.execute(identifier, async () => {
            return await fetchAlfaData(phone, password, adminId, identifier);
        });
        const duration = Date.now() - startTime;

        // Check if this was an incremental (no-changes) response
        if (data.incremental && data.noChanges) {
            console.log(`[${new Date().toISOString()}] ⚡ Incremental check: No changes (${duration}ms)`);
            res.json({
                success: true,
                incremental: true,
                noChanges: true,
                message: data.message || 'No changes detected since last refresh',
                data: data.data || {},
                duration: duration,
                timestamp: data.timestamp,
                lastUpdate: data.lastUpdate
            });
        } else {
            console.log(`[${new Date().toISOString()}] ✅ Completed ${data.incremental ? 'incremental' : 'full'} scrape in ${duration}ms`);
            res.json({
                success: true,
                incremental: data.incremental || false,
                noChanges: false,
                data: data,
                duration: duration,
                timestamp: data.timestamp || Date.now()
            });
        }
    } catch (error) {
        console.error('❌ Error fetching Alfa data:', error);
        console.error('Error message:', error?.message);
        console.error('Stack trace:', error?.stack);
        
        res.status(500).json({
            success: false,
            incremental: false,
            error: error?.message || 'Unknown error occurred'
        });
    }
});

// Get request queue status (for monitoring)
app.get('/api/queue/status', (req, res) => {
    try {
        const status = requestQueue.getStatus();
        res.json({
            success: true,
            ...status
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Manual trigger for scheduled refresh (for testing/admin)
app.post('/api/scheduled-refresh/trigger', async (req, res) => {
    try {
        console.log('🔧 Manual scheduled refresh triggered via API');
        await scheduledRefresh.manualRefresh();
        res.json({
            success: true,
            message: 'Scheduled refresh completed'
        });
    } catch (error) {
        console.error('❌ Error triggering scheduled refresh:', error);
        res.status(500).json({
            success: false,
            error: error?.message || 'Unknown error occurred'
        });
    }
});

// Clear stuck request for an admin
app.post('/api/refresh/clear-stuck', async (req, res) => {
    try {
        const { adminId } = req.body;
        if (!adminId) {
            return res.status(400).json({
                success: false,
                error: 'adminId is required'
            });
        }

        // Clear from request queue
        const cleared = requestQueue.clearRequest(adminId);
        
        // Also clear Redis lock if it exists
        const { releaseRefreshLock } = require('./services/cookieManager');
        await releaseRefreshLock(adminId).catch(() => {});

        if (cleared) {
            console.log(`🧹 Cleared stuck request for admin: ${adminId}`);
            res.json({
                success: true,
                message: `Cleared stuck request for ${adminId}`
            });
        } else {
            res.json({
                success: true,
                message: `No stuck request found for ${adminId} (may have already cleared)`
            });
        }
    } catch (error) {
        console.error('❌ Error clearing stuck request:', error);
        res.status(500).json({
            success: false,
            error: error?.message || 'Unknown error occurred'
        });
    }
});

// Add subscriber endpoint
app.post('/api/subscribers/add', async (req, res) => {
    try {
        const { adminId, subscriberPhone, quota } = req.body;

        if (!adminId || !subscriberPhone || !quota) {
            return res.status(400).json({
                success: false,
                error: 'adminId, subscriberPhone, and quota are required'
            });
        }

        console.log(`[${new Date().toISOString()}] Adding subscriber for admin: ${adminId}`);
        console.log(`   Subscriber: ${subscriberPhone}, Quota: ${quota} GB`);

        // Get admin data from Firebase
        const adminData = await getAdminData(adminId);
        if (!adminData || !adminData.phone || !adminData.password) {
            return res.status(404).json({
                success: false,
                error: 'Admin not found or missing credentials'
            });
        }

        // Call addSubscriber service
        const result = await addSubscriber(
            adminId,
            adminData.phone,
            adminData.password,
            subscriberPhone,
            parseFloat(quota)
        );

        if (result.success) {
            console.log(`[${new Date().toISOString()}] ✅ Successfully added subscriber`);
            
            // Store as pending subscriber in Firebase (wait for it to complete)
            const { addPendingSubscriber } = require('./services/firebaseDbService');
            try {
                const added = await addPendingSubscriber(adminId, subscriberPhone, parseFloat(quota));
                if (added) {
                    console.log(`[${new Date().toISOString()}] ✅ Pending subscriber ${subscriberPhone} stored in Firebase for admin ${adminId}`);
                } else {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Failed to store pending subscriber ${subscriberPhone} in Firebase`);
                }
            } catch (pendingError) {
                console.warn(`⚠️ Could not add pending subscriber (non-critical):`, pendingError?.message);
            }
            
            res.json({
                success: true,
                message: result.message || 'Subscriber added successfully'
            });
        } else {
            console.log(`[${new Date().toISOString()}] ❌ Failed to add subscriber: ${result.message}`);
            res.status(500).json({
                success: false,
                error: result.message || 'Failed to add subscriber'
            });
        }
    } catch (error) {
        console.error('❌ Error adding subscriber:', error);
        console.error('Error message:', error?.message);
        console.error('Stack trace:', error?.stack);
        
        res.status(500).json({
            success: false,
            error: error?.message || 'Unknown error occurred while adding subscriber'
        });
    }
});

// Edit subscribers endpoint (update quota, add, remove)
app.post('/api/subscribers/edit', async (req, res) => {
    try {
        const { adminId, sessionId, updates, removals, additions } = req.body;

        if (!adminId) {
            return res.status(400).json({
                success: false,
                error: 'adminId is required'
            });
        }

        console.log(`[${new Date().toISOString()}] Editing subscribers for admin: ${adminId}`);
        console.log(`   Updates: ${updates?.length || 0}, Removals: ${removals?.length || 0}, Additions: ${additions?.length || 0}`);

        // Get admin data from Firebase
        const adminData = await getAdminData(adminId);
        if (!adminData || !adminData.phone || !adminData.password) {
            return res.status(404).json({
                success: false,
                error: 'Admin not found or missing credentials'
            });
        }

        const { addPendingSubscriber, removePendingSubscriber, addRemovedSubscriber, addRemovedActiveSubscriber, getAdminData: getFullAdminData } = require('./services/firebaseDbService');
        const results = {
            updates: [],
            removals: [],
            additions: []
        };
        
        // Get session data if sessionId provided (for faster edits using existing page)
        let sessionData = null;
        if (sessionId) {
            sessionData = getActiveSession(sessionId);
            if (sessionData) {
                console.log(`⚡ Using existing edit session for faster operations`);
            } else {
                console.log(`⚠️ Session ${sessionId} not found or expired, will create new page`);
            }
        }

        // Handle additions
        if (additions && Array.isArray(additions) && additions.length > 0) {
            for (const addition of additions) {
                if (addition.phone && addition.quota) {
                    try {
                        // Pass sessionData to use existing page if available (faster)
                        const result = await addSubscriber(
                            adminId,
                            adminData.phone,
                            adminData.password,
                            addition.phone,
                            parseFloat(addition.quota),
                            sessionData
                        );
                        
                        if (result.success) {
                            await addPendingSubscriber(adminId, addition.phone, parseFloat(addition.quota));
                            results.additions.push({ phone: addition.phone, success: true });
                        } else {
                            results.additions.push({ phone: addition.phone, success: false, error: result.message });
                        }
                    } catch (error) {
                        results.additions.push({ phone: addition.phone, success: false, error: error.message });
                    }
                }
            }
        }

        // Handle removals (browser automation to remove from Alfa)
        if (removals && Array.isArray(removals) && removals.length > 0) {
            // Get current subscriber data before removal to check status (Active vs Requested)
            const currentAdminData = await getFullAdminData(adminId);
            const currentSecondarySubscribers = currentAdminData?.alfaData?.secondarySubscribers || [];
            
            for (const phone of removals) {
                try {
                    // Check if subscriber is Active or Requested BEFORE removal
                    const cleanPhone = phone.replace(/^961/, ''); // Remove 961 prefix if present
                    const subscriberInList = currentSecondarySubscribers.find(
                        sub => sub.phoneNumber === cleanPhone || sub.phoneNumber === phone
                    );
                    const isActive = subscriberInList && subscriberInList.status === 'Active';
                    
                    // Remove from Alfa using browser automation
                    // Pass sessionData to use existing page if available (faster)
                    const result = await removeSubscriber(
                        adminId,
                        adminData.phone,
                        adminData.password,
                        phone,
                        sessionData
                    );
                    
                    if (result.success) {
                        // Remove from pending subscribers in Firebase (if pending)
                        await removePendingSubscriber(adminId, phone).catch(() => {
                            // Non-critical if not in pending list
                        });
                        
                        // Only add to removedSubscribers if subscriber was Active
                        // Requested subscribers will disappear naturally (won't show in view details)
                        if (isActive && subscriberInList) {
                            // Store removed Active subscriber with full data so it can be displayed as "Out"
                            await addRemovedActiveSubscriber(adminId, {
                                phoneNumber: subscriberInList.phoneNumber,
                                fullPhoneNumber: subscriberInList.fullPhoneNumber || subscriberInList.phoneNumber,
                                consumption: subscriberInList.consumption || 0,
                                limit: subscriberInList.quota || subscriberInList.limit || 0
                            }).catch(() => {
                                // Non-critical
                            });
                        }
                        
                        results.removals.push({ phone, success: true });
                    } else {
                        results.removals.push({ phone, success: false, error: result.message });
                    }
                } catch (error) {
                    results.removals.push({ phone, success: false, error: error.message });
                }
            }
        }

        // Handle updates (quota changes via browser automation)
        if (updates && Array.isArray(updates) && updates.length > 0) {
            for (const update of updates) {
                if (update.phone && update.quota) {
                    try {
                        // Edit subscriber quota in Alfa using browser automation
                        // Pass sessionData if available (for faster edits using existing page)
                        const result = await editSubscriber(
                            adminId,
                            adminData.phone,
                            adminData.password,
                            update.phone,
                            parseFloat(update.quota),
                            sessionData // Pass session to reuse existing page
                        );
                        
                        if (result.success) {
                            // Update pending subscriber quota in Firebase if it exists
                            try {
                                await removePendingSubscriber(adminId, update.phone);
                                await addPendingSubscriber(adminId, update.phone, parseFloat(update.quota));
                            } catch (firebaseError) {
                                // Non-critical if not in pending list
                                console.log(`ℹ️ Could not update pending subscriber (non-critical): ${firebaseError.message}`);
                            }
                            results.updates.push({ phone: update.phone, success: true });
                        } else {
                            results.updates.push({ phone: update.phone, success: false, error: result.message });
                        }
                    } catch (error) {
                        results.updates.push({ phone: update.phone, success: false, error: error.message });
                    }
                }
            }
        }

        const allSuccess = 
            results.additions.every(r => r.success) &&
            results.removals.every(r => r.success) &&
            results.updates.every(r => r.success);

        res.json({
            success: allSuccess,
            results: results,
            message: allSuccess ? 'Subscribers updated successfully' : 'Some operations failed'
        });
    } catch (error) {
        console.error('❌ Error editing subscribers:', error);
        res.status(500).json({
            success: false,
            error: error?.message || 'Unknown error occurred while editing subscribers'
        });
    }
});

// Prepare edit session: Navigate to Ushare page and return subscriber data + session ID
app.post('/api/ushare/prepare-edit', async (req, res) => {
    try {
        const { adminId } = req.body;
        
        if (!adminId) {
            return res.status(400).json({
                success: false,
                error: 'adminId is required'
            });
        }
        
        console.log(`[${new Date().toISOString()}] Preparing edit session for admin: ${adminId}`);
        
        // Get admin data
        const adminData = await getAdminData(adminId);
        if (!adminData || !adminData.phone || !adminData.password) {
            return res.status(404).json({
                success: false,
                error: 'Admin not found or missing credentials'
            });
        }
        
        // Prepare edit session (navigates to Ushare page and returns data + session ID)
        const result = await prepareEditSession(adminId, adminData.phone, adminData.password);
        
        if (result.success) {
            res.json({
                success: true,
                sessionId: result.sessionId,
                data: result.data
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error || 'Failed to prepare edit session'
            });
        }
    } catch (error) {
        console.error('❌ Error preparing edit session:', error);
        res.status(500).json({
            success: false,
            error: error?.message || 'Unknown error occurred'
        });
    }
});

// Close edit session
app.post('/api/ushare/close-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (sessionId) {
            await closeSession(sessionId);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error closing session:', error);
        res.status(500).json({
            success: false,
            error: error?.message || 'Unknown error occurred'
        });
    }
});

// Get balance history endpoint
app.get('/api/admin/:adminId/balance-history', async (req, res) => {
    try {
        const { adminId } = req.params;
        
        if (!adminId) {
            return res.status(400).json({
                success: false,
                error: 'adminId is required'
            });
        }
        
        const balanceHistory = await getBalanceHistory(adminId);
        
        res.json({
            success: true,
            data: balanceHistory
        });
    } catch (error) {
        console.error('❌ Error getting balance history:', error);
        res.status(500).json({
            success: false,
            error: error?.message || 'Unknown error occurred'
        });
    }
});

// Serve frontend static files (AFTER all API routes)
const frontendPath = path.join(__dirname, '../frontend');
console.log('📁 Frontend path:', frontendPath);
app.use(express.static(frontendPath));

// Log static file serving for debugging
app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/health') {
        return next();
    }
    console.log(`[Static] Request: ${req.path}`);
    next();
});

// Initialize browser pool and start server
async function startServer() {
    try {
        // CRITICAL: Start server FIRST (non-blocking) so Render.com detects the port
        // Browser pool initialization will happen in background
        const actualPort = await findAvailablePort(PORT);
        
        // Start server immediately (before browser pool initialization)
        app.listen(actualPort, () => {
            console.log(`🚀 Linkify backend server running on port ${actualPort}`);
            console.log(`📁 Serving static files from: ${frontendPath}`);
            console.log(`🌐 Access frontend at: http://localhost:${actualPort}/`);
            console.log(`📄 Home page: http://localhost:${actualPort}/pages/home.html`);
            console.log(`\n⚠️  Note: If port ${PORT} was in use, server is running on port ${actualPort}`);
        });
        
        // Initialize browser pool in background (non-blocking)
        // This allows server to start even if Chromium isn't ready yet
        console.log('🔧 Initializing browser pool (non-blocking)...');
        browserPool.initialize().then(() => {
            console.log('✅ Browser pool initialized successfully');
        }).catch((err) => {
            console.error('⚠️ Browser pool initialization failed (server still running):', err.message);
            console.error('   Browser-dependent features will not work until Chromium is available');
        });
        
        // Start scheduled refresh service (non-blocking)
        console.log('🔧 Initializing scheduled refresh service...');
        scheduledRefresh.startScheduledRefresh();
        
        // Start background cookie refresh worker (proactive cookie renewal) - non-blocking
        console.log('🔧 Starting background cookie refresh worker...');
        cookieRefreshWorker.startWorker();
        
    } catch (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
}

// Graceful shutdown handler
async function gracefulShutdown(signal) {
    console.log(`\n${signal} received. Starting graceful shutdown...`);
    
    try {
        // Stop cookie refresh worker
        console.log('🛑 Stopping cookie refresh worker...');
        cookieRefreshWorker.stopWorker();
        
        // Close browser pool
        await browserPool.shutdown();
        console.log('✅ Graceful shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
    }
}

// Handle shutdown signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
    console.error('❌ Uncaught Exception:', error);
    await browserPool.shutdown();
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', async (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit on unhandled rejection, but log it
});

// Start the server
startServer();

