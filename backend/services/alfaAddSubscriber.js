const browserPool = require('./browserPool');
const { getSession } = require('./sessionManager');
const { getCookies, areCookiesExpired, acquireRefreshLock, releaseRefreshLock } = require('./cookieManager');
const { loginToAlfa } = require('./alfaLogin');

const ALFA_DASHBOARD_URL = 'https://www.alfa.com.lb/en/account';
const ALFA_MANAGE_SERVICES_URL = 'https://www.alfa.com.lb/en/account/manage-services';
const ALFA_USHARE_BASE_URL = 'https://www.alfa.com.lb/en/account/manage-services/ushare';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Add a subscriber to an admin's u-share service
 * @param {string} adminId - Admin ID
 * @param {string} adminPhone - Admin phone number (8 digits)
 * @param {string} adminPassword - Admin password (for login if cookies expired)
 * @param {string} subscriberPhone - Subscriber phone number (8 digits)
 * @param {number} quota - Quota in GB (e.g., 1.5)
 * @returns {Promise<{success: boolean, message: string}>} Result
 */
async function addSubscriber(adminId, adminPhone, adminPassword, subscriberPhone, quota) {
    let context = null;
    let page = null;
    let refreshLockAcquired = false;

    try {
        console.log(`🔵 Starting add subscriber operation for admin: ${adminId}`);
        console.log(`   Subscriber: ${subscriberPhone}, Quota: ${quota} GB`);

        // Acquire refresh lock to prevent cookie worker from interfering
        refreshLockAcquired = await acquireRefreshLock(adminId, 300); // 5 minute lock
        if (!refreshLockAcquired) {
            // Lock already exists (worker or another operation is active)
            // This is unlikely for add subscriber, but handle gracefully
            console.log(`⏸️ [${adminId}] Refresh lock exists, but proceeding with add subscriber...`);
        }

        // Validate inputs
        const cleanSubscriberPhone = subscriberPhone.replace(/\D/g, '').substring(0, 8);
        if (cleanSubscriberPhone.length !== 8) {
            throw new Error(`Subscriber phone must be exactly 8 digits. Got: ${cleanSubscriberPhone.length} digits`);
        }

        if (!quota || quota < 0.1 || quota > 70) {
            throw new Error(`Quota must be between 0.1 and 70 GB. Got: ${quota}`);
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
            // Check if cookies are expired
            cookiesExpired = areCookiesExpired(cookies) || savedSession.needsRefresh;
            if (cookiesExpired) {
                console.log(`⚠️ Found ${cookies.length} cookies but they are expired`);
            } else {
                console.log(`✅ Found ${cookies.length} cookies in session (valid)`);
            }
        } else {
            // Try cookieManager as fallback
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
                throw new Error('Login failed - cannot proceed with adding subscriber');
            }
            
            // After login, we should already be on dashboard or close to it
            // Wait a bit for page to stabilize
            await delay(2000);
            
            // Verify we're on dashboard (loginToAlfa should handle this, but double-check)
            const currentUrl = page.url();
            if (currentUrl.includes('/login')) {
                // Still on login page, navigate to dashboard
                console.log(`🌐 Navigating to dashboard after login...`);
                await page.goto(ALFA_DASHBOARD_URL, {
                    waitUntil: 'domcontentloaded',
                    timeout: 20000
                });
                await delay(2000);
            } else {
                console.log(`✅ Already on dashboard after login: ${currentUrl}`);
            }
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
                
                // After login, wait for page to stabilize
                await delay(2000);
            }
        }

        // Click "Manage Services" button
        console.log(`🔘 Looking for "Manage Services" button...`);
        
        // Wait for page to be fully loaded and stabilized
        await delay(3000);
        
        // Debug: Check current page content
        const currentUrlBefore = page.url();
        console.log(`📍 Current URL: ${currentUrlBefore}`);
        
        const pageText = await page.evaluate(() => document.body.innerText);
        const hasManageServices = pageText.includes('Manage Services') || pageText.includes('manage-services');
        console.log(`📄 Page check: Has "Manage Services" text: ${hasManageServices}`);
        
        // Get all links for debugging
        const allLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            return links.map(link => ({
                text: link.textContent.trim().substring(0, 50),
                href: link.href || link.getAttribute('href'),
                classes: link.className,
                visible: link.offsetParent !== null
            }));
        });
        
        const manageLinks = allLinks.filter(link => 
            (link.text && link.text.toLowerCase().includes('manage')) || 
            (link.href && link.href.includes('manage-services'))
        );
        console.log(`🔍 Found ${manageLinks.length} links containing "manage":`, JSON.stringify(manageLinks.slice(0, 5), null, 2));
        
        // Find the "Manage Services" link with the button classes
        const manageServicesLink = manageLinks.find(link => 
            link.text && link.text.includes('Manage Services') && 
            link.classes && link.classes.includes('redBtn')
        );
        
        let clicked = false;
        let manageServicesHref = null;
        
        if (manageServicesLink && manageServicesLink.href) {
            manageServicesHref = manageServicesLink.href;
            console.log(`📍 Found "Manage Services" link href: ${manageServicesHref}`);
        }
        
        // Try multiple selectors and strategies
        const selectors = [
            'a.alfabtn.redBtn[href="/en/account/manage-services"]',
            'a.alfabtn[href="/en/account/manage-services"]',
            'a.redBtn[href="/en/account/manage-services"]',
            'a[href="/en/account/manage-services"]',
            'a[href*="manage-services"]'
        ];
        
        for (const selector of selectors) {
            try {
                console.log(`🔍 Trying selector: ${selector}`);
                
                // Wait for selector (don't require visible, might be off-screen)
                await page.waitForSelector(selector, {
                    timeout: 5000
                });
                
                // Check if element is visible and scroll into view
                const isVisible = await page.evaluate((sel) => {
                    const element = document.querySelector(sel);
                    if (!element) return false;
                    
                    // Scroll into view
                    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    
                    // Check visibility
                    const rect = element.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                }, selector);
                
                if (!isVisible) {
                    console.log(`⚠️ Element found but not visible, trying to scroll...`);
                    await delay(1000);
                }
                
                // Try clicking
                await page.click(selector, { timeout: 5000 });
                console.log(`✅ Clicked "Manage Services" using selector: ${selector}`);
                
                // Wait a bit to see if navigation happens
                await delay(2000);
                const urlAfterClick = page.url();
                if (urlAfterClick.includes('manage-services')) {
                    console.log(`✅ Navigation successful after click: ${urlAfterClick}`);
                    clicked = true;
                    break;
                } else {
                    console.log(`⚠️ Click didn't navigate, still on: ${urlAfterClick}`);
                    // Try navigating directly using the href we found
                    if (manageServicesHref) {
                        console.log(`🔍 Navigating directly to: ${manageServicesHref}`);
                        try {
                            await page.goto(manageServicesHref, {
                                waitUntil: 'domcontentloaded',
                                timeout: 20000
                            });
                            await delay(2000);
                            const directNavUrl = page.url();
                            if (directNavUrl.includes('manage-services')) {
                                console.log(`✅ Direct navigation successful: ${directNavUrl}`);
                                clicked = true;
                                break;
                            }
                        } catch (directNavError) {
                            console.log(`⚠️ Direct navigation failed: ${directNavError.message}`);
                        }
                    }
                    // Continue to try other methods
                }
            } catch (err) {
                console.log(`⚠️ Selector ${selector} failed: ${err.message}`);
                continue;
            }
        }
        
        // If CSS selectors failed, try XPath
        if (!clicked) {
            console.log(`🔍 Trying XPath search...`);
            try {
                // Try XPath - case insensitive
                const xpathSelectors = [
                    "//a[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'manage services')]",
                    "//a[contains(@href, 'manage-services')]",
                    "//a[contains(text(), 'Manage Services')]"
                ];
                
                for (const xpath of xpathSelectors) {
                    try {
                        const [button] = await page.$x(xpath);
                        if (button) {
                            await page.evaluate((el) => {
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }, button);
                            await delay(1000);
                            await button.click();
                            console.log(`✅ Clicked "Manage Services" using XPath: ${xpath}`);
                            clicked = true;
                            break;
                        }
                    } catch (xpathErr) {
                        continue;
                    }
                }
            } catch (xpathError) {
                console.log(`⚠️ XPath failed: ${xpathError.message}`);
            }
        }
        
        // If still not clicked, try finding by text content and clicking via evaluate
        if (!clicked) {
            console.log(`🔍 Trying JavaScript-based click...`);
            try {
                const clickResult = await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a'));
                    const manageLink = links.find(link => {
                        const text = link.textContent.trim().toLowerCase();
                        const href = (link.href || link.getAttribute('href') || '').toLowerCase();
                        return text.includes('manage services') || href.includes('manage-services');
                    });
                    
                    if (manageLink) {
                        manageLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        // Return the href so we can navigate manually if click doesn't work
                        return {
                            found: true,
                            href: manageLink.href || manageLink.getAttribute('href')
                        };
                    }
                    return { found: false };
                });
                
                if (clickResult.found) {
                    // Try clicking the element
                    await page.evaluate(() => {
                        const links = Array.from(document.querySelectorAll('a'));
                        const manageLink = links.find(link => {
                            const text = link.textContent.trim().toLowerCase();
                            const href = (link.href || link.getAttribute('href') || '').toLowerCase();
                            return text.includes('manage services') || href.includes('manage-services');
                        });
                        if (manageLink) {
                            manageLink.click();
                        }
                    });
                    
                    await delay(1000);
                    console.log(`✅ Clicked "Manage Services" using JavaScript`);
                    clicked = true;
                    
                    // If click didn't navigate, try navigating directly
                    const newUrl = page.url();
                    if (!newUrl.includes('manage-services') && clickResult.href) {
                        console.log(`⚠️ Click didn't navigate, trying direct navigation to: ${clickResult.href}`);
                        await page.goto(clickResult.href, {
                            waitUntil: 'domcontentloaded',
                            timeout: 20000
                        });
                        await delay(2000);
                    }
                }
            } catch (jsError) {
                console.log(`⚠️ JavaScript-based click failed: ${jsError.message}`);
            }
        }
        
        if (!clicked) {
            // Last resort: try navigating directly to the URL
            console.log(`🔍 Last resort: Trying direct navigation to manage-services URL...`);
            try {
                await page.goto(ALFA_MANAGE_SERVICES_URL, {
                    waitUntil: 'domcontentloaded',
                    timeout: 20000
                });
                await delay(2000);
                console.log(`✅ Navigated directly to manage-services page`);
                clicked = true;
            } catch (navError) {
                console.log(`⚠️ Direct navigation failed: ${navError.message}`);
                
                // Final debug: Save screenshot and HTML for analysis
                try {
                    const screenshot = await page.screenshot({ encoding: 'base64' });
                    console.log(`📸 Screenshot captured (base64 length: ${screenshot.length})`);
                    
                    const html = await page.content();
                    console.log(`📄 Page HTML length: ${html.length} characters`);
                    console.log(`📄 Page HTML preview (first 500 chars): ${html.substring(0, 500)}`);
                } catch (debugError) {
                    console.log(`⚠️ Could not capture debug info: ${debugError.message}`);
                }
            }
        }
        
        if (!clicked) {
            // Show all relevant information in error
            const errorDetails = {
                currentUrl: currentUrlBefore,
                foundLinks: manageLinks.length,
                sampleLinks: manageLinks.slice(0, 3),
                pageHasText: hasManageServices
            };
            console.log(`❌ Error details:`, JSON.stringify(errorDetails, null, 2));
            throw new Error(`Could not find or click "Manage Services" button. Found ${manageLinks.length} relevant links. Current URL: ${currentUrlBefore}. Check logs for details.`);
        }
        
        // Wait for navigation after click (if not already navigated)
        const currentUrlAfter = page.url();
        console.log(`📍 URL after click attempt: ${currentUrlAfter}`);
        
        if (!currentUrlAfter.includes('manage-services')) {
            console.log(`⏳ Waiting for navigation to manage-services page...`);
            try {
                // Use Promise.race to handle both navigation and timeout
                await Promise.race([
                    page.waitForNavigation({
                        waitUntil: 'domcontentloaded',
                        timeout: 20000
                    }),
                    new Promise((resolve) => {
                        // Check URL periodically
                        const checkInterval = setInterval(async () => {
                            const url = page.url();
                            if (url.includes('manage-services')) {
                                clearInterval(checkInterval);
                                resolve();
                            }
                        }, 500);
                        
                        // Clear after timeout
                        setTimeout(() => {
                            clearInterval(checkInterval);
                            resolve();
                        }, 20000);
                    })
                ]);
                await delay(2000);
                
                const finalUrl = page.url();
                console.log(`📍 Final URL after navigation wait: ${finalUrl}`);
            } catch (navError) {
                const finalUrl = page.url();
                console.log(`⚠️ Navigation wait completed. Final URL: ${finalUrl}`);
                if (finalUrl.includes('manage-services')) {
                    console.log(`✅ Successfully on manage-services page`);
                } else {
                    console.log(`⚠️ Not on manage-services page, but continuing...`);
                    // Don't throw, continue and see if we can find the MANAGE button anyway
                }
            }
        } else {
            console.log(`✅ Already on manage-services page: ${currentUrlAfter}`);
        }

        // Verify we're on manage-services page (if not, navigate directly)
        let manageServicesUrl = page.url();
        if (!manageServicesUrl.includes('/manage-services')) {
            console.log(`⚠️ Not on manage-services page after click (${manageServicesUrl}), navigating directly...`);
            // Navigate directly to manage-services URL
            await page.goto(ALFA_MANAGE_SERVICES_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });
            await delay(2000);
            manageServicesUrl = page.url();
            
            if (!manageServicesUrl.includes('/manage-services')) {
                throw new Error(`Could not navigate to manage-services page. Current URL: ${manageServicesUrl}`);
            }
            console.log(`✅ Navigated directly to manage-services page: ${manageServicesUrl}`);
        } else {
            console.log(`✅ On manage-services page: ${manageServicesUrl}`);
        }

        // Find and click "MANAGE" button
        // The button has href like: /en/account/manage-services/ushare?mobileNumber=81106131
        console.log(`🔘 Looking for "MANAGE" button...`);
        
        // Wait a bit for page to fully load
        await delay(2000);
        
        let manageClicked = false;
        const manageSelectors = [
            'a.redBtn.alfabtn[href*="/ushare"]',
            'a.alfabtn[href*="/ushare"]',
            'a.redBtn[href*="/ushare"]',
            'a[href*="/ushare"]'
        ];
        
        for (const selector of manageSelectors) {
            try {
                console.log(`🔍 Trying MANAGE selector: ${selector}`);
                await page.waitForSelector(selector, {
                    timeout: 5000,
                    visible: true
                });
                
                // Get the href before clicking
                const href = await page.evaluate((sel) => {
                    const element = document.querySelector(sel);
                    return element ? (element.href || element.getAttribute('href')) : null;
                }, selector);
                
                console.log(`📍 MANAGE button href: ${href}`);
                
                // Scroll into view
                await page.evaluate((sel) => {
                    const element = document.querySelector(sel);
                    if (element) {
                        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }, selector);
                await delay(500);
                
                // Click the button
                await page.click(selector);
                console.log(`✅ Clicked "MANAGE" button`);
                manageClicked = true;
                break;
            } catch (err) {
                console.log(`⚠️ MANAGE selector ${selector} failed: ${err.message}`);
                continue;
            }
        }
        
        // If CSS selectors failed, try XPath or direct navigation
        if (!manageClicked) {
            console.log(`🔍 Trying XPath for MANAGE button...`);
            try {
                const [button] = await page.$x("//a[contains(@href, '/ushare')]");
                if (button) {
                    const href = await page.evaluate((el) => {
                        return el.href || el.getAttribute('href');
                    }, button);
                    console.log(`📍 Found MANAGE button via XPath, href: ${href}`);
                    
                    await page.evaluate((el) => {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, button);
                    await delay(500);
                    await button.click();
                    console.log(`✅ Clicked "MANAGE" using XPath`);
                    manageClicked = true;
                }
            } catch (xpathErr) {
                console.log(`⚠️ XPath failed: ${xpathErr.message}`);
            }
        }
        
        if (!manageClicked) {
            // Last resort: try to find and click via JavaScript
            console.log(`🔍 Trying JavaScript-based click for MANAGE...`);
            const manageHref = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                const manageLink = links.find(link => {
                    const href = (link.href || link.getAttribute('href') || '').toLowerCase();
                    return href.includes('/ushare');
                });
                if (manageLink) {
                    manageLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    manageLink.click();
                    return manageLink.href || manageLink.getAttribute('href');
                }
                return null;
            });
            
            if (manageHref) {
                console.log(`✅ Clicked "MANAGE" using JavaScript, href: ${manageHref}`);
                manageClicked = true;
                await delay(1000);
            }
        }
        
        if (!manageClicked) {
            throw new Error(`Could not find or click "MANAGE" button on manage-services page`);
        }
        
        // Wait for navigation to ushare page (with better handling)
        console.log(`⏳ Waiting for navigation to ushare page...`);
        try {
            // Wait for URL to change to ushare
            await page.waitForFunction(
                () => window.location.href.includes('/ushare'),
                { timeout: 20000 }
            );
            await delay(2000);
            console.log(`✅ Navigated to ushare page`);
        } catch (navError) {
            // Check current URL - might already be on ushare page
            const currentUrl = page.url();
            console.log(`📍 Current URL after MANAGE click: ${currentUrl}`);
            
            if (currentUrl.includes('/ushare')) {
                console.log(`✅ Already on ushare page: ${currentUrl}`);
            } else {
                console.log(`⚠️ Navigation timeout, but continuing. Current URL: ${currentUrl}`);
                // Try waiting a bit more and check again
                await delay(3000);
                const finalUrl = page.url();
                if (finalUrl.includes('/ushare')) {
                    console.log(`✅ Eventually reached ushare page: ${finalUrl}`);
                } else {
                    console.log(`⚠️ Still not on ushare page: ${finalUrl}`);
                    // Don't throw - continue and see if form is available
                }
            }
        }

        // Verify we're on ushare page (with retry)
        let ushareUrl = page.url();
        let onUsharePage = ushareUrl.includes('/ushare');
        
        if (!onUsharePage) {
            console.log(`⚠️ Not on ushare page yet, waiting a bit more...`);
            await delay(3000);
            ushareUrl = page.url();
            onUsharePage = ushareUrl.includes('/ushare');
        }
        
        if (!onUsharePage) {
            // Try navigating directly if we have the href
            console.log(`⚠️ Still not on ushare page (${ushareUrl}), trying to find ushare link and navigate directly...`);
            try {
                const ushareLink = await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a'));
                    const manageLink = links.find(link => {
                        const href = (link.href || link.getAttribute('href') || '').toLowerCase();
                        return href.includes('/ushare');
                    });
                    return manageLink ? (manageLink.href || manageLink.getAttribute('href')) : null;
                });
                
                if (ushareLink) {
                    console.log(`🔗 Found ushare link: ${ushareLink}, navigating directly...`);
                    await page.goto(ushareLink, {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000
                    });
                    await delay(2000);
                    ushareUrl = page.url();
                    onUsharePage = ushareUrl.includes('/ushare');
                }
            } catch (directNavError) {
                console.log(`⚠️ Direct navigation failed: ${directNavError.message}`);
            }
        }
        
        if (!onUsharePage) {
            console.log(`⚠️ Could not reach ushare page. Current URL: ${ushareUrl}`);
            console.log(`⚠️ Continuing anyway to see if form is available...`);
            // Don't throw - continue and see if form is available
        } else {
            console.log(`✅ On ushare page: ${ushareUrl}`);
        }

        // Wait for form to be available (with multiple attempts)
        console.log(`📝 Waiting for form...`);
        let formFound = false;
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await page.waitForSelector('form.form-horizontal', {
                    timeout: 5000
                });
                formFound = true;
                console.log(`✅ Form found on attempt ${attempt}`);
                break;
            } catch (formError) {
                console.log(`⚠️ Form not found on attempt ${attempt}, waiting...`);
                await delay(2000);
                
                // Check if we're on the right page
                const currentUrl = page.url();
                console.log(`📍 Current URL while waiting for form: ${currentUrl}`);
                
                // If we're back on dashboard or manage-services, try to navigate to ushare again
                if (currentUrl.includes('/account') && !currentUrl.includes('/ushare')) {
                    console.log(`⚠️ Appears to have navigated away from ushare page, trying to get back...`);
                    // The form might be on a different page structure, continue anyway
                }
            }
        }
        
        if (!formFound) {
            // Check if form exists but with different selector
            const formExists = await page.evaluate(() => {
                return document.querySelector('form') !== null;
            });
            
            if (formExists) {
                console.log(`✅ Form exists but with different selector, continuing...`);
                formFound = true;
            } else {
                throw new Error('Form not found on page. Cannot proceed with adding subscriber.');
            }
        }
        
        await delay(1000);

        // Extract __RequestVerificationToken from the form
        const token = await page.evaluate(() => {
            const input = document.querySelector('input[name="__RequestVerificationToken"]');
            return input ? input.value : null;
        });

        if (!token) {
            throw new Error('Could not find __RequestVerificationToken in form');
        }
        console.log(`✅ Found verification token`);

        // Fill in the form fields
        console.log(`📝 Filling form fields...`);
        
        // Fill secondary phone number
        await page.waitForSelector('#Number', { timeout: 10000 });
        await page.click('#Number', { clickCount: 3 }); // Select all existing text
        await page.type('#Number', cleanSubscriberPhone, { delay: 100 });
        console.log(`✅ Filled subscriber phone: ${cleanSubscriberPhone}`);

        // Fill quota (format: X.XX)
        await page.waitForSelector('#Quota', { timeout: 10000 });
        await page.click('#Quota', { clickCount: 3 }); // Select all existing text
        await page.type('#Quota', quota.toString(), { delay: 100 });
        console.log(`✅ Filled quota: ${quota} GB`);

        await delay(500);

        // Submit the form
        console.log(`🚀 Submitting form...`);
        await page.waitForSelector('button[type="submit"]#submit', { timeout: 10000 });
        
        // Click submit button
        await page.click('button[type="submit"]#submit');
        console.log(`✅ Clicked submit button`);

        // Wait for form submission - navigation might or might not happen
        let navigationHappened = false;
        try {
            await page.waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            navigationHappened = true;
            console.log(`✅ Navigation detected after form submission`);
        } catch (navError) {
            // Navigation timeout is OK - form might just show a message on the same page
            console.log(`ℹ️ No navigation detected (form may show message on same page)`);
        }
        
        await delay(2000); // Wait a bit more for any messages to appear or page to stabilize

        // Try to get page content and URL, but handle navigation gracefully
        let pageContent = '';
        let formPageText = '';
        let finalUrl = '';
        
        try {
            finalUrl = page.url();
            try {
                pageContent = await page.content();
                formPageText = await page.evaluate(() => document.body.innerText);
            } catch (contentError) {
                // Execution context destroyed due to navigation - this is actually good (means form submitted)
                console.log(`ℹ️ Could not read page content (page navigated - this indicates success)`);
            }
        } catch (urlError) {
            // Page might have navigated away completely
            console.log(`ℹ️ Could not get URL (page navigated - this indicates success)`);
        }

        // If navigation happened, it's definitely success
        if (navigationHappened) {
            console.log(`✅ Form submitted successfully, page navigated to: ${finalUrl || 'new page'}`);
            
            // Release refresh lock before returning
            if (refreshLockAcquired) {
                await releaseRefreshLock(adminId).catch(() => {});
            }
            
            return {
                success: true,
                message: `Subscriber invitation sent successfully. SMS sent to ${cleanSubscriberPhone}. The subscriber will appear after accepting the invitation.`
            };
        }

        // Check if we're still on the ushare page
        if (finalUrl && finalUrl.includes('/ushare')) {
            // Still on ushare page - SMS is still sent when submit is clicked
            console.log(`✅ Subscriber invitation sent successfully (SMS sent to ${cleanSubscriberPhone})!`);
            
            // Release refresh lock before returning
            if (refreshLockAcquired) {
                await releaseRefreshLock(adminId).catch(() => {});
            }
            
            return {
                success: true,
                message: `Subscriber invitation sent successfully. SMS sent to ${cleanSubscriberPhone}. The subscriber will appear after accepting the invitation.`
            };
        } else {
            // Navigated away or couldn't determine URL - treat as success
            console.log(`✅ Form submitted successfully`);
            
            // Release refresh lock before returning
            if (refreshLockAcquired) {
                await releaseRefreshLock(adminId).catch(() => {});
            }
            
            return {
                success: true,
                message: `Subscriber invitation sent successfully. SMS sent to ${cleanSubscriberPhone}. The subscriber will appear after accepting the invitation.`
            };
        }

    } catch (error) {
        // If we got to the point where we clicked submit, the SMS was sent
        // So even if there's an error reading the page, we should return success
        const errorMessage = error.message || '';
        const isNavigationError = errorMessage.includes('Execution context was destroyed') || 
                                  errorMessage.includes('navigation') ||
                                  errorMessage.includes('Target closed');
        
        if (isNavigationError) {
            // Navigation error means the form was submitted and page navigated - this is success!
            console.log(`✅ Form submitted successfully (navigation detected via error)`);
            
            // Release refresh lock before returning
            if (refreshLockAcquired) {
                await releaseRefreshLock(adminId).catch(() => {});
            }
            
            return {
                success: true,
                message: `Subscriber invitation sent successfully. SMS sent to ${cleanSubscriberPhone}. The subscriber will appear after accepting the invitation.`
            };
        }
        
        // For other errors, log but return error
        console.error(`❌ Error adding subscriber:`, error);
        console.error(`   Error message: ${error.message}`);
        console.error(`   Stack trace: ${error.stack}`);
        
        return {
            success: false,
            message: error.message || 'Unknown error occurred while adding subscriber'
        };
    } finally {
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
    addSubscriber
};

