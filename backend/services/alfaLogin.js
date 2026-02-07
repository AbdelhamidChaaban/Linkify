const { getSession, saveSession } = require('./sessionManager');
const { solveCaptcha, extractSiteKey, isCaptchaServiceAvailable } = require('./captchaService');
const https = require('https');
const { URL } = require('url');

const AEFA_LOGIN_URL = 'https://www.alfa.com.lb/en/account/login';
const AEFA_DASHBOARD_URL = 'https://www.alfa.com.lb/en/account';

// HTTP Agent for connection pooling (faster requests)
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 60000
});

// Rate limiting to prevent Alfa from blocking us
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_ATTEMPTS_PER_WINDOW = 3; // Max 3 login attempts per minute per admin

function checkRateLimit(adminId) {
    const now = Date.now();
    const attempts = loginAttempts.get(adminId) || [];
    
    // Clean old attempts
    const recentAttempts = attempts.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (recentAttempts.length >= MAX_ATTEMPTS_PER_WINDOW) {
        const oldestAttempt = Math.min(...recentAttempts);
        const waitTime = RATE_LIMIT_WINDOW - (now - oldestAttempt);
        throw new Error(`Rate limit exceeded. Please wait ${Math.ceil(waitTime / 1000)} seconds before trying again.`);
    }
    
    recentAttempts.push(now);
    loginAttempts.set(adminId, recentAttempts);
    return true;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Exponential backoff for retries
function getBackoffDelay(attempt) {
    const delays = [1000, 2000, 4000, 8000, 16000]; // 1s, 2s, 4s, 8s, 16s
    return delays[Math.min(attempt, delays.length - 1)];
}

/**
 * Login to Alfa website (DEPRECATED - Puppeteer-based, no longer used)
 * This function is kept for backward compatibility but should not be called.
 * Use loginViaHttp instead which supports 2Captcha.
 * @param {Object} page - Puppeteer page object (deprecated)
 * @param {string} phone - Phone number (username)
 * @param {string} password - Password
 * @param {string} adminId - Admin ID for session storage
 * @returns {Promise<{success: boolean, alreadyOnDashboard: boolean}>} Login result
 * @deprecated Use loginViaHttp instead
 */
async function loginToAlfa(page, phone, password, adminId) {
    throw new Error('loginToAlfa is deprecated. Puppeteer has been removed. Use loginViaHttp instead.');
    try {
        // Check for existing session from Redis
        // Note: Session cookies should already be injected in fetchAlfaData before this is called
        // But we check again here as a fallback
        const savedSession = await getSession(adminId || phone);
        let needsLogin = true;
        let alreadyOnDashboard = false;

        if (savedSession && savedSession.cookies && savedSession.cookies.length > 0) {
            const sessionNeedsRefresh = savedSession.needsRefresh || false;
            
            // If cookies weren't already injected, inject them now
            try {
                const existingCookies = await page.cookies();
                if (existingCookies.length === 0) {
                    await page.setCookie(...savedSession.cookies);
                    console.log(`✅ Injected ${savedSession.cookies.length} cookies from Redis`);
                }
            } catch (cookieError) {
                console.warn('⚠️ Error injecting cookies:', cookieError.message);
            }

            // Only verify session if it's expiring (to refresh it)
            // If session is fresh, skip verification to save time
            if (sessionNeedsRefresh) {
                console.log('⚠️ Session is expiring soon. Verifying and refreshing...');
                
                // OPTIMIZATION: Check current URL first - if already on dashboard, skip navigation
                try {
                    const currentUrl = page.url();
                    if (currentUrl.includes('/account') && !currentUrl.includes('/login')) {
                        // Already on dashboard - just refresh cookies without navigation
                        console.log('✅ Already on dashboard, refreshing cookies without navigation...');
                        const currentCookies = await page.cookies();
                        await saveSession(adminId || phone, currentCookies, {});
                        console.log('✅ Session refreshed successfully!');
                        needsLogin = false;
                    } else {
                        // Need to navigate - use optimized settings
                        try {
                            await page.goto(AEFA_DASHBOARD_URL, {
                                waitUntil: 'domcontentloaded',
                                timeout: 8000 // Faster than networkidle0 but still reliable
                            });
                            
                            // Brief delay to allow redirects
                            await delay(500);
                            
                            const finalUrl = page.url();
                            if (!finalUrl.includes('/login')) {
                                console.log('✅ Session verified, refreshing cookies...');
                                const currentCookies = await page.cookies();
                                await saveSession(adminId || phone, currentCookies, {});
                                console.log('✅ Session refreshed successfully!');
                                needsLogin = false;
                            } else {
                                console.log('⚠️ Session expired. Will login again.');
                                needsLogin = true;
                            }
                        } catch (navError) {
                            // If navigation fails, check URL - might already be on dashboard
                            const checkUrl = page.url();
                            if (checkUrl.includes('/account') && !checkUrl.includes('/login')) {
                                console.log('✅ Navigation timeout but already on dashboard, refreshing cookies...');
                                const currentCookies = await page.cookies();
                                await saveSession(adminId || phone, currentCookies, {});
                                console.log('✅ Session refreshed successfully!');
                                needsLogin = false;
                            } else {
                                console.log('⚠️ Navigation failed and not on dashboard, will proceed with login:', navError.message);
                                needsLogin = true;
                            }
                        }
                    }
                } catch (error) {
                    console.log('⚠️ Error during session verification, will proceed with login:', error.message);
                    needsLogin = true;
                }
            } else {
                // Session is fresh - skip verification to save time
                // We'll verify it during the actual data fetch by checking if APIs work
                // IMPORTANT: Even if session is fresh, we should still refresh it periodically to extend lifetime
                // But we skip the verification step to save time - the session will be refreshed after successful data fetch
                console.log('✅ Found fresh session in Redis (skipping verification for speed, will refresh after successful operation)');
                needsLogin = false;
            }
        } else {
            console.log('ℹ️ No saved session found in Redis, will login');
        }

        if (needsLogin) {
            alreadyOnDashboard = false; // We need to login, so we're not on dashboard yet
            const credentials = { username: phone, password: password };
            
            // Check current URL - if we're already on dashboard, navigate to login page first
            const initialUrl = page.url();
            if (initialUrl.includes('/account') && !initialUrl.includes('/login')) {
                console.log('🔐 Currently on dashboard, navigating to login page first...');
                try {
                    await page.goto(AEFA_LOGIN_URL, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    });
                    await delay(1000); // Small delay after navigation
                } catch (navError) {
                    console.warn('⚠️ Error navigating to login page:', navError.message);
                }
            }
            
            console.log('🔐 Navigating to login page...');
            
            // Retry navigation with different strategies (handle 503 errors) - EXACTLY like alfa-automation.txt
            let navigationSuccess = false;
            const maxRetries = 5;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    console.log(`🔄 Navigation attempt ${attempt}/${maxRetries}...`);
                    
                    await page.goto(AEFA_LOGIN_URL, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    });
                    
                    // Check if we got a 503 error or service unavailable
                    const pageContent = await page.evaluate(() => {
                        return document.body.textContent || '';
                    });
                    
                    if (pageContent.includes('Service Unavailable') || pageContent.includes('503') || pageContent.includes('HTTP Error')) {
                        console.log(`⚠️ Got 503/Service Unavailable on attempt ${attempt}`);
                        if (attempt < maxRetries) {
                            const waitTime = attempt * 3000;
                            console.log(`⏳ Waiting ${waitTime/1000}s before retry...`);
                            await delay(waitTime);
                            continue;
                        } else {
                            throw new Error('Service unavailable (503) after multiple retries');
                        }
                    }
                    
                    const currentUrl = page.url();
                    console.log(`✅ Navigation successful. Current URL: ${currentUrl}`);
                    navigationSuccess = true;
                    break;
                } catch (error) {
                    console.log(`⚠️ Navigation attempt ${attempt} failed: ${error.message}`);
                    
                    if (attempt < maxRetries) {
                        if (error.message.includes('ERR_NAME_NOT_RESOLVED') || error.message.includes('DNS')) {
                            console.log('⚠️ DNS/Network error detected - website may be down or unreachable');
                            const waitTime = attempt * 3000;
                            console.log(`⏳ Waiting ${waitTime/1000}s before retry (checking internet connection)...`);
                            await delay(waitTime);
                        } else {
                            const waitTime = attempt * 2000;
                            console.log(`⏳ Waiting ${waitTime/1000}s before retry...`);
                            await delay(waitTime);
                        }
                    } else {
                        // Last attempt - check if we're on any alfa page
                        try {
                            const finalUrl = page.url();
                            const pageText = await page.evaluate(() => {
                                try {
                                    return document.body.textContent || '';
                                } catch (e) {
                                    return '';
                                }
                            });
                            
                            if (finalUrl.includes('alfa.com.lb') && !pageText.includes('Service Unavailable') && !pageText.includes('503')) {
                                console.log(`✅ Page loaded despite errors. URL: ${finalUrl}`);
                                navigationSuccess = true;
                            } else {
                                throw new Error(`Failed to navigate after ${maxRetries} attempts. Last error: ${error.message}`);
                            }
                        } catch (evalError) {
                            if (error.message.includes('ERR_NAME_NOT_RESOLVED')) {
                                throw new Error('Cannot reach alfa.com.lb - DNS resolution failed. Please check your internet connection.');
                            }
                            throw new Error(`Failed to navigate after ${maxRetries} attempts. Network error: ${error.message}`);
                        }
                    }
                }
            }
            
            if (!navigationSuccess) {
                throw new Error('Unable to navigate to login page');
            }

            console.log('⏳ Waiting for page to stabilize...');
            await delay(3000);
            
            // CRITICAL: Check if we're actually on the dashboard (session might still be valid)
            // Sometimes navigation to login page redirects us back to dashboard if session is valid
            const finalUrl = page.url();
            if (finalUrl.includes('/account') && !finalUrl.includes('/login')) {
                // We're already on dashboard - session is valid, just refresh it
                console.log('✅ Already on dashboard after navigation - session is valid, refreshing...');
                const currentCookies = await page.cookies();
                await saveSession(adminId || phone, currentCookies, {});
                console.log('✅ Session refreshed successfully!');
                needsLogin = false;
                alreadyOnDashboard = true;
                // CRITICAL: Return early - don't continue with login logic
                return {
                    success: true,
                    alreadyOnDashboard: true,
                    sessionWasFresh: false
                };
            }
            
            // Verify page is actually loaded (not 503 or error) - EXACTLY like alfa-automation.txt
            let pageCheck;
            try {
                pageCheck = await page.evaluate(() => {
                    return {
                        hasLoginForm: !!document.querySelector('#Username, input[type="password"]'),
                        hasError: document.body.textContent.includes('Service Unavailable') || 
                                 document.body.textContent.includes('503') ||
                                 document.body.textContent.includes('ERR_NAME_NOT_RESOLVED'),
                        bodyText: document.body.textContent.substring(0, 200)
                    };
                });
            } catch (evalError) {
                const currentUrl = page.url();
                throw new Error(`Page evaluation failed. Current URL: ${currentUrl}. This may indicate the page crashed or navigated unexpectedly.`);
            }
            
            if (pageCheck.hasError) {
                throw new Error('Login page returned Service Unavailable (503) error');
            }
            
            if (!pageCheck.hasLoginForm) {
                console.log('⚠️ Login form not found, page content:', pageCheck.bodyText);
                throw new Error('Login form not found - page may have changed or service unavailable');
            }

            // Ensure phone is exactly 8 digits
            const cleanPhone = phone.replace(/\D/g, '').substring(0, 8);
            if (cleanPhone.length !== 8) {
                throw new Error(`Phone number must be exactly 8 digits. Got: ${cleanPhone.length} digits`);
            }

            console.log('✅ Login page loaded. Waiting for form...');

            await page.waitForSelector('#Username', { timeout: 15000 });
            await page.type('#Username', cleanPhone);
            await page.type('#Password', password);

            // Set up error listeners BEFORE clicking submit
            let navigationError = null;
            let pageError = null;
            
            const errorHandler = (error) => {
                console.log(`⚠️ Page error detected: ${error.message}`);
                pageError = error;
            };
            
            const requestFailedHandler = (request) => {
                const url = request.url();
                // Ignore analytics, ads, tracking, and other non-critical requests
                if (url.includes('google-analytics') || 
                    url.includes('googleads') || 
                    url.includes('doubleclick') || 
                    url.includes('analytics') ||
                    url.includes('facebook') ||
                    url.includes('googletagmanager') ||
                    url.includes('.jpg') || url.includes('.png') || url.includes('.gif') ||
                    url.includes('.css') || url.includes('.js') && !url.includes('alfa.com.lb')) {
                    return; // Ignore these requests - they're not critical for login
                }
                
                // Only care about actual login/account page requests
                if (url.includes('alfa.com.lb') && (url.includes('/login') || url.includes('/account'))) {
                    const failure = request.failure();
                    if (failure && failure.errorText !== 'net::ERR_ABORTED') { // ERR_ABORTED is often intentional (cancelled requests)
                        console.log(`⚠️ Critical request failed: ${url} - ${failure.errorText}`);
                        navigationError = new Error(`Critical request failed: ${failure.errorText}`);
                    }
                }
            };
            
            page.on('error', errorHandler);
            page.on('pageerror', errorHandler);
            page.on('requestfailed', requestFailedHandler);
            
            // Retry logic for form submission
            let submitSuccess = false;
            const maxSubmitRetries = 3;
            
            for (let submitAttempt = 1; submitAttempt <= maxSubmitRetries; submitAttempt++) {
                try {
                    // Reset error tracking
                    navigationError = null;
                    pageError = null;
                    
                    console.log(`🔄 Form submission attempt ${submitAttempt}/${maxSubmitRetries}...`);
                    
                    // ✅ Automatically click the Sign In button - EXACTLY like goToCaptchaStealth.txt
                    const navigationPromise = page.waitForNavigation({ 
                        waitUntil: 'domcontentloaded', 
                        timeout: 30000 
                    }).catch(err => {
                        // Don't throw here, we'll check URL manually
                        return null;
                    });
                    
                    await page.click('button[type="submit"]');
                    console.log('⏸️ Login submitted. Waiting for navigation...');
                    
                    // Wait for navigation OR timeout
                    await Promise.race([
                        navigationPromise,
                        new Promise(resolve => setTimeout(resolve, 30000)) // Max 30s wait
                    ]);
                    
                    // Small delay to let page settle
                    await delay(2000);
                    
                    // Check current URL FIRST - this is the most reliable indicator of success/failure
                    const currentUrl = page.url();
                    console.log(`📍 URL after navigation: ${currentUrl}`);
                    
                    // CRITICAL: Check for Chrome error pages or other error URLs
                    const isChromeError = currentUrl.startsWith('chrome-error://') || 
                                         currentUrl.startsWith('chrome://') ||
                                         currentUrl.includes('chromewebdata');
                    const isNetworkError = currentUrl.startsWith('about:') && 
                                          (currentUrl.includes('error') || currentUrl.includes('blank'));
                    
                    if (isChromeError || isNetworkError) {
                        if (submitAttempt < maxSubmitRetries) {
                            console.log(`⚠️ Browser error page detected on attempt ${submitAttempt} (${currentUrl}), retrying...`);
                            // Navigate back to login page before retry
                            try {
                                await page.goto(AEFA_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                                await delay(2000);
                                // Re-enter credentials
                                await page.waitForSelector('#Username', { timeout: 15000 });
                                await page.evaluate(() => {
                                    const username = document.querySelector('#Username');
                                    const password = document.querySelector('#Password');
                                    if (username) username.value = '';
                                    if (password) password.value = '';
                                });
                                await page.type('#Username', cleanPhone);
                                await page.type('#Password', password);
                            } catch (retryNavError) {
                                console.log(`⚠️ Failed to navigate back to login page: ${retryNavError.message}`);
                            }
                            await delay(3000 * submitAttempt);
                            continue;
                        } else {
                            throw new Error(`Navigation failed - browser error page detected: ${currentUrl}. This may indicate a network issue, DNS problem, or the website is unreachable.`);
                        }
                    }
                    
                    // Check if we're on a valid Alfa page (either login or account page)
                    if (currentUrl.includes('alfa.com.lb')) {
                        // We're on an Alfa page - check if we're still on login (CAPTCHA/failure) or moved to account (success)
                        if (!currentUrl.includes('/login')) {
                            // Successfully navigated to account/dashboard - login succeeded!
                            submitSuccess = true;
                            break;
                        }
                        // Still on login page - might be CAPTCHA or invalid credentials
                        // Don't retry if we're still on login - let the main flow handle it
                        submitSuccess = true; // Mark as "success" to break the retry loop, but we'll check for CAPTCHA later
                        break;
                    }
                    
                    // Not on an Alfa page and not an error page - might be a redirect or other issue
                    // Only retry if we have a navigationError indicating actual failure
                    if (navigationError) {
                        if (submitAttempt < maxSubmitRetries) {
                            console.log(`⚠️ Navigation error on attempt ${submitAttempt} (URL: ${currentUrl}), retrying...`);
                            await delay(3000 * submitAttempt);
                            continue;
                        } else {
                            throw navigationError;
                        }
                    }
                    
                    // Check for page errors as a fallback
                    if (pageError) {
                        throw new Error(`Page error during navigation: ${pageError.message}`);
                    }
                    
                    // If we get here, we're in an unexpected state - treat as success and let main flow handle it
                    submitSuccess = true;
                    break;
                    
                } catch (submitError) {
                    console.log(`⚠️ Form submission attempt ${submitAttempt} failed: ${submitError.message}`);
                    
                    if (submitAttempt < maxSubmitRetries) {
                        console.log(`⏳ Waiting before retry...`);
                        await delay(3000 * submitAttempt);
                        // Try to navigate back to login page
                        try {
                            await page.goto(AEFA_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                            await delay(2000);
                            await page.waitForSelector('#Username', { timeout: 15000 });
                            await page.evaluate(() => {
                                const username = document.querySelector('#Username');
                                const password = document.querySelector('#Password');
                                if (username) username.value = '';
                                if (password) password.value = '';
                            });
                            await page.type('#Username', cleanPhone);
                            await page.type('#Password', password);
                        } catch (retryNavError) {
                            console.log(`⚠️ Failed to navigate back to login page: ${retryNavError.message}`);
                        }
                    } else {
                        // Remove error listeners
                        page.off('error', errorHandler);
                        page.off('pageerror', errorHandler);
                        page.off('requestfailed', requestFailedHandler);
                        throw submitError;
                    }
                }
            }
            
            // Remove error listeners
            page.off('error', errorHandler);
            page.off('pageerror', errorHandler);
            page.off('requestfailed', requestFailedHandler);
            
            if (!submitSuccess) {
                throw new Error('Form submission failed after multiple attempts');
            }
            
            // Final URL check
            const currentUrl = page.url();
            console.log(`📍 Final URL: ${currentUrl}`);
            
            // CRITICAL: Check for Chrome error pages one more time
            const isChromeError = currentUrl.startsWith('chrome-error://') || 
                                 currentUrl.startsWith('chrome://') ||
                                 currentUrl.includes('chromewebdata');
            const isNetworkError = currentUrl.startsWith('about:') && 
                                  (currentUrl.includes('error') || currentUrl.includes('blank'));
            
            if (isChromeError || isNetworkError) {
                throw new Error(`Navigation failed - browser error page detected: ${currentUrl}. This may indicate a network issue, DNS problem, or the website is unreachable.`);
            }
            
            if (!currentUrl.includes('/login')) {
                // Check if we're actually on an Alfa page (not an error page)
                if (!currentUrl.includes('alfa.com.lb')) {
                    throw new Error(`Login navigation failed - URL is not an Alfa page: ${currentUrl}`);
                }
                
                // Successfully logged in!
                console.log('✅ Login successful! Saving session to Redis...');
                const cookies = await page.cookies();
                
                // CRITICAL: Validate that we actually got cookies
                if (!cookies || cookies.length === 0) {
                    throw new Error(`Login appeared successful but no cookies received. URL: ${currentUrl}`);
                }
                
                // Save session immediately after successful login
                // This ensures session persists even if later operations fail
                await saveSession(adminId || phone, cookies, {});
                
                // CRITICAL: Verify session was actually saved (saveSession may reject invalid cookies)
                const savedSession = await getSession(adminId || phone);
                if (!savedSession || !savedSession.cookies || savedSession.cookies.length === 0) {
                    throw new Error(`Session save failed - cookies were rejected or not persisted. Received ${cookies.length} cookies but session is empty.`);
                }
                
                console.log(`✅ Session saved successfully! (${cookies.length} cookies)`);
            } else {
                // Still on login page - check for CAPTCHA
                console.log('⚠️ Still on login page. Checking for CAPTCHA...');
                const hasCaptcha = await getCaptchaSiteKey(page);
                
                if (hasCaptcha) {
                    console.log('🔍 CAPTCHA detected, solving...');
                    try {
                        const captchaToken = await solveCaptcha(hasCaptcha, page.url());
                        await injectCaptchaToken(page, captchaToken);
                        await delay(1000);
                        await page.click('button[type="submit"]');
                        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                        await delay(2000);
                        const newUrl = page.url();
                        console.log(`📍 URL after CAPTCHA submit: ${newUrl}`);
                        
                        // CRITICAL: Check for Chrome error pages or other error URLs
                        const isChromeErrorAfterCaptcha = newUrl.startsWith('chrome-error://') || 
                                                         newUrl.startsWith('chrome://') ||
                                                         newUrl.includes('chromewebdata');
                        const isNetworkErrorAfterCaptcha = newUrl.startsWith('about:') && 
                                                          (newUrl.includes('error') || newUrl.includes('blank'));
                        
                        if (isChromeErrorAfterCaptcha || isNetworkErrorAfterCaptcha) {
                            throw new Error(`Navigation failed after CAPTCHA - browser error page detected: ${newUrl}`);
                        }
                        
                        if (!newUrl.includes('/login')) {
                            // Check if we're actually on an Alfa page
                            if (!newUrl.includes('alfa.com.lb')) {
                                throw new Error(`Login navigation failed after CAPTCHA - URL is not an Alfa page: ${newUrl}`);
                            }
                            
                            console.log('✅ Login successful after CAPTCHA! Saving session to Redis...');
                            const cookies = await page.cookies();
                            
                            // CRITICAL: Validate that we actually got cookies
                            if (!cookies || cookies.length === 0) {
                                throw new Error(`Login appeared successful after CAPTCHA but no cookies received. URL: ${newUrl}`);
                            }
                            
                            // Save session immediately after successful login
                            await saveSession(adminId || phone, cookies, {});
                            
                            // CRITICAL: Verify session was actually saved
                            const savedSession = await getSession(adminId || phone);
                            if (!savedSession || !savedSession.cookies || savedSession.cookies.length === 0) {
                                throw new Error(`Session save failed after CAPTCHA - cookies were rejected or not persisted. Received ${cookies.length} cookies but session is empty.`);
                            }
                            
                            console.log(`✅ Session saved successfully! (${cookies.length} cookies)`);
                        } else {
                            throw new Error('Login failed after CAPTCHA solve');
                        }
                    } catch (captchaError) {
                        throw new Error(`CAPTCHA solving failed: ${captchaError.message}`);
                    }
                } else {
                    // Wait a bit longer for JavaScript-driven error messages to appear
                    await delay(3000);
                    
                    // Check for error messages more thoroughly
                    const errorInfo = await page.evaluate(() => {
                        const bodyText = (document.body.textContent || '').toLowerCase();
                        const bodyHTML = document.body.innerHTML || '';
                        
                        // Check for common error keywords in page content
                        const errorKeywords = [
                            'invalid', 'incorrect', 'wrong', 'error', 'failed', 
                            'username', 'password', 'credentials', 'authentication',
                            'try again', 'please check', 'not found'
                        ];
                        
                        let foundError = null;
                        for (const keyword of errorKeywords) {
                            if (bodyText.includes(keyword)) {
                                // Try to find the error message in context
                                const contextStart = Math.max(0, bodyText.indexOf(keyword) - 50);
                                const contextEnd = Math.min(bodyText.length, bodyText.indexOf(keyword) + 100);
                                const context = bodyText.substring(contextStart, contextEnd);
                                if (context.length < 200) { // Only use short contexts (likely error messages)
                                    foundError = context.trim();
                                    break;
                                }
                            }
                        }
                        
                        // Check for visible error elements
                        const errorSelectors = [
                            '.error', '.alert', '.alert-danger', '.alert-error',
                            '[class*="error"]', '[class*="alert"]', 
                            '[class*="validation"]', '[class*="warning"]',
                            '#error', '#alert', '.field-validation-error',
                            '[role="alert"]', '.help-block'
                        ];
                        
                        for (const selector of errorSelectors) {
                            try {
                                const elements = document.querySelectorAll(selector);
                                for (const el of elements) {
                                    // Check if element is visible
                                    const style = window.getComputedStyle(el);
                                    if (style.display !== 'none' && style.visibility !== 'hidden' && el.textContent) {
                                        const text = el.textContent.trim();
                                        if (text.length > 0 && text.length < 500) { // Reasonable error message length
                                            foundError = foundError || text;
                                        }
                                    }
                                }
                            } catch (e) {
                                // Ignore selector errors
                            }
                        }
                        
                        // Check input field validation messages
                        const usernameInput = document.querySelector('#Username');
                        const passwordInput = document.querySelector('#Password');
                        
                        if (usernameInput) {
                            const usernameValidation = usernameInput.getAttribute('data-valmsg-for') || 
                                                      usernameInput.parentElement?.querySelector('[class*="validation"]');
                            if (usernameValidation && usernameValidation.textContent) {
                                foundError = foundError || usernameValidation.textContent.trim();
                            }
                        }
                        
                        if (passwordInput) {
                            const passwordValidation = passwordInput.getAttribute('data-valmsg-for') || 
                                                      passwordInput.parentElement?.querySelector('[class*="validation"]');
                            if (passwordValidation && passwordValidation.textContent) {
                                foundError = foundError || passwordValidation.textContent.trim();
                            }
                        }
                        
                        // Check if form fields still have values (might indicate form didn't submit)
                        const formSubmitted = !usernameInput?.value && !passwordInput?.value;
                        
                        return {
                            error: foundError || null,
                            formSubmitted: formSubmitted,
                            usernameHasValue: !!usernameInput?.value,
                            passwordHasValue: !!passwordInput?.value
                        };
                    });
                    
                    if (errorInfo.error) {
                        throw new Error(`Login failed: ${errorInfo.error}`);
                    } else if (!errorInfo.formSubmitted && (errorInfo.usernameHasValue || errorInfo.passwordHasValue)) {
                        // Form fields still have values - might indicate form didn't submit or was blocked
                        throw new Error('Login failed - form submission may have been blocked or prevented. Form fields still contain values.');
                    } else {
                        // No clear error message, but still on login page
                        throw new Error('Login failed - still on login page. No CAPTCHA or error message detected. This may indicate invalid credentials or a form submission issue.');
                    }
                }
            }
        }

        return { success: true, alreadyOnDashboard: alreadyOnDashboard };
    } catch (error) {
        console.error('❌ Login error:', error.message);
        throw error;
    }
}

/**
 * Parse Set-Cookie header into cookie objects (Puppeteer format)
 * @param {Array} setCookieHeaders - Array of Set-Cookie header strings
 * @param {string} domain - Cookie domain
 * @returns {Array} Array of cookie objects
 */
function parseCookiesFromHeaders(setCookieHeaders, domain = 'www.alfa.com.lb') {
    const cookies = [];
    
    if (!setCookieHeaders || !Array.isArray(setCookieHeaders)) {
        return cookies;
    }
    
    setCookieHeaders.forEach(header => {
        const parts = header.split(';');
        const [nameValue] = parts;
        const [name, value] = nameValue.split('=').map(s => s.trim());
        
        if (!name || !value) return;
        
        const cookie = {
            name: name,
            value: value,
            domain: domain,
            path: '/',
            httpOnly: header.includes('HttpOnly'),
            secure: header.includes('Secure'),
            sameSite: header.includes('SameSite=None') ? 'None' : 
                     header.includes('SameSite=Lax') ? 'Lax' : 
                     header.includes('SameSite=Strict') ? 'Strict' : 'Lax'
        };
        
        // Parse expiry
        const expiresMatch = header.match(/Expires=([^;]+)/i) || header.match(/Max-Age=(\d+)/i);
        if (expiresMatch) {
            if (expiresMatch[0].startsWith('Max-Age')) {
                cookie.expires = Math.floor(Date.now() / 1000) + parseInt(expiresMatch[1]);
            } else {
                cookie.expires = Math.floor(new Date(expiresMatch[1]).getTime() / 1000);
            }
        }
        
        cookies.push(cookie);
    });
    
    return cookies;
}

/**
 * Fast HTTP-based login (much faster than Puppeteer - 2-5s vs 10-20s)
 * @param {string} phone - Phone number (8 digits)
 * @param {string} password - Password
 * @param {string} adminId - Admin ID
 * @returns {Promise<{success: boolean, cookies: Array, needsCaptcha: boolean, fallback: boolean}>}
 */
async function loginViaHttp(phone, password, adminId) {
    // Check rate limit first
    checkRateLimit(adminId);
    
    const cleanPhone = phone.replace(/\D/g, '').substring(0, 8);
    if (cleanPhone.length !== 8) {
        throw new Error(`Phone number must be exactly 8 digits. Got: ${cleanPhone.length} digits`);
    }
    
    // Retry logic with exponential backoff
    let lastError = null;
    const maxRetries = 3;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            const delayMs = getBackoffDelay(attempt - 1);
            console.log(`🔄 [HTTP Login] Retry attempt ${attempt}/${maxRetries} after ${delayMs}ms delay...`);
            await delay(delayMs);
        }
        
        try {
            const result = await performLoginAttempt(cleanPhone, password, adminId);
            if (result.success) {
                console.log(`✅ [HTTP Login] Login successful on attempt ${attempt + 1}`);
                return result;
            }
            
            // If CAPTCHA required, don't retry - let it fail to CAPTCHA service
            if (result.needsCaptcha) {
                console.log(`⚠️ [HTTP Login] CAPTCHA required, not retrying`);
                return result;
            }
            
            lastError = result.error || 'Login failed';
            console.log(`⚠️ [HTTP Login] Attempt ${attempt + 1} failed: ${lastError}`);
            
        } catch (error) {
            lastError = error.message;
            console.log(`⚠️ [HTTP Login] Attempt ${attempt + 1} error: ${lastError}`);
        }
    }
    
    // All retries failed
    throw new Error(`Login failed after ${maxRetries + 1} attempts: ${lastError}`);
}

async function performLoginAttempt(cleanPhone, password, adminId) {
    
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const loginUrl = new URL(AEFA_LOGIN_URL);
        let cookies = [];
        let csrfToken = null;
        
        // Step 1: Fetch login page to get CSRF token
        const getOptions = {
            hostname: loginUrl.hostname,
            path: loginUrl.pathname,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.alfa.com.lb/'
            },
            agent: httpsAgent
        };
        
        console.log(`⚡ [HTTP Login] Fetching login page to extract CSRF token...`);
        const getReq = https.request(getOptions, (getRes) => {
            let htmlData = '';
            
            // Collect cookies from initial request
            if (getRes.headers['set-cookie']) {
                cookies = parseCookiesFromHeaders(getRes.headers['set-cookie']);
            }
            
            getRes.on('data', (chunk) => {
                htmlData += chunk;
            });
            
            getRes.on('end', () => {
                // Extract CSRF token from HTML
                const tokenMatch = htmlData.match(/name="__RequestVerificationToken"\s+value="([^"]+)"/) ||
                                 htmlData.match(/<input[^>]*name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
                
                if (!tokenMatch) {
                    console.log(`⚠️ [HTTP Login] Could not extract CSRF token`);
                    resolve({ success: false, needsCaptcha: false, error: 'Could not extract CSRF token' });
                    return;
                }
                
                csrfToken = tokenMatch[1];
                console.log(`✅ [HTTP Login] Extracted CSRF token`);
                
                // Check for CAPTCHA in HTML
                const hasCaptcha = htmlData.includes('g-recaptcha') || htmlData.includes('recaptcha');
                let captchaToken = null;
                
                if (hasCaptcha) {
                    console.log(`[Captcha] CAPTCHA detected in login page`);
                    
                    // Extract site key
                    const siteKey = extractSiteKey(htmlData);
                    if (!siteKey) {
                        console.log(`⚠️ [HTTP Login] CAPTCHA detected but could not extract site key`);
                        resolve({ success: false, needsCaptcha: true, fallback: false });
                        return;
                    }
                    
                    // Solve CAPTCHA using 2Captcha
                    if (isCaptchaServiceAvailable()) {
                        console.log(`[Captcha] Solving CAPTCHA for admin ${adminId}`);
                        solveCaptcha(siteKey, AEFA_LOGIN_URL)
                            .then(token => {
                                captchaToken = token;
                                console.log(`[Captcha] CAPTCHA solved successfully`);
                                
                                // Continue with login using the token
                                performLoginWithCaptcha();
                            })
                            .catch(error => {
                                console.error(`[Captcha] CAPTCHA failed after retries: ${error.message}`);
                                resolve({ success: false, needsCaptcha: true, error: error.message });
                            });
                        return; // Will continue in performLoginWithCaptcha callback
                    } else {
                        console.log(`⚠️ [HTTP Login] CAPTCHA detected but CAPTCHA_API_KEY not configured`);
                        resolve({ success: false, needsCaptcha: true, fallback: false });
                        return;
                    }
                }
                
                // No CAPTCHA, proceed with normal login
                performLoginWithoutCaptcha();
                
                function performLoginWithCaptcha() {
                    // Step 2: POST login form with CAPTCHA token
                    const postUrl = new URL(AEFA_LOGIN_URL);
                    let formData = `Username=${encodeURIComponent(cleanPhone)}&Password=${encodeURIComponent(password)}&__RequestVerificationToken=${encodeURIComponent(csrfToken)}`;
                    
                    if (captchaToken) {
                        formData += `&g-recaptcha-response=${encodeURIComponent(captchaToken)}`;
                    }
                    
                    performPostRequest(formData);
                }
                
                function performLoginWithoutCaptcha() {
                    // Step 2: POST login form
                    const postUrl = new URL(AEFA_LOGIN_URL);
                    const formData = `Username=${encodeURIComponent(cleanPhone)}&Password=${encodeURIComponent(password)}&__RequestVerificationToken=${encodeURIComponent(csrfToken)}`;
                    
                    performPostRequest(formData);
                }
                
                function performPostRequest(formData) {
                    const postUrl = new URL(AEFA_LOGIN_URL);
                    
                    // Build cookie header from initial cookies
                    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                    
                    const postOptions = {
                        hostname: postUrl.hostname,
                        path: postUrl.pathname,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Content-Length': Buffer.byteLength(formData),
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Referer': AEFA_LOGIN_URL,
                            'Origin': 'https://www.alfa.com.lb',
                            'Cookie': cookieHeader
                        },
                        agent: httpsAgent
                    };
                    
                    console.log(`⚡ [HTTP Login] Submitting login form...`);
                    const postReq = https.request(postOptions, (postRes) => {
                        console.log(`🔍🔍🔍 [HTTP Login] POST RESPONSE HANDLER CALLED! Status: ${postRes.statusCode}`);
                        console.log(`🔍 [HTTP Login] POST response received: status=${postRes.statusCode}`);
                        
                        // Collect cookies from login response
                        if (postRes.headers['set-cookie']) {
                            const newCookies = parseCookiesFromHeaders(postRes.headers['set-cookie']);
                            // Merge cookies, keeping latest values
                            const cookieMap = new Map();
                            [...cookies, ...newCookies].forEach(c => cookieMap.set(c.name, c));
                            cookies = Array.from(cookieMap.values());
                            console.log(`🔍 [HTTP Login] Collected ${newCookies.length} new cookies from POST response (total: ${cookies.length})`);
                        }
                        
                        // Check if login was successful (redirect to dashboard or 302/301/200)
                        const location = postRes.headers.location || '';
                        const isSuccess = postRes.statusCode === 302 || postRes.statusCode === 301 || postRes.statusCode === 200;
                        
                        console.log(`🔍 [HTTP Login] POST response: status=${postRes.statusCode}, location="${location}", cookies=${cookies.length}, isSuccess=${isSuccess}`);
                        
                        // For redirects or 200, we need to consume the response body
                        if (postRes.statusCode === 302 || postRes.statusCode === 301 || postRes.statusCode === 200) {
                            postRes.resume(); // Consume the response body
                        }
                    
                    if (isSuccess) {
                        // Follow redirect to get __ACCOUNT cookie (set on redirect target)
                        // Also handle 200 responses - we should still visit /en/account to get __ACCOUNT cookie
                        const shouldFollowRedirect = location && (postRes.statusCode === 302 || postRes.statusCode === 301);
                        const shouldFollowDashboard = postRes.statusCode === 200; // Always try to visit dashboard for 200 responses
                        
                        if (shouldFollowRedirect || shouldFollowDashboard) {
                            // Use location header if present, otherwise go to dashboard
                            const redirectPath = location || '/en/account';
                            console.log(`🔄 [HTTP Login] Following ${shouldFollowRedirect ? 'redirect' : 'dashboard request'} to: ${redirectPath}`);
                            const redirectUrl = new URL(redirectPath, 'https://www.alfa.com.lb');
                            const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                            
                            const redirectOptions = {
                                hostname: redirectUrl.hostname,
                                path: redirectUrl.pathname + (redirectUrl.search || ''),
                                method: 'GET',
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                                    'Accept-Language': 'en-US,en;q=0.9',
                                    'Referer': AEFA_LOGIN_URL,
                                    'Cookie': cookieHeader
                                },
                                agent: httpsAgent
                            };
                            
                            const redirectReq = https.request(redirectOptions, (redirectRes) => {
                                // Collect cookies from redirect target (where __ACCOUNT is typically set)
                                if (redirectRes.headers['set-cookie']) {
                                    const redirectCookies = parseCookiesFromHeaders(redirectRes.headers['set-cookie']);
                                    // Merge cookies, keeping latest values
                                    const finalCookieMap = new Map();
                                    [...cookies, ...redirectCookies].forEach(c => finalCookieMap.set(c.name, c));
                                    cookies = Array.from(finalCookieMap.values());
                                }
                                
                                // Check if we got __ACCOUNT cookie
                                const hasAccountCookie = cookies.some(c => c.name === '__ACCOUNT');
                                
                                if (cookies.length > 0) {
                                    console.log(`✅ [HTTP Login] Login successful! Got ${cookies.length} cookies (${hasAccountCookie ? 'including __ACCOUNT' : 'no __ACCOUNT'}) (${Math.round((Date.now() - startTime) / 100) / 10}s)`);
                                    resolve({ success: true, cookies, needsCaptcha: false });
                                } else {
                                    console.log(`⚠️ [HTTP Login] Login redirect succeeded but no cookies received`);
                                    resolve({ success: false, needsCaptcha: false, error: 'No cookies received after redirect' });
                                }
                            });
                            
                            redirectReq.on('error', () => {
                                // Even if redirect fails, use cookies we have
                                if (cookies.length > 0) {
                                    const hasAccountCookie = cookies.some(c => c.name === '__ACCOUNT');
                                    console.log(`✅ [HTTP Login] Login successful! Got ${cookies.length} cookies (${hasAccountCookie ? 'including __ACCOUNT' : 'no __ACCOUNT'}, redirect failed but using available cookies) (${Math.round((Date.now() - startTime) / 100) / 10}s)`);
                                    resolve({ success: true, cookies, needsCaptcha: false });
                                } else {
                                    resolve({ success: false, needsCaptcha: false, fallback: true });
                                }
                            });
                            
                            redirectReq.setTimeout(5000, () => {
                                redirectReq.destroy();
                                // Use cookies we have even if redirect times out
                                if (cookies.length > 0) {
                                    const hasAccountCookie = cookies.some(c => c.name === '__ACCOUNT');
                                    console.log(`✅ [HTTP Login] Login successful! Got ${cookies.length} cookies (${hasAccountCookie ? 'including __ACCOUNT' : 'no __ACCOUNT'}, redirect timeout but using available cookies) (${Math.round((Date.now() - startTime) / 100) / 10}s)`);
                                    resolve({ success: true, cookies, needsCaptcha: false });
                                } else {
                                    resolve({ success: false, needsCaptcha: false, fallback: true });
                                }
                            });
                            
                            redirectReq.end();
                            return; // Don't continue with original response handling
                        }
                        
                        // No redirect but success
                        if (cookies.length > 0) {
                            const hasAccountCookie = cookies.some(c => c.name === '__ACCOUNT');
                            console.log(`✅ [HTTP Login] Login successful! Got ${cookies.length} cookies (${hasAccountCookie ? 'including __ACCOUNT' : 'no __ACCOUNT'}) (${Math.round((Date.now() - startTime) / 100) / 10}s)`);
                            resolve({ success: true, cookies, needsCaptcha: false });
                        } else {
                            console.log(`⚠️ [HTTP Login] Login succeeded but no cookies received`);
                            resolve({ success: false, needsCaptcha: false, error: 'No cookies received after login' });
                        }
                    } else {
                        // Check response body for errors or CAPTCHA
                        let responseData = '';
                        postRes.on('data', (chunk) => {
                            responseData += chunk.toString();
                        });
                        
                        postRes.on('end', () => {
                            if (responseData.includes('g-recaptcha') || responseData.includes('recaptcha')) {
                                console.log(`⚠️ [HTTP Login] CAPTCHA required in response`);
                                resolve({ success: false, needsCaptcha: true, error: 'CAPTCHA required' });
                            } else {
                                console.log(`⚠️ [HTTP Login] Login failed (status: ${postRes.statusCode})`);
                                resolve({ success: false, needsCaptcha: false, error: `Login failed with status ${postRes.statusCode}` });
                            }
                        });
                    }
                });
                
                postReq.on('error', (error) => {
                    console.log(`⚠️ [HTTP Login] POST request error: ${error.message}`);
                    resolve({ success: false, needsCaptcha: false, error: error.message });
                });
                
                postReq.setTimeout(10000, () => {
                    postReq.destroy();
                    console.log(`⚠️ [HTTP Login] POST request timeout`);
                    resolve({ success: false, needsCaptcha: false, error: 'POST request timeout' });
                });
                
                    postReq.write(formData);
                    postReq.end();
                }
            });
        });
        
        getReq.on('error', (error) => {
            console.log(`⚠️ [HTTP Login] GET request error: ${error.message}`);
            resolve({ success: false, needsCaptcha: false, error: error.message });
        });
        
        getReq.setTimeout(8000, () => {
            getReq.destroy();
            console.log(`⚠️ [HTTP Login] GET request timeout`);
            resolve({ success: false, needsCaptcha: false, error: 'GET request timeout' });
        });
        
        getReq.end();
    });
}

module.exports = { loginToAlfa, loginViaHttp, delay, AEFA_LOGIN_URL, AEFA_DASHBOARD_URL };

