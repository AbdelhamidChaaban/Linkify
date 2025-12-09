const browserPool = require('./browserPool');
const { getSession } = require('./sessionManager');
const { getCookies, areCookiesExpired, acquireRefreshLock, releaseRefreshLock, getCookieExpiry } = require('./cookieManager');
const { loginToAlfa } = require('./alfaLogin');

const ALFA_DASHBOARD_URL = 'https://www.alfa.com.lb/en/account';
const ALFA_USHARE_BASE_URL = 'https://www.alfa.com.lb/en/account/manage-services/ushare';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Edit a subscriber's quota in an admin's u-share service
 * @param {string} adminId - Admin ID
 * @param {string} adminPhone - Admin phone number (8 digits)
 * @param {string} adminPassword - Admin password (for login if cookies expired)
 * @param {string} subscriberPhone - Subscriber phone number (8 digits, with or without 961 prefix)
 * @param {number} newQuota - New quota in GB (e.g., 1.5)
 * @returns {Promise<{success: boolean, message: string}>} Result
 */
async function editSubscriber(adminId, adminPhone, adminPassword, subscriberPhone, newQuota, sessionData = null) {
    let context = null;
    let page = null;
    let refreshLockAcquired = false;

    try {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`✏️ EDIT SUBSCRIBER OPERATION STARTED for admin: ${adminId}`);
        console.log(`   Subscriber: ${subscriberPhone}, New Quota: ${newQuota} GB`);
        console.log(`   Started at: ${new Date().toISOString()}`);
        console.log(`${'='.repeat(80)}\n`);

        // Acquire refresh lock to prevent cookie worker from interfering
        refreshLockAcquired = await acquireRefreshLock(adminId, 300); // 5 minute lock
        if (!refreshLockAcquired) {
            console.log(`⏸️ [${adminId}] Refresh lock exists, but proceeding with edit subscriber...`);
        }

        // Validate inputs
        // Subscriber phone can be 8 digits or 11 digits (with 961 prefix)
        let cleanSubscriberPhone = subscriberPhone.replace(/\D/g, '');
        if (cleanSubscriberPhone.length === 11 && cleanSubscriberPhone.startsWith('961')) {
            cleanSubscriberPhone = cleanSubscriberPhone.substring(3); // Remove 961 prefix
        }
        if (cleanSubscriberPhone.length !== 8) {
            throw new Error(`Subscriber phone must be exactly 8 digits. Got: ${cleanSubscriberPhone.length} digits`);
        }

        if (!newQuota || newQuota < 0.1 || newQuota > 70) {
            throw new Error(`Quota must be between 0.1 and 70 GB. Got: ${newQuota}`);
        }

        // Use existing session if provided (faster - page already loaded)
        let skipNavigation = false;
        if (sessionData && sessionData.page && sessionData.context) {
            console.log(`⚡ Using existing session for faster edit (page already loaded)`);
            context = sessionData.context;
            page = sessionData.page;
            skipNavigation = true; // Skip all login/navigation logic
            
            // Verify we're on the ushare page - but DON'T refresh (cookies are already set, refresh might cause login redirect)
            const currentUrl = page.url();
            const ushareUrl = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
            
            if (!currentUrl.includes('/ushare')) {
                // Not on ushare page, navigate to it (but don't refresh if already there)
                console.log(`🌐 [Session] Navigating to Ushare page: ${ushareUrl}`);
                await page.goto(ushareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await delay(2000);
            } else {
                // Already on ushare page - DON'T refresh (cookies are set, page is ready)
                // Refreshing might cause a redirect to login even with valid cookies
                console.log(`✅ [Session] Already on Ushare page, skipping refresh to avoid login redirect`);
            }
        } else {
            // Get a new isolated browser context from the pool
            const contextData = await browserPool.createContext();
            context = contextData.context;
            page = contextData.page;
        }

        // Skip all login/navigation logic if using existing session
        if (!skipNavigation) {
            // Get admin's cookies from Redis
            console.log(`🔑 Getting cookies for admin: ${adminId}`);
            let cookies = await getCookies(adminId || adminPhone);
            
            // Fallback to sessionManager if cookieManager has no cookies
            if (!cookies || cookies.length === 0) {
                const savedSession = await getSession(adminId || adminPhone);
                if (savedSession && savedSession.cookies && savedSession.cookies.length > 0) {
                    cookies = savedSession.cookies;
                    console.log(`✅ Found ${cookies.length} cookies from sessionManager`);
                }
            } else {
                console.log(`✅ Found ${cookies.length} cookies from cookieManager`);
            }

            // Check if cookies are valid using Redis expiry timestamp (more reliable than cookie expires field)
            let cookiesExpired = true;
            if (cookies && cookies.length > 0) {
                // First check Redis cookie expiry timestamp (most reliable)
                const cookieExpiry = await getCookieExpiry(adminId || adminPhone);
                const now = Date.now();
                
                console.log(`🔍 [Cookie Validation] Checking cookie validity for ${adminId}`);
                console.log(`   Cookies found: ${cookies.length}`);
                console.log(`   Redis expiry: ${cookieExpiry ? new Date(cookieExpiry).toISOString() : 'null'}`);
                console.log(`   Current time: ${new Date(now).toISOString()}`);
                
                if (cookieExpiry && typeof cookieExpiry === 'number' && !isNaN(cookieExpiry)) {
                    // Ensure cookieExpiry is in milliseconds (not seconds)
                    const expiryMs = cookieExpiry > 10000000000 ? cookieExpiry : cookieExpiry * 1000;
                    
                    if (expiryMs > now) {
                        // Redis expiry timestamp says cookies are still valid
                        cookiesExpired = false;
                        const timeRemaining = Math.floor((expiryMs - now) / 1000 / 60);
                        console.log(`✅ Cookies are valid (Redis expiry: ${new Date(expiryMs).toISOString()}, ${timeRemaining} minutes remaining)`);
                    } else {
                        // Redis expiry timestamp says cookies are expired
                        const timeExpired = Math.floor((now - expiryMs) / 1000 / 60);
                        console.log(`⚠️ Cookies are expired (Redis expiry: ${new Date(expiryMs).toISOString()}, expired ${timeExpired} minutes ago)`);
                        cookiesExpired = true;
                    }
                } else {
                    // No Redis expiry timestamp - fall back to checking cookie expires field
                    console.log(`⚠️ No Redis expiry timestamp found, falling back to cookie expires field check`);
                    cookiesExpired = areCookiesExpired(cookies);
                    if (!cookiesExpired) {
                        console.log(`✅ Cookies are valid (no Redis expiry, checked cookie expires field - not expired)`);
                    } else {
                        console.log(`⚠️ Cookies appear expired (checked cookie expires field - found expired cookie)`);
                    }
                }
            } else {
                console.log(`⚠️ [Cookie Validation] No cookies found`);
            }

            // If no cookies found OR cookies are expired, perform login
            if (!cookies || cookies.length === 0 || cookiesExpired) {
                if (cookiesExpired) {
                    console.log(`⚠️ Cookies expired, performing login for admin: ${adminId}`);
                } else {
                    console.log(`⚠️ No cookies found, performing login for admin: ${adminId}`);
                }
                
                if (!adminPassword) {
                    throw new Error('No valid cookies found and password not provided for login');
                }
                
                const loginResult = await loginToAlfa(page, adminPhone, adminPassword, adminId);
                if (!loginResult.success) {
                    throw new Error('Login failed - cannot proceed with editing subscriber');
                }
                
                // After login, navigate directly to ushare page
                await delay(2000);
                const ushareUrl = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
                console.log(`🌐 Navigating directly to ushare page after login: ${ushareUrl}`);
                await page.goto(ushareUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 20000
                });
                await delay(3000);
                
                // Check if we're on login page (cookies might have expired)
                const currentUrl = page.url();
                if (currentUrl.includes('/login')) {
                    console.log(`⚠️ Redirected to login page, cookies expired. Performing login...`);
                    if (!adminPassword) {
                        throw new Error('Cookies expired and password not provided for login');
                    }
                    
                    const retryLoginResult = await loginToAlfa(page, adminPhone, adminPassword, adminId);
                    if (!retryLoginResult.success) {
                        throw new Error('Login failed after cookie expiration');
                    }
                    
                    // After login, navigate directly to ushare page again
                    await delay(2000);
                    console.log(`🌐 Navigating to ushare page after login: ${ushareUrl}`);
                    await page.goto(ushareUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000
                    });
                    await delay(3000);
                } else if (currentUrl.includes('/ushare')) {
                    console.log(`✅ Successfully navigated to ushare page: ${currentUrl}`);
                } else {
                    console.log(`⚠️ Unexpected page after navigation: ${currentUrl}, continuing...`);
                }
            } else {
                // Inject cookies before navigation
                console.log(`🔑 Injecting ${cookies.length} valid cookies...`);
                await page.setCookie(...cookies);
                console.log(`✅ Cookies injected`);
                
                // Navigate directly to ushare page (skip dashboard)
                const ushareUrl = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
                console.log(`🌐 Navigating directly to ushare page: ${ushareUrl}`);
                await page.goto(ushareUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 20000
                });
                await delay(3000);

                // Check if we're on login page (cookies might have expired between check and navigation)
                const currentUrl = page.url();
                if (currentUrl.includes('/login')) {
                    console.log(`⚠️ Redirected to login page, cookies expired during navigation. Performing login...`);
                    if (!adminPassword) {
                        throw new Error('Cookies expired and password not provided for login');
                    }
                    
                    const loginResult = await loginToAlfa(page, adminPhone, adminPassword, adminId);
                    if (!loginResult.success) {
                        throw new Error('Login failed after cookie expiration');
                    }
                    
                    // After login, navigate directly to ushare page again
                    await delay(2000);
                    console.log(`🌐 Navigating to ushare page after login: ${ushareUrl}`);
                    await page.goto(ushareUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000
                    });
                    await delay(3000);
                } else if (currentUrl.includes('/ushare')) {
                    console.log(`✅ Successfully navigated to ushare page: ${currentUrl}`);
                } else {
                    console.log(`⚠️ Unexpected page after navigation: ${currentUrl}, continuing...`);
                }
            }
        }

        // Scroll down to find subscriber cards
        console.log(`📜 Scrolling down to find subscriber cards...`);
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });
        await delay(2000);

        // Find the subscriber card by phone number
        // The card contains an h2 with the phone number (with 961 prefix)
        const subscriberPhoneWithPrefix = `961${cleanSubscriberPhone}`;
        console.log(`🔍 Looking for subscriber card with phone: ${subscriberPhoneWithPrefix}`);

        // Wait for cards to load
        await page.waitForSelector('.col-sm-4', { timeout: 10000 }).catch(() => {
            console.log(`⚠️ No cards found, but continuing...`);
        });

        // Find the card containing the subscriber phone
        const cardFound = await page.evaluate((phone) => {
            const cards = document.querySelectorAll('.col-sm-4');
            for (const card of cards) {
                const h2 = card.querySelector('h2');
                if (h2 && h2.textContent.trim() === phone) {
                    return true;
                }
            }
            return false;
        }, subscriberPhoneWithPrefix);

        if (!cardFound) {
            throw new Error(`Subscriber card with phone ${subscriberPhoneWithPrefix} not found on page`);
        }

        console.log(`✅ Found subscriber card`);

        // Click the edit button for this subscriber
        // The edit button has href like: /en/account/manage-services/ushare-modify?number=96170534495&sharedQuota=22
        const editButtonClicked = await page.evaluate((phone) => {
            const cards = document.querySelectorAll('.col-sm-4');
            for (const card of cards) {
                const h2 = card.querySelector('h2');
                if (h2 && h2.textContent.trim() === phone) {
                    const editLink = card.querySelector('a[href*="ushare-modify"]');
                    if (editLink) {
                        editLink.click();
                        return true;
                    }
                }
            }
            return false;
        }, subscriberPhoneWithPrefix);

        if (!editButtonClicked) {
            throw new Error(`Edit button not found for subscriber ${subscriberPhoneWithPrefix}`);
        }

        console.log(`✅ Clicked edit button`);

        // Wait for edit form to load
        await page.waitForNavigation({
            waitUntil: 'domcontentloaded',
            timeout: 15000
        }).catch(() => {
            console.log(`ℹ️ No navigation detected, form may be on same page`);
        });
        await delay(2000);

        // Wait for the form
        console.log(`📝 Waiting for edit form...`);
        await page.waitForSelector('form.form-horizontal', { timeout: 10000 });
        await page.waitForSelector('#Quota', { timeout: 10000 });

        // Get verification token
        const token = await page.evaluate(() => {
            const input = document.querySelector('input[name="__RequestVerificationToken"]');
            return input ? input.value : null;
        });

        if (!token) {
            throw new Error('Could not find __RequestVerificationToken in form');
        }
        console.log(`✅ Found verification token`);

        // Fill in the new quota
        console.log(`📝 Filling new quota: ${newQuota} GB`);
        await page.waitForSelector('#Quota', { timeout: 10000 });
        await page.click('#Quota', { clickCount: 3 }); // Select all existing text
        await page.type('#Quota', newQuota.toString(), { delay: 100 });
        console.log(`✅ Filled quota: ${newQuota} GB`);

        await delay(500);

        // Submit the form
        console.log(`🚀 Submitting form...`);
        
        // Try multiple selectors for submit button (Alfa website might use different selectors)
        let submitButtonFound = false;
        const submitSelectors = [
            '#submit',  // Simple ID selector
            'button#submit',  // Button with ID
            'button[type="submit"]',  // Button with type submit
            'button[type="submit"]#submit',  // Combined (original)
            'input[type="submit"]',  // Input submit button
            'button.btn-primary[type="submit"]',  // Bootstrap button
            'form button[type="submit"]'  // Submit button in form
        ];
        
        for (const selector of submitSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 2000 });
                console.log(`✅ Found submit button with selector: ${selector}`);
                await page.click(selector);
                submitButtonFound = true;
                break;
            } catch (e) {
                // Try next selector
                continue;
            }
        }
        
        if (!submitButtonFound) {
            // Last resort: try to find and click submit button by evaluating JavaScript
            console.log(`🔍 Trying JavaScript evaluation to find submit button...`);
            const clicked = await page.evaluate(() => {
                // Try to find submit button
                const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                const submitBtn = buttons.find(btn => 
                    btn.type === 'submit' || 
                    btn.id === 'submit' || 
                    btn.getAttribute('onclick')?.includes('submit') ||
                    btn.textContent?.toLowerCase().includes('submit') ||
                    btn.classList.contains('submit') ||
                    btn.name === 'submit'
                );
                
                if (submitBtn) {
                    // Click it directly in the page context
                    submitBtn.click();
                    return true;
                }
                return false;
            });
            
            if (clicked) {
                console.log(`✅ Found and clicked submit button via JavaScript evaluation`);
                submitButtonFound = true;
            } else {
                throw new Error('Could not find submit button with any known selector. Please check the form structure.');
            }
        }
        
        console.log(`✅ Clicked submit button`);

        // Wait for form submission
        let navigationHappened = false;
        try {
            await page.waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            navigationHappened = true;
            console.log(`✅ Navigation detected after form submission`);
        } catch (navError) {
            console.log(`ℹ️ No navigation detected (form may show message on same page)`);
        }
        
        await delay(2000);

        // Release refresh lock before returning
        if (refreshLockAcquired) {
            await releaseRefreshLock(adminId).catch(() => {});
        }

        return {
            success: true,
            message: `Subscriber ${subscriberPhoneWithPrefix} quota updated to ${newQuota} GB successfully.`
        };
        
        console.log(`\n${'='.repeat(80)}`);
        console.log(`✅ EDIT SUBSCRIBER OPERATION COMPLETED for admin: ${adminId}`);
        console.log(`   Subscriber: ${subscriberPhoneWithPrefix}, New Quota: ${newQuota} GB`);
        console.log(`   Completed at: ${new Date().toISOString()}`);
        console.log(`${'='.repeat(80)}\n`);

    } catch (error) {
        console.error(`❌ Error editing subscriber:`, error);
        console.error(`   Error message: ${error.message}`);
        console.error(`   Stack trace: ${error.stack}`);

        // Take screenshot on error
        try {
            if (page) {
                const screenshot = await page.screenshot({ encoding: 'base64' });
                console.log(`📸 Screenshot taken (base64 length: ${screenshot.length})`);
            }
        } catch (screenshotError) {
            console.warn(`⚠️ Could not take screenshot: ${screenshotError.message}`);
        }

        return {
            success: false,
            message: error.message || 'Unknown error occurred while editing subscriber'
        };
    } finally {
        // Release refresh lock
        if (refreshLockAcquired) {
            await releaseRefreshLock(adminId).catch(() => {});
        }

        // Clean up browser context
        if (context) {
            try {
                await browserPool.closeContext(context);
                console.log(`🧹 Browser context closed`);
            } catch (closeError) {
                console.warn(`⚠️ Error closing context: ${closeError.message}`);
            }
        }
    }
}

module.exports = {
    editSubscriber
};

