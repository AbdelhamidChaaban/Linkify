/**
 * Ensure Chromium is downloaded for Puppeteer
 * This script runs during build to trigger Chromium download
 * 
 * CRITICAL: This ensures Chromium is available for puppeteer-extra
 * which may use puppeteer-core internally.
 * 
 * On Render.com, we need Chromium in node_modules (not system cache)
 * so it persists from build to runtime.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// Set Puppeteer cache directory to node_modules/.cache/puppeteer
// This ensures Chromium persists from build to runtime on Render.com
const puppeteerCacheDir = path.join(__dirname, 'node_modules', '.cache', 'puppeteer');
if (!process.env.PUPPETEER_CACHE_DIR) {
    process.env.PUPPETEER_CACHE_DIR = puppeteerCacheDir;
    // Ensure directory exists
    if (!fs.existsSync(puppeteerCacheDir)) {
        fs.mkdirSync(puppeteerCacheDir, { recursive: true });
    }
    console.log(`📁 Set PUPPETEER_CACHE_DIR to: ${puppeteerCacheDir}`);
}

async function ensureChromium() {
    console.log('🔍 Ensuring Chromium is downloaded for Puppeteer...');
    console.log('   This may take 2-5 minutes on first build...');
    
    try {
        // Get executable path - this triggers Chromium download if not present
        console.log('   Getting executable path (triggers download if needed)...');
        const executablePath = await puppeteer.executablePath();
        
        if (executablePath) {
            console.log(`✅ Chromium executable found: ${executablePath.substring(0, 100)}...`);
            
            // Test launch to ensure Chromium is fully downloaded and functional
            console.log('   Testing Chromium launch...');
            try {
                const browser = await puppeteer.launch({
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
                });
                await browser.close();
                console.log('✅ Chromium launch test successful - ready for deployment');
            } catch (launchError) {
                console.warn(`⚠️ Chromium found but launch test failed: ${launchError.message}`);
                console.warn('   Chromium may still work at runtime, but verify deployment logs');
            }
            
            return true;
        } else {
            console.error('❌ Chromium executable path is null');
            console.error('   Chromium download may have failed');
            return false;
        }
    } catch (error) {
        console.error('❌ Error ensuring Chromium:', error.message);
        console.error('   Stack:', error.stack);
        console.error('');
        console.error('🔧 Troubleshooting:');
        console.error('   1. Check that PUPPETEER_SKIP_DOWNLOAD is NOT set to true');
        console.error('   2. Verify npm install completed successfully');
        console.error('   3. Chromium will attempt to download on first browser launch');
        return false;
    }
}

// Run verification with timeout
const timeout = setTimeout(() => {
    console.error('⏱️ Chromium download verification timed out after 5 minutes');
    console.error('   Build will continue - Chromium will download on first launch');
    process.exit(0);
}, 5 * 60 * 1000); // 5 minute timeout

ensureChromium()
    .then(success => {
        clearTimeout(timeout);
        if (!success) {
            console.log('');
            console.log('⚠️ WARNING: Chromium download verification failed');
            console.log('   The build will continue, but browser may fail to launch on Render.com');
            console.log('   Check deployment logs for "Could not find Chrome" errors');
        } else {
            console.log('');
            console.log('✅ Chromium verification complete - ready for deployment');
        }
        process.exit(0); // Don't fail build
    })
    .catch(error => {
        clearTimeout(timeout);
        console.error('❌ Verification script error:', error);
        console.error('   Build will continue - Chromium will download on first launch');
        process.exit(0); // Don't fail build
    });

