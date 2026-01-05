# Firebase Firestore Test - Browser Console

Since the test page needs deployment, use this script directly in your browser console.

## Steps

1. **Open your site**: https://cellspottmanagefrontend1.vercel.app
2. **Log in** (if not already logged in)
3. **Open browser console** (F12)
4. **Copy and paste this script** into the console:

```javascript
// Firebase Firestore Debug Test
(async function() {
    console.log('🔥 Firebase Firestore Debug Test\n');
    console.log('='.repeat(50));
    
    // 1. SDK Version Check
    console.log('\n1. SDK Version Check');
    console.log('-'.repeat(50));
    if (typeof firebase === 'undefined') {
        console.error('❌ Firebase SDK not loaded');
        return;
    }
    console.log('✅ Firebase SDK loaded');
    console.log(`   SDK Version: ${firebase.SDK_VERSION || 'unknown'}`);
    console.log(`   Current domain: ${window.location.hostname}`);
    
    // 2. Initialization Check
    console.log('\n2. Initialization Check');
    console.log('-'.repeat(50));
    if (!firebase.apps || firebase.apps.length === 0) {
        console.error('❌ Firebase not initialized');
        return;
    }
    console.log(`✅ Firebase initialized (${firebase.apps.length} app(s))`);
    const app = firebase.apps[0];
    console.log(`   Project ID: ${app.options.projectId}`);
    
    if (typeof auth !== 'undefined' && auth) {
        console.log('✅ Auth service available');
    } else {
        console.error('❌ Auth service not available');
        return;
    }
    
    if (typeof db !== 'undefined' && db) {
        console.log('✅ Firestore service available');
    } else {
        console.error('❌ Firestore service not available');
        return;
    }
    
    // 3. Authentication Check
    console.log('\n3. Authentication Check');
    console.log('-'.repeat(50));
    if (!auth.currentUser) {
        console.error('❌ User not authenticated');
        console.log('   Please log in first');
        return;
    }
    const userId = auth.currentUser.uid;
    console.log(`✅ User authenticated: ${userId}`);
    console.log(`   Email: ${auth.currentUser.email || 'N/A'}`);
    
    // 4. REST Query Test (Non-Real-time)
    console.log('\n4. REST Query Test (get() method)');
    console.log('-'.repeat(50));
    try {
        console.log('   Executing: db.collection("admins").where("userId", "==", userId).limit(1).get()');
        const startTime = Date.now();
        const snapshot = await db.collection('admins')
            .where('userId', '==', userId)
            .limit(1)
            .get();
        const duration = Date.now() - startTime;
        
        console.log(`✅ REST query succeeded in ${duration}ms`);
        console.log(`   Documents returned: ${snapshot.docs.length}`);
        console.log(`   From cache: ${snapshot.metadata.fromCache}`);
        
        if (snapshot.metadata.fromCache) {
            console.warn('   ⚠️ Data is from cache (offline mode or server unavailable)');
        } else {
            console.log('   ✅ Data is from server (online)');
        }
        
        if (snapshot.docs.length > 0) {
            const docData = snapshot.docs[0].data();
            console.log(`   Sample document ID: ${snapshot.docs[0].id}`);
            console.log(`   Sample data keys: ${Object.keys(docData).join(', ')}`);
        }
    } catch (error) {
        console.error(`❌ REST query failed: ${error.message}`);
        console.error(`   Error code: ${error.code || 'N/A'}`);
        console.error(`   Full error:`, error);
        return;
    }
    
    // 5. Real-time Listener Test
    console.log('\n5. Real-time Listener Test (onSnapshot)');
    console.log('-'.repeat(50));
    console.log('   Setting up listener (will timeout after 10 seconds)...');
    
    let listenerFired = false;
    const listenerPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            if (!listenerFired) {
                reject(new Error('Listener timeout after 10 seconds'));
            }
        }, 10000);
        
        try {
            const unsubscribe = db.collection('admins')
                .where('userId', '==', userId)
                .limit(1)
                .onSnapshot(
                    (snapshot) => {
                        listenerFired = true;
                        clearTimeout(timeout);
                        console.log('✅ Listener callback fired!');
                        console.log(`   Documents: ${snapshot.docs.length}`);
                        console.log(`   From cache: ${snapshot.metadata.fromCache}`);
                        unsubscribe();
                        resolve(snapshot);
                    },
                    (error) => {
                        clearTimeout(timeout);
                        console.error(`❌ Listener error: ${error.message}`);
                        console.error(`   Error code: ${error.code || 'N/A'}`);
                        console.error(`   Full error:`, error);
                        unsubscribe();
                        reject(error);
                    }
                );
        } catch (error) {
            clearTimeout(timeout);
            reject(error);
        }
    });
    
    try {
        await listenerPromise;
        console.log('✅ Real-time listener test passed');
    } catch (error) {
        console.error(`❌ Real-time listener test failed: ${error.message}`);
    }
    
    // 6. Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 Test Summary');
    console.log('='.repeat(50));
    console.log(`Domain: ${window.location.hostname}`);
    console.log(`Project: ${app.options.projectId}`);
    console.log(`User: ${userId}`);
    console.log('\n🔍 If REST query works but listener fails:');
    console.log('   → Problem is with real-time Listen channel');
    console.log('   → Likely domain authorization or API key restrictions');
    console.log('\n🔍 If both fail:');
    console.log('   → Check Firebase Authorized Domains');
    console.log('   → Check API key restrictions in Google Cloud Console');
    console.log('\n✅ Test complete!');
})();
```

## What to Look For

### ✅ Success Indicators
- REST query succeeds
- Real-time listener fires
- Data loads from server (not cache)

### ❌ Problem Indicators
- REST query fails with 404/PERMISSION_DENIED
- Real-time listener times out or errors
- Data only loads from cache

## Next Steps Based on Results

**If REST query works but listener fails:**
- Problem is isolated to real-time Listen channel
- Focus on domain authorization and API key restrictions

**If both fail:**
- Check Firebase Authorized Domains
- Check API key restrictions
- Check Firestore security rules

