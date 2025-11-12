/**
 * Set up network listeners to capture API responses
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<Array>} Array to store API responses
 */
async function setupApiCapture(page) {
    const apiResponses = [];

    // Listen for requests (only log essential API requests to reduce noise)
    page.on('request', (request) => {
        const url = request.url();
        const resourceType = request.resourceType();
        
        // Only log essential API endpoints
        if ((resourceType === 'xhr' || resourceType === 'fetch') && 
            (url.includes('getconsumption') || 
             url.includes('getmyservices') || 
             url.includes('getexpirydate') || 
             url.includes('getlastrecharge'))) {
            console.log(`📡 Request: ${request.method()} ${url}`);
        }
    });

    // Listen for responses
    page.on('response', async (response) => {
        const url = response.url();
        const status = response.status();
        const resourceType = response.request().resourceType();
        
        if (((resourceType === 'xhr' || resourceType === 'fetch') || 
             url.includes('alfa.com.lb') || url.includes('api') || 
             url.includes('ajax') || url.includes('json') || url.includes('data')) && 
            status === 200) {
            try {
                const contentType = response.headers()['content-type'] || '';
                if (contentType.includes('json') || url.includes('.json')) {
                    const responseData = await response.json();
                    apiResponses.push({
                        url: url,
                        status: status,
                        data: responseData
                    });
                    
                    // Only log essential endpoints (reduced logging for performance)
                    if (url.includes('getconsumption') || url.includes('getmyservices')) {
                        // Silent - only log if there's an issue
                    }
                } else {
                    const responseText = await response.text();
                    if (responseText.trim().startsWith('{') || responseText.trim().startsWith('[')) {
                        try {
                            const responseData = JSON.parse(responseText);
                            apiResponses.push({
                                url: url,
                                status: status,
                                data: responseData
                            });
                            // Silent - data captured successfully
                        } catch (e) {
                            // Not JSON
                        }
                    }
                }
            } catch (error) {
                // Ignore errors reading response
            }
        }
    });

    return apiResponses;
}

/**
 * Wait for specific API endpoints to be called
 * @param {Array} apiResponses - Array of captured API responses
 * @param {Array} endpointNames - Array of endpoint names to wait for (e.g., ['getconsumption', 'getmyservices'])
 * @param {number} maxWaitTime - Maximum wait time in milliseconds
 * @returns {Promise<void>}
 */
async function waitForApiEndpoints(apiResponses, endpointNames, maxWaitTime = 15000) {
    const startTime = Date.now();
    const found = {};

    // Check more frequently (every 200ms instead of 500ms) for faster response
    while (Date.now() - startTime < maxWaitTime) {
        endpointNames.forEach(name => {
            if (!found[name]) {
                const response = apiResponses.find(resp => resp.url && resp.url.includes(name));
                if (response && response.data) {
                    found[name] = true;
                }
            }
        });

        if (Object.keys(found).length === endpointNames.length) {
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 200)); // Faster polling
    }

    endpointNames.forEach(name => {
        if (!found[name]) {
            console.log(`⚠️ ${name} API not found after ${maxWaitTime}ms wait`);
        }
    });
}

/**
 * Fetch API endpoint directly if not captured
 * @param {Object} page - Puppeteer page object
 * @param {string} endpointOrUrl - API endpoint name (e.g., 'getmyservices') or full URL
 * @param {number} timeout - Optional timeout in milliseconds
 * @returns {Promise<Object|null>} Response data or null
 */
async function fetchApiDirectly(page, endpointOrUrl, timeout = 3000) {
    // Check if page is still open
    if (page.isClosed()) {
        return null;
    }
    
    // Build full URL if endpoint name is provided
    let url;
    if (endpointOrUrl.startsWith('http')) {
        url = endpointOrUrl;
    } else {
        // Map endpoint names to full URLs
        const endpointMap = {
            'getconsumption': `https://www.alfa.com.lb/en/account/getconsumption?_=${Date.now()}`,
            'getmyservices': `https://www.alfa.com.lb/en/account/manage-services/getmyservices?_=${Date.now()}`,
            'getexpirydate': `https://www.alfa.com.lb/en/account/getexpirydate?_=${Date.now()}`
        };
        url = endpointMap[endpointOrUrl] || endpointOrUrl;
    }
    
    try {
        // Use Promise.race to add timeout
        const fetchPromise = page.evaluate(async (apiUrl) => {
            try {
                const response = await fetch(apiUrl, {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });
                
                if (response.ok) {
                    const contentType = response.headers.get('content-type') || '';
                    if (contentType.includes('json')) {
                        return { success: true, data: await response.json(), status: response.status };
                    } else {
                        const text = await response.text();
                        // Try to parse as JSON
                        try {
                            return { success: true, data: JSON.parse(text), status: response.status };
                        } catch {
                            // Return as string/number if it's just a number
                            const numValue = text.trim().match(/^\d+$/) ? text.trim() : (isNaN(text.trim()) ? null : text.trim());
                            return { success: true, data: numValue || text.trim(), status: response.status };
                        }
                    }
                } else {
                    return { success: false, error: `HTTP ${response.status}`, status: response.status };
                }
            } catch (error) {
                return { success: false, error: error.message, status: 0 };
            }
        }, url);
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), timeout)
        );
        
        const data = await Promise.race([fetchPromise, timeoutPromise]);

        if (data && data.success && data.data !== null && data.data !== undefined) {
            return {
                url: url,
                status: data.status || 200,
                data: data.data
            };
        } else if (data && data.status === 404) {
            // Silently skip 404 errors - endpoint might not be available
            return null;
        } else {
            // Only log non-404 errors
            if (data && data.status !== 404) {
                console.log(`⚠️ Failed to fetch ${endpointOrUrl}: ${data.error || 'Unknown error'}`);
            }
            return null;
        }
    } catch (error) {
        // Silently handle "Target closed" and timeout errors during concurrent operations
        if (error.message.includes('Target closed') || 
            error.message.includes('Session closed') || 
            error.message.includes('Protocol error') ||
            error.message === 'Timeout') {
            return null;
        }
        console.log(`⚠️ Error making direct API call to ${endpointOrUrl}:`, error.message);
        return null;
    }
}

module.exports = {
    setupApiCapture,
    waitForApiEndpoints,
    fetchApiDirectly
};

