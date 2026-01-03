/**
 * Service Worker for Push Notifications
 * Handles background push events and displays notifications
 */

const CACHE_NAME = 'linkify-v1';

// Install event - cache assets
self.addEventListener('install', (event) => {
    // Skip waiting to activate immediately
    self.skipWaiting();
    
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Service Worker: Cache opened');
                // Don't cache files during install - we'll cache on demand
                return Promise.resolve();
            })
            .catch((error) => {
                console.error('Service Worker: Cache error during install:', error);
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Service Worker: Deleting old cache', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            ).then(() => {
                // Take control of all pages immediately
                return self.clients.claim();
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
    
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                // Return cached version or fetch from network
                if (response) {
                    return response;
                }
                
                return fetch(event.request).catch((error) => {
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
            .catch((error) => {
                // Catch any errors in the promise chain
                // Only log unexpected errors
                if (error.name !== 'TypeError' || !error.message.includes('Failed to fetch')) {
                    console.error('Service Worker: Error in fetch handler:', error);
                }
                // Try to fetch directly, but don't catch errors here (let browser handle it)
                try {
                    return fetch(event.request);
                } catch (e) {
                    // If fetch also fails, return offline response
                    return new Response('Offline', {
                        status: 503,
                        statusText: 'Service Unavailable',
                        headers: new Headers({
                            'Content-Type': 'text/plain'
                        })
                    });
                }
            })
    );
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

