/**
 * Puppeteer Configuration
 * Sets cache directory to node_modules/.cache/puppeteer
 * This ensures Chromium persists from build to runtime on Render.com
 */

const { join } = require('path');

module.exports = {
    cacheDirectory: join(__dirname, 'node_modules', '.cache', 'puppeteer'),
};

