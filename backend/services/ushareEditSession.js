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
        
        // CRITICAL: Check if cookies are expired and login PROACTIVELY before any navigation
        // This ensures admin is logged in BEFORE user sees the edit modal (no waiting)
        const userId = adminId || adminPhone;
        let cookiesExpired = true;
        
        if (cookies && cookies.length > 0) {
            console.log(`🔍 [Edit Session] Checking cookie validity for ${userId}`);
            console.log(`   Cookies found: ${cookies.length}`);
            
            // CRITICAL: Check if __ACCOUNT cookie exists (this is the key cookie that lasts 72 hours)
            // __ACCOUNT cookies don't expire quickly - if missing, cookies are invalid
            const hasAccountCookie = cookies.some(c => c.name === '__ACCOUNT');
            console.log(`   __ACCOUNT cookie: ${hasAccountCookie ? '✅ Found' : '❌ Missing'}`);
            
            if (!hasAccountCookie) {
                // Missing __ACCOUNT cookie - cookies are invalid (even if other cookies exist)
                cookiesExpired = true;
                console.log(`⚠️ [Edit Session] Cookies are invalid - missing __ACCOUNT cookie (required for authentication)`);
            } else {
                // __ACCOUNT cookie exists - check Redis expiry to see if it's still valid
                const cookieExpiry = await getCookieExpiry(userId);
                const now = Date.now();
                
                console.log(`   Redis expiry: ${cookieExpiry ? new Date(cookieExpiry).toISOString() : 'null'}`);
                console.log(`   Current time: ${new Date(now).toISOString()}`);
                
                if (cookieExpiry && typeof cookieExpiry === 'number' && !isNaN(cookieExpiry)) {
                    // Ensure cookieExpiry is in milliseconds (not seconds)
                    const expiryMs = cookieExpiry > 10000000000 ? cookieExpiry : cookieExpiry * 1000;
                    
                    if (expiryMs > now) {
                        // Redis expiry says cookies are still valid
                        cookiesExpired = false;
                        const timeRemaining = Math.floor((expiryMs - now) / 1000 / 60);
                        console.log(`✅ [Edit Session] Cookies are valid (__ACCOUNT exists, Redis expiry: ${timeRemaining} minutes remaining)`);
                    } else {
                        // Redis expiry says cookies are expired
                        const timeExpired = Math.floor((now - expiryMs) / 1000 / 60);
                        console.log(`⚠️ [Edit Session] Cookies are expired (Redis expiry: expired ${timeExpired} minutes ago)`);
                        cookiesExpired = true;
                    }
                } else {
                    // No Redis expiry - but __ACCOUNT exists, so assume valid (it lasts 72 hours)
                    // Only login if navigation fails (handled below)
                    cookiesExpired = false;
                    console.log(`✅ [Edit Session] Cookies appear valid (__ACCOUNT exists, no Redis expiry - will verify on navigation)`);
                }
            }
        } else {
            console.log(`⚠️ [Edit Session] No cookies found`);
        }
        
        // If cookies are expired or missing, login IMMEDIATELY (before navigation)
        // This ensures cookies are fresh when we navigate, so user doesn't wait
        if (!cookies || cookies.length === 0 || cookiesExpired) {
            console.log(`🔐 [Edit Session] Cookies expired/missing, performing PROACTIVE login before navigation...`);
            if (!adminPassword) {
                throw new Error('No valid cookies and password not provided');
            }
            
            // Perform login FIRST (before any navigation)
            // This ensures admin is logged in before user sees the modal
            const loginResult = await loginToAlfa(page, adminPhone, adminPassword, adminId);
            if (!loginResult.success) {
                throw new Error('Login failed');
            }
            
            // Get fresh cookies after login
            cookies = await getCookies(userId);
            if (!cookies || cookies.length === 0) {
                const savedSession = await getSession(userId);
                if (savedSession && savedSession.cookies) {
                    cookies = savedSession.cookies;
                }
            }
            
            // Inject fresh cookies (format them properly for Puppeteer)
            if (cookies && cookies.length > 0) {
                const formattedCookies = cookies.map(cookie => {
                    return {
                        ...cookie,
                        domain: cookie.domain || 'www.alfa.com.lb',
                        path: cookie.path || '/',
                        expires: cookie.expires ? (cookie.expires > 10000000000 ? Math.floor(cookie.expires / 1000) : cookie.expires) : undefined
                    };
                });
                await page.setCookie(...formattedCookies);
                console.log(`✅ [Edit Session] Injected ${formattedCookies.length} fresh cookies after login (formatted for Puppeteer)`);
            }
            await delay(1000); // Brief delay to ensure cookies are set
        } else {
            // Cookies are valid - format them properly for Puppeteer (ensure domain/path are set)
            const formattedCookies = cookies.map(cookie => {
                // Ensure domain and path are set (required for Puppeteer)
                return {
                    ...cookie,
                    domain: cookie.domain || 'www.alfa.com.lb',
                    path: cookie.path || '/',
                    // Ensure expires is in seconds (Puppeteer expects seconds, not milliseconds)
                    expires: cookie.expires ? (cookie.expires > 10000000000 ? Math.floor(cookie.expires / 1000) : cookie.expires) : undefined
                };
            });
            
            // CRITICAL: Navigate to domain first before setting cookies (Puppeteer requirement)
            console.log(`🌐 [Edit Session] Navigating to domain first to set cookies properly...`);
            await page.goto('https://www.alfa.com.lb', {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });
            await delay(500);
            
            // Set cookies in Puppeteer (must be on correct domain)
            await page.setCookie(...formattedCookies);
            console.log(`✅ [Edit Session] Injected ${formattedCookies.length} valid cookies (formatted for Puppeteer)`);
            
            // Verify cookies were set by checking if __ACCOUNT cookie exists
            const setCookies = await page.cookies();
            const hasAccountAfterSet = setCookies.some(c => c.name === '__ACCOUNT');
            if (!hasAccountAfterSet) {
                console.log(`⚠️ [Edit Session] __ACCOUNT cookie not found after setting - cookies may not have been set correctly`);
            } else {
                console.log(`✅ [Edit Session] Verified __ACCOUNT cookie is set in browser`);
            }
        }
        
        // Navigate to Ushare page
        const ushareUrl = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        console.log(`🌐 [Edit Session] Navigating to Ushare page: ${ushareUrl}`);
        await page.goto(ushareUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });
        await delay(2000);
        
        // Check if redirected to login (shouldn't happen if we logged in proactively, but handle it)
        const currentUrl = page.url();
        if (currentUrl.includes('/login')) {
            console.log(`⚠️ [Edit Session] Unexpected redirect to login, performing login immediately...`);
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

