// Home Page Script
class HomeManager {
    constructor() {
        this.admins = [];
        this.unsubscribe = null;
        this.periodicRefreshInterval = null;
        this.initCardListeners();
        this.initRealTimeListener();
        
        // Also force a fresh fetch on initialization to ensure we have latest data
        this.forceRefresh();
        
        // Refresh when page becomes visible (user switches back to tab)
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                console.log('👁️ [Home] Page became visible, refreshing data...');
                this.forceRefresh();
            }
        });

        // Set up periodic refresh every 30 seconds to ensure we're always in sync
        // This acts as a safety net in case the real-time listener misses something
        this.periodicRefreshInterval = setInterval(() => {
            console.log('⏰ [Home] Periodic refresh triggered');
            this.forceRefresh();
        }, 30000); // 30 seconds
    }

    async forceRefresh() {
        // Force a fresh fetch from server to ensure we have latest data
        if (typeof db === 'undefined') {
            console.warn('⚠️ [Home] Firebase not available, skipping force refresh');
            return;
        }

        try {
            console.log('🔄 [Home] Force refreshing data from server...');
            // Note: Compat version may not support source option, but get() should still work
            const snapshot = await db.collection('admins').get();
            
            // Update admins array from fresh server data
            const previousCount = this.admins.length;
            const previousIds = new Set(this.admins.map(a => a.id));
            
            // CRITICAL: Only include documents that actually exist in the snapshot
            const newAdmins = [];
            snapshot.docs.forEach(doc => {
                try {
                    const data = doc.data();
                    if (data && doc.id) {
                        newAdmins.push({
                            id: doc.id,
                            ...data
                        });
                    } else {
                        console.warn(`⚠️ [Home] Skipping invalid document: ${doc.id}`);
                    }
                } catch (e) {
                    console.error(`❌ [Home] Error processing document ${doc.id}:`, e);
                }
            });

            this.admins = newAdmins;

            const currentIds = new Set(this.admins.map(a => a.id));
            const deletedIds = [...previousIds].filter(id => !currentIds.has(id));
            const addedIds = [...currentIds].filter(id => !previousIds.has(id));

            console.log(`✅ [Home] Force refresh complete:`, {
                previousCount: previousCount,
                currentCount: this.admins.length,
                deleted: deletedIds.length,
                added: addedIds.length,
                deletedIds: deletedIds,
                addedIds: addedIds
            });
            
            // Update card counts
            this.updateCardCounts();
        } catch (error) {
            console.error('❌ [Home] Force refresh failed:', error);
        }
    }

    initRealTimeListener() {
        // Check if Firebase is available
        if (typeof db === 'undefined') {
            console.error('Firebase Firestore (db) is not initialized. Real-time updates disabled.');
            return;
        }

        // Set up real-time listener for admins collection
        // Note: Compat version doesn't support includeMetadataChanges option
        this.unsubscribe = db.collection('admins').onSnapshot(
            (snapshot) => {
                // Check if this is from cache (offline mode)
                const source = snapshot.metadata && snapshot.metadata.fromCache ? 'cache' : 'server';
                
                // Log document changes to track deletions
                let hasDeletions = false;
                const deletedIdsFromChanges = [];
                try {
                    const changes = snapshot.docChanges ? snapshot.docChanges() : [];
                    if (changes.length > 0) {
                        console.log(`📝 [Home] Detected ${changes.length} document change(s) (source: ${source}):`);
                        changes.forEach((change) => {
                            console.log(`   - ${change.type}: ${change.doc.id}`);
                            if (change.type === 'removed') {
                                hasDeletions = true;
                                deletedIdsFromChanges.push(change.doc.id);
                                console.log(`   🗑️ [Home] Admin deleted: ${change.doc.id}`);
                            }
                        });
                    }
                } catch (e) {
                    console.log('📝 [Home] Could not get docChanges (compat version limitation)');
                }

                // CRITICAL: Always rebuild admins array from snapshot.docs
                // Deleted documents won't be in snapshot.docs, so they're automatically excluded
                const previousAdminIds = new Set(this.admins.map(a => a.id));
                
                // Rebuild admins array from current snapshot (this automatically excludes deleted docs)
                // IMPORTANT: Only include documents that exist in the snapshot
                const newAdmins = [];
                snapshot.docs.forEach(doc => {
                    try {
                        const data = doc.data();
                        if (data && doc.id) {
                            newAdmins.push({
                                id: doc.id,
                                ...data
                            });
                        }
                    } catch (e) {
                        console.error(`❌ [Home] Error processing document ${doc.id}:`, e);
                    }
                });

                // Update admins array
                this.admins = newAdmins;
                
                const currentAdminIds = new Set(this.admins.map(a => a.id));
                
                // Find deleted admins by comparing previous and current IDs
                const deletedIds = [...previousAdminIds].filter(id => !currentAdminIds.has(id));
                
                if (deletedIds.length > 0) {
                    console.log(`🗑️ [Home] Detected ${deletedIds.length} deleted admin(s):`, deletedIds);
                    console.log(`🗑️ [Home] Deleted IDs from changes:`, deletedIdsFromChanges);
                }

                console.log('🔄 [Home] Real-time listener triggered!', {
                    docCount: snapshot.docs.length,
                    previousCount: previousAdminIds.size,
                    currentCount: this.admins.length,
                    deletedCount: deletedIds.length,
                    source: source,
                    timestamp: new Date().toISOString()
                });

                // ALWAYS update card counts when listener fires (to catch any deletions)
                console.log(`🔄 [Home] Updating card counts (hasDeletions: ${hasDeletions}, deletedIds: ${deletedIds.length})`);
                this.updateCardCounts();
                this.updateOpenModals();

                // If using cache, warn and force a server refresh
                if (source === 'cache') {
                    console.warn('⚠️ [Home] Using cached data - forcing server refresh to ensure accuracy');
                    // Force a server refresh to get latest data
                    setTimeout(() => {
                        this.forceRefresh();
                    }, 1000);
                }
            },
            (error) => {
                console.error('❌ [Home] Real-time listener error:', error);
                
                // Try to reconnect after a delay
                setTimeout(() => {
                    console.log('🔄 [Home] Attempting to reconnect to Firestore...');
                    if (this.unsubscribe) {
                        this.unsubscribe();
                    }
                    this.initRealTimeListener();
                }, 5000);
            }
        );
    }

    updateCardCounts() {
        // Log current state for debugging
        console.log(`📊 [Home] Updating card counts with ${this.admins.length} admin(s)`);
        
        // CRITICAL: Filter out any invalid admins first
        const validAdmins = this.admins.filter(admin => {
            if (!admin || !admin.id) {
                console.warn(`⚠️ [Home] Found invalid admin (missing id):`, admin);
                return false;
            }
            return true;
        });

        if (validAdmins.length !== this.admins.length) {
            console.log(`🧹 [Home] Filtered out ${this.admins.length - validAdmins.length} invalid admin(s)`);
            this.admins = validAdmins;
        }
        
        // CRITICAL: Remove duplicates by ID
        const uniqueAdmins = [];
        const seenIds = new Set();
        this.admins.forEach(admin => {
            if (!seenIds.has(admin.id)) {
                seenIds.add(admin.id);
                uniqueAdmins.push(admin);
            } else {
                console.warn(`⚠️ [Home] Found duplicate admin ID: ${admin.id}`);
            }
        });
        
        if (uniqueAdmins.length !== this.admins.length) {
            console.log(`🧹 [Home] Removed ${this.admins.length - uniqueAdmins.length} duplicate admin(s)`);
            this.admins = uniqueAdmins;
        }
        
        if (!this.admins || this.admins.length === 0) {
            // No admins yet, set all counts to 0
            console.log('📊 [Home] No admins found, setting all counts to 0');
            this.setCardCount('1', 0); // Available Services
            this.setCardCount('2', 0); // Expired Numbers
            this.setCardCount('3', 0); // Services To Expire Today
            this.setCardCount('6', 0); // Finished Services
            this.setCardCount('7', 0); // High Admin Consumption
            this.setCardCount('9', 0); // Inactive Numbers
            return;
        }

        // Create a snapshot-like object for compatibility with filter functions
        // IMPORTANT: Only include valid admins that exist in this.admins
        const snapshot = {
            docs: this.admins.map(admin => ({
                id: admin.id,
                data: () => admin
            }))
        };

        console.log(`📊 [Home] Processing ${snapshot.docs.length} unique admin document(s) for filtering`);

        // Calculate counts for each card
        const availableServices = this.filterAvailableServices(snapshot);
        const expiredNumbers = this.filterExpiredNumbers(snapshot);
        const expiringToday = this.filterServicesToExpireToday(snapshot);
        const finishedServices = this.filterFinishedServices(snapshot);
        const highAdminConsumption = this.filterHighAdminConsumption(snapshot);
        const inactiveNumbers = this.filterInactiveNumbers(snapshot);

        // Update card counts
        this.setCardCount('1', availableServices.length); // Available Services
        this.setCardCount('2', expiredNumbers.length); // Expired Numbers
        this.setCardCount('3', expiringToday.length); // Services To Expire Today
        this.setCardCount('6', finishedServices.length); // Finished Services
        this.setCardCount('7', highAdminConsumption.length); // High Admin Consumption
        this.setCardCount('9', inactiveNumbers.length); // Inactive Numbers

        console.log(`📊 [Home] Card counts updated:`, {
            availableServices: availableServices.length,
            expiredNumbers: expiredNumbers.length,
            expiringToday: expiringToday.length,
            finishedServices: finishedServices.length,
            highAdminConsumption: highAdminConsumption.length,
            inactiveNumbers: inactiveNumbers.length,
            totalAdmins: this.admins.length
        });
    }

    setCardCount(cardId, count) {
        const card = document.querySelector(`.card[data-card-id="${cardId}"]`);
        if (card) {
            // Find or create count element
            let countElement = card.querySelector('.card-count');
            if (!countElement) {
                countElement = document.createElement('div');
                countElement.className = 'card-count';
                // Append directly to card (not card-content) so it doesn't overlap with title
                card.appendChild(countElement);
            }
            countElement.textContent = count;
        }
    }

    updateOpenModals() {
        // Update modals if they're currently open
        const availableServicesModal = document.getElementById('availableServicesModal');
        if (availableServicesModal && !availableServicesModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            // Modal is open and not loading - refresh data
            this.refreshOpenModal('availableServices');
        }

        const expiredNumbersModal = document.getElementById('expiredNumbersModal');
        if (expiredNumbersModal && !expiredNumbersModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('expiredNumbers');
        }

        const servicesToExpireTodayModal = document.getElementById('servicesToExpireTodayModal');
        if (servicesToExpireTodayModal && !servicesToExpireTodayModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('servicesToExpireToday');
        }

        const finishedServicesModal = document.getElementById('finishedServicesModal');
        if (finishedServicesModal && !finishedServicesModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('finishedServices');
        }

        const highAdminConsumptionModal = document.getElementById('highAdminConsumptionModal');
        if (highAdminConsumptionModal && !highAdminConsumptionModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('highAdminConsumption');
        }

        const inactiveNumbersModal = document.getElementById('inactiveNumbersModal');
        if (inactiveNumbersModal && !inactiveNumbersModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('inactiveNumbers');
        }
    }

    refreshOpenModal(modalType) {
        if (!this.admins || this.admins.length === 0) return;

        const snapshot = {
            docs: this.admins.map(admin => ({
                id: admin.id,
                data: () => admin
            }))
        };

        switch (modalType) {
            case 'availableServices':
                const availableServices = this.filterAvailableServices(snapshot);
                this.showAvailableServicesModal(availableServices);
                break;
            case 'expiredNumbers':
                const expiredNumbers = this.filterExpiredNumbers(snapshot);
                this.showExpiredNumbersModal(expiredNumbers);
                break;
            case 'servicesToExpireToday':
                const expiringToday = this.filterServicesToExpireToday(snapshot);
                this.showServicesToExpireTodayModal(expiringToday);
                break;
            case 'finishedServices':
                const finishedServices = this.filterFinishedServices(snapshot);
                this.showFinishedServicesModal(finishedServices);
                break;
            case 'highAdminConsumption':
                const highAdminConsumption = this.filterHighAdminConsumption(snapshot);
                this.showHighAdminConsumptionModal(highAdminConsumption);
                break;
            case 'inactiveNumbers':
                const inactiveNumbers = this.filterInactiveNumbers(snapshot);
                this.showInactiveNumbersModal(inactiveNumbers);
                break;
        }
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
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                // Use cached real-time data
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                // Fallback: fetch from Firebase if real-time data not available
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                const firebaseSnapshot = await db.collection('admins').get();
                snapshot = firebaseSnapshot;
            }
            
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
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                const firebaseSnapshot = await db.collection('admins').get();
                snapshot = firebaseSnapshot;
            }
            
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
     * Uses the EXACT same logic as insights.js
     * RULE 1: Admin is active if ServiceNameValue contains "U-share Main"
     * RULE 2 (EXCEPTION): Admin is active if ServiceNameValue is "Mobile Internet" AND ValidityDateValue has a valid date
     * Otherwise, admin is inactive
     * @param {Object} data - Admin document data from Firebase
     * @param {Object} alfaData - Alfa data from admin document
     * @returns {boolean} - True if admin is inactive, false if active
     */
    isAdminInactive(data, alfaData) {
        const hasAlfaData = alfaData && Object.keys(alfaData).length > 0 && !alfaData.error;
        
        // Determine status based on getconsumption API response (EXACT same logic as insights.js)
        // RULE 1: Admin is active if ServiceNameValue contains "U-share Main"
        // RULE 2 (EXCEPTION): Admin is active if ServiceNameValue is "Mobile Internet" AND ValidityDateValue has a valid date
        // Otherwise, admin is inactive
        let status = 'inactive'; // Default to inactive
        
        if (hasAlfaData && alfaData.primaryData) {
            try {
                const apiData = alfaData.primaryData;
                
                // Check ServiceInformationValue array
                if (apiData.ServiceInformationValue && Array.isArray(apiData.ServiceInformationValue)) {
                    for (const service of apiData.ServiceInformationValue) {
                        if (service.ServiceNameValue) {
                            const serviceName = String(service.ServiceNameValue).trim();
                            
                            // RULE 1: Check if ServiceNameValue is "U-share Main" (case-insensitive)
                            if (serviceName.toLowerCase() === 'u-share main') {
                                status = 'active';
                                break;
                            }
                            
                            // RULE 2 (EXCEPTION): Check if ServiceNameValue is "Mobile Internet" AND has valid ValidityDateValue
                            if (serviceName.toLowerCase() === 'mobile internet') {
                                // Check ServiceDetailsInformationValue for ValidityDateValue
                                if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                    for (const details of service.ServiceDetailsInformationValue) {
                                        const validityDate = details.ValidityDateValue;
                                        // Check if ValidityDateValue exists and is not empty/null
                                        if (validityDate && String(validityDate).trim() !== '' && String(validityDate).trim() !== 'null') {
                                            // Check if it looks like a valid date (e.g., "22/11/2025")
                                            const datePattern = /^\d{2}\/\d{2}\/\d{4}$/;
                                            if (datePattern.test(String(validityDate).trim())) {
                                                status = 'active';
                                                break;
                                            }
                                        }
                                    }
                                    if (status === 'active') break;
                                }
                            }
                        }
                    }
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
                    const responseData = getConsumptionResponse.data;
                    if (responseData.ServiceInformationValue && Array.isArray(responseData.ServiceInformationValue)) {
                        for (const service of responseData.ServiceInformationValue) {
                            if (service.ServiceNameValue) {
                                const serviceName = String(service.ServiceNameValue).trim();
                                
                                // RULE 1: Check for "U-share Main"
                                if (serviceName.toLowerCase() === 'u-share main') {
                                    status = 'active';
                                    break;
                                }
                                
                                // RULE 2 (EXCEPTION): Check for "Mobile Internet" with valid ValidityDateValue
                                if (serviceName.toLowerCase() === 'mobile internet') {
                                    if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                        for (const details of service.ServiceDetailsInformationValue) {
                                            const validityDate = details.ValidityDateValue;
                                            if (validityDate && String(validityDate).trim() !== '' && String(validityDate).trim() !== 'null') {
                                                const datePattern = /^\d{2}\/\d{2}\/\d{4}$/;
                                                if (datePattern.test(String(validityDate).trim())) {
                                                    status = 'active';
                                                    break;
                                                }
                                            }
                                        }
                                        if (status === 'active') break;
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors
                }
            }
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
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                const firebaseSnapshot = await db.collection('admins').get();
                snapshot = firebaseSnapshot;
            }
            
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
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                const firebaseSnapshot = await db.collection('admins').get();
                snapshot = firebaseSnapshot;
            }
            
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
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                const firebaseSnapshot = await db.collection('admins').get();
                snapshot = firebaseSnapshot;
            }
            
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
            // Show loading state
            this.showLoadingModal();

            // CRITICAL: Always fetch fresh data from Firebase to ensure we have latest state
            // Don't rely on cached this.admins as it might contain deleted admins
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
            }

            console.log('🔄 [Home] Fetching fresh data for inactive numbers modal...');
            const firebaseSnapshot = await db.collection('admins').get();
            
            // Update this.admins with fresh data
            const previousCount = this.admins.length;
            this.admins = firebaseSnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            
            console.log(`✅ [Home] Fresh data fetched: ${previousCount} → ${this.admins.length} admins`);
            
            // Create snapshot from fresh data
            const snapshot = {
                docs: this.admins.map(admin => ({
                    id: admin.id,
                    data: () => admin
                }))
            };
            
            // Process and filter admins
            const inactiveNumbers = this.filterInactiveNumbers(snapshot);
            
            console.log(`📋 [Home] Found ${inactiveNumbers.length} inactive admin(s) for modal`);
            
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
        const processedIds = new Set();

        console.log(`🔍 [Home] Filtering inactive numbers from ${snapshot.docs.length} admin(s)`);

        snapshot.docs.forEach(doc => {
            // CRITICAL: Ensure document has valid ID
            if (!doc || !doc.id) {
                console.warn(`⚠️ [Home] Skipping invalid document in filterInactiveNumbers`);
                return;
            }

            // CRITICAL: Skip if we've already processed this ID (duplicate check)
            if (processedIds.has(doc.id)) {
                console.warn(`⚠️ [Home] Skipping duplicate admin ID: ${doc.id}`);
                return;
            }
            processedIds.add(doc.id);

            const data = doc.data();
            
            // CRITICAL: Ensure data exists
            if (!data) {
                console.warn(`⚠️ [Home] Skipping admin ${doc.id} - no data`);
                return;
            }

            const alfaData = data.alfaData || {};

            // Filter: only show admins with status === 'inactive' (using helper function)
            const isInactive = this.isAdminInactive(data, alfaData);
            
            if (isInactive) {
                // Parse balance
                let balance = 0;
                if (alfaData.balance) {
                    const balanceStr = String(alfaData.balance).trim();
                    const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                    balance = match ? parseFloat(match[0]) : 0;
                }

                console.log(`📋 [Home] Found inactive admin: ${doc.id} (${data.name || 'N/A'})`);
                
                inactiveNumbers.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    balance: balance,
                    alfaData: alfaData
                });
            }
        });

        console.log(`✅ [Home] Filtered ${inactiveNumbers.length} inactive admin(s) from ${snapshot.docs.length} total`);
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

// Global instance for cleanup
let homeManagerInstance = null;

document.addEventListener('DOMContentLoaded', () => {
    homeManagerInstance = new HomeManager();
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (homeManagerInstance) {
        if (homeManagerInstance.unsubscribe) {
            homeManagerInstance.unsubscribe();
            console.log('🔄 [Home] Real-time listener unsubscribed');
        }
        if (homeManagerInstance.periodicRefreshInterval) {
            clearInterval(homeManagerInstance.periodicRefreshInterval);
            console.log('🔄 [Home] Periodic refresh cleared');
        }
    }
});
