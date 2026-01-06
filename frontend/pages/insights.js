// Insights Page Script
class InsightsManager {
    constructor() {
        this.currentPage = 1;
        this.rowsPerPage = 25;
        this.subscribers = [];
        this.filteredSubscribers = [];
        // Removed selectedRows - using status indicators instead
        this.denseMode = false;
        // Default to 'all' to show all admins, but will be set from HTML on init
        this.activeTab = 'all';
        this.filters = {
            type: [],
            search: '',
            availableServices: false
        };
        
        // Map to store recent manual lastUpdate values (from refresh operations)
        // Key: subscriber ID, Value: { timestamp: Date, setAt: number (ms) }
        // This persists across Firebase listener updates
        this.recentManualUpdates = new Map();
        
        // Flags to prevent duplicate form submissions
        this.isSubmittingEditForm = false;
        this.isSubmittingAddForm = false;
        this.currentUserId = null; // Current authenticated user ID
        
        this.init();
    }
    
    // Get current user ID from Firebase auth
    getCurrentUserId() {
        if (typeof auth !== 'undefined' && auth && auth.currentUser) {
            return auth.currentUser.uid;
        }
        return null;
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
            
            // Get current user ID - CRITICAL for data isolation
            const currentUserId = this.getCurrentUserId();
            if (!currentUserId) {
                throw new Error('User not authenticated. Please log in.');
            }
            
            // Set up real-time listener - CRITICAL: Filter by userId to ensure each user only sees their own admins
            // Note: Compat version doesn't support third parameter (options)
            this.unsubscribe = db.collection('admins').where('userId', '==', currentUserId).onSnapshot(
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
                // CRITICAL: Each admin's lastUpdate must be isolated - never mix between admins
                // CRITICAL: Always start with updatedAt for THIS specific admin (doc.id)
                let lastUpdate = updatedAt;
                
                // Check for recent manual update from refresh operations (persists across Firebase updates)
                // CRITICAL: Use doc.id (admin ID) as the key to ensure isolation between admins
                // CRITICAL: Never use another admin's timestamp - always verify doc.id matches
                const now = Date.now();
                const manualUpdate = this.recentManualUpdates.get(doc.id);
                let manualLastUpdate = null;
                
                if (manualUpdate) {
                    // CRITICAL: Verify this update belongs to THIS admin (doc.id)
                    // Double-check that the cached update is for the correct admin
                    if (manualUpdate.adminId && manualUpdate.adminId !== doc.id) {
                        // Wrong admin - remove it immediately
                        console.error(`❌ [${doc.id}] Cached manual update belongs to different admin (${manualUpdate.adminId}), removing!`);
                        this.recentManualUpdates.delete(doc.id);
                    } else {
                        // Check if the manual update is still recent (within 15 seconds)
                        const age = now - manualUpdate.setAt;
                        if (age < 15000) { // Within last 15 seconds
                            manualLastUpdate = manualUpdate.timestamp;
                            // CRITICAL: Verify the timestamp is valid
                            if (manualLastUpdate instanceof Date && !isNaN(manualLastUpdate.getTime())) {
                                console.log(`🔄 [${doc.id}] Found recent manual lastUpdate from cache: ${manualLastUpdate.toLocaleString()} (age: ${age}ms)`);
                            } else {
                                // Invalid timestamp - remove it
                                console.error(`❌ [${doc.id}] Invalid manual lastUpdate timestamp, removing from cache`);
                                this.recentManualUpdates.delete(doc.id);
                                manualLastUpdate = null;
                            }
                        } else {
                            // Manual update is too old, remove it from cache
                            this.recentManualUpdates.delete(doc.id);
                            console.log(`🗑️ [${doc.id}] Removed stale manual update from cache (age: ${age}ms)`);
                        }
                    }
                }
                
                // Process Firebase lastRefreshTimestamp
                // CRITICAL: Only process lastRefreshTimestamp for THIS specific admin (doc.id)
                // Do not mix timestamps between different admins
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
                        
                        // Priority order:
                        // 1. Recent manual lastUpdate (from refresh cache for THIS admin) - highest priority
                        // 2. Firebase lastRefreshTimestamp (from THIS document being processed)
                        // 3. updatedAt (fallback)
                        // CRITICAL: Always verify we're using the correct admin's timestamp
                        if (manualLastUpdate) {
                            // If we have a recent manual update for THIS admin, only use Firebase if it's newer
                            if (firebaseLastUpdate.getTime() > manualLastUpdate.getTime()) {
                                lastUpdate = firebaseLastUpdate;
                                // Update the cache with the newer Firebase timestamp (for THIS admin only)
                                this.recentManualUpdates.set(doc.id, {
                                    timestamp: firebaseLastUpdate,
                                    setAt: now,
                                    adminId: doc.id // CRITICAL: Store admin ID
                                });
                                console.log(`🔄 [${doc.id}] Using newer Firebase timestamp: ${lastUpdate.toLocaleString()}`);
                            } else {
                                lastUpdate = manualLastUpdate;
                                console.log(`🔄 [${doc.id}] Keeping cached manual lastUpdate: ${lastUpdate.toLocaleString()}`);
                            }
                        } else {
                            // No manual update for THIS admin, use Firebase timestamp if it's newer
                            if (firebaseLastUpdate.getTime() > lastUpdate.getTime()) {
                                lastUpdate = firebaseLastUpdate;
                                console.log(`🔄 [${doc.id}] Using Firebase lastRefreshTimestamp: ${lastUpdate.toLocaleString()}`);
                            } else {
                                console.log(`🔄 [${doc.id}] Keeping existing lastUpdate (Firebase timestamp not newer): ${lastUpdate.toLocaleString()}`);
                            }
                        }
                    } else {
                        // Invalid timestamp - use manual update if available, otherwise keep existing
                        if (manualLastUpdate) {
                            lastUpdate = manualLastUpdate;
                            console.log(`🔄 [${doc.id}] Using cached manual lastUpdate (invalid Firebase timestamp): ${lastUpdate.toLocaleString()}`);
                        } else {
                            console.log(`⚠️ [${doc.id}] Invalid lastRefreshTimestamp, using updatedAt: ${lastUpdate.toLocaleString()}`);
                        }
                    }
                } else if (manualLastUpdate) {
                    // No Firebase timestamp for THIS admin, but we have a recent manual update - use it
                    lastUpdate = manualLastUpdate;
                    console.log(`🔄 [${doc.id}] Using cached manual lastUpdate (no Firebase timestamp): ${lastUpdate.toLocaleString()}`);
                } else {
                    // No Firebase timestamp and no manual update - keep existing lastUpdate (updatedAt)
                    console.log(`ℹ️ [${doc.id}] No lastRefreshTimestamp or manual update, using updatedAt: ${lastUpdate.toLocaleString()}`);
                }
                
                // Get Alfa dashboard data if available
                const alfaData = data.alfaData || {};
                const hasAlfaData = alfaData && Object.keys(alfaData).length > 0 && !alfaData.error;
                
                // Debug: Log subscriber counts from Firebase
                if (alfaData.subscribersCount !== undefined || alfaData.subscribersActiveCount !== undefined) {
                    console.log(`📊 [${doc.id}] Subscriber counts from Firebase:`, {
                        subscribersCount: alfaData.subscribersCount,
                        subscribersActiveCount: alfaData.subscribersActiveCount,
                        subscribersRequestedCount: alfaData.subscribersRequestedCount
                    });
                }
                
                // Determine status based on getconsumption API response
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
                                        console.log(`✅ [${doc.id}] Marked as active - found "U-share Main" in ServiceNameValue: "${serviceName}"`);
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
                                                        console.log(`✅ [${doc.id}] Marked as active - found "Mobile Internet" with valid ValidityDateValue: "${validityDate}"`);
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
                        console.warn(`⚠️ Error checking status from primaryData for admin ${doc.id}:`, statusError);
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
                                            console.log(`✅ [${doc.id}] Marked as active - found "U-share Main" in apiResponses: "${serviceName}"`);
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
                                                            console.log(`✅ [${doc.id}] Marked as active - found "Mobile Internet" with valid ValidityDateValue in apiResponses: "${validityDate}"`);
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
                
                // If no "U-share Main" found, admin is inactive (default)
                if (status === 'inactive') {
                    console.log(`⚠️ [${doc.id}] Marked as inactive - "U-share Main" not found in ServiceNameValue`);
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
                            console.log(`🔍 [${doc.id}] Extracting from primaryData, current totalConsumption=${totalConsumption}, totalLimit=${totalLimit} (quota=${data.quota})`);
                            
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
                            
                            // Look for consumption data in ServiceInformationValue structure
                            if (primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue) && primaryData.ServiceInformationValue.length > 0) {
                                console.log(`🔍 [${doc.id}] Found ${primaryData.ServiceInformationValue.length} service(s) in ServiceInformationValue`);
                                
                                // FIRST PASS: Collect all PackageValues (prioritize this for total bundle size)
                                // PackageValue represents the total bundle size (e.g., 77 GB) and should ALWAYS be used
                                let packageValues = [];
                                for (const service of primaryData.ServiceInformationValue) {
                                    if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                        for (const details of service.ServiceDetailsInformationValue) {
                                            if (details.PackageValue) {
                                                const packageStr = String(details.PackageValue).trim();
                                                const packageMatch = packageStr.match(/^([\d.]+)/);
                                                if (packageMatch) {
                                                    const packageValue = parseFloat(packageMatch[1]) || 0;
                                                    if (packageValue > 0) {
                                                        packageValues.push(packageValue);
                                                        console.log(`🔍 [${doc.id}] Found PackageValue: ${packageValue} GB in service: ${service.ServiceNameValue || 'unknown'}`);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                
                                // Use the largest PackageValue as totalLimit (should be the total bundle)
                                if (packageValues.length > 0) {
                                    const maxPackageValue = Math.max(...packageValues);
                                    const adminQuota = parseFloat(data.quota || 0);
                                    
                                    // Always use PackageValue if it's larger than admin quota (indicates total bundle)
                                    // OR if totalLimit hasn't been set properly yet
                                    if (maxPackageValue > adminQuota || totalLimit === 0 || totalLimit === adminQuota || totalLimit < maxPackageValue) {
                                        totalLimit = maxPackageValue;
                                        console.log(`✅ [${doc.id}] Extracted totalLimit from PackageValue (max of ${packageValues.length} found): ${totalLimit} GB (admin quota: ${adminQuota} GB, packageValues: [${packageValues.join(', ')}])`);
                                    }
                                }
                                
                                // SECOND PASS: Extract consumption and other values
                                for (const service of primaryData.ServiceInformationValue) {
                                    const serviceName = service.ServiceNameValue || 'unknown';
                                    console.log(`🔍 [${doc.id}] Processing service: ${serviceName}`);
                                    if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                        for (const details of service.ServiceDetailsInformationValue) {
                                            console.log(`🔍 [${doc.id}] Service details - ConsumptionValue: ${details.ConsumptionValue}, ConsumptionUnit: ${details.ConsumptionUnitValue}, PackageValue: ${details.PackageValue}, PackageUnit: ${details.PackageUnitValue}`);
                                            
                                            // Extract consumption from ConsumptionValue (for services like "Mobile Internet")
                                            if (details.ConsumptionValue) {
                                                const consumptionValue = parseFloat(details.ConsumptionValue) || 0;
                                                const consumptionUnit = details.ConsumptionUnitValue || '';
                                                
                                                // Only extract if we don't have consumption yet, or if this is a better source
                                                if (!totalConsumption || (consumptionValue > 0 && totalConsumption === 0)) {
                                                    // Convert MB to GB if needed
                                                    if (consumptionUnit === 'MB' && consumptionValue > 0) {
                                                        totalConsumption = consumptionValue / 1024;
                                                        console.log(`✅ [${doc.id}] Extracted totalConsumption from ConsumptionValue (MB->GB): ${consumptionValue} MB = ${totalConsumption} GB`);
                                                    } else if (consumptionUnit === 'GB' || !consumptionUnit) {
                                                        totalConsumption = consumptionValue;
                                                        console.log(`✅ [${doc.id}] Extracted totalConsumption from ConsumptionValue: ${totalConsumption} GB`);
                                                    }
                                                }
                                            }
                                            
                                            // First, try to get total consumption from SecondaryValue (U-Share Total Bundle)
                                            if (details.SecondaryValue && Array.isArray(details.SecondaryValue)) {
                                                // Find U-Share Total Bundle
                                                const totalBundle = details.SecondaryValue.find(secondary => {
                                                    const bundleName = (secondary.BundleNameValue || '').toLowerCase();
                                                    return bundleName.includes('u-share total') || 
                                                           bundleName.includes('total bundle');
                                                }) || details.SecondaryValue[0]; // Fallback to first
                                                
                                                if (totalBundle) {
                                                    const consumptionValue = totalBundle.ConsumptionValue || details.ConsumptionValue || '';
                                                    const consumptionUnit = totalBundle.ConsumptionUnitValue || details.ConsumptionUnitValue || '';
                                                    
                                                    if (consumptionValue && !totalConsumption) {
                                                        let consumption = parseFloat(consumptionValue) || 0;
                                                        if (consumptionUnit === 'MB' && consumption > 0) {
                                                            consumption = consumption / 1024;
                                                        }
                                                        totalConsumption = consumption;
                                                    }
                                                    
                                                    // Only use QuotaValue from SecondaryValue if PackageValue was not found
                                                    // (PackageValue takes priority as it represents the total bundle)
                                                    const quotaValue = totalBundle.QuotaValue || '';
                                                    if (quotaValue && (!totalLimit || totalLimit === data.quota || totalLimit === 0)) {
                                                        const quotaStr = String(quotaValue).trim();
                                                        const quotaMatch = quotaStr.match(/^([\d.]+)/);
                                                        if (quotaMatch) {
                                                            const quotaVal = parseFloat(quotaMatch[1]) || 0;
                                                            // Only use if larger than current totalLimit (indicates it's the total bundle, not a sub-bundle)
                                                            if (quotaVal > totalLimit) {
                                                                totalLimit = quotaVal;
                                                                console.log(`✅ [${doc.id}] Extracted totalLimit from SecondaryValue QuotaValue (fallback): ${totalLimit} GB`);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                            
                                            // Extract total limit from QuotaValue (for U-Share services) - ONLY as fallback if PackageValue not found
                                            if (details.QuotaValue && (!totalLimit || totalLimit === data.quota || totalLimit === 0)) {
                                                const quotaStr = String(details.QuotaValue).trim();
                                                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                                                if (quotaMatch) {
                                                    const quotaVal = parseFloat(quotaMatch[1]) || 0;
                                                    // Only use if larger than current totalLimit (indicates it's the total bundle, not a sub-bundle)
                                                    if (quotaVal > totalLimit) {
                                                        totalLimit = quotaVal;
                                                        console.log(`✅ [${doc.id}] Extracted totalLimit from QuotaValue (fallback): ${totalLimit} GB`);
                                                    }
                                                }
                                            }
                                            
                                            // If we found both, break
                                            if (totalConsumption > 0 && totalLimit > 0 && totalLimit > (data.quota || 0)) break;
                                        }
                                        if (totalConsumption > 0 && totalLimit > 0 && totalLimit > (data.quota || 0)) break;
                                    }
                                }
                            }
                        } catch (primaryError) {
                            console.warn(`⚠️ Error extracting from primaryData for admin ${doc.id}:`, primaryError);
                        }
                        
                        // Log final extracted values
                        if (alfaData.primaryData) {
                            console.log(`📊 [${doc.id}] After primaryData extraction - totalConsumption: ${totalConsumption}, totalLimit: ${totalLimit} (quota: ${data.quota})`);
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
                            
                            // Handle two formats:
                            // 1. "X / Y GB" format (old format with limit)
                            // 2. "X GB" format (new format without limit - frontend will add limit from quota)
                            const matchWithLimit = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                            const matchWithoutLimit = adminConsumptionStr.match(/^([\d.]+)\s*(GB|MB)/i);
                            
                            if (matchWithLimit) {
                                // Old format: "X / Y GB"
                                const extractedConsumption = parseFloat(matchWithLimit[1]) || 0;
                                const extractedLimit = parseFloat(matchWithLimit[2]) || 0;
                                
                                // IMPORTANT: Check if the limit matches totalLimit (not adminLimit)
                                // If it matches totalLimit, this is actually total consumption, not admin consumption
                                // Admin consumption should have a limit that matches admin quota, not total bundle size
                                const adminQuota = parseFloat(data.quota || 0);
                                const isLikelyTotalConsumption = extractedLimit > adminQuota && adminQuota > 0;
                                
                                if (isLikelyTotalConsumption) {
                                    // This looks like total consumption (e.g., "71.21 / 77 GB" where 77 is totalLimit, not adminLimit)
                                    // Don't use it as admin consumption - keep it as 0
                                    console.log(`⚠️ [${doc.id}] Ignoring adminConsumption string "${adminConsumptionStr}" - limit (${extractedLimit}) matches totalLimit, not adminLimit (${adminQuota}). This is likely total consumption, not admin consumption.`);
                                    adminConsumption = 0; // Will be extracted from U-Share Main if available
                                } else {
                                    // This looks like valid admin consumption (e.g., "17.11 / 15 GB" where 15 is admin quota)
                                    adminConsumption = extractedConsumption;
                                    console.log(`✅ [${doc.id}] Extracted adminConsumption from string: "${adminConsumptionStr}" -> ${adminConsumption}`);
                                }
                            } else if (matchWithoutLimit) {
                                // New format: "X GB" (consumption only, no limit)
                                // Extract the consumption value and use admin quota as limit
                                adminConsumption = parseFloat(matchWithoutLimit[1]) || 0;
                                console.log(`✅ [${doc.id}] Extracted adminConsumption from value-only format: "${adminConsumptionStr}" -> ${adminConsumption} GB (limit will be from admin quota)`);
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
                        
                        // Look for U-Share Main service for admin consumption (NOT Mobile Internet!)
                        // Mobile Internet service shows total bundle consumption, not admin's share
                        if (primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue) && primaryData.ServiceInformationValue.length > 0) {
                            // First pass: Look for U-Share Main service
                            for (const service of primaryData.ServiceInformationValue) {
                                const serviceName = (service.ServiceNameValue || '').toLowerCase();
                                
                                // Skip Mobile Internet - that's total consumption, not admin consumption
                                if (serviceName.includes('mobile internet')) {
                                    continue;
                                }
                                
                                // Look for U-Share Main service
                                if (serviceName.includes('u-share') && serviceName.includes('main')) {
                                    if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                        for (const details of service.ServiceDetailsInformationValue) {
                                            // Look for U-Share Main circle in SecondaryValue
                                            if (details.SecondaryValue && Array.isArray(details.SecondaryValue)) {
                                                const uShareMain = details.SecondaryValue.find(secondary => {
                                                    const bundleName = (secondary.BundleNameValue || '').toLowerCase();
                                                    return bundleName.includes('u-share main') || bundleName.includes('main');
                                                });
                                                
                                                if (uShareMain && uShareMain.ConsumptionValue) {
                                                    let consumption = parseFloat(uShareMain.ConsumptionValue) || 0;
                                                    const consumptionUnit = uShareMain.ConsumptionUnitValue || '';
                                                    if (consumptionUnit === 'MB' && consumption > 0) {
                                                        consumption = consumption / 1024;
                                                    }
                                                    adminConsumption = consumption;
                                                    console.log(`✅ [${doc.id}] Extracted adminConsumption from U-Share Main SecondaryValue: ${adminConsumption} GB`);
                                                    break;
                                                }
                                            }
                                            
                                            // Fallback: Use ConsumptionValue from U-Share Main service details
                                            if (adminConsumption === 0 && details.ConsumptionValue) {
                                                let consumption = parseFloat(details.ConsumptionValue) || 0;
                                                const consumptionUnit = details.ConsumptionUnitValue || '';
                                                if (consumptionUnit === 'MB' && consumption > 0) {
                                                    consumption = consumption / 1024;
                                                }
                                                adminConsumption = consumption;
                                                console.log(`✅ [${doc.id}] Extracted adminConsumption from U-Share Main details: ${adminConsumption} GB`);
                                                break;
                                            }
                                        }
                                        if (adminConsumption > 0) break;
                                    }
                                }
                            }
                            
                            // Second pass: If U-Share Main not found, look for any U-Share service (but NOT Mobile Internet)
                            if (adminConsumption === 0) {
                                for (const service of primaryData.ServiceInformationValue) {
                                    const serviceName = (service.ServiceNameValue || '').toLowerCase();
                                    
                                    // Skip Mobile Internet - that's total consumption, not admin consumption
                                    if (serviceName.includes('mobile internet')) {
                                        continue;
                                    }
                                    
                                    // Look for any U-Share service
                                    if (serviceName.includes('u-share')) {
                                        if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                            for (const details of service.ServiceDetailsInformationValue) {
                                                if (details.ConsumptionValue) {
                                                    let consumption = parseFloat(details.ConsumptionValue) || 0;
                                                    const consumptionUnit = details.ConsumptionUnitValue || '';
                                                    if (consumptionUnit === 'MB' && consumption > 0) {
                                                        consumption = consumption / 1024;
                                                    }
                                                    adminConsumption = consumption;
                                                    console.log(`✅ [${doc.id}] Extracted adminConsumption from U-Share service: ${adminConsumption} GB`);
                                                    break;
                                                }
                                            }
                                            if (adminConsumption > 0) break;
                                        }
                                    }
                                }
                            }
                        }
                    } catch (primaryError) {
                        console.warn(`⚠️ Error extracting adminConsumption from primaryData for admin ${doc.id}:`, primaryError);
                    }
                }
                
                // CRITICAL: If there are 0 subscribers, admin consumption must be 0
                // The admin hasn't used their share yet when there are no subscribers
                // This overrides any incorrect value from Firebase (e.g., when backend sets it to 0 but Firebase save fails)
                const finalSubscribersCount = hasAlfaData && alfaData.subscribersCount !== undefined
                    ? (typeof alfaData.subscribersCount === 'number' ? alfaData.subscribersCount : parseInt(alfaData.subscribersCount) || 0)
                    : 0;
                
                if (finalSubscribersCount === 0 && adminConsumption > 0) {
                    console.log(`✅ [${doc.id}] Overriding adminConsumption from ${adminConsumption} to 0 (subscribersCount is 0)`);
                    adminConsumption = 0;
                }
                
                // IMPORTANT: Do NOT use totalConsumption as adminConsumption fallback
                // If admin consumption is 0, it means the admin hasn't used their share yet
                // Total consumption includes all subscribers, so it's not the same as admin consumption
                
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
                
                // Extract subscribers count from ushare HTML (Active/Requested breakdown)
                let subscribersCount = hasAlfaData && alfaData.subscribersCount !== undefined 
                    ? (typeof alfaData.subscribersCount === 'number' ? alfaData.subscribersCount : parseInt(alfaData.subscribersCount) || 0)
                    : 0;
                
                // Get Active and Requested counts from ushare HTML data
                // CRITICAL: Ushare HTML is the source of truth - always trust it when available
                const hasUshareHtmlData = hasAlfaData && alfaData.subscribersRequestedCount !== undefined;
                
                let activeCount = hasAlfaData && alfaData.subscribersActiveCount !== undefined
                    ? (typeof alfaData.subscribersActiveCount === 'number' ? alfaData.subscribersActiveCount : parseInt(alfaData.subscribersActiveCount) || 0)
                    : subscribersCount; // Fallback to total count if active count not available
                
                let requestedCount = hasUshareHtmlData
                    ? (typeof alfaData.subscribersRequestedCount === 'number' ? alfaData.subscribersRequestedCount : parseInt(alfaData.subscribersRequestedCount) || 0)
                    : undefined; // Don't set to 0 if Ushare HTML data is not available
                
                // Get pending subscribers count from Firebase (for backward compatibility - only use if Ushare HTML not available)
                const pendingSubscribers = data.pendingSubscribers || [];
                const removedSubscribers = data.removedSubscribers || [];
                // CRITICAL: removedActiveSubscribers is stored at root level of Firebase document, not in alfaData
                const removedActiveSubscribers = data.removedActiveSubscribers || [];
                
                // Debug logging for removedActiveSubscribers
                if (removedActiveSubscribers.length > 0 || data.removedActiveSubscribers) {
                    console.log(`🔍 [${doc.id}] removedActiveSubscribers from Firebase:`, {
                        length: removedActiveSubscribers.length,
                        exists: !!data.removedActiveSubscribers,
                        isArray: Array.isArray(data.removedActiveSubscribers),
                        raw: data.removedActiveSubscribers,
                        processed: removedActiveSubscribers
                    });
                }
                
                // Filter out removed pending subscribers from the count
                const activePendingSubscribers = pendingSubscribers.filter(pending => {
                    const pendingPhone = String(pending.phone || '').trim();
                    return !removedSubscribers.includes(pendingPhone);
                });
                const pendingCount = activePendingSubscribers.length;
                
                // CRITICAL: Only use pending count as fallback if Ushare HTML data is NOT available
                // If Ushare HTML says 0 requested, trust it (subscriber was removed on Alfa website)
                if (!hasUshareHtmlData && pendingCount > 0) {
                    requestedCount = pendingCount;
                } else if (!hasUshareHtmlData) {
                    requestedCount = 0; // No Ushare HTML data and no pending subscribers
                }
                // If hasUshareHtmlData is true, requestedCount is already set above (even if 0)
                
                // Debug: Log extracted counts
                if (hasAlfaData && (alfaData.subscribersCount !== undefined || alfaData.subscribersActiveCount !== undefined)) {
                    console.log(`📊 [${doc.id}] Extracted subscriber counts:`, {
                        subscribersCount,
                        activeCount,
                        requestedCount,
                        hasUshareHtmlData,
                        pendingCount,
                        fromAlfaData: {
                            subscribersCount: alfaData.subscribersCount,
                            subscribersActiveCount: alfaData.subscribersActiveCount,
                            subscribersRequestedCount: alfaData.subscribersRequestedCount
                        }
                    });
                }
                
                // Debug: Log pending subscribers
                if (pendingCount > 0) {
                    console.log(`📋 Admin ${doc.id} has ${pendingCount} pending subscriber(s):`, activePendingSubscribers);
                }
                
                // Extract expiration (number of days)
                const expiration = hasAlfaData && alfaData.expiration !== undefined 
                    ? (typeof alfaData.expiration === 'number' ? alfaData.expiration : parseInt(alfaData.expiration) || 0)
                    : 0;
                
                // Parse dates from Alfa data if available
                let subscriptionDate = this.formatDate(createdAt);
                let validityDate = this.formatDate(new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000));
                
                // CRITICAL: Only use dates from API if they are valid (not NaN)
                if (hasAlfaData && alfaData.subscriptionDate) {
                    const apiSubDate = alfaData.subscriptionDate;
                    // Validate: must be a string, not empty, and not contain NaN
                    if (typeof apiSubDate === 'string' && apiSubDate.trim() && !apiSubDate.includes('NaN')) {
                        subscriptionDate = apiSubDate;
                    } else {
                        // Invalid date from API - keep fallback date or empty
                        console.warn(`⚠️ Invalid subscriptionDate from API: ${apiSubDate}, using fallback`);
                    }
                }
                if (hasAlfaData && alfaData.validityDate) {
                    const apiValDate = alfaData.validityDate;
                    // Validate: must be a string, not empty, and not contain NaN
                    if (typeof apiValDate === 'string' && apiValDate.trim() && !apiValDate.includes('NaN')) {
                        validityDate = apiValDate;
                    } else {
                        // Invalid date from API - keep fallback date or empty
                        console.warn(`⚠️ Invalid validityDate from API: ${apiValDate}, using fallback`);
                    }
                }
                
                // Check if validity date is yesterday or earlier (expired)
                // NOTE: Validity date is a cycle date, not an expiration date. We should NOT reset consumption
                // based on validity date alone. Only reset if admin is truly inactive or expired based on expiration field.
                // The expiration field (in days) is the source of truth for whether the admin is expired.
                // IMPORTANT: Only reset totalConsumption (not adminConsumption) when expired
                const expirationDays = hasAlfaData && alfaData.expiration !== undefined 
                    ? (typeof alfaData.expiration === 'number' ? alfaData.expiration : parseInt(alfaData.expiration) || 0)
                    : 0;
                
                // Only consider expired if expiration is explicitly 0 or negative (not just validity date passed)
                const isExpired = expirationDays <= 0 && expirationDays !== undefined;
                
                if (isExpired) {
                    console.warn(`⚠️ [${doc.id}] Admin is expired (expiration: ${expirationDays} days), resetting totalConsumption from ${totalConsumption} to 0 (adminConsumption kept)`);
                    totalConsumption = 0;
                    totalLimit = 0;
                    // NOTE: Do NOT reset adminConsumption - it should remain even if expired
                } else {
                    console.log(`✅ [${doc.id}] Admin is NOT expired (expiration: ${expirationDays} days, validityDate: ${validityDate}), keeping totalConsumption: ${totalConsumption}`);
                }
                
                // If admin is inactive, set consumption and date fields to empty
                // IMPORTANT: Only set to empty if status is strictly 'inactive'
                // NOTE: Keep pendingSubscribers even for inactive admins (they might become active later)
                // IMPORTANT: Only reset totalConsumption for inactive admins, NOT adminConsumption
                if (status === 'inactive') {
                    totalConsumption = 0;
                    totalLimit = 0;
                    subscriptionDate = '';
                    validityDate = '';
                    subscribersCount = 0;
                    // NOTE: Do NOT reset adminConsumption or adminLimit for inactive admins - keep them
                    // Don't clear pendingSubscribers - they should still be tracked
                }
                // For active admins, keep all original values (even if they're 0 or empty from data source)
                
                // DEBUG: Log final values before creating subscriber object
                if (doc.id === 'C46uXuZKR4sOvChA9hsl') {
                    console.log(`🔍 [${doc.id}] Creating subscriber object with: totalConsumption=${totalConsumption}, totalLimit=${totalLimit}, adminConsumption=${adminConsumption}, adminLimit=${adminLimit}, isExpired=${isExpired}, status=${status}`);
                }
                
                return {
                    id: doc.id,
                    userId: data.userId || null, // CRITICAL: Include userId for ownership validation
                    name: data.name || 'Unknown',
                    phone: data.phone || '',
                    type: type,
                    status: status,
                    totalConsumption: totalConsumption,
                    totalLimit: isExpired ? 0 : (totalLimit || 1), // If expired, set to 0; otherwise avoid division by zero
                    subscriptionDate: subscriptionDate,
                    validityDate: validityDate,
                    subscribersCount: subscribersCount,
                    subscribersActiveCount: activeCount,
                    subscribersRequestedCount: requestedCount,
                    pendingSubscribers: activePendingSubscribers, // Store active pending subscribers (excluding removed)
                    pendingCount: pendingCount, // Store pending count (excluding removed) - for backward compatibility
                    removedSubscribers: removedSubscribers, // Store removed subscribers array (for backward compatibility)
                    removedActiveSubscribers: data.removedActiveSubscribers || [], // Store removed Active subscribers with full data
                    adminConsumption: adminConsumption,
                    adminLimit: adminLimit || 1, // Always keep adminLimit (not affected by expiration)
                    balance: balance,
                    expiration: expiration,
                    lastUpdate: (() => {
                        // CRITICAL: Ensure lastUpdate is always a valid Date object for THIS admin
                        // CRITICAL: Never use another admin's lastUpdate - always validate it belongs to this admin
                        
                        // Helper function to convert any value to a valid Date
                        const toValidDate = (value) => {
                            if (!value) return null;
                            // If it's already a valid Date
                            if (value instanceof Date && !isNaN(value.getTime())) {
                                return value;
                            }
                            // If it's a Firebase Timestamp
                            if (value.toDate && typeof value.toDate === 'function') {
                                try {
                                    const date = value.toDate();
                                    if (date instanceof Date && !isNaN(date.getTime())) {
                                        return date;
                                    }
                                } catch (e) {
                                    // Conversion failed
                                }
                            }
                            // Try to parse as Date
                            try {
                                const date = new Date(value);
                                if (date instanceof Date && !isNaN(date.getTime())) {
                                    return date;
                                }
                            } catch (e) {
                                // Parsing failed
                            }
                            return null;
                        };
                        
                        let finalLastUpdate = toValidDate(lastUpdate) || toValidDate(updatedAt) || new Date();
                        
                        // CRITICAL: Double-check cached update belongs to this admin
                        const cachedUpdate = this.recentManualUpdates.get(doc.id);
                        if (cachedUpdate) {
                            if (cachedUpdate.adminId && cachedUpdate.adminId !== doc.id) {
                                // Wrong admin - remove it
                                console.error(`❌ [${doc.id}] Cached update belongs to different admin (${cachedUpdate.adminId}), removing!`);
                                this.recentManualUpdates.delete(doc.id);
                            } else if (cachedUpdate.timestamp instanceof Date && !isNaN(cachedUpdate.timestamp.getTime())) {
                                // Valid cached update for this admin - use it if it's newer
                                if (cachedUpdate.timestamp.getTime() > finalLastUpdate.getTime()) {
                                    finalLastUpdate = cachedUpdate.timestamp;
                                    console.log(`✅ [${doc.id}] Using cached lastUpdate (newer): ${finalLastUpdate.toLocaleString()}`);
                                }
                            }
                        }
                        
                        return finalLastUpdate; // CRITICAL: Always valid Date for THIS admin only
                    })(),
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
            
            // Update immediately for better responsiveness (no animation delay)
            this.applyFilters();
            this.updateTabCounts();
            this.renderTable();
            this.updatePagination();
            this.updatePageInfo();
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
                    <td colspan="12" style="text-align: center; padding: 3rem;">
                        ${window.UIHelpers ? window.UIHelpers.createEmptyState({
                            icon: 'error',
                            title: 'Error Loading Data',
                            description: message
                        }) : `<div style="color: #ef4444;">${message}</div>`}
                    </td>
                </tr>
            `;
        }
    }
    
    showLoading() {
        const tbody = document.getElementById('subscribersTableBody');
        if (tbody && window.UIHelpers) {
            tbody.innerHTML = window.UIHelpers.createSkeletonScreen('table', 5);
        } else if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" style="text-align: center; padding: 3rem;">
                        <div class="loading-spinner" style="margin: 0 auto;"></div>
                    </td>
                </tr>
            `;
        }
    }
    
    showEmptyState() {
        const tbody = document.getElementById('subscribersTableBody');
        if (tbody && window.UIHelpers) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" style="padding: 0;">
                        ${window.UIHelpers.createEmptyState({
                            icon: 'no-data',
                            title: 'No Subscribers Found',
                            description: 'There are no subscribers to display. Try adjusting your filters or add a new subscriber.'
                        })}
                    </td>
                </tr>
            `;
        } else if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No subscribers found
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
        
        // Start periodic cleanup of stale manual updates (every 30 seconds)
        this.startCacheCleanup();
        
        // Wait for Firebase Auth and Firestore to be ready
        this.waitForAuth().then(() => {
            return this.waitForFirebase();
        }).then(() => {
            this.loadSubscribers();
        }).catch(error => {
            console.error('Firebase initialization error:', error);
            this.showError('Error loading data. Please refresh the page.');
        });
    }
    
    async forceRefresh() {
        // Force refresh all subscribers data
        console.log('🔄 [Insights] Force refresh triggered');
        // Don't show loading state - keep existing data visible during refresh
        // The real-time listener will update the table when data arrives
        
        try {
            // Reload subscribers from Firebase
            if (this.unsubscribe) {
                this.unsubscribe();
            }
            await this.loadSubscribers();
        } catch (error) {
            console.error('❌ [Insights] Force refresh error:', error);
            this.showError('Error refreshing data. Please try again.');
        }
    }
    
    startCacheCleanup() {
        // Clean up stale entries from recentManualUpdates cache every 30 seconds
        if (this.cacheCleanupInterval) {
            clearInterval(this.cacheCleanupInterval);
        }
        
        this.cacheCleanupInterval = setInterval(() => {
            const now = Date.now();
            const staleThreshold = 20000; // 20 seconds
            
            for (const [id, update] of this.recentManualUpdates.entries()) {
                const age = now - update.setAt;
                if (age > staleThreshold) {
                    this.recentManualUpdates.delete(id);
                    console.log('🗑️ Cleaned up stale manual update cache for:', id, `(age: ${age}ms)`);
                }
            }
        }, 30000); // Run every 30 seconds
    }
    
    // Clean up listener when page is unloaded
    destroy() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        
        // Clean up cache cleanup interval
        if (this.cacheCleanupInterval) {
            clearInterval(this.cacheCleanupInterval);
            this.cacheCleanupInterval = null;
        }
        
        // Clear the cache
        this.recentManualUpdates.clear();
    }
    
    async waitForAuth() {
        // Wait for Firebase auth to be available and user to be authenticated
        let attempts = 0;
        while (attempts < 50) {
            if (typeof auth !== 'undefined' && auth) {
                // Wait for auth state to be ready
                return new Promise((resolve, reject) => {
                    const unsubscribe = auth.onAuthStateChanged((user) => {
                        unsubscribe(); // Stop listening after first state change
                        if (user && user.uid) {
                            this.currentUserId = user.uid;
                            console.log('✅ User authenticated:', user.uid);
                            resolve();
                        } else {
                            reject(new Error('User not authenticated. Please log in.'));
                        }
                    });
                    
                    // If user is already logged in, resolve immediately
                    if (auth.currentUser && auth.currentUser.uid) {
                        this.currentUserId = auth.currentUser.uid;
                        console.log('✅ User already authenticated:', auth.currentUser.uid);
                        unsubscribe();
                        resolve();
                    }
                });
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        throw new Error('Firebase auth timeout - user not authenticated');
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
        if (tbody && window.UIHelpers) {
            tbody.innerHTML = window.UIHelpers.createSkeletonScreen('table', 5);
        } else if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        <div class="loading-spinner" style="margin: 0 auto;"></div>
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
            // IMPORTANT: "Not u-share" admins should ONLY appear in the "Not u-share" tab
            // If an admin has notUShare === true, exclude them from all other tabs
            if (sub.notUShare === true) {
                // Only show in "Not u-share" tab
                if (this.activeTab !== 'notUShare') {
                    return false;
                }
                // If we're in "Not u-share" tab, show this admin
                return true;
            }
            
            // For non-"Not u-share" admins, apply normal tab filtering
            // Tab filter - 'all' shows everything
            if (this.activeTab === 'all') {
                // Show all, no status filter
            } else if (this.activeTab === 'active' && sub.status !== 'active') {
                return false;
            } else if (this.activeTab === 'inactive' && sub.status !== 'inactive') {
                return false;
            } else if (this.activeTab === 'notUShare') {
                // We already handled notUShare admins above, so if we reach here and tab is notUShare,
                // this admin doesn't have notUShare flag, so exclude them
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
            
            // Available Services filter - same logic as home page
            if (this.filters.availableServices) {
                // Count subscribers by status (Active, Requested, Out)
                const activeCount = sub.subscribersActiveCount || 0;
                const requestedCount = sub.subscribersRequestedCount || 0;
                const removedActiveSubscribers = sub.removedActiveSubscribers || [];
                const outCount = Array.isArray(removedActiveSubscribers) ? removedActiveSubscribers.length : 0;
                
                // NEW EXCLUSION LOGIC: Check if admin matches any of the 9 exclusion conditions
                // 1. One active and two requested
                if (activeCount === 1 && requestedCount === 2 && outCount === 0) {
                    return false; // Exclude this admin
                }
                // 2. Three requested
                if (activeCount === 0 && requestedCount === 3 && outCount === 0) {
                    return false; // Exclude this admin
                }
                // 3. Three active
                if (activeCount === 3 && requestedCount === 0 && outCount === 0) {
                    return false; // Exclude this admin
                }
                // 4. Two active and one requested
                if (activeCount === 2 && requestedCount === 1 && outCount === 0) {
                    return false; // Exclude this admin
                }
                // 5. One active and two out
                if (activeCount === 1 && requestedCount === 0 && outCount === 2) {
                    return false; // Exclude this admin
                }
                // 6. Two active and one out
                if (activeCount === 2 && requestedCount === 0 && outCount === 1) {
                    return false; // Exclude this admin
                }
                // 7. One active and one requested and one out
                if (activeCount === 1 && requestedCount === 1 && outCount === 1) {
                    return false; // Exclude this admin
                }
                // 8. Two requested and one out
                if (activeCount === 0 && requestedCount === 2 && outCount === 1) {
                    return false; // Exclude this admin
                }
                // 9. Two out and one requested
                if (activeCount === 0 && requestedCount === 1 && outCount === 2) {
                    return false; // Exclude this admin
                }
                
                // TERM 1 & 2: Admin must have less than 3 total subscribers (active + removed "Out" subscribers)
                // Total subscribers count (active + requested + removed) must be < 3
                const totalSubscribersCount = activeCount + requestedCount + outCount;
                if (totalSubscribersCount >= 3) {
                    return false; // Exclude this admin
                }

                // TERM 3: Admin must have minimum 20 days before validity date
                const validityDateStr = sub.validityDate || '';
                
                // Helper function to parse DD/MM/YYYY date
                const parseDDMMYYYY = (dateStr) => {
                    if (!dateStr || dateStr === 'N/A' || dateStr.trim() === '') return null;
                    const parts = String(dateStr).trim().split('/');
                    if (parts.length !== 3) return null;
                    const day = parseInt(parts[0], 10);
                    const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
                    const year = parseInt(parts[2], 10);
                    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
                    return new Date(year, month, day);
                };

                // Helper function to calculate days until validity date
                const daysUntilValidity = (dateStr) => {
                    const validityDate = parseDDMMYYYY(dateStr);
                    if (!validityDate) return null;
                    const today = new Date();
                    today.setHours(0, 0, 0, 0); // Set to start of day
                    validityDate.setHours(0, 0, 0, 0);
                    const diffTime = validityDate.getTime() - today.getTime();
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    return diffDays;
                };

                const daysUntil = daysUntilValidity(validityDateStr);
                if (daysUntil === null || daysUntil < 20) {
                    return false; // Exclude if validity date is invalid or less than 20 days away
                }
            }
            
            return true;
        });
    }
    
    updateTabCounts() {
        const allCount = this.subscribers.length;
        // Active count: only admins with status 'active' AND not marked as "Not u-share"
        const activeCount = this.subscribers.filter(s => s.status === 'active' && s.notUShare !== true).length;
        // Inactive count: only admins with status 'inactive' AND not marked as "Not u-share"
        // "Not u-share" admins should only appear in their own tab, not in active/inactive
        const inactiveAdmins = this.subscribers.filter(s => s.status === 'inactive' && s.notUShare !== true);
        const inactiveCount = inactiveAdmins.length;
        
        // Debug: Log inactive admins to help identify issues
        if (inactiveCount > 0) {
            console.log(`📊 Inactive admins (${inactiveCount}):`, inactiveAdmins.map(s => ({ id: s.id, name: s.name, phone: s.phone, notUShare: s.notUShare })));
        }
        
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
            if (window.UIHelpers && this.filteredSubscribers.length === 0 && this.subscribers.length > 0) {
                // No results after filtering
                tbody.innerHTML = `
                    <tr>
                        <td colspan="12" style="padding: 0;">
                            ${window.UIHelpers.createEmptyState({
                                icon: 'no-results',
                                title: 'No Results Found',
                                description: 'No subscribers match your current filters. Try adjusting your search or filter criteria.'
                            })}
                        </td>
                    </tr>
                `;
            } else if (window.UIHelpers && this.subscribers.length === 0) {
                // No subscribers at all
                tbody.innerHTML = `
                    <tr>
                        <td colspan="12" style="padding: 0;">
                            ${window.UIHelpers.createEmptyState({
                                icon: 'no-data',
                                title: 'No Subscribers Found',
                                description: 'There are no subscribers to display. Add a new subscriber to get started.'
                            })}
                        </td>
                    </tr>
                `;
            } else {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="12" style="text-align: center; padding: 3rem; color: #94a3b8;">
                            No subscribers found
                        </td>
                    </tr>
                `;
            }
            return;
        }
        
        // CRITICAL: Use immutable mapping to prevent cross-admin contamination
        // CRITICAL: Each subscriber's lastUpdate must be isolated and preserved
        tbody.innerHTML = currentSubscribers.map(sub => {
            // CRITICAL: Verify lastUpdate belongs to this subscriber
            // CRITICAL: If lastUpdate is missing or invalid, try to restore from cache
            if (!sub.lastUpdate || !(sub.lastUpdate instanceof Date) || isNaN(sub.lastUpdate.getTime())) {
                // Try to restore from cache
                const cachedUpdate = this.recentManualUpdates.get(sub.id);
                if (cachedUpdate && cachedUpdate.timestamp instanceof Date && !isNaN(cachedUpdate.timestamp.getTime())) {
                    sub.lastUpdate = cachedUpdate.timestamp;
                    console.log(`🔄 [${sub.id}] Restored lastUpdate from cache in renderTable: ${sub.lastUpdate.toLocaleString()}`);
                } else {
                    // Use updatedAt as fallback
                    sub.lastUpdate = sub.updatedAt || new Date();
                    console.warn(`⚠️ [${sub.id}] lastUpdate missing/invalid, using updatedAt: ${sub.lastUpdate.toLocaleString()}`);
                }
            }
            return this.renderRow(sub);
        }).join('');
        
        // Bind event listeners to action buttons
        this.bindActionButtons();
    }
    
    renderRow(subscriber) {
        // Fallback: If consumption values are 0 or missing, try to extract from alfaData.primaryData
        // This handles cases where extraction in processSubscribers didn't work but View Details can extract it
        let totalConsumption = subscriber.totalConsumption || 0;
        // IMPORTANT: Use subscriber.totalLimit if it exists, otherwise fall back to admin quota
        // But we should always extract from PackageValue if totalLimit is missing or equals admin quota
        let totalLimit = subscriber.totalLimit;
        if (totalLimit === undefined || totalLimit === null || totalLimit === 0) {
            totalLimit = 0; // Will be extracted from PackageValue below
        }
        
        // DEBUG: Log what we received
        console.log(`🔍 renderRow [${subscriber.id}]: subscriber.totalLimit=${subscriber.totalLimit}, subscriber.totalConsumption=${subscriber.totalConsumption}, initial totalLimit=${totalLimit}`);
        
        let adminConsumption = subscriber.adminConsumption || 0;
        
        // CRITICAL FIX: If adminConsumption is 0 but alfaData.adminConsumption exists, extract from it
        // This ensures the table shows the same value as View Details (which uses alfaData.adminConsumption)
        if (adminConsumption === 0 && subscriber.alfaData && subscriber.alfaData.adminConsumption) {
            try {
                const adminConsumptionValue = subscriber.alfaData.adminConsumption;
                
                if (typeof adminConsumptionValue === 'number') {
                    adminConsumption = adminConsumptionValue;
                    console.log(`✅ renderRow [${subscriber.id}]: Extracted adminConsumption from alfaData.adminConsumption (number): ${adminConsumption} GB`);
                } else if (typeof adminConsumptionValue === 'string') {
                    const adminConsumptionStr = adminConsumptionValue.trim();
                    // Parse formats: "17.11 / 15 GB" or "17.11 GB" or just "17.11"
                    const matchWithLimit = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*[\d.]+\s*(GB|MB)/i);
                    const matchWithoutLimit = adminConsumptionStr.match(/^([\d.]+)\s*(GB|MB)/i);
                    const matchNumber = adminConsumptionStr.match(/^([\d.]+)/);
                    
                    if (matchWithLimit) {
                        adminConsumption = parseFloat(matchWithLimit[1]) || 0;
                        // Convert MB to GB if needed
                        if (matchWithLimit[2].toUpperCase() === 'MB') {
                            adminConsumption = adminConsumption / 1024;
                        }
                        console.log(`✅ renderRow [${subscriber.id}]: Extracted adminConsumption from alfaData.adminConsumption (string with limit): ${adminConsumption} GB`);
                    } else if (matchWithoutLimit) {
                        adminConsumption = parseFloat(matchWithoutLimit[1]) || 0;
                        // Convert MB to GB if needed
                        if (matchWithoutLimit[2].toUpperCase() === 'MB') {
                            adminConsumption = adminConsumption / 1024;
                        }
                        console.log(`✅ renderRow [${subscriber.id}]: Extracted adminConsumption from alfaData.adminConsumption (string without limit): ${adminConsumption} GB`);
                    } else if (matchNumber) {
                        adminConsumption = parseFloat(matchNumber[1]) || 0;
                        // If value is large (>100), assume MB and convert
                        if (adminConsumption > 100) {
                            adminConsumption = adminConsumption / 1024;
                            console.log(`✅ renderRow [${subscriber.id}]: Extracted adminConsumption from alfaData.adminConsumption (large number, assumed MB): ${adminConsumption} GB`);
                        } else {
                            console.log(`✅ renderRow [${subscriber.id}]: Extracted adminConsumption from alfaData.adminConsumption (number): ${adminConsumption} GB`);
                        }
                    }
                }
            } catch (parseError) {
                console.warn(`⚠️ Error parsing alfaData.adminConsumption for ${subscriber.id}:`, parseError);
            }
        }
        
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
        
        // Extract totalLimit from PackageValue if it's missing, 0, equals admin quota, or equals totalConsumption (wrong!)
        // This ensures we always use the correct total bundle size (e.g., 77 GB) instead of admin quota (e.g., 20 GB) or consumption (e.g., 71.19 GB)
        // IMPORTANT: Always check PackageValue even if totalLimit exists, to ensure we have the correct value
        // Also check if totalLimit is suspiciously equal to totalConsumption (which would be wrong)
        const isWrongLimit = (totalLimit > 0 && totalConsumption > 0 && Math.abs(totalLimit - totalConsumption) < 0.01);
        const needsExtraction = (totalLimit === 0 || totalLimit === adminLimit || !totalLimit || isWrongLimit);
        
        if (needsExtraction && subscriber.alfaData && subscriber.alfaData.primaryData) {
            console.log(`🔍 renderRow [${subscriber.id}]: Extracting totalLimit from PackageValue (needsExtraction=${needsExtraction}, isWrongLimit=${isWrongLimit}, current totalLimit=${totalLimit})`);
            try {
                const primaryData = subscriber.alfaData.primaryData;
                if (primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue)) {
                    // FIRST: Collect all PackageValues and use the largest one (total bundle)
                    let packageValues = [];
                    for (const service of primaryData.ServiceInformationValue) {
                        if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                            for (const details of service.ServiceDetailsInformationValue) {
                                if (details.PackageValue) {
                                    const packageStr = String(details.PackageValue).trim();
                                    const packageMatch = packageStr.match(/^([\d.]+)/);
                                    if (packageMatch) {
                                        const packageValue = parseFloat(packageMatch[1]) || 0;
                                        if (packageValue > 0) {
                                            packageValues.push(packageValue);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    
                    // Use the largest PackageValue as totalLimit (should be the total bundle)
                    if (packageValues.length > 0) {
                        const maxPackageValue = Math.max(...packageValues);
                        // Always use PackageValue if it's larger than adminLimit or current totalLimit
                        if (maxPackageValue > adminLimit && maxPackageValue > totalLimit) {
                            const oldTotalLimit = totalLimit;
                            totalLimit = maxPackageValue;
                            console.log(`✅ renderRow [${subscriber.id}]: Extracted totalLimit from PackageValue (max of ${packageValues.length} found): ${totalLimit} GB (adminLimit: ${adminLimit} GB, was: ${oldTotalLimit}, packageValues: [${packageValues.join(', ')}])`);
                        }
                    }
                }
            } catch (extractError) {
                console.warn(`⚠️ Error extracting totalLimit in renderRow for ${subscriber.id}:`, extractError);
            }
        }
        
        // Final check: Log the final values before rendering
        console.log(`📊 renderRow [${subscriber.id}]: Final values - totalConsumption: ${totalConsumption}, totalLimit: ${totalLimit}, adminLimit: ${adminLimit}`);
        
        // If values are missing, try to extract from primaryData (same logic as View Details)
        // IMPORTANT: When expired, totalConsumption is intentionally set to 0, but adminConsumption should remain
        // Only extract adminConsumption if it's truly missing (0), not if totalConsumption is 0 due to expiration
        // Check if adminConsumption was already extracted (preserved, not missing)
        const adminConsumptionWasExtracted = subscriber.adminConsumption !== undefined && subscriber.adminConsumption !== null && subscriber.adminConsumption > 0;
        
        if ((totalConsumption === 0 || (adminConsumption === 0 && !adminConsumptionWasExtracted)) && subscriber.alfaData && subscriber.alfaData.primaryData) {
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
                                // IMPORTANT: Skip Mobile Internet service - that's total consumption, not admin consumption
                                // Admin consumption should come from U-Share Main service
                                // CRITICAL: Only extract if adminConsumption is truly missing (0), not if it was preserved from expiration
                                if (adminConsumption === 0 && !adminConsumptionWasExtracted) {
                                    const serviceName = (service.ServiceNameValue || '').toLowerCase();
                                    
                                    // Skip Mobile Internet - that's total consumption, not admin consumption
                                    if (serviceName.includes('mobile internet')) {
                                        continue;
                                    }
                                    
                                    // Only extract from U-Share services
                                    if (serviceName.includes('u-share')) {
                                        const consumptionValue = details.ConsumptionValue || '';
                                        const consumptionUnit = details.ConsumptionUnitValue || '';
                                        
                                        if (consumptionValue) {
                                            let consumption = parseFloat(consumptionValue) || 0;
                                            if (consumptionUnit === 'MB' && consumption > 0) {
                                                consumption = consumption / 1024;
                                            }
                                            adminConsumption = consumption;
                                            console.log(`✅ renderRow [${subscriber.id}]: Extracted adminConsumption from U-Share service: ${adminConsumption} GB`);
                                            
                                            // Don't update adminLimit from PackageValue - use subscriber.quota instead
                                            // adminLimit should always be the quota set when creating the admin
                                        }
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
        
        // Ensure values are numbers before comparison (handle null/undefined)
        const safeTotalConsumption = (totalConsumption != null && !isNaN(totalConsumption)) ? totalConsumption : 0;
        const safeTotalLimit = (totalLimit != null && !isNaN(totalLimit)) ? totalLimit : 0;
        const safeAdminConsumption = (adminConsumption != null && !isNaN(adminConsumption)) ? adminConsumption : 0;
        const safeAdminLimit = (adminLimit != null && !isNaN(adminLimit)) ? adminLimit : 0;
        
        // Check if total consumption is fully used (>= totalLimit)
        const isTotalFull = safeTotalLimit > 0 && safeTotalConsumption >= safeTotalLimit - 0.01;
        
        // Check if admin consumption >= admin limit (admin has used their full quota)
        const isAdminFull = safeAdminLimit > 0 && safeAdminConsumption >= safeAdminLimit - 0.01;
        
        // IMPORTANT: Only treat bundle as fully used if TOTAL consumption is full, not admin consumption
        // Admin consumption exceeding admin limit just means admin used their quota, not that total bundle is full
        // The total limit should ALWAYS be from PackageValue (e.g., 77 GB), not from admin consumption
        const bundleIsFullyUsed = isTotalFull;
        
        const totalPercent = safeTotalLimit > 0 ? (safeTotalConsumption / safeTotalLimit) * 100 : 0;
        
        // Display values - always use the correct totalLimit from PackageValue
        // Never overwrite totalLimit with adminConsumption - that's wrong!
        let displayTotalConsumption = safeTotalConsumption;
        let displayTotalLimit = safeTotalLimit; // Always use the correct totalLimit (from PackageValue, e.g., 77 GB)
        
        // CRITICAL FIX: Always show admin consumption, even when bundle is fully used
        // The admin consumption value is independent of whether the bundle is fully used
        // View Details shows it correctly, so the table should too
        const displayAdminConsumption = safeAdminConsumption;
        const adminPercent = safeAdminLimit > 0 ? (safeAdminConsumption / safeAdminLimit) * 100 : 0;
        
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
        
        // Admin progress bar color: red if admin quota is reached, regardless of bundle status
        let adminProgressClass = 'progress-fill';
        if (isAdminFull || adminPercent >= 100) {
            // Admin has used their full quota - show red
            adminProgressClass += ' error';
        } else if (adminPercent >= 90) {
            // Admin is at 90%+ of quota - show red as warning
            adminProgressClass += ' error';
        } else if (adminPercent >= 70) {
            // Admin is at 70%+ of quota - show yellow warning
            adminProgressClass += ' warning';
        }
        
        // Get status indicator based on admin status and expiration
        const statusIndicator = this.getStatusIndicator(subscriber);
        
        // CRITICAL: Validate lastUpdate before formatting - ensure it belongs to this subscriber
        let lastUpdateToFormat = subscriber.lastUpdate;
        
        // CRITICAL: If lastUpdate is missing or invalid, try to restore from cache
        if (!lastUpdateToFormat || !(lastUpdateToFormat instanceof Date) || isNaN(lastUpdateToFormat.getTime())) {
            const cachedUpdate = this.recentManualUpdates.get(subscriber.id);
            if (cachedUpdate && cachedUpdate.timestamp instanceof Date && !isNaN(cachedUpdate.timestamp.getTime())) {
                lastUpdateToFormat = cachedUpdate.timestamp;
                console.log(`🔄 [${subscriber.id}] Restored lastUpdate from cache in renderRow: ${lastUpdateToFormat.toLocaleString()}`);
            } else {
                // Use updatedAt as fallback
                lastUpdateToFormat = subscriber.updatedAt || new Date();
                console.warn(`⚠️ [${subscriber.id}] lastUpdate missing/invalid in renderRow, using updatedAt: ${lastUpdateToFormat.toLocaleString()}`);
            }
        }
        
        const lastUpdate = this.formatDateTime(lastUpdateToFormat);
        
        return `
            <tr>
                <td class="status-indicator-cell">
                    ${statusIndicator}
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
                <td>${subscriber.status === 'inactive' ? '' : (subscriber.subscriptionDate && !subscriber.subscriptionDate.includes('NaN') ? subscriber.subscriptionDate : '')}</td>
                <td>${subscriber.status === 'inactive' ? '' : (subscriber.validityDate && !subscriber.validityDate.includes('NaN') ? subscriber.validityDate : '')}</td>
                <td>${subscriber.status === 'inactive' ? '' : this.formatSubscribersCount(subscriber.subscribersActiveCount !== undefined ? subscriber.subscribersActiveCount : subscriber.subscribersCount, subscriber.subscribersRequestedCount !== undefined ? subscriber.subscribersRequestedCount : subscriber.pendingCount)}</td>
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
                            <img src="/assets/eye.png" alt="View Details" style="width: 20px; height: 20px; object-fit: contain;" />
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
    
    getStatusIndicator(subscriber) {
        // Determine status based on admin status and expiration days
        const isInactive = subscriber.status === 'inactive';
        const expirationDays = typeof subscriber.expiration === 'number' ? subscriber.expiration : parseInt(subscriber.expiration) || 0;
        
        // Determine status color and icon
        let statusClass = 'status-indicator';
        let statusIcon = '';
        let tooltipText = '';
        
        if (isInactive) {
            // Red: Inactive
            statusClass += ' status-inactive';
            statusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>`;
            tooltipText = 'Inactive';
        } else if (expirationDays <= 0) {
            // Red: Expired
            statusClass += ' status-expired';
            statusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>`;
            tooltipText = 'Expired';
        } else if (expirationDays < 7) {
            // Yellow: Expiring soon
            statusClass += ' status-warning';
            statusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>`;
            tooltipText = `Expiring in ${expirationDays} day${expirationDays !== 1 ? 's' : ''}`;
        } else {
            // Green: Active and healthy
            statusClass += ' status-active';
            statusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>`;
            tooltipText = `Active (${expirationDays} days remaining)`;
        }
        
        return `<div class="${statusClass}" title="${tooltipText}">
            ${statusIcon}
        </div>`;
    }
    
    bindActionButtons() {
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
    
    // Removed updateSelectAll - using status indicators instead
    
    viewSubscriber(id) {
        const subscriber = this.subscribers.find(s => s.id === id);
        if (!subscriber) {
            console.error('Subscriber not found:', id);
            return;
        }
        
        // DEBUG: Log the full subscriber data to see what's available
        console.log('\n🔍 [View Details] Full subscriber data check:');
        console.log('   - alfaData exists:', !!subscriber.alfaData);
        console.log('   - removedActiveSubscribers exists:', !!subscriber.removedActiveSubscribers);
        console.log('   - removedActiveSubscribers type:', typeof subscriber.removedActiveSubscribers);
        console.log('   - removedActiveSubscribers is array:', Array.isArray(subscriber.removedActiveSubscribers));
        if (Array.isArray(subscriber.removedActiveSubscribers)) {
            console.log('   - removedActiveSubscribers length:', subscriber.removedActiveSubscribers.length);
            if (subscriber.removedActiveSubscribers.length > 0) {
                console.log('   - removedActiveSubscribers:', subscriber.removedActiveSubscribers);
            }
        }
        console.log('   - removedSubscribers:', subscriber.removedSubscribers);
        if (subscriber.alfaData) {
            console.log('   - alfaData keys:', Object.keys(subscriber.alfaData));
            console.log('   - secondarySubscribers:', subscriber.alfaData.secondarySubscribers);
            console.log('   - secondarySubscribers type:', typeof subscriber.alfaData.secondarySubscribers);
            console.log('   - secondarySubscribers is array:', Array.isArray(subscriber.alfaData.secondarySubscribers));
            if (Array.isArray(subscriber.alfaData.secondarySubscribers)) {
                console.log('   - secondarySubscribers length:', subscriber.alfaData.secondarySubscribers.length);
                if (subscriber.alfaData.secondarySubscribers.length > 0) {
                    console.log('   - First subscriber sample:', subscriber.alfaData.secondarySubscribers[0]);
                }
            }
            console.log('   - consumptions:', subscriber.alfaData.consumptions);
        }
        console.log('');
        
        // Extract view details data
        const viewData = this.extractViewDetailsData(subscriber);
        
        // DEBUG: Log extracted view data
        console.log('🔍 Extracted view data:', viewData);
        console.log('🔍 Subscribers count:', viewData.subscribers.length);
        console.log('🔍 removedActiveSubscribers in viewData:', viewData.removedActiveSubscribers);
        console.log('🔍 removedActiveSubscribers length:', viewData.removedActiveSubscribers ? viewData.removedActiveSubscribers.length : 0);
        
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
        
        // Use the EXACT same values as the insights table - no re-extraction
        // The table already extracted these correctly, so we just use them directly
        const data = {
            adminPhone: subscriber.phone,
            adminConsumption: subscriber.adminConsumption || 0, // Use exactly what the table shows
            adminLimit: adminLimit, // Use quota, not API limit
            subscribers: [],
            pendingSubscribers: [], // Will be set conditionally - only if Ushare HTML data not available
            removedSubscribers: subscriber.removedSubscribers || [], // Include removed subscribers (for backward compatibility)
            removedActiveSubscribers: subscriber.removedActiveSubscribers || [], // Include removed Active subscribers with full data
            totalConsumption: subscriber.totalConsumption || 0, // Use exactly what the table shows
            totalLimit: subscriber.totalLimit || 0, // Use exactly what the table shows
            hasUshareHtmlData: false // Flag to track if Ushare HTML data was used
        };
        
        // NO FALLBACK EXTRACTION - trust the values from the table
        // The insights table already extracted these correctly, so we use them as-is
        // This ensures the modal shows EXACTLY the same values as the table
        console.log(`📊 View Details: Using values from table - adminConsumption: ${data.adminConsumption}, totalConsumption: ${data.totalConsumption}, totalLimit: ${data.totalLimit}`);
        
        // PRIORITY 1: Get subscriber data from secondarySubscribers array (from ushare HTML - most accurate with Active/Requested status)
        console.log('🔍 [View Details] Checking for ushare HTML data...');
        console.log('   - alfaData exists:', !!subscriber.alfaData);
        console.log('   - secondarySubscribers exists:', !!(subscriber.alfaData && subscriber.alfaData.secondarySubscribers));
        console.log('   - secondarySubscribers is array:', !!(subscriber.alfaData && Array.isArray(subscriber.alfaData.secondarySubscribers)));
        console.log('   - secondarySubscribers length:', subscriber.alfaData && subscriber.alfaData.secondarySubscribers ? subscriber.alfaData.secondarySubscribers.length : 0);
        
        // Check if Ushare HTML data exists (even if it has 0 subscribers - it's still the source of truth)
        const hasUshareHtmlArray = subscriber.alfaData && subscriber.alfaData.secondarySubscribers && Array.isArray(subscriber.alfaData.secondarySubscribers);
        if (hasUshareHtmlArray) {
            // Ushare HTML data exists - it's the source of truth (even if empty array means 0 subscribers)
            data.hasUshareHtmlData = true;
            if (subscriber.alfaData.secondarySubscribers.length > 0) {
                console.log(`\n🎯 [View Details] ✅ USING USHARE HTML DATA (${subscriber.alfaData.secondarySubscribers.length} subscribers)`);
                subscriber.alfaData.secondarySubscribers.forEach((secondary, idx) => {
                console.log(`   [${idx + 1}] Subscriber: ${secondary.phoneNumber}, Status: ${secondary.status || 'Active'}, Consumption: ${secondary.consumption}, Quota: ${secondary.quota}`);
                if (secondary && secondary.phoneNumber) {
                    let used = 0;
                    let total = 0;
                    
                    // Check if data is from ushare HTML (has consumption and quota as numbers in GB)
                    if (typeof secondary.consumption === 'number' && typeof secondary.quota === 'number') {
                        // Data from ushare HTML - already in GB
                        used = secondary.consumption;
                        total = secondary.quota;
                    } else if (secondary.consumptionText) {
                        // Parse from consumptionText (format: "0.48 / 30 GB")
                        const consumptionMatch = secondary.consumptionText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                        if (consumptionMatch) {
                            used = parseFloat(consumptionMatch[1]) || 0;
                            total = parseFloat(consumptionMatch[2]) || 0;
                        }
                    } else {
                        // Fallback: parse from consumption string (format: "1.18 / 30 GB" or "1.18/30 GB")
                        const consumptionStr = secondary.consumption || '';
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
                    }
                    
                    // Always add subscriber if phoneNumber exists (even if consumption is 0, status might be 'Requested')
                    if (secondary.phoneNumber) {
                        const subscriberStatus = secondary.status || 'Active'; // 'Active' or 'Requested'
                        data.subscribers.push({
                            phoneNumber: secondary.phoneNumber,
                            fullPhoneNumber: secondary.fullPhoneNumber || secondary.phoneNumber,
                            status: subscriberStatus, // 'Active' or 'Requested' from ushare HTML
                            consumption: used,
                            limit: total
                        });
                        console.log(`✅ Added subscriber from ushare HTML: ${secondary.phoneNumber} - ${used} / ${total} GB (Status: ${subscriberStatus})`);
                    }
                }
                });
                console.log(`✅ [View Details] Successfully extracted ${data.subscribers.length} subscribers from ushare HTML\n`);
            } else {
                // Ushare HTML data exists but is empty (0 subscribers) - this is valid data
                console.log(`\n🎯 [View Details] ✅ USING USHARE HTML DATA (0 subscribers - all removed)\n`);
            }
        } else {
            console.log(`⚠️ [View Details] ⚠️ USHARE HTML DATA NOT AVAILABLE - will fallback to getconsumption API\n`);
        }
        
        // PRIORITY 1.5: Try to extract from apiResponses if secondarySubscribers not available
        if (data.subscribers.length === 0 && subscriber.alfaData && subscriber.alfaData.apiResponses && Array.isArray(subscriber.alfaData.apiResponses)) {
            console.log('⚠️ [View Details] ⚠️ FALLING BACK TO getconsumption API (ushare HTML not available)');
            // Ushare HTML not available - allow pending subscribers to be shown
            data.hasUshareHtmlData = false;
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
            // Ushare HTML not available - allow pending subscribers to be shown
            data.hasUshareHtmlData = false;
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
                            status: 'Active', // Consumption circles don't have status, default to Active
                            consumption: used,
                            limit: total
                        });
                        console.log(`✅ Added subscriber from HTML (consumption circles): ${phoneNumber} - ${used} / ${total} GB (Status: Active - default)`);
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
        
        // CRITICAL: Handle pendingSubscribers based on Ushare HTML data availability
        // If Ushare HTML data is available, it's the source of truth - completely ignore stale pendingSubscribers
        // Ushare HTML data is always the most accurate (fetched directly from Alfa website)
        if (data.hasUshareHtmlData) {
            // Ushare HTML data is available - it's the ONLY source of truth
            // Do NOT show any pendingSubscribers - they are all stale
            // If Ushare HTML says 0 requested subscribers, that's the truth (subscriber was removed on Alfa website)
            data.pendingSubscribers = [];
            console.log(`📋 [View Details] Ushare HTML data available - ignoring all pendingSubscribers (source of truth)`);
        } else {
            // Ushare HTML data NOT available - use pendingSubscribers as fallback
            if (subscriber.pendingSubscribers && Array.isArray(subscriber.pendingSubscribers)) {
                // Filter out removed subscribers
                const activePending = subscriber.pendingSubscribers.filter(pending => {
                    const pendingPhone = String(pending.phone || '').trim();
                    return !(data.removedSubscribers || []).includes(pendingPhone);
                });
                data.pendingSubscribers = activePending;
                console.log(`📋 [View Details] Ushare HTML data NOT available - using ${activePending.length} pendingSubscribers as fallback`);
            } else {
                data.pendingSubscribers = [];
            }
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
        
        // Calculate stats
        const activeCount = data.subscribers.filter(s => s.status === 'Active' || !s.status).length;
        const requestedCount = data.subscribers.filter(s => s.status === 'Requested').length;
        // Count unique removed subscribers (removedActiveSubscribers are the source of truth)
        const removedCount = (data.removedActiveSubscribers || []).length;
        const totalSubscribers = data.subscribers.length + removedCount;
        
        // Create modal
        const modal = document.createElement('div');
        modal.id = 'viewDetailsModal';
        modal.className = 'view-details-modal-overlay';
        modal.innerHTML = `
            <div class="view-details-modal">
                <div class="view-details-modal-inner">
                    <div class="view-details-modal-header">
                        <div class="modal-header-content">
                            <div class="modal-header-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="8.5" cy="7" r="4"></circle>
                                    <path d="M20 8v6M23 11h-6"></path>
                                </svg>
                            </div>
                            <div class="modal-header-text">
                                <h2>Consumption Details</h2>
                                <p class="modal-header-subtitle">${data.adminPhone}</p>
                            </div>
                        </div>
                        <button class="modal-close-btn" onclick="this.closest('.view-details-modal-overlay').remove()" aria-label="Close">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="view-details-modal-stats">
                        <div class="stat-card">
                            <div class="stat-icon stat-icon-admin">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="12" cy="7" r="4"></circle>
                                </svg>
                            </div>
                            <div class="stat-content">
                                <div class="stat-label">Admin Usage</div>
                                <div class="stat-value">${data.adminConsumption.toFixed(2)} / ${data.adminLimit} GB</div>
                            </div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-icon stat-icon-total">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="9" cy="7" r="4"></circle>
                                    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>
                                </svg>
                            </div>
                            <div class="stat-content">
                                <div class="stat-label">Total Usage</div>
                                <div class="stat-value">${data.totalConsumption.toFixed(2)} / ${data.totalLimit} GB</div>
                            </div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-icon stat-icon-users">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="9" cy="7" r="4"></circle>
                                    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>
                                </svg>
                            </div>
                            <div class="stat-content">
                                <div class="stat-label">Subscribers</div>
                                <div class="stat-value">${totalSubscribers} <span class="stat-detail">${activeCount} active</span></div>
                            </div>
                        </div>
                    </div>
                    <div class="view-details-modal-body">
                        <div class="table-wrapper">
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
        const adminWhatsappNumber = data.adminPhone.startsWith('961') ? data.adminPhone : `961${data.adminPhone}`;
        const adminWhatsappUrl = `https://wa.me/${adminWhatsappNumber}`;
        const adminCopyId = `copy-btn-admin-${data.adminPhone.replace(/\s/g, '-')}`;
        rows += `
            <tr>
                <td>
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <a href="${adminWhatsappUrl}" target="_blank" style="text-decoration: none; display: flex; align-items: center;" title="Open WhatsApp chat"><img src="/assets/wlogo.png" alt="WhatsApp" style="width: 18px; height: 18px; object-fit: contain;" /></a>
                        <a href="${adminWhatsappUrl}" target="_blank" style="text-decoration: none; color: inherit; cursor: pointer;" title="Click to open WhatsApp chat">Admin - ${data.adminPhone}</a>
                        <button onclick="navigator.clipboard.writeText('${data.adminPhone}').then(() => { const btn = document.getElementById('${adminCopyId}'); if (btn) { const img = btn.querySelector('img'); if (img) { img.src = '/assets/copy.png'; img.style.opacity = '0.5'; setTimeout(() => { img.src = '/assets/copy.png'; img.style.opacity = '1'; }, 2000); } } })" id="${adminCopyId}" style="background: rgba(100, 116, 139, 0.1); border: none; padding: 0.375rem; border-radius: 50%; cursor: pointer; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; margin-left: 0.5rem; transition: all 0.2s ease;" title="Copy phone number" onmouseover="this.style.background='rgba(100, 116, 139, 0.2)'" onmouseout="this.style.background='rgba(100, 116, 139, 0.1)'"><img src="/assets/copy.png" alt="Copy" style="width: 16px; height: 16px; object-fit: contain; transition: opacity 0.2s ease;" /></button>
                    </div>
                </td>
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
        
        // Subscriber rows (confirmed subscribers from API)
        data.subscribers.forEach(sub => {
            // Check if this subscriber was removed (Active subscriber that was removed)
            const isRemoved = (data.removedSubscribers || []).includes(sub.phoneNumber);
            
            // Format phone number for WhatsApp (add 961 prefix if needed)
            const fullPhoneNumber = sub.fullPhoneNumber || sub.phoneNumber;
            const whatsappNumber = fullPhoneNumber.startsWith('961') ? fullPhoneNumber : `961${fullPhoneNumber}`;
            const whatsappUrl = `https://wa.me/${whatsappNumber}`;
            const uniqueId = `copy-btn-${sub.phoneNumber.replace(/\s/g, '-')}`;
            
            if (isRemoved) {
                // Show removed Active subscriber as "Out" in red with hashed styling and progress bar
                // Handle both field name formats: consumption/limit or usedConsumption/totalQuota
                const removedConsumption = sub.consumption !== undefined ? sub.consumption : 
                                          (sub.usedConsumption !== undefined ? sub.usedConsumption : 0);
                const removedLimit = sub.limit !== undefined ? sub.limit :
                                    (sub.quota !== undefined ? sub.quota :
                                    (sub.totalQuota !== undefined ? sub.totalQuota : 0));
                const removedPercent = removedLimit > 0 ? (removedConsumption / removedLimit) * 100 : 0;
                const removedProgressClass = removedPercent >= 100 ? 'progress-fill error' : 'progress-fill';
                
                rows += `
                    <tr style="opacity: 0.5; text-decoration: line-through;">
                        <td>
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <img src="/assets/wlogo.png" alt="WhatsApp" style="width: 18px; height: 18px; object-fit: contain;" />
                                <span style="color: #ef4444;">${sub.phoneNumber}</span>
                                <span style="color: #ef4444; font-weight: bold;">Out</span>
                                <button onclick="navigator.clipboard.writeText('${sub.phoneNumber}').then(() => { const btn = document.getElementById('${uniqueId}'); if (btn) { const img = btn.querySelector('img'); if (img) { img.style.opacity = '0.5'; setTimeout(() => { img.style.opacity = '1'; }, 2000); } } })" id="${uniqueId}" style="background: rgba(100, 116, 139, 0.1); border: none; padding: 0.375rem; border-radius: 50%; cursor: pointer; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; margin-left: 0.5rem; transition: all 0.2s ease;" title="Copy phone number" onmouseover="this.style.background='rgba(100, 116, 139, 0.2)'" onmouseout="this.style.background='rgba(100, 116, 139, 0.1)'"><img src="/assets/copy.png" alt="Copy" style="width: 16px; height: 16px; object-fit: contain; transition: opacity 0.2s ease;" /></button>
                            </div>
                        </td>
                        <td>
                            <div class="progress-container" style="opacity: 0.5;">
                                <div class="progress-bar">
                                    <div class="${removedProgressClass}" style="width: ${Math.min(100, removedPercent)}%"></div>
                                </div>
                                <div class="progress-text" style="color: #64748b;">${removedConsumption.toFixed(2)} / ${removedLimit} GB</div>
                            </div>
                        </td>
                    </tr>
                `;
            } else {
                // Normal subscriber display with status (Active/Requested)
                const subPercent = sub.limit > 0 ? (sub.consumption / sub.limit) * 100 : 0;
                const subProgressClass = subPercent >= 100 ? 'progress-fill error' : 'progress-fill';
                const status = sub.status || 'Active'; // 'Active' or 'Requested' from ushare HTML
                
                // Display status badge for both Active and Requested
                let statusBadge = '';
                if (status === 'Requested') {
                    statusBadge = '<span style="color: #f59e0b; font-weight: bold; margin-left: 0.5rem;" class="status-badge status-requested">Requested</span>';
                } else if (status === 'Active') {
                    statusBadge = '<span style="color: #10b981; font-weight: bold; margin-left: 0.5rem;" class="status-badge status-active">Active</span>';
                }
                
                // Debug: Log subscriber data being rendered
                console.log(`📊 [View Details] Rendering subscriber: ${sub.phoneNumber}, Status: "${status}", Has status property: ${'status' in sub}, Badge HTML: ${statusBadge.substring(0, 50)}...`);
                
                rows += `
                    <tr>
                        <td>
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <a href="${whatsappUrl}" target="_blank" style="text-decoration: none; display: flex; align-items: center;" title="Open WhatsApp chat"><img src="/assets/wlogo.png" alt="WhatsApp" style="width: 18px; height: 18px; object-fit: contain;" /></a>
                                <a href="${whatsappUrl}" target="_blank" style="text-decoration: none; color: inherit; cursor: pointer;" title="Click to open WhatsApp chat">${sub.phoneNumber}</a>
                                ${statusBadge}
                                <button onclick="navigator.clipboard.writeText('${sub.phoneNumber}').then(() => { const btn = document.getElementById('${uniqueId}'); if (btn) { const img = btn.querySelector('img'); if (img) { img.style.opacity = '0.5'; setTimeout(() => { img.style.opacity = '1'; }, 2000); } } })" id="${uniqueId}" style="background: rgba(100, 116, 139, 0.1); border: none; padding: 0.375rem; border-radius: 50%; cursor: pointer; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; margin-left: 0.5rem; transition: all 0.2s ease;" title="Copy phone number" onmouseover="this.style.background='rgba(100, 116, 139, 0.2)'" onmouseout="this.style.background='rgba(100, 116, 139, 0.1)'"><img src="/assets/copy.png" alt="Copy" style="width: 16px; height: 16px; object-fit: contain; transition: opacity 0.2s ease;" /></button>
                            </div>
                        </td>
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
            }
        });
        
        // Removed Active subscribers (no longer in ushare HTML but should still be displayed as "Out")
        // These are Active subscribers that were removed - they should appear with red color and "Out" label
        const removedActiveSubscribers = data.removedActiveSubscribers || [];
        console.log(`🔍 [View Details Modal] Checking removedActiveSubscribers: length=${removedActiveSubscribers.length}`, removedActiveSubscribers);
        if (removedActiveSubscribers.length > 0) {
            console.log(`✅ [View Details Modal] Found ${removedActiveSubscribers.length} removed active subscriber(s) to display as "Out"`);
            removedActiveSubscribers.forEach(removedSub => {
                // Check if this removed subscriber is already in data.subscribers (shouldn't happen, but check anyway)
                const isAlreadyShown = data.subscribers.some(sub => {
                    const subPhone = String(sub.phoneNumber || '').trim();
                    const removedPhone = String(removedSub.phoneNumber || '').trim();
                    return subPhone === removedPhone;
                });
                
                // Only show if not already displayed in subscribers list
                if (!isAlreadyShown) {
                    const fullPhoneNumber = removedSub.fullPhoneNumber || removedSub.phoneNumber;
                    const whatsappNumber = fullPhoneNumber.startsWith('961') ? fullPhoneNumber : `961${fullPhoneNumber}`;
                    const uniqueId = `copy-btn-removed-${removedSub.phoneNumber.replace(/\s/g, '-')}`;
                    
                    // Calculate progress for removed subscriber using last stored consumption from Firebase
                    // Handle both field name formats: consumption/limit or usedConsumption/totalQuota (for backward compatibility)
                    const removedConsumption = removedSub.consumption !== undefined ? removedSub.consumption : 
                                              (removedSub.usedConsumption !== undefined ? removedSub.usedConsumption : 0);
                    const removedLimit = removedSub.limit !== undefined ? removedSub.limit :
                                        (removedSub.quota !== undefined ? removedSub.quota :
                                        (removedSub.totalQuota !== undefined ? removedSub.totalQuota : 0));
                    const removedPercent = removedLimit > 0 ? (removedConsumption / removedLimit) * 100 : 0;
                    const removedProgressClass = removedPercent >= 100 ? 'progress-fill error' : 'progress-fill';
                    
                    // Show removed Active subscriber as "Out" in red with hashed styling and progress bar
                    rows += `
                        <tr style="opacity: 0.5; text-decoration: line-through;">
                            <td>
                                <div style="display: flex; align-items: center; gap: 0.5rem;">
                                    <img src="/assets/wlogo.png" alt="WhatsApp" style="width: 18px; height: 18px; object-fit: contain;" />
                                    <span style="color: #ef4444;">${removedSub.phoneNumber}</span>
                                    <span style="color: #ef4444; font-weight: bold;" class="status-badge status-out">Out</span>
                                    <button onclick="navigator.clipboard.writeText('${removedSub.phoneNumber}').then(() => { const btn = document.getElementById('${uniqueId}'); if (btn) { const img = btn.querySelector('img'); if (img) { img.style.opacity = '0.5'; setTimeout(() => { img.style.opacity = '1'; }, 2000); } } })" id="${uniqueId}" style="background: rgba(100, 116, 139, 0.1); border: none; padding: 0.375rem; border-radius: 50%; cursor: pointer; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; margin-left: 0.5rem; transition: all 0.2s ease;" title="Copy phone number" onmouseover="this.style.background='rgba(100, 116, 139, 0.2)'" onmouseout="this.style.background='rgba(100, 116, 139, 0.1)'"><img src="/assets/copy.png" alt="Copy" style="width: 16px; height: 16px; object-fit: contain; transition: opacity 0.2s ease;" /></button>
                                </div>
                            </td>
                            <td>
                                <div class="progress-container" style="opacity: 0.5;">
                                    <div class="progress-bar">
                                        <div class="${removedProgressClass}" style="width: ${Math.min(100, removedPercent)}%"></div>
                                    </div>
                                    <div class="progress-text" style="color: #64748b;">${removedConsumption.toFixed(2)} / ${removedLimit} GB</div>
                                </div>
                            </td>
                        </tr>
                    `;
                }
            });
        }
        
        // Pending subscriber rows (not yet accepted)
        // CRITICAL: Show pending subscribers that are NOT in Ushare HTML data
        // This handles newly added subscribers that haven't been fetched from Ushare HTML yet
        // Note: pendingSubscribers should be passed in data object from extractViewDetailsData
        const pendingSubscribersToShow = data.pendingSubscribers || [];
        if (pendingSubscribersToShow.length > 0) {
            pendingSubscribersToShow.forEach(pending => {
                const pendingPhone = String(pending.phone || '').trim();
                
                // Check if this pending subscriber is already in Ushare HTML data (data.subscribers)
                const isInUshareHtml = data.subscribers.some(sub => {
                    const subPhone = String(sub.phoneNumber || '').trim();
                    return subPhone === pendingPhone;
                });
                
                // Check if this pending subscriber was removed
                const isRemoved = (data.removedSubscribers || []).includes(pendingPhone);
                
                // Only show if:
                // 1. NOT in Ushare HTML data (newly added, not yet fetched)
                // 2. AND not removed
                if (!isInUshareHtml && !isRemoved) {
                    // Format phone number for WhatsApp (add 961 prefix if needed)
                    const pendingWhatsappNumber = pendingPhone.startsWith('961') ? pendingPhone : `961${pendingPhone}`;
                    const pendingWhatsappUrl = `https://wa.me/${pendingWhatsappNumber}`;
                    const pendingCopyId = `copy-btn-pending-${pendingPhone.replace(/\s/g, '-')}`;
                    
                    // Display pending subscriber without progress bar - just text
                    rows += `
                        <tr>
                            <td>
                                <div style="display: flex; align-items: center; gap: 0.5rem;">
                                    <a href="${pendingWhatsappUrl}" target="_blank" style="text-decoration: none; display: flex; align-items: center;" title="Open WhatsApp chat"><img src="/assets/wlogo.png" alt="WhatsApp" style="width: 18px; height: 18px; object-fit: contain;" /></a>
                                    <a href="${pendingWhatsappUrl}" target="_blank" style="text-decoration: none; color: inherit; cursor: pointer;" title="Click to open WhatsApp chat">${pending.phone}</a>
                                    <span style="color: #f59e0b; font-weight: bold; margin-left: 0.5rem;">[Requested]</span>
                                    <button onclick="navigator.clipboard.writeText('${pending.phone}').then(() => { const btn = document.getElementById('${pendingCopyId}'); if (btn) { const img = btn.querySelector('img'); if (img) { img.style.opacity = '0.5'; setTimeout(() => { img.style.opacity = '1'; }, 2000); } } })" id="${pendingCopyId}" style="background: rgba(100, 116, 139, 0.1); border: none; padding: 0.375rem; border-radius: 50%; cursor: pointer; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; margin-left: 0.5rem; transition: all 0.2s ease;" title="Copy phone number" onmouseover="this.style.background='rgba(100, 116, 139, 0.2)'" onmouseout="this.style.background='rgba(100, 116, 139, 0.1)'"><img src="/assets/copy.png" alt="Copy" style="width: 16px; height: 16px; object-fit: contain; transition: opacity 0.2s ease;" /></button>
                                </div>
                            </td>
                            <td>
                                <div style="padding: 0.5rem 0; color: #64748b;">Requested: ${pending.quota} GB</div>
                            </td>
                        </tr>
                    `;
                }
            });
        }
        
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
            <div class="dropdown-item" data-action="statement">
                <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
                    <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
                </svg>
                Statement
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
        } else if (action === 'statement') {
            this.showStatement(id);
        }
    }
    
    async showStatement(adminId) {
        // Show modal immediately with loading state
        this.createStatementModal(adminId, null); // null = loading state
        
        try {
            // Fetch balance history from backend
            // Get backend base URL from config
            const baseURL = window.AEFA_API_URL || window.ALFA_API_URL || 'https://cell-spott-manage-backend.onrender.com';
            const response = await fetch(`${baseURL}/api/admin/${adminId}/balance-history`);
            const result = await response.json();
            
            if (!result.success) {
                console.error('❌ Error fetching balance history:', result.error);
                this.updateStatementModal(adminId, [], 'error');
                return;
            }
            
            const balanceHistory = result.data || [];
            
            // Update modal with data
            this.updateStatementModal(adminId, balanceHistory);
        } catch (error) {
            console.error('❌ Error showing statement:', error);
            this.updateStatementModal(adminId, [], 'error');
        }
    }
    
    createStatementModal(adminId, balanceHistory) {
        // Remove existing modal if any
        const existingModal = document.getElementById('statementModal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Find admin name
        const admin = this.subscribers.find(s => s.id === adminId);
        const adminName = admin ? admin.name : 'Admin';
        
        // Determine content based on state
        let content = '';
        if (balanceHistory === null) {
            // Loading state
            content = `
                <div class="statement-loading">
                    <div class="statement-spinner"></div>
                    <p>Loading balance history...</p>
                </div>
            `;
        } else if (balanceHistory.length === 0) {
            // Empty state
            content = `
                <div class="statement-empty">
                    <p>No balance history available yet.</p>
                    <p class="statement-empty-hint">Balance history will appear here after successful refreshes.</p>
                </div>
            `;
        } else {
            // Data state
            content = `
                <div class="statement-table">
                    <div class="statement-table-header">
                        <div class="statement-col-date">Date</div>
                        <div class="statement-col-balance">Balance</div>
                    </div>
                    <div class="statement-table-body">
                        ${balanceHistory.map(entry => {
                            const dateTime = this.formatDateTime(new Date(entry.timestamp || entry.date));
                            return `
                                <div class="statement-table-row">
                                    <div class="statement-col-date">${dateTime.date} ${dateTime.time}</div>
                                    <div class="statement-col-balance">${this.escapeHtml(entry.balance || 'N/A')}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        
        // Create modal
        const modal = document.createElement('div');
        modal.id = 'statementModal';
        modal.className = 'statement-modal-overlay';
        modal.innerHTML = `
            <div class="statement-modal-container">
                <div class="statement-modal-header">
                    <h3>Statement - ${this.escapeHtml(adminName)}</h3>
                    <button class="statement-modal-close" aria-label="Close">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="statement-modal-content">
                    ${content}
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Add event listeners
        const closeBtn = modal.querySelector('.statement-modal-close');
        closeBtn.addEventListener('click', () => {
            modal.remove();
        });
        
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
    
    updateStatementModal(adminId, balanceHistory, error = null) {
        const modal = document.getElementById('statementModal');
        if (!modal) return;
        
        const contentDiv = modal.querySelector('.statement-modal-content');
        if (!contentDiv) return;
        
        let content = '';
        if (error === 'error') {
            content = `
                <div class="statement-empty">
                    <p>Failed to load balance history.</p>
                    <p class="statement-empty-hint">Please try again later.</p>
                </div>
            `;
        } else if (balanceHistory.length === 0) {
            content = `
                <div class="statement-empty">
                    <p>No balance history available yet.</p>
                    <p class="statement-empty-hint">Balance history will appear here after successful refreshes.</p>
                </div>
            `;
        } else {
            content = `
                <div class="statement-table">
                    <div class="statement-table-header">
                        <div class="statement-col-date">Date</div>
                        <div class="statement-col-balance">Balance</div>
                    </div>
                    <div class="statement-table-body">
                        ${balanceHistory.map(entry => {
                            const dateTime = this.formatDateTime(new Date(entry.timestamp || entry.date));
                            return `
                                <div class="statement-table-row">
                                    <div class="statement-col-date">${dateTime.date} ${dateTime.time}</div>
                                    <div class="statement-col-balance">${this.escapeHtml(entry.balance || 'N/A')}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        
        contentDiv.innerHTML = content;
    }
    
    async refreshSubscriber(id) {
        // CRITICAL: Verify ownership before refreshing
        const currentUserId = this.getCurrentUserId();
        if (!currentUserId) {
            alert('Error: You must be logged in to refresh admins.');
            return;
        }
        
        // Find the subscriber in our data
        const subscriber = this.subscribers.find(s => s.id === id);
        if (!subscriber) {
            console.error('Subscriber not found:', id);
            return;
        }
        
        // CRITICAL: Verify ownership
        if (subscriber.userId && subscriber.userId !== currentUserId) {
            alert('Error: You do not have permission to refresh this admin.');
            return;
        }
        
        // Capture the refresh timestamp when user initiates the refresh (client-side time)
        const refreshInitiatedAt = Date.now();
        console.log('🔄 Refresh initiated at:', new Date(refreshInitiatedAt).toLocaleString(), 'timestamp:', refreshInitiatedAt);
        
        try {
            console.log('Refreshing subscriber:', id);
            
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
                adminConsumptionValue: alfaData.adminConsumption,
                subscribersCount: alfaData.subscribersCount,
                subscribersActiveCount: alfaData.subscribersActiveCount,
                subscribersRequestedCount: alfaData.subscribersRequestedCount
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
                
                // CRITICAL: Ensure userId is preserved when updating (not overwritten)
                // Get current document to preserve userId
                const currentUserId = this.getCurrentUserId();
                let currentDocData = {};
                try {
                    const currentDoc = await db.collection('admins').doc(id).get();
                    if (currentDoc.exists()) {
                        currentDocData = currentDoc.data();
                        // Verify ownership one more time
                        if (currentDocData.userId && currentDocData.userId !== currentUserId) {
                            throw new Error('Permission denied: Admin does not belong to current user');
                        }
                    }
                } catch (docError) {
                    console.warn('⚠️ Could not verify ownership before update:', docError.message);
                    // Continue anyway - merge: true will preserve existing userId
                }
                
                await db.collection('admins').doc(id).set({
                    userId: currentDocData.userId || currentUserId, // Preserve existing userId or use current
                    alfaData: alfaData,
                    alfaDataFetchedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    lastRefreshTimestamp: refreshTimestamp // Store the client-side refresh timestamp (milliseconds)
                }, { merge: true });
                
                console.log('✅ Successfully saved lastRefreshTimestamp to Firebase');
            } catch (updateError) {
                // If Firebase save fails (e.g., permission errors), still update local data
                console.warn('⚠️ Failed to save to Firebase (may have permission errors):', updateError.message);
                console.log('📦 Will update local data directly from API response to ensure UI shows correct values');
            }
            
            // CRITICAL: Immediately update the subscriber in our local data with API response - don't wait for Firebase
            // This ensures the UI shows the correct data immediately, even if Firebase save fails
            const subscriberIndex = this.subscribers.findIndex(s => s.id === id);
            if (subscriberIndex !== -1) {
                // Create new Date object from the refresh timestamp
                const newLastUpdate = new Date(refreshTimestamp);
                const now = Date.now();
                
                // Store the old value for comparison
                const oldLastUpdate = this.subscribers[subscriberIndex].lastUpdate;
                
                // CRITICAL: Store in persistent cache FIRST - this survives Firebase listener updates
                // CRITICAL: Include adminId to prevent cross-admin contamination
                this.recentManualUpdates.set(id, {
                    timestamp: newLastUpdate,
                    setAt: now,
                    adminId: id // Store admin ID to verify ownership
                });
                console.log('💾 Stored manual lastUpdate in cache for:', id, newLastUpdate.toLocaleString(), `(adminId: ${id})`);
                
                // CRITICAL: Update subscriber with API response data immediately
                // This ensures adminConsumption and other fields are updated even if Firebase save fails
                // Process the alfaData to extract consumption values (same logic as processSubscribers)
                const updatedSubscriber = { ...this.subscribers[subscriberIndex] };
                updatedSubscriber.lastUpdate = newLastUpdate;
                
                // Update alfaData in subscriber object so it's available for extraction
                if (alfaData) {
                    updatedSubscriber.alfaData = alfaData;
                    
                    // Extract totalConsumption and adminConsumption from alfaData (same as processSubscribers)
                    if (alfaData.totalConsumption) {
                        // Parse consumption string (e.g., "58.97 / 77")
                        const consumptionStr = String(alfaData.totalConsumption).trim();
                        const match = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                        if (match) {
                            const used = parseFloat(match[1]) || 0;
                            const total = parseFloat(match[2]) || 0;
                            if (used > 0) {
                                updatedSubscriber.totalConsumption = used;
                                updatedSubscriber.totalLimit = total || updatedSubscriber.totalLimit;
                                console.log(`✅ [${id}] Updated totalConsumption from API response: ${used} / ${total}`);
                            }
                        }
                    }
                    
                    if (alfaData.adminConsumption) {
                        const adminConsumptionStr = String(alfaData.adminConsumption).trim();
                        const matchWithoutLimit = adminConsumptionStr.match(/^([\d.]+)\s*(GB|MB)/i);
                        if (matchWithoutLimit) {
                            let adminConsumptionValue = parseFloat(matchWithoutLimit[1]) || 0;
                            // Convert MB to GB if needed
                            if (matchWithoutLimit[2].toUpperCase() === 'MB') {
                                adminConsumptionValue = adminConsumptionValue / 1024;
                            }
                            updatedSubscriber.adminConsumption = adminConsumptionValue;
                            console.log(`✅ [${id}] Updated adminConsumption from API response: ${adminConsumptionValue} GB`);
                        }
                    }
                }
                
                // CRITICAL: Use immutable updates - create new objects instead of mutating
                // CRITICAL: This prevents cross-admin contamination
                // Update subscribers array with immutable update
                this.subscribers = this.subscribers.map((sub, idx) => {
                    if (idx === subscriberIndex && sub.id === id) {
                        // CRITICAL: Only update if IDs match - prevent cross-admin contamination
                        return updatedSubscriber;
                    }
                    return sub; // Return unchanged for all other admins
                });
                
                // Update filteredSubscribers array with immutable update
                const filteredIndex = this.filteredSubscribers.findIndex(s => s.id === id);
                if (filteredIndex !== -1) {
                    this.filteredSubscribers = this.filteredSubscribers.map((sub, idx) => {
                        if (idx === filteredIndex && sub.id === id) {
                            // CRITICAL: Only update if IDs match - prevent cross-admin contamination
                            return updatedSubscriber;
                        }
                        return sub; // Return unchanged for all other admins
                    });
                }
                
                console.log('🔄 UPDATING lastUpdate:', {
                    subscriberId: id,
                    refreshTimestamp: refreshTimestamp,
                    newDate: newLastUpdate.toISOString(),
                    newLocal: newLastUpdate.toLocaleString(),
                    oldLocal: oldLastUpdate instanceof Date ? oldLastUpdate.toLocaleString() : 'N/A',
                    timestamp: newLastUpdate.getTime(),
                    cached: true
                });
                
                // Re-render immediately to show the updated timestamp
                this.renderTable();
                
                // Verify it was updated correctly
                const verifyUpdate = this.subscribers.find(s => s.id === id);
                const verifyFiltered = this.filteredSubscribers.find(s => s.id === id);
                const verifyCache = this.recentManualUpdates.get(id);
                console.log('✅ VERIFIED update:', {
                    subscriberId: id,
                    subscribersArray: verifyUpdate?.lastUpdate instanceof Date ? verifyUpdate.lastUpdate.toLocaleString() : verifyUpdate?.lastUpdate,
                    filteredArray: verifyFiltered?.lastUpdate instanceof Date ? verifyFiltered.lastUpdate.toLocaleString() : verifyFiltered?.lastUpdate,
                    cache: verifyCache ? verifyCache.timestamp.toLocaleString() : 'N/A',
                    formatted: this.formatDateTime(verifyUpdate?.lastUpdate),
                    timestampsMatch: verifyUpdate?.lastUpdate?.getTime() === newLastUpdate.getTime(),
                    cacheMatch: verifyCache && verifyCache.timestamp.getTime() === newLastUpdate.getTime()
                });
            } else {
                console.warn('⚠️ Subscriber not found in subscribers array:', id);
            }
            
            console.log('Alfa data refreshed successfully');
            
            // Show success notification
            if (typeof notification !== 'undefined') {
                notification.set({ delay: 2000 });
                notification.success('Refresh completed successfully');
            }
            
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
            
            // Show error notification
            if (typeof notification !== 'undefined') {
                notification.set({ delay: 3000 });
                notification.error('Refresh failed: ' + (errorMessage.length > 50 ? errorMessage.substring(0, 50) + '...' : errorMessage));
            } else {
                // Fallback to alert if notification system not loaded
                alert('Failed to refresh data: ' + errorMessage);
            }
            
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
        // Open Edit Subscribers modal instead of navigating to admin edit
        this.openEditSubscribersModal(id);
    }
    
    async openEditSubscribersModal(adminId) {
        const modal = document.getElementById('editSubscribersModal');
        if (!modal) {
            console.error('Edit Subscribers modal not found');
            return;
        }
        
        // Find the admin/subscriber data
        const subscriber = this.subscribers.find(s => s.id === adminId);
        if (!subscriber) {
            console.error('Subscriber not found:', adminId);
            return;
        }
        
        // Store current admin ID
        this.editingAdminId = adminId;
        // No session ID needed (stateless API)
        
        // Show modal with loading state
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
        
        // Show loading spinner
        this.showEditModalLoading();
        
        try {
            // Fetch Ushare data using new API-only endpoint (no Puppeteer)
            console.log('🔄 Fetching subscriber data...');
            
            // Use AlfaAPIService to get Ushare data (JWT-protected)
            const ushareResponse = await window.AlfaAPIService.getUshare(adminId, false); // useQueue = false for immediate response
            
            // Check if response was queued
            if (ushareResponse.queued) {
                throw new Error('Request was queued. Please try again in a moment.');
            }
            
            // Transform response format: { number, results, summary } -> { subscribers: results }
            // The modal expects: { subscribers: [{ phoneNumber, usedConsumption, totalQuota, status }] }
            const ushareData = {
                subscribers: ushareResponse.results || []
            };
            
            // Hide loading
            this.hideEditModalLoading();
            
            // Initialize modal with fresh Ushare data
            this.initEditSubscribersModalWithUshareData(subscriber, ushareData);
            
            console.log('✅ Subscriber data loaded, modal ready');
        } catch (error) {
            console.error('❌ Error loading subscriber data:', error);
            this.hideEditModalLoading();
            alert(`Failed to load subscriber data: ${error.message}`);
            this.closeEditSubscribersModal();
        }
    }
    
    showEditModalLoading(message = 'Processing...') {
        const modal = document.getElementById('editSubscribersModal');
        if (!modal) return;
        
        const modalContainer = modal.querySelector('.edit-subscribers-modal-container');
        if (!modalContainer) return;
        
        // Ensure modal container has relative positioning
        modalContainer.style.position = 'relative';
        
        // Create or show loading overlay
        let loadingOverlay = modalContainer.querySelector('.edit-modal-loading');
        if (!loadingOverlay) {
            loadingOverlay = document.createElement('div');
            loadingOverlay.className = 'edit-modal-loading';
            modalContainer.appendChild(loadingOverlay);
        }
        
        // Update loading message
        loadingOverlay.innerHTML = `
            <div class="edit-modal-loading-spinner">
                <div class="refresh-loading">
                    <div class="loader">
                        <div class="inner one"></div>
                        <div class="inner two"></div>
                        <div class="inner three"></div>
                    </div>
                </div>
                <p>${message}</p>
            </div>
        `;
        loadingOverlay.style.display = 'flex';
    }
    
    hideEditModalLoading() {
        const modal = document.getElementById('editSubscribersModal');
        if (!modal) return;
        
        const modalContainer = modal.querySelector('.edit-subscribers-modal-container');
        if (!modalContainer) return;
        
        const loadingOverlay = modalContainer.querySelector('.edit-modal-loading');
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
    }
    
    initEditSubscribersModalWithUshareData(subscriber, ushareData) {
        // Set admin info
        const adminInfoEl = document.getElementById('editSubscribersAdminInfo');
        if (adminInfoEl) {
            adminInfoEl.innerHTML = `
                <h6 class="edit-subscribers-admin-name">${this.escapeHtml(subscriber.name)} - ${this.escapeHtml(subscriber.phone)} (${subscriber.quota || 0} GB)</h6>
            `;
        }
        
        // Load subscribers from Ushare data
        const itemsContainer = document.getElementById('editSubscribersItems');
        if (!itemsContainer) return;
        
        itemsContainer.innerHTML = '';
        
        // Add subscribers from Ushare data
        if (ushareData.subscribers && Array.isArray(ushareData.subscribers)) {
            ushareData.subscribers.forEach((sub, index) => {
                const isPending = sub.status === 'Requested';
                const itemHtml = this.createEditSubscriberItem(
                    sub.phoneNumber,
                    sub.usedConsumption || 0,
                    sub.totalQuota || 0,
                    index,
                    isPending
                );
                itemsContainer.insertAdjacentHTML('beforeend', itemHtml);
            });
        }
        
        // Bind events
        this.bindEditSubscribersEvents();
        
        // Update add button state
        this.updateEditAddSubscriberButtonState();
    }
    
    closeEditSubscribersModal() {
        const modal = document.getElementById('editSubscribersModal');
        if (modal) {
            modal.classList.remove('show');
            document.body.style.overflow = '';
        }
        this.editingAdminId = null;
    }
    
    initEditSubscribersModal(subscriber) {
        // Set admin info
        const adminInfoEl = document.getElementById('editSubscribersAdminInfo');
        if (adminInfoEl) {
            adminInfoEl.innerHTML = `
                <h6 class="edit-subscribers-admin-name">${this.escapeHtml(subscriber.name)} - ${this.escapeHtml(subscriber.phone)} (${subscriber.quota || 0} GB)</h6>
            `;
        }
        
        // Load existing subscribers (confirmed and pending)
        this.loadSubscribersIntoEditModal(subscriber);
        
        // Bind event listeners
        this.bindEditSubscribersEvents();
    }
    
    loadSubscribersIntoEditModal(subscriber) {
        const itemsContainer = document.getElementById('editSubscribersItems');
        if (!itemsContainer) return;
        
        itemsContainer.innerHTML = '';
        
        // Get subscribers from View Details data
        const viewData = this.extractViewDetailsData(subscriber);
        
        // Add confirmed subscribers
        viewData.subscribers.forEach((sub, index) => {
            const itemHtml = this.createEditSubscriberItem(sub.phoneNumber, sub.consumption, sub.limit, index, false);
            itemsContainer.insertAdjacentHTML('beforeend', itemHtml);
        });
        
        // Add pending subscribers
        if (viewData.pendingSubscribers && Array.isArray(viewData.pendingSubscribers)) {
            viewData.pendingSubscribers.forEach((pending, index) => {
                const itemHtml = this.createEditSubscriberItem(pending.phoneNumber || pending.phone, 0, pending.quota, viewData.subscribers.length + index, true);
                itemsContainer.insertAdjacentHTML('beforeend', itemHtml);
            });
        }
        
        // Bind events after loading
        this.bindEditSubscribersEvents();
        
        // Update add button state after loading subscribers
        this.updateEditAddSubscriberButtonState();
    }
    
    createEditSubscriberItem(phone, consumption, quota, index, isPending) {
        return `
            <div class="edit-subscriber-item" data-index="${index}" data-phone="${phone}" data-pending="${isPending}">
                <div class="edit-subscriber-fields">
                    <div class="edit-subscriber-field">
                        <label>Subscriber</label>
                        <input type="tel" name="items[${index}].subscriber" value="${phone}" readonly disabled class="edit-subscriber-input readonly">
                    </div>
                    <div class="edit-subscriber-field">
                        <label>Consumption</label>
                        <input type="number" name="items[${index}].consumption" value="${consumption.toFixed(2)}" readonly disabled class="edit-subscriber-input readonly">
                    </div>
                    <div class="edit-subscriber-field">
                        <label>Quota</label>
                        <input type="number" step="any" name="items[${index}].quota" value="${quota}" ${isPending ? 'readonly disabled' : ''} class="edit-subscriber-input ${isPending ? 'readonly' : ''}">
                    </div>
                </div>
                ${isPending ? '<span class="edit-subscriber-pending-badge">Requested</span>' : ''}
                <button type="button" class="edit-subscriber-remove-btn" data-index="${index}" data-phone="${phone}">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                    Remove
                </button>
            </div>
            <hr class="edit-subscriber-divider">
        `;
    }
    
    bindEditSubscribersEvents() {
        // Close button - ensure it works properly
        const closeBtn = document.querySelector('.edit-subscribers-close');
        if (closeBtn) {
            // Remove onclick attribute and use event listener instead
            closeBtn.removeAttribute('onclick');
            closeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.closeEditSubscribersModal();
            }, { capture: true });
        }
        
        // Remove subscriber button
        document.querySelectorAll('.edit-subscriber-remove-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = e.currentTarget.dataset.index;
                this.removeEditSubscriberItem(index);
            });
        });
        
        // Add subscriber button
        const addBtn = document.getElementById('editSubscribersAddBtn');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                this.addEditSubscriberItem();
            });
            // Update button state initially
            this.updateEditAddSubscriberButtonState();
        }
        
        // Form submit
        const form = document.getElementById('editSubscribersForm');
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleEditSubscribersSubmit();
            });
        }
        
        // Close on overlay click
        const modal = document.getElementById('editSubscribersModal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeEditSubscribersModal();
                }
            });
        }
    }
    
    removeEditSubscriberItem(index) {
        const itemsContainer = document.getElementById('editSubscribersItems');
        if (!itemsContainer) return;
        
        // Allow removing all subscribers - user can remove all if needed
        // Removed the check that prevented removing all subscribers
        
        const item = document.querySelector(`.edit-subscriber-item[data-index="${index}"]`);
        if (item) {
            // Get subscriber phone for confirmation message
            const subscriberInput = item.querySelector('input[name*="subscriber"]');
            const subscriberPhone = subscriberInput ? subscriberInput.value.trim() : 'this subscriber';
            
            // Ask for confirmation before removing
            if (!confirm(`Are you sure you want to remove ${subscriberPhone}?`)) {
                return; // User cancelled
            }
            
            const divider = item.nextElementSibling;
            if (divider && divider.classList.contains('edit-subscriber-divider')) {
                divider.remove();
            }
            item.remove();
            this.reindexEditSubscriberItems();
            // Update add button state after removing an item
            this.updateEditAddSubscriberButtonState();
        }
    }
    
    addEditSubscriberItem() {
        // Open admin selector to choose which admin to share with (same as Add Subscribers modal)
        // For now, we'll add a simple input row, but ideally should open admin selector
        const itemsContainer = document.getElementById('editSubscribersItems');
        if (!itemsContainer) return;
        
        // Limit to maximum 3 subscriber rows
        const MAX_SUBSCRIBERS = 3;
        const existingItems = itemsContainer.querySelectorAll('.edit-subscriber-item');
        if (existingItems.length >= MAX_SUBSCRIBERS) {
            console.log(`⚠️ Maximum ${MAX_SUBSCRIBERS} subscribers allowed`);
            return;
        }
        
        // Find the highest index
        let maxIndex = -1;
        existingItems.forEach(item => {
            const idx = parseInt(item.dataset.index) || 0;
            if (idx > maxIndex) maxIndex = idx;
        });
        const newIndex = maxIndex + 1;
        
        // Create a new row with editable subscriber phone number input
        const itemHtml = `
            <div class="edit-subscriber-item" data-index="${newIndex}" data-phone="" data-pending="false" data-is-new="true">
                <div class="edit-subscriber-fields">
                    <div class="edit-subscriber-field">
                        <label>Subscriber</label>
                        <input type="tel" name="items[${newIndex}].subscriber" value="" placeholder="Enter phone number (8 digits)" class="edit-subscriber-input" data-item-index="${newIndex}">
                    </div>
                    <div class="edit-subscriber-field">
                        <label>Consumption</label>
                        <input type="number" name="items[${newIndex}].consumption" value="0" readonly disabled class="edit-subscriber-input readonly">
                    </div>
                    <div class="edit-subscriber-field">
                        <label>Quota</label>
                        <input type="number" step="any" name="items[${newIndex}].quota" value="0" class="edit-subscriber-input" placeholder="Enter quota">
                    </div>
                </div>
                <button type="button" class="edit-subscriber-remove-btn" data-index="${newIndex}" data-phone="">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                    Remove
                </button>
            </div>
            <hr class="edit-subscriber-divider">
        `;
        itemsContainer.insertAdjacentHTML('beforeend', itemHtml);
        
        // Re-bind events for the new item
        const newItem = itemsContainer.querySelector(`.edit-subscriber-item[data-index="${newIndex}"]`);
        if (newItem) {
            const removeBtn = newItem.querySelector('.edit-subscriber-remove-btn');
            if (removeBtn) {
                removeBtn.addEventListener('click', (e) => {
                    this.removeEditSubscriberItem(newIndex);
                });
            }
            
            // Subscriber input is now editable - no admin selector needed
            // User can directly type the phone number
        }
        
        // Update add button state after adding an item
        this.updateEditAddSubscriberButtonState();
    }
    
    updateEditAddSubscriberButtonState() {
        const itemsContainer = document.getElementById('editSubscribersItems');
        const addBtn = document.getElementById('editSubscribersAddBtn');
        const MAX_SUBSCRIBERS = 3;
        
        if (!itemsContainer || !addBtn) return;
        
        const existingItems = itemsContainer.querySelectorAll('.edit-subscriber-item');
        const currentCount = existingItems.length;
        
        if (currentCount >= MAX_SUBSCRIBERS) {
            // Hide the button completely when limit is reached
            addBtn.style.display = 'none';
        } else {
            // Show the button when below limit
            addBtn.style.display = '';
        }
    }
    
    openAdminSelectorForEditItem(itemIndex) {
        // Open admin selector modal (reuse existing functionality)
        // Get active admins that match "Available Services" criteria (excluding the current admin being edited)
        const activeAdmins = this.subscribers.filter(s => 
            this.isAdminAvailableService(s) &&
            s.id !== this.editingAdminId &&
            s.notUShare !== true
        );
        
        if (activeAdmins.length === 0) {
            alert('No active admins available to share with.');
            return;
        }
        
        // Store the item index for when admin is selected
        this.editingItemIndex = itemIndex;
        
        // Populate and show admin selector
        // Use a dummy itemIndex for the modal, but we'll check editingItemIndex in selectAdmin
        const modal = document.getElementById('adminSelectorModal');
        if (modal) {
            modal.dataset.itemIndex = itemIndex; // Store for compatibility
        }
        
        this.populateAdminSelector(activeAdmins);
        
        // Bind close button
        const closeBtn = modal?.querySelector('.admin-selector-close');
        if (closeBtn) {
            closeBtn.removeAttribute('onclick');
            closeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.closeAdminSelector();
            }, { capture: true });
        }
        
        // Show the modal
        if (modal) {
            modal.classList.add('show');
            document.body.style.overflow = 'hidden';
        }
    }
    
    reindexEditSubscriberItems() {
        const itemsContainer = document.getElementById('editSubscribersItems');
        if (!itemsContainer) return;
        
        const items = Array.from(itemsContainer.querySelectorAll('.edit-subscriber-item'));
        items.forEach((item, newIndex) => {
            const oldIndex = item.dataset.index;
            item.dataset.index = newIndex;
            
            // Update input names
            item.querySelectorAll('input').forEach(input => {
                const name = input.name;
                if (name) {
                    input.name = name.replace(`[${oldIndex}]`, `[${newIndex}]`);
                }
            });
            
            // Update remove button data-index
            const removeBtn = item.querySelector('.edit-subscriber-remove-btn');
            if (removeBtn) {
                removeBtn.dataset.index = newIndex;
            }
        });
    }
    
    async handleEditSubscribersSubmit() {
        // Prevent duplicate submissions
        if (this.isSubmittingEditForm) {
            console.log('⏸️ Form submission already in progress, ignoring duplicate request');
            return;
        }
        
        if (!this.editingAdminId) {
            console.error('No admin ID set for editing');
            return;
        }
        
        this.isSubmittingEditForm = true;
        
        // Show loading animation
        this.showEditModalLoading('Processing subscriber changes...');
        
        // Disable submit button to prevent multiple clicks
        const submitButton = document.querySelector('#editSubscribersForm button[type="submit"]');
        let originalButtonText = '';
        if (submitButton) {
            originalButtonText = submitButton.textContent;
            submitButton.disabled = true;
            submitButton.textContent = 'Processing...';
        }
        
        try {
            const itemsContainer = document.getElementById('editSubscribersItems');
            if (!itemsContainer) {
                this.isSubmittingEditForm = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = originalButtonText;
                }
                return;
            }
            
            const items = Array.from(itemsContainer.querySelectorAll('.edit-subscriber-item'));
            const updates = [];
            const removals = [];
            const additions = [];
            
            // Get original subscriber data to compare
            const subscriber = this.subscribers.find(s => s.id === this.editingAdminId);
            if (!subscriber) {
                console.error('Subscriber not found');
                this.isSubmittingEditForm = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = originalButtonText;
                }
                return;
            }
            
            const viewData = this.extractViewDetailsData(subscriber);
            const originalSubscribers = viewData.subscribers.map(s => s.phoneNumber);
            const originalPending = (viewData.pendingSubscribers || []).map(p => p.phoneNumber || p.phone);
            
            // Collect data from form
            items.forEach((item) => {
            const subscriberInput = item.querySelector('input[name*="subscriber"]');
            const quotaInput = item.querySelector('input[name*="quota"]');
            const isPending = item.dataset.pending === 'true';
            const originalPhone = item.dataset.phone;
            const isNew = item.dataset.isNew === 'true';
            
            if (subscriberInput && quotaInput) {
                const phone = subscriberInput.value.trim();
                const quota = parseFloat(quotaInput.value) || 0;
                
                if (!phone) return; // Skip empty rows
                
                if (isNew) {
                    // New subscriber to add
                    additions.push({ phone, quota });
                } else if (originalPhone && originalPhone !== phone) {
                    // Phone changed - treat as removal + addition
                    removals.push(originalPhone);
                    additions.push({ phone, quota });
                } else if (originalPhone && originalPhone === phone) {
                    // Existing subscriber - check if quota changed
                    const originalQuota = isPending 
                        ? (viewData.pendingSubscribers.find(p => (p.phoneNumber || p.phone) === phone)?.quota || 0)
                        : (viewData.subscribers.find(s => s.phoneNumber === phone)?.limit || 0);
                    
                    if (quota !== originalQuota) {
                        updates.push({ phone, quota });
                    }
                }
            }
            });
            
            // Find removed subscribers (in original but not in form)
            const currentPhones = items
                .map(item => {
                    const input = item.querySelector('input[name*="subscriber"]');
                    return input ? input.value.trim() : '';
                })
                .filter(phone => phone);
            
            originalSubscribers.forEach(phone => {
                if (!currentPhones.includes(phone)) {
                    removals.push(phone);
                }
            });
            
            originalPending.forEach(phone => {
                if (!currentPhones.includes(phone)) {
                    removals.push(phone);
                }
            });
        
            // Allow removing all subscribers - user can remove all if needed
            // Removed the check that prevented removing all subscribers
            const totalSubscribers = currentPhones.length + additions.length;
            
            // No need to ask for confirmation again - user already confirmed when clicking remove button
            
            // Call backend API using new individual endpoints (JWT-protected, no Puppeteer)
            try {
                const adminId = this.editingAdminId;
                const results = {
                    additions: [],
                    updates: [],
                    removals: []
                };
                
                // Process additions
                for (const addition of additions) {
                    try {
                        await window.AlfaAPIService.addSubscriber(adminId, addition.phone, addition.quota);
                        results.additions.push({ phone: addition.phone, success: true });
                    } catch (error) {
                        console.error(`❌ Failed to add subscriber ${addition.phone}:`, error);
                        results.additions.push({ phone: addition.phone, success: false, error: error.message });
                    }
                }
                
                // Process updates
                for (const update of updates) {
                    try {
                        await window.AlfaAPIService.editSubscriber(adminId, update.phone, update.quota);
                        results.updates.push({ phone: update.phone, success: true });
                    } catch (error) {
                        console.error(`❌ Failed to update subscriber ${update.phone}:`, error);
                        results.updates.push({ phone: update.phone, success: false, error: error.message });
                    }
                }
                
                // Process removals in parallel for better performance
                // IMPORTANT: Start all deletion requests simultaneously, don't wait for one to finish before starting the next
                if (removals.length > 0) {
                    console.log(`🔄 [Delete] Starting ${removals.length} deletion(s) in parallel...`);
                    // Create all promises immediately - they all start executing right away
                    const removalPromises = removals.map((phone, index) => {
                        console.log(`🚀 [Delete] Starting deletion ${index + 1}/${removals.length} for ${phone}`);
                        // Return the promise directly - don't await here, let Promise.all handle it
                        return window.AlfaAPIService.removeSubscriber(adminId, phone, true)
                            .then(() => {
                                console.log(`✅ [Delete] Completed deletion ${index + 1}/${removals.length} for ${phone}`);
                                return { phone, success: true };
                            })
                            .catch((error) => {
                                console.error(`❌ Failed to remove subscriber ${phone}:`, error);
                                return { phone, success: false, error: error.message };
                            });
                    });
                    // Wait for all deletions to complete (they run in parallel)
                    results.removals = await Promise.all(removalPromises);
                    console.log(`✅ [Delete] All ${removals.length} deletion(s) completed`);
                }
                
                // Check if all operations succeeded
                const allSuccess = 
                    results.additions.every(r => r.success) &&
                    results.updates.every(r => r.success) &&
                    results.removals.every(r => r.success);
                
                if (allSuccess) {
                    console.log('✅ Subscribers updated successfully');
                    
                    // Copy success message to clipboard if there are additions
                    if (results.additions.length > 0) {
                        const firstAddition = results.additions.find(r => r.success);
                        if (firstAddition && subscriber) {
                            const adminPhone = subscriber.phone || '';
                            const message = `Send ${adminPhone} to 1323`;
                            try {
                                await navigator.clipboard.writeText(message);
                                console.log('✅ Copied to clipboard:', message);
                            } catch (clipError) {
                                console.warn('Failed to copy to clipboard:', clipError);
                            }
                        }
                    }
                    
                    // Build success message
                    const messages = [];
                    if (results.additions.length > 0) {
                        messages.push(`Added ${results.additions.length} subscriber(s)`);
                    }
                    if (results.updates.length > 0) {
                        messages.push(`Updated ${results.updates.length} subscriber(s)`);
                    }
                    if (results.removals.length > 0) {
                        messages.push(`Removed ${results.removals.length} subscriber(s)`);
                    }
                    
                    const successMessage = messages.length > 0 
                        ? `✅ Successfully ${messages.join(', ')}!`
                        : '✅ Subscribers updated successfully!';
                    
                    alert(successMessage);
                    
                    // Close the modal
                    this.closeEditSubscribersModal();
                    
                    // Note: No automatic refresh - user can refresh manually if needed
                } else {
                    // Some operations failed - copy cancel message
                    const cancelMessage = `Cancel old service\n*111*7*2*1*2*1#`;
                    try {
                        await navigator.clipboard.writeText(cancelMessage);
                        console.log('✅ Copied to clipboard:', cancelMessage);
                    } catch (clipError) {
                        console.warn('Failed to copy to clipboard:', clipError);
                    }
                    
                    // Some operations failed
                    const failed = [
                        ...results.additions.filter(r => !r.success).map(r => `Add ${r.phone}: ${r.error}`),
                        ...results.updates.filter(r => !r.success).map(r => `Update ${r.phone}: ${r.error}`),
                        ...results.removals.filter(r => !r.success).map(r => `Remove ${r.phone}: ${r.error}`)
                    ];
                    
                    const successCount = 
                        results.additions.filter(r => r.success).length +
                        results.updates.filter(r => r.success).length +
                        results.removals.filter(r => r.success).length;
                    
                    alert(`⚠️ Some operations failed (${successCount} succeeded). Errors:\n${failed.join('\n')}`);
                }
            } catch (error) {
                console.error('❌ Error calling API:', error);
                alert('Error updating subscribers: ' + (error.message || 'Please try again.'));
            }
        } finally {
            // Hide loading animation
            this.hideEditModalLoading();
            
            // Re-enable submit button and reset flag
            this.isSubmittingEditForm = false;
            if (submitButton && originalButtonText) {
                submitButton.disabled = false;
                submitButton.textContent = originalButtonText;
            }
        }
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
        
        // Start with just 1 subscriber row (user can add more up to 3)
        this.addSubscriberRow();
        
        // Bind add button (but it will be disabled when 3 rows are present)
        const addBtn = document.getElementById('addSubscriberRowBtn');
        if (addBtn) {
            addBtn.onclick = () => this.addSubscriberRow();
            // Initially enable since we only have 1 row
            this.updateAddSubscriberButtonState();
        }
        
        // Bind form submit
        const form = document.getElementById('addSubscribersForm');
        if (form) {
            form.onsubmit = (e) => {
                e.preventDefault();
                this.handleAddSubscribersSubmit();
            };
        }
        
        // Bind close button
        const closeBtn = document.querySelector('.add-subscribers-close');
        if (closeBtn) {
            closeBtn.removeAttribute('onclick');
            closeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.closeAddSubscribersModal();
            }, { capture: true });
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
        
        // Limit to maximum 3 subscriber rows
        const MAX_SUBSCRIBERS = 3;
        if (container.children.length >= MAX_SUBSCRIBERS) {
            console.log(`⚠️ Maximum ${MAX_SUBSCRIBERS} subscribers allowed`);
            return;
        }
        
        const itemIndex = container.children.length;
        const itemDiv = document.createElement('div');
        itemDiv.className = 'add-subscribers-item';
        itemDiv.dataset.index = itemIndex;
        
        // Only require fields for the first row (index 0)
        const isFirstRow = itemIndex === 0;
        const requiredAttr = isFirstRow ? 'required' : '';
        
        itemDiv.innerHTML = `
            <div class="add-subscribers-item-fields">
                <div class="add-subscribers-field">
                    <label for="subscriber_${itemIndex}">Subscriber</label>
                    <input type="tel" id="subscriber_${itemIndex}" name="items[${itemIndex}].subscriber" placeholder="Enter phone number" ${requiredAttr}>
                </div>
                <div class="add-subscribers-field">
                    <label for="quota_${itemIndex}">Quota</label>
                    <input type="number" id="quota_${itemIndex}" name="items[${itemIndex}].quota" step="any" placeholder="Enter quota" ${requiredAttr}>
                </div>
                <div class="add-subscribers-field">
                    <label for="service_${itemIndex}">Service</label>
                    <div class="service-selector" id="service_selector_${itemIndex}" data-index="${itemIndex}">
                        <span class="service-selector-text" id="service_text_${itemIndex}">Select admin</span>
                        <svg class="service-selector-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M6 9l6 6 6-6"/>
                        </svg>
                    </div>
                    <input type="hidden" id="service_${itemIndex}" name="items[${itemIndex}].service" data-admin-id="" data-admin-name="" ${requiredAttr}>
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
        
        // Bind click handler for service selector
        const selector = document.getElementById(`service_selector_${itemIndex}`);
        if (selector) {
            // Prevent keyboard on mobile by handling touch events properly
            selector.setAttribute('tabindex', '-1');
            selector.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Blur any active input to prevent keyboard
                if (document.activeElement && document.activeElement.tagName === 'INPUT') {
                    document.activeElement.blur();
                }
                this.openAdminSelector(itemIndex);
            });
        }
        
        // Update add button state after adding a row
        this.updateAddSubscriberButtonState();
    }
    
    updateAddSubscriberButtonState() {
        const container = document.getElementById('subscribersItemsContainer');
        const addBtn = document.getElementById('addSubscriberRowBtn');
        const MAX_SUBSCRIBERS = 3;
        
        if (!container || !addBtn) return;
        
        const currentCount = container.children.length;
        if (currentCount >= MAX_SUBSCRIBERS) {
            // Hide the button completely when limit is reached
            addBtn.style.display = 'none';
        } else {
            // Show the button when below limit
            addBtn.style.display = '';
            addBtn.disabled = false;
            addBtn.style.opacity = '1';
            addBtn.style.cursor = 'pointer';
        }
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
                    const selectors = child.querySelectorAll('.service-selector');
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
                    selectors.forEach(selector => {
                        const oldIndex = selector.dataset.index;
                        selector.id = `service_selector_${index}`;
                        selector.dataset.index = index;
                        selector.setAttribute('tabindex', '-1');
                        selector.onclick = null; // Remove old handler
                        selector.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            // Blur any active input to prevent keyboard
                            if (document.activeElement && document.activeElement.tagName === 'INPUT') {
                                document.activeElement.blur();
                            }
                            this.openAdminSelector(index);
                        });
                        const textSpan = selector.querySelector('.service-selector-text');
                        if (textSpan) {
                            textSpan.id = `service_text_${index}`;
                        }
                    });
                });
            }
            
            // Update add button state after removing a row (re-enable if below limit)
            this.updateAddSubscriberButtonState();
        }
    }
    
    /**
     * Check if an admin matches the "Available Services" criteria
     * Same logic as the "Available Services" checkbox filter in insights table
     */
    isAdminAvailableService(admin) {
        // Must be active
        if (admin.status !== 'active') {
            return false;
        }
        
        // Count subscribers by status (Active, Requested, Out)
        const activeCount = admin.subscribersActiveCount || 0;
        const requestedCount = admin.subscribersRequestedCount || 0;
        const removedActiveSubscribers = admin.removedActiveSubscribers || [];
        const outCount = Array.isArray(removedActiveSubscribers) ? removedActiveSubscribers.length : 0;
        
        // NEW EXCLUSION LOGIC: Check if admin matches any of the 9 exclusion conditions
        // 1. One active and two requested
        if (activeCount === 1 && requestedCount === 2 && outCount === 0) {
            return false; // Exclude this admin
        }
        // 2. Three requested
        if (activeCount === 0 && requestedCount === 3 && outCount === 0) {
            return false; // Exclude this admin
        }
        // 3. Three active
        if (activeCount === 3 && requestedCount === 0 && outCount === 0) {
            return false; // Exclude this admin
        }
        // 4. Two active and one requested
        if (activeCount === 2 && requestedCount === 1 && outCount === 0) {
            return false; // Exclude this admin
        }
        // 5. One active and two out
        if (activeCount === 1 && requestedCount === 0 && outCount === 2) {
            return false; // Exclude this admin
        }
        // 6. Two active and one out
        if (activeCount === 2 && requestedCount === 0 && outCount === 1) {
            return false; // Exclude this admin
        }
        // 7. One active and one requested and one out
        if (activeCount === 1 && requestedCount === 1 && outCount === 1) {
            return false; // Exclude this admin
        }
        // 8. Two requested and one out
        if (activeCount === 0 && requestedCount === 2 && outCount === 1) {
            return false; // Exclude this admin
        }
        // 9. Two out and one requested
        if (activeCount === 0 && requestedCount === 1 && outCount === 2) {
            return false; // Exclude this admin
        }
        
        // TERM 1 & 2: Admin must have less than 3 total subscribers (active + requested + removed "Out" subscribers)
        // This matches the logic in applyFilters() when availableServices filter is checked
        const totalSubscribersCount = activeCount + requestedCount + outCount;
        if (totalSubscribersCount >= 3) {
            return false; // Exclude this admin
        }
        
        // TERM 3: Admin must have minimum 20 days before validity date
        // This matches the logic in applyFilters() when availableServices filter is checked
        const validityDateStr = admin.validityDate || '';
        
        // Helper function to parse DD/MM/YYYY date
        const parseDDMMYYYY = (dateStr) => {
            if (!dateStr || dateStr === 'N/A' || dateStr.trim() === '') return null;
            const parts = String(dateStr).trim().split('/');
            if (parts.length !== 3) return null;
            const day = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
            const year = parseInt(parts[2], 10);
            if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
            return new Date(year, month, day);
        };
        
        // Helper function to calculate days until validity date
        const daysUntilValidity = (dateStr) => {
            const validityDate = parseDDMMYYYY(dateStr);
            if (!validityDate) return null;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            validityDate.setHours(0, 0, 0, 0);
            const diffTime = validityDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            return diffDays;
        };
        
        const daysUntil = daysUntilValidity(validityDateStr);
        if (daysUntil === null || daysUntil < 20) {
            return false; // Exclude if validity date is invalid or less than 20 days away
        }
        
        return true; // All criteria passed
    }
    
    openAdminSelector(itemIndex) {
        try {
            const modal = document.getElementById('adminSelectorModal');
            if (!modal) {
                console.error('Admin selector modal not found');
                return;
            }
            
            // Store the current item index for when admin is selected
            modal.dataset.itemIndex = itemIndex;
            
            // Get active admins that match "Available Services" criteria
            // Only show admins that would appear when "Available Services" checkbox is checked
            let activeAdmins = [];
            try {
                activeAdmins = this.subscribers.filter(sub => {
                    try {
                        return this.isAdminAvailableService(sub);
                    } catch (error) {
                        console.error('Error checking admin availability:', error, sub);
                        return false; // Skip admins that cause errors
                    }
                });
            } catch (error) {
                console.error('Error filtering admins:', error);
                // Fallback to all active admins if filtering fails
                activeAdmins = this.subscribers.filter(sub => sub.status === 'active');
            }
            
            // Populate the modal
            this.populateAdminSelector(activeAdmins);
            
            // Show modal with animation
            modal.classList.add('show');
            document.body.style.overflow = 'hidden';
            
            // Only auto-focus search input on desktop (not mobile to avoid keyboard popup)
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
            if (!isMobile) {
                const searchInput = document.getElementById('adminSelectorSearch');
                if (searchInput) {
                    setTimeout(() => searchInput.focus(), 100);
                }
            }
            
            // Bind search functionality
            if (searchInput) {
                searchInput.oninput = (e) => {
                    const searchTerm = e.target.value.toLowerCase().trim();
                    this.filterAdminSelector(searchTerm, activeAdmins);
                };
            }
            
            // Bind close button
            const closeBtn = modal.querySelector('.admin-selector-close');
            if (closeBtn) {
                closeBtn.removeAttribute('onclick');
                closeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.closeAdminSelector();
                }, { capture: true });
            }
            
            // Close on overlay click
            modal.onclick = (e) => {
                if (e.target === modal) {
                    this.closeAdminSelector();
                }
            };
        } catch (error) {
            console.error('Error opening admin selector:', error);
            alert('Error opening admin selector. Please check the console for details.');
        }
    }
    
    closeAdminSelector() {
        const modal = document.getElementById('adminSelectorModal');
        if (modal) {
            modal.classList.remove('show');
            document.body.style.overflow = '';
            
            // Clear search
            const searchInput = document.getElementById('adminSelectorSearch');
            if (searchInput) {
                searchInput.value = '';
            }
        }
    }
    
    populateAdminSelector(admins) {
        const list = document.getElementById('adminSelectorList');
        if (!list) return;
        
        list.innerHTML = '';
        
        if (admins.length === 0) {
            list.innerHTML = '<div class="admin-selector-empty">No active admins available</div>';
            return;
        }
        
        admins.forEach((admin, index) => {
            const item = document.createElement('div');
            item.className = 'admin-selector-item';
            item.style.animationDelay = `${index * 0.05}s`;
            item.onclick = () => this.selectAdmin(admin);
            
            item.innerHTML = `
                <div class="admin-selector-item-info">
                    <div class="admin-selector-item-name">${admin.name || 'Unknown'}</div>
                    <div class="admin-selector-item-phone">${admin.phone || ''}</div>
                </div>
                <svg class="admin-selector-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 18l6-6-6-6"/>
                </svg>
            `;
            
            list.appendChild(item);
        });
    }
    
    filterAdminSelector(searchTerm, allAdmins) {
        const list = document.getElementById('adminSelectorList');
        if (!list) return;
        
        if (!searchTerm) {
            this.populateAdminSelector(allAdmins);
            return;
        }
        
        const filtered = allAdmins.filter(admin => {
            const name = (admin.name || '').toLowerCase();
            const phone = (admin.phone || '').toLowerCase();
            return name.includes(searchTerm) || phone.includes(searchTerm);
        });
        
        list.innerHTML = '';
        
        if (filtered.length === 0) {
            list.innerHTML = '<div class="admin-selector-empty">No admins found</div>';
            return;
        }
        
        filtered.forEach((admin, index) => {
            const item = document.createElement('div');
            item.className = 'admin-selector-item';
            item.style.animationDelay = `${index * 0.05}s`;
            item.onclick = () => this.selectAdmin(admin);
            
            item.innerHTML = `
                <div class="admin-selector-item-info">
                    <div class="admin-selector-item-name">${admin.name || 'Unknown'}</div>
                    <div class="admin-selector-item-phone">${admin.phone || ''}</div>
                </div>
                <svg class="admin-selector-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 18l6-6-6-6"/>
                </svg>
            `;
            
            list.appendChild(item);
        });
    }
    
    selectAdmin(admin) {
        const modal = document.getElementById('adminSelectorModal');
        if (!modal) return;
        
        const itemIndex = parseInt(modal.dataset.itemIndex);
        
        // Check if we're in edit subscribers modal
        if (this.editingItemIndex !== undefined && this.editingItemIndex !== null) {
            // Update the subscriber input in edit modal
            const editItem = document.querySelector(`.edit-subscriber-item[data-index="${this.editingItemIndex}"]`);
            if (editItem) {
                const subscriberInput = editItem.querySelector('input[name*="subscriber"]');
                if (subscriberInput) {
                    subscriberInput.value = admin.phone;
                    subscriberInput.dataset.adminId = admin.id;
                    subscriberInput.dataset.adminName = admin.name;
                    // Remove readonly class to show it's been set
                    subscriberInput.classList.remove('readonly');
                }
            }
            this.editingItemIndex = null;
        } else if (!isNaN(itemIndex)) {
            // Update the service selector in add subscribers modal
            const selector = document.getElementById(`service_selector_${itemIndex}`);
            const selectorText = document.getElementById(`service_text_${itemIndex}`);
            const hiddenInput = document.getElementById(`service_${itemIndex}`);
            
            if (selector && selectorText && hiddenInput) {
                selectorText.textContent = `${admin.name || admin.phone}`;
                selectorText.classList.add('selected');
                hiddenInput.value = admin.id;
                hiddenInput.dataset.adminId = admin.id;
                hiddenInput.dataset.adminName = admin.name || admin.phone;
            }
        }
        
        // Close modal
        this.closeAdminSelector();
    }
    
    showAddModalLoading(message = 'Processing...') {
        const modal = document.getElementById('addSubscribersModal');
        if (!modal) return;
        
        const modalContainer = modal.querySelector('.add-subscribers-modal-container');
        if (!modalContainer) return;
        
        // Ensure modal container has relative positioning
        modalContainer.style.position = 'relative';
        
        // Create or show loading overlay
        let loadingOverlay = modalContainer.querySelector('.add-modal-loading');
        if (!loadingOverlay) {
            loadingOverlay = document.createElement('div');
            loadingOverlay.className = 'add-modal-loading';
            modalContainer.appendChild(loadingOverlay);
        }
        
        // Update loading message
        loadingOverlay.innerHTML = `
            <div class="add-modal-loading-spinner">
                <div class="refresh-loading">
                    <div class="loader">
                        <div class="inner one"></div>
                        <div class="inner two"></div>
                        <div class="inner three"></div>
                    </div>
                </div>
                <p>${message}</p>
            </div>
        `;
        loadingOverlay.style.display = 'flex';
    }
    
    hideAddModalLoading() {
        const modal = document.getElementById('addSubscribersModal');
        if (!modal) return;
        
        const modalContainer = modal.querySelector('.add-subscribers-modal-container');
        if (!modalContainer) return;
        
        const loadingOverlay = modalContainer.querySelector('.add-modal-loading');
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
    }
    
    async handleAddSubscribersSubmit() {
        // Prevent duplicate submissions
        if (this.isSubmittingAddForm) {
            console.log('⏸️ Form submission already in progress, ignoring duplicate request');
            return;
        }
        
        const form = document.getElementById('addSubscribersForm');
        if (!form) return;
        
        this.isSubmittingAddForm = true;
        
        // Show loading animation
        this.showAddModalLoading('Adding subscribers...');
        
        // Disable submit button to prevent multiple clicks
        const submitBtn = document.getElementById('shareSubscribersBtn');
        let originalButtonText = '';
        if (submitBtn) {
            originalButtonText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Processing...';
        }
        
        try {
            const formData = new FormData(form);
            const items = [];
            
            // Collect all subscriber items
            const container = document.getElementById('subscribersItemsContainer');
            if (container) {
                const itemDivs = container.querySelectorAll('.add-subscribers-item');
                itemDivs.forEach((itemDiv, index) => {
                    const subscriber = itemDiv.querySelector(`input[name="items[${index}].subscriber"]`)?.value.trim();
                    const quota = itemDiv.querySelector(`input[name="items[${index}].quota"]`)?.value.trim();
                    const serviceInput = itemDiv.querySelector(`input[name="items[${index}].service"]`);
                    const adminId = serviceInput?.dataset.adminId || serviceInput?.value.trim();
                    const adminName = serviceInput?.dataset.adminName || '';
                    
                    if (subscriber && quota && adminId) {
                        items.push({
                            subscriber: subscriber,
                            quota: parseFloat(quota) || 0,
                            adminId: adminId,
                            adminName: adminName
                        });
                    }
                });
            }
            
            if (items.length === 0) {
                alert('Please add at least one subscriber with all fields filled.');
                this.isSubmittingAddForm = false;
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalButtonText;
                }
                return;
            }
            
            // Validate that all items have admin selected
            const missingAdmin = items.find(item => !item.adminId);
            if (missingAdmin) {
                alert('Please select an admin for all subscribers.');
                this.isSubmittingAddForm = false;
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalButtonText;
                }
                return;
            }
            
            console.log('Submitting subscribers:', items);
            
            // Call API for each subscriber
            const results = [];
            for (const item of items) {
                try {
                    const baseURL = window.AEFA_API_URL || window.ALFA_API_URL || 'https://cell-spott-manage-backend.onrender.com';
                    const response = await fetch(`${baseURL}/api/subscribers/add`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            adminId: item.adminId,
                            subscriberPhone: item.subscriber,
                            quota: item.quota
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        results.push({
                            subscriber: item.subscriber,
                            success: true,
                            message: data.message
                        });
                    } else {
                        results.push({
                            subscriber: item.subscriber,
                            success: false,
                            message: data.error || 'Failed to add subscriber'
                        });
                    }
                } catch (error) {
                    console.error(`Error adding subscriber ${item.subscriber}:`, error);
                    results.push({
                        subscriber: item.subscriber,
                        success: false,
                        message: error.message || 'Network error occurred'
                    });
                }
            }
            
            // Show results
            const successCount = results.filter(r => r.success).length;
            const failCount = results.filter(r => !r.success).length;
            
            // Copy message to clipboard based on success/failure
            if (failCount === 0) {
                // All succeeded - copy success message
                const firstSuccess = results.find(r => r.success);
                if (firstSuccess) {
                    const firstItem = items.find(item => item.subscriber === firstSuccess.subscriber);
                    if (firstItem) {
                        const admin = this.subscribers.find(s => s.id === firstItem.adminId);
                        const adminPhone = admin?.phone || firstItem.adminId;
                        const message = `Send ${adminPhone} to 1323`;
                        try {
                            await navigator.clipboard.writeText(message);
                            console.log('✅ Copied to clipboard:', message);
                        } catch (clipError) {
                            console.warn('Failed to copy to clipboard:', clipError);
                        }
                    }
                }
                
                alert(`✅ Successfully added ${successCount} subscriber(s)!`);
                this.closeAddSubscribersModal();
                // Optionally refresh the page or reload subscribers
                this.loadSubscribers();
            } else {
                // Some failed - copy cancel message
                const cancelMessage = `Cancel old service\n*111*7*2*1*2*1#`;
                try {
                    await navigator.clipboard.writeText(cancelMessage);
                    console.log('✅ Copied to clipboard:', cancelMessage);
                } catch (clipError) {
                    console.warn('Failed to copy to clipboard:', clipError);
                }
                
                const failedSubscribers = results.filter(r => !r.success)
                    .map(r => `${r.subscriber}: ${r.message}`)
                    .join('\n');
                alert(`⚠️ Added ${successCount} subscriber(s), but ${failCount} failed:\n\n${failedSubscribers}`);
                if (successCount > 0) {
                    this.closeAddSubscribersModal();
                    this.loadSubscribers();
                }
            }
            
            // Reset form
            this.initAddSubscribersModal();
        } catch (error) {
            console.error('Error adding subscribers:', error);
            alert('Failed to add subscribers. Please try again.');
        } finally {
            // Hide loading animation
            this.hideAddModalLoading();
            
            // Re-enable submit button and reset flag
            this.isSubmittingAddForm = false;
            if (submitBtn && originalButtonText) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalButtonText;
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
    
    formatSubscribersCount(activeCount, requestedCount) {
        // Support both old format (confirmedCount, pendingCount) and new format (activeCount, requestedCount)
        if (activeCount === undefined && requestedCount === undefined) return '';
        
        const active = activeCount || 0;
        const requested = requestedCount || 0;
        
        if (requested > 0) {
            return `${active} (${requested})`;
        }
        return active.toString();
    }
    
    formatDateTime(date) {
        // CRITICAL: Always validate input and return valid date or N/A
        // CRITICAL: Never use another admin's date - always validate it belongs to current admin
        if (!date) {
            console.warn('formatDateTime: No date provided');
            return { date: 'N/A', time: '' };
        }
        
        // Ensure we have a valid Date object
        let d;
        if (date instanceof Date) {
            d = date;
        } else if (typeof date === 'number') {
            // If it's a number, treat as milliseconds since epoch
            // Validate it's a reasonable timestamp (not 0, not negative, not too large)
            if (date <= 0 || date > 9999999999999) {
                console.warn('formatDateTime: Invalid timestamp number:', date);
                return { date: 'N/A', time: '' };
            }
            d = new Date(date);
        } else if (typeof date === 'string') {
            // If it's a string, try to parse it
            d = new Date(date);
        } else {
            // Invalid type
            console.warn('formatDateTime: Invalid date type:', typeof date, date);
            return { date: 'N/A', time: '' };
        }
        
        // Validate the date
        if (isNaN(d.getTime()) || d.getTime() <= 0) {
            console.warn('formatDateTime: Invalid date value:', date, '->', d);
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
        window.insightsManager = new InsightsManager();
    });
} else {
    window.insightsManager = new InsightsManager();
}
