# Complete Deployment Guide: Render + Vercel + Cloudflare

This guide will walk you through deploying your application using:
- **Backend**: Render.com (Node.js service)
- **Frontend**: Vercel (static site)
- **DNS + Security**: Cloudflare (free plan)

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Backend Deployment (Render)](#backend-deployment-render)
3. [Frontend Deployment (Vercel)](#frontend-deployment-vercel)
4. [Cloudflare Setup (Without Domain)](#cloudflare-setup-without-domain)
5. [Cloudflare Setup (With Domain - Future)](#cloudflare-setup-with-domain-future)
6. [Environment Variables Reference](#environment-variables-reference)
7. [Testing Your Deployment](#testing-your-deployment)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before starting, make sure you have:

- ✅ GitHub account and repository with your code
- ✅ Render.com account (free tier works)
- ✅ Vercel account (free tier works)
- ✅ Cloudflare account (free plan)
- ✅ Firebase project with Firestore enabled
- ✅ Redis instance (optional, for queue workers)
- ✅ 2Captcha API key (for captcha solving)

---

## Backend Deployment (Render)

### Step 1: Prepare Your Repository

1. Make sure your code is pushed to GitHub
2. Ensure `backend/package.json` has the correct scripts:
   ```json
   {
     "scripts": {
       "start": "node server.js",
       "build": "npm install"
     }
   }
   ```

### Step 2: Create a New Web Service on Render

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Select your repository from the list

### Step 3: Configure the Service

Fill in the following settings:

- **Name**: `linkify-backend` (or your preferred name)
- **Environment**: `Node`
- **Region**: Choose closest to your users (e.g., `Oregon (US West)`)
- **Branch**: `main` (or your default branch)
- **Root Directory**: `backend`
- **Runtime**: `Node`
- **Build Command**: `npm install` (or leave blank, Render will auto-detect)
- **Start Command**: `npm start`
- **Plan**: `Free` (or `Starter` for better performance)

### Step 4: Add Environment Variables

In the Render dashboard, go to **Environment** tab and add these variables:

#### Required Variables

```
# Firebase Configuration
FIREBASE_API_KEY=your_firebase_api_key
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_STORAGE_BUCKET=your-project.appspot.com
FIREBASE_MESSAGING_SENDER_ID=your_sender_id
FIREBASE_APP_ID=your_app_id
FIREBASE_MEASUREMENT_ID=your_measurement_id

# Firebase Admin SDK (Service Account Key)
# IMPORTANT: This is a JSON object - you need to minify it and paste as a single line
# See instructions below for how to get and format this
FIREBASE_SERVICE_ACCOUNT_KEY={"type":"service_account","project_id":"..."}

# 2Captcha API Key
CAPTCHA_API_KEY=your_2captcha_api_key

# Optional: Frontend URL (for CORS - add after deploying frontend)
FRONTEND_URL=https://your-frontend.vercel.app
```

#### Optional Variables

```
# Redis (for queue workers - optional)
REDIS_HOST=your_redis_host
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
REDIS_TLS=true  # Set to true if using Redis Cloud

# Timezone for scheduled tasks
TZ=UTC

# Disable features if needed (set to 'true' to disable)
DISABLE_FIREBASE=false
DISABLE_SCHEDULED_REFRESH=false
DISABLE_SCHEDULED_CLEANUP=false
```

#### How to Get Firebase Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Go to **Project Settings** (gear icon) → **Service Accounts**
4. Click **"Generate New Private Key"**
5. Save the JSON file
6. **Minify the JSON**: Remove all line breaks and spaces. You can use:
   - Online tool: [jsonformatter.org/json-minify](https://jsonformatter.org/json-minify)
   - Or use this Node.js script (run in backend folder):
     ```bash
     node -e "console.log(JSON.stringify(require('./path-to-service-account.json')))"
     ```
7. Copy the minified JSON (single line) and paste into `FIREBASE_SERVICE_ACCOUNT_KEY` in Render

**Note**: Render has a limit on environment variable size. If your service account key is too large, you can:
- Use Render CLI to set it: `render env:set FIREBASE_SERVICE_ACCOUNT_KEY "$(cat service-account.json | jq -c .)"`
- Or contact Render support for increasing the limit

### Step 5: Deploy

1. Click **"Create Web Service"**
2. Render will start building and deploying your backend
3. Wait for the deployment to complete (first deployment takes ~5-10 minutes)
4. Once deployed, note your backend URL: `https://your-service-name.onrender.com`

### Step 6: Test Backend Health

Visit: `https://your-service-name.onrender.com/health`

You should see:
```json
{
  "status": "ok",
  "timestamp": "2024-...",
  "cache": { ... }
}
```

**Important Notes:**
- Render free tier services spin down after 15 minutes of inactivity
- First request after spin-down may take 30-60 seconds (cold start)
- Consider upgrading to Starter plan ($7/month) for better performance

---

## Frontend Deployment (Vercel)

### Step 1: Prepare Your Repository

1. Make sure `frontend/vercel.json` exists (already created)
2. Make sure `frontend/config.js` exists and is configured

### Step 2: Connect Repository to Vercel

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click **"Add New..."** → **"Project"**
3. Import your GitHub repository
4. Select your repository

### Step 3: Configure the Project

- **Framework Preset**: `Other`
- **Root Directory**: `frontend` (click "Edit" and set it)
- **Build Command**: Leave empty (static site, no build needed)
- **Output Directory**: Leave empty (Vercel will serve from root)
- **Install Command**: Leave empty

### Step 4: Update Frontend Config

Before deploying, update `frontend/config.js` with your Render backend URL:

1. Open `frontend/config.js`
2. Find this line:
   ```javascript
   return 'https://your-backend-name.onrender.com';
   ```
3. Replace `your-backend-name` with your actual Render service name
4. Commit and push the change

**Example:**
```javascript
return 'https://linkify-backend.onrender.com';
```

### Step 5: Deploy

1. Click **"Deploy"**
2. Wait for deployment to complete (~1-2 minutes)
3. Once deployed, note your Vercel URL: `https://your-project-name.vercel.app`

### Step 6: Update Backend CORS

1. Go back to Render dashboard
2. Edit your backend service
3. Go to **Environment** tab
4. Add/update `FRONTEND_URL`:
   ```
   FRONTEND_URL=https://your-project-name.vercel.app
   ```
5. Save changes (this will trigger a redeploy)

### Step 7: Update Frontend Config for Custom Domain (Future)

If you'll use a custom domain later, the `frontend/config.js` is already configured to:
- Use `api.yourdomain.com` if on custom domain
- Fallback to Render URL if on Vercel domain

No changes needed now, but you'll update it after setting up Cloudflare.

---

## Cloudflare Setup (Without Domain)

Since you don't have a domain yet, you can still use Cloudflare for:

### Option 1: Use Vercel and Render URLs Directly (Recommended for Now)

- Frontend: `https://your-project.vercel.app`
- Backend: `https://your-backend.onrender.com`

This works perfectly fine. You can add Cloudflare later when you get a domain.

### Option 2: Cloudflare Tunnel (Advanced - Optional)

If you want to use Cloudflare's free features now, you can set up Cloudflare Tunnel, but this is more complex. We recommend waiting until you have a domain.

---

## Cloudflare Setup (With Domain - Future)

When you purchase a domain, follow these steps:

### Step 1: Add Domain to Cloudflare

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Click **"Add a Site"**
3. Enter your domain (e.g., `yourdomain.com`)
4. Choose the **Free** plan
5. Cloudflare will scan your DNS records
6. Update your domain's nameservers at your registrar to Cloudflare's nameservers
7. Wait for DNS propagation (usually 24-48 hours, but can be faster)

### Step 2: Configure DNS Records

In Cloudflare DNS, add these records:

#### For Frontend (Vercel)

1. Go to Vercel dashboard → Your project → Settings → Domains
2. Add your domain (e.g., `yourdomain.com` and `www.yourdomain.com`)
3. Vercel will give you DNS records to add
4. In Cloudflare DNS, add:
   - Type: `CNAME`
   - Name: `@` (or `yourdomain.com`)
   - Target: `cname.vercel-dns.com`
   - Proxy status: **Proxied** (orange cloud) ✅

   - Type: `CNAME`
   - Name: `www`
   - Target: `cname.vercel-dns.com`
   - Proxy status: **Proxied** (orange cloud) ✅

#### For Backend (Render)

Since Render doesn't support custom domains on free tier, you have two options:

**Option A: Use Render URL directly (Free)**
- Keep using `https://your-backend.onrender.com`
- Update `frontend/config.js` to use this URL
- No DNS changes needed

**Option B: Use Cloudflare Worker or Page Rule (Free)**
- Create a Cloudflare Worker to proxy requests
- Or use Cloudflare's Workers for free (10,000 requests/day)
- This is more complex - see Cloudflare Workers documentation

**Option C: Upgrade Render (Paid)**
- Render Starter plan ($7/month) supports custom domains
- Add custom domain in Render dashboard
- Add DNS record in Cloudflare:
  - Type: `CNAME`
  - Name: `api` (or `backend`)
  - Target: `your-backend.onrender.com`
  - Proxy status: **Proxied** (orange cloud) ✅

### Step 3: Update Frontend Config

Update `frontend/config.js` - it should already work, but verify:

```javascript
// If on custom domain, it will use api.yourdomain.com
// If on Vercel domain, it will use Render URL
```

### Step 4: Update Backend CORS

1. Go to Render dashboard → Your backend service → Environment
2. Update `FRONTEND_URL`:
   ```
   FRONTEND_URL=https://yourdomain.com
   ```
3. Save (triggers redeploy)

### Step 5: Cloudflare Settings (Free Plan)

In Cloudflare dashboard, optimize these settings:

#### SSL/TLS
- **SSL/TLS encryption mode**: `Full (strict)`
- This ensures encrypted connection between Cloudflare and your servers

#### Speed
- **Auto Minify**: Enable for CSS, HTML, JavaScript
- **Brotli**: Enable
- **Early Hints**: Enable (if available)

#### Caching
- **Caching Level**: Standard
- **Browser Cache TTL**: 4 hours
- Vercel already handles caching headers, but Cloudflare can add an extra layer

#### Security
- **Security Level**: Medium
- **Bot Fight Mode**: On (free plan)
- **Challenge Passage**: 30 minutes

#### Firewall Rules (Optional)
- Create rules to block suspicious traffic
- Example: Block requests with no user-agent

### Step 6: Firebase Authorized Domains

Don't forget to add your domain to Firebase:

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Project Settings → General → Your apps
3. Scroll to **"Authorized domains"**
4. Click **"Add domain"**
5. Add:
   - `yourdomain.com`
   - `www.yourdomain.com`
   - `your-project.vercel.app` (keep this for preview deployments)

---

## Environment Variables Reference

### Backend (Render) - Required

| Variable | Description | Example |
|----------|-------------|---------|
| `FIREBASE_API_KEY` | Firebase Web API Key | `AIzaSy...` |
| `FIREBASE_AUTH_DOMAIN` | Firebase Auth Domain | `project.firebaseapp.com` |
| `FIREBASE_PROJECT_ID` | Firebase Project ID | `your-project-id` |
| `FIREBASE_STORAGE_BUCKET` | Firebase Storage Bucket | `project.appspot.com` |
| `FIREBASE_MESSAGING_SENDER_ID` | Firebase Sender ID | `123456789` |
| `FIREBASE_APP_ID` | Firebase App ID | `1:123:web:abc` |
| `FIREBASE_MEASUREMENT_ID` | Firebase Analytics ID | `G-XXXXXXXXXX` |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Firebase Admin SDK JSON (minified) | `{"type":"service_account",...}` |
| `CAPTCHA_API_KEY` | 2Captcha API Key | `your_2captcha_key` |

### Backend (Render) - Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `FRONTEND_URL` | Frontend URL for CORS | - |
| `REDIS_HOST` | Redis hostname | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis password | - |
| `REDIS_TLS` | Enable Redis TLS | `false` |
| `TZ` | Timezone for cron jobs | `UTC` |
| `DISABLE_FIREBASE` | Disable Firebase | `false` |
| `DISABLE_SCHEDULED_REFRESH` | Disable scheduled refresh | `false` |
| `DISABLE_SCHEDULED_CLEANUP` | Disable scheduled cleanup | `false` |

### Frontend (Vercel) - Optional

Vercel doesn't require environment variables for this setup. All configuration is in `frontend/config.js`.

---

## Testing Your Deployment

### 1. Test Backend Health

```bash
curl https://your-backend.onrender.com/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "cache": { ... }
}
```

### 2. Test Frontend

1. Visit: `https://your-project.vercel.app`
2. Check browser console (F12) for errors
3. Verify API calls are going to your Render backend
4. Look for: `🌐 Backend API URL: https://your-backend.onrender.com`

### 3. Test API Connection

1. Open browser console on your frontend
2. Try to log in or perform an action
3. Check Network tab for API requests
4. Verify requests are going to your Render backend
5. Check for CORS errors (should be none)

### 4. Test Firebase Connection

1. Try to log in via Firebase Auth
2. Check Firebase Console → Authentication → Users
3. Verify user is created
4. Check Firestore for data

---

## Troubleshooting

### Backend Issues

#### Backend returns 404 or timeout

- **Cause**: Service spun down (free tier)
- **Solution**: Wait 30-60 seconds for cold start, or upgrade to Starter plan

#### CORS errors

- **Cause**: Frontend URL not in CORS whitelist
- **Solution**: Add `FRONTEND_URL` environment variable in Render

#### Firebase errors

- **Cause**: Missing or incorrect Firebase credentials
- **Solution**: Verify all `FIREBASE_*` environment variables are set correctly
- **Check**: Service account key is minified JSON on a single line

#### Redis connection errors

- **Cause**: Redis credentials incorrect or Redis not available
- **Solution**: Check `REDIS_*` environment variables, or disable Redis if not needed

### Frontend Issues

#### Frontend shows blank page

- **Cause**: JavaScript errors or missing files
- **Solution**: Check browser console, verify all files are in `frontend/` directory

#### API calls fail with CORS error

- **Cause**: Backend CORS not configured for frontend domain
- **Solution**: Add `FRONTEND_URL` to Render environment variables

#### API calls go to wrong URL

- **Cause**: `frontend/config.js` has wrong backend URL
- **Solution**: Update `frontend/config.js` with correct Render backend URL

#### Firebase authentication fails

- **Cause**: Vercel domain not in Firebase authorized domains
- **Solution**: Add Vercel domain to Firebase Console → Project Settings → Authorized domains

### Cloudflare Issues

#### Domain not resolving

- **Cause**: DNS propagation not complete or nameservers not updated
- **Solution**: Wait 24-48 hours, verify nameservers at domain registrar

#### SSL errors

- **Cause**: SSL/TLS mode incorrect
- **Solution**: Set SSL/TLS mode to "Full (strict)" in Cloudflare

#### Site too slow

- **Cause**: Caching not enabled
- **Solution**: Enable Cloudflare caching and Auto Minify in Speed settings

---

## Next Steps

1. ✅ Deploy backend to Render
2. ✅ Deploy frontend to Vercel
3. ✅ Test both deployments
4. ⏳ Purchase domain (when ready)
5. ⏳ Set up Cloudflare with domain
6. ⏳ Configure custom domains
7. ⏳ Optimize Cloudflare settings
8. ⏳ Monitor performance and errors

---

## Summary

You now have:
- ✅ Backend deployed on Render
- ✅ Frontend deployed on Vercel
- ✅ Configuration files set up correctly
- ✅ Guide for future Cloudflare setup with domain

Your application is live and accessible at:
- Frontend: `https://your-project.vercel.app`
- Backend: `https://your-backend.onrender.com`

When you're ready to add a custom domain, follow the "Cloudflare Setup (With Domain)" section above.

---

## Need Help?

- Render Docs: https://render.com/docs
- Vercel Docs: https://vercel.com/docs
- Cloudflare Docs: https://developers.cloudflare.com/
- Firebase Docs: https://firebase.google.com/docs

Good luck with your deployment! 🚀

