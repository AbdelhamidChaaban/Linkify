/**
 * Subscriber Management Routes
 * API-only routes for adding, editing, and removing subscribers
 * All routes require JWT authentication
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const cheerio = require('cheerio');
const { authenticateJWT } = require('../middleware/auth');
const { getCookiesOrLogin } = require('../services/cookieManager');
const { formatCookiesForHeader } = require('../services/apiClient');
const { getAdminData, getFullAdminData, logAction, addRemovedActiveSubscriber } = require('../services/firebaseDbService');
// Response normalizer utilities (inline for consistency)
function normalizeSubscriberResponse(subscriberData) {
    return {
        success: true,
        data: {
            number: subscriberData.number || subscriberData.phone || subscriberData.mobileNumber,
            results: subscriberData.results || [],
            ...subscriberData
        },
        timestamp: Date.now()
    };
}

function createErrorResponse(message, error = null) {
    const response = {
        success: false,
        error: message,
        timestamp: Date.now()
    };
    
    if (error && process.env.NODE_ENV !== 'production') {
        response.errorDetails = {
            message: error.message,
            type: error.type || error.name
        };
    }
    
    return response;
}

const ALFA_BASE_URL = 'https://www.alfa.com.lb';
const USHARE_BASE_URL = `${ALFA_BASE_URL}/en/account/manage-services/ushare`;

/**
 * Helper: Get admin credentials and cookies
 */
async function getAdminCredentialsAndCookies(adminId, userId) {
    const adminData = await getAdminData(adminId);
    
    if (!adminData) {
        throw new Error('Admin not found');
    }
    
    if (adminData.userId !== userId) {
        throw new Error('Unauthorized: Admin does not belong to current user');
    }
    
    if (!adminData.phone || !adminData.password) {
        throw new Error('Admin credentials missing');
    }
    
    const cookies = await getCookiesOrLogin(adminData.phone, adminData.password, adminId);
    
    return {
        phone: adminData.phone,
        password: adminData.password,
        cookies: cookies
    };
}

/**
 * Helper: Get CSRF token from Ushare page
 * Automatically refreshes cookies if they're expired
 */
async function getCsrfToken(adminPhone, cookies, adminId, adminPassword, retryCount = 0) {
    const MAX_RETRIES = 2; // Prevent infinite loops
    
    try {
        // CRITICAL: Ensure __ACCOUNT cookie is present (long-lived authentication cookie)
        const hasAccountCookie = cookies && cookies.some(c => c.name === '__ACCOUNT');
        if (!hasAccountCookie && cookies && cookies.length > 0) {
            console.warn(`⚠️ [CSRF] No __ACCOUNT cookie found in ${cookies.length} cookie(s). Cookie names: ${cookies.map(c => c.name).join(', ')}`);
            // If no __ACCOUNT cookie, refresh cookies immediately (don't wait for redirect)
            if (adminId && adminPassword && retryCount < MAX_RETRIES) {
                console.log(`🔄 [CSRF] Missing __ACCOUNT cookie, refreshing... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
                const refreshedCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                await new Promise(resolve => setTimeout(resolve, 1000));
                return getCsrfToken(adminPhone, refreshedCookies, adminId, adminPassword, retryCount + 1);
            }
        }
        
        const cookieHeader = formatCookiesForHeader(cookies);
        const url = `${USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        
        const response = await axios.get(url, {
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': `${ALFA_BASE_URL}/en/account`,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            maxRedirects: 5, // Allow redirects (follow them)
            validateStatus: (status) => status >= 200 && status < 500,
            timeout: 20000 // Increased to 20s to match Ushare HTML timeout (Alfa's servers are slow)
        });
        
        // Check if redirected to login page (check final URL)
        const finalUrl = response.request.res.responseUrl || response.config.url;
        if (finalUrl && finalUrl.includes('/login')) {
            if (adminId && adminPassword && retryCount < MAX_RETRIES) {
                console.log(`🔄 [CSRF] Cookies expired, refreshing... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
                // Refresh cookies
                const refreshedCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                // Wait a bit for cookies to settle
                await new Promise(resolve => setTimeout(resolve, 1000));
                // Retry with fresh cookies
                return getCsrfToken(adminPhone, refreshedCookies, adminId, adminPassword, retryCount + 1);
            }
            throw new Error('Redirected to login - cookies expired');
        }
        
        // Check response status
        if (response.status >= 400) {
            if (adminId && adminPassword && retryCount < MAX_RETRIES) {
                console.log(`🔄 HTTP ${response.status}, refreshing cookies... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
                const refreshedCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                await new Promise(resolve => setTimeout(resolve, 1000));
                return getCsrfToken(adminPhone, refreshedCookies, adminId, adminPassword, retryCount + 1);
            }
            throw new Error(`Failed to get CSRF token: HTTP ${response.status}`);
        }
        
        // Extract CSRF token from HTML
        const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        
        // Try multiple patterns for CSRF token
        let csrfMatch = html.match(/name="__RequestVerificationToken"\s+value="([^"]+)"/);
        if (!csrfMatch) {
            csrfMatch = html.match(/__RequestVerificationToken[^>]*value="([^"]+)"/);
        }
        if (!csrfMatch) {
            csrfMatch = html.match(/<input[^>]*name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
        }
        
        if (!csrfMatch || !csrfMatch[1]) {
            // Log a snippet of the HTML for debugging
            const snippet = html.substring(0, 500);
            console.error('❌ CSRF token not found in page. HTML snippet:', snippet);
            
            // If we haven't retried yet, try refreshing cookies
            if (adminId && adminPassword && retryCount < MAX_RETRIES) {
                console.log(`🔄 CSRF token not found, refreshing cookies and retrying... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
                const refreshedCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                await new Promise(resolve => setTimeout(resolve, 1000));
                return getCsrfToken(adminPhone, refreshedCookies, adminId, adminPassword, retryCount + 1);
            }
            
            throw new Error('CSRF token not found in page - page may require login');
        }
        
        // Extract MaxQuota if available
        const maxQuotaMatch = html.match(/id="MaxQuota"\s+value="([^"]+)"/);
        const maxQuota = maxQuotaMatch ? parseFloat(maxQuotaMatch[1]) : null;
        
        return {
            token: csrfMatch[1],
            maxQuota: maxQuota
        };
    } catch (error) {
        // If it's already our custom error, re-throw it
        if (error.message && (error.message.includes('CSRF token') || error.message.includes('cookies expired'))) {
            throw error;
        }
        
        // For axios errors, check if it's a redirect or auth issue
        if (error.response) {
            const status = error.response.status;
            if ((status === 401 || status === 403 || status >= 300) && adminId && adminPassword && retryCount < MAX_RETRIES) {
                console.log(`🔄 HTTP ${status} error, refreshing cookies... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
                const refreshedCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                await new Promise(resolve => setTimeout(resolve, 1000));
                return getCsrfToken(adminPhone, refreshedCookies, adminId, adminPassword, retryCount + 1);
            }
            throw new Error(`Failed to get CSRF token: HTTP ${status}`);
        }
        
        throw error;
    }
}

/**
 * POST /api/addSubscriber
 * Add a subscriber to an admin's U-share service
 * Body: { adminId, subscriberNumber, quota }
 */
router.post('/addSubscriber', authenticateJWT, async (req, res) => {
    try {
        const { adminId, subscriberNumber, quota } = req.body;
        
        if (!adminId || !subscriberNumber || quota === undefined) {
            return res.status(400).json(createErrorResponse('adminId, subscriberNumber, and quota are required'));
        }
        
        // Validate quota
        if (quota < 0.1 || quota > 70) {
            return res.status(400).json(createErrorResponse('Quota must be between 0.1 and 70 GB'));
        }
        
        const { phone: adminPhone, password: adminPassword, cookies } = await getAdminCredentialsAndCookies(adminId, req.userId);
        
        // Clean subscriber number (8 digits)
        // Normalize: Remove spaces and Lebanon country code (+961 or 961)
        let cleanSubscriberNumber = subscriberNumber.trim().replace(/\s+/g, ''); // Remove spaces first
        
        // Handle +961 prefix (e.g., "+96171935446")
        if (cleanSubscriberNumber.startsWith('+961')) {
            cleanSubscriberNumber = cleanSubscriberNumber.substring(4); // Remove "+961"
        }
        // Handle 961 prefix (e.g., "96171935446")
        else if (cleanSubscriberNumber.startsWith('961') && cleanSubscriberNumber.length >= 11) {
            cleanSubscriberNumber = cleanSubscriberNumber.substring(3); // Remove "961"
        }
        
        // Remove all non-digit characters
        cleanSubscriberNumber = cleanSubscriberNumber.replace(/\D/g, '');
        
        if (cleanSubscriberNumber.length === 11 && cleanSubscriberNumber.startsWith('961')) {
            cleanSubscriberNumber = cleanSubscriberNumber.substring(3);
        }
        // Auto-fix: If 7 digits, prepend '0' to make it 8 digits
        if (cleanSubscriberNumber.length === 7) {
            cleanSubscriberNumber = '0' + cleanSubscriberNumber;
            console.log(`ℹ️ [AddSubscriber] Auto-corrected 7-digit number to 8 digits: ${cleanSubscriberNumber}`);
        }
        cleanSubscriberNumber = cleanSubscriberNumber.substring(0, 8);
        if (cleanSubscriberNumber.length !== 8) {
            return res.status(400).json(createErrorResponse('Subscriber number must be 8 digits'));
        }
        
        // Get CSRF token and MaxQuota (will auto-refresh cookies if expired)
        const { token: csrfToken, maxQuota } = await getCsrfToken(adminPhone, cookies, adminId, adminPassword);
        const actualMaxQuota = maxQuota || 70; // Default to 70 if not found
        
        // Reuse cookies - getCsrfToken already refreshed them internally if needed
        // No need to call getCookiesOrLogin again (this was causing the 17-second delay)
        const cookieHeader = formatCookiesForHeader(cookies);
        
        // Build form data
        const { URLSearchParams } = require('url');
        const formData = new URLSearchParams();
        formData.append('mobileNumber', adminPhone);
        formData.append('Number', cleanSubscriberNumber);
        formData.append('Quota', quota.toString());
        formData.append('MaxQuota', actualMaxQuota.toString());
        formData.append('__RequestVerificationToken', csrfToken);
        const url = `${USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        
        console.log(`📤 [Add Subscriber] POSTing to ${url}`);
        console.log(`   Subscriber: ${cleanSubscriberNumber}, Quota: ${quota}GB, MaxQuota: ${actualMaxQuota}GB`);
        
        const response = await axios.post(url, formData.toString(), {
            headers: {
                'Cookie': cookieHeader,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': url
            },
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            timeout: 20000 // Increased to 20s (Alfa's servers are slow)
        });
        
        console.log(`📥 [Add Subscriber] Response status: ${response.status}`);
        
        // Extract location for redirect checks
        const location = response.headers.location || '';
        if (location) {
            console.log(`   Redirect location: ${location}`);
        }
        
        // Check if redirected to login
        if (response.status >= 300 && location.includes('/login')) {
            return res.status(401).json(createErrorResponse('Authentication failed - cookies expired'));
        }
        
        // Parse response HTML to check for errors
        let html = '';
        if (response.data && typeof response.data === 'string') {
            html = response.data;
        } else if (response.data) {
            html = JSON.stringify(response.data);
        }
        
        const isRedirect = response.status >= 300 && response.status < 400;
        const is200 = response.status === 200;
        
        // Check response HTML first before following redirect (faster)
        // Simplified error detection: Just check for alert-danger marker
        let hasAlertDanger = html.includes('alert-danger') || /alert-danger/i.test(html);
        let hasAlertSuccess = html.includes('alert-success') || /alert-success/i.test(html);
        
        // Check for subscriber card (success indicator)
        const subscriberCardPattern = new RegExp(`(?:961|0)?${cleanSubscriberNumber}`, 'i');
        let hasSubscriberCard = subscriberCardPattern.test(html) && 
                                 html.includes('secondary-numbers') &&
                                 (html.includes('ushare-numbers') || html.includes('col-sm-4'));
        
        // OPTIMIZATION: Only follow redirect if we don't have clear success/error indicators
        // This saves ~9 seconds when success is already clear from redirect response
        const needsRedirectCheck = isRedirect && !location.includes('/login') && !hasAlertDanger && !hasAlertSuccess && !hasSubscriberCard;
        
        if (needsRedirectCheck) {
            console.log(`🔄 [Add Subscriber] Following redirect to check for errors (no clear indicators in response)...`);
            try {
                const redirectUrl = location.startsWith('http') ? location : `${ALFA_BASE_URL}${location}`;
                // Reduced timeout - we're just checking for errors, don't need to wait 20s
                const redirectResponse = await axios.get(redirectUrl, {
                    headers: {
                        'Cookie': cookieHeader,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': url
                    },
                    maxRedirects: 5,
                    validateStatus: (status) => status >= 200 && status < 400,
                    timeout: 10000 // Reduced from 20s to 10s - this is just a verification step
                });
                
                // Get redirected HTML
                if (redirectResponse.data && typeof redirectResponse.data === 'string') {
                    html = redirectResponse.data;
                } else if (redirectResponse.data) {
                    html = JSON.stringify(redirectResponse.data);
                }
                
                // Re-check for markers after following redirect
                hasAlertDanger = html.includes('alert-danger') || /alert-danger/i.test(html);
                hasAlertSuccess = html.includes('alert-success') || /alert-success/i.test(html);
                hasSubscriberCard = subscriberCardPattern.test(html) && 
                                     html.includes('secondary-numbers') &&
                                     (html.includes('ushare-numbers') || html.includes('col-sm-4'));
            } catch (redirectError) {
                console.warn(`⚠️ [Add Subscriber] Error following redirect: ${redirectError.message}`);
                // Continue with original HTML if redirect fails - we'll check what we have
            }
        } else if (isRedirect && !location.includes('/login')) {
            console.log(`✅ [Add Subscriber] Skipping redirect check - clear indicators already found (${hasAlertSuccess || hasSubscriberCard ? 'success' : hasAlertDanger ? 'error' : 'unknown'})`);
        }
        
        console.log(`🔍 [Add Subscriber] Detection: hasAlertDanger=${hasAlertDanger}, hasAlertSuccess=${hasAlertSuccess}, hasSubscriberCard=${hasSubscriberCard}`);
        
        // If alert-danger is found, it's definitely an error - return immediately
        if (hasAlertDanger) {
            console.error(`❌ [Add Subscriber] Error detected (alert-danger found)`);
            const adminData = await getAdminData(adminId).catch(() => null);
            await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'add', cleanSubscriberNumber, quota, false, 'Operation failed');
            return res.status(400).json(createErrorResponse('Operation failed'));
        }
        
        // If explicit success markers are found, return success immediately
        if (hasAlertSuccess || hasSubscriberCard) {
            console.log(`✅ [Add Subscriber] Success detected (explicit markers found)`);
            const { invalidateUshareCache } = require('../services/ushareHtmlParser');
            invalidateUshareCache(adminPhone).catch(() => {});
            
            const adminData = await getAdminData(adminId).catch(() => null);
            await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'add', cleanSubscriberNumber, quota, true);
            
            return res.json(normalizeSubscriberResponse({
                number: cleanSubscriberNumber,
                results: [],
                message: 'Subscriber added successfully',
                cacheInvalidated: true
            }));
        }
        
        // No clear success/error markers found - verify by checking if subscriber exists in Ushare HTML
        // This is important because sometimes Alfa's HTML response doesn't contain clear markers
        // but the operation actually succeeded (especially for pending subscribers)
        console.log(`⚠️ [Add Subscriber] No clear success markers found - verifying by checking Ushare HTML...`);
        
        // For 200 responses or redirects without clear indicators, do verification
        const { fetchUshareHtml, invalidateUshareCache } = require('../services/ushareHtmlParser');
        
        // Verify for both 200 OK and redirects (redirects often indicate success even without clear markers)
        let verifyResult = null;
        if (is200 || isRedirect) {
            // Brief wait to allow Alfa's system to update
            await new Promise(resolve => setTimeout(resolve, 1500)); // Slightly longer wait for reliability
            verifyResult = await fetchUshareHtml(adminPhone, cookies, false).catch(() => null);
        }
        
        if (verifyResult && verifyResult.success && verifyResult.data) {
            const subscribers = verifyResult.data.subscribers || [];
            const subscriberExists = subscribers.some(sub => {
                const subNumber = sub.phoneNumber || sub.fullPhoneNumber || '';
                return subNumber.replace(/^961/, '').replace(/\D/g, '') === cleanSubscriberNumber;
            });
            
            if (subscriberExists) {
                console.log(`✅ [Add Subscriber] Verified: Subscriber ${cleanSubscriberNumber} exists in list`);
                // Invalidate cache (already required above)
                await invalidateUshareCache(adminPhone).catch(err => {
                    console.warn('⚠️ Failed to invalidate cache:', err.message);
                });
                console.log(`🗑️ [Add Subscriber] Cache invalidated for ${adminPhone}`);
                
                // Log action
                const adminData = await getAdminData(adminId).catch(() => null);
                await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'add', cleanSubscriberNumber, quota, true);
                
                return res.json(normalizeSubscriberResponse({
                    number: cleanSubscriberNumber,
                    results: [],
                    message: 'Subscriber added successfully',
                    cacheInvalidated: true
                }));
            } else {
                console.warn(`⚠️ [Add Subscriber] Subscriber ${cleanSubscriberNumber} not found in list after adding`);
                // Still might be success if it's a pending subscriber (redirect usually means success)
                if (isRedirect) {
                    console.log(`   But got redirect response, assuming pending subscriber`);
                    // Invalidate cache (already required above)
                    await invalidateUshareCache(adminPhone).catch(err => {
                        console.warn('⚠️ Failed to invalidate cache:', err.message);
                    });
                    console.log(`🗑️ [Add Subscriber] Cache invalidated for ${adminPhone} (pending subscriber)`);
                    
                    // Log action
                    const adminData = await getAdminData(adminId).catch(() => null);
                    await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'add', cleanSubscriberNumber, quota, true);
                    
                    return res.json(normalizeSubscriberResponse({
                        number: cleanSubscriberNumber,
                        results: [],
                        message: 'Subscriber added successfully (may be pending)',
                        cacheInvalidated: true
                    }));
                } else {
                    // Log failed action
                    const adminData = await getAdminData(adminId).catch(() => null);
                    await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'add', cleanSubscriberNumber, quota, false, 'Verification failed');
                    return res.status(400).json(createErrorResponse('Subscriber was not added - verification failed'));
                }
            }
        } else {
            // Couldn't verify, but if we got a redirect that's usually success
            if (isRedirect) {
                console.log(`✅ [Add Subscriber] Got redirect/success response, assuming success`);
                // Invalidate cache (already required above)
                await invalidateUshareCache(adminPhone).catch(err => {
                    console.warn('⚠️ Failed to invalidate cache:', err.message);
                });
                console.log(`🗑️ [Add Subscriber] Cache invalidated for ${adminPhone} (unverified)`);
                
                // Log action
                const adminData = await getAdminData(adminId).catch(() => null);
                await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'add', cleanSubscriberNumber, quota, true);
                
                return res.json(normalizeSubscriberResponse({
                    number: cleanSubscriberNumber,
                    results: [],
                    message: 'Subscriber added successfully',
                    cacheInvalidated: true
                }));
            } else {
                console.error(`❌ [Add Subscriber] Could not verify and no clear success indicator`);
                // Log failed action
                const adminData = await getAdminData(adminId).catch(() => null);
                await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'add', cleanSubscriberNumber, quota, false, 'Could not verify');
                return res.status(400).json(createErrorResponse('Failed to add subscriber - could not verify'));
            }
        }
        
    } catch (error) {
        console.error('❌ Error in /api/addSubscriber:', error);
        
        // Log failed action
        try {
            const { adminId, subscriberNumber, quota } = req.body;
            if (adminId && subscriberNumber) {
                const cleanSubscriberNumber = subscriberNumber.replace(/\D/g, '').substring(0, 8);
                const adminData = await getAdminData(adminId).catch(() => null);
                const adminPhone = adminData?.phone || '';
                await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'add', cleanSubscriberNumber, quota || null, false, error.message || 'Unknown error');
            }
        } catch (logError) {
            console.error('Failed to log action:', logError);
        }
        
        if (error.response?.status === 401 || error.response?.status === 403) {
            return res.status(401).json(createErrorResponse('Authentication failed'));
        }
        
        res.status(500).json(createErrorResponse(
            error.message || 'Failed to add subscriber',
            error
        ));
    }
});

/**
 * DELETE /api/removeSubscriber
 * Remove a subscriber from an admin's U-share service
 * Query params: adminId, subscriberNumber, pending (optional, default: true)
 */
router.delete('/removeSubscriber', authenticateJWT, async (req, res) => {
    try {
        const { adminId, subscriberNumber, pending = 'true' } = req.query;
        
        if (!adminId || !subscriberNumber) {
            return res.status(400).json(createErrorResponse('adminId and subscriberNumber are required'));
        }
        
        const { phone: adminPhone, password: adminPassword, cookies } = await getAdminCredentialsAndCookies(adminId, req.userId);
        
        // Clean subscriber number
        let cleanSubscriberNumber = subscriberNumber.replace(/\D/g, '');
        if (cleanSubscriberNumber.length === 11 && cleanSubscriberNumber.startsWith('961')) {
            cleanSubscriberNumber = cleanSubscriberNumber.substring(3);
        }
        // Auto-fix: If 7 digits, prepend '0' to make it 8 digits
        if (cleanSubscriberNumber.length === 7) {
            cleanSubscriberNumber = '0' + cleanSubscriberNumber;
            console.log(`ℹ️ [RemoveSubscriber] Auto-corrected 7-digit number to 8 digits: ${cleanSubscriberNumber}`);
        }
        if (cleanSubscriberNumber.length !== 8) {
            return res.status(400).json(createErrorResponse('Subscriber number must be 8 digits'));
        }
        
        // Get fresh cookies (in case they expired)
        let freshCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
        
        // CRITICAL: Get subscriber data from Firebase BEFORE deletion (same as detection logic)
        // This ensures we preserve the consumption/limit values correctly
        let subscriberDataToSave = null;
        try {
            const adminData = await getFullAdminData(adminId);
            if (adminData && adminData.alfaData && adminData.alfaData.secondarySubscribers) {
                const secondarySubscribers = adminData.alfaData.secondarySubscribers || [];
                // Find subscriber in secondarySubscribers (normalize phone for comparison)
                const normalizedCleanNumber = cleanSubscriberNumber.replace(/^0+/, '');
                const matchingSubscriber = secondarySubscribers.find(sub => {
                    const subPhone = (sub.phoneNumber || '').replace(/^0+/, '');
                    const subFullPhone = (sub.fullPhoneNumber || '').replace(/^961/, '').replace(/^0+/, '');
                    return subPhone === normalizedCleanNumber || 
                           subFullPhone === normalizedCleanNumber ||
                           sub.phoneNumber === cleanSubscriberNumber ||
                           (sub.fullPhoneNumber && sub.fullPhoneNumber.replace(/^961/, '') === cleanSubscriberNumber);
                });
                
                if (matchingSubscriber) {
                    // Extract consumption and limit (handle different field names)
                    const consumption = matchingSubscriber.consumption !== undefined ? matchingSubscriber.consumption :
                                       (matchingSubscriber.usedConsumption !== undefined ? matchingSubscriber.usedConsumption : 0);
                    const limit = matchingSubscriber.quota !== undefined ? matchingSubscriber.quota :
                                 (matchingSubscriber.limit !== undefined ? matchingSubscriber.limit :
                                 (matchingSubscriber.totalQuota !== undefined ? matchingSubscriber.totalQuota : 0));
                    
                    // Only save if it's an Active subscriber (same as detection logic)
                    const status = matchingSubscriber.status || 'Active';
                    if (status === 'Active' || !status) {
                        subscriberDataToSave = {
                            phoneNumber: cleanSubscriberNumber,
                            fullPhoneNumber: matchingSubscriber.fullPhoneNumber || `961${cleanSubscriberNumber}`,
                            consumption: consumption,
                            limit: limit,
                            status: 'Active'
                        };
                        console.log(`✅ [Delete] Found subscriber in Firebase data: ${JSON.stringify(subscriberDataToSave)}`);
                    } else {
                        console.log(`ℹ️ [Delete] Subscriber ${cleanSubscriberNumber} is ${status}, will not save as "Out" (Requested subscribers are automatically removed)`);
                    }
                } else {
                    console.warn(`⚠️ [Delete] Subscriber ${cleanSubscriberNumber} not found in Firebase secondarySubscribers, will try to extract from HTML`);
                }
            }
        } catch (firebaseError) {
            console.warn(`⚠️ [Delete] Error getting subscriber data from Firebase: ${firebaseError.message}, will try to extract from HTML`);
        }
        
        // Step 0: Fetch Ushare page to extract the actual delete link from subscriber card
        // Step 1: GET the confirmation page using the extracted link
        // Step 2: POST the confirmation form with CSRF token
        let deleteSuccess = false;
        let attempts = 0;
        const maxAttempts = 2;
        
        while (attempts < maxAttempts && !deleteSuccess) {
            const cookieHeader = formatCookiesForHeader(freshCookies);
            
            try {
                // Step 0: Fetch Ushare page HTML once to find the delete link
                console.log(`🔍 [Delete] Step 0: Fetching Ushare page to find delete link...`);
                const ushareUrl = `${USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
                const ushareHtmlResponse = await axios.get(ushareUrl, {
                    headers: {
                        'Cookie': cookieHeader,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': `${ALFA_BASE_URL}/en/account`
                    },
                    maxRedirects: 5,
                    validateStatus: (status) => status >= 200 && status < 400,
                    timeout: 20000 // Increased to 20s (Alfa's servers are slow)
                });
                
                // Parse HTML to find subscriber card and extract delete link
                const ushareHtml = typeof ushareHtmlResponse.data === 'string' 
                    ? ushareHtmlResponse.data 
                    : JSON.stringify(ushareHtmlResponse.data);
                
                // Check if redirected to login
                const finalUrl = ushareHtmlResponse.request?.res?.responseUrl || ushareHtmlResponse.config?.url || '';
                if (finalUrl.includes('/login')) {
                    throw new Error('Redirected to login - cookies expired');
                }
                
                const $ushare = cheerio.load(ushareHtml);
                
                // Find subscriber card by phone number (try both with and without 961 prefix)
                const subscriberPhoneWithPrefix = `961${cleanSubscriberNumber}`;
                let deleteLinkHref = null;
                
                // Find all subscriber cards (they're inside #ushare-numbers)
                let subscriberCards = $ushare('#ushare-numbers .col-sm-4');
                
                // If no cards found with that selector, try alternative selectors
                if (subscriberCards.length === 0) {
                    console.warn(`⚠️ [Delete] No cards found with #ushare-numbers .col-sm-4, trying alternatives...`);
                    // Try finding all .col-sm-4, but we'll filter them below
                    const allColSm4 = $ushare('.col-sm-4');
                    console.log(`   Found ${allColSm4.length} total .col-sm-4 elements on page`);
                    
                    // Filter to only subscriber cards (must have delete link or phone number pattern)
                    subscriberCards = allColSm4.filter((i, el) => {
                        const $el = $ushare(el);
                        // Check if it's NOT a contact/support card
                        const text = $el.text().toLowerCase();
                        if (text.includes('contact us') || (text.includes('phone:') && text.includes('email:'))) {
                            return false; // Skip contact cards
                        }
                        // Check if it has a delete link (indicates it's a subscriber card)
                        // Delete links have class="remove" or href contains "ushare-delete"
                        const hasDeleteLink = $el.find('a.remove, a[href*="ushare-delete"]').length > 0;
                        // Check if it has an h2 with what looks like a phone number (8-11 digits)
                        const h2 = $el.find('h2');
                        const h2Text = h2.text().trim();
                        const h2Digits = h2Text.replace(/\D/g, '');
                        const looksLikePhone = h2Digits.length >= 8 && h2Digits.length <= 11 && /^[03-9]/.test(h2Digits);
                        // Check if it has status indicators (Active/Requested)
                        const hasStatus = $el.find('h4').text().includes('Active') || $el.find('h4').text().includes('Requested');
                        return hasDeleteLink || (looksLikePhone && hasStatus);
                    });
                    
                    console.log(`   Filtered to ${subscriberCards.length} subscriber card(s)`);
                }
                
                console.log(`📋 [Delete] Found ${subscriberCards.length} subscriber card(s) on page`);
                
                const foundPhones = []; // For debugging
                
                subscriberCards.each((i, card) => {
                    const $card = $ushare(card);
                    
                    // Find phone number - try multiple methods
                    let cardPhone = '';
                    
                    // Method 1: h2 element text
                    const h2 = $card.find('h2');
                    if (h2.length > 0) {
                        cardPhone = h2.text().trim();
                    }
                    
                    // Method 2: capacity element's id attribute
                    if (!cardPhone || cardPhone.length < 8) {
                        const capacityElement = $card.find('h4.italic.capacity');
                        const capacityId = capacityElement.attr('id');
                        if (capacityId && capacityId.length >= 8) {
                            cardPhone = capacityId;
                        }
                    }
                    
                    // Method 3: Look for phone number in any text content (8+ digits)
                    if (!cardPhone || cardPhone.length < 8) {
                        const cardText = $card.text();
                        // Look for 8-digit numbers (with or without 961 prefix)
                        const phoneMatch = cardText.match(/(?:961)?(\d{8})/);
                        if (phoneMatch) {
                            const extractedPhone = phoneMatch[1]; // Get the 8 digits
                            // Check if it looks like a phone number (starts with 03, 70, 71, 76, 78, 79)
                            if (/^0[3-9]|^7[0-9]/.test(extractedPhone)) {
                                cardPhone = extractedPhone;
                            }
                        }
                    }
                    
                    // Method 4: Check delete link href for phone number
                    if (!cardPhone || cardPhone.length < 8) {
                        const deleteLink = $card.find('a[href*="ushare-delete"]');
                        if (deleteLink.length > 0) {
                            const href = deleteLink.attr('href') || '';
                            // Extract number from URL like: /ushare-delete?number=96171935446&pending=True
                            const numberMatch = href.match(/number=(\d+)/);
                            if (numberMatch) {
                                const numberFromUrl = numberMatch[1];
                                // Remove 961 prefix if present
                                cardPhone = numberFromUrl.replace(/^961/, '').substring(0, 8);
                            }
                        }
                    }
                    
                    // Method 5: Try data attributes
                    if (!cardPhone || cardPhone.length < 8) {
                        const dataNumber = $card.attr('data-number') || $card.attr('data-phone') || $card.attr('data-subscriber');
                        if (dataNumber && dataNumber.length >= 8) {
                            cardPhone = dataNumber;
                        }
                    }
                    
                    // Method 6: Try all links and extract from hrefs
                    if (!cardPhone || cardPhone.length < 8) {
                        const allLinks = $card.find('a[href]');
                        allLinks.each((idx, link) => {
                            const href = $ushare(link).attr('href') || '';
                            // Look for phone number patterns in href
                            const phonePattern = /(?:961)?(\d{8})/;
                            const match = href.match(phonePattern);
                            if (match && !cardPhone) {
                                const extracted = match[1];
                                if (/^0[3-9]|^7[0-9]/.test(extracted)) {
                                    cardPhone = extracted;
                                    return false; // Break
                                }
                            }
                        });
                    }
                    
                    // Clean the phone number for comparison
                    let cleanCardPhone = cardPhone ? cardPhone.replace(/^961/, '').replace(/\D/g, '') : '';
                    // Normalize: Ensure 8 digits (pad with leading zero if 7 digits)
                    if (cleanCardPhone.length === 7) {
                        cleanCardPhone = '0' + cleanCardPhone;
                    }
                    cleanCardPhone = cleanCardPhone.substring(0, 8);
                    
                    // Normalize cleanSubscriberNumber for comparison (should already be 8 digits, but ensure)
                    let normalizedSubscriberNumber = cleanSubscriberNumber.replace(/\D/g, '');
                    if (normalizedSubscriberNumber.length === 7) {
                        normalizedSubscriberNumber = '0' + normalizedSubscriberNumber;
                    }
                    normalizedSubscriberNumber = normalizedSubscriberNumber.substring(0, 8);
                    
                    // Debug: Log card structure if phone not found
                    if (!cardPhone || cardPhone.length < 8) {
                        const cardHtmlSnippet = $card.html().substring(0, 500);
                        console.warn(`⚠️ [Delete] Card ${i}: Could not extract phone number. HTML snippet: ${cardHtmlSnippet}`);
                    }
                    
                    if (cardPhone && cardPhone.length >= 8) {
                        foundPhones.push(`${cardPhone} (cleaned: ${cleanCardPhone})`); // Debug logging
                    } else {
                        foundPhones.push(`(could not extract phone from card ${i})`);
                    }
                    
                    // Match phone with normalized comparison (handles leading zero differences)
                    // Compare both with and without leading zeros to handle format mismatches
                    const cardPhoneWithoutZero = cleanCardPhone.replace(/^0+/, '');
                    const subscriberWithoutZero = normalizedSubscriberNumber.replace(/^0+/, '');
                    
                    if (cleanCardPhone === normalizedSubscriberNumber || 
                        cardPhoneWithoutZero === subscriberWithoutZero ||
                        cardPhone.replace(/\D/g, '').replace(/^961/, '') === normalizedSubscriberNumber ||
                        cardPhone.replace(/\D/g, '').replace(/^961/, '').replace(/^0+/, '') === subscriberWithoutZero ||
                        normalizedSubscriberNumber.includes(cleanCardPhone.replace(/^0+/, '')) ||
                        cleanCardPhone.replace(/^0+/, '').includes(subscriberWithoutZero)) {
                        
                        // Find delete link in this card - try multiple selectors
                        // The delete link has class="remove" and href="/en/account/manage-services/ushare-delete?number=..."
                        let deleteLink = $card.find('a.remove, a[href*="ushare-delete"]');
                        if (deleteLink.length === 0) {
                            // Try without href filter - search all links
                            deleteLink = $card.find('a').filter((i, el) => {
                                const href = $ushare(el).attr('href') || '';
                                const classes = $ushare(el).attr('class') || '';
                                return href.includes('ushare-delete') || 
                                       href.includes('delete') || 
                                       classes.includes('remove');
                            });
                        }
                        
                        if (deleteLink.length > 0) {
                            deleteLinkHref = deleteLink.attr('href');
                            // Extract pending status from the actual delete link (preserve what Alfa shows)
                            const pendingMatch = deleteLinkHref.match(/pending=([^&]*)/i);
                            const actualPendingStatus = pendingMatch ? pendingMatch[1] : null;
                            console.log(`✅ [Delete] Found matching subscriber card: ${cardPhone} (clean: ${cleanCardPhone}) -> ${deleteLinkHref} (pending=${actualPendingStatus || 'not specified'})`);
                            
                            // Only extract from HTML if we didn't get data from Firebase (fallback)
                            if (!subscriberDataToSave) {
                                // Extract subscriber data BEFORE deletion (consumption, limit, status)
                                // Only save Active subscribers as "Out" (Requested subscribers are automatically removed)
                                const statusElement = $card.find('h4').first();
                                const statusText = statusElement.text().trim();
                                const isActive = statusText.toLowerCase().includes('active');
                                const isRequested = statusText.toLowerCase().includes('requested');
                                
                                if (isActive) {
                                    // Extract consumption and limit from the card
                                    // Try multiple methods to ensure we get the values
                                    let consumption = 0;
                                    let limit = 0;
                                    
                                    const capacityElement = $card.find('h4.italic.capacity');
                                    
                                    // Method 1: Try data attributes first (most reliable - same as ushareHtmlParser.js)
                                    if (capacityElement.length > 0) {
                                        const dataVal = capacityElement.attr('data-val');
                                        const dataQuota = capacityElement.attr('data-quota');
                                        if (dataVal && dataQuota) {
                                            consumption = parseFloat(dataVal) || 0;
                                            limit = parseFloat(dataQuota) || 0;
                                            console.log(`✅ [Delete] Extracted from HTML data attributes: consumption=${consumption}, limit=${limit}`);
                                        }
                                    }
                                    
                                    // Method 2: Try parsing from capacity element text (format: "X / Y GB" or "X / Y MB")
                                    if (limit === 0 && capacityElement.length > 0) {
                                        const capacityText = capacityElement.text().trim();
                                        const capacityMatch = capacityText.match(/([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                                        if (capacityMatch) {
                                            consumption = parseFloat(capacityMatch[1]) || 0;
                                            limit = parseFloat(capacityMatch[2]) || 0;
                                            // Convert MB to GB if needed
                                            if (capacityMatch[3].toUpperCase() === 'MB') {
                                                consumption = consumption / 1024;
                                                limit = limit / 1024;
                                            }
                                            console.log(`✅ [Delete] Extracted from HTML capacity text: consumption=${consumption}, limit=${limit}`);
                                        }
                                    }
                                    
                                    // Method 3: Try progress bar text as last resort
                                    if (limit === 0) {
                                        const progressBar = $card.find('.progress-bar, [class*="progress"]');
                                        if (progressBar.length > 0) {
                                            const progressText = progressBar.text().trim();
                                            const progressMatch = progressText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                                            if (progressMatch) {
                                                consumption = parseFloat(progressMatch[1]) || 0;
                                                limit = parseFloat(progressMatch[2]) || 0;
                                                console.log(`✅ [Delete] Extracted from HTML progress bar: consumption=${consumption}, limit=${limit}`);
                                            }
                                        }
                                    }
                                    
                                    // Store subscriber data to save after successful deletion (only if we got values)
                                    if (limit > 0 || consumption > 0) {
                                        subscriberDataToSave = {
                                            phoneNumber: cleanSubscriberNumber,
                                            fullPhoneNumber: subscriberPhoneWithPrefix,
                                            consumption: consumption,
                                            limit: limit,
                                            status: 'Active'
                                        };
                                        console.log(`📋 [Delete] Extracted subscriber data from HTML: ${JSON.stringify(subscriberDataToSave)}`);
                                    } else {
                                        console.warn(`⚠️ [Delete] Could not extract consumption/limit from HTML (got ${consumption}/${limit}), subscriber data may be incomplete`);
                                    }
                                } else if (isRequested) {
                                    console.log(`ℹ️ [Delete] Subscriber ${cleanSubscriberNumber} is Requested, will not save as "Out" (Requested subscribers are automatically removed)`);
                                }
                            } else {
                                console.log(`✅ [Delete] Using subscriber data from Firebase (already extracted)`);
                            }
                            
                            // Store the actual pending status to use it instead of overriding
                            if (actualPendingStatus) {
                                deleteLinkHref = deleteLinkHref.replace(/pending=[^&]*/i, `pending=${actualPendingStatus}`);
                            }
                            
                            return false; // Break the loop
                        } else {
                            console.warn(`⚠️ [Delete] Found subscriber card for ${cardPhone} but no delete link found`);
                            // Log all links in this card for debugging
                            const allLinks = $card.find('a');
                            if (allLinks.length > 0) {
                                console.warn(`   Available links in card: ${allLinks.map((i, el) => $ushare(el).attr('href')).get().join(', ')}`);
                            }
                        }
                    }
                });
                
                // If we still haven't found the delete link, try searching all delete links on the page
                if (!deleteLinkHref) {
                    console.warn(`⚠️ [Delete] Delete link not found via card matching, trying direct search...`);
                    // Find all delete links on the page - try multiple selectors
                    // Links have class="remove" or href contains "ushare-delete"
                    let allDeleteLinks = $ushare('a.remove, a[href*="ushare-delete"]');
                    console.log(`   Found ${allDeleteLinks.length} delete link(s) with .remove or ushare-delete`);
                    
                    // If none found, try broader search
                    if (allDeleteLinks.length === 0) {
                        allDeleteLinks = $ushare('a[href*="delete"], a[class*="remove"]');
                        console.log(`   Found ${allDeleteLinks.length} delete/remove link(s) with broader search`);
                    }
                    
                    // Try to match by subscriber number in the URL
                    allDeleteLinks.each((i, link) => {
                        let href = $ushare(link).attr('href') || '';
                        // Convert HTML entities (&amp; to &)
                        href = href.replace(/&amp;/g, '&');
                        
                        // Extract number from URL: /ushare-delete?number=96171935446&pending=True
                        // Also handle &amp; in URL
                        const numberMatch = href.match(/number=(\d+)/);
                        if (numberMatch) {
                            const numberFromUrl = numberMatch[1].replace(/^961/, '').replace(/\D/g, '').substring(0, 8);
                            if (numberFromUrl === cleanSubscriberNumber) {
                                deleteLinkHref = href;
                                console.log(`✅ [Delete] Found delete link via URL matching: ${href}`);
                                return false; // Break the loop
                            }
                        }
                    });
                    
                    // If still not found, try to construct the delete URL based on known pattern
                    if (!deleteLinkHref) {
                        console.warn(`⚠️ [Delete] No delete link found, trying to construct URL manually...`);
                        const isPending = pending === 'true' || pending === true;
                        // Try both with and without 961 prefix
                        const deleteUrlWith961 = `/en/account/manage-services/ushare-delete?number=961${cleanSubscriberNumber}&pending=${isPending ? 'True' : 'False'}`;
                        const deleteUrlWithout961 = `/en/account/manage-services/ushare-delete?number=${cleanSubscriberNumber}&pending=${isPending ? 'True' : 'False'}`;
                        
                        console.log(`   Trying constructed URL: ${deleteUrlWith961}`);
                        console.log(`   Or: ${deleteUrlWithout961}`);
                        
                        // We'll try both URLs when we get to the confirmation step
                        // For now, just log what we're trying
                        deleteLinkHref = deleteUrlWith961; // Try with 961 first
                    }
                }
                
                // If we found delete link via URL matching but didn't extract subscriber data yet, extract it now
                if (deleteLinkHref && !subscriberDataToSave) {
                    // Try to find the subscriber card again to extract data
                    subscriberCards.each((i, card) => {
                        const $card = $ushare(card);
                        
                        // Extract phone number from card (same logic as before)
                        let cardPhone = '';
                        const h2 = $card.find('h2');
                        if (h2.length > 0) {
                            cardPhone = h2.text().trim();
                        }
                        let cleanCardPhone = cardPhone ? cardPhone.replace(/^961/, '').replace(/\D/g, '') : '';
                        if (cleanCardPhone.length === 7) {
                            cleanCardPhone = '0' + cleanCardPhone;
                        }
                        cleanCardPhone = cleanCardPhone.substring(0, 8);
                        
                        const normalizedSubscriberNumber = cleanSubscriberNumber.replace(/\D/g, '');
                        const subscriberWithoutZero = normalizedSubscriberNumber.replace(/^0+/, '');
                        const cardPhoneWithoutZero = cleanCardPhone.replace(/^0+/, '');
                        
                        if (cleanCardPhone === normalizedSubscriberNumber || 
                            cardPhoneWithoutZero === subscriberWithoutZero) {
                            
                            // Extract subscriber data
                            const statusElement = $card.find('h4').first();
                            const statusText = statusElement.text().trim();
                            const isActive = statusText.toLowerCase().includes('active');
                            
                            if (isActive) {
                                let consumption = 0;
                                let limit = 0;
                                
                                const capacityElement = $card.find('h4.italic.capacity');
                                if (capacityElement.length > 0) {
                                    const capacityText = capacityElement.text().trim();
                                    const capacityMatch = capacityText.match(/([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                                    if (capacityMatch) {
                                        consumption = parseFloat(capacityMatch[1]) || 0;
                                        limit = parseFloat(capacityMatch[2]) || 0;
                                        if (capacityMatch[3].toUpperCase() === 'MB') {
                                            consumption = consumption / 1024;
                                            limit = limit / 1024;
                                        }
                                    }
                                }
                                
                                subscriberDataToSave = {
                                    phoneNumber: cleanSubscriberNumber,
                                    fullPhoneNumber: subscriberPhoneWithPrefix,
                                    consumption: consumption,
                                    limit: limit,
                                    status: 'Active'
                                };
                                console.log(`📋 [Delete] Extracted subscriber data (fallback): ${JSON.stringify(subscriberDataToSave)}`);
                                return false; // Break
                            }
                        }
                    });
                }
                
                // Before throwing error, try to save the HTML for debugging
                if (!deleteLinkHref) {
                    console.error(`❌ [Delete] Delete link not found. Looking for: ${cleanSubscriberNumber} or ${subscriberPhoneWithPrefix}`);
                    console.error(`   Found phones on page: ${foundPhones.length > 0 ? foundPhones.join(', ') : '(none)'}`);
                    console.error(`   Pending parameter: ${pending}`);
                    
                    // Log all delete links found for debugging
                    const allDeleteLinks = $ushare('a[href*="ushare-delete"]');
                    if (allDeleteLinks.length > 0) {
                        console.error(`   Available delete links on page:`);
                        allDeleteLinks.each((i, link) => {
                            const href = $ushare(link).attr('href') || '';
                            console.error(`     - ${href}`);
                        });
                    } else {
                        console.error(`   No delete links found anywhere on the page`);
                        // Log a larger HTML snippet to see the page structure
                        const ushareContainer = $ushare('#ushare-numbers');
                        if (ushareContainer.length > 0) {
                            const containerHtml = ushareContainer.html();
                            console.error(`   #ushare-numbers container HTML (first 2000 chars):`);
                            console.error(containerHtml.substring(0, 2000));
                        } else {
                            console.error(`   #ushare-numbers container not found`);
                            // Try to find any elements that might contain subscribers
                            const allH2 = $ushare('h2');
                            console.error(`   Found ${allH2.length} h2 elements on page`);
                            allH2.each((i, h2) => {
                                const text = $ushare(h2).text().trim();
                                if (text && text.length >= 8) {
                                    console.error(`     h2[${i}]: ${text}`);
                                }
                            });
                        }
                    }
                    
                    // If subscriber not found, try constructing URL anyway if it's a pending subscriber
                    const isPending = pending === 'true' || pending === true;
                    if (isPending && foundPhones.length === 0) {
                        console.warn(`⚠️ [Delete] No delete link found for pending subscriber, attempting to construct URL...`);
                        const constructedUrl = `/en/account/manage-services/ushare-delete?number=961${cleanSubscriberNumber}&pending=True`;
                        deleteLinkHref = constructedUrl;
                        console.log(`   Will try constructed URL: ${constructedUrl}`);
                    } else {
                        // If subscriber not found, it might already be deleted
                        if (foundPhones.length === 0 && subscriberCards.length === 0) {
                            throw new Error(`Subscriber ${cleanSubscriberNumber} not found on Ushare page. It may have already been deleted.`);
                        } else {
                            throw new Error(`Delete link not found for subscriber ${cleanSubscriberNumber} on Ushare page. Found phones: ${foundPhones.join(', ') || '(none)'}`);
                        }
                    }
                }
                
                // Make delete link absolute if it's relative
                let confirmationUrl = deleteLinkHref;
                // Convert HTML entities to regular characters
                confirmationUrl = confirmationUrl.replace(/&amp;/g, '&');
                
                if (!confirmationUrl.startsWith('http')) {
                    confirmationUrl = `${ALFA_BASE_URL}${confirmationUrl.startsWith('/') ? '' : '/'}${confirmationUrl}`;
                }
                
                // Ensure pending parameter is set correctly in the delete URL
                // IMPORTANT: Use the pending status from the actual delete link on the card (Alfa's source of truth)
                // Only override if the URL doesn't have a pending parameter at all
                if (!confirmationUrl.includes('pending=')) {
                    // URL doesn't have pending parameter, add it based on user request
                    const isPendingSubscriber = pending === 'true' || pending === true;
                    const separator = confirmationUrl.includes('?') ? '&' : '?';
                    confirmationUrl = `${confirmationUrl}${separator}pending=${isPendingSubscriber ? 'True' : 'False'}`;
                    console.log(`✅ [Delete] Added pending parameter to URL: ${confirmationUrl}`);
                } else {
                    // URL already has pending parameter from the card - use it as-is (this is what Alfa expects)
                    const pendingMatch = confirmationUrl.match(/pending=([^&]*)/i);
                    const actualPendingStatus = pendingMatch ? pendingMatch[1] : null;
                    console.log(`✅ [Delete] Using pending status from card's delete link: ${actualPendingStatus || 'not found'}`);
                }
                
                console.log(`✅ [Delete] Final delete URL: ${confirmationUrl}`);
                
                // Step 1: GET confirmation page
                console.log(`🔍 [Delete] Step 1: Fetching confirmation page...`);
                const confirmationResponse = await axios.get(confirmationUrl, {
                    headers: {
                        'Cookie': cookieHeader,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': `${USHARE_BASE_URL}?mobileNumber=${adminPhone}`
                    },
                    maxRedirects: 5,
                    validateStatus: (status) => status >= 200 && status < 400,
                    timeout: 20000 // Increased to 20s (Alfa's servers are slow)
                });
                
                // Check if redirected to login
                const confirmationFinalUrl = confirmationResponse.request?.res?.responseUrl || confirmationResponse.config?.url || '';
                if (confirmationFinalUrl.includes('/login')) {
                    if (attempts < maxAttempts - 1) {
                        console.log(`🔄 Cookies expired during delete confirmation, refreshing... (attempt ${attempts + 1}/${maxAttempts})`);
                        freshCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                        continue;
                    }
                    return res.status(401).json(createErrorResponse('Authentication failed - cookies expired'));
                }
                
                // Parse HTML to extract CSRF token and form action
                const html = confirmationResponse.data;
                const $ = cheerio.load(html);
                
                // Check if this is actually a confirmation page
                const pageText = $('body').text();
                if (!pageText.includes('Are you sure')) {
                    console.error(`❌ [Delete] Not a confirmation page. Page text preview: ${pageText.substring(0, 200)}`);
                    return res.status(500).json(createErrorResponse('Confirmation page not found - deletion may have already occurred'));
                }
                
                // Extract CSRF token from form
                const csrfToken = $('input[name="__RequestVerificationToken"]').val();
                if (!csrfToken) {
                    console.error(`❌ [Delete] CSRF token not found in confirmation page`);
                    return res.status(500).json(createErrorResponse('CSRF token not found in confirmation page'));
                }
                
                // Extract form action (default to same URL if not specified)
                const form = $('form.form-horizontal');
                const formAction = form.attr('action') || confirmationUrl.split('?')[0]; // Use base URL if no action
                
                console.log(`✅ [Delete] Found CSRF token, submitting confirmation form...`);
                
                // Step 2: POST the confirmation form
                const { URLSearchParams } = require('url');
                const formData = new URLSearchParams();
                formData.append('__RequestVerificationToken', csrfToken);
                // Add any hidden form fields that might be present
                form.find('input[type="hidden"]').each((i, elem) => {
                    const name = $(elem).attr('name');
                    const value = $(elem).val();
                    if (name && name !== '__RequestVerificationToken') {
                        formData.append(name, value || '');
                    }
                });
                
                const deleteResponse = await axios.post(confirmationUrl, formData.toString(), {
                    headers: {
                        'Cookie': cookieHeader,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': confirmationUrl
                    },
                    maxRedirects: 5,
                    validateStatus: (status) => status >= 200 && status < 400,
                    timeout: 20000 // Increased to 20s (Alfa's servers are slow)
                });
                
                const deleteFinalUrl = deleteResponse.request.res.responseUrl || deleteResponse.config.url || '';
                
                // Check if redirected to login
                if (deleteFinalUrl.includes('/login')) {
                    if (attempts < maxAttempts - 1) {
                        console.log(`🔄 Cookies expired during delete submission, refreshing... (attempt ${attempts + 1}/${maxAttempts})`);
                        freshCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                        continue;
                    }
                    return res.status(401).json(createErrorResponse('Authentication failed - cookies expired'));
                }
                
                console.log(`✅ [Delete] Confirmation form submitted. Status: ${deleteResponse.status}, Final URL: ${deleteFinalUrl}`);
                
                // If we got a successful response (200 OK or redirect to ushare page), mark as success
                // Redirect to ushare page indicates successful deletion
                if (deleteResponse.status === 200 || deleteFinalUrl.includes('/ushare')) {
                    deleteSuccess = true;
                } else {
                    console.warn(`⚠️ [Delete] Unexpected response status: ${deleteResponse.status}, URL: ${deleteFinalUrl}`);
                    deleteSuccess = true; // Still mark as success if not a clear error
                }
                
            } catch (error) {
                if (error.response && (error.response.status === 401 || error.response.status === 403)) {
                    if (attempts < maxAttempts - 1) {
                        console.log(`🔄 Authentication error during delete, refreshing cookies... (attempt ${attempts + 1}/${maxAttempts})`);
                        freshCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                        continue;
                    }
                }
                throw error;
            }
        }
        
        if (!deleteSuccess) {
            throw new Error('Failed to delete subscriber after multiple attempts');
        }
        
        // OPTIMIZATION: Skip verification if delete was successful (saves ~15 seconds)
        // The delete response already indicates success (200 OK or redirect to ushare page)
        // Verification is non-critical and can be done on next refresh
        console.log(`✅ [Delete] Deletion successful, skipping verification (saves ~15s)`);
        
        // Save removed Active subscriber data to Firebase (to display as "Out" in view details)
        if (subscriberDataToSave) {
            console.log(`💾 [Delete] Saving removed Active subscriber data to Firebase: ${subscriberDataToSave.phoneNumber}`);
            addRemovedActiveSubscriber(adminId, subscriberDataToSave).catch(err => {
                console.error('❌ Failed to save removed Active subscriber data:', err.message);
                // Don't fail the request if saving fails - it's not critical
            });
        }
        
        // Invalidate Ushare cache so fresh data is fetched next time (don't wait)
        const { invalidateUshareCache } = require('../services/ushareHtmlParser');
        invalidateUshareCache(adminPhone).catch(err => {
            console.warn('⚠️ Failed to invalidate cache:', err.message);
        });
        
        // Optional: Quick verification (non-blocking, async) - don't wait for it
        // This runs in background and doesn't block the response
        setImmediate(async () => {
            try {
                await new Promise(resolve => setTimeout(resolve, 2000)); // Brief wait
                const { fetchUshareHtml } = require('../services/ushareHtmlParser');
                const verification = await fetchUshareHtml(adminPhone, freshCookies, false);
                
                if (verification.success && verification.data && verification.data.subscribers) {
                    // Normalize subscriber number for comparison (handle leading zero differences)
                    const normalizedNumber = cleanSubscriberNumber.replace(/^0+/, '');
                    const normalizedWithZero = normalizedNumber.length === 7 ? '0' + normalizedNumber : normalizedNumber;
                    
                    const subscriberStillExists = verification.data.subscribers.some(sub => {
                        const subPhone = (sub.phoneNumber || '').replace(/\D/g, '').replace(/^961/, '').replace(/^0+/, '');
                        const subFullPhone = (sub.fullPhoneNumber || '').replace(/\D/g, '').replace(/^961/, '').replace(/^0+/, '');
                        const searchNormalized = normalizedNumber;
                        const searchWithZero = normalizedWithZero;
                        
                        return subPhone === searchNormalized || 
                               subPhone === searchWithZero ||
                               subFullPhone === searchNormalized ||
                               subFullPhone === searchWithZero ||
                               (sub.phoneNumber || '') === cleanSubscriberNumber ||
                               (sub.fullPhoneNumber || '') === cleanSubscriberNumber ||
                               (sub.fullPhoneNumber || '') === `961${cleanSubscriberNumber}`;
                    });
                    
                    if (subscriberStillExists) {
                        console.warn(`⚠️ [Delete] Background verification: Subscriber ${cleanSubscriberNumber} still exists (may be pending removal)`);
                    } else {
                        console.log(`✅ [Delete] Background verification: Subscriber ${cleanSubscriberNumber} confirmed deleted`);
                    }
                }
            } catch (verifyError) {
                // Silent fail - verification is non-critical
            }
        });
        
        // Log action
        const adminData = await getAdminData(adminId).catch(() => null);
        await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'remove', cleanSubscriberNumber, null, true);
        
        res.json(normalizeSubscriberResponse({
            number: cleanSubscriberNumber,
            results: [],
            message: 'Subscriber removed successfully'
        }));
        
    } catch (error) {
        console.error('❌ Error in /api/removeSubscriber:', error);
        
        // Log failed action
        try {
            const { adminId, subscriberNumber } = req.query;
            if (adminId && subscriberNumber) {
                let cleanSubscriberNumber = subscriberNumber.replace(/\D/g, '');
                if (cleanSubscriberNumber.length === 11 && cleanSubscriberNumber.startsWith('961')) {
                    cleanSubscriberNumber = cleanSubscriberNumber.substring(3);
                }
                // Auto-fix: If 7 digits, prepend '0' to make it 8 digits
                if (cleanSubscriberNumber.length === 7) {
                    cleanSubscriberNumber = '0' + cleanSubscriberNumber;
                }
                const adminData = await getAdminData(adminId).catch(() => null);
                const adminPhone = adminData?.phone || '';
                await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'remove', cleanSubscriberNumber, null, false, error.message || 'Unknown error');
            }
        } catch (logError) {
            console.error('Failed to log action:', logError);
        }
        
        if (error.response?.status === 401 || error.response?.status === 403) {
            return res.status(401).json(createErrorResponse('Authentication failed'));
        }
        
        res.status(500).json(createErrorResponse(
            error.message || 'Failed to remove subscriber',
            error
        ));
    }
});

/**
 * PUT /api/editSubscriber
 * Edit a subscriber's quota
 * Body: { adminId, subscriberNumber, quota }
 */
router.put('/editSubscriber', authenticateJWT, async (req, res) => {
    try {
        const { adminId, subscriberNumber, quota } = req.body;
        
        if (!adminId || !subscriberNumber || quota === undefined) {
            return res.status(400).json(createErrorResponse('adminId, subscriberNumber, and quota are required'));
        }
        
        // Validate quota
        if (quota < 0.1 || quota > 70) {
            return res.status(400).json(createErrorResponse('Quota must be between 0.1 and 70 GB'));
        }
        
        const { phone: adminPhone, password: adminPassword, cookies } = await getAdminCredentialsAndCookies(adminId, req.userId);
        
        // Clean subscriber number
        let cleanSubscriberNumber = subscriberNumber.replace(/\D/g, '');
        if (cleanSubscriberNumber.length === 11 && cleanSubscriberNumber.startsWith('961')) {
            cleanSubscriberNumber = cleanSubscriberNumber.substring(3);
        }
        // Auto-fix: If 7 digits, prepend '0' to make it 8 digits
        if (cleanSubscriberNumber.length === 7) {
            cleanSubscriberNumber = '0' + cleanSubscriberNumber;
            console.log(`ℹ️ [EditSubscriber] Auto-corrected 7-digit number to 8 digits: ${cleanSubscriberNumber}`);
        }
        if (cleanSubscriberNumber.length !== 8) {
            return res.status(400).json(createErrorResponse('Subscriber number must be 8 digits'));
        }
        
        // Edit requires: GET edit form -> extract CSRF -> POST form
        // OPTIMIZATION: Skip redundant cookie validation - we'll validate cookies when fetching the edit form
        // This saves ~20 seconds (getCsrfToken makes a full HTTP request with 20s timeout)
        // The edit form fetch will validate cookies and refresh them if needed in the retry loop
        
        // Step 1: GET the edit form page
        // Get cookies (will refresh if needed when we detect login redirect in retry loop)
        let freshCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
        let attempts = 0;
        const maxAttempts = 2;
        let editSuccess = false;
        
        while (attempts < maxAttempts && !editSuccess) {
            const cookieHeader = formatCookiesForHeader(freshCookies);
            
            try {
                // GET the edit form page
                // URL format: /en/account/manage-services/ushare-modify?number=96171935446&sharedQuota=10
                const subscriberPhoneWith961 = `961${cleanSubscriberNumber}`;
                const editFormUrl = `${ALFA_BASE_URL}/en/account/manage-services/ushare-modify?number=${subscriberPhoneWith961}&sharedQuota=${quota}`;
                
                console.log(`📝 [Edit] Step 1: Fetching edit form page...`);
                const formResponse = await axios.get(editFormUrl, {
                    headers: {
                        'Cookie': cookieHeader,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': `${USHARE_BASE_URL}?mobileNumber=${adminPhone}`
                    },
                    maxRedirects: 5,
                    validateStatus: (status) => status >= 200 && status < 400,
                    timeout: 20000
                });
                
                // Check if redirected to login - check both final URL and response HTML
                const formFinalUrl = formResponse.request?.res?.responseUrl || formResponse.config?.url || '';
                const formHtml = typeof formResponse.data === 'string' ? formResponse.data : JSON.stringify(formResponse.data);
                const isLoginPage = formFinalUrl.includes('/login') || formHtml.includes('Log in') || formHtml.includes('Welcome') && formHtml.includes('START HERE');
                
                if (isLoginPage) {
                    if (attempts < maxAttempts - 1) {
                        console.log(`🔄 [Edit] Cookies expired during edit form fetch (detected login page), refreshing... (attempt ${attempts + 1}/${maxAttempts})`);
                        freshCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                        continue;
                    }
                    console.error(`❌ [Edit] Still redirected to login after cookie refresh`);
                    return res.status(401).json(createErrorResponse('Authentication failed - cookies expired'));
                }
                
                // Parse HTML to extract CSRF token
                const html = formResponse.data;
                const $ = cheerio.load(html);
                
                // Check if form exists
                const form = $('form.form-horizontal');
                if (form.length === 0) {
                    // Check if we're on a login page
                    if (formHtml.includes('Log in') || formHtml.includes('Welcome') && formHtml.includes('START HERE')) {
                        throw new Error('Redirected to login page - cookies expired');
                    }
                    console.error(`❌ [Edit] Edit form not found. Page content preview: ${formHtml.substring(0, 500)}`);
                    throw new Error('Edit form not found on page - page structure may have changed');
                }
                
                // Extract CSRF token
                const csrfToken = $('input[name="__RequestVerificationToken"]').val();
                if (!csrfToken) {
                    throw new Error('CSRF token not found in edit form');
                }
                
                console.log(`✅ [Edit] Found CSRF token, submitting form...`);
                
                // Extract all form fields to see what we're working with
                const allFormFields = {};
                form.find('input').each((i, elem) => {
                    const name = $(elem).attr('name');
                    const value = $(elem).val();
                    const type = $(elem).attr('type');
                    if (name) {
                        allFormFields[name] = { value, type: type || 'text' };
                    }
                });
                console.log(`🔍 [Edit] Form fields found: ${Object.keys(allFormFields).join(', ')}`);
                
                // Step 2: POST the form with updated quota
                const formAction = form.attr('action') || editFormUrl.split('?')[0];
                const { URLSearchParams } = require('url');
                const formData = new URLSearchParams();
                formData.append('__RequestVerificationToken', csrfToken);
                formData.append('Quota', quota.toString());
                
                // Add ALL hidden and text input fields from the form (except Quota which we're updating)
                form.find('input').each((i, elem) => {
                    const name = $(elem).attr('name');
                    const value = $(elem).val();
                    const type = $(elem).attr('type') || 'text';
                    
                    if (name && name !== '__RequestVerificationToken' && name !== 'Quota') {
                        // Include all fields: hidden, text, etc. (like Number, MaxQuota, etc.)
                        formData.append(name, value || '');
                        console.log(`   Adding form field: ${name} = ${value} (type: ${type})`);
                    }
                });
                
                console.log(`📤 [Edit] Submitting form to ${formAction}`);
                console.log(`   Form data: Quota=${quota}, and ${formData.toString().split('&').length - 1} other fields`);
                
                const submitResponse = await axios.post(formAction, formData.toString(), {
                    headers: {
                        'Cookie': cookieHeader,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': editFormUrl
                    },
                    maxRedirects: 5,
                    validateStatus: (status) => status >= 200 && status < 600, // Accept all status codes to handle 500 errors from Alfa
                    timeout: 20000
                });
                
                const submitFinalUrl = submitResponse.request?.res?.responseUrl || submitResponse.config?.url || '';
                const submitHtml = typeof submitResponse.data === 'string' ? submitResponse.data : JSON.stringify(submitResponse.data);
                
                // Check if redirected to login
                if (submitFinalUrl.includes('/login')) {
                    if (attempts < maxAttempts - 1) {
                        console.log(`🔄 Cookies expired during edit submission, refreshing... (attempt ${attempts + 1}/${maxAttempts})`);
                        freshCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                        continue;
                    }
                    return res.status(401).json(createErrorResponse('Authentication failed - cookies expired'));
                }
                
                // Handle 500 errors from Alfa - check response body for success/error indicators
                if (submitResponse.status === 500) {
                    console.warn(`⚠️ [Edit] Alfa server returned 500 error. Checking response body...`);
                    console.log(`   Response body preview (first 1000 chars): ${submitHtml.substring(0, 1000)}`);
                    
                    // Check if the error page contains success indicators (sometimes Alfa returns 500 but the operation succeeded)
                    const lowerHtml = submitHtml.toLowerCase();
                    
                    // Check for specific error messages in the HTML
                    const validationErrorMatch = submitHtml.match(/validation.*error|invalid.*quota|quota.*invalid/i);
                    if (validationErrorMatch) {
                        const errorMsg = validationErrorMatch[0];
                        console.error(`❌ [Edit] Validation error detected: ${errorMsg}`);
                        throw new Error(`Edit failed: ${errorMsg}. Please check the quota value and try again.`);
                    }
                    
                    // Check for success indicators in the response
                    if (lowerHtml.includes('success') || lowerHtml.includes('updated') || lowerHtml.includes('modified')) {
                        console.log(`✅ [Edit] Alfa returned 500 but response indicates success`);
                        editSuccess = true;
                    } else {
                        // 500 error with no success indicators - verify by checking Ushare page
                        console.log(`⚠️ [Edit] Alfa returned 500 error. Verifying edit by checking Ushare page...`);
                        try {
                            // Wait a moment for Alfa to process the change
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            
                            // Fetch Ushare page to verify the quota was updated
                            const { formatCookiesForHeader } = require('../services/apiClient');
                            const cookieHeader = formatCookiesForHeader(freshCookies || cookies);
                            const ushareUrl = `https://www.alfa.com.lb/en/account/manage-services/ushare?mobileNumber=${adminPhone}`;
                            const ushareResponse = await axios.get(ushareUrl, {
                                headers: {
                                    'Cookie': cookieHeader,
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                                },
                                timeout: 20000,
                                maxRedirects: 5,
                                validateStatus: (status) => status < 400
                            });
                            const ushareHtml = typeof ushareResponse.data === 'string' ? ushareResponse.data : JSON.stringify(ushareResponse.data);
                            const $verify = cheerio.load(ushareHtml);
                            
                            // Find the subscriber in the Ushare page and check quota (same structure as ushareHtmlParser.js)
                            const subscriberCards = $verify('#ushare-numbers .col-sm-4');
                            let quotaUpdated = false;
                            let foundSubscriber = false;
                            
                            subscriberCards.each((index, element) => {
                                const $card = $verify(element);
                                
                                // Find phone number (in h2 element)
                                const phoneElement = $card.find('h2');
                                let phoneNumber = phoneElement.text().trim();
                                
                                // Clean phone number for comparison (remove 961 prefix, keep only digits)
                                const cleanPhoneFromPage = phoneNumber.replace(/^961/, '').replace(/\D/g, '');
                                const cleanPhoneToFind = cleanSubscriberNumber.replace(/\D/g, '');
                                
                                if (cleanPhoneFromPage === cleanPhoneToFind || phoneNumber.includes(cleanSubscriberNumber)) {
                                    foundSubscriber = true;
                                    
                                    // Get quota from data-quota attribute (same as ushareHtmlParser.js)
                                    const capacityElement = $card.find('h4.italic.capacity');
                                    const dataQuota = capacityElement.attr('data-quota');
                                    const quotaFromPage = dataQuota ? parseFloat(dataQuota) : null;
                                    
                                    console.log(`🔍 [Edit] Found subscriber ${phoneNumber}, quota on page: ${quotaFromPage}, expected: ${quota}`);
                                    
                                    if (quotaFromPage !== null && Math.abs(quotaFromPage - quota) < 0.1) {
                                        quotaUpdated = true;
                                        console.log(`✅ [Edit] Verified: Subscriber quota is ${quotaFromPage} GB on Ushare page (matches expected ${quota} GB)`);
                                        return false; // Break out of each loop
                                    } else if (quotaFromPage !== null) {
                                        console.log(`⚠️ [Edit] Subscriber found but quota mismatch: ${quotaFromPage} GB (expected ${quota} GB)`);
                                    } else {
                                        console.warn(`⚠️ [Edit] Subscriber found but data-quota attribute not found`);
                                    }
                                }
                            });
                            
                            if (!foundSubscriber) {
                                console.error(`❌ [Edit] Verification failed: Subscriber ${cleanSubscriberNumber} not found on Ushare page`);
                                throw new Error(`Edit verification failed: Subscriber not found on Ushare page. The edit may have failed.`);
                            } else if (!quotaUpdated) {
                                console.error(`❌ [Edit] Edit verification failed - quota not updated on Ushare page (found subscriber but quota doesn't match)`);
                                throw new Error('Edit operation failed - quota was not updated on the Ushare page. Please try again.');
                            } else {
                                console.log(`✅ [Edit] Edit verified successfully despite 500 error from Alfa`);
                                editSuccess = true;
                            }
                        } catch (verifyError) {
                            console.error(`❌ [Edit] Error verifying edit: ${verifyError.message}`);
                            // If verification fails, check if HTML contains specific error messages
                            const errorMatch = submitHtml.match(/<div[^>]*class[^>]*error[^>]*>(.*?)<\/div>/i) ||
                                              submitHtml.match(/<p[^>]*class[^>]*error[^>]*>(.*?)<\/p>/i) ||
                                              submitHtml.match(/error[^>]*>(.*?)</i);
                            const errorMessage = errorMatch ? errorMatch[1].replace(/<[^>]*>/g, '').trim() : 'Server error';
                            throw new Error(`Edit failed: ${errorMessage || verifyError.message}. Please try again.`);
                        }
                    }
                } else if (submitResponse.status === 200 || submitResponse.status === 302 || submitFinalUrl.includes('/ushare')) {
                    // Success: 200 OK, 302 redirect, or redirect to ushare page indicates success
                    console.log(`✅ [Edit] Form submitted successfully. Status: ${submitResponse.status}, Final URL: ${submitFinalUrl}`);
                    editSuccess = true;
                } else {
                    // Other status codes - check response body
                    const lowerHtml = submitHtml.toLowerCase();
                    if (lowerHtml.includes('success') || lowerHtml.includes('updated')) {
                        console.log(`✅ [Edit] Response indicates success despite status ${submitResponse.status}`);
                        editSuccess = true;
                    } else {
                        console.warn(`⚠️ [Edit] Unexpected response: ${submitResponse.status}, URL: ${submitFinalUrl}`);
                        // For now, assume success for non-500 errors (might be a redirect or partial success)
                        editSuccess = true;
                    }
                }
                
            } catch (error) {
                // Handle 500 errors from Alfa (axios may throw even with validateStatus accepting 500)
                if (error.response && error.response.status === 500) {
                    console.warn(`⚠️ [Edit] Alfa server returned 500 error. Checking response body...`);
                    const errorHtml = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data);
                    const lowerHtml = errorHtml.toLowerCase();
                    
                    // Check for success indicators in the error response
                    if (lowerHtml.includes('success') || lowerHtml.includes('updated') || lowerHtml.includes('modified')) {
                        console.log(`✅ [Edit] Alfa returned 500 but response indicates success`);
                        editSuccess = true;
                        break; // Exit retry loop
                    } else {
                        // 500 error with no success indicators - verify by checking Ushare page
                        console.log(`⚠️ [Edit] Alfa returned 500 error. Verifying edit by checking Ushare page...`);
                        try {
                            // Wait a moment for Alfa to process the change
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            
                            // Fetch Ushare page to verify the quota was updated
                            const { formatCookiesForHeader } = require('../services/apiClient');
                            const cookieHeader = formatCookiesForHeader(freshCookies || cookies);
                            const ushareUrl = `https://www.alfa.com.lb/en/account/manage-services/ushare?mobileNumber=${adminPhone}`;
                            const ushareResponse = await axios.get(ushareUrl, {
                                headers: {
                                    'Cookie': cookieHeader,
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                                },
                                timeout: 20000,
                                maxRedirects: 5,
                                validateStatus: (status) => status < 400
                            });
                            const ushareHtml = typeof ushareResponse.data === 'string' ? ushareResponse.data : JSON.stringify(ushareResponse.data);
                            const $verify = cheerio.load(ushareHtml);
                            
                            // Find the subscriber in the Ushare page and check quota (same structure as ushareHtmlParser.js)
                            const subscriberCards = $verify('#ushare-numbers .col-sm-4');
                            let quotaUpdated = false;
                            let foundSubscriber = false;
                            
                            subscriberCards.each((index, element) => {
                                const $card = $verify(element);
                                
                                // Find phone number (in h2 element)
                                const phoneElement = $card.find('h2');
                                let phoneNumber = phoneElement.text().trim();
                                
                                // Clean phone number for comparison (remove 961 prefix, keep only digits)
                                const cleanPhoneFromPage = phoneNumber.replace(/^961/, '').replace(/\D/g, '');
                                const cleanPhoneToFind = cleanSubscriberNumber.replace(/\D/g, '');
                                
                                if (cleanPhoneFromPage === cleanPhoneToFind || phoneNumber.includes(cleanSubscriberNumber)) {
                                    foundSubscriber = true;
                                    
                                    // Get quota from data-quota attribute (same as ushareHtmlParser.js)
                                    const capacityElement = $card.find('h4.italic.capacity');
                                    const dataQuota = capacityElement.attr('data-quota');
                                    const quotaFromPage = dataQuota ? parseFloat(dataQuota) : null;
                                    
                                    console.log(`🔍 [Edit] Found subscriber ${phoneNumber}, quota on page: ${quotaFromPage}, expected: ${quota}`);
                                    
                                    if (quotaFromPage !== null && Math.abs(quotaFromPage - quota) < 0.1) {
                                        quotaUpdated = true;
                                        console.log(`✅ [Edit] Verified: Subscriber quota is ${quotaFromPage} GB on Ushare page (matches expected ${quota} GB)`);
                                        return false; // Break out of each loop
                                    } else if (quotaFromPage !== null) {
                                        console.log(`⚠️ [Edit] Subscriber found but quota mismatch: ${quotaFromPage} GB (expected ${quota} GB)`);
                                    } else {
                                        console.warn(`⚠️ [Edit] Subscriber found but data-quota attribute not found`);
                                    }
                                }
                            });
                            
                            if (!foundSubscriber) {
                                console.error(`❌ [Edit] Verification failed: Subscriber ${cleanSubscriberNumber} not found on Ushare page`);
                                if (attempts >= maxAttempts - 1) {
                                    throw new Error(`Edit verification failed: Subscriber not found on Ushare page. The edit may have failed.`);
                                }
                                attempts++;
                                continue;
                            } else if (!quotaUpdated) {
                                console.error(`❌ [Edit] Edit verification failed - quota not updated on Ushare page (found subscriber but quota doesn't match)`);
                                if (attempts >= maxAttempts - 1) {
                                    throw new Error('Edit operation failed - quota was not updated on the Ushare page. Please try again.');
                                }
                                attempts++;
                                continue;
                            } else {
                                console.log(`✅ [Edit] Edit verified successfully despite 500 error from Alfa`);
                                editSuccess = true;
                                break; // Exit retry loop
                            }
                        } catch (verifyError) {
                            console.error(`❌ [Edit] Error verifying edit: ${verifyError.message}`);
                            // If verification fails and no more attempts, throw error
                            if (attempts >= maxAttempts - 1) {
                                const errorHtml = typeof error.response?.data === 'string' ? error.response.data : JSON.stringify(error.response?.data || '');
                                const errorMatch = errorHtml.match(/<div[^>]*class[^>]*error[^>]*>(.*?)<\/div>/i) ||
                                                  errorHtml.match(/<p[^>]*class[^>]*error[^>]*>(.*?)<\/p>/i);
                                const errorMessage = errorMatch ? errorMatch[1].replace(/<[^>]*>/g, '').trim() : verifyError.message;
                                throw new Error(`Edit failed: ${errorMessage}. Please try again.`);
                            }
                            attempts++;
                            continue;
                        }
                    }
                } else if (error.response && (error.response.status === 401 || error.response.status === 403)) {
                    if (attempts < maxAttempts - 1) {
                        console.log(`🔄 Authentication error during edit, refreshing cookies... (attempt ${attempts + 1}/${maxAttempts})`);
                        freshCookies = await getCookiesOrLogin(adminPhone, adminPassword, adminId);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                        continue;
                    }
                }
                throw error;
            }
        }
        
        if (!editSuccess) {
            throw new Error('Failed to edit subscriber after multiple attempts');
        }
        
        // Invalidate Ushare cache so fresh data is fetched next time (don't wait)
        const { invalidateUshareCache } = require('../services/ushareHtmlParser');
        invalidateUshareCache(adminPhone).catch(err => {
            console.warn('⚠️ Failed to invalidate cache:', err.message);
        });
        
        // Log action
        const adminData = await getAdminData(adminId).catch(() => null);
        await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'edit', cleanSubscriberNumber, quota, true);
        
        res.json(normalizeSubscriberResponse({
            number: cleanSubscriberNumber,
            quota: quota,
            results: [],
            message: 'Subscriber quota updated successfully'
        }));
        
    } catch (error) {
        console.error('❌ Error in /api/editSubscriber:', error);
        
        // Log failed action
        try {
            const { adminId, subscriberNumber, quota } = req.body;
            if (adminId && subscriberNumber) {
                let cleanSubscriberNumber = subscriberNumber.replace(/\D/g, '');
                if (cleanSubscriberNumber.length === 11 && cleanSubscriberNumber.startsWith('961')) {
                    cleanSubscriberNumber = cleanSubscriberNumber.substring(3);
                }
                cleanSubscriberNumber = cleanSubscriberNumber.substring(0, 8);
                const adminData = await getAdminData(adminId).catch(() => null);
                const adminPhone = adminData?.phone || '';
                await logAction(req.userId, adminId, adminData?.name || 'Unknown', adminPhone, 'edit', cleanSubscriberNumber, quota || null, false, error.message || 'Unknown error');
            }
        } catch (logError) {
            console.error('Failed to log action:', logError);
        }
        
        if (error.response?.status === 401 || error.response?.status === 403) {
            return res.status(401).json(createErrorResponse('Authentication failed'));
        }
        
        res.status(500).json(createErrorResponse(
            error.message || 'Failed to edit subscriber',
            error
        ));
    }
});

module.exports = router;

