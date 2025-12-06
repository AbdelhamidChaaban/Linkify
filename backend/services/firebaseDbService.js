// Import the functions you need from the SDKs you need
const { initializeApp } = require("firebase/app");
const { getFirestore, doc, getDoc, setDoc } = require("firebase/firestore");

// Your web app's Firebase configuration (from environment variables)
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

// Validate Firebase configuration
const requiredEnvVars = ['FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_PROJECT_ID'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.warn('⚠️ Missing required Firebase environment variables:', missingVars.join(', '));
  console.warn('   Please check your .env file in the backend folder.');
  console.warn('   Firebase operations will be disabled until variables are set.');
  // Don't throw - allow server to start without Firebase
}

// Initialize Firebase
let app;
let db;

try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  console.log('✅ Firebase initialized successfully');
} catch (error) {
  console.error('❌ Error initializing Firebase:', error.message);
  console.error('Stack:', error.stack);
  // Don't throw - allow server to start even if Firebase fails
  // Firebase will be retried when actually needed
  console.warn('⚠️ Firebase initialization failed, but server will continue. Firebase operations may fail.');
}

// Collection name for storing admins
const COLLECTION_NAME = 'admins';

/**
 * Remove undefined values from object
 */
function removeUndefined(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj;
  }
  
  if (typeof obj !== 'object') {
    return obj;
  }
  
  const cleaned = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      if (Array.isArray(obj[key])) {
        cleaned[key] = obj[key];
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        cleaned[key] = removeUndefined(obj[key]);
      } else {
        cleaned[key] = obj[key];
      }
    }
  }
  return cleaned;
}

/**
 * Update admin dashboard data
 * @param {string} adminId - Admin document ID
 * @param {Object} dashboardData - Dashboard data
 */
async function updateDashboardData(adminId, dashboardData) {
  // Completely disable Firebase if it's causing issues
  // Check if Firebase is disabled via environment variable
  if (process.env.DISABLE_FIREBASE === 'true') {
    console.log('ℹ️ Firebase saving is disabled via DISABLE_FIREBASE env var');
    return;
  }
  
  // Check if Firebase is initialized
  if (!db || !app) {
    console.warn('⚠️ Firebase not initialized, skipping database update');
    return; // Don't throw, just skip the save
  }
  
  // Wrap everything in a try-catch to ensure we never throw
  try {
    // Try to create doc reference - this might fail if db is offline
    let userDocRef;
    try {
      userDocRef = doc(db, COLLECTION_NAME, adminId);
    } catch (docError) {
      console.warn('⚠️ Could not create document reference (Firebase may be offline):', docError.message);
      return; // Can't proceed without a valid doc reference
    }
    
    // Preserve critical fields
    const totalConsumptionBackup = dashboardData.totalConsumption;
    const secondarySubscribersBackup = dashboardData.secondarySubscribers ? JSON.parse(JSON.stringify(dashboardData.secondarySubscribers)) : null;
    const balanceBackup = dashboardData.balance;
    const adminConsumptionBackup = dashboardData.adminConsumption;
    const adminConsumptionTemplateBackup = dashboardData.adminConsumptionTemplate ? JSON.parse(JSON.stringify(dashboardData.adminConsumptionTemplate)) : null;
    const apiResponsesBackup = dashboardData.apiResponses ? JSON.parse(JSON.stringify(dashboardData.apiResponses)) : null;
    const primaryDataBackup = dashboardData.primaryData ? JSON.parse(JSON.stringify(dashboardData.primaryData)) : null;
    const subscribersCountBackup = dashboardData.subscribersCount;
    const subscribersActiveCountBackup = dashboardData.subscribersActiveCount;
    const subscribersRequestedCountBackup = dashboardData.subscribersRequestedCount;
    
    // Clean data
    const cleanDashboardData = removeUndefined(dashboardData || {});
    
    // CRITICAL: NEVER save expiration = 0 to Firebase - if it's 0 or invalid, remove it
    if (cleanDashboardData.expiration === 0 || isNaN(cleanDashboardData.expiration) || (typeof cleanDashboardData.expiration === 'number' && cleanDashboardData.expiration <= 0)) {
        delete cleanDashboardData.expiration;
        console.log(`⚠️ [${adminId}] Removed invalid expiration (${dashboardData.expiration}) before saving to Firebase`);
    }
    
    // Force restore critical fields
    // CRITICAL: Always restore totalConsumption if it exists (even if it's an empty string, we want to preserve it)
    // Check for null/undefined specifically, not just truthy (empty string is falsy but valid)
    if (totalConsumptionBackup !== null && totalConsumptionBackup !== undefined) {
      cleanDashboardData.totalConsumption = totalConsumptionBackup;
      console.log(`✅ [${adminId}] Restored totalConsumption to Firebase: "${totalConsumptionBackup}"`);
    } else {
      console.warn(`⚠️ [${adminId}] WARNING: totalConsumptionBackup is null/undefined! dashboardData.totalConsumption was: ${dashboardData.totalConsumption}`);
    }
    
    if (secondarySubscribersBackup && Array.isArray(secondarySubscribersBackup) && secondarySubscribersBackup.length > 0) {
      cleanDashboardData.secondarySubscribers = secondarySubscribersBackup;
    }
    
    if (balanceBackup && !cleanDashboardData.balance) {
      cleanDashboardData.balance = String(balanceBackup).trim();
    }
    
    if (adminConsumptionBackup) {
      cleanDashboardData.adminConsumption = adminConsumptionBackup;
    }
    
    if (adminConsumptionTemplateBackup) {
      cleanDashboardData.adminConsumptionTemplate = adminConsumptionTemplateBackup;
    }
    
    if (apiResponsesBackup && Array.isArray(apiResponsesBackup) && apiResponsesBackup.length > 0) {
      cleanDashboardData.apiResponses = apiResponsesBackup;
    }
    
    if (primaryDataBackup && typeof primaryDataBackup === 'object' && Object.keys(primaryDataBackup).length > 0) {
      if (primaryDataBackup.ServiceInformationValue && Array.isArray(primaryDataBackup.ServiceInformationValue)) {
        cleanDashboardData.primaryData = primaryDataBackup;
      }
    }
    
    // Force restore subscriber count fields
    if (subscribersCountBackup !== undefined && subscribersCountBackup !== null) {
      cleanDashboardData.subscribersCount = subscribersCountBackup;
    }
    if (subscribersActiveCountBackup !== undefined && subscribersActiveCountBackup !== null) {
      cleanDashboardData.subscribersActiveCount = subscribersActiveCountBackup;
    }
    if (subscribersRequestedCountBackup !== undefined && subscribersRequestedCountBackup !== null) {
      cleanDashboardData.subscribersRequestedCount = subscribersRequestedCountBackup;
    }
    
    // Get current document to preserve other fields
    let currentData = {};
    try {
      const currentDoc = await getDoc(userDocRef);
      currentData = currentDoc.exists() ? currentDoc.data() : {};
    } catch (getError) {
      // Firebase is offline or failed - that's OK, we'll use empty currentData
      console.warn('⚠️ Could not get current document (Firebase may be offline):', getError.message);
      // Continue with empty currentData
    }
    
    // Track balance history (last 5 successful refreshes)
    if (balanceBackup && balanceBackup.trim()) {
      let balanceHistory = currentData.balanceHistory || [];
      
      // Add new balance entry with timestamp
      const balanceEntry = {
        balance: String(balanceBackup).trim(),
        timestamp: Date.now(),
        date: new Date().toISOString()
      };
      
      // Add to history (most recent first)
      balanceHistory.unshift(balanceEntry);
      
      // Keep only last 5 entries
      balanceHistory = balanceHistory.slice(0, 5);
      
      // Store in currentData for merging
      currentData.balanceHistory = balanceHistory;
    }
    
    // Preserve critical fields that should not be overwritten
    const preservedFields = {
      name: currentData.name,
      phone: currentData.phone,
      password: currentData.password,
      quota: currentData.quota,
      type: currentData.type,
      pendingSubscribers: Array.isArray(currentData.pendingSubscribers) ? currentData.pendingSubscribers : [], // CRITICAL: Preserve pending subscribers (always array)
      removedSubscribers: Array.isArray(currentData.removedSubscribers) ? currentData.removedSubscribers : [], // Preserve removed subscribers (always array)
      createdAt: currentData.createdAt,
      updatedAt: currentData.updatedAt
    };
    
    // Remove undefined values from preservedFields and currentData before merging
    const cleanPreservedFields = removeUndefined(preservedFields);
    const cleanCurrentData = removeUndefined(currentData || {});
    
    // Ensure arrays are never undefined
    if (!cleanPreservedFields.pendingSubscribers) {
      cleanPreservedFields.pendingSubscribers = [];
    }
    if (!cleanPreservedFields.removedSubscribers) {
      cleanPreservedFields.removedSubscribers = [];
    }
    
    // CRITICAL: Only save if primaryData exists (prevents admins becoming inactive)
    const hasPrimaryData = cleanDashboardData.primaryData && 
                          typeof cleanDashboardData.primaryData === 'object' && 
                          Object.keys(cleanDashboardData.primaryData).length > 0;
    
    if (!hasPrimaryData) {
      console.warn(`⚠️ Skipping Firebase save for ${adminId} - primaryData missing (would mark admin inactive)`);
      return; // Don't save incomplete data
    }
    
    // Update document
    try {
      await setDoc(userDocRef, {
        ...cleanPreservedFields,
        ...cleanCurrentData, // Include all other current data
        alfaData: cleanDashboardData,
        alfaDataFetchedAt: new Date().toISOString(),
        lastDataFetch: new Date().toISOString()
      }, { merge: false });
      
      // Log subscriber counts and totalConsumption for debugging
      const logParts = [];
      if (cleanDashboardData.subscribersCount !== undefined || cleanDashboardData.subscribersActiveCount !== undefined) {
        logParts.push(`subscribersCount: ${cleanDashboardData.subscribersCount}, activeCount: ${cleanDashboardData.subscribersActiveCount}, requestedCount: ${cleanDashboardData.subscribersRequestedCount}`);
      }
      if (cleanDashboardData.totalConsumption !== undefined) {
        logParts.push(`totalConsumption: "${cleanDashboardData.totalConsumption}"`);
      }
      if (logParts.length > 0) {
        console.log(`✅ Dashboard data saved to database - ${logParts.join(', ')}`);
      } else {
        console.log('✅ Dashboard data saved to database');
      }
    } catch (setError) {
      // Firebase is offline or failed - that's OK, data was fetched successfully
      console.warn('⚠️ Could not save to Firebase (Firebase may be offline):', setError.message);
      // Don't throw - the data was fetched successfully, just couldn't save it
      // The frontend will update via real-time listener when connection is restored
    }
  } catch (error) {
    // Catch ALL errors and never throw
    console.warn('⚠️ Firebase update failed (non-critical):', error?.message || String(error));
    console.warn('   Data was fetched successfully from Alfa - that is what matters');
    // Silently continue - don't throw any error
    return; // Explicitly return to ensure no error propagation
  }
}

/**
 * Get admin data by adminId
 * @param {string} adminId - Admin document ID
 * @returns {Promise<{phone: string, password: string, name: string} | null>} Admin data
 */
async function getAdminData(adminId) {
  // Check if Firebase is disabled
  if (process.env.DISABLE_FIREBASE === 'true') {
    console.log('ℹ️ Firebase is disabled via DISABLE_FIREBASE env var');
    return null;
  }
  
  // Check if Firebase is initialized
  if (!db || !app) {
    console.warn('⚠️ Firebase not initialized, cannot get admin data');
    return null;
  }
  
  try {
    const adminDocRef = doc(db, COLLECTION_NAME, adminId);
    const adminDoc = await getDoc(adminDocRef);
    
    if (!adminDoc.exists()) {
      console.warn(`⚠️ Admin document ${adminId} does not exist`);
      return null;
    }
    
    const data = adminDoc.data();
    return {
      phone: data.phone || '',
      password: data.password || '',
      name: data.name || ''
    };
  } catch (error) {
    console.error(`❌ Error getting admin data for ${adminId}:`, error.message);
    return null;
  }
}

/**
 * Add a pending subscriber to an admin
 * @param {string} adminId - Admin document ID
 * @param {string} subscriberPhone - Subscriber phone number
 * @param {number} quota - Quota in GB
 * @returns {Promise<boolean>} Success status
 */
async function addPendingSubscriber(adminId, subscriberPhone, quota) {
  // Check if Firebase is disabled
  if (process.env.DISABLE_FIREBASE === 'true') {
    console.log('ℹ️ Firebase is disabled via DISABLE_FIREBASE env var');
    return false;
  }
  
  // Check if Firebase is initialized
  if (!db || !app) {
    console.warn('⚠️ Firebase not initialized, cannot add pending subscriber');
    return false;
  }
  
  try {
    const adminDocRef = doc(db, COLLECTION_NAME, adminId);
    const adminDoc = await getDoc(adminDocRef);
    
    if (!adminDoc.exists()) {
      console.warn(`⚠️ Admin document ${adminId} does not exist`);
      return false;
    }
    
    const data = adminDoc.data();
    const pendingSubscribers = data.pendingSubscribers || [];
    
    // Check if subscriber already exists (avoid duplicates)
    const exists = pendingSubscribers.some(p => p.phone === subscriberPhone);
    if (exists) {
      console.log(`ℹ️ Pending subscriber ${subscriberPhone} already exists for admin ${adminId}`);
      return true; // Consider it success since it already exists
    }
    
    // Add new pending subscriber
    pendingSubscribers.push({
      phone: subscriberPhone,
      quota: quota,
      addedAt: new Date().toISOString()
    });
    
    // Update document
    await setDoc(adminDocRef, {
      ...data,
      pendingSubscribers: pendingSubscribers
    }, { merge: true });
    
    console.log(`✅ Added pending subscriber ${subscriberPhone} (quota: ${quota} GB) to admin ${adminId}. Total pending: ${pendingSubscribers.length}`);
    return true;
  } catch (error) {
    console.error(`❌ Error adding pending subscriber for ${adminId}:`, error.message);
    return false;
  }
}

/**
 * Get pending subscribers for an admin
 * @param {string} adminId - Admin document ID
 * @returns {Promise<Array<{phone: string, quota: number, addedAt: string}>>} Pending subscribers
 */
async function getPendingSubscribers(adminId) {
  // Check if Firebase is disabled
  if (process.env.DISABLE_FIREBASE === 'true') {
    return [];
  }
  
  // Check if Firebase is initialized
  if (!db || !app) {
    return [];
  }
  
  try {
    const adminDocRef = doc(db, COLLECTION_NAME, adminId);
    const adminDoc = await getDoc(adminDocRef);
    
    if (!adminDoc.exists()) {
      return [];
    }
    
    const data = adminDoc.data();
    return data.pendingSubscribers || [];
  } catch (error) {
    console.error(`❌ Error getting pending subscribers for ${adminId}:`, error.message);
    return [];
  }
}

/**
 * Remove a pending subscriber from an admin (when they accept the invitation)
 * @param {string} adminId - Admin document ID
 * @param {string} subscriberPhone - Subscriber phone number
 * @returns {Promise<boolean>} Success status
 */
async function removePendingSubscriber(adminId, subscriberPhone) {
  // Check if Firebase is disabled
  if (process.env.DISABLE_FIREBASE === 'true') {
    return false;
  }
  
  // Check if Firebase is initialized
  if (!db || !app) {
    return false;
  }
  
  try {
    const adminDocRef = doc(db, COLLECTION_NAME, adminId);
    const adminDoc = await getDoc(adminDocRef);
    
    if (!adminDoc.exists()) {
      return false;
    }
    
    const data = adminDoc.data();
    const pendingSubscribers = (data.pendingSubscribers || []).filter(
      p => p.phone !== subscriberPhone
    );
    
    // Update document
    await setDoc(adminDocRef, {
      ...data,
      pendingSubscribers: pendingSubscribers
    }, { merge: true });
    
    console.log(`✅ Removed pending subscriber ${subscriberPhone} from admin ${adminId}`);
    return true;
  } catch (error) {
    console.error(`❌ Error removing pending subscriber for ${adminId}:`, error.message);
    return false;
  }
}

/**
 * Add a removed subscriber to track (for confirmed subscribers that were removed)
 * @param {string} adminId - Admin document ID
 * @param {string} subscriberPhone - Subscriber phone number
 * @returns {Promise<boolean>} Success status
 */
async function addRemovedSubscriber(adminId, subscriberPhone) {
  // Check if Firebase is disabled
  if (process.env.DISABLE_FIREBASE === 'true') {
    return false;
  }
  
  // Check if Firebase is initialized
  if (!db || !app) {
    return false;
  }
  
  try {
    const adminDocRef = doc(db, COLLECTION_NAME, adminId);
    const adminDoc = await getDoc(adminDocRef);
    
    if (!adminDoc.exists()) {
      return false;
    }
    
    const data = adminDoc.data();
    const removedSubscribers = data.removedSubscribers || [];
    
    // Check if subscriber already in removed list
    if (removedSubscribers.includes(subscriberPhone)) {
      return true; // Already tracked
    }
    
    // Add to removed list
    removedSubscribers.push(subscriberPhone);
    
    // Update document
    await setDoc(adminDocRef, {
      ...data,
      removedSubscribers: removedSubscribers
    }, { merge: true });
    
    console.log(`✅ Added removed subscriber ${subscriberPhone} to admin ${adminId}`);
    return true;
  } catch (error) {
    console.error(`❌ Error adding removed subscriber for ${adminId}:`, error.message);
    return false;
  }
}

/**
 * Get balance history for an admin (last 5 successful refreshes)
 * @param {string} adminId - Admin document ID
 * @returns {Promise<Array>} Balance history array
 */
async function getBalanceHistory(adminId) {
  // Check if Firebase is disabled
  if (process.env.DISABLE_FIREBASE === 'true') {
    console.log('ℹ️ Firebase is disabled via DISABLE_FIREBASE env var');
    return [];
  }
  
  // Check if Firebase is initialized
  if (!db || !app) {
    console.warn('⚠️ Firebase not initialized, cannot get balance history');
    return [];
  }
  
  try {
    const userDocRef = doc(db, COLLECTION_NAME, adminId);
    const currentDoc = await getDoc(userDocRef);
    
    if (!currentDoc.exists()) {
      return [];
    }
    
    const data = currentDoc.data();
    const balanceHistory = data.balanceHistory || [];
    
    // Return last 5 entries (they're already sorted most recent first)
    return balanceHistory.slice(0, 5);
  } catch (error) {
    console.warn('⚠️ Could not get balance history:', error.message);
    return [];
  }
}

module.exports = {
  updateDashboardData,
  getAdminData,
  addPendingSubscriber,
  getPendingSubscribers,
  removePendingSubscriber,
  addRemovedSubscriber,
  getBalanceHistory
};

