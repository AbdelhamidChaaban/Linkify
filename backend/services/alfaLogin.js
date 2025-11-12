const { getSession, saveSession } = require('./sessionManager');
const { getCaptchaSiteKey, solveCaptcha, injectCaptchaToken } = require('./captchaService');

const AEFA_LOGIN_URL = 'https://www.alfa.com.lb/en/account/login';
const AEFA_DASHBOARD_URL = 'https://www.alfa.com.lb/en/account';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Login to Alfa website
 * @param {Object} page - Puppeteer page object
 * @param {string} phone - Phone number (username)
 * @param {string} password - Password
 * @param {string} adminId - Admin ID for session storage
 * @returns {Promise<{success: boolean, alreadyOnDashboard: boolean}>} Login result
 */
async function loginToAlfa(page, phone, password, adminId) {
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
                try {
                    // Use networkidle0 with shorter timeout for faster verification
                    await page.goto(AEFA_DASHBOARD_URL, {
                        waitUntil: 'networkidle0',
                        timeout: 15000 // Reduced from 30s to 15s
                    });

                    // No delay needed - networkidle0 already waits for network
                    const currentUrl = page.url();
                    if (!currentUrl.includes('/login')) {
                        console.log('✅ Session verified, refreshing cookies...');
                        const currentCookies = await page.cookies();
                        await saveSession(adminId || phone, currentCookies, {});
                        console.log('✅ Session refreshed successfully!');
                        needsLogin = false;
                    } else {
                        console.log('⚠️ Session expired. Will login again.');
                        needsLogin = true;
                    }
                } catch (error) {
                    // If timeout, try with domcontentloaded (faster fallback)
                    try {
                        await page.goto(AEFA_DASHBOARD_URL, {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        });
                        const currentUrl = page.url();
                        if (!currentUrl.includes('/login')) {
                            console.log('✅ Session verified (fast check), refreshing cookies...');
                            const currentCookies = await page.cookies();
                            await saveSession(adminId || phone, currentCookies, {});
                            console.log('✅ Session refreshed successfully!');
                            needsLogin = false;
                        } else {
                            console.log('⚠️ Session expired. Will login again.');
                            needsLogin = true;
                        }
                    } catch (fallbackError) {
                        console.log('⚠️ Error verifying session, will proceed with login:', fallbackError.message);
                        needsLogin = true;
                    }
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

            // ✅ Automatically click the Sign In button - EXACTLY like goToCaptchaStealth.txt
            await page.click('button[type="submit"]');

            console.log('⏸️ Login submitted. Waiting for login to complete...');
            
            // Wait for navigation after login (either dashboard or still on login if CAPTCHA) - EXACTLY like goToCaptchaStealth.txt
            try {
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch (navError) {
                console.log('⚠️ Navigation wait timed out, checking page state...');
            }
            
            // Always check URL after waiting
            await delay(2000);
            const currentUrl = page.url();
            console.log(`📍 URL after navigation: ${currentUrl}`);
            
            if (!currentUrl.includes('/login')) {
                // Successfully logged in!
                console.log('✅ Login successful! Saving session to Redis...');
                const cookies = await page.cookies();
                // Save session immediately after successful login
                // This ensures session persists even if later operations fail
                await saveSession(adminId || phone, cookies, {});
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
                        if (!newUrl.includes('/login')) {
                            console.log('✅ Login successful after CAPTCHA! Saving session to Redis...');
                            const cookies = await page.cookies();
                            // Save session immediately after successful login
                            await saveSession(adminId || phone, cookies, {});
                            console.log(`✅ Session saved successfully! (${cookies.length} cookies)`);
                        } else {
                            throw new Error('Login failed after CAPTCHA solve');
                        }
                    } catch (captchaError) {
                        throw new Error(`CAPTCHA solving failed: ${captchaError.message}`);
                    }
                } else {
                    // Check for error messages
                    const errorMsg = await page.evaluate(() => {
                        const bodyText = document.body.textContent || '';
                        if (bodyText.toLowerCase().includes('invalid') || bodyText.toLowerCase().includes('incorrect')) {
                            return 'Invalid credentials';
                        }
                        // Check for common error messages
                        const errorSelectors = ['.error', '.alert', '[class*="error"]', '[class*="alert"]'];
                        for (const selector of errorSelectors) {
                            const el = document.querySelector(selector);
                            if (el && el.textContent) {
                                return el.textContent.trim();
                            }
                        }
                        return null;
                    });
                    
                    if (errorMsg) {
                        throw new Error(`Login failed: ${errorMsg}`);
                    } else {
                        throw new Error('Login failed - still on login page. No CAPTCHA or error message detected.');
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

module.exports = { loginToAlfa, delay, AEFA_DASHBOARD_URL };

