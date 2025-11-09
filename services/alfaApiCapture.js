/**
 * Set up network listeners to capture API responses
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<Array>} Array to store API responses
 */
async function setupApiCapture(page) {
    const apiResponses = [];

    // Listen for requests
    page.on('request', (request) => {
        const url = request.url();
        const resourceType = request.resourceType();
        
        if (resourceType === 'xhr' || resourceType === 'fetch' || 
            url.includes('alfa.com.lb') || url.includes('api') || 
            url.includes('ajax') || url.includes('json') || url.includes('data')) {
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
                    
                    // Special logging for important endpoints
                    if (url.includes('getconsumption')) {
                        console.log(`🎯 ✅ getconsumption endpoint response captured!`);
                    } else if (url.includes('getmyservices')) {
                        console.log(`🎯 ✅ getmyservices endpoint response captured!`);
                    } else {
                        console.log(`✅ API Response from ${url}`);
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
                            if (url.includes('getconsumption')) {
                                console.log(`🎯 ✅ getconsumption endpoint response captured (parsed from text)!`);
                            } else if (url.includes('getmyservices')) {
                                console.log(`🎯 ✅ getmyservices endpoint response captured (parsed from text)!`);
                            }
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
    console.log(`⏳ Waiting for API endpoints: ${endpointNames.join(', ')}...`);
    const startTime = Date.now();
    const found = {};

    while (Date.now() - startTime < maxWaitTime) {
        endpointNames.forEach(name => {
            if (!found[name]) {
                const response = apiResponses.find(resp => resp.url && resp.url.includes(name));
                if (response && response.data) {
                    found[name] = true;
                    console.log(`✅✅✅ ${name} API found after ${Date.now() - startTime}ms wait!`);
                }
            }
        });

        if (Object.keys(found).length === endpointNames.length) {
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 500));
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
 * @param {string} url - API endpoint URL
 * @returns {Promise<Object|null>} Response data or null
 */
async function fetchApiDirectly(page, url) {
    try {
        console.log(`📡 Request: GET ${url}`);
        const data = await page.evaluate(async (apiUrl) => {
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
                        return { success: true, data: await response.json() };
                    } else {
                        const text = await response.text();
                        // Try to parse as JSON
                        try {
                            return { success: true, data: JSON.parse(text) };
                        } catch {
                            // Return as string/number if it's just a number
                            const numValue = text.trim().match(/^\d+$/) ? text.trim() : (isNaN(text.trim()) ? null : text.trim());
                            return { success: true, data: numValue || text.trim() };
                        }
                    }
                } else {
                    return { success: false, error: `HTTP ${response.status}` };
                }
            } catch (error) {
                return { success: false, error: error.message };
            }
        }, url);

        if (data.success && data.data !== null && data.data !== undefined) {
            console.log(`✅✅✅ Successfully fetched ${url} directly!`);
            return {
                url: url,
                status: 200,
                data: data.data
            };
        } else {
            console.log(`❌ Failed to fetch ${url}:`, data.error);
            return null;
        }
    } catch (error) {
        console.log(`❌ Error making direct API call to ${url}:`, error.message);
        return null;
    }
}

module.exports = {
    setupApiCapture,
    waitForApiEndpoints,
    fetchApiDirectly
};

