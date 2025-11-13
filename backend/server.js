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

const app = express();
const PORT = process.env.PORT || 3000;

// Function to find available port
function findAvailablePort(startPort) {
    return new Promise((resolve, reject) => {
        const server = require('net').createServer();
        server.listen(startPort, () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                // Try next port
                findAvailablePort(startPort + 1).then(resolve).catch(reject);
            } else {
                reject(err);
            }
        });
    });
}

// Middleware
app.use(cors());
app.use(express.json());

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

// Serve frontend static files
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

// Import request queue for handling concurrent requests
const requestQueue = require('./services/requestQueue');

// Fetch Alfa dashboard data (with incremental scraping support)
app.post('/api/alfa/fetch', async (req, res) => {
    try {
        const { phone, password, adminId } = req.body;

        if (!phone || !password) {
            return res.status(400).json({
                success: false,
                error: 'Phone and password are required'
            });
        }

        const identifier = adminId || phone;
        console.log(`[${new Date().toISOString()}] Fetching Alfa data for admin: ${identifier}`);

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

// Initialize browser pool and start server
async function startServer() {
    try {
        // Initialize browser pool first
        console.log('🔧 Initializing browser pool...');
        await browserPool.initialize();
        
        // Start scheduled refresh service
        console.log('🔧 Initializing scheduled refresh service...');
        scheduledRefresh.startScheduledRefresh();
        
        // Start server on available port
        const actualPort = await findAvailablePort(PORT);
        
        app.listen(actualPort, () => {
            console.log(`🚀 Linkify backend server running on port ${actualPort}`);
            console.log(`📁 Serving static files from: ${frontendPath}`);
            console.log(`🌐 Access frontend at: http://localhost:${actualPort}/`);
            console.log(`📄 Home page: http://localhost:${actualPort}/pages/home.html`);
            console.log(`\n⚠️  Note: If port ${PORT} was in use, server is running on port ${actualPort}`);
        });
    } catch (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
}

// Graceful shutdown handler
async function gracefulShutdown(signal) {
    console.log(`\n${signal} received. Starting graceful shutdown...`);
    
    try {
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

