/**
 * PM2 Monitoring Fix Script
 * 
 * This script disables PM2 monitoring for the app to avoid wmic errors on Windows.
 * Run this after starting PM2: pm2 unmonitor linkify-backend
 * 
 * Or use: node fix-pm2-monitoring.js
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function disableMonitoring() {
    try {
        console.log('🔧 Disabling PM2 monitoring to avoid wmic errors...');
        
        // Unmonitor the app (disables CPU/memory monitoring)
        try {
            await execPromise('pm2 unmonitor linkify-backend');
            console.log('✅ PM2 monitoring disabled for linkify-backend');
        } catch (error) {
            // App might not be running, that's OK
            if (error.message.includes('not found')) {
                console.log('ℹ️  App not running, monitoring will be disabled when started');
            } else {
                console.warn('⚠️  Could not disable monitoring:', error.message);
            }
        }
        
        console.log('✅ PM2 monitoring fix applied');
        console.log('   Note: PM2 will still restart on crashes, but won\'t monitor CPU/memory');
        console.log('   This prevents "spawn wmic ENOENT" errors on Windows');
        
    } catch (error) {
        console.error('❌ Error fixing PM2 monitoring:', error.message);
    }
}

// Run if called directly
if (require.main === module) {
    disableMonitoring();
}

module.exports = { disableMonitoring };

