const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE_URL = 'https://www.alfa.com.lb';
const DEFAULT_TIMEOUT = 3000;
const MAX_RETRIES = 2; // Retry up to 2 times (maxRetries=2 means 3 total attempts)
const RETRY_DELAYS = [300, 600, 1200]; // Exponential backoff: 300ms → 600ms → 1200ms
const TIMEOUT_RETRY_DELAY = 150; // Shorter delay for timeout retries (150ms)

// Connection pooling: Reuse HTTP agents for better performance
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 60000
});

// Track API performance for dynamic timeout adjustment
const apiPerformance = new Map(); // endpoint -> { successCount, totalCount, avgDuration }

/**
 * Custom error types for API client
 */
class ApiError extends Error {
    constructor(message, type, statusCode, originalError) {
        super(message);
        this.name = 'ApiError';
        this.type = type; // 'Unauthorized', 'Timeout', 'Network', 'Server'
        this.statusCode = statusCode;
        this.originalError = originalError;
    }
}

/**
 * Convert cookie array to cookie header string
 * Ensures __ACCOUNT cookie is always included (long-lived authentication cookie)
 * @param {Array} cookies - Array of cookie objects from Puppeteer
 * @returns {string} Cookie header string
 */
function formatCookiesForHeader(cookies) {
    if (!cookies || !Array.isArray(cookies)) {
        return '';
    }
    
    // Ensure __ACCOUNT cookie is included (critical for authentication)
    // Include all cookies, but prioritize __ACCOUNT if present
    const accountCookie = cookies.find(c => c.name === '__ACCOUNT');
    const otherCookies = cookies.filter(c => c.name !== '__ACCOUNT');
    
    // Build cookie string: __ACCOUNT first (if present), then others
    const cookieStrings = [];
    if (accountCookie) {
        cookieStrings.push(`${accountCookie.name}=${accountCookie.value}`);
    }
    otherCookies.forEach(cookie => {
        const name = cookie.name || '';
        const value = cookie.value || '';
        if (name && value) {
            cookieStrings.push(`${name}=${value}`);
        }
    });
    
    return cookieStrings.join('; ');
}

/**
 * Make HTTP request with cookies, timeout, and retry logic
 * @param {string} endpoint - API endpoint (e.g., '/en/account/getexpirydate')
 * @param {Array} cookies - Array of cookie objects
 * @param {Object} options - Request options
 * @returns {Promise<Object>} Parsed JSON response
 */
async function apiRequest(endpoint, cookies = [], options = {}) {
    const {
        timeout = DEFAULT_TIMEOUT,
        maxRetries = MAX_RETRIES,
        method = 'GET'
    } = options;

    const url = new URL(endpoint, BASE_URL);
    const cookieHeader = formatCookiesForHeader(cookies);
    
    const requestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + (url.search || ''),
        method: method,
        headers: {
            'Accept': 'application/json', // Use application/json as specified
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Cookie': cookieHeader,
            'Referer': 'https://www.alfa.com.lb/en/account',
            'Origin': 'https://www.alfa.com.lb',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    };

    let lastError;
    let attempt = 0;

    while (attempt <= maxRetries) {
        try {
            const startTime = Date.now();
            const response = await makeRequest(requestOptions, timeout);
            const duration = Date.now() - startTime;

            // Track API performance for dynamic timeout adjustment
            if (!apiPerformance.has(endpoint)) {
                apiPerformance.set(endpoint, { successCount: 0, totalCount: 0, avgDuration: 0 });
            }
            const perf = apiPerformance.get(endpoint);
            perf.successCount++;
            perf.totalCount++;
            perf.avgDuration = (perf.avgDuration * (perf.totalCount - 1) + duration) / perf.totalCount;

            // Log successful request
            if (attempt > 0) {
                console.log(`✅ API ${endpoint} succeeded on retry ${attempt} (${duration}ms)`);
            } else {
                console.log(`✅ API ${endpoint} succeeded (${duration}ms)`);
            }

            return response;
        } catch (error) {
            lastError = error;
            attempt++;

            // Don't retry on 401 (Unauthorized) - cookies are invalid
            if (error.type === 'Unauthorized') {
                console.error(`❌ API ${endpoint} returned 401 Unauthorized - cookies expired`);
                throw error;
            }

            // Don't retry on 4xx errors (except 401)
            if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
                console.error(`❌ API ${endpoint} returned ${error.statusCode} - not retrying`);
                throw error;
            }

            // Retry on timeout, network errors, or 5xx errors
            // Use shorter delay for timeout retries (150ms), exponential backoff for others
            if (attempt <= maxRetries) {
                const isTimeout = error.type === 'Timeout';
                const delay = isTimeout ? TIMEOUT_RETRY_DELAY : (RETRY_DELAYS[attempt - 1] || 1200);
                const errorType = error.type || 'Unknown';
                console.warn(`⚠️ API ${endpoint} failed (attempt ${attempt}/${maxRetries + 1}, type: ${errorType}): ${error.message}, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                const errorType = error.type || 'Unknown';
                console.error(`❌ API ${endpoint} failed after ${maxRetries + 1} attempts (type: ${errorType}): ${error.message}`);
                throw error;
            }
        }
    }

    throw lastError;
}

/**
 * Make a single HTTP request
 * @param {Object} options - Request options
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<Object>} Parsed JSON response
 */
function makeRequest(options, timeout) {
    return new Promise((resolve, reject) => {
        const protocol = options.port === 443 || !options.port ? https : http;
        
        // Use connection pooling for HTTPS requests
        if (protocol === https) {
            options.agent = httpsAgent;
        }
        
        const req = protocol.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                // Check for redirect to login (401 or redirect)
                if (res.statusCode === 401 || 
                    res.statusCode === 302 || 
                    res.statusCode === 301 ||
                    (res.statusCode === 200 && data.includes('/login'))) {
                    reject(new ApiError(
                        `Unauthorized - cookies expired (${res.statusCode})`,
                        'Unauthorized',
                        res.statusCode
                    ));
                    return;
                }

                // Check for 404 - might indicate wrong endpoint or missing cookies
                if (res.statusCode === 404) {
                    reject(new ApiError(
                        `Endpoint not found (${res.statusCode}) - check URL and cookies`,
                        'Network',
                        res.statusCode
                    ));
                    return;
                }

                // Check for server errors
                if (res.statusCode >= 500) {
                    reject(new ApiError(
                        `Server error: ${res.statusCode}`,
                        'Server',
                        res.statusCode
                    ));
                    return;
                }

                // Parse JSON response
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch (parseError) {
                    reject(new ApiError(
                        `Failed to parse JSON response: ${parseError.message}`,
                        'Network',
                        res.statusCode,
                        parseError
                    ));
                }
            });
        });

        req.on('error', (error) => {
            reject(new ApiError(
                `Network error: ${error.message}`,
                'Network',
                null,
                error
            ));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new ApiError(
                `Request timeout after ${timeout}ms`,
                'Timeout',
                null
            ));

        });

        req.setTimeout(timeout);
        req.end();
    });
}

/**
 * Fetch all three API endpoints in parallel
 * @param {Array} cookies - Array of cookie objects
 * @param {Object} options - Options for API calls
 * @param {number} options.maxRetries - Maximum retries (default: 2, use 0-1 for manual refresh)
 * @returns {Promise<Object>} Object with expiry, services, and consumption data
 */
async function fetchAllApis(cookies, options = {}) {
    const { maxRetries = 3 } = options;
    // Optimized timeouts per endpoint with dynamic adjustment capability
    // Increased timeouts to avoid false failures that force login
    const endpoints = [
        { key: 'expiry', path: '/en/account/getexpirydate', timeout: 6000 }, // 6s
        { key: 'services', path: '/en/account/manage-services/getmyservices', timeout: 20000 }, // 20s (increased to avoid false failures)
        { key: 'consumption', path: '/en/account/getconsumption', timeout: 15000 } // 15s (increased to avoid false failures)
    ];
    
    // Apply dynamic timeout adjustment based on historical performance
    endpoints.forEach(endpoint => {
        const perf = apiPerformance.get(endpoint.path);
        if (perf && perf.totalCount >= 5) {
            // If average duration is consistently high, increase timeout by 20%
            const adjustedTimeout = Math.ceil(perf.avgDuration * 1.2);
            if (adjustedTimeout > endpoint.timeout) {
                endpoint.timeout = Math.min(adjustedTimeout, endpoint.timeout * 1.5); // Cap at 50% increase
            }
        }
    });

    console.log(`🚀 Fetching all APIs in parallel... (maxRetries: ${maxRetries})`);
    const startTime = Date.now();

    try {
        // Use Promise.allSettled to fetch all APIs in parallel and handle failures gracefully
        const results = await Promise.allSettled(
            endpoints.map(endpoint => 
                apiRequest(endpoint.path, cookies, { timeout: endpoint.timeout, maxRetries })
                    .then(data => ({ key: endpoint.key, data, success: true }))
                    .catch(error => ({ key: endpoint.key, error, success: false }))
            )
        );

        const duration = Date.now() - startTime;
        console.log(`✅ All API calls completed in ${duration}ms`);

        const response = {};
        const errors = [];
        let allUnauthorized = true;
        const apiSuccess = {}; // Track which APIs succeeded for status classification
        const apiErrors = {}; // Track error types for each API (to detect 401 on specific endpoints)

        results.forEach((result, index) => {
            const endpoint = endpoints[index];
            
            if (result.status === 'fulfilled' && result.value.success) {
                response[endpoint.key] = result.value.data;
                apiSuccess[endpoint.key] = true;
                apiErrors[endpoint.key] = null; // No error
                allUnauthorized = false; // At least one succeeded
            } else {
                response[endpoint.key] = null;
                apiSuccess[endpoint.key] = false;
                
                const error = result.status === 'fulfilled' ? result.value.error : result.reason;
                errors.push({ endpoint: endpoint.key, error });
                
                // Track error type for this endpoint (to detect 401 on getconsumption)
                apiErrors[endpoint.key] = error ? error.type : 'Unknown';
                
                // Check if this error is NOT unauthorized
                if (error && error.type !== 'Unauthorized' && error.type !== 'Redirect') {
                    allUnauthorized = false;
                }
            }
        });

        if (errors.length > 0) {
            const errorTypes = errors.map(e => `${e.endpoint}(${e.error?.type || 'Unknown'})`).join(', ');
            console.warn(`⚠️ ${errors.length} API call(s) failed: ${errorTypes}`);
            
            // Fail-fast on 401/302: If all errors are Unauthorized or Redirect, throw immediately
            if (allUnauthorized && errors.length === results.length) {
                const firstError = errors[0].error;
                throw new ApiError(
                    `All API calls returned ${firstError.type} - cookies expired`,
                    firstError.type === 'Redirect' ? 'Redirect' : 'Unauthorized',
                    firstError.statusCode || 401
                );
            }
        }

        // Attach API success tracking for status classification
        response._apiSuccess = apiSuccess;
        response._apiErrors = apiErrors; // Track error types (to detect 401 on specific endpoints)
        return response;
    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ Failed to fetch APIs after ${duration}ms:`, error.message);
        throw error;
    }
}

module.exports = {
    apiRequest,
    fetchAllApis,
    ApiError,
    formatCookiesForHeader
};


