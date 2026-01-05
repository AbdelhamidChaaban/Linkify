/**
 * Profit Engine Page
 * Manages profit calculations and pricing for services
 */

class ProfitEngine {
    constructor() {
        this.currentPage = 1;
        this.rowsPerPage = 25;
        this.services = [];
        this.filteredServices = [];
        this.searchQuery = '';
        this.statusFilter = 'all'; // 'all', 'complete', 'incomplete'
        this.dateFilter = 'this-month'; // 'today', 'yesterday', 'this-month', 'last-month', 'custom'
        this.dateRange = null; // { start: Date, end: Date } for custom dates
        this.currentUserId = null;
        this.unsubscribe = null;
        this.currentAdminId = null; // For modals
        this.adminsMap = new Map();
        this.defaultCosts = {}; // Store default costs: { size: { regular: number, data: number } }
        this.defaultPrices = {}; // Store default prices: { quota: number } (e.g., { 5: 420000, 6: 510000 })
        this.unsubscribeAdmins = null;
        this.actionLogsInterval = null;
        
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
        if (this.actionLogsInterval) {
            clearInterval(this.actionLogsInterval);
            this.actionLogsInterval = null;
        }
    }
    
    /**
     * Initialize the profit engine
     */
    async init() {
        try {
            await this.waitForAuth();
            await this.waitForFirebase();
            this.hideCustomDatePicker(); // Hide custom date picker initially
            this.bindEvents();
            this.updateDateFilterCaption(); // Initialize caption
            await this.loadDefaultCosts(); // Load default costs
            await this.loadDefaultPrices(); // Load default prices
            await this.loadServices();
        } catch (error) {
            console.error('Error initializing Profit Engine:', error);
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
                    unsubscribe();
                    resolve();
                } else {
                    if (auth.currentUser && auth.currentUser.uid) {
                        this.currentUserId = auth.currentUser.uid;
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
        const searchInput = document.getElementById('profitSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.toLowerCase();
                this.currentPage = 1;
                this.applyFilters();
                this.renderTable();
                this.updatePagination();
                this.updateSummary();
            });
        }
        
        // Filter chips
        const filterChips = document.querySelectorAll('.filter-chip');
        filterChips.forEach(chip => {
            chip.addEventListener('click', () => {
                filterChips.forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                this.statusFilter = chip.getAttribute('data-filter');
                this.currentPage = 1;
                this.applyFilters();
                this.renderTable();
                this.updatePagination();
                this.updateSummary();
            });
        });
        
        // Date filter chips
        const dateFilterChips = document.querySelectorAll('.date-filter-chip');
        dateFilterChips.forEach(chip => {
            chip.addEventListener('click', () => {
                const filter = chip.getAttribute('data-date-filter');
                dateFilterChips.forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                
                if (filter === 'custom') {
                    this.showCustomDatePicker();
                } else {
                    this.hideCustomDatePicker();
                    this.dateFilter = filter;
                    this.dateRange = null;
                    this.currentPage = 1;
                    this.applyFilters();
                    this.updateDateFilterCaption();
                    this.renderTable();
                    this.updatePagination();
                    this.updateSummary();
                }
            });
        });
        
        // Custom date inputs
        const startDateInput = document.getElementById('startDateInput');
        const endDateInput = document.getElementById('endDateInput');
        
        if (startDateInput) {
            startDateInput.addEventListener('change', () => {
                if (this.dateFilter === 'custom') {
                    this.handleCustomDateChange();
                }
            });
        }
        
        if (endDateInput) {
            endDateInput.addEventListener('change', () => {
                if (this.dateFilter === 'custom') {
                    this.handleCustomDateChange();
                }
            });
        }
        
        // Default Costs button
        const defaultCostsBtn = document.getElementById('defaultCostsBtn');
        if (defaultCostsBtn) {
            defaultCostsBtn.addEventListener('click', () => {
                this.openDefaultCostsModal();
            });
        }
        
        // Default Costs Modal
        const defaultCostsModal = document.getElementById('defaultCostsModal');
        const defaultCostsClose = document.getElementById('defaultCostsClose');
        const defaultCostsCancel = document.getElementById('defaultCostsCancel');
        const defaultCostsSave = document.getElementById('defaultCostsSave');
        
        if (defaultCostsClose) {
            defaultCostsClose.addEventListener('click', () => this.closeDefaultCostsModal());
        }
        if (defaultCostsCancel) {
            defaultCostsCancel.addEventListener('click', () => this.closeDefaultCostsModal());
        }
        if (defaultCostsSave) {
            defaultCostsSave.addEventListener('click', () => this.saveDefaultCosts());
        }
        if (defaultCostsModal) {
            defaultCostsModal.addEventListener('click', (e) => {
                if (e.target === defaultCostsModal) {
                    this.closeDefaultCostsModal();
                }
            });
        }
        
        // Format number inputs on change
        const defaultCostInputs = document.querySelectorAll('.default-cost-input');
        defaultCostInputs.forEach(input => {
            input.addEventListener('input', (e) => {
                this.formatNumberInput(e.target);
            });
            input.addEventListener('blur', (e) => {
                this.formatNumberInput(e.target);
            });
        });
        
        // Default Prices button
        const defaultPricesBtn = document.getElementById('defaultPricesBtn');
        if (defaultPricesBtn) {
            defaultPricesBtn.addEventListener('click', () => {
                this.openDefaultPricesModal();
            });
        }
        
        // Default Prices Modal
        const defaultPricesModal = document.getElementById('defaultPricesModal');
        const defaultPricesClose = document.getElementById('defaultPricesClose');
        const defaultPricesCancel = document.getElementById('defaultPricesCancel');
        const defaultPricesSave = document.getElementById('defaultPricesSave');
        const addDefaultPriceBtn = document.getElementById('addDefaultPriceBtn');
        
        if (defaultPricesClose) {
            defaultPricesClose.addEventListener('click', () => this.closeDefaultPricesModal());
        }
        if (defaultPricesCancel) {
            defaultPricesCancel.addEventListener('click', () => this.closeDefaultPricesModal());
        }
        if (defaultPricesSave) {
            defaultPricesSave.addEventListener('click', () => this.saveDefaultPrices());
        }
        if (addDefaultPriceBtn) {
            addDefaultPriceBtn.addEventListener('click', () => this.addDefaultPriceEntry());
        }
        if (defaultPricesModal) {
            defaultPricesModal.addEventListener('click', (e) => {
                if (e.target === defaultPricesModal) {
                    this.closeDefaultPricesModal();
                }
            });
        }
        
        // Format new price input
        const newPriceInput = document.getElementById('newPriceInput');
        if (newPriceInput) {
            newPriceInput.addEventListener('input', (e) => {
                this.formatNumberInput(e.target);
            });
            newPriceInput.addEventListener('blur', (e) => {
                this.formatNumberInput(e.target);
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
                const maxPage = Math.ceil(this.filteredServices.length / this.rowsPerPage);
                if (this.currentPage < maxPage) {
                    this.currentPage++;
                    this.renderTable();
                    this.updatePagination();
                }
            });
        }
        
        // Set Cost Modal
        this.bindCostModal();
        
        // Set Prices Modal
        this.bindPricesModal();
    }
    
    /**
     * Bind Set Cost Modal events
     */
    bindCostModal() {
        const modal = document.getElementById('setCostModal');
        const closeBtn = document.getElementById('setCostClose');
        const cancelBtn = document.getElementById('setCostCancel');
        const saveBtn = document.getElementById('setCostSave');
        
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeCostModal());
        }
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.closeCostModal());
        }
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.saveCost());
        }
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeCostModal();
                }
            });
        }
    }
    
    /**
     * Bind Set Prices Modal events
     */
    bindPricesModal() {
        const modal = document.getElementById('setPricesModal');
        const closeBtn = document.getElementById('setPricesClose');
        const cancelBtn = document.getElementById('setPricesCancel');
        const saveBtn = document.getElementById('setPricesSave');
        
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closePricesModal());
        }
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.closePricesModal());
        }
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.savePrices());
        }
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closePricesModal();
                }
            });
        }
    }
    
    /**
     * Load services data from admins that match "Available Services" criteria
     */
    async loadServices() {
        try {
            const tbody = document.getElementById('profitTableBody');
            
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="9" class="loading-state" style="text-align: center; padding: 3rem;">
                            <p>Loading subscriber operations...</p>
                        </td>
                    </tr>
                `;
            }
            
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized');
            }
            
            // Load admins first (needed for admin info)
            if (this.unsubscribeAdmins) {
                this.unsubscribeAdmins();
            }
            
            this.unsubscribeAdmins = db.collection('admins')
                .where('userId', '==', this.currentUserId)
                .onSnapshot(
                    (snapshot) => {
                        this.adminsMap.clear();
                        snapshot.docs.forEach(doc => {
                            this.adminsMap.set(doc.id, { id: doc.id, ...doc.data() });
                        });
                        // Reload action logs when admins update
                        this.loadActionLogs();
                    },
                    (error) => {
                        console.error('Error loading admins:', error);
                    }
                );
            
            // Load subscriber addition operations from API
            this.loadActionLogs();
            
            // Store unsubscribe function
            if (this.unsubscribe) {
                this.unsubscribe();
            }
            this.unsubscribe = () => {
                if (this.unsubscribeAdmins) this.unsubscribeAdmins();
                if (this.actionLogsInterval) {
                    clearInterval(this.actionLogsInterval);
                    this.actionLogsInterval = null;
                }
            };
        } catch (error) {
            console.error('Error loading services:', error);
        }
    }
    
    /**
     * Load action logs from API
     */
    async loadActionLogs() {
        try {
            if (!auth || !auth.currentUser) {
                console.error('User not authenticated');
                return;
            }
            
            // Get JWT token
            const token = await auth.currentUser.getIdToken();
            
            // Fetch action logs from API
            const apiBaseURL = window.AEFA_API_URL || window.ALFA_API_URL || 'https://cell-spott-manage-backend.onrender.com';
            const response = await fetch(`${apiBaseURL}/api/actionLogs?actionFilter=add&limit=1000`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`API error: ${response.status} ${response.statusText}`);
            }
            
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Failed to load action logs');
            }
            
            // Process the logs
            this.processActionLogs(result.data || []);
            
            // Set up polling to refresh data periodically (since we can't use real-time listeners)
            if (this.actionLogsInterval) {
                clearInterval(this.actionLogsInterval);
            }
            this.actionLogsInterval = setInterval(() => {
                this.loadActionLogs();
            }, 30000); // Refresh every 30 seconds
            
        } catch (error) {
            console.error('Error loading action logs:', error);
            const tbody = document.getElementById('profitTableBody');
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="9" style="text-align: center; padding: 3rem;">
                            <p style="color: #ef4444;">Error loading subscriber operations: ${error.message}</p>
                        </td>
                    </tr>
                `;
            }
        }
    }
    
    /**
     * Process action logs array and extract subscriber addition operations
     */
    processActionLogs(actionLogs) {
        const services = [];
        
        actionLogs.forEach((actionLog, index) => {
            
            // Skip if not an 'add' action or not successful
            if (actionLog.action !== 'add' || !actionLog.success) {
                return;
            }
            
            // Get admin data from map
            const adminData = this.adminsMap.get(actionLog.adminId);
            if (!adminData) {
                // Admin not loaded yet, skip this operation
                return;
            }
            
            // Check if admin is available service (matches available services filter)
            if (!this.isAvailableService(adminData, actionLog.adminId)) {
                return;
            }
            
            // Extract quota from action log
            const quota = actionLog.quota || 0;
            if (quota <= 0) return; // Skip operations with invalid quota
            
            // Get cost for this subscriber operation
            // Use default cost based on admin bundle size
            let cost = 0;
            const alfaData = adminData.alfaData || {};
            const adminSize = this.extractTotalLimit(adminData, alfaData);
            if (adminSize > 0 && this.defaultCosts[adminSize]) {
                // Use regular cost (assuming regular is the main type)
                cost = this.defaultCosts[adminSize].regular || this.defaultCosts[adminSize].data || 0;
            }
            
            // Get revenue for this subscriber operation
            // Use default price based on quota
            let revenue = 0;
            if (this.defaultPrices[quota]) {
                revenue = this.defaultPrices[quota];
            }
            
            // Calculate profit and margin
            const profit = revenue - cost;
            const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
            
            // Check if complete (both cost and revenue are set)
            const isComplete = cost > 0 && revenue > 0;
            
            // Extract timestamp from action log
            // Handle Firestore Timestamp objects (serialized as {seconds, nanoseconds}) or ISO strings
            let createdAt = new Date();
            
            const parseDate = (dateValue) => {
                if (!dateValue) return null;
                
                // If it's already a Date object
                if (dateValue instanceof Date) {
                    return dateValue;
                }
                
                // If it's a Firestore Timestamp object (has toDate method)
                if (typeof dateValue === 'object' && dateValue !== null && typeof dateValue.toDate === 'function') {
                    return dateValue.toDate();
                }
                
                // If it's a Firestore Timestamp serialized object (has seconds property)
                if (typeof dateValue === 'object' && dateValue !== null && typeof dateValue.seconds === 'number') {
                    return new Date(dateValue.seconds * 1000 + (dateValue.nanoseconds || 0) / 1000000);
                }
                
                // If it's a string (ISO format or other)
                if (typeof dateValue === 'string') {
                    const parsed = new Date(dateValue);
                    return isNaN(parsed.getTime()) ? null : parsed;
                }
                
                // Try to create a date from the value (fallback)
                const parsed = new Date(dateValue);
                return isNaN(parsed.getTime()) ? null : parsed;
            };
            
            if (actionLog.createdAt) {
                const parsed = parseDate(actionLog.createdAt);
                if (parsed) createdAt = parsed;
            } else if (actionLog.timestamp) {
                const parsed = parseDate(actionLog.timestamp);
                if (parsed) createdAt = parsed;
            }
            
            // Validate date - if invalid, use current date as fallback
            if (isNaN(createdAt.getTime())) {
                createdAt = new Date();
            }
            
            services.push({
                id: actionLog.id || `log_${index}`,
                adminId: actionLog.adminId,
                adminNumber: actionLog.adminPhone || adminData.phone || '',
                adminName: actionLog.adminName || adminData.name || '',
                subscriberPhone: actionLog.subscriberPhone || '',
                quota: quota,
                cost: cost,
                revenue: revenue,
                profit: profit,
                margin: margin,
                isComplete: isComplete,
                createdAt: createdAt,
                adminData: adminData,
                actionLog: actionLog
            });
        });
        
        this.services = services;
        this.applyFilters();
        this.updateDateFilterCaption();
        this.renderTable();
        this.updatePagination();
        this.updateSummary();
    }
    
    /**
     * Check if admin is an "Available Service" (same logic as Flow Manager)
     */
    isAvailableService(adminData, adminId) {
        const alfaData = adminData.alfaData || {};
        const adminValidityDate = alfaData.validityDate || '';
        
        // Must have validity date
        if (!adminValidityDate || typeof adminValidityDate !== 'string') {
            return false;
        }
        
        // Must have secondarySubscribers array
        const secondarySubscribers = alfaData.secondarySubscribers || [];
        if (!Array.isArray(secondarySubscribers) || secondarySubscribers.length === 0) {
            return false;
        }
        
        // Must have at least one active subscriber
        const hasActiveSubscriber = secondarySubscribers.some(sub => {
            const status = sub.status || 'Active';
            return status === 'Active' || status === 'active' || !status;
        });
        
        if (!hasActiveSubscriber) {
            return false;
        }
        
        // Must have days left > 0
        const daysLeft = this.calculateDaysLeft(adminValidityDate);
        if (!daysLeft || daysLeft <= 0) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Extract total limit (bundle size) from admin data
     */
    extractTotalLimit(adminData, alfaData) {
        let totalLimit = 0;
        
        const parseConsumption = (consumptionStr) => {
            if (!consumptionStr || typeof consumptionStr !== 'string') return { used: 0, total: 0 };
            const match = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
            return match ? { used: parseFloat(match[1]), total: parseFloat(match[2]) } : { used: 0, total: 0 };
        };
        
        if (alfaData.totalConsumption && typeof alfaData.totalConsumption === 'string') {
            const parsed = parseConsumption(alfaData.totalConsumption);
            if (parsed.total > 0) {
                totalLimit = parsed.total;
            }
        }
        
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
                totalLimit = Math.max(...packageValues);
            }
        }
        
        if (totalLimit === 0 && alfaData.totalLimit) {
            totalLimit = parseFloat(alfaData.totalLimit) || 0;
        }
        
        if (totalLimit === 0 && adminData.quota) {
            const quotaStr = String(adminData.quota).trim();
            const quotaMatch = quotaStr.match(/^([\d.]+)/);
            totalLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
        }
        
        return totalLimit;
    }
    
    /**
     * Get partitions for a service (from flow manager partitions or active subscribers)
     */
    getPartitions(adminData, alfaData) {
        const partitions = [];
        
        // First try to get from flow manager partitions
        const flowPartitions = alfaData.partitions || [];
        if (flowPartitions.length > 0) {
            flowPartitions.forEach((p, i) => {
                const partitionValue = parseFloat(p);
                if (!isNaN(partitionValue) && partitionValue > 0) {
                    partitions.push(partitionValue);
                }
            });
        }
        
        // If no flow partitions, get from active subscribers
        if (partitions.length === 0) {
            const secondarySubscribers = alfaData.secondarySubscribers || [];
            const activeSubscribers = secondarySubscribers.filter(sub => {
                const status = sub.status || 'Active';
                return status === 'Active' || status === 'active' || !status;
            });
            
            activeSubscribers.forEach(subscriber => {
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
                
                if (quota > 0) {
                    partitions.push(quota);
                }
            });
        }
        
        return partitions;
    }
    
    /**
     * Calculate revenue from partitions and prices
     */
    calculateRevenue(partitions, prices) {
        let revenue = 0;
        partitions.forEach((partitionSize, index) => {
            const price = prices[index] || 0;
            revenue += partitionSize * price;
        });
        return revenue;
    }
    
    /**
     * Calculate days left from validity date
     */
    calculateDaysLeft(validityDateStr) {
        if (!validityDateStr || typeof validityDateStr !== 'string') {
            return null;
        }
        
        const dateMatch = validityDateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
        if (!dateMatch) {
            return null;
        }
        
        const [, day, month, year] = dateMatch;
        const validityDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        validityDate.setHours(23, 59, 59, 999);
        
        const now = new Date();
        const diffTime = validityDate - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        return diffDays;
    }
    
    /**
     * Apply filters (search and status)
     */
    applyFilters() {
        const dateRange = this.getDateRange();
        
        this.filteredServices = this.services.filter(service => {
            // Search filter
            if (this.searchQuery) {
                const searchLower = this.searchQuery.toLowerCase();
                const matchesAdminNumber = (service.adminNumber || '').toLowerCase().includes(searchLower);
                const matchesAdminName = (service.adminName || '').toLowerCase().includes(searchLower);
                const matchesSubscriberPhone = (service.subscriberPhone || '').toLowerCase().includes(searchLower);
                if (!matchesAdminNumber && !matchesAdminName && !matchesSubscriberPhone) {
                    return false;
                }
            }
            
            // Status filter
            if (this.statusFilter === 'complete') {
                if (!service.isComplete) return false;
            } else if (this.statusFilter === 'incomplete') {
                if (service.isComplete) return false;
            }
            
            // Date filter
            if (dateRange && service.createdAt) {
                // Ensure createdAt is a Date object
                let serviceDate = service.createdAt;
                if (!(serviceDate instanceof Date)) {
                    serviceDate = new Date(serviceDate);
                }
                
                // Check if date is valid
                if (isNaN(serviceDate.getTime())) {
                    return false; // Invalid date, exclude from results
                }
                
                serviceDate.setHours(0, 0, 0, 0);
                
                const startDate = new Date(dateRange.start);
                startDate.setHours(0, 0, 0, 0);
                
                const endDate = new Date(dateRange.end);
                endDate.setHours(23, 59, 59, 999);
                
                if (serviceDate < startDate || serviceDate > endDate) {
                    return false;
                }
            }
            
            return true;
        });
    }
    
    /**
     * Get date range based on current date filter
     */
    getDateRange() {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        if (this.dateRange) {
            // Custom date range
            return this.dateRange;
        }
        
        switch (this.dateFilter) {
            case 'today':
                return {
                    start: new Date(today),
                    end: new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1)
                };
            case 'yesterday':
                const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
                return {
                    start: new Date(yesterday),
                    end: new Date(yesterday.getTime() + 24 * 60 * 60 * 1000 - 1)
                };
            case 'this-month':
                return {
                    start: new Date(now.getFullYear(), now.getMonth(), 1),
                    end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
                };
            case 'last-month':
                return {
                    start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
                    end: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
                };
            default:
                return null;
        }
    }
    
    /**
     * Update date filter caption
     */
    updateDateFilterCaption() {
        const caption = document.getElementById('dateFilterCaption');
        if (!caption) return;
        
        const dateRange = this.getDateRange();
        if (!dateRange) {
            caption.textContent = 'Showing all subscriber operations';
            return;
        }
        
        const formatDate = (date) => {
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            return `${months[date.getMonth()]} ${date.getDate().toString().padStart(2, '0')}, ${date.getFullYear()}`;
        };
        
        caption.textContent = `Showing subscriber operations between ${formatDate(dateRange.start)} - ${formatDate(dateRange.end)}`;
    }
    
    /**
     * Show custom date picker fields
     */
    showCustomDatePicker() {
        const customDatePicker = document.getElementById('customDatePicker');
        if (customDatePicker) {
            customDatePicker.style.display = 'block';
        }
        this.dateFilter = 'custom';
        
        // Initialize dates if not set
        const startDateInput = document.getElementById('startDateInput');
        const endDateInput = document.getElementById('endDateInput');
        
        if (startDateInput && !startDateInput.value && !this.dateRange) {
            // Set default to first day of current month
            const now = new Date();
            const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
            startDateInput.value = this.formatDateForInput(firstDay);
        }
        
        if (endDateInput && !endDateInput.value && !this.dateRange) {
            // Set default to today
            const today = new Date();
            endDateInput.value = this.formatDateForInput(today);
        }
        
        // If we have a saved date range, populate the inputs
        if (this.dateRange) {
            if (startDateInput) {
                startDateInput.value = this.formatDateForInput(this.dateRange.start);
            }
            if (endDateInput) {
                endDateInput.value = this.formatDateForInput(this.dateRange.end);
            }
        }
    }
    
    /**
     * Hide custom date picker fields
     */
    hideCustomDatePicker() {
        const customDatePicker = document.getElementById('customDatePicker');
        if (customDatePicker) {
            customDatePicker.style.display = 'none';
        }
    }
    
    /**
     * Handle custom date change
     */
    handleCustomDateChange() {
        const startDateInput = document.getElementById('startDateInput');
        const endDateInput = document.getElementById('endDateInput');
        
        if (!startDateInput || !endDateInput) return;
        
        const startDateStr = startDateInput.value;
        const endDateStr = endDateInput.value;
        
        if (!startDateStr || !endDateStr) {
            // Don't filter if both dates aren't set
            return;
        }
        
        const startDate = new Date(startDateStr);
        const endDate = new Date(endDateStr);
        
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return;
        }
        
        if (startDate > endDate) {
            // Show error or swap dates
            alert('Start date must be before or equal to end date.');
            endDateInput.value = startDateStr;
            return;
        }
        
        // Set end date to end of day
        endDate.setHours(23, 59, 59, 999);
        
        this.dateRange = { start: startDate, end: endDate };
        this.currentPage = 1;
        this.applyFilters();
        this.updateDateFilterCaption();
        this.renderTable();
        this.updatePagination();
        this.updateSummary();
    }
    
    /**
     * Format date for input field (YYYY-MM-DD)
     */
    formatDateForInput(date) {
        if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
            return '';
        }
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    /**
     * Load default costs from Firebase
     */
    async loadDefaultCosts() {
        try {
            if (typeof db === 'undefined') {
                return;
            }
            
            const userDoc = await db.collection('users').doc(this.currentUserId).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                this.defaultCosts = userData.defaultCosts || {};
            }
        } catch (error) {
            console.error('Error loading default costs:', error);
        }
    }
    
    /**
     * Open Default Costs Modal
     */
    async openDefaultCostsModal() {
        const modal = document.getElementById('defaultCostsModal');
        if (!modal) return;
        
        // Populate inputs with existing default costs
        const sizes = [22, 44, 77, 111];
        sizes.forEach(size => {
            const regularInput = document.getElementById(`defaultCost${size}Regular`);
            const dataInput = document.getElementById(`defaultCost${size}Data`);
            
            if (regularInput && this.defaultCosts[size] && this.defaultCosts[size].regular) {
                regularInput.value = this.formatNumberWithCommas(this.defaultCosts[size].regular);
            } else if (regularInput) {
                regularInput.value = '';
            }
            
            if (dataInput && this.defaultCosts[size] && this.defaultCosts[size].data) {
                dataInput.value = this.formatNumberWithCommas(this.defaultCosts[size].data);
            } else if (dataInput) {
                dataInput.value = '';
            }
        });
        
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }
    
    /**
     * Close Default Costs Modal
     */
    closeDefaultCostsModal() {
        const modal = document.getElementById('defaultCostsModal');
        if (modal) {
            modal.classList.remove('show');
        }
        document.body.style.overflow = '';
    }
    
    /**
     * Save Default Costs to Firebase
     */
    async saveDefaultCosts() {
        const saveBtn = document.getElementById('defaultCostsSave');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
        }
        
        try {
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized');
            }
            
            const defaultCosts = {};
            const sizes = [22, 44, 77, 111];
            
            sizes.forEach(size => {
                const regularInput = document.getElementById(`defaultCost${size}Regular`);
                const dataInput = document.getElementById(`defaultCost${size}Data`);
                
                defaultCosts[size] = {
                    regular: regularInput ? this.parseNumberFromInput(regularInput.value) : 0,
                    data: dataInput ? this.parseNumberFromInput(dataInput.value) : 0
                };
            });
            
            // Save to user document
            const userRef = db.collection('users').doc(this.currentUserId);
            await userRef.set({
                defaultCosts: defaultCosts,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            // Update local cache
            this.defaultCosts = defaultCosts;
            
            this.closeDefaultCostsModal();
            alert('Default costs saved successfully!');
            
            // Reload services to apply new default costs
            await this.loadServices();
        } catch (error) {
            console.error('Error saving default costs:', error);
            alert('Error saving default costs: ' + (error.message || 'Unknown error'));
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save Defaults';
            }
        }
    }
    
    /**
     * Format number input with commas
     */
    formatNumberInput(input) {
        if (!input || !input.value) return;
        
        const value = this.parseNumberFromInput(input.value);
        if (value > 0) {
            input.value = this.formatNumberWithCommas(value);
        } else {
            input.value = '';
        }
    }
    
    /**
     * Parse number from input (remove commas and spaces)
     */
    parseNumberFromInput(value) {
        if (!value) return 0;
        const cleaned = String(value).replace(/[,\s]/g, '');
        const parsed = parseFloat(cleaned);
        return isNaN(parsed) ? 0 : parsed;
    }
    
    /**
     * Format number with commas
     */
    formatNumberWithCommas(num) {
        if (!num || num === 0) return '';
        return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    
    /**
     * Render table
     */
    renderTable() {
        const tbody = document.getElementById('profitTableBody');
        if (!tbody) return;
        
        const start = (this.currentPage - 1) * this.rowsPerPage;
        const end = start + this.rowsPerPage;
        const pageServices = this.filteredServices.slice(start, end);
        
        if (pageServices.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align: center; padding: 3rem;">
                        <p>No subscriber operations found</p>
                    </td>
                </tr>
            `;
            return;
        }
        
        tbody.innerHTML = pageServices.map(service => this.renderServiceRow(service)).join('');
        
        // Bind action buttons
        pageServices.forEach(service => {
            // Delete button
            const deleteBtn = document.getElementById(`deleteBtn_${service.id}`);
            if (deleteBtn) {
                deleteBtn.addEventListener('click', () => this.deleteService(service));
            }
        });
    }
    
    /**
     * Render service row (subscriber operation)
     */
    renderServiceRow(service) {
        const costDisplay = service.cost > 0 
            ? `${this.formatCurrency(service.cost)} LBP`
            : '-';
        
        const revenueDisplay = service.revenue > 0 
            ? `${this.formatCurrency(service.revenue)} LBP`
            : '-';
        
        const profitDisplay = this.formatCurrency(service.profit) + ' LBP';
        
        const marginClass = service.margin >= 0 ? 'positive' : 'negative';
        const marginDisplay = service.revenue > 0 
            ? `${service.margin >= 0 ? '+' : ''}${service.margin.toFixed(0)}%`
            : '-';
        
        const statusIcon = service.isComplete
            ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10s10-4.5 10-10S17.5 2 12 2m-2 15l-5-5l1.41-1.41L10 14.17l7.59-7.59L19 8z"/></svg>'
            : '';
        
        return `
            <tr>
                <td></td>
                <td>
                    <div class="profit-admin-cell">
                        <div class="profit-admin-info">
                            <div class="profit-admin-number">${this.escapeHtml(service.adminNumber)}</div>
                            <div class="profit-admin-name">${this.escapeHtml(service.adminName || '')}</div>
                        </div>
                        ${statusIcon ? `<div class="profit-status-icon">${statusIcon}</div>` : ''}
                    </div>
                </td>
                <td>
                    <div class="profit-size-cell">
                        ${this.getAdminSize(service)}
                    </div>
                </td>
                <td>${service.quota} GB</td>
                <td class="text-right">${costDisplay}</td>
                <td class="text-right">${revenueDisplay}</td>
                <td class="text-right" style="color: ${service.profit >= 0 ? '#10b981' : '#ef4444'}">${profitDisplay}</td>
                <td class="text-center">
                    ${service.revenue > 0 ? `<div class="profit-margin-chip ${marginClass}">${marginDisplay}</div>` : '-'}
                </td>
                <td class="text-center">
                    <button class="profit-action-btn profit-delete-btn" id="deleteBtn_${service.id}" title="Remove">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>
                        </svg>
                    </button>
                </td>
            </tr>
        `;
    }
    
    /**
     * Get admin total bundle size for display
     */
    getAdminSize(service) {
        if (!service.adminData) {
            return '-';
        }
        
        const alfaData = service.adminData.alfaData || {};
        const totalLimit = this.extractTotalLimit(service.adminData, alfaData);
        
        if (totalLimit > 0) {
            return `${totalLimit} GB`;
        }
        
        return '-';
    }
    
    /**
     * Format currency
     */
    formatCurrency(value) {
        return new Intl.NumberFormat('en-US').format(Math.round(value));
    }
    
    /**
     * Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    /**
     * Update pagination
     */
    updatePagination() {
        const total = this.filteredServices.length;
        const start = total === 0 ? 0 : (this.currentPage - 1) * this.rowsPerPage + 1;
        const end = Math.min(this.currentPage * this.rowsPerPage, total);
        
        const pageInfo = document.getElementById('pageInfo');
        if (pageInfo) {
            pageInfo.textContent = `${start}-${end} of ${total}`;
        }
        
        const prevPage = document.getElementById('prevPage');
        const nextPage = document.getElementById('nextPage');
        if (prevPage) {
            prevPage.disabled = this.currentPage === 1;
        }
        if (nextPage) {
            nextPage.disabled = this.currentPage >= Math.ceil(total / this.rowsPerPage);
        }
    }
    
    /**
     * Update summary cards
     */
    updateSummary() {
        const totalRevenue = this.filteredServices.reduce((sum, s) => sum + s.revenue, 0);
        const totalCost = this.filteredServices.reduce((sum, s) => sum + s.cost, 0);
        const totalProfit = totalRevenue - totalCost;
        const avgProfit = this.filteredServices.length > 0 ? totalProfit / this.filteredServices.length : 0;
        
        const totalRevenueEl = document.getElementById('totalRevenue');
        const totalCostEl = document.getElementById('totalCost');
        const totalProfitEl = document.getElementById('totalProfit');
        const avgServiceProfitEl = document.getElementById('avgServiceProfit');
        const serviceCountEl = document.getElementById('serviceCount');
        
        if (totalRevenueEl) {
            totalRevenueEl.textContent = this.formatCurrency(totalRevenue) + ' LBP';
        }
        if (totalCostEl) {
            totalCostEl.textContent = this.formatCurrency(totalCost) + ' LBP';
        }
        if (totalProfitEl) {
            totalProfitEl.textContent = this.formatCurrency(totalProfit) + ' LBP';
        }
        if (avgServiceProfitEl) {
            avgServiceProfitEl.textContent = this.formatCurrency(avgProfit) + ' LBP';
        }
        if (serviceCountEl) {
            serviceCountEl.textContent = `${this.filteredServices.length} services`;
        }
    }
    
    /**
     * Delete a subscriber operation
     */
    async deleteService(service) {
        // Confirm deletion
        if (!confirm(`Are you sure you want to remove this subscriber operation?\n\nAdmin: ${service.adminNumber}\nQuota: ${service.quota} GB`)) {
            return;
        }
        
        try {
            // Get auth token
            const user = auth.currentUser;
            if (!user) {
                throw new Error('User not authenticated');
            }
            const token = await user.getIdToken();
            
            // Delete from API
            const response = await fetch(`/api/actionLogs/${service.id}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `Failed to delete: ${response.status} ${response.statusText}`);
            }
            
            // Remove from services array
            this.services = this.services.filter(s => s.id !== service.id);
            
            // Update filters and re-render
            this.applyFilters();
            this.renderTable();
            this.updatePagination();
            this.updateSummary();
            
        } catch (error) {
            console.error('Error deleting service:', error);
            alert(`Failed to delete subscriber operation: ${error.message}`);
        }
    }
    
    /**
     * Open Set Cost Modal
     */
    openCostModal(service) {
        this.currentAdminId = service.adminId; // Use adminId instead of service.id
        const modal = document.getElementById('setCostModal');
        const title = document.getElementById('setCostTitle');
        const input = document.getElementById('adminCostInput');
        
        // Get admin data to show current cost
        const adminData = this.adminsMap.get(service.adminId);
        const currentCost = adminData ? (adminData.profitCost || 0) : 0;
        
        if (title) {
            title.textContent = `Set Cost - ${service.adminNumber}`;
        }
        if (input) {
            input.value = currentCost;
        }
        if (modal) {
            modal.classList.add('show');
            document.body.style.overflow = 'hidden';
        }
    }
    
    /**
     * Close Set Cost Modal
     */
    closeCostModal() {
        const modal = document.getElementById('setCostModal');
        if (modal) {
            modal.classList.remove('show');
            document.body.style.overflow = '';
        }
        this.currentAdminId = null;
    }
    
    /**
     * Save Cost
     */
    async saveCost() {
        if (!this.currentAdminId) return;
        
        const input = document.getElementById('adminCostInput');
        if (!input) return;
        
        const cost = parseFloat(input.value) || 0;
        const saveBtn = document.getElementById('setCostSave');
        
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
        }
        
        try {
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized');
            }
            
            await db.collection('admins').doc(this.currentAdminId).update({
                profitCost: cost,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            this.closeCostModal();
            // Data will update automatically via real-time listener
        } catch (error) {
            console.error('Error saving cost:', error);
            alert('Error saving cost: ' + (error.message || 'Unknown error'));
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        }
    }
    
    /**
     * Open Set Prices Modal
     */
    openPricesModal(service) {
        this.currentAdminId = service.id;
        const modal = document.getElementById('setPricesModal');
        const title = document.getElementById('setPricesTitle');
        const container = document.getElementById('pricesContainer');
        
        if (title) {
            title.textContent = `Set Prices - ${service.number}`;
        }
        if (container) {
            container.innerHTML = service.partitions.map((partition, index) => {
                const price = service.prices[index] || 0;
                return `
                    <div class="profit-price-item">
                        <label class="profit-price-label">Partition ${index + 1} (${partition.toFixed(0)} GB) - Price per GB (LBP)</label>
                        <input type="number" class="profit-form-input" data-partition-index="${index}" value="${price}" min="0" step="1000">
                    </div>
                `;
            }).join('');
        }
        if (modal) {
            modal.classList.add('show');
            document.body.style.overflow = 'hidden';
        }
    }
    
    /**
     * Close Set Prices Modal
     */
    closePricesModal() {
        const modal = document.getElementById('setPricesModal');
        if (modal) {
            modal.classList.remove('show');
            document.body.style.overflow = '';
        }
        this.currentAdminId = null;
    }
    
    /**
     * Save Prices
     */
    async savePrices() {
        if (!this.currentAdminId) return;
        
        const service = this.services.find(s => s.id === this.currentAdminId);
        if (!service) return;
        
        const inputs = document.querySelectorAll('#pricesContainer input');
        const prices = [];
        
        inputs.forEach((input, index) => {
            const price = parseFloat(input.value) || 0;
            prices[index] = price;
        });
        
        // Pad array to match partitions length
        while (prices.length < service.partitions.length) {
            prices.push(0);
        }
        
        const saveBtn = document.getElementById('setPricesSave');
        
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
        }
        
        try {
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized');
            }
            
            await db.collection('admins').doc(this.currentAdminId).update({
                profitPrices: prices,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            this.closePricesModal();
            // Data will update automatically via real-time listener
        } catch (error) {
            console.error('Error saving prices:', error);
            alert('Error saving prices: ' + (error.message || 'Unknown error'));
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        }
    }
    
    /**
     * Format number input with commas
     */
    formatNumberInput(input) {
        if (!input || !input.value) return;
        
        const value = this.parseNumberFromInput(input.value);
        if (value > 0) {
            input.value = this.formatNumberWithCommas(value);
        } else {
            input.value = '';
        }
    }
    
    /**
     * Parse number from input (remove commas and spaces)
     */
    parseNumberFromInput(value) {
        if (!value) return 0;
        const cleaned = String(value).replace(/[,\s]/g, '');
        const parsed = parseFloat(cleaned);
        return isNaN(parsed) ? 0 : parsed;
    }
    
    /**
     * Format number with commas
     */
    formatNumberWithCommas(num) {
        if (!num || num === 0) return '';
        return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    
    /**
     * Load default prices from Firebase
     */
    async loadDefaultPrices() {
        try {
            if (typeof db === 'undefined') {
                return;
            }
            
            const userDoc = await db.collection('users').doc(this.currentUserId).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                this.defaultPrices = userData.defaultPrices || {};
            }
        } catch (error) {
            console.error('Error loading default prices:', error);
        }
    }
    
    /**
     * Open Default Prices Modal
     */
    async openDefaultPricesModal() {
        const modal = document.getElementById('defaultPricesModal');
        if (!modal) return;
        
        // Clear add form
        const newQuotaInput = document.getElementById('newQuotaInput');
        const newPriceInput = document.getElementById('newPriceInput');
        if (newQuotaInput) newQuotaInput.value = '';
        if (newPriceInput) newPriceInput.value = '';
        
        // Render existing prices
        this.renderDefaultPricesList();
        
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }
    
    /**
     * Close Default Prices Modal
     */
    closeDefaultPricesModal() {
        const modal = document.getElementById('defaultPricesModal');
        if (modal) {
            modal.classList.remove('show');
        }
        document.body.style.overflow = '';
    }
    
    /**
     * Render default prices list
     */
    renderDefaultPricesList() {
        const list = document.getElementById('defaultPricesList');
        if (!list) return;
        
        if (Object.keys(this.defaultPrices).length === 0) {
            list.innerHTML = '<div class="default-prices-empty">No default prices set yet.</div>';
            return;
        }
        
        // Sort quotas numerically
        const sortedQuotas = Object.keys(this.defaultPrices)
            .map(q => parseFloat(q))
            .sort((a, b) => a - b);
        
        list.innerHTML = sortedQuotas.map(quota => {
            const price = this.defaultPrices[quota];
            return `
                <div class="default-prices-item" data-quota="${quota}">
                    <span class="default-prices-item-quota">${quota} GB</span>
                    <div class="default-prices-item-input-container">
                        <input type="text" class="default-prices-item-input" value="${this.formatNumberWithCommas(price)}" data-quota="${quota}" placeholder="Price">
                        <span class="default-prices-item-suffix">LBP</span>
                    </div>
                    <button class="default-prices-item-remove" type="button" data-quota="${quota}" title="Remove">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            `;
        }).join('');
        
        // Bind events for inputs and remove buttons
        list.querySelectorAll('.default-prices-item-input').forEach(input => {
            input.addEventListener('input', (e) => {
                this.formatNumberInput(e.target);
            });
            input.addEventListener('blur', (e) => {
                this.formatNumberInput(e.target);
            });
        });
        
        list.querySelectorAll('.default-prices-item-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const quota = e.target.closest('.default-prices-item-remove').getAttribute('data-quota');
                this.removeDefaultPriceEntry(quota);
            });
        });
    }
    
    /**
     * Add new default price entry
     */
    addDefaultPriceEntry() {
        const quotaInput = document.getElementById('newQuotaInput');
        const priceInput = document.getElementById('newPriceInput');
        
        if (!quotaInput || !priceInput) return;
        
        const quotaStr = quotaInput.value.trim();
        const priceStr = priceInput.value.trim();
        
        if (!quotaStr || !priceStr) {
            alert('Please enter both quota and price.');
            return;
        }
        
        const quota = parseFloat(quotaStr);
        const price = this.parseNumberFromInput(priceStr);
        
        if (isNaN(quota) || quota <= 0) {
            alert('Please enter a valid quota (positive number).');
            return;
        }
        
        if (price <= 0) {
            alert('Please enter a valid price.');
            return;
        }
        
        // Check if quota already exists
        if (this.defaultPrices[quota]) {
            alert(`A default price for ${quota} GB already exists. Please remove it first or update it.`);
            return;
        }
        
        // Add to default prices
        this.defaultPrices[quota] = price;
        
        // Clear inputs
        quotaInput.value = '';
        priceInput.value = '';
        
        // Re-render list
        this.renderDefaultPricesList();
    }
    
    /**
     * Remove default price entry
     */
    removeDefaultPriceEntry(quota) {
        if (this.defaultPrices[quota]) {
            delete this.defaultPrices[quota];
            this.renderDefaultPricesList();
        }
    }
    
    /**
     * Save Default Prices to Firebase
     */
    async saveDefaultPrices() {
        const saveBtn = document.getElementById('defaultPricesSave');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
        }
        
        try {
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized');
            }
            
            // Collect all prices from inputs (in case user edited them)
            const list = document.getElementById('defaultPricesList');
            if (list) {
                list.querySelectorAll('.default-prices-item-input').forEach(input => {
                    const quota = parseFloat(input.getAttribute('data-quota'));
                    const price = this.parseNumberFromInput(input.value);
                    if (!isNaN(quota) && quota > 0 && price > 0) {
                        this.defaultPrices[quota] = price;
                    }
                });
            }
            
            // Save to user document
            const userRef = db.collection('users').doc(this.currentUserId);
            await userRef.set({
                defaultPrices: this.defaultPrices,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            this.closeDefaultPricesModal();
            alert('Default prices saved successfully!');
            
            // Reload services to apply new default prices
            await this.loadServices();
        } catch (error) {
            console.error('Error saving default prices:', error);
            alert('Error saving default prices: ' + (error.message || 'Unknown error'));
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save Defaults';
            }
        }
    }
}

// Initialize when DOM is ready
let profitEngine;
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        profitEngine = new ProfitEngine();
    });
} else {
    profitEngine = new ProfitEngine();
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (profitEngine) {
        profitEngine.destroy();
    }
});

