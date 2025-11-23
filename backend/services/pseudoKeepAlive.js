const https = require('https');
const { URL } = require('url');
const { getCookies, saveCookies } = require('./cookieManager');
const { saveSession } = require('./sessionManager');
const cacheLayer = require('./cacheLayer');
const { apiRequest } = require('./apiClient');

const BASE_URL = 'https://www.alfa.com.lb';
const KEEP_ALIVE_TIMEOUT = 5000; // 5 seconds timeout for keep-alive requests (fail fast)

/**
 * Convert cookie array to cookie header string
 * @param {Array} cookies - Array of cookie objects
 * @returns {string} Cookie header string
 */
function formatCookiesForHeader(cookies) {
    if (!cookies || !Array.isArray(cookies)) {
        return '';
    }
    
    return cookies
        .map(cookie => {
            const name = cookie.name || '';
            const value = cookie.value || '';
            return `${name}=${value}`;
        })
        .join('; ');
}

/**
 * Parse Set-Cookie header into cookie object
 * @param {string} setCookieHeader - Set-Cookie header value
 * @param {string} domain - Cookie domain
 * @returns {Object|null} Cookie object or null
 */
function parseSetCookie(setCookieHeader, domain = 'www.alfa.com.lb') {
    if (!setCookieHeader) {
        return null;
    }

    const parts = setCookieHeader.split(';').map(p => p.trim());
    const [nameValue] = parts;
    const [name, value] = nameValue.split('=').map(p => p.trim());

    if (!name || !value) {
        return null;
    }

    const cookie = {
        name,
        value,
        domain: domain.startsWith('.') ? domain : `.${domain}`,
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax'
    };

    // Parse attributes
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i].toLowerCase();
        if (part.startsWith('domain=')) {
            cookie.domain = part.split('=')[1].trim();
        } else if (part.startsWith('path=')) {
            cookie.path = part.split('=')[1].trim();
        } else if (part === 'httponly') {
            cookie.httpOnly = true;
        } else if (part === 'secure') {
            cookie.secure = true;
        } else if (part.startsWith('expires=')) {
            const expiresStr = part.split('=')[1].trim();
            const expiresDate = new Date(expiresStr);
            if (!isNaN(expiresDate.getTime())) {
                cookie.expires = Math.floor(expiresDate.getTime() / 1000);
            }
        } else if (part.startsWith('max-age=')) {
            const maxAge = parseInt(part.split('=')[1].trim());
            if (!isNaN(maxAge)) {
                cookie.expires = Math.floor(Date.now() / 1000) + maxAge;
            }
        }
    }

    return cookie;
}

/**
 * Extract cookies from response headers
 * @param {Object} headers - Response headers
 * @param {string} domain - Cookie domain
 * @returns {Array} Array of cookie objects
 */
function extractCookiesFromHeaders(headers, domain = 'www.alfa.com.lb') {
    const cookies = [];
    
    // Handle both single Set-Cookie header and array of Set-Cookie headers
    let setCookieHeaders = headers['set-cookie'] || headers['Set-Cookie'] || [];
    
    if (typeof setCookieHeaders === 'string') {
        setCookieHeaders = [setCookieHeaders];
    }

    for (const setCookieHeader of setCookieHeaders) {
        const cookie = parseSetCookie(setCookieHeader, domain);
        if (cookie) {
            cookies.push(cookie);
        }
    }

    return cookies;
}

/**
 * Merge new cookies with existing cookies
 * @param {Array} existingCookies - Existing cookie array
 * @param {Array} newCookies - New cookies from response
 * @returns {Array} Merged cookie array
 */
function mergeCookies(existingCookies, newCookies) {
    if (!existingCookies || existingCookies.length === 0) {
        return newCookies || [];
    }

    if (!newCookies || newCookies.length === 0) {
        return existingCookies;
    }

    // Create a map of existing cookies by name
    const cookieMap = new Map();
    for (const cookie of existingCookies) {
        cookieMap.set(cookie.name, cookie);
    }

    // Update with new cookies (new cookies override existing ones)
    for (const cookie of newCookies) {
        cookieMap.set(cookie.name, cookie);
    }

    return Array.from(cookieMap.values());
}

/**
 * Send lightweight GET request to /en/account to refresh cookies
 * Captures response headers (Set-Cookie) without parsing full page
 * @param {string} userId - User ID
 * @param {Array} currentCookies - Current cookies
 * @returns {Promise<{success: boolean, cookies: Array|null, statusCode: number, error: string|null}>}
 */
async function pseudoKeepAlive(userId, currentCookies) {
    if (!currentCookies || currentCookies.length === 0) {
        return {
            success: false,
            cookies: null,
            statusCode: 0,
            error: 'No cookies provided'
        };
    }

    const startTime = Date.now();
    const cookieHeader = formatCookiesForHeader(currentCookies);
    
    return new Promise((resolve) => {
        const url = new URL('/en/account', BASE_URL);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'GET',
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive'
            },
            timeout: KEEP_ALIVE_TIMEOUT
        };

        const req = https.request(options, (res) => {
            const statusCode = res.statusCode;
            const headers = res.headers;
            
            // Don't wait for body - just capture headers
            res.on('data', () => {}); // Drain data
            res.on('end', () => {
                const duration = Date.now() - startTime;
                
                // Check response status
                if (statusCode === 200) {
                    // 200 OK means cookies are valid - check for new cookies
                    const hasNewCookies = headers['set-cookie'] || headers['Set-Cookie'];
                    
                    if (hasNewCookies) {
                        // Extract new cookies from Set-Cookie headers
                        const newCookies = extractCookiesFromHeaders(headers);
                        
                        if (newCookies && newCookies.length > 0) {
                            // Merge new cookies with existing ones
                            const mergedCookies = mergeCookies(currentCookies, newCookies);
                            console.log(`✅ [Keep-Alive] ${userId}: Got ${newCookies.length} new cookie(s) from Set-Cookie headers (${duration}ms)`);
                            
                            resolve({
                                success: true,
                                cookies: mergedCookies,
                                statusCode: 200,
                                error: null
                            });
                        } else {
                            // 200 OK with Set-Cookie but couldn't parse - cookies still valid
                            console.log(`✅ [Keep-Alive] ${userId}: 200 OK, cookies still valid (${duration}ms)`);
                            resolve({
                                success: true,
                                cookies: currentCookies,
                                statusCode: 200,
                                error: null
                            });
                        }
                    } else {
                        // 200 OK but no Set-Cookie - cookies are still valid, no refresh needed
                        // This is SUCCESS - cookies don't need to be refreshed if they're still working
                        console.log(`✅ [Keep-Alive] ${userId}: 200 OK, cookies still valid (no refresh needed, ${duration}ms)`);
                        resolve({
                            success: true,
                            cookies: currentCookies,
                            statusCode: 200,
                            error: null
                        });
                    }
                } else if (statusCode === 401 || statusCode === 403) {
                    // Unauthorized - cookies expired
                    console.log(`⚠️ [Keep-Alive] ${userId}: Unauthorized (${statusCode}), cookies expired (${duration}ms)`);
                    resolve({
                        success: false,
                        cookies: null,
                        statusCode: statusCode,
                        error: 'Unauthorized - cookies expired'
                    });
                } else if (statusCode === 302 || statusCode === 301) {
                    // Redirect - likely redirecting to login page, cookies expired
                    // Mark for refresh but don't immediately login - serve cached data if available
                    console.log(`⚠️ [Keep-Alive] ${userId}: Redirect (${statusCode}), cookies expired - marked for refresh (${duration}ms)`);
                    resolve({
                        success: false,
                        cookies: null,
                        statusCode: statusCode,
                        error: `Redirect ${statusCode} - cookies expired`,
                        needsRefresh: true // Flag to indicate refresh needed but don't login immediately
                    });
                } else {
                    // Other status code - might be error
                    console.log(`⚠️ [Keep-Alive] ${userId}: Status ${statusCode} (${duration}ms)`);
                    resolve({
                        success: false,
                        cookies: null,
                        statusCode: statusCode,
                        error: `Status ${statusCode}`
                    });
                }
            });
        });

        req.on('error', (error) => {
            const duration = Date.now() - startTime;
            console.log(`⚠️ [Keep-Alive] ${userId}: Network error (${error.message}, ${duration}ms)`);
            resolve({
                success: false,
                cookies: null,
                statusCode: 0,
                error: error.message || 'Network error'
            });
        });

        req.on('timeout', () => {
            req.destroy();
            const duration = Date.now() - startTime;
            console.log(`⚠️ [Keep-Alive] ${userId}: Request timeout (${duration}ms)`);
            resolve({
                success: false,
                cookies: null,
                statusCode: 0,
                error: 'Request timeout'
            });
        });

        req.setTimeout(KEEP_ALIVE_TIMEOUT);
        req.end();
    });
}

/**
 * Refresh cookies using pseudo keep-alive for a user
 * @param {string} userId - User ID
 * @returns {Promise<{success: boolean, needsRefresh: boolean}>} Result with success and needsRefresh flags
 */
async function refreshCookiesKeepAlive(userId) {
    try {
        // Get current cookies
        const currentCookies = await getCookies(userId);
        
        if (!currentCookies || currentCookies.length === 0) {
            console.log(`⚠️ [Keep-Alive] ${userId}: No cookies found, full login required`);
            return { success: false, needsRefresh: true };
        }

        // Attempt pseudo keep-alive
        const result = await pseudoKeepAlive(userId, currentCookies);

        if (result.success && result.cookies) {
            // Save refreshed cookies (updates expiry and nextRefresh via saveCookies)
            // saveCookies automatically updates refreshSchedule sorted set
            await saveCookies(userId, result.cookies);
            
            // Also save to session manager
            await saveSession(userId, result.cookies, {});
            
            console.log(`✅ [Keep-Alive] ${userId}: Cookies refreshed successfully (refreshSchedule updated)`);
            return { success: true, needsRefresh: false };
        } else if (result.needsRefresh) {
            // 302 redirect - cookies expired, mark for refresh but don't immediately login
            // Schedule refresh in Redis but return success=false so caller can use cached data
            console.log(`⚠️ [Keep-Alive] ${userId}: Cookies expired (${result.statusCode}), marked for refresh (no immediate login)`);
            
            // Update nextRefresh to now (so worker will refresh soon)
            // storeNextRefresh updates both individual key and sorted set
            const { storeNextRefresh } = require('./cookieManager');
            await storeNextRefresh(userId, Date.now());
            
            console.log(`📅 [Keep-Alive] ${userId}: Scheduled immediate refresh in refreshSchedule`);
            return { success: false, needsRefresh: true };
        } else {
            // Keep-alive failed (timeout, network error, etc.) - may need full login
            console.log(`⚠️ [Keep-Alive] ${userId}: Failed (${result.error}), may need full login`);
            return { success: false, needsRefresh: true };
        }
    } catch (error) {
        console.error(`❌ [Keep-Alive] ${userId}: Error during keep-alive:`, error.message);
        return { success: false, needsRefresh: true };
    }
}

module.exports = {
    pseudoKeepAlive,
    refreshCookiesKeepAlive,
    extractCookiesFromHeaders,
    mergeCookies
};

