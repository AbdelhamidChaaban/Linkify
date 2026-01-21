// PWA Orientation Handler
// Ensures the PWA can rotate on mobile devices and viewport updates correctly

(function() {
    'use strict';
    
    // Debug logging (remove in production)
    console.log('[PWA Orientation] Script loaded');
    console.log('[PWA Orientation] Current orientation:', window.screen?.orientation?.angle || 'unknown');
    console.log('[PWA Orientation] Screen dimensions:', window.innerWidth, 'x', window.innerHeight);
    console.log('[PWA Orientation] Orientation type:', window.screen?.orientation?.type || window.orientation || 'unknown');
    
    // Check if manifest is loaded correctly
    if (navigator.serviceWorker) {
        navigator.serviceWorker.ready.then(registration => {
            console.log('[PWA Orientation] Service Worker ready');
        });
    }
    
    // Ensure orientation is unlocked on page load
    function unlockOrientation() {
        if ('screen' in window && 'orientation' in window.screen) {
            // Unlock orientation if it was previously locked
            if (window.screen.orientation && typeof window.screen.orientation.unlock === 'function') {
                try {
                    window.screen.orientation.unlock();
                    console.log('[PWA Orientation] Orientation unlocked');
                } catch (e) {
                    // Ignore errors if unlock is not allowed (requires user gesture in some browsers)
                    console.log('[PWA Orientation] Unlock failed (requires user gesture):', e.message);
                }
            } else {
                console.log('[PWA Orientation] Orientation unlock not available');
            }
        } else {
            console.log('[PWA Orientation] Screen orientation API not available');
        }
    }
    
    // Try to unlock immediately
    unlockOrientation();
    
    // Also try on user interaction (required by some browsers)
    document.addEventListener('touchstart', unlockOrientation, { once: true });
    document.addEventListener('click', unlockOrientation, { once: true });
    
    // Handle orientation changes - debounced to prevent multiple calls
    let orientationChangeTimer = null;
    function handleOrientationChange() {
        // Clear any pending orientation change handling
        if (orientationChangeTimer) {
            clearTimeout(orientationChangeTimer);
        }
        
        console.log('[PWA Orientation] Orientation change detected');
        console.log('[PWA Orientation] New dimensions:', window.innerWidth, 'x', window.innerHeight);
        console.log('[PWA Orientation] New angle:', window.screen?.orientation?.angle || 'unknown');
        
        // Debounce the actual handling to avoid multiple rapid calls
        orientationChangeTimer = setTimeout(() => {
            // Save current scroll position if on insights page
            const cardContainer = document.querySelector('.card-container');
            const savedScrollTop = cardContainer ? cardContainer.scrollTop : window.pageYOffset || window.scrollY;
            
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
                        console.log('[PWA Orientation] Viewport restored');
                    }
                });
            }
            
            // Trigger resize events to ensure CSS media queries update (only once, debounced)
            window.dispatchEvent(new Event('resize'));
            
            // Restore scroll position after a short delay to allow layout to settle
            if (cardContainer) {
                requestAnimationFrame(() => {
                    cardContainer.scrollTop = savedScrollTop;
                });
            } else {
                requestAnimationFrame(() => {
                    window.scrollTo(0, savedScrollTop);
                });
            }
            
            orientationChangeTimer = null;
        }, 150); // Debounce delay
    }
    
    // Listen for orientation changes - multiple methods for compatibility
    window.addEventListener('orientationchange', function(e) {
        console.log('[PWA Orientation] orientationchange event fired');
        handleOrientationChange();
    });
    
    // Alternative: listen to screen orientation API
    if (window.screen?.orientation) {
        window.screen.orientation.addEventListener('change', function(e) {
            console.log('[PWA Orientation] screen.orientation.change event fired');
            handleOrientationChange();
        });
    }
    
    // Also listen for resize events as fallback (some devices fire resize instead of orientationchange)
    // But be careful not to interfere with normal scrolling
    let resizeTimer;
    let lastWidth = window.innerWidth;
    let lastHeight = window.innerHeight;
    let isHandlingResize = false;
    
    window.addEventListener('resize', function() {
        // Prevent recursive calls
        if (isHandlingResize) return;
        
        const currentWidth = window.innerWidth;
        const currentHeight = window.innerHeight;
        
        // Check if this is likely an orientation change (width/height swap)
        // Only trigger if it's a significant change that looks like rotation
        const widthChange = Math.abs(currentWidth - lastWidth);
        const heightChange = Math.abs(currentHeight - lastHeight);
        const isOrientationChange = (
            (Math.abs(currentWidth - lastHeight) < 50 && Math.abs(currentHeight - lastWidth) < 50) ||
            (widthChange > 100 && heightChange > 100 && 
             Math.abs(currentWidth - lastHeight) < Math.abs(currentWidth - lastWidth)) // Width became previous height
        );
        
        if (isOrientationChange) {
            console.log('[PWA Orientation] Resize detected as orientation change:', 
                       lastWidth + 'x' + lastHeight, '->', currentWidth + 'x' + currentHeight);
            clearTimeout(resizeTimer);
            isHandlingResize = true;
            resizeTimer = setTimeout(function() {
                handleOrientationChange();
                lastWidth = currentWidth;
                lastHeight = currentHeight;
                isHandlingResize = false;
            }, 200); // Increased delay to avoid conflicts with scrolling
        } else {
            // Small resize changes - just update tracking
            if (widthChange < 50 && heightChange < 50) {
                // Likely just a scrollbar or small UI change, ignore
                return;
            }
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

