// PWA Orientation Handler
// Ensures the PWA can rotate on mobile devices

(function() {
    'use strict';
    
    // Ensure orientation is unlocked
    if ('screen' in window && 'orientation' in window.screen) {
        // Unlock orientation if it was previously locked
        if (window.screen.orientation && typeof window.screen.orientation.unlock === 'function') {
            try {
                window.screen.orientation.unlock();
            } catch (e) {
                // Ignore errors if unlock is not allowed
            }
        }
    }
    
    // Handle orientation changes
    function handleOrientationChange() {
        // Force a viewport update on orientation change
        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport) {
            const content = viewport.getAttribute('content');
            viewport.setAttribute('content', content);
        }
        
        // Trigger a resize event to ensure CSS media queries update
        window.dispatchEvent(new Event('resize'));
        
        // Small delay to ensure layout updates
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 100);
    }
    
    // Listen for orientation changes
    window.addEventListener('orientationchange', handleOrientationChange);
    
    // Also listen for resize events as fallback
    let resizeTimer;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function() {
            handleOrientationChange();
        }, 250);
    });
    
    // For iOS Safari
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
        // Force viewport recalculation on iOS
        window.addEventListener('orientationchange', function() {
            setTimeout(function() {
                document.body.style.height = window.innerHeight + 'px';
                setTimeout(function() {
                    document.body.style.height = '';
                }, 100);
            }, 100);
        });
    }
})();

