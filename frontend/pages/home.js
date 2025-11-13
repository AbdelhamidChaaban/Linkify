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

    filterAvailableServices(snapshot) {
        const availableServices = [];

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};

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
}

document.addEventListener('DOMContentLoaded', () => {
    new HomeManager();
});
