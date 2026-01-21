// PWA Orientation Handler
// Ensures the PWA can rotate on mobile devices and viewport updates correctly

(function() {
    'use strict';
    
    // Ensure orientation is unlocked on page load
    function unlockOrientation() {
        if ('screen' in window && 'orientation' in window.screen) {
            // Unlock orientation if it was previously locked
            if (window.screen.orientation && typeof window.screen.orientation.unlock === 'function') {
                try {
                    window.screen.orientation.unlock();
                } catch (e) {
                    // Ignore errors if unlock is not allowed (requires user gesture in some browsers)
                    console.log('Orientation unlock not available:', e);
                }
            }
        }
    }
    
    // Try to unlock immediately
    unlockOrientation();
    
    // Also try on user interaction (required by some browsers)
    document.addEventListener('touchstart', unlockOrientation, { once: true });
    document.addEventListener('click', unlockOrientation, { once: true });
    
    // Handle orientation changes
    function handleOrientationChange() {
        // Force a viewport update on orientation change
        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport) {
            // Temporarily remove and re-add viewport to force recalculation
            const content = viewport.getAttribute('content');
            viewport.setAttribute('content', 'width=device-width, initial-scale=1.0');
            
            // Use requestAnimationFrame to ensure browser processes the change
            requestAnimationFrame(() => {
                if (content) {
                    viewport.setAttribute('content', content);
                }
            });
        }
        
        // Force layout recalculation
        if (document.body) {
            document.body.style.display = 'none';
            requestAnimationFrame(() => {
                document.body.style.display = '';
            });
        }
        
        // Trigger resize events to ensure CSS media queries update
        window.dispatchEvent(new Event('resize'));
        
        // Multiple resize events with delays to catch all edge cases
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
            window.dispatchEvent(new Event('orientationchange'));
        }, 100);
        
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 300);
    }
    
    // Listen for orientation changes
    window.addEventListener('orientationchange', function() {
        handleOrientationChange();
    });
    
    // Also listen for resize events as fallback (some devices fire resize instead of orientationchange)
    let resizeTimer;
    let lastWidth = window.innerWidth;
    let lastHeight = window.innerHeight;
    
    window.addEventListener('resize', function() {
        const currentWidth = window.innerWidth;
        const currentHeight = window.innerHeight;
        
        // Check if this is likely an orientation change (width/height swap)
        const isOrientationChange = (
            (Math.abs(currentWidth - lastHeight) < 50 && Math.abs(currentHeight - lastWidth) < 50) ||
            (currentWidth !== lastWidth && currentHeight !== lastHeight)
        );
        
        if (isOrientationChange) {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function() {
                handleOrientationChange();
                lastWidth = currentWidth;
                lastHeight = currentHeight;
            }, 100);
        } else {
            lastWidth = currentWidth;
            lastHeight = currentHeight;
        }
    });
    
    // For iOS Safari - additional fixes
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
        // Force viewport recalculation on iOS
        window.addEventListener('orientationchange', function() {
            setTimeout(function() {
                const vh = window.innerHeight;
                document.documentElement.style.setProperty('--vh', `${vh}px`);
                document.body.style.height = vh + 'px';
                
                setTimeout(function() {
                    document.body.style.height = '';
                }, 100);
            }, 100);
        });
        
        // Fix for iOS viewport units
        function setVH() {
            const vh = window.innerHeight * 0.01;
            document.documentElement.style.setProperty('--vh', `${vh}px`);
        }
        setVH();
        window.addEventListener('resize', setVH);
        window.addEventListener('orientationchange', function() {
            setTimeout(setVH, 100);
        });
    }
    
    // Ensure CSS media queries are evaluated on orientation change
    window.addEventListener('orientationchange', function() {
        // Force reflow
        void document.body.offsetHeight;
    });
})();

