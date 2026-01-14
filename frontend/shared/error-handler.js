/**
 * Global Error Handler
 * Suppresses harmless browser extension errors
 */

// Handle unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
    // Suppress browser extension errors
    const errorMessage = event.reason?.message || event.reason?.toString() || '';
    
    if (errorMessage.includes('message channel closed') || 
        errorMessage.includes('asynchronous response') ||
        errorMessage.includes('message channel closed before a response')) {
        // Suppress this harmless browser extension error
        event.preventDefault();
        return;
    }
    
    // Suppress service worker errors when file doesn't exist (expected behavior)
    if (errorMessage.includes('service-worker.js') && 
        (errorMessage.includes('Not found') || 
         errorMessage.includes('404') || 
         errorMessage.includes('Failed to update') ||
         errorMessage.includes('service worker'))) {
        // Suppress this harmless service worker error (file is optional)
        event.preventDefault();
        return;
    }
    
    // Let other errors pass through normally
});

// Handle general errors (less common for this specific error, but just in case)
window.addEventListener('error', (event) => {
    const errorMessage = event.message || event.error?.message || '';
    
    if (errorMessage.includes('message channel closed') || 
        errorMessage.includes('asynchronous response') ||
        errorMessage.includes('message channel closed before a response')) {
        // Suppress this harmless browser extension error
        event.preventDefault();
        return false;
    }
    
    // Suppress service worker errors when file doesn't exist (expected behavior)
    if (errorMessage.includes('service-worker.js') && 
        (errorMessage.includes('Not found') || 
         errorMessage.includes('404') || 
         errorMessage.includes('Failed to update') ||
         errorMessage.includes('service worker'))) {
        // Suppress this harmless service worker error (file is optional)
        event.preventDefault();
        return false;
    }
    
    // Let other errors pass through normally
    return true;
});

