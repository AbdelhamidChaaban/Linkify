// Add Subscriber Page - Data Loading Functions (extends AddSubscriberPageManager prototype)
// Simplified data loading - uses Firestore listeners like insights.js

AddSubscriberPageManager.prototype.getAuthToken = async function() {
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

// Lazy load admins: Wait until page is visible and interactive
AddSubscriberPageManager.prototype.loadAdminsLazy = function() {
    // If page is already visible and interactive, initialize immediately
    if (document.visibilityState === 'visible' && document.readyState === 'complete') {
        // Use requestIdleCallback to initialize when browser is idle (better performance)
        if ('requestIdleCallback' in window) {
            requestIdleCallback(() => {
                console.log('⚡ [Add Subscriber] Page visible and idle - initializing Firebase listener');
                this.loadAdmins();
            }, { timeout: 2000 }); // Max 2 second wait even if browser is busy
        } else {
            // Fallback: small delay to allow page to finish rendering
            setTimeout(() => {
                console.log('⚡ [Add Subscriber] Page ready - initializing Firebase listener (fallback)');
                this.loadAdmins();
            }, 100);
        }
    } else {
        // Wait for page to become visible and interactive
        const initListener = () => {
            if (document.visibilityState === 'visible') {
                // Page is visible, wait for it to be interactive
                if (document.readyState === 'complete' || document.readyState === 'interactive') {
                    if ('requestIdleCallback' in window) {
                        requestIdleCallback(() => {
                            console.log('⚡ [Add Subscriber] Page visible and idle - initializing Firebase listener');
                            this.loadAdmins();
                        }, { timeout: 2000 });
                    } else {
                        setTimeout(() => {
                            console.log('⚡ [Add Subscriber] Page ready - initializing Firebase listener');
                            this.loadAdmins();
                        }, 100);
                    }
                    document.removeEventListener('visibilitychange', initListener);
                    if (document.readyState === 'loading') {
                        document.removeEventListener('DOMContentLoaded', initListener);
                    }
                }
            }
        };
        
        // Listen for page visibility and ready state
        document.addEventListener('visibilitychange', initListener);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initListener);
        } else {
            // Already loaded, try to initialize after a short delay
            setTimeout(initListener, 100);
        }
        
        // Fallback: Initialize after max 3 seconds even if page isn't fully ready
        setTimeout(() => {
            if (!this.unsubscribe) {
                console.log('⚡ [Add Subscriber] Timeout reached - initializing Firebase listener (fallback)');
                this.loadAdmins();
            }
        }, 3000);
    }
};

AddSubscriberPageManager.prototype.loadAdmins = function() {
    try {
        if (!this.currentUserId) {
            console.error('Cannot load admins: user not authenticated');
            return;
        }
        
        console.log('📡 [Add Subscriber] Loading admins data...');
        
        // Unsubscribe from previous listener if exists
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        
        // Set up real-time listener (similar to insights.js)
        this.unsubscribe = db.collection('admins')
            .where('userId', '==', this.currentUserId)
            .onSnapshot(
                (snapshot) => {
                    console.log('📊 [Add Subscriber] Received admins snapshot, processing...');
                    this.processAdminsSnapshot(snapshot);
                },
                (error) => {
                    console.error('❌ [Add Subscriber] Error in admins listener:', error);
                    if (error.code === 'permission-denied') {
                        console.error('❌ [Add Subscriber] Permission denied. Check Firestore security rules.');
                    } else if (error.code === 'unavailable') {
                        console.error('❌ [Add Subscriber] Firestore unavailable. Check internet connection.');
                    }
                }
            );
    } catch (error) {
        console.error('❌ [Add Subscriber] Error setting up admins listener:', error);
    }
};

AddSubscriberPageManager.prototype.processAdminsSnapshot = function(snapshot) {
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
            
            // Get subscriber counts from alfaData (should be pre-calculated)
            let activeCount = 0;
            let requestedCount = 0;
            
            if (alfaData.subscribersActiveCount !== undefined) {
                activeCount = typeof alfaData.subscribersActiveCount === 'number' 
                    ? alfaData.subscribersActiveCount 
                    : parseInt(alfaData.subscribersActiveCount) || 0;
            } else if (alfaData.secondarySubscribers && Array.isArray(alfaData.secondarySubscribers)) {
                // Fallback: count active subscribers
                activeCount = alfaData.secondarySubscribers.filter(sub => 
                    sub && (sub.status === 'Active' || sub.status === 'active')
                ).length;
            }
            
            if (alfaData.subscribersRequestedCount !== undefined) {
                requestedCount = typeof alfaData.subscribersRequestedCount === 'number'
                    ? alfaData.subscribersRequestedCount
                    : parseInt(alfaData.subscribersRequestedCount) || 0;
            } else if (alfaData.secondarySubscribers && Array.isArray(alfaData.secondarySubscribers)) {
                // Fallback: count requested subscribers
                requestedCount = alfaData.secondarySubscribers.filter(sub =>
                    sub && (sub.status === 'Requested' || sub.status === 'requested')
                ).length;
            }
            
            // Get removed active subscribers (stored at root level, not in alfaData)
            const removedActiveSubscribers = data.removedActiveSubscribers || [];
            
            // Extract totalLimit (package size) - same logic as insights.js
            let totalLimit = 0;
            
            // First, try to parse from totalConsumption string (format: "X / Y GB")
            if (alfaData.totalConsumption && typeof alfaData.totalConsumption === 'string') {
                const consumptionMatch = String(alfaData.totalConsumption).match(/([\d.]+)\s*\/\s*([\d.]+)/);
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
            
            const validityDate = alfaData.validityDate || '';
            
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
                adminLimit: adminLimit,
                validityDate: validityDate,
                
                // Subscriber counts
                subscribersActiveCount: activeCount,
                subscribersRequestedCount: requestedCount,
                removedActiveSubscribers: removedActiveSubscribers
            };
            
            this.subscribers.push(admin);
        });
        
        console.log(`✅ [Add Subscriber] Processed ${this.subscribers.length} admin(s)`);
        console.log(`📊 [Add Subscriber] Admin statuses:`, this.subscribers.map(a => ({ name: a.name, status: a.status, activeCount: a.subscribersActiveCount, requestedCount: a.subscribersRequestedCount })));
    } catch (error) {
        console.error('❌ [Add Subscriber] Error processing admins snapshot:', error);
        this.subscribers = [];
    }
};

