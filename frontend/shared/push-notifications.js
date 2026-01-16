/**
 * Push Notifications Manager
 * Handles browser push notifications, subscription, and notification panel
 */

class PushNotificationManager {
    constructor() {
        this.subscription = null;
        this.isEnabled = false;
        this.vapidPublicKey = null;
        this.checkInterval = null;
        this.notifications = [];
        this.baseURL = window.ALFA_API_URL || 'http://localhost:3000';
        
        // Inject notification UI if not present
        this.injectNotificationUI();
        
        this.init();
    }
    
    injectNotificationUI() {
        // Inject notification link in mobile sidebar (if not already present)
        if (!document.getElementById('mobileNotificationButton')) {
            this.injectMobileSidebarNotification();
        }
        
        // Inject notification icon in top bar for desktop (if nav-right exists and button not present)
        const navRight = document.querySelector('.nav-right');
        if (navRight && !document.getElementById('notificationToggle')) {
            const themeToggle = document.getElementById('themeToggle');
            if (themeToggle) {
                // Create notification icon button for desktop
                const notificationButton = document.createElement('button');
                notificationButton.className = 'notification-toggle';
                notificationButton.id = 'notificationToggle';
                notificationButton.setAttribute('aria-label', 'Notifications');
                notificationButton.innerHTML = `
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="notification-badge" id="notificationBadge" style="display: none;">0</span>
                `;
                // Insert before theme toggle
                navRight.insertBefore(notificationButton, themeToggle);
            }
        }
        
        // Inject notification panel HTML if not present
        if (!document.getElementById('notificationPanel')) {
            const panelHTML = `
                <div id="notificationPanel" class="notification-panel">
                    <div class="notification-panel-header">
                        <h2>Notifications</h2>
                        <button class="notification-panel-close" id="notificationPanelClose">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    
                    <div class="notification-panel-content">
                        <div class="notification-toggle-section">
                            <div class="notification-toggle-header">
                                <span>Push Notifications</span>
                                <div class="toggle-switch-container">
                                    <input type="checkbox" id="pushNotificationToggle" class="toggle-switch-input">
                                    <label for="pushNotificationToggle" class="toggle-switch-label">
                                        <span class="toggle-switch-slider"></span>
                                    </label>
                                </div>
                            </div>
                            <p class="notification-toggle-description">Receive notifications about expiring admins and high consumption even when you're away</p>
                        </div>
                        
                        <div class="notification-list-section">
                            <div class="notification-list-header">
                                <h3>Recent Notifications</h3>
                                <button id="deleteAllNotifications" class="delete-all-btn" style="display: none;">Delete All</button>
                            </div>
                            <div id="notificationList" class="notification-list">
                                <div class="notification-empty">No notifications yet</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div id="notificationPanelOverlay" class="notification-panel-overlay"></div>
            `;
            
            document.body.insertAdjacentHTML('beforeend', panelHTML);
        }
    }
    
    injectMobileSidebarNotification() {
        // Find mobile sidebar actions container (where theme toggle and avatar are)
        const mobileSidebarActions = document.querySelector('.mobile-sidebar-actions');
        if (!mobileSidebarActions) {
            console.warn('mobile-sidebar-actions not found, cannot inject notification button');
            return;
        }
        
        // Check if already exists
        if (document.getElementById('mobileNotificationButton')) {
            return;
        }
        
        // Create notification button (similar to theme toggle button)
        const notificationButton = document.createElement('button');
        notificationButton.className = 'mobile-sidebar-notification';
        notificationButton.id = 'mobileNotificationButton';
        notificationButton.setAttribute('aria-label', 'Notifications');
        notificationButton.style.position = 'relative';
        notificationButton.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            <span class="notification-badge-mobile" id="notificationBadgeMobile" style="display: none; position: absolute; top: -4px; right: -4px; background: #ef4444; color: white; border-radius: 10px; padding: 0.125rem 0.375rem; font-size: 0.625rem; font-weight: 700; min-width: 18px; height: 18px; text-align: center; display: flex; align-items: center; justify-content: center; border: 2px solid rgba(15, 15, 20, 0.95);">0</span>
        `;
        
        // Add click handler
        notificationButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openPanel();
            // Close mobile sidebar
            const mobileMenuCheck = document.getElementById('mobileMenuCheck');
            if (mobileMenuCheck) {
                mobileMenuCheck.checked = false;
            }
        });
        
        // Insert before theme toggle button
        const themeToggle = document.getElementById('mobileThemeToggle');
        if (themeToggle && themeToggle.parentElement) {
            mobileSidebarActions.insertBefore(notificationButton, themeToggle);
        } else {
            // If theme toggle not found, prepend to actions
            mobileSidebarActions.insertBefore(notificationButton, mobileSidebarActions.firstChild);
        }
    }
    
    async init() {
        // Wait for auth to be ready
        await this.waitForAuth();
        
        // Initialize UI (but don't set toggle state yet)
        this.initUI();
        
        // Get VAPID public key from backend
        await this.fetchVapidKey();
        
        // Check if service worker is supported
        if ('serviceWorker' in navigator && 'PushManager' in window) {
            // Check for Opera browser - it may have PushManager but push service may not work
            const userAgent = navigator.userAgent.toLowerCase();
            const isOpera = userAgent.includes('opera') || userAgent.includes('opr/');
            
            if (isOpera) {
                console.warn('⚠️ Opera browser detected. Push notifications may not work properly in Opera.');
                console.warn('   For best results, please use Chrome, Firefox, or Edge browser.');
                // Still try to initialize, but warn user
                const toggle = document.getElementById('pushNotificationToggle');
                if (toggle) {
                    toggle.disabled = false; // Allow user to try, but it may fail
                }
            }
            
            // Register service worker
            await this.registerServiceWorker();
            
            // Listen for messages from service worker
            navigator.serviceWorker.addEventListener('message', (event) => {
                this.handleServiceWorkerMessage(event);
            });
            
            // Check existing subscription and update toggle state
            // This MUST happen after service worker is ready
            await this.checkSubscription();
        } else {
            console.warn('Push notifications are not supported in this browser');
            this.disablePushUI();
        }
        
        // Start periodic checks for expiring/high consumption admins
        this.startPeriodicChecks();
        
        // Load initial notifications count - wait for authentication first
        this.waitForAuth().then(() => {
            this.updateBadgeCount();
        }).catch(() => {
            console.warn('⚠️ User not authenticated yet, skipping initial badge count update');
        });
    }
    
    async waitForAuth() {
        let attempts = 0;
        while (attempts < 50) {
            if (typeof auth !== 'undefined' && auth && auth.currentUser) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        // If we get here, authentication hasn't completed after 5 seconds
        // Throw an error so callers can handle it gracefully
        throw new Error('Authentication timeout');
    }
    
    initUI() {
        const toggle = document.getElementById('pushNotificationToggle');
        const panelToggle = document.getElementById('notificationToggle');
        const mobileNotificationButton = document.getElementById('mobileNotificationButton');
        const panel = document.getElementById('notificationPanel');
        const overlay = document.getElementById('notificationPanelOverlay');
        const closeBtn = document.getElementById('notificationPanelClose');
        const deleteAllBtn = document.getElementById('deleteAllNotifications');
        
        // Don't set toggle state here - wait for checkSubscription to set it
        // This prevents the toggle from being reset to unchecked on page load
        if (toggle) {
            toggle.addEventListener('change', async (e) => {
                console.log('🔄 Toggle changed to:', e.target.checked);
                if (e.target.checked) {
                    try {
                        await this.enablePushNotifications();
                    } catch (error) {
                        console.error('❌ Failed to enable push notifications:', error);
                        // Reset toggle if enable failed
                        e.target.checked = false;
                    }
                } else {
                    await this.disablePushNotifications();
                }
            });
        }
        
        if (panelToggle) {
            panelToggle.addEventListener('click', () => {
                this.openPanel();
            });
        }
        
        if (mobileNotificationButton) {
            mobileNotificationButton.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openPanel();
                // Close mobile sidebar
                const mobileMenuCheck = document.getElementById('mobileMenuCheck');
                if (mobileMenuCheck) {
                    mobileMenuCheck.checked = false;
                }
            });
        }
        
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.closePanel();
            });
        }
        
        if (overlay) {
            overlay.addEventListener('click', () => {
                this.closePanel();
            });
        }
        
        if (deleteAllBtn) {
            deleteAllBtn.addEventListener('click', async () => {
                await this.deleteAllNotifications();
            });
        }
    }
    
    openPanel() {
        const panel = document.getElementById('notificationPanel');
        const overlay = document.getElementById('notificationPanelOverlay');
        if (panel) panel.classList.add('active');
        if (overlay) overlay.classList.add('active');
        this.loadNotifications();
    }
    
    closePanel() {
        const panel = document.getElementById('notificationPanel');
        const overlay = document.getElementById('notificationPanelOverlay');
        if (panel) panel.classList.remove('active');
        if (overlay) overlay.classList.remove('active');
    }
    
    async fetchVapidKey() {
        try {
            const response = await fetch(`${this.baseURL}/api/push/vapid-public-key`);
            if (response.ok) {
                const data = await response.json();
                this.vapidPublicKey = data.key;
            }
        } catch (error) {
            console.error('Failed to fetch VAPID key:', error);
        }
    }
    
    async registerServiceWorker() {
        try {
            // First, check if service worker file exists
            const swCheck = await fetch('/service-worker.js', { method: 'HEAD' });
            if (!swCheck.ok) {
                console.log('[SW] Service Worker file not found, skipping registration');
                return null;
            }
            
            // First, check if there are any existing service workers and unregister them if needed
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (let registration of registrations) {
                // Check if this registration is from a different origin (like localhost)
                if (registration.scope.includes('localhost')) {
                    console.log('[SW] Unregistering service worker from different origin:', registration.scope);
                    await registration.unregister();
                }
            }
            
            // Register new service worker
            const registration = await navigator.serviceWorker.register('/service-worker.js', {
                updateViaCache: 'none' // Always check for updates
            });
            
            console.log('[SW] Service Worker registered:', registration);
            
            // Listen for service worker updates
            registration.addEventListener('updatefound', () => {
                const newWorker = registration.installing;
                if (newWorker) {
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            // New service worker available, force reload
                            console.log('[SW] New service worker installed, reloading page...');
                            window.location.reload();
                        }
                    });
                }
            });
            
            // Listen for messages from service worker
            navigator.serviceWorker.addEventListener('message', (event) => {
                this.handleServiceWorkerMessage(event);
            });
            
            // Check for updates every 60 seconds (with error handling)
            setInterval(() => {
                registration.update().catch((updateError) => {
                    // Silently handle update errors (file might not exist)
                    if (updateError.message && !updateError.message.includes('404') && !updateError.message.includes('not found')) {
                        console.warn('[SW] Service Worker update check failed:', updateError.message);
                    }
                });
            }, 60000);
            
            return registration;
        } catch (error) {
            console.error('[SW] Service Worker registration failed:', error);
            return null;
        }
    }
    
    async checkSubscription() {
        try {
            // Wait for service worker to be ready
            const registration = await navigator.serviceWorker.ready;
            
            // Check if we have an active subscription
            this.subscription = await registration.pushManager.getSubscription();
            
            // Also check backend to see if subscription is stored there
            // This helps sync state if service worker was cleared but backend still has it
            let backendHasSubscription = false;
            try {
                const token = await this.getIdToken();
                const response = await fetch(`${this.baseURL}/api/push/subscription-status`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (response.ok) {
                    const data = await response.json();
                    backendHasSubscription = data.hasSubscription === true;
                    console.log('🔍 Backend subscription check:', backendHasSubscription);
                } else {
                    console.warn('⚠️ Backend subscription check failed:', response.status);
                }
            } catch (e) {
                console.warn('⚠️ Backend subscription check error:', e.message);
            }
            
            // Subscription exists if we have it in service worker OR backend
            const hasSubscription = !!this.subscription || backendHasSubscription;
            
            // Update toggle state based on subscription status
            const toggle = document.getElementById('pushNotificationToggle');
            if (toggle) {
                // Force update the toggle state
                toggle.checked = hasSubscription;
                // Also set the checked attribute to ensure it persists
                if (hasSubscription) {
                    toggle.setAttribute('checked', 'checked');
                } else {
                    toggle.removeAttribute('checked');
                }
                console.log('🔄 Setting toggle to:', hasSubscription, '(SW:', !!this.subscription, ', Backend:', backendHasSubscription, ')');
            } else {
                console.warn('⚠️ Toggle element not found when trying to set state');
            }
            
            this.isEnabled = hasSubscription;
            
            if (this.subscription) {
                console.log('✅ Existing push subscription found in service worker');
            } else if (backendHasSubscription) {
                console.log('ℹ️ Subscription found in backend but not in service worker - toggle will stay on');
            } else {
                console.log('ℹ️ No push subscription found - toggle will be off');
            }
        } catch (error) {
            console.error('❌ Error checking subscription:', error);
            const toggle = document.getElementById('pushNotificationToggle');
            if (toggle) {
                toggle.checked = false;
            }
            this.isEnabled = false;
        }
    }
    
    async enablePushNotifications() {
        console.log('🔵 enablePushNotifications() called');
        
        if (!('Notification' in window)) {
            console.error('❌ Notifications not supported');
            alert('This browser does not support notifications');
            return;
        }
        
        console.log('🔵 Checking notification permission...');
        // Request permission
        const permission = await Notification.requestPermission();
        console.log('🔵 Permission result:', permission);
        
        if (permission !== 'granted') {
            console.error('❌ Notification permission denied:', permission);
            alert('Notification permission denied');
            const toggle = document.getElementById('pushNotificationToggle');
            if (toggle) toggle.checked = false;
            return;
        }
        
        try {
            console.log('🔵 Getting service worker registration...');
            // Register service worker if not already
            const registration = await navigator.serviceWorker.ready;
            console.log('🔵 Service worker ready');
            
            if (!this.vapidPublicKey) {
                console.log('🔵 Fetching VAPID key...');
                await this.fetchVapidKey();
            }
            
            if (!this.vapidPublicKey) {
                throw new Error('VAPID key not available');
            }
            console.log('🔵 VAPID key available');
            
            console.log('🔵 Subscribing to push manager...');
            console.log('🔵 VAPID public key:', this.vapidPublicKey ? this.vapidPublicKey.substring(0, 20) + '...' : 'NOT SET');
            
            // Subscribe to push notifications
            try {
                const applicationServerKey = this.urlBase64ToUint8Array(this.vapidPublicKey);
                this.subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: applicationServerKey
                });
                console.log('🔵 Push subscription created successfully');
            } catch (subscribeError) {
                console.error('❌ Push subscription error:', subscribeError);
                console.error('❌ Error name:', subscribeError.name);
                console.error('❌ Error message:', subscribeError.message);
                
                // Browser-specific error handling
                const userAgent = navigator.userAgent.toLowerCase();
                let errorMessage = 'Failed to enable push notifications. ';
                
                // Check for storage errors (often happens in private/incognito mode)
                // Check both error name and message for storage-related errors
                const isStorageError = (subscribeError.name === 'AbortError' || subscribeError.name === 'DOMException') &&
                                      subscribeError.message && 
                                      (subscribeError.message.toLowerCase().includes('storage') || 
                                       subscribeError.message.toLowerCase().includes('quota') ||
                                       subscribeError.message.toLowerCase().includes('indexeddb'));
                
                if (isStorageError) {
                    errorMessage += '\n\n⚠️ STORAGE ERROR DETECTED:\n';
                    errorMessage += 'This error usually occurs when:\n';
                    errorMessage += '1. You are in Private/Incognito browsing mode\n';
                    errorMessage += '2. Browser storage (IndexedDB) is disabled\n';
                    errorMessage += '3. Browser storage quota is exceeded\n';
                    errorMessage += '4. Browser extensions are blocking storage\n\n';
                    errorMessage += 'SOLUTIONS:\n';
                    errorMessage += '✅ Exit Private/Incognito mode and use a regular window\n';
                    errorMessage += '✅ Enable browser storage in settings\n';
                    errorMessage += '✅ Clear browser cache and storage, then try again\n';
                    errorMessage += '✅ Disable browser extensions that block storage\n';
                    errorMessage += '✅ Try a different browser (Chrome, Firefox, Edge)\n\n';
                    errorMessage += 'NOTE: Push notifications require browser storage to work.';
                } else if (userAgent.includes('opera') || userAgent.includes('opr/')) {
                    errorMessage += '\n\n⚠️ OPERA BROWSER LIMITATION:\n';
                    errorMessage += 'Unfortunately, Opera browser does not fully support Web Push notifications.\n';
                    errorMessage += 'Even with proper settings, Opera\'s push service backend may reject registrations.\n\n';
                    errorMessage += 'RECOMMENDED SOLUTION:\n';
                    errorMessage += '✅ Use Chrome, Firefox, or Microsoft Edge for push notifications\n';
                    errorMessage += '   These browsers have full, reliable push notification support\n\n';
                    errorMessage += 'If you must use Opera, try:\n';
                    errorMessage += '1. Update Opera to the latest version\n';
                    errorMessage += '2. Go to Settings → Privacy & security → Site Settings → Notifications\n';
                    errorMessage += '3. Enable "Sites can ask to send notifications"\n';
                    errorMessage += '⚠️ Note: This may still not work due to Opera\'s limitations';
                } else if (userAgent.includes('brave')) {
                    errorMessage += '\n\nFor Brave browser:\n';
                    errorMessage += '1. Go to brave://settings/privacy\n';
                    errorMessage += '2. Enable "Use Google services for push messaging"\n';
                    errorMessage += '3. Refresh this page and try again';
                } else {
                    errorMessage += 'Please check your browser settings to allow notifications for this site.';
                }
                
                alert(errorMessage);
                const toggle = document.getElementById('pushNotificationToggle');
                if (toggle) toggle.checked = false;
                throw subscribeError;
            }
            
            // Send subscription to server
            console.log('📤 About to send subscription to server...');
            await this.sendSubscriptionToServer(this.subscription);
            console.log('✅ Subscription successfully sent to server');
            
            // Verify subscription was saved by checking backend
            try {
                const token = await this.getIdToken();
                const verifyResponse = await fetch(`${this.baseURL}/api/push/subscription-status`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (verifyResponse.ok) {
                    const verifyData = await verifyResponse.json();
                    console.log('✅ Verified subscription saved in backend:', verifyData.hasSubscription);
                    if (!verifyData.hasSubscription) {
                        console.warn('⚠️ Subscription sent but not found in backend - may need to retry');
                    }
                }
            } catch (verifyError) {
                console.warn('⚠️ Could not verify subscription:', verifyError);
            }
            
            this.isEnabled = true;
            
            console.log('✅ Push notifications enabled');
            
            // Show success message
            if (typeof notification !== 'undefined') {
                notification.success('Push notifications enabled');
            }
            
        } catch (error) {
            console.error('❌ Error enabling push notifications:', error);
            console.error('❌ Error stack:', error.stack);
            const toggle = document.getElementById('pushNotificationToggle');
            if (toggle) toggle.checked = false;
            this.isEnabled = false;
            
            if (typeof notification !== 'undefined') {
                notification.error('Failed to enable push notifications');
            }
        }
    }
    
    async disablePushNotifications() {
        try {
            if (this.subscription) {
                await this.subscription.unsubscribe();
                await this.removeSubscriptionFromServer(this.subscription);
                this.subscription = null;
            }
            
            this.isEnabled = false;
            
            console.log('✅ Push notifications disabled');
            
            if (typeof notification !== 'undefined') {
                notification.success('Push notifications disabled');
            }
            
        } catch (error) {
            console.error('Error disabling push notifications:', error);
        }
    }
    
    async sendSubscriptionToServer(subscription) {
        try {
            const token = await this.getIdToken();
            const subscriptionData = subscription.toJSON();
            console.log('📤 Sending subscription to server...', { endpoint: subscriptionData.endpoint?.substring(0, 50) + '...' });
            
            const response = await fetch(`${this.baseURL}/api/push/subscribe`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    subscription: subscriptionData
                })
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('❌ Server response not OK:', response.status, errorText);
                throw new Error(`Failed to send subscription to server: ${response.status}`);
            }
            
            const result = await response.json();
            console.log('✅ Subscription sent to server successfully:', result);
            return result;
        } catch (error) {
            console.error('❌ Error sending subscription to server:', error);
            throw error;
        }
    }
    
    async removeSubscriptionFromServer(subscription) {
        try {
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/push/unsubscribe`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    endpoint: subscription.endpoint
                })
            });
            
            return response.ok;
        } catch (error) {
            console.error('Error removing subscription from server:', error);
            return false;
        }
    }
    
    async getIdToken() {
        if (typeof auth !== 'undefined' && auth && auth.currentUser) {
            return await auth.currentUser.getIdToken();
        }
        throw new Error('User not authenticated');
    }
    
    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/\-/g, '+')
            .replace(/_/g, '/');
        
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }
    
    startPeriodicChecks() {
        // Check every 5 minutes for expiring/high consumption admins
        // The backend cron job handles most of this, but we can also trigger checks
        this.checkInterval = setInterval(() => {
            if (this.isEnabled) {
                // Only update if user is authenticated
                if (typeof auth !== 'undefined' && auth && auth.currentUser) {
                    this.updateBadgeCount();
                }
            }
        }, 5 * 60 * 1000); // 5 minutes
        
        // Initial check - wait for authentication first
        this.waitForAuth().then(() => {
            setTimeout(() => this.updateBadgeCount(), 5000); // Check after 5 seconds
        }).catch(() => {
            // User not authenticated yet, skip initial check
            // The main init() method will handle the initial badge update
        });
    }
    
    async updateBadgeCount() {
        try {
            const count = await this.getNotificationCount();
            // Update desktop badge
            const badge = document.getElementById('notificationBadge');
            if (badge) {
                if (count > 0) {
                    badge.textContent = count > 99 ? '99+' : count.toString();
                    badge.style.display = 'flex';
                } else {
                    badge.style.display = 'none';
                }
            }
            // Update mobile sidebar badge
            const mobileBadge = document.getElementById('notificationBadgeMobile');
            if (mobileBadge) {
                if (count > 0) {
                    mobileBadge.textContent = count > 99 ? '99+' : count.toString();
                    mobileBadge.style.display = 'inline-flex';
                } else {
                    mobileBadge.style.display = 'none';
                }
            }
        } catch (error) {
            console.error('Error updating badge count:', error);
        }
    }
    
    async getNotificationCount() {
        try {
            // Check if user is authenticated before trying to get token
            if (typeof auth === 'undefined' || !auth || !auth.currentUser) {
                return 0; // Return 0 if not authenticated (don't log error)
            }
            
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/push/notifications`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                const notifications = data.notifications || [];
                return notifications.filter(n => !n.read).length;
            }
            return 0;
        } catch (error) {
            // Only log error if it's not an authentication error (which is expected on page load)
            if (error.message !== 'User not authenticated') {
                console.error('Error getting notification count:', error);
            }
            return 0;
        }
    }
    
    async loadNotifications() {
        try {
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/push/notifications`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                this.notifications = data.notifications || [];
                this.renderNotifications();
                this.updateBadge();
            }
        } catch (error) {
            console.error('Error loading notifications:', error);
        }
    }
    
    renderNotifications() {
        const list = document.getElementById('notificationList');
        const deleteAllBtn = document.getElementById('deleteAllNotifications');
        
        if (!list) return;
        
        if (this.notifications.length === 0) {
            list.innerHTML = '<div class="notification-empty">No notifications yet</div>';
            if (deleteAllBtn) deleteAllBtn.style.display = 'none';
            return;
        }
        
        // Show delete all button if there are notifications
        if (deleteAllBtn) deleteAllBtn.style.display = 'inline-block';
        
        list.innerHTML = this.notifications.map(notif => {
            const time = new Date(notif.timestamp).toLocaleString();
            const typeClass = notif.type === 'expiring' ? 'expiring' : 'high-consumption';
            
            return `
                <div class="notification-item ${typeClass}">
                    <div class="notification-item-header">
                        <h4 class="notification-item-title">${notif.title}</h4>
                        <span class="notification-item-time">${time}</span>
                    </div>
                    <p class="notification-item-message">${notif.message}</p>
                </div>
            `;
        }).join('');
    }
    
    async deleteAllNotifications() {
        try {
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/push/notifications/delete-all`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (response.ok) {
                console.log('✅ All notifications deleted');
                this.notifications = [];
                this.renderNotifications();
                this.updateBadge();
            } else {
                console.error('❌ Failed to delete notifications');
            }
        } catch (error) {
            console.error('Error deleting notifications:', error);
        }
    }
    
    handleServiceWorkerMessage(event) {
        const { type, text, url } = event.data || {};
        
        switch (type) {
            case 'SW_UPDATED':
                console.log('[SW] Service worker updated to:', event.data.cacheVersion);
                // Force reload to get new files
                setTimeout(() => {
                    window.location.reload();
                }, 1000);
                break;
            case 'COPY_TO_CLIPBOARD':
                if (text) {
                    this.copyToClipboard(text);
                }
                break;
            case 'OPEN_WHATSAPP':
                if (url) {
                    window.open(url, '_blank');
                }
                break;
            default:
                console.log('Unknown service worker message type:', type);
        }
    }
    
    async copyToClipboard(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                console.log('✅ Notification message copied to clipboard:', text);
            } else {
                // Fallback for older browsers
                this.fallbackCopyToClipboard(text);
            }
        } catch (err) {
            console.error('❌ Failed to copy to clipboard:', err);
            // Try fallback method
            this.fallbackCopyToClipboard(text);
        }
    }
    
    fallbackCopyToClipboard(text) {
        try {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);
            if (successful) {
                console.log('✅ Notification message copied to clipboard (fallback method):', text);
            } else {
                console.warn('⚠️ Failed to copy to clipboard using fallback method');
            }
        } catch (err) {
            console.error('❌ Error copying to clipboard (fallback):', err);
        }
    }
    
    updateBadge() {
        const unreadCount = this.notifications.filter(n => !n.read).length;
        // Update desktop badge
        const badge = document.getElementById('notificationBadge');
        if (badge) {
            if (unreadCount > 0) {
                badge.textContent = unreadCount > 99 ? '99+' : unreadCount.toString();
                badge.style.display = 'flex';
            } else {
                badge.style.display = 'none';
            }
        }
        // Update mobile sidebar badge
        const mobileBadge = document.getElementById('notificationBadgeMobile');
        if (mobileBadge) {
            if (unreadCount > 0) {
                mobileBadge.textContent = unreadCount > 99 ? '99+' : unreadCount.toString();
                mobileBadge.style.display = 'inline-flex';
            } else {
                mobileBadge.style.display = 'none';
            }
        }
    }
    
    disablePushUI() {
        const toggle = document.getElementById('pushNotificationToggle');
        const panelToggle = document.getElementById('notificationToggle');
        if (toggle) {
            toggle.disabled = true;
            toggle.checked = false;
        }
        if (panelToggle) {
            panelToggle.style.opacity = '0.5';
            panelToggle.style.cursor = 'not-allowed';
        }
    }
}

// Initialize when DOM is ready
let pushNotificationManager;
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        pushNotificationManager = new PushNotificationManager();
    });
} else {
    pushNotificationManager = new PushNotificationManager();
}
