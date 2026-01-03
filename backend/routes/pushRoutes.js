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
async function checkForNotifications(userId) {
    const notifications = [];
    const db = getAdminDb();
    if (!db) return notifications;
    
    try {
        // Get user's admins from Firestore
        // Admins are stored in the 'admins' collection, filter by userId field
        const adminsRef = db.collection('admins').where('userId', '==', userId);
        const adminsSnapshot = await adminsRef.get();
        
        const now = new Date();
        const oneDayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours
        const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days
        
        for (const adminDoc of adminsSnapshot.docs) {
            const adminData = adminDoc.data();
            const adminId = adminDoc.id;
            
            // Check expiration - check both alfaData.validityDate and direct expiryDate
            let expiryDateValue = null;
            if (adminData.alfaData && adminData.alfaData.validityDate) {
                // Parse validity date string (format: "DD/MM/YYYY" or "DD-MM-YYYY")
                const validityDateStr = adminData.alfaData.validityDate;
                const dateMatch = validityDateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
                if (dateMatch) {
                    const [, day, month, year] = dateMatch;
                    expiryDateValue = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
                    expiryDateValue.setHours(23, 59, 59, 999); // End of day
                }
            } else if (adminData.expiryDate) {
                expiryDateValue = adminData.expiryDate.toDate ? adminData.expiryDate.toDate() : new Date(adminData.expiryDate);
            }
            
            if (expiryDateValue && expiryDateValue > now) {
                if (expiryDateValue <= oneDayFromNow) {
                    // Expiring within 24 hours
                    const hoursUntilExpiry = Math.round((expiryDateValue - now) / (1000 * 60 * 60));
                    notifications.push({
                        type: 'expiring',
                        title: 'Admin Expiring Soon',
                        message: `${adminData.phone || adminData.name || 'Admin'} expires in ${hoursUntilExpiry} hour${hoursUntilExpiry !== 1 ? 's' : ''}`,
                        adminId: adminId,
                        adminPhone: adminData.phone,
                        expiryDate: expiryDateValue,
                        priority: hoursUntilExpiry <= 12 ? 'high' : 'medium'
                    });
                } else if (expiryDateValue <= threeDaysFromNow) {
                    // Expiring within 3 days (but more than 24 hours)
                    const daysUntilExpiry = Math.round((expiryDateValue - now) / (1000 * 60 * 60 * 24));
                    notifications.push({
                        type: 'expiring',
                        title: 'Admin Expiring Soon',
                        message: `${adminData.phone || adminData.name || 'Admin'} expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}`,
                        adminId: adminId,
                        adminPhone: adminData.phone,
                        expiryDate: expiryDateValue,
                        priority: 'low'
                    });
                }
            }
            
            // Check high consumption
            // Get consumption data from alfaData - check multiple possible locations
            let totalConsumption = 0;
            let totalLimit = 0;
            
            // Try to get from alfaData.primaryData.totalConsumption (format: "47.97 / 77 GB")
            if (adminData.alfaData && adminData.alfaData.primaryData) {
                const primaryData = adminData.alfaData.primaryData;
                if (primaryData.totalConsumption) {
                    // Parse format like "47.97 / 77 GB" or just "47.97"
                    const consumptionStr = String(primaryData.totalConsumption);
                    const match = consumptionStr.match(/(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)/);
                    if (match) {
                        totalConsumption = parseFloat(match[1]) || 0;
                        totalLimit = parseFloat(match[2]) || 0;
                    } else {
                        // Try to parse just the number
                        totalConsumption = parseFloat(consumptionStr) || 0;
                    }
                }
            }
            
            // If not found, try consumptionData
            if (totalConsumption === 0 && adminData.alfaData && adminData.alfaData.consumptionData) {
                const consumptionData = adminData.alfaData.consumptionData;
                if (consumptionData.totalConsumption) {
                    totalConsumption = parseFloat(consumptionData.totalConsumption) || 0;
                }
            }
            
            // Get limit from adminData if not found in consumption string
            if (totalLimit === 0) {
                totalLimit = adminData.totalLimit || adminData.quota || 0;
            }
            
            // Check if consumption is high (above 80% of limit)
            const highConsumptionThreshold = 80; // 80% of limit
            
            if (totalConsumption > 0 && totalLimit > 0) {
                const consumptionPercentage = (totalConsumption / totalLimit) * 100;
                
                if (consumptionPercentage >= highConsumptionThreshold) {
                    notifications.push({
                        type: 'high-consumption',
                        title: 'High Consumption Warning',
                        message: `${adminData.phone || adminData.name || 'Admin'} has ${consumptionPercentage.toFixed(1)}% consumption (${totalConsumption.toFixed(2)}/${totalLimit} GB)`,
                        adminId: adminId,
                        adminPhone: adminData.phone,
                        consumption: totalConsumption,
                        limit: totalLimit,
                        percentage: consumptionPercentage,
                        priority: consumptionPercentage >= 90 ? 'high' : 'medium'
                    });
                }
            }
        }
        
        return notifications;
    } catch (error) {
        console.error('Error checking for notifications:', error);
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
        
        // Send each notification
        for (const notif of notifications) {
            try {
                const payload = JSON.stringify({
                    title: notif.title,
                    body: notif.message,
                    icon: '/assets/logo1.png',
                    badge: '/assets/logo1.png',
                    tag: `notification-${notif.type}-${notif.adminId}`,
                    data: {
                        adminId: notif.adminId,
                        type: notif.type,
                        url: '/pages/insights.html'
                    }
                });
                
                await webpush.sendNotification(subscription, payload);
                console.log(`✅ Push notification sent to user ${userId}: ${notif.title}`);
                
                // Save notification to Firestore subcollection: users/{userId}/notifications
                await db.collection('users').doc(userId).collection('notifications').add({
                    type: notif.type,
                    title: notif.title,
                    message: notif.message,
                    adminId: notif.adminId,
                    adminPhone: notif.adminPhone,
                    data: notif,
                    read: false,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                
            } catch (error) {
                console.error(`Error sending push notification:`, error);
                // If subscription is invalid, remove it
                if (error.statusCode === 410 || error.statusCode === 404) {
                    await db.collection('pushSubscriptions').doc(userId).delete();
                    console.log(`Removed invalid subscription for user ${userId}`);
                }
            }
        }
    } catch (error) {
        console.error('Error sending push notifications:', error);
    }
}

module.exports = router;

