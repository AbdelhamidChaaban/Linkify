/**
 * Service Worker for Push Notifications
 * Handles background push events and displays notifications
 */

const CACHE_NAME = 'linkify-v4'; // Updated to force cache refresh - v4: cache-first strategy for instant navigation
const FORCE_UPDATE = true; // Set to true to force immediate update

// Install event - cache assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker v3...');
    // Skip waiting to activate immediately
    self.skipWaiting();
    
    event.waitUntil(
        // Delete ALL old caches first
        caches.keys().then((cacheNames) => {
            console.log('[SW] Found caches:', cacheNames);
            return Promise.all(
                cacheNames.map((cacheName) => {
                    console.log('[SW] Deleting old cache:', cacheName);
                    return caches.delete(cacheName);
                })
            );
        }).then(() => {
            // Open new cache
            return caches.open(CACHE_NAME);
        }).then((cache) => {
            console.log('[SW] New cache opened:', CACHE_NAME);
            // Don't cache files during install - we'll cache on demand
            return Promise.resolve();
        })
        .catch((error) => {
            console.error('[SW] Cache error during install:', error);
        })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker v3...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            console.log('[SW] Checking for old caches to delete...');
            const deletePromises = cacheNames.map((cacheName) => {
                if (cacheName !== CACHE_NAME) {
                    console.log('[SW] Deleting old cache:', cacheName);
                    return caches.delete(cacheName);
                }
            }).filter(p => p !== undefined);
            
            return Promise.all(deletePromises).then(() => {
                console.log('[SW] All old caches deleted');
                // Take control of all pages immediately
                return self.clients.claim();
            }).then(() => {
                console.log('[SW] Service worker activated and controlling clients');
                // Notify all clients about the update
                return self.clients.matchAll().then((clients) => {
                    clients.forEach((client) => {
                        client.postMessage({
                            type: 'SW_UPDATED',
                            cacheVersion: CACHE_NAME
                        });
                    });
                });
            });
        })
    );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    // Only handle GET requests
    if (event.request.method !== 'GET') {
        return;
    }
    
    // Don't cache API requests or browser extension URLs
    if (event.request.url.includes('/api/') || 
        event.request.url.startsWith('chrome-extension://') ||
        event.request.url.startsWith('moz-extension://')) {
        return;
    }
    
    // Only handle same-origin requests
    try {
        const url = new URL(event.request.url);
        if (url.origin !== self.location.origin) {
            return;
        }
    } catch (e) {
        // Invalid URL, skip
        return;
    }
    
    // Check if this is an HTML, CSS, or JS file - use cache-first for instant navigation
    const url = new URL(event.request.url);
    const isHTML = url.pathname.match(/\.(html|htm)$/i);
    const isStaticAsset = url.pathname.match(/\.(css|js)$/i);
    
    if (isHTML || isStaticAsset) {
        // Cache-first strategy: Serve from cache immediately, update in background
        // This makes navigation instant while still keeping content fresh
        event.respondWith(
            caches.match(event.request)
                .then((cachedResponse) => {
                    // If we have a cached version, return it immediately
                    if (cachedResponse) {
                        // Update cache in background (don't wait for it)
                        fetch(event.request)
                            .then((response) => {
                                if (response && response.status === 200) {
                                    const responseToCache = response.clone();
                                    caches.open(CACHE_NAME).then((cache) => {
                                        cache.put(event.request, responseToCache);
                                    });
                                }
                            })
                            .catch(() => {
                                // Network failed, keep using cached version
                            });
                        return cachedResponse;
                    }
                    
                    // No cache, fetch from network
                    return fetch(event.request)
                        .then((response) => {
                            // Cache successful responses
                            if (response && response.status === 200) {
                                const responseToCache = response.clone();
                                caches.open(CACHE_NAME).then((cache) => {
                                    cache.put(event.request, responseToCache);
                                });
                            }
                            return response;
                        })
                        .catch(() => {
                            // Network failed, return a basic offline page for HTML
                            if (isHTML) {
                                return new Response(
                                    '<!DOCTYPE html><html><head><title>Offline</title></head><body><h1>You are offline</h1><p>Please check your internet connection and try again.</p></body></html>',
                                    {
                                        status: 503,
                                        statusText: 'Service Unavailable',
                                        headers: new Headers({
                                            'Content-Type': 'text/html'
                                        })
                                    }
                                );
                            }
                            return new Response('Offline', {
                                status: 503,
                                statusText: 'Service Unavailable'
                            });
                        });
                })
        );
    } else {
        // For other files (images, fonts), use cache-first (offline-friendly)
        event.respondWith(
            caches.match(event.request)
                .then((response) => {
                    // Return cached version or fetch from network
                    if (response) {
                        return response;
                    }
                    
                    return fetch(event.request).then((response) => {
                        // Cache successful responses
                        if (response && response.status === 200) {
                            const responseToCache = response.clone();
                            caches.open(CACHE_NAME).then((cache) => {
                                cache.put(event.request, responseToCache);
                            });
                        }
                        return response;
                    }).catch((error) => {
                        // Only log if it's not a network error (which is expected when offline)
                        if (error.name !== 'TypeError' || !error.message.includes('Failed to fetch')) {
                            console.error('Service Worker: Fetch failed:', error);
                        }
                        // Return a basic offline response if fetch fails
                        return new Response('Offline', {
                            status: 503,
                            statusText: 'Service Unavailable',
                            headers: new Headers({
                                'Content-Type': 'text/plain'
                            })
                        });
                    });
                })
        );
    }
});

// Push event - handle incoming push notifications
self.addEventListener('push', (event) => {
    console.log('Push event received:', event);
    
    let notificationData = {
        title: 'Cell Spott Manage',
        body: 'You have a new notification',
        icon: '/assets/logo1.png',
        badge: '/assets/logo1.png',
        tag: 'notification',
        requireInteraction: false,
        data: {}
    };
    
    if (event.data) {
        try {
            const data = event.data.json();
            notificationData = {
                title: data.title || notificationData.title,
                body: data.body || data.message || notificationData.body,
                icon: data.icon || notificationData.icon,
                badge: data.badge || notificationData.badge,
                tag: data.tag || notificationData.tag,
                requireInteraction: data.requireInteraction || false,
                data: data.data || {},
                actions: data.actions || []
            };
        } catch (e) {
            // If data is text, use it as body
            notificationData.body = event.data.text();
        }
    }
    
    event.waitUntil(
        self.registration.showNotification(notificationData.title, {
            body: notificationData.body,
            icon: notificationData.icon,
            badge: notificationData.badge,
            tag: notificationData.tag,
            requireInteraction: notificationData.requireInteraction,
            data: notificationData.data,
            actions: notificationData.actions,
            vibrate: [200, 100, 200],
            timestamp: Date.now()
        })
    );
});

// Notification click event - handle when user clicks on notification
self.addEventListener('notificationclick', (event) => {
    console.log('Notification clicked:', event);
    console.log('Notification data:', event.notification.data);
    console.log('Notification body:', event.notification.body);
    
    event.notification.close();
    
    // Get notification data - CRITICAL: Extract from data object (sent by backend)
    const notificationData = event.notification.data || {};
    const adminPhone = notificationData.adminPhone || '';
    const message = notificationData.message || event.notification.body || '';
    
    console.log('📋 Extracted notification data:', { adminPhone, message });
    
    event.waitUntil(
        clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        }).then((clientList) => {
            // CRITICAL: Open WhatsApp FIRST with admin phone and pre-filled message
            if (adminPhone && adminPhone.trim()) {
                // Clean and format phone number (remove all non-digits except +)
                let cleanPhone = adminPhone.trim().replace(/[^\d+]/g, '');
                
                // Format for Lebanon: if starts with 0, replace with 961 (no + in WhatsApp URL)
                if (cleanPhone.startsWith('0')) {
                    cleanPhone = '961' + cleanPhone.substring(1);
                } else if (cleanPhone.startsWith('+961')) {
                    // Remove the + sign (WhatsApp URLs don't use +)
                    cleanPhone = cleanPhone.substring(1); // Remove the +, keep 961
                } else if (cleanPhone.startsWith('+')) {
                    // Remove the + sign
                    cleanPhone = cleanPhone.substring(1);
                } else if (!cleanPhone.startsWith('961')) {
                    // If no prefix and doesn't start with 961, assume it's Lebanese number
                    cleanPhone = '961' + cleanPhone;
                }
                
                // Extract message - CRITICAL: Use notification body if message is not in data
                let notificationMessage = notificationData.message || event.notification.body || '';
                if (!notificationMessage || !notificationMessage.trim()) {
                    // Fallback: Try to get from notification body
                    notificationMessage = event.notification.body || '';
                }
                
                // Build WhatsApp URL with pre-filled message
                let whatsappUrl = `https://wa.me/${cleanPhone}`;
                if (notificationMessage && notificationMessage.trim()) {
                    // Encode message for URL (WhatsApp uses text parameter)
                    const encodedMessage = encodeURIComponent(notificationMessage.trim());
                    whatsappUrl += `?text=${encodedMessage}`;
                }
                
                console.log('📱 Opening WhatsApp:', whatsappUrl);
                console.log('   Phone (cleaned):', cleanPhone);
                console.log('   Message (raw):', notificationMessage);
                console.log('   Message (encoded):', notificationMessage ? encodeURIComponent(notificationMessage.trim()) : '');
                
                // Send message to existing clients to open WhatsApp (as backup)
                if (clientList.length > 0) {
                    clientList.forEach((client) => {
                        client.postMessage({
                            type: 'OPEN_WHATSAPP',
                            url: whatsappUrl,
                            phone: cleanPhone,
                            message: notificationMessage
                        });
                    });
                }
                
                // Always try to open WhatsApp directly (works in notification click context)
                if (self.clients && self.clients.openWindow) {
                    return self.clients.openWindow(whatsappUrl).catch((err) => {
                        console.error('Failed to open WhatsApp directly:', err);
                        // Still try to focus app
                        return focusOrOpenApp(clientList);
                    });
                }
            } else {
                console.warn('⚠️ No admin phone found in notification data:', notificationData);
            }
            
            // Step 2: Copy to clipboard via client message (if message exists and no phone)
            if (message && clientList.length > 0) {
                clientList.forEach((client) => {
                    client.postMessage({
                        type: 'COPY_TO_CLIPBOARD',
                        text: message
                    });
                });
            }
            
            // Step 3: Focus or open the app (only if WhatsApp wasn't opened)
            return focusOrOpenApp(clientList);
        }).catch((error) => {
            console.error('Error handling notification click:', error);
            // Still try to open WhatsApp even if everything fails
            if (adminPhone && adminPhone.trim()) {
                let cleanPhone = adminPhone.trim().replace(/[^\d+]/g, '');
                if (cleanPhone.startsWith('0')) {
                    cleanPhone = '961' + cleanPhone.substring(1);
                } else if (cleanPhone.startsWith('+961')) {
                    cleanPhone = cleanPhone.substring(1);
                } else if (cleanPhone.startsWith('+')) {
                    cleanPhone = cleanPhone.substring(1);
                } else if (!cleanPhone.startsWith('961')) {
                    cleanPhone = '961' + cleanPhone;
                }
                const errorMessage = event.notification.body || notificationData.message || '';
                let whatsappUrl = `https://wa.me/${cleanPhone}`;
                if (errorMessage && errorMessage.trim()) {
                    const encodedMessage = encodeURIComponent(errorMessage.trim());
                    whatsappUrl += `?text=${encodedMessage}`;
                }
                if (self.clients && self.clients.openWindow) {
                    self.clients.openWindow(whatsappUrl).catch((err) => {
                        console.error('Failed to open WhatsApp in error handler:', err);
                    });
                }
            }
        })
    );
});

// Helper function to focus existing app window or open new one
function focusOrOpenApp(clientList) {
    // If app is already open, focus it
    for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if ((client.url === '/' || client.url.includes('/pages/')) && 'focus' in client) {
            return client.focus();
        }
    }
    // Otherwise, open a new window
    if (self.clients && self.clients.openWindow) {
        return self.clients.openWindow('/pages/home.html');
    }
    return Promise.resolve();
}

// Notification close event
self.addEventListener('notificationclose', (event) => {
    console.log('Notification closed:', event);
});

