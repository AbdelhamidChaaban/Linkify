const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middleware/auth');
const webpush = require('web-push');
const admin = require('firebase-admin');

// Get Firebase Admin DB instance
function getAdminDb() {
    try {
        if (admin.apps.length === 0) {
            const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
                ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
                : null;
            
            if (!serviceAccount) {
                return null;
            }
            
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        
        return admin.firestore();
    } catch (error) {
        console.error('Error initializing Firebase Admin:', error.message);
        return null;
    }
}

// VAPID keys - should be in environment variables
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BEl62iUYgUivxIkv69yViEuiBIa40HIeRxF6u0hUxHh2QD6tQvAZVv2UO9XQhqW4vUz8Oq6Y3UZ5F1xW7pR8E3Y';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'VAPID_PRIVATE_KEY_NOT_SET';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:your-email@example.com';

// Set VAPID details for web-push
if (VAPID_PRIVATE_KEY && VAPID_PRIVATE_KEY !== 'VAPID_PRIVATE_KEY_NOT_SET') {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log('✅ VAPID keys configured for push notifications');
    console.log('   Public Key:', VAPID_PUBLIC_KEY.substring(0, 20) + '...');
    console.log('   Subject:', VAPID_SUBJECT);
} else {
    console.warn('⚠️ VAPID_PRIVATE_KEY is not set. Push notifications will not work.');
    console.warn('   Run: node generate-vapid-keys.js to generate keys');
}

// Get VAPID public key
router.get('/push/vapid-public-key', (req, res) => {
    res.json({ key: VAPID_PUBLIC_KEY });
});

// Check subscription status
router.get('/push/subscription-status', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.uid;
        const db = getAdminDb();
        if (!db) {
            return res.status(500).json({ error: 'Database not initialized' });
        }
        
        const subscriptionDoc = await db.collection('pushSubscriptions').doc(userId).get();
        const exists = subscriptionDoc.exists;
        const data = exists ? subscriptionDoc.data() : null;
        // Check if enabled flag exists and is true, or if enabled flag doesn't exist (backward compatibility)
        const hasSubscription = exists && (data.enabled === true || data.enabled === undefined);
        
        console.log(`🔍 [Subscription Status] User ${userId}: exists=${exists}, enabled=${data?.enabled}, hasSubscription=${hasSubscription}`);
        
        res.json({ hasSubscription });
    } catch (error) {
        console.error('Error checking subscription status:', error);
        res.status(500).json({ error: 'Failed to check subscription status' });
    }
});

// Subscribe to push notifications
router.post('/push/subscribe', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { subscription } = req.body;
        
        if (!subscription) {
            return res.status(400).json({ error: 'Subscription is required' });
        }
        
        const db = getAdminDb();
        if (!db) {
            return res.status(500).json({ error: 'Database not initialized' });
        }
        
        // Save subscription to Firestore
        await db.collection('pushSubscriptions').doc(userId).set({
            subscription: subscription,
            userId: userId,
            enabled: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        // Verify it was saved
        const savedDoc = await db.collection('pushSubscriptions').doc(userId).get();
        const savedData = savedDoc.exists ? savedDoc.data() : null;
        console.log(`✅ Push subscription saved for user ${userId}, enabled=${savedData?.enabled}, exists=${savedDoc.exists}`);
        
        res.json({ success: true, message: 'Subscription saved' });
    } catch (error) {
        console.error('Error saving push subscription:', error);
        res.status(500).json({ error: 'Failed to save subscription' });
    }
});

// Unsubscribe from push notifications
router.post('/push/unsubscribe', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { subscription } = req.body;
        
        const db = getAdminDb();
        if (!db) {
            return res.status(500).json({ error: 'Database not initialized' });
        }
        
        // Remove subscription from Firestore
        await db.collection('pushSubscriptions').doc(userId).delete();
        
        console.log(`✅ Push subscription removed for user ${userId}`);
        
        res.json({ success: true, message: 'Unsubscribed successfully' });
    } catch (error) {
        console.error('Error removing push subscription:', error);
        res.status(500).json({ error: 'Failed to unsubscribe' });
    }
});

// Check for notifications and send if needed
router.get('/push/check', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.uid;
        
        // Check for expiring admins and high consumption
        const notifications = await checkForNotifications(userId);
        
        // Send push notifications if any found
        if (notifications.length > 0) {
            await sendPushNotifications(userId, notifications);
        }
        
        res.json({ 
            success: true, 
            notificationsFound: notifications.length,
            notifications: notifications 
        });
    } catch (error) {
        console.error('Error checking for notifications:', error);
        res.status(500).json({ error: 'Failed to check for notifications' });
    }
});

// Delete all notifications for a user
router.delete('/push/notifications/delete-all', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.uid;
        const db = getAdminDb();
        if (!db) {
            return res.status(500).json({ error: 'Database not available' });
        }
        
        // Delete all notifications for this user
        const notificationsRef = db.collection('users').doc(userId).collection('notifications');
        const snapshot = await notificationsRef.get();
        
        if (snapshot.empty) {
            return res.json({ success: true, deleted: 0 });
        }
        
        // Delete all notifications in batch
        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();
        
        console.log(`✅ Deleted ${snapshot.size} notification(s) for user ${userId}`);
        res.json({ success: true, deleted: snapshot.size });
    } catch (error) {
        console.error('Error deleting notifications:', error);
        res.status(500).json({ error: 'Failed to delete notifications' });
    }
});

// Get notification history
router.get('/push/notifications', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.uid;
        const db = getAdminDb();
        if (!db) {
            return res.status(500).json({ error: 'Database not initialized' });
        }
        
        // Get notifications from Firestore subcollection: users/{userId}/notifications
        const notificationsSnapshot = await db.collection('users').doc(userId).collection('notifications')
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get();
        
        const notifications = [];
        
        notificationsSnapshot.forEach(doc => {
            const data = doc.data();
            notifications.push({
                id: doc.id,
                ...data,
                timestamp: data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : (data.timestamp || null)
            });
        });
        
        res.json({ notifications });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ error: 'Failed to fetch notifications', details: error.message });
    }
});

// Clear all notifications
router.delete('/push/notifications', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.uid;
        const db = getAdminDb();
        if (!db) {
            return res.status(500).json({ error: 'Database not initialized' });
        }
        
        // Delete all notifications from subcollection
        const notificationsRef = db.collection('users').doc(userId).collection('notifications');
        const snapshot = await notificationsRef.get();
        
        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();
        
        console.log(`✅ All notifications cleared for user ${userId}`);
        res.json({ success: true, message: 'All notifications cleared' });
    } catch (error) {
        console.error('Error clearing notifications:', error);
        res.status(500).json({ error: 'Failed to clear notifications', details: error.message });
    }
});

// Helper function to check for notifications
// @param {string} userId - User ID to check notifications for
// @param {string} [adminId] - Optional: Specific admin ID to check. If provided, only this admin will be checked.
async function checkForNotifications(userId, adminId = null) {
    const notifications = [];
    const db = getAdminDb();
    if (!db) {
        console.log('⚠️ Database not available for notification check');
        return notifications;
    }
    
    try {
        let adminsSnapshot;
        
        if (adminId) {
            // Check only the specific admin that was refreshed
            const adminDoc = await db.collection('admins').doc(adminId).get();
            if (!adminDoc.exists) {
                console.log(`ℹ️ Admin ${adminId} not found`);
                return notifications;
            }
            // Check if this admin belongs to the user
            const adminData = adminDoc.data();
            if (adminData.userId !== userId) {
                console.log(`⚠️ Admin ${adminId} does not belong to user ${userId}`);
                return notifications;
            }
            // Create a snapshot-like structure with just this one admin
            adminsSnapshot = { docs: [adminDoc], empty: false };
            console.log(`🔍 Checking notifications for user ${userId} (1 admin: ${adminId})`);
        } else {
            // Get user's admins from Firestore
            // Admins are stored in the 'admins' collection, filter by userId field
            const adminsRef = db.collection('admins').where('userId', '==', userId);
            adminsSnapshot = await adminsRef.get();
            
            if (adminsSnapshot.empty) {
                console.log(`ℹ️ No admins found for user ${userId}`);
                return notifications;
            }
            
            console.log(`🔍 Checking notifications for user ${userId} (${adminsSnapshot.docs.length} admins)`);
        }
        
        for (const adminDoc of adminsSnapshot.docs) {
            const adminData = adminDoc.data();
            const adminId = adminDoc.id;
            const adminName = adminData.name || adminData.phone || 'Admin';
            const adminPhone = adminData.phone || '';
            
            // ==========================================
            // CRITICAL: Skip inactive admins completely
            // ==========================================
            // Check if admin is active using the SAME logic as frontend insights.js
            // RULE 1: Admin is active if ServiceNameValue contains "U-share Main"
            // RULE 2 (EXCEPTION): Admin is active if ServiceNameValue is "Mobile Internet" AND ValidityDateValue has a valid date
            // Otherwise, admin is inactive
            let isActive = false;
            
            const alfaData = adminData.alfaData || {};
            const hasAlfaData = alfaData && Object.keys(alfaData).length > 0 && !alfaData.error;
            
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
                                    isActive = true;
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
                                                    isActive = true;
                                                    break;
                                                }
                                            }
                                        }
                                        if (isActive) break;
                                    }
                                }
                            }
                        }
                    }
                } catch (statusError) {
                    console.warn(`⚠️ Error checking status from primaryData for admin ${adminId}:`, statusError.message);
                }
            }
            
            // Fallback: Also check apiResponses if primaryData not available
            if (!isActive && hasAlfaData && alfaData.apiResponses && Array.isArray(alfaData.apiResponses)) {
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
                                        isActive = true;
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
                                                        isActive = true;
                                                        break;
                                                    }
                                                }
                                            }
                                            if (isActive) break;
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
            
            // Skip inactive admins - they should NOT get any notifications
            if (!isActive) {
                console.log(`ℹ️ Skipping ${adminName} (INACTIVE admin - no notifications)`);
                continue;
            }
            
            console.log(`✅ ${adminName} is ACTIVE - checking for notifications`);
            
            // ==========================================
            // 1. CHECK: Admin quota usage at 80%
            // ==========================================
            // Use ADMIN consumption (not total consumption)
            // ONLY FOR ACTIVE ADMINS
            let adminConsumption = 0;
            let adminLimit = 0;
            const alfaDataForConsumption = adminData.alfaData || {};
            
            // Try to get from alfaData.adminConsumption (format: "47.97 / 77 GB")
            if (alfaDataForConsumption.adminConsumption) {
                const consumptionStr = String(alfaDataForConsumption.adminConsumption);
                const match = consumptionStr.match(/(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)/);
                if (match) {
                    adminConsumption = parseFloat(match[1]) || 0;
                    adminLimit = parseFloat(match[2]) || 0;
                    console.log(`✅ [${adminName}] Found adminConsumption from alfaData.adminConsumption: ${adminConsumption}/${adminLimit}`);
                }
            }
            
            // If not found, try to extract from primaryData (complex extraction like frontend)
            if (adminConsumption === 0 && alfaDataForConsumption.primaryData) {
                try {
                    const primaryData = alfaDataForConsumption.primaryData;
                    
                    // Look for U-Share Main service for admin consumption
                    if (primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue)) {
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
                                                console.log(`✅ [${adminName}] Extracted adminConsumption from U-Share Main SecondaryValue: ${adminConsumption} GB`);
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
                                            console.log(`✅ [${adminName}] Extracted adminConsumption from U-Share Main details: ${adminConsumption} GB`);
                                            break;
                                        }
                                    }
                                    if (adminConsumption > 0) break;
                                }
                            }
                        }
                        
                        // If U-Share Main not found, look for any U-Share service (but NOT Mobile Internet)
                        if (adminConsumption === 0) {
                            for (const service of primaryData.ServiceInformationValue) {
                                const serviceName = (service.ServiceNameValue || '').toLowerCase();
                                
                                // Skip Mobile Internet
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
                                                console.log(`✅ [${adminName}] Extracted adminConsumption from U-Share service: ${adminConsumption} GB`);
                                                break;
                                            }
                                        }
                                        if (adminConsumption > 0) break;
                                    }
                                }
                            }
                        }
                    }
                } catch (extractError) {
                    console.warn(`⚠️ [${adminName}] Error extracting adminConsumption from primaryData:`, extractError.message);
                }
            }
            
            // Get limit from adminData.quota if not found
            if (adminLimit === 0) {
                adminLimit = adminData.quota || 0;
            }
            
            // Debug logging for consumption check
            console.log(`🔍 [${adminName}] Consumption check: adminConsumption=${adminConsumption}, adminLimit=${adminLimit}, quota=${adminData.quota}`);
            
            // Check if admin consumption is >= 80% of limit
            if (adminConsumption > 0 && adminLimit > 0) {
                const consumptionPercentage = (adminConsumption / adminLimit) * 100;
                console.log(`📊 [${adminName}] Consumption percentage: ${consumptionPercentage.toFixed(1)}%`);
                
                if (consumptionPercentage >= 80) {
                    notifications.push({
                        type: 'high-consumption',
                        title: 'Quota Usage Alert',
                        message: `${adminName} has used ${adminConsumption.toFixed(2)} / ${adminLimit.toFixed(2)} GB`,
                        adminId: adminId,
                        adminPhone: adminPhone,
                        consumption: adminConsumption,
                        limit: adminLimit,
                        percentage: consumptionPercentage,
                        priority: consumptionPercentage >= 90 ? 'high' : 'medium'
                    });
                    console.log(`📢 Notification: ${adminName} has ${consumptionPercentage.toFixed(1)}% admin quota usage (${adminConsumption.toFixed(2)}/${adminLimit.toFixed(2)} GB)`);
                } else {
                    console.log(`ℹ️ [${adminName}] Consumption ${consumptionPercentage.toFixed(1)}% is below 80% threshold`);
                }
            } else {
                console.log(`⚠️ [${adminName}] Cannot check consumption - missing data: adminConsumption=${adminConsumption}, adminLimit=${adminLimit}`);
            }
            
            // ==========================================
            // 2. CHECK: Admin expiration less than 30 days
            // ==========================================
            // expiration is a number (days until expiration) from getexpirydate API
            // ONLY FOR ACTIVE ADMINS
            let expirationDays = null;
            
            // Check alfaData.expiration first
            if (adminData.alfaData && adminData.alfaData.expiration !== undefined && adminData.alfaData.expiration !== null) {
                expirationDays = parseInt(adminData.alfaData.expiration);
            }
            // Check _cachedExpiration
            else if (adminData._cachedExpiration && adminData._cachedExpiration.value !== undefined && adminData._cachedExpiration.value !== null) {
                expirationDays = parseInt(adminData._cachedExpiration.value);
            }
            // Check direct expiration field
            else if (adminData.expiration !== undefined && adminData.expiration !== null) {
                expirationDays = parseInt(adminData.expiration);
            }
            
            // Debug logging for expiration check
            console.log(`🔍 [${adminName}] Expiration check: expirationDays=${expirationDays}`);
            
            // Check if expiration is less than 30 days (and greater than 0)
            if (expirationDays !== null && !isNaN(expirationDays) && expirationDays > 0 && expirationDays < 30) {
                notifications.push({
                    type: 'expiration-warning',
                    title: 'Expiration Alert',
                    message: `${adminName} has less than 30 days to expire`,
                    adminId: adminId,
                    adminPhone: adminPhone,
                    expirationDays: expirationDays,
                    priority: expirationDays < 7 ? 'high' : expirationDays < 15 ? 'medium' : 'low'
                });
                console.log(`📢 Notification: ${adminName} (ACTIVE) has ${expirationDays} days until expiration`);
            } else {
                if (expirationDays === null || isNaN(expirationDays)) {
                    console.log(`ℹ️ [${adminName}] No expiration data found`);
                } else if (expirationDays <= 0) {
                    console.log(`ℹ️ [${adminName}] Expiration days is ${expirationDays} (expired or invalid)`);
                } else {
                    console.log(`ℹ️ [${adminName}] Expiration days ${expirationDays} is >= 30 days`);
                }
            }
        }
        
        console.log(`✅ Notification check complete: ${notifications.length} notification(s) found before deduplication`);
        
        // ==========================================
        // DEDUPLICATION: Only send one notification per admin per day
        // ==========================================
        if (notifications.length > 0) {
            try {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const todayTimestamp = today.getTime();
                
                // Get today's notifications from Firestore
                const notificationsRef = db.collection('users').doc(userId).collection('notifications');
                const todayNotifications = await notificationsRef
                    .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(today))
                    .get();
                
                // Build a set of adminIds that already have notifications today
                const notifiedAdminIdsToday = new Set();
                todayNotifications.docs.forEach(doc => {
                    const data = doc.data();
                    if (data.adminId) {
                        notifiedAdminIdsToday.add(data.adminId);
                    }
                });
                
                console.log(`ℹ️ Found ${notifiedAdminIdsToday.size} admin(s) already notified today`);
                
                // Filter out notifications for admins that were already notified today
                const dedupedNotifications = notifications.filter(notif => {
                    if (notifiedAdminIdsToday.has(notif.adminId)) {
                        console.log(`🚫 Skipping duplicate notification for admin ${notif.adminId} (already notified today)`);
                        return false;
                    }
                    return true;
                });
                
                console.log(`✅ After deduplication: ${dedupedNotifications.length} notification(s) to send`);
                return dedupedNotifications;
            } catch (dedupError) {
                console.error('❌ Error during deduplication:', dedupError);
                // If deduplication fails, return all notifications (fail-safe)
                return notifications;
            }
        }
        
        return notifications;
    } catch (error) {
        console.error('❌ Error checking for notifications:', error);
        console.error('   Stack:', error.stack);
        return notifications;
    }
}

// Helper function to send push notifications
async function sendPushNotifications(userId, notifications) {
    const db = getAdminDb();
    if (!db) return;
    
    try {
        // Get user's subscription
        const subscriptionDoc = await db.collection('pushSubscriptions').doc(userId).get();
        if (!subscriptionDoc.exists) {
            console.log(`No subscription found for user ${userId}`);
            return;
        }
        
        const subscriptionData = subscriptionDoc.data();
        const subscription = subscriptionData.subscription;
        
        let subscriptionInvalid = false;
        
        // Send each notification
        for (const notif of notifications) {
            let pushSent = false;
            
            try {
                const payload = JSON.stringify({
                    title: notif.title,
                    body: notif.message,
                    icon: '/assets/logo1.png',
                    badge: '/assets/logo1.png',
                    tag: `notification-${notif.type}-${notif.adminId}`,
                    data: {
                        adminId: notif.adminId,
                        adminPhone: notif.adminPhone || '',
                        type: notif.type,
                        url: '/pages/insights.html',
                        message: notif.message
                    }
                });
                
                await webpush.sendNotification(subscription, payload);
                pushSent = true;
                console.log(`✅ Push notification sent to user ${userId}: ${notif.title}`);
                
            } catch (error) {
                console.error(`❌ Error sending push notification:`, error.message);
                
                // If subscription is invalid, mark it and remove it
                if (error.statusCode === 410 || error.statusCode === 404) {
                    subscriptionInvalid = true;
                    console.log(`⚠️ Push subscription expired/invalid for user ${userId} (statusCode: ${error.statusCode})`);
                    console.log(`   Endpoint: ${error.endpoint?.substring(0, 50)}...`);
                    console.log(`   Please re-enable push notifications in the browser.`);
                }
            }
            
            // ALWAYS save notification to Firestore (even if push failed)
            // This ensures users can see notifications in the notification panel
            try {
                await db.collection('users').doc(userId).collection('notifications').add({
                    type: notif.type,
                    title: notif.title,
                    message: notif.message,
                    adminId: notif.adminId,
                    adminPhone: notif.adminPhone,
                    data: notif,
                    read: false,
                    pushSent: pushSent, // Track if push was successfully sent
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                
                if (!pushSent) {
                    console.log(`ℹ️ Notification saved to Firestore (push failed): ${notif.title}`);
                }
            } catch (saveError) {
                console.error(`❌ Error saving notification to Firestore:`, saveError.message);
            }
        }
        
        // Remove invalid subscription after processing all notifications
        if (subscriptionInvalid) {
            try {
                await db.collection('pushSubscriptions').doc(userId).delete();
                console.log(`🗑️ Removed invalid subscription for user ${userId}`);
                console.log(`💡 User needs to re-enable push notifications to receive future push notifications`);
            } catch (deleteError) {
                console.error(`❌ Error removing invalid subscription:`, deleteError.message);
            }
        }
    } catch (error) {
        console.error('Error sending push notifications:', error);
    }
}

// Export checkForNotifications for use in scheduled refresh
module.exports = router;
module.exports.checkForNotifications = checkForNotifications;
module.exports.sendPushNotifications = sendPushNotifications;

