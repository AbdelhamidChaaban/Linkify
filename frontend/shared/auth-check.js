/**
 * Shared authentication and block status check utility
 * Used by all protected pages to verify user authentication and block status
 */

let blockStatusUnsubscribe = null; // Store the unsubscribe function for the real-time listener

/**
 * Sign out blocked user and redirect to login
 * @param {string} userId - User ID to sign out
 */
async function signOutBlockedUser(userId) {
    try {
        console.warn(`🚫 User ${userId} is blocked - signing out immediately`);
        
        // Sign out the user immediately
        if (typeof auth !== 'undefined' && auth) {
            await auth.signOut();
        }
        
        // Clear any cached data
        localStorage.clear();
        sessionStorage.clear();
        
        // Show message and redirect
        alert('Your account has been blocked. Please contact support.');
        window.location.href = '/auth/login.html';
    } catch (error) {
        console.error('❌ Error signing out blocked user:', error);
        // Force redirect even if sign out fails
        window.location.href = '/auth/login.html';
    }
}

/**
 * Check if user is blocked and sign them out if they are
 * This should be called on page load for all protected pages
 * @returns {Promise<boolean>} True if user is not blocked, false if blocked (and logged out)
 */
async function checkUserBlockStatus() {
    try {
        // Check if Firebase is loaded
        if (typeof auth === 'undefined' || !auth) {
            return true; // Can't check, assume not blocked
        }
        
        // Wait for auth state
        const user = auth.currentUser;
        if (!user || !user.uid) {
            return true; // Not logged in, no need to check block status
        }
        
        // Check if Firestore is loaded
        if (typeof db === 'undefined' || !db) {
            return true; // Can't check, assume not blocked
        }
        
        // Check if user document exists and user is approved and not blocked
        const userDoc = await db.collection('users').doc(user.uid).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            
            // Check if user is approved (must be explicitly true)
            if (userData.isApproved !== true) {
                console.warn(`🚫 User ${user.uid} is not approved - signing out immediately`);
                await auth.signOut();
                localStorage.clear();
                sessionStorage.clear();
                alert('Please contact 71829887');
                window.location.href = '/auth/login.html';
                return false;
            }
            
            // Check if user is blocked
            if (userData.isBlocked === true) {
                await signOutBlockedUser(user.uid);
                return false;
            }
        } else {
            // User document doesn't exist - sign out
            console.warn(`🚫 User ${user.uid} document does not exist - signing out immediately`);
            await auth.signOut();
            localStorage.clear();
            sessionStorage.clear();
            alert('Please contact 71829887');
            window.location.href = '/auth/login.html';
            return false;
        }
        
        return true; // User is approved and not blocked
    } catch (error) {
        console.error('❌ Error checking user block status:', error);
        // If check fails, don't block the user (fail open)
        return true;
    }
}

/**
 * Set up real-time listener for user block status
 * This will immediately detect when a user gets blocked
 */
function setupBlockStatusListener() {
    try {
        // Check if Firebase is loaded
        if (typeof auth === 'undefined' || !auth) {
            return;
        }
        
        // Check if Firestore is loaded
        if (typeof db === 'undefined' || !db) {
            return;
        }
        
        // Wait for user to be authenticated
        const user = auth.currentUser;
        if (!user || !user.uid) {
            // User not logged in yet, wait for auth state change
            if (auth.onAuthStateChanged) {
                const unsubscribeAuth = auth.onAuthStateChanged((authUser) => {
                    if (authUser && authUser.uid) {
                        unsubscribeAuth(); // Stop listening to auth changes
                        setupBlockStatusListener(); // Set up block listener now that user is authenticated
                    }
                });
            }
            return;
        }
        
        // Clean up any existing listener
        if (blockStatusUnsubscribe) {
            blockStatusUnsubscribe();
            blockStatusUnsubscribe = null;
        }
        
        // Set up real-time listener on user document
        const userRef = db.collection('users').doc(user.uid);
        blockStatusUnsubscribe = userRef.onSnapshot(
            (doc) => {
                if (doc.exists) {
                    const userData = doc.data();
                    
                    // Check if user is no longer approved
                    if (userData.isApproved !== true) {
                        console.warn(`🚫 User ${user.uid} approval revoked - signing out immediately`);
                        auth.signOut().then(() => {
                            localStorage.clear();
                            sessionStorage.clear();
                            alert('Please contact 71829887');
                            window.location.href = '/auth/login.html';
                        }).catch(error => {
                            console.error('Error signing out unapproved user:', error);
                        });
                        return;
                    }
                    
                    // Check if user got blocked
                    if (userData.isBlocked === true) {
                        // User just got blocked - sign them out immediately
                        signOutBlockedUser(user.uid).catch(error => {
                            console.error('Error signing out blocked user:', error);
                        });
                    }
                } else {
                    // User document deleted - sign out
                    console.warn(`🚫 User ${user.uid} document deleted - signing out immediately`);
                    auth.signOut().then(() => {
                        localStorage.clear();
                        sessionStorage.clear();
                        alert('Please contact 71829887');
                        window.location.href = '/auth/login.html';
                    }).catch(error => {
                        console.error('Error signing out user with deleted document:', error);
                    });
                }
            },
            (error) => {
                console.error('❌ Error in block status listener:', error);
                // If listener fails, fall back to periodic checks
                // Don't block the user if listener fails
            }
        );
        
        console.log('✅ Block status real-time listener set up for user:', user.uid);
    } catch (error) {
        console.error('❌ Error setting up block status listener:', error);
    }
}

/**
 * Initialize block status monitoring
 * This should be called when the page loads
 * It checks immediately and sets up a real-time listener
 */
function initBlockStatusCheck() {
    // Check immediately when page loads
    if (typeof auth !== 'undefined' && typeof db !== 'undefined') {
        checkUserBlockStatus().then((isNotBlocked) => {
            if (isNotBlocked) {
                // Only set up listener if user is not blocked
                setupBlockStatusListener();
            }
        }).catch(error => {
            console.error('Error in initial block status check:', error);
        });
    } else {
        // Wait for Firebase to load, then check
        let attempts = 0;
        const maxAttempts = 50; // 5 seconds
        const checkInterval = setInterval(() => {
            attempts++;
            if (typeof auth !== 'undefined' && typeof db !== 'undefined') {
                clearInterval(checkInterval);
                checkUserBlockStatus().then((isNotBlocked) => {
                    if (isNotBlocked) {
                        // Only set up listener if user is not blocked
                        setupBlockStatusListener();
                    }
                }).catch(error => {
                    console.error('Error in block status check:', error);
                });
            } else if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
            }
        }, 100);
    }
    
    // Also listen for auth state changes to set up listener when user logs in
    if (typeof auth !== 'undefined' && auth.onAuthStateChanged) {
        auth.onAuthStateChanged((user) => {
            if (user && user.uid) {
                // User logged in, set up block status listener
                if (typeof db !== 'undefined') {
                    setupBlockStatusListener();
                }
            } else {
                // User logged out, clean up listener
                if (blockStatusUnsubscribe) {
                    blockStatusUnsubscribe();
                    blockStatusUnsubscribe = null;
                }
            }
        });
    }
}

// Clean up listener when page unloads
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        if (blockStatusUnsubscribe) {
            blockStatusUnsubscribe();
            blockStatusUnsubscribe = null;
        }
    });
}

// Auto-initialize when script loads (for pages that include this script)
if (typeof window !== 'undefined') {
    // Run check when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initBlockStatusCheck);
    } else {
        initBlockStatusCheck();
    }
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { checkUserBlockStatus, initBlockStatusCheck, setupBlockStatusListener };
}

