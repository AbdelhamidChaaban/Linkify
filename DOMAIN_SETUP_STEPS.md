# Domain Setup Steps - Cloudflare Domain

Since you bought your domain from Cloudflare, it's already in your Cloudflare account. Follow these steps:

## Step 1: Verify Domain in Cloudflare

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Your domain should already be listed
3. Click on your domain to open its dashboard
4. Verify it shows "Active" status

## Step 2: Add Domain to Vercel (Frontend)

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click on your project (the one with your frontend)
3. Go to **Settings** → **Domains**
4. Click **"Add Domain"**
5. Enter your domain: `yourdomain.com` (replace with your actual domain)
6. Click **"Add"**
7. Vercel will show you DNS records to add

## Step 3: Configure DNS Records in Cloudflare

Go to your domain in Cloudflare → **DNS** → **Records**

### For Frontend (Vercel)

Vercel will give you specific DNS records. Typically, you need to add:

1. **Root domain** (`@`):
   - **Type**: `CNAME`
   - **Name**: `@` (or your domain name)
   - **Target**: `cname.vercel-dns.com` (or what Vercel shows you)
   - **Proxy status**: ✅ **Proxied** (orange cloud)
   - Click **Save**

2. **WWW subdomain**:
   - **Type**: `CNAME`
   - **Name**: `www`
   - **Target**: `cname.vercel-dns.com` (or what Vercel shows you)
   - **Proxy status**: ✅ **Proxied** (orange cloud)
   - Click **Save**

### For Backend (Render)

You have two options:

**Option A: Use Render URL directly (Free - Recommended for now)**
- No DNS records needed
- Keep using: `https://cell-spott-manage-backend.onrender.com`
- Your `frontend/config.js` already handles this correctly
- Skip to Step 4

**Option B: Use API subdomain (If you upgrade Render to Starter plan)**
- If you upgrade Render to Starter plan ($7/month), you can add a custom domain
- In Render dashboard → Your backend service → Settings → Custom Domain
- Add: `api.yourdomain.com`
- Then in Cloudflare DNS, add:
  - **Type**: `CNAME`
  - **Name**: `api`
  - **Target**: `cell-spott-manage-backend.onrender.com`
  - **Proxy status**: ✅ **Proxied** (orange cloud)

## Step 4: Wait for DNS Propagation

- DNS changes can take a few minutes to a few hours
- Check Vercel dashboard → Domains to see when it's verified
- You'll see a green checkmark when it's ready

## Step 5: Update Backend CORS (Render)

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click on your backend service
3. Go to **Environment** tab
4. Find or add `FRONTEND_URL` variable
5. Update it to:
   ```
   FRONTEND_URL=https://yourdomain.com
   ```
   (Replace `yourdomain.com` with your actual domain)
6. Also add `www` version (separate variable or update to include both):
   ```
   FRONTEND_URL=https://yourdomain.com
   ```
   The backend CORS code will automatically handle `www.yourdomain.com` if you provide the main domain
7. Click **Save Changes** (this will trigger a redeploy)

## Step 6: Update Firebase Authorized Domains

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project: `linkify-1f8e7`
3. Click the gear icon ⚙️ → **Project Settings**
4. Scroll down to **"Your apps"** section
5. Click on your web app
6. Scroll to **"Authorized domains"** section
7. Click **"Add domain"**
8. Add these domains (one at a time):
   - `yourdomain.com` (replace with your actual domain)
   - `www.yourdomain.com`
9. Click **Add** for each

**Keep the existing Vercel domain** (`cellspottmanagefrontend1.vercel.app`) for preview deployments.

## Step 7: Verify SSL/TLS in Cloudflare

1. Go to Cloudflare dashboard → Your domain
2. Click **SSL/TLS**
3. Set **SSL/TLS encryption mode** to: **Full (strict)**
4. This ensures secure connection between Cloudflare and Vercel/Render

## Step 8: Test Your Setup

1. Wait 5-10 minutes for DNS to propagate
2. Visit: `https://yourdomain.com`
3. You should see your website
4. Open browser console (F12)
5. Check for: `🌐 Backend API URL: https://cell-spott-manage-backend.onrender.com`
6. Try logging in
7. Verify everything works

## Step 9: Optional - Cloudflare Optimizations

### Speed Settings

1. Go to Cloudflare dashboard → Your domain → **Speed**
2. Enable:
   - ✅ **Auto Minify**: CSS, HTML, JavaScript
   - ✅ **Brotli**
   - ✅ **Early Hints** (if available)

### Caching

1. Go to **Caching** → **Configuration**
2. Set **Caching Level**: Standard
3. Set **Browser Cache TTL**: 4 hours

### Security

1. Go to **Security**
2. Set **Security Level**: Medium
3. Enable **Bot Fight Mode** (free plan)
4. Set **Challenge Passage**: 30 minutes

## Troubleshooting

### Domain not working after adding DNS records

- Wait 10-30 minutes for DNS propagation
- Check Vercel dashboard → Domains to see verification status
- In Cloudflare, check DNS records are correct
- Make sure proxy is enabled (orange cloud) for CNAME records

### SSL errors

- Make sure SSL/TLS mode is set to "Full (strict)" in Cloudflare
- Wait a few minutes for SSL certificates to provision
- Clear browser cache

### Backend API calls failing

- Verify `FRONTEND_URL` is set correctly in Render
- Check browser console for CORS errors
- Verify backend is running (check Render logs)
- The backend URL in `config.js` should still work (it falls back to Render URL)

### Firebase authentication fails

- Verify domain is added to Firebase Authorized Domains
- Wait a few minutes after adding domain
- Clear browser cache and try again

## Summary

After completing these steps, you'll have:

- ✅ Frontend accessible at: `https://yourdomain.com` and `https://www.yourdomain.com`
- ✅ Backend API at: `https://cell-spott-manage-backend.onrender.com` (or `https://api.yourdomain.com` if you upgraded Render)
- ✅ Cloudflare providing SSL, caching, and security
- ✅ Firebase configured for your domain
- ✅ CORS properly configured

Your website is now live on your custom domain! 🎉

