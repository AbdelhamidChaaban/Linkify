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
// Removed: Puppeteer-based subscriber services (replaced with API-only routes in subscriberRoutes.js)
const { getAdminData, getFullAdminData, getBalanceHistory, getActionLogs, logAction } = require('./services/firebaseDbService');
// Removed: Puppeteer-based edit session (replaced with API-only routes)

const app = express();
// Make sure the Express app binds to Render's dynamic port
const PORT = process.env.PORT || 3000;

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

// Request logging middleware - Only log API requests (not static files)
app.use((req, res, next) => {
    // Only log API routes, not static files
    if (req.path.startsWith('/api/')) {
        const timestamp = new Date().toISOString();
        console.log(`📥 [${timestamp}] ${req.method} ${req.path}`);
        if (req.method === 'POST' && req.body && Object.keys(req.body).length > 0) {
            const bodyKeys = Object.keys(req.body);
            const sanitizedBody = { ...req.body };
            // Hide password in logs for security
            if (sanitizedBody.password) {
                sanitizedBody.password = '***HIDDEN***';
            }
            console.log(`   Body keys: ${bodyKeys.join(', ')}`);
        }
    }
    next();
});

// Import request queue for handling concurrent requests
const requestQueue = require('./services/requestQueue');

// Import new API routes
const alfaApiRoutes = require('./routes/alfaApiRoutes');
const subscriberRoutes = require('./routes/subscriberRoutes');
const actionLogsRoutes = require('./routes/actionLogsRoutes');

// Import queue workers
const { initializeWorkers } = require('./services/queue');
const { initializeWorker: initializeUshareWorker } = require('./workers/ushareHtmlWorker');

// Health check endpoint at /health
app.get('/health', (req, res) => {
    console.log(`\n💚 Health check called at ${new Date().toISOString()}\n`);
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        browserPool: {
            // TODO: Remove Puppeteer health check once captchaService.js replaces login fallback
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

// Mount new JWT-protected API routes
// These routes require authentication via JWT token
app.use('/api', alfaApiRoutes);      // /api/getconsumption, /api/getexpirydate, etc.
app.use('/api', subscriberRoutes);   // /api/addSubscriber, /api/editSubscriber, etc.
app.use('/api', actionLogsRoutes);   // /api/actionLogs

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
    const requestStartTime = Date.now();
    
    // CRITICAL: Log immediately - this MUST show up
    process.stdout.write(`\n\n🔥🔥🔥 REFRESH API CALLED 🔥🔥🔥\n`);
    console.error(`\n\n🔥🔥🔥 REFRESH API CALLED - ${new Date().toISOString()} 🔥🔥🔥\n`);
    console.log(`\n\n🔥🔥🔥 REFRESH API CALLED - ${new Date().toISOString()} 🔥🔥🔥\n`);
    
    try {
        const { phone, password, adminId } = req.body;
        
        console.log(`\n${'='.repeat(80)}`);
        console.log(`[${new Date().toISOString()}] 🔵 [API] /api/alfa/fetch - Refresh request received`);
        console.log(`   Body keys: ${Object.keys(req.body).join(', ')}`);
        console.log(`   Phone: ${phone || 'not provided'}`);
        console.log(`   Admin ID: ${adminId || 'not provided'}`);
        console.log(`${'='.repeat(80)}\n`);

        if (!phone || !password) {
            console.log(`⚠️ [API] Missing phone or password in request`);
            return res.status(400).json({
                success: false,
                error: 'Phone and password are required'
            });
        }

        const identifier = adminId || phone;
        console.log(`[${new Date().toISOString()}] 📋 [API] Processing refresh for admin: ${identifier}`);

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
        console.log(`[${new Date().toISOString()}] 🔄 [API] Starting refresh for ${identifier} via request queue...`);
        const startTime = Date.now();
        const data = await requestQueue.execute(identifier, async () => {
            console.log(`[${new Date().toISOString()}] ✅ [API] Request queue executing refresh for ${identifier}`);
            return await fetchAlfaData(phone, password, adminId, identifier);
        });
        const duration = Date.now() - startTime;
        console.log(`[${new Date().toISOString()}] 📊 [API] Request queue completed for ${identifier} in ${duration}ms`);

        // Check if this was an incremental (no-changes) response
        if (data.incremental && data.noChanges) {
            console.log(`[${new Date().toISOString()}] ⚡ [API] Incremental check: No changes detected (${duration}ms)`);
            console.log(`[${new Date().toISOString()}] ✅ [API] /api/alfa/fetch completed for ${identifier} - No changes\n`);
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
            console.log(`[${new Date().toISOString()}] ✅ [API] Completed ${data.incremental ? 'incremental' : 'full'} refresh in ${duration}ms`);
            console.log(`[${new Date().toISOString()}] ✅ [API] /api/alfa/fetch completed for ${identifier} - Data refreshed\n`);
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
        const errorDuration = Date.now() - (requestStartTime || Date.now());
        console.error(`\n[${new Date().toISOString()}] ❌ [API] /api/alfa/fetch ERROR for ${identifier || 'unknown'}`);
        console.error(`   Duration: ${errorDuration}ms`);
        console.error(`   Error message: ${error?.message}`);
        console.error(`   Stack trace: ${error?.stack}`);
        console.error(`${'='.repeat(80)}\n`);
        
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

// Add subscriber endpoint (legacy - delegates to new route handler)
// NOTE: This endpoint is kept for backward compatibility
// New code should use /api/addSubscriber (JWT-protected) instead
app.post('/api/subscribers/add', async (req, res) => {
    try {
        const { adminId, subscriberPhone, quota } = req.body;

        if (!adminId || !subscriberPhone || !quota) {
            return res.status(400).json({
                success: false,
                error: 'adminId, subscriberPhone, and quota are required'
            });
        }

        // Validate quota
        const quotaNum = parseFloat(quota);
        if (isNaN(quotaNum) || quotaNum < 0.1 || quotaNum > 70) {
            return res.status(400).json({
                success: false,
                error: 'Quota must be between 0.1 and 70 GB'
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

        // Clean subscriber number (8 digits)
        const cleanSubscriberNumber = subscriberPhone.replace(/\D/g, '').substring(0, 8);
        if (cleanSubscriberNumber.length !== 8) {
            return res.status(400).json({
                success: false,
                error: 'Subscriber number must be 8 digits'
            });
        }

        // Use the same logic as the new route
        const { getCookiesOrLogin } = require('./services/cookieManager');
        const { formatCookiesForHeader } = require('./services/apiClient');
        const axios = require('axios');
        const ALFA_BASE_URL = 'https://www.alfa.com.lb';
        const USHARE_BASE_URL = `${ALFA_BASE_URL}/en/account/manage-services/ushare`;
        
        // Get cookies
        const cookies = await getCookiesOrLogin(adminData.phone, adminData.password, adminId);

        // Get CSRF token (reuse helper from subscriberRoutes)
        // Import the helper function
        const getCsrfToken = async (adminPhone, cookies, adminId, adminPassword, retryCount = 0) => {
            const MAX_RETRIES = 2;
            try {
                const hasAccountCookie = cookies && cookies.some(c => c.name === '__ACCOUNT');
                if (!hasAccountCookie && cookies && cookies.length > 0 && adminId && adminPassword && retryCount < MAX_RETRIES) {
                    console.log(`🔄 [CSRF] Missing __ACCOUNT cookie, refreshing... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
                    const refreshedCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    return getCsrfToken(adminPhone, refreshedCookies, adminId, adminPassword, retryCount + 1);
                }
                
                const cookieHeaderForRequest = formatCookiesForHeader(cookies);
                const url = `${USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
                const response = await axios.get(url, {
                    headers: {
                        'Cookie': cookieHeaderForRequest,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 20000,
                    maxRedirects: 5
                });
                
                if (response.status >= 400) {
                    if (adminId && adminPassword && retryCount < MAX_RETRIES) {
                        const refreshedCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        return getCsrfToken(adminPhone, refreshedCookies, adminId, adminPassword, retryCount + 1);
                    }
                    throw new Error(`Failed to get CSRF token: HTTP ${response.status}`);
                }
                
                const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                let csrfMatch = html.match(/name="__RequestVerificationToken"\s+value="([^"]+)"/);
                if (!csrfMatch) {
                    csrfMatch = html.match(/__RequestVerificationToken[^>]*value="([^"]+)"/);
                }
                if (!csrfMatch) {
                    csrfMatch = html.match(/<input[^>]*name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
                }
                
                if (!csrfMatch || !csrfMatch[1]) {
                    if (adminId && adminPassword && retryCount < MAX_RETRIES) {
                        const refreshedCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        return getCsrfToken(adminPhone, refreshedCookies, adminId, adminPassword, retryCount + 1);
                    }
                    throw new Error('CSRF token not found in page');
                }
                
                const maxQuotaMatch = html.match(/id="MaxQuota"\s+value="([^"]+)"/);
                const maxQuota = maxQuotaMatch ? parseFloat(maxQuotaMatch[1]) : null;
                
                return {
                    token: csrfMatch[1],
                    maxQuota: maxQuota
                };
            } catch (error) {
                if (error.message && (error.message.includes('CSRF token') || error.message.includes('cookies expired'))) {
                    throw error;
                }
                if (error.response?.status === 401 || error.response?.status === 403) {
                    if (adminId && adminPassword && retryCount < MAX_RETRIES) {
                        const refreshedCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        return getCsrfToken(adminPhone, refreshedCookies, adminId, adminPassword, retryCount + 1);
                    }
                    throw new Error('Authentication failed - cookies expired');
                }
                throw error;
            }
        };

        const { token: csrfToken, maxQuota } = await getCsrfToken(adminData.phone, cookies, adminId, adminData.password);
        const actualMaxQuota = maxQuota || 70;

        // Format cookie header for POST request
        const cookieHeader = formatCookiesForHeader(cookies);

        // Build form data
        const { URLSearchParams } = require('url');
        const formData = new URLSearchParams();
        formData.append('mobileNumber', adminData.phone);
        formData.append('Number', cleanSubscriberNumber);
        formData.append('Quota', quotaNum.toString());
        formData.append('MaxQuota', actualMaxQuota.toString());
        formData.append('__RequestVerificationToken', csrfToken);
        const url = `${USHARE_BASE_URL}?mobileNumber=${adminData.phone}`;

        console.log(`📤 [Add Subscriber] POSTing to ${url}`);
        console.log(`   Subscriber: ${cleanSubscriberNumber}, Quota: ${quotaNum}GB, MaxQuota: ${actualMaxQuota}GB`);

        const response = await axios.post(url, formData.toString(), {
            headers: {
                'Cookie': cookieHeader,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': url
            },
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            timeout: 20000
        });

        console.log(`📥 [Add Subscriber] Response status: ${response.status}`);

        const location = response.headers.location || '';
        if (location) {
            console.log(`   Redirect location: ${location}`);
        }

        // Check if redirected to login
        if (response.status >= 300 && location.includes('/login')) {
            return res.status(401).json({
                success: false,
                error: 'Authentication failed - cookies expired'
            });
        }

        // Parse response HTML to check for errors
        let html = '';
        if (response.data && typeof response.data === 'string') {
            html = response.data;
        } else if (response.data) {
            html = JSON.stringify(response.data);
        }

        const errorPatterns = [
            /error|Error|ERROR/,
            /invalid|Invalid|INVALID/,
            /failed|Failed|FAILED/,
            /already exists|already added|duplicate/i,
            /not found|does not exist/i
        ];

        const hasError = errorPatterns.some(pattern => pattern.test(html));
        const successPatterns = [/success|Success|SUCCESS/, /added successfully|subscriber added/i];
        const hasSuccess = successPatterns.some(pattern => pattern.test(html));
        const isRedirect = response.status >= 300 && response.status < 400;
        const is200 = response.status === 200;

        if (hasError && !hasSuccess) {
            const errorMatch = html.match(/(error|Error)[^<]*([^<]{0,100})/i);
            const errorMessage = errorMatch ? errorMatch[0].substring(0, 200) : 'Unknown error from Alfa';
            console.error(`❌ [Add Subscriber] Error detected: ${errorMessage}`);
            
            // Log failed action
            try {
                const userId = adminData.userId || null;
                if (userId) {
                    await logAction(userId, adminId, adminData.name || 'Unknown', adminData.phone, 'add', cleanSubscriberNumber, quotaNum, false, errorMessage);
                }
            } catch (logError) {
                console.warn(`⚠️ Could not log action (non-critical):`, logError?.message);
            }
            
            return res.status(400).json({
                success: false,
                error: `Failed to add subscriber: ${errorMessage}`
            });
        }

        // Invalidate cache
        const { invalidateUshareCache } = require('./services/ushareHtmlParser');
        if (isRedirect && !location.includes('/login')) {
            console.log(`✅ [Add Subscriber] Got ${response.status} redirect (success)`);
            invalidateUshareCache(adminData.phone).catch(() => {});
            
            // Log action (get userId from adminData)
            try {
                const userId = adminData.userId || null;
                if (userId) {
                    await logAction(userId, adminId, adminData.name || 'Unknown', adminData.phone, 'add', cleanSubscriberNumber, quotaNum, true);
                }
            } catch (logError) {
                console.warn(`⚠️ Could not log action (non-critical):`, logError?.message);
            }
            
            return res.json({
                success: true,
                message: 'Subscriber added successfully'
            });
        }

        // For 200 OK, do brief verification
        if (is200) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const { fetchUshareHtml } = require('./services/ushareHtmlParser');
            const verifyResult = await fetchUshareHtml(adminData.phone, cookies, false).catch(() => null);
            
            if (verifyResult && verifyResult.success && verifyResult.data) {
                const subscribers = verifyResult.data.subscribers || [];
                const subscriberExists = subscribers.some(sub => {
                    const subNumber = sub.phoneNumber || sub.fullPhoneNumber || '';
                    return subNumber.replace(/^961/, '').replace(/\D/g, '') === cleanSubscriberNumber;
                });
                
                if (subscriberExists) {
                    console.log(`✅ [Add Subscriber] Verified: Subscriber ${cleanSubscriberNumber} exists`);
                }
            }
            await invalidateUshareCache(adminData.phone).catch(() => {});
            
            // Log action (get userId from adminData)
            try {
                const userId = adminData.userId || null;
                if (userId) {
                    await logAction(userId, adminId, adminData.name || 'Unknown', adminData.phone, 'add', cleanSubscriberNumber, quotaNum, true);
                }
            } catch (logError) {
                console.warn(`⚠️ Could not log action (non-critical):`, logError?.message);
            }
        }

        // Store as pending subscriber in Firebase
        const { addPendingSubscriber } = require('./services/firebaseDbService');
        try {
            await addPendingSubscriber(adminId, cleanSubscriberNumber, quotaNum);
        } catch (pendingError) {
            console.warn(`⚠️ Could not add pending subscriber (non-critical):`, pendingError?.message);
        }

        res.json({
            success: true,
            message: 'Subscriber added successfully'
        });

    } catch (error) {
        console.error('❌ Error adding subscriber:', error);
        console.error('Error message:', error?.message);
        console.error('Stack trace:', error?.stack);
        
        // Log failed action
        try {
            if (adminData && adminData.userId) {
                const cleanSubscriberNumber = subscriberPhone?.replace(/\D/g, '').substring(0, 8);
                await logAction(adminData.userId, adminId, adminData.name || 'Unknown', adminData.phone || '', 'add', cleanSubscriberNumber || '', quota || null, false, error.message || 'Unknown error');
            }
        } catch (logError) {
            console.warn(`⚠️ Could not log action (non-critical):`, logError?.message);
        }
        
        res.status(500).json({
            success: false,
            error: error?.message || 'Unknown error occurred while adding subscriber'
        });
    }
});

// Edit subscribers endpoint (update quota, add, remove)
// REMOVED: /api/subscribers/edit - Replaced with API-only routes:
//   PUT /api/editSubscriber (JWT-protected, no Puppeteer)
//   POST /api/addSubscriber (JWT-protected, no Puppeteer)
//   DELETE /api/removeSubscriber (JWT-protected, no Puppeteer)
app.post('/api/subscribers/edit', async (req, res) => {
    res.status(410).json({
        success: false,
        error: 'This endpoint has been removed. Please use the new API-only routes: PUT /api/editSubscriber, POST /api/addSubscriber, DELETE /api/removeSubscriber'
    });
});

// Prepare edit session: Navigate to Ushare page and return subscriber data + session ID
// Render.com-optimized: Uses browser pool with Render-safe flags, proper error handling, and non-blocking startup
// REMOVED: /api/ushare/prepare-edit - Replaced with GET /api/ushare (JWT-protected, no Puppeteer)
// Use GET /api/ushare?adminId=xxx to fetch subscriber list directly
app.post('/api/ushare/prepare-edit', async (req, res) => {
    res.status(410).json({
        success: false,
        error: 'This endpoint has been removed. Please use GET /api/ushare?adminId=xxx to fetch subscriber data (JWT-protected, API-only)'
    });
});

// REMOVED: /api/ushare/close-session - No longer needed (no Puppeteer sessions)
app.post('/api/ushare/close-session', async (req, res) => {
    res.status(410).json({
        success: false,
        error: 'This endpoint has been removed. Sessions are no longer used (stateless API-only backend)'
    });
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
// This will serve index.html at the root "/" and all other frontend files
const frontendPath = path.join(__dirname, '..', 'frontend');
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
        // Use PORT directly (Render.com sets this automatically)
        
        // Start server immediately - Render.com needs the port bound right away
        app.listen(PORT, () => {
            console.log(`Backend running on port ${PORT}`);
        });
        
        // Defer heavy Puppeteer tasks - do not launch immediately at startup
        // Browser pool will be initialized lazily when first needed
        console.log('ℹ️ Browser pool will be initialized on first use (deferred for faster startup)');
        
        // Start scheduled refresh service (non-blocking)
        console.log('🔧 Initializing scheduled refresh service...');
        scheduledRefresh.startScheduledRefresh();
        scheduledRefresh.startScheduledCleanup();
        
        // Start background cookie refresh worker (proactive cookie renewal) - non-blocking
        console.log('🔧 Starting background cookie refresh worker...');
        cookieRefreshWorker.startWorker();
        
        // Initialize BullMQ queues and workers
        console.log('🔧 Initializing BullMQ queues and workers...');
        initializeWorkers();
        initializeUshareWorker();
        
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
        
        // Close queue workers
        try {
            const { closeQueues } = require('./services/queue');
            const { closeWorker } = require('./workers/ushareHtmlWorker');
            console.log('🛑 Closing queue workers...');
            await closeWorker();
            await closeQueues();
        } catch (queueError) {
            console.warn('⚠️ Error closing queues:', queueError.message);
        }
        
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

