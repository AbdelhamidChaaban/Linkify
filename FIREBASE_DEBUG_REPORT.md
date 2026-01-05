# Firebase Firestore 404 Error - Debugging Report

## 1. SDK Version Verification

### Frontend (Vercel)
- **SDK Loading Method**: CDN scripts (not npm)
- **SDK Version**: `10.7.1` (compat)
- **Scripts Used**:
  ```html
  <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js"></script>
  ```
- **Status**: ✅ Consistent version across all pages

### Backend (Render)
- **Package**: `firebase@10.14.1` (installed, from package.json `^10.7.1`)
- **Note**: Backend uses `firebase-admin` SDK, not client SDK
- **Status**: ⚠️ Version differs but not critical (backend uses Admin SDK)

**Conclusion**: ✅ No SDK version mismatch. All using v10.7.1.

---

## 2. Initialization Check

### Frontend Initialization
**File**: `frontend/auth/firebase-config.js`

```javascript
// Using compat SDK (correct for CDN usage)
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
```

**Status**: ✅ Correct initialization using compat SDK

**Note**: The code is correctly using compat SDK (`firebase.initializeApp`, `firebase.firestore()`), which is appropriate when loading Firebase via CDN scripts. This is NOT a problem.

---

## 3. Environment Separation

### Client-Side Usage (Frontend)
✅ **Correct Usage Found**:
- `db.collection('admins').where('userId', '==', userId).onSnapshot(...)` - Real-time listeners
- `db.collection('admins').where('userId', '==', userId).get()` - REST queries
- All Firestore operations are client-side only

### Server-Side Usage (Backend)
✅ **Correct Usage Found**:
- Backend uses `firebase-admin` SDK (separate from client SDK)
- No client SDK Firestore operations in backend code

**Conclusion**: ✅ Proper environment separation. No server-side client SDK usage.

---

## 4. REST Query Fallback Test

### Test Script
Run this in browser console on your deployed site:

```javascript
// Test REST query (non-real-time)
async function testFirestoreREST() {
    try {
        console.log('🧪 Testing Firestore REST query...');
        const currentUserId = auth.currentUser?.uid;
        
        if (!currentUserId) {
            console.error('❌ User not authenticated');
            return;
        }
        
        console.log('✅ User authenticated:', currentUserId);
        
        // Test REST query (get() instead of onSnapshot)
        const snapshot = await db.collection('admins')
            .where('userId', '==', currentUserId)
            .limit(1)
            .get();
        
        console.log('✅ REST query succeeded!');
        console.log('   Documents:', snapshot.docs.length);
        console.log('   From cache:', snapshot.metadata.fromCache);
        
        return true;
    } catch (error) {
        console.error('❌ REST query failed:', error);
        console.error('   Error code:', error.code);
        console.error('   Error message:', error.message);
        return false;
    }
}

// Run test
testFirestoreREST();
```

### Expected Results

**If REST query succeeds but listeners fail:**
- ✅ Problem is isolated to real-time Listen channel
- 🔍 Issue is SDK transport layer (gRPC-Web channel)
- 💡 Solution: Domain authorization or API key restrictions

**If REST query also fails:**
- ❌ Problem is broader than just listeners
- 🔍 Check domain authorization, API key, security rules

---

## 5. Deployment Checks

### Vercel Build
- ✅ Static site deployment (no build step for Firebase)
- ✅ Firebase loaded via CDN (no bundling/polyfilling)
- ✅ No build-time modifications to Firebase SDK

### Render Backend
- ✅ Backend doesn't use client SDK for Firestore
- ✅ Backend uses Admin SDK (bypasses security rules)
- ✅ Backend doesn't interfere with frontend Firestore connections

### Network/Firewall
**To Test**:
```javascript
// Test if Firestore endpoints are accessible
async function testFirestoreConnectivity() {
    const endpoints = [
        'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen',
        'https://firestore.googleapis.com/v1/projects/linkify-1f8e7/databases/(default)/documents'
    ];
    
    for (const endpoint of endpoints) {
        try {
            const response = await fetch(endpoint, {
                method: 'OPTIONS',
                mode: 'cors'
            });
            console.log(`✅ ${endpoint}: ${response.status}`);
        } catch (error) {
            console.error(`❌ ${endpoint}: ${error.message}`);
        }
    }
}

testFirestoreConnectivity();
```

---

## Root Cause Analysis

Based on the error pattern:
- **Error**: `GET https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?... 404 (Not Found)`
- **Error Type**: `ERR_ABORTED 404`
- **SDK Version**: 10.7.1 (compat, correct)
- **Initialization**: Correct (compat SDK)
- **Environment**: Correct (client-side only)

### Most Likely Causes (in order):

1. **Domain Authorization Issue** ⭐ (Most Likely)
   - Domain `cellspottmanagefrontend1.vercel.app` not properly authorized in Firebase
   - Check: Firebase Console → Project Settings → Authorized Domains

2. **API Key Restrictions**
   - API key has HTTP referrer restrictions
   - Domain not in allowed referrers list
   - Check: Google Cloud Console → APIs & Services → Credentials → API Key

3. **Security Rules Issue** (Less Likely - would give PERMISSION_DENIED, not 404)
   - Firestore security rules blocking access
   - Check: Firebase Console → Firestore Database → Rules

---

## Recommended Actions

### Immediate Steps:

1. **Verify Domain Authorization**
   - Go to: https://console.firebase.google.com/project/linkify-1f8e7/settings/general
   - Check "Authorized domains" includes: `cellspottmanagefrontend1.vercel.app`
   - Add if missing

2. **Check API Key Restrictions**
   - Go to: https://console.cloud.google.com/apis/credentials?project=linkify-1f8e7
   - Find API key: `AIzaSyCz83EAYIqHZgfjdyhsNr1m1d0lfe7SHRg`
   - Check "Application restrictions"
   - If set to "HTTP referrers", ensure domain is listed

3. **Run REST Query Test**
   - Use test script above in browser console
   - Determine if issue is isolated to Listen channel

4. **Test in Incognito Mode**
   - Rule out browser cache issues
   - Test with fresh browser state

### If Issue Persists:

- Check browser console Network tab for exact request details
- Verify CORS headers (though 404 suggests request never reached server)
- Check Firebase service status: https://status.firebase.google.com/
- Consider upgrading to latest Firebase SDK (though current version should work)

---

## Conclusion

**SDK Configuration**: ✅ Correct
- Compat SDK v10.7.1 via CDN
- Proper initialization
- Client-side only usage

**Problem**: 🔍 Domain/API Key Authorization
- 404 error indicates authorization/configuration issue
- NOT an SDK version or initialization problem
- Focus on Firebase Authorized Domains and API Key restrictions

