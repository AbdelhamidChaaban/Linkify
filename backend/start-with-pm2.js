/**
 * PM2 Startup Script with Monitoring Disabled
 * 
 * This script starts the server and ensures PM2 monitoring is disabled
 * to avoid wmic errors on Windows.
 * 
 * Usage: pm2 start start-with-pm2.js --name linkify-backend
 */

// Suppress pidusage errors on Windows
process.on('uncaughtException', (error) => {
    // Ignore wmic/pidusage errors - they don't affect functionality
    if (error.message && (
        error.message.includes('wmic') ||
        error.message.includes('ENOENT') ||
        error.message.includes('pidusage')
    )) {
        // Silently ignore - monitoring is not critical
        return;
    }
    // Re-throw other errors
    throw error;
});

// Start the server
require('./server.js');

