/**
 * Alfa API Routes
 * Direct API endpoints for Alfa services
 * All routes require JWT authentication
 */

const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middleware/auth');
const { getCookiesOrLogin } = require('../services/cookieManager');
const { apiRequest } = require('../services/apiClient');
const { getAdminData } = require('../services/firebaseDbService');

// Response normalizer utilities
function normalizeApiResponse(data, metadata = {}) {
    return {
        success: true,
        data: data,
        timestamp: Date.now(),
        ...metadata
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

const BASE_URL = 'https://www.alfa.com.lb';

/**
 * Helper: Get admin credentials and cookies
 */
async function getAdminCredentialsAndCookies(adminId, userId) {
    // Get admin data from Firebase
    const adminData = await getAdminData(adminId);
    
    if (!adminData) {
        throw new Error('Admin not found');
    }
    
    // Verify ownership
    if (adminData.userId !== userId) {
        throw new Error('Unauthorized: Admin does not belong to current user');
    }
    
    if (!adminData.phone || !adminData.password) {
        throw new Error('Admin credentials missing');
    }
    
    // Get cookies (will login if needed)
    const cookies = await getCookiesOrLogin(adminData.phone, adminData.password, adminId);
    
    return {
        phone: adminData.phone,
        password: adminData.password,
        cookies: cookies
    };
}

/**
 * GET /api/getconsumption
 * Get consumption data for an admin
 */
router.get('/getconsumption', authenticateJWT, async (req, res) => {
    try {
        const { adminId } = req.query;
        
        if (!adminId) {
            return res.status(400).json(createErrorResponse('adminId is required'));
        }
        
        const { cookies } = await getAdminCredentialsAndCookies(adminId, req.userId);
        
        const data = await apiRequest('/en/account/getconsumption', cookies, {
            timeout: 15000,
            maxRetries: 1
        });
        
        res.json(normalizeApiResponse(data, { adminId }));
    } catch (error) {
        console.error('❌ Error in /api/getconsumption:', error);
        res.status(500).json(createErrorResponse(error.message, error));
    }
});

/**
 * GET /api/getexpirydate
 * Get expiry date for an admin
 */
router.get('/getexpirydate', authenticateJWT, async (req, res) => {
    try {
        const { adminId } = req.query;
        
        if (!adminId) {
            return res.status(400).json(createErrorResponse('adminId is required'));
        }
        
        const { cookies } = await getAdminCredentialsAndCookies(adminId, req.userId);
        
        const data = await apiRequest('/en/account/getexpirydate', cookies, {
            timeout: 10000,
            maxRetries: 1
        });
        
        res.json(normalizeApiResponse(data, { adminId }));
    } catch (error) {
        console.error('❌ Error in /api/getexpirydate:', error);
        res.status(500).json(createErrorResponse(error.message, error));
    }
});

/**
 * GET /api/getmyservices
 * Get services data for an admin
 */
router.get('/getmyservices', authenticateJWT, async (req, res) => {
    try {
        const { adminId } = req.query;
        
        if (!adminId) {
            return res.status(400).json(createErrorResponse('adminId is required'));
        }
        
        const { cookies } = await getAdminCredentialsAndCookies(adminId, req.userId);
        
        const data = await apiRequest('/en/account/manage-services/getmyservices', cookies, {
            timeout: 15000,
            maxRetries: 1
        });
        
        res.json(normalizeApiResponse(data, { adminId }));
    } catch (error) {
        console.error('❌ Error in /api/getmyservices:', error);
        res.status(500).json(createErrorResponse(error.message, error));
    }
});

/**
 * GET /api/ushare
 * Get Ushare subscriber data for an admin
 * Fetches HTML via HTTP and parses server-side (no Puppeteer)
 * Returns normalized JSON: { "number": "03295772", "results": [...] }
 */
router.get('/ushare', authenticateJWT, async (req, res) => {
    try {
        const { adminId } = req.query;
        
        if (!adminId) {
            return res.status(400).json(createErrorResponse('adminId is required'));
        }
        
        const { phone, cookies } = await getAdminCredentialsAndCookies(adminId, req.userId);
        
        // Fetch and parse Ushare HTML (HTTP-only, no Puppeteer)
        const { fetchUshareHtml } = require('../services/ushareHtmlParser');
        const result = await fetchUshareHtml(phone, cookies, true); // useCache = true
        
        if (result.success && result.data) {
            // Normalize response format: { "number": adminPhone, "results": subscribers }
            const normalized = {
                number: phone,
                results: result.data.subscribers || [],
                summary: {
                    totalCount: result.data.totalCount || 0,
                    activeCount: result.data.activeCount || 0,
                    requestedCount: result.data.requestedCount || 0
                }
            };
            
            return res.json(normalizeApiResponse(normalized, { adminId, source: 'http' }));
        }
        
        // HTTP fetch failed
        res.status(500).json(createErrorResponse(
            result.error || 'Failed to fetch Ushare HTML',
            result.error
        ));
    } catch (error) {
        console.error('❌ Error in /api/ushare:', error);
        res.status(500).json(createErrorResponse(error.message, error));
    }
});

/**
 * GET /api/refreshAdmins
 * Composite route that calls all 4 APIs and aggregates responses
 */
router.get('/refreshAdmins', authenticateJWT, async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { adminId } = req.query;
        
        if (!adminId) {
            return res.status(400).json(createErrorResponse('adminId is required'));
        }
        
        const { phone, cookies } = await getAdminCredentialsAndCookies(adminId, req.userId);
        
        // OPTIMIZATION: Fetch previous admin data and Ushare HTML in parallel with API calls to reduce total time
        // This data is needed for subscriber removal detection, but we can fetch it while APIs are running
        const { getFullAdminData } = require('../services/firebaseDbService');
        const { fetchUshareHtml } = require('../services/ushareHtmlParser');
        
        const previousAdminDataPromise = getFullAdminData(adminId).catch(error => {
            console.warn(`   ⚠️ [DETECTION] Error fetching previous admin data in parallel: ${error.message}`);
            return null;
        });
        
        // OPTIMIZATION: Fetch Ushare HTML in parallel with APIs (not sequentially after APIs complete)
        // IMPORTANT: Use useCache=false for refresh to ensure we get the latest data
        // (cache is invalidated after add/edit/remove operations, but we want fresh data on refresh)
        const usharePromise = fetchUshareHtml(phone, cookies, false)
            .then(result => ({ success: result.success, data: result.data, error: result.error ? result.error : null }))
            .catch(error => ({ success: false, data: null, error: error.message || 'Unknown error' }));
        
        // Fetch all APIs, previous admin data, and Ushare HTML in parallel
        // Increased timeouts to match Alfa's actual response times (they're very slow)
        const [consumptionResult, expiryResult, servicesResult, previousAdminData, ushareResultSettled] = await Promise.allSettled([
            apiRequest('/en/account/getconsumption', cookies, { timeout: 15000, maxRetries: 1 })
                .then(data => ({ success: true, data, error: null }))
                .catch(error => ({ success: false, data: null, error })),
            
            apiRequest('/en/account/getexpirydate', cookies, { timeout: 10000, maxRetries: 1 })
                .then(data => ({ success: true, data, error: null }))
                .catch(error => ({ success: false, data: null, error })),
            
            apiRequest('/en/account/manage-services/getmyservices', cookies, { timeout: 15000, maxRetries: 1 })
                .then(data => ({ success: true, data, error: null }))
                .catch(error => ({ success: false, data: null, error })),
            
            previousAdminDataPromise,
            
            usharePromise
        ]);
        
        // Extract previous admin data from Promise.allSettled result
        const previousAdminDataResolved = previousAdminData.status === 'fulfilled' ? previousAdminData.value : null;
        
        // Extract Ushare result from Promise.allSettled result
        const ushareResult = ushareResultSettled.status === 'fulfilled' ? ushareResultSettled.value : {
            success: false,
            data: null,
            error: ushareResultSettled.reason?.message || 'Unknown error'
        };
        
        if (ushareResult.success && ushareResult.data) {
            console.log(`✅ [Refresh] Ushare data fetched: ${ushareResult.data.totalCount || 0} total, ${ushareResult.data.activeCount || 0} active, ${ushareResult.data.requestedCount || 0} requested`);
        } else {
            console.warn(`⚠️ [Refresh] Ushare data fetch failed: ${ushareResult.error || 'Unknown error'}`);
        }
        
        // Process raw API responses into frontend-expected format
        const { extractFromGetConsumption, extractFromGetMyServices, extractExpiration } = require('../services/alfaApiDataExtraction');
        const processedData = {};
        
        // Process consumption data
        if (consumptionResult.status === 'fulfilled' && consumptionResult.value.success && consumptionResult.value.data) {
            const extracted = extractFromGetConsumption(consumptionResult.value.data);
            Object.assign(processedData, extracted);
        }
        
        // Process services data
        if (servicesResult.status === 'fulfilled' && servicesResult.value.success && servicesResult.value.data) {
            const extracted = extractFromGetMyServices(servicesResult.value.data);
            Object.assign(processedData, extracted);
        }
        
        // Process expiry data
        // getexpirydate returns a number directly (e.g., 30 for 30 days, or 0 if expired), not an object
        if (expiryResult.status === 'fulfilled' && expiryResult.value.success && expiryResult.value.data !== undefined && expiryResult.value.data !== null) {
            const rawExpiry = expiryResult.value.data;
            // Convert to number if it's a string
            let expiryNumber = typeof rawExpiry === 'number' ? rawExpiry : parseInt(rawExpiry);
            
            // Check if it's a valid number (including 0, which means expired)
            if (!isNaN(expiryNumber)) {
                // 0 is a valid value (means expired), negative values are invalid
                if (expiryNumber >= 0) {
                    processedData.expiration = expiryNumber;
                    console.log(`✅ Processed expiration: ${expiryNumber} days`);
                } else {
                    console.warn(`⚠️ getexpirydate returned negative value: ${expiryNumber}`);
                    processedData.expiration = null;
                }
            } else {
                console.warn(`⚠️ getexpirydate returned invalid (NaN) data: ${rawExpiry}`);
                processedData.expiration = null;
            }
        } else {
            console.warn(`⚠️ getexpirydate API call failed or returned no data`);
        }
        
        // Process ushare data (add subscribers info)
        if (ushareResult.success && ushareResult.data) {
            processedData.ushare = ushareResult.data;
            if (ushareResult.data.subscribers) {
                processedData.secondarySubscribers = ushareResult.data.subscribers;
            }
            // CRITICAL: Always set subscriber counts from Ushare data (even if 0)
            // This ensures the frontend gets the latest counts after add/edit/remove operations
            if (ushareResult.data.totalCount !== undefined && ushareResult.data.totalCount !== null) {
                processedData.subscribersCount = ushareResult.data.totalCount;
                console.log(`✅ [Refresh] Set subscribersCount: ${processedData.subscribersCount}`);
            } else {
                console.warn(`⚠️ [Refresh] totalCount is undefined/null, not setting subscribersCount`);
            }
            if (ushareResult.data.activeCount !== undefined && ushareResult.data.activeCount !== null) {
                processedData.subscribersActiveCount = ushareResult.data.activeCount;
                console.log(`✅ [Refresh] Set subscribersActiveCount: ${processedData.subscribersActiveCount}`);
            }
            if (ushareResult.data.requestedCount !== undefined && ushareResult.data.requestedCount !== null) {
                processedData.subscribersRequestedCount = ushareResult.data.requestedCount;
                console.log(`✅ [Refresh] Set subscribersRequestedCount: ${processedData.subscribersRequestedCount}`);
            }
        } else {
            console.warn(`⚠️ [Refresh] Ushare data not available, subscriber counts will not be updated`);
        }
        
        // Add raw API responses for backward compatibility
        processedData.consumption = consumptionResult.status === 'fulfilled' ? consumptionResult.value.data : null;
        processedData.expiry = expiryResult.status === 'fulfilled' ? expiryResult.value.data : null;
        processedData.services = servicesResult.status === 'fulfilled' ? servicesResult.value.data : null;
        
        // CRITICAL: Build apiResponses array for bundle renewal detection
        // Format: [{ url: '/en/account/getconsumption', data: {...}, success: true/false }]
        const apiResponses = [];
        if (consumptionResult.status === 'fulfilled' && consumptionResult.value.success && consumptionResult.value.data) {
            apiResponses.push({
                url: '/en/account/getconsumption',
                data: consumptionResult.value.data,
                success: true
            });
        }
        if (expiryResult.status === 'fulfilled' && expiryResult.value.success && expiryResult.value.data !== undefined && expiryResult.value.data !== null) {
            apiResponses.push({
                url: '/en/account/getexpirydate',
                data: expiryResult.value.data,
                success: true
            });
        }
        if (servicesResult.status === 'fulfilled' && servicesResult.value.success && servicesResult.value.data) {
            apiResponses.push({
                url: '/en/account/manage-services/getmyservices',
                data: servicesResult.value.data,
                success: true
            });
        }
        
        // Aggregate results (processed data at root level for frontend compatibility)
        const aggregated = {
            ...processedData, // Processed data at root level
            adminId: adminId,
            timestamp: Date.now(),
            duration: Date.now() - startTime,
            // CRITICAL: Include apiResponses array for bundle renewal detection in updateDashboardData
            apiResponses: apiResponses,
            // Also include raw API responses for debugging
            apis: {
                consumption: {
                    success: consumptionResult.status === 'fulfilled' && consumptionResult.value.success,
                    data: consumptionResult.status === 'fulfilled' ? consumptionResult.value.data : null,
                    error: consumptionResult.status === 'fulfilled' ? consumptionResult.value.error : consumptionResult.reason
                },
                expiry: {
                    success: expiryResult.status === 'fulfilled' && expiryResult.value.success,
                    data: expiryResult.status === 'fulfilled' ? expiryResult.value.data : null,
                    error: expiryResult.status === 'fulfilled' ? expiryResult.value.error : expiryResult.reason
                },
                services: {
                    success: servicesResult.status === 'fulfilled' && servicesResult.value.success,
                    data: servicesResult.status === 'fulfilled' ? servicesResult.value.data : null,
                    error: servicesResult.status === 'fulfilled' ? servicesResult.value.error : servicesResult.reason
                },
                ushare: {
                    success: ushareResult.success,
                    data: ushareResult.data || null,
                    error: ushareResult.error || null,
                    source: 'http' // HTTP-only, no Puppeteer
                }
            },
            summary: {
                successful: [
                    consumptionResult.status === 'fulfilled' && consumptionResult.value.success ? 'consumption' : null,
                    expiryResult.status === 'fulfilled' && expiryResult.value.success ? 'expiry' : null,
                    servicesResult.status === 'fulfilled' && servicesResult.value.success ? 'services' : null,
                    ushareResult.success ? 'ushare' : null
                ].filter(Boolean),
                failed: [
                    consumptionResult.status !== 'fulfilled' || !consumptionResult.value.success ? 'consumption' : null,
                    expiryResult.status !== 'fulfilled' || !expiryResult.value.success ? 'expiry' : null,
                    servicesResult.status !== 'fulfilled' || !servicesResult.value.success ? 'services' : null,
                    !ushareResult.success ? 'ushare' : null
                ].filter(Boolean)
            }
        };
        
        // Determine overall success (at least one API succeeded)
        const overallSuccess = aggregated.summary.successful.length > 0;
        
        // CRITICAL: DETECT SUBSCRIBERS REMOVED DIRECTLY FROM ALFA WEBSITE
        // Compare current subscribers with previous ones to find missing Active subscribers
        if (overallSuccess && aggregated.primaryData && ushareResult.success) {
            console.log(`   🔍 [DETECTION] Starting subscriber removal detection in /api/refreshAdmins...`);
            console.log(`   🔍 [DETECTION] Using previously fetched admin data from Firebase (fetched in parallel with APIs)...`);
            
            // Use the admin data that was fetched in parallel with API calls
            const previousAdminData = previousAdminDataResolved;
            
            if (!previousAdminData) {
                console.log(`   ⚠️ [DETECTION] getFullAdminData returned null - cannot detect removed subscribers`);
                console.log(`   ⚠️ [DETECTION] This may happen if admin data doesn't exist yet in Firebase`);
            } else {
                console.log(`   ✅ [DETECTION] getFullAdminData returned data for admin ${adminId}`);
            }
            
            // Get previous subscribers from Firebase
            const previousSecondarySubscribers = previousAdminData?.alfaData?.secondarySubscribers || [];
            let existingRemovedActiveSubscribers = previousAdminData?.removedActiveSubscribers || [];
            
            // CRITICAL: Clean concatenated phone numbers from existing data
            // Handle cases like "7659002696170313250" which contains "76590026" + "961" + "70313250"
            // We need to extract BOTH phone numbers from concatenated strings and remove "961" prefix
            const cleanedExistingRemoved = [];
            const seenPhoneNumbers = new Set();
            
            existingRemovedActiveSubscribers.forEach(sub => {
                let phoneNumber = sub.phoneNumber || '';
                
                // Check if this is a concatenated phone number (longer than 11 digits)
                // Pattern: "7659002696170313250" = "76590026" + "961" + "70313250"
                if (phoneNumber.length > 11) {
                    // Extract all phone numbers from the concatenated string
                    // Strategy: Split by "961" and extract valid phone numbers from each part
                    let remaining = phoneNumber;
                    const extractedNumbers = [];
                    
                    // Keep extracting 8-11 digit phone numbers, skipping "961" separators
                    while (remaining.length >= 8) {
                        // Try to match: 8-11 digits at the start
                        const match = remaining.match(/^(\d{8,11})/);
                        if (match) {
                            const extracted = match[1];
                            extractedNumbers.push(extracted);
                            remaining = remaining.substring(extracted.length);
                            
                            // If next part starts with "961", skip it (Lebanon country code separator)
                            if (remaining.startsWith('961')) {
                                remaining = remaining.substring(3);
                            }
                        } else {
                            break; // Can't extract more
                        }
                    }
                    
                    // Add all extracted numbers as separate subscribers (avoid duplicates)
                    if (extractedNumbers.length > 0) {
                        console.log(`   🔧 [DETECTION] Split concatenated phone number "${sub.phoneNumber}" into: ${extractedNumbers.join(', ')}`);
                        extractedNumbers.forEach(extractedNum => {
                            if (!seenPhoneNumbers.has(extractedNum)) {
                                seenPhoneNumbers.add(extractedNum);
                                cleanedExistingRemoved.push({ ...sub, phoneNumber: extractedNum });
                            }
                        });
                    } else {
                        // Fallback: couldn't extract, use original (trimmed)
                        const trimmed = phoneNumber.replace(/^961/, '').substring(0, 11);
                        if (!seenPhoneNumbers.has(trimmed)) {
                            seenPhoneNumbers.add(trimmed);
                            cleanedExistingRemoved.push({ ...sub, phoneNumber: trimmed });
                        }
                    }
                } else {
                    // Normal phone number (not concatenated)
                    // Remove "961" Lebanon country code prefix if present
                    phoneNumber = phoneNumber.replace(/^961/, '');
                    if (!seenPhoneNumbers.has(phoneNumber)) {
                        seenPhoneNumbers.add(phoneNumber);
                        cleanedExistingRemoved.push({ ...sub, phoneNumber });
                    }
                }
            });
            
            existingRemovedActiveSubscribers = cleanedExistingRemoved;
            const existingRemovedPhoneNumbers = new Set(existingRemovedActiveSubscribers.map(sub => sub.phoneNumber));
            
            // Get current subscribers from ushare data
            const currentSubscribers = ushareResult.data?.subscribers || [];
            const currentPhoneNumbers = new Set(currentSubscribers.map(sub => sub.phoneNumber));
            
            console.log(`   🔍 [DETECTION] Previous subscribers count: ${previousSecondarySubscribers.length}, Current subscribers count: ${currentSubscribers.length}`);
            if (previousSecondarySubscribers.length > 0) {
                console.log(`      Previous subscriber phones: ${previousSecondarySubscribers.map(s => s.phoneNumber).join(', ')}`);
            }
            if (currentSubscribers.length > 0) {
                console.log(`      Current subscriber phones: ${currentSubscribers.map(s => s.phoneNumber).join(', ')}`);
            }
            console.log(`      Existing removed subscribers in Firebase: ${existingRemovedActiveSubscribers.length}`);
            
            // Detect newly removed Active subscribers
            const newlyRemovedActiveSubscribers = [];
            
            if (previousSecondarySubscribers.length > 0) {
                console.log(`   🔍 [DETECTION] Comparing ${previousSecondarySubscribers.length} previous subscribers with ${currentSubscribers.length} current subscribers...`);
                previousSecondarySubscribers.forEach(prevSub => {
                    // Only check Active subscribers (Requested subscribers disappear naturally)
                    if (prevSub.status === 'Active') {
                        if (!currentPhoneNumbers.has(prevSub.phoneNumber)) {
                            // This Active subscriber was in the previous list but is now missing
                            // Check if it's not already in removedActiveSubscribers (avoid duplicates)
                            if (!existingRemovedPhoneNumbers.has(prevSub.phoneNumber)) {
                                // It was removed directly from Alfa website
                                console.log(`   🔍 [DETECTION] Found removed Active subscriber: ${prevSub.phoneNumber} (was Active, now missing)`);
                                console.log(`      [Detection] Subscriber ${prevSub.phoneNumber} marked as Out for admin ${adminId}`);
                                
                                // Handle both field name formats: usedConsumption/totalQuota (Ushare HTML) or consumption/quota (API)
                                const consumptionValue = prevSub.consumption !== undefined ? prevSub.consumption : 
                                                        (prevSub.usedConsumption !== undefined ? prevSub.usedConsumption : 0);
                                const limitValue = prevSub.quota !== undefined ? prevSub.quota :
                                                  (prevSub.limit !== undefined ? prevSub.limit :
                                                  (prevSub.totalQuota !== undefined ? prevSub.totalQuota : 0));
                                
                                newlyRemovedActiveSubscribers.push({
                                    phoneNumber: prevSub.phoneNumber,
                                    fullPhoneNumber: prevSub.fullPhoneNumber || prevSub.phoneNumber,
                                    consumption: typeof consumptionValue === 'number' ? consumptionValue : parseFloat(consumptionValue) || 0,
                                    limit: typeof limitValue === 'number' ? limitValue : parseFloat(limitValue) || 0,
                                    status: 'Active' // Always Active since we only store Active removed subscribers
                                });
                            } else {
                                console.log(`   ℹ️ [DETECTION] Subscriber ${prevSub.phoneNumber} already in removedActiveSubscribers, skipping (duplicate prevention)`);
                            }
                        } else {
                            console.log(`   ✅ [DETECTION] Subscriber ${prevSub.phoneNumber} still exists in current list`);
                        }
                    } else {
                        console.log(`   ℹ️ [DETECTION] Subscriber ${prevSub.phoneNumber} has status "${prevSub.status}" (not Active), skipping`);
                    }
                });
            } else {
                console.log(`   ⚠️ [DETECTION] No previous subscribers found - cannot detect removals`);
                console.log(`   ⚠️ [DETECTION] This may indicate first refresh or data not yet saved to Firebase`);
            }
            
            // ALWAYS set detectedRemovedActiveSubscribers (either merged or existing) to preserve data
            if (newlyRemovedActiveSubscribers.length > 0) {
                console.log(`   🔍 [DETECTION] Detected ${newlyRemovedActiveSubscribers.length} NEW Active subscriber(s) removed directly from Alfa website:`);
                for (const removedSub of newlyRemovedActiveSubscribers) {
                    console.log(`      ➖ ${removedSub.phoneNumber} (was Active, now missing from HTML)`);
                    console.log(`      [Detection] Subscriber ${removedSub.phoneNumber} marked as Out`);
                }
                // Merge with existing removedActiveSubscribers and store in aggregated for updateDashboardData
                aggregated.detectedRemovedActiveSubscribers = [...existingRemovedActiveSubscribers, ...newlyRemovedActiveSubscribers];
                console.log(`   ✅ [DETECTION] Stored ${aggregated.detectedRemovedActiveSubscribers.length} total removed active subscriber(s) (${existingRemovedActiveSubscribers.length} existing + ${newlyRemovedActiveSubscribers.length} newly detected) in aggregated`);
            } else {
                console.log(`   ℹ️ [DETECTION] No NEW removed subscribers detected`);
                // CRITICAL: Always preserve existing removed subscribers (even if empty array)
                aggregated.detectedRemovedActiveSubscribers = existingRemovedActiveSubscribers;
                if (existingRemovedActiveSubscribers.length > 0) {
                    console.log(`   ✅ [DETECTION] Preserved ${existingRemovedActiveSubscribers.length} existing removed active subscriber(s) in aggregated`);
                } else {
                    console.log(`   ℹ️ [DETECTION] No existing removed subscribers to preserve (setting empty array)`);
                }
            }
            
            console.log(`   ✅ [DETECTION] Detection complete. detectedRemovedActiveSubscribers set: ${!!aggregated.detectedRemovedActiveSubscribers}, length: ${aggregated.detectedRemovedActiveSubscribers?.length || 0}`);
            if (aggregated.detectedRemovedActiveSubscribers && aggregated.detectedRemovedActiveSubscribers.length > 0) {
                console.log(`   📋 [DETECTION] Removed subscribers list: ${aggregated.detectedRemovedActiveSubscribers.map(s => s.phoneNumber).join(', ')}`);
            }
            console.log(``);
        }
        
        // Send response IMMEDIATELY to avoid blocking the refresh
        res.json({
            success: overallSuccess,
            data: aggregated,
            message: overallSuccess 
                ? `Refresh completed: ${aggregated.summary.successful.length}/4 APIs successful`
                : 'All API calls failed'
        });
        
        // AFTER response is sent, save to Firebase and check notifications (non-blocking)
        // Use setImmediate to ensure this runs after the response is fully sent
        if (overallSuccess && aggregated.primaryData) {
            const { updateDashboardData } = require('../services/firebaseDbService');
            const { checkForNotifications, sendPushNotifications } = require('./pushRoutes');
            
            // Use setImmediate to ensure this runs AFTER the response is sent
            setImmediate(() => {
                (async () => {
                    try {
                        // Save to Firebase first
                        await updateDashboardData(adminId, aggregated);
                        console.log(`✅ [Refresh] Data saved to Firebase for admin ${adminId}`);
                        
                        // Then check and send push notifications after data is saved
                        try {
                            // Get userId from admin document
                            const admin = require('firebase-admin');
                            const adminDbInstance = admin.firestore();
                            const adminDoc = await adminDbInstance.collection('admins').doc(adminId).get();
                            
                            if (adminDoc.exists) {
                                const adminData = adminDoc.data();
                                const userId = adminData.userId;
                                
                                if (userId) {
                                    // Only check the admin that was refreshed
                                    const notifications = await checkForNotifications(userId, adminId);
                                    if (notifications.length > 0) {
                                        await sendPushNotifications(userId, notifications);
                                        console.log(`📢 [Refresh] Sent ${notifications.length} notification(s) to user ${userId} for admin ${adminId}`);
                                    } else {
                                        console.log(`ℹ️ [Refresh] No notifications needed for admin ${adminId}`);
                                    }
                                }
                            }
                        } catch (notifError) {
                            console.warn(`⚠️ [Refresh] Notification check failed (non-critical):`, notifError?.message);
                        }
                    } catch (firebaseError) {
                        console.warn(`⚠️ [Refresh] Firebase save failed (non-critical):`, firebaseError?.message);
                    }
                })();
            });
        } else if (overallSuccess && !aggregated.primaryData) {
            console.warn(`⚠️ [Refresh] Skipping Firebase save - primaryData missing (would mark admin inactive)`);
        }
        
    } catch (error) {
        console.error('❌ Error in /api/refreshAdmins:', error);
        res.status(500).json(createErrorResponse(error.message, error));
    }
});

module.exports = router;

