/**
 * Frontend API Configuration
 * 
 * This file configures the backend API URL for production deployments.
 * 
 * IMPORTANT: After deploying your backend to Render.com, update the URL below
 * with your actual Render.com backend URL.
 * 
 * Example: https://linkify-backend.onrender.com
 * 
 * For local development, this can be overridden by setting window.AEFA_API_URL
 * before this script loads.
 */

// Backend API URL - Configured for production
window.AEFA_API_URL = window.AEFA_API_URL || 'https://cellspottmanage.onrender.com';

// Log the configured API URL (for debugging in production)
if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    console.log('🌐 Backend API URL:', window.AEFA_API_URL);
    if (window.AEFA_API_URL.includes('your-backend-url')) {
        console.warn('⚠️ WARNING: Backend URL not configured! Update frontend/config.js with your Render.com backend URL.');
    }
}

