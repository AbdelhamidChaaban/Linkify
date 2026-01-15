// Edit Subscriber Page - Data Loading Functions (extends EditSubscriberPageManager prototype)
// Loads admin data and subscriber information for editing

EditSubscriberPageManager.prototype.getAuthToken = async function() {
    if (typeof auth !== 'undefined' && auth && auth.currentUser) {
        try {
            return await auth.currentUser.getIdToken();
        } catch (error) {
            console.error('Error getting auth token:', error);
            return null;
        }
    }
    return null;
};

// IMMEDIATE load for edit subscriber page - user needs data right away
// No lazy loading since user specifically came to edit a specific admin
// This function is kept for compatibility but not used - we call loadAdmins() directly

EditSubscriberPageManager.prototype.loadAdmins = function() {
    try {
        if (!this.currentUserId) {
            console.error('Cannot load admins: user not authenticated');
            this.hidePageLoading();
            return;
        }
        
        console.log('📡 [Edit Subscriber] Loading admin data IMMEDIATELY...');
        
        // Unsubscribe from previous listener if exists
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        
        // OPTIMIZATION: For edit page, we only need ONE specific admin
        // Try to fetch it directly first (faster than listener) with timeout
        if (this.editingAdminId) {
            console.log(`🚀 [Edit Subscriber] Fetching admin ${this.editingAdminId} directly...`);
            const adminDocRef = db.collection('admins').doc(this.editingAdminId);
            
            // Add timeout to prevent hanging
            const fetchPromise = adminDocRef.get();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Admin fetch timeout')), 5000)
            );
            
            Promise.race([fetchPromise, timeoutPromise]).then((doc) => {
                if (doc.exists && doc.data().userId === this.currentUserId) {
                    console.log('✅ [Edit Subscriber] Got admin directly from Firestore');
                    // Process only this specific admin (optimized)
                    this.processSingleAdmin(doc);
                } else {
                    console.warn('⚠️ [Edit Subscriber] Admin not found or access denied, falling back to listener...');
                    // Fall back to listener
                    this.setupAdminListener();
                }
            }).catch((error) => {
                console.warn('⚠️ [Edit Subscriber] Direct fetch failed, falling back to listener:', error);
                // Fall back to listener
                this.setupAdminListener();
            });
            
            // Also set up listener for real-time updates (in case admin data changes)
            this.setupAdminListener();
        } else {
            // No admin ID - use listener (shouldn't happen, but handle it)
            this.setupAdminListener();
        }
    } catch (error) {
        console.error('❌ [Edit Subscriber] Error loading admins:', error);
        this.hidePageLoading();
    }
};

EditSubscriberPageManager.prototype.setupAdminListener = function() {
    try {
        // Set up real-time listener (for updates after initial load)
        this.unsubscribe = db.collection('admins')
            .where('userId', '==', this.currentUserId)
            .onSnapshot(
                (snapshot) => {
                    console.log('📊 [Edit Subscriber] Received admins snapshot update, processing...');
                    this.processAdminsSnapshot(snapshot);
                },
                (error) => {
                    console.error('❌ [Edit Subscriber] Error in admins listener:', error);
                    if (error.code === 'permission-denied') {
                        console.error('❌ [Edit Subscriber] Permission denied. Check Firestore security rules.');
                        this.hidePageLoading();
                    } else if (error.code === 'unavailable') {
                        console.error('❌ [Edit Subscriber] Firestore unavailable. Check internet connection.');
                        this.hidePageLoading();
                    }
                }
            );
    } catch (error) {
        console.error('❌ [Edit Subscriber] Error setting up listener:', error);
        this.hidePageLoading();
    }
};

// Optimized version - processes only a single admin document (for edit page)
EditSubscriberPageManager.prototype.processSingleAdmin = function(doc) {
    try {
        const data = doc.data();
        if (data.userId !== this.currentUserId) {
            console.warn('⚠️ [Edit Subscriber] Admin does not belong to current user');
            this.hidePageLoading();
            return;
        }
        
        // Process this single admin (same logic as processAdminsSnapshot but optimized)
        const admin = this.extractAdminData(doc);
        this.subscribers = [admin];
        
        console.log(`✅ [Edit Subscriber] Processed admin: ${admin.name || admin.phone}`);
        
        // Load subscriber data for this admin
        this.loadSubscriberDataForEditing(admin);
    } catch (error) {
        console.error('❌ [Edit Subscriber] Error processing admin:', error);
        this.hidePageLoading();
    }
};

// Extract admin data from a document (shared logic)
EditSubscriberPageManager.prototype.extractAdminData = function(doc) {
    const data = doc.data();
    const alfaData = data.alfaData || {};
    
    // Determine status (similar to insights.js logic)
    let status = data.status || 'inactive';
    if (alfaData.primaryData && alfaData.primaryData.ServiceInformationValue) {
        const services = alfaData.primaryData.ServiceInformationValue;
        if (Array.isArray(services)) {
            for (const service of services) {
                if (service.ServiceNameValue) {
                    const serviceName = String(service.ServiceNameValue).trim().toLowerCase();
                    if (serviceName === 'u-share main') {
                        status = 'active';
                        break;
                    }
                }
            }
        }
    }
    
    // Extract subscriber counts - same logic as insights.js and add-subscriber-data.js
    const hasAlfaData = alfaData && Object.keys(alfaData).length > 0 && !alfaData.error;
    
    // Get subscribers count from alfaData (total count)
    let subscribersCount = hasAlfaData && alfaData.subscribersCount !== undefined 
        ? (typeof alfaData.subscribersCount === 'number' ? alfaData.subscribersCount : parseInt(alfaData.subscribersCount) || 0)
        : 0;
    
    // Get Active and Requested counts from ushare HTML data
    const hasUshareHtmlData = hasAlfaData && alfaData.subscribersRequestedCount !== undefined;
    
    let activeCount = hasAlfaData && alfaData.subscribersActiveCount !== undefined
        ? (typeof alfaData.subscribersActiveCount === 'number' ? alfaData.subscribersActiveCount : parseInt(alfaData.subscribersActiveCount) || 0)
        : subscribersCount;
    
    let requestedCount = hasUshareHtmlData
        ? (typeof alfaData.subscribersRequestedCount === 'number' ? alfaData.subscribersRequestedCount : parseInt(alfaData.subscribersRequestedCount) || 0)
        : undefined;
    
    // Get pending subscribers count from Firebase
    const pendingSubscribers = data.pendingSubscribers || [];
    const removedSubscribers = data.removedSubscribers || [];
    
    const activePendingSubscribers = pendingSubscribers.filter(pending => {
        const pendingPhone = String(pending.phone || '').trim();
        return !removedSubscribers.includes(pendingPhone);
    });
    const pendingCount = activePendingSubscribers.length;
    
    if (!hasUshareHtmlData && pendingCount > 0) {
        requestedCount = pendingCount;
    } else if (!hasUshareHtmlData) {
        requestedCount = 0;
    }
    
    const removedActiveSubscribers = data.removedActiveSubscribers || [];
    
    // Extract totalLimit (package size)
    let totalLimit = 0;
    if (alfaData.totalConsumption && typeof alfaData.totalConsumption === 'string') {
        const consumptionMatch = String(alfaData.totalConsumption).match(/([\d.]+)\s*\/\s*([\d.]+)(?:\s*(GB|MB))?/i);
        if (consumptionMatch && consumptionMatch[2]) {
            totalLimit = parseFloat(consumptionMatch[2]) || 0;
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
    
    // Extract totalConsumption
    let totalConsumption = 0;
    if (alfaData.totalConsumption && typeof alfaData.totalConsumption === 'string') {
        const consumptionMatch = String(alfaData.totalConsumption).match(/([\d.]+)\s*\/\s*[\d.]+/);
        if (consumptionMatch) {
            totalConsumption = parseFloat(consumptionMatch[1]) || 0;
        }
    } else if (alfaData.totalConsumption !== undefined && alfaData.totalConsumption !== null) {
        totalConsumption = parseFloat(alfaData.totalConsumption) || 0;
    }
    
    // Extract adminLimit
    let adminLimit = 0;
    if (data.quota) {
        const quotaStr = String(data.quota).trim();
        const quotaMatch = quotaStr.match(/^([\d.]+)/);
        adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
    }
    
    if (adminLimit === 0 && alfaData.adminConsumption && typeof alfaData.adminConsumption === 'string') {
        const consumptionMatch = String(alfaData.adminConsumption).match(/([\d.]+)\s*\/\s*([\d.]+)/);
        if (consumptionMatch && consumptionMatch[2]) {
            adminLimit = parseFloat(consumptionMatch[2]) || 0;
        }
    }
    
    if (adminLimit === 0 && alfaData.primaryData) {
        try {
            const primaryData = alfaData.primaryData;
            if (primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue)) {
                for (const service of primaryData.ServiceInformationValue) {
                    const serviceName = (service.ServiceNameValue || '').toLowerCase();
                    if (serviceName.includes('u-share main') || serviceName === 'u-share main') {
                        if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                            for (const details of service.ServiceDetailsInformationValue) {
                                if (details.PackageValue) {
                                    const packageStr = String(details.PackageValue).trim();
                                    const packageMatch = packageStr.match(/^([\d.]+)/);
                                    if (packageMatch) {
                                        const packageValue = parseFloat(packageMatch[1]);
                                        if (!isNaN(packageValue) && packageValue > 0) {
                                            adminLimit = packageValue;
                                            break;
                                        }
                                    }
                                }
                                if (adminLimit === 0 && details.QuotaValue) {
                                    const quotaStr = String(details.QuotaValue).trim();
                                    const quotaMatch = quotaStr.match(/^([\d.]+)/);
                                    if (quotaMatch) {
                                        adminLimit = parseFloat(quotaMatch[1]) || 0;
                                        break;
                                    }
                                }
                            }
                            if (adminLimit > 0) break;
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('Error extracting adminLimit from primaryData:', error);
        }
    }
    
    if (adminLimit === 0 && alfaData.adminLimit) {
        adminLimit = parseFloat(alfaData.adminLimit) || 0;
    }
    
    // Extract validityDate
    let validityDate = alfaData.validityDate || data.validityDate || '';
    if (status === 'inactive') {
        validityDate = '';
    }
    
    // Extract adminConsumption
    let adminConsumption = 0;
    if (alfaData.adminConsumption && typeof alfaData.adminConsumption === 'string') {
        const consumptionMatch = String(alfaData.adminConsumption).match(/([\d.]+)\s*\/\s*[\d.]+/);
        if (consumptionMatch) {
            adminConsumption = parseFloat(consumptionMatch[1]) || 0;
        }
    } else if (alfaData.adminConsumption !== undefined && alfaData.adminConsumption !== null) {
        adminConsumption = parseFloat(alfaData.adminConsumption) || 0;
    }
    
    return {
        id: doc.id,
        name: data.name || '',
        phone: data.phone || '',
        status: status,
        quota: data.quota || 0,
        type: data.type || '',
        notUShare: data.notUShare === true,
        alfaData: alfaData,
        totalLimit: totalLimit,
        totalConsumption: totalConsumption,
        adminLimit: adminLimit,
        adminConsumption: adminConsumption,
        validityDate: validityDate,
        subscribersActiveCount: activeCount,
        subscribersRequestedCount: requestedCount,
        removedActiveSubscribers: removedActiveSubscribers,
        password: data.password || null
    };
};

EditSubscriberPageManager.prototype.processAdminsSnapshot = function(snapshot) {
    try {
        this.subscribers = [];
        
        snapshot.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Determine status (similar to insights.js logic)
            let status = data.status || 'inactive';
            if (alfaData.primaryData && alfaData.primaryData.ServiceInformationValue) {
                const services = alfaData.primaryData.ServiceInformationValue;
                if (Array.isArray(services)) {
                    for (const service of services) {
                        if (service.ServiceNameValue) {
                            const serviceName = String(service.ServiceNameValue).trim().toLowerCase();
                            if (serviceName === 'u-share main') {
                                status = 'active';
                                break;
                            }
                        }
                    }
                }
            }
            
            // Extract subscriber counts - same logic as insights.js and add-subscriber-data.js
            const hasAlfaData = alfaData && Object.keys(alfaData).length > 0 && !alfaData.error;
            
            // Get subscribers count from alfaData (total count)
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
            
            // Get removed active subscribers (stored at root level, not in alfaData)
            const removedActiveSubscribers = data.removedActiveSubscribers || [];
            
            // Extract totalLimit (package size) - same logic as insights.js
            let totalLimit = 0;
            
            // First, try to parse from totalConsumption string (format: "X / Y GB")
            if (alfaData.totalConsumption && typeof alfaData.totalConsumption === 'string') {
                const consumptionMatch = String(alfaData.totalConsumption).match(/([\d.]+)\s*\/\s*[\d.]+(?:\s*(GB|MB))?/i);
                if (consumptionMatch) {
                    totalLimit = parseFloat(consumptionMatch[2]) || 0; // Second number is the total/limit
                }
            }
            
            // If still 0, try to extract from PackageValue (total bundle size) in primaryData
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
            
            // Extract totalConsumption (used amount) - same logic as insights.js
            let totalConsumption = 0;
            if (alfaData.totalConsumption && typeof alfaData.totalConsumption === 'string') {
                const consumptionMatch = String(alfaData.totalConsumption).match(/([\d.]+)\s*\/\s*[\d.]+/);
                if (consumptionMatch) {
                    totalConsumption = parseFloat(consumptionMatch[1]) || 0; // First number is the used amount
                }
            } else if (alfaData.totalConsumption !== undefined && alfaData.totalConsumption !== null) {
                totalConsumption = parseFloat(alfaData.totalConsumption) || 0;
            }
            
            // Extract adminLimit (admin's quota/limit) - same logic as insights.js
            let adminLimit = 0;
            
            // First, try to get from quota field in data (admin's own quota/limit)
            if (data.quota) {
                // Handle if quota is a string with units (e.g., "15 GB" or "15")
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Try to parse from adminConsumption string (format: "X / Y GB" - Y is the limit/quota)
            if (adminLimit === 0 && alfaData.adminConsumption && typeof alfaData.adminConsumption === 'string') {
                const consumptionMatch = String(alfaData.adminConsumption).match(/([\d.]+)\s*\/\s*([\d.]+)/);
                if (consumptionMatch) {
                    adminLimit = parseFloat(consumptionMatch[2]) || 0; // Second number is the limit/quota
                }
            }
            
            // Try to extract from primaryData (U-Share Main circle quota)
            if (adminLimit === 0 && alfaData.primaryData) {
                try {
                    const primaryData = alfaData.primaryData;
                    if (primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue)) {
                        for (const service of primaryData.ServiceInformationValue) {
                            const serviceName = (service.ServiceNameValue || '').toLowerCase();
                            // Look for U-Share Main service
                            if (serviceName.includes('u-share main') || serviceName === 'u-share main') {
                                if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                    for (const details of service.ServiceDetailsInformationValue) {
                                        // Try PackageValue first (total bundle)
                                        if (details.PackageValue) {
                                            const packageStr = String(details.PackageValue).trim();
                                            const packageMatch = packageStr.match(/^([\d.]+)/);
                                            if (packageMatch) {
                                                const packageValue = parseFloat(packageMatch[1]);
                                                if (!isNaN(packageValue) && packageValue > 0) {
                                                    adminLimit = packageValue;
                                                    break;
                                                }
                                            }
                                        }
                                        // Fallback: Try QuotaValue
                                        if (adminLimit === 0 && details.QuotaValue) {
                                            const quotaStr = String(details.QuotaValue).trim();
                                            const quotaMatch = quotaStr.match(/^([\d.]+)/);
                                            if (quotaMatch) {
                                                adminLimit = parseFloat(quotaMatch[1]) || 0;
                                                break;
                                            }
                                        }
                                    }
                                    if (adminLimit > 0) break;
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.warn('Error extracting adminLimit from primaryData:', error);
                }
            }
            
            // Fallback to adminLimit field
            if (adminLimit === 0 && alfaData.adminLimit) {
                adminLimit = parseFloat(alfaData.adminLimit) || 0;
            }
            
            // Extract validityDate - same as insights.js (checks alfaData first, then admin document)
            let validityDate = alfaData.validityDate || data.validityDate || '';
            
            // If admin is inactive, set validityDate to empty (same as insights.js)
            if (status === 'inactive') {
                validityDate = '';
            }
            
            // Extract adminConsumption
            let adminConsumption = 0;
            if (alfaData.adminConsumption && typeof alfaData.adminConsumption === 'string') {
                const consumptionMatch = String(alfaData.adminConsumption).match(/([\d.]+)\s*\/\s*[\d.]+/);
                if (consumptionMatch) {
                    adminConsumption = parseFloat(consumptionMatch[1]) || 0; // First number is the used amount
                }
            } else if (alfaData.adminConsumption !== undefined && alfaData.adminConsumption !== null) {
                adminConsumption = parseFloat(alfaData.adminConsumption) || 0;
            }
            
            // Extract basic admin info
            const admin = {
                id: doc.id,
                name: data.name || '',
                phone: data.phone || '',
                status: status,
                quota: data.quota || 0,
                type: data.type || '',
                notUShare: data.notUShare === true,
                alfaData: alfaData,
                
                // Processed values (same structure as insights.js)
                totalLimit: totalLimit,
                totalConsumption: totalConsumption,
                adminLimit: adminLimit,
                adminConsumption: adminConsumption,
                validityDate: validityDate,
                
                // Subscriber counts
                subscribersActiveCount: activeCount,
                subscribersRequestedCount: requestedCount,
                removedActiveSubscribers: removedActiveSubscribers,
                
                // Additional data for edit functionality
                password: data.password || null
            };
            
            this.subscribers.push(admin);
        });
        
        console.log(`✅ [Edit Subscriber] Processed ${this.subscribers.length} admin(s)`);
        
        // Once we have the admins loaded, check if we have the admin being edited and load its data
        if (this.editingAdminId) {
            const editingAdmin = this.subscribers.find(s => s.id === this.editingAdminId);
            if (editingAdmin) {
                console.log('✅ [Edit Subscriber] Found admin to edit:', editingAdmin.name);
                // Load subscriber data for this admin (will hide loading when done)
                this.loadSubscriberDataForEditing(editingAdmin);
            } else {
                console.warn('⚠️ [Edit Subscriber] Admin not found in snapshot');
                // Check if admin exists but belongs to different user
                const allAdmins = snapshot.docs || [];
                const adminExists = allAdmins.some(doc => doc.id === this.editingAdminId);
                
                if (!adminExists) {
                    // Admin doesn't exist - show error
                    this.hidePageLoading();
                    alert(`Admin with ID "${this.editingAdminId}" not found. Redirecting to Insights...`);
                    window.location.href = '/pages/insights.html';
                } else {
                    // Admin exists but might not belong to this user or data not ready
                    console.warn('⚠️ [Edit Subscriber] Admin exists but not accessible yet, will wait for next update');
                    // Keep loading visible - will try again when more data arrives
                    // Set a timeout to prevent infinite loading
                    if (!this._adminLoadTimeout) {
                        this._adminLoadTimeout = setTimeout(() => {
                            console.error('❌ [Edit Subscriber] Timeout waiting for admin data');
                            this.hidePageLoading();
                            alert('Timeout loading admin data. Please try again.');
                            window.location.href = '/pages/insights.html';
                        }, 10000); // 10 second timeout
                    }
                }
            }
        }
    } catch (error) {
        console.error('❌ [Edit Subscriber] Error processing admins snapshot:', error);
        this.subscribers = [];
    }
};

// Load subscriber data for the admin being edited
EditSubscriberPageManager.prototype.loadSubscriberDataForEditing = async function(subscriber) {
    if (!subscriber || !subscriber.id) {
        console.error('❌ [Edit Subscriber] Invalid subscriber data');
        this.hidePageLoading();
        return;
    }
    
    // Clear timeout since we found the admin
    if (this._adminLoadTimeout) {
        clearTimeout(this._adminLoadTimeout);
        this._adminLoadTimeout = null;
    }
    
    console.log('🔄 [Edit Subscriber] Loading subscriber data for:', subscriber.id);
    
    // OPTIMIZATION: Check if we have Ushare data in Firebase first (much faster)
    const alfaData = subscriber.alfaData || {};
    const hasUshareData = alfaData.secondarySubscribers && Array.isArray(alfaData.secondarySubscribers) && alfaData.secondarySubscribers.length > 0;
    
    if (hasUshareData) {
        console.log('✅ [Edit Subscriber] Using cached Ushare data from Firebase (fast path)');
        // Transform Firebase data to expected format
        const ushareData = {
            subscribers: alfaData.secondarySubscribers.map(sub => {
                // Extract consumption - try multiple field names
                let usedConsumption = 0;
                if (typeof sub.consumption === 'number') {
                    usedConsumption = sub.consumption;
                } else if (typeof sub.usedConsumption === 'number') {
                    usedConsumption = sub.usedConsumption;
                } else if (sub.consumptionText) {
                    // Parse from consumptionText (format: "0.48 / 30 GB")
                    const match = sub.consumptionText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    if (match) {
                        usedConsumption = parseFloat(match[1]) || 0;
                    }
                } else if (sub.consumption) {
                    // Parse from consumption string (format: "1.18 / 30 GB")
                    const consumptionStr = String(sub.consumption);
                    const match = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    if (match) {
                        usedConsumption = parseFloat(match[1]) || 0;
                    } else {
                        usedConsumption = parseFloat(consumptionStr) || 0;
                    }
                }
                
                // Extract quota - try multiple field names and formats
                let totalQuota = 0;
                if (typeof sub.quota === 'number') {
                    totalQuota = sub.quota;
                } else if (typeof sub.totalQuota === 'number') {
                    totalQuota = sub.totalQuota;
                } else if (typeof sub.limit === 'number') {
                    totalQuota = sub.limit;
                } else if (sub.quota) {
                    totalQuota = parseFloat(sub.quota) || 0;
                } else if (sub.totalQuota) {
                    totalQuota = parseFloat(sub.totalQuota) || 0;
                } else if (sub.limit) {
                    totalQuota = parseFloat(sub.limit) || 0;
                } else if (sub.consumptionText) {
                    // Parse from consumptionText (format: "0.48 / 30 GB") - get the number after "/"
                    const match = sub.consumptionText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    if (match) {
                        totalQuota = parseFloat(match[2]) || 0;
                    }
                } else if (sub.consumption && typeof sub.consumption === 'string') {
                    // Parse from consumption string (format: "1.18 / 30 GB") - get the number after "/"
                    const consumptionStr = String(sub.consumption);
                    const match = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    if (match) {
                        totalQuota = parseFloat(match[2]) || 0;
                    }
                }
                
                return {
                    phoneNumber: sub.phoneNumber || sub.fullPhoneNumber || '',
                    usedConsumption: usedConsumption,
                    totalQuota: totalQuota,
                    status: sub.status || 'Active'
                };
            })
        };
        
        // Initialize form immediately with cached data
        this.initEditSubscribersPageWithUshareData(subscriber, ushareData);
        this.hidePageLoading();
        console.log('✅ [Edit Subscriber] Form ready with cached data');
        
        // Fetch fresh data in background (non-blocking) to update form if needed
        this.refreshUshareDataInBackground(subscriber);
    } else {
        // No cached data - must fetch from API
        console.log('📡 [Edit Subscriber] No cached data, fetching from API...');
        this.showPageLoading('Loading subscriber data...');
        
        try {
            // Fetch Ushare data using API (with timeout)
            console.log('📡 [Edit Subscriber] Calling getUshare API...');
            const startTime = Date.now();
            
            // Add timeout to API call
            const apiCall = window.AlfaAPIService.getUshare(subscriber.id, false);
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Ushare API timeout')), 15000) // 15 second timeout
            );
            
            const ushareResponse = await Promise.race([apiCall, timeoutPromise]);
            const endTime = Date.now();
            console.log(`✅ [Edit Subscriber] getUshare API completed in ${endTime - startTime}ms`);
            
            // Check if response was queued
            if (ushareResponse.queued) {
                throw new Error('Request was queued. Please try again in a moment.');
            }
            
            // Transform response format - ensure field names are consistent
            const ushareData = {
                subscribers: (ushareResponse.results || []).map(sub => {
                    // Handle different field name variations from API
                    return {
                        phoneNumber: sub.phoneNumber || sub.fullPhoneNumber || '',
                        usedConsumption: sub.usedConsumption || sub.consumption || 0,
                        totalQuota: sub.totalQuota || sub.quota || sub.limit || 0,
                        status: sub.status || 'Active'
                    };
                })
            };
            
            console.log(`📊 [Edit Subscriber] Got ${ushareData.subscribers.length} subscriber(s) from API`);
            
            // Initialize form with fresh Ushare data
            this.initEditSubscribersPageWithUshareData(subscriber, ushareData);
            
            console.log('✅ [Edit Subscriber] Subscriber data loaded, form ready');
            
            // Hide loading ONLY after data is loaded and form is initialized
            this.hidePageLoading();
        } catch (error) {
            console.error('❌ [Edit Subscriber] Error loading subscriber data:', error);
            // Still initialize with existing data from Firebase as fallback
            this.initEditSubscribersPageWithExistingData(subscriber);
            // Hide loading even if there's an error (fallback data is shown)
            this.hidePageLoading();
            
            // Show error alert only if it's not a timeout (timeout is expected sometimes)
            if (!error.message.includes('timeout')) {
                alert(`Failed to load subscriber data: ${error.message}\n\nShowing cached data from Firebase.`);
            }
        }
    }
};

// Refresh Ushare data in background (non-blocking)
EditSubscriberPageManager.prototype.refreshUshareDataInBackground = async function(subscriber) {
    try {
        console.log('🔄 [Edit Subscriber] Refreshing Ushare data in background...');
        const ushareResponse = await window.AlfaAPIService.getUshare(subscriber.id, false);
        
        if (ushareResponse.queued || !ushareResponse.results) {
            return; // Skip if queued or invalid response
        }
        
        // Update form with fresh data if it changed
        const ushareData = {
            subscribers: ushareResponse.results || []
        };
        
        console.log('✅ [Edit Subscriber] Background refresh completed, updating form...');
        // Note: We could update the form here, but for now just log it
        // The form is already populated with cached data, so background refresh is optional
    } catch (error) {
        // Silently fail - we already have cached data showing
        console.warn('⚠️ [Edit Subscriber] Background refresh failed (non-critical):', error.message);
    }
};

