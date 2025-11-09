// Insights Page Script
class InsightsManager {
    constructor() {
        this.currentPage = 1;
        this.rowsPerPage = 25;
        this.subscribers = [];
        this.filteredSubscribers = [];
        this.selectedRows = new Set();
        this.denseMode = false;
        // Default to 'all' to show all admins, but will be set from HTML on init
        this.activeTab = 'all';
        this.filters = {
            type: [],
            search: '',
            availableServices: false
        };
        
        this.init();
    }
    
    loadSubscribers() {
        try {
            // Check if db is available
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
            }
            
            // Use real-time listener to automatically update when data changes
            if (this.unsubscribe) {
                // Unsubscribe from previous listener if exists
                this.unsubscribe();
            }
            
            // Set up real-time listener - this will automatically update when admins are added/updated
            // Note: Compat version doesn't support third parameter (options)
            this.unsubscribe = db.collection('admins').onSnapshot(
                (snapshot) => {
                    console.log('🔄 Real-time listener triggered!', {
                        docCount: snapshot.docs.length,
                        timestamp: new Date().toISOString()
                    });
                    
                    // Log what changed (compat version uses docChanges() as a method)
                    try {
                        const changes = snapshot.docChanges ? snapshot.docChanges() : [];
                        if (changes.length > 0) {
                            console.log(`📝 Detected ${changes.length} document change(s):`);
                            changes.forEach((change) => {
                                const changeData = change.doc.data();
                                console.log(`   - ${change.type}: ${change.doc.id}`);
                            });
                        } else {
                            console.log('📝 No document changes detected (full snapshot)');
                        }
                    } catch (e) {
                        console.log('📝 Could not get docChanges (compat version limitation)');
                    }
                    
                    // Check if this is from cache (offline mode)
                    const source = snapshot.metadata && snapshot.metadata.fromCache ? 'cache' : 'server';
                    if (source === 'cache') {
                        console.warn('⚠️ Using cached data - offline mode or connection issue');
                        // If we're using cache, check if we need to wait for server data
                        // This can happen when data was just saved but cache hasn't updated yet
                        const hasRecentChanges = snapshot.docChanges && snapshot.docChanges().length > 0;
                        if (hasRecentChanges) {
                            console.log('⏳ Recent changes detected from cache, will process but may need server sync');
                        }
                    } else {
                        console.log('✅ Reading from server (fresh data)');
                    }
                    
                    // Process the snapshot
                    this.processSubscribers(snapshot);
                },
                (error) => {
                    console.error('Error in real-time listener:', error);
                    
                    // Handle specific error types
                    let errorMessage = 'Error loading admins';
                    if (error.code === 'unavailable') {
                        errorMessage = 'Cannot connect to Firestore. Please check your internet connection.';
                    } else if (error.code === 'permission-denied') {
                        errorMessage = 'Permission denied. Please check your Firebase rules.';
                    } else if (error.message) {
                        errorMessage = error.message;
                    }
                    
                    this.showError(errorMessage);
                    
                    // Try to reconnect after a delay
                    setTimeout(() => {
                        console.log('🔄 Attempting to reconnect to Firestore...');
                        if (this.unsubscribe) {
                            this.unsubscribe();
                        }
                        this.loadSubscribers();
                    }, 5000);
                }
            );
            
        } catch (error) {
            console.error('Error setting up real-time listener:', error);
            alert('Error loading admins: ' + error.message);
            this.subscribers = [];
            this.filteredSubscribers = [];
            this.renderTable();
            this.updatePagination();
            this.updatePageInfo();
        }
    }
    
    processSubscribers(snapshot) {
        try {
            console.log('📊 Processing subscribers snapshot...', {
                totalDocs: snapshot.docs.length,
                timestamp: new Date().toISOString()
            });
            
            // Check if snapshot has errors (compat version may not have metadata)
            if (snapshot.metadata && snapshot.metadata.hasPendingWrites) {
                console.log('📝 Snapshot has pending writes (local changes not yet synced)');
            }
            
            this.subscribers = snapshot.docs.map(doc => {
                const data = doc.data();
                
                // Quick status check
                const status = (data.status && data.status.toLowerCase().includes('inactive')) ? 'inactive' : 'active';
                const type = (data.type || 'open').toLowerCase();
                
                // Efficient date handling (do this FIRST so we can use createdAt later)
                let updatedAt = new Date();
                if (data.updatedAt) {
                    updatedAt = data.updatedAt.toDate ? data.updatedAt.toDate() : (data.updatedAt instanceof Date ? data.updatedAt : new Date(data.updatedAt));
                }
                
                let createdAt = updatedAt;
                if (data.createdAt) {
                    createdAt = data.createdAt.toDate ? data.createdAt.toDate() : (data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt));
                }
                
                // Get Alfa dashboard data if available
                const alfaData = data.alfaData || {};
                const hasAlfaData = alfaData && Object.keys(alfaData).length > 0 && !alfaData.error;
                
                // Helper function to parse consumption string like "47.97 / 77 GB" or "13 / 15 GB"
                function parseConsumption(consumptionStr) {
                    if (!consumptionStr || typeof consumptionStr !== 'string') return { used: 0, total: 0 };
                    const match = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    if (match) {
                        return {
                            used: parseFloat(match[1]) || 0,
                            total: parseFloat(match[2]) || 0
                        };
                    }
                    return { used: 0, total: 0 };
                }
                
                // Helper function to parse balance string like "$ 3.05" or "$ -0.29"
                function parseBalance(balanceStr) {
                    if (!balanceStr || typeof balanceStr !== 'string') return 0;
                    // Remove $ and spaces, extract number
                    const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                    return match ? parseFloat(match[0]) : 0;
                }
                
                // Extract total consumption (format: "47.97 / 77 GB")
                let totalConsumption = 0;
                let totalLimit = data.quota || 0;
                if (hasAlfaData && alfaData.totalConsumption) {
                    const parsed = parseConsumption(alfaData.totalConsumption);
                    totalConsumption = parsed.used;
                    totalLimit = parsed.total || totalLimit;
                }
                
                // Extract admin consumption from U-Share Main circle
                // Format: number before "/" from U-Share Main circle / admin quota
                let adminConsumption = 0;
                let adminLimit = 0;
                
                // Admin limit is always the quota set when creating admin (extract number only)
                if (data.quota) {
                    // Handle if quota is a string with units (e.g., "15 GB" or "15")
                    const quotaStr = String(data.quota).trim();
                    const quotaMatch = quotaStr.match(/^([\d.]+)/);
                    adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
                }
                
                // Get the "used" value from the first consumption circle (U-Share Main)
                if (hasAlfaData && alfaData.consumptions && Array.isArray(alfaData.consumptions) && alfaData.consumptions.length > 0) {
                    // Find U-Share Main circle (first circle or one with "U-share Main" in planName)
                    const uShareMain = alfaData.consumptions.find(c => 
                        c.planName && c.planName.toLowerCase().includes('u-share main')
                    ) || alfaData.consumptions[0]; // Fallback to first circle
                    
                    if (uShareMain) {
                        // Extract just the number from "used" field (e.g., "17.11" from "17.11" or "17.11 / 77 GB")
                        if (uShareMain.used) {
                            const usedStr = String(uShareMain.used).trim();
                            const usedMatch = usedStr.match(/^([\d.]+)/);
                            adminConsumption = usedMatch ? parseFloat(usedMatch[1]) : parseFloat(usedStr) || 0;
                        } else if (uShareMain.usage) {
                            // Fallback to usage field if used doesn't exist
                            const usageStr = String(uShareMain.usage).trim();
                            const usageMatch = usageStr.match(/^([\d.]+)/);
                            adminConsumption = usageMatch ? parseFloat(usageMatch[1]) : 0;
                        }
                    }
                }
                
                // Extract balance (format: "$ 3.05" or "$ -0.29")
                let balance = 0;
                if (hasAlfaData && alfaData.balance) {
                    balance = parseBalance(alfaData.balance);
                }
                
                // Extract subscribers count
                const subscribersCount = hasAlfaData && alfaData.subscribersCount !== undefined 
                    ? (typeof alfaData.subscribersCount === 'number' ? alfaData.subscribersCount : parseInt(alfaData.subscribersCount) || 0)
                    : 0;
                
                // Extract expiration (number of days)
                const expiration = hasAlfaData && alfaData.expiration !== undefined 
                    ? (typeof alfaData.expiration === 'number' ? alfaData.expiration : parseInt(alfaData.expiration) || 0)
                    : 0;
                
                // Parse dates from Alfa data if available
                let subscriptionDate = this.formatDate(createdAt);
                let validityDate = this.formatDate(new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000));
                
                if (hasAlfaData && alfaData.subscriptionDate) {
                    subscriptionDate = alfaData.subscriptionDate;
                }
                if (hasAlfaData && alfaData.validityDate) {
                    validityDate = alfaData.validityDate;
                }
                
                return {
                    id: doc.id,
                    name: data.name || 'Unknown',
                    phone: data.phone || '',
                    type: type,
                    status: status,
                    totalConsumption: totalConsumption,
                    totalLimit: totalLimit || 1, // Avoid division by zero
                    subscriptionDate: subscriptionDate,
                    validityDate: validityDate,
                    subscribersCount: subscribersCount,
                    adminConsumption: adminConsumption,
                    adminLimit: adminLimit || 1, // Avoid division by zero
                    balance: balance,
                    expiration: expiration,
                    lastUpdate: updatedAt,
                    createdAt: createdAt,
                    alfaData: alfaData, // Store full alfaData for View Details modal
                    quota: data.quota // Store quota for admin limit
                };
            });
            
            // Sort alphabetically by name (A to Z) - optimized
            if (this.subscribers.length > 0) {
                this.subscribers.sort((a, b) => {
                    const nameA = (a.name || '').toLowerCase();
                    const nameB = (b.name || '').toLowerCase();
                    return nameA.localeCompare(nameB);
                });
            }
            
            // Use requestAnimationFrame for non-blocking operations
            requestAnimationFrame(() => {
                this.applyFilters();
                this.updateTabCounts();
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
            });
        } catch (error) {
            console.error('Error processing subscribers:', error);
            this.subscribers = [];
            this.filteredSubscribers = [];
            this.renderTable();
            this.updatePagination();
            this.updatePageInfo();
        }
    }
    
    showError(message) {
        const tbody = document.getElementById('subscribersTableBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" style="text-align: center; padding: 3rem; color: #ef4444;">
                        ${message}
                    </td>
                </tr>
            `;
        }
    }
    
    init() {
        // Set initial active tab from HTML
        const activeTabButton = document.querySelector('.tab-button.active');
        if (activeTabButton) {
            this.activeTab = activeTabButton.dataset.tab || 'all';
        }
        
        // Initialize unsubscribe function
        this.unsubscribe = null;
        
        this.bindEvents();
        this.showLoading();
        
        // Wait for Firebase to be ready
        this.waitForFirebase().then(() => {
            this.loadSubscribers();
        }).catch(error => {
            console.error('Firebase initialization error:', error);
            this.showError('Error loading data. Please refresh the page.');
        });
    }
    
    // Clean up listener when page is unloaded
    destroy() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
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
        const tbody = document.getElementById('subscribersTableBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        <div style="display: inline-block; width: 40px; height: 40px; border: 4px solid rgba(58, 10, 78, 0.2); border-top-color: #3a0a4e; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                        <p style="margin-top: 1rem;">Loading admins...</p>
                    </td>
                </tr>
            `;
        }
    }
    
    bindEvents() {
        // Tab buttons
        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tab = e.currentTarget.dataset.tab;
                this.setActiveTab(tab);
            });
        });
        
        // Type filter - custom dropdown
        const typeFilter = document.getElementById('typeFilter');
        const typeFilterDisplay = document.getElementById('typeFilterDisplay');
        
        if (typeFilter && typeFilterDisplay) {
            typeFilterDisplay.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleTypeDropdown(typeFilterDisplay, typeFilter);
            });
            
            // Close dropdown when clicking outside
            document.addEventListener('click', (e) => {
                const dropdown = document.querySelector('.type-filter-dropdown');
                if (dropdown && !typeFilterDisplay.contains(e.target) && !dropdown.contains(e.target)) {
                    this.closeTypeDropdown();
                }
            });
            
            typeFilter.addEventListener('change', () => {
                this.filters.type = Array.from(typeFilter.selectedOptions).map(opt => opt.value);
                this.updateTypeFilterDisplay();
                this.applyFilters();
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
            });
        }
        
        // Search input
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.filters.search = e.target.value.toLowerCase();
                this.applyFilters();
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
            });
        }
        
        // Available Services checkbox
        const availableServicesCheck = document.getElementById('availableServicesCheck');
        if (availableServicesCheck) {
            availableServicesCheck.addEventListener('change', (e) => {
                this.filters.availableServices = e.target.checked;
                this.applyFilters();
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
            });
        }
        
        // Total and Needed buttons
        const totalBtn = document.getElementById('totalBtn');
        if (totalBtn) {
            totalBtn.addEventListener('click', () => {
                console.log('Total clicked');
            });
        }
        
        const neededBtn = document.getElementById('neededBtn');
        if (neededBtn) {
            neededBtn.addEventListener('click', () => {
                console.log('Needed clicked');
            });
        }
        
        // Select all checkbox
        const selectAll = document.getElementById('selectAll');
        if (selectAll) {
            selectAll.addEventListener('change', (e) => {
                const checked = e.target.checked;
                this.selectedRows.clear();
                if (checked) {
                    this.getCurrentPageSubscribers().forEach(sub => {
                        this.selectedRows.add(sub.id);
                    });
                }
                this.renderTable();
            });
        }
        
        // Rows per page
        const rowsPerPage = document.getElementById('rowsPerPage');
        if (rowsPerPage) {
            rowsPerPage.addEventListener('change', (e) => {
                this.rowsPerPage = parseInt(e.target.value);
                this.currentPage = 1;
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
            });
        }
        
        // Pagination buttons
        const prevPage = document.getElementById('prevPage');
        if (prevPage) {
            prevPage.addEventListener('click', () => {
                if (this.currentPage > 1) {
                    this.currentPage--;
                    this.renderTable();
                    this.updatePagination();
                    this.updatePageInfo();
                }
            });
        }
        
        const nextPage = document.getElementById('nextPage');
        if (nextPage) {
            nextPage.addEventListener('click', () => {
                const totalPages = Math.ceil(this.filteredSubscribers.length / this.rowsPerPage);
                if (this.currentPage < totalPages) {
                    this.currentPage++;
                    this.renderTable();
                    this.updatePagination();
                    this.updatePageInfo();
                }
            });
        }
        
        // Dense toggle
        const denseToggle = document.getElementById('denseToggle');
        if (denseToggle) {
            denseToggle.addEventListener('change', (e) => {
                this.denseMode = e.target.checked;
                const table = document.getElementById('subscribersTable');
                if (table) {
                    if (this.denseMode) {
                        table.classList.add('dense');
                    } else {
                        table.classList.remove('dense');
                    }
                }
            });
        }
        
        // Add Subscribers button
        const addSubscribersBtn = document.getElementById('addSubscribersBtn');
        if (addSubscribersBtn) {
            addSubscribersBtn.addEventListener('click', (e) => {
                e.preventDefault();
                console.log('Add Subscribers clicked');
            });
        }
    }
    
    setActiveTab(tab) {
        this.activeTab = tab;
        
        // Update tab buttons
        document.querySelectorAll('.tab-button').forEach(btn => {
            if (btn.dataset.tab === tab) {
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
            } else {
                btn.classList.remove('active');
                btn.setAttribute('aria-selected', 'false');
            }
        });
        
        this.applyFilters();
        this.renderTable();
        this.updatePagination();
        this.updatePageInfo();
    }
    
    applyFilters() {
        this.filteredSubscribers = this.subscribers.filter(sub => {
            // Tab filter - 'all' shows everything
            if (this.activeTab === 'all') {
                // Show all, no status filter
            } else if (this.activeTab === 'active' && sub.status !== 'active') {
                return false;
            } else if (this.activeTab === 'inactive' && sub.status !== 'inactive') {
                return false;
            }
            
            // Type filter
            if (this.filters.type.length > 0 && !this.filters.type.includes(sub.type)) return false;
            
            // Search filter
            if (this.filters.search) {
                const searchLower = this.filters.search.toLowerCase();
                if (!sub.name.toLowerCase().includes(searchLower) &&
                    !sub.phone.includes(searchLower)) {
                    return false;
                }
            }
            
            // Available Services filter (placeholder logic)
            if (this.filters.availableServices) {
                // Add your logic here
            }
            
            return true;
        });
    }
    
    updateTabCounts() {
        const allCount = this.subscribers.length;
        const activeCount = this.subscribers.filter(s => s.status === 'active').length;
        const inactiveCount = this.subscribers.filter(s => s.status === 'inactive').length;
        
        document.getElementById('countAll').textContent = allCount;
        document.getElementById('countActive').textContent = activeCount;
        document.getElementById('countInactive').textContent = inactiveCount;
    }
    
    toggleTypeDropdown(display, nativeSelect) {
        // Remove existing dropdown if any
        const existing = document.querySelector('.type-filter-dropdown');
        if (existing) {
            existing.remove();
            display.classList.remove('open');
            return;
        }
        
        // Create dropdown menu
        const dropdown = document.createElement('div');
        dropdown.className = 'type-filter-dropdown';
        
        const options = [
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' }
        ];
        
        options.forEach(option => {
            const item = document.createElement('div');
            item.className = 'type-filter-option';
            const isSelected = Array.from(nativeSelect.selectedOptions).some(opt => opt.value === option.value);
            if (isSelected) {
                item.classList.add('selected');
            }
            
            const checkbox = document.createElement('span');
            checkbox.className = 'type-filter-checkbox';
            if (isSelected) {
                checkbox.innerHTML = '✓';
            }
            
            const label = document.createElement('span');
            label.className = 'type-filter-label';
            label.textContent = option.label;
            
            item.appendChild(checkbox);
            item.appendChild(label);
            
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const optionElement = nativeSelect.querySelector(`option[value="${option.value}"]`);
                if (optionElement) {
                    optionElement.selected = !optionElement.selected;
                    // Trigger change event
                    const event = new Event('change', { bubbles: true });
                    nativeSelect.dispatchEvent(event);
                }
                this.closeTypeDropdown();
            });
            
            dropdown.appendChild(item);
        });
        
        // Position dropdown
        const rect = display.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = (rect.bottom + 4) + 'px';
        dropdown.style.left = rect.left + 'px';
        dropdown.style.minWidth = rect.width + 'px';
        
        document.body.appendChild(dropdown);
        display.classList.add('open');
        
        // Close on escape key
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                this.closeTypeDropdown();
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);
    }
    
    closeTypeDropdown() {
        const dropdown = document.querySelector('.type-filter-dropdown');
        if (dropdown) {
            dropdown.remove();
        }
        const display = document.getElementById('typeFilterDisplay');
        if (display) {
            display.classList.remove('open');
        }
    }
    
    updateTypeFilterDisplay() {
        const typeFilter = document.getElementById('typeFilter');
        const display = document.getElementById('typeFilterDisplay');
        if (!typeFilter || !display) return;
        
        const placeholder = display.querySelector('.mui-select-placeholder');
        if (!placeholder) return;
        
        const selected = Array.from(typeFilter.selectedOptions).map(opt => opt.value);
        
        if (selected.length === 0) {
            placeholder.textContent = '';
            placeholder.style.color = 'rgba(0, 0, 0, 0.5)';
            if (!document.body.classList.contains('light-mode')) {
                placeholder.style.color = 'rgba(255, 255, 255, 0.5)';
            }
        } else {
            const labels = selected.map(val => val === 'open' ? 'Open' : 'Closed');
            placeholder.textContent = labels.join(', ');
            placeholder.style.color = '';
        }
    }
    
    getCurrentPageSubscribers() {
        const start = (this.currentPage - 1) * this.rowsPerPage;
        const end = start + this.rowsPerPage;
        return this.filteredSubscribers.slice(start, end);
    }
    
    renderTable() {
        const tbody = document.getElementById('subscribersTableBody');
        const table = document.getElementById('subscribersTable');
        const currentSubscribers = this.getCurrentPageSubscribers();
        
        // Preserve dense mode class
        if (table && this.denseMode) {
            table.classList.add('dense');
        } else if (table) {
            table.classList.remove('dense');
        }
        
        if (currentSubscribers.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No subscribers found
                    </td>
                </tr>
            `;
            return;
        }
        
        tbody.innerHTML = currentSubscribers.map(sub => this.renderRow(sub)).join('');
        
        // Bind event listeners to action buttons
        this.bindActionButtons();
        
        // Update select all checkbox
        const selectAll = document.getElementById('selectAll');
        const allSelected = currentSubscribers.every(sub => this.selectedRows.has(sub.id));
        selectAll.checked = allSelected && currentSubscribers.length > 0;
        selectAll.indeterminate = !allSelected && currentSubscribers.some(sub => this.selectedRows.has(sub.id));
    }
    
    renderRow(subscriber) {
        const totalPercent = (subscriber.totalConsumption / subscriber.totalLimit) * 100;
        const adminPercent = (subscriber.adminConsumption / subscriber.adminLimit) * 100;
        
        let progressClass = 'progress-fill';
        if (totalPercent >= 90) progressClass += ' error';
        else if (totalPercent >= 70) progressClass += ' warning';
        
        let adminProgressClass = 'progress-fill';
        if (adminPercent >= 90) adminProgressClass += ' error';
        else if (adminPercent >= 70) adminProgressClass += ' warning';
        
        const isSelected = this.selectedRows.has(subscriber.id);
        const lastUpdate = this.formatDateTime(subscriber.lastUpdate);
        
        return `
            <tr>
                <td>
                    <input type="checkbox" class="row-checkbox" ${isSelected ? 'checked' : ''} 
                           data-subscriber-id="${subscriber.id}">
                </td>
                <td>
                    <div>
                        <div class="subscriber-name">${this.escapeHtml(subscriber.name)}</div>
                        <div class="subscriber-phone">${this.escapeHtml(subscriber.phone)}</div>
                    </div>
                </td>
                <td>
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="${progressClass}" style="width: ${totalPercent}%"></div>
                        </div>
                        <div class="progress-text">${subscriber.totalConsumption.toFixed(2)} / ${subscriber.totalLimit} GB</div>
                    </div>
                </td>
                <td>${subscriber.subscriptionDate}</td>
                <td>${subscriber.validityDate}</td>
                <td>${subscriber.subscribersCount}</td>
                <td>
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="${adminProgressClass}" style="width: ${adminPercent}%"></div>
                        </div>
                        <div class="progress-text">${subscriber.adminConsumption.toFixed(2)} / ${subscriber.adminLimit} GB</div>
                    </div>
                </td>
                <td>$${subscriber.balance.toFixed(2)}</td>
                <td>${subscriber.expiration}</td>
                <td>
                    <div>
                        <div>${lastUpdate.date}</div>
                        <div style="font-size: 0.75rem; color: #94a3b8; margin-top: 0.25rem;">${lastUpdate.time}</div>
                    </div>
                </td>
                <td>
                    <span class="status-badge ${subscriber.status === 'inactive' ? 'inactive' : ''}">${subscriber.status}</span>
                </td>
                <td>
                    <div class="action-buttons">
                        <button class="action-btn view-btn" data-subscriber-id="${subscriber.id}" aria-label="Quick View">
                            <svg viewBox="0 0 24 24" fill="currentColor">
                                <path d="M9.75 12a2.25 2.25 0 1 1 4.5 0a2.25 2.25 0 0 1-4.5 0"/>
                                <path fill-rule="evenodd" d="M2 12c0 1.64.425 2.191 1.275 3.296C4.972 17.5 7.818 20 12 20s7.028-2.5 8.725-4.704C21.575 14.192 22 13.639 22 12c0-1.64-.425-2.191-1.275-3.296C19.028 6.5 16.182 4 12 4S4.972 6.5 3.275 8.704C2.425 9.81 2 10.361 2 12m10-3.75a3.75 3.75 0 1 0 0 7.5a3.75 3.75 0 0 0 0-7.5" clip-rule="evenodd"/>
                            </svg>
                        </button>
                        <button class="action-btn menu-btn" data-subscriber-id="${subscriber.id}">
                            <svg viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="12" cy="12" r="2"/>
                                <circle cx="12" cy="5" r="2"/>
                                <circle cx="12" cy="19" r="2"/>
                            </svg>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }
    
    bindActionButtons() {
        // Row checkboxes
        document.querySelectorAll('.row-checkbox[data-subscriber-id]').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const id = e.target.dataset.subscriberId;
                if (e.target.checked) {
                    this.selectedRows.add(id);
                } else {
                    this.selectedRows.delete(id);
                }
                this.updateSelectAll();
            });
        });
        
        // View buttons
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriber(id);
            });
        });
        
        // Menu buttons
        document.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });
    }
    
    updateSelectAll() {
        const selectAll = document.getElementById('selectAll');
        const currentSubscribers = this.getCurrentPageSubscribers();
        const allSelected = currentSubscribers.every(sub => this.selectedRows.has(sub.id));
        selectAll.checked = allSelected && currentSubscribers.length > 0;
        selectAll.indeterminate = !allSelected && currentSubscribers.some(sub => this.selectedRows.has(sub.id));
    }
    
    viewSubscriber(id) {
        const subscriber = this.subscribers.find(s => s.id === id);
        if (!subscriber) {
            console.error('Subscriber not found:', id);
            return;
        }
        
        // Extract view details data
        const viewData = this.extractViewDetailsData(subscriber);
        
        // Show modal
        this.showViewDetailsModal(viewData);
    }
    
    extractViewDetailsData(subscriber) {
        const data = {
            adminPhone: subscriber.phone,
            adminConsumption: subscriber.adminConsumption || 0,
            adminLimit: subscriber.adminLimit || 0,
            subscribers: [],
            totalConsumption: 0,
            totalLimit: 0
        };
        
        // Helper function to parse consumption string (same as in processSubscribers)
        function parseConsumption(consumptionStr) {
            if (!consumptionStr || typeof consumptionStr !== 'string') return { used: 0, total: 0 };
            const match = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
            if (match) {
                return {
                    used: parseFloat(match[1]) || 0,
                    total: parseFloat(match[2]) || 0
                };
            }
            return { used: 0, total: 0 };
        }
        
        // Get total consumption from API (same as in insights table)
        // This ensures the modal shows the exact same value as the table
        if (subscriber.alfaData && subscriber.alfaData.totalConsumption) {
            const parsed = parseConsumption(subscriber.alfaData.totalConsumption);
            data.totalConsumption = parsed.used;
            data.totalLimit = parsed.total || data.totalLimit;
        }
        
        // Get subscriber data from consumption circles (for displaying individual subscribers)
        if (subscriber.alfaData && subscriber.alfaData.consumptions && Array.isArray(subscriber.alfaData.consumptions)) {
            subscriber.alfaData.consumptions.forEach(circle => {
                // Check if this is a U-share secondary circle
                if (circle.planName && circle.planName.toLowerCase().includes('u-share secondary')) {
                    // Extract phone number from circle
                    let phoneNumber = null;
                    if (circle.phoneNumber) {
                        phoneNumber = circle.phoneNumber;
                    } else {
                        // Try to extract from circle data (might be in different format)
                        const circleStr = JSON.stringify(circle);
                        const phoneMatch = circleStr.match(/(\d{8,})/);
                        if (phoneMatch) {
                            phoneNumber = phoneMatch[1];
                        }
                    }
                    
                    // Extract consumption values
                    let used = 0;
                    let total = 0;
                    
                    // First try to parse from usage string (format: "1.18 / 30 GB" or "1.18/30 GB")
                    if (circle.usage) {
                        const usageStr = String(circle.usage).trim();
                        const usageMatch = usageStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                        if (usageMatch) {
                            used = parseFloat(usageMatch[1]) || 0;
                            total = parseFloat(usageMatch[2]) || 0;
                        }
                    }
                    
                    // If usage didn't work, try used field (might contain "1.18/30")
                    if (used === 0 && circle.used) {
                        const usedStr = String(circle.used).trim();
                        // Check if it contains "/" (format: "1.18/30")
                        if (usedStr.includes('/')) {
                            const usedMatch = usedStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                            if (usedMatch) {
                                used = parseFloat(usedMatch[1]) || 0;
                                total = parseFloat(usedMatch[2]) || 0;
                            }
                        } else {
                            // Just a number
                            const usedMatch = usedStr.match(/^([\d.]+)/);
                            used = usedMatch ? parseFloat(usedMatch[1]) : parseFloat(usedStr) || 0;
                        }
                    }
                    
                    // Extract total from circle.total if still not found
                    if (total === 0 && circle.total) {
                        const totalStr = String(circle.total).trim();
                        const totalMatch = totalStr.match(/^([\d.]+)/);
                        total = totalMatch ? parseFloat(totalMatch[1]) : parseFloat(totalStr) || 0;
                    }
                    
                    if (phoneNumber && (used > 0 || total > 0)) {
                        data.subscribers.push({
                            phoneNumber: phoneNumber,
                            consumption: used,
                            limit: total
                        });
                        // Note: We don't add to totalConsumption here anymore - it comes from API
                    }
                }
            });
        }
        
        // Fallback: If API doesn't have totalConsumption, calculate from admin + subscribers
        // This should rarely happen, but provides a fallback
        if (data.totalConsumption === 0 && (!subscriber.alfaData || !subscriber.alfaData.totalConsumption)) {
            // Sum subscriber consumptions
            data.subscribers.forEach(sub => {
                data.totalConsumption += sub.consumption;
                data.totalLimit += sub.limit;
            });
            // Add admin consumption
            data.totalConsumption += data.adminConsumption;
            // Total limit is admin limit + subscriber limits
            data.totalLimit = data.adminLimit + data.totalLimit;
        }
        
        return data;
    }
    
    showViewDetailsModal(data) {
        // Remove existing modal if any
        const existingModal = document.getElementById('viewDetailsModal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Create modal
        const modal = document.createElement('div');
        modal.id = 'viewDetailsModal';
        modal.className = 'view-details-modal-overlay';
        modal.innerHTML = `
            <div class="view-details-modal">
                <div class="view-details-modal-header">
                    <h2>View Details</h2>
                </div>
                <div class="view-details-modal-body">
                    <table class="view-details-table">
                        <thead>
                            <tr>
                                <th>User Number</th>
                                <th>Consumption</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${this.generateViewDetailsRows(data)}
                        </tbody>
                    </table>
                </div>
                <div class="view-details-modal-footer">
                    <button class="btn-cancel" onclick="this.closest('.view-details-modal-overlay').remove()">Cancel</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
        
        // Close on Escape key
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);
    }
    
    generateViewDetailsRows(data) {
        let rows = '';
        
        // Admin row
        const adminPercent = data.adminLimit > 0 ? (data.adminConsumption / data.adminLimit) * 100 : 0;
        const adminProgressClass = adminPercent >= 100 ? 'progress-fill error' : 'progress-fill';
        rows += `
            <tr>
                <td>Admin - ${data.adminPhone}</td>
                <td>
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="${adminProgressClass}" style="width: ${Math.min(100, adminPercent)}%"></div>
                        </div>
                        <div class="progress-text">${data.adminConsumption.toFixed(2)} / ${data.adminLimit} GB</div>
                    </div>
                </td>
            </tr>
        `;
        
        // Subscriber rows
        data.subscribers.forEach(sub => {
            const subPercent = sub.limit > 0 ? (sub.consumption / sub.limit) * 100 : 0;
            const subProgressClass = subPercent >= 100 ? 'progress-fill error' : 'progress-fill';
            rows += `
                <tr>
                    <td>${sub.phoneNumber}</td>
                    <td>
                        <div class="progress-container">
                            <div class="progress-bar">
                                <div class="${subProgressClass}" style="width: ${Math.min(100, subPercent)}%"></div>
                            </div>
                            <div class="progress-text">${sub.consumption.toFixed(2)} / ${sub.limit} GB</div>
                        </div>
                    </td>
                </tr>
            `;
        });
        
        // Total row
        const totalPercent = data.totalLimit > 0 ? (data.totalConsumption / data.totalLimit) * 100 : 0;
        const totalProgressClass = totalPercent >= 100 ? 'progress-fill error' : 'progress-fill';
        rows += `
            <tr class="total-row">
                <td><strong>Total</strong></td>
                <td>
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="${totalProgressClass}" style="width: ${Math.min(100, totalPercent)}%"></div>
                        </div>
                        <div class="progress-text">${data.totalConsumption.toFixed(2)} / ${data.totalLimit} GB</div>
                    </div>
                </td>
            </tr>
        `;
        
        return rows;
    }
    
    toggleMenu(id, button) {
        // Close any existing menus
        document.querySelectorAll('.dropdown-menu').forEach(menu => {
            if (menu.dataset.subscriberId !== id) {
                menu.remove();
            }
        });
        
        // Check if menu already exists
        let menu = document.querySelector(`.dropdown-menu[data-subscriber-id="${id}"]`);
        
        if (menu) {
            menu.remove();
            return;
        }
        
        // Create menu
        menu = document.createElement('div');
        menu.className = 'dropdown-menu';
        menu.dataset.subscriberId = id;
        menu.innerHTML = `
            <div class="dropdown-item" data-action="refresh">
                <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
                    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                </svg>
                Refresh
            </div>
            <div class="dropdown-item" data-action="edit">
                <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
                    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                </svg>
                Edit
            </div>
        `;
        
        // Position menu
        const rect = button.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.right = `${window.innerWidth - rect.right}px`;
        menu.style.zIndex = '10000';
        
        document.body.appendChild(menu);
        
        // Add click handlers
        menu.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;
                this.handleMenuAction(action, id);
                menu.remove();
            });
        });
        
        // Close on outside click
        setTimeout(() => {
            const clickHandler = (e) => {
                if (!menu.contains(e.target) && e.target !== button) {
                    menu.remove();
                    document.removeEventListener('click', clickHandler);
                }
            };
            document.addEventListener('click', clickHandler);
        }, 0);
    }
    
    handleMenuAction(action, id) {
        if (action === 'refresh') {
            this.refreshSubscriber(id);
        } else if (action === 'edit') {
            this.editSubscriber(id);
        }
    }
    
    async refreshSubscriber(id) {
        try {
            console.log('Refreshing subscriber:', id);
            
            // Find the subscriber in our data
            const subscriber = this.subscribers.find(s => s.id === id);
            if (!subscriber) {
                console.error('Subscriber not found:', id);
                return;
            }
            
            // Get admin data from Firestore to get phone and password
            const adminDoc = await db.collection('admins').doc(id).get();
            if (!adminDoc.exists) {
                console.error('Admin not found in Firestore:', id);
                return;
            }
            
            const adminData = adminDoc.data();
            const phone = adminData.phone;
            const password = adminData.password;
            
            if (!phone || !password) {
                console.error('Phone or password missing for admin:', id);
                alert('Cannot refresh: Phone or password missing');
                return;
            }
            
            // Check if AlfaAPIService is available
            if (typeof window.AlfaAPIService === 'undefined' || !window.AlfaAPIService) {
                alert('Backend service not available. Please make sure the server is running and alfa-api.js is loaded.');
                return;
            }
            
            // Show loading indicator
            const row = document.querySelector(`tr[data-subscriber-id="${id}"]`);
            if (row) {
                row.style.opacity = '0.5';
            }
            
            // Fetch Alfa data
            const alfaData = await window.AlfaAPIService.fetchDashboardData(phone, password, id);
            
            // Update admin document with new Alfa data
            await db.collection('admins').doc(id).update({
                alfaData: alfaData,
                alfaDataFetchedAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            console.log('Alfa data refreshed successfully');
            
            // Data will automatically update via real-time listener
            if (row) {
                row.style.opacity = '1';
            }
            
        } catch (error) {
            console.error('Error refreshing subscriber:', error);
            alert('Failed to refresh data: ' + error.message);
            
            // Restore row opacity
            const row = document.querySelector(`tr[data-subscriber-id="${id}"]`);
            if (row) {
                row.style.opacity = '1';
            }
        }
    }
    
    editSubscriber(id) {
        console.log('Edit subscriber:', id);
        // Implement edit functionality
    }
    
    updatePagination() {
        const totalPages = Math.ceil(this.filteredSubscribers.length / this.rowsPerPage);
        const prevBtn = document.getElementById('prevPage');
        const nextBtn = document.getElementById('nextPage');
        
        prevBtn.disabled = this.currentPage === 1;
        nextBtn.disabled = this.currentPage >= totalPages || totalPages === 0;
    }
    
    updatePageInfo() {
        const total = this.filteredSubscribers.length;
        const start = total === 0 ? 0 : (this.currentPage - 1) * this.rowsPerPage + 1;
        const end = Math.min(this.currentPage * this.rowsPerPage, total);
        
        document.getElementById('pageInfo').textContent = `${start}–${end} of ${total}`;
    }
    
    formatDate(date) {
        if (!date) return 'N/A';
        const d = new Date(date);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
    }
    
    formatDateTime(date) {
        if (!date) return { date: 'N/A', time: '' };
        const d = new Date(date);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        let hours = d.getHours();
        const minutes = String(d.getMinutes()).padStart(2, '0');
        const seconds = String(d.getSeconds()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12;
        const hoursStr = String(hours).padStart(2, '0');
        
        return {
            date: `${day}/${month}/${year}`,
            time: `${hoursStr}:${minutes}:${seconds} ${ampm}`
        };
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize when DOM is ready
let insightsManager;
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        insightsManager = new InsightsManager();
    });
} else {
    insightsManager = new InsightsManager();
}
