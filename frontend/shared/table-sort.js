/**
 * Table Sorting Utility
 * Provides reusable sorting functionality for all tables across the website
 */

class TableSort {
    /**
     * Initialize sorting for a table
     * @param {string} tableSelector - CSS selector for the table
     * @param {Object} options - Configuration options
     */
    static init(tableSelector, options = {}) {
        const table = document.querySelector(tableSelector);
        if (!table) return;

        const {
            sortField = null,
            sortDirection = 'desc',
            onSort = null,
            dataFieldMap = {}
        } = options;

        // Find all sortable headers
        const headers = table.querySelectorAll('thead th[data-sort]');
        
        headers.forEach(header => {
            const field = header.getAttribute('data-sort');
            
            // Add sortable class if not already present
            if (!header.classList.contains('sortable')) {
                header.classList.add('sortable');
            }
            
            // Add sort icon if not present
            if (!header.querySelector('.sort-icon')) {
                const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                icon.classList.add('sort-icon');
                icon.setAttribute('viewBox', '0 0 24 24');
                icon.setAttribute('fill', 'none');
                icon.setAttribute('stroke', 'currentColor');
                icon.setAttribute('stroke-width', '2');
                icon.innerHTML = '<path d="M12 16V8M12 16l-4-4M12 16l4-4"/>';
                
                // Wrap text in span if needed
                const text = header.textContent.trim();
                if (text && !header.querySelector('span')) {
                    header.innerHTML = `<span>${text}</span>`;
                }
                header.appendChild(icon);
            }
            
            // Add click handler
            header.addEventListener('click', (e) => {
                e.stopPropagation();
                
                // Remove active class from all headers
                headers.forEach(h => {
                    h.classList.remove('sort-active', 'sort-asc', 'sort-desc');
                    const icon = h.querySelector('.sort-icon');
                    if (icon) {
                        icon.classList.remove('sort-asc', 'sort-desc');
                    }
                });
                
                // Get current sort direction
                let currentDirection = header.getAttribute('data-sort-direction') || sortDirection;
                
                // Toggle direction
                const newDirection = currentDirection === 'asc' ? 'desc' : 'asc';
                
                // Update header
                header.classList.add('sort-active', `sort-${newDirection}`);
                header.setAttribute('data-sort-direction', newDirection);
                
                const icon = header.querySelector('.sort-icon');
                if (icon) {
                    icon.classList.add(`sort-${newDirection}`);
                    if (newDirection === 'asc') {
                        icon.innerHTML = '<path d="M12 5v14M12 5l4 4M12 5L8 9"/>';
                    } else {
                        icon.innerHTML = '<path d="M12 19V5M12 19l-4-4M12 19l4-4"/>';
                    }
                }
                
                // Call callback if provided
                if (onSort) {
                    onSort(field, newDirection);
                }
            });
        });
    }
    
    /**
     * Sort data array by field and direction
     * @param {Array} data - Data array to sort
     * @param {string} field - Field name to sort by
     * @param {string} direction - 'asc' or 'desc'
     * @param {Object} fieldMap - Map field names to data properties
     * @returns {Array} Sorted data array
     */
    static sortData(data, field, direction, fieldMap = {}) {
        const sorted = [...data];
        
        sorted.sort((a, b) => {
            let aVal = this.getFieldValue(a, field, fieldMap);
            let bVal = this.getFieldValue(b, field, fieldMap);
            
            // Handle different data types
            if (this.isDate(aVal) && this.isDate(bVal)) {
                aVal = new Date(aVal).getTime();
                bVal = new Date(bVal).getTime();
            } else if (this.isNumeric(aVal) && this.isNumeric(bVal)) {
                aVal = parseFloat(aVal) || 0;
                bVal = parseFloat(bVal) || 0;
            } else {
                // String comparison
                aVal = String(aVal || '').toLowerCase();
                bVal = String(bVal || '').toLowerCase();
            }
            
            if (direction === 'asc') {
                return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
            } else {
                return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
            }
        });
        
        return sorted;
    }
    
    /**
     * Get field value from data object
     */
    static getFieldValue(obj, field, fieldMap = {}) {
        // Check field map first
        if (fieldMap[field]) {
            const mapped = fieldMap[field];
            if (typeof mapped === 'function') {
                return mapped(obj);
            }
            return this.getNestedValue(obj, mapped);
        }
        
        return this.getNestedValue(obj, field);
    }
    
    /**
     * Get nested object value by path
     */
    static getNestedValue(obj, path) {
        const keys = path.split('.');
        let value = obj;
        for (const key of keys) {
            if (value && typeof value === 'object') {
                value = value[key];
            } else {
                return null;
            }
        }
        return value;
    }
    
    /**
     * Check if value is a date
     */
    static isDate(value) {
        if (!value) return false;
        if (value instanceof Date) return true;
        if (typeof value === 'string' && !isNaN(Date.parse(value))) return true;
        return false;
    }
    
    /**
     * Check if value is numeric
     */
    static isNumeric(value) {
        if (value === null || value === undefined || value === '') return false;
        return !isNaN(value) && !isNaN(parseFloat(value));
    }
}

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TableSort;
}

