// Home Page Script
class HomeManager {
    constructor() {
        this.admins = [];
        this.unsubscribe = null;
        this.periodicRefreshInterval = null;
        this.currentUserId = null; // Current authenticated user ID
        this.hasReceivedInitialData = false; // Track if we've received initial data from listener
        this.isListenerActive = false; // Track if listener is currently active
        this.refreshingAdmins = new Set(); // Track which admins are currently being refreshed
        this.lastRefreshTime = new Map(); // Track when each admin was last refreshed (to skip modal updates)
        this.modalUpdateTimeout = null; // Debounce timeout for modal updates
        
        // Initialize after auth is ready
        this.init();
    }
    
    async init() {
        // Wait for Firebase auth to be ready and user to be authenticated
        try {
            // CRITICAL: Wait for auth to be confirmed before setting up listeners
            try {
                await this.waitForAuth();
            } catch (authError) {
                console.error('❌ [Home] Auth wait failed:', authError.message);
                // Try to get user ID directly as fallback
                const fallbackUserId = this.getCurrentUserId();
                if (fallbackUserId) {
                    this.currentUserId = fallbackUserId;
                    console.log('✅ [Home] Using fallback user ID:', fallbackUserId);
                } else {
                    throw authError; // Re-throw if no fallback available
                }
            }
            
            await this.waitForFirebase();
            
            // Verify user is still authenticated before proceeding
            const currentUserId = this.getCurrentUserId() || this.currentUserId;
            if (!currentUserId) {
                console.error('❌ [Home] User not authenticated after wait - cannot initialize');
                return;
            }
            
            console.log(`✅ [Home] User authenticated: ${currentUserId} - Initializing listeners`);
            
            // Update welcome banner with user name/email
            await this.updateWelcomeBanner();
            
            // Initialize card listeners first (doesn't depend on Firestore)
            console.log('🔍 [Home] Initializing card listeners...');
            this.initCardListeners();
            
            // LAZY LOAD: Initialize real-time listener only after page is visible/interactive
            // This improves initial page load performance by deferring Firebase listener setup
            this.initRealTimeListenerLazy();
            
            // Wait a bit for listener to get initial data, then do force refresh as backup
            // This prevents race condition where forceRefresh clears data before listener loads
            setTimeout(() => {
                if (!this.hasReceivedInitialData) {
                    console.log('⚠️ [Home] Listener hasn\'t received data yet, using forceRefresh as fallback');
                    this.forceRefresh();
                } else {
                    console.log('✅ [Home] Listener already has data, skipping forceRefresh');
                }
            }, 2000);
            
            // Refresh when page becomes visible (user switches back to tab)
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) {
                    console.log('👁️ [Home] Page became visible, refreshing data...');
                    this.forceRefresh();
                }
            });

            // Set up periodic refresh every 30 seconds to ensure we're always in sync
            // This acts as a safety net in case the real-time listener misses something
            this.periodicRefreshInterval = setInterval(() => {
                console.log('⏰ [Home] Periodic refresh triggered');
                this.forceRefresh();
            }, 30000); // 30 seconds
        } catch (error) {
            console.error('❌ [Home] Initialization error:', error);
            // Try to recover by checking auth one more time
            const fallbackUserId = this.getCurrentUserId();
            if (fallbackUserId) {
                console.log('🔄 [Home] Attempting recovery with fallback user ID:', fallbackUserId);
                this.currentUserId = fallbackUserId;
                // Try to initialize listener anyway
                try {
                    this.initRealTimeListenerLazy();
                    this.forceRefresh();
                } catch (recoveryError) {
                    console.error('❌ [Home] Recovery failed:', recoveryError);
                }
            } else {
                // Show user-friendly error message
                const errorMsg = document.createElement('div');
                errorMsg.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #ef4444; color: white; padding: 2rem; border-radius: 8px; z-index: 10000; text-align: center; max-width: 400px;';
                errorMsg.innerHTML = '<h3 style="margin: 0 0 1rem 0;">Authentication Error</h3><p style="margin: 0 0 1rem 0;">Please refresh the page or log in again.</p><button onclick="location.reload()" style="padding: 0.5rem 1rem; background: white; color: #ef4444; border: none; border-radius: 4px; cursor: pointer;">Refresh Page</button>';
                document.body.appendChild(errorMsg);
                setTimeout(() => errorMsg.remove(), 10000);
            }
        }
    }
    
    async waitForAuth() {
        // Wait for Firebase auth to be available and user to be authenticated
        // CRITICAL: Use onAuthStateChanged to ensure auth state is confirmed before proceeding
        let attempts = 0;
        while (attempts < 50) {
            if (typeof auth !== 'undefined' && auth) {
                // Wait for auth state to be confirmed via onAuthStateChanged
                return new Promise((resolve, reject) => {
                    let resolved = false;
                    
                    // CRITICAL: Check currentUser FIRST before setting up listener (faster path)
                    // This handles cases where user is already authenticated but onAuthStateChanged hasn't fired
                    if (auth.currentUser && auth.currentUser.uid) {
                        this.currentUserId = auth.currentUser.uid;
                        console.log('✅ [Home] User already authenticated (immediate check):', auth.currentUser.uid);
                        resolve();
                        return;
                    }
                    
                    // If currentUser is null, wait for onAuthStateChanged to fire
                    const unsubscribe = auth.onAuthStateChanged((user) => {
                        if (!resolved) {
                            resolved = true;
                            unsubscribe();
                            if (user && user.uid) {
                                this.currentUserId = user.uid;
                                console.log('✅ [Home] Auth state confirmed - User authenticated:', user.uid);
                                resolve();
                            } else {
                                // No user - check currentUser one more time as fallback
                                if (auth.currentUser && auth.currentUser.uid) {
                                    this.currentUserId = auth.currentUser.uid;
                                    console.log('✅ [Home] User found via currentUser fallback:', auth.currentUser.uid);
                                    resolve();
                                } else {
                                    console.error('❌ [Home] Auth state confirmed - No user signed in');
                                    reject(new Error('User not authenticated. Please log in.'));
                                }
                            }
                        }
                    });
                    
                    // Increased timeout to 15 seconds - auth state can take time to initialize
                    // Also check currentUser periodically as fallback
                    let checkCount = 0;
                    const checkInterval = setInterval(() => {
                        checkCount++;
                        if (auth.currentUser && auth.currentUser.uid && !resolved) {
                            resolved = true;
                            clearInterval(checkInterval);
                            unsubscribe();
                            this.currentUserId = auth.currentUser.uid;
                            console.log('✅ [Home] User authenticated via periodic check:', auth.currentUser.uid);
                            resolve();
                        } else if (checkCount >= 30) {
                            // 15 seconds (30 * 500ms)
                            clearInterval(checkInterval);
                            if (!resolved) {
                                resolved = true;
                                unsubscribe();
                                // Final fallback: check currentUser one last time
                                if (auth.currentUser && auth.currentUser.uid) {
                                    this.currentUserId = auth.currentUser.uid;
                                    console.log('✅ [Home] User authenticated via final fallback check:', auth.currentUser.uid);
                                    resolve();
                                } else {
                                    reject(new Error('Auth state timeout - user authentication state not confirmed'));
                                }
                            }
                        }
                    }, 500);
                    
                    // Also set a timeout as backup
                    setTimeout(() => {
                        clearInterval(checkInterval);
                        if (!resolved) {
                            resolved = true;
                            unsubscribe();
                            // Final fallback: check currentUser one last time
                            if (auth.currentUser && auth.currentUser.uid) {
                                this.currentUserId = auth.currentUser.uid;
                                console.log('✅ [Home] User authenticated via timeout fallback:', auth.currentUser.uid);
                                resolve();
                            } else {
                                reject(new Error('Auth state timeout - user authentication state not confirmed'));
                            }
                        }
                    }, 15000);
                });
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        throw new Error('Firebase auth timeout - auth object not available');
    }
    
    async waitForFirebase() {
        // Wait for db to be available
        let attempts = 0;
        while (typeof db === 'undefined' && attempts < 50) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
        if (typeof db === 'undefined') {
            throw new Error('Firebase Firestore (db) is not initialized');
        }
    }

    // Get current user ID from Firebase auth
    getCurrentUserId() {
        if (typeof auth !== 'undefined' && auth && auth.currentUser) {
            return auth.currentUser.uid;
        }
        return null;
    }
    
    // Update welcome banner with user's name from Firestore
    async updateWelcomeBanner() {
        const welcomeNameEl = document.getElementById('homeWelcomeName');
        if (!welcomeNameEl) return;
        
        try {
            const currentUserId = this.getCurrentUserId();
            if (!currentUserId) {
                welcomeNameEl.textContent = 'User';
                return;
            }
            
            // Fetch user document from Firestore to get the username
            if (typeof db !== 'undefined' && db) {
                const userDoc = await db.collection('users').doc(currentUserId).get();
                if (userDoc.exists) {
                    const userData = userDoc.data();
                    const userName = userData.name || userData.email || 'User';
                    welcomeNameEl.textContent = userName;
                } else {
                    // Fallback to email if user document doesn't exist
                    if (typeof auth !== 'undefined' && auth && auth.currentUser) {
                        const user = auth.currentUser;
                        welcomeNameEl.textContent = user.email || 'User';
                    } else {
                        welcomeNameEl.textContent = 'User';
                    }
                }
            } else {
                // Fallback if Firestore is not available
                if (typeof auth !== 'undefined' && auth && auth.currentUser) {
                    const user = auth.currentUser;
                    welcomeNameEl.textContent = user.email || 'User';
                } else {
                    welcomeNameEl.textContent = 'User';
                }
            }
        } catch (error) {
            console.error('Error updating welcome banner:', error);
            // Fallback to email on error
            try {
                if (typeof auth !== 'undefined' && auth && auth.currentUser) {
                    const user = auth.currentUser;
                    welcomeNameEl.textContent = user.email || 'User';
                } else {
                    welcomeNameEl.textContent = 'User';
                }
            } catch (fallbackError) {
                welcomeNameEl.textContent = 'User';
            }
        }
    }

    async forceRefresh(showNotification = false) {
        // Force a fresh fetch from server to ensure we have latest data
        // showNotification: Only show toast notification if this is a manual refresh (user-initiated)
        if (typeof db === 'undefined') {
            console.warn('⚠️ [Home] Firebase not available, skipping force refresh');
            return;
        }

        try {
            // Get current user ID - CRITICAL for data isolation
            const currentUserId = this.getCurrentUserId();
            if (!currentUserId) {
                console.warn('⚠️ [Home] No authenticated user found. Cannot refresh data.');
                return;
            }
            
            console.log('🔄 [Home] Force refreshing data from server...');
            // CRITICAL: Filter admins by userId to ensure each user only sees their own admins
            // Note: Compat version may not support source option, but get() should still work
            const snapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
            
            // Update admins array from fresh server data
            const previousCount = this.admins.length;
            const previousIds = new Set(this.admins.map(a => a.id));
            
            // CRITICAL: Only include documents that actually exist in the snapshot
            const newAdmins = [];
            snapshot.docs.forEach(doc => {
                try {
                    const data = doc.data();
                    if (data && doc.id) {
                        newAdmins.push({
                            id: doc.id,
                            ...data
                        });
                    } else {
                        console.warn(`⚠️ [Home] Skipping invalid document: ${doc.id}`);
                    }
                } catch (e) {
                    console.error(`❌ [Home] Error processing document ${doc.id}:`, e);
                }
            });

            this.admins = newAdmins;

            const currentIds = new Set(this.admins.map(a => a.id));
            const deletedIds = [...previousIds].filter(id => !currentIds.has(id));
            const addedIds = [...currentIds].filter(id => !previousIds.has(id));

            console.log(`✅ [Home] Force refresh complete:`, {
                previousCount: previousCount,
                currentCount: this.admins.length,
                deleted: deletedIds.length,
                added: addedIds.length,
                deletedIds: deletedIds,
                addedIds: addedIds
            });
            
            // Update card counts
            this.updateCardCounts();
            
            // Show success toast notification only if this is a manual refresh
            if (showNotification) {
                try {
                    const notify = (typeof window !== 'undefined' && window.notification) ? window.notification : (typeof notification !== 'undefined' ? notification : null);
                    if (notify && typeof notify.success === 'function') {
                        notify.set({ delay: 3000 });
                        notify.success('Data refreshed successfully');
                    } else {
                        console.warn('⚠️ Notification system not available or not initialized');
                    }
                } catch (e) {
                    console.error('Error showing notification:', e);
                }
            }
        } catch (error) {
            console.error('❌ [Home] Force refresh failed:', error);
            
            // Show error toast notification only if this is a manual refresh
            if (showNotification) {
                const errorMessage = error?.message || error?.toString() || 'Unknown error occurred';
                try {
                    const notify = (typeof window !== 'undefined' && window.notification) ? window.notification : (typeof notification !== 'undefined' ? notification : null);
                    if (notify && typeof notify.error === 'function') {
                        notify.set({ delay: 3000 });
                        notify.error('Refresh failed: ' + (errorMessage.length > 50 ? errorMessage.substring(0, 50) + '...' : errorMessage));
                    } else {
                        console.warn('⚠️ Notification system not available or not initialized');
                    }
                } catch (e) {
                    console.error('Error showing notification:', e);
                }
            }
        }
    }

    // Lazy load real-time listener: Wait until page is visible and interactive
    initRealTimeListenerLazy() {
        // If page is already visible and interactive, initialize immediately
        if (document.visibilityState === 'visible' && document.readyState === 'complete') {
            // Use requestIdleCallback to initialize when browser is idle (better performance)
            if ('requestIdleCallback' in window) {
                requestIdleCallback(() => {
                    console.log('⚡ [Home] Page visible and idle - initializing Firebase listener');
                    this.initRealTimeListener();
                }, { timeout: 2000 }); // Max 2 second wait even if browser is busy
            } else {
                // Fallback: small delay to allow page to finish rendering
                setTimeout(() => {
                    console.log('⚡ [Home] Page ready - initializing Firebase listener (fallback)');
                    this.initRealTimeListener();
                }, 100);
            }
        } else {
            // Wait for page to become visible and interactive
            const initListener = () => {
                if (document.visibilityState === 'visible') {
                    // Page is visible, wait for it to be interactive
                    if (document.readyState === 'complete' || document.readyState === 'interactive') {
                        if ('requestIdleCallback' in window) {
                            requestIdleCallback(() => {
                                console.log('⚡ [Home] Page visible and idle - initializing Firebase listener');
                                this.initRealTimeListener();
                            }, { timeout: 2000 });
                        } else {
                            setTimeout(() => {
                                console.log('⚡ [Home] Page ready - initializing Firebase listener');
                                this.initRealTimeListener();
                            }, 100);
                        }
                        document.removeEventListener('visibilitychange', initListener);
                        if (document.readyState === 'loading') {
                            document.removeEventListener('DOMContentLoaded', initListener);
                        }
                    }
                }
            };
            
            // Listen for page visibility and ready state
            document.addEventListener('visibilitychange', initListener);
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', initListener);
            } else {
                // Already loaded, try to initialize after a short delay
                setTimeout(initListener, 100);
            }
            
            // Fallback: Initialize after max 3 seconds even if page isn't fully ready
            setTimeout(() => {
                if (!this.isListenerActive) {
                    console.log('⚡ [Home] Timeout reached - initializing Firebase listener (fallback)');
                    this.initRealTimeListener();
                }
            }, 3000);
        }
    }

    initRealTimeListener() {
        // CRITICAL: Unsubscribe from existing listener first to prevent multiple listeners
        if (this.unsubscribe) {
            console.log('🔄 [Home] Unsubscribing from existing listener before creating new one');
            try {
                this.unsubscribe();
            } catch (e) {
                console.warn('⚠️ [Home] Error unsubscribing:', e);
            }
            this.unsubscribe = null;
            this.isListenerActive = false;
        }
        
        // Check if Firebase is available
        if (typeof db === 'undefined') {
            console.error('❌ [Home] Firestore (db) is not initialized. Real-time updates disabled.');
            return;
        }

        // CRITICAL: Verify user is authenticated before setting up listener
        const currentUserId = this.getCurrentUserId();
        if (!currentUserId) {
            console.error('❌ [Home] No authenticated user found. Real-time updates disabled.');
            console.error('❌ [Home] This indicates an auth state issue - listener cannot be set up');
            return;
        }
        
        console.log(`🔄 [Home] Setting up real-time listener for user: ${currentUserId}`);
        this.isListenerActive = true;
        
        // Set up query aligned with Firestore rules
        // Rule: Users can only read admins where userId matches their auth.uid
        const adminsQuery = db.collection('admins').where('userId', '==', currentUserId);
        
        // Note: Firestore persistence is enabled in firebase-config.js with synchronizeTabs: false
        // This provides offline support and caching without multi-tab synchronization warnings
        
        // Set up real-time listener with explicit error handling
        console.log('📡 [Home] Attaching Firestore listener with query:', {
            collection: 'admins',
            filter: 'userId == ' + currentUserId
        });
        
        this.unsubscribe = adminsQuery.onSnapshot(
            (snapshot) => {
                // Check if this is from cache (offline mode) or server
                const source = snapshot.metadata && snapshot.metadata.fromCache ? 'cache' : 'server';
                console.log(`📡 [Home] Admins snapshot received: ${snapshot.docs.length} docs (source: ${source})`);
                
                // Log document changes to track deletions
                let hasDeletions = false;
                const deletedIdsFromChanges = [];
                try {
                    const changes = snapshot.docChanges ? snapshot.docChanges() : [];
                    if (changes.length > 0) {
                        console.log(`📝 [Home] Detected ${changes.length} document change(s) (source: ${source}):`);
                        changes.forEach((change) => {
                            console.log(`   - ${change.type}: ${change.doc.id}`);
                            if (change.type === 'removed') {
                                hasDeletions = true;
                                deletedIdsFromChanges.push(change.doc.id);
                                console.log(`   🗑️ [Home] Admin deleted: ${change.doc.id}`);
                            }
                        });
                    }
                } catch (e) {
                    console.log('📝 [Home] Could not get docChanges (compat version limitation)');
                }

                // CRITICAL: Always rebuild admins array from snapshot.docs
                // Deleted documents won't be in snapshot.docs, so they're automatically excluded
                const previousAdminIds = new Set(this.admins.map(a => a.id));
                
                // Rebuild admins array from current snapshot (this automatically excludes deleted docs)
                // IMPORTANT: Only include documents that exist in the snapshot
                const newAdmins = [];
                snapshot.docs.forEach(doc => {
                    try {
                        const data = doc.data();
                        if (data && doc.id) {
                            newAdmins.push({
                                id: doc.id,
                                ...data
                            });
                        }
                    } catch (e) {
                        console.error(`❌ [Home] Error processing document ${doc.id}:`, e);
                    }
                });

                // CRITICAL FIX: Prevent clearing admins when connection drops
                // Only update admins if:
                // 1. Data is from server (not cache), OR
                // 2. We have valid new data, OR  
                // 3. We've never received initial data (first load)
                
                const hasExistingAdmins = this.admins.length > 0;
                const hasNewAdmins = newAdmins.length > 0;
                const isFromServer = source === 'server';
                
                // Mark that we've received data if we have any admins
                if (hasNewAdmins) {
                    this.hasReceivedInitialData = true;
                }
                
                if (isFromServer) {
                    // Server data is authoritative - always use it
                    this.admins = newAdmins;
                    console.log(`✅ [Home] Updated from server: ${newAdmins.length} admins`);
                } else if (hasNewAdmins) {
                    // Cache has data - use it
                    this.admins = newAdmins;
                    console.log(`✅ [Home] Updated from cache: ${newAdmins.length} admins`);
                } else if (hasExistingAdmins && !hasNewAdmins && source === 'cache') {
                    // CRITICAL: Connection dropped, snapshot is empty, but we have cached data
                    // DON'T clear - keep existing admins to prevent disappearing
                    console.warn(`⚠️ [Home] Connection dropped - snapshot empty but preserving ${this.admins.length} cached admins`);
                    // DO NOT update this.admins - keep existing cached data
                } else if (!this.hasReceivedInitialData && !hasNewAdmins) {
                    // First load and no data - this is okay, might be empty collection
                    this.admins = newAdmins;
                    this.hasReceivedInitialData = true; // Mark as received even if empty
                    console.log(`ℹ️ [Home] Initial load: ${newAdmins.length} admins (collection might be empty)`);
                } else {
                    // Fallback: only update if we have new data or this is first load
                    if (hasNewAdmins || !this.hasReceivedInitialData) {
                        this.admins = newAdmins;
                    } else {
                        console.warn(`⚠️ [Home] Ignoring empty snapshot update to preserve existing ${this.admins.length} admins`);
                    }
                }
                
                const currentAdminIds = new Set(this.admins.map(a => a.id));
                
                // Find deleted admins by comparing previous and current IDs
                const deletedIds = [...previousAdminIds].filter(id => !currentAdminIds.has(id));
                
                if (deletedIds.length > 0) {
                    console.log(`🗑️ [Home] Detected ${deletedIds.length} deleted admin(s):`, deletedIds);
                    console.log(`🗑️ [Home] Deleted IDs from changes:`, deletedIdsFromChanges);
                }

                console.log('🔄 [Home] Real-time listener triggered!', {
                    docCount: snapshot.docs.length,
                    previousCount: previousAdminIds.size,
                    currentCount: this.admins.length,
                    deletedCount: deletedIds.length,
                    source: source,
                    timestamp: new Date().toISOString()
                });

                // ALWAYS update card counts when listener fires (to catch any deletions)
                console.log(`🔄 [Home] Updating card counts (hasDeletions: ${hasDeletions}, deletedIds: ${deletedIds.length})`);
                this.updateCardCounts();
                
                // Debounce modal updates to prevent closing/reopening during refresh
                // Skip modal updates if any admin was refreshed in the last 5 seconds
                const now = Date.now();
                const recentRefresh = Array.from(this.lastRefreshTime.entries()).some(([adminId, refreshTime]) => 
                    now - refreshTime < 5000
                );
                
                // Check if any modals are currently open
                const hasOpenModal = document.getElementById('availableServicesModal') ||
                                    document.getElementById('expiredNumbersModal') ||
                                    document.getElementById('servicesToExpireTodayModal') ||
                                    document.getElementById('finishedServicesModal') ||
                                    document.getElementById('highAdminConsumptionModal') ||
                                    document.getElementById('inactiveNumbersModal') ||
                                    document.getElementById('accessDeniedNumbersModal');
                
                if (recentRefresh && hasOpenModal) {
                    console.log('⏸️ [Home] Skipping modal update - refresh completed recently and modal is open (will update silently when user closes/reopens)');
                    // Clear any pending modal update timeout
                    if (this.modalUpdateTimeout) {
                        clearTimeout(this.modalUpdateTimeout);
                    }
                    // Don't schedule update - let user close/reopen modal to see fresh data
                    // This prevents the flicker of closing/reopening during refresh
                } else if (recentRefresh && !hasOpenModal) {
                    // No modal open, but recent refresh - schedule update after cooldown
                    console.log('⏸️ [Home] Skipping modal update - refresh completed recently (no modal open)');
                    if (this.modalUpdateTimeout) {
                        clearTimeout(this.modalUpdateTimeout);
                    }
                    this.modalUpdateTimeout = setTimeout(() => {
                        this.updateOpenModals();
                        this.modalUpdateTimeout = null;
                    }, 5000);
                } else {
                    // No recent refresh or no open modal - update normally
                    this.updateOpenModals();
                }

                // If using cache, log but don't force refresh (it will fail if offline)
                if (source === 'cache') {
                    console.warn(`⚠️ [Home] Using cached data (offline mode) - ${this.admins.length} admins visible`);
                    // Don't force refresh immediately - it will fail if offline
                    // The periodic refresh (30s) will handle reconnection when connection is restored
                }
            },
            (error) => {
                console.error('❌ [Home] Real-time listener error:', error);
                this.isListenerActive = false;
                
                // Handle specific error types
                if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
                    console.warn('⚠️ [Home] Firestore connection unavailable - operating in offline mode');
                    // Don't clear admins array - keep showing cached data
                    // The periodic refresh will try to reconnect
                    return;
                } else if (error.code === 'permission-denied') {
                    console.error('❌ [Home] Permission denied - clearing admins');
                    this.admins = [];
                    this.updateCardCounts();
                    alert('Permission denied. Please check your Firebase rules.');
                    return;
                }
                
                // Try to reconnect after a delay
                setTimeout(() => {
                    console.log('🔄 [Home] Attempting to reconnect real-time listener...');
                    // Only reconnect if we still have a user and Firebase is available
                    const currentUserId = this.getCurrentUserId();
                    if (currentUserId && typeof db !== 'undefined') {
                        this.initRealTimeListener();
                    } else {
                        console.error('❌ [Home] Cannot reconnect - user or Firebase not available');
                    }
                }, 5000);
            }
        );
    }

    updateCardCounts() {
        // Log current state for debugging
        console.log(`📊 [Home] Updating card counts with ${this.admins.length} admin(s)`);
        
        // CRITICAL: Filter out any invalid admins first
        const validAdmins = this.admins.filter(admin => {
            if (!admin || !admin.id) {
                console.warn(`⚠️ [Home] Found invalid admin (missing id):`, admin);
                return false;
            }
            return true;
        });

        if (validAdmins.length !== this.admins.length) {
            console.log(`🧹 [Home] Filtered out ${this.admins.length - validAdmins.length} invalid admin(s)`);
            this.admins = validAdmins;
        }
        
        // CRITICAL: Remove duplicates by ID
        const uniqueAdmins = [];
        const seenIds = new Set();
        this.admins.forEach(admin => {
            if (!seenIds.has(admin.id)) {
                seenIds.add(admin.id);
                uniqueAdmins.push(admin);
            } else {
                console.warn(`⚠️ [Home] Found duplicate admin ID: ${admin.id}`);
            }
        });
        
        if (uniqueAdmins.length !== this.admins.length) {
            console.log(`🧹 [Home] Removed ${this.admins.length - uniqueAdmins.length} duplicate admin(s)`);
            this.admins = uniqueAdmins;
        }
        
        if (!this.admins || this.admins.length === 0) {
            // No admins yet, set all counts to 0
            console.log('📊 [Home] No admins found, setting all counts to 0');
            this.setCardCount('1', 0); // Available Services
            this.setCardCount('2', 0); // Expired Numbers
            this.setCardCount('10', 0); // Services Expired Yesterday
            this.setCardCount('3', 0); // Services To Expire Today
            this.setCardCount('11', 0); // Services To Expire Tomorrow
            this.setCardCount('6', 0); // Finished Services
            this.setCardCount('7', 0); // High Admin Consumption
            this.setCardCount('9', 0); // Inactive Numbers
            this.setCardCount('12', 0); // Waiting Balance
            this.setCardCount('13', 0); // Access Denied Numbers
            return;
        }

        // Create a snapshot-like object for compatibility with filter functions
        // IMPORTANT: Only include valid admins that exist in this.admins
        const snapshot = {
            docs: this.admins.map(admin => ({
                id: admin.id,
                data: () => admin
            }))
        };

        console.log(`📊 [Home] Processing ${snapshot.docs.length} unique admin document(s) for filtering`);

        // Calculate counts for each card
        const availableServices = this.filterAvailableServices(snapshot);
        const expiredNumbers = this.filterExpiredNumbers(snapshot);
        const expiredYesterday = this.filterServicesExpiredYesterday(snapshot);
        const expiringToday = this.filterServicesToExpireToday(snapshot);
        const expiringTomorrow = this.filterServicesToExpireTomorrow(snapshot);
        const finishedServices = this.filterFinishedServices(snapshot);
        const highAdminConsumption = this.filterHighAdminConsumption(snapshot);
        const requestedServices = this.filterRequestedServices(snapshot);
        const inactiveNumbers = this.filterInactiveNumbers(snapshot);
        const accessDeniedNumbers = this.filterAccessDeniedNumbers(snapshot);

        // Update card counts
        this.setCardCount('1', availableServices.length); // Available Services
        this.setCardCount('2', expiredNumbers.length); // Expired Numbers
        this.setCardCount('10', expiredYesterday.length); // Services Expired Yesterday
        this.setCardCount('3', expiringToday.length); // Services To Expire Today
        this.setCardCount('11', expiringTomorrow.length); // Services To Expire Tomorrow
        this.setCardCount('6', finishedServices.length); // Finished Services
        this.setCardCount('7', highAdminConsumption.length); // High Admin Consumption
        this.setCardCount('8', requestedServices.length); // Requested Services
        this.setCardCount('9', inactiveNumbers.length); // Inactive Numbers
        this.setCardCount('13', accessDeniedNumbers.length); // Access Denied Numbers
        // Waiting Balance count
        const waitingBalanceCount = this.getWaitingBalanceData().length;
        this.setCardCount('12', waitingBalanceCount);

        console.log(`📊 [Home] Card counts updated:`, {
            availableServices: availableServices.length,
            expiredNumbers: expiredNumbers.length,
            expiredYesterday: expiredYesterday.length,
            expiringToday: expiringToday.length,
            expiringTomorrow: expiringTomorrow.length,
            finishedServices: finishedServices.length,
            highAdminConsumption: highAdminConsumption.length,
            requestedServices: requestedServices.length,
            inactiveNumbers: inactiveNumbers.length,
            accessDeniedNumbers: accessDeniedNumbers.length,
            totalAdmins: this.admins.length
        });
        
        // Update stat cards
        this.updateStatCards();
    }

    setCardCount(cardId, count) {
        const card = document.querySelector(`.card[data-card-id="${cardId}"]`);
        if (card) {
            // Find or create count element
            let countElement = card.querySelector('.card-count');
            if (!countElement) {
                countElement = document.createElement('div');
                countElement.className = 'card-count';
                // Append directly to card (not card-content) so it doesn't overlap with title
                card.appendChild(countElement);
            }
            countElement.textContent = count;
        }
    }
    
    // Update stat cards (Total Active Subscribers, Available Places, Total Balance)
    updateStatCards() {
        if (!this.admins || this.admins.length === 0) {
            this.updateStatCardValue('homeStatTotalActiveSubscribers', '0');
            this.updateStatCardValue('homeStatAvailablePlaces', '0');
            this.updateStatCardValue('homeStatTotalBalance', '$ 0.00');
            return;
        }
        
        // Create snapshot-like object
        const snapshot = {
            docs: this.admins.map(admin => ({
                id: admin.id,
                data: () => admin
            }))
        };
        
        // Calculate Total Active Subscribers
        let totalActiveSubscribers = 0;
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            const activeSubscribers = alfaData.secondarySubscribers || [];
            if (Array.isArray(activeSubscribers)) {
                totalActiveSubscribers += activeSubscribers.length;
            }
        });
        
        // Calculate Available Places (using filterAvailableServices logic)
        const availableServices = this.filterAvailableServices(snapshot);
        let availablePlaces = 0;
        availableServices.forEach(service => {
            // Get full admin data by ID
            const admin = this.admins.find(a => a.id === service.id);
            if (!admin) return;
            
            const alfaData = admin.alfaData || {};
            const activeSubscribers = alfaData.secondarySubscribers || [];
            const removedActiveSubscribers = admin.removedActiveSubscribers || [];
            
            // Count total subscribers (active + requested + out)
            let activeCount = 0;
            let requestedCount = 0;
            let outCount = Array.isArray(removedActiveSubscribers) ? removedActiveSubscribers.length : 0;
            
            if (Array.isArray(activeSubscribers)) {
                activeSubscribers.forEach(sub => {
                    const status = sub.status || 'Active';
                    if (status === 'Requested') {
                        requestedCount++;
                    } else {
                        activeCount++;
                    }
                });
            }
            
            const totalSubscribers = activeCount + requestedCount + outCount;
            const freeSlots = Math.max(0, 3 - totalSubscribers);
            availablePlaces += freeSlots;
        });
        
        // Calculate Total Balance (only for CLOSED admins)
        let totalBalance = 0;
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            // Only include admins with type "Closed" (case-insensitive check)
            const adminType = data.type ? String(data.type).toUpperCase() : '';
            if (adminType === 'CLOSED') {
                const alfaData = data.alfaData || {};
                if (alfaData.balance) {
                    const balanceStr = String(alfaData.balance).trim();
                    const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                    const balance = match ? parseFloat(match[0]) : 0;
                    totalBalance += balance;
                }
            }
        });
        
        // Update DOM elements
        this.updateStatCardValue('homeStatTotalActiveSubscribers', totalActiveSubscribers.toString());
        this.updateStatCardValue('homeStatAvailablePlaces', availablePlaces.toString());
        this.updateStatCardValue('homeStatTotalBalance', `$ ${totalBalance.toFixed(2)}`);
    }
    
    updateStatCardValue(elementId, value) {
        const element = document.getElementById(elementId);
        if (element) {
            element.textContent = value;
        }
    }

    updateOpenModals() {
        // Update modals if they're currently open
        const availableServicesModal = document.getElementById('availableServicesModal');
        if (availableServicesModal && !availableServicesModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            // Modal is open and not loading - refresh data
            this.refreshOpenModal('availableServices');
        }

        const expiredNumbersModal = document.getElementById('expiredNumbersModal');
        if (expiredNumbersModal && !expiredNumbersModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('expiredNumbers');
        }

        const servicesToExpireTodayModal = document.getElementById('servicesToExpireTodayModal');
        if (servicesToExpireTodayModal && !servicesToExpireTodayModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('servicesToExpireToday');
        }

        const finishedServicesModal = document.getElementById('finishedServicesModal');
        if (finishedServicesModal && !finishedServicesModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('finishedServices');
        }

        const highAdminConsumptionModal = document.getElementById('highAdminConsumptionModal');
        if (highAdminConsumptionModal && !highAdminConsumptionModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('highAdminConsumption');
        }

        const inactiveNumbersModal = document.getElementById('inactiveNumbersModal');
        if (inactiveNumbersModal && !inactiveNumbersModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('inactiveNumbers');
        }

        const accessDeniedNumbersModal = document.getElementById('accessDeniedNumbersModal');
        if (accessDeniedNumbersModal && !accessDeniedNumbersModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('accessDeniedNumbers');
        }

        const servicesExpiredYesterdayModal = document.getElementById('servicesExpiredYesterdayModal');
        if (servicesExpiredYesterdayModal && !servicesExpiredYesterdayModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('servicesExpiredYesterday');
        }

        const servicesToExpireTomorrowModal = document.getElementById('servicesToExpireTomorrowModal');
        if (servicesToExpireTomorrowModal && !servicesToExpireTomorrowModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('servicesToExpireTomorrow');
        }

        const requestedServicesModal = document.getElementById('requestedServicesModal');
        if (requestedServicesModal && !requestedServicesModal.querySelector('.available-services-modal-inner')?.querySelector('.loading-spinner')) {
            this.refreshOpenModal('requestedServices');
        }
    }

    refreshOpenModal(modalType) {
        if (!this.admins || this.admins.length === 0) return;

        const snapshot = {
            docs: this.admins.map(admin => ({
                id: admin.id,
                data: () => admin
            }))
        };

        // Check if modal is already open - if so, update in place instead of recreating
        let modalElement = null;
        switch (modalType) {
            case 'availableServices':
                modalElement = document.getElementById('availableServicesModal');
                if (modalElement) {
                    // Modal is open - update table content in place
                    const availableServices = this.filterAvailableServices(snapshot);
                    this.updateModalTableContent(modalElement, availableServices, 'availableServices');
                } else {
                    const availableServices = this.filterAvailableServices(snapshot);
                    this.showAvailableServicesModal(availableServices);
                }
                break;
            case 'expiredNumbers':
                modalElement = document.getElementById('expiredNumbersModal');
                if (modalElement) {
                    const expiredNumbers = this.filterExpiredNumbers(snapshot);
                    this.updateModalTableContent(modalElement, expiredNumbers, 'expiredNumbers');
                } else {
                    const expiredNumbers = this.filterExpiredNumbers(snapshot);
                    this.showExpiredNumbersModal(expiredNumbers);
                }
                break;
            case 'servicesToExpireToday':
                modalElement = document.getElementById('servicesToExpireTodayModal');
                if (modalElement) {
                    const expiringToday = this.filterServicesToExpireToday(snapshot);
                    this.updateModalTableContent(modalElement, expiringToday, 'servicesToExpireToday');
                } else {
                    const expiringToday = this.filterServicesToExpireToday(snapshot);
                    this.showServicesToExpireTodayModal(expiringToday);
                }
                break;
            case 'finishedServices':
                modalElement = document.getElementById('finishedServicesModal');
                if (modalElement) {
                    const finishedServices = this.filterFinishedServices(snapshot);
                    this.updateModalTableContent(modalElement, finishedServices, 'finishedServices');
                } else {
                    const finishedServices = this.filterFinishedServices(snapshot);
                    this.showFinishedServicesModal(finishedServices);
                }
                break;
            case 'highAdminConsumption':
                modalElement = document.getElementById('highAdminConsumptionModal');
                if (modalElement) {
                    const highAdminConsumption = this.filterHighAdminConsumption(snapshot);
                    this.updateModalTableContent(modalElement, highAdminConsumption, 'highAdminConsumption');
                } else {
                    const highAdminConsumption = this.filterHighAdminConsumption(snapshot);
                    this.showHighAdminConsumptionModal(highAdminConsumption);
                }
                break;
            case 'inactiveNumbers':
                modalElement = document.getElementById('inactiveNumbersModal');
                if (modalElement) {
                    const inactiveNumbers = this.filterInactiveNumbers(snapshot);
                    this.updateModalTableContent(modalElement, inactiveNumbers, 'inactiveNumbers');
                } else {
                    const inactiveNumbers = this.filterInactiveNumbers(snapshot);
                    this.showInactiveNumbersModal(inactiveNumbers);
                }
                break;
            case 'accessDeniedNumbers':
                modalElement = document.getElementById('accessDeniedNumbersModal');
                if (modalElement) {
                    const accessDeniedNumbers = this.filterAccessDeniedNumbers(snapshot);
                    this.updateModalTableContent(modalElement, accessDeniedNumbers, 'accessDeniedNumbers');
                } else {
                    const accessDeniedNumbers = this.filterAccessDeniedNumbers(snapshot);
                    this.showAccessDeniedNumbersModal(accessDeniedNumbers);
                }
                break;
            case 'servicesExpiredYesterday':
                modalElement = document.getElementById('servicesExpiredYesterdayModal');
                if (modalElement) {
                    const expiredYesterday = this.filterServicesExpiredYesterday(snapshot);
                    this.updateModalTableContent(modalElement, expiredYesterday, 'servicesExpiredYesterday');
                } else {
                    const expiredYesterday = this.filterServicesExpiredYesterday(snapshot);
                    this.showServicesExpiredYesterdayModal(expiredYesterday);
                }
                break;
            case 'servicesToExpireTomorrow':
                modalElement = document.getElementById('servicesToExpireTomorrowModal');
                if (modalElement) {
                    const expiringTomorrow = this.filterServicesToExpireTomorrow(snapshot);
                    this.updateModalTableContent(modalElement, expiringTomorrow, 'servicesToExpireTomorrow');
                } else {
                    const expiringTomorrow = this.filterServicesToExpireTomorrow(snapshot);
                    this.showServicesToExpireTomorrowModal(expiringTomorrow);
                }
                break;
            case 'requestedServices':
                modalElement = document.getElementById('requestedServicesModal');
                if (modalElement) {
                    const requestedServices = this.filterRequestedServices(snapshot);
                    this.updateModalTableContent(modalElement, requestedServices, 'requestedServices');
                } else {
                    const requestedServices = this.filterRequestedServices(snapshot);
                    this.showRequestedServicesModal(requestedServices);
                }
                break;
        }
    }
    
    // Update modal table content in place without removing/recreating the modal
    updateModalTableContent(modalElement, services, modalType) {
        if (!modalElement || !services) return;
        
        const tbody = modalElement.querySelector('tbody');
        if (!tbody) return;
        
        // Helper function to bind event handlers for table rows
        const bindEventHandlers = (tableRows, services) => {
            const tbody = modalElement.querySelector('tbody');
            if (!tbody) return;
            
            tbody.innerHTML = tableRows;
            
            // Re-bind event handlers for new rows
            const viewButtons = tbody.querySelectorAll('.view-btn');
            viewButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const id = e.currentTarget.dataset.subscriberId;
                    this.viewSubscriberDetails(id, services);
                });
            });
            
            const menuButtons = tbody.querySelectorAll('.menu-btn');
            menuButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const id = e.currentTarget.dataset.subscriberId;
                    this.toggleMenu(id, e.currentTarget);
                });
            });
        };
        
        // Handle modals with 7 columns: Name, Balance, Bundle Size, Subscribers, Needed Balance, Expiration, Actions
        // (Services To Expire Today, Services Expired Yesterday, Services To Expire Tomorrow)
        if (modalType === 'servicesToExpireToday' || modalType === 'servicesExpiredYesterday' || modalType === 'servicesToExpireTomorrow') {
            let tableRows = '';
            let hasMore = false;
            if (services.length === 0) {
                tableRows = `
                    <tr>
                        <td colspan="7" style="text-align: center; padding: 3rem; color: #94a3b8;">
                            No services expiring today found
                        </td>
                    </tr>
                `;
            } else {
                const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                    const statusClass = service.neededBalanceStatus === 'Ready To Renew' ? 'ready' : 'not-ready';
                    const hiddenClass = isHidden ? 'table-row-hidden' : '';
                    
                    return `
                        <tr class="${hiddenClass}">
                            <td>
                                <div>
                                    <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                    <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                                </div>
                            </td>
                            <td>$${service.balance.toFixed(2)}</td>
                            <td>${(modalType === 'servicesExpiredYesterday' || modalType === 'servicesToExpireTomorrow') ? service.bundleSize.toFixed(2) : service.bundleSize} GB</td>
                            <td>${service.subscribersCount}</td>
                            <td>
                                <span class="needed-balance-status ${statusClass}">${this.escapeHtml(service.neededBalanceStatus)}</span>
                            </td>
                            <td>${service.expiration}</td>
                            <td>
                                <div class="action-buttons">
                                    <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                            <circle cx="12" cy="12" r="3"/>
                                        </svg>
                                    </button>
                                    <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                        <svg viewBox="0 0 24 24" fill="currentColor">
                                            <circle cx="12" cy="12" r="2"/>
                                            <circle cx="12" cy="5" r="2"/>
                                            <circle cx="12" cy="19" r="2"/>
                                        </svg>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                }, 4);
                tableRows = result.rows;
                hasMore = result.hasMore;
            }
            
            // Update table body content
            tbody.innerHTML = tableRows;
            
            // Update "See More" button
            const seeMoreBtn = modalElement.querySelector('.see-more-btn');
            if (hasMore && !seeMoreBtn) {
                const modalBody = modalElement.querySelector('.available-services-modal-body');
                if (modalBody) {
                    const btn = document.createElement('button');
                    btn.className = 'see-more-btn';
                    btn.textContent = 'See More';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                        hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                        btn.remove();
                    });
                    modalBody.appendChild(btn);
                }
            } else if (!hasMore && seeMoreBtn) {
                seeMoreBtn.remove();
            }
            
            bindEventHandlers(tableRows, services);
            return; // Exit early for this modal type
        }
        
        // Handle "Expired Numbers" modal - 3 columns: Name, Expiration, Actions
        if (modalType === 'expiredNumbers') {
            let tableRows = '';
            let hasMore = false;
            if (services.length === 0) {
                tableRows = `
                    <tr>
                        <td colspan="3" style="text-align: center; padding: 3rem; color: #94a3b8;">
                            No expired numbers found
                        </td>
                    </tr>
                `;
            } else {
                const result = this.buildTableRowsWithLimit(services, (number, index, isHidden = false) => {
                    const hiddenClass = isHidden ? 'table-row-hidden' : '';
                    return `
                        <tr class="${hiddenClass}">
                            <td>
                                <div>
                                    <div class="subscriber-name">${this.escapeHtml(number.name)}</div>
                                    <div class="subscriber-phone">${this.escapeHtml(number.phone)}</div>
                                </div>
                            </td>
                            <td>${number.expiration}</td>
                            <td>
                                <div class="action-buttons">
                                    <button class="action-btn view-btn" data-subscriber-id="${number.id}" title="View Details">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                            <circle cx="12" cy="12" r="3"/>
                                        </svg>
                                    </button>
                                    <button class="action-btn menu-btn" data-subscriber-id="${number.id}" title="Menu">
                                        <svg viewBox="0 0 24 24" fill="currentColor">
                                            <circle cx="12" cy="12" r="2"/>
                                            <circle cx="12" cy="5" r="2"/>
                                            <circle cx="12" cy="19" r="2"/>
                                        </svg>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                }, 4);
                tableRows = result.rows;
                hasMore = result.hasMore;
            }
            
            // Update table body content
            tbody.innerHTML = tableRows;
            
            // Update "See More" button
            const seeMoreBtn = modalElement.querySelector('.see-more-btn');
            if (hasMore && !seeMoreBtn) {
                const modalBody = modalElement.querySelector('.available-services-modal-body');
                if (modalBody) {
                    const btn = document.createElement('button');
                    btn.className = 'see-more-btn';
                    btn.textContent = 'See More';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                        hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                        btn.remove();
                    });
                    modalBody.appendChild(btn);
                }
            } else if (!hasMore && seeMoreBtn) {
                seeMoreBtn.remove();
            }
            
            bindEventHandlers(tableRows, services);
            return;
        }
        
        // Handle "Requested Services" modal - 3 columns: Name, Subscribers, Actions
        if (modalType === 'requestedServices') {
            let tableRows = '';
            let hasMore = false;
            if (services.length === 0) {
                tableRows = `
                    <tr>
                        <td colspan="3" style="text-align: center; padding: 3rem; color: #94a3b8;">
                            No admins with requested subscribers found
                        </td>
                    </tr>
                `;
            } else {
                const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                    const subscribersDisplay = this.formatSubscribersCount(
                        service.subscribersActiveCount !== undefined ? service.subscribersActiveCount : service.subscribersCount,
                        service.subscribersRequestedCount
                    );
                    const hiddenClass = isHidden ? 'table-row-hidden' : '';
                    
                    return `
                        <tr class="${hiddenClass}">
                            <td>
                                <div>
                                    <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                    <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                                </div>
                            </td>
                            <td>${subscribersDisplay}</td>
                            <td>
                                <div class="action-buttons">
                                    <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                        <img src="/assets/eye.png" alt="View Details" style="width: 20px; height: 20px; object-fit: contain;" />
                                    </button>
                                    <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                        <svg viewBox="0 0 24 24" fill="currentColor">
                                            <circle cx="12" cy="12" r="2"/>
                                            <circle cx="12" cy="5" r="2"/>
                                            <circle cx="12" cy="19" r="2"/>
                                        </svg>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                }, 4);
                tableRows = result.rows;
                hasMore = result.hasMore;
            }
            
            // Update table body content
            tbody.innerHTML = tableRows;
            
            // Update "See More" button
            const seeMoreBtn = modalElement.querySelector('.see-more-btn');
            if (hasMore && !seeMoreBtn) {
                const modalBody = modalElement.querySelector('.available-services-modal-body');
                if (modalBody) {
                    const btn = document.createElement('button');
                    btn.className = 'see-more-btn';
                    btn.textContent = 'See More';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                        hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                        btn.remove();
                    });
                    modalBody.appendChild(btn);
                }
            } else if (!hasMore && seeMoreBtn) {
                seeMoreBtn.remove();
            }
            
            bindEventHandlers(tableRows, services);
            return;
        }
        
        // Handle "Finished Services" modal - 6 columns: Name, Usage, Subscribers, Expiration, Balance, Actions
        if (modalType === 'finishedServices') {
            let tableRows = '';
            let hasMore = false;
            if (services.length === 0) {
                tableRows = `
                    <tr>
                        <td colspan="6" style="text-align: center; padding: 3rem; color: #94a3b8;">
                            No finished services found (all services have available space)
                        </td>
                    </tr>
                `;
            } else {
                const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                    const usagePercent = service.totalLimit > 0 ? (service.totalConsumption / service.totalLimit) * 100 : 0;
                    const progressClass = usagePercent >= 100 ? 'progress-fill error' : 'progress-fill';
                    const hiddenClass = isHidden ? 'table-row-hidden' : '';
                    
                    return `
                        <tr class="${hiddenClass}">
                            <td>
                                <div>
                                    <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                    <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                                </div>
                            </td>
                            <td>
                                <div class="progress-container">
                                    <div class="progress-bar">
                                        <div class="${progressClass}" style="width: ${usagePercent}%"></div>
                                    </div>
                                    <div class="progress-text">${service.totalConsumption.toFixed(2)} / ${service.totalLimit} GB</div>
                                </div>
                            </td>
                            <td>${service.subscribersCount}</td>
                            <td>${service.expiration}</td>
                            <td>$${service.balance.toFixed(2)}</td>
                            <td>
                                <div class="action-buttons">
                                    <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                            <circle cx="12" cy="12" r="3"/>
                                        </svg>
                                    </button>
                                    <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                        <svg viewBox="0 0 24 24" fill="currentColor">
                                            <circle cx="12" cy="12" r="2"/>
                                            <circle cx="12" cy="5" r="2"/>
                                            <circle cx="12" cy="19" r="2"/>
                                        </svg>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                }, 4);
                tableRows = result.rows;
                hasMore = result.hasMore;
            }
            
            // Update table body content
            tbody.innerHTML = tableRows;
            
            // Update "See More" button
            const seeMoreBtn = modalElement.querySelector('.see-more-btn');
            if (hasMore && !seeMoreBtn) {
                const modalBody = modalElement.querySelector('.available-services-modal-body');
                if (modalBody) {
                    const btn = document.createElement('button');
                    btn.className = 'see-more-btn';
                    btn.textContent = 'See More';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                        hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                        btn.remove();
                    });
                    modalBody.appendChild(btn);
                }
            } else if (!hasMore && seeMoreBtn) {
                seeMoreBtn.remove();
            }
            
            bindEventHandlers(tableRows, services);
            return;
        }
        
        // Handle "High Admin Consumption" modal - 5 columns: Name, Admin Usage, Total Usage, Expiration Date, Actions
        if (modalType === 'highAdminConsumption') {
            let tableRows = '';
            let hasMore = false;
            if (services.length === 0) {
                tableRows = `
                    <tr>
                        <td colspan="5" style="text-align: center; padding: 3rem; color: #94a3b8;">
                            No admins with high admin consumption found
                        </td>
                    </tr>
                `;
            } else {
                const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                    const adminPercent = service.adminLimit > 0 ? (service.adminConsumption / service.adminLimit) * 100 : 0;
                    const adminProgressClass = adminPercent >= 95 ? 'progress-fill error' : 'progress-fill';
                    const adminProgressWidth = Math.min(adminPercent, 100);
                    
                    const totalPercent = service.totalLimit > 0 ? (service.totalConsumption / service.totalLimit) * 100 : 0;
                    const totalProgressClass = totalPercent >= 90 ? 'progress-fill error' : 'progress-fill';
                    const totalProgressWidth = Math.min(totalPercent, 100);
                    const hiddenClass = isHidden ? 'table-row-hidden' : '';
                    
                    return `
                        <tr class="${hiddenClass}">
                            <td>
                                <div>
                                    <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                    <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                                </div>
                            </td>
                            <td>
                                <div class="progress-container">
                                    <div class="progress-bar">
                                        <div class="${adminProgressClass}" style="width: ${adminProgressWidth}%"></div>
                                    </div>
                                    <div class="progress-text">${service.adminConsumption.toFixed(2)} / ${service.adminLimit.toFixed(2)} GB</div>
                                </div>
                            </td>
                            <td>
                                <div class="progress-container">
                                    <div class="progress-bar">
                                        <div class="${totalProgressClass}" style="width: ${totalProgressWidth}%"></div>
                                    </div>
                                    <div class="progress-text">${service.totalConsumption.toFixed(2)} / ${service.totalLimit.toFixed(2)} GB</div>
                                </div>
                            </td>
                            <td>${this.escapeHtml(service.validityDate)}</td>
                            <td>
                                <div class="action-buttons">
                                    <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                            <circle cx="12" cy="12" r="3"/>
                                        </svg>
                                    </button>
                                    <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                        <svg viewBox="0 0 24 24" fill="currentColor">
                                            <circle cx="12" cy="12" r="2"/>
                                            <circle cx="12" cy="5" r="2"/>
                                            <circle cx="12" cy="19" r="2"/>
                                        </svg>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                }, 4);
                tableRows = result.rows;
                hasMore = result.hasMore;
            }
            
            // Update table body content
            tbody.innerHTML = tableRows;
            
            // Update "See More" button
            const seeMoreBtn = modalElement.querySelector('.see-more-btn');
            if (hasMore && !seeMoreBtn) {
                const modalBody = modalElement.querySelector('.available-services-modal-body');
                if (modalBody) {
                    const btn = document.createElement('button');
                    btn.className = 'see-more-btn';
                    btn.textContent = 'See More';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                        hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                        btn.remove();
                    });
                    modalBody.appendChild(btn);
                }
            } else if (!hasMore && seeMoreBtn) {
                seeMoreBtn.remove();
            }
            
            bindEventHandlers(tableRows, services);
            return;
        }
        
        // Handle "Inactive Numbers" modal - 3 columns: Name, Balance, Actions
        if (modalType === 'inactiveNumbers') {
            let tableRows = '';
            let hasMore = false;
            if (services.length === 0) {
                tableRows = `
                    <tr>
                        <td colspan="3" style="text-align: center; padding: 3rem; color: #94a3b8;">
                            No inactive numbers found
                        </td>
                    </tr>
                `;
            } else {
                const result = this.buildTableRowsWithLimit(services, (number, index, isHidden = false) => {
                    const hiddenClass = isHidden ? 'table-row-hidden' : '';
                    return `
                        <tr class="${hiddenClass}">
                            <td>
                                <div>
                                    <div class="subscriber-name">${this.escapeHtml(number.name)}</div>
                                    <div class="subscriber-phone">${this.escapeHtml(number.phone)}</div>
                                </div>
                            </td>
                            <td>$${number.balance.toFixed(2)}</td>
                            <td>
                                <div class="action-buttons">
                                    <button class="action-btn view-btn" data-subscriber-id="${number.id}" title="View Details">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                            <circle cx="12" cy="12" r="3"/>
                                        </svg>
                                    </button>
                                    <button class="action-btn menu-btn" data-subscriber-id="${number.id}" title="Menu">
                                        <svg viewBox="0 0 24 24" fill="currentColor">
                                            <circle cx="12" cy="12" r="2"/>
                                            <circle cx="12" cy="5" r="2"/>
                                            <circle cx="12" cy="19" r="2"/>
                                        </svg>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                }, 4);
                tableRows = result.rows;
                hasMore = result.hasMore;
            }
            
            // Update table body content
            tbody.innerHTML = tableRows;
            
            // Update "See More" button
            const seeMoreBtn = modalElement.querySelector('.see-more-btn');
            if (hasMore && !seeMoreBtn) {
                const modalBody = modalElement.querySelector('.available-services-modal-body');
                if (modalBody) {
                    const btn = document.createElement('button');
                    btn.className = 'see-more-btn';
                    btn.textContent = 'See More';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                        hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                        btn.remove();
                    });
                    modalBody.appendChild(btn);
                }
            } else if (!hasMore && seeMoreBtn) {
                seeMoreBtn.remove();
            }
            
            bindEventHandlers(tableRows, services);
            return;
        }
        
        // Handle "Access Denied Numbers" modal - 3 columns: Name, Details, Actions
        if (modalType === 'accessDeniedNumbers') {
            let tableRows = '';
            let hasMore = false;
            if (services.length === 0) {
                tableRows = `
                    <tr>
                        <td colspan="3" style="text-align: center; padding: 3rem; color: #94a3b8;">
                            No access denied numbers found
                        </td>
                    </tr>
                `;
            } else {
                const result = this.buildTableRowsWithLimit(services, (number, index, isHidden = false) => {
                    const hiddenClass = isHidden ? 'table-row-hidden' : '';
                    return `
                        <tr class="${hiddenClass}">
                            <td>
                                <div>
                                    <div class="subscriber-name">${this.escapeHtml(number.name)}</div>
                                    <div class="subscriber-phone">${this.escapeHtml(number.phone)}</div>
                                </div>
                            </td>
                            <td style="color: #ef4444;">Access denied by Alfa system</td>
                            <td>
                                <div class="action-buttons">
                                    <button class="action-btn view-btn" data-subscriber-id="${number.id}" title="View Details">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                            <circle cx="12" cy="12" r="3"/>
                                        </svg>
                                    </button>
                                    <button class="action-btn menu-btn" data-subscriber-id="${number.id}" title="Menu">
                                        <svg viewBox="0 0 24 24" fill="currentColor">
                                            <circle cx="12" cy="12" r="2"/>
                                            <circle cx="12" cy="5" r="2"/>
                                            <circle cx="12" cy="19" r="2"/>
                                        </svg>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                }, 4);
                tableRows = result.rows;
                hasMore = result.hasMore;
            }
            
            // Update table body content
            tbody.innerHTML = tableRows;
            
            // Update "See More" button
            const seeMoreBtn = modalElement.querySelector('.see-more-btn');
            if (hasMore && !seeMoreBtn) {
                const modalBody = modalElement.querySelector('.available-services-modal-body');
                if (modalBody) {
                    const btn = document.createElement('button');
                    btn.className = 'see-more-btn';
                    btn.textContent = 'See More';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                        hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                        btn.remove();
                    });
                    modalBody.appendChild(btn);
                }
            } else if (!hasMore && seeMoreBtn) {
                seeMoreBtn.remove();
            }
            
            bindEventHandlers(tableRows, services);
            return;
        }
        
        // Build new table rows for other modal types (availableServices uses generic format)
        let tableRows = '';
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No data found
                    </td>
                </tr>
            `;
        } else {
            const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                const usagePercent = service.usageLimit > 0 ? (service.usage / service.usageLimit) * 100 : 0;
                const progressClass = usagePercent >= 90 ? 'progress-fill error' : 'progress-fill';
                const hiddenClass = isHidden ? 'table-row-hidden' : '';
                
                return `
                    <tr class="${hiddenClass}">
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="${progressClass}" style="width: ${usagePercent}%"></div>
                                </div>
                                <div class="progress-text">${service.usage.toFixed(2)} / ${service.usageLimit} GB</div>
                            </div>
                        </td>
                        <td>${service.subscribersCount}</td>
                        <td>${service.freeSpace.toFixed(2)} GB</td>
                        <td>${this.escapeHtml(service.validityDate)}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }, 4);
            tableRows = result.rows;
            
            // Update "See More" button
            const seeMoreBtn = modalElement.querySelector('.see-more-btn');
            if (result.hasMore && !seeMoreBtn) {
                const modalBody = modalElement.querySelector('.available-services-modal-body');
                if (modalBody) {
                    const btn = document.createElement('button');
                    btn.className = 'see-more-btn';
                    btn.textContent = 'See More';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                        hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                        btn.remove();
                    });
                    modalBody.appendChild(btn);
                }
            } else if (!result.hasMore && seeMoreBtn) {
                seeMoreBtn.remove();
            }
        }
        
        // Update table body content
        tbody.innerHTML = tableRows;
        
        // Re-bind event handlers for new rows
        const viewButtons = tbody.querySelectorAll('.view-btn');
        viewButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, services);
            });
        });
        
        const menuButtons = tbody.querySelectorAll('.menu-btn');
        menuButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });
    }

    initCardListeners() {
        const cardsContainer = document.querySelector('.cards-container');
        if (cardsContainer) {
            cardsContainer.addEventListener('click', (event) => {
                const card = event.target.closest('.card');
                if (card) {
                    const cardId = card.dataset.cardId;
                    if (event.target.classList.contains('card-button')) {
                        this.handleCardClick(cardId, 'button');
                    } else {
                        this.handleCardClick(cardId, 'card');
                    }
                }
            });
        }
    }

    handleCardClick(cardId, action) {
        console.log(`Card ${cardId} was clicked with action: ${action}`);
        
        // Handle "Available Services" card (card-id="1")
        if (cardId === '1') {
            this.openAvailableServicesModal();
        }
        // Handle "Expired Numbers" card (card-id="2")
        else if (cardId === '2') {
            this.openExpiredNumbersModal();
        }
        // Handle "Services Expired Yesterday" card (card-id="10")
        else if (cardId === '10') {
            this.openServicesExpiredYesterdayModal();
        }
        // Handle "Services To Expire Today" card (card-id="3")
        else if (cardId === '3') {
            this.openServicesToExpireTodayModal();
        }
        // Handle "Services To Expire Tomorrow" card (card-id="11")
        else if (cardId === '11') {
            this.openServicesToExpireTomorrowModal();
        }
        // Handle "Finished Services" card (card-id="6")
        else if (cardId === '6') {
            this.openFinishedServicesModal();
        }
        // Handle "High Admin Consumption" card (card-id="7")
        else if (cardId === '7') {
            this.openHighAdminConsumptionModal();
        }
        // Handle "Requested Services" card (card-id="8")
        else if (cardId === '8') {
            this.openRequestedServicesModal();
        }
        // Handle "Inactive Numbers" card (card-id="9")
        else if (cardId === '9') {
            this.openInactiveNumbersModal();
        }
        // Handle "Waiting Balance" card (card-id="12")
        else if (cardId === '12') {
            this.openWaitingBalanceModal();
        }
        // Handle "Access Denied Numbers" card (card-id="13")
        else if (cardId === '13') {
            this.openAccessDeniedNumbersModal();
        }
        // Future cards will be handled here
    }

    async openAvailableServicesModal() {
        try {
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                // Use cached real-time data
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                // Fallback: fetch from Firebase if real-time data not available
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                // CRITICAL: Filter by userId for data isolation
                const currentUserId = this.getCurrentUserId();
                if (!currentUserId) {
                    throw new Error('User not authenticated. Please log in.');
                }
                const firebaseSnapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
                snapshot = firebaseSnapshot;
            }
            
            // Process and filter admins
            const availableServices = this.filterAvailableServices(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showAvailableServicesModal(availableServices);
        } catch (error) {
            console.error('Error opening Available Services modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    async openExpiredNumbersModal() {
        try {
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                // CRITICAL: Filter by userId for data isolation
                const currentUserId = this.getCurrentUserId();
                if (!currentUserId) {
                    throw new Error('User not authenticated. Please log in.');
                }
                const firebaseSnapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
                snapshot = firebaseSnapshot;
            }
            
            // Process and filter admins
            const expiredNumbers = this.filterExpiredNumbers(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showExpiredNumbersModal(expiredNumbers);
        } catch (error) {
            console.error('Error opening Expired Numbers modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterAvailableServices(snapshot) {
        const availableServices = [];
        
        // Get today's date
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Set to start of day for accurate day calculation
        
        // First, get all admins that would appear in other cards to exclude them
        const excludedIds = new Set();
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip inactive admins (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                excludedIds.add(doc.id);
                return;
            }
            
            // Check if admin is in "Finished Services"
            // Parse admin consumption
            let adminConsumption = 0;
            let adminLimit = 0;
            
            if (alfaData.adminConsumption) {
                const adminConsumptionStr = String(alfaData.adminConsumption).trim();
                const match = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                if (match) {
                    adminConsumption = parseFloat(match[1]) || 0;
                    adminLimit = parseFloat(match[2]) || 0;
                }
            } else if (data.quota) {
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Parse total consumption
            let totalConsumption = 0;
            let totalLimit = 0;
            if (alfaData.totalConsumption) {
                const parsed = this.parseConsumption(alfaData.totalConsumption);
                totalConsumption = parsed.used;
                totalLimit = parsed.total || 0;
            } else if (data.quota) {
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                totalLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Check if this admin would be in Finished Services (same logic as filterFinishedServices)
            const isAdminFull = adminLimit > 0 && adminConsumption >= adminLimit - 0.01;
            const isTotalFull = totalLimit > 0 && totalConsumption >= totalLimit - 0.01;
            const isFullyUsed = isAdminFull || isTotalFull;
            
            if (isFullyUsed) {
                excludedIds.add(doc.id);
            }
            
            // Check if admin is in "Services To Expire Today"
            const todayFormatted = this.formatDateDDMMYYYY(today);
            let validityDate = '';
            if (alfaData.validityDate) {
                validityDate = alfaData.validityDate;
            } else {
                // Fallback: calculate from createdAt + 30 days
                let createdAt = new Date();
                if (data.createdAt) {
                    createdAt = data.createdAt.toDate ? data.createdAt.toDate() : (data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt));
                }
                validityDate = this.formatDateDDMMYYYY(new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000));
            }
            
            // Check if validity date matches today
            if (validityDate === todayFormatted) {
                excludedIds.add(doc.id);
            }
        });

        // Helper function to parse DD/MM/YYYY date
        const parseDDMMYYYY = (dateStr) => {
            if (!dateStr || dateStr === 'N/A') return null;
            const parts = String(dateStr).trim().split('/');
            if (parts.length !== 3) return null;
            const day = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
            const year = parseInt(parts[2], 10);
            if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
            return new Date(year, month, day);
        };

        // Helper function to calculate days until validity date
        const daysUntilValidity = (validityDateStr) => {
            const validityDate = parseDDMMYYYY(validityDateStr);
            if (!validityDate) return null;
            validityDate.setHours(0, 0, 0, 0);
            const diffTime = validityDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            return diffDays;
        };

        // Now filter for Available Services, excluding those in other cards
        snapshot.docs.forEach(doc => {
            // Skip if this admin is in Finished Services or Services To Expire Today
            if (excludedIds.has(doc.id)) {
                return;
            }
            
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }

            // TERM 1: Admin must have less than 3 subscribers
            // Count active subscribers (secondarySubscribers)
            const activeSubscribers = alfaData.secondarySubscribers || [];
            const activeSubscribersCount = Array.isArray(activeSubscribers) ? activeSubscribers.length : 0;
            
            // TERM 2: Count "Out" subscribers (removedActiveSubscribers) - these are counted in Alfa website logic
            const removedActiveSubscribers = data.removedActiveSubscribers || [];
            const removedSubscribersCount = Array.isArray(removedActiveSubscribers) ? removedActiveSubscribers.length : 0;
            
            // NEW EXCLUSION LOGIC: Count subscribers by status (Active, Requested, Out)
            let activeCount = 0;
            let requestedCount = 0;
            let outCount = removedSubscribersCount; // Out subscribers come from removedActiveSubscribers
            
            // Count Active and Requested from secondarySubscribers
            if (Array.isArray(activeSubscribers)) {
                activeSubscribers.forEach(sub => {
                    const status = sub.status || 'Active'; // Default to Active if status is missing
                    if (status === 'Requested') {
                        requestedCount++;
                    } else {
                        activeCount++; // Count as Active if status is 'Active' or missing/undefined
                    }
                });
            }
            
            // Check if admin matches any of the exclusion conditions
            // 1. One active and two requested
            if (activeCount === 1 && requestedCount === 2 && outCount === 0) {
                return; // Skip this admin
            }
            // 2. Three requested
            if (activeCount === 0 && requestedCount === 3 && outCount === 0) {
                return; // Skip this admin
            }
            // 3. Three active
            if (activeCount === 3 && requestedCount === 0 && outCount === 0) {
                return; // Skip this admin
            }
            // 4. Two active and one requested
            if (activeCount === 2 && requestedCount === 1 && outCount === 0) {
                return; // Skip this admin
            }
            // 5. One active and two out
            if (activeCount === 1 && requestedCount === 0 && outCount === 2) {
                return; // Skip this admin
            }
            // 6. Two active and one out
            if (activeCount === 2 && requestedCount === 0 && outCount === 1) {
                return; // Skip this admin
            }
            // 7. One active and one requested and one out
            if (activeCount === 1 && requestedCount === 1 && outCount === 1) {
                return; // Skip this admin
            }
            // 8. Two requested and one out
            if (activeCount === 0 && requestedCount === 2 && outCount === 1) {
                return; // Skip this admin
            }
            // 9. Two out and one requested
            if (activeCount === 0 && requestedCount === 1 && outCount === 2) {
                return; // Skip this admin
            }
            
            // Total subscribers count (active + removed) must be < 3
            // If admin has 2 active + 1 removed = 3 total, they should NOT be displayed
            const totalSubscribersCount = activeSubscribersCount + removedSubscribersCount;
            if (totalSubscribersCount >= 3) {
                return; // Skip this admin
            }

            // TERM 3: Admin must have minimum 20 days before validity date
            let validityDateStr = '';
            if (alfaData.validityDate) {
                validityDateStr = alfaData.validityDate;
            } else {
                // Fallback: calculate from createdAt + 30 days
                let createdAt = new Date();
                if (data.createdAt) {
                    createdAt = data.createdAt.toDate ? data.createdAt.toDate() : (data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt));
                }
                validityDateStr = this.formatDateDDMMYYYY(new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000));
            }

            const daysUntil = daysUntilValidity(validityDateStr);
            if (daysUntil === null || daysUntil < 20) {
                return; // Skip if validity date is invalid or less than 20 days away
            }

            // All terms passed - add to available services
            // Parse total consumption for display
            let totalConsumption = 0;
            let totalLimit = data.quota || 0;
            if (alfaData.totalConsumption) {
                const parsed = this.parseConsumption(alfaData.totalConsumption);
                totalConsumption = parsed.used;
                totalLimit = parsed.total || totalLimit;
            }

            // Calculate free space
            const freeSpace = Math.max(0, totalLimit - totalConsumption);

            availableServices.push({
                id: doc.id,
                name: data.name || 'N/A',
                phone: data.phone || 'N/A',
                usage: totalConsumption,
                usageLimit: totalLimit,
                quota: data.quota || null, // Admin's quota (e.g., 15 GB) - different from totalLimit (total bundle, e.g., 77 GB)
                subscribersCount: activeSubscribersCount, // Show only active subscribers count
                freeSpace: freeSpace,
                validityDate: validityDateStr,
                alfaData: alfaData
            });
        });

        return availableServices;
    }

    filterExpiredNumbers(snapshot) {
        const expiredNumbers = [];

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }

            // Get expiration (number of days)
            let expiration = 0;
            if (alfaData.expiration !== undefined) {
                expiration = typeof alfaData.expiration === 'number' 
                    ? alfaData.expiration 
                    : parseInt(alfaData.expiration) || 0;
            }

            // Filter: only show admins with expiration === 0
            if (expiration === 0) {
                expiredNumbers.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    expiration: expiration,
                    alfaData: alfaData
                });
            }
        });

        return expiredNumbers;
    }

    parseConsumption(consumptionStr) {
        if (!consumptionStr || typeof consumptionStr !== 'string') return { used: 0, total: 0 };
        const match = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
        if (match) {
            return {
                used: parseFloat(match[1]) || 0,
                total: parseFloat(match[2]) || 0
            };
        }
        return { used: 0, total: 0 };
    }

    /**
     * Helper function to determine if an admin is inactive
     * Uses the EXACT same logic as insights.js
     * RULE 1: Admin is active if ServiceNameValue contains "U-share Main"
     * RULE 2 (EXCEPTION): Admin is active if ServiceNameValue is "Mobile Internet" AND ValidityDateValue has a valid date
     * Otherwise, admin is inactive
     * @param {Object} data - Admin document data from Firebase
     * @param {Object} alfaData - Alfa data from admin document
     * @returns {boolean} - True if admin is inactive, false if active
     */
    isAdminInactive(data, alfaData) {
        const hasAlfaData = alfaData && Object.keys(alfaData).length > 0 && !alfaData.error;
        
        // Determine status based on getconsumption API response (EXACT same logic as insights.js)
        // RULE 1: Admin is active if ServiceNameValue contains "U-share Main"
        // RULE 2 (EXCEPTION): Admin is active if ServiceNameValue is "Mobile Internet" AND ValidityDateValue has a valid date
        // Otherwise, admin is inactive
        let status = 'inactive'; // Default to inactive
        
        if (hasAlfaData && alfaData.primaryData) {
            try {
                const apiData = alfaData.primaryData;
                
                // Check ServiceInformationValue array
                if (apiData.ServiceInformationValue && Array.isArray(apiData.ServiceInformationValue)) {
                    for (const service of apiData.ServiceInformationValue) {
                        if (service.ServiceNameValue) {
                            const serviceName = String(service.ServiceNameValue).trim();
                            
                            // RULE 1: Check if ServiceNameValue is "U-share Main" (case-insensitive)
                            if (serviceName.toLowerCase() === 'u-share main') {
                                status = 'active';
                                break;
                            }
                            
                            // RULE 2 (EXCEPTION): Check if ServiceNameValue is "Mobile Internet" AND has valid ValidityDateValue
                            if (serviceName.toLowerCase() === 'mobile internet') {
                                // Check ServiceDetailsInformationValue for ValidityDateValue
                                if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                    for (const details of service.ServiceDetailsInformationValue) {
                                        const validityDate = details.ValidityDateValue;
                                        // Check if ValidityDateValue exists and is not empty/null
                                        if (validityDate && String(validityDate).trim() !== '' && String(validityDate).trim() !== 'null') {
                                            // Check if it looks like a valid date (e.g., "22/11/2025")
                                            const datePattern = /^\d{2}\/\d{2}\/\d{4}$/;
                                            if (datePattern.test(String(validityDate).trim())) {
                                                status = 'active';
                                                break;
                                            }
                                        }
                                    }
                                    if (status === 'active') break;
                                }
                            }
                        }
                    }
                }
            } catch (statusError) {
                // If error, keep as inactive
            }
        }
        
        // Fallback: Also check apiResponses if primaryData not available
        if (status === 'inactive' && hasAlfaData && alfaData.apiResponses && Array.isArray(alfaData.apiResponses)) {
            const getConsumptionResponse = alfaData.apiResponses.find(resp => 
                resp.url && resp.url.includes('getconsumption')
            );
            if (getConsumptionResponse && getConsumptionResponse.data) {
                try {
                    const responseData = getConsumptionResponse.data;
                    if (responseData.ServiceInformationValue && Array.isArray(responseData.ServiceInformationValue)) {
                        for (const service of responseData.ServiceInformationValue) {
                            if (service.ServiceNameValue) {
                                const serviceName = String(service.ServiceNameValue).trim();
                                
                                // RULE 1: Check for "U-share Main"
                                if (serviceName.toLowerCase() === 'u-share main') {
                                    status = 'active';
                                    break;
                                }
                                
                                // RULE 2 (EXCEPTION): Check for "Mobile Internet" with valid ValidityDateValue
                                if (serviceName.toLowerCase() === 'mobile internet') {
                                    if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                        for (const details of service.ServiceDetailsInformationValue) {
                                            const validityDate = details.ValidityDateValue;
                                            if (validityDate && String(validityDate).trim() !== '' && String(validityDate).trim() !== 'null') {
                                                const datePattern = /^\d{2}\/\d{2}\/\d{4}$/;
                                                if (datePattern.test(String(validityDate).trim())) {
                                                    status = 'active';
                                                    break;
                                                }
                                            }
                                        }
                                        if (status === 'active') break;
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors
                }
            }
        }
        
        return status === 'inactive';
    }

    showLoadingModal() {
        // Remove existing modal if any
        const existingModal = document.getElementById('availableServicesModal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.id = 'availableServicesModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Available Services</h2>
                    </div>
                    <div class="available-services-modal-body">
                        <div style="display: flex; justify-content: center; align-items: center; padding: 3rem;">
                            <div style="display: inline-block; width: 40px; height: 40px; border: 4px solid rgba(58, 10, 78, 0.2); border-top-color: #3a0a4e; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Add spin animation if not already defined
        if (!document.getElementById('spinAnimation')) {
            const style = document.createElement('style');
            style.id = 'spinAnimation';
            style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
            document.head.appendChild(style);
        }
    }

    hideLoadingModal() {
        const modal = document.getElementById('availableServicesModal');
        if (modal) {
            modal.remove();
        }
    }

    // Helper function to build table rows with limit and "see more" functionality
    buildTableRowsWithLimit(services, buildRowCallback, limit = 4) {
        if (services.length === 0) {
            return { rows: '', hasMore: false };
        }

        const rowsToShow = services.slice(0, limit);
        const hasMore = services.length > limit;

        let rows = '';
        rowsToShow.forEach((service, index) => {
            rows += buildRowCallback(service, index);
        });

        if (hasMore) {
            services.slice(limit).forEach((service, index) => {
                rows += buildRowCallback(service, index + limit, true); // true = hidden
            });
        }

        return { rows, hasMore };
    }

    showAvailableServicesModal(services) {
        // Remove existing modal if any
        const existingModal = document.getElementById('availableServicesModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows with limit
        let tableRows = '';
        let hasMore = false;
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No available services found (all services have more than 5% usage)
                    </td>
                </tr>
            `;
        } else {
            const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                const usagePercent = service.usageLimit > 0 ? (service.usage / service.usageLimit) * 100 : 0;
                const progressClass = usagePercent >= 90 ? 'progress-fill error' : 'progress-fill';
                const hiddenClass = isHidden ? 'table-row-hidden' : '';
                
                return `
                    <tr class="${hiddenClass}">
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="${progressClass}" style="width: ${usagePercent}%"></div>
                                </div>
                                <div class="progress-text">${service.usage.toFixed(2)} / ${service.usageLimit} GB</div>
                            </div>
                        </td>
                        <td>${service.subscribersCount}</td>
                        <td>${service.freeSpace.toFixed(2)} GB</td>
                        <td>${this.escapeHtml(service.validityDate)}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }, 4);
            tableRows = result.rows;
            hasMore = result.hasMore;
        }

        const modal = document.createElement('div');
        modal.id = 'availableServicesModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Available Services</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Usage</th>
                                        <th>Subscribers</th>
                                        <th>Free Space</th>
                                        <th>Expiration Date</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                        ${hasMore ? '<button class="see-more-btn">See More</button>' : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, services);
            });
        });

        // Bind menu buttons
        modal.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });

        // Bind see more button
        const seeMoreBtn = modal.querySelector('.see-more-btn');
        if (seeMoreBtn) {
            seeMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tbody = modal.querySelector('tbody');
                const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                seeMoreBtn.remove();
            });
        }

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    viewSubscriberDetails(id, services) {
        const service = services.find(s => s.id === id);
        if (!service) {
            console.error('Service not found:', id);
            return;
        }

        // Get the full admin object from this.admins to ensure we have all fields (including quota)
        const fullAdmin = this.admins.find(a => a.id === id);
        if (!fullAdmin) {
            console.error('Full admin not found:', id);
            return;
        }

        // Reuse the view details functionality from insights.js
        // We need to create a subscriber-like object for compatibility
        const subscriber = {
            id: fullAdmin.id,
            name: fullAdmin.name || service.name,
            phone: fullAdmin.phone || service.phone,
            alfaData: fullAdmin.alfaData || service.alfaData,
            quota: fullAdmin.quota || null, // Admin's quota (e.g., 15 GB) - NOT usageLimit (total bundle)
            removedActiveSubscribers: fullAdmin.removedActiveSubscribers || [] // Include removed Active subscribers (out subscribers)
        };

        // Import and use insights manager's view details method
        // For now, we'll create a simplified version
        this.showViewDetailsModal(subscriber);
    }

    showViewDetailsModal(subscriber) {
        // Remove existing modal if any
        const existingModal = document.getElementById('viewDetailsModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Extract view details data (similar to insights.js)
        const viewData = this.extractViewDetailsData(subscriber);

        // Create modal
        const modal = document.createElement('div');
        modal.id = 'viewDetailsModal';
        modal.className = 'view-details-modal-overlay';
        modal.innerHTML = `
            <div class="view-details-modal">
                <div class="view-details-modal-inner">
                    <div class="view-details-modal-header">
                        <h2>View Details - ${this.escapeHtml(subscriber.name)}</h2>
                        <button class="modal-close-btn" onclick="this.closest('.view-details-modal-overlay').remove()" aria-label="Close">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="view-details-modal-body">
                        <div class="table-wrapper">
                            <table class="view-details-table">
                                <thead>
                                    <tr>
                                        <th>User Number</th>
                                        <th>Consumption</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${this.buildViewDetailsRows(viewData)}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Close button event listener
        const closeBtn = modal.querySelector('.modal-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                modal.remove();
            });
        }

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
        
        // Close on Escape key
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);
    }

    extractViewDetailsData(subscriber) {
        const data = {
            adminPhone: subscriber.phone,
            adminConsumption: 0,
            adminLimit: 0,
            subscribers: [],
            removedActiveSubscribers: subscriber.removedActiveSubscribers || [], // Include removed Active subscribers (out subscribers)
            totalConsumption: 0,
            totalLimit: 0
        };

        if (!subscriber.alfaData) {
            return data;
        }

        const alfaData = subscriber.alfaData;
        
        // Get total limit FIRST (needed for validation of admin consumption string)
        if (alfaData.totalConsumption) {
            const parsed = this.parseConsumption(alfaData.totalConsumption);
            data.totalConsumption = parsed.used;
            data.totalLimit = parsed.total || 0;
        }
        
        // Get admin limit from quota (this is the admin's quota, e.g., 15 GB, NOT the total bundle limit)
        // Admin limit should always be the quota set when creating the admin
        if (subscriber.quota) {
            const quotaStr = String(subscriber.quota).trim();
            const quotaMatch = quotaStr.match(/^([\d.]+)/);
            data.adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
        }

        // Extract admin consumption - handle multiple formats
        let adminConsumption = 0;
        
        // Priority 1: Check if adminConsumption exists and parse it
        if (alfaData.hasOwnProperty('adminConsumption')) {
            try {
                if (alfaData.adminConsumption === null || alfaData.adminConsumption === undefined || alfaData.adminConsumption === '') {
                    // Empty/null - will use fallback
                } else if (typeof alfaData.adminConsumption === 'number') {
                    adminConsumption = alfaData.adminConsumption;
                } else if (typeof alfaData.adminConsumption === 'string') {
                    const adminConsumptionStr = alfaData.adminConsumption.trim();
                    
                    // Handle "X / Y GB" format
                    const matchWithLimit = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                    // Handle "X GB" format (without limit)
                    const matchWithoutLimit = adminConsumptionStr.match(/^([\d.]+)\s*(GB|MB)/i);
                    
                    if (matchWithLimit) {
                        const extractedConsumption = parseFloat(matchWithLimit[1]) || 0;
                        const extractedLimit = parseFloat(matchWithLimit[2]) || 0;
                        
                        // IMPORTANT: Check if the limit matches totalLimit (not adminLimit)
                        // If it matches totalLimit, this is actually total consumption, not admin consumption
                        // Admin consumption should have a limit that matches admin quota, not total bundle size
                        const adminQuota = data.adminLimit || 0;
                        const totalBundleLimit = data.totalLimit || 0;
                        // If extracted limit is closer to totalLimit than adminQuota, it's likely total consumption
                        const isLikelyTotalConsumption = adminQuota > 0 && extractedLimit > adminQuota && 
                                                         (totalBundleLimit === 0 || Math.abs(extractedLimit - totalBundleLimit) < Math.abs(extractedLimit - adminQuota));
                        
                        if (isLikelyTotalConsumption) {
                            // This looks like total consumption (e.g., "71.21 / 77 GB" where 77 is totalLimit, not adminLimit)
                            // Don't use it as admin consumption - keep it as 0, will use fallback extraction
                            console.log(`⚠️ Ignoring adminConsumption string "${adminConsumptionStr}" - limit (${extractedLimit}) matches totalLimit, not adminLimit (${adminQuota}). This is likely total consumption, not admin consumption.`);
                            adminConsumption = 0; // Will be extracted from U-Share Main if available
                        } else {
                            // This looks like valid admin consumption (e.g., "17.11 / 15 GB" where 15 is admin quota)
                            // Convert MB to GB if needed
                            if (matchWithLimit[3] && matchWithLimit[3].toUpperCase() === 'MB' && extractedConsumption > 0) {
                                adminConsumption = extractedConsumption / 1024;
                            } else {
                                adminConsumption = extractedConsumption;
                            }
                            // Use extracted limit only if we don't have quota (as fallback)
                            if (data.adminLimit === 0) {
                                data.adminLimit = extractedLimit;
                            }
                        }
                    } else if (matchWithoutLimit) {
                        adminConsumption = parseFloat(matchWithoutLimit[1]) || 0;
                        // Convert MB to GB if needed
                        if (matchWithoutLimit[2] && matchWithoutLimit[2].toUpperCase() === 'MB' && adminConsumption > 0) {
                            adminConsumption = adminConsumption / 1024;
                        }
                    } else {
                        // Try to extract just the number
                        const numMatch = adminConsumptionStr.match(/^([\d.]+)/);
                        if (numMatch) {
                            adminConsumption = parseFloat(numMatch[1]) || 0;
                        }
                    }
                }
            } catch (parseError) {
                console.warn('⚠️ Error parsing adminConsumption:', parseError);
            }
        }
        
        // Fallback 1: Extract from consumptions array (U-Share Main circle)
        if (adminConsumption === 0 && alfaData.consumptions && Array.isArray(alfaData.consumptions) && alfaData.consumptions.length > 0) {
            const uShareMain = alfaData.consumptions.find(c => 
                c.planName && c.planName.toLowerCase().includes('u-share main')
            ) || alfaData.consumptions[0]; // Fallback to first circle
            
            if (uShareMain) {
                if (uShareMain.used) {
                    const usedStr = String(uShareMain.used).trim();
                    const usedMatch = usedStr.match(/^([\d.]+)/);
                    adminConsumption = usedMatch ? parseFloat(usedMatch[1]) : parseFloat(usedStr) || 0;
                } else if (uShareMain.usage) {
                    const usageStr = String(uShareMain.usage).trim();
                    const usageMatch = usageStr.match(/^([\d.]+)/);
                    adminConsumption = usageMatch ? parseFloat(usageMatch[1]) : 0;
                }
            }
        }
        
        // Fallback 2: Extract from primaryData (raw API response) - U-Share Main service
        if (adminConsumption === 0 && alfaData.primaryData) {
            try {
                const primaryData = alfaData.primaryData;
                
                if (primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue)) {
                    for (const service of primaryData.ServiceInformationValue) {
                        const serviceName = (service.ServiceNameValue || '').toLowerCase();
                        
                        // Skip Mobile Internet - that's total consumption, not admin consumption
                        if (serviceName.includes('mobile internet')) {
                            continue;
                        }
                        
                        // Look for U-Share Main service
                        if (serviceName.includes('u-share') && serviceName.includes('main')) {
                            if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                for (const details of service.ServiceDetailsInformationValue) {
                                    // Look for U-Share Main circle in SecondaryValue
                                    if (details.SecondaryValue && Array.isArray(details.SecondaryValue)) {
                                        const uShareMain = details.SecondaryValue.find(secondary => {
                                            const bundleName = (secondary.BundleNameValue || '').toLowerCase();
                                            return bundleName.includes('u-share main') || bundleName.includes('main');
                                        });
                                        
                                        if (uShareMain && uShareMain.ConsumptionValue) {
                                            let consumption = parseFloat(uShareMain.ConsumptionValue) || 0;
                                            const consumptionUnit = uShareMain.ConsumptionUnitValue || '';
                                            if (consumptionUnit === 'MB' && consumption > 0) {
                                                consumption = consumption / 1024;
                                            }
                                            adminConsumption = consumption;
                                            break;
                                        }
                                    }
                                    
                                    // Fallback: Use ConsumptionValue from U-Share Main service details
                                    if (adminConsumption === 0 && details.ConsumptionValue) {
                                        let consumption = parseFloat(details.ConsumptionValue) || 0;
                                        const consumptionUnit = details.ConsumptionUnitValue || '';
                                        if (consumptionUnit === 'MB' && consumption > 0) {
                                            consumption = consumption / 1024;
                                        }
                                        adminConsumption = consumption;
                                        break;
                                    }
                                }
                                if (adminConsumption > 0) break;
                            }
                        }
                    }
                }
            } catch (extractError) {
                console.warn('⚠️ Error extracting admin consumption from primaryData:', extractError);
            }
        }
        
        data.adminConsumption = adminConsumption;
        
        // Total consumption and totalLimit were already extracted above (needed for validation)

        // Get subscribers from secondarySubscribers
        if (subscriber.alfaData.secondarySubscribers && Array.isArray(subscriber.alfaData.secondarySubscribers)) {
            subscriber.alfaData.secondarySubscribers.forEach(secondary => {
                if (secondary && secondary.phoneNumber) {
                    let used = 0;
                    let total = 0;
                    
                    // Check if data is from ushare HTML (has consumption and quota as numbers in GB)
                    if (typeof secondary.consumption === 'number' && typeof secondary.quota === 'number') {
                        // Data from ushare HTML - already in GB
                        used = secondary.consumption;
                        total = secondary.quota;
                    } else if (secondary.consumptionText) {
                        // Parse from consumptionText (format: "0.48 / 30 GB")
                        const consumptionMatch = secondary.consumptionText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                        if (consumptionMatch) {
                            used = parseFloat(consumptionMatch[1]) || 0;
                            total = parseFloat(consumptionMatch[2]) || 0;
                        }
                    } else {
                        // Fallback: parse from consumption string (format: "1.18 / 30 GB" or "1.18/30 GB")
                        const consumptionStr = secondary.consumption || '';
                        if (consumptionStr) {
                            const consumptionMatch = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                            if (consumptionMatch) {
                                used = parseFloat(consumptionMatch[1]) || 0;
                                total = parseFloat(consumptionMatch[2]) || 0;
                            }
                        }
                        
                        // Fallback: use raw values if consumption string parsing failed
                        if ((used === 0 && total === 0) && secondary.rawConsumption && secondary.quota) {
                            used = parseFloat(secondary.rawConsumption) || 0;
                            total = parseFloat(secondary.quota) || 0;
                            
                            // Convert MB to GB if needed
                            if (secondary.rawConsumptionUnit === 'MB' && secondary.quotaUnit === 'GB') {
                                used = used / 1024;
                            }
                        }
                    }
                    
                    data.subscribers.push({
                        phoneNumber: secondary.phoneNumber,
                        consumption: used,
                        limit: total
                    });
                }
            });
        }

        return data;
    }

    buildViewDetailsRows(viewData) {
        let rows = '';

        // Admin row
        const adminPercent = viewData.adminLimit > 0 ? (viewData.adminConsumption / viewData.adminLimit) * 100 : 0;
        const adminProgressClass = adminPercent >= 100 ? 'progress-fill error' : 'progress-fill';
        rows += `
            <tr>
                <td><strong>${this.escapeHtml(viewData.adminPhone)}</strong> (Admin)</td>
                <td>
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="${adminProgressClass}" style="width: ${adminPercent}%"></div>
                        </div>
                        <div class="progress-text">${viewData.adminConsumption.toFixed(2)} / ${viewData.adminLimit} GB</div>
                    </div>
                </td>
            </tr>
        `;

        // Subscriber rows
        viewData.subscribers.forEach(sub => {
            const subPercent = sub.limit > 0 ? (sub.consumption / sub.limit) * 100 : 0;
            const subProgressClass = subPercent >= 100 ? 'progress-fill error' : 'progress-fill';
            rows += `
                <tr>
                    <td>${this.escapeHtml(sub.phoneNumber)}</td>
                    <td>
                        <div class="progress-container">
                            <div class="progress-bar">
                                <div class="${subProgressClass}" style="width: ${subPercent}%"></div>
                            </div>
                            <div class="progress-text">${sub.consumption.toFixed(2)} / ${sub.limit} GB</div>
                        </div>
                    </td>
                </tr>
            `;
        });

        // Removed Active subscribers (no longer in ushare HTML but should still be displayed as "Out")
        // These are Active subscribers that were removed - they should appear with red color and "Out" label
        const removedActiveSubscribers = viewData.removedActiveSubscribers || [];
        if (removedActiveSubscribers.length > 0) {
            removedActiveSubscribers.forEach(removedSub => {
                // Check if this removed subscriber is already in viewData.subscribers (shouldn't happen, but check anyway)
                const isAlreadyShown = viewData.subscribers.some(sub => {
                    const subPhone = String(sub.phoneNumber || '').trim();
                    const removedPhone = String(removedSub.phoneNumber || '').trim();
                    return subPhone === removedPhone;
                });
                
                // Only show if not already displayed in subscribers list
                if (!isAlreadyShown) {
                    // Calculate progress for removed subscriber using last stored consumption from Firebase
                    // Handle both field name formats: consumption/limit or usedConsumption/totalQuota (for backward compatibility)
                    const removedConsumption = removedSub.consumption !== undefined ? removedSub.consumption : 
                                              (removedSub.usedConsumption !== undefined ? removedSub.usedConsumption : 0);
                    const removedLimit = removedSub.limit !== undefined ? removedSub.limit :
                                        (removedSub.quota !== undefined ? removedSub.quota :
                                        (removedSub.totalQuota !== undefined ? removedSub.totalQuota : 0));
                    const removedPercent = removedLimit > 0 ? (removedConsumption / removedLimit) * 100 : 0;
                    const removedProgressClass = removedPercent >= 100 ? 'progress-fill error' : 'progress-fill';
                    
                    // Show removed Active subscriber as "Out" in red with hashed styling and progress bar
                    rows += `
                        <tr style="opacity: 0.5; text-decoration: line-through;">
                            <td>
                                <span style="color: #ef4444;">${this.escapeHtml(removedSub.phoneNumber)}</span>
                                <span style="color: #ef4444; font-weight: bold;">Out</span>
                            </td>
                            <td>
                                <div class="progress-container" style="opacity: 0.5;">
                                    <div class="progress-bar">
                                        <div class="${removedProgressClass}" style="width: ${Math.min(100, removedPercent)}%"></div>
                                    </div>
                                    <div class="progress-text" style="color: #64748b;">${removedConsumption.toFixed(2)} / ${removedLimit} GB</div>
                                </div>
                            </td>
                        </tr>
                    `;
                }
            });
        }

        // Total row
        const totalPercent = viewData.totalLimit > 0 ? (viewData.totalConsumption / viewData.totalLimit) * 100 : 0;
        const totalProgressClass = totalPercent >= 100 ? 'progress-fill error' : 'progress-fill';
        rows += `
            <tr class="total-row">
                <td><strong>Total</strong></td>
                <td>
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="${totalProgressClass}" style="width: ${totalPercent}%"></div>
                        </div>
                        <div class="progress-text">${viewData.totalConsumption.toFixed(2)} / ${viewData.totalLimit} GB</div>
                    </div>
                </td>
            </tr>
        `;

        return rows;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Services Expired Yesterday Modal
    async openServicesExpiredYesterdayModal() {
        try {
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                // CRITICAL: Filter by userId for data isolation
                const currentUserId = this.getCurrentUserId();
                if (!currentUserId) {
                    throw new Error('User not authenticated. Please log in.');
                }
                const firebaseSnapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
                snapshot = firebaseSnapshot;
            }
            
            // Process and filter admins
            const expiredYesterday = this.filterServicesExpiredYesterday(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showServicesExpiredYesterdayModal(expiredYesterday);
        } catch (error) {
            console.error('Error opening Services Expired Yesterday modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    // Services To Expire Today Modal
    async openServicesToExpireTodayModal() {
        try {
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                // CRITICAL: Filter by userId for data isolation
                const currentUserId = this.getCurrentUserId();
                if (!currentUserId) {
                    throw new Error('User not authenticated. Please log in.');
                }
                const firebaseSnapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
                snapshot = firebaseSnapshot;
            }
            
            // Process and filter admins
            const expiringToday = this.filterServicesToExpireToday(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showServicesToExpireTodayModal(expiringToday);
        } catch (error) {
            console.error('Error opening Services To Expire Today modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    // Services To Expire Tomorrow Modal
    async openServicesToExpireTomorrowModal() {
        try {
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                // CRITICAL: Filter by userId for data isolation
                const currentUserId = this.getCurrentUserId();
                if (!currentUserId) {
                    throw new Error('User not authenticated. Please log in.');
                }
                const firebaseSnapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
                snapshot = firebaseSnapshot;
            }
            
            // Process and filter admins
            const expiringTomorrow = this.filterServicesToExpireTomorrow(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showServicesToExpireTomorrowModal(expiringTomorrow);
        } catch (error) {
            console.error('Error opening Services To Expire Tomorrow modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterServicesExpiredYesterday(snapshot) {
        const expiredYesterday = [];
        
        // Get yesterday's date in DD/MM/YYYY format
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayFormatted = this.formatDateDDMMYYYY(yesterday);
        
        // Get today's date in DD/MM/YYYY format
        const today = new Date();
        const todayFormatted = this.formatDateDDMMYYYY(today);

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }
            
            // Get admin validity date
            let validityDate = '';
            if (alfaData.validityDate) {
                validityDate = alfaData.validityDate;
            } else {
                // Fallback: calculate from createdAt + 30 days
                let createdAt = new Date();
                if (data.createdAt) {
                    createdAt = data.createdAt.toDate ? data.createdAt.toDate() : (data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt));
                }
                validityDate = this.formatDateDDMMYYYY(new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000));
            }
            
            // Get tracking field for when admin was shown in this table
            const expiredYesterdayShownDate = data._expiredYesterdayShownDate || null;
            
            // Include if:
            // 1. Admin validity date matches yesterday (first time appearing), OR
            // 2. Admin was already shown today (persist for the whole day even if validity date changed)
            const shouldInclude = validityDate === yesterdayFormatted || expiredYesterdayShownDate === todayFormatted;
            
            if (shouldInclude) {
                // Parse balance
                let balance = 0;
                if (alfaData.balance) {
                    const balanceStr = String(alfaData.balance).trim();
                    const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                    balance = match ? parseFloat(match[0]) : 0;
                }

                // Get bundle size (total limit from total consumption)
                let bundleSize = 0;
                if (alfaData.totalConsumption) {
                    const parsed = this.parseConsumption(alfaData.totalConsumption);
                    bundleSize = parsed.total || 0;
                } else if (data.quota) {
                    const quotaStr = String(data.quota).trim();
                    const quotaMatch = quotaStr.match(/^([\d.]+)/);
                    bundleSize = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
                }

                // Get subscribers count
                let subscribersCount = 0;
                if (alfaData.secondarySubscribers && Array.isArray(alfaData.secondarySubscribers)) {
                    subscribersCount = alfaData.secondarySubscribers.length;
                } else if (alfaData.subscribersCount !== undefined) {
                    subscribersCount = typeof alfaData.subscribersCount === 'number' 
                        ? alfaData.subscribersCount 
                        : parseInt(alfaData.subscribersCount) || 0;
                }

                // Get expiration (days)
                let expiration = 0;
                if (alfaData.expiration !== undefined) {
                    expiration = typeof alfaData.expiration === 'number' 
                        ? alfaData.expiration 
                        : parseInt(alfaData.expiration) || 0;
                }

                // Calculate needed balance status
                const neededBalanceStatus = this.calculateNeededBalanceStatus(bundleSize, balance);

                expiredYesterday.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    balance: balance,
                    bundleSize: bundleSize,
                    subscribersCount: subscribersCount,
                    neededBalanceStatus: neededBalanceStatus,
                    expiration: expiration,
                    validityDate: validityDate,
                    alfaData: alfaData
                });
            }
        });

        return expiredYesterday;
    }

    filterServicesToExpireToday(snapshot) {
        const expiringToday = [];
        
        // Get today's date in DD/MM/YYYY format
        const today = new Date();
        const todayFormatted = this.formatDateDDMMYYYY(today);

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }
            
            // Get validity date
            let validityDate = '';
            if (alfaData.validityDate) {
                validityDate = alfaData.validityDate;
            } else {
                // Fallback: calculate from createdAt + 30 days
                let createdAt = new Date();
                if (data.createdAt) {
                    createdAt = data.createdAt.toDate ? data.createdAt.toDate() : (data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt));
                }
                validityDate = this.formatDateDDMMYYYY(new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000));
            }

            // Check if validity date matches today
            // This shows services that expire TODAY
            if (validityDate === todayFormatted) {
                // Parse balance
                let balance = 0;
                if (alfaData.balance) {
                    const balanceStr = String(alfaData.balance).trim();
                    const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                    balance = match ? parseFloat(match[0]) : 0;
                }

                // Get bundle size (total limit from total consumption)
                let bundleSize = 0;
                if (alfaData.totalConsumption) {
                    const parsed = this.parseConsumption(alfaData.totalConsumption);
                    bundleSize = parsed.total || 0;
                } else if (data.quota) {
                    const quotaStr = String(data.quota).trim();
                    const quotaMatch = quotaStr.match(/^([\d.]+)/);
                    bundleSize = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
                }

                // Get subscribers count
                let subscribersCount = 0;
                if (alfaData.secondarySubscribers && Array.isArray(alfaData.secondarySubscribers)) {
                    subscribersCount = alfaData.secondarySubscribers.length;
                } else if (alfaData.subscribersCount !== undefined) {
                    subscribersCount = typeof alfaData.subscribersCount === 'number' 
                        ? alfaData.subscribersCount 
                        : parseInt(alfaData.subscribersCount) || 0;
                }

                // Get expiration (days)
                let expiration = 0;
                if (alfaData.expiration !== undefined) {
                    expiration = typeof alfaData.expiration === 'number' 
                        ? alfaData.expiration 
                        : parseInt(alfaData.expiration) || 0;
                }

                // Calculate needed balance status
                const neededBalanceStatus = this.calculateNeededBalanceStatus(bundleSize, balance);

                expiringToday.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    balance: balance,
                    bundleSize: bundleSize,
                    subscribersCount: subscribersCount,
                    neededBalanceStatus: neededBalanceStatus,
                    expiration: expiration,
                    validityDate: validityDate,
                    alfaData: alfaData
                });
            }
        });

        return expiringToday;
    }

    filterServicesToExpireTomorrow(snapshot) {
        const expiringTomorrow = [];
        
        // Get tomorrow's date in DD/MM/YYYY format
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowFormatted = this.formatDateDDMMYYYY(tomorrow);

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }
            
            // Get validity date
            let validityDate = '';
            if (alfaData.validityDate) {
                validityDate = alfaData.validityDate;
            } else {
                // Fallback: calculate from createdAt + 30 days
                let createdAt = new Date();
                if (data.createdAt) {
                    createdAt = data.createdAt.toDate ? data.createdAt.toDate() : (data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt));
                }
                validityDate = this.formatDateDDMMYYYY(new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000));
            }

            // Check if validity date matches tomorrow
            if (validityDate === tomorrowFormatted) {
                // Parse balance
                let balance = 0;
                if (alfaData.balance) {
                    const balanceStr = String(alfaData.balance).trim();
                    const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                    balance = match ? parseFloat(match[0]) : 0;
                }

                // Get bundle size (total limit from total consumption)
                let bundleSize = 0;
                if (alfaData.totalConsumption) {
                    const parsed = this.parseConsumption(alfaData.totalConsumption);
                    bundleSize = parsed.total || 0;
                } else if (data.quota) {
                    const quotaStr = String(data.quota).trim();
                    const quotaMatch = quotaStr.match(/^([\d.]+)/);
                    bundleSize = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
                }

                // Get subscribers count
                let subscribersCount = 0;
                if (alfaData.secondarySubscribers && Array.isArray(alfaData.secondarySubscribers)) {
                    subscribersCount = alfaData.secondarySubscribers.length;
                } else if (alfaData.subscribersCount !== undefined) {
                    subscribersCount = typeof alfaData.subscribersCount === 'number' 
                        ? alfaData.subscribersCount 
                        : parseInt(alfaData.subscribersCount) || 0;
                }

                // Get expiration (days)
                let expiration = 0;
                if (alfaData.expiration !== undefined) {
                    expiration = typeof alfaData.expiration === 'number' 
                        ? alfaData.expiration 
                        : parseInt(alfaData.expiration) || 0;
                }

                // Calculate needed balance status
                const neededBalanceStatus = this.calculateNeededBalanceStatus(bundleSize, balance);

                expiringTomorrow.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    balance: balance,
                    bundleSize: bundleSize,
                    subscribersCount: subscribersCount,
                    neededBalanceStatus: neededBalanceStatus,
                    expiration: expiration,
                    validityDate: validityDate,
                    alfaData: alfaData
                });
            }
        });

        return expiringTomorrow;
    }

    formatDateDDMMYYYY(date) {
        if (!date) return '';
        const d = new Date(date);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
    }

    calculateNeededBalanceStatus(bundleSize, balance) {
        // Round bundle size to nearest integer for comparison
        const size = Math.round(bundleSize);
        
        if (size === 1) {
            return balance >= 3.50 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 7) {
            return balance >= 9 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 22) {
            return balance >= 14.50 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 44) {
            return balance >= 21 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 77) {
            return balance >= 31 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 111) {
            return balance >= 40 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else if (size === 444) {
            return balance >= 40 ? 'Ready To Renew' : 'Not Ready To Renew';
        } else {
            // Default: if bundle size doesn't match any known size, use 77 GB logic
            return balance >= 31 ? 'Ready To Renew' : 'Not Ready To Renew';
        }
    }

    showServicesExpiredYesterdayModal(services) {
        // Remove existing modal if any
        const existingModal = document.getElementById('servicesExpiredYesterdayModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows with limit
        let tableRows = '';
        let hasMore = false;
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No services expired yesterday found
                    </td>
                </tr>
            `;
        } else {
            const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                const statusClass = service.neededBalanceStatus === 'Ready To Renew' ? 'ready' : 'not-ready';
                const hiddenClass = isHidden ? 'table-row-hidden' : '';
                
                return `
                    <tr class="${hiddenClass}">
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>$${service.balance.toFixed(2)}</td>
                        <td>${service.bundleSize.toFixed(2)} GB</td>
                        <td>${service.subscribersCount}</td>
                        <td>
                            <span class="needed-balance-status ${statusClass}">${this.escapeHtml(service.neededBalanceStatus)}</span>
                        </td>
                        <td>${service.expiration}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }, 4);
            tableRows = result.rows;
            hasMore = result.hasMore;
        }

        const modal = document.createElement('div');
        modal.id = 'servicesExpiredYesterdayModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Services Expired Yesterday</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Balance</th>
                                        <th>Bundle Size</th>
                                        <th>Subscribers</th>
                                        <th>Needed Balance</th>
                                        <th>Expiration</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                        ${hasMore ? '<button class="see-more-btn">See More</button>' : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, services);
            });
        });

        // Bind menu buttons
        modal.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });

        // Bind "See More" button
        const seeMoreBtn = modal.querySelector('.see-more-btn');
        if (seeMoreBtn) {
            seeMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tbody = modal.querySelector('tbody');
                if (tbody) {
                    const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                    hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                    seeMoreBtn.remove();
                }
            });
        }

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    showServicesToExpireTomorrowModal(services) {
        // Remove existing modal if any
        const existingModal = document.getElementById('servicesToExpireTomorrowModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows with limit
        let tableRows = '';
        let hasMore = false;
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No services expiring tomorrow found
                    </td>
                </tr>
            `;
        } else {
            const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                const statusClass = service.neededBalanceStatus === 'Ready To Renew' ? 'ready' : 'not-ready';
                const hiddenClass = isHidden ? 'table-row-hidden' : '';
                
                return `
                    <tr class="${hiddenClass}">
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>$${service.balance.toFixed(2)}</td>
                        <td>${service.bundleSize.toFixed(2)} GB</td>
                        <td>${service.subscribersCount}</td>
                        <td>
                            <span class="needed-balance-status ${statusClass}">${this.escapeHtml(service.neededBalanceStatus)}</span>
                        </td>
                        <td>${service.expiration}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }, 4);
            tableRows = result.rows;
            hasMore = result.hasMore;
        }

        const modal = document.createElement('div');
        modal.id = 'servicesToExpireTomorrowModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Services To Expire Tomorrow</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Balance</th>
                                        <th>Bundle Size</th>
                                        <th>Subscribers</th>
                                        <th>Needed Balance</th>
                                        <th>Expiration</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                        ${hasMore ? '<button class="see-more-btn">See More</button>' : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, services);
            });
        });

        // Bind menu buttons
        modal.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });

        // Bind "See More" button
        const seeMoreBtn = modal.querySelector('.see-more-btn');
        if (seeMoreBtn) {
            seeMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tbody = modal.querySelector('tbody');
                if (tbody) {
                    const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                    hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                    seeMoreBtn.remove();
                }
            });
        }

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    showServicesToExpireTodayModal(services) {
        // Remove existing modal if any
        const existingModal = document.getElementById('servicesToExpireTodayModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows with limit
        let tableRows = '';
        let hasMore = false;
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No services expiring today found
                    </td>
                </tr>
            `;
        } else {
            const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                const statusClass = service.neededBalanceStatus === 'Ready To Renew' ? 'ready' : 'not-ready';
                const hiddenClass = isHidden ? 'table-row-hidden' : '';
                
                return `
                    <tr class="${hiddenClass}">
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>$${service.balance.toFixed(2)}</td>
                        <td>${service.bundleSize} GB</td>
                        <td>${service.subscribersCount}</td>
                        <td>
                            <span class="needed-balance-status ${statusClass}">${this.escapeHtml(service.neededBalanceStatus)}</span>
                        </td>
                        <td>${service.expiration}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }, 4);
            tableRows = result.rows;
            hasMore = result.hasMore;
        }

        const modal = document.createElement('div');
        modal.id = 'servicesToExpireTodayModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Services To Expire Today</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Balance</th>
                                        <th>Bundle Size</th>
                                        <th>Subscribers</th>
                                        <th>Needed Balance</th>
                                        <th>Expiration</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                        ${hasMore ? '<button class="see-more-btn">See More</button>' : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, services);
            });
        });

        // Bind menu buttons
        modal.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });

        // Bind "See More" button
        const seeMoreBtn = modal.querySelector('.see-more-btn');
        if (seeMoreBtn) {
            seeMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tbody = modal.querySelector('tbody');
                if (tbody) {
                    const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                    hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                    seeMoreBtn.remove();
                }
            });
        }

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    showExpiredNumbersModal(numbers) {
        // Remove existing modal if any
        const existingModal = document.getElementById('expiredNumbersModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows with limit
        let tableRows = '';
        let hasMore = false;
        if (numbers.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="3" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No expired numbers found
                    </td>
                </tr>
            `;
        } else {
            const result = this.buildTableRowsWithLimit(numbers, (number, index, isHidden = false) => {
                const hiddenClass = isHidden ? 'table-row-hidden' : '';
                return `
                    <tr class="${hiddenClass}">
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(number.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(number.phone)}</div>
                            </div>
                        </td>
                        <td>${number.expiration}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${number.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${number.id}" title="Menu">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }, 4);
            tableRows = result.rows;
            hasMore = result.hasMore;
        }

        const modal = document.createElement('div');
        modal.id = 'expiredNumbersModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Expired Numbers</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Expiration</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                        ${hasMore ? '<button class="see-more-btn">See More</button>' : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, numbers);
            });
        });

        // Bind menu buttons
        modal.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    // Requested Services Modal
    async openRequestedServicesModal() {
        try {
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                // CRITICAL: Filter by userId for data isolation
                const currentUserId = this.getCurrentUserId();
                if (!currentUserId) {
                    throw new Error('User not authenticated. Please log in.');
                }
                const firebaseSnapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
                snapshot = firebaseSnapshot;
            }
            
            // Process and filter admins
            const requestedServices = this.filterRequestedServices(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showRequestedServicesModal(requestedServices);
        } catch (error) {
            console.error('Error opening Requested Services modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterRequestedServices(snapshot) {
        const requestedServices = [];
        
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Get subscribers counts
            let subscribersCount = 0;
            let subscribersActiveCount = 0;
            let subscribersRequestedCount = 0;
            
            if (alfaData.subscribersCount !== undefined) {
                subscribersCount = typeof alfaData.subscribersCount === 'number' 
                    ? alfaData.subscribersCount 
                    : parseInt(alfaData.subscribersCount) || 0;
            }
            
            if (alfaData.subscribersActiveCount !== undefined) {
                subscribersActiveCount = typeof alfaData.subscribersActiveCount === 'number'
                    ? alfaData.subscribersActiveCount
                    : parseInt(alfaData.subscribersActiveCount) || 0;
            }
            
            if (alfaData.subscribersRequestedCount !== undefined) {
                subscribersRequestedCount = typeof alfaData.subscribersRequestedCount === 'number'
                    ? alfaData.subscribersRequestedCount
                    : parseInt(alfaData.subscribersRequestedCount) || 0;
            }
            
            // Only include admins with requested subscribers (requestedCount > 0)
            if (subscribersRequestedCount > 0) {
                requestedServices.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    subscribersCount: subscribersCount,
                    subscribersActiveCount: subscribersActiveCount,
                    subscribersRequestedCount: subscribersRequestedCount,
                    alfaData: alfaData
                });
            }
        });
        
        return requestedServices;
    }

    formatSubscribersCount(activeCount, requestedCount) {
        // Format like insights table: "1 (1)" for active (requested)
        if (activeCount === undefined && requestedCount === undefined) return '';
        
        const active = activeCount || 0;
        const requested = requestedCount || 0;
        
        if (requested > 0) {
            return `${active} (${requested})`;
        }
        return active.toString();
    }

    showRequestedServicesModal(services) {
        // Remove existing modal if any
        const existingModal = document.getElementById('requestedServicesModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows with limit
        let tableRows = '';
        let hasMore = false;
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="3" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No admins with requested subscribers found
                    </td>
                </tr>
            `;
        } else {
            const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                const subscribersDisplay = this.formatSubscribersCount(
                    service.subscribersActiveCount !== undefined ? service.subscribersActiveCount : service.subscribersCount,
                    service.subscribersRequestedCount
                );
                const hiddenClass = isHidden ? 'table-row-hidden' : '';
                
                return `
                    <tr class="${hiddenClass}">
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>${subscribersDisplay}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <img src="/assets/eye.png" alt="View Details" style="width: 20px; height: 20px; object-fit: contain;" />
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }, 4);
            tableRows = result.rows;
            hasMore = result.hasMore;
        }

        const modal = document.createElement('div');
        modal.id = 'requestedServicesModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Requested Services</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Subscribers</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                        ${hasMore ? '<button class="see-more-btn">See More</button>' : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons - show view details modal
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                const service = services.find(s => s.id === id);
                if (service) {
                    this.viewSubscriberDetails(id, services);
                }
            });
        });

        // Bind menu buttons
        modal.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });

        // Bind "See More" button
        const seeMoreBtn = modal.querySelector('.see-more-btn');
        if (seeMoreBtn) {
            seeMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tbody = modal.querySelector('tbody');
                if (tbody) {
                    const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                    hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                    seeMoreBtn.remove();
                }
            });
        }

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    // Finished Services Modal
    async openFinishedServicesModal() {
        try {
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                // CRITICAL: Filter by userId for data isolation
                const currentUserId = this.getCurrentUserId();
                if (!currentUserId) {
                    throw new Error('User not authenticated. Please log in.');
                }
                const firebaseSnapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
                snapshot = firebaseSnapshot;
            }
            
            // Process and filter admins
            const finishedServices = this.filterFinishedServices(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showFinishedServicesModal(finishedServices);
        } catch (error) {
            console.error('Error opening Finished Services modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterFinishedServices(snapshot) {
        const finishedServices = [];

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }

            // Parse total consumption
            let totalConsumption = 0;
            let totalLimit = 0;

            if (alfaData.totalConsumption) {
                const parsed = this.parseConsumption(alfaData.totalConsumption);
                totalConsumption = parsed.used;
                totalLimit = parsed.total || 0;
            } else if (data.quota) {
                // Fallback: use quota as limit
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                totalLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }

            // Parse admin consumption
            let adminConsumption = 0;
            let adminLimit = 0;
            
            if (alfaData.adminConsumption) {
                const adminConsumptionStr = String(alfaData.adminConsumption).trim();
                const match = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                if (match) {
                    adminConsumption = parseFloat(match[1]) || 0;
                    adminLimit = parseFloat(match[2]) || 0;
                }
            } else if (data.quota) {
                // Fallback: use quota as admin limit
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }

            // Check if bundle is fully used:
            // 1. If admin consumption >= admin limit (e.g., 77/22) - bundle is fully used
            // 2. If total consumption >= total limit - bundle is fully used
            const isAdminFull = adminLimit > 0 && adminConsumption >= adminLimit - 0.01;
            const isTotalFull = totalLimit > 0 && totalConsumption >= totalLimit - 0.01;
            const isFullyUsed = isAdminFull || isTotalFull;

            if (isFullyUsed) {
                // Parse balance
                let balance = 0;
                if (alfaData.balance) {
                    const balanceStr = String(alfaData.balance).trim();
                    const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                    balance = match ? parseFloat(match[0]) : 0;
                }

                // Get subscribers count
                let subscribersCount = 0;
                if (alfaData.secondarySubscribers && Array.isArray(alfaData.secondarySubscribers)) {
                    subscribersCount = alfaData.secondarySubscribers.length;
                } else if (alfaData.subscribersCount !== undefined) {
                    subscribersCount = typeof alfaData.subscribersCount === 'number' 
                        ? alfaData.subscribersCount 
                        : parseInt(alfaData.subscribersCount) || 0;
                }

                // Get expiration (days)
                let expiration = 0;
                if (alfaData.expiration !== undefined) {
                    expiration = typeof alfaData.expiration === 'number' 
                        ? alfaData.expiration 
                        : parseInt(alfaData.expiration) || 0;
                }

                // When bundle is fully used, use adminConsumption as total if it's full
                let displayTotalConsumption = totalConsumption;
                let displayTotalLimit = totalLimit;
                
                if (isAdminFull && adminConsumption > 0) {
                    // When admin consumption is full (e.g., 77/22), use adminConsumption as total bundle size
                    displayTotalConsumption = adminConsumption;
                    displayTotalLimit = adminConsumption;
                }

                finishedServices.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    totalConsumption: displayTotalConsumption,
                    totalLimit: displayTotalLimit,
                    subscribersCount: subscribersCount,
                    expiration: expiration,
                    balance: balance,
                    usagePercent: 100, // Always 100% when fully used
                    alfaData: alfaData
                });
            }
        });

        return finishedServices;
    }

    // High Admin Consumption Modal
    async openHighAdminConsumptionModal() {
        try {
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                // CRITICAL: Filter by userId for data isolation
                const currentUserId = this.getCurrentUserId();
                if (!currentUserId) {
                    throw new Error('User not authenticated. Please log in.');
                }
                const firebaseSnapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
                snapshot = firebaseSnapshot;
            }
            
            // Process and filter admins
            const highAdminConsumption = this.filterHighAdminConsumption(snapshot);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showHighAdminConsumptionModal(highAdminConsumption);
        } catch (error) {
            console.error('Error opening High Admin Consumption modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterHighAdminConsumption(snapshot) {
        const highAdminConsumption = [];
        
        // First, get all admins that would appear in "Finished Services" to exclude them
        const finishedServicesIds = new Set();
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Parse admin consumption
            let adminConsumption = 0;
            let adminLimit = 0;
            
            if (alfaData.adminConsumption) {
                const adminConsumptionStr = String(alfaData.adminConsumption).trim();
                const match = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                if (match) {
                    adminConsumption = parseFloat(match[1]) || 0;
                    adminLimit = parseFloat(match[2]) || 0;
                }
            } else if (data.quota) {
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Parse total consumption
            let totalConsumption = 0;
            let totalLimit = 0;
            if (alfaData.totalConsumption) {
                const parsed = this.parseConsumption(alfaData.totalConsumption);
                totalConsumption = parsed.used;
                totalLimit = parsed.total || 0;
            } else if (data.quota) {
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                totalLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Check if this admin would be in Finished Services (same logic as filterFinishedServices)
            const isAdminFull = adminLimit > 0 && adminConsumption >= adminLimit - 0.01;
            const isTotalFull = totalLimit > 0 && totalConsumption >= totalLimit - 0.01;
            const isFullyUsed = isAdminFull || isTotalFull;
            
            if (isFullyUsed) {
                finishedServicesIds.add(doc.id);
            }
        });

        // Now filter for High Admin Consumption, excluding those in Finished Services
        snapshot.docs.forEach(doc => {
            // Skip if this admin is in Finished Services
            if (finishedServicesIds.has(doc.id)) {
                return;
            }
            
            const data = doc.data();
            const alfaData = data.alfaData || {};
            
            // Skip if admin is inactive (should only appear in Inactive Numbers card)
            if (this.isAdminInactive(data, alfaData)) {
                return;
            }

            // Parse admin consumption - this is the key metric
            // Get admin limit from quota (this is the admin's quota, e.g., 15 GB, NOT the total bundle limit)
            // Also check if data.adminLimit exists (might be pre-calculated)
            let adminLimit = 0;
            if (data.adminLimit !== undefined && data.adminLimit !== null) {
                adminLimit = parseFloat(data.adminLimit) || 0;
            } else if (data.quota) {
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Get total limit FIRST (needed for validation of admin consumption string)
            let totalLimitForValidation = 0;
            if (alfaData.totalConsumption) {
                const parsed = this.parseConsumption(alfaData.totalConsumption);
                totalLimitForValidation = parsed.total || 0;
            } else if (data.quota) {
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                totalLimitForValidation = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }
            
            // Extract admin consumption - handle multiple formats (similar to processSubscribers in insights.js)
            // First check if adminConsumption is already calculated in the data object (from insights processing)
            let adminConsumption = 0;
            if (data.adminConsumption !== undefined && data.adminConsumption !== null) {
                adminConsumption = parseFloat(data.adminConsumption) || 0;
            }
            
            // Try to get admin consumption from alfaData.adminConsumption first (backend-built string like "17.11 / 15 GB")
            // Check if the property exists (even if it's 0, null, or empty string)
            const hasAlfaData = alfaData && typeof alfaData === 'object';
            if (adminConsumption === 0 && hasAlfaData && alfaData.hasOwnProperty('adminConsumption')) {
                try {
                    if (alfaData.adminConsumption === null || alfaData.adminConsumption === undefined || alfaData.adminConsumption === '') {
                        // Empty/null - will try fallbacks
                    } else if (typeof alfaData.adminConsumption === 'number') {
                        adminConsumption = alfaData.adminConsumption;
                    } else if (typeof alfaData.adminConsumption === 'string') {
                        const adminConsumptionStr = alfaData.adminConsumption.trim();
                        
                        // Handle two formats:
                        // 1. "X / Y GB" format (old format with limit)
                        // 2. "X GB" format (new format without limit - frontend will add limit from quota)
                        const matchWithLimit = adminConsumptionStr.match(/^([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                        const matchWithoutLimit = adminConsumptionStr.match(/^([\d.]+)\s*(GB|MB)/i);
                        
                        if (matchWithLimit) {
                            // Old format: "X / Y GB"
                            const extractedConsumption = parseFloat(matchWithLimit[1]) || 0;
                            const extractedLimit = parseFloat(matchWithLimit[2]) || 0;
                            
                            // IMPORTANT: Check if the limit matches totalLimit (not adminLimit)
                            // If it matches totalLimit, this is actually total consumption, not admin consumption
                            // Admin consumption should have a limit that matches admin quota, not total bundle size
                            const adminQuota = adminLimit || 0;
                            const totalBundleLimit = totalLimitForValidation || 0;
                            // If extracted limit is closer to totalLimit than adminQuota, it's likely total consumption
                            const isLikelyTotalConsumption = adminQuota > 0 && extractedLimit > adminQuota && 
                                                             (totalBundleLimit === 0 || Math.abs(extractedLimit - totalBundleLimit) < Math.abs(extractedLimit - adminQuota));
                            
                            if (isLikelyTotalConsumption) {
                                // This looks like total consumption (e.g., "71.21 / 77 GB" where 77 is totalLimit, not adminLimit)
                                // Don't use it as admin consumption - will try fallback extraction
                                adminConsumption = 0;
                            } else {
                                // This looks like valid admin consumption (e.g., "17.11 / 15 GB" where 15 is admin quota)
                                // Convert MB to GB if needed
                                if (matchWithLimit[3] && matchWithLimit[3].toUpperCase() === 'MB' && extractedConsumption > 0) {
                                    adminConsumption = extractedConsumption / 1024;
                                } else {
                                    adminConsumption = extractedConsumption;
                                }
                            }
                        } else if (matchWithoutLimit) {
                            // New format: "X GB" (without limit)
                            adminConsumption = parseFloat(matchWithoutLimit[1]) || 0;
                            // Convert MB to GB if needed
                            if (matchWithoutLimit[2] && matchWithoutLimit[2].toUpperCase() === 'MB' && adminConsumption > 0) {
                                adminConsumption = adminConsumption / 1024;
                            }
                        } else {
                            // Try to extract just the number
                            const numMatch = adminConsumptionStr.match(/^([\d.]+)/);
                            if (numMatch) {
                                adminConsumption = parseFloat(numMatch[1]) || 0;
                            }
                        }
                    }
                } catch (parseError) {
                    console.warn('⚠️ Error parsing adminConsumption:', parseError);
                }
            }
            
            // Fallback 1: Extract from consumptions array (U-Share Main circle) if adminConsumption is still 0
            if (adminConsumption === 0 && alfaData.consumptions && Array.isArray(alfaData.consumptions) && alfaData.consumptions.length > 0) {
                const uShareMain = alfaData.consumptions.find(c => 
                    c.planName && c.planName.toLowerCase().includes('u-share main')
                ) || alfaData.consumptions[0]; // Fallback to first circle
                
                if (uShareMain) {
                    if (uShareMain.used) {
                        const usedStr = String(uShareMain.used).trim();
                        const usedMatch = usedStr.match(/^([\d.]+)/);
                        adminConsumption = usedMatch ? parseFloat(usedMatch[1]) : parseFloat(usedStr) || 0;
                    } else if (uShareMain.usage) {
                        const usageStr = String(uShareMain.usage).trim();
                        const usageMatch = usageStr.match(/^([\d.]+)/);
                        adminConsumption = usageMatch ? parseFloat(usageMatch[1]) : parseFloat(usageStr) || 0;
                    }
                }
            }
            
            // Fallback 2: Extract from primaryData (raw API response) if still not found (same as insights.js)
            if (adminConsumption === 0 && hasAlfaData && alfaData.primaryData) {
                try {
                    const primaryData = alfaData.primaryData;
                    
                    // Look for U-Share Main service for admin consumption (NOT Mobile Internet!)
                    if (primaryData.ServiceInformationValue && Array.isArray(primaryData.ServiceInformationValue) && primaryData.ServiceInformationValue.length > 0) {
                        // First pass: Look for U-Share Main service
                        for (const service of primaryData.ServiceInformationValue) {
                            const serviceName = (service.ServiceNameValue || '').toLowerCase();
                            
                            // Skip Mobile Internet - that's total consumption, not admin consumption
                            if (serviceName.includes('mobile internet')) {
                                continue;
                            }
                            
                            // Look for U-Share Main service
                            if (serviceName.includes('u-share') && serviceName.includes('main')) {
                                if (service.ServiceDetailsInformationValue && Array.isArray(service.ServiceDetailsInformationValue)) {
                                    for (const details of service.ServiceDetailsInformationValue) {
                                        // Look for U-Share Main circle in SecondaryValue
                                        if (details.SecondaryValue && Array.isArray(details.SecondaryValue)) {
                                            const uShareMain = details.SecondaryValue.find(secondary => {
                                                const bundleName = (secondary.BundleNameValue || '').toLowerCase();
                                                return bundleName.includes('u-share main') || bundleName.includes('main');
                                            });
                                            
                                            if (uShareMain && uShareMain.ConsumptionValue) {
                                                let consumption = parseFloat(uShareMain.ConsumptionValue) || 0;
                                                const consumptionUnit = uShareMain.ConsumptionUnitValue || '';
                                                if (consumptionUnit === 'MB' && consumption > 0) {
                                                    consumption = consumption / 1024;
                                                }
                                                adminConsumption = consumption;
                                                break;
                                            }
                                        }
                                        
                                        // Fallback: Use ConsumptionValue from U-Share Main service details
                                        if (adminConsumption === 0 && details.ConsumptionValue) {
                                            let consumption = parseFloat(details.ConsumptionValue) || 0;
                                            const consumptionUnit = details.ConsumptionUnitValue || '';
                                            if (consumptionUnit === 'MB' && consumption > 0) {
                                                consumption = consumption / 1024;
                                            }
                                            adminConsumption = consumption;
                                            break;
                                        }
                                    }
                                    if (adminConsumption > 0) break;
                                }
                            }
                        }
                    }
                } catch (primaryError) {
                    console.warn(`⚠️ Error extracting adminConsumption from primaryData for admin ${doc.id}:`, primaryError);
                }
            }

            // Parse total consumption for display
            let totalConsumption = 0;
            let totalLimit = 0;

            if (alfaData.totalConsumption) {
                const parsed = this.parseConsumption(alfaData.totalConsumption);
                totalConsumption = parsed.used;
                totalLimit = parsed.total || 0;
            } else if (data.quota) {
                // Fallback: use quota as limit
                const quotaStr = String(data.quota).trim();
                const quotaMatch = quotaStr.match(/^([\d.]+)/);
                totalLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
            }

            // Check if admin consumption is 95% or more of admin quota
            // Note: 100% users are already excluded via Finished Services filter above
            const adminPercent = adminLimit > 0 ? (adminConsumption / adminLimit) * 100 : 0;
            const isHighAdminConsumption = adminLimit > 0 && adminConsumption > 0 && adminPercent >= 95;
            
            // Debug logging (can be removed later)
            if (adminLimit > 0) {
                console.log(`[High Admin Consumption Filter] ${data.name || data.phone}: adminConsumption=${adminConsumption.toFixed(2)} GB, adminLimit=${adminLimit.toFixed(2)} GB, percent=${adminPercent.toFixed(2)}%, isHigh=${isHighAdminConsumption ? 'YES' : 'NO'}`);
                if (adminConsumption === 0) {
                    console.log(`  ⚠️ Debug: alfaData.adminConsumption=`, alfaData.adminConsumption, `consumptions=`, alfaData.consumptions ? `${alfaData.consumptions.length} items` : 'missing');
                }
            }
            
            // Show only if admin quota usage is 95% or more (and we already excluded Finished Services admins above)
            if (isHighAdminConsumption) {
                // Get validity date
                let validityDate = '';
                if (alfaData.validityDate) {
                    validityDate = alfaData.validityDate;
                } else {
                    // Fallback: calculate from createdAt + 30 days
                    let createdAt = new Date();
                    if (data.createdAt) {
                        createdAt = data.createdAt.toDate ? data.createdAt.toDate() : (data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt));
                    }
                    validityDate = this.formatDateDDMMYYYY(new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000));
                }

                highAdminConsumption.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    adminConsumption: adminConsumption,
                    adminLimit: adminLimit,
                    totalConsumption: totalConsumption,
                    totalLimit: totalLimit,
                    validityDate: validityDate,
                    alfaData: alfaData
                });
            }
        });

        return highAdminConsumption;
    }

    showHighAdminConsumptionModal(services) {
        // Remove existing modal if any
        const existingModal = document.getElementById('highAdminConsumptionModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows with limit
        let tableRows = '';
        let hasMore = false;
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="5" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No admins with high admin consumption found
                    </td>
                </tr>
            `;
        } else {
            const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                const adminPercent = service.adminLimit > 0 ? (service.adminConsumption / service.adminLimit) * 100 : 0;
                // All admins in this table have 95%+ admin consumption, so show error (red) for all
                const adminProgressClass = adminPercent >= 95 ? 'progress-fill error' : 'progress-fill';
                const adminProgressWidth = Math.min(adminPercent, 100);
                
                const totalPercent = service.totalLimit > 0 ? (service.totalConsumption / service.totalLimit) * 100 : 0;
                // Total progress bar: error at 90%+ (matching available-services table logic)
                const totalProgressClass = totalPercent >= 90 ? 'progress-fill error' : 'progress-fill';
                const totalProgressWidth = Math.min(totalPercent, 100);
                const hiddenClass = isHidden ? 'table-row-hidden' : '';
                
                return `
                    <tr class="${hiddenClass}">
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="${adminProgressClass}" style="width: ${adminProgressWidth}%"></div>
                                </div>
                                <div class="progress-text">${service.adminConsumption.toFixed(2)} / ${service.adminLimit.toFixed(2)} GB</div>
                            </div>
                        </td>
                        <td>
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="${totalProgressClass}" style="width: ${totalProgressWidth}%"></div>
                                </div>
                                <div class="progress-text">${service.totalConsumption.toFixed(2)} / ${service.totalLimit.toFixed(2)} GB</div>
                            </div>
                        </td>
                        <td>${this.escapeHtml(service.validityDate)}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }, 4);
            tableRows = result.rows;
            hasMore = result.hasMore;
        }

        const modal = document.createElement('div');
        modal.id = 'highAdminConsumptionModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>High Admin Consumption</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Admin Usage</th>
                                        <th>Total Usage</th>
                                        <th>Expiration Date</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                        ${hasMore ? '<button class="see-more-btn">See More</button>' : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, services);
            });
        });

        // Bind menu buttons
        modal.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });

        // Bind "See More" button
        const seeMoreBtn = modal.querySelector('.see-more-btn');
        if (seeMoreBtn) {
            seeMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tbody = modal.querySelector('tbody');
                if (tbody) {
                    const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                    hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                    seeMoreBtn.remove();
                }
            });
        }

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    showFinishedServicesModal(services) {
        // Remove existing modal if any
        const existingModal = document.getElementById('finishedServicesModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows with limit
        let tableRows = '';
        let hasMore = false;
        if (services.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No finished services found (all services have available space)
                    </td>
                </tr>
            `;
        } else {
            const result = this.buildTableRowsWithLimit(services, (service, index, isHidden = false) => {
                const usagePercent = service.totalLimit > 0 ? (service.totalConsumption / service.totalLimit) * 100 : 0;
                const progressClass = usagePercent >= 100 ? 'progress-fill error' : 'progress-fill';
                const hiddenClass = isHidden ? 'table-row-hidden' : '';
                
                return `
                    <tr class="${hiddenClass}">
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(service.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(service.phone)}</div>
                            </div>
                        </td>
                        <td>
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="${progressClass}" style="width: ${usagePercent}%"></div>
                                </div>
                                <div class="progress-text">${service.totalConsumption.toFixed(2)} / ${service.totalLimit} GB</div>
                            </div>
                        </td>
                        <td>${service.subscribersCount}</td>
                        <td>${service.expiration}</td>
                        <td>$${service.balance.toFixed(2)}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${service.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${service.id}" title="Menu">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }, 4);
            tableRows = result.rows;
            hasMore = result.hasMore;
        }

        const modal = document.createElement('div');
        modal.id = 'finishedServicesModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Finished Services</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Usage</th>
                                        <th>Subscribers</th>
                                        <th>Expiration</th>
                                        <th>Balance</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                        ${hasMore ? '<button class="see-more-btn">See More</button>' : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, services);
            });
        });

        // Bind menu buttons
        modal.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });

        // Bind "See More" button
        const seeMoreBtn = modal.querySelector('.see-more-btn');
        if (seeMoreBtn) {
            seeMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tbody = modal.querySelector('tbody');
                if (tbody) {
                    const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                    hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                    seeMoreBtn.remove();
                }
            });
        }

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    async openInactiveNumbersModal() {
        try {
            // Show loading state
            this.showLoadingModal();

            // CRITICAL: Always fetch fresh data from Firebase to ensure we have latest state
            // Don't rely on cached this.admins as it might contain deleted admins
            if (typeof db === 'undefined') {
                throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
            }

            // CRITICAL: Filter by userId for data isolation
            const currentUserId = this.getCurrentUserId();
            if (!currentUserId) {
                throw new Error('User not authenticated. Please log in.');
            }

            console.log('🔄 [Home] Fetching fresh data for inactive numbers modal...');
            const firebaseSnapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
            
            // Update this.admins with fresh data
            const previousCount = this.admins.length;
            this.admins = firebaseSnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            
            console.log(`✅ [Home] Fresh data fetched: ${previousCount} → ${this.admins.length} admins`);
            
            // Create snapshot from fresh data
            const snapshot = {
                docs: this.admins.map(admin => ({
                    id: admin.id,
                    data: () => admin
                }))
            };
            
            // Process and filter admins
            const inactiveNumbers = this.filterInactiveNumbers(snapshot);
            
            console.log(`📋 [Home] Found ${inactiveNumbers.length} inactive admin(s) for modal`);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showInactiveNumbersModal(inactiveNumbers);
        } catch (error) {
            console.error('Error opening Inactive Numbers modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterInactiveNumbers(snapshot) {
        const inactiveNumbers = [];
        const processedIds = new Set();

        console.log(`🔍 [Home] Filtering inactive numbers from ${snapshot.docs.length} admin(s)`);

        snapshot.docs.forEach(doc => {
            // CRITICAL: Ensure document has valid ID
            if (!doc || !doc.id) {
                console.warn(`⚠️ [Home] Skipping invalid document in filterInactiveNumbers`);
                return;
            }

            // CRITICAL: Skip if we've already processed this ID (duplicate check)
            if (processedIds.has(doc.id)) {
                console.warn(`⚠️ [Home] Skipping duplicate admin ID: ${doc.id}`);
                return;
            }
            processedIds.add(doc.id);

            const data = doc.data();
            
            // CRITICAL: Ensure data exists
            if (!data) {
                console.warn(`⚠️ [Home] Skipping admin ${doc.id} - no data`);
                return;
            }

            const alfaData = data.alfaData || {};

            // Filter: only show admins with status === 'inactive' (using helper function)
            const isInactive = this.isAdminInactive(data, alfaData);
            
            // CRITICAL: Exclude admins that appear in "Access Denied Numbers" table
            // Access denied admins should not appear in inactive numbers table
            const isAccessDenied = alfaData.accessDenied === true;
            
            if (isInactive && !isAccessDenied) {
                // Parse balance
                let balance = 0;
                if (alfaData.balance) {
                    const balanceStr = String(alfaData.balance).trim();
                    const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                    balance = match ? parseFloat(match[0]) : 0;
                }

                console.log(`📋 [Home] Found inactive admin: ${doc.id} (${data.name || 'N/A'})`);
                
                inactiveNumbers.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    balance: balance,
                    alfaData: alfaData
                });
            } else if (isInactive && isAccessDenied) {
                console.log(`🚫 [Home] Skipping inactive admin ${doc.id} - appears in Access Denied Numbers table`);
            }
        });

        console.log(`✅ [Home] Filtered ${inactiveNumbers.length} inactive admin(s) from ${snapshot.docs.length} total`);
        return inactiveNumbers;
    }

    showInactiveNumbersModal(numbers) {
        // Remove existing modal if any
        const existingModal = document.getElementById('inactiveNumbersModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows with limit
        let tableRows = '';
        let hasMore = false;
        if (numbers.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="3" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No inactive numbers found
                    </td>
                </tr>
            `;
        } else {
            const result = this.buildTableRowsWithLimit(numbers, (number, index, isHidden = false) => {
                const hiddenClass = isHidden ? 'table-row-hidden' : '';
                return `
                    <tr class="${hiddenClass}">
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(number.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(number.phone)}</div>
                            </div>
                        </td>
                        <td>$${number.balance.toFixed(2)}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${number.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${number.id}" title="Menu">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }, 4);
            tableRows = result.rows;
            hasMore = result.hasMore;
        }

        const modal = document.createElement('div');
        modal.id = 'inactiveNumbersModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Inactive Numbers</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Balance</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                        ${hasMore ? '<button class="see-more-btn">See More</button>' : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, numbers);
            });
        });

        // Bind menu buttons
        modal.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });

        // Bind "See More" button
        const seeMoreBtn = modal.querySelector('.see-more-btn');
        if (seeMoreBtn) {
            seeMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tbody = modal.querySelector('tbody');
                if (tbody) {
                    const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                    hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                    seeMoreBtn.remove();
                }
            });
        }

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    // Access Denied Numbers Modal
    async openAccessDeniedNumbersModal() {
        try {
            // Show loading state
            this.showLoadingModal();

            // Use real-time data if available, otherwise fetch
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized. Please check firebase-config.js');
                }
                // CRITICAL: Filter by userId for data isolation
                const currentUserId = this.getCurrentUserId();
                if (!currentUserId) {
                    throw new Error('User not authenticated. Please log in.');
                }
                const firebaseSnapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
                snapshot = firebaseSnapshot;
            }
            
            // Process and filter admins
            const accessDeniedNumbers = this.filterAccessDeniedNumbers(snapshot);
            
            console.log(`📋 [Home] Found ${accessDeniedNumbers.length} access denied admin(s) for modal`);
            
            // Hide loading and show modal with data
            this.hideLoadingModal();
            this.showAccessDeniedNumbersModal(accessDeniedNumbers);
        } catch (error) {
            console.error('Error opening Access Denied Numbers modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    }

    filterAccessDeniedNumbers(snapshot) {
        const accessDeniedNumbers = [];
        const processedIds = new Set();

        console.log(`🔍 [Home] Filtering access denied numbers from ${snapshot.docs.length} admin(s)`);

        snapshot.docs.forEach(doc => {
            // CRITICAL: Ensure document has valid ID
            if (!doc || !doc.id) {
                console.warn(`⚠️ [Home] Skipping invalid document in filterAccessDeniedNumbers`);
                return;
            }

            // CRITICAL: Skip if we've already processed this ID (duplicate check)
            if (processedIds.has(doc.id)) {
                console.warn(`⚠️ [Home] Skipping duplicate admin ID: ${doc.id}`);
                return;
            }
            processedIds.add(doc.id);

            const data = doc.data();
            
            // CRITICAL: Ensure data exists
            if (!data) {
                console.warn(`⚠️ [Home] Skipping admin ${doc.id} - no data`);
                return;
            }

            const alfaData = data.alfaData || {};
            
            // Check if admin has accessDenied flag (Alfa system problem - login succeeded but all APIs still 401)
            const isAccessDenied = alfaData.accessDenied === true || data.accessDenied === true;
            
            if (isAccessDenied) {
                console.log(`🚫 [Home] Found access denied admin: ${doc.id} (${data.name || 'N/A'})`);
                
                accessDeniedNumbers.push({
                    id: doc.id,
                    name: data.name || 'N/A',
                    phone: data.phone || 'N/A',
                    alfaData: alfaData
                });
            }
        });

        console.log(`✅ [Home] Filtered ${accessDeniedNumbers.length} access denied admin(s) from ${snapshot.docs.length} total`);
        return accessDeniedNumbers;
    }

    showAccessDeniedNumbersModal(numbers) {
        // Remove existing modal if any
        const existingModal = document.getElementById('accessDeniedNumbersModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Build table rows with limit
        let tableRows = '';
        let hasMore = false;
        if (numbers.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="3" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No access denied numbers found
                    </td>
                </tr>
            `;
        } else {
            const result = this.buildTableRowsWithLimit(numbers, (number, index, isHidden = false) => {
                const hiddenClass = isHidden ? 'table-row-hidden' : '';
                return `
                    <tr class="${hiddenClass}">
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(number.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(number.phone)}</div>
                            </div>
                        </td>
                        <td style="color: #ef4444;">Access denied by Alfa system</td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${number.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${number.id}" title="Menu">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }, 4);
            tableRows = result.rows;
            hasMore = result.hasMore;
        }

        const modal = document.createElement('div');
        modal.id = 'accessDeniedNumbersModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Access Denied Numbers</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Details</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                        ${hasMore ? '<button class="see-more-btn">See More</button>' : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Bind view buttons
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                this.viewSubscriberDetails(id, numbers);
            });
        });

        // Bind menu buttons
        modal.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleMenu(id, e.currentTarget);
            });
        });

        // Bind "See More" button
        const seeMoreBtn = modal.querySelector('.see-more-btn');
        if (seeMoreBtn) {
            seeMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tbody = modal.querySelector('tbody');
                if (tbody) {
                    const hiddenRows = tbody.querySelectorAll('.table-row-hidden');
                    hiddenRows.forEach(row => row.classList.remove('table-row-hidden'));
                    seeMoreBtn.remove();
                }
            });
        }

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    // Three-dot menu functions (copied from insights.js)
    toggleMenu(id, button) {
        // Close any existing menus
        document.querySelectorAll('.dropdown-menu').forEach(menu => {
            if (menu.dataset.subscriberId !== id) {
                menu.remove();
            }
        });
        
        // Check if menu already exists
        let menu = document.querySelector(`.dropdown-menu[data-subscriber-id="${id}"]`);
        
        if (menu) {
            menu.remove();
            return;
        }
        
        // Create menu
        menu = document.createElement('div');
        menu.className = 'dropdown-menu';
        menu.dataset.subscriberId = id;
        menu.innerHTML = `
            <div class="dropdown-item" data-action="refresh">
                <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
                    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                </svg>
                Refresh
            </div>
            <div class="dropdown-item" data-action="edit">
                <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
                    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                </svg>
                Edit
            </div>
            <div class="dropdown-item" data-action="statement">
                <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
                    <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
                </svg>
                Statement
            </div>
        `;
        
        // Position menu - ensure it doesn't cover table data
        const rect = button.getBoundingClientRect();
        const modal = button.closest('.available-services-modal-overlay');
        const isInModal = modal !== null;
        
        menu.style.position = 'fixed';
        menu.style.zIndex = '10000';
        
        // Calculate position - prefer placing below button, aligned to right edge of button
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        const menuHeight = 150; // Approximate menu height (3 items)
        
        if (spaceBelow >= menuHeight || spaceBelow >= spaceAbove) {
            // Place below button
            menu.style.top = `${rect.bottom + 4}px`;
        } else {
            // Place above button
            menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            menu.style.top = 'auto';
        }
        
        // Align to right edge of button, but ensure it doesn't go off-screen
        const menuWidth = 150; // Approximate menu width
        const rightPosition = window.innerWidth - rect.right;
        if (rightPosition + menuWidth > window.innerWidth - 16) {
            // Menu would go off-screen, align to left instead
            menu.style.left = `${rect.left}px`;
            menu.style.right = 'auto';
        } else {
            menu.style.right = `${rightPosition}px`;
            menu.style.left = 'auto';
        }
        
        document.body.appendChild(menu);
        
        // Add click handlers
        menu.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;
                this.handleMenuAction(action, id);
                menu.remove();
            });
        });
        
        // Close on outside click
        setTimeout(() => {
            const clickHandler = (e) => {
                if (!menu.contains(e.target) && e.target !== button) {
                    menu.remove();
                    document.removeEventListener('click', clickHandler);
                }
            };
            document.addEventListener('click', clickHandler);
        }, 0);
    }
    
    handleMenuAction(action, id) {
        if (action === 'refresh') {
            this.refreshSubscriber(id);
        } else if (action === 'edit') {
            this.editSubscriber(id);
        } else if (action === 'statement') {
            this.showStatement(id);
        }
    }
    
    editSubscriber(id) {
        // Navigate to Edit Subscribers page instead of opening modal
        window.location.href = `/pages/edit-subscriber.html?id=${encodeURIComponent(id)}`;
    }
    
    async showStatement(adminId) {
        // Show modal immediately with loading state
        this.createStatementModal(adminId, null); // null = loading state
        
        try {
            // Fetch balance history from backend
            // Get backend base URL from config
            const baseURL = window.AEFA_API_URL || window.ALFA_API_URL || 'https://cell-spott-manage-backend.onrender.com';
            const response = await fetch(`${baseURL}/api/admin/${adminId}/balance-history`);
            const result = await response.json();
            
            if (!result.success) {
                console.error('❌ Error fetching balance history:', result.error);
                this.updateStatementModal(adminId, [], 'error');
                return;
            }
            
            const balanceHistory = result.data || [];
            
            // Update modal with data
            this.updateStatementModal(adminId, balanceHistory);
        } catch (error) {
            console.error('❌ Error showing statement:', error);
            this.updateStatementModal(adminId, [], 'error');
        }
    }
    
    createStatementModal(adminId, balanceHistory) {
        // Remove existing modal if any
        const existingModal = document.getElementById('statementModal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Find admin name from this.admins
        const admin = this.admins.find(s => s.id === adminId);
        const adminName = admin ? admin.name : 'Admin';
        
        // Determine content based on state
        let content = '';
        if (balanceHistory === null) {
            // Loading state
            content = `
                <div class="statement-loading">
                    <div class="statement-spinner"></div>
                    <p>Loading balance history...</p>
                </div>
            `;
        } else if (balanceHistory.length === 0) {
            // Empty state
            content = `
                <div class="statement-empty">
                    <p>No balance history available yet.</p>
                    <p class="statement-empty-hint">Balance history will appear here after successful refreshes.</p>
                </div>
            `;
        } else {
            // Data state
            content = `
                <div class="statement-table">
                    <div class="statement-table-header">
                        <div class="statement-col-date">Date</div>
                        <div class="statement-col-balance">Balance</div>
                    </div>
                    <div class="statement-table-body">
                        ${balanceHistory.map(entry => {
                            const dateTime = this.formatDateTime(new Date(entry.timestamp || entry.date));
                            return `
                                <div class="statement-table-row">
                                    <div class="statement-col-date">${dateTime.date} ${dateTime.time}</div>
                                    <div class="statement-col-balance">${this.escapeHtml(entry.balance || 'N/A')}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        
        // Create modal
        const modal = document.createElement('div');
        modal.id = 'statementModal';
        modal.className = 'statement-modal-overlay';
        modal.innerHTML = `
            <div class="statement-modal-container">
                <div class="statement-modal-header">
                    <h3>Statement - ${this.escapeHtml(adminName)}</h3>
                    <button class="statement-modal-close" aria-label="Close">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="statement-modal-content">
                    ${content}
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Add event listeners
        const closeBtn = modal.querySelector('.statement-modal-close');
        closeBtn.addEventListener('click', () => {
            modal.remove();
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
        
        // Close on Escape key
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);
    }
    
    updateStatementModal(adminId, balanceHistory, error = null) {
        const modal = document.getElementById('statementModal');
        if (!modal) return;
        
        const contentDiv = modal.querySelector('.statement-modal-content');
        if (!contentDiv) return;
        
        let content = '';
        if (error === 'error') {
            content = `
                <div class="statement-empty">
                    <p>Failed to load balance history.</p>
                    <p class="statement-empty-hint">Please try again later.</p>
                </div>
            `;
        } else if (balanceHistory.length === 0) {
            content = `
                <div class="statement-empty">
                    <p>No balance history available yet.</p>
                    <p class="statement-empty-hint">Balance history will appear here after successful refreshes.</p>
                </div>
            `;
        } else {
            content = `
                <div class="statement-table">
                    <div class="statement-table-header">
                        <div class="statement-col-date">Date</div>
                        <div class="statement-col-balance">Balance</div>
                    </div>
                    <div class="statement-table-body">
                        ${balanceHistory.map(entry => {
                            const dateTime = this.formatDateTime(new Date(entry.timestamp || entry.date));
                            return `
                                <div class="statement-table-row">
                                    <div class="statement-col-date">${dateTime.date} ${dateTime.time}</div>
                                    <div class="statement-col-balance">${this.escapeHtml(entry.balance || 'N/A')}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        
        contentDiv.innerHTML = content;
    }
    
    formatDateTime(date) {
        // CRITICAL: Always validate input and return valid date or N/A
        if (!date) {
            console.warn('formatDateTime: No date provided');
            return { date: 'N/A', time: '' };
        }
        
        // Ensure we have a valid Date object
        let d;
        if (date instanceof Date) {
            d = date;
        } else if (typeof date === 'number') {
            // If it's a number, treat as milliseconds since epoch
            if (date <= 0 || date > 9999999999999) {
                console.warn('formatDateTime: Invalid timestamp number:', date);
                return { date: 'N/A', time: '' };
            }
            d = new Date(date);
        } else if (typeof date === 'string') {
            d = new Date(date);
        } else {
            console.warn('formatDateTime: Invalid date type:', typeof date, date);
            return { date: 'N/A', time: '' };
        }
        
        // Validate the date
        if (isNaN(d.getTime()) || d.getTime() <= 0) {
            console.warn('formatDateTime: Invalid date value:', date, '->', d);
            return { date: 'N/A', time: '' };
        }
        
        // Use local timezone methods
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        
        let hours = d.getHours();
        const minutes = d.getMinutes();
        const seconds = d.getSeconds();
        
        const minutesStr = String(minutes).padStart(2, '0');
        const secondsStr = String(seconds).padStart(2, '0');
        
        // 12-hour format
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12;
        const hoursStr = String(hours).padStart(2, '0');
        
        return {
            date: `${day}/${month}/${year}`,
            time: `${hoursStr}:${minutesStr}:${secondsStr} ${ampm}`
        };
    }

    async refreshSubscriber(id) {
        // CRITICAL: Verify ownership before refreshing
        const currentUserId = this.getCurrentUserId();
        if (!currentUserId) {
            alert('Error: You must be logged in to refresh admins.');
            return;
        }
        
        // Find the admin in our data
        const admin = this.admins.find(a => a.id === id);
        if (!admin) {
            console.error('Admin not found:', id);
            return;
        }
        
        // CRITICAL: Verify ownership
        if (admin.userId && admin.userId !== currentUserId) {
            alert('Error: You do not have permission to refresh this admin.');
            return;
        }
        
        // Mark this admin as being refreshed (prevents modal updates during refresh)
        this.refreshingAdmins.add(id);
        
        // Record refresh start time immediately (before any async operations)
        // This ensures the listener can detect the refresh is in progress
        this.lastRefreshTime.set(id, Date.now());
        
        // Capture the refresh timestamp when user initiates the refresh (client-side time)
        const refreshInitiatedAt = Date.now();
        console.log('🔄 Refresh initiated at:', new Date(refreshInitiatedAt).toLocaleString(), 'timestamp:', refreshInitiatedAt);
        
        try {
            console.log('Refreshing admin:', id);
            
            // Get admin data from Firestore to get phone and password
            const phone = admin.phone || '';
            
            if (!phone) {
                console.error('Phone not found for admin:', id);
                alert('Cannot refresh: Phone number not found');
                return;
            }
            
            // Try to get password - check cache first, then Firestore
            let password = admin.password || null;
            
            // First, try to get from localStorage cache (fastest, no network needed)
            if (!password) {
                try {
                    const cachedAdmin = localStorage.getItem(`admin_${id}`);
                    if (cachedAdmin) {
                        const adminData = JSON.parse(cachedAdmin);
                        if (adminData.password) {
                            password = adminData.password;
                            console.log('✅ Using cached password from localStorage');
                        }
                    }
                } catch (cacheError) {
                    console.warn('Could not read from cache:', cacheError);
                }
            }
            
            // If not in admin object or cache, try to get from Firestore (but don't block if it fails)
            if (!password) {
                try {
                    const waitForOnline = () => {
                        return new Promise((resolve, reject) => {
                            const timeout = setTimeout(() => {
                                reject(new Error('Firestore request timed out'));
                            }, 3000);
                            
                            const docRef = db.collection('admins').doc(id);
                            
                            docRef.get()
                                .then((doc) => {
                                    clearTimeout(timeout);
                                    resolve(doc);
                                })
                                .catch((error) => {
                                    clearTimeout(timeout);
                                    reject(error);
                                });
                        });
                    };
                    
                    const adminDoc = await waitForOnline();
                    
                    if (adminDoc.exists) {
                        const adminData = adminDoc.data();
                        password = adminData?.password || null;
                        
                        // Cache password in admin object and localStorage for next time
                        if (password) {
                            admin.password = password;
                            try {
                                localStorage.setItem(`admin_${id}`, JSON.stringify({
                                    password: password,
                                    phone: phone,
                                    cachedAt: Date.now()
                                }));
                            } catch (e) {
                                console.warn('Could not cache to localStorage:', e);
                            }
                        } else {
                            console.warn(`⚠️ Admin document exists (${id}) but password field is missing or empty`);
                        }
                    } else {
                        console.warn('Admin document not found in Firestore:', id);
                    }
                } catch (firestoreError) {
                    // Firestore failed, but we already checked cache above
                    // Only log warning, don't bother user - we'll check if password exists below
                    console.warn('⚠️ Firestore fetch failed (using cached data if available):', firestoreError.message);
                }
            }
            
            // Final check: only show error if password truly cannot be found anywhere
            if (!password) {
                console.error('Password not found for admin:', id);
                this.refreshingAdmins.delete(id);
                alert('Cannot refresh: Password not found.\n\nPlease ensure:\n1. You are connected to the internet\n2. The admin account exists in Firestore\n3. The password is stored in the admin document');
                this.removeRefreshIndicators(id);
                return;
            }
            
            // Check if AlfaAPIService is available
            if (typeof window.AlfaAPIService === 'undefined' || !window.AlfaAPIService) {
                this.refreshingAdmins.delete(id);
                alert('Backend service not available. Please make sure the server is running and alfa-api.js is loaded.');
                this.removeRefreshIndicators(id);
                return;
            }
            
            // Show animated loading indicator
            const button = document.querySelector(`button[data-subscriber-id="${id}"], .menu-btn[data-subscriber-id="${id}"]`);
            const row = button ? button.closest('tr') : null;
            let loadingIndicator = null;
            let successIndicator = null;
            
            if (row) {
                // Add refreshing class for animation
                row.classList.add('refreshing');
                
                // Remove any existing indicators
                const existingLoading = row.querySelector('.refresh-loading');
                const existingSuccess = row.querySelector('.refresh-success');
                if (existingLoading) existingLoading.remove();
                if (existingSuccess) existingSuccess.remove();
                
                // Create and add 3D rotating loader
                loadingIndicator = document.createElement('div');
                loadingIndicator.className = 'refresh-loading';
                loadingIndicator.innerHTML = `
                    <div class="loader">
                        <div class="inner one"></div>
                        <div class="inner two"></div>
                        <div class="inner three"></div>
                    </div>
                `;
                row.appendChild(loadingIndicator);
                console.log('✅ 3D loader added to row');
            } else {
                console.warn('⚠️ Row not found for admin:', id);
            }
            
            // Fetch Alfa data from backend
            console.log('📡 Calling backend API with phone:', phone, 'adminId:', id);
            const response = await window.AlfaAPIService.fetchDashboardData(phone, password, id);
            
            // Extract alfaData - handle both nested and flat structures
            const alfaData = (response.data && response.data.data) ? response.data.data : response.data;
            
            // Validate that we have consumption data before saving
            if (!alfaData.totalConsumption && !alfaData.adminConsumption && !alfaData.primaryData) {
                console.error(`❌ [${id}] No consumption data found in API response!`);
            }
            
            // Use the client-side timestamp when refresh was initiated
            const refreshTimestamp = refreshInitiatedAt;
            
            // Update admin document with new Alfa data
            try {
                console.log('💾 Saving to Firebase:', {
                    adminId: id,
                    lastRefreshTimestamp: refreshTimestamp,
                    timestampDate: new Date(refreshTimestamp).toLocaleString(),
                    hasTotalConsumption: !!alfaData.totalConsumption,
                    hasAdminConsumption: !!alfaData.adminConsumption,
                    hasPrimaryData: !!alfaData.primaryData,
                    alfaDataKeys: Object.keys(alfaData || {})
                });
                
                // CRITICAL: Ensure userId is preserved when updating
                const currentUserId = this.getCurrentUserId();
                let currentDocData = {};
                try {
                    const currentDoc = await db.collection('admins').doc(id).get();
                    if (currentDoc.exists()) {
                        currentDocData = currentDoc.data();
                        // Verify ownership one more time
                        if (currentDocData.userId && currentDocData.userId !== currentUserId) {
                            throw new Error('Permission denied: Admin does not belong to current user');
                        }
                    }
                } catch (docError) {
                    console.warn('⚠️ Could not verify ownership before update:', docError.message);
                }
                
                await db.collection('admins').doc(id).set({
                    userId: currentDocData.userId || currentUserId,
                    alfaData: alfaData,
                    alfaDataFetchedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    lastRefreshTimestamp: refreshTimestamp
                }, { merge: true });
                
                console.log('✅ Successfully saved lastRefreshTimestamp to Firebase');
            } catch (updateError) {
                console.warn('⚠️ Failed to save to Firebase:', updateError.message);
            }
            
            console.log('Alfa data refreshed successfully');
            
            // Show success notification
            try {
                const notify = (typeof window !== 'undefined' && window.notification) ? window.notification : (typeof notification !== 'undefined' ? notification : null);
                if (notify && typeof notify.success === 'function') {
                    notify.set({ delay: 3000 });
                    notify.success('Refresh completed successfully');
                } else {
                    console.warn('⚠️ Notification system not available or not initialized');
                }
            } catch (e) {
                console.error('Error showing notification:', e);
            }
            
            // Wait a bit for Firebase real-time listener to update the UI
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Show success animation
            if (row) {
                // Remove loading indicator
                if (loadingIndicator) {
                    loadingIndicator.remove();
                }
                
                // Remove refreshing class
                row.classList.remove('refreshing');
                
                // Add success class and indicator
                row.classList.add('refresh-success');
                
                // Create and add success checkmark
                successIndicator = document.createElement('div');
                successIndicator.className = 'refresh-success';
                successIndicator.innerHTML = `
                    <svg viewBox="0 0 24 24">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                `;
                row.appendChild(successIndicator);
                
                // Remove success indicator after animation completes
                setTimeout(() => {
                    if (successIndicator) {
                        successIndicator.remove();
                    }
                    row.classList.remove('refresh-success');
                }, 2000);
                
                // Mark refresh as complete and record timestamp (prevents modal updates for 3 seconds)
                this.refreshingAdmins.delete(id);
                this.lastRefreshTime.set(id, Date.now());
            }
            
        } catch (error) {
            console.error('Error refreshing admin:', error);
            
            // Mark refresh as complete even on error
            this.refreshingAdmins.delete(id);
            this.lastRefreshTime.set(id, Date.now());
            
            let errorMessage = error?.message || error?.toString() || 'Unknown error occurred';
            
            if (error?.details) {
                console.error('Backend error details:', error.details);
                errorMessage += '\n\nCheck the backend console for more details.';
            }
            
            // Show error notification
            try {
                const notify = (typeof window !== 'undefined' && window.notification) ? window.notification : (typeof notification !== 'undefined' ? notification : null);
                if (notify && typeof notify.error === 'function') {
                    notify.set({ delay: 3000 });
                    notify.error('Refresh failed: ' + (errorMessage.length > 50 ? errorMessage.substring(0, 50) + '...' : errorMessage));
                } else {
                    console.warn('⚠️ Notification system not available or not initialized');
                    alert('Failed to refresh data: ' + errorMessage);
                }
            } catch (e) {
                console.error('Error showing notification:', e);
                alert('Failed to refresh data: ' + errorMessage);
            }
            
            // Remove loading indicators and restore row
            this.removeRefreshIndicators(id);
        }
    }

    removeRefreshIndicators(id) {
        const button = document.querySelector(`button[data-subscriber-id="${id}"], .menu-btn[data-subscriber-id="${id}"]`);
        const row = button ? button.closest('tr') : null;
        if (row) {
            row.classList.remove('refreshing', 'refresh-success');
            const loadingIndicator = row.querySelector('.refresh-loading');
            const successIndicator = row.querySelector('.refresh-success');
            if (loadingIndicator) loadingIndicator.remove();
            if (successIndicator) successIndicator.remove();
        }
    }
}

// Global instance for cleanup
let homeManagerInstance = null;

document.addEventListener('DOMContentLoaded', () => {
    homeManagerInstance = new HomeManager();
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (homeManagerInstance) {
        if (homeManagerInstance.unsubscribe) {
            homeManagerInstance.unsubscribe();
            console.log('🔄 [Home] Real-time listener unsubscribed');
        }
        if (homeManagerInstance.periodicRefreshInterval) {
            clearInterval(homeManagerInstance.periodicRefreshInterval);
            console.log('🔄 [Home] Periodic refresh cleared');
        }
    }
});

// Add waiting balance functions to HomeManager class
Object.assign(HomeManager.prototype, {
    getWaitingBalanceData() {
        try {
            const userId = this.getCurrentUserId() || 'default';
            const key = `waitingBalance_${userId}`;
            const data = localStorage.getItem(key);
            return data ? JSON.parse(data) : [];
        } catch (error) {
            console.error('Error getting waiting balance data:', error);
            return [];
        }
    },
    
    setWaitingBalanceData(data) {
        try {
            const userId = this.getCurrentUserId() || 'default';
            const key = `waitingBalance_${userId}`;
            localStorage.setItem(key, JSON.stringify(data));
            this.updateCardCounts();
        } catch (error) {
            console.error('Error setting waiting balance data:', error);
        }
    },
    
    removeFromWaitingBalance(adminId) {
        const waitingBalance = this.getWaitingBalanceData();
        const filtered = waitingBalance.filter(item => item.adminId !== adminId);
        this.setWaitingBalanceData(filtered);
    },
    
    async openWaitingBalanceModal() {
        try {
            this.showLoadingModal();
            const waitingBalance = this.getWaitingBalanceData();
            if (waitingBalance.length === 0) {
                this.hideLoadingModal();
                this.showWaitingBalanceModal([]);
                return;
            }
            
            let snapshot;
            if (this.admins && this.admins.length > 0) {
                snapshot = {
                    docs: this.admins.map(admin => ({
                        id: admin.id,
                        data: () => admin
                    }))
                };
            } else {
                if (typeof db === 'undefined') {
                    throw new Error('Firebase Firestore (db) is not initialized.');
                }
                const currentUserId = this.getCurrentUserId();
                if (!currentUserId) {
                    throw new Error('User not authenticated.');
                }
                const firebaseSnapshot = await db.collection('admins').where('userId', '==', currentUserId).get();
                snapshot = firebaseSnapshot;
            }
            
            const waitingBalanceData = [];
            const waitingBalanceMap = new Map(waitingBalance.map(item => [item.adminId, item]));
            
            snapshot.docs.forEach(doc => {
                const markedData = waitingBalanceMap.get(doc.id);
                if (markedData) {
                    const data = doc.data();
                    const alfaData = data.alfaData || {};
                    
                    let currentBalance = 0;
                    if (alfaData.balance) {
                        const balanceStr = String(alfaData.balance).trim();
                        const match = balanceStr.replace(/\$/g, '').trim().match(/-?[\d.]+/);
                        currentBalance = match ? parseFloat(match[0]) : 0;
                    }
                    
                    waitingBalanceData.push({
                        id: doc.id,
                        name: data.name || 'N/A',
                        phone: data.phone || 'N/A',
                        markedBalance: markedData.markedBalance,
                        currentBalance: currentBalance,
                        difference: currentBalance - markedData.markedBalance,
                        alfaData: alfaData
                    });
                }
            });
            
            // Sort by validity date: nearest (earliest) to farthest (latest)
            const parseDDMMYYYY = (dateStr) => {
                if (!dateStr || dateStr === 'N/A') return null;
                const parts = String(dateStr).trim().split('/');
                if (parts.length !== 3) return null;
                const day = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
                const year = parseInt(parts[2], 10);
                if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
                const date = new Date(year, month, day);
                if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
                    return null; // Invalid date
                }
                return date;
            };
            
            waitingBalanceData.sort((a, b) => {
                // Get validity dates
                let validityDateA = a.alfaData?.validityDate || '';
                let validityDateB = b.alfaData?.validityDate || '';
                
                // If no validity date in alfaData, try to calculate from createdAt
                if (!validityDateA && a.alfaData) {
                    // Fallback: use a far future date if no validity date
                    validityDateA = '';
                }
                if (!validityDateB && b.alfaData) {
                    // Fallback: use a far future date if no validity date
                    validityDateB = '';
                }
                
                // Parse dates
                const dateA = parseDDMMYYYY(validityDateA);
                const dateB = parseDDMMYYYY(validityDateB);
                
                // Handle null dates (put them at the end)
                if (!dateA && !dateB) return 0;
                if (!dateA) return 1; // A goes to end
                if (!dateB) return -1; // B goes to end
                
                // Sort by date: earlier dates first (nearest validity dates first)
                return dateA.getTime() - dateB.getTime();
            });
            
            this.hideLoadingModal();
            this.showWaitingBalanceModal(waitingBalanceData);
        } catch (error) {
            console.error('Error opening Waiting Balance modal:', error);
            this.hideLoadingModal();
            alert('Error loading data: ' + error.message);
        }
    },
    
    showWaitingBalanceModal(data) {
        const existingModal = document.getElementById('waitingBalanceModal');
        if (existingModal) {
            existingModal.remove();
        }
        
        let tableRows = '';
        if (data.length === 0) {
            tableRows = `
                <tr>
                    <td colspan="5" style="text-align: center; padding: 3rem; color: #94a3b8;">
                        No admins in waiting balance
                    </td>
                </tr>
            `;
        } else {
            data.forEach(item => {
                const differenceColor = item.difference >= 0 ? '#10b981' : '#ef4444';
                tableRows += `
                    <tr>
                        <td>
                            <div>
                                <div class="subscriber-name">${this.escapeHtml(item.name)}</div>
                                <div class="subscriber-phone">${this.escapeHtml(item.phone)}</div>
                            </div>
                        </td>
                        <td>$${item.markedBalance.toFixed(2)}</td>
                        <td>$${item.currentBalance.toFixed(2)}</td>
                        <td style="color: ${differenceColor}; font-weight: bold;">
                            ${item.difference >= 0 ? '+' : ''}$${item.difference.toFixed(2)}
                        </td>
                        <td>
                            <div class="action-buttons">
                                <button class="action-btn view-btn" data-subscriber-id="${item.id}" title="View Details">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                </button>
                                <button class="action-btn menu-btn" data-subscriber-id="${item.id}">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="12" r="2"/>
                                        <circle cx="12" cy="5" r="2"/>
                                        <circle cx="12" cy="19" r="2"/>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            });
        }
        
        const modal = document.createElement('div');
        modal.id = 'waitingBalanceModal';
        modal.className = 'available-services-modal-overlay';
        modal.innerHTML = `
            <div class="available-services-modal">
                <div class="available-services-modal-inner">
                    <div class="available-services-modal-header">
                        <h2>Waiting Balance</h2>
                        <button class="modal-close-btn" onclick="this.closest('.available-services-modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="available-services-modal-body">
                        <div class="table-container">
                            <table class="available-services-table">
                                <thead>
                                    <tr>
                                        <th>Admin</th>
                                        <th>Marked $</th>
                                        <th>Current $</th>
                                        <th>Difference</th>
                                        <th class="actions-col">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        modal.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.subscriberId;
                const admin = data.find(item => item.id === id);
                if (admin) {
                    this.viewSubscriberDetails(id, data);
                }
            });
        });
        
        modal.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = e.currentTarget.dataset.subscriberId;
                this.toggleWaitingBalanceMenu(id, e.currentTarget, data);
            });
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    },
    
    toggleWaitingBalanceMenu(id, button, data) {
        document.querySelectorAll('.dropdown-menu').forEach(menu => {
            if (menu.dataset.subscriberId !== id) {
                menu.remove();
            }
        });
        
        let menu = document.querySelector(`.dropdown-menu[data-subscriber-id="${id}"]`);
        if (menu) {
            menu.remove();
            return;
        }
        
        menu = document.createElement('div');
        menu.className = 'dropdown-menu';
        menu.dataset.subscriberId = id;
        menu.innerHTML = `
            <div class="dropdown-item" data-action="unmark" style="color: #ef4444;">
                <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
                Unmark
            </div>
        `;
        
        const rect = button.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.right = `${window.innerWidth - rect.right}px`;
        menu.style.zIndex = '10000';
        
        document.body.appendChild(menu);
        
        menu.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;
                this.handleWaitingBalanceMenuAction(action, id, data);
                menu.remove();
            });
        });
        
        setTimeout(() => {
            const clickHandler = (e) => {
                if (!menu.contains(e.target) && e.target !== button) {
                    menu.remove();
                    document.removeEventListener('click', clickHandler);
                }
            };
            document.addEventListener('click', clickHandler);
        }, 0);
    },
    
    async     handleWaitingBalanceMenuAction(action, id, data) {
        if (action === 'unmark') {
            this.removeFromWaitingBalance(id);
            this.openWaitingBalanceModal();
            window.dispatchEvent(new Event('storage'));
        }
    },
    
    async showWaitingBalanceStatement(adminId, data) {
        // Find admin name from data
        const admin = data.find(item => item.id === adminId);
        const adminName = admin ? admin.name : 'Admin';
        
        // Show modal immediately with loading state
        this.createWaitingBalanceStatementModal(adminId, adminName, null);
        
        try {
            // Fetch balance history from backend
            const baseURL = window.AEFA_API_URL || window.ALFA_API_URL || 'https://cell-spott-manage-backend.onrender.com';
            const response = await fetch(`${baseURL}/api/admin/${adminId}/balance-history`);
            const result = await response.json();
            
            if (!result.success) {
                console.error('❌ Error fetching balance history:', result.error);
                this.updateWaitingBalanceStatementModal(adminId, [], 'error');
                return;
            }
            
            const balanceHistory = result.data || [];
            this.updateWaitingBalanceStatementModal(adminId, balanceHistory);
        } catch (error) {
            console.error('❌ Error showing statement:', error);
            this.updateWaitingBalanceStatementModal(adminId, [], 'error');
        }
    },
    
    createWaitingBalanceStatementModal(adminId, adminName, balanceHistory) {
        const existingModal = document.getElementById('waitingBalanceStatementModal');
        if (existingModal) {
            existingModal.remove();
        }
        
        let content = '';
        if (balanceHistory === null) {
            content = `
                <div class="statement-loading">
                    <div class="statement-spinner"></div>
                    <p>Loading balance history...</p>
                </div>
            `;
        } else if (balanceHistory.length === 0) {
            content = `
                <div class="statement-empty">
                    <p>No balance history available yet.</p>
                    <p class="statement-empty-hint">Balance history will appear here after successful refreshes.</p>
                </div>
            `;
        } else {
            content = `
                <div class="statement-table">
                    <div class="statement-table-header">
                        <div class="statement-col-date">Date</div>
                        <div class="statement-col-balance">Balance</div>
                    </div>
                    <div class="statement-table-body">
                        ${balanceHistory.map(entry => {
                            const dateTime = this.formatDateTime(new Date(entry.timestamp || entry.date));
                            return `
                                <div class="statement-table-row">
                                    <div class="statement-col-date">${dateTime.date} ${dateTime.time}</div>
                                    <div class="statement-col-balance">${this.escapeHtml(entry.balance || 'N/A')}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        
        const modal = document.createElement('div');
        modal.id = 'waitingBalanceStatementModal';
        modal.className = 'statement-modal-overlay';
        modal.innerHTML = `
            <div class="statement-modal-container">
                <div class="statement-modal-header">
                    <h3>Statement - ${this.escapeHtml(adminName)}</h3>
                    <button class="statement-modal-close" aria-label="Close">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="statement-modal-content">
                    ${content}
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const closeBtn = modal.querySelector('.statement-modal-close');
        closeBtn.addEventListener('click', () => {
            modal.remove();
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
        
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);
    },
    
    updateWaitingBalanceStatementModal(adminId, balanceHistory, error = null) {
        const modal = document.getElementById('waitingBalanceStatementModal');
        if (!modal) return;
        
        const contentDiv = modal.querySelector('.statement-modal-content');
        if (!contentDiv) return;
        
        let content = '';
        if (error === 'error') {
            content = `
                <div class="statement-empty">
                    <p>Failed to load balance history.</p>
                    <p class="statement-empty-hint">Please try again later.</p>
                </div>
            `;
        } else if (balanceHistory.length === 0) {
            content = `
                <div class="statement-empty">
                    <p>No balance history available yet.</p>
                    <p class="statement-empty-hint">Balance history will appear here after successful refreshes.</p>
                </div>
            `;
        } else {
            content = `
                <div class="statement-table">
                    <div class="statement-table-header">
                        <div class="statement-col-date">Date</div>
                        <div class="statement-col-balance">Balance</div>
                    </div>
                    <div class="statement-table-body">
                        ${balanceHistory.map(entry => {
                            const dateTime = this.formatDateTime(new Date(entry.timestamp || entry.date));
                            return `
                                <div class="statement-table-row">
                                    <div class="statement-col-date">${dateTime.date} ${dateTime.time}</div>
                                    <div class="statement-col-balance">${this.escapeHtml(entry.balance || 'N/A')}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        
        contentDiv.innerHTML = content;
    },
    
    formatDateTime(date) {
        if (!date || isNaN(date.getTime())) {
            return { date: 'N/A', time: '' };
        }
        
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        
        return {
            date: `${day}/${month}/${year}`,
            time: `${hours}:${minutes}`
        };
    }
});
