/**
 * Download Chromium for Puppeteer
 * This script runs during build (postinstall) to ensure Chromium is downloaded
 * Required for Render.com deployment where build and runtime environments are separate
 */

const puppeteer = require('puppeteer');
const path = require('path');

async function downloadChromium() {
    console.log('🔍 Ensuring Chromium is downloaded for Puppeteer...');
    console.log('   This is required for Render.com deployment');
    
    try {
        // Set cache directory to node_modules/.cache/puppeteer
        // This ensures Chromium persists from build to runtime on Render.com
        const cacheDir = path.join(__dirname, 'node_modules', '.cache', 'puppeteer');
        process.env.PUPPETEER_CACHE_DIR = cacheDir;
        
        console.log(`📁 Puppeteer cache directory: ${cacheDir}`);
        
        // Calling executablePath() triggers Chromium download if not present
        console.log('   Getting executable path (triggers download if needed)...');
        const executablePath = await puppeteer.executablePath();
        
        if (executablePath) {
            console.log(`✅ Chromium downloaded: ${executablePath.substring(0, 100)}...`);
            
            // Test launch to ensure it works
            console.log('   Testing Chromium launch...');
            const browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });
            await browser.close();
            console.log('✅ Chromium launch test successful');
            
            return true;
        } else {
            console.error('❌ Chromium executable path is null');
            return false;
        }
    } catch (error) {
        console.error('❌ Error downloading Chromium:', error.message);
        console.error('   Stack:', error.stack);
        console.error('');
        console.error('🔧 Troubleshooting:');
        console.error('   1. Ensure PUPPETEER_SKIP_DOWNLOAD is NOT set to true');
        console.error('   2. Check build logs for network/disk space issues');
        console.error('   3. Chromium download requires ~300MB disk space');
        return false;
    }
}

// Run with timeout
const timeout = setTimeout(() => {
    console.error('⏱️ Chromium download timed out after 10 minutes');
    console.error('   Build will continue, but browser may fail at runtime');
    process.exit(0);
}, 10 * 60 * 1000); // 10 minute timeout

downloadChromium()
    .then(success => {
        clearTimeout(timeout);
        if (!success) {
            console.log('');
            console.log('⚠️ WARNING: Chromium download failed');
            console.log('   The build will continue, but the browser may fail to launch');
        } else {
            console.log('');
            console.log('✅ Chromium download complete - ready for deployment');
        }
        process.exit(0); // Don't fail build
    })
    .catch(error => {
        clearTimeout(timeout);
        console.error('❌ Download script error:', error);
        console.error('   Build will continue');
        process.exit(0); // Don't fail build
    });

