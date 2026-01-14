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
            
            // Get limits and validity date
            const totalLimit = alfaData.totalLimit || alfaData.totalConsumption || 0;
            const adminLimit = alfaData.adminLimit || alfaData.adminConsumption || 0;
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

