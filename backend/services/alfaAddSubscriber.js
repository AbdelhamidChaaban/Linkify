const axios = require('axios');
const { URLSearchParams } = require('url');
const browserPool = require('./browserPool');
const { getSession } = require('./sessionManager');
const { getCookies, areCookiesExpired, acquireRefreshLock, releaseRefreshLock, loginAndSaveCookies, getCookieExpiry } = require('./cookieManager');
const { loginToAlfa } = require('./alfaLogin');
const { formatCookiesForHeader } = require('./apiClient');
const { getAdminData } = require('./firebaseDbService');
const { addPendingSubscriber } = require('./firebaseDbService');
const { pseudoKeepAlive } = require('./pseudoKeepAlive');

const ALFA_BASE_URL = 'https://www.alfa.com.lb';
const ALFA_DASHBOARD_URL = 'https://www.alfa.com.lb/en/account';
const ALFA_MANAGE_SERVICES_URL = 'https://www.alfa.com.lb/en/account/manage-services';
const ALFA_USHARE_BASE_URL = 'https://www.alfa.com.lb/en/account/manage-services/ushare';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * API-first subscriber addition: Direct POST to Alfa's hidden endpoint
 * @param {string} adminId - Admin ID
 * @param {string} adminPhone - Admin phone number (8 digits)
 * @param {Array} cookies - Array of cookie objects
 * @param {string} subscriberPhone - Subscriber phone number (8 digits)
 * @param {number} quota - Quota in GB
 * @param {number} maxQuota - Maximum quota allowed
 * @param {string} csrfToken - CSRF token from page
 * @returns {Promise<{success: boolean, needsLogin: boolean, needsPuppeteer: boolean, error?: string}>}
 */
async function addSubscriberApiFirst(adminId, adminPhone, cookies, subscriberPhone, quota, maxQuota, csrfToken) {
    try {
        const cleanSubscriberPhone = subscriberPhone.replace(/\D/g, '').substring(0, 8);
        if (cleanSubscriberPhone.length !== 8) {
            return { success: false, needsPuppeteer: true, error: 'Invalid subscriber phone' };
        }

        // Format cookies as header string
        const cookieHeader = formatCookiesForHeader(cookies);
        
        // Build URL with mobileNumber query parameter
        const url = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        
        // Build form data
        const formData = new URLSearchParams();
        formData.append('mobileNumber', adminPhone);
        formData.append('Number', cleanSubscriberPhone);
        formData.append('Quota', quota.toString());
        formData.append('MaxQuota', maxQuota.toString());
        formData.append('__RequestVerificationToken', csrfToken);
        
        console.log(`🚀 [API-First] POST ${url}`);
        console.log(`   Payload: Number=${cleanSubscriberPhone}, Quota=${quota}, MaxQuota=${maxQuota}`);
        
        // Make POST request with maxRedirects: 0 to detect 302 manually
        const response = await axios.post(url, formData.toString(), {
            headers: {
                'Cookie': cookieHeader,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`
            },
            maxRedirects: 0, // Don't auto-follow redirects
            validateStatus: (status) => status >= 200 && status < 400, // Accept 2xx and 3xx
            timeout: 10000 // 10 second timeout
        });
        
        // Check response status
        if (response.status === 302 || response.status === 301) {
            // 302 redirect = success (Alfa redirects after successful submission)
            const location = response.headers.location || '';
            if (location.includes('/login')) {
                // Redirected to login = cookies expired
                console.log(`⚠️ [API-First] Redirected to login (${response.status}), cookies expired`);
                return { success: false, needsLogin: true };
            }
            // Other redirect = success
            console.log(`✅ [API-First] Success (${response.status} redirect to ${location})`);
            return { success: true };
        } else if (response.status === 200) {
            // 200 OK might also indicate success
            console.log(`✅ [API-First] Success (200 OK)`);
            return { success: true };
        } else {
            console.log(`⚠️ [API-First] Unexpected status: ${response.status}`);
            return { success: false, needsPuppeteer: true, error: `Unexpected status: ${response.status}` };
        }
    } catch (error) {
        if (error.response) {
            const status = error.response.status;
            if (status === 401 || status === 403) {
                console.log(`⚠️ [API-First] Unauthorized (${status}), cookies expired`);
                return { success: false, needsLogin: true };
            } else if (status === 302 || status === 301) {
                const location = error.response.headers.location || '';
                if (location.includes('/login')) {
                    console.log(`⚠️ [API-First] Redirected to login (${status}), cookies expired`);
                    return { success: false, needsLogin: true };
                }
                // Other redirect = success
                console.log(`✅ [API-First] Success (${status} redirect)`);
                return { success: true };
            } else {
                console.log(`⚠️ [API-First] HTTP error (${status}): ${error.message}`);
                return { success: false, needsPuppeteer: true, error: `HTTP ${status}` };
            }
        } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            console.log(`⚠️ [API-First] Timeout: ${error.message}`);
            return { success: false, needsPuppeteer: true, error: 'Request timeout' };
        } else {
            console.log(`⚠️ [API-First] Network error: ${error.message}`);
            return { success: false, needsPuppeteer: true, error: error.message };
        }
    }
}

/**
 * Extract CSRF token and MaxQuota from ushare page
 * @param {string} adminPhone - Admin phone number (8 digits)
 * @param {Array} cookies - Array of cookie objects
 * @returns {Promise<{token: string, maxQuota: number} | null>}
 */
async function extractCsrfTokenAndMaxQuota(adminPhone, cookies) {
    try {
        const cookieHeader = formatCookiesForHeader(cookies);
        const url = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        
        const response = await axios.get(url, {
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': ALFA_DASHBOARD_URL
            },
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            timeout: 10000
        });
        
        // Check if redirected to login
        if (response.status === 302 || response.status === 301) {
            const location = response.headers.location || '';
            if (location.includes('/login')) {
                console.log(`⚠️ [CSRF Extract] Redirected to login, cookies expired`);
                return null;
            }
        }
        
        // Extract CSRF token and MaxQuota from HTML
        const html = response.data;
        const tokenMatch = html.match(/name="__RequestVerificationToken"\s+value="([^"]+)"/);
        const maxQuotaMatch = html.match(/id="MaxQuota"\s+value="([^"]+)"/);
        
        if (!tokenMatch) {
            console.log(`⚠️ [CSRF Extract] Could not find CSRF token`);
            return null;
        }
        
        const token = tokenMatch[1];
        const maxQuota = maxQuotaMatch ? parseFloat(maxQuotaMatch[1]) : 70; // Default to 70 if not found
        
        console.log(`✅ [CSRF Extract] Found token and MaxQuota: ${maxQuota}`);
        return { token, maxQuota };
    } catch (error) {
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            console.log(`⚠️ [CSRF Extract] Unauthorized, cookies expired`);
            return null;
        } else if (error.response && (error.response.status === 302 || error.response.status === 301)) {
            const location = error.response.headers.location || '';
            if (location.includes('/login')) {
                console.log(`⚠️ [CSRF Extract] Redirected to login, cookies expired`);
                return null;
            }
        }
        console.log(`⚠️ [CSRF Extract] Error: ${error.message}`);
        return null;
    }
}

/**
 * Add a subscriber to an admin's u-share service (API-first with Puppeteer fallback)
 * @param {string} adminId - Admin ID
 * @param {string} adminPhone - Admin phone number (8 digits)
 * @param {string} adminPassword - Admin password (for login if cookies expired)
 * @param {string} subscriberPhone - Subscriber phone number (8 digits)
 * @param {number} quota - Quota in GB (e.g., 1.5)
 * @returns {Promise<{success: boolean, message: string}>} Result
 */
async function addSubscriber(adminId, adminPhone, adminPassword, subscriberPhone, quota, sessionData = null) {
    let context = null;
    let page = null;
    let refreshLockAcquired = false;

    try {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`➕ ADD SUBSCRIBER OPERATION STARTED for admin: ${adminId}`);
        console.log(`   Subscriber: ${subscriberPhone}, Quota: ${quota} GB`);
        console.log(`   Started at: ${new Date().toISOString()}`);
        console.log(`${'='.repeat(80)}\n`);

        // Validate inputs
        const cleanSubscriberPhone = subscriberPhone.replace(/\D/g, '').substring(0, 8);
        if (cleanSubscriberPhone.length !== 8) {
            throw new Error(`Subscriber phone must be exactly 8 digits. Got: ${cleanSubscriberPhone.length} digits`);
        }

        if (!quota || quota < 0.1 || quota > 70) {
            throw new Error(`Quota must be between 0.1 and 70 GB. Got: ${quota}`);
        }

        // Acquire refresh lock to prevent cookie worker from interfering
        refreshLockAcquired = await acquireRefreshLock(adminId, 300); // 5 minute lock
        if (!refreshLockAcquired) {
            console.log(`⏸️ [${adminId}] Refresh lock exists, but proceeding with add subscriber...`);
        }

        // Check if we're using an existing session FIRST - if so, skip all cookie/API logic
        let skipNavigation = false;
        let context = null;
        let page = null;
        if (sessionData && sessionData.page && sessionData.context) {
            console.log(`⚡ Using existing session for faster add (page already loaded)`);
            context = sessionData.context;
            page = sessionData.page;
            skipNavigation = true; // Skip all cookie validation and API-first logic
            
            // Just refresh the page to get latest data
            const currentUrl = page.url();
            const ushareUrl = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
            
            if (!currentUrl.includes('/ushare')) {
                // Not on ushare page, navigate to it
                console.log(`🌐 [Session] Navigating to Ushare page: ${ushareUrl}`);
                await page.goto(ushareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await delay(2000);
            } else {
                // Already on ushare page, just refresh to get latest data
                console.log(`🔄 [Session] Refreshing Ushare page to get latest data...`);
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
                await delay(2000);
            }
            console.log(`✅ [Session] skipNavigation set to true - will skip all cookie/API logic`);
        }

        // Skip all cookie validation and API-first logic if using existing session
        let cookies = null;
        let cookiesValid = false;
        if (!skipNavigation) {
            // Get admin's cookies from Redis (prefer cookieManager over sessionManager)
            console.log(`🔑 Getting cookies for admin: ${adminId}`);
            cookies = await getCookies(adminId || adminPhone);
            
            // Fallback to sessionManager if cookieManager has no cookies
            if (!cookies || cookies.length === 0) {
                const savedSession = await getSession(adminId || adminPhone);
                if (savedSession && savedSession.cookies && savedSession.cookies.length > 0) {
                    cookies = savedSession.cookies;
                    console.log(`✅ Found ${cookies.length} cookies from sessionManager`);
                }
            } else {
                console.log(`✅ Found ${cookies.length} cookies from cookieManager`);
            }

            // Check if cookies are valid using Redis expiry timestamp (more reliable than cookie expires field)
            if (cookies && cookies.length > 0) {
                // First check Redis cookie expiry timestamp (most reliable)
            const cookieExpiry = await getCookieExpiry(adminId || adminPhone);
            const now = Date.now();
            
            console.log(`🔍 [Cookie Validation] Checking cookie validity for ${adminId}`);
            console.log(`   Cookies found: ${cookies.length}`);
            console.log(`   Redis expiry: ${cookieExpiry ? new Date(cookieExpiry).toISOString() : 'null'}`);
            console.log(`   Current time: ${new Date(now).toISOString()}`);
            
            if (cookieExpiry && typeof cookieExpiry === 'number' && !isNaN(cookieExpiry)) {
                // Ensure cookieExpiry is in milliseconds (not seconds)
                const expiryMs = cookieExpiry > 10000000000 ? cookieExpiry : cookieExpiry * 1000;
                
                if (expiryMs > now) {
                    // Redis expiry timestamp says cookies are still valid
                    cookiesValid = true;
                    const timeRemaining = Math.floor((expiryMs - now) / 1000 / 60);
                    console.log(`✅ Cookies are valid (Redis expiry: ${new Date(expiryMs).toISOString()}, ${timeRemaining} minutes remaining)`);
                } else {
                    // Redis expiry timestamp says cookies are expired
                    const timeExpired = Math.floor((now - expiryMs) / 1000 / 60);
                    console.log(`⚠️ Cookies are expired (Redis expiry: ${new Date(expiryMs).toISOString()}, expired ${timeExpired} minutes ago)`);
                    cookiesValid = false;
                }
            } else {
                // No Redis expiry timestamp - fall back to checking cookie expires field
                console.log(`⚠️ No Redis expiry timestamp found, falling back to cookie expires field check`);
                const areExpired = areCookiesExpired(cookies);
                cookiesValid = !areExpired;
                if (cookiesValid) {
                    console.log(`✅ Cookies are valid (no Redis expiry, checked cookie expires field - not expired)`);
                } else {
                    console.log(`⚠️ Cookies appear expired (checked cookie expires field - found expired cookie)`);
                }
            }
            } else {
                console.log(`⚠️ [Cookie Validation] No cookies found`);
            }

            // STEP 1: Try API-first approach if we have valid cookies
            if (cookiesValid) {
            console.log(`🚀 [API-First] Attempting direct POST to Alfa endpoint...`);
            
            // OPTIMIZATION: Check if cookies were recently kept alive by the scheduler
            // If cookies are fresh (expiry > 30 minutes away), skip redundant keep-alive check
            const cookieExpiry = await getCookieExpiry(adminId || adminPhone);
            const now = Date.now();
            const timeUntilExpiry = cookieExpiry ? (cookieExpiry - now) : 0;
            const minutesUntilExpiry = Math.floor(timeUntilExpiry / 1000 / 60);
            
            // If cookies expire in more than 30 minutes, they're likely fresh (kept alive by scheduler)
            // Skip the redundant keep-alive check and proceed directly to CSRF extraction
            if (timeUntilExpiry > 30 * 60 * 1000) {
                console.log(`✅ [API-First] Cookies are fresh (expire in ${minutesUntilExpiry} minutes), skipping redundant keep-alive check (scheduler maintains them)`);
                // Cookies are fresh - proceed directly to CSRF extraction
            } else {
                // Cookies are close to expiry (< 30 minutes) - verify with keep-alive check
                console.log(`🔍 [API-First] Cookies expire in ${minutesUntilExpiry} minutes, verifying with keep-alive check...`);
                const keepAliveResult = await pseudoKeepAlive(adminId, cookies);
                
                if (!keepAliveResult.success) {
                    // Check if it's a timeout/network error vs actual cookie expiration
                    const isTimeout = keepAliveResult.error && (
                        keepAliveResult.error.includes('timeout') || 
                        keepAliveResult.error.includes('Request timeout') ||
                        keepAliveResult.error.includes('socket hang up') ||
                        keepAliveResult.error.includes('Network error')
                    );
                    
                    if (isTimeout) {
                        // Timeout = network issue, not necessarily expired cookies
                        // Proceed with CSRF extraction anyway - if cookies are expired, CSRF extraction will fail
                        console.log(`⚠️ [API-First] Keep-alive timeout (network issue), but cookies may still be valid. Proceeding with CSRF extraction...`);
                        // Don't mark cookies as invalid - let CSRF extraction determine if they're expired
                    } else {
                        // 302/401 = cookies actually expired
                        console.log(`⚠️ [API-First] Keep-alive check failed (${keepAliveResult.error || 'unknown'}), cookies expired. Will perform login...`);
                        cookiesValid = false;
                    }
                } else {
                    console.log(`✅ [API-First] Keep-alive check passed, cookies are actually valid. Proceeding with CSRF extraction...`);
                    // Update cookies if keep-alive returned new ones
                    if (keepAliveResult.cookies && keepAliveResult.cookies.length > 0) {
                        cookies = keepAliveResult.cookies;
                        console.log(`✅ [API-First] Updated cookies from keep-alive response`);
                    }
                }
            }
        }
        
        // STEP 1b: Extract CSRF token if cookies are still valid after keep-alive check
        if (cookiesValid) {
            // Extract CSRF token and MaxQuota from ushare page
            const csrfData = await extractCsrfTokenAndMaxQuota(adminPhone, cookies);
            
            if (csrfData && csrfData.token) {
                // Try API-first POST
                const apiResult = await addSubscriberApiFirst(
                    adminId,
                    adminPhone,
                    cookies,
                    cleanSubscriberPhone,
                    quota,
                    csrfData.maxQuota,
                    csrfData.token
                );
                
                if (apiResult.success) {
                    // API-first succeeded - update Firebase immediately
                    console.log(`✅ [API-First] Subscriber addition successful via API`);
                    await addPendingSubscriber(adminId, cleanSubscriberPhone, quota);
                    
                    if (refreshLockAcquired) {
                        await releaseRefreshLock(adminId).catch(() => {});
                    }
                    
                    return {
                        success: true,
                        message: `Subscriber invitation sent successfully. SMS sent to ${cleanSubscriberPhone}. The subscriber will appear after accepting the invitation.`
                    };
                } else if (apiResult.needsLogin) {
                    // Cookies expired - perform login and retry
                    console.log(`⚠️ [API-First] Cookies expired, performing login and retrying...`);
                    
                    // Get admin credentials from Firebase if not provided
                    let phone = adminPhone;
                    let password = adminPassword;
                    if (!password) {
                        const adminData = await getAdminData(adminId);
                        if (!adminData || !adminData.phone || !adminData.password) {
                            throw new Error('Cookies expired and password not provided for login');
                        }
                        phone = adminData.phone;
                        password = adminData.password;
                    }
                    
                    // Perform full login
                    await loginAndSaveCookies(phone, password, adminId);
                    cookies = await getCookies(adminId);
                    
                    // Retry API-first with fresh cookies
                    const csrfDataRetry = await extractCsrfTokenAndMaxQuota(adminPhone, cookies);
                    if (csrfDataRetry && csrfDataRetry.token) {
                        const apiResultRetry = await addSubscriberApiFirst(
                            adminId,
                            adminPhone,
                            cookies,
                            cleanSubscriberPhone,
                            quota,
                            csrfDataRetry.maxQuota,
                            csrfDataRetry.token
                        );
                        
                        if (apiResultRetry.success) {
                            // API-first succeeded after login retry
                            console.log(`✅ [API-First] Subscriber addition successful after login retry`);
                            await addPendingSubscriber(adminId, cleanSubscriberPhone, quota);
                            
                            if (refreshLockAcquired) {
                                await releaseRefreshLock(adminId).catch(() => {});
                            }
                            
                            return {
                                success: true,
                                message: `Subscriber invitation sent successfully. SMS sent to ${cleanSubscriberPhone}. The subscriber will appear after accepting the invitation.`
                            };
                        }
                    }
                    
                    // API-first failed after login retry - fall back to Puppeteer
                    console.log(`⚠️ [API-First] Failed after login retry, falling back to Puppeteer...`);
                } else {
                    // API-first failed for other reasons - fall back to Puppeteer
                    console.log(`⚠️ [API-First] Failed (${apiResult.error}), falling back to Puppeteer...`);
                }
                } else {
                    // Could not extract CSRF token - cookies might be expired
                    console.log(`⚠️ [API-First] Could not extract CSRF token, cookies may be expired`);
                }
            } else {
                console.log(`⚠️ [API-First] No valid cookies found, will use Puppeteer...`);
            }
        }

        // STEP 2: Fallback to Puppeteer form automation
        if (!skipNavigation) {
            console.log(`🔄 [Puppeteer] Falling back to Puppeteer form automation...`);
            
            // Get a new isolated browser context from the pool
            const contextData = await browserPool.createContext();
            context = contextData.context;
            page = contextData.page;
            console.log(`🔄 [Navigation] Created new browser context - will proceed with login/navigation`);
        } else {
            console.log(`⚡ [Puppeteer] Using existing session - skipping browser context creation`);
        }

        // Skip login/navigation if using existing session
        if (!skipNavigation) {
            console.log(`🔄 [Navigation] Not using existing session, proceeding with login/navigation logic`);
            // Get cookies if not already available
            if (!cookies || cookies.length === 0) {
                cookies = await getCookies(adminId || adminPhone);
                if (!cookies || cookies.length === 0) {
                    const savedSession = await getSession(adminId || adminPhone);
                    if (savedSession && savedSession.cookies && savedSession.cookies.length > 0) {
                        cookies = savedSession.cookies;
                    }
                }
            }
            
            // If no cookies or cookies expired, perform login
            if (!cookies || cookies.length === 0 || areCookiesExpired(cookies)) {
                console.log(`⚠️ Cookies expired or missing, performing login for admin: ${adminId}`);
                
                // Get admin credentials from Firebase if not provided
                let phone = adminPhone;
                let password = adminPassword;
                if (!password) {
                    const adminData = await getAdminData(adminId);
                    if (!adminData || !adminData.phone || !adminData.password) {
                        throw new Error('No valid cookies found and password not provided for login');
                    }
                    phone = adminData.phone;
                    password = adminData.password;
                }
                
                const loginResult = await loginToAlfa(page, adminPhone, adminPassword, adminId);
                if (!loginResult.success) {
                    throw new Error('Login failed - cannot proceed with adding subscriber');
                }
                
                // After login, navigate DIRECTLY to ushare page (skip dashboard completely)
                await delay(2000);
                const ushareUrl = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
                console.log(`🌐 [DIRECT NAVIGATION] Navigating directly to ushare page after login: ${ushareUrl}`);
            
            // Navigate directly - don't go through dashboard
            // Use retry logic for navigation timeout
            let navigationSuccess = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    console.log(`🔄 [DIRECT NAVIGATION] Navigation attempt ${attempt}/3...`);
                    await page.goto(ushareUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000 // Increased to 30s
                    });
                    await delay(2000);
                    
                    // Check if we're on the right page
                    const currentUrl = page.url();
                    if (currentUrl.includes('/ushare')) {
                        navigationSuccess = true;
                        console.log(`✅ [DIRECT NAVIGATION] Successfully navigated to ushare page: ${currentUrl}`);
                        break;
                    } else if (currentUrl.includes('/login')) {
                        console.log(`⚠️ [DIRECT NAVIGATION] Redirected to login, cookies may have expired`);
                        // Don't retry if redirected to login
                        break;
                    } else {
                        console.log(`⚠️ [DIRECT NAVIGATION] Unexpected page: ${currentUrl}, retrying...`);
                        await delay(2000);
                    }
                } catch (navError) {
                    if (navError.message.includes('timeout')) {
                        console.log(`⚠️ [DIRECT NAVIGATION] Navigation timeout on attempt ${attempt}, retrying...`);
                        if (attempt < 3) {
                            await delay(2000);
                            continue;
                        } else {
                            // Last attempt failed - check current URL
                            const currentUrl = page.url();
                            if (currentUrl.includes('/ushare')) {
                                console.log(`✅ [DIRECT NAVIGATION] Already on ushare page despite timeout: ${currentUrl}`);
                                navigationSuccess = true;
                            } else {
                                throw new Error(`Navigation to ushare page failed after 3 attempts. Current URL: ${currentUrl}`);
                            }
                        }
                    } else {
                        throw navError;
                    }
                }
            }
            
            if (!navigationSuccess) {
                // Final check - maybe we're already on the page
                const finalUrl = page.url();
                if (finalUrl.includes('/ushare')) {
                    console.log(`✅ [DIRECT NAVIGATION] Already on ushare page: ${finalUrl}`);
                } else {
                    throw new Error(`Failed to navigate to ushare page. Current URL: ${finalUrl}`);
                }
            }
            
            // Verify we're on ushare page (not login or dashboard)
            const currentUrl = page.url();
            console.log(`📍 Current URL after direct navigation: ${currentUrl}`);
            
            if (currentUrl.includes('/login')) {
                console.log(`⚠️ Redirected to login page, retrying login...`);
                if (!adminPassword) {
                    throw new Error('Cookies expired and password not provided for login');
                }
                
                const retryLoginResult = await loginToAlfa(page, adminPhone, adminPassword, adminId);
                if (!retryLoginResult.success) {
                    throw new Error('Login failed after cookie expiration');
                }
                
                // After retry login, navigate directly to ushare again with retry logic
                await delay(2000);
                console.log(`🌐 [DIRECT NAVIGATION] Navigating to ushare page after retry login: ${ushareUrl}`);
                
                let retryNavSuccess = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        await page.goto(ushareUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: 30000
                        });
                        await delay(2000);
                        const retryUrl = page.url();
                        if (retryUrl.includes('/ushare')) {
                            retryNavSuccess = true;
                            console.log(`✅ [DIRECT NAVIGATION] Successfully navigated after retry login: ${retryUrl}`);
                            break;
                        }
                    } catch (retryNavError) {
                        if (retryNavError.message.includes('timeout') && attempt < 3) {
                            console.log(`⚠️ [DIRECT NAVIGATION] Retry navigation timeout on attempt ${attempt}, retrying...`);
                            await delay(2000);
                        } else {
                            throw retryNavError;
                        }
                    }
                }
                
                if (!retryNavSuccess) {
                    const finalRetryUrl = page.url();
                    if (!finalRetryUrl.includes('/ushare')) {
                        throw new Error(`Failed to navigate to ushare after retry login. Current URL: ${finalRetryUrl}`);
                    }
                }
            } else if (currentUrl.includes('/ushare')) {
                console.log(`✅ [DIRECT NAVIGATION] Successfully navigated to ushare page: ${currentUrl}`);
            } else if (currentUrl.includes('/account') && !currentUrl.includes('/ushare')) {
                // If we're on dashboard, navigate directly to ushare (shouldn't happen, but handle it)
                console.log(`⚠️ [DIRECT NAVIGATION] Still on dashboard, navigating directly to ushare: ${ushareUrl}`);
                await page.goto(ushareUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 20000
                });
                await delay(3000);
            } else {
                console.log(`⚠️ [DIRECT NAVIGATION] Unexpected page after navigation: ${currentUrl}, continuing...`);
            }
            } else {
                // Cookies are valid - inject them and navigate
                console.log(`🔑 Injecting ${cookies.length} valid cookies...`);
                await page.setCookie(...cookies);
                console.log(`✅ Cookies injected`);
                
                // Navigate directly to ushare page (skip dashboard) with retry logic
                const ushareUrl = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
                console.log(`🌐 Navigating directly to ushare page: ${ushareUrl}`);
            
                let cookieNavSuccess = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await page.goto(ushareUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000 // Increased to 30s
                    });
                    await delay(2000);
                    
                    const checkUrl = page.url();
                    if (checkUrl.includes('/ushare')) {
                        cookieNavSuccess = true;
                        console.log(`✅ Successfully navigated to ushare page: ${checkUrl}`);
                        break;
                    } else if (checkUrl.includes('/login')) {
                        console.log(`⚠️ Redirected to login page during navigation`);
                        break; // Don't retry if redirected to login
                    } else {
                        console.log(`⚠️ Unexpected page: ${checkUrl}, retrying...`);
                        if (attempt < 3) await delay(2000);
                    }
                } catch (navError) {
                    if (navError.message.includes('timeout') && attempt < 3) {
                        console.log(`⚠️ Navigation timeout on attempt ${attempt}, retrying...`);
                        await delay(2000);
                    } else {
                        // Check if we're already on the page despite error
                        const errorUrl = page.url();
                        if (errorUrl.includes('/ushare')) {
                            console.log(`✅ Already on ushare page despite error: ${errorUrl}`);
                            cookieNavSuccess = true;
                            break;
                        } else if (attempt === 3) {
                            throw navError;
                        }
                    }
                }
                }

                // Check if we're on login page (cookies might have expired between check and navigation)
                const currentUrl = page.url();
                if (currentUrl.includes('/login')) {
                    console.log(`⚠️ Redirected to login page, cookies expired during navigation. Performing login...`);
                    if (!adminPassword) {
                        throw new Error('Cookies expired and password not provided for login');
                    }
                    
                    const loginResult = await loginToAlfa(page, adminPhone, adminPassword, adminId);
                    if (!loginResult.success) {
                        throw new Error('Login failed after cookie expiration');
                    }
                    
                    // After login, navigate directly to ushare page again
                    await delay(2000);
                    console.log(`🌐 Navigating to ushare page after login: ${ushareUrl}`);
                    await page.goto(ushareUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000
                    });
                    await delay(3000);
                } else if (currentUrl.includes('/ushare')) {
                    console.log(`✅ Successfully navigated to ushare page: ${currentUrl}`);
                } else {
                    console.log(`⚠️ Unexpected page after navigation: ${currentUrl}, continuing...`);
                }
            }
        }

        // Wait for form to be available (with multiple attempts)
        console.log(`📝 Waiting for form...`);
        let formFound = false;
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await page.waitForSelector('form.form-horizontal', {
                    timeout: 5000
                });
                formFound = true;
                console.log(`✅ Form found on attempt ${attempt}`);
                break;
            } catch (formError) {
                console.log(`⚠️ Form not found on attempt ${attempt}, waiting...`);
                await delay(2000);
                
                // Check if we're on the right page
                const currentUrl = page.url();
                console.log(`📍 Current URL while waiting for form: ${currentUrl}`);
                
                // If we're back on dashboard or manage-services, try to navigate to ushare again
                if (currentUrl.includes('/account') && !currentUrl.includes('/ushare')) {
                    console.log(`⚠️ Appears to have navigated away from ushare page, trying to get back...`);
                    // The form might be on a different page structure, continue anyway
                }
            }
        }
        
        if (!formFound) {
            // Check if form exists but with different selector
            const formExists = await page.evaluate(() => {
                return document.querySelector('form') !== null;
            });
            
            if (formExists) {
                console.log(`✅ Form exists but with different selector, continuing...`);
                formFound = true;
            } else {
                throw new Error('Form not found on page. Cannot proceed with adding subscriber.');
            }
        }
        
        await delay(1000);

        // Extract __RequestVerificationToken from the form
        const token = await page.evaluate(() => {
            const input = document.querySelector('input[name="__RequestVerificationToken"]');
            return input ? input.value : null;
        });

        if (!token) {
            throw new Error('Could not find __RequestVerificationToken in form');
        }
        console.log(`✅ Found verification token`);

        // Fill in the form fields
        console.log(`📝 Filling form fields...`);
        
        // Fill secondary phone number
        await page.waitForSelector('#Number', { timeout: 10000 });
        await page.click('#Number', { clickCount: 3 }); // Select all existing text
        await page.type('#Number', cleanSubscriberPhone, { delay: 100 });
        console.log(`✅ Filled subscriber phone: ${cleanSubscriberPhone}`);

        // Fill quota (format: X.XX)
        await page.waitForSelector('#Quota', { timeout: 10000 });
        await page.click('#Quota', { clickCount: 3 }); // Select all existing text
        await page.type('#Quota', quota.toString(), { delay: 100 });
        console.log(`✅ Filled quota: ${quota} GB`);

        await delay(500);

        // Submit the form
        console.log(`🚀 Submitting form...`);
        await page.waitForSelector('button[type="submit"]#submit', { timeout: 10000 });
        
        // Click submit button
        await page.click('button[type="submit"]#submit');
        console.log(`✅ Clicked submit button`);

        // Wait for form submission - navigation might or might not happen
        let navigationHappened = false;
        try {
            await page.waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            navigationHappened = true;
            console.log(`✅ Navigation detected after form submission`);
        } catch (navError) {
            // Navigation timeout is OK - form might just show a message on the same page
            console.log(`ℹ️ No navigation detected (form may show message on same page)`);
        }
        
        await delay(2000); // Wait a bit more for any messages to appear or page to stabilize

        // Try to get page content and URL, but handle navigation gracefully
        let pageContent = '';
        let formPageText = '';
        let finalUrl = '';
        
        try {
            finalUrl = page.url();
            try {
                pageContent = await page.content();
                formPageText = await page.evaluate(() => document.body.innerText);
            } catch (contentError) {
                // Execution context destroyed due to navigation - this is actually good (means form submitted)
                console.log(`ℹ️ Could not read page content (page navigated - this indicates success)`);
            }
        } catch (urlError) {
            // Page might have navigated away completely
            console.log(`ℹ️ Could not get URL (page navigated - this indicates success)`);
        }

        // If navigation happened, it's definitely success
        if (navigationHappened) {
            console.log(`✅ Form submitted successfully, page navigated to: ${finalUrl || 'new page'}`);
            
            // Release refresh lock before returning
            if (refreshLockAcquired) {
                await releaseRefreshLock(adminId).catch(() => {});
            }
            
            return {
                success: true,
                message: `Subscriber invitation sent successfully. SMS sent to ${cleanSubscriberPhone}. The subscriber will appear after accepting the invitation.`
            };
        }

        // Check if we're still on the ushare page
        if (finalUrl && finalUrl.includes('/ushare')) {
            // Still on ushare page - SMS is still sent when submit is clicked
            console.log(`✅ Subscriber invitation sent successfully (SMS sent to ${cleanSubscriberPhone})!`);
            
            // Release refresh lock before returning
            if (refreshLockAcquired) {
                await releaseRefreshLock(adminId).catch(() => {});
            }
            
            return {
                success: true,
                message: `Subscriber invitation sent successfully. SMS sent to ${cleanSubscriberPhone}. The subscriber will appear after accepting the invitation.`
            };
        } else {
            // Navigated away or couldn't determine URL - treat as success
            console.log(`✅ Form submitted successfully`);
            
            // Release refresh lock before returning
            if (refreshLockAcquired) {
                await releaseRefreshLock(adminId).catch(() => {});
            }
            
            return {
                success: true,
                message: `Subscriber invitation sent successfully. SMS sent to ${cleanSubscriberPhone}. The subscriber will appear after accepting the invitation.`
            };
        }
    } catch (error) {
        // If we got to the point where we clicked submit, the SMS was sent
        // So even if there's an error reading the page, we should return success
        const errorMessage = error.message || '';
        const isNavigationError = errorMessage.includes('Execution context was destroyed') || 
                                  errorMessage.includes('navigation') ||
                                  errorMessage.includes('Target closed');
        
        if (isNavigationError) {
            // Navigation error means the form was submitted and page navigated - this is success!
            console.log(`✅ Form submitted successfully (navigation detected via error)`);
            
            // Update Firebase with pending subscriber
            await addPendingSubscriber(adminId, cleanSubscriberPhone, quota);
            
            console.log(`\n${'='.repeat(80)}`);
            console.log(`✅ ADD SUBSCRIBER OPERATION COMPLETED for admin: ${adminId}`);
            console.log(`   Subscriber: ${cleanSubscriberPhone}, Quota: ${quota} GB`);
            console.log(`   Completed at: ${new Date().toISOString()}`);
            console.log(`${'='.repeat(80)}\n`);
            
            // Release refresh lock before returning
            if (refreshLockAcquired) {
                await releaseRefreshLock(adminId).catch(() => {});
            }
            
            return {
                success: true,
                message: `Subscriber invitation sent successfully. SMS sent to ${cleanSubscriberPhone}. The subscriber will appear after accepting the invitation.`
            };
        }
        
        // For other errors, log but return error
        console.error(`❌ Error adding subscriber:`, error);
        console.error(`   Error message: ${error.message}`);
        console.error(`   Stack trace: ${error.stack}`);
        
        return {
            success: false,
            message: error.message || 'Unknown error occurred while adding subscriber'
        };
    } finally {
        // Clean up browser context
        if (context) {
            try {
                await browserPool.closeContext(context);
                console.log(`🧹 Browser context closed`);
            } catch (closeError) {
                console.warn(`⚠️ Error closing context: ${closeError.message}`);
            }
        }
    }
}

module.exports = {
    addSubscriber,
    addSubscriberApiFirst,
    extractCsrfTokenAndMaxQuota
};

