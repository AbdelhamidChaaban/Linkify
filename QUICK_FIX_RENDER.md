# ⚡ Quick Fix: "Could not find Chrome" on Render.com

## Immediate Action Required

### Step 1: Add Environment Variable in Render.com

1. Go to your Render.com service dashboard
2. Click **"Environment"** tab  
3. Click **"Add Environment Variable"**
4. Add:
   - **Key:** `PUPPETEER_SKIP_DOWNLOAD`
   - **Value:** `false`
5. Click **"Save Changes"**
6. Render will automatically redeploy

### Step 2: Verify Build Command

In Render.com dashboard → Settings → Build & Deploy:
- **Build Command:** `npm install` (should already be this)
- The `postinstall` script will automatically run and download Chromium

### Step 3: Check Build Logs

After redeploy, check logs for:
```
🔍 Ensuring Chromium is downloaded...
✅ Chromium executable found: ...
✅ Chromium launch test successful
```

**First build takes 5-10 minutes** (Chromium download ~300MB)

---

## What Was Fixed

### ✅ Code Changes (Already Applied)

1. **`backend/services/browserPool.js`**:
   - Gets `executablePath` from bundled `puppeteer`
   - Explicitly passes it to `puppeteer-extra.launch()`
   - This ensures Chromium is found

2. **`backend/ensure-chromium.js`** (new file):
   - Runs during `npm install` (postinstall script)
   - Triggers Chromium download
   - Verifies Chromium is ready

3. **`backend/package.json`**:
   - Added `postinstall` script
   - Ensures Chromium downloads during build

---

## Why This Works

- **Problem:** `puppeteer-extra` uses `puppeteer-core` internally (no Chromium)
- **Solution:** Get Chromium path from bundled `puppeteer` and pass it explicitly
- **Result:** `puppeteer-extra` uses the correct Chromium binary

---

## After Redeploy

Expected logs:
```
✅ Chromium executable found: /opt/render/project/src/backend/node_modules/.cache/puppeteer/...
✅ Chromium launch test successful
✅ Browser pool initialized successfully
```

If you still see errors, check:
1. ✅ `PUPPETEER_SKIP_DOWNLOAD=false` is set in Render.com
2. ✅ Build logs show Chromium download completing
3. ✅ First build took 5-10 minutes (Chromium download time)

