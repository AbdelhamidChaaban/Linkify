class AdminsManager {
    constructor() {
        this.currentPage = 1;
        this.rowsPerPage = 25;
        this.admins = []; // Will be populated from Firebase/API
        this.selectedRows = new Set();
        this.denseMode = false;
        this.modal = null;
        this.form = null;
        this.editingAdminId = null; // Track which admin is being edited
        
        this.init();
    }
    
    // Load admins from Firebase/API
    async loadAdmins() {
        try {
            // Try to get all admins without orderBy to avoid index issues
            let snapshot;
            try {
                snapshot = await db.collection('admins').get();
            } catch (error) {
                console.error('Error fetching admins:', error);
                this.admins = [];
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
                return;
            }
            
            this.admins = snapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    ...data
                };
            });
            
            // Sort alphabetically by name (A to Z) - optimized
            if (this.admins.length > 0) {
                this.admins.sort((a, b) => {
                    const nameA = (a.name || '').toLowerCase();
                    const nameB = (b.name || '').toLowerCase();
                    return nameA.localeCompare(nameB);
                });
            }
            
            // Use requestAnimationFrame for non-blocking render
            requestAnimationFrame(() => {
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
            });
        } catch (error) {
            console.error('Error loading admins:', error);
            this.admins = [];
            this.renderTable();
            this.updatePagination();
            this.updatePageInfo();
        }
    }
    
    init() {
        this.bindEvents();
        this.initModal();
        this.showLoading();
        // Wait for Firebase to be ready
        this.waitForFirebase().then(() => {
            this.loadAdmins();
        }).catch(error => {
            console.error('Firebase initialization error:', error);
            const tbody = document.getElementById('adminsTableBody');
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="5" class="empty-state" style="text-align: center; padding: 3rem; color: #ef4444;">
                            Error loading data. Please refresh the page.
                        </td>
                    </tr>
                `;
            }
        });
    }
    
    async waitForFirebase() {
        // Wait for db to be available
        let attempts = 0;
        while (typeof db === 'undefined' && attempts < 50) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
        if (typeof db === 'undefined') {
            throw new Error('Firebase Firestore (db) is not initialized');
        }
    }
    
    showLoading() {
        const tbody = document.getElementById('adminsTableBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="empty-state" style="text-align: center; padding: 3rem;">
                        <div style="display: inline-block; width: 40px; height: 40px; border: 4px solid rgba(58, 10, 78, 0.2); border-top-color: #3a0a4e; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                        <p style="margin-top: 1rem; color: #94a3b8;">Loading admins...</p>
                    </td>
                </tr>
            `;
        }
    }
    
    initModal() {
        this.modal = document.getElementById('newAdminModal');
        this.form = document.getElementById('newAdminForm');
        const newAdminBtn = document.getElementById('newAdminBtn');
        const closeModal = document.getElementById('closeModal');
        const cancelBtn = document.getElementById('cancelBtn');
        
        newAdminBtn.addEventListener('click', () => this.openModal());
        closeModal.addEventListener('click', () => this.closeModal());
        cancelBtn.addEventListener('click', () => this.closeModal());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.closeModal();
            }
        });
        
        this.form.addEventListener('submit', (e) => this.handleSubmit(e));
    }
    
    openModal(adminId = null) {
        this.editingAdminId = adminId;
        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden';
        this.form.reset();
        this.clearAllErrors();
        
        // Update modal title and button text
        const modalTitle = this.modal.querySelector('.modal-header h3');
        const submitBtn = this.form.querySelector('.btn-submit .btn-text');
        
        if (adminId) {
            // Edit mode - populate form with existing data
            modalTitle.textContent = 'Edit Admin';
            submitBtn.textContent = 'Update Admin';
            
            // Update password field label
            document.getElementById('passwordRequired').style.display = 'none';
            document.getElementById('passwordOptional').style.display = 'inline';
            document.getElementById('adminPassword').required = false;
            
            const admin = this.admins.find(a => a.id === adminId);
            if (admin) {
                document.getElementById('adminName').value = admin.name || '';
                document.getElementById('adminPhone').value = admin.phone || '';
                document.getElementById('adminType').value = admin.type || '';
                document.getElementById('adminPassword').value = ''; // Don't populate password for security
                document.getElementById('adminQuota').value = admin.quota || 0;
            }
        } else {
            // Create mode
            modalTitle.textContent = 'Add New Admin';
            submitBtn.textContent = 'Create Admin';
            
            // Update password field label
            document.getElementById('passwordRequired').style.display = 'inline';
            document.getElementById('passwordOptional').style.display = 'none';
            document.getElementById('adminPassword').required = true;
        }
    }
    
    closeModal() {
        this.modal.classList.remove('show');
        document.body.style.overflow = '';
        this.editingAdminId = null;
        setTimeout(() => {
            this.form.reset();
            this.clearAllErrors();
        }, 300);
    }
    
    clearAllErrors() {
        const errorFields = ['name', 'phone', 'type', 'password', 'quota'];
        errorFields.forEach(field => {
            const errorEl = document.getElementById(`${field}Error`);
            if (errorEl) errorEl.textContent = '';
        });
    }
    
    showError(field, message) {
        const errorEl = document.getElementById(`${field}Error`);
        if (errorEl) {
            errorEl.textContent = message;
        }
    }
    
    clearError(field) {
        const errorEl = document.getElementById(`${field}Error`);
        if (errorEl) {
            errorEl.textContent = '';
        }
    }
    
    validateForm() {
        let isValid = true;
        
        const name = document.getElementById('adminName').value.trim();
        const phone = document.getElementById('adminPhone').value.trim();
        const type = document.getElementById('adminType').value;
        const password = document.getElementById('adminPassword').value;
        const quota = document.getElementById('adminQuota').value.trim();
        
        // Validate name
        if (!name) {
            this.showError('name', 'Full name is required');
            isValid = false;
        } else if (name.length < 2) {
            this.showError('name', 'Name must be at least 2 characters');
            isValid = false;
        } else {
            this.clearError('name');
        }
        
        // Validate phone
        if (!phone) {
            this.showError('phone', 'Phone number is required');
            isValid = false;
        } else {
            this.clearError('phone');
        }
        
        // Validate type
        if (!type) {
            this.showError('type', 'Type is required');
            isValid = false;
        } else {
            this.clearError('type');
        }
        
        // Validate password - required for new admins, optional for editing
        if (!this.editingAdminId) {
            // Creating new admin - password is required
            if (!password) {
                this.showError('password', 'Password is required');
                isValid = false;
            } else if (password.length < 6) {
                this.showError('password', 'Password must be at least 6 characters');
                isValid = false;
            } else {
                this.clearError('password');
            }
        } else {
            // Editing admin - password is optional (only validate if provided)
            if (password && password.length < 6) {
                this.showError('password', 'Password must be at least 6 characters');
                isValid = false;
            } else {
                this.clearError('password');
            }
        }
        
        // Validate quota
        if (!quota) {
            this.showError('quota', 'Admin quota is required');
            isValid = false;
        } else if (isNaN(quota) || parseInt(quota) < 0) {
            this.showError('quota', 'Admin quota must be a valid number (0 or greater)');
            isValid = false;
        } else {
            this.clearError('quota');
        }
        
        return isValid;
    }
    
    setLoading(loading) {
        const submitBtn = this.form.querySelector('.btn-submit');
        if (loading) {
            submitBtn.classList.add('loading');
            submitBtn.disabled = true;
        } else {
            submitBtn.classList.remove('loading');
            submitBtn.disabled = false;
        }
    }
    
    async handleSubmit(e) {
        e.preventDefault();
        
        if (!this.validateForm()) {
            return;
        }
        
        this.setLoading(true);
        
        try {
            const name = document.getElementById('adminName').value.trim();
            const phone = document.getElementById('adminPhone').value.trim();
            const type = document.getElementById('adminType').value;
            const password = document.getElementById('adminPassword').value;
            const quota = parseInt(document.getElementById('adminQuota').value.trim());
            
            // Prepare admin data
            const adminData = {
                name: name,
                phone: phone,
                type: type,
                status: type === 'Open' ? 'Open (Admin)' : 'Closed (Admin)',
                quota: quota,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            
            // Only include password if it's not empty (for edit mode)
            if (password) {
                // Note: Storing password in plain text is not recommended for production.
                // Consider using Firebase Authentication or hashing the password.
                adminData.password = password;
            }
            
            if (this.editingAdminId) {
                // Update existing admin
                await db.collection('admins').doc(this.editingAdminId).update(adminData);
                
                // Close modal and refresh list
                this.closeModal();
                await this.loadAdmins();
                
                alert(`Admin "${name}" has been updated successfully!`);
            } else {
                // Create new admin
                adminData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                const docRef = await db.collection('admins').add(adminData);
                const newAdminId = docRef.id;
                
                // Close modal first
                this.closeModal();
                
                // Show loading message
                alert(`Admin "${name}" has been added! Fetching Alfa data... This may take a few seconds.`);
                
                // Fetch Alfa dashboard data and wait for it to complete
                try {
                    console.log(`🔄 Starting Alfa data fetch for ${name}...`);
                    await this.fetchAlfaDataForAdmin(newAdminId, phone, password, name);
                    console.log(`✅ Alfa data fetched and saved for ${name}`);
                    alert(`Admin "${name}" has been added successfully with real data!`);
                } catch (error) {
                    console.error('❌ Error fetching Alfa data:', error);
                    let errorMsg = `Admin "${name}" has been added, but failed to fetch Alfa data.`;
                    if (error.message.includes('not available') || error.message.includes('AlfaAPIService')) {
                        errorMsg += '\n\nPlease make sure the backend server is running (node server.js)';
                    } else {
                        errorMsg += `\n\nError: ${error.message}`;
                    }
                    errorMsg += '\n\nYou can refresh manually later using the refresh button.';
                    alert(errorMsg);
                }
                
                // Refresh the admins list to show the new admin
                await this.loadAdmins();
            }
            
        } catch (error) {
            console.error('Error saving admin:', error);
            let errorMessage = this.editingAdminId 
                ? 'Failed to update admin. Please try again.' 
                : 'Failed to create admin. Please try again.';
            
            if (error.code === 'permission-denied') {
                errorMessage = 'Permission denied. Please check your Firebase rules.';
            } else if (error.code === 'not-found') {
                errorMessage = 'Admin not found. It may have been deleted.';
            } else if (error.message) {
                errorMessage = error.message;
            }
            
            alert(errorMessage);
        } finally {
            this.setLoading(false);
        }
    }
    
    bindEvents() {
        // Select all checkbox
        document.getElementById('selectAll').addEventListener('change', (e) => {
            this.selectAllRows(e.target.checked);
        });
        
        // Rows per page
        document.getElementById('rowsPerPage').addEventListener('change', (e) => {
            this.rowsPerPage = parseInt(e.target.value);
            this.currentPage = 1;
            this.renderTable();
            this.updatePagination();
            this.updatePageInfo();
        });
        
        // Pagination buttons
        document.getElementById('prevPage').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
            }
        });
        
        document.getElementById('nextPage').addEventListener('click', () => {
            const totalPages = Math.ceil(this.admins.length / this.rowsPerPage);
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
            }
        });
        
        // Dense toggle
        document.getElementById('denseToggle').addEventListener('change', (e) => {
            this.denseMode = e.target.checked;
            document.getElementById('denseSwitch').classList.toggle('active', this.denseMode);
            document.getElementById('adminsTable').classList.toggle('dense', this.denseMode);
        });
        
        // Initialize dense switch
        document.getElementById('denseSwitch').addEventListener('click', () => {
            const toggle = document.getElementById('denseToggle');
            toggle.checked = !toggle.checked;
            toggle.dispatchEvent(new Event('change'));
        });
    }
    
    renderTable() {
        const tbody = document.getElementById('adminsTableBody');
        
        if (this.admins.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                            <circle cx="12" cy="7" r="4"/>
                        </svg>
                        <p>No admins found. Add your first admin to get started.</p>
                    </td>
                </tr>
            `;
            return;
        }
        
        const startIndex = (this.currentPage - 1) * this.rowsPerPage;
        const endIndex = startIndex + this.rowsPerPage;
        const pageAdmins = this.admins.slice(startIndex, endIndex);
        
        tbody.innerHTML = pageAdmins.map(admin => `
            <tr>
                <td>
                    <input type="checkbox" class="row-checkbox" data-id="${admin.id}" 
                           ${this.selectedRows.has(admin.id) ? 'checked' : ''}>
                </td>
                <td>${admin.name}</td>
                <td>${admin.phone}</td>
                <td><span class="status-badge">${admin.status}</span></td>
                <td>
                    <div class="action-buttons">
                        <button class="action-btn edit" data-admin-id="${admin.id}" aria-label="Edit">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="m11.4 18.161l7.396-7.396a10.3 10.3 0 0 1-3.326-2.234a10.3 10.3 0 0 1-2.235-3.327L5.839 12.6c-.577.577-.866.866-1.114 1.184a6.6 6.6 0 0 0-.749 1.211c-.173.364-.302.752-.56 1.526l-1.362 4.083a1.06 1.06 0 0 0 1.342 1.342l4.083-1.362c.775-.258 1.162-.387 1.526-.56q.647-.308 1.211-.749c.318-.248.607-.537 1.184-1.114m9.448-9.448a3.932 3.932 0 0 0-5.561-5.561l-.887.887l.038.111a8.75 8.75 0 0 0 2.092 3.32a8.75 8.75 0 0 0 3.431 2.13z"/>
                            </svg>
                        </button>
                        <button class="action-btn delete" data-admin-id="${admin.id}" aria-label="Delete">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 6.386c0-.484.345-.877.771-.877h2.665c.529-.016.996-.399 1.176-.965l.03-.1l.115-.391c.07-.24.131-.45.217-.637c.338-.739.964-1.252 1.687-1.383c.184-.033.378-.033.6-.033h3.478c.223 0 .417 0 .6.033c.723.131 1.35.644 1.687 1.383c.086.187.147.396.218.637l.114.391l.03.1c.18.566.74.95 1.27.965h2.57c.427 0 .772.393.772.877s-.345.877-.771.877H3.77c-.425 0-.77-.393-.77-.877"/>
                                <path d="M11.596 22h.808c2.783 0 4.174 0 5.08-.886c.904-.886.996-2.339 1.181-5.245l.267-4.188c.1-1.577.15-2.366-.303-2.865c-.454-.5-1.22-.5-2.753-.5H8.124c-1.533 0-2.3 0-2.753.5s-.404 1.288-.303 2.865l.267 4.188c.185 2.906.277 4.36 1.182 5.245c.905.886 2.296.886 5.079.886m-1.35-9.811c-.04-.434-.408-.75-.82-.707c-.413.043-.713.43-.672.864l.5 5.263c.04.434.408.75.82.707c.413-.043.713-.43.672-.864zm4.329-.707c.412.043.713.43.671.864l-.5 5.263c-.04.434-.409.75-.82.707c-.413-.043-.713-.43-.672-.864l.5-5.263c.04-.434.409-.75.82-.707"/>
                            </svg>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
        
        // Bind row checkbox events
        tbody.querySelectorAll('.row-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const id = e.target.dataset.id;
                if (e.target.checked) {
                    this.selectedRows.add(id);
                } else {
                    this.selectedRows.delete(id);
                }
                this.updateSelectAll();
            });
        });
        
        // Bind edit button events
        tbody.querySelectorAll('.action-btn.edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const adminId = btn.dataset.adminId;
                this.editAdmin(adminId);
            });
        });
        
        // Bind delete button events
        tbody.querySelectorAll('.action-btn.delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const adminId = btn.dataset.adminId;
                this.deleteAdmin(adminId);
            });
        });
    }
    
    selectAllRows(checked) {
        const startIndex = (this.currentPage - 1) * this.rowsPerPage;
        const endIndex = startIndex + this.rowsPerPage;
        const pageAdmins = this.admins.slice(startIndex, endIndex);
        
        pageAdmins.forEach(admin => {
            if (checked) {
                this.selectedRows.add(admin.id);
            } else {
                this.selectedRows.delete(admin.id);
            }
        });
        
        this.renderTable();
    }
    
    updateSelectAll() {
        const startIndex = (this.currentPage - 1) * this.rowsPerPage;
        const endIndex = startIndex + this.rowsPerPage;
        const pageAdmins = this.admins.slice(startIndex, endIndex);
        const allSelected = pageAdmins.length > 0 && pageAdmins.every(admin => this.selectedRows.has(admin.id));
        document.getElementById('selectAll').checked = allSelected;
    }
    
    updatePagination() {
        const totalPages = Math.ceil(this.admins.length / this.rowsPerPage);
        document.getElementById('prevPage').disabled = this.currentPage === 1;
        document.getElementById('nextPage').disabled = this.currentPage === totalPages || totalPages === 0;
    }
    
    updatePageInfo() {
        if (this.admins.length === 0) {
            document.getElementById('pageInfo').textContent = '0 of 0';
            return;
        }
        const startIndex = (this.currentPage - 1) * this.rowsPerPage + 1;
        const endIndex = Math.min(this.currentPage * this.rowsPerPage, this.admins.length);
        document.getElementById('pageInfo').textContent = `${startIndex}–${endIndex} of ${this.admins.length}`;
    }
    
    editAdmin(id) {
        const admin = this.admins.find(a => a.id === id);
        if (admin) {
            this.openModal(id);
        } else {
            console.error('Admin not found with id:', id);
        }
    }
    
    async deleteAdmin(id) {
        const admin = this.admins.find(a => a.id === id);
        if (!admin) {
            console.error('Admin not found with id:', id);
            return;
        }
        
        if (confirm(`Are you sure you want to delete "${admin.name}"?`)) {
            try {
                await db.collection('admins').doc(id).delete();
                await this.loadAdmins();
                alert(`Admin "${admin.name}" has been deleted successfully!`);
            } catch (error) {
                console.error('Error deleting admin:', error);
                let errorMessage = 'Failed to delete admin. Please try again.';
                
                if (error.code === 'permission-denied') {
                    errorMessage = 'Permission denied. Please check your Firebase rules.';
                } else if (error.message) {
                    errorMessage = error.message;
                }
                
                alert(errorMessage);
            }
        }
    }
    
    /**
     * Fetch Alfa dashboard data for a newly created admin
     * @param {string} adminId - Admin document ID
     * @param {string} phone - Alfa phone number
     * @param {string} password - Alfa password
     * @param {string} name - Admin name (for logging)
     */
    async fetchAlfaDataForAdmin(adminId, phone, password, name) {
        // Check if AlfaAPIService is available
        if (typeof window.AlfaAPIService === 'undefined' || !window.AlfaAPIService) {
            throw new Error('AlfaAPIService not loaded. Make sure backend server is running and alfa-api.js is loaded.');
        }
        
        console.log(`📡 Fetching Alfa data for admin: ${name} (${phone})`);
        
        try {
            // Check backend health first
            const isHealthy = await window.AlfaAPIService.checkHealth();
            if (!isHealthy) {
                throw new Error('Backend server is not responding. Please make sure the server is running (node server.js)');
            }
            
            console.log('✅ Backend server is healthy');
            
            // Fetch Alfa data
            const alfaData = await window.AlfaAPIService.fetchDashboardData(phone, password, adminId);
            
            if (!alfaData) {
                throw new Error('No data returned from backend');
            }
            
            console.log('✅ Alfa data received:', {
                hasBalance: !!alfaData.balance,
                hasTotalConsumption: !!alfaData.totalConsumption,
                hasAdminConsumption: !!alfaData.adminConsumption,
                subscribersCount: alfaData.subscribersCount
            });
            
            // Update admin document with Alfa data
            console.log('💾 Saving Alfa data to Firestore for admin:', adminId);
            await db.collection('admins').doc(adminId).update({
                alfaData: alfaData,
                alfaDataFetchedAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            console.log('✅ Alfa data saved to Firestore successfully');
            
            // Trigger a refresh of the insights page if it's open
            window.dispatchEvent(new CustomEvent('alfaDataUpdated', { 
                detail: { adminId: adminId, timestamp: Date.now() } 
            }));
            
            return alfaData;
        } catch (error) {
            console.error('❌ Error in fetchAlfaDataForAdmin:', error);
            throw error;
        }
    }
    
}

// Initialize when DOM is ready
let adminsManager;
document.addEventListener('DOMContentLoaded', () => {
    adminsManager = new AdminsManager();
});

