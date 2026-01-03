/**
 * JWT Authentication Middleware
 * Validates JWT tokens from Firebase Auth or custom tokens
 */

const jwt = require('jsonwebtoken');
const axios = require('axios');

// Initialize Firebase Admin if available
let adminAuth = null;
try {
    const admin = require('firebase-admin');
    if (!admin.apps || admin.apps.length === 0) {
        // Initialize Firebase Admin if not already done
        const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
            ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
            : null;
        
        if (serviceAccount) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            adminAuth = admin.auth();
            console.log('✅ Firebase Admin initialized for JWT verification');
        } else {
            console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT_KEY not set, using Firebase REST API for token verification');
        }
    } else {
        const { getAuth } = require('firebase-admin/auth');
        adminAuth = getAuth(admin.app());
        console.log('✅ Firebase Admin already initialized');
    }
} catch (error) {
    console.warn('⚠️ Firebase Admin not available, JWT validation will use Firebase REST API or custom secret');
}

// JWT secret from environment (fallback for custom tokens)
const JWT_SECRET = process.env.JWT_SECRET || process.env.FIREBASE_API_KEY || 'fallback-secret-change-in-production';

// Check Firebase API key on startup
if (!process.env.FIREBASE_API_KEY && !adminAuth) {
    console.error('❌ [Auth] FIREBASE_API_KEY not set and Firebase Admin not available!');
    console.error('   JWT token verification will fail. Please set FIREBASE_API_KEY in your .env file.');
    console.error('   The API key should match your frontend Firebase config.');
}

/**
 * Extract JWT token from Authorization header
 * Supports: "Bearer <token>" or just "<token>"
 */
function extractToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return null;
    }
    
    // Support "Bearer <token>" format
    if (authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }
    
    // Support direct token
    return authHeader;
}

/**
 * Verify Firebase ID token using Admin SDK or REST API
 */
async function verifyFirebaseToken(token) {
    // Try Firebase Admin SDK first
    if (adminAuth) {
        try {
            console.log('🔍 [Auth] Attempting Firebase Admin SDK verification...');
            const decodedToken = await adminAuth.verifyIdToken(token);
            console.log('✅ [Auth] Firebase Admin SDK verification successful');
            return {
                uid: decodedToken.uid,
                email: decodedToken.email,
                emailVerified: decodedToken.email_verified,
                firebase: true
            };
        } catch (error) {
            console.warn(`⚠️ [Auth] Firebase Admin SDK verification failed: ${error.message}`);
            // Fall through to REST API
        }
    } else {
        console.log('⚠️ [Auth] Firebase Admin SDK not available, using REST API...');
    }
    
    // Fallback to Firebase REST API
    try {
        let apiKey = process.env.FIREBASE_API_KEY;
        
        // If FIREBASE_API_KEY is not set, try FIREBASE_WEB_API_KEY as fallback
        if (!apiKey) {
            apiKey = process.env.FIREBASE_WEB_API_KEY;
        }
        
        // Last resort: use the API key from frontend config (should be set in .env)
        // This is the API key from firebase-config.js: AIzaSyCz83EAYIqHZgfjdyhsNr1m1d0lfe7SHRg
        // NOTE: This is a temporary fallback - you should set FIREBASE_API_KEY in .env
        if (!apiKey && process.env.NODE_ENV !== 'production') {
            console.warn('⚠️ [Auth] FIREBASE_API_KEY not set, using hardcoded fallback (development only)');
            console.warn('   ⚠️ Please set FIREBASE_API_KEY in your backend .env file');
            console.warn('   ⚠️ It should match the apiKey from your frontend firebase-config.js');
            apiKey = 'AIzaSyCz83EAYIqHZgfjdyhsNr1m1d0lfe7SHRg'; // Frontend API key (public, safe for client-side)
        }
        
        if (!apiKey) {
            console.error('❌ [Auth] FIREBASE_API_KEY not set, cannot verify via REST API');
            console.error('   Please set FIREBASE_API_KEY in your backend .env file');
            console.error('   It should match the apiKey from your frontend firebase-config.js');
            return null;
        }
        
        console.log('🔍 [Auth] Attempting Firebase REST API verification...');
        const response = await axios.post(
            `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
            { idToken: token },
            { timeout: 5000 }
        );
        
        if (response.data && response.data.users && response.data.users.length > 0) {
            const user = response.data.users[0];
            console.log('✅ [Auth] Firebase REST API verification successful');
            return {
                uid: user.localId || user.uid,
                email: user.email,
                emailVerified: user.emailVerified || false,
                firebase: true
            };
        } else {
            console.warn('⚠️ [Auth] Firebase REST API returned no users');
        }
    } catch (error) {
        // Token verification failed
        console.error(`❌ [Auth] Firebase REST API verification failed: ${error.message}`);
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            if (error.response.data) {
                console.error(`   Error: ${JSON.stringify(error.response.data)}`);
            }
            
            // Check for specific error codes
            if (error.response.status === 400) {
                const errorData = error.response.data;
                if (errorData.error && errorData.error.message) {
                    console.error(`   Firebase Error: ${errorData.error.message}`);
                }
            }
        }
        return null;
    }
    
    return null;
}

/**
 * Verify custom JWT token
 */
function verifyCustomToken(token) {
    try {
        console.log('🔍 [Auth] Attempting custom JWT verification...');
        const decoded = jwt.verify(token, JWT_SECRET);
        console.log('✅ [Auth] Custom JWT verification successful');
        return {
            uid: decoded.uid || decoded.userId || decoded.id,
            email: decoded.email,
            emailVerified: decoded.emailVerified || false,
            firebase: false
        };
    } catch (error) {
        console.warn(`⚠️ [Auth] Custom JWT verification failed: ${error.message}`);
        return null;
    }
}

/**
 * JWT Authentication Middleware
 * Validates JWT token and attaches user info to req.user
 */
async function authenticateJWT(req, res, next) {
    try {
        const token = extractToken(req);
        
        if (!token) {
            console.warn('⚠️ [Auth] No token provided in request');
            return res.status(401).json({
                success: false,
                error: 'Authentication required',
                message: 'No authorization token provided'
            });
        }
        
        // Log token prefix for debugging (first 20 chars only for security)
        const tokenPrefix = token.substring(0, 20) + '...';
        console.log(`🔍 [Auth] Verifying token: ${tokenPrefix}`);
        
        // Try Firebase token first (if Firebase Admin is available)
        let user = await verifyFirebaseToken(token);
        
        if (user) {
            console.log(`✅ [Auth] Firebase token verified for user: ${user.uid}`);
        } else {
            console.log(`⚠️ [Auth] Firebase token verification failed, trying custom JWT...`);
        }
        
        // Fallback to custom JWT token
        if (!user) {
            user = verifyCustomToken(token);
            if (user) {
                console.log(`✅ [Auth] Custom JWT verified for user: ${user.uid}`);
            } else {
                console.log(`❌ [Auth] Custom JWT verification also failed`);
            }
        }
        
        if (!user) {
            console.error('❌ [Auth] Token verification failed for all methods');
            return res.status(401).json({
                success: false,
                error: 'Invalid token',
                message: 'Token verification failed. Please log in again.'
            });
        }
        
        // Attach user info to request
        req.user = user;
        req.userId = user.uid;
        req.userEmail = user.email; // Also attach email for convenience
        
        // Check if user is blocked (only for Firebase users, not custom JWT)
        if (user.firebase) {
            try {
                const admin = require('firebase-admin');
                let adminDb = null;
                
                // Try to get existing Firebase Admin instance
                if (admin.apps.length > 0) {
                    adminDb = admin.firestore();
                } else {
                    // Initialize if not already done
                    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
                        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
                        : null;
                    if (serviceAccount) {
                        admin.initializeApp({
                            credential: admin.credential.cert(serviceAccount)
                        });
                        adminDb = admin.firestore();
                    }
                }
                
                if (adminDb) {
                    const userDoc = await adminDb.collection('users').doc(user.uid).get();
                    if (userDoc.exists) {
                        const userData = userDoc.data();
                        if (userData.isBlocked === true) {
                            console.warn(`🚫 [Auth] Blocked user attempted to access: ${user.uid}`);
                            return res.status(403).json({
                                success: false,
                                error: 'Account blocked',
                                message: 'Your account has been blocked. Please contact support.'
                            });
                        }
                    }
                }
            } catch (blockCheckError) {
                // If block check fails, log but don't block the request (fail open for now)
                // This prevents blocking legitimate users if there's a database issue
                console.warn('⚠️ [Auth] Could not check user block status:', blockCheckError.message);
            }
        }
        
        next();
    } catch (error) {
        console.error('❌ [Auth] Authentication error:', error);
        return res.status(500).json({
            success: false,
            error: 'Authentication error',
            message: error.message
        });
    }
}

/**
 * Optional authentication middleware
 * Attaches user info if token is valid, but doesn't fail if missing
 */
async function optionalAuth(req, res, next) {
    try {
        const token = extractToken(req);
        
        if (token) {
            let user = await verifyFirebaseToken(token);
            if (!user) {
                user = verifyCustomToken(token);
            }
            
            if (user) {
                req.user = user;
                req.userId = user.uid;
            }
        }
        
        next();
    } catch (error) {
        // Don't fail on optional auth errors
        next();
    }
}

module.exports = {
    authenticateJWT,
    optionalAuth,
    extractToken
};

