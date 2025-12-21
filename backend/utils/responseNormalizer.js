/**
 * Response Normalizer
 * Normalizes API responses to consistent format
 */

/**
 * Normalize successful API response
 * @param {*} data - Response data
 * @param {Object} metadata - Additional metadata
 * @returns {Object} Normalized response
 */
function normalizeApiResponse(data, metadata = {}) {
    return {
        success: true,
        data: data,
        timestamp: Date.now(),
        ...metadata
    };
}

/**
 * Create error response
 * @param {string} message - Error message
 * @param {Error} error - Original error object
 * @returns {Object} Error response
 */
function createErrorResponse(message, error = null) {
    const response = {
        success: false,
        error: message,
        timestamp: Date.now()
    };
    
    // Include error details in development
    if (error && process.env.NODE_ENV !== 'production') {
        response.errorDetails = {
            message: error.message,
            type: error.type || error.name,
            stack: error.stack
        };
    }
    
    return response;
}

/**
 * Normalize subscriber data response
 * @param {Object} subscriberData - Subscriber data
 * @returns {Object} Normalized subscriber response
 */
function normalizeSubscriberResponse(subscriberData) {
    return {
        success: true,
        data: {
            number: subscriberData.number || subscriberData.phone || subscriberData.mobileNumber,
            results: subscriberData.results || [],
            ...subscriberData
        },
        timestamp: Date.now()
    };
}

module.exports = {
    normalizeApiResponse,
    createErrorResponse,
    normalizeSubscriberResponse
};

