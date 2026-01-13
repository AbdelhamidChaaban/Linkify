/**
 * PWA Registration Script
 * Registers service worker and handles PWA installation
 */

(function() {
    'use strict';

    // Register Service Worker
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            // Check if service worker file exists before registering
            fetch('/service-worker.js', { method: 'HEAD' })
                .then((response) => {
                    if (response.ok) {
                        // Service worker file exists, register it
                        return navigator.serviceWorker.register('/service-worker.js', {
                            scope: '/' // Explicitly set scope to root
                        });
                    } else {
                        throw new Error('Service worker file not found (404)');
                    }
                })
                .then((registration) => {
                    console.log('[PWA] Service Worker registered successfully:', registration.scope);

                    // Check for updates
                    registration.addEventListener('updatefound', () => {
                        const newWorker = registration.installing;
                        if (newWorker) {
                            newWorker.addEventListener('statechange', () => {
                                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                    console.log('[PWA] New service worker available. Reload to update.');
                                    // Optionally show update notification to user
                                    // Removed confirm() to prevent blocking - use a toast notification instead
                                }
                            });
                        }
                    });
                })
                .catch((error) => {
                    // Only log error if it's not a 404 (file not found is expected if service worker is disabled)
                    if (error.message && !error.message.includes('404') && !error.message.includes('not found')) {
                        console.warn('[PWA] Service Worker registration failed:', error.message);
                    } else {
                        console.log('[PWA] Service Worker not available (file not found or disabled)');
                    }
                    // Don't show alert - just log the error
                });

            // Listen for service worker messages (non-blocking)
            if (navigator.serviceWorker) {
                navigator.serviceWorker.addEventListener('message', (event) => {
                    if (event && event.data) {
                        console.log('[PWA] Message from service worker:', event.data);
                    }
                });
            }
        });
    }

    // Handle PWA install prompt
    let deferredPrompt;
    window.addEventListener('beforeinstallprompt', (e) => {
        // Prevent the mini-infobar from appearing on mobile
        e.preventDefault();
        // Stash the event so it can be triggered later
        deferredPrompt = e;
        console.log('[PWA] Install prompt available');
        
        // Optionally show custom install button
        // You can trigger this manually: deferredPrompt.prompt();
    });

    // Track successful installation
    window.addEventListener('appinstalled', () => {
        console.log('[PWA] App installed successfully');
        deferredPrompt = null;
    });

    // Expose install function globally
    window.installPWA = function() {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            deferredPrompt.userChoice.then((choiceResult) => {
                if (choiceResult.outcome === 'accepted') {
                    console.log('[PWA] User accepted the install prompt');
                } else {
                    console.log('[PWA] User dismissed the install prompt');
                }
                deferredPrompt = null;
            });
        } else {
            console.log('[PWA] Install prompt not available');
        }
    };
})();

