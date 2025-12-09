# 🚀 Quick Deployment Checklist

Use this checklist to ensure you don't miss any steps during deployment.

## Pre-Deployment

- [ ] Code is pushed to GitHub
- [ ] All environment variables documented
- [ ] Redis Cloud account set up
- [ ] 2Captcha API key ready
- [ ] Firebase project configured

---

## Backend Deployment (Render.com)

### Setup
- [ ] Created Render.com account
- [ ] Created new Web Service
- [ ] Connected GitHub repository
- [ ] Set Root Directory to `backend`
- [ ] Set Build Command to `npm install`
- [ ] Set Start Command to `npm start`
- [ ] Set Health Check Path to `/health`

### Environment Variables (Set in Render Dashboard)
- [ ] `NODE_ENV=production`
- [ ] `PORT=10000` (or let Render set it)
- [ ] `REDIS_HOST=your-redis-host`
- [ ] `REDIS_PORT=11585`
- [ ] `REDIS_PASSWORD=your-redis-password`
- [ ] `REDIS_TLS=true`
- [ ] `FIREBASE_API_KEY=...`
- [ ] `FIREBASE_AUTH_DOMAIN=...`
- [ ] `FIREBASE_PROJECT_ID=...`
- [ ] `FIREBASE_STORAGE_BUCKET=...`
- [ ] `FIREBASE_MESSAGING_SENDER_ID=...`
- [ ] `FIREBASE_APP_ID=...`
- [ ] `FIREBASE_MEASUREMENT_ID=...`
- [ ] `CAPTCHA_API_KEY=your-2captcha-key`
- [ ] `CACHE_TTL_HOURS=24` (optional)

### Deployment
- [ ] Clicked "Create Web Service"
- [ ] Waited for deployment to complete (5-10 min)
- [ ] Checked deployment logs for errors
- [ ] Tested health endpoint: `https://your-backend.onrender.com/health`
- [ ] Verified backend URL (save for frontend config)

**Backend URL:** `https://________________.onrender.com`

---

## Frontend Deployment (Vercel)

### Setup
- [ ] Created Vercel account
- [ ] Connected GitHub repository
- [ ] Set Root Directory to `frontend`
- [ ] Set Framework Preset to `Other`

### Configuration
- [ ] Updated `frontend/config.js` with your Render.com backend URL
- [ ] Verified `frontend/index.html` includes `<script src="/config.js"></script>`
- [ ] (Optional) Added config.js to other HTML files if needed

### Deployment
- [ ] Clicked "Deploy"
- [ ] Waited for deployment to complete
- [ ] Tested frontend URL
- [ ] Verified login works
- [ ] Checked browser console for errors

**Frontend URL:** `https://________________.vercel.app`

---

## Post-Deployment Testing

### Backend Tests
- [ ] Health endpoint responds: `/health`
- [ ] Redis connection works (check logs)
- [ ] Firebase initialized (check logs)
- [ ] Browser pool initialized (check logs)

### Frontend Tests
- [ ] Frontend loads correctly
- [ ] Login page displays
- [ ] Can create account
- [ ] Can log in
- [ ] No CORS errors in console
- [ ] API calls go to correct backend URL

### Integration Tests
- [ ] Can add admin
- [ ] Can refresh admin data
- [ ] Real-time updates work
- [ ] Cookies saved to Redis

---

## Troubleshooting

If something doesn't work:

1. **Check Render.com Logs**
   - Go to your service → Logs tab
   - Look for errors or warnings

2. **Check Vercel Logs**
   - Go to your project → Deployments → Click latest → Functions tab

3. **Check Browser Console**
   - Open DevTools (F12)
   - Check Console and Network tabs
   - Look for CORS errors or failed requests

4. **Verify Environment Variables**
   - Double-check all env vars are set correctly
   - Ensure no typos or extra spaces

5. **Test Backend Directly**
   - Visit: `https://your-backend.onrender.com/health`
   - Should return JSON with status: "ok"

---

## Common Issues

### ❌ CORS Errors
**Solution:** Update CORS in `backend/server.js` to allow your Vercel domain

### ❌ Backend Not Starting
**Solution:** Check Render logs, verify all env vars are set

### ❌ Puppeteer Fails
**Solution:** Upgrade Render plan (free tier may not have enough resources)

### ❌ Redis Connection Failed
**Solution:** Verify REDIS_HOST, REDIS_PORT, REDIS_PASSWORD are correct

### ❌ Frontend Can't Connect to Backend
**Solution:** Verify `window.AEFA_API_URL` in config.js matches your Render URL

---

## 🎉 Success Indicators

Your deployment is successful when:
- ✅ Backend health check returns `{"status": "ok"}`
- ✅ Frontend loads without errors
- ✅ You can log in and add admins
- ✅ No CORS errors in browser console
- ✅ Data refreshes correctly

---

## Need Help?

Refer to `DEPLOYMENT_GUIDE.md` for detailed instructions.

