/**
 * Flow Manager Page
 * Manages flow assignments table with search, sorting, and pagination
 */

class FlowManager {
    constructor() {
        this.currentPage = 1;
        this.rowsPerPage = 25;
        this.flows = [];
        this.filteredFlows = [];
        this.searchQuery = '';
        this.sortField = 'daysLeft';
        this.sortDirection = 'asc';
        this.denseMode = false;
        this.currentUserId = null;
        this.unsubscribe = null; // Firebase listener unsubscribe function
        this.currentAdminData = null; // Store admin data for modal
        this.adminsMap = new Map(); // Map adminId to admin document data
        
        this.init();
    }
    
    /**
     * Clean up Firebase listener
     */
    destroy() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
    }
    
    /**
     * Initialize the flow manager
     */
    async init() {
        try {
            await this.waitForAuth();
            await this.waitForFirebase();
            this.bindEvents();
            await this.loadFlows();
        } catch (error) {
            // Ignore browser extension errors (they're harmless)
            if (error.message && error.message.includes('message channel')) {
                return;
            }
            console.error('Error initializing Flow Manager:', error);
        }
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
                    console.log('✅ [Flow Manager] User authenticated:', user.uid);
                    unsubscribe();
                    resolve();
                } else {
                    if (auth.currentUser && auth.currentUser.uid) {
                        this.currentUserId = auth.currentUser.uid;
                        console.log('✅ [Flow Manager] User already authenticated:', auth.currentUser.uid);
                        unsubscribe();
                        resolve();
                    }
                }
            });
            
            setTimeout(() => {
                unsubscribe();
                reject(new Error('Auth timeout'));
            }, 10000);
        });
    }
    
    /**
     * Wait for Firebase to be ready
     */
    async waitForFirebase() {
        let attempts = 0;
        while (typeof db === 'undefined' && attempts < 50) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
        if (typeof db === 'undefined') {
            throw new Error('Firebase Firestore not loaded');
        }
    }
    
    /**
     * Bind event listeners
     */
    bindEvents() {
        // Search input
        const searchInput = document.getElementById('flowSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value;
                this.currentPage = 1;
                this.applyFilters();
                this.renderTable();
                this.updatePagination();
            });
        }
        
        // Manage Flow button
        const manageFlowBtn = document.getElementById('manageFlowBtn');
        if (manageFlowBtn) {
            manageFlowBtn.addEventListener('click', () => {
                alert('Manage Assignments functionality coming soon!');
            });
        }
        
        // Sortable headers
        const sortableHeaders = document.querySelectorAll('.sortable-header');
        sortableHeaders.forEach(header => {
            header.addEventListener('click', () => {
                const sortField = header.getAttribute('data-sort');
                if (sortField) {
                    if (this.sortField === sortField) {
                        this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                    } else {
                        this.sortField = sortField;
                        this.sortDirection = 'asc';
                    }
                    this.updateSortIndicators();
                    this.applyFilters();
                    this.renderTable();
                }
            });
        });
        
        // Rows per page
        const rowsPerPage = document.getElementById('rowsPerPage');
        if (rowsPerPage) {
            rowsPerPage.addEventListener('change', (e) => {
                this.rowsPerPage = parseInt(e.target.value);
                this.currentPage = 1;
                this.renderTable();
                this.updatePagination();
            });
        }
        
        // Pagination buttons
        const prevPage = document.getElementById('prevPage');
        const nextPage = document.getElementById('nextPage');
        if (prevPage) {
            prevPage.addEventListener('click', () => {
                if (this.currentPage > 1) {
                    this.currentPage--;
                    this.renderTable();
                    this.updatePagination();
                }
            });
        }
        if (nextPage) {
            nextPage.addEventListener('click', () => {
                const maxPage = Math.ceil(this.filteredFlows.length / this.rowsPerPage);
                if (this.currentPage < maxPage) {
                    this.currentPage++;
                    this.renderTable();
                    this.updatePagination();
                }
            });
        }
        
        // Dense toggle
        const denseToggle = document.getElementById('denseToggle');
        if (denseToggle) {
            denseToggle.addEventListener('change', (e) => {
                this.denseMode = e.target.checked;
                const table = document.getElementById('flowTable');
                if (table) {
                    if (this.denseMode) {
                        table.classList.add('dense');
                    } else {
                        table.classList.remove('dense');
                    }
                }
            });
        }
        
        // Modal close button
        const manageFlowClose = document.getElementById('manageFlowClose');
        if (manageFlowClose) {
            manageFlowClose.addEventListener('click', () => {
                this.closeManageFlowModal();
            });
        }
        
        // Modal cancel button
        const manageFlowCancel = document.getElementById('manageFlowCancel');
        if (manageFlowCancel) {
            manageFlowCancel.addEventListener('click', () => {
                this.closeManageFlowModal();
            });
        }
        
        // Modal overlay click to close
        const manageFlowModal = document.getElementById('manageFlowModal');
        if (manageFlowModal) {
            manageFlowModal.addEventListener('click', (e) => {
                if (e.target === manageFlowModal) {
                    this.closeManageFlowModal();
                }
            });
        }
        
        // Modal save button
        const manageFlowSave = document.getElementById('manageFlowSave');
        if (manageFlowSave) {
            manageFlowSave.addEventListener('click', () => {
                this.saveManageFlow();
            });
        }
    }
    
    /**
     * Load flows data from admins that match "Available Services" criteria
     * Extracts subscribers from those admins and transforms them into flow format
     */
    async loadFlows() {
        try {
            const tbody = document.getElementById('flowTableBody');
            
            // Show loading state
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" class="loading-state">
                            <p>Loading flows...</p>
                        </td>
                    </tr>
                `;
            }
            
            // Load admins from Firebase using real-time listener
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized');
            }
            
            // Unsubscribe from previous listener if exists
            if (this.unsubscribe) {
                this.unsubscribe();
            }
            
            // Set up real-time listener
            this.unsubscribe = db.collection('admins')
                .where('userId', '==', this.currentUserId)
                .onSnapshot(
                    (snapshot) => {
                        // Store admin data in map for modal access
                        this.adminsMap.clear();
                        snapshot.docs.forEach(doc => {
                            this.adminsMap.set(doc.id, { id: doc.id, ...doc.data() });
                        });
                        this.processAdminsSnapshot(snapshot);
                    },
                    (error) => {
                        console.error('Error in Flow Manager real-time listener:', error);
                        const tbody = document.getElementById('flowTableBody');
                        if (tbody) {
                            tbody.innerHTML = `
                                <tr>
                                    <td colspan="6" class="empty-state" style="text-align: center; padding: 3rem;">
                                        <p style="color: #ef4444; margin-bottom: 1rem;">❌ Error loading flows</p>
                                        <p style="color: #94a3b8; font-size: 0.875rem;">${error.message}</p>
                                    </td>
                                </tr>
                            `;
                        }
                    }
                );
        } catch (error) {
            console.error('Error loading flows:', error);
            const tbody = document.getElementById('flowTableBody');
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" class="empty-state" style="text-align: center; padding: 3rem;">
                            <p style="color: #ef4444; margin-bottom: 1rem;">❌ Error loading flows</p>
                            <p style="color: #94a3b8; font-size: 0.875rem;">${error.message}</p>
                        </td>
                    </tr>
                `;
            }
        }
    }
    
    /**
     * Process admins snapshot and extract flows (one flow per admin)
     */
    processAdminsSnapshot(snapshot) {
        const flows = [];
        
        snapshot.docs.forEach(doc => {
            const adminData = doc.data();
            
            // Apply "Available Services" filter logic (same as insights.js)
            if (this.isAvailableService(adminData, doc.id)) {
                const alfaData = adminData.alfaData || {};
                const adminValidityDate = alfaData.validityDate || '';
                
                // Extract total bundle size (totalLimit) - same logic as insights.js
                // This is the number after "/" in total consumption (e.g., "47.97 / 77 GB" -> 77 GB)
                let totalLimit = 0;
                
                // Helper function to parse consumption string
                const parseConsumption = (consumptionStr) => {
                    if (!consumptionStr || typeof consumptionStr !== 'string') return { used: 0, total: 0 };
                    const match = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    return match ? { used: parseFloat(match[1]), total: parseFloat(match[2]) } : { used: 0, total: 0 };
                };
                
                // Try to extract from totalConsumption string (e.g., "47.97 / 77 GB")
                if (alfaData.totalConsumption && typeof alfaData.totalConsumption === 'string') {
                    const parsed = parseConsumption(alfaData.totalConsumption);
                    if (parsed.total > 0) {
                        totalLimit = parsed.total;
                    }
                }
                
                // If not found, try to extract from PackageValue (total bundle size)
                if (totalLimit === 0 && alfaData.primaryData) {
                    const primaryData = alfaData.primaryData;
                    const packageValues = [];
                    
                    if (primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue)) {
                        for (const service of primaryData.ServiceInformationValue) {
                            if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                for (const details of service.ServiceDetailsInformationValue) {
                                    if (details.PackageValue) {
                                        const packageStr = String(details.PackageValue).trim();
                                        const packageMatch = packageStr.match(/^([\d.]+)/);
                                        if (packageMatch) {
                                            const packageValue = parseFloat(packageMatch[1]);
                                            if (!isNaN(packageValue) && packageValue > 0) {
                                                packageValues.push(packageValue);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    
                    if (packageValues.length > 0) {
                        // Use the largest PackageValue as totalLimit
                        totalLimit = Math.max(...packageValues);
                    }
                }
                
                // Fallback to totalLimit field if available
                if (totalLimit === 0 && alfaData.totalLimit) {
                    totalLimit = parseFloat(alfaData.totalLimit) || 0;
                }
                
                // Final fallback to admin quota (less preferred, but better than 0)
                if (totalLimit === 0 && adminData.quota) {
                    const quotaStr = String(adminData.quota).trim();
                    const quotaMatch = quotaStr.match(/^([\d.]+)/);
                    totalLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
                }
                
                // Format size
                const size = totalLimit > 0 ? `${totalLimit}GB` : '0GB';
                
                // Calculate Current Flow from active subscribers
                // Display the quota (number after "/") for each subscriber, separated by " / "
                let currentFlow = null;
                const secondarySubscribers = alfaData.secondarySubscribers || [];
                
                // Filter active subscribers (status is 'Active' or missing/null)
                const activeSubscribers = secondarySubscribers.filter(sub => {
                    const status = sub.status || 'Active';
                    return status === 'Active' || status === 'active' || !status;
                });
                
                if (activeSubscribers.length > 0) {
                    // Collect quota from each active subscriber
                    const quotas = [];
                    
                    activeSubscribers.forEach(subscriber => {
                        let quota = 0;
                        
                        // Extract quota (the number after "/") - same logic as view details modal
                        if (typeof subscriber.quota === 'number') {
                            // Direct quota value
                            quota = subscriber.quota;
                        } else if (subscriber.totalQuota) {
                            // From Ushare HTML parser
                            quota = parseFloat(subscriber.totalQuota) || 0;
                        } else if (subscriber.consumptionText) {
                            // Parse from consumptionText (format: "0.48 / 30 GB") - get the number after "/"
                            const consumptionMatch = subscriber.consumptionText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                            if (consumptionMatch) {
                                quota = parseFloat(consumptionMatch[2]) || 0; // Second number is the quota
                            }
                        } else if (subscriber.consumption) {
                            // Parse from consumption string (format: "1.18 / 30 GB") - get the number after "/"
                            const consumptionStr = String(subscriber.consumption);
                            const consumptionMatch = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                            if (consumptionMatch) {
                                quota = parseFloat(consumptionMatch[2]) || 0; // Second number is the quota
                            }
                        } else if (subscriber.limit) {
                            // Fallback to limit
                            quota = parseFloat(subscriber.limit) || 0;
                        }
                        
                        // Add quota to array if found
                        if (quota > 0) {
                            quotas.push(quota.toFixed(2));
                        }
                    });
                    
                    // Display quotas separated by " / "
                    // Example: "12" for one subscriber, "12 / 12" for two, "12 / 12 / 12" for three
                    if (quotas.length > 0) {
                        currentFlow = quotas.join(' / ');
                    }
                }
                
                // Calculate days left from validity date
                const daysLeft = this.calculateDaysLeft(adminValidityDate);
                
                // Create flow entry for this admin
                flows.push({
                    id: doc.id,
                    number: adminData.phone || '',
                    name: adminData.name || '',
                    type: adminData.type === 'closed' ? 'Closed' : 'Open',
                    size: size,
                    currentFlow: currentFlow, // Will be "X / Y" or null
                    daysLeft: daysLeft || 0,
                    expirationDate: adminValidityDate,
                    adminId: doc.id
                });
            }
        });
        
        this.flows = flows;
        this.applyFilters();
        this.renderTable();
        this.updatePagination();
    }
    
    /**
     * Check if admin matches "Available Services" criteria (same logic as insights.js)
     */
    isAvailableService(adminData, adminId) {
        const alfaData = adminData.alfaData || {};
        const secondarySubscribers = alfaData.secondarySubscribers || [];
        
        // Count subscribers by status
        let activeCount = 0;
        let requestedCount = 0;
        
        secondarySubscribers.forEach(sub => {
            const status = sub.status || 'Active';
            if (status === 'Active' || !status || status === 'active') {
                activeCount++;
            } else if (status === 'Requested' || status === 'requested') {
                requestedCount++;
            }
        });
        
        const removedActiveSubscribers = adminData.removedActiveSubscribers || [];
        const outCount = Array.isArray(removedActiveSubscribers) ? removedActiveSubscribers.length : 0;
        
        // EXCLUSION LOGIC: Check if admin matches any of the 9 exclusion conditions
        if (activeCount === 1 && requestedCount === 2 && outCount === 0) return false;
        if (activeCount === 0 && requestedCount === 3 && outCount === 0) return false;
        if (activeCount === 3 && requestedCount === 0 && outCount === 0) return false;
        if (activeCount === 2 && requestedCount === 1 && outCount === 0) return false;
        if (activeCount === 1 && requestedCount === 0 && outCount === 2) return false;
        if (activeCount === 2 && requestedCount === 0 && outCount === 1) return false;
        if (activeCount === 1 && requestedCount === 1 && outCount === 1) return false;
        if (activeCount === 0 && requestedCount === 2 && outCount === 1) return false;
        if (activeCount === 0 && requestedCount === 1 && outCount === 2) return false;
        
        // TERM 1 & 2: Total subscribers must be < 3
        const totalSubscribersCount = activeCount + requestedCount + outCount;
        if (totalSubscribersCount >= 3) return false;
        
        // TERM 3: Admin must have minimum 20 days before validity date
        const validityDateStr = alfaData.validityDate || '';
        const daysUntil = this.calculateDaysLeft(validityDateStr);
        if (daysUntil === null || daysUntil < 20) return false;
        
        return true;
    }
    
    /**
     * Calculate days left until validity date
     */
    calculateDaysLeft(validityDateStr) {
        if (!validityDateStr || validityDateStr === 'N/A' || validityDateStr.trim() === '') {
            return null;
        }
        
        // Parse DD/MM/YYYY format
        const parts = String(validityDateStr).trim().split('/');
        if (parts.length !== 3) return null;
        
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
        const year = parseInt(parts[2], 10);
        
        if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
        
        const validityDate = new Date(year, month, day);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        validityDate.setHours(0, 0, 0, 0);
        
        const diffTime = validityDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        return diffDays;
    }
    
    /**
     * Apply search and sort filters
     */
    applyFilters() {
        // Filter by search query
        this.filteredFlows = this.flows.filter(flow => {
            if (!this.searchQuery) return true;
            
            const searchLower = this.searchQuery.toLowerCase();
            return (
                (flow.number && flow.number.toString().includes(this.searchQuery)) ||
                (flow.name && flow.name.toLowerCase().includes(searchLower)) ||
                (flow.type && flow.type.toLowerCase().includes(searchLower)) ||
                (flow.currentFlow && flow.currentFlow.toString().includes(this.searchQuery))
            );
        });
        
        // Sort
        this.filteredFlows.sort((a, b) => {
            let aValue = a[this.sortField];
            let bValue = b[this.sortField];
            
            // Handle different data types
            if (this.sortField === 'daysLeft') {
                aValue = aValue || 0;
                bValue = bValue || 0;
            } else if (this.sortField === 'size') {
                // Extract numeric value from "44GB" format
                aValue = parseFloat(aValue) || 0;
                bValue = parseFloat(bValue) || 0;
            } else if (typeof aValue === 'string') {
                aValue = aValue.toLowerCase();
                bValue = (bValue || '').toLowerCase();
            }
            
            if (aValue < bValue) {
                return this.sortDirection === 'asc' ? -1 : 1;
            }
            if (aValue > bValue) {
                return this.sortDirection === 'asc' ? 1 : -1;
            }
            return 0;
        });
    }
    
    /**
     * Update sort indicators in table headers
     */
    updateSortIndicators() {
        const headers = document.querySelectorAll('.sortable-header');
        headers.forEach(header => {
            const sortField = header.getAttribute('data-sort');
            header.classList.remove('sort-active');
            
            if (sortField === this.sortField) {
                header.classList.add('sort-active');
                header.setAttribute('data-sort-direction', this.sortDirection);
                
                // Update sort icon
                const sortIcon = header.querySelector('.sort-icon');
                if (sortIcon) {
                    sortIcon.classList.remove('sort-asc', 'sort-desc');
                    sortIcon.classList.add(this.sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
                }
            }
        });
    }
    
    /**
     * Render the table
     */
    renderTable() {
        const tbody = document.getElementById('flowTableBody');
        if (!tbody) return;
        
        if (this.filteredFlows.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="empty-state">
                        <p>No flows found</p>
                    </td>
                </tr>
            `;
            return;
        }
        
        // Calculate pagination
        const startIndex = (this.currentPage - 1) * this.rowsPerPage;
        const endIndex = startIndex + this.rowsPerPage;
        const pageFlows = this.filteredFlows.slice(startIndex, endIndex);
        
        tbody.innerHTML = pageFlows.map(flow => this.renderFlowRow(flow)).join('');
    }
    
    /**
     * Render a single flow row
     */
    renderFlowRow(flow) {
        const daysLeft = flow.daysLeft || 0;
        const expirationDate = flow.expirationDate || '';
        
        return `
            <tr>
                <td>
                    <div class="number-cell">
                        <button class="number-link" onclick="navigator.clipboard.writeText('${flow.number || ''}')">
                            ${flow.number || 'N/A'}
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                            </svg>
                        </button>
                        ${flow.name ? `<span class="number-name">${flow.name}</span>` : ''}
                    </div>
                </td>
                <td>
                    <span class="type-badge">${flow.type || 'Open'}</span>
                </td>
                <td>
                    <p class="size-text">${flow.size || 'N/A'}</p>
                </td>
                <td>
                    <div class="current-flow-cell">
                        ${flow.currentFlow 
                            ? `<p class="current-flow-value current-flow-consumption">${flow.currentFlow}</p>`
                            : `<span class="current-flow-not-set">Not Set</span>`
                        }
                    </div>
                </td>
                <td>
                    <div class="days-left-cell">
                        <div class="days-chip">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m4.3 7.61l-4.57 6a1 1 0 0 1-.79.39a1 1 0 0 1-.79-.38l-2.44-3.11a1 1 0 0 1 1.58-1.23l1.63 2.08l3.78-5a1 1 0 1 1 1.6 1.22Z"/>
                            </svg>
                            <span>${daysLeft} days</span>
                        </div>
                        ${expirationDate ? `<span class="days-date">${expirationDate}</span>` : ''}
                    </div>
                </td>
                <td style="text-align: right;">
                    <button class="manage-btn" data-admin-id="${flow.adminId}" onclick="flowManager.openManageFlowModal('${flow.adminId}')">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="1.5"/>
                            <path d="M20.32 9.37h-1.09c-.14 0-.24-.11-.3-.26a.34.34 0 0 1 0-.37l.81-.74a1.63 1.63 0 0 0 .5-1.18a1.67 1.67 0 0 0-.5-1.19L18.4 4.26a1.67 1.67 0 0 0-2.37 0l-.77.74a.38.38 0 0 1-.41 0a.34.34 0 0 1-.22-.29V3.68A1.68 1.68 0 0 0 13 2h-1.94a1.69 1.69 0 0 0-1.69 1.68v1.09c0 .14-.11.24-.26.3a.34.34 0 0 1-.37 0L8 4.26a1.72 1.72 0 0 0-1.19-.5a1.65 1.65 0 0 0-1.18.5L4.26 5.6a1.67 1.67 0 0 0 0 2.4l.74.74a.38.38 0 0 1 0 .41a.34.34 0 0 1-.29.22H3.68A1.68 1.68 0 0 0 2 11.05v1.89a1.69 1.69 0 0 0 1.68 1.69h1.09c.14 0 .24.11.3.26a.34.34 0 0 1 0 .37l-.81.74a1.72 1.72 0 0 0-.5 1.19a1.66 1.66 0 0 0 .5 1.19l1.34 1.36a1.67 1.67 0 0 0 2.37 0l.77-.74a.38.38 0 0 1 .41 0a.34.34 0 0 1 .22.29v1.09A1.68 1.68 0 0 0 11.05 22h1.89a1.69 1.69 0 0 0 1.69-1.68v-1.09c0-.14.11-.24.26-.3a.34.34 0 0 1 .37 0l.76.77a1.72 1.72 0 0 0 1.19.5a1.65 1.65 0 0 0 1.18-.5l1.34-1.34a1.67 1.67 0 0 0 0-2.37l-.73-.73a.34.34 0 0 1 0-.37a.34.34 0 0 1 .29-.22h1.09A1.68 1.68 0 0 0 22 13v-1.94a1.69 1.69 0 0 0-1.68-1.69M12 15.5a3.5 3.5 0 1 1 3.5-3.5a3.5 3.5 0 0 1-3.5 3.5"/>
                        </svg>
                        Manage
                    </button>
                </td>
            </tr>
        `;
    }
    
    /**
     * Update pagination controls
     */
    updatePagination() {
        const pageInfo = document.getElementById('pageInfo');
        const prevPage = document.getElementById('prevPage');
        const nextPage = document.getElementById('nextPage');
        
        const totalItems = this.filteredFlows.length;
        const startIndex = (this.currentPage - 1) * this.rowsPerPage;
        const endIndex = Math.min(startIndex + this.rowsPerPage, totalItems);
        
        if (pageInfo) {
            if (totalItems === 0) {
                pageInfo.textContent = '0–0 of 0';
            } else {
                pageInfo.textContent = `${startIndex + 1}–${endIndex} of ${totalItems}`;
            }
        }
        
        if (prevPage) {
            prevPage.disabled = this.currentPage === 1;
        }
        
        if (nextPage) {
            const maxPage = Math.ceil(totalItems / this.rowsPerPage);
            nextPage.disabled = this.currentPage >= maxPage || totalItems === 0;
        }
    }
    
    /**
     * Open Manage Flow Modal for a specific admin
     */
    openManageFlowModal(adminId) {
        const modal = document.getElementById('manageFlowModal');
        if (!modal) {
            console.error('Manage Flow modal element not found');
            return;
        }
        
        if (!adminId) {
            console.error('Admin ID is required');
            return;
        }
        
        // Get admin data from map
        const adminData = this.adminsMap.get(adminId);
        if (!adminData) {
            console.error('Admin data not found for ID:', adminId);
            return;
        }
        
        // Find corresponding flow data
        const flow = this.flows.find(f => f.adminId === adminId);
        if (!flow) {
            console.error('Flow data not found for admin ID:', adminId);
            return;
        }
        
        this.currentAdminData = adminData;
        this.populateModalData(adminData, flow);
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }
    
    /**
     * Close Manage Flow Modal
     */
    closeManageFlowModal() {
        const modal = document.getElementById('manageFlowModal');
        if (modal) {
            modal.classList.remove('show');
            document.body.style.overflow = '';
        }
        this.currentAdminData = null;
    }
    
    /**
     * Populate modal with admin data
     */
    populateModalData(adminData, flow) {
        // Set title
        const title = document.getElementById('manageFlowTitle');
        if (title) {
            title.textContent = `Manage Flow - ${adminData.phone || flow.number || 'N/A'}`;
        }
        
        // Set total service size
        const totalServiceSize = document.getElementById('totalServiceSize');
        if (totalServiceSize) {
            const sizeMatch = flow.size ? flow.size.match(/^([\d.]+)/) : null;
            const sizeGB = sizeMatch ? sizeMatch[1] : '0';
            totalServiceSize.textContent = `Total Service Size: ${sizeGB}GB`;
        }
        
        // Set admin quota
        const adminQuotaInput = document.getElementById('adminQuotaInput');
        if (adminQuotaInput) {
            let quotaValue = 0;
            if (adminData.quota) {
                const quotaStr = String(adminData.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                quotaValue = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            adminQuotaInput.value = quotaValue;
        }
        
        // Populate current flow partition slots
        this.populatePartitionSlots(adminData);
        
        // Initially hide flow configuration until mode is selected
        const flowConfigSection = document.querySelector('.manage-flow-section:has(#flowConfigurationContainer)');
        if (flowConfigSection) {
            flowConfigSection.style.display = 'none';
        }
        
        // Add event listener for flow mode select
        const flowModeSelect = document.getElementById('flowModeSelect');
        if (flowModeSelect) {
            flowModeSelect.addEventListener('change', () => {
                if (flowModeSelect.value === 'custom') {
                    // Show flow configuration and populate it
                    if (flowConfigSection) {
                        flowConfigSection.style.display = 'block';
                    }
                    this.populateFlowConfiguration(adminData);
                    // Enable save button
                    const saveBtn = document.getElementById('manageFlowSave');
                    if (saveBtn) {
                        saveBtn.disabled = false;
                    }
                } else {
                    // Hide flow configuration
                    if (flowConfigSection) {
                        flowConfigSection.style.display = 'none';
                    }
                    // Disable save button
                    const saveBtn = document.getElementById('manageFlowSave');
                    if (saveBtn) {
                        saveBtn.disabled = true;
                    }
                }
            });
        }
    }
    
    /**
     * Populate partition slots from active subscribers
     */
    populatePartitionSlots(adminData) {
        const container = document.getElementById('partitionSlotsContainer');
        if (!container) return;
        
        const alfaData = adminData.alfaData || {};
        const secondarySubscribers = alfaData.secondarySubscribers || [];
        
        // Filter active subscribers
        const activeSubscribers = secondarySubscribers.filter(sub => {
            const status = sub.status || 'Active';
            return status === 'Active' || status === 'active' || !status;
        });
        
        // Create slots (max 3)
        const maxSlots = 3;
        let slotsHTML = '';
        
        for (let i = 0; i < maxSlots; i++) {
            const subscriber = activeSubscribers[i];
            const slotNum = i + 1;
            
            if (subscriber) {
                // Extract quota (number after "/")
                let quota = 0;
                if (typeof subscriber.quota === 'number') {
                    quota = subscriber.quota;
                } else if (subscriber.totalQuota) {
                    quota = parseFloat(subscriber.totalQuota) || 0;
                } else if (subscriber.consumptionText) {
                    const match = subscriber.consumptionText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    quota = match ? parseFloat(match[2]) || 0 : 0;
                } else if (subscriber.consumption) {
                    const consumptionStr = String(subscriber.consumption);
                    const match = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    quota = match ? parseFloat(match[2]) || 0 : 0;
                } else if (subscriber.limit) {
                    quota = parseFloat(subscriber.limit) || 0;
                }
                
                const subscriberNumber = subscriber.phone || subscriber.number || '';
                
                slotsHTML += `
                    <div class="partition-slot">
                        <span class="partition-slot-label">Slot ${slotNum}</span>
                        <h6 class="partition-slot-value">${quota > 0 ? quota.toFixed(2) + ' GB' : ' GB'}</h6>
                        <span class="partition-slot-number">${subscriberNumber}</span>
                    </div>
                `;
            } else {
                slotsHTML += `
                    <div class="partition-slot">
                        <span class="partition-slot-label">Slot ${slotNum}</span>
                        <h6 class="partition-slot-value"> GB</h6>
                    </div>
                `;
            }
            
            // Add divider between slots (not after last one)
            if (i < maxSlots - 1) {
                slotsHTML += '<h6 class="partition-divider">/</h6>';
            }
        }
        
        container.innerHTML = slotsHTML;
    }
    
    /**
     * Populate flow configuration (3 partitions)
     * Shows unchangeable flows (with subscribers) and editable fields (empty slots)
     */
    populateFlowConfiguration(adminData) {
        const container = document.getElementById('flowConfigurationContainer');
        if (!container || !adminData) return;
        
        const alfaData = adminData.alfaData || {};
        const secondarySubscribers = alfaData.secondarySubscribers || [];
        
        // Filter active subscribers
        const activeSubscribers = secondarySubscribers.filter(sub => {
            const status = sub.status || 'Active';
            return status === 'Active' || status === 'active' || !status;
        });
        
        let configHTML = '';
        const partitionCount = 3;
        
        for (let i = 0; i < partitionCount; i++) {
            const partitionNum = i + 1;
            const subscriber = activeSubscribers[i];
            
            if (subscriber) {
                // Unchangeable flow - display subscriber's total consumption (quota)
                let quota = 0;
                if (typeof subscriber.quota === 'number') {
                    quota = subscriber.quota;
                } else if (subscriber.totalQuota) {
                    quota = parseFloat(subscriber.totalQuota) || 0;
                } else if (subscriber.consumptionText) {
                    const match = subscriber.consumptionText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    quota = match ? parseFloat(match[2]) || 0 : 0;
                } else if (subscriber.consumption) {
                    const consumptionStr = String(subscriber.consumption);
                    const match = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    quota = match ? parseFloat(match[2]) || 0 : 0;
                } else if (subscriber.limit) {
                    quota = parseFloat(subscriber.limit) || 0;
                }
                
                configHTML += `
                    <div class="flow-partition-item">
                        <span class="flow-partition-label">Partition ${partitionNum}/${partitionCount}</span>
                        <div class="flow-partition-card flow-partition-unchangeable">
                            <p class="flow-partition-value">${quota > 0 ? quota.toFixed(2) + ' GB' : 'N/A'}</p>
                        </div>
                    </div>
                `;
                } else {
                // Editable field - empty slot
                // Get saved partition value if exists
                const partitions = alfaData.partitions || [];
                const savedValue = partitions[i] ? parseFloat(partitions[i]) : '';
                
                configHTML += `
                    <div class="flow-partition-item">
                        <span class="flow-partition-label">Partition ${partitionNum}/${partitionCount}</span>
                        <div class="flow-partition-card flow-partition-editable">
                            <input 
                                type="number" 
                                class="flow-partition-input" 
                                data-partition-index="${i}"
                                placeholder="Enter GB" 
                                min="0" 
                                step="0.01"
                                value="${savedValue || ''}"
                            >
                            <span class="flow-partition-input-suffix">GB</span>
                        </div>
                    </div>
                `;
            }
        }
        
        container.innerHTML = configHTML;
    }
    
    /**
     * Save manage flow changes
     */
    async saveManageFlow() {
        if (!this.currentAdminData) {
            alert('No admin data selected');
            return;
        }
        
        const adminQuotaInput = document.getElementById('adminQuotaInput');
        const flowModeSelect = document.getElementById('flowModeSelect');
        
        if (!adminQuotaInput || !flowModeSelect) {
            return;
        }
        
        const quota = parseFloat(adminQuotaInput.value) || 0;
        const flowMode = flowModeSelect.value;
        
        if (!flowMode) {
            alert('Please select a Flow Mode');
            return;
        }
        
        // Get partition values from editable inputs
        const partitionInputs = document.querySelectorAll('.flow-partition-input');
        const partitions = [];
        partitionInputs.forEach((input, index) => {
            const value = parseFloat(input.value);
            partitions[index] = isNaN(value) || value <= 0 ? '' : value.toString();
        });
        
        // Disable save button during save
        const saveBtn = document.getElementById('manageFlowSave');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
        }
        
        try {
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized');
            }
            
            const adminId = this.currentAdminData.id;
            const updateData = {};
            
            // Update admin quota
            if (!isNaN(quota) && quota > 0) {
                updateData.quota = quota;
            }
            
            // Update partitions - need to update entire alfaData object
            const alfaData = { ...(this.currentAdminData.alfaData || {}) };
            alfaData.partitions = partitions;
            updateData.alfaData = alfaData;
            
            // Update timestamp
            updateData.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
            
            // Save to Firebase
            await db.collection('admins').doc(adminId).update(updateData);
            
            // Update local admin data
            if (quota > 0) {
                this.currentAdminData.quota = quota;
            }
            if (!this.currentAdminData.alfaData) {
                this.currentAdminData.alfaData = {};
            }
            this.currentAdminData.alfaData.partitions = partitions;
            
            // Update in map
            this.adminsMap.set(adminId, this.currentAdminData);
            
            alert('Flow configuration saved successfully!');
            this.closeManageFlowModal();
            
        } catch (error) {
            console.error('Error saving flow configuration:', error);
            alert('Error saving flow configuration: ' + (error.message || 'Unknown error'));
        } finally {
            // Re-enable save button
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save Changes';
            }
        }
    }
}

// Initialize Flow Manager when DOM is ready
(function() {
    try {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                try {
                    window.flowManager = new FlowManager();
                } catch (error) {
                    // Ignore browser extension errors
                    if (!error.message || !error.message.includes('message channel')) {
                        console.error('Failed to initialize Flow Manager:', error);
                    }
                }
            });
        } else {
            try {
                window.flowManager = new FlowManager();
            } catch (error) {
                // Ignore browser extension errors
                if (!error.message || !error.message.includes('message channel')) {
                    console.error('Failed to initialize Flow Manager:', error);
                }
            }
        }
    } catch (error) {
        // Silently ignore browser extension errors
        if (!error.message || !error.message.includes('message channel')) {
            console.error('Failed to initialize Flow Manager:', error);
        }
    }
})();
