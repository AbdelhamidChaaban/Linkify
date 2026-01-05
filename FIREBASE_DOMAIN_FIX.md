# Fix Firebase Firestore 404 Errors

## Problem
You're seeing errors like:
```
GET https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?... 404 (Not Found)
Could not reach Cloud Firestore backend
```

This happens when your domain is not authorized in Firebase.

## Solution: Add Domain to Firebase Authorized Domains

### Step 1: Go to Firebase Console
1. Visit: https://console.firebase.google.com/
2. Select your project: **linkify-1f8e7**

### Step 2: Open Project Settings
1. Click the **gear icon ⚙️** (top left, next to "Project Overview")
2. Click **"Project Settings"**

### Step 3: Find Your Web App
1. Scroll down to **"Your apps"** section
2. Find your **Web app** (the one with app ID: `1:22572769612:web:580da17cab96ae519a6fe9`)
3. Click on it to expand

### Step 4: Add Authorized Domains
1. Scroll to **"Authorized domains"** section
2. You should see domains like:
   - `localhost`
   - `cellspottmanagefrontend1.vercel.app` (if already added)
3. Click **"Add domain"** button
4. Add each of these domains (one at a time):
   - `yourdomain.com` (replace with your actual domain)
   - `www.yourdomain.com` (replace with your actual domain)
   - `cellspottmanagefrontend1.vercel.app` (if not already listed)

### Step 5: Wait and Refresh
1. Wait 10-30 seconds for changes to propagate
2. Clear your browser cache (Ctrl+Shift+R or Cmd+Shift+R)
3. Refresh the page
4. Check browser console - errors should be gone!

## Common Domains to Add

If you're using:
- **Custom domain**: Add `yourdomain.com` and `www.yourdomain.com`
- **Vercel domain**: Add `cellspottmanagefrontend1.vercel.app`
- **Both**: Add all three domains

## Verification

After adding domains:
1. Open browser console (F12)
2. Look for Firebase errors
3. You should see successful Firestore connections
4. Your admins and data should load normally

## Note

Firebase Authorized Domains are different from Firebase Hosting. Even if you're not using Firebase Hosting, you still need to authorize domains that will use Firebase Authentication and Firestore.

