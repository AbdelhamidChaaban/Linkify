const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE_URL = 'https://www.alfa.com.lb';
const DEFAULT_TIMEOUT = 3000;
const MAX_RETRIES = 2;
const RETRY_DELAYS = [300, 900]; // Exponential backoff: 300ms, 900ms

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
 * @param {Array} cookies - Array of cookie objects from Puppeteer
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
            if (attempt <= maxRetries) {
                const delay = RETRY_DELAYS[attempt - 1] || 900;
                console.warn(`⚠️ API ${endpoint} failed (attempt ${attempt}/${maxRetries + 1}): ${error.message}, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error(`❌ API ${endpoint} failed after ${maxRetries + 1} attempts: ${error.message}`);
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
 * @returns {Promise<Object>} Object with expiry, services, and consumption data
 */
async function fetchAllApis(cookies) {
    const endpoints = [
        { key: 'expiry', path: '/en/account/getexpirydate', timeout: 3000 },
        { key: 'services', path: '/en/account/manage-services/getmyservices', timeout: 8000 }, // Longer timeout for getmyservices
        { key: 'consumption', path: '/en/account/getconsumption', timeout: 3000 }
    ];

    console.log('🚀 Fetching all APIs in parallel...');
    const startTime = Date.now();

    try {
        const results = await Promise.all(
            endpoints.map(endpoint => 
                apiRequest(endpoint.path, cookies, { timeout: endpoint.timeout })
                    .then(data => ({ key: endpoint.key, data, success: true }))
                    .catch(error => ({ key: endpoint.key, error, success: false }))
            )
        );

        const duration = Date.now() - startTime;
        console.log(`✅ All API calls completed in ${duration}ms`);

        const response = {};
        const errors = [];
        let allUnauthorized = true;

        results.forEach(result => {
            if (result.success) {
                response[result.key] = result.data;
                allUnauthorized = false; // At least one succeeded
            } else {
                response[result.key] = null;
                errors.push({ endpoint: result.key, error: result.error });
                // Check if this error is NOT unauthorized
                if (result.error.type !== 'Unauthorized') {
                    allUnauthorized = false;
                }
            }
        });

        if (errors.length > 0) {
            console.warn(`⚠️ ${errors.length} API call(s) failed:`, errors.map(e => e.endpoint).join(', '));
            
            // If all errors are Unauthorized (401), throw Unauthorized error
            if (allUnauthorized && errors.length === results.length) {
                throw new ApiError(
                    'All API calls returned 401 Unauthorized - cookies expired',
                    'Unauthorized',
                    401
                );
            }
        }

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

