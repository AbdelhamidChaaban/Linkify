/**
 * Prefetch likely next pages for faster navigation
 * This script adds <link rel="prefetch"> tags to preload HTML pages
 */

(function() {
    // Get current page path
    const currentPath = window.location.pathname;
    
    // Define common navigation paths based on current page
    const prefetchMap = {
        '/pages/home.html': ['/pages/insights.html', '/pages/admins.html'],
        '/pages/insights.html': ['/pages/home.html', '/pages/admins.html', '/pages/add-subscriber.html'],
        '/pages/admins.html': ['/pages/home.html', '/pages/insights.html'],
        '/pages/actions.html': ['/pages/home.html', '/pages/insights.html'],
        '/pages/flow-manager.html': ['/pages/home.html', '/pages/insights.html'],
        '/pages/profit-engine.html': ['/pages/home.html', '/pages/insights.html'],
        '/pages/add-subscriber.html': ['/pages/insights.html', '/pages/home.html'],
        '/pages/settings.html': ['/pages/home.html']
    };
    
    // Get pages to prefetch for current page
    const pagesToPrefetch = prefetchMap[currentPath] || [];
    
    // Add prefetch links to head
    const head = document.head || document.getElementsByTagName('head')[0];
    
    pagesToPrefetch.forEach(page => {
        // Check if prefetch link already exists
        const existing = document.querySelector(`link[rel="prefetch"][href="${page}"]`);
        if (!existing) {
            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.href = page;
            link.as = 'document';
            head.appendChild(link);
            console.log(`🔮 Prefetching ${page} for faster navigation`);
        }
    });
    
    // Also prefetch common assets
    const commonAssets = [
        '/shared/layout.css',
        '/shared/nav.js',
        '/shared/auth-helper.js',
        '/shared/alfa-api.js'
    ];
    
    commonAssets.forEach(asset => {
        const existing = document.querySelector(`link[rel="prefetch"][href="${asset}"]`);
        if (!existing) {
            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.href = asset;
            head.appendChild(link);
        }
    });
})();

