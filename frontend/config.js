/**
 * Frontend API Configuration
 * Sets the backend API URL based on the environment
 */

(function() {
    'use strict';
    
    // Detect if running on localhost
    const isLocalhost = window.location.hostname === 'localhost' || 
                        window.location.hostname === '127.0.0.1' ||
                        window.location.hostname === '';

    // Auto-detect API URL based on environment
    window.AEFA_API_URL = window.AEFA_API_URL || (
        isLocalhost
            ? 'http://localhost:3000'  // Local development
            : (() => {
                // Production: Use api subdomain if on custom domain, otherwise use Render URL
                const hostname = window.location.hostname;

                // If on custom domain (not vercel.app), use api subdomain
                if (hostname && !hostname.includes('vercel.app') && !hostname.includes('localhost')) {
                    // Replace www or remove subdomain, add api
                    const domain = hostname.replace(/^(www\.|api\.)/, '');
                    return `https://api.${domain}`;
                }

                // Fallback to Render URL (direct Render deployment URL)
                // TODO: Update this with your actual Render backend URL after deployment
                return 'https://cell-spott-manage-backend.onrender.com';
            })()
    );
    
    // Log the detected URL for debugging (only in development)
    if (isLocalhost) {
        console.log('🌐 Backend API URL:', window.AEFA_API_URL);
    }
})();

