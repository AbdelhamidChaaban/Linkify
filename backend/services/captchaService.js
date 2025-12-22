/**
 * CAPTCHA Service - 2Captcha Integration
 * 
 * Uses 2Captcha API to solve reCAPTCHA v2/v3 during login.
 * API key should be set in process.env.CAPTCHA_API_KEY
 */

const axios = require('axios');

const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY;
const CAPTCHA_API_URL = 'http://2captcha.com';
const MAX_RETRIES = 3;
const POLL_INTERVAL = 5000; // 5 seconds
const MAX_POLL_TIME = 120000; // 2 minutes max wait time

/**
 * Extract reCAPTCHA site key from HTML
 * @param {string} html - HTML content
 * @returns {string|null} Site key or null if not found
 */
function extractSiteKey(html) {
    // Try to find site key in various formats
    const patterns = [
        /data-sitekey=["']([^"']+)["']/i,
        /sitekey=["']([^"']+)["']/i,
        /g-recaptcha[^>]*data-sitekey=["']([^"']+)["']/i,
        /recaptcha[^>]*data-sitekey=["']([^"']+)["']/i
    ];
    
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    
    return null;
}

/**
 * Submit CAPTCHA to 2Captcha for solving
 * @param {string} siteKey - reCAPTCHA site key
 * @param {string} pageUrl - URL of the page with CAPTCHA
 * @returns {Promise<string>} Task ID from 2Captcha
 */
async function submitCaptcha(siteKey, pageUrl) {
    if (!CAPTCHA_API_KEY) {
        throw new Error('CAPTCHA_API_KEY not set in environment variables');
    }
    
    const submitUrl = `${CAPTCHA_API_URL}/in.php`;
    const params = new URLSearchParams({
        key: CAPTCHA_API_KEY,
        method: 'userrecaptcha',
        googlekey: siteKey,
        pageurl: pageUrl,
        json: '1'
    });
    
    try {
        console.log(`[Captcha] Submitting CAPTCHA to 2Captcha (siteKey: ${siteKey.substring(0, 20)}...)`);
        const response = await axios.post(submitUrl, params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 30000
        });
        
        const result = response.data;
        
        if (result.status === 1 && result.request) {
            console.log(`[Captcha] CAPTCHA submitted successfully, task ID: ${result.request}`);
            return result.request;
        } else {
            const errorMsg = result.request || 'Unknown error';
            throw new Error(`Failed to submit CAPTCHA: ${errorMsg}`);
        }
    } catch (error) {
        if (error.response) {
            throw new Error(`2Captcha API error: ${error.response.status} - ${error.response.statusText}`);
        }
        throw new Error(`Failed to submit CAPTCHA: ${error.message}`);
    }
}

/**
 * Poll 2Captcha for CAPTCHA solution
 * @param {string} taskId - Task ID from submitCaptcha
 * @returns {Promise<string>} Solved CAPTCHA token
 */
async function pollForSolution(taskId) {
    if (!CAPTCHA_API_KEY) {
        throw new Error('CAPTCHA_API_KEY not set in environment variables');
    }
    
    const pollUrl = `${CAPTCHA_API_URL}/res.php`;
    const startTime = Date.now();
    
    while (Date.now() - startTime < MAX_POLL_TIME) {
        try {
            const params = new URLSearchParams({
                key: CAPTCHA_API_KEY,
                action: 'get',
                id: taskId,
                json: '1'
            });
            
            const response = await axios.get(`${pollUrl}?${params.toString()}`, {
                timeout: 10000
            });
            
            const result = response.data;
            
            if (result.status === 1 && result.request) {
                console.log(`[Captcha] CAPTCHA solved successfully`);
                return result.request; // This is the token
            } else if (result.request === 'CAPCHA_NOT_READY') {
                // Still processing, wait and retry
                await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
                continue;
            } else {
                const errorMsg = result.request || 'Unknown error';
                throw new Error(`CAPTCHA solving failed: ${errorMsg}`);
            }
        } catch (error) {
            if (error.response) {
                throw new Error(`2Captcha API error: ${error.response.status} - ${error.response.statusText}`);
            }
            // Network error, retry
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        }
    }
    
    throw new Error('CAPTCHA solving timeout - exceeded maximum wait time');
}

/**
 * Solve CAPTCHA using 2Captcha
 * @param {string} siteKey - reCAPTCHA site key
 * @param {string} pageUrl - URL of the page with CAPTCHA (default: Alfa login URL)
 * @returns {Promise<string>} Solved CAPTCHA token
 */
async function solveCaptcha(siteKey, pageUrl = 'https://www.alfa.com.lb/en/account/login') {
    if (!CAPTCHA_API_KEY) {
        throw new Error('CAPTCHA_API_KEY not set in environment variables');
    }
    
    if (!siteKey) {
        throw new Error('Site key is required');
    }
    
    console.log(`[Captcha] Solving CAPTCHA for siteKey: ${siteKey.substring(0, 20)}...`);
    
    // Submit CAPTCHA
    const taskId = await submitCaptcha(siteKey, pageUrl);
    
    // Poll for solution
    const token = await pollForSolution(taskId);
    
    return token;
}

/**
 * Check if CAPTCHA service is available
 * @returns {boolean} True if CAPTCHA_API_KEY is set
 */
function isCaptchaServiceAvailable() {
    return !!CAPTCHA_API_KEY;
}

module.exports = {
    solveCaptcha,
    extractSiteKey,
    isCaptchaServiceAvailable
};
