/**
 * Fast Navigation - Optimize page transitions
 * Intercepts navigation clicks and uses cache-first approach
 */

(function() {
    'use strict';
    
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    function init() {
        // Intercept all navigation link clicks
        document.addEventListener('click', function(e) {
            const link = e.target.closest('a[href]');
            if (!link) return;
            
            const href = link.getAttribute('href');
            
            // Only intercept internal navigation links
            if (!href || href.startsWith('http://') || href.startsWith('https://') || 
                href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') ||
                href.includes('/api/') || href.includes('login.html')) {
                return;
            }
            
            // Skip if link opens in new tab
            if (link.target === '_blank' || e.ctrlKey || e.metaKey) {
                return;
            }
            
            // Prevent default navigation temporarily
            e.preventDefault();
            
            // Prefetch the page if not already cached
            prefetchPage(href).then(() => {
                // After prefetch completes (or if already cached), navigate
                window.location.href = href;
            }).catch(() => {
                // If prefetch fails, navigate anyway (normal navigation)
                window.location.href = href;
            });
        }, true); // Use capture phase to catch early
    }
    
    function prefetchPage(url) {
        return new Promise((resolve, reject) => {
            // Check if page is already in cache
            if ('caches' in window) {
                caches.open('linkify-v4').then(cache => {
                    cache.match(url).then(response => {
                        if (response) {
                            // Already cached, resolve immediately
                            resolve(response);
                        } else {
                            // Try to prefetch
                            const link = document.createElement('link');
                            link.rel = 'prefetch';
                            link.href = url;
                            link.as = 'document';
                            link.onload = () => resolve();
                            link.onerror = () => reject();
                            document.head.appendChild(link);
                            
                            // Also try to fetch directly (may be faster than prefetch)
                            fetch(url, { method: 'HEAD', cache: 'force-cache' })
                                .then(() => resolve())
                                .catch(() => {
                                    // Give prefetch a moment, then resolve anyway
                                    setTimeout(resolve, 100);
                                });
                        }
                    });
                });
            } else {
                // No cache support, resolve immediately
                resolve();
            }
        });
    }
})();

