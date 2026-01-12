# Progressive Web App (PWA) Setup Guide

## Files Created/Modified

### 1. `manifest.json` (Root: `/frontend/manifest.json`)
   - Defines app metadata, icons, theme colors, and display mode
   - **Location**: Must be accessible at `/manifest.json` from the root of your website
   - **Display Mode**: `standalone` - Opens like a native app without browser UI

### 2. `service-worker.js` (Already exists: `/frontend/service-worker.js`)
   - Handles offline caching and push notifications
   - Already configured with network-first strategy for HTML/CSS/JS
   - Cache-first strategy for images and static assets

### 3. `pwa-register.js` (New: `/frontend/shared/pwa-register.js`)
   - Registers the service worker
   - Handles PWA install prompts
   - Manages service worker updates

### 4. HTML Files Updated
   - All pages in `/frontend/pages/` now include:
     - Manifest link: `<link rel="manifest" href="/manifest.json">`
     - Theme color meta tag
     - iOS-specific meta tags for better iOS support
     - PWA registration script

## Required Icons

You need to create two icon files and place them in `/frontend/assets/`:

1. **icon-192x192.png** - 192x192 pixels
2. **icon-512x512.png** - 512x512 pixels

### Creating Icons

You can use your existing logo (`/assets/logo1.png`) as a base:

#### Option 1: Online Tools
- Use [PWA Asset Generator](https://www.pwabuilder.com/imageGenerator)
- Upload your logo and it will generate all required sizes

#### Option 2: Image Editing Software
- Open your logo in an image editor (Photoshop, GIMP, etc.)
- Resize to 192x192 pixels, save as `icon-192x192.png`
- Resize to 512x512 pixels, save as `icon-512x512.png`
- Ensure icons have transparent backgrounds or solid backgrounds
- Icons should be square and centered

#### Option 3: Command Line (if you have ImageMagick)
```bash
# Convert logo to 192x192
convert assets/logo1.png -resize 192x192 -background white -gravity center -extent 192x192 assets/icon-192x192.png

# Convert logo to 512x512
convert assets/logo1.png -resize 512x512 -background white -gravity center -extent 512x512 assets/icon-512x512.png
```

## Testing the PWA

### Desktop (Chrome/Edge)
1. Open your website
2. Look for the install icon in the address bar
3. Click "Install" to add to desktop
4. The app should open in a standalone window

### Android
1. Open your website in Chrome
2. Tap the menu (three dots)
3. Select "Add to Home screen" or "Install app"
4. The app icon will appear on your home screen
5. Tap it to open in standalone mode (no browser UI)

### iOS (Safari)
1. Open your website in Safari
2. Tap the Share button
3. Select "Add to Home Screen"
4. The app will open in standalone mode when launched from home screen

## Verification Checklist

- [ ] Icons created and placed in `/frontend/assets/`
- [ ] `manifest.json` is accessible at `/manifest.json`
- [ ] Service worker is registered (check browser DevTools > Application > Service Workers)
- [ ] Manifest is valid (check DevTools > Application > Manifest)
- [ ] App installs on Android
- [ ] App installs on iOS (via "Add to Home Screen")
- [ ] App opens in standalone mode (no browser address bar)
- [ ] Offline functionality works (test by going offline)

## Troubleshooting

### Icons not showing
- Ensure icons are exactly 192x192 and 512x512 pixels
- Check that file paths in `manifest.json` are correct
- Verify icons are accessible via URL (try opening `/assets/icon-192x192.png` in browser)

### Service worker not registering
- Check browser console for errors
- Ensure site is served over HTTPS (or localhost for development)
- Verify `service-worker.js` is accessible at `/service-worker.js`

### App not installing
- Check that all requirements are met (HTTPS, valid manifest, service worker)
- Use Chrome DevTools > Application > Manifest to check for errors
- Ensure `display: "standalone"` is set in manifest

### iOS not showing install prompt
- iOS doesn't show install prompts like Android
- Users must manually use "Add to Home Screen" from Safari share menu
- Ensure iOS meta tags are present in HTML

## Additional Notes

- The service worker already handles push notifications
- Offline caching is configured with network-first strategy for dynamic content
- The app will work offline after first visit (cached resources)
- Theme color (`#5b21b6`) matches your purple/violet brand color

