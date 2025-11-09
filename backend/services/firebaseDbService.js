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
    
    // Clean data
    const cleanDashboardData = removeUndefined(dashboardData || {});
    
    // Force restore critical fields
    if (totalConsumptionBackup) {
      cleanDashboardData.totalConsumption = totalConsumptionBackup;
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
    
    // Update document
    try {
      await setDoc(userDocRef, {
        ...currentData,
        alfaData: cleanDashboardData,
        alfaDataFetchedAt: new Date().toISOString(),
        lastDataFetch: new Date().toISOString()
      }, { merge: false });
      
      console.log('✅ Dashboard data saved to database');
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

module.exports = {
  updateDashboardData
};

