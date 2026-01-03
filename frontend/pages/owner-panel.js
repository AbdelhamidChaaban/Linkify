/**
 * Owner Panel JavaScript
 * Manages user administration, admin limits, and blocking
 */

class OwnerPanel {
    constructor() {
        this.users = [];
        this.pendingUsers = [];
        this.approvedUsers = [];
        this.currentEditingUserId = null;
        this.baseURL = window.ALFA_API_URL || 'http://localhost:3000';
        
        // Filtered data for tables
        this.filteredUsers = [];
        this.filteredPendingUsers = [];
        this.filteredApprovedUsers = [];
        this.filteredLimitationsUsers = [];
        
        // Search and filter states
        this.searchFilters = {
            users: '',
            limitations: '',
            approvements: '',
            deletion: ''
        };
        this.statusFilter = 'all';
        
        // Activity log (simulated - in real app, fetch from backend)
        this.recentActivity = [];
        
        this.init();
    }
    
    async init() {
        try {
            await this.waitForAuth();
            await this.checkOwnerAccess();
            this.bindEvents();
            await this.loadUsers();
        } catch (error) {
            console.error('Error initializing Owner Panel:', error);
            this.showError('Failed to initialize. ' + error.message);
        }
    }
    
    async waitForAuth() {
        // Check if owner token exists in sessionStorage
        const ownerToken = sessionStorage.getItem('ownerToken');
        if (!ownerToken) {
            // Redirect to owner login
            window.location.href = '/auth/owner-login.html';
            throw new Error('Not authenticated');
        }
        return Promise.resolve();
    }
    
    async checkOwnerAccess() {
        // Owner access is checked on the backend via token
        // If token is invalid or expired, API will return 401/403
        // We'll handle that in loadUsers()
    }
    
    async getIdToken() {
        const token = sessionStorage.getItem('ownerToken');
        if (!token) {
            throw new Error('No owner token found. Please login.');
        }
        return token;
    }
    
    async loadUsers() {
        try {
            const tbody = document.getElementById('usersTableBody');
            if (tbody) {
                tbody.innerHTML = this.renderSkeletonLoader(6);
            }
            const limitationsTbody = document.getElementById('limitationsTableBody');
            if (limitationsTbody) {
                limitationsTbody.innerHTML = this.renderSkeletonLoader(3);
            }
            
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/owner/users`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.status === 401 || response.status === 403) {
                // Token expired or invalid, redirect to login
                sessionStorage.removeItem('ownerToken');
                window.location.href = '/auth/owner-login.html';
                return;
            }
            
            if (!response.ok) {
                throw new Error(`API error: ${response.status} ${response.statusText}`);
            }
            
            const result = await response.json();
            this.users = result.users || [];
            this.filteredUsers = [...this.users];
            this.filteredLimitationsUsers = [...this.users];
            this.renderTable();
            this.renderLimitationsTable();
            this.updateDashboard();
            
        } catch (error) {
            console.error('Error loading users:', error);
            this.showError('Failed to load users: ' + error.message);
            const tbody = document.getElementById('usersTableBody');
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Error loading users. Please refresh the page.</td></tr>';
            }
        }
    }
    
    // Filter users based on search and status
    filterUsers() {
        let filtered = [...this.users];
        
        // Apply status filter
        if (this.statusFilter === 'active') {
            filtered = filtered.filter(u => !u.isBlocked);
        } else if (this.statusFilter === 'blocked') {
            filtered = filtered.filter(u => u.isBlocked);
        }
        
        // Apply search filter
        const search = this.searchFilters.users.toLowerCase().trim();
        if (search) {
            filtered = filtered.filter(user => {
                const email = (user.email || '').toLowerCase();
                const name = (user.name || '').toLowerCase();
                const phone = (user.phone || '').toLowerCase();
                return email.includes(search) || name.includes(search) || phone.includes(search);
            });
        }
        
        this.filteredUsers = filtered;
        this.updateUsersRowCount();
    }
    
    // Filter limitations users
    filterLimitationsUsers() {
        let filtered = [...this.users];
        const search = this.searchFilters.limitations.toLowerCase().trim();
        if (search) {
            filtered = filtered.filter(user => {
                const email = (user.email || '').toLowerCase();
                const name = (user.name || '').toLowerCase();
                return email.includes(search) || name.includes(search);
            });
        }
        this.filteredLimitationsUsers = filtered;
        this.updateLimitationsRowCount();
    }
    
    // Filter pending users
    filterPendingUsers() {
        if (!this.pendingUsers) {
            this.filteredPendingUsers = [];
            return;
        }
        let filtered = [...this.pendingUsers];
        const search = this.searchFilters.approvements.toLowerCase().trim();
        if (search) {
            filtered = filtered.filter(user => {
                const email = (user.email || '').toLowerCase();
                const name = (user.name || '').toLowerCase();
                const phone = (user.phone || '').toLowerCase();
                return email.includes(search) || name.includes(search) || phone.includes(search);
            });
        }
        this.filteredPendingUsers = filtered;
        this.updateApprovementsRowCount();
    }
    
    // Filter approved users
    filterApprovedUsers() {
        if (!this.approvedUsers) {
            this.filteredApprovedUsers = [];
            return;
        }
        let filtered = [...this.approvedUsers];
        const search = this.searchFilters.deletion.toLowerCase().trim();
        if (search) {
            filtered = filtered.filter(user => {
                const email = (user.email || '').toLowerCase();
                const name = (user.name || '').toLowerCase();
                const phone = (user.phone || '').toLowerCase();
                return email.includes(search) || name.includes(search) || phone.includes(search);
            });
        }
        this.filteredApprovedUsers = filtered;
        this.updateDeletionRowCount();
    }
    
    updateUsersRowCount() {
        const countEl = document.getElementById('usersRowCount');
        if (countEl) {
            const total = this.users.length;
            const filtered = this.filteredUsers.length;
            countEl.textContent = filtered === total ? `(${total})` : `(${filtered} of ${total})`;
        }
    }
    
    updateLimitationsRowCount() {
        const countEl = document.getElementById('limitationsRowCount');
        if (countEl) {
            const total = this.users.length;
            const filtered = this.filteredLimitationsUsers.length;
            countEl.textContent = filtered === total ? `(${total})` : `(${filtered} of ${total})`;
        }
    }
    
    updateApprovementsRowCount() {
        const countEl = document.getElementById('approvementsRowCount');
        if (countEl) {
            const total = this.pendingUsers.length;
            const filtered = this.filteredPendingUsers.length;
            countEl.textContent = filtered === total ? `(${total})` : `(${filtered} of ${total})`;
        }
    }
    
    updateDeletionRowCount() {
        const countEl = document.getElementById('deletionRowCount');
        if (countEl) {
            const total = this.approvedUsers.length;
            const filtered = this.filteredApprovedUsers.length;
            countEl.textContent = filtered === total ? `(${total})` : `(${filtered} of ${total})`;
        }
    }
    
    renderTable() {
        const tbody = document.getElementById('usersTableBody');
        if (!tbody) return;
        
        if (this.filteredUsers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No users found.</td></tr>';
            return;
        }
        
        tbody.innerHTML = this.filteredUsers.map((user, index) => {
            const createdAt = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '-';
            const statusBadge = user.isBlocked 
                ? '<span class="status-badge blocked">Blocked</span>'
                : '<span class="status-badge active">Active</span>';
            const toggleId = `block-toggle-${user.id}`;
            const toggleChecked = user.isBlocked; // ON = blocked, OFF = active (unblocked)
            
            return `
                <tr style="animation-delay: ${index * 0.05}s" class="clickable-row" data-user-id="${user.id}">
                    <td>${user.email || '-'}</td>
                    <td>${user.name || '-'}</td>
                    <td>${user.phone || '-'}</td>
                    <td>${statusBadge}</td>
                    <td>${createdAt}</td>
                    <td class="actions-col">
                        <div class="toggle-container owner-toggle">
                            <div class="toggle-wrap">
                                <input class="toggle-input" id="${toggleId}" type="checkbox" ${toggleChecked ? 'checked' : ''} data-user-id="${user.id}" />
                                <label class="toggle-track" for="${toggleId}">
                                    <div class="track-lines">
                                        <div class="track-line"></div>
                                    </div>
                                    <div class="toggle-thumb">
                                        <div class="thumb-core"></div>
                                        <div class="thumb-inner"></div>
                                        <div class="thumb-scan"></div>
                                        <div class="thumb-particles">
                                            <div class="thumb-particle"></div>
                                            <div class="thumb-particle"></div>
                                            <div class="thumb-particle"></div>
                                            <div class="thumb-particle"></div>
                                            <div class="thumb-particle"></div>
                                        </div>
                                    </div>
                                    <div class="toggle-data">
                                        <div class="data-text off">OFF</div>
                                        <div class="data-text on">ON</div>
                                        <div class="status-indicator off"></div>
                                        <div class="status-indicator on"></div>
                                    </div>
                                    <div class="energy-rings">
                                        <div class="energy-ring"></div>
                                        <div class="energy-ring"></div>
                                        <div class="energy-ring"></div>
                                    </div>
                                    <div class="interface-lines">
                                        <div class="interface-line"></div>
                                        <div class="interface-line"></div>
                                        <div class="interface-line"></div>
                                        <div class="interface-line"></div>
                                        <div class="interface-line"></div>
                                        <div class="interface-line"></div>
                                    </div>
                                    <div class="toggle-reflection"></div>
                                    <div class="holo-glow"></div>
                                </label>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
        
        // Bind event listeners
        this.bindTableEvents();
        this.updateUsersRowCount();
    }
    
    renderLimitationsTable() {
        const tbody = document.getElementById('limitationsTableBody');
        if (!tbody) {
            return;
        }
        
        if (!this.filteredLimitationsUsers || this.filteredLimitationsUsers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No users found.</td></tr>';
            return;
        }
        
        // Use the same logic as renderTable for admin-related columns
        tbody.innerHTML = this.filteredLimitationsUsers.map((user, index) => {
            const adminLimit = user.adminLimit === null || user.adminLimit === undefined 
                ? '<span class="admin-limit-unlimited">Unlimited</span>' 
                : `<span class="admin-limit-value">${user.adminLimit}</span>`;
            const userName = user.name || user.email || '-';
            
            return `
                <tr style="animation-delay: ${index * 0.05}s">
                    <td>${userName}</td>
                    <td><strong>${user.adminCount || 0}</strong></td>
                    <td class="admin-limit-cell">
                        ${adminLimit}
                        <button class="btn-small btn-edit" data-user-id="${user.id}" data-current-limit="${user.adminLimit || ''}">Edit</button>
                    </td>
                </tr>
            `;
        }).join('');
        
        // Bind event listeners for limitations table
        this.bindLimitationsTableEvents();
        this.updateLimitationsRowCount();
    }
    
    bindLimitationsTableEvents() {
        // Edit admin limit buttons (only in limitations table)
        const limitationsTable = document.getElementById('limitationsTableBody');
        if (limitationsTable) {
            limitationsTable.querySelectorAll('.btn-edit[data-user-id]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const userId = e.target.dataset.userId;
                    const currentLimit = e.target.dataset.currentLimit;
                    this.openAdminLimitModal(userId, currentLimit);
                });
            });
        }
    }
    
    bindTableEvents() {
        // Block/Unblock toggle switches
        document.querySelectorAll('.toggle-input[data-user-id]').forEach(toggle => {
            toggle.addEventListener('change', async (e) => {
                e.stopPropagation(); // Prevent row click
                const toggleElement = e.target;
                const userId = toggleElement.dataset.userId;
                const isChecked = toggleElement.checked;
                // Store original state in case we need to revert
                const originalState = !isChecked;
                // isChecked = true means user is blocked, false means unblocked
                // So we pass isChecked directly as isBlocked
                const success = await this.toggleBlockUser(userId, isChecked);
                // If the API call failed, revert the toggle
                if (!success) {
                    toggleElement.checked = !isChecked;
                }
            });
        });
        
        // Clickable rows for user details
        document.querySelectorAll('.clickable-row[data-user-id]').forEach(row => {
            row.addEventListener('click', (e) => {
                // Don't open modal if clicking on toggle or actions
                if (e.target.closest('.toggle-container') || e.target.closest('.actions-col')) {
                    return;
                }
                const userId = row.dataset.userId;
                this.showUserDetails(userId);
            });
            row.style.cursor = 'pointer';
        });
    }
    
    openAdminLimitModal(userId, currentLimit) {
        const user = this.users.find(u => u.id === userId);
        if (!user) return;
        
        this.currentEditingUserId = userId;
        const modal = document.getElementById('adminLimitModal');
        const userEmailEl = document.getElementById('adminLimitUserEmail');
        const limitInput = document.getElementById('adminLimitInput');
        
        if (userEmailEl) userEmailEl.textContent = user.email || '-';
        if (limitInput) {
            limitInput.value = currentLimit === '' || currentLimit === null || currentLimit === undefined ? '' : currentLimit;
        }
        if (modal) modal.style.display = 'flex';
    }
    
    closeAdminLimitModal() {
        const modal = document.getElementById('adminLimitModal');
        if (modal) modal.style.display = 'none';
        this.currentEditingUserId = null;
    }
    
    async saveAdminLimit() {
        if (!this.currentEditingUserId) {
            console.error('No user ID set for editing');
            this.showError('Error: No user selected for editing.');
            return;
        }
        
        const limitInput = document.getElementById('adminLimitInput');
        if (!limitInput) {
            console.error('Admin limit input not found');
            this.showError('Error: Input field not found.');
            return;
        }
        
        const limitValue = limitInput.value.trim();
        
        // Parse limit value (empty or 0 means unlimited)
        let adminLimit = null;
        if (limitValue !== '' && limitValue !== '0') {
            const parsed = parseInt(limitValue, 10);
            if (isNaN(parsed) || parsed < 0) {
                this.showError('Please enter a valid positive number or leave empty for unlimited.');
                return;
            }
            adminLimit = parsed;
        }
        
        // Disable save button during request
        const saveBtn = document.getElementById('adminLimitSave');
        const originalText = saveBtn?.textContent;
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
        }
        
        try {
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/owner/users/${this.currentEditingUserId}/admin-limit`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ adminLimit })
            });
            
            if (response.status === 401 || response.status === 403) {
                // Token expired, redirect to login
                sessionStorage.removeItem('ownerToken');
                window.location.href = '/auth/owner-login.html';
                return;
            }
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Failed to update admin limit' }));
                throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
            }
            
            const result = await response.json();
            console.log('Admin limit updated successfully:', result);
            
            // Refresh both tables
            await this.loadUsers();
            this.closeAdminLimitModal();
            this.showSuccess('Admin limit updated successfully');
            
        } catch (error) {
            console.error('Error saving admin limit:', error);
            this.showError('Failed to save admin limit: ' + error.message);
        } finally {
            // Re-enable save button
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = originalText || 'Save';
            }
        }
    }
    
    async toggleBlockUser(userId, isBlocked) {
        try {
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/owner/users/${userId}/block`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ isBlocked })
            });
            
            if (response.status === 401 || response.status === 403) {
                // Token expired, redirect to login
                sessionStorage.removeItem('ownerToken');
                window.location.href = '/auth/owner-login.html';
                return false;
            }
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to update block status');
            }
        
            // Refresh users list
            await this.loadUsers();
            this.showSuccess(`User ${isBlocked ? 'blocked' : 'unblocked'} successfully`);
            return true;
        
        } catch (error) {
            console.error('Error toggling block status:', error);
            this.showError('Failed to update block status: ' + error.message);
            return false;
        }
    }
    
    bindEvents() {
        // Tab navigation
        document.querySelectorAll('.owner-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const targetTab = e.target.dataset.tab;
                this.switchTab(targetTab);
            });
        });

        // Sync admin counts button (in limitations)
        document.getElementById('syncAdminCountsBtnLimitations')?.addEventListener('click', () => {
            this.syncAdminCounts();
        });
        
        // Bind search and filter events
        this.bindSearchAndFilterEvents();
        
        // Logout button (in avatar dropdown)
        const logoutLink = document.getElementById('logoutLink');
        if (logoutLink) {
            logoutLink.addEventListener('click', (e) => {
                e.preventDefault();
                sessionStorage.removeItem('ownerToken');
                window.location.href = '/auth/owner-login.html';
            });
        }
        
        // Admin Limit Modal
        const adminLimitModal = document.getElementById('adminLimitModal');
        const adminLimitModalClose = document.getElementById('adminLimitModalClose');
        const adminLimitCancel = document.getElementById('adminLimitCancel');
        const adminLimitSave = document.getElementById('adminLimitSave');
        
        if (adminLimitModalClose) {
            adminLimitModalClose.addEventListener('click', () => this.closeAdminLimitModal());
        }
        if (adminLimitCancel) {
            adminLimitCancel.addEventListener('click', () => this.closeAdminLimitModal());
        }
        if (adminLimitSave) {
            adminLimitSave.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await this.saveAdminLimit();
            });
        }
        
        // Close modal on overlay click
        if (adminLimitModal) {
            adminLimitModal.addEventListener('click', (e) => {
                if (e.target === adminLimitModal) {
                    this.closeAdminLimitModal();
                }
            });
        }
        
        // Allow Enter key to save in modal
        const limitInput = document.getElementById('adminLimitInput');
        if (limitInput) {
            limitInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.saveAdminLimit();
                }
            });
        }
    }
    
    
    showError(message) {
        console.error(message);
        if (typeof notification !== 'undefined') {
            notification.error(message);
        }
    }
    
    showSuccess(message) {
        console.log(message);
        if (typeof notification !== 'undefined') {
            notification.success(message);
        }
    }
    
    // Custom confirm modal (replaces confirm())
    async showConfirm(title, message) {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirmModal');
            const titleEl = document.getElementById('confirmModalTitle');
            const messageEl = document.getElementById('confirmModalMessage');
            const confirmBtn = document.getElementById('confirmModalConfirm');
            const cancelBtn = document.getElementById('confirmModalCancel');
            const closeBtn = document.getElementById('confirmModalClose');
            
            if (!modal) {
                resolve(false);
                return;
            }
            
            if (titleEl) titleEl.textContent = title;
            if (messageEl) messageEl.textContent = message;
            
            const handleConfirm = () => {
                cleanup();
                modal.style.display = 'none';
                resolve(true);
            };
            
            const handleCancel = () => {
                cleanup();
                modal.style.display = 'none';
                resolve(false);
            };
            
            const cleanup = () => {
                confirmBtn?.removeEventListener('click', handleConfirm);
                cancelBtn?.removeEventListener('click', handleCancel);
                closeBtn?.removeEventListener('click', handleCancel);
                modal?.removeEventListener('click', handleOverlayClick);
            };
            
            const handleOverlayClick = (e) => {
                if (e.target === modal) {
                    handleCancel();
                }
            };
            
            confirmBtn?.addEventListener('click', handleConfirm);
            cancelBtn?.addEventListener('click', handleCancel);
            closeBtn?.addEventListener('click', handleCancel);
            modal?.addEventListener('click', handleOverlayClick);
            
            modal.style.display = 'flex';
        });
    }
    
    // Render skeleton loader
    renderSkeletonLoader(colspan) {
        return `
            <tr>
                <td colspan="${colspan}" class="loading-state">
                    <div class="skeleton-loader">
                        <div class="skeleton-row"></div>
                        <div class="skeleton-row"></div>
                        <div class="skeleton-row"></div>
                    </div>
                </td>
            </tr>
        `;
    }
    
    switchTab(tabName) {
        // Remove active class from all tabs and content
        document.querySelectorAll('.owner-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelectorAll('.owner-tab-content').forEach(content => {
            content.classList.remove('active');
        });

        // Add active class to selected tab
        const selectedTab = document.querySelector(`[data-tab="${tabName}"]`);
        if (selectedTab) {
            selectedTab.classList.add('active');
        }

        // Show corresponding content
        if (tabName === 'dashboard') {
            const dashboardTab = document.getElementById('dashboardTab');
            if (dashboardTab) {
                dashboardTab.classList.add('active');
                this.updateDashboard();
            }
        } else if (tabName === 'user-management') {
            document.getElementById('userManagementTab')?.classList.add('active');
        } else if (tabName === 'limitations') {
            const limitationsTab = document.getElementById('limitationsTab');
            if (limitationsTab) {
                limitationsTab.classList.add('active');
                // Always render table when switching to this tab
                this.renderLimitationsTable();
            }
        } else if (tabName === 'approvements') {
            const approvementsTab = document.getElementById('approvementsTab');
            if (approvementsTab) {
                approvementsTab.classList.add('active');
                // Load pending approvals when switching to this tab
                this.loadPendingApprovals();
            }
        } else if (tabName === 'deletion') {
            const deletionTab = document.getElementById('deletionTab');
            if (deletionTab) {
                deletionTab.classList.add('active');
                // Load approved users when switching to this tab
                this.loadApprovedUsers();
            }
        }
    }
    
    async syncAdminCounts() {
        const btn1 = document.getElementById('syncAdminCountsBtn');
        const btn2 = document.getElementById('syncAdminCountsBtnLimitations');
        const buttons = [btn1, btn2].filter(btn => btn !== null);
        
        if (buttons.length === 0) return;
        
        // Store original button states
        const originalStates = buttons.map(btn => ({
            disabled: btn.disabled,
            innerHTML: btn.innerHTML
        }));
        
        // Disable both buttons and show loading state
        const loadingHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 1s linear infinite;">
                <path d="M21.5 2v6h-6M2.5 22v-6h-6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
            </svg>
            Syncing...
        `;
        
        buttons.forEach(btn => {
            btn.disabled = true;
            btn.innerHTML = loadingHTML;
        });
        
        try {
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/owner/recalculate-admin-counts`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            const result = await response.json();
            
            if (!result.success) {
                throw new Error(result.error || 'Failed to sync admin counts');
            }
            
            // Show success message
            this.showSuccess(`Successfully synced admin counts! Updated ${result.updated} users.`);
            
            // Reload both tables
            await this.loadUsers();
            
        } catch (error) {
            console.error('Error syncing admin counts:', error);
            this.showError(`Failed to sync admin counts: ${error.message}`);
        } finally {
            // Restore both buttons to their original state
            buttons.forEach((btn, index) => {
                btn.disabled = originalStates[index].disabled;
                btn.innerHTML = originalStates[index].innerHTML;
            });
        }
    }
    
    async loadPendingApprovals() {
        const tbody = document.getElementById('approvementsTableBody');
        if (!tbody) return;
        
        try {
            tbody.innerHTML = this.renderSkeletonLoader(5);
            
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/owner/pending-approvals`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.status === 401 || response.status === 403) {
                sessionStorage.removeItem('ownerToken');
                window.location.href = '/auth/owner-login.html';
                return;
            }
            
            if (!response.ok) {
                throw new Error(`API error: ${response.status} ${response.statusText}`);
            }
            
            const result = await response.json();
            this.pendingUsers = result.users || [];
            this.filterPendingUsers(); // This will set filteredPendingUsers
            this.renderApprovementsTable();
            this.updateDashboard();
        } catch (error) {
            console.error('Error loading pending approvals:', error);
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Error loading pending approvals. Please refresh the page.</td></tr>';
            }
        }
    }
    
    renderApprovementsTable() {
        const tbody = document.getElementById('approvementsTableBody');
        if (!tbody) return;
        
        if (this.filteredPendingUsers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No pending approvals.</td></tr>';
            this.updateApprovementsRowCount();
            return;
        }
        
        tbody.innerHTML = this.filteredPendingUsers.map((user, index) => {
                const createdAt = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '-';
                return `
                    <tr style="animation-delay: ${index * 0.05}s">
                        <td>${user.email || '-'}</td>
                        <td>${user.name || '-'}</td>
                        <td>${user.phone || '-'}</td>
                        <td>${createdAt}</td>
                        <td class="actions-col">
                            <button class="btn-small btn-approve" data-user-id="${user.id}">Approve</button>
                            <button class="btn-small btn-reject" data-user-id="${user.id}">Reject</button>
                        </td>
                    </tr>
                `;
            }).join('');
            
        // Bind event listeners
        this.bindApprovementsTableEvents();
        this.updateApprovementsRowCount();
    }
    
    bindApprovementsTableEvents() {
        // Approve buttons
        document.querySelectorAll('.btn-approve[data-user-id]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const userId = e.target.dataset.userId;
                await this.approveUser(userId);
            });
        });
        
        // Reject buttons
        document.querySelectorAll('.btn-reject[data-user-id]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const userId = e.target.dataset.userId;
                await this.rejectUser(userId);
            });
        });
    }
    
    async approveUser(userId) {
        try {
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/owner/users/${userId}/approve`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to approve user');
            }
            
            const result = await response.json();
            this.showSuccess('User approved successfully!');
            
            // Reload pending approvals
            await this.loadPendingApprovals();
        } catch (error) {
            console.error('Error approving user:', error);
            this.showError(`Failed to approve user: ${error.message}`);
        }
    }
    
    async rejectUser(userId) {
        const confirmed = await this.showConfirm(
            'Reject User',
            'Are you sure you want to reject this user? Their account will be permanently deleted.'
        );
        if (!confirmed) {
            return;
        }
        
        try {
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/owner/users/${userId}/reject`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to reject user');
            }
            
            const result = await response.json();
            this.showSuccess('User rejected successfully!');
            
            // Reload pending approvals
            await this.loadPendingApprovals();
        } catch (error) {
            console.error('Error rejecting user:', error);
            this.showError(`Failed to reject user: ${error.message}`);
        }
    }
    
    async loadApprovedUsers() {
        const tbody = document.getElementById('deletionTableBody');
        if (!tbody) return;
        
        try {
            tbody.innerHTML = this.renderSkeletonLoader(5);
            
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/owner/approved-users`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.status === 401 || response.status === 403) {
                sessionStorage.removeItem('ownerToken');
                window.location.href = '/auth/owner-login.html';
                return;
            }
            
            if (!response.ok) {
                throw new Error(`API error: ${response.status} ${response.statusText}`);
            }
            
            const result = await response.json();
            this.approvedUsers = result.users || [];
            this.filterApprovedUsers(); // This will set filteredApprovedUsers
            this.renderDeletionTable();
            this.updateDashboard();
        } catch (error) {
            console.error('Error loading approved users:', error);
            const tbody = document.getElementById('deletionTableBody');
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="5" class="error-state">Error loading approved users. Please try again.</td></tr>';
            }
        }
    }
    
    renderDeletionTable() {
        const tbody = document.getElementById('deletionTableBody');
        if (!tbody) return;
        
        if (!this.filteredApprovedUsers || this.filteredApprovedUsers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No approved users found.</td></tr>';
            this.updateDeletionRowCount();
            return;
        }
        
        tbody.innerHTML = this.filteredApprovedUsers.map((user, index) => {
            const createdAt = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '-';
            return `
                <tr style="animation-delay: ${index * 0.05}s">
                    <td>${user.email || '-'}</td>
                    <td>${user.name || '-'}</td>
                    <td>${user.phone || '-'}</td>
                    <td>${createdAt}</td>
                    <td class="actions-col">
                        <button class="btn-small btn-delete" data-user-id="${user.id}">Delete</button>
                    </td>
                </tr>
            `;
        }).join('');
        
        this.bindDeletionTableEvents();
        this.updateDeletionRowCount();
    }
    
    bindDeletionTableEvents() {
        const deletionTable = document.getElementById('deletionTableBody');
        if (deletionTable) {
            deletionTable.querySelectorAll('.btn-delete[data-user-id]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const userId = e.target.dataset.userId;
                    this.deleteUser(userId);
                });
            });
        }
    }
    
    async deleteUser(userId) {
        const confirmed = await this.showConfirm(
            'Delete User',
            'Are you sure you want to delete this user? Their account will be permanently deleted and they will not be able to log in again.'
        );
        if (!confirmed) {
            return;
        }
        
        try {
            const token = await this.getIdToken();
            const response = await fetch(`${this.baseURL}/api/owner/users/${userId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to delete user');
            }
            
            const result = await response.json();
            this.showSuccess('User deleted successfully!');
            
            // Reload approved users
            await this.loadApprovedUsers();
        } catch (error) {
            console.error('Error deleting user:', error);
            this.showError(`Failed to delete user: ${error.message}`);
        }
    }
    
    // Dashboard methods
    updateDashboard() {
        this.updateDashboardMetrics();
        this.updateStatusChart();
        this.updateActivityList();
    }
    
    updateDashboardMetrics() {
        const totalUsers = this.users.length;
        const activeUsers = this.users.filter(u => !u.isBlocked).length;
        const blockedUsers = this.users.filter(u => u.isBlocked).length;
        const pendingCount = this.pendingUsers.length;
        const approvedCount = this.approvedUsers.length;
        
        const setMetric = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value.toLocaleString();
        };
        
        setMetric('metricTotalUsers', totalUsers);
        setMetric('metricActiveUsers', activeUsers);
        setMetric('metricBlockedUsers', blockedUsers);
        setMetric('metricPendingApprovals', pendingCount);
        setMetric('metricApprovedUsers', approvedCount);
    }
    
    updateStatusChart() {
        const canvas = document.getElementById('statusChart');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        const activeUsers = this.users.filter(u => !u.isBlocked).length;
        const blockedUsers = this.users.filter(u => u.isBlocked).length;
        const pending = this.pendingUsers.length;
        const total = activeUsers + blockedUsers + pending;
        
        if (total === 0) {
            // Clear canvas and show message
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = 'var(--text-secondary)';
            ctx.font = '14px Inter';
            ctx.textAlign = 'center';
            ctx.fillText('No data available', canvas.width / 2, canvas.height / 2);
            return;
        }
        
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const radius = Math.min(canvas.width, canvas.height) / 2 - 20;
        
        let currentAngle = -Math.PI / 2; // Start at top
        
        // Colors
        const colors = {
            active: '#10b981',
            blocked: '#ef4444',
            pending: '#f59e0b'
        };
        
        const data = [
            { label: 'Active', value: activeUsers, color: colors.active },
            { label: 'Blocked', value: blockedUsers, color: colors.blocked },
            { label: 'Pending', value: pending, color: colors.pending }
        ].filter(d => d.value > 0);
        
        // Draw pie slices
        data.forEach((item, index) => {
            const sliceAngle = (item.value / total) * 2 * Math.PI;
            
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.arc(centerX, centerY, radius, currentAngle, currentAngle + sliceAngle);
            ctx.closePath();
            ctx.fillStyle = item.color;
            ctx.fill();
            ctx.strokeStyle = 'var(--card-bg)';
            ctx.lineWidth = 2;
            ctx.stroke();
            
            // Draw label
            const labelAngle = currentAngle + sliceAngle / 2;
            const labelX = centerX + Math.cos(labelAngle) * (radius * 0.7);
            const labelY = centerY + Math.sin(labelAngle) * (radius * 0.7);
            
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 12px Inter';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.value.toString(), labelX, labelY);
            
            currentAngle += sliceAngle;
        });
        
        // Draw legend
        let legendY = 20;
        data.forEach((item) => {
            ctx.fillStyle = item.color;
            ctx.fillRect(20, legendY, 15, 15);
            
            ctx.fillStyle = 'var(--text-primary)';
            ctx.font = '12px Inter';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(`${item.label}: ${item.value}`, 40, legendY + 2);
            
            legendY += 20;
        });
    }
    
    updateActivityList() {
        const activityList = document.getElementById('activityList');
        if (!activityList) return;
        
        // Generate recent activity from current state (in real app, fetch from backend)
        const activities = [];
        
        // Add recent user actions (this is simulated - in production, fetch from activity log)
        if (this.users.length > 0) {
            activities.push({
                title: `Total Users: ${this.users.length}`,
                time: new Date().toLocaleString(),
                details: 'System status updated'
            });
        }
        
        if (this.pendingUsers.length > 0) {
            activities.push({
                title: `${this.pendingUsers.length} Pending Approval${this.pendingUsers.length !== 1 ? 's' : ''}`,
                time: new Date().toLocaleString(),
                details: 'Users waiting for approval'
            });
        }
        
        if (activities.length === 0) {
            activityList.innerHTML = '<div class="activity-item"><div class="activity-item-title">No recent activity</div></div>';
            return;
        }
        
        activityList.innerHTML = activities.map(activity => `
            <div class="activity-item">
                <div class="activity-item-header">
                    <div class="activity-item-title">${activity.title}</div>
                    <div class="activity-item-time">${activity.time}</div>
                </div>
                <div class="activity-item-details">${activity.details}</div>
            </div>
        `).join('');
    }
    
    // User Details Modal
    async showUserDetails(userId) {
        const user = this.users.find(u => u.id === userId) || 
                    this.pendingUsers.find(u => u.id === userId) ||
                    this.approvedUsers.find(u => u.id === userId);
        
        if (!user) {
            this.showError('User not found');
            return;
        }
        
        const modal = document.getElementById('userDetailsModal');
        const content = document.getElementById('userDetailsContent');
        if (!modal || !content) return;
        
        content.innerHTML = '<div class="loading-state">Loading user details...</div>';
        modal.style.display = 'flex';
        
        try {
            // Format user data
            const createdAt = user.createdAt ? new Date(user.createdAt).toLocaleString() : '-';
            const adminLimit = user.adminLimit === null || user.adminLimit === undefined 
                ? 'Unlimited' 
                : user.adminLimit.toString();
            
            content.innerHTML = `
                <div class="user-details-grid">
                    <div class="user-detail-item">
                        <div class="user-detail-label">Email</div>
                        <div class="user-detail-value">${user.email || '-'}</div>
                    </div>
                    <div class="user-detail-item">
                        <div class="user-detail-label">Name</div>
                        <div class="user-detail-value">${user.name || '-'}</div>
                    </div>
                    <div class="user-detail-item">
                        <div class="user-detail-label">Phone</div>
                        <div class="user-detail-value">${user.phone || '-'}</div>
                    </div>
                    <div class="user-detail-item">
                        <div class="user-detail-label">Status</div>
                        <div class="user-detail-value">
                            ${user.isBlocked ? '<span class="status-badge blocked">Blocked</span>' : '<span class="status-badge active">Active</span>'}
                            ${user.isApproved ? '<span class="status-badge active" style="margin-left: 0.5rem;">Approved</span>' : '<span class="status-badge" style="margin-left: 0.5rem; background: #f59e0b;">Pending</span>'}
                        </div>
                    </div>
                    <div class="user-detail-item">
                        <div class="user-detail-label">Created At</div>
                        <div class="user-detail-value">${createdAt}</div>
                    </div>
                    <div class="user-detail-item">
                        <div class="user-detail-label">Admin Count</div>
                        <div class="user-detail-value">${user.adminCount || 0}</div>
                    </div>
                    <div class="user-detail-item">
                        <div class="user-detail-label">Admin Limit</div>
                        <div class="user-detail-value">${adminLimit}</div>
                    </div>
                    <div class="user-detail-item">
                        <div class="user-detail-label">User ID</div>
                        <div class="user-detail-value" style="font-size: 0.875rem; word-break: break-all;">${user.id}</div>
                    </div>
                </div>
                <div class="user-details-actions">
                    <button class="btn-primary" id="userDetailsBlockBtn" data-user-id="${user.id}" data-is-blocked="${user.isBlocked}">${user.isBlocked ? 'Unblock User' : 'Block User'}</button>
                    <button class="btn-secondary" id="userDetailsLimitBtn" data-user-id="${user.id}" data-limit="${user.adminLimit || ''}">${user.adminLimit !== null ? 'Edit Admin Limit' : 'Set Admin Limit'}</button>
                </div>
            `;
            
            // Bind action buttons
            const blockBtn = content.querySelector('#userDetailsBlockBtn');
            if (blockBtn) {
                blockBtn.addEventListener('click', async () => {
                    const isBlocked = blockBtn.dataset.isBlocked === 'true';
                    await this.toggleBlockUser(user.id, !isBlocked);
                    this.closeUserDetailsModal();
                });
            }
            
            const limitBtn = content.querySelector('#userDetailsLimitBtn');
            if (limitBtn) {
                limitBtn.addEventListener('click', () => {
                    this.openAdminLimitModal(user.id, limitBtn.dataset.limit);
                    this.closeUserDetailsModal();
                });
            }
        } catch (error) {
            console.error('Error loading user details:', error);
            content.innerHTML = '<div class="error-state">Error loading user details</div>';
        }
    }
    
    closeUserDetailsModal() {
        const modal = document.getElementById('userDetailsModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }
    
    // Add search and filter event bindings
    bindSearchAndFilterEvents() {
        // Users search
        const usersSearchInput = document.getElementById('usersSearchInput');
        if (usersSearchInput) {
            usersSearchInput.addEventListener('input', (e) => {
                this.searchFilters.users = e.target.value;
                this.filterUsers();
                this.renderTable();
            });
        }
        
        // Users status filter
        const usersStatusFilter = document.getElementById('usersStatusFilter');
        if (usersStatusFilter) {
            usersStatusFilter.addEventListener('change', (e) => {
                this.statusFilter = e.target.value;
                this.filterUsers();
                this.renderTable();
            });
        }
        
        // Limitations search
        const limitationsSearchInput = document.getElementById('limitationsSearchInput');
        if (limitationsSearchInput) {
            limitationsSearchInput.addEventListener('input', (e) => {
                this.searchFilters.limitations = e.target.value;
                this.filterLimitationsUsers();
                this.renderLimitationsTable();
            });
        }
        
        // Approvements search
        const approvementsSearchInput = document.getElementById('approvementsSearchInput');
        if (approvementsSearchInput) {
            approvementsSearchInput.addEventListener('input', (e) => {
                this.searchFilters.approvements = e.target.value;
                this.filterPendingUsers();
                this.renderApprovementsTable();
            });
        }
        
        // Deletion search
        const deletionSearchInput = document.getElementById('deletionSearchInput');
        if (deletionSearchInput) {
            deletionSearchInput.addEventListener('input', (e) => {
                this.searchFilters.deletion = e.target.value;
                this.filterApprovedUsers();
                this.renderDeletionTable();
            });
        }
        
        // Refresh buttons
        const refreshUsersBtn = document.getElementById('refreshUsersBtn');
        if (refreshUsersBtn) {
            refreshUsersBtn.addEventListener('click', () => {
                this.loadUsers();
            });
        }
        
        const refreshApprovementsBtn = document.getElementById('refreshApprovementsBtn');
        if (refreshApprovementsBtn) {
            refreshApprovementsBtn.addEventListener('click', () => {
                this.loadPendingApprovals();
            });
        }
        
        const refreshDeletionBtn = document.getElementById('refreshDeletionBtn');
        if (refreshDeletionBtn) {
            refreshDeletionBtn.addEventListener('click', () => {
                this.loadApprovedUsers();
            });
        }
        
        // User details modal close
        const userDetailsModal = document.getElementById('userDetailsModal');
        const userDetailsClose = document.getElementById('userDetailsClose');
        const userDetailsModalClose = document.getElementById('userDetailsModalClose');
        
        if (userDetailsClose) {
            userDetailsClose.addEventListener('click', () => {
                this.closeUserDetailsModal();
            });
        }
        
        if (userDetailsModalClose) {
            userDetailsModalClose.addEventListener('click', () => {
                this.closeUserDetailsModal();
            });
        }
        
        if (userDetailsModal) {
            userDetailsModal.addEventListener('click', (e) => {
                if (e.target === userDetailsModal) {
                    this.closeUserDetailsModal();
                }
            });
        }
    }
}

// Initialize when DOM is ready
let ownerPanel;
document.addEventListener('DOMContentLoaded', () => {
    ownerPanel = new OwnerPanel();
});

