// Firebase Configuration
// NOTE: Firebase web API keys are meant to be public, but MUST be restricted using Firebase Security Rules
// Make sure your Firestore Security Rules properly restrict access to authenticated users only
const firebaseConfig = {
    apiKey: "AIzaSyCz83EAYIqHZgfjdyhsNr1m1d0lfe7SHRg", // Public web API key - restrict with Security Rules
    authDomain: "linkify-1f8e7.firebaseapp.com",
    projectId: "linkify-1f8e7",
    storageBucket: "linkify-1f8e7.firebasestorage.app",
    messagingSenderId: "22572769612",
    appId: "1:22572769612:web:580da17cab96ae519a6fe9",
    measurementId: "G-01YBXB5H9V"
};

// Initialize Firebase (using compat version for easier integration)
const app = firebase.initializeApp(firebaseConfig);

// Verify project ID is correctly set
if (app.options.projectId !== 'linkify-1f8e7') {
    console.warn('⚠️ Firebase project ID mismatch. Expected: linkify-1f8e7, Got:', app.options.projectId);
}

// Initialize Firebase services
const auth = firebase.auth();

// Initialize Firestore with long polling to bypass stream blocking
// This prevents 404 errors on 'Listen' channels and ERR_INTERNET_DISCONNECTED errors
let db;
try {
    // For compat SDK, we need to initialize Firestore first, then configure settings
    db = firebase.firestore();
    
    // CRITICAL: Configure Firestore to use long polling instead of WebSocket streams
    // This bypasses issues with firestore.googleapis.com/.../Listen/channel 404 errors
    // and ERR_INTERNET_DISCONNECTED errors caused by network/proxy blocking
    if (db.settings) {
        db.settings({
            experimentalForceLongPolling: true, // Use HTTP long polling instead of WebSocket streams
            cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED // Enable unlimited cache for offline support
        });
        console.log('✅ Firestore configured with long polling (bypasses stream blocking)');
    }
} catch (settingsError) {
    console.warn('⚠️ Could not configure Firestore settings:', settingsError.message);
    // Fallback: try to get db without settings
    db = firebase.firestore();
}

// Configure Firestore persistence for offline support
// Note: Using compat version syntax
try {
    // Enable offline persistence for proper offline support and data caching
    // Note: This will show a deprecation warning about enableIndexedDbPersistence(),
    // but it's harmless and necessary for offline functionality. The warning indicates
    // that Firebase will migrate to FirestoreSettings.cache in future versions, but
    // the compat SDK doesn't support the new API yet. The functionality works correctly.
    if (db && db.enablePersistence) {
        db.enablePersistence({
            synchronizeTabs: false  // Set to false to avoid multi-tab persistence warning
        }).catch((err) => {
            if (err.code === 'failed-precondition') {
                // Multiple tabs open, persistence can only be enabled in one tab at a time
                console.warn('⚠️ Firestore persistence already enabled in another tab');
            } else if (err.code === 'unimplemented') {
                // Browser doesn't support persistence
                console.warn('⚠️ This browser does not support Firestore persistence');
            } else {
                console.warn('⚠️ Error enabling Firestore persistence:', err.message);
            }
        });
    }
} catch (error) {
    console.warn('⚠️ Could not configure Firestore persistence:', error.message);
}

// Add global error handler for Firestore connection issues
if (typeof window !== 'undefined') {
    // Listen for Firestore connection errors
    window.addEventListener('unhandledrejection', (event) => {
        if (event.reason && event.reason.message && 
            (event.reason.message.includes('Could not reach Cloud Firestore') ||
             event.reason.message.includes('Backend didn\'t respond'))) {
            console.warn('⚠️ Firestore connection timeout - using cached data if available');
            // Don't prevent default - let Firestore handle offline mode
            // The app should continue working with cached data
        }
    });
}

// Export for use in other scripts (optional, but helpful)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { auth, db };
}

