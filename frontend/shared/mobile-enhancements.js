// Mobile Experience Enhancements
// Pull-to-refresh, swipe gestures, and touch-friendly interactions

class MobileEnhancements {
    constructor() {
        this.pullToRefresh = {
            startY: 0,
            currentY: 0,
            isPulling: false,
            threshold: 80,
            maxPull: 120
        };
        this.swipeGestures = new Map(); // Store swipe handlers per element
        this.init();
    }

    init() {
        // Only enable on mobile devices
        if (this.isMobileDevice()) {
            this.initPullToRefresh();
            this.initSwipeGestures();
            this.initTouchOptimizations();
        }
    }

    isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
               (window.innerWidth <= 768);
    }

    // ==================== Pull-to-Refresh ====================
    initPullToRefresh() {
        // Only enable pull-to-refresh on insights page for the table container
        const isInsightsPage = document.body.classList.contains('insights-page');
        
        // For insights page, use table container instead of main content
        const targetElement = isInsightsPage 
            ? document.querySelector('.table-container')
            : document.querySelector('.main-content, .insights-section, .home-container');
            
        if (!targetElement) return;

        let touchStartY = 0;
        let touchCurrentY = 0;
        let isPulling = false;
        let pullIndicator = null;

        // Create pull indicator
        pullIndicator = this.createPullIndicator();

        const handleTouchStart = (e) => {
            // For insights page, check if we're at the top of the table container
            if (isInsightsPage) {
                const tableContainer = e.currentTarget;
                if (tableContainer.scrollTop > 0) return; // Only work at top of table
            } else {
                if (window.scrollY > 0) return; // Only work at top of page
            }
            
            touchStartY = e.touches[0].clientY;
            isPulling = false;
        };

        const handleTouchMove = (e) => {
            // Check scroll position
            if (isInsightsPage) {
                const tableContainer = e.currentTarget;
                if (tableContainer.scrollTop > 0) return;
            } else {
                if (window.scrollY > 0) return;
            }
            
            touchCurrentY = e.touches[0].clientY;
            const pullDistance = touchCurrentY - touchStartY;

            // Only prevent default if we're actually pulling down (positive distance)
            if (pullDistance > 0 && pullDistance < 200) {
                isPulling = true;
                e.preventDefault();
                
                const pullProgress = Math.min(pullDistance / 100, 1);
                this.updatePullIndicator(pullIndicator, pullDistance, pullProgress);
            }
        };

        const handleTouchEnd = () => {
            if (!isPulling) return;
            
            const pullDistance = touchCurrentY - touchStartY;
            
            if (pullDistance >= this.pullToRefresh.threshold) {
                this.triggerRefresh(pullIndicator);
            } else {
                this.resetPullIndicator(pullIndicator);
            }
            
            isPulling = false;
            touchStartY = 0;
            touchCurrentY = 0;
        };

        targetElement.addEventListener('touchstart', handleTouchStart, { passive: false });
        targetElement.addEventListener('touchmove', handleTouchMove, { passive: false });
        targetElement.addEventListener('touchend', handleTouchEnd);
    }

    createPullIndicator() {
        const indicator = document.createElement('div');
        indicator.className = 'pull-to-refresh-indicator';
        indicator.innerHTML = `
            <div class="pull-to-refresh-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
            </div>
            <div class="pull-to-refresh-text">Pull to refresh</div>
        `;
        document.body.appendChild(indicator);
        return indicator;
    }

    updatePullIndicator(indicator, distance, progress) {
        if (!indicator) return;
        
        const icon = indicator.querySelector('.pull-to-refresh-icon');
        const text = indicator.querySelector('.pull-to-refresh-text');
        
        indicator.style.opacity = Math.min(progress * 2, 1);
        indicator.style.transform = `translateY(${Math.min(distance * 0.5, 60)}px)`;
        
        if (icon) {
            icon.style.transform = `rotate(${progress * 360}deg)`;
        }
        
        if (distance >= this.pullToRefresh.threshold) {
            text.textContent = 'Release to refresh';
            indicator.classList.add('ready');
        } else {
            text.textContent = 'Pull to refresh';
            indicator.classList.remove('ready');
        }
    }

    resetPullIndicator(indicator) {
        if (!indicator) return;
        
        indicator.style.opacity = '0';
        indicator.style.transform = 'translateY(-60px)';
        indicator.classList.remove('ready');
        
        const icon = indicator.querySelector('.pull-to-refresh-icon');
        if (icon) {
            icon.style.transform = 'rotate(0deg)';
        }
    }

    async triggerRefresh(indicator) {
        if (!indicator) return;
        
        const text = indicator.querySelector('.pull-to-refresh-text');
        if (text) {
            text.textContent = 'Refreshing...';
        }
        
        // Trigger refresh based on current page
        const currentPage = window.location.pathname;
        
        if (currentPage.includes('insights.html')) {
            if (window.insightsManager && typeof window.insightsManager.forceRefresh === 'function') {
                await window.insightsManager.forceRefresh();
            }
        } else if (currentPage.includes('home.html')) {
            if (window.homeManager && typeof window.homeManager.forceRefresh === 'function') {
                await window.homeManager.forceRefresh();
            }
        } else if (currentPage.includes('admins.html')) {
            if (window.adminsManager && typeof window.adminsManager.loadAdmins === 'function') {
                await window.adminsManager.loadAdmins();
            }
        }
        
        // Reset after refresh
        setTimeout(() => {
            this.resetPullIndicator(indicator);
        }, 500);
    }

    // ==================== Swipe Gestures ====================
    initSwipeGestures() {
        // Swipe to delete for table rows
        this.enableSwipeToDelete();
        
        // Swipe to refresh (alternative to pull-to-refresh)
        this.enableSwipeToRefresh();
    }

    enableSwipeToDelete() {
        const tableRows = document.querySelectorAll('tbody tr, .subscriber-row');
        
        tableRows.forEach(row => {
            let touchStartX = 0;
            let touchStartY = 0;
            let touchEndX = 0;
            let touchEndY = 0;
            let isSwiping = false;

            row.addEventListener('touchstart', (e) => {
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                isSwiping = false;
            }, { passive: true });

            row.addEventListener('touchmove', (e) => {
                touchEndX = e.touches[0].clientX;
                touchEndY = e.touches[0].clientY;
                
                const deltaX = touchEndX - touchStartX;
                const deltaY = Math.abs(touchEndY - touchStartY);
                
                // Only trigger if horizontal swipe is dominant
                if (Math.abs(deltaX) > 30 && deltaY < 50) {
                    isSwiping = true;
                    const swipeDistance = Math.min(Math.abs(deltaX), 100);
                    const direction = deltaX > 0 ? 'right' : 'left';
                    
                    // Visual feedback
                    if (direction === 'left' && swipeDistance > 50) {
                        row.style.transform = `translateX(${-swipeDistance}px)`;
                        row.style.opacity = `${1 - swipeDistance / 200}`;
                        row.classList.add('swiping');
                    }
                }
            }, { passive: true });

            row.addEventListener('touchend', () => {
                if (!isSwiping) return;
                
                const deltaX = touchEndX - touchStartX;
                
                if (Math.abs(deltaX) > 80) {
                    // Trigger delete action
                    this.handleSwipeDelete(row, deltaX < 0);
                } else {
                    // Reset position
                    row.style.transform = '';
                    row.style.opacity = '';
                    row.classList.remove('swiping');
                }
                
                isSwiping = false;
            });
        });
    }

    handleSwipeDelete(row, isLeftSwipe) {
        if (!isLeftSwipe) return; // Only delete on left swipe
        
        // Find delete button or trigger delete action
        const deleteBtn = row.querySelector('.delete-btn, [data-action="delete"]');
        const checkbox = row.querySelector('input[type="checkbox"]');
        
        if (deleteBtn) {
            deleteBtn.click();
        } else if (checkbox && window.insightsManager) {
            // If it's a table row with checkbox, select and show delete option
            checkbox.checked = true;
            if (window.insightsManager.updateBulkActions) {
                window.insightsManager.updateBulkActions();
            }
        }
        
        // Reset row position
        row.style.transform = '';
        row.style.opacity = '';
        row.classList.remove('swiping');
    }

    enableSwipeToRefresh() {
        // Alternative swipe-to-refresh for areas where pull-to-refresh might not work
        const swipeableArea = document.querySelector('.main-content');
        if (!swipeableArea) return;

        let touchStartY = 0;
        let isSwiping = false;

        swipeableArea.addEventListener('touchstart', (e) => {
            if (window.scrollY === 0) {
                touchStartY = e.touches[0].clientY;
                isSwiping = true;
            }
        }, { passive: true });

        swipeableArea.addEventListener('touchmove', (e) => {
            if (!isSwiping || window.scrollY > 0) return;
            
            const deltaY = e.touches[0].clientY - touchStartY;
            if (deltaY > 100) {
                // Swipe down detected - could trigger refresh
                isSwiping = false;
            }
        }, { passive: true });
    }

    // ==================== Touch Optimizations ====================
    initTouchOptimizations() {
        // Increase tap target sizes for mobile
        this.optimizeTapTargets();
        
        // Add touch feedback
        this.addTouchFeedback();
        
        // Prevent accidental double-tap zoom
        this.preventDoubleTapZoom();
    }

    optimizeTapTargets() {
        // Ensure buttons and interactive elements are at least 44x44px (Apple's recommendation)
        const style = document.createElement('style');
        style.textContent = `
            @media (max-width: 768px) {
                button, .btn, a.nav-link, .mobile-nav-link {
                    min-height: 44px;
                    min-width: 44px;
                    padding: 12px 16px;
                }
                
                input[type="checkbox"], input[type="radio"] {
                    width: 24px;
                    height: 24px;
                }
                
                table td, table th {
                    padding: 12px 8px;
                }
            }
        `;
        document.head.appendChild(style);
    }

    addTouchFeedback() {
        // Add active state styles for better touch feedback
        const style = document.createElement('style');
        style.textContent = `
            @media (max-width: 768px) {
                button:active, .btn:active, a:active {
                    transform: scale(0.95);
                    opacity: 0.8;
                }
                
                .touch-feedback {
                    transition: transform 0.1s ease, opacity 0.1s ease;
                }
            }
        `;
        document.head.appendChild(style);
    }

    preventDoubleTapZoom() {
        let lastTouchEnd = 0;
        document.addEventListener('touchend', (e) => {
            // Don't prevent default on buttons or interactive elements
            if (e.target.closest('button, a, input, select, textarea, [onclick]')) {
                return;
            }
            
            const now = Date.now();
            if (now - lastTouchEnd <= 300) {
                e.preventDefault();
            }
            lastTouchEnd = now;
        }, { passive: false });
    }

}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.mobileEnhancements = new MobileEnhancements();
    });
} else {
    window.mobileEnhancements = new MobileEnhancements();
}

