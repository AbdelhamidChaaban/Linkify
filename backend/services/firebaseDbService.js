// Import the functions you need from the SDKs you need
const { initializeApp } = require("firebase/app");
const { getFirestore, doc, getDoc, setDoc, collection, addDoc, query, orderBy, limit, getDocs, where, deleteDoc } = require("firebase/firestore");

// Firebase Admin SDK for actionLogs (bypasses security rules)
let adminDb = null;
function initializeAdminDb() {
    if (adminDb) return adminDb; // Already initialized
    
    try {
        const admin = require('firebase-admin');
        if (!admin.apps || admin.apps.length === 0) {
            // Try to initialize Admin SDK if service account is available
            const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
                ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
                : null;
            
            if (serviceAccount) {
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount)
                });
                console.log('✅ Firebase Admin initialized for actionLogs');
            } else {
                return null;
            }
        }
        
        adminDb = admin.firestore();
        return adminDb;
    } catch (error) {
        console.warn('⚠️ Firebase Admin not available for actionLogs:', error.message);
        console.warn('   Will use client SDK (may require security rules)');
        return null;
    }
}

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
 * @param {string} expectedUserId - Optional: Expected userId for validation (security)
 */
async function updateDashboardData(adminId, dashboardData, expectedUserId = null) {
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
    
    // CRITICAL: Always preserve primaryData if it exists (needed for status determination)
    // Don't require ServiceInformationValue - the API response structure may vary
    // As long as primaryData is a valid object, preserve it (frontend can handle missing fields)
    if (primaryDataBackup && typeof primaryDataBackup === 'object' && Object.keys(primaryDataBackup).length > 0) {
      cleanDashboardData.primaryData = primaryDataBackup;
      // Ensure ServiceInformationValue is at least an empty array if missing (for compatibility)
      if (!cleanDashboardData.primaryData.ServiceInformationValue || !Array.isArray(cleanDashboardData.primaryData.ServiceInformationValue)) {
        cleanDashboardData.primaryData.ServiceInformationValue = [];
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
      if (!currentDoc.exists()) {
        console.warn(`⚠️ Admin document ${adminId} does not exist`);
        return; // Don't create new document if it doesn't exist
      }
      currentData = currentDoc.data();
      
      // SECURITY: Validate userId if provided
      if (expectedUserId && currentData.userId && currentData.userId !== expectedUserId) {
        console.warn(`⚠️ Security: Admin ${adminId} does not belong to user ${expectedUserId}, update rejected`);
        return; // Reject update to prevent unauthorized modification
      }
    } catch (getError) {
      // Firebase is offline or failed - that's OK, we'll use empty currentData
      console.warn('⚠️ Could not get current document (Firebase may be offline):', getError.message);
      // Continue with empty currentData (but we can't validate userId if offline)
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
    
    // CRITICAL: Store successful dates/expiration with timestamps for fallback on API failure
    // Only update cache when we have valid values from successful API calls
    const now = Date.now();
    const nowISO = new Date().toISOString();
    
    // Cache subscriptionDate and validityDate from getmyservices API (only if valid)
    if (cleanDashboardData.subscriptionDate && 
        typeof cleanDashboardData.subscriptionDate === 'string' && 
        cleanDashboardData.subscriptionDate.trim() && 
        !cleanDashboardData.subscriptionDate.includes('NaN')) {
      currentData._cachedDates = currentData._cachedDates || {};
      currentData._cachedDates.subscriptionDate = {
        value: cleanDashboardData.subscriptionDate,
        timestamp: now,
        date: nowISO
      };
    }
    
    if (cleanDashboardData.validityDate && 
        typeof cleanDashboardData.validityDate === 'string' && 
        cleanDashboardData.validityDate.trim() && 
        !cleanDashboardData.validityDate.includes('NaN')) {
      currentData._cachedDates = currentData._cachedDates || {};
      currentData._cachedDates.validityDate = {
        value: cleanDashboardData.validityDate,
        timestamp: now,
        date: nowISO
      };
    }
    
    // Cache expiration from getexpirydate API (only if valid and > 0)
    if (cleanDashboardData.expiration !== undefined && 
        cleanDashboardData.expiration !== null && 
        typeof cleanDashboardData.expiration === 'number' && 
        !isNaN(cleanDashboardData.expiration) && 
        cleanDashboardData.expiration > 0) {
      currentData._cachedExpiration = {
        value: cleanDashboardData.expiration,
        timestamp: now,
        date: nowISO
      };
    }
    
    // CRITICAL: Preserve existing removedActiveSubscribers and merge with newly detected ones
    // Start with existing removed subscribers from Firebase (always preserve them)
    let removedActiveSubscribersToSave = Array.isArray(currentData.removedActiveSubscribers) ? currentData.removedActiveSubscribers : [];
    let removedSubscribersToSave = Array.isArray(currentData.removedSubscribers) ? currentData.removedSubscribers : [];
    
    console.log(`🔄 [${adminId}] Current removedActiveSubscribers in Firebase: ${removedActiveSubscribersToSave.length}`);
    
    // If detected removed subscribers are provided, merge them with existing ones (avoid duplicates)
    if (cleanDashboardData.detectedRemovedActiveSubscribers && Array.isArray(cleanDashboardData.detectedRemovedActiveSubscribers)) {
      console.log(`🔄 [${adminId}] Processing detected removed subscribers: ${cleanDashboardData.detectedRemovedActiveSubscribers.length} total detected`);
      
      // The detected list already includes existing + newly detected, so use it directly
      // But we need to ensure we don't lose any that might be in currentData but not in detected
      // Since detection code already merges existing + newly detected, we can trust it
      if (cleanDashboardData.detectedRemovedActiveSubscribers.length > 0) {
        console.log(`🔄 [${adminId}] Using detected removed subscribers list (${cleanDashboardData.detectedRemovedActiveSubscribers.length} total)`);
        removedActiveSubscribersToSave = cleanDashboardData.detectedRemovedActiveSubscribers;
        
        // Update removedSubscribers array (for backward compatibility) - extract phone numbers
        const detectedPhoneNumbers = new Set(cleanDashboardData.detectedRemovedActiveSubscribers.map(sub => sub.phoneNumber));
        removedSubscribersToSave = Array.from(detectedPhoneNumbers);
        console.log(`   ✅ Updated removedSubscribers array to ${removedSubscribersToSave.length} phone number(s) (backward compatibility)`);
        
        console.log(`✅ [${adminId}] Successfully set ${removedActiveSubscribersToSave.length} removed active subscriber(s) to be saved`);
      } else {
        console.log(`ℹ️ [${adminId}] Detected list is empty, preserving existing ${removedActiveSubscribersToSave.length} removed subscriber(s)`);
      }
      
      // Remove detectedRemovedActiveSubscribers from cleanDashboardData (it's a temporary field)
      delete cleanDashboardData.detectedRemovedActiveSubscribers;
    } else {
      console.log(`ℹ️ [${adminId}] No detectedRemovedActiveSubscribers in dashboardData - preserving existing ${removedActiveSubscribersToSave.length} removed subscriber(s) from Firebase`);
    }
    
    // CRITICAL: Clear removedActiveSubscribers when validity date passes (billing cycle reset)
    // Cleanup happens when today is AFTER the validity date (at 00:00:00 on the day after validity date)
    // Example: If validity date is 22/12/2025, cleanup happens at 00:00:00 on 23/12/2025
    // Track last cleanup date to prevent multiple cleanups
    const validityDateStr = cleanDashboardData.validityDate || 
                           currentData.alfaData?.validityDate || 
                           currentData._cachedDates?.validityDate?.value;
    
    if (validityDateStr && typeof validityDateStr === 'string' && validityDateStr.trim()) {
      // Parse validity date (format: "DD/MM/YYYY" like "22/12/2025" or "DD-MM-YYYY")
      const dateMatch = validityDateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if (dateMatch) {
        const [, day, month, year] = dateMatch;
        const validityDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        validityDate.setHours(23, 59, 59, 999); // End of validity date day
        
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Start of today
        
        // Check if today is AFTER validity date (i.e., today > validity date)
        // This means validity date has passed, so we should clear removed subscribers
        if (today.getTime() > validityDate.getTime()) {
          // Get last cleanup date from currentData (format: "YYYY-MM-DD")
          const lastCleanupDateStr = currentData._lastRemovedCleanupDate || null;
          const todayStr = today.toISOString().split('T')[0]; // Format: "YYYY-MM-DD"
          
          // Check if we need to perform cleanup
          // Cleanup should happen once per day when validity date has passed
          // We check if cleanup hasn't happened today yet
          const shouldCleanup = lastCleanupDateStr !== todayStr;
          
          if (shouldCleanup) {
            if (removedActiveSubscribersToSave.length > 0 || removedSubscribersToSave.length > 0) {
              console.log(`🔄 [${adminId}] [Cleanup] Validity date (${validityDateStr}) has passed - clearing removed subscribers (billing cycle reset)`);
              console.log(`   [Cleanup] Removed subscribers cleared for admin ${adminId}`);
              console.log(`   [Cleanup] Clearing ${removedActiveSubscribersToSave.length} removed active subscriber(s) and ${removedSubscribersToSave.length} removed subscriber phone(s)`);
              removedActiveSubscribersToSave = []; // Clear the list for new billing cycle
              removedSubscribersToSave = []; // Clear the list for new billing cycle
              
              // Track that cleanup happened today (will be saved to Firebase below)
              currentData._lastRemovedCleanupDate = todayStr;
              console.log(`   [Cleanup] Marked cleanup date as ${todayStr} to prevent duplicate cleanups`);
            } else {
              // No subscribers to clean, but still mark cleanup date to prevent repeated checks
              currentData._lastRemovedCleanupDate = todayStr;
              console.log(`ℹ️ [${adminId}] [Cleanup] Validity date (${validityDateStr}) has passed, but no removed subscribers to clean`);
            }
          } else {
            console.log(`ℹ️ [${adminId}] [Cleanup] Cleanup already performed today (${todayStr}) - skipping to prevent duplicate cleanups`);
          }
        }
      }
    }
    
    // Preserve critical fields that should not be overwritten
    const preservedFields = {
      name: currentData.name,
      phone: currentData.phone,
      password: currentData.password,
      quota: currentData.quota,
      type: currentData.type,
      userId: currentData.userId || null, // CRITICAL: Preserve userId for data isolation
      pendingSubscribers: Array.isArray(currentData.pendingSubscribers) ? currentData.pendingSubscribers : [], // CRITICAL: Preserve pending subscribers (always array)
      removedSubscribers: removedSubscribersToSave, // Merged with detected removed subscribers (for backward compatibility)
      removedActiveSubscribers: removedActiveSubscribersToSave, // Merged with detected removed subscribers, cleared if validity date matched
      _lastRemovedCleanupDate: currentData._lastRemovedCleanupDate || null, // Track when removed subscribers were last cleaned up (prevents duplicate cleanups)
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
    if (!cleanPreservedFields.removedActiveSubscribers) {
      cleanPreservedFields.removedActiveSubscribers = [];
    }
    
    // CRITICAL: Remove fields from cleanCurrentData that are in preservedFields to prevent overwriting
    // These fields should be set by preservedFields, not by currentData
    const { removedActiveSubscribers: _, removedSubscribers: __, pendingSubscribers: ___, _lastRemovedCleanupDate: ____, ...cleanCurrentDataWithoutPreserved } = cleanCurrentData;
    
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
        ...cleanCurrentDataWithoutPreserved, // Include all other current data first
        ...cleanPreservedFields, // Then apply preserved fields (these take precedence)
        alfaData: cleanDashboardData,
        alfaDataFetchedAt: new Date().toISOString(),
        lastDataFetch: new Date().toISOString()
      }, { merge: false });
      
      // Log removedActiveSubscribers for debugging
      if (removedActiveSubscribersToSave.length > 0) {
        console.log(`✅ [${adminId}] Saved ${removedActiveSubscribersToSave.length} removed active subscriber(s) to Firebase:`, removedActiveSubscribersToSave.map(s => s.phoneNumber).join(', '));
      }
      
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
 * @param {string} expectedUserId - Optional: Expected userId for validation (security)
 * @returns {Promise<{phone: string, password: string, name: string} | null>} Admin data
 * 
 * SECURITY NOTE: This function does not validate userId by default.
 * The frontend is responsible for filtering by userId and validating ownership.
 * For enhanced security, pass expectedUserId and this function will verify ownership.
 */
async function getAdminData(adminId, expectedUserId = null) {
  // Check if Firebase is disabled
  if (process.env.DISABLE_FIREBASE === 'true') {
    console.log('ℹ️ Firebase is disabled via DISABLE_FIREBASE env var');
    return null;
  }
  
  // Use Admin SDK to bypass security rules
  const adminDbInstance = initializeAdminDb();
  if (!adminDbInstance) {
    console.warn('⚠️ Firebase Admin SDK not available, cannot get admin data');
    return null;
  }
  
  try {
    const adminDoc = await adminDbInstance.collection(COLLECTION_NAME).doc(adminId).get();
    
    if (!adminDoc.exists) {
      console.warn(`⚠️ Admin document ${adminId} does not exist`);
      return null;
    }
    
    const data = adminDoc.data();
    
    // SECURITY: Validate userId if provided
    if (expectedUserId && data.userId && data.userId !== expectedUserId) {
      console.warn(`⚠️ Security: Admin ${adminId} does not belong to user ${expectedUserId}`);
      return null; // Return null to prevent unauthorized access
    }
    
    // Ensure alfaData.secondarySubscribers is properly structured
    const alfaData = data.alfaData || null;
    if (alfaData && !Array.isArray(alfaData.secondarySubscribers)) {
      // Ensure secondarySubscribers is always an array
      alfaData.secondarySubscribers = alfaData.secondarySubscribers || [];
    }
    
    return {
      phone: data.phone || '',
      password: data.password || '',
      name: data.name || '',
      userId: data.userId || null, // Include userId in response
      // Include cached dates and expiration for fallback
      _cachedDates: data._cachedDates || null,
      _cachedExpiration: data._cachedExpiration || null,
      // Also include expiration from alfaData for backward compatibility
      expiration: alfaData?.expiration || null,
      // Include full alfaData for checking subscriber status (with guaranteed secondarySubscribers array)
      alfaData: alfaData,
      // Include removedActiveSubscribers for detection logic
      removedActiveSubscribers: Array.isArray(data.removedActiveSubscribers) ? data.removedActiveSubscribers : [],
      // Include removedSubscribers for backward compatibility
      removedSubscribers: Array.isArray(data.removedSubscribers) ? data.removedSubscribers : []
    };
  } catch (error) {
    console.error(`❌ Error getting admin data for ${adminId}:`, error.message);
    return null;
  }
}

/**
 * Get full admin data including alfaData (alias for getAdminData with full data)
 * @param {string} adminId - Admin document ID
 * @returns {Promise<Object|null>} Full admin data including alfaData
 */
async function getFullAdminData(adminId) {
  return await getAdminData(adminId);
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
 * Uses Admin SDK to bypass security rules
 * @param {string} adminId - Admin document ID
 * @returns {Promise<Array<{phone: string, quota: number, addedAt: string}>>} Pending subscribers
 */
async function getPendingSubscribers(adminId) {
  // Check if Firebase is disabled
  if (process.env.DISABLE_FIREBASE === 'true') {
    return [];
  }
  
  // Use Admin SDK to bypass security rules
  const adminDbInstance = initializeAdminDb();
  if (!adminDbInstance) {
    console.warn('⚠️ Firebase Admin SDK not available, cannot get pending subscribers');
    return [];
  }
  
  try {
    const adminDoc = await adminDbInstance.collection(COLLECTION_NAME).doc(adminId).get();
    
    if (!adminDoc.exists) {
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
 * Add a removed Active subscriber with full data (for displaying as "Out" in view details)
 * @param {string} adminId - Admin document ID
 * @param {Object} subscriberData - Subscriber data with phoneNumber, fullPhoneNumber, consumption, limit
 * @returns {Promise<boolean>} Success status
 */
async function addRemovedActiveSubscriber(adminId, subscriberData) {
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
    const removedActiveSubscribers = data.removedActiveSubscribers || [];
    
    // Check if subscriber already in removed Active list
    const phoneToCheck = subscriberData.phoneNumber;
    if (removedActiveSubscribers.some(sub => sub.phoneNumber === phoneToCheck)) {
      return true; // Already tracked
    }
    
    // Add to removed Active list with full data
    removedActiveSubscribers.push({
      phoneNumber: subscriberData.phoneNumber,
      fullPhoneNumber: subscriberData.fullPhoneNumber || subscriberData.phoneNumber,
      consumption: subscriberData.consumption || 0,
      limit: subscriberData.limit || 0,
      status: 'Active' // Always Active since we only store Active removed subscribers
    });
    
    // Also add to removedSubscribers array (for backward compatibility)
    const removedSubscribers = data.removedSubscribers || [];
    if (!removedSubscribers.includes(phoneToCheck)) {
      removedSubscribers.push(phoneToCheck);
    }
    
    // Update document
    await setDoc(adminDocRef, {
      ...data,
      removedActiveSubscribers: removedActiveSubscribers,
      removedSubscribers: removedSubscribers
    }, { merge: true });
    
    console.log(`✅ Added removed Active subscriber ${phoneToCheck} to admin ${adminId} with data`);
    return true;
  } catch (error) {
    console.error(`❌ Error adding removed Active subscriber for ${adminId}:`, error.message);
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

/**
 * Log an action (add/edit/remove subscriber) to the action logs collection
 * @param {string} userId - User ID (from Firebase auth)
 * @param {string} adminId - Admin document ID
 * @param {string} adminName - Admin name
 * @param {string} adminPhone - Admin phone number
 * @param {string} action - Action type: 'add', 'edit', 'remove'
 * @param {string} subscriberPhone - Subscriber phone number
 * @param {number} quota - Quota in GB (optional, for add/edit)
 * @param {boolean} success - Whether the action succeeded
 * @param {string} errorMessage - Error message if failed (optional)
 * @returns {Promise<boolean>} Success status
 */
async function logAction(userId, adminId, adminName, adminPhone, action, subscriberPhone, quota = null, success = true, errorMessage = null) {
  // Check if Firebase is disabled
  if (process.env.DISABLE_FIREBASE === 'true') {
    return false;
  }
  
  try {
    // Prefer Admin SDK (bypasses security rules) - initialize if needed
    const adminDbInstance = initializeAdminDb();
    if (adminDbInstance) {
      const actionLog = {
        userId,
        adminId,
        adminName: adminName || 'Unknown',
        adminPhone: adminPhone || '',
        action, // 'add', 'edit', 'remove'
        subscriberPhone,
        success,
        timestamp: new Date().toISOString(),
        createdAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
      };
      
      if (quota !== null && quota !== undefined) {
        actionLog.quota = quota;
      }
      if (errorMessage) {
        actionLog.errorMessage = errorMessage;
      }
      
      await adminDbInstance.collection('actionLogs').add(actionLog);
      console.log(`✅ Logged action: ${action} subscriber ${subscriberPhone} for admin ${adminId} (${success ? 'success' : 'failed'})`);
      
      // Update user revenue if action is 'add' and successful
      if (action === 'add' && success && quota !== null && quota !== undefined && userId) {
        try {
          const userRef = adminDbInstance.collection('users').doc(userId);
          const userDoc = await userRef.get();
          
          if (userDoc.exists) {
            const userData = userDoc.data();
            const defaultPrices = userData.defaultPrices || {};
            const quotaNum = typeof quota === 'string' ? parseFloat(quota) : quota;
            
            // Calculate price for this quota
            let price = 0;
            if (defaultPrices[quotaNum] !== undefined) {
              price = defaultPrices[quotaNum];
            } else if (defaultPrices[String(quotaNum)] !== undefined) {
              price = defaultPrices[String(quotaNum)];
            }
            
            // Update revenue if price is found
            if (price > 0) {
              const admin = require('firebase-admin');
              const currentRevenue = userData.revenue || 0;
              await userRef.update({
                revenue: currentRevenue + price,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
              console.log(`💰 Updated revenue for user ${userId}: +${price} (total: ${currentRevenue + price})`);
            }
          }
        } catch (revenueError) {
          // Non-critical error - log but don't fail the action logging
          console.warn(`⚠️ Failed to update revenue for user ${userId}:`, revenueError.message);
        }
      }
      
      return true;
    }
    
    // Fallback to client SDK (requires security rules)
    if (!db || !app) {
      console.warn('⚠️ Firebase not initialized, cannot log action');
      return false;
    }
    
    const actionsCollection = collection(db, 'actionLogs');
    const actionLog = {
      userId,
      adminId,
      adminName: adminName || 'Unknown',
      adminPhone: adminPhone || '',
      action, // 'add', 'edit', 'remove'
      subscriberPhone,
      quota: quota !== null ? quota : undefined,
      success,
      errorMessage: errorMessage || undefined,
      timestamp: new Date().toISOString(),
      createdAt: new Date()
    };
    
    // Remove undefined values
    Object.keys(actionLog).forEach(key => {
      if (actionLog[key] === undefined) {
        delete actionLog[key];
      }
    });
    
    await addDoc(actionsCollection, actionLog);
    console.log(`✅ Logged action: ${action} subscriber ${subscriberPhone} for admin ${adminId} (${success ? 'success' : 'failed'})`);
    
    // Update user revenue if action is 'add' and successful (client SDK fallback)
    // Note: This requires security rules to allow user document updates
    if (action === 'add' && success && quota !== null && quota !== undefined && userId) {
      try {
        // Try to use Admin SDK for revenue update (more reliable)
        const adminDbInstance = initializeAdminDb();
        if (adminDbInstance) {
          const userRef = adminDbInstance.collection('users').doc(userId);
          const userDoc = await userRef.get();
          
          if (userDoc.exists) {
            const userData = userDoc.data();
            const defaultPrices = userData.defaultPrices || {};
            const quotaNum = typeof quota === 'string' ? parseFloat(quota) : quota;
            
            // Calculate price for this quota
            let price = 0;
            if (defaultPrices[quotaNum] !== undefined) {
              price = defaultPrices[quotaNum];
            } else if (defaultPrices[String(quotaNum)] !== undefined) {
              price = defaultPrices[String(quotaNum)];
            }
            
            // Update revenue if price is found
            if (price > 0) {
              const admin = require('firebase-admin');
              const currentRevenue = userData.revenue || 0;
              await userRef.update({
                revenue: currentRevenue + price,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
              console.log(`💰 Updated revenue for user ${userId}: +${price} (total: ${currentRevenue + price})`);
            }
          }
        }
        // If Admin SDK not available, skip revenue update (requires security rules for client SDK)
      } catch (revenueError) {
        // Non-critical error - log but don't fail the action logging
        console.warn(`⚠️ Failed to update revenue for user ${userId}:`, revenueError.message);
      }
    }
    
    return true;
  } catch (error) {
    console.error('❌ Error logging action:', error.message);
    console.error('   Stack:', error.stack);
    return false;
  }
}

/**
 * Get action logs for a user
 * @param {string} userId - User ID (from Firebase auth)
 * @param {Object} options - Query options
 * @param {string} options.actionFilter - Filter by action type: 'all', 'add', 'edit', 'remove'
 * @param {number} options.limit - Maximum number of logs to return
 * @param {string} options.startAfter - Document ID to start after (for pagination)
 * @returns {Promise<Array>} Array of action logs
 */
async function getActionLogs(userId, options = {}) {
  const {
    actionFilter = 'all',
    dateFilter = 'all',
    limitCount = 100,
    startAfter = null
  } = options;
  
  // Calculate minimum timestamp based on date filter
  let minTimestamp = null;
  if (dateFilter !== 'all') {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    switch (dateFilter) {
      case 'today':
        minTimestamp = todayStart;
        break;
      case 'yesterday':
        const yesterdayStart = new Date(todayStart);
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        minTimestamp = yesterdayStart;
        break;
      case '7days':
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        minTimestamp = sevenDaysAgo;
        break;
      case '30days':
        const thirtyDaysAgo = new Date(now);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        minTimestamp = thirtyDaysAgo;
        break;
    }
  }
  
  // Check if Firebase is disabled
  if (process.env.DISABLE_FIREBASE === 'true') {
    return [];
  }
  
  try {
    // Prefer Admin SDK (bypasses security rules)
    const adminDbInstance = initializeAdminDb();
    if (adminDbInstance) {
      try {
        const admin = require('firebase-admin');
        // Query using composite index: action, userId, timestamp
        // When using composite indexes, where clauses should match index order
        let query = adminDbInstance.collection('actionLogs');
        
        // Add date filter if specified (filter by timestamp >= minTimestamp)
        if (minTimestamp) {
          query = query.where('timestamp', '>=', admin.firestore.Timestamp.fromDate(minTimestamp));
        }
        
        // Build query based on filter - match index field order (action, userId, timestamp)
        if (actionFilter !== 'all') {
          query = query.where('action', '==', actionFilter);
        }
        query = query.where('userId', '==', userId);
        query = query.orderBy('timestamp', 'desc');
        query = query.limit(limitCount);
        
        const querySnapshot = await query.get();
        let logs = [];
        
        querySnapshot.forEach((doc) => {
          const data = doc.data();
          // Handle 'yesterday' filter in memory (needs upper bound check)
          if (dateFilter === 'yesterday') {
            const logTimestamp = data.timestamp || data.createdAt;
            let logDate;
            if (logTimestamp && logTimestamp.toDate) {
              logDate = logTimestamp.toDate();
            } else if (typeof logTimestamp === 'string') {
              logDate = new Date(logTimestamp);
            } else {
              logDate = new Date();
            }
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            if (logDate >= todayStart) {
              return; // Skip logs from today
            }
          }
          
          logs.push({
            id: doc.id,
            ...data,
            // Convert Firestore Timestamp to ISO string
            timestamp: data.timestamp || (data.createdAt && data.createdAt.toDate ? data.createdAt.toDate().toISOString() : (typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString()))
          });
        });
        
        console.log(`✅ Retrieved ${logs.length} action log(s) for user ${userId} (actionFilter: ${actionFilter}, dateFilter: ${dateFilter}) using Admin SDK with composite index`);
        return logs;
      } catch (indexError) {
        // If index error, use simpler query and sort in memory
        if (indexError.message && indexError.message.includes('index')) {
          // Log at debug level - this is expected behavior with fallback
          console.log('ℹ️ Using fallback query for action logs (composite index not required, but recommended for better performance)');
          
          let simpleQuery = adminDbInstance.collection('actionLogs')
            .where('userId', '==', userId);
          
          // Add date filter if specified
          if (minTimestamp) {
            const admin = require('firebase-admin');
            simpleQuery = simpleQuery.where('timestamp', '>=', admin.firestore.Timestamp.fromDate(minTimestamp));
          }
          
          // Get more documents to account for filtering
          simpleQuery = simpleQuery.limit(limitCount * 3);
          
          const querySnapshot = await simpleQuery.get();
          let logs = [];
          
          querySnapshot.forEach((doc) => {
            const data = doc.data();
            
            // Filter by action type in memory if needed
            if (actionFilter !== 'all' && data.action !== actionFilter) {
              return; // Skip this document
            }
            
            // Handle 'yesterday' filter in memory (needs upper bound check)
            if (dateFilter === 'yesterday') {
              const logTimestamp = data.timestamp || data.createdAt;
              let logDate;
              if (logTimestamp && logTimestamp.toDate) {
                logDate = logTimestamp.toDate();
              } else if (typeof logTimestamp === 'string') {
                logDate = new Date(logTimestamp);
              } else {
                logDate = new Date();
              }
              const todayStart = new Date();
              todayStart.setHours(0, 0, 0, 0);
              if (logDate >= todayStart) {
                return; // Skip logs from today
              }
            }
            
            logs.push({
              id: doc.id,
              ...data,
              timestamp: data.timestamp || (data.createdAt && data.createdAt.toDate ? data.createdAt.toDate().toISOString() : (typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString()))
            });
          });
          
          // Sort by timestamp descending in memory
          logs.sort((a, b) => {
            const dateA = new Date(a.timestamp).getTime();
            const dateB = new Date(b.timestamp).getTime();
            return dateB - dateA;
          });
          
          // Limit after sorting
          logs = logs.slice(0, limitCount);
          
          console.log(`✅ Retrieved ${logs.length} action log(s) using Admin SDK fallback (actionFilter: ${actionFilter}, dateFilter: ${dateFilter}, sorted in memory)`);
          return logs;
        }
        throw indexError; // Re-throw if it's not an index error
      }
    }
    
    // Fallback to client SDK (requires security rules)
    if (!db || !app) {
      return [];
    }
    
    const actionsCollection = collection(db, 'actionLogs');
    
    // Build query conditions array
    const conditions = [
      where('userId', '==', userId)
    ];
    
    // Add date filter if specified
    if (minTimestamp) {
      const { Timestamp } = require('firebase/firestore');
      conditions.push(where('timestamp', '>=', Timestamp.fromDate(minTimestamp)));
    }
    
    conditions.push(orderBy('timestamp', 'desc'));
    
    // Add action filter if not 'all'
    // Note: This may require a composite index when combined with date filter
    if (actionFilter !== 'all') {
      conditions.push(where('action', '==', actionFilter));
    }
    
    // Add limit
    conditions.push(limit(limitCount));
    
    // Build the query with all conditions at once
    const q = query(actionsCollection, ...conditions);
    
    const querySnapshot = await getDocs(q);
    const logs = [];
    
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      logs.push({
        id: doc.id,
        ...data,
        // Ensure timestamp is a string if it's a Firestore Timestamp
        timestamp: data.timestamp ? (typeof data.timestamp === 'string' ? data.timestamp : (data.timestamp.toDate ? data.timestamp.toDate().toISOString() : new Date(data.timestamp).toISOString())) : (data.createdAt ? (typeof data.createdAt === 'string' ? data.createdAt : (data.createdAt.toDate ? data.createdAt.toDate().toISOString() : new Date(data.createdAt).toISOString())) : new Date().toISOString())
      });
    });
    
    console.log(`✅ Retrieved ${logs.length} action log(s) for user ${userId} (filter: ${actionFilter}) using client SDK`);
    return logs;
  } catch (error) {
    console.error('❌ Error getting action logs:', error.message);
    console.error('   Stack:', error.stack);
    // If it's a composite index error, try a simpler query
    if (error.message && (error.message.includes('index') || error.message.includes('permission'))) {
      console.warn('⚠️ Query error detected. Trying simpler query...');
      try {
        // Try with Admin SDK fallback if available
        const adminDbInstance = initializeAdminDb();
        if (adminDbInstance) {
          let simpleQuery = adminDbInstance.collection('actionLogs')
            .where('userId', '==', userId)
            .limit(limitCount);
          
          if (actionFilter !== 'all') {
            simpleQuery = simpleQuery.where('action', '==', actionFilter);
          }
          
          const snapshot = await simpleQuery.get();
          const logs = [];
          snapshot.forEach((doc) => {
            const data = doc.data();
            logs.push({
              id: doc.id,
              ...data,
              timestamp: data.timestamp || (data.createdAt && data.createdAt.toDate ? data.createdAt.toDate().toISOString() : new Date().toISOString())
            });
          });
          // Sort in memory
          logs.sort((a, b) => {
            const dateA = new Date(a.timestamp).getTime();
            const dateB = new Date(b.timestamp).getTime();
            return dateB - dateA; // Descending
          });
          console.log(`✅ Retrieved ${logs.length} action log(s) using Admin SDK fallback`);
          return logs;
        }
        
        // Client SDK fallback
        const actionsCollection = collection(db, 'actionLogs');
        const simpleConditions = [where('userId', '==', userId)];
        if (actionFilter !== 'all') {
          simpleConditions.push(where('action', '==', actionFilter));
        }
        simpleConditions.push(limit(limitCount));
        const simpleQuery = query(actionsCollection, ...simpleConditions);
        const snapshot = await getDocs(simpleQuery);
        const logs = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          logs.push({
            id: doc.id,
            ...data,
            timestamp: data.timestamp ? (typeof data.timestamp === 'string' ? data.timestamp : (data.timestamp.toDate ? data.timestamp.toDate().toISOString() : new Date(data.timestamp).toISOString())) : (data.createdAt ? (typeof data.createdAt === 'string' ? data.createdAt : (data.createdAt.toDate ? data.createdAt.toDate().toISOString() : new Date(data.createdAt).toISOString())) : new Date().toISOString())
          });
        });
        // Sort in memory
        logs.sort((a, b) => {
          const dateA = new Date(a.timestamp).getTime();
          const dateB = new Date(b.timestamp).getTime();
          return dateB - dateA; // Descending
        });
        console.log(`✅ Retrieved ${logs.length} action log(s) using client SDK fallback`);
        return logs;
      } catch (fallbackError) {
        console.error('❌ Fallback query also failed:', fallbackError.message);
      }
    }
    return [];
  }
}

/**
 * Delete an action log by ID
 * @param {string} logId - Action log document ID
 * @param {string} userId - User ID (for security validation)
 * @returns {Promise<boolean>} Success status
 */
async function deleteActionLog(logId, userId) {
  // Check if Firebase is disabled
  if (process.env.DISABLE_FIREBASE === 'true') {
    return false;
  }
  
  try {
    // Prefer Admin SDK (bypasses security rules)
    const adminDbInstance = initializeAdminDb();
    if (adminDbInstance) {
      // Verify the log belongs to the user before deleting (security check)
      const logDoc = await adminDbInstance.collection('actionLogs').doc(logId).get();
      if (!logDoc.exists) {
        console.warn(`⚠️ Action log ${logId} does not exist`);
        return false;
      }
      
      const logData = logDoc.data();
      if (logData.userId !== userId) {
        console.warn(`⚠️ Security: Action log ${logId} does not belong to user ${userId}`);
        return false;
      }
      
      // Delete the document
      await adminDbInstance.collection('actionLogs').doc(logId).delete();
      console.log(`✅ Deleted action log ${logId} for user ${userId}`);
      return true;
    }
    
    // Fallback to client SDK (requires security rules)
    if (!db || !app) {
      console.warn('⚠️ Firebase not initialized, cannot delete action log');
      return false;
    }
    
    // Verify ownership and delete
    const logDocRef = doc(db, 'actionLogs', logId);
    const logDoc = await getDoc(logDocRef);
    
    if (!logDoc.exists()) {
      console.warn(`⚠️ Action log ${logId} does not exist`);
      return false;
    }
    
    const logData = logDoc.data();
    if (logData.userId !== userId) {
      console.warn(`⚠️ Security: Action log ${logId} does not belong to user ${userId}`);
      return false;
    }
    
    // Delete using client SDK
    await deleteDoc(logDocRef);
    console.log(`✅ Deleted action log ${logId} for user ${userId}`);
    return true;
  } catch (error) {
    console.error('❌ Error deleting action log:', error.message);
    console.error('   Stack:', error.stack);
    return false;
  }
}

module.exports = {
  updateDashboardData,
  getAdminData,
  getFullAdminData,
  addPendingSubscriber,
  getPendingSubscribers,
  removePendingSubscriber,
  addRemovedActiveSubscriber,
  addRemovedSubscriber,
  getBalanceHistory,
  logAction,
  getActionLogs,
  deleteActionLog
};

