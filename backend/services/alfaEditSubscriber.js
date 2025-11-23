const browserPool = require('./browserPool');
const { getSession } = require('./sessionManager');
const { getCookies, areCookiesExpired, acquireRefreshLock, releaseRefreshLock } = require('./cookieManager');
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
async function editSubscriber(adminId, adminPhone, adminPassword, subscriberPhone, newQuota) {
    let context = null;
    let page = null;
    let refreshLockAcquired = false;

    try {
        console.log(`🔵 Starting edit subscriber operation for admin: ${adminId}`);
        console.log(`   Subscriber: ${subscriberPhone}, New Quota: ${newQuota} GB`);

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

        // Get a new isolated browser context from the pool
        const contextData = await browserPool.createContext();
        context = contextData.context;
        page = contextData.page;

        // Get admin's cookies from Redis
        console.log(`🔑 Getting cookies for admin: ${adminId}`);
        const savedSession = await getSession(adminId || adminPhone);
        let cookies = null;
        let cookiesExpired = false;

        if (savedSession && savedSession.cookies && savedSession.cookies.length > 0) {
            cookies = savedSession.cookies;
            cookiesExpired = areCookiesExpired(cookies) || savedSession.needsRefresh;
            if (cookiesExpired) {
                console.log(`⚠️ Found ${cookies.length} cookies but they are expired`);
            } else {
                console.log(`✅ Found ${cookies.length} cookies in session (valid)`);
            }
        } else {
            const cookieManagerCookies = await getCookies(adminId || adminPhone);
            if (cookieManagerCookies && cookieManagerCookies.length > 0) {
                cookies = cookieManagerCookies;
                cookiesExpired = areCookiesExpired(cookies);
                if (cookiesExpired) {
                    console.log(`⚠️ Found ${cookies.length} cookies from cookieManager but they are expired`);
                } else {
                    console.log(`✅ Found ${cookies.length} cookies from cookieManager (valid)`);
                }
            }
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
            
            await delay(2000);
        } else {
            // Inject cookies before navigation
            console.log(`🔑 Injecting ${cookies.length} valid cookies...`);
            await page.setCookie(...cookies);
            console.log(`✅ Cookies injected`);
            
            // Navigate to dashboard
            console.log(`🌐 Navigating to dashboard...`);
            await page.goto(ALFA_DASHBOARD_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });
            await delay(2000);

            // Check if we're on login page
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
                
                await delay(2000);
            }
        }

        // Navigate directly to u-share page
        const ushareUrl = `${ALFA_USHARE_BASE_URL}?mobileNumber=${adminPhone}`;
        console.log(`🌐 Navigating to u-share page: ${ushareUrl}`);
        await page.goto(ushareUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });
        await delay(3000);

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
        await page.waitForSelector('button[type="submit"]#submit', { timeout: 10000 });
        await page.click('button[type="submit"]#submit');
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

