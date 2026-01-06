/**
 * Service Worker for Push Notifications
 * Handles background push events and displays notifications
 */

const CACHE_NAME = 'linkify-v3'; // Updated to force cache refresh - v3: network-first strategy
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
    
    // Check if this is an HTML, CSS, or JS file that should use network-first strategy
    const url = new URL(event.request.url);
    const isStaticAsset = url.pathname.match(/\.(css|js|html|htm)$/i);
    
    if (isStaticAsset) {
        // Network-first strategy: Try network first, fallback to cache
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    // If network request succeeds, cache and return the response
                    if (response && response.status === 200) {
                        const responseToCache = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseToCache);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // Network failed, try cache as fallback
                    return caches.match(event.request);
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
    
    event.notification.close();
    
    // Open or focus the app
    event.waitUntil(
        clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        }).then((clientList) => {
            // If app is already open, focus it
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if (client.url === '/' || client.url.includes('/pages/') && 'focus' in client) {
                    return client.focus();
                }
            }
            // Otherwise, open a new window
            if (clients.openWindow) {
                return clients.openWindow('/pages/home.html');
            }
        })
    );
});

// Notification close event
self.addEventListener('notificationclose', (event) => {
    console.log('Notification closed:', event);
});

