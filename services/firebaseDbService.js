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

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

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
  try {
    const userDocRef = doc(db, COLLECTION_NAME, adminId);
    
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
    const currentDoc = await getDoc(userDocRef);
    const currentData = currentDoc.exists() ? currentDoc.data() : {};
    
    // Update document
    await setDoc(userDocRef, {
      ...currentData,
      alfaData: cleanDashboardData,
      alfaDataFetchedAt: new Date().toISOString(),
      lastDataFetch: new Date().toISOString()
    }, { merge: false });
    
    console.log('✅ Dashboard data saved to database');
  } catch (error) {
    console.error('❌ Error updating dashboard data:', error);
    throw error;
  }
}

module.exports = {
  updateDashboardData
};

