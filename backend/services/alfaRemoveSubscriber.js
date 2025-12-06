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
 * Remove a subscriber from an admin's u-share service
 * @param {string} adminId - Admin ID
 * @param {string} adminPhone - Admin phone number (8 digits)
 * @param {string} adminPassword - Admin password (for login if cookies expired)
 * @param {string} subscriberPhone - Subscriber phone number (8 digits, with or without 961 prefix)
 * @param {Object} sessionData - Optional session data with page and context (for faster removals)
 * @returns {Promise<{success: boolean, message: string}>} Result
 */
async function removeSubscriber(adminId, adminPhone, adminPassword, subscriberPhone, sessionData = null) {
    let context = null;
    let page = null;
    let refreshLockAcquired = false;

    try {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`➖ REMOVE SUBSCRIBER OPERATION STARTED for admin: ${adminId}`);
        console.log(`   Subscriber: ${subscriberPhone}`);
        console.log(`   Started at: ${new Date().toISOString()}`);
        console.log(`${'='.repeat(80)}\n`);

        // Acquire refresh lock to prevent cookie worker from interfering
        refreshLockAcquired = await acquireRefreshLock(adminId, 300); // 5 minute lock
        if (!refreshLockAcquired) {
            console.log(`⏸️ [${adminId}] Refresh lock exists, but proceeding with remove subscriber...`);
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

        // Use existing session if provided (faster - page already loaded)
        let skipNavigation = false;
        if (sessionData && sessionData.page && sessionData.context) {
            console.log(`⚡ Using existing session for faster removal (page already loaded)`);
            context = sessionData.context;
            page = sessionData.page;
            skipNavigation = true; // Skip all login/navigation logic
            
            // Just verify we're on the ushare page, refresh if needed
            const currentUrl = page.url();
            const ushareUrl = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
            
            if (!currentUrl.includes('/ushare')) {
                // Not on ushare page, navigate to it
                console.log(`🌐 [Session] Navigating to Ushare page: ${ushareUrl}`);
                await page.goto(ushareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await delay(2000);
            } else {
                // Already on ushare page, just refresh to get latest data
                console.log(`🔄 [Session] Refreshing Ushare page to get latest data...`);
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
                await delay(2000);
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
                    throw new Error('Login failed - cannot proceed with removing subscriber');
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

        // Click the remove button for this subscriber
        // The remove button has href like: /en/account/manage-services/ushare-delete?number=96170534495&pending=False
        const removeButtonClicked = await page.evaluate((phone) => {
            const cards = document.querySelectorAll('.col-sm-4');
            for (const card of cards) {
                const h2 = card.querySelector('h2');
                if (h2 && h2.textContent.trim() === phone) {
                    const removeLink = card.querySelector('a[href*="ushare-delete"]');
                    if (removeLink) {
                        removeLink.click();
                        return true;
                    }
                }
            }
            return false;
        }, subscriberPhoneWithPrefix);

        if (!removeButtonClicked) {
            throw new Error(`Remove button not found for subscriber ${subscriberPhoneWithPrefix}`);
        }

        console.log(`✅ Clicked remove button`);

        // Wait for confirmation page to load
        await page.waitForNavigation({
            waitUntil: 'domcontentloaded',
            timeout: 15000
        }).catch(() => {
            console.log(`ℹ️ No navigation detected, confirmation may be on same page`);
        });
        await delay(2000);

        // Wait for the confirmation form
        console.log(`📝 Waiting for confirmation form...`);
        await page.waitForSelector('form.form-horizontal', { timeout: 10000 });

        // Verify we're on the confirmation page (should contain "Are you sure")
        const pageText = await page.evaluate(() => document.body.innerText);
        if (!pageText.includes('Are you sure')) {
            throw new Error('Confirmation page not found after clicking remove button');
        }

        console.log(`✅ Found confirmation page`);

        // Click the Remove button on confirmation page
        // The button has text "Remove" and is type="submit"
        console.log(`🚀 Clicking Remove button on confirmation page...`);
        const removeConfirmed = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button[type="submit"]'));
            const removeButton = buttons.find(btn => {
                const span = btn.querySelector('span');
                return span && span.textContent.trim() === 'Remove';
            });
            if (removeButton) {
                removeButton.click();
                return true;
            }
            return false;
        });

        if (!removeConfirmed) {
            throw new Error('Remove button not found on confirmation page');
        }

        console.log(`✅ Clicked Remove button on confirmation page`);

        // Wait for removal to complete
        let navigationHappened = false;
        try {
            await page.waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            navigationHappened = true;
            console.log(`✅ Navigation detected after removal`);
        } catch (navError) {
            console.log(`ℹ️ No navigation detected (removal may be complete)`);
        }
        
        await delay(3000); // Give page time to update

        // Verify removal - if using existing session and already on ushare page, just reload instead of navigating
        const ushareUrl = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        const currentUrl = page.url();
        
        if (sessionData && sessionData.page && currentUrl.includes('/ushare')) {
            // Using existing session and already on ushare page - just reload to get latest data
            console.log(`🔄 [Session] Reloading current Ushare page to verify removal...`);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
            await delay(2000);
        } else {
            // Not using session or not on ushare page - navigate to it
            console.log(`🔍 Navigating to ushare page to verify removal: ${ushareUrl}`);
            await page.goto(ushareUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await delay(2000);
        }

        // Scroll down to see all subscriber cards
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });
        await delay(1000);

        // Verify the subscriber is actually gone by checking the ushare page
        // This is the ONLY reliable way to verify removal - ignore error messages if subscriber is gone
        console.log(`🔍 Verifying subscriber removal - checking if ${subscriberPhoneWithPrefix} still exists...`);
        const subscriberStillExists = await page.evaluate((phone) => {
            const cards = document.querySelectorAll('.col-sm-4');
            for (const card of cards) {
                const h2 = card.querySelector('h2');
                if (h2 && h2.textContent.trim() === phone) {
                    return true;
                }
            }
            return false;
        }, subscriberPhoneWithPrefix);

        // If subscriber is gone, removal succeeded - regardless of any error messages
        if (!subscriberStillExists) {
            console.log(`✅ Subscriber ${subscriberPhoneWithPrefix} successfully removed - no longer found on page`);
            
            // Release refresh lock before returning
            if (refreshLockAcquired) {
                await releaseRefreshLock(adminId).catch(() => {});
            }
            
            return {
                success: true,
                message: `Subscriber ${subscriberPhoneWithPrefix} removed successfully.`
            };
        }

        // Subscriber still exists - but do multiple retry checks to ensure it's really still there
        // Page might need time to update after removal
        console.log(`⚠️ Subscriber ${subscriberPhoneWithPrefix} found on first check - doing retry checks to verify...`);
        
        // CRITICAL: Always do multiple retry checks to ensure subscriber is really still there
        // Don't trust the first check - page might need time to update
        // COMPLETELY IGNORE error messages - only verify by checking if subscriber is gone
        let subscriberStillExistsAfterRetries = true;
        for (let retryAttempt = 1; retryAttempt <= 5; retryAttempt++) {
            console.log(`🔄 Retry check ${retryAttempt}/5: Verifying if subscriber is actually removed...`);
            
            // Wait and reload page
            await delay(2000);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
            await delay(2000);
            
            // Scroll to see all subscribers
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });
            await delay(1000);
            
            // Check again if subscriber exists
            subscriberStillExistsAfterRetries = await page.evaluate((phone) => {
                const cards = document.querySelectorAll('.col-sm-4');
                for (const card of cards) {
                    const h2 = card.querySelector('h2');
                    if (h2 && h2.textContent.trim() === phone) {
                        return true;
                    }
                }
                return false;
            }, subscriberPhoneWithPrefix);
            
            if (!subscriberStillExistsAfterRetries) {
                // Subscriber is actually gone - removal succeeded!
                console.log(`✅ Subscriber ${subscriberPhoneWithPrefix} successfully removed (verified on retry ${retryAttempt})`);
                
                if (refreshLockAcquired) {
                    await releaseRefreshLock(adminId).catch(() => {});
                }
                
                return {
                    success: true,
                    message: `Subscriber ${subscriberPhoneWithPrefix} removed successfully.`
                };
            }
        }
        
        // After all retries, subscriber still exists - removal really failed
        console.log(`❌ Subscriber ${subscriberPhoneWithPrefix} still exists after all retries - removal failed`);
        
        // Return generic error - DO NOT return the "At least one subscriber" message
        // User can remove all subscribers, so we should never block them with that message
        const errorMessage = `Failed to remove subscriber ${subscriberPhoneWithPrefix}. The subscriber is still present on the page after multiple verification attempts.`;
        
        // Release refresh lock before returning
        if (refreshLockAcquired) {
            await releaseRefreshLock(adminId).catch(() => {});
        }
        
        return {
            success: false,
            message: errorMessage
        };

        console.log(`✅ Subscriber ${subscriberPhoneWithPrefix} successfully removed - no longer found on page`);

        // Release refresh lock before returning
        if (refreshLockAcquired) {
            await releaseRefreshLock(adminId).catch(() => {});
        }

        return {
            success: true,
            message: `Subscriber ${subscriberPhoneWithPrefix} removed successfully.`
        };
        
        console.log(`\n${'='.repeat(80)}`);
        console.log(`✅ REMOVE SUBSCRIBER OPERATION COMPLETED for admin: ${adminId}`);
        console.log(`   Subscriber: ${subscriberPhoneWithPrefix}`);
        console.log(`   Completed at: ${new Date().toISOString()}`);
        console.log(`${'='.repeat(80)}\n`);

    } catch (error) {
        console.error(`❌ Error removing subscriber:`, error);
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
            message: error.message || 'Unknown error occurred while removing subscriber'
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
    removeSubscriber
};

