// UI Helper Functions for Empty States, Skeleton Screens, etc.

class UIHelpers {
    // Create skeleton screen
    static createSkeletonScreen(type = 'table', count = 5) {
        const skeletons = {
            table: () => {
                const rows = [];
                for (let i = 0; i < count; i++) {
                    rows.push(`
                        <tr class="skeleton-table-row">
                            <td><div class="skeleton skeleton-text short"></div></td>
                            <td><div class="skeleton skeleton-text medium"></div></td>
                            <td><div class="skeleton skeleton-text short"></div></td>
                            <td><div class="skeleton skeleton-text medium"></div></td>
                            <td><div class="skeleton skeleton-text short"></div></td>
                        </tr>
                    `);
                }
                return rows.join('');
            },
            card: () => {
                return `
                    <div class="skeleton-card skeleton">
                        <div class="skeleton skeleton-text long" style="margin-bottom: 12px;"></div>
                        <div class="skeleton skeleton-text medium" style="margin-bottom: 12px;"></div>
                        <div class="skeleton skeleton-text short"></div>
                    </div>
                `;
            },
            list: () => {
                const items = [];
                for (let i = 0; i < count; i++) {
                    items.push(`
                        <div class="skeleton" style="display: flex; gap: 12px; padding: 16px; align-items: center;">
                            <div class="skeleton skeleton-avatar"></div>
                            <div style="flex: 1;">
                                <div class="skeleton skeleton-text medium" style="margin-bottom: 8px;"></div>
                                <div class="skeleton skeleton-text short"></div>
                            </div>
                        </div>
                    `);
                }
                return items.join('');
            }
        };

        return skeletons[type] ? skeletons[type]() : '';
    }

    // Create empty state
    static createEmptyState(config = {}) {
        const {
            icon = 'no-data',
            title = 'No Data Available',
            description = 'There is no data to display at this time.',
            action = null,
            actionText = null,
            actionCallback = null
        } = config;

        const actionHTML = action && actionText ? `
            <div class="empty-state-action">
                <button class="btn btn-primary" onclick="${actionCallback ? `(${actionCallback.toString()})()` : ''}">
                    ${actionText}
                </button>
            </div>
        ` : '';

        return `
            <div class="empty-state ${icon}">
                <div class="empty-state-icon">
                    ${this.getEmptyStateIcon(icon)}
                </div>
                <h3 class="empty-state-title">${title}</h3>
                <p class="empty-state-description">${description}</p>
                ${actionHTML}
            </div>
        `;
    }

    static getEmptyStateIcon(type) {
        const icons = {
            'no-data': `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 3v18h18"/>
                    <path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/>
                </svg>
            `,
            'no-results': `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/>
                    <path d="M21 21l-4.35-4.35"/>
                </svg>
            `,
            'error': `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
            `,
            'success': `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
            `,
            'loading': `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
            `
        };

        return icons[type] || icons['no-data'];
    }

    // Show loading overlay
    static showLoadingOverlay(message = 'Loading...') {
        const overlay = document.createElement('div');
        overlay.className = 'loading-overlay';
        overlay.id = 'globalLoadingOverlay';
        overlay.innerHTML = `
            <div style="text-align: center;">
                <div class="loading-spinner"></div>
                ${message ? `<p style="margin-top: 16px; color: #f8fafc;">${message}</p>` : ''}
            </div>
        `;
        document.body.appendChild(overlay);
        return overlay;
    }

    // Hide loading overlay
    static hideLoadingOverlay() {
        const overlay = document.getElementById('globalLoadingOverlay');
        if (overlay) {
            overlay.style.animation = 'fadeIn 0.2s ease-out reverse';
            setTimeout(() => overlay.remove(), 200);
        }
    }

    // Show skeleton screen in container
    static showSkeleton(container, type = 'table', count = 5) {
        if (typeof container === 'string') {
            container = document.querySelector(container);
        }
        if (!container) return;

        container.innerHTML = this.createSkeletonScreen(type, count);
    }

    // Show empty state in container
    static showEmptyState(container, config = {}) {
        if (typeof container === 'string') {
            container = document.querySelector(container);
        }
        if (!container) return;

        container.innerHTML = this.createEmptyState(config);
    }

    // Smooth scroll to element
    static scrollTo(element, offset = 0) {
        if (typeof element === 'string') {
            element = document.querySelector(element);
        }
        if (!element) return;

        const elementPosition = element.getBoundingClientRect().top;
        const offsetPosition = elementPosition + window.pageYOffset - offset;

        window.scrollTo({
            top: offsetPosition,
            behavior: 'smooth'
        });
    }

    // Animate number counter
    static animateNumber(element, target, duration = 1000) {
        if (typeof element === 'string') {
            element = document.querySelector(element);
        }
        if (!element) return;

        const start = parseFloat(element.textContent) || 0;
        const increment = (target - start) / (duration / 16);
        let current = start;

        const timer = setInterval(() => {
            current += increment;
            if ((increment > 0 && current >= target) || (increment < 0 && current <= target)) {
                current = target;
                clearInterval(timer);
            }
            element.textContent = Math.round(current).toLocaleString();
        }, 16);
    }

    // Add ripple effect to element
    static addRippleEffect(element) {
        if (typeof element === 'string') {
            element = document.querySelector(element);
        }
        if (!element) return;

        element.classList.add('ripple');
    }

    // Debounce function
    static debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    // Throttle function
    static throttle(func, limit) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }
}

// Make available globally
window.UIHelpers = UIHelpers;

