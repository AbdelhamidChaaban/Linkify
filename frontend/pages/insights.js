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
                
                // Use refresh timestamp for lastUpdate (when user made the refresh)
                // If lastRefreshTimestamp exists, use it; otherwise fall back to updatedAt
                let lastUpdate = updatedAt;
                
                // Check if we have a manually updated lastUpdate that's more recent (from refresh)
                const existingSubscriber = this.subscribers.find(s => s.id === doc.id);
                if (existingSubscriber && existingSubscriber.lastUpdate instanceof Date) {
                    // If we have a manually set lastUpdate that's very recent (within last 5 seconds),
                    // keep it instead of overwriting with Firebase data (which might be stale)
                    const now = Date.now();
                    const existingTime = existingSubscriber.lastUpdate.getTime();
                    if (now - existingTime < 5000) { // Within last 5 seconds
                        lastUpdate = existingSubscriber.lastUpdate;
                        console.log('🔄 Keeping recent manual lastUpdate for:', doc.id, lastUpdate.toLocaleString());
                    }
                }
                
                if (data.lastRefreshTimestamp !== undefined && data.lastRefreshTimestamp !== null) {
                    // lastRefreshTimestamp is a number (milliseconds since epoch)
                    // Handle both number and string formats from Firebase
                    let timestamp = typeof data.lastRefreshTimestamp === 'number' 
                        ? data.lastRefreshTimestamp 
                        : parseFloat(data.lastRefreshTimestamp);
                    
                    // Check if timestamp is in seconds (less than year 2000 in milliseconds)
                    if (timestamp < 946684800000 && timestamp > 0) {
                        timestamp = timestamp * 1000; // Convert seconds to milliseconds
                    }
                    
                    if (!isNaN(timestamp) && timestamp > 0) {
                        const firebaseLastUpdate = new Date(timestamp);
                        
                        // Only use Firebase timestamp if it's newer than what we have
                        if (!lastUpdate || firebaseLastUpdate.getTime() > lastUpdate.getTime()) {
                            lastUpdate = firebaseLastUpdate;
                        }
                    }
                }
                
                // Get Alfa dashboard data if available
                const alfaData = data.alfaData || {};
                const hasAlfaData = alfaData && Object.keys(alfaData).length > 0 && !alfaData.error;
                
                // Determine status based on getconsumption API response
                // Check if "u-share" (case-insensitive) exists in the getconsumption response
                // The getconsumption response is stored in primaryData (from backend extraction)
                let status = 'inactive'; // Default to inactive
                
                if (hasAlfaData && alfaData.primaryData) {
                    try {
                        const apiData = alfaData.primaryData;
                        
                        // First, do a simple string search (most reliable)
                        const responseStr = JSON.stringify(apiData).toLowerCase();
                        if (responseStr.includes('u-share')) {
                            status = 'active';
                        } else {
                            // If string search didn't find it, try structure traversal
                            // Check in ServiceInformationValue structure
                            if (apiData.ServiceInformationValue && Array.isArray(apiData.ServiceInformationValue)) {
                                for (const service of apiData.ServiceInformationValue) {
                                    // Check ServiceNameValue at service level (e.g., "U-share Main")
                                    if (service.ServiceNameValue) {
                                        const serviceName = String(service.ServiceNameValue).toLowerCase();
                                        if (serviceName.includes('u-share')) {
                                            status = 'active';
                                            break;
                                        }
                                    }
                                    
                                    // Check BundleNameValue in SecondaryValue array
                                    if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                        for (const serviceDetails of service.ServiceDetailsInformationValue) {
                                            if (serviceDetails.SecondaryValue && Array.isArray(serviceDetails.SecondaryValue)) {
                                                for (const secondary of serviceDetails.SecondaryValue) {
                                                    if (secondary.BundleNameValue) {
                                                        const bundleName = String(secondary.BundleNameValue).toLowerCase();
                                                        if (bundleName.includes('u-share')) {
                                                            status = 'active';
                                                            break;
                                                        }
                                                    }
                                                }
                                                if (status === 'active') break;
                                            }
                                        }
                                        if (status === 'active') break;
                                    }
                                    
                                    if (status === 'active') break;
                                }
                            }
                        }
                    } catch (statusError) {
                        console.warn(`⚠️ Error checking status from primaryData for admin ${doc.id}:`, statusError);
                        // Fallback to string search if structure parsing fails
                        try {
                            const responseStr = JSON.stringify(alfaData.primaryData).toLowerCase();
                            if (responseStr.includes('u-share')) {
                                status = 'active';
                            }
                        } catch (e) {
                            console.warn(`⚠️ Error in fallback status check for admin ${doc.id}:`, e);
                        }
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
                            // Ignore errors in fallback
                        }
                    }
                }
                
                // Fallback to existing status logic if getconsumption response not found
                if (status === 'inactive' && data.status && data.status.toLowerCase().includes('active')) {
                    status = 'active';
                }
                
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
                
                // Try multiple sources for total consumption
                if (hasAlfaData) {
                    // Source 1: Direct alfaData.totalConsumption
                    // Check if the property exists (even if it's 0, null, or empty string)
                    if (alfaData.hasOwnProperty('totalConsumption')) {
                        try {
                            // Handle null, undefined, or empty string - treat as missing and use fallback
                            if (alfaData.totalConsumption === null || alfaData.totalConsumption === undefined || alfaData.totalConsumption === '') {
                                // Field exists but is empty/null - treat as if it doesn't exist, will use fallback extraction
                                console.log(`⚠️ [${doc.id}] totalConsumption exists but is empty/null, will use fallback extraction`);
                                // Don't set totalConsumption here, let it fall through to Source 2
                            } else if (typeof alfaData.totalConsumption === 'string') {
                                const parsed = parseConsumption(alfaData.totalConsumption);
                                totalConsumption = parsed.used;
                                totalLimit = parsed.total || totalLimit;
                                console.log(`✅ [${doc.id}] Extracted totalConsumption from string: "${alfaData.totalConsumption}" -> ${totalConsumption} / ${totalLimit}`);
                            } else if (typeof alfaData.totalConsumption === 'number') {
                                totalConsumption = alfaData.totalConsumption;
                                if (alfaData.totalLimit && typeof alfaData.totalLimit === 'number') {
                                    totalLimit = alfaData.totalLimit;
                                }
                                console.log(`✅ [${doc.id}] Extracted totalConsumption from number: ${totalConsumption} / ${totalLimit}`);
                            }
                        } catch (parseError) {
                            console.warn(`⚠️ Error parsing totalConsumption for admin ${doc.id}:`, parseError);
                            const numMatch = String(alfaData.totalConsumption).match(/[\d.]+/);
                            if (numMatch) {
                                totalConsumption = parseFloat(numMatch[0]) || 0;
                            }
                        }
                    } else if (alfaData.totalConsumption) {
                        // Fallback: old check for backwards compatibility
                        try {
                            if (typeof alfaData.totalConsumption === 'string') {
                                const parsed = parseConsumption(alfaData.totalConsumption);
                                totalConsumption = parsed.used;
                                totalLimit = parsed.total || totalLimit;
                                console.log(`✅ [${doc.id}] Extracted totalConsumption (fallback): "${alfaData.totalConsumption}" -> ${totalConsumption} / ${totalLimit}`);
                            } else if (typeof alfaData.totalConsumption === 'number') {
                                totalConsumption = alfaData.totalConsumption;
                                if (alfaData.totalLimit && typeof alfaData.totalLimit === 'number') {
                                    totalLimit = alfaData.totalLimit;
                                }
                                console.log(`✅ [${doc.id}] Extracted totalConsumption (fallback number): ${totalConsumption} / ${totalLimit}`);
                            }
                        } catch (parseError) {
                            console.warn(`⚠️ Error parsing totalConsumption for admin ${doc.id}:`, parseError);
                            const numMatch = String(alfaData.totalConsumption).match(/[\d.]+/);
                            if (numMatch) {
                                totalConsumption = parseFloat(numMatch[0]) || 0;
                            }
                        }
                    } else {
                        console.log(`⚠️ [${doc.id}] totalConsumption field does not exist in alfaData`);
                    }
                    
                    // Source 2: Extract from primaryData (raw API response) if not found
                    if (totalConsumption === 0 && alfaData.primaryData) {
                        try {
                            const primaryData = alfaData.primaryData;
                            
                            // First, try direct extraction from primaryData root level (for cases where structure is different)
                            if (!totalConsumption && primaryData.ConsumptionValue) {
                                let consumption = parseFloat(primaryData.ConsumptionValue) || 0;
                                const consumptionUnit = primaryData.ConsumptionUnitValue || '';
                                if (consumptionUnit === 'MB' && consumption > 0) {
                                    consumption = consumption / 1024;
                                }
                                totalConsumption = consumption;
                                
                                if (primaryData.QuotaValue) {
                                    const quotaStr = String(primaryData.QuotaValue).trim();
                                    const quotaMatch = quotaStr.match(/^([\d.]+)/);
                                    if (quotaMatch) {
                                        totalLimit = parseFloat(quotaMatch[1]) || totalLimit;
                                    }
                                }
                            }
                            
                            // Look for QuotaValue in ServiceInformationValue structure
                            if (primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue) && primaryData.ServiceInformationValue.length > 0) {
                                for (const service of primaryData.ServiceInformationValue) {
                                    if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                        for (const details of service.ServiceDetailsInformationValue) {
                                            // First, try to get total consumption from SecondaryValue (U-Share Total Bundle)
                                            if (details.SecondaryValue && Array.isArray(details.SecondaryValue)) {
                                                // Find U-Share Total Bundle
                                                const totalBundle = details.SecondaryValue.find(secondary => {
                                                    const bundleName = (secondary.BundleNameValue || '').toLowerCase();
                                                    return bundleName.includes('u-share total') || 
                                                           bundleName.includes('total bundle');
                                                }) || details.SecondaryValue[0]; // Fallback to first
                                                
                                                if (totalBundle) {
                                                    const quotaValue = totalBundle.QuotaValue || '';
                                                    const consumptionValue = totalBundle.ConsumptionValue || details.ConsumptionValue || '';
                                                    const consumptionUnit = totalBundle.ConsumptionUnitValue || details.ConsumptionUnitValue || '';
                                                    
                                                    if (quotaValue) {
                                                        const quotaStr = String(quotaValue).trim();
                                                        const quotaMatch = quotaStr.match(/^([\d.]+)/);
                                                        if (quotaMatch) {
                                                            totalLimit = parseFloat(quotaMatch[1]) || totalLimit;
                                                        }
                                                    }
                                                    
                                                    if (consumptionValue && !totalConsumption) {
                                                        let consumption = parseFloat(consumptionValue) || 0;
                                                        if (consumptionUnit === 'MB' && consumption > 0) {
                                                            consumption = consumption / 1024;
                                                        }
                                                        totalConsumption = consumption;
                                                    }
                                                }
                                            }
                                            
                                            // Fallback: Try to get from QuotaValue directly
                                            if (details.QuotaValue && !totalLimit) {
                                                const quotaStr = String(details.QuotaValue).trim();
                                                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                                                if (quotaMatch) {
                                                    totalLimit = parseFloat(quotaMatch[1]) || totalLimit;
                                                }
                                            }
                                            
                                            // Fallback: Try to get consumption from ConsumptionValue directly
                                            if (details.ConsumptionValue && !totalConsumption) {
                                                const consumptionValue = parseFloat(details.ConsumptionValue) || 0;
                                                const consumptionUnit = details.ConsumptionUnitValue || '';
                                                // Convert MB to GB if needed
                                                if (consumptionUnit === 'MB' && consumptionValue > 0) {
                                                    totalConsumption = consumptionValue / 1024;
                                                } else if (consumptionUnit === 'GB' || !consumptionUnit) {
                                                    totalConsumption = consumptionValue;
                                                }
                                            }
                                            
                                            // If we found both, break
                                            if (totalConsumption > 0 && totalLimit > 0) break;
                                        }
                                        if (totalConsumption > 0 && totalLimit > 0) break;
                                    }
                                }
                            }
                        } catch (primaryError) {
                            console.warn(`⚠️ Error extracting from primaryData for admin ${doc.id}:`, primaryError);
                        }
                    }
                    
                    // Source 3: Calculate from consumptions array if available
                    if (totalConsumption === 0 && alfaData.consumptions && Array.isArray(alfaData.consumptions) && alfaData.consumptions.length > 0) {
                        try {
                            // Sum all consumption circles
                            let sumConsumption = 0;
                            let sumLimit = 0;
                            for (const circle of alfaData.consumptions) {
                                if (circle.used) {
                                    const usedStr = String(circle.used).trim();
                                    const usedMatch = usedStr.match(/^([\d.]+)/);
                                    if (usedMatch) {
                                        sumConsumption += parseFloat(usedMatch[1]) || 0;
                                    }
                                }
                                if (circle.total) {
                                    const totalStr = String(circle.total).trim();
                                    const totalMatch = totalStr.match(/^([\d.]+)/);
                                    if (totalMatch) {
                                        sumLimit += parseFloat(totalMatch[1]) || 0;
                                    }
                                }
                            }
                            if (sumConsumption > 0) {
                                totalConsumption = sumConsumption;
                                if (sumLimit > 0) {
                                    totalLimit = sumLimit;
                                }
                            }
                        } catch (sumError) {
                            console.warn(`⚠️ Error summing consumptions for admin ${doc.id}:`, sumError);
                        }
                    }
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
                
                // Try to get admin consumption from alfaData.adminConsumption first (backend-built string like "17.11 / 15 GB")
                // Check if the property exists (even if it's 0, null, or empty string)
                if (hasAlfaData && alfaData.hasOwnProperty('adminConsumption')) {
                    try {
                        // Handle null, undefined, or empty string - treat as missing and use fallback
                        if (alfaData.adminConsumption === null || alfaData.adminConsumption === undefined || alfaData.adminConsumption === '') {
                            // Field exists but is empty/null - treat as if it doesn't exist, will use fallback extraction
                            console.log(`⚠️ [${doc.id}] adminConsumption exists but is empty/null, will use fallback extraction`);
                            // Don't set adminConsumption here, let it fall through to fallback extraction
                        } else if (typeof alfaData.adminConsumption === 'number') {
                            adminConsumption = alfaData.adminConsumption;
                            console.log(`✅ [${doc.id}] Extracted adminConsumption from number: ${adminConsumption}`);
                        } else if (typeof alfaData.adminConsumption === 'string') {
                            const adminConsumptionStr = alfaData.adminConsumption.trim();
                            // Parse "17.11 / 15 GB" format to extract the used value
                            const match = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*[\d.]+\s*(GB|MB)/i);
                            if (match) {
                                adminConsumption = parseFloat(match[1]) || 0;
                                console.log(`✅ [${doc.id}] Extracted adminConsumption from string: "${adminConsumptionStr}" -> ${adminConsumption}`);
                            } else {
                                // Try to extract just the number if format doesn't match
                                const numMatch = adminConsumptionStr.match(/^([\d.]+)/);
                                if (numMatch) {
                                    adminConsumption = parseFloat(numMatch[1]) || 0;
                                    console.log(`✅ [${doc.id}] Extracted adminConsumption (simple number): "${adminConsumptionStr}" -> ${adminConsumption}`);
                                }
                            }
                        }
                    } catch (parseError) {
                        console.warn(`⚠️ Error parsing adminConsumption for admin ${doc.id}:`, parseError);
                    }
                } else {
                    console.log(`⚠️ [${doc.id}] adminConsumption field does not exist in alfaData`);
                }
                
                // Fallback 1: Get the "used" value from the first consumption circle (U-Share Main)
                if (adminConsumption === 0 && hasAlfaData && alfaData.consumptions && Array.isArray(alfaData.consumptions) && alfaData.consumptions.length > 0) {
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
                
                // Fallback 2: Extract from primaryData (raw API response) if still not found
                if (adminConsumption === 0 && hasAlfaData && alfaData.primaryData) {
                    try {
                        const primaryData = alfaData.primaryData;
                        
                        // First, try direct extraction from primaryData root level (for cases where structure is different)
                        if (!adminConsumption && primaryData.ConsumptionValue) {
                            let consumption = parseFloat(primaryData.ConsumptionValue) || 0;
                            const consumptionUnit = primaryData.ConsumptionUnitValue || '';
                            if (consumptionUnit === 'MB' && consumption > 0) {
                                consumption = consumption / 1024;
                            }
                            adminConsumption = consumption;
                            
                            if (primaryData.PackageValue) {
                                const packageStr = String(primaryData.PackageValue).trim();
                                const packageMatch = packageStr.match(/^([\d.]+)/);
                                if (packageMatch) {
                                    adminLimit = parseFloat(packageMatch[1]) || adminLimit;
                                }
                            }
                        }
                        
                        // Look for ConsumptionValue and PackageValue in ServiceInformationValue structure
                        if (primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue) && primaryData.ServiceInformationValue.length > 0) {
                            for (const service of primaryData.ServiceInformationValue) {
                                if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                    for (const details of service.ServiceDetailsInformationValue) {
                                        // Admin consumption is ConsumptionValue (consumption) / PackageValue (limit)
                                        const consumptionValue = details.ConsumptionValue || '';
                                        const consumptionUnit = details.ConsumptionUnitValue || '';
                                        const packageValue = details.PackageValue || '';
                                        const packageUnit = details.PackageUnitValue || '';
                                        
                                        if (consumptionValue) {
                                            let consumption = parseFloat(consumptionValue) || 0;
                                            // Convert MB to GB if needed
                                            if (consumptionUnit === 'MB' && consumption > 0) {
                                                consumption = consumption / 1024;
                                            }
                                            adminConsumption = consumption;
                                            
                                            // Also update adminLimit if PackageValue is available
                                            if (packageValue) {
                                                const packageStr = String(packageValue).trim();
                                                const packageMatch = packageStr.match(/^([\d.]+)/);
                                                if (packageMatch) {
                                                    adminLimit = parseFloat(packageMatch[1]) || adminLimit;
                                                }
                                            }
                                            
                                            // Found it, break out
                                            if (adminConsumption > 0) break;
                                        }
                                    }
                                    if (adminConsumption > 0) break;
                                }
                            }
                        }
                    } catch (primaryError) {
                        console.warn(`⚠️ Error extracting adminConsumption from primaryData for admin ${doc.id}:`, primaryError);
                    }
                }
                
                // Fallback 3: Use totalConsumption if adminConsumption is still 0 and we have totalConsumption
                // This handles cases where admin consumption equals total consumption
                if (adminConsumption === 0 && totalConsumption > 0) {
                    adminConsumption = totalConsumption;
                }
                
                // Debug logging for ALL admins (not just missing data) to see what's happening
                if (hasAlfaData) {
                    const hasMissingData = (totalConsumption === 0 || adminConsumption === 0);
                    const logPrefix = hasMissingData ? '🔍' : '✅';
                    console.log(`${logPrefix} [${doc.id}] Consumption extraction summary:`, {
                        totalConsumption,
                        adminConsumption,
                        totalLimit,
                        adminLimit,
                        hasTotalConsumption: !!alfaData.totalConsumption,
                        hasAdminConsumption: !!alfaData.adminConsumption,
                        hasConsumptions: !!(alfaData.consumptions && alfaData.consumptions.length > 0),
                        hasPrimaryData: !!alfaData.primaryData,
                        consumptionsCount: alfaData.consumptions ? alfaData.consumptions.length : 0,
                        alfaDataKeys: Object.keys(alfaData || {}),
                        totalConsumptionValue: alfaData.totalConsumption,
                        adminConsumptionValue: alfaData.adminConsumption,
                        totalConsumptionType: typeof alfaData.totalConsumption,
                        adminConsumptionType: typeof alfaData.adminConsumption,
                        totalConsumptionExists: alfaData.hasOwnProperty('totalConsumption'),
                        adminConsumptionExists: alfaData.hasOwnProperty('adminConsumption'),
                        primaryDataKeys: alfaData.primaryData ? Object.keys(alfaData.primaryData) : null
                    });
                    
                    // Log the full alfaData structure for debugging (truncated)
                    if (alfaData.primaryData) {
                        console.log(`🔍 [${doc.id}] primaryData structure:`, {
                            hasServiceInformationValue: !!(alfaData.primaryData.ServiceInformationValue),
                            serviceInfoLength: alfaData.primaryData.ServiceInformationValue ? alfaData.primaryData.ServiceInformationValue.length : 0,
                            firstServiceKeys: alfaData.primaryData.ServiceInformationValue && alfaData.primaryData.ServiceInformationValue[0] 
                                ? Object.keys(alfaData.primaryData.ServiceInformationValue[0]) 
                                : null,
                            // Check for direct fields at root level
                            hasConsumptionValue: !!(alfaData.primaryData.ConsumptionValue),
                            hasQuotaValue: !!(alfaData.primaryData.QuotaValue),
                            hasPackageValue: !!(alfaData.primaryData.PackageValue),
                            primaryDataKeys: Object.keys(alfaData.primaryData || {}).slice(0, 10) // First 10 keys
                        });
                        
                        // If ServiceInformationValue is empty, log the full primaryData structure (truncated)
                        if (alfaData.primaryData.ServiceInformationValue && alfaData.primaryData.ServiceInformationValue.length === 0) {
                            console.warn(`⚠️ [${doc.id}] ServiceInformationValue is empty! Full primaryData keys:`, Object.keys(alfaData.primaryData));
                            // Try to find consumption data in any field
                            const allValues = JSON.stringify(alfaData.primaryData).substring(0, 500);
                            console.log(`⚠️ [${doc.id}] primaryData sample (first 500 chars):`, allValues);
                        }
                    }
                }
                
                // Extract balance (format: "$ 3.05" or "$ -0.29")
                let balance = 0;
                if (hasAlfaData && alfaData.balance) {
                    balance = parseBalance(alfaData.balance);
                }
                
                // Extract subscribers count
                let subscribersCount = hasAlfaData && alfaData.subscribersCount !== undefined 
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
                
                // Check if validity date is yesterday or earlier (expired)
                // If expired, set total consumption and admin consumption to 0, and limits to 0
                const isExpired = this.isValidityDateExpired(validityDate);
                if (isExpired) {
                    totalConsumption = 0;
                    totalLimit = 0;
                    adminConsumption = 0;
                    adminLimit = 0;
                }
                
                // If admin is inactive, set consumption and date fields to empty
                // IMPORTANT: Only set to empty if status is strictly 'inactive'
                if (status === 'inactive') {
                    totalConsumption = 0;
                    totalLimit = 0;
                    subscriptionDate = '';
                    validityDate = '';
                    subscribersCount = 0;
                    adminConsumption = 0;
                    adminLimit = 0;
                }
                // For active admins, keep all original values (even if they're 0 or empty from data source)
                
                return {
                    id: doc.id,
                    name: data.name || 'Unknown',
                    phone: data.phone || '',
                    type: type,
                    status: status,
                    totalConsumption: totalConsumption,
                    totalLimit: isExpired ? 0 : (totalLimit || 1), // If expired, set to 0; otherwise avoid division by zero
                    subscriptionDate: subscriptionDate,
                    validityDate: validityDate,
                    subscribersCount: subscribersCount,
                    adminConsumption: adminConsumption,
                    adminLimit: isExpired ? 0 : (adminLimit || 1), // If expired, set to 0; otherwise avoid division by zero
                    balance: balance,
                    expiration: expiration,
                    lastUpdate: lastUpdate,
                    createdAt: createdAt,
                    alfaData: alfaData, // Store full alfaData for View Details modal
                    quota: data.quota, // Store quota for admin limit
                    notUShare: data.notUShare === true // Store notUShare flag
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
                this.openAddSubscribersModal();
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
            } else if (this.activeTab === 'notUShare') {
                // Show only admins with notUShare flag set to true
                if (!sub.notUShare || sub.notUShare !== true) {
                    return false;
                }
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
        const notUShareCount = this.subscribers.filter(s => s.notUShare === true).length;
        
        document.getElementById('countAll').textContent = allCount;
        document.getElementById('countActive').textContent = activeCount;
        document.getElementById('countInactive').textContent = inactiveCount;
        const notUShareElement = document.getElementById('countNotUShare');
        if (notUShareElement) {
            notUShareElement.textContent = notUShareCount;
        }
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
        // Fallback: If consumption values are 0 or missing, try to extract from alfaData.primaryData
        // This handles cases where extraction in processSubscribers didn't work but View Details can extract it
        let totalConsumption = subscriber.totalConsumption || 0;
        let totalLimit = subscriber.totalLimit || 0;
        let adminConsumption = subscriber.adminConsumption || 0;
        // Admin limit should always be the quota set when creating the admin (not from API)
        // Use subscriber.quota as the source of truth for admin limit
        // Parse quota if it's a string (e.g., "15 GB" or "15")
        let adminLimit = 0;
        if (subscriber.quota) {
            const quotaStr = String(subscriber.quota).trim();
            const quotaMatch = quotaStr.match(/^([\d.]+)/);
            adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
        } else if (subscriber.adminLimit) {
            adminLimit = subscriber.adminLimit;
        }
        
        // If values are missing, try to extract from primaryData (same logic as View Details)
        if ((totalConsumption === 0 || adminConsumption === 0) && subscriber.alfaData && subscriber.alfaData.primaryData) {
            try {
                const primaryData = subscriber.alfaData.primaryData;
                
                // Extract total consumption from primaryData if missing
                if (totalConsumption === 0 && primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue) && primaryData.ServiceInformationValue.length > 0) {
                    for (const service of primaryData.ServiceInformationValue) {
                        if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                            for (const details of service.ServiceDetailsInformationValue) {
                                if (details.SecondaryValue && Array.isArray(details.SecondaryValue)) {
                                    const totalBundle = details.SecondaryValue.find(secondary => {
                                        const bundleName = (secondary.BundleNameValue || '').toLowerCase();
                                        return bundleName.includes('u-share total') || bundleName.includes('total bundle');
                                    }) || details.SecondaryValue[0];
                                    
                                    if (totalBundle) {
                                        const quotaValue = totalBundle.QuotaValue || '';
                                        const consumptionValue = totalBundle.ConsumptionValue || details.ConsumptionValue || '';
                                        const consumptionUnit = totalBundle.ConsumptionUnitValue || details.ConsumptionUnitValue || '';
                                        
                                        if (quotaValue) {
                                            const quotaStr = String(quotaValue).trim();
                                            const quotaMatch = quotaStr.match(/^([\d.]+)/);
                                            if (quotaMatch) {
                                                totalLimit = parseFloat(quotaMatch[1]) || totalLimit;
                                            }
                                        }
                                        
                                        if (consumptionValue && totalConsumption === 0) {
                                            let consumption = parseFloat(consumptionValue) || 0;
                                            if (consumptionUnit === 'MB' && consumption > 0) {
                                                consumption = consumption / 1024;
                                            }
                                            totalConsumption = consumption;
                                        }
                                    }
                                }
                                
                                // Extract admin consumption if missing
                                if (adminConsumption === 0) {
                                    const consumptionValue = details.ConsumptionValue || '';
                                    const consumptionUnit = details.ConsumptionUnitValue || '';
                                    
                                    if (consumptionValue) {
                                        let consumption = parseFloat(consumptionValue) || 0;
                                        if (consumptionUnit === 'MB' && consumption > 0) {
                                            consumption = consumption / 1024;
                                        }
                                        adminConsumption = consumption;
                                        
                                        // Don't update adminLimit from PackageValue - use subscriber.quota instead
                                        // adminLimit should always be the quota set when creating the admin
                                    }
                                }
                                
                                if (totalConsumption > 0 && adminConsumption > 0) break;
                            }
                            if (totalConsumption > 0 && adminConsumption > 0) break;
                        }
                    }
                }
            } catch (extractError) {
                console.warn(`⚠️ Error extracting consumption in renderRow for ${subscriber.id}:`, extractError);
            }
        }
        
        // Check if admin consumption >= admin limit (e.g., 77/22 GB means total bundle is fully used)
        // When admin consumption exceeds or equals admin limit, it means the total bundle is fully consumed
        // Ensure values are numbers before comparison (handle null/undefined)
        const safeTotalConsumption = (totalConsumption != null && !isNaN(totalConsumption)) ? totalConsumption : 0;
        const safeTotalLimit = (totalLimit != null && !isNaN(totalLimit)) ? totalLimit : 0;
        const safeAdminConsumption = (adminConsumption != null && !isNaN(adminConsumption)) ? adminConsumption : 0;
        const safeAdminLimit = (adminLimit != null && !isNaN(adminLimit)) ? adminLimit : 0;
        
        const isAdminFull = safeAdminLimit > 0 && safeAdminConsumption >= safeAdminLimit - 0.01;
        
        // Check if total consumption is fully used (>= totalLimit)
        const isTotalFull = safeTotalLimit > 0 && safeTotalConsumption >= safeTotalLimit - 0.01;
        
        // If admin consumption is full (e.g., 77/22), treat total bundle as fully used
        const bundleIsFullyUsed = isAdminFull || isTotalFull;
        
        const totalPercent = safeTotalLimit > 0 ? (safeTotalConsumption / safeTotalLimit) * 100 : 0;
        
        // When bundle is fully used (admin consumption >= admin limit, e.g., 77/22):
        // - adminConsumption (77) represents the total bundle size
        // - Show total consumption as adminConsumption/adminConsumption (77/77)
        // - Show admin consumption as 0/adminLimit (0/22)
        let displayTotalConsumption = safeTotalConsumption;
        let displayTotalLimit = safeTotalLimit;
        
        if (bundleIsFullyUsed && safeAdminConsumption > 0) {
            // When admin consumption is full, use adminConsumption as the total bundle size
            displayTotalConsumption = safeAdminConsumption;
            displayTotalLimit = safeAdminConsumption;
        }
        
        const displayAdminConsumption = bundleIsFullyUsed ? 0 : safeAdminConsumption;
        const adminPercent = bundleIsFullyUsed ? 0 : (safeAdminLimit > 0 ? (safeAdminConsumption / safeAdminLimit) * 100 : 0);
        
        // Calculate total percent for progress bar
        const displayTotalPercent = displayTotalLimit > 0 ? (displayTotalConsumption / displayTotalLimit) * 100 : 0;
        const totalProgressWidth = bundleIsFullyUsed ? 100 : Math.min(displayTotalPercent, 100);
        
        let progressClass = 'progress-fill';
        if (bundleIsFullyUsed || totalPercent >= 100) {
            progressClass += ' error';
        } else if (totalPercent >= 90) {
            progressClass += ' error';
        } else if (totalPercent >= 70) {
            progressClass += ' warning';
        }
        
        let adminProgressClass = 'progress-fill';
        if (bundleIsFullyUsed) {
            // When bundle is fully used, admin consumption should show 0% (no error class needed)
            adminProgressClass = 'progress-fill';
        } else {
            if (adminPercent >= 100) adminProgressClass += ' error';
            else if (adminPercent >= 90) adminProgressClass += ' error';
            else if (adminPercent >= 70) adminProgressClass += ' warning';
        }
        
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
                    ${subscriber.status === 'inactive' ? '' : `
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="${progressClass}" style="width: ${totalProgressWidth}%"></div>
                        </div>
                        <div class="progress-text">${displayTotalConsumption.toFixed(2)} / ${displayTotalLimit.toFixed(2)} GB</div>
                    </div>
                    `}
                </td>
                <td>${subscriber.status === 'inactive' ? '' : (subscriber.subscriptionDate || '')}</td>
                <td>${subscriber.status === 'inactive' ? '' : (subscriber.validityDate || '')}</td>
                <td>${subscriber.status === 'inactive' ? '' : (subscriber.subscribersCount !== undefined ? subscriber.subscribersCount : '')}</td>
                <td>
                    ${subscriber.status === 'inactive' ? '' : `
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="${adminProgressClass}" style="width: ${adminPercent}%"></div>
                        </div>
                        <div class="progress-text">${displayAdminConsumption.toFixed(2)} / ${safeAdminLimit.toFixed(2)} GB</div>
                    </div>
                    `}
                </td>
                <td>$${((subscriber.balance != null && !isNaN(subscriber.balance)) ? subscriber.balance : 0).toFixed(2)}</td>
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
        
        // DEBUG: Log the full subscriber data to see what's available
        console.log('🔍 Full subscriber data:', subscriber);
        console.log('🔍 alfaData:', subscriber.alfaData);
        if (subscriber.alfaData) {
            console.log('🔍 alfaData keys:', Object.keys(subscriber.alfaData));
            console.log('🔍 secondarySubscribers:', subscriber.alfaData.secondarySubscribers);
            console.log('🔍 consumptions:', subscriber.alfaData.consumptions);
        }
        
        // Extract view details data
        const viewData = this.extractViewDetailsData(subscriber);
        
        // DEBUG: Log extracted view data
        console.log('🔍 Extracted view data:', viewData);
        console.log('🔍 Subscribers count:', viewData.subscribers.length);
        
        // Show modal
        this.showViewDetailsModal(viewData);
    }
    
    extractViewDetailsData(subscriber) {
        // Admin limit should always be the quota set when creating the admin (not from API)
        // Parse quota if it's a string (e.g., "15 GB" or "15")
        let adminLimit = 0;
        if (subscriber.quota) {
            const quotaStr = String(subscriber.quota).trim();
            const quotaMatch = quotaStr.match(/^([\d.]+)/);
            adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
        } else if (subscriber.adminLimit) {
            adminLimit = subscriber.adminLimit;
        }
        
        const data = {
            adminPhone: subscriber.phone,
            adminConsumption: subscriber.adminConsumption || 0,
            adminLimit: adminLimit, // Use quota, not API limit
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
        
        // Fallback: Extract admin consumption from primaryData if subscriber.adminConsumption is 0
        if (data.adminConsumption === 0 && subscriber.alfaData && subscriber.alfaData.primaryData) {
            try {
                const primaryData = subscriber.alfaData.primaryData;
                
                // Try direct extraction from root level
                if (primaryData.ConsumptionValue) {
                    let consumption = parseFloat(primaryData.ConsumptionValue) || 0;
                    const consumptionUnit = primaryData.ConsumptionUnitValue || '';
                    if (consumptionUnit === 'MB' && consumption > 0) {
                        consumption = consumption / 1024;
                    }
                    data.adminConsumption = consumption;
                    
                    // Don't update adminLimit from PackageValue - use subscriber.quota instead
                    // adminLimit should always be the quota set when creating the admin
                }
                
                // Try extraction from ServiceInformationValue structure (even if empty array, check structure)
                if (data.adminConsumption === 0 && primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue)) {
                    for (const service of primaryData.ServiceInformationValue) {
                        if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                            for (const details of service.ServiceDetailsInformationValue) {
                                const consumptionValue = details.ConsumptionValue || '';
                                const consumptionUnit = details.ConsumptionUnitValue || '';
                                
                                if (consumptionValue) {
                                    let consumption = parseFloat(consumptionValue) || 0;
                                    if (consumptionUnit === 'MB' && consumption > 0) {
                                        consumption = consumption / 1024;
                                    }
                                    data.adminConsumption = consumption;
                                    
                                    // Don't update adminLimit from PackageValue - use subscriber.quota instead
                                    // adminLimit should always be the quota set when creating the admin
                                    
                                    if (data.adminConsumption > 0) break;
                                }
                            }
                            if (data.adminConsumption > 0) break;
                        }
                    }
                }
            } catch (extractError) {
                console.warn('⚠️ Error extracting admin consumption in View Details:', extractError);
            }
        }
        
        // PRIORITY 1: Get subscriber data from secondarySubscribers array (from getconsumption API - most reliable)
        if (subscriber.alfaData && subscriber.alfaData.secondarySubscribers && Array.isArray(subscriber.alfaData.secondarySubscribers) && subscriber.alfaData.secondarySubscribers.length > 0) {
            console.log('📊 Using secondarySubscribers from API:', subscriber.alfaData.secondarySubscribers.length, 'subscribers');
            subscriber.alfaData.secondarySubscribers.forEach(secondary => {
                if (secondary && secondary.phoneNumber) {
                    // Parse consumption string (format: "1.18 / 30 GB" or "1.18/30 GB")
                    const consumptionStr = secondary.consumption || '';
                    let used = 0;
                    let total = 0;
                    
                    // Try to parse from consumption string first
                    if (consumptionStr) {
                        const consumptionMatch = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                        if (consumptionMatch) {
                            used = parseFloat(consumptionMatch[1]) || 0;
                            total = parseFloat(consumptionMatch[2]) || 0;
                        }
                    }
                    
                    // Fallback: use raw values if consumption string parsing failed
                    if ((used === 0 && total === 0) && secondary.rawConsumption && secondary.quota) {
                        used = parseFloat(secondary.rawConsumption) || 0;
                        total = parseFloat(secondary.quota) || 0;
                        
                        // Convert MB to GB if needed
                        if (secondary.rawConsumptionUnit === 'MB' && secondary.quotaUnit === 'GB') {
                            used = used / 1024;
                        }
                    }
                    
                    if (used > 0 || total > 0) {
                        data.subscribers.push({
                            phoneNumber: secondary.phoneNumber,
                            consumption: used,
                            limit: total
                        });
                        console.log(`✅ Added subscriber from API: ${secondary.phoneNumber} - ${used} / ${total} GB`);
                    }
                }
            });
        }
        
        // PRIORITY 1.5: Try to extract from apiResponses if secondarySubscribers not available
        if (data.subscribers.length === 0 && subscriber.alfaData && subscriber.alfaData.apiResponses && Array.isArray(subscriber.alfaData.apiResponses)) {
            console.log('📊 Trying to extract from apiResponses array...');
            const getConsumptionResponse = subscriber.alfaData.apiResponses.find(resp => resp.url && resp.url.includes('getconsumption'));
            if (getConsumptionResponse && getConsumptionResponse.data) {
                console.log('📊 Found getconsumption in apiResponses, extracting...');
                try {
                    // Extract from ServiceInformationValue structure (same as backend)
                    const apiData = getConsumptionResponse.data;
                    if (apiData.ServiceInformationValue && Array.isArray(apiData.ServiceInformationValue) && apiData.ServiceInformationValue.length > 0) {
                        const firstService = apiData.ServiceInformationValue[0];
                        if (firstService.ServiceDetailsInformationValue && Array.isArray(firstService.ServiceDetailsInformationValue) && firstService.ServiceDetailsInformationValue.length > 0) {
                            const firstServiceDetails = firstService.ServiceDetailsInformationValue[0];
                            if (firstServiceDetails.SecondaryValue && Array.isArray(firstServiceDetails.SecondaryValue)) {
                                firstServiceDetails.SecondaryValue.forEach((secondary) => {
                                    if (secondary.BundleNameValue && secondary.BundleNameValue.includes('U-share secondary')) {
                                        const secondaryNumber = secondary.SecondaryNumberValue || '';
                                        let consumptionValue = secondary.ConsumptionValue || '';
                                        let consumptionUnit = secondary.ConsumptionUnitValue || '';
                                        let quotaValue = secondary.QuotaValue || '';
                                        let quotaUnit = secondary.QuotaUnitValue || '';
                                        
                                        if (secondaryNumber) {
                                            // Convert MB to GB if needed
                                            let displayConsumption = consumptionValue;
                                            if (consumptionUnit === 'MB' && quotaUnit === 'GB') {
                                                displayConsumption = (parseFloat(consumptionValue) / 1024).toFixed(2);
                                            }
                                            
                                            const used = parseFloat(displayConsumption) || 0;
                                            const total = parseFloat(quotaValue) || 0;
                                            
                                            if (used > 0 || total > 0) {
                                                data.subscribers.push({
                                                    phoneNumber: secondaryNumber,
                                                    consumption: used,
                                                    limit: total
                                                });
                                                console.log(`✅ Added subscriber from apiResponses: ${secondaryNumber} - ${used} / ${total} GB`);
                                            }
                                        }
                                    }
                                });
                            }
                        }
                    }
                } catch (extractError) {
                    console.warn('⚠️ Error extracting from apiResponses:', extractError.message);
                }
            }
        }
        
        // PRIORITY 2: Fallback to consumption circles from HTML (if secondarySubscribers not available)
        if (data.subscribers.length === 0 && subscriber.alfaData && subscriber.alfaData.consumptions && Array.isArray(subscriber.alfaData.consumptions)) {
            console.log('📊 Using consumption circles from HTML:', subscriber.alfaData.consumptions.length, 'circles');
            subscriber.alfaData.consumptions.forEach(circle => {
                // Check if this is a U-share secondary circle
                if (circle && circle.planName && circle.planName.toLowerCase().includes('u-share secondary')) {
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
                        console.log(`✅ Added subscriber from HTML: ${phoneNumber} - ${used} / ${total} GB`);
                    }
                }
            });
        }
        
        // Log final result
        if (data.subscribers.length === 0) {
            console.warn('⚠️ No subscribers found in alfaData. Available keys:', subscriber.alfaData ? Object.keys(subscriber.alfaData) : 'no alfaData');
        } else {
            console.log(`✅ Total subscribers found: ${data.subscribers.length}`);
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
                <div class="view-details-modal-inner">
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
        // Capture the refresh timestamp when user initiates the refresh (client-side time)
        const refreshInitiatedAt = Date.now();
        console.log('🔄 Refresh initiated at:', new Date(refreshInitiatedAt).toLocaleString(), 'timestamp:', refreshInitiatedAt);
        
        try {
            console.log('Refreshing subscriber:', id);
            
            // Find the subscriber in our data
            const subscriber = this.subscribers.find(s => s.id === id);
            if (!subscriber) {
                console.error('Subscriber not found:', id);
                return;
            }
            
            // Get admin data from Firestore to get phone and password
            // Use subscriber phone if available, but we need password from Firestore
            const phone = subscriber.phone || '';
            
            if (!phone) {
                console.error('Phone not found for subscriber:', id);
                alert('Cannot refresh: Phone number not found');
                return;
            }
            
            // Try to get password from Firestore
            // First check if we have it cached in the subscriber object
            let password = subscriber.password || null;
            
            // If not in subscriber object, try to get from Firestore with improved error handling
            if (!password) {
                try {
                    // Use a shorter timeout and better error handling
                    const waitForOnline = () => {
                        return new Promise((resolve, reject) => {
                            // Reduced timeout to 3 seconds
                            const timeout = setTimeout(() => {
                                reject(new Error('Firestore request timed out. Trying to use cached data...'));
                            }, 3000);
                            
                            // Try to get document
                            const docRef = db.collection('admins').doc(id);
                            
                            // Use get() with timeout
                            docRef.get()
                                .then((doc) => {
                                    clearTimeout(timeout);
                                    resolve(doc);
                                })
                                .catch((error) => {
                                    clearTimeout(timeout);
                                    reject(error);
                                });
                        });
                    };
                    
                    const adminDoc = await waitForOnline();
                    
                    if (adminDoc.exists) {
                    const adminData = adminDoc.data();
                    password = adminData.password;
                    
                    // Cache password in subscriber object and localStorage for next time
                    if (password) {
                        subscriber.password = password;
                        // Also cache in localStorage as backup
                        try {
                            localStorage.setItem(`admin_${id}`, JSON.stringify({
                                password: password,
                                phone: phone,
                                cachedAt: Date.now()
                            }));
                        } catch (e) {
                            console.warn('Could not cache to localStorage:', e);
                        }
                    }
                    } else {
                        console.warn('Admin document not found in Firestore:', id);
                    }
                } catch (firestoreError) {
                    console.warn('⚠️ Firestore fetch failed (will try to continue):', firestoreError.message);
                    
                    // Try to get password from cache/localStorage as fallback
                    try {
                        const cachedAdmin = localStorage.getItem(`admin_${id}`);
                        if (cachedAdmin) {
                            const adminData = JSON.parse(cachedAdmin);
                            if (adminData.password) {
                                password = adminData.password;
                                console.log('✅ Using cached password from localStorage');
                            }
                        }
                    } catch (cacheError) {
                        console.warn('Could not read from cache:', cacheError);
                    }
                    
                    // If still no password, show error but don't block - let user know
                    if (!password) {
                        const errorMsg = firestoreError.message || 'Cannot connect to Firestore';
                        const userChoice = confirm(
                            `Cannot get password from Firestore: ${errorMsg}\n\n` +
                            `Would you like to:\n` +
                            `- Click OK to try refreshing anyway (if password is cached)\n` +
                            `- Click Cancel to abort`
                        );
                        
                        if (!userChoice) {
                            // Remove any loading indicators
                            const checkbox = document.querySelector(`.row-checkbox[data-subscriber-id="${id}"]`);
                            const row = checkbox ? checkbox.closest('tr') : null;
                            if (row) {
                                row.classList.remove('refreshing', 'refresh-success');
                                const loadingIndicator = row.querySelector('.refresh-loading');
                                const successIndicator = row.querySelector('.refresh-success');
                                if (loadingIndicator) loadingIndicator.remove();
                                if (successIndicator) successIndicator.remove();
                            }
                            return;
                        }
                    }
                }
            }
            
            if (!password) {
                console.error('Password not found for admin:', id);
                alert('Cannot refresh: Password not found.\n\nPlease ensure:\n1. You are connected to the internet\n2. The admin account exists in Firestore\n3. The password is stored in the admin document');
                
                // Remove any loading indicators
                const checkbox2 = document.querySelector(`.row-checkbox[data-subscriber-id="${id}"]`);
                const row2 = checkbox2 ? checkbox2.closest('tr') : null;
                if (row2) {
                    row2.classList.remove('refreshing', 'refresh-success');
                    const loadingIndicator = row2.querySelector('.refresh-loading');
                    const successIndicator = row2.querySelector('.refresh-success');
                    if (loadingIndicator) loadingIndicator.remove();
                    if (successIndicator) successIndicator.remove();
                }
                return;
            }
            
            // Check if AlfaAPIService is available
            if (typeof window.AlfaAPIService === 'undefined' || !window.AlfaAPIService) {
                alert('Backend service not available. Please make sure the server is running and alfa-api.js is loaded.');
                
                // Remove any loading indicators
                const checkbox3 = document.querySelector(`.row-checkbox[data-subscriber-id="${id}"]`);
                const row3 = checkbox3 ? checkbox3.closest('tr') : null;
                if (row3) {
                    row3.classList.remove('refreshing', 'refresh-success');
                    const loadingIndicator = row3.querySelector('.refresh-loading');
                    const successIndicator = row3.querySelector('.refresh-success');
                    if (loadingIndicator) loadingIndicator.remove();
                    if (successIndicator) successIndicator.remove();
                }
                return;
            }
            
            // Show animated loading indicator
            // Find row by finding checkbox or button with data-subscriber-id, then get parent tr
            const checkbox = document.querySelector(`.row-checkbox[data-subscriber-id="${id}"]`);
            const button = document.querySelector(`button[data-subscriber-id="${id}"]`);
            const row = checkbox ? checkbox.closest('tr') : (button ? button.closest('tr') : null);
            let loadingIndicator = null;
            let successIndicator = null;
            
            if (row) {
                // Add refreshing class for animation
                row.classList.add('refreshing');
                
                // Remove any existing indicators
                const existingLoading = row.querySelector('.refresh-loading');
                const existingSuccess = row.querySelector('.refresh-success');
                if (existingLoading) existingLoading.remove();
                if (existingSuccess) existingSuccess.remove();
                
                // Ensure row has relative positioning for absolute child positioning
                row.style.position = 'relative';
                
                // Create and add 3D rotating loader
                loadingIndicator = document.createElement('div');
                loadingIndicator.className = 'refresh-loading';
                loadingIndicator.innerHTML = `
                    <div class="loader">
                        <div class="inner one"></div>
                        <div class="inner two"></div>
                        <div class="inner three"></div>
                    </div>
                `;
                row.appendChild(loadingIndicator);
                console.log('✅ 3D loader added to row');
            } else {
                console.warn('⚠️ Row not found for subscriber:', id);
            }
            
            // Fetch Alfa data from backend
            console.log('📡 Calling backend API with phone:', phone, 'adminId:', id);
            const response = await window.AlfaAPIService.fetchDashboardData(phone, password, id);
            
            // Debug: Log the response structure
            console.log('📦 API Response structure:', {
                hasData: !!response.data,
                responseKeys: response ? Object.keys(response) : null,
                dataKeys: response.data ? Object.keys(response.data) : null,
                hasNestedData: !!(response.data && response.data.data),
                nestedDataKeys: (response.data && response.data.data) ? Object.keys(response.data.data) : null,
                hasTotalConsumption: !!(response.data && (response.data.totalConsumption || (response.data.data && response.data.data.totalConsumption))),
                hasAdminConsumption: !!(response.data && (response.data.adminConsumption || (response.data.data && response.data.data.adminConsumption))),
                hasPrimaryData: !!(response.data && (response.data.primaryData || (response.data.data && response.data.data.primaryData)))
            });
            
            // Extract alfaData - handle both nested and flat structures
            // Backend returns: { success: true, data: { data: dashboardData, ... } }
            // So we need to check if response.data.data exists (nested) or use response.data directly (flat)
            const alfaData = (response.data && response.data.data) ? response.data.data : response.data;
            
            // Additional debug after extraction
            console.log('📦 Extracted alfaData structure:', {
                hasTotalConsumption: !!alfaData.totalConsumption,
                hasAdminConsumption: !!alfaData.adminConsumption,
                hasPrimaryData: !!alfaData.primaryData,
                hasConsumptions: !!(alfaData.consumptions && alfaData.consumptions.length > 0),
                alfaDataKeys: Object.keys(alfaData || {}),
                totalConsumptionValue: alfaData.totalConsumption,
                adminConsumptionValue: alfaData.adminConsumption
            });
            
            // Validate that we have consumption data before saving
            if (!alfaData.totalConsumption && !alfaData.adminConsumption && !alfaData.primaryData) {
                console.error(`❌ [${id}] No consumption data found in API response!`, {
                    alfaDataKeys: Object.keys(alfaData || {}),
                    fullResponse: response
                });
                // Don't throw - allow the save to proceed, but log the issue
                // The frontend extraction logic will try to extract from primaryData if available
            }
            
            // Use the client-side timestamp when refresh was initiated (when user clicked refresh)
            // This ensures the time matches exactly when the user made the refresh
            const refreshTimestamp = refreshInitiatedAt;
            
            // Debug: Log the timestamp we're about to store
            console.log('🕐 Storing refresh timestamp:', {
                clientTime: refreshInitiatedAt,
                serverTime: response.timestamp,
                currentTime: Date.now(),
                date: new Date(refreshTimestamp).toISOString(),
                local: new Date(refreshTimestamp).toLocaleString()
            });
            
            // Update admin document with new Alfa data
            // Use set with merge to handle offline mode better
            try {
                console.log('💾 Saving to Firebase:', {
                    adminId: id,
                    lastRefreshTimestamp: refreshTimestamp,
                    timestampDate: new Date(refreshTimestamp).toLocaleString(),
                    hasTotalConsumption: !!alfaData.totalConsumption,
                    hasAdminConsumption: !!alfaData.adminConsumption,
                    hasPrimaryData: !!alfaData.primaryData,
                    alfaDataKeys: Object.keys(alfaData || {})
                });
                
                await db.collection('admins').doc(id).set({
                    alfaData: alfaData,
                    alfaDataFetchedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    lastRefreshTimestamp: refreshTimestamp // Store the client-side refresh timestamp (milliseconds)
                }, { merge: true });
                
                console.log('✅ Successfully saved lastRefreshTimestamp to Firebase');
                
                // Immediately update the subscriber in our local data - don't wait for Firebase
                const subscriberIndex = this.subscribers.findIndex(s => s.id === id);
                if (subscriberIndex !== -1) {
                    // Create new Date object from the refresh timestamp
                    const newLastUpdate = new Date(refreshTimestamp);
                    
                    // Store the old value for comparison
                    const oldLastUpdate = this.subscribers[subscriberIndex].lastUpdate;
                    
                    // Update both subscribers arrays
                    this.subscribers[subscriberIndex].lastUpdate = newLastUpdate;
                    
                    const filteredIndex = this.filteredSubscribers.findIndex(s => s.id === id);
                    if (filteredIndex !== -1) {
                        this.filteredSubscribers[filteredIndex].lastUpdate = newLastUpdate;
                    }
                    
                    console.log('🔄 UPDATING lastUpdate:', {
                        subscriberId: id,
                        refreshTimestamp: refreshTimestamp,
                        newDate: newLastUpdate.toISOString(),
                        newLocal: newLastUpdate.toLocaleString(),
                        oldLocal: oldLastUpdate instanceof Date ? oldLastUpdate.toLocaleString() : 'N/A'
                    });
                    
                    // Re-render immediately
                    this.renderTable();
                    
                    // Verify it was updated
                    const verifyUpdate = this.subscribers.find(s => s.id === id);
                    console.log('✅ VERIFIED update:', {
                        subscriberId: id,
                        lastUpdate: verifyUpdate?.lastUpdate instanceof Date ? verifyUpdate.lastUpdate.toLocaleString() : verifyUpdate?.lastUpdate,
                        formatted: this.formatDateTime(verifyUpdate?.lastUpdate)
                    });
                }
            } catch (updateError) {
                // If update fails, log but don't fail the whole operation
                console.warn('Failed to update Firestore (may be offline):', updateError);
                // The data was fetched successfully, so we can still show it
            }
            
            console.log('Alfa data refreshed successfully');
            
            // Wait a bit for Firebase real-time listener to update the UI
            // This ensures the loader stays visible until data actually appears
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Show success animation
            if (row) {
                // Remove loading indicator
                if (loadingIndicator) {
                    loadingIndicator.remove();
                }
                
                // Remove refreshing class
                row.classList.remove('refreshing');
                
                // Add success class and indicator
                row.classList.add('refresh-success');
                
                // Create and add success checkmark
                successIndicator = document.createElement('div');
                successIndicator.className = 'refresh-success';
                successIndicator.innerHTML = `
                    <svg viewBox="0 0 24 24">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                `;
                row.appendChild(successIndicator);
                
                // Remove success indicator after animation completes
                setTimeout(() => {
                    if (successIndicator) {
                        successIndicator.remove();
                    }
                    row.classList.remove('refresh-success');
                }, 2000); // Keep success animation for 2 seconds
            }
            
        } catch (error) {
            console.error('Error refreshing subscriber:', error);
            console.error('Error type:', typeof error);
            console.error('Error message:', error?.message);
            console.error('Error name:', error?.name);
            console.error('Error stack:', error?.stack);
            console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            
            // Show more detailed error message
            let errorMessage = error?.message || error?.toString() || 'Unknown error occurred';
            
            if (error?.details) {
                console.error('Backend error details:', error.details);
                errorMessage += '\n\nCheck the backend console for more details.';
            }
            
            // If error message is empty, provide a default
            if (!errorMessage || errorMessage.trim() === '') {
                errorMessage = 'An error occurred. Please check the backend console (where you ran "node server.js") for details.';
            }
            
            alert('Failed to refresh data: ' + errorMessage);
            
            // Remove loading indicators and restore row
            const errorCheckbox = document.querySelector(`.row-checkbox[data-subscriber-id="${id}"]`);
            const errorRow = errorCheckbox ? errorCheckbox.closest('tr') : null;
            if (errorRow) {
                errorRow.classList.remove('refreshing', 'refresh-success');
                const loadingIndicator = errorRow.querySelector('.refresh-loading');
                const successIndicator = errorRow.querySelector('.refresh-success');
                if (loadingIndicator) loadingIndicator.remove();
                if (successIndicator) successIndicator.remove();
            }
        }
    }
    
    editSubscriber(id) {
        // Navigate to admins page and open edit modal
        // The admin ID is the same as subscriber ID
        window.location.href = `/pages/admins.html#edit-${id}`;
    }
    
    openAddSubscribersModal() {
        const modal = document.getElementById('addSubscribersModal');
        if (modal) {
            modal.classList.add('show');
            document.body.style.overflow = 'hidden';
            this.initAddSubscribersModal();
        }
    }
    
    closeAddSubscribersModal() {
        const modal = document.getElementById('addSubscribersModal');
        if (modal) {
            modal.classList.remove('show');
            document.body.style.overflow = '';
        }
    }
    
    initAddSubscribersModal() {
        const container = document.getElementById('subscribersItemsContainer');
        if (!container) return;
        
        // Clear existing items
        container.innerHTML = '';
        
        // Add first subscriber row
        this.addSubscriberRow();
        
        // Bind add button
        const addBtn = document.getElementById('addSubscriberRowBtn');
        if (addBtn) {
            addBtn.onclick = () => this.addSubscriberRow();
        }
        
        // Bind form submit
        const form = document.getElementById('addSubscribersForm');
        if (form) {
            form.onsubmit = (e) => {
                e.preventDefault();
                this.handleAddSubscribersSubmit();
            };
        }
        
        // Close modal on overlay click
        const modal = document.getElementById('addSubscribersModal');
        if (modal) {
            modal.onclick = (e) => {
                if (e.target === modal) {
                    this.closeAddSubscribersModal();
                }
            };
        }
    }
    
    addSubscriberRow() {
        const container = document.getElementById('subscribersItemsContainer');
        if (!container) return;
        
        const itemIndex = container.children.length;
        const itemDiv = document.createElement('div');
        itemDiv.className = 'add-subscribers-item';
        itemDiv.dataset.index = itemIndex;
        
        itemDiv.innerHTML = `
            <div class="add-subscribers-item-fields">
                <div class="add-subscribers-field">
                    <label for="subscriber_${itemIndex}">Subscriber</label>
                    <input type="tel" id="subscriber_${itemIndex}" name="items[${itemIndex}].subscriber" placeholder="Enter phone number" required>
                </div>
                <div class="add-subscribers-field">
                    <label for="quota_${itemIndex}">Quota</label>
                    <input type="number" id="quota_${itemIndex}" name="items[${itemIndex}].quota" step="any" placeholder="Enter quota" required>
                </div>
                <div class="add-subscribers-field">
                    <label for="service_${itemIndex}">Service</label>
                    <input type="text" id="service_${itemIndex}" name="items[${itemIndex}].service" placeholder="Enter service" required>
                </div>
            </div>
            <button type="button" class="add-subscribers-remove-btn" onclick="insightsManager.removeSubscriberRow(this)">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 6.386c0-.484.345-.877.771-.877h2.665c.529-.016.996-.399 1.176-.965l.03-.1l.115-.391c.07-.24.131-.45.217-.637c.338-.739.964-1.252 1.687-1.383c.184-.033.378-.033.6-.033h3.478c.223 0 .417 0 .6.033c.723.131 1.35.644 1.687 1.383c.086.187.147.396.218.637l.114.391l.03.1c.18.566.74.95 1.27.965h2.57c.427 0 .772.393.772.877s-.345.877-.771.877H3.77c-.425 0-.77-.393-.77-.877"/>
                    <path fill-rule="evenodd" d="M11.596 22h.808c2.783 0 4.174 0 5.08-.886c.904-.886.996-2.339 1.181-5.245l.267-4.188c.1-1.577.15-2.366-.303-2.865c-.454-.5-1.22-.5-2.753-.5H8.124c-1.533 0-2.3 0-2.753.5s-.404 1.288-.303 2.865l.267 4.188c.185 2.906.277 4.36 1.182 5.245c.905.886 2.296.886 5.079.886m-1.35-9.811c-.04-.434-.408-.75-.82-.707c-.413.043-.713.43-.672.864l.5 5.263c.04.434.408.75.82.707c.413-.043.713-.43.672-.864zm4.329-.707c.412.043.713.43.671.864l-.5 5.263c-.04.434-.409.75-.82.707c-.413-.043-.713-.43-.672-.864l.5-5.263c.04-.434.409-.75.82-.707" clip-rule="evenodd"/>
                </svg>
                Remove
            </button>
        `;
        
        container.appendChild(itemDiv);
    }
    
    removeSubscriberRow(button) {
        const item = button.closest('.add-subscribers-item');
        if (item) {
            item.remove();
            // Re-index remaining items
            const container = document.getElementById('subscribersItemsContainer');
            if (container) {
                Array.from(container.children).forEach((child, index) => {
                    child.dataset.index = index;
                    const inputs = child.querySelectorAll('input');
                    inputs.forEach(input => {
                        const name = input.name;
                        if (name) {
                            input.name = name.replace(/\[\d+\]/, `[${index}]`);
                            input.id = input.id.replace(/\d+$/, index);
                        }
                        const label = child.querySelector(`label[for="${input.id}"]`);
                        if (label) {
                            label.setAttribute('for', input.id);
                        }
                    });
                });
            }
        }
    }
    
    async handleAddSubscribersSubmit() {
        const form = document.getElementById('addSubscribersForm');
        if (!form) return;
        
        const formData = new FormData(form);
        const items = [];
        
        // Collect all subscriber items
        const container = document.getElementById('subscribersItemsContainer');
        if (container) {
            const itemDivs = container.querySelectorAll('.add-subscribers-item');
            itemDivs.forEach((itemDiv, index) => {
                const subscriber = itemDiv.querySelector(`input[name="items[${index}].subscriber"]`)?.value.trim();
                const quota = itemDiv.querySelector(`input[name="items[${index}].quota"]`)?.value.trim();
                const service = itemDiv.querySelector(`input[name="items[${index}].service"]`)?.value.trim();
                
                if (subscriber && quota && service) {
                    items.push({
                        subscriber: subscriber,
                        quota: parseFloat(quota) || 0,
                        service: service
                    });
                }
            });
        }
        
        if (items.length === 0) {
            alert('Please add at least one subscriber with all fields filled.');
            return;
        }
        
        // Disable submit button
        const submitBtn = document.getElementById('shareSubscribersBtn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Sharing...';
        }
        
        try {
            // TODO: Implement the actual API call to add subscribers
            console.log('Submitting subscribers:', items);
            
            // Simulate API call
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            alert(`Successfully added ${items.length} subscriber(s)!`);
            this.closeAddSubscribersModal();
            
            // Reset form
            this.initAddSubscribersModal();
        } catch (error) {
            console.error('Error adding subscribers:', error);
            alert('Failed to add subscribers. Please try again.');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Share';
            }
        }
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
    
    /**
     * Check if validity date is expired (yesterday or earlier)
     * @param {string} validityDateStr - Date string in DD/MM/YYYY format
     * @returns {boolean} - True if validity date is yesterday or earlier
     */
    isValidityDateExpired(validityDateStr) {
        if (!validityDateStr || validityDateStr === 'N/A') {
            return false;
        }
        
        try {
            // Parse DD/MM/YYYY format
            const parts = validityDateStr.split('/');
            if (parts.length !== 3) {
                return false;
            }
            
            const day = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed in Date
            const year = parseInt(parts[2], 10);
            
            if (isNaN(day) || isNaN(month) || isNaN(year)) {
                return false;
            }
            
            const validityDate = new Date(year, month, day);
            validityDate.setHours(23, 59, 59, 999); // End of day
            
            // Get yesterday's date (end of yesterday)
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            yesterday.setHours(23, 59, 59, 999);
            
            // Check if validity date is yesterday or earlier
            return validityDate <= yesterday;
        } catch (error) {
            console.warn('Error parsing validity date:', validityDateStr, error);
            return false;
        }
    }
    
    formatDateTime(date) {
        if (!date) return { date: 'N/A', time: '' };
        
        // Ensure we have a valid Date object
        let d;
        if (date instanceof Date) {
            d = date;
        } else if (typeof date === 'number') {
            // If it's a number, treat as milliseconds since epoch
            d = new Date(date);
        } else if (typeof date === 'string') {
            // If it's a string, try to parse it
            d = new Date(date);
        } else {
            d = new Date(date);
        }
        
        // Validate the date
        if (isNaN(d.getTime())) {
            console.warn('Invalid date in formatDateTime:', date);
            return { date: 'N/A', time: '' };
        }
        
        // Use local timezone methods (getHours, getMinutes, etc. return local time)
        // These methods automatically use the browser's local timezone
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        
        // Get local time components (these are already in local timezone)
        let hours = d.getHours(); // Returns local hours (0-23)
        const minutes = d.getMinutes(); // Returns local minutes (0-59)
        const seconds = d.getSeconds(); // Returns local seconds (0-59)
        
        // Format with padding
        const minutesStr = String(minutes).padStart(2, '0');
        const secondsStr = String(seconds).padStart(2, '0');
        
        // Convert to 12-hour format
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12; // Convert 0 to 12 for 12-hour format
        const hoursStr = String(hours).padStart(2, '0');
        
        return {
            date: `${day}/${month}/${year}`,
            time: `${hoursStr}:${minutesStr}:${secondsStr} ${ampm}`
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
