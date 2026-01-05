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
    const apiURL = window.AEFA_API_URL || (
        isLocalhost
            ? 'http://localhost:3000'  // Local development
            : (() => {
                // Production: Always use Render URL directly
                // If you set up an API subdomain later, you can configure it here
                // For now, use the Render backend URL directly
                return 'https://cell-spott-manage-backend.onrender.com';
            })()
    );
    
    // Set both variable names for backward compatibility
    window.AEFA_API_URL = apiURL;
    window.ALFA_API_URL = apiURL;  // Alias for files that use ALFA_API_URL
    
    // Log the detected URL for debugging
    console.log('🌐 Backend API URL:', window.AEFA_API_URL);
})();

