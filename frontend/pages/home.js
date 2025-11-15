// Home Page Script
class HomeManager {
    constructor() {
        this.initCardListeners();
    }

    initCardListeners() {
        const cardsContainer = document.querySelector('.cards-container');
        if (cardsContainer) {
            cardsContainer.addEventListener('click', (event) => {
                const card = event.target.closest('.card');
                if (card) {
                    const cardId = card.dataset.cardId;
                    if (event.target.classList.contains('card-button')) {
                        this.handleCardClick(cardId, 'button');
                    } else {
                        this.handleCardClick(cardId, 'card');
                    }
                }
            });
        }
    }

    handleCardClick(cardId, action) {
        console.log(`Card ${cardId} was clicked with action: ${action}`);
        
        // Handle "Available Services" card (card-id="1")
        if (cardId === '1') {
            this.openAvailableServicesModal();
        }
        // Handle "Expired Numbers" card (card-id="2")
        else if (cardId === '2') {
            this.openExpiredNumbersModal();
        }
        // Handle "Services To Expire Today" card (card-id="3")
        else if (cardId === '3') {
            this.openServicesToExpireTodayModal();
        }
        // Handle "Finished Services" card (card-id="6")
        else if (cardId === '6') {
            this.openFinishedServicesModal();
        }
        // Handle "High Admin Consumption" card (card-id="7")
        else if (cardId === '7') {
            this.openHighAdminConsumptionModal();
        }
        // Handle "Inactive Numbers" card (card-id="9")
        else if (cardId === '9') {
            this.openInactiveNumbersModal();
        }
        // Future cards will be handled here
    }

    async openAvailableServicesModal() {
        try {
            // Check if Firebase is available
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
            }

            // Show loading state
            this.showLoadingModal();

            // Fetch all admins from Firebase
            const snapshot = await db.collection('admins').get();
            
            // Process and filter admins
            const availableServices = this.filterAvailableServices(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showAvailableServicesModal(availableServices);
        } catch (error) {
            console.error('Error opening Available Services modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    async openExpiredNumbersModal() {
        try {
            // Check if Firebase is available
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
            }

            // Show loading state
            this.showLoadingModal();

            // Fetch all admins from Firebase
            const snapshot = await db.collection('admins').get();
            
            // Process and filter admins
            const expiredNumbers = this.filterExpiredNumbers(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showExpiredNumbersModal(expiredNumbers);
        } catch (error) {
            console.error('Error opening Expired Numbers modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterAvailableServices(snapshot) {
        const availableServices = [];
        
        // Get today's date in DD/MM/YYYY format
        const today = new Date();
        const todayFormatted = this.formatDateDDMMYYYY(today);
        
        // First, get all admins that would appear in other cards to exclude them
        const excludedIds = new Set();
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip inactive admins (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                excludedIds.add(doc.id);
                return;
            }
            
            // Check if admin is in "Finished Services"
            // Parse admin consumption
            let adminConsumption = 0;
            let adminLimit = 0;
            
            if (alfaData.adminConsumption) {
                const adminConsumptionStr = String(alfaData.adminConsumption).trim();
                const match = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                if (match) {
                    adminConsumption = parseFloat(match[1]) || 0;
                    adminLimit = parseFloat(match[2]) || 0;
                }
            } else if (data.quota) {
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Parse total consumption
            let totalConsumption = 0;
            let totalLimit = 0;
            if (alfaData.totalConsumption) {
                const parsed = this.parseConsumption(alfaData.totalConsumption);
                totalConsumption = parsed.used;
                totalLimit = parsed.total || 0;
            } else if (data.quota) {
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                totalLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Check if this admin would be in Finished Services (same logic as filterFinishedServices)
            const isAdminFull = adminLimit > 0 && adminConsumption >= adminLimit - 0.01;
            const isTotalFull = totalLimit > 0 && totalConsumption >= totalLimit - 0.01;
            const isFullyUsed = isAdminFull || isTotalFull;
            
            if (isFullyUsed) {
                excludedIds.add(doc.id);
            }
            
            // Check if admin is in "Services To Expire Today"
            let validityDate = '';
            if (alfaData.validityDate) {
                validityDate = alfaData.validityDate;
            } else {
                // Fallback: calculate from createdAt + 30 days
                let createdAt = new Date();
                if (data.createdAt) {
                    createdAt = data.createdAt.toDate ? data.createdAt.toDate() : (data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt));
                }
                validityDate = this.formatDateDDMMYYYY(new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000));
            }
            
            // Check if validity date matches today
            if (validityDate === todayFormatted) {
                excludedIds.add(doc.id);
            }
        });

        // Now filter for Available Services, excluding those in other cards
        snapshot.docs.forEach(doc => {
            // Skip if this admin is in Finished Services or Services To Expire Today
            if (excludedIds.has(doc.id)) {
                return;
            }
            
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }

            // Parse total consumption
            let totalConsumption = 0;
            let totalLimit = data.quota || 0;

            if (alfaData.totalConsumption) {
                const parsed = this.parseConsumption(alfaData.totalConsumption);
                totalConsumption = parsed.used;
                totalLimit = parsed.total || totalLimit;
            }

            // Calculate usage percentage
            const usagePercent = totalLimit > 0 ? (totalConsumption / totalLimit) * 100 : 0;

            // Filter: only show admins with less than 5% usage
            if (usagePercent < 5) {
                // Get admin consumption
                let adminConsumption = 0;
                if (alfaData.adminConsumption) {
                    const adminConsumptionStr = String(alfaData.adminConsumption).trim();
                    const match = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*[\d.]+\s*(GB|MB)/i);
                    if (match) {
                        adminConsumption = parseFloat(match[1]) || 0;
                    }
                }

                // Calculate free space: totalLimit - totalConsumption
                // Note: totalConsumption already includes admin consumption, so we don't subtract it again
                const freeSpace = Math.max(0, totalLimit - totalConsumption);

                // Get validity date
                let validityDate = 'N/A';
                if (alfaData.validityDate) {
                    validityDate = alfaData.validityDate;
                }

                // Get subscribers count
                let subscribersCount = 0;
                if (alfaData.secondarySubscribers && Array.isArray(alfaData.secondarySubscribers)) {
                    subscribersCount = alfaData.secondarySubscribers.length;
                }

                availableServices.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    usage: totalConsumption,
                    usageLimit: totalLimit,
                    subscribersCount: subscribersCount,
                    freeSpace: freeSpace,
                    validityDate: validityDate,
                    alfaData: alfaData
                });
            }
        });

        return availableServices;
    }

    filterExpiredNumbers(snapshot) {
        const expiredNumbers = [];

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }

            // Get expiration (number of days)
            let expiration = 0;
            if (alfaData.expiration !== undefined) {
                expiration = typeof alfaData.expiration === 'number' 
                    ? alfaData.expiration 
                    : parseInt(alfaData.expiration) || 0;
            }

            // Filter: only show admins with expiration === 0
            if (expiration === 0) {
                expiredNumbers.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    expiration: expiration,
                    alfaData: alfaData
                });
            }
        });

        return expiredNumbers;
    }

    parseConsumption(consumptionStr) {
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

    /**
     * Helper function to determine if an admin is inactive
     * Uses the same logic as insights.js - checks if "u-share" exists in getconsumption response
     * @param {Object} data - Admin document data from Firebase
     * @param {Object} alfaData - Alfa data from admin document
     * @returns {boolean} - True if admin is inactive, false if active
     */
    isAdminInactive(data, alfaData) {
        const hasAlfaData = alfaData && Object.keys(alfaData).length > 0 && !alfaData.error;
        
        // Determine status based on getconsumption API response (same logic as insights.js)
        let status = 'inactive'; // Default to inactive
        
        if (hasAlfaData && alfaData.primaryData) {
            try {
                const apiData = alfaData.primaryData;
                
                // First, do a simple string search (most reliable)
                const responseStr = JSON.stringify(apiData).toLowerCase();
                if (responseStr.includes('u-share')) {
                    status = 'active';
                }
            } catch (statusError) {
                // If error, keep as inactive
            }
        }
        
        // Fallback: Also check apiResponses if primaryData not available
        if (status === 'inactive' && hasAlfaData && alfaData.apiResponses && Array.isArray(alfaData.apiResponses)) {
            const getConsumptionResponse = alfaData.apiResponses.find(resp => 
                resp.url && resp.url.includes('getconsumption')
            );
            if (getConsumptionResponse && getConsumptionResponse.data) {
                try {
                    const responseStr = JSON.stringify(getConsumptionResponse.data).toLowerCase();
                    if (responseStr.includes('u-share')) {
                        status = 'active';
                    }
                } catch (e) {
                    // Ignore errors
                }
            }
        }
        
        // Fallback to existing status logic if getconsumption response not found
        if (status === 'inactive' && data.status && data.status.toLowerCase().includes('active')) {
            status = 'active';
        }
        
        return status === 'inactive';
    }

    showLoadingModal() {
        // Remove existing modal if any
        const existingModal = document.getElementById('availableServicesModal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.id = 'availableServicesModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Available Services</h2>
                    </div>
                    <div class="available-services-modal-body">
                        <div style="display: flex; justify-content: center; align-items: center; padding: 3rem;">
                            <div style="display: inline-block; width: 40px; height: 40px; border: 4px solid rgba(58, 10, 78, 0.2); border-top-color: #3a0a4e; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Add spin animation if not already defined
        if (!document.getElementById('spinAnimation')) {
            const style = document.createElement('style');
            style.id = 'spinAnimation';
            style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
            document.head.appendChild(style);
        }
    }

    hideLoadingModal() {
        const modal = document.getElementById('availableServicesModal');
        if (modal) {
            modal.remove();
        }
    }

    showAvailableServicesModal(services) {
        // Remove existing modal if any
        const existingModal = document.getElementById('availableServicesModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows
        let tableRows = '';
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="5" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No available services found (all services have more than 5% usage)
                    </td>
                </tr>
            `;
        } else {
            services.forEach(service => {
                const usagePercent = service.usageLimit > 0 ? (service.usage / service.usageLimit) * 100 : 0;
                const progressClass = usagePercent >= 90 ? 'progress-fill error' : 'progress-fill';
                
                tableRows += `
                    <tr>
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="${progressClass}" style="width: ${usagePercent}%"></div>
                                </div>
                                <div class="progress-text">${service.usage.toFixed(2)} / ${service.usageLimit} GB</div>
                            </div>
                        </td>
                        <td>${service.subscribersCount}</td>
                        <td>${service.freeSpace.toFixed(2)} GB</td>
                        <td>${this.escapeHtml(service.validityDate)}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            });
        }

        const modal = document.createElement('div');
        modal.id = 'availableServicesModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Available Services</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Usage</th>
                                        <th>Subscribers</th>
                                        <th>Free Space</th>
                                        <th>Expiration Date</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, services);
            });
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    viewSubscriberDetails(id, services) {
        const service = services.find(s => s.id === id);
        if (!service) {
            console.error('Service not found:', id);
            return;
        }

        // Reuse the view details functionality from insights.js
        // We need to create a subscriber-like object for compatibility
        const subscriber = {
            id: service.id,
            name: service.name,
            phone: service.phone,
            alfaData: service.alfaData
        };

        // Import and use insights manager's view details method
        // For now, we'll create a simplified version
        this.showViewDetailsModal(subscriber);
    }

    showViewDetailsModal(subscriber) {
        // Remove existing modal if any
        const existingModal = document.getElementById('viewDetailsModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Extract view details data (similar to insights.js)
        const viewData = this.extractViewDetailsData(subscriber);

        // Create modal
        const modal = document.createElement('div');
        modal.id = 'viewDetailsModal';
        modal.className = 'view-details-modal-overlay';
        modal.innerHTML = `
            <div class="view-details-modal">
                <div class="view-details-modal-inner">
                    <div class="view-details-modal-header">
                        <h2>View Details - ${this.escapeHtml(subscriber.name)}</h2>
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
                                ${this.buildViewDetailsRows(viewData)}
                            </tbody>
                        </table>
                    </div>
                    <div class="view-details-modal-footer">
                        <button class="btn-cancel" onclick="this.closest('.view-details-modal-overlay').remove()">Close</button>
                    </div>
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
    }

    extractViewDetailsData(subscriber) {
        const data = {
            adminPhone: subscriber.phone,
            adminConsumption: 0,
            adminLimit: 0,
            subscribers: [],
            totalConsumption: 0,
            totalLimit: 0
        };

        if (!subscriber.alfaData) {
            return data;
        }

        // Get admin consumption
        if (subscriber.alfaData.adminConsumption) {
            const adminConsumptionStr = String(subscriber.alfaData.adminConsumption).trim();
            const match = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
            if (match) {
                data.adminConsumption = parseFloat(match[1]) || 0;
                data.adminLimit = parseFloat(match[2]) || 0;
            }
        }

        // Get total consumption
        if (subscriber.alfaData.totalConsumption) {
            const parsed = this.parseConsumption(subscriber.alfaData.totalConsumption);
            data.totalConsumption = parsed.used;
            data.totalLimit = parsed.total || data.totalLimit;
        }

        // Get subscribers from secondarySubscribers
        if (subscriber.alfaData.secondarySubscribers && Array.isArray(subscriber.alfaData.secondarySubscribers)) {
            subscriber.alfaData.secondarySubscribers.forEach(secondary => {
                if (secondary && secondary.phoneNumber) {
                    const consumptionStr = secondary.consumption || '';
                    const parsed = this.parseConsumption(consumptionStr);
                    data.subscribers.push({
                        phoneNumber: secondary.phoneNumber,
                        consumption: parsed.used,
                        limit: parsed.total
                    });
                }
            });
        }

        return data;
    }

    buildViewDetailsRows(viewData) {
        let rows = '';

        // Admin row
        const adminPercent = viewData.adminLimit > 0 ? (viewData.adminConsumption / viewData.adminLimit) * 100 : 0;
        const adminProgressClass = adminPercent >= 100 ? 'progress-fill error' : 'progress-fill';
        rows += `
            <tr>
                <td><strong>${this.escapeHtml(viewData.adminPhone)}</strong> (Admin)</td>
                <td>
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="${adminProgressClass}" style="width: ${adminPercent}%"></div>
                        </div>
                        <div class="progress-text">${viewData.adminConsumption.toFixed(2)} / ${viewData.adminLimit} GB</div>
                    </div>
                </td>
            </tr>
        `;

        // Subscriber rows
        viewData.subscribers.forEach(sub => {
            const subPercent = sub.limit > 0 ? (sub.consumption / sub.limit) * 100 : 0;
            const subProgressClass = subPercent >= 100 ? 'progress-fill error' : 'progress-fill';
            rows += `
                <tr>
                    <td>${this.escapeHtml(sub.phoneNumber)}</td>
                    <td>
                        <div class="progress-container">
                            <div class="progress-bar">
                                <div class="${subProgressClass}" style="width: ${subPercent}%"></div>
                            </div>
                            <div class="progress-text">${sub.consumption.toFixed(2)} / ${sub.limit} GB</div>
                        </div>
                    </td>
                </tr>
            `;
        });

        // Total row
        const totalPercent = viewData.totalLimit > 0 ? (viewData.totalConsumption / viewData.totalLimit) * 100 : 0;
        const totalProgressClass = totalPercent >= 100 ? 'progress-fill error' : 'progress-fill';
        rows += `
            <tr class="total-row">
                <td><strong>Total</strong></td>
                <td>
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="${totalProgressClass}" style="width: ${totalPercent}%"></div>
                        </div>
                        <div class="progress-text">${viewData.totalConsumption.toFixed(2)} / ${viewData.totalLimit} GB</div>
                    </div>
                </td>
            </tr>
        `;

        return rows;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Services To Expire Today Modal
    async openServicesToExpireTodayModal() {
        try {
            // Check if Firebase is available
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
            }

            // Show loading state
            this.showLoadingModal();

            // Fetch all admins from Firebase
            const snapshot = await db.collection('admins').get();
            
            // Process and filter admins
            const expiringToday = this.filterServicesToExpireToday(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showServicesToExpireTodayModal(expiringToday);
        } catch (error) {
            console.error('Error opening Services To Expire Today modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterServicesToExpireToday(snapshot) {
        const expiringToday = [];
        
        // Get today's date in DD/MM/YYYY format
        const today = new Date();
        const todayFormatted = this.formatDateDDMMYYYY(today);

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }
            
            // Get validity date
            let validityDate = '';
            if (alfaData.validityDate) {
                validityDate = alfaData.validityDate;
            } else {
                // Fallback: calculate from createdAt + 30 days
                let createdAt = new Date();
                if (data.createdAt) {
                    createdAt = data.createdAt.toDate ? data.createdAt.toDate() : (data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt));
                }
                validityDate = this.formatDateDDMMYYYY(new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000));
            }

            // Check if validity date matches today
            if (validityDate === todayFormatted) {
                // Parse balance
                let balance = 0;
                if (alfaData.balance) {
                    const balanceStr = String(alfaData.balance).trim();
                    const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                    balance = match ? parseFloat(match[0]) : 0;
                }

                // Get bundle size (total limit from total consumption)
                let bundleSize = 0;
                if (alfaData.totalConsumption) {
                    const parsed = this.parseConsumption(alfaData.totalConsumption);
                    bundleSize = parsed.total || 0;
                } else if (data.quota) {
                    const quotaStr = String(data.quota).trim();
                    const quotaMatch = quotaStr.match(/^([\d.]+)/);
                    bundleSize = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
                }

                // Get subscribers count
                let subscribersCount = 0;
                if (alfaData.secondarySubscribers && Array.isArray(alfaData.secondarySubscribers)) {
                    subscribersCount = alfaData.secondarySubscribers.length;
                } else if (alfaData.subscribersCount !== undefined) {
                    subscribersCount = typeof alfaData.subscribersCount === 'number' 
                        ? alfaData.subscribersCount 
                        : parseInt(alfaData.subscribersCount) || 0;
                }

                // Get expiration (days)
                let expiration = 0;
                if (alfaData.expiration !== undefined) {
                    expiration = typeof alfaData.expiration === 'number' 
                        ? alfaData.expiration 
                        : parseInt(alfaData.expiration) || 0;
                }

                // Calculate needed balance status
                const neededBalanceStatus = this.calculateNeededBalanceStatus(bundleSize, balance);

                expiringToday.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    balance: balance,
                    bundleSize: bundleSize,
                    subscribersCount: subscribersCount,
                    neededBalanceStatus: neededBalanceStatus,
                    expiration: expiration,
                    validityDate: validityDate,
                    alfaData: alfaData
                });
            }
        });

        return expiringToday;
    }

    formatDateDDMMYYYY(date) {
        if (!date) return '';
        const d = new Date(date);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
    }

    calculateNeededBalanceStatus(bundleSize, balance) {
        // Round bundle size to nearest integer for comparison
        const size = Math.round(bundleSize);
        
        if (size === 1) {
            return balance >= 3.50 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 7) {
            return balance >= 9 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 22) {
            return balance >= 14.50 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 44) {
            return balance >= 21 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 77) {
            return balance >= 31 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 111) {
            return balance >= 40 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 444) {
            return balance >= 40 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else {
            // Default: if bundle size doesn't match any known size, use 77 GB logic
            return balance >= 31 ? 'Ready To Renew' : 'Not Ready To Renew';
        }
    }

    showServicesToExpireTodayModal(services) {
        // Remove existing modal if any
        const existingModal = document.getElementById('servicesToExpireTodayModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows
        let tableRows = '';
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No services expiring today found
                    </td>
                </tr>
            `;
        } else {
            services.forEach(service => {
                const statusClass = service.neededBalanceStatus === 'Ready To Renew' ? 'ready' : 'not-ready';
                
                tableRows += `
                    <tr>
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>$${service.balance.toFixed(2)}</td>
                        <td>${service.bundleSize} GB</td>
                        <td>${service.subscribersCount}</td>
                        <td>
                            <span class="needed-balance-status ${statusClass}">${this.escapeHtml(service.neededBalanceStatus)}</span>
                        </td>
                        <td>${service.expiration}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            });
        }

        const modal = document.createElement('div');
        modal.id = 'servicesToExpireTodayModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Services To Expire Today</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Balance</th>
                                        <th>Bundle Size</th>
                                        <th>Subscribers</th>
                                        <th>Needed Balance</th>
                                        <th>Expiration</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, services);
            });
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    showExpiredNumbersModal(numbers) {
        // Remove existing modal if any
        const existingModal = document.getElementById('expiredNumbersModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows
        let tableRows = '';
        if (numbers.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="3" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No expired numbers found
                    </td>
                </tr>
            `;
        } else {
            numbers.forEach(number => {
                tableRows += `
                    <tr>
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(number.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(number.phone)}</div>
                            </div>
                        </td>
                        <td>${number.expiration}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${number.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            });
        }

        const modal = document.createElement('div');
        modal.id = 'expiredNumbersModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Expired Numbers</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Expiration</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, numbers);
            });
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }


    // Finished Services Modal
    async openFinishedServicesModal() {
        try {
            // Check if Firebase is available
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
            }

            // Show loading state
            this.showLoadingModal();

            // Fetch all admins from Firebase
            const snapshot = await db.collection('admins').get();
            
            // Process and filter admins
            const finishedServices = this.filterFinishedServices(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showFinishedServicesModal(finishedServices);
        } catch (error) {
            console.error('Error opening Finished Services modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterFinishedServices(snapshot) {
        const finishedServices = [];

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }

            // Parse total consumption
            let totalConsumption = 0;
            let totalLimit = 0;

            if (alfaData.totalConsumption) {
                const parsed = this.parseConsumption(alfaData.totalConsumption);
                totalConsumption = parsed.used;
                totalLimit = parsed.total || 0;
            } else if (data.quota) {
                // Fallback: use quota as limit
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                totalLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }

            // Parse admin consumption
            let adminConsumption = 0;
            let adminLimit = 0;
            
            if (alfaData.adminConsumption) {
                const adminConsumptionStr = String(alfaData.adminConsumption).trim();
                const match = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                if (match) {
                    adminConsumption = parseFloat(match[1]) || 0;
                    adminLimit = parseFloat(match[2]) || 0;
                }
            } else if (data.quota) {
                // Fallback: use quota as admin limit
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }

            // Check if bundle is fully used:
            // 1. If admin consumption >= admin limit (e.g., 77/22) - bundle is fully used
            // 2. If total consumption >= total limit - bundle is fully used
            const isAdminFull = adminLimit > 0 && adminConsumption >= adminLimit - 0.01;
            const isTotalFull = totalLimit > 0 && totalConsumption >= totalLimit - 0.01;
            const isFullyUsed = isAdminFull || isTotalFull;

            if (isFullyUsed) {
                // Parse balance
                let balance = 0;
                if (alfaData.balance) {
                    const balanceStr = String(alfaData.balance).trim();
                    const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                    balance = match ? parseFloat(match[0]) : 0;
                }

                // Get subscribers count
                let subscribersCount = 0;
                if (alfaData.secondarySubscribers && Array.isArray(alfaData.secondarySubscribers)) {
                    subscribersCount = alfaData.secondarySubscribers.length;
                } else if (alfaData.subscribersCount !== undefined) {
                    subscribersCount = typeof alfaData.subscribersCount === 'number' 
                        ? alfaData.subscribersCount 
                        : parseInt(alfaData.subscribersCount) || 0;
                }

                // Get expiration (days)
                let expiration = 0;
                if (alfaData.expiration !== undefined) {
                    expiration = typeof alfaData.expiration === 'number' 
                        ? alfaData.expiration 
                        : parseInt(alfaData.expiration) || 0;
                }

                // When bundle is fully used, use adminConsumption as total if it's full
                let displayTotalConsumption = totalConsumption;
                let displayTotalLimit = totalLimit;
                
                if (isAdminFull && adminConsumption > 0) {
                    // When admin consumption is full (e.g., 77/22), use adminConsumption as total bundle size
                    displayTotalConsumption = adminConsumption;
                    displayTotalLimit = adminConsumption;
                }

                finishedServices.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    totalConsumption: displayTotalConsumption,
                    totalLimit: displayTotalLimit,
                    subscribersCount: subscribersCount,
                    expiration: expiration,
                    balance: balance,
                    usagePercent: 100, // Always 100% when fully used
                    alfaData: alfaData
                });
            }
        });

        return finishedServices;
    }

    // High Admin Consumption Modal
    async openHighAdminConsumptionModal() {
        try {
            // Check if Firebase is available
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
            }

            // Show loading state
            this.showLoadingModal();

            // Fetch all admins from Firebase
            const snapshot = await db.collection('admins').get();
            
            // Process and filter admins
            const highAdminConsumption = this.filterHighAdminConsumption(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showHighAdminConsumptionModal(highAdminConsumption);
        } catch (error) {
            console.error('Error opening High Admin Consumption modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterHighAdminConsumption(snapshot) {
        const highAdminConsumption = [];
        
        // First, get all admins that would appear in "Finished Services" to exclude them
        const finishedServicesIds = new Set();
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Parse admin consumption
            let adminConsumption = 0;
            let adminLimit = 0;
            
            if (alfaData.adminConsumption) {
                const adminConsumptionStr = String(alfaData.adminConsumption).trim();
                const match = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                if (match) {
                    adminConsumption = parseFloat(match[1]) || 0;
                    adminLimit = parseFloat(match[2]) || 0;
                }
            } else if (data.quota) {
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Parse total consumption
            let totalConsumption = 0;
            let totalLimit = 0;
            if (alfaData.totalConsumption) {
                const parsed = this.parseConsumption(alfaData.totalConsumption);
                totalConsumption = parsed.used;
                totalLimit = parsed.total || 0;
            } else if (data.quota) {
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                totalLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Check if this admin would be in Finished Services (same logic as filterFinishedServices)
            const isAdminFull = adminLimit > 0 && adminConsumption >= adminLimit - 0.01;
            const isTotalFull = totalLimit > 0 && totalConsumption >= totalLimit - 0.01;
            const isFullyUsed = isAdminFull || isTotalFull;
            
            if (isFullyUsed) {
                finishedServicesIds.add(doc.id);
            }
        });

        // Now filter for High Admin Consumption, excluding those in Finished Services
        snapshot.docs.forEach(doc => {
            // Skip if this admin is in Finished Services
            if (finishedServicesIds.has(doc.id)) {
                return;
            }
            
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }

            // Parse admin consumption - this is the key metric
            let adminConsumption = 0;
            let adminLimit = 0;
            
            // Admin limit is always the quota set when creating admin (extract number only)
            if (data.quota) {
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Get admin consumption from alfaData.adminConsumption (format: "X / Y GB")
            if (alfaData.adminConsumption) {
                const adminConsumptionStr = String(alfaData.adminConsumption).trim();
                const match = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*[\d.]+\s*(GB|MB)/i);
                if (match) {
                    adminConsumption = parseFloat(match[1]) || 0;
                    // adminLimit is from quota, not from the adminConsumption string
                }
            }

            // Parse total consumption for display
            let totalConsumption = 0;
            let totalLimit = 0;

            if (alfaData.totalConsumption) {
                const parsed = this.parseConsumption(alfaData.totalConsumption);
                totalConsumption = parsed.used;
                totalLimit = parsed.total || 0;
            } else if (data.quota) {
                // Fallback: use quota as limit
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                totalLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }

            // Check if admin consumption is fully used or exceeds admin quota
            const isAdminQuotaFull = adminLimit > 0 && adminConsumption >= adminLimit - 0.01;
            
            // Show only if admin quota is full (and we already excluded Finished Services admins above)
            if (isAdminQuotaFull) {
                // Get validity date
                let validityDate = '';
                if (alfaData.validityDate) {
                    validityDate = alfaData.validityDate;
                } else {
                    // Fallback: calculate from createdAt + 30 days
                    let createdAt = new Date();
                    if (data.createdAt) {
                        createdAt = data.createdAt.toDate ? data.createdAt.toDate() : (data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt));
                    }
                    validityDate = this.formatDateDDMMYYYY(new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000));
                }

                highAdminConsumption.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    adminConsumption: adminConsumption,
                    adminLimit: adminLimit,
                    totalConsumption: totalConsumption,
                    totalLimit: totalLimit,
                    validityDate: validityDate,
                    alfaData: alfaData
                });
            }
        });

        return highAdminConsumption;
    }

    showHighAdminConsumptionModal(services) {
        // Remove existing modal if any
        const existingModal = document.getElementById('highAdminConsumptionModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows
        let tableRows = '';
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="5" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No admins with high admin consumption found
                    </td>
                </tr>
            `;
        } else {
            services.forEach(service => {
                const adminPercent = service.adminLimit > 0 ? (service.adminConsumption / service.adminLimit) * 100 : 0;
                const adminProgressClass = adminPercent >= 100 ? 'progress-fill error' : 'progress-fill';
                const adminProgressWidth = Math.min(adminPercent, 100);
                
                const totalPercent = service.totalLimit > 0 ? (service.totalConsumption / service.totalLimit) * 100 : 0;
                const totalProgressClass = totalPercent >= 100 ? 'progress-fill error' : (totalPercent >= 90 ? 'progress-fill error' : (totalPercent >= 70 ? 'progress-fill warning' : 'progress-fill'));
                const totalProgressWidth = Math.min(totalPercent, 100);
                
                tableRows += `
                    <tr>
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="${adminProgressClass}" style="width: ${adminProgressWidth}%"></div>
                                </div>
                                <div class="progress-text">${service.adminConsumption.toFixed(2)} / ${service.adminLimit.toFixed(2)} GB</div>
                            </div>
                        </td>
                        <td>
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="${totalProgressClass}" style="width: ${totalProgressWidth}%"></div>
                                </div>
                                <div class="progress-text">${service.totalConsumption.toFixed(2)} / ${service.totalLimit.toFixed(2)} GB</div>
                            </div>
                        </td>
                        <td>${this.escapeHtml(service.validityDate)}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            });
        }

        const modal = document.createElement('div');
        modal.id = 'highAdminConsumptionModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>High Admin Consumption</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Admin Usage</th>
                                        <th>Total Usage</th>
                                        <th>Expiration Date</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, services);
            });
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    showFinishedServicesModal(services) {
        // Remove existing modal if any
        const existingModal = document.getElementById('finishedServicesModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows
        let tableRows = '';
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No finished services found (all services have available space)
                    </td>
                </tr>
            `;
        } else {
            services.forEach(service => {
                const usagePercent = service.totalLimit > 0 ? (service.totalConsumption / service.totalLimit) * 100 : 0;
                const progressClass = usagePercent >= 100 ? 'progress-fill error' : 'progress-fill';
                
                tableRows += `
                    <tr>
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="${progressClass}" style="width: ${usagePercent}%"></div>
                                </div>
                                <div class="progress-text">${service.totalConsumption.toFixed(2)} / ${service.totalLimit} GB</div>
                            </div>
                        </td>
                        <td>${service.subscribersCount}</td>
                        <td>${service.expiration}</td>
                        <td>$${service.balance.toFixed(2)}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            });
        }

        const modal = document.createElement('div');
        modal.id = 'finishedServicesModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Finished Services</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Usage</th>
                                        <th>Subscribers</th>
                                        <th>Expiration</th>
                                        <th>Balance</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, services);
            });
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    async openInactiveNumbersModal() {
        try {
            // Check if Firebase is available
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
            }

            // Show loading state
            this.showLoadingModal();

            // Fetch all admins from Firebase
            const snapshot = await db.collection('admins').get();
            
            // Process and filter admins
            const inactiveNumbers = this.filterInactiveNumbers(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showInactiveNumbersModal(inactiveNumbers);
        } catch (error) {
            console.error('Error opening Inactive Numbers modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterInactiveNumbers(snapshot) {
        const inactiveNumbers = [];

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};

            // Filter: only show admins with status === 'inactive' (using helper function)
            if (this.isAdminInactive(data, alfaData)) {
                // Parse balance
                let balance = 0;
                if (alfaData.balance) {
                    const balanceStr = String(alfaData.balance).trim();
                    const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                    balance = match ? parseFloat(match[0]) : 0;
                }

                inactiveNumbers.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    balance: balance,
                    alfaData: alfaData
                });
            }
        });

        return inactiveNumbers;
    }

    showInactiveNumbersModal(numbers) {
        // Remove existing modal if any
        const existingModal = document.getElementById('inactiveNumbersModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows
        let tableRows = '';
        if (numbers.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="2" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No inactive numbers found
                    </td>
                </tr>
            `;
        } else {
            numbers.forEach(number => {
                tableRows += `
                    <tr>
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(number.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(number.phone)}</div>
                            </div>
                        </td>
                        <td>$${number.balance.toFixed(2)}</td>
                    </tr>
                `;
            });
        }

        const modal = document.createElement('div');
        modal.id = 'inactiveNumbersModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Inactive Numbers</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Balance</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                    </div>
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
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new HomeManager();
});
