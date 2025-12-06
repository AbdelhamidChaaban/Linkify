/**
 * Ushare Edit Session Manager
 * Manages browser sessions for editing subscribers (keeps page loaded for fast edits)
 */

const browserPool = require('./browserPool');
const { getCookies, getCookieExpiry, areCookiesExpired } = require('./cookieManager');
const { getSession } = require('./sessionManager');
const { loginToAlfa } = require('./alfaLogin');

const ALFA_USHARE_BASE_URL = 'https://www.alfa.com.lb/en/account/manage-services/ushare';

// Store active edit sessions: Map<sessionId, {page, context, adminId, adminPhone, expiresAt}>
const activeSessions = new Map();
const SESSION_TTL = 10 * 60 * 1000; // 10 minutes

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate unique session ID
 */
function generateSessionId() {
    return `edit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Clean up expired sessions
 */
function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
        if (session.expiresAt < now) {
            console.log(`🧹 Cleaning up expired edit session: ${sessionId}`);
            if (session.context) {
                session.context.close().catch(() => {});
            }
            activeSessions.delete(sessionId);
        }
    }
}

// Clean up expired sessions every minute
setInterval(cleanupExpiredSessions, 60 * 1000);

/**
 * Prepare edit session: Navigate to Ushare page and return subscriber data + session ID
 * @param {string} adminId - Admin ID
 * @param {string} adminPhone - Admin phone number
 * @param {string} adminPassword - Admin password
 * @returns {Promise<{success: boolean, sessionId: string|null, data: Object|null, error: string|null}>}
 */
async function prepareEditSession(adminId, adminPhone, adminPassword) {
    let context = null;
    let page = null;
    
    try {
        console.log(`🔧 [Edit Session] Preparing edit session for admin: ${adminId}`);
        
        // Get browser context
        const contextData = await browserPool.createContext();
        context = contextData.context;
        page = contextData.page;
        
        // Get cookies
        let cookies = await getCookies(adminId || adminPhone);
        if (!cookies || cookies.length === 0) {
            const savedSession = await getSession(adminId || adminPhone);
            if (savedSession && savedSession.cookies) {
                cookies = savedSession.cookies;
            }
        }
        
        // Check if cookies are expired
        let cookiesExpired = true;
        if (cookies && cookies.length > 0) {
            const cookieExpiry = await getCookieExpiry(adminId || adminPhone);
            const now = Date.now();
            if (cookieExpiry && cookieExpiry > now) {
                cookiesExpired = false;
            } else {
                cookiesExpired = areCookiesExpired(cookies);
            }
        }
        
        // Login if needed
        if (!cookies || cookies.length === 0 || cookiesExpired) {
            console.log(`🔐 [Edit Session] Cookies expired/missing, performing login...`);
            if (!adminPassword) {
                throw new Error('No valid cookies and password not provided');
            }
            
            const loginResult = await loginToAlfa(page, adminPhone, adminPassword, adminId);
            if (!loginResult.success) {
                throw new Error('Login failed');
            }
            await delay(2000);
        } else {
            // Inject cookies
            await page.setCookie(...cookies);
            console.log(`✅ [Edit Session] Injected ${cookies.length} cookies`);
        }
        
        // Navigate to Ushare page
        const ushareUrl = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        console.log(`🌐 [Edit Session] Navigating to Ushare page: ${ushareUrl}`);
        await page.goto(ushareUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });
        await delay(2000);
        
        // Check if redirected to login
        const currentUrl = page.url();
        if (currentUrl.includes('/login')) {
            console.log(`⚠️ [Edit Session] Redirected to login, performing login...`);
            if (!adminPassword) {
                throw new Error('Cookies expired and password not provided');
            }
            const loginResult = await loginToAlfa(page, adminPhone, adminPassword, adminId);
            if (!loginResult.success) {
                throw new Error('Login failed');
            }
            await delay(2000);
            await page.goto(ushareUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });
            await delay(2000);
        }
        
        // Parse subscriber data from page
        const subscriberData = await page.evaluate(() => {
            const cards = document.querySelectorAll('#ushare-numbers .col-sm-4');
            const subscribers = [];
            let activeCount = 0;
            let requestedCount = 0;
            
            cards.forEach(card => {
                const h2 = card.querySelector('h2');
                if (!h2) return;
                
                const phoneNumber = h2.textContent.trim();
                if (!phoneNumber || phoneNumber.length < 8) return;
                
                // Check status
                const isActive = !card.querySelector('.requested-badge');
                const isRequested = card.querySelector('.requested-badge') !== null;
                
                if (isActive) activeCount++;
                if (isRequested) requestedCount++;
                
                // Get consumption and quota
                const capacityEl = card.querySelector('h4.italic.capacity');
                const dataVal = capacityEl ? parseFloat(capacityEl.getAttribute('data-val') || '0') : 0;
                const dataQuota = capacityEl ? parseFloat(capacityEl.getAttribute('data-quota') || '0') : 0;
                
                subscribers.push({
                    phoneNumber: phoneNumber.replace(/^961/, ''),
                    fullPhoneNumber: phoneNumber,
                    status: isActive ? 'Active' : (isRequested ? 'Requested' : 'Unknown'),
                    usedConsumption: dataVal,
                    totalQuota: dataQuota,
                    consumptionText: `${dataVal} / ${dataQuota} GB`
                });
            });
            
            return {
                subscribers,
                activeCount,
                requestedCount,
                totalCount: subscribers.length
            };
        });
        
        // Generate session ID
        const sessionId = generateSessionId();
        
        // Store session
        activeSessions.set(sessionId, {
            page,
            context,
            adminId,
            adminPhone,
            expiresAt: Date.now() + SESSION_TTL
        });
        
        console.log(`✅ [Edit Session] Session created: ${sessionId} (expires in 10 minutes)`);
        
        return {
            success: true,
            sessionId,
            data: subscriberData,
            error: null
        };
        
    } catch (error) {
        console.error(`❌ [Edit Session] Error preparing session:`, error.message);
        
        // Clean up on error
        if (context) {
            context.close().catch(() => {});
        }
        
        return {
            success: false,
            sessionId: null,
            data: null,
            error: error.message
        };
    }
}

/**
 * Get active session
 * @param {string} sessionId - Session ID
 * @returns {Object|null} Session object or null if not found/expired
 */
function getActiveSession(sessionId) {
    cleanupExpiredSessions();
    
    const session = activeSessions.get(sessionId);
    if (!session) {
        return null;
    }
    
    if (session.expiresAt < Date.now()) {
        console.log(`⚠️ [Edit Session] Session expired: ${sessionId}`);
        if (session.context) {
            session.context.close().catch(() => {});
        }
        activeSessions.delete(sessionId);
        return null;
    }
    
    return session;
}

/**
 * Close and remove session
 * @param {string} sessionId - Session ID
 */
async function closeSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (session) {
        console.log(`🔒 [Edit Session] Closing session: ${sessionId}`);
        if (session.context) {
            await session.context.close().catch(() => {});
        }
        activeSessions.delete(sessionId);
    }
}

module.exports = {
    prepareEditSession,
    getActiveSession,
    closeSession
};

