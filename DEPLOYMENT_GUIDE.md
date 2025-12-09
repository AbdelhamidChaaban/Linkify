# 🚀 Deployment Guide: Linkify to Render.com (Backend) + Vercel (Frontend)

This guide will help you deploy your Linkify application to production.

## 📋 Prerequisites

- ✅ GitHub repository with your code
- ✅ Render.com account (free tier available)
- ✅ Vercel account (free tier available)
- ✅ Redis Cloud account (for session storage)
- ✅ Firebase project (already configured)
- ✅ 2Captcha API key (for CAPTCHA solving)

---

## Part 1: Deploy Backend to Render.com

### Step 1: Create a Web Service on Render

1. **Go to Render Dashboard**
   - Visit [https://dashboard.render.com](https://dashboard.render.com)
   - Click **"New +"** → **"Web Service"**

2. **Connect Your Repository**
   - Choose **"Connect GitHub"** or **"Connect GitLab"**
   - Authorize Render to access your repositories
   - Select your **Linkify repository**

3. **Configure the Service**

   **Basic Settings:**
   - **Name:** `linkify-backend` (or your preferred name)
   - **Region:** Choose closest to your users (e.g., `Oregon (US West)`)
   - **Branch:** `main` (or your default branch)
   - **Root Directory:** `backend`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   
   **⚠️ Important:** 
   - Chromium downloads automatically during `npm install` (postinstall script verifies it)
   - First build takes 5-10 minutes due to Chromium download (~300MB)
   - **CRITICAL:** Add `PUPPETEER_SKIP_DOWNLOAD=false` to environment variables (see Step 2)

   **⚠️ Important Settings:**
   - **Auto-Deploy:** `Yes` (deploys automatically on git push)
   - **Health Check Path:** `/health`

### Step 2: Configure Environment Variables

Click **"Environment"** tab and add these variables:

#### **Required Variables:**

```bash
# Server Configuration
PORT=10000
NODE_ENV=production

# Puppeteer Configuration (CRITICAL - ensures Chromium downloads)
PUPPETEER_SKIP_DOWNLOAD=false
PUPPETEER_CACHE_DIR=/opt/render/project/src/backend/node_modules/.cache/puppeteer

# Redis Cloud Configuration
REDIS_HOST=redis-11585.c55.eu-central-1-1.ec2.cloud.redislabs.com
REDIS_PORT=11585
REDIS_PASSWORD=your-rediscloud-password-here
REDIS_TLS=true

# Firebase Configuration
FIREBASE_API_KEY=AIzaSyCz83EAYIqHZgfjdyhsNr1m1d0lfe7SHRg
FIREBASE_AUTH_DOMAIN=linkify-1f8e7.firebaseapp.com
FIREBASE_PROJECT_ID=linkify-1f8e7
FIREBASE_STORAGE_BUCKET=linkify-1f8e7.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=22572769612
FIREBASE_APP_ID=1:22572769612:web:580da17cab96ae519a6fe9
FIREBASE_MEASUREMENT_ID=G-01YBXB5H9V

# CAPTCHA Service (2Captcha)
CAPTCHA_API_KEY=your-2captcha-api-key-here

# Optional: Cache TTL (in hours, default is 24)
CACHE_TTL_HOURS=24
```

**🔒 Security Note:** 
- Replace `your-rediscloud-password-here` with your actual Redis Cloud password
- Replace `your-2captcha-api-key-here` with your actual 2Captcha API key
- Get these from your Redis Cloud and 2Captcha dashboards

### Step 3: Advanced Settings (Optional but Recommended)

1. **Health Check:**
   - Path: `/health`
   - Interval: `30 seconds`

2. **Auto-Deploy:**
   - Enable automatic deployments from your branch

3. **Plan:**
   - **Free Tier:** Limited to 512MB RAM, 0.1 CPU
   - **Starter Plan ($7/month):** 512MB RAM, better performance
   - **Professional Plan ($25/month):** 2GB RAM, recommended for production

**⚠️ Important:** Puppeteer needs at least 512MB RAM. Free tier might work, but Starter/Professional is recommended.

### Step 4: Deploy and Test

1. Click **"Create Web Service"**
2. Render will:
   - Clone your repository
   - Install dependencies (`npm install`)
   - Start your server (`npm start`)
3. Wait for deployment to complete (5-10 minutes first time)
4. Check logs for any errors
5. Test the health endpoint: `https://your-service-name.onrender.com/health`

**Expected Output:**
```json
{
  "status": "ok",
  "timestamp": "2025-12-09T...",
  "browserPool": {...},
  "cache": {...}
}
```

### Step 5: Get Your Backend URL

After deployment, Render provides a URL like:
```
https://linkify-backend.onrender.com
```

**Save this URL** - you'll need it for the frontend configuration!

---

## Part 2: Deploy Frontend to Vercel

### Step 1: Install Vercel CLI (Optional but Recommended)

```bash
npm install -g vercel
```

Or deploy directly from Vercel dashboard (no CLI needed).

### Step 2: Deploy via Vercel Dashboard

1. **Go to Vercel Dashboard**
   - Visit [https://vercel.com/dashboard](https://vercel.com/dashboard)
   - Click **"Add New..."** → **"Project"**

2. **Import Your Repository**
   - Connect your GitHub account if not already connected
   - Select your **Linkify repository**

3. **Configure the Project**

   **Project Settings:**
   - **Framework Preset:** `Other` (static site)
   - **Root Directory:** `frontend`
   - **Build Command:** (leave empty - static files)
   - **Output Directory:** (leave empty - serves from root)
   - **Install Command:** (leave empty)

### Step 3: Configure Environment Variables

Click **"Environment Variables"** and add:

```bash
VITE_API_URL=https://your-backend-url.onrender.com
```

**OR** if you prefer, create a config file (see Step 4 below).

### Step 4: Configure Backend API URL (Recommended Method)

Create a configuration file in the frontend to set the backend URL:

**Create `frontend/config.js`:**
```javascript
// Frontend API Configuration
window.AEFA_API_URL = 'https://your-backend-url.onrender.com';
```

**Then update `frontend/index.html`** to include this config:

Add before closing `</head>` tag:
```html
<script src="/config.js"></script>
```

**OR** add inline in `frontend/index.html`:
```html
<script>
  // Backend API URL - Update this with your Render.com backend URL
  window.AEFA_API_URL = 'https://your-backend-url.onrender.com';
</script>
```

### Step 5: Deploy

1. Click **"Deploy"**
2. Vercel will:
   - Clone your repository
   - Deploy your frontend files
   - Provide you with a URL like: `https://linkify.vercel.app`

### Step 6: Test Your Deployment

1. Visit your Vercel URL
2. Try logging in
3. Check browser console for any API errors
4. Verify API calls are going to your Render.com backend

---

## Part 3: Update CORS Settings (If Needed)

If you get CORS errors, update `backend/server.js`:

```javascript
// Update CORS middleware to allow your Vercel domain
app.use(cors({
    origin: [
        'https://your-vercel-app.vercel.app',
        'https://your-custom-domain.com', // If you have a custom domain
        /\.vercel\.app$/ // Allow all Vercel preview deployments
    ],
    credentials: true
}));
```

Or allow all origins (less secure, for testing):
```javascript
app.use(cors({
    origin: true,
    credentials: true
}));
```

---

## Part 4: Post-Deployment Checklist

### ✅ Backend (Render.com)
- [ ] Health endpoint works: `/health`
- [ ] Logs show no errors
- [ ] Redis connection established
- [ ] Firebase initialized
- [ ] Browser pool initialized

### ✅ Frontend (Vercel)
- [ ] Frontend loads correctly
- [ ] Login works
- [ ] API calls go to Render.com backend
- [ ] No CORS errors in console
- [ ] Firebase authentication works

### ✅ Integration
- [ ] Frontend can fetch data from backend
- [ ] Admin refresh works
- [ ] Cookies are saved to Redis
- [ ] Real-time updates work (Firebase)

---

## Part 5: Troubleshooting

### Backend Issues

**Problem: Build fails**
- Check that `backend/package.json` has all dependencies
- Verify Node.js version in Render settings (use Node 18 or 20)

**Problem: Server crashes on start**
- Check environment variables are set correctly
- Review logs in Render dashboard
- Verify Redis Cloud credentials

**Problem: Puppeteer fails**
- ✅ **Chromium is automatically bundled** - No manual Chrome installation needed!
- The project uses `puppeteer` (not `puppeteer-core`) which includes Chromium
- Chromium downloads automatically during `npm install` on Render.com
- Render free tier has limited resources (512MB RAM)
- Upgrade to Starter/Professional plan for better performance
- Check logs for memory/CPU errors
- If you see "Could not find Chrome" errors, ensure you're using `puppeteer` (not `puppeteer-core`)

### Frontend Issues

**Problem: API calls fail**
- Verify `window.AEFA_API_URL` is set correctly
- Check CORS settings in backend
- Verify backend URL is accessible (test `/health` endpoint)

**Problem: CORS errors**
- Update CORS settings in `backend/server.js`
- Add your Vercel domain to allowed origins

**Problem: Firebase errors**
- Verify Firebase config in `frontend/auth/firebase-config.js`
- Check Firebase Security Rules allow authenticated users

---

## Part 6: Custom Domains (Optional)

### Render.com Custom Domain
1. Go to your service settings
2. Click "Custom Domains"
3. Add your domain
4. Follow DNS configuration instructions

### Vercel Custom Domain
1. Go to project settings
2. Click "Domains"
3. Add your custom domain
4. Configure DNS as instructed

---

## Part 7: Monitoring and Logs

### Render.com Logs
- Access logs in Render dashboard
- Real-time logs available
- Download logs for analysis

### Vercel Logs
- Access logs in Vercel dashboard
- Function logs available
- Analytics included

---

## 🎉 Success!

Your application should now be live:
- **Backend:** `https://your-backend.onrender.com`
- **Frontend:** `https://your-app.vercel.app`

If you encounter any issues, check the troubleshooting section or review the logs.

---

## 📝 Quick Reference

**Backend Environment Variables:**
- `PORT` (Render sets this automatically, but you can override)
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_TLS`
- `FIREBASE_*` (all Firebase config vars)
- `CAPTCHA_API_KEY`

**Frontend Configuration:**
- Set `window.AEFA_API_URL` to your Render.com backend URL

**Important URLs:**
- Render Dashboard: https://dashboard.render.com
- Vercel Dashboard: https://vercel.com/dashboard
- Redis Cloud: https://redis.com/try-free/
- 2Captcha: https://2captcha.com

