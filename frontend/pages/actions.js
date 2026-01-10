/**
 * Actions Page Manager
 * Manages the action logs table with search, filtering, and pagination
 */

class ActionsManager {
    constructor() {
        this.currentPage = 1;
        this.rowsPerPage = 25;
        this.actionLogs = [];
        this.filteredLogs = [];
        this.searchQuery = '';
        this.actionFilter = 'all';
        this.dateFilter = 'all'; // 'all', 'today', 'yesterday', '7days', '30days', or specific date
        this.sortField = 'date';
        this.sortDirection = 'desc';
        this.denseMode = false;
        this.currentUserId = null;
        
        this.init();
    }
    
    /**
     * Get current user ID from Firebase auth
     */
    getCurrentUserId() {
        if (typeof auth !== 'undefined' && auth && auth.currentUser) {
            return auth.currentUser.uid;
        }
        return null;
    }
    
    /**
     * Get Firebase auth token
     */
    async getAuthToken() {
        if (typeof auth !== 'undefined' && auth && auth.currentUser) {
            try {
                return await auth.currentUser.getIdToken();
            } catch (error) {
                console.error('Error getting auth token:', error);
                return null;
            }
        }
        return null;
    }
    
    /**
     * Wait for Firebase auth to be ready
     */
    async waitForAuth() {
        return new Promise((resolve, reject) => {
            if (typeof auth === 'undefined') {
                reject(new Error('Firebase auth not loaded'));
                return;
            }
            
            const unsubscribe = auth.onAuthStateChanged((user) => {
                if (user && user.uid) {
                    this.currentUserId = user.uid;
                    console.log('✅ User authenticated:', user.uid);
                    unsubscribe();
                    resolve();
                } else {
                    // Check if user is already logged in
                    if (auth.currentUser && auth.currentUser.uid) {
                        this.currentUserId = auth.currentUser.uid;
                        console.log('✅ User already authenticated:', auth.currentUser.uid);
                        unsubscribe();
                        resolve();
                    }
                }
            });
            
            // Timeout after 10 seconds
            setTimeout(() => {
                unsubscribe();
                reject(new Error('Auth timeout'));
            }, 10000);
        });
    }
    
    /**
     * Load action logs from API
     */
    async loadActionLogs() {
        try {
            const tbody = document.getElementById('actionsTableBody');
            
            // Show loading state
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" class="loading-state">
                            <p>Loading action logs...</p>
                        </td>
                    </tr>
                `;
            }
            
            // Get auth token
            const token = await this.getAuthToken();
            if (!token) {
                throw new Error('Not authenticated');
            }
            
            // Get API base URL
            const apiBaseURL = window.AEFA_API_URL || 'http://localhost:3000';
            
            // Fetch action logs with date filter for better performance
            const response = await fetch(`${apiBaseURL}/api/actionLogs?actionFilter=${this.actionFilter}&dateFilter=${this.dateFilter}&limit=500`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`Failed to fetch action logs: ${response.statusText}`);
            }
            
            const result = await response.json();
            console.log('📋 [Actions] API Response:', result);
            
            if (result.success && result.data) {
                console.log(`📋 [Actions] Received ${result.data.length} action log(s)`);
                this.actionLogs = result.data;
                console.log('📋 [Actions] Action logs:', this.actionLogs);
                this.applyFilters();
                console.log(`📋 [Actions] After filtering: ${this.filteredLogs.length} log(s)`);
                this.renderTable();
                this.updatePagination();
            } else {
                throw new Error(result.error || 'Failed to load action logs');
            }
        } catch (error) {
            console.error('Error loading action logs:', error);
            const tbody = document.getElementById('actionsTableBody');
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" class="empty-state" style="text-align: center; padding: 3rem;">
                            <p style="color: #ef4444; margin-bottom: 1rem;">❌ Error loading action logs</p>
                            <p style="color: #94a3b8; font-size: 0.875rem;">${error.message}</p>
                        </td>
                    </tr>
                `;
            }
        }
    }
    
    /**
     * Apply search, action, and date filters
     */
    applyFilters() {
        this.filteredLogs = this.actionLogs.filter(log => {
            // Search filter
            if (this.searchQuery) {
                const searchLower = this.searchQuery.toLowerCase();
                const matchesSearch = 
                    (log.adminName && log.adminName.toLowerCase().includes(searchLower)) ||
                    (log.adminPhone && log.adminPhone.includes(this.searchQuery)) ||
                    (log.subscriberPhone && log.subscriberPhone.includes(this.searchQuery));
                
                if (!matchesSearch) {
                    return false;
                }
            }
            
            // Action filter
            if (this.actionFilter !== 'all' && log.action !== this.actionFilter) {
                return false;
            }
            
            // Date filter
            if (this.dateFilter !== 'all') {
                const logDate = new Date(log.timestamp || log.createdAt);
                const now = new Date();
                const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const yesterdayStart = new Date(todayStart);
                yesterdayStart.setDate(yesterdayStart.getDate() - 1);
                
                switch (this.dateFilter) {
                    case 'today':
                        if (logDate < todayStart) {
                            return false;
                        }
                        break;
                    case 'yesterday':
                        if (logDate < yesterdayStart || logDate >= todayStart) {
                            return false;
                        }
                        break;
                    case '7days':
                        const sevenDaysAgo = new Date(now);
                        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                        if (logDate < sevenDaysAgo) {
                            return false;
                        }
                        break;
                    case '30days':
                        const thirtyDaysAgo = new Date(now);
                        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                        if (logDate < thirtyDaysAgo) {
                            return false;
                        }
                        break;
                }
            }
            
            return true;
        });
        
        // Sort logs
        this.filteredLogs.sort((a, b) => {
            let aVal, bVal;
            
            switch(this.sortField) {
                case 'date':
                    aVal = new Date(a.timestamp || a.createdAt).getTime();
                    bVal = new Date(b.timestamp || b.createdAt).getTime();
                    break;
                case 'admin':
                    aVal = (a.adminName || a.admin || '').toLowerCase();
                    bVal = (b.adminName || b.admin || '').toLowerCase();
                    break;
                case 'action':
                    aVal = (a.action || '').toLowerCase();
                    bVal = (b.action || '').toLowerCase();
                    break;
                case 'numbers':
                    aVal = parseInt(a.numbers || a.numberCount || 0);
                    bVal = parseInt(b.numbers || b.numberCount || 0);
                    break;
                case 'quotas':
                    aVal = parseFloat(a.quotas || a.quota || 0);
                    bVal = parseFloat(b.quotas || b.quota || 0);
                    break;
                case 'status':
                    aVal = (a.status || '').toLowerCase();
                    bVal = (b.status || '').toLowerCase();
                    break;
                default:
                    aVal = a[this.sortField] || '';
                    bVal = b[this.sortField] || '';
            }
            
            if (this.sortDirection === 'asc') {
                return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
            } else {
                return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
            }
        });
        
        // Update pagination
        this.updatePagination();
    }
    
    /**
     * Render the actions table
     */
    renderTable() {
        const tbody = document.getElementById('actionsTableBody');
        if (!tbody) {
            console.warn('⚠️ [Actions] Table body not found');
            return;
        }
        
        console.log(`📋 [Actions] Rendering table. Filtered logs: ${this.filteredLogs.length}, Current page: ${this.currentPage}`);
        
        // Calculate pagination
        const startIndex = (this.currentPage - 1) * this.rowsPerPage;
        const endIndex = startIndex + this.rowsPerPage;
        const pageLogs = this.filteredLogs.slice(startIndex, endIndex);
        
        console.log(`📋 [Actions] Page logs to render: ${pageLogs.length} (start: ${startIndex}, end: ${endIndex})`);
        
        if (pageLogs.length === 0) {
            console.log('📋 [Actions] No logs to display, showing empty state');
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="empty-state">
                        <p>No action logs found</p>
                        <p style="font-size: 0.875rem; color: #94a3b8; margin-top: 0.5rem;">Actions will appear here after you add, edit, or remove subscribers.</p>
                    </td>
                </tr>
            `;
            return;
        }
        
        tbody.innerHTML = pageLogs.map(log => this.renderTableRow(log)).join('');
        
        // Attach event listeners
        pageLogs.forEach((log, index) => {
            const actualIndex = startIndex + index;
            const row = tbody.children[index];
            if (row) {
                const deleteBtn = row.querySelector('.delete-btn');
                if (deleteBtn) {
                    deleteBtn.addEventListener('click', () => this.handleDelete(log));
                }
            }
        });
        
        // Update table dense mode class
        const table = document.getElementById('actionsTable');
        if (table) {
            if (this.denseMode) {
                table.classList.add('dense');
            } else {
                table.classList.remove('dense');
            }
        }
    }
    
    /**
     * Render a single table row
     */
    renderTableRow(log) {
        // Handle date parsing - timestamp might be a string or Firestore Timestamp
        let date;
        if (log.timestamp) {
            date = typeof log.timestamp === 'string' ? new Date(log.timestamp) : (log.timestamp.toDate ? log.timestamp.toDate() : new Date(log.timestamp));
        } else if (log.createdAt) {
            date = typeof log.createdAt === 'string' ? new Date(log.createdAt) : (log.createdAt.toDate ? log.createdAt.toDate() : new Date(log.createdAt));
        } else {
            date = new Date();
        }
        
        // Check if date is valid
        if (isNaN(date.getTime())) {
            console.warn('⚠️ [Actions] Invalid date in log:', log);
            date = new Date();
        }
        
        const formattedDate = date.toLocaleString('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
        
        const actionClass = log.action === 'edit' ? 'edit' : (log.action === 'remove' ? 'remove' : '');
        const statusClass = log.success ? 'success' : 'failed';
        const statusText = log.success ? 'Success' : 'Failed';
        
        // Format quota if available
        const quotaDisplay = log.quota !== null && log.quota !== undefined ? `${log.quota} GB` : '-';
        
        // Copy button (only show for success)
        const deleteButton = `
            <button class="delete-btn" aria-label="Delete action" title="Delete action">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            </button>
        `;
        
        return `
            <tr>
                <td>
                    <div class="admin-cell">
                        <div class="admin-name">${this.escapeHtml(log.adminName || 'Unknown')}</div>
                        <div class="admin-phone">${this.escapeHtml(log.adminPhone || '')}</div>
                    </div>
                </td>
                <td>
                    <span class="action-badge ${actionClass}">${this.escapeHtml(log.action || 'unknown')}</span>
                </td>
                <td>
                    <div class="number-chip">${this.escapeHtml(log.subscriberPhone || '')}</div>
                </td>
                <td>
                    ${log.quota !== null && log.quota !== undefined ? `<div class="quota-chip">${this.escapeHtml(quotaDisplay)}</div>` : '-'}
                </td>
                <td>
                    <div class="date-text">${this.escapeHtml(formattedDate)}</div>
                </td>
                    <td>
                        <div class="status-cell">
                            <span class="status-badge-action ${statusClass}">${this.escapeHtml(statusText)}</span>
                            <div class="action-buttons-group">
                                ${deleteButton}
                            </div>
                        </div>
                    </td>
            </tr>
        `;
    }
    
    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    /**
     * Handle delete button click
     */
    async handleDelete(log) {
        if (!log.id) {
            console.error('⚠️ Cannot delete action log: missing ID');
            return;
        }
        
        // Confirm deletion
        if (!confirm('Are you sure you want to delete this action log?')) {
            return;
        }
        
        try {
            const token = await this.getAuthToken();
            if (!token) {
                throw new Error('Authentication token not available');
            }
            
            const baseURL = window.AEFA_API_URL || window.ALFA_API_URL || 'https://cell-spott-manage-backend.onrender.com';
            const deleteUrl = `${baseURL}/api/actionLogs/${log.id}`;
            console.log('🗑️ [Delete] Attempting to delete action log:', deleteUrl);
            
            const response = await fetch(deleteUrl, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            // Check if response is JSON before parsing
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                console.error('❌ [Delete] Non-JSON response received:', text.substring(0, 200));
                throw new Error(`Server returned ${response.status} ${response.statusText}. Expected JSON but got: ${contentType || 'unknown'}`);
            }
            
            const result = await response.json();
            
            if (response.ok && result.success) {
                console.log('✅ Action log deleted successfully');
                
                // Remove from local array
                this.actionLogs = this.actionLogs.filter(l => l.id !== log.id);
                
                // Reapply filters and re-render
                this.applyFilters();
                this.renderTable();
                this.updatePagination();
            } else {
                throw new Error(result.error || 'Failed to delete action log');
            }
        } catch (error) {
            console.error('❌ Error deleting action log:', error);
            alert(`Failed to delete action log: ${error.message}`);
        }
    }
    
    /**
     * Update pagination controls
     */
    updatePagination() {
        const totalPages = Math.ceil(this.filteredLogs.length / this.rowsPerPage);
        const startIndex = (this.currentPage - 1) * this.rowsPerPage;
        const endIndex = Math.min(startIndex + this.rowsPerPage, this.filteredLogs.length);
        
        // Update pagination info
        const paginationInfo = document.getElementById('paginationInfo');
        if (paginationInfo) {
            if (this.filteredLogs.length === 0) {
                paginationInfo.textContent = '0 results';
            } else {
                paginationInfo.textContent = `${startIndex + 1}–${endIndex} of ${this.filteredLogs.length}`;
            }
        }
        
        // Update pagination buttons
        const prevBtn = document.getElementById('prevPageBtn');
        const nextBtn = document.getElementById('nextPageBtn');
        
        if (prevBtn) {
            prevBtn.disabled = this.currentPage <= 1;
        }
        
        if (nextBtn) {
            nextBtn.disabled = this.currentPage >= totalPages;
        }
    }
    
    /**
     * Bind event listeners
     */
    bindEvents() {
        // Search input
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.trim();
                this.currentPage = 1; // Reset to first page
                this.applyFilters();
                this.renderTable();
            });
        }
        
        // Action filter
        const actionFilter = document.getElementById('actionFilter');
        if (actionFilter) {
            actionFilter.addEventListener('change', (e) => {
                this.actionFilter = e.target.value;
                this.currentPage = 1; // Reset to first page
                this.applyFilters();
                this.renderTable();
            });
        }
        
        // Date filter
        const dateFilter = document.getElementById('dateFilter');
        if (dateFilter) {
            dateFilter.addEventListener('change', (e) => {
                this.dateFilter = e.target.value;
                this.currentPage = 1; // Reset to first page
                this.applyFilters();
                this.renderTable();
            });
        }
        
        // Pagination buttons
        const prevBtn = document.getElementById('prevPageBtn');
        const nextBtn = document.getElementById('nextPageBtn');
        
        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                if (this.currentPage > 1) {
                    this.currentPage--;
                    this.renderTable();
                    this.updatePagination();
                }
            });
        }
        
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                const totalPages = Math.ceil(this.filteredLogs.length / this.rowsPerPage);
                if (this.currentPage < totalPages) {
                    this.currentPage++;
                    this.renderTable();
                    this.updatePagination();
                }
            });
        }
        
        // Dense mode toggle
        const denseToggle = document.getElementById('denseModeToggle');
        if (denseToggle) {
            denseToggle.addEventListener('change', (e) => {
                this.denseMode = e.target.checked;
                this.renderTable();
            });
        }
        
        // Initialize table sorting
        this.initTableSorting();
    }
    
    initTableSorting() {
        const table = document.getElementById('actionsTable');
        if (!table) return;
        
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
                
                // If header has no child elements, append icon directly to preserve structure
                if (header.children.length === 0) {
                    const text = header.textContent.trim();
                    header.textContent = '';
                    header.appendChild(document.createTextNode(text));
                }
                header.appendChild(icon);
            }
            
            // Add click handler
            header.addEventListener('click', () => {
                // Remove active class from all headers
                headers.forEach(h => {
                    h.classList.remove('sort-active', 'sort-asc', 'sort-desc');
                    const icon = h.querySelector('.sort-icon');
                    if (icon) {
                        icon.classList.remove('sort-asc', 'sort-desc');
                    }
                });
                
                // Toggle direction if same field, otherwise set to asc
                if (this.sortField === field) {
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortField = field;
                    this.sortDirection = 'asc';
                }
                
                // Update header
                header.classList.add('sort-active', `sort-${this.sortDirection}`);
                const icon = header.querySelector('.sort-icon');
                if (icon) {
                    icon.classList.add(`sort-${this.sortDirection}`);
                    if (this.sortDirection === 'asc') {
                        icon.innerHTML = '<path d="M12 5v14M12 5l4 4M12 5L8 9"/>';
                    } else {
                        icon.innerHTML = '<path d="M12 19V5M12 19l-4-4M12 19l4-4"/>';
                    }
                }
                
                // Apply filters and re-render
                this.applyFilters();
                this.renderTable();
            });
        });
        
        // Set initial sort state (date, desc)
        const dateHeader = table.querySelector('th[data-sort="date"]');
        if (dateHeader) {
            dateHeader.classList.add('sort-active', 'sort-desc');
            const icon = dateHeader.querySelector('.sort-icon');
            if (icon) {
                icon.classList.add('sort-desc');
                icon.innerHTML = '<path d="M12 19V5M12 19l-4-4M12 19l4-4"/>';
            }
        }
    }
    
    /**
     * Initialize the page
     */
    async init() {
        try {
            await this.waitForAuth();
            this.bindEvents();
            await this.loadActionLogs();
        } catch (error) {
            console.error('Error initializing actions page:', error);
            const tbody = document.getElementById('actionsTableBody');
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" class="empty-state" style="text-align: center; padding: 3rem; color: #ef4444;">
                            <p>⚠️ Authentication required. Please log in.</p>
                            <p style="margin-top: 1rem;"><a href="/auth/login.html" style="color: #3b82f6;">Go to Login</a></p>
                        </td>
                    </tr>
                `;
            }
        }
    }
}

// Initialize when DOM is ready
let actionsManager;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        actionsManager = new ActionsManager();
    });
} else {
    actionsManager = new ActionsManager();
}


