class AdminsManager {
    constructor() {
        this.currentPage = 1;
        this.rowsPerPage = 25;
        this.admins = []; // Will be populated from Firebase/API
        this.filteredAdmins = []; // Filtered admins based on search
        this.searchQuery = ''; // Current search query
        // Removed selectedRows - using status indicators instead
        this.denseMode = false;
        this.sortField = 'name';
        this.sortDirection = 'asc';
        this.modal = null;
        this.form = null;
        this.editingAdminId = null; // Track which admin is being edited
        this.currentUserId = null; // Current authenticated user ID
        this.unsubscribe = null; // Real-time listener unsubscribe function
        this.isListenerActive = false; // Track if listener is active
        this.hasReceivedInitialData = false; // Track if we've received initial data
        
        this.init();
    }
    
    // Get current user ID from Firebase auth
    getCurrentUserId() {
        if (typeof auth !== 'undefined' && auth && auth.currentUser) {
            return auth.currentUser.uid;
        }
        return null;
    }
    
    /**
     * Normalize phone number by removing Lebanon country code (+961 or 961) and spaces
     * Examples:
     *   "+96171935446" -> "71935446"
     *   "96171935446" -> "71935446"
     *   "71 935 446" -> "71935446"
     *   "71935446" -> "71935446" (no change)
     */
    normalizePhoneNumber(phone) {
        if (!phone) return phone;
        
        // Remove all spaces first
        let cleaned = phone.trim().replace(/\s+/g, '');
        
        // Handle +961 prefix (e.g., "+96171935446")
        if (cleaned.startsWith('+961')) {
            cleaned = cleaned.substring(4); // Remove "+961"
        }
        // Handle 961 prefix (e.g., "96171935446")
        else if (cleaned.startsWith('961') && cleaned.length >= 11) {
            cleaned = cleaned.substring(3); // Remove "961"
        }
        
        // Remove any remaining non-digit characters (shouldn't be any, but just in case)
        cleaned = cleaned.replace(/\D/g, '');
        
        return cleaned;
    }
    
    // Get Firebase auth token for API calls
    async getAuthToken() {
        if (typeof auth !== 'undefined' && auth && auth.currentUser) {
            try {
                return await auth.currentUser.getIdToken();
            } catch (error) {
                console.error('Error getting auth token:', error);
                return null;
            }
        }
        return null;
    }
    
    // Check if browser is Samsung Internet
    isSamsungBrowser() {
        const ua = navigator.userAgent || navigator.vendor || window.opera;
        return /SamsungBrowser/i.test(ua) || /SAMSUNG/i.test(ua);
    }

    // Lazy load admins: Wait until page is visible and interactive
    loadAdminsLazy() {
        // If page is already visible and interactive, initialize immediately
        if (document.visibilityState === 'visible' && document.readyState === 'complete') {
            // Use requestIdleCallback to initialize when browser is idle (better performance)
            if ('requestIdleCallback' in window) {
                requestIdleCallback(() => {
                    console.log('⚡ [Admins] Page visible and idle - initializing Firebase listener');
                    this.loadAdmins();
                }, { timeout: 2000 }); // Max 2 second wait even if browser is busy
            } else {
                // Fallback: small delay to allow page to finish rendering
                setTimeout(() => {
                    console.log('⚡ [Admins] Page ready - initializing Firebase listener (fallback)');
                    this.loadAdmins();
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
                                console.log('⚡ [Admins] Page visible and idle - initializing Firebase listener');
                                this.loadAdmins();
                            }, { timeout: 2000 });
                        } else {
                            setTimeout(() => {
                                console.log('⚡ [Admins] Page ready - initializing Firebase listener');
                                this.loadAdmins();
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
                    console.log('⚡ [Admins] Timeout reached - initializing Firebase listener (fallback)');
                    this.loadAdmins();
                }
            }, 3000);
        }
    }

    // Load admins from Firebase using real-time listener
    loadAdmins() {
        // CRITICAL: Unsubscribe from existing listener first to prevent multiple listeners
        if (this.unsubscribe) {
            console.log('🔄 [Admins] Unsubscribing from existing listener before creating new one');
            try {
                this.unsubscribe();
            } catch (e) {
                console.warn('⚠️ [Admins] Error unsubscribing:', e);
            }
            this.unsubscribe = null;
            this.isListenerActive = false;
        }
        
        try {
            // Get current user ID - CRITICAL for data isolation
            this.currentUserId = this.getCurrentUserId();
            if (!this.currentUserId) {
                console.error('❌ [Admins] No authenticated user found. Please log in.');
                const tbody = document.getElementById('adminsTableBody');
                if (tbody) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="5" class="empty-state" style="text-align: center; padding: 3rem; color: #ef4444;">
                                <p>⚠️ You must be logged in to view admins.</p>
                                <p style="margin-top: 1rem;"><a href="/auth/login.html" style="color: #3b82f6;">Go to Login</a></p>
                            </td>
                        </tr>
                    `;
                }
                return;
            }
            
            // Check if Firebase is available
            if (typeof db === 'undefined') {
                console.error('❌ [Admins] Firestore (db) is not initialized. Real-time updates disabled.');
                return;
            }
            
            // Log browser info for debugging
            if (this.isSamsungBrowser()) {
                console.log('🌐 [Admins] Samsung Internet browser detected - using enhanced compatibility mode');
            }
            
            console.log(`🔄 [Admins] Setting up real-time listener for user: ${this.currentUserId}`);
            this.isListenerActive = true;
            
            // Set up query aligned with Firestore rules
            // Rule: Users can only read admins where userId matches their auth.uid
            const adminsQuery = db.collection('admins').where('userId', '==', this.currentUserId);
            
            // Note: Firestore persistence is enabled in firebase-config.js with synchronizeTabs: false
            // This provides offline support and caching without multi-tab synchronization warnings
            
            // Set up real-time listener with explicit error handling
            console.log('📡 [Admins] Attaching Firestore listener with query:', {
                collection: 'admins',
                filter: 'userId == ' + this.currentUserId
            });
            
            this.unsubscribe = adminsQuery.onSnapshot(
                (snapshot) => {
                    // Check if this is from cache (offline mode) or server
                    const source = snapshot.metadata && snapshot.metadata.fromCache ? 'cache' : 'server';
                    console.log(`📡 [Admins] Admins snapshot received: ${snapshot.docs.length} docs (source: ${source})`);
                    
                    // Process snapshot
                    if (!snapshot || !snapshot.docs) {
                        console.error('❌ [Admins] Invalid snapshot received:', snapshot);
                        return;
                    }
                    
                    const previousAdminIds = new Set(this.admins.map(a => a.id));
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
                        } catch (error) {
                            console.error(`❌ [Admins] Error processing document ${doc.id}:`, error);
                        }
                    });
                    
                    // CRITICAL: Only update admins if we have valid data or this is from server
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
                        console.log(`✅ [Admins] Updated from server: ${newAdmins.length} admins`);
                    } else if (hasNewAdmins) {
                        // Cache has data - use it
                        this.admins = newAdmins;
                        console.log(`✅ [Admins] Updated from cache: ${newAdmins.length} admins`);
                    } else if (hasExistingAdmins && !hasNewAdmins && source === 'cache') {
                        // CRITICAL: Connection dropped, snapshot is empty, but we have cached data
                        // DON'T clear - keep existing admins to prevent disappearing
                        console.warn(`⚠️ [Admins] Connection dropped - snapshot empty but preserving ${this.admins.length} cached admins`);
                        // DO NOT update this.admins - keep existing cached data
                    } else if (!this.hasReceivedInitialData && !hasNewAdmins) {
                        // First load and no data - this is okay, might be empty collection
                        this.admins = newAdmins;
                        this.hasReceivedInitialData = true;
                        console.log(`ℹ️ [Admins] Initial load: ${newAdmins.length} admins (collection might be empty)`);
                    } else {
                        // Fallback: only update if we have new data or this is first load
                        if (hasNewAdmins || !this.hasReceivedInitialData) {
                            this.admins = newAdmins;
                        } else {
                            console.warn(`⚠️ [Admins] Ignoring empty snapshot update to preserve existing ${this.admins.length} admins`);
                        }
                    }
                    
                    // Apply search filter and render
                    this.applySearchFilter();
                    this.renderTable();
                    this.updatePagination();
                    this.updatePageInfo();
                    
                    // Hide loading state
                    this.hideLoading();
                },
                (error) => {
                    // Explicit error handling with detailed diagnostics
                    console.error('❌ [Admins] Snapshot error:', {
                        code: error.code,
                        message: error.message,
                        stack: error.stack
                    });
                    
                    this.isListenerActive = false;
                    
                    // Handle specific error types with clear diagnostics
                    if (error.code === 'permission-denied') {
                        // Rule denial - security rules are blocking access
                        console.error('❌ [Admins] PERMISSION DENIED - Firestore rules blocking access');
                        console.error('❌ [Admins] Check Firestore rules allow: users can read admins where userId == auth.uid');
                        console.error('❌ [Admins] User ID:', this.currentUserId);
                        this.admins = [];
                        this.applySearchFilter();
                        this.renderTable();
                        this.updatePagination();
                        this.updatePageInfo();
                        this.hideLoading();
                        alert('Permission denied. Your Firestore security rules are blocking access to admins data.');
                        return;
                    } else if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
                        // Transport/network issues
                        console.warn('⚠️ [Admins] TRANSPORT ERROR - Firestore backend unavailable');
                        console.warn('⚠️ [Admins] Error code:', error.code);
                        console.warn('⚠️ [Admins] Operating in offline mode - preserving cached data');
                        // Don't clear admins array - keep showing cached data
                        this.hideLoading();
                        return;
                    } else if (error.code === 'unauthenticated' || error.message?.includes('auth')) {
                        // Auth state issues
                        console.error('❌ [Admins] AUTH ERROR - User authentication state invalid');
                        console.error('❌ [Admins] Error code:', error.code);
                        console.error('❌ [Admins] User ID:', this.currentUserId);
                        this.hideLoading();
                    } else {
                        // Other unexpected errors
                        console.error('❌ [Admins] UNEXPECTED ERROR in real-time listener');
                        console.error('❌ [Admins] Error code:', error.code);
                        console.error('❌ [Admins] Error message:', error.message);
                        this.hideLoading();
                    }
                    
                    // Try to reconnect after a delay (except for permission-denied)
                    if (error.code !== 'permission-denied') {
                        setTimeout(() => {
                            console.log('🔄 [Admins] Attempting to reconnect real-time listener...');
                            // Verify user is still authenticated before reconnecting
                            const currentUserId = this.getCurrentUserId();
                            if (currentUserId && typeof db !== 'undefined') {
                                this.loadAdmins();
                            } else {
                                console.error('❌ [Admins] Cannot reconnect - user or Firebase not available');
                                console.error('❌ [Admins] User ID:', currentUserId, 'Firebase available:', typeof db !== 'undefined');
                            }
                        }, 5000);
                    }
                }
            );
            
        } catch (error) {
            console.error('❌ [Admins] Error setting up real-time listener:', error);
            this.isListenerActive = false;
            this.hideLoading();
            
            // Show error in table
            const tbody = document.getElementById('adminsTableBody');
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="5" class="empty-state" style="text-align: center; padding: 3rem; color: #ef4444;">
                            <p>Error setting up real-time listener. Please refresh the page.</p>
                            <p style="margin-top: 1rem;"><button onclick="location.reload()" style="padding: 0.5rem 1rem; background: #3a0a4e; color: white; border: none; border-radius: 0.5rem; cursor: pointer;">Retry</button></p>
                        </td>
                    </tr>
                `;
            }
        }
    }
    
    init() {
        // CRITICAL: Wait for auth to be confirmed before setting up listeners
        this.waitForAuth().then(() => {
            // Verify user is still authenticated
            const currentUserId = this.getCurrentUserId();
            if (!currentUserId) {
                console.error('❌ [Admins] User not authenticated after wait - redirecting to login');
                window.location.href = '/auth/login.html';
                return;
            }
            
            console.log(`✅ [Admins] User authenticated: ${currentUserId} - Initializing`);
            
            this.bindEvents();
            this.initModal();
            this.showLoading();
            // Wait for Firebase to be ready
            return this.waitForFirebase();
        }).then(() => {
            // LAZY LOAD: Initialize real-time listener only after page is visible/interactive
            // This improves initial page load performance by deferring Firebase listener setup
            this.loadAdminsLazy();
            // Check if we should open edit modal from URL hash (e.g., #edit-{adminId})
            // Use setTimeout to ensure listener has time to load data first
            setTimeout(() => {
                this.checkUrlHash();
            }, 1000);
        }).catch(error => {
            console.error('Firebase initialization error:', error);
            
            // If user is not authenticated, redirect to login page
            if (error.message && error.message.includes('not authenticated')) {
                console.warn('⚠️ [Admins] User not authenticated - redirecting to login');
                window.location.href = '/auth/login.html';
                return;
            }
            
            const tbody = document.getElementById('adminsTableBody');
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="5" class="empty-state" style="text-align: center; padding: 3rem; color: #ef4444;">
                            Error loading data. Please refresh the page.
                        </td>
                    </tr>
                `;
            }
        });
    }
    
    async waitForAuth() {
        // Wait for Firebase auth to be available and user to be authenticated
        // CRITICAL: Use onAuthStateChanged to ensure auth state is confirmed before proceeding
        let attempts = 0;
        const maxAttempts = 100; // Increased for slower devices
        
        while (attempts < maxAttempts) {
            try {
                // First check if firebase is available
                if (typeof firebase === 'undefined' || !firebase || !firebase.auth) {
                    // Firebase not loaded yet, wait and retry
                    await new Promise(resolve => setTimeout(resolve, 100));
                    attempts++;
                    continue;
                }
                
                // Try to access auth - it might throw if not initialized yet
                let authInstance;
                try {
                    // Check if auth is defined in global scope (from firebase-config.js)
                    if (typeof auth !== 'undefined' && auth) {
                        authInstance = auth;
                    } else {
                        // Fallback: get auth directly from firebase
                        authInstance = firebase.auth();
                    }
                } catch (initError) {
                    // Auth not initialized yet, wait and retry
                    if (initError.message && initError.message.includes('initialization')) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                        attempts++;
                        continue;
                    }
                    throw initError;
                }
                
                // Now check if user is authenticated
                if (authInstance && authInstance.currentUser && authInstance.currentUser.uid) {
                    // User is already logged in - fast path
                    this.currentUserId = authInstance.currentUser.uid;
                    console.log('✅ [Admins] User already authenticated (fast path):', authInstance.currentUser.uid);
                    return Promise.resolve();
                }
                
                // Wait for auth state to be confirmed via onAuthStateChanged
                return new Promise((resolve, reject) => {
                    let resolved = false;
                    let unsubscribeFn = null;
                    
                    const timeout = setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            if (unsubscribeFn) unsubscribeFn();
                            if (authInstance.currentUser && authInstance.currentUser.uid) {
                                this.currentUserId = authInstance.currentUser.uid;
                                console.log('✅ [Admins] User authenticated (timeout fallback):', authInstance.currentUser.uid);
                                resolve();
                            } else {
                                // Redirect to login page if not authenticated
                                window.location.href = '/auth/login.html';
                                reject(new Error('Auth state timeout - user authentication state not confirmed'));
                            }
                        }
                    }, 5000); // 5s timeout for auth state
                    
                    try {
                        unsubscribeFn = authInstance.onAuthStateChanged((user) => {
                            if (resolved) return;
                            clearTimeout(timeout);
                            resolved = true;
                            if (unsubscribeFn) unsubscribeFn(); // Stop listening after first state change
                            
                            if (user && user.uid) {
                                this.currentUserId = user.uid;
                                console.log('✅ [Admins] Auth state confirmed - User authenticated:', user.uid);
                                resolve();
                            } else {
                                console.error('❌ [Admins] Auth state confirmed - No user signed in');
                                // Redirect to login page immediately
                                window.location.href = '/auth/login.html';
                                reject(new Error('User not authenticated. Please log in.'));
                            }
                        });
                        
                        // Double-check if user logged in while setting up listener (race condition fix)
                        if (authInstance.currentUser && authInstance.currentUser.uid && !resolved) {
                            clearTimeout(timeout);
                            resolved = true;
                            if (unsubscribeFn) unsubscribeFn();
                            this.currentUserId = authInstance.currentUser.uid;
                            console.log('✅ [Admins] User authenticated (race condition fix):', authInstance.currentUser.uid);
                            resolve();
                        }
                    } catch (err) {
                        clearTimeout(timeout);
                        if (unsubscribeFn) unsubscribeFn();
                        if (!resolved) {
                            resolved = true;
                            reject(err);
                        }
                    }
                });
            } catch (error) {
                // Only log if it's not an initialization error (those are expected)
                if (!error.message || !error.message.includes('initialization')) {
                    console.warn('⚠️ [Admins] Auth check error (attempt ' + attempts + '):', error.message);
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        
        // If we get here, Firebase auth never became available
        console.error('❌ [Admins] Firebase auth not available after ' + maxAttempts + ' attempts - redirecting to login');
        window.location.href = '/auth/login.html';
        throw new Error('Firebase auth timeout - auth object not available after ' + maxAttempts + ' attempts');
    }
    
    checkUrlHash() {
        const hash = window.location.hash;
        if (hash && hash.startsWith('#edit-')) {
            const adminId = hash.substring(6); // Remove '#edit-' prefix
            if (adminId) {
                // Try to find the admin and open edit modal
                // Retry a few times in case admins are still loading
                let attempts = 0;
                const maxAttempts = 10;
                const checkAdmin = () => {
                    const admin = this.admins.find(a => a.id === adminId);
                    if (admin) {
                        this.openModal(adminId);
                        // Remove hash from URL after opening modal
                        window.history.replaceState(null, '', window.location.pathname);
                    } else if (attempts < maxAttempts) {
                        attempts++;
                        setTimeout(checkAdmin, 100); // Retry after 100ms
                    } else {
                        console.warn('Admin not found with id:', adminId);
                    }
                };
                checkAdmin();
            }
        }
    }
    
    async waitForFirebase() {
        // Wait for db to be available
        // Samsung Internet browser compatibility: more robust checking
        let attempts = 0;
        const maxAttempts = 100; // Increased for slower devices
        
        while (attempts < maxAttempts) {
            try {
                // Check if db is available and has collection method (not just defined)
                if (typeof db !== 'undefined' && db && typeof db.collection === 'function') {
                    console.log('✅ Firebase Firestore (db) is ready');
                    return Promise.resolve();
                }
            } catch (error) {
                console.warn('⚠️ Firebase check error (attempt ' + attempts + '):', error.message);
            }
            
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
        
        if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') {
            throw new Error('Firebase Firestore (db) is not initialized after ' + maxAttempts + ' attempts');
        }
    }
    
    showLoading() {
        const tbody = document.getElementById('adminsTableBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="empty-state" style="text-align: center; padding: 3rem;">
                        <div style="display: inline-block; width: 40px; height: 40px; border: 4px solid rgba(58, 10, 78, 0.2); border-top-color: #3a0a4e; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                        <p style="margin-top: 1rem; color: #94a3b8;">Loading admins...</p>
                    </td>
                </tr>
            `;
        }
        // Initialize filteredAdmins as empty array during loading
        this.filteredAdmins = [];
    }
    
    hideLoading() {
        // Loading state will be cleared when table is rendered with data
        // This method exists for compatibility and can be used to clear loading state if needed
        // No-op since renderTable() will replace the loading state
    }
    
    initModal() {
        this.modal = document.getElementById('newAdminModal');
        this.form = document.getElementById('newAdminForm');
        const newAdminBtn = document.getElementById('newAdminBtn');
        const closeModal = document.getElementById('closeModal');
        const cancelBtn = document.getElementById('cancelBtn');
        
        newAdminBtn.addEventListener('click', () => this.openModal());
        closeModal.addEventListener('click', () => this.closeModal());
        cancelBtn.addEventListener('click', () => this.closeModal());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.closeModal();
            }
        });
        
        // Listen for admin type changes to show/hide quota field
        const adminTypeSelect = document.getElementById('adminType');
        if (adminTypeSelect) {
            adminTypeSelect.addEventListener('change', () => this.handleAdminTypeChange());
        }
        
        // Normalize phone number on blur (when user leaves the field)
        const adminPhoneInput = document.getElementById('adminPhone');
        if (adminPhoneInput) {
            adminPhoneInput.addEventListener('blur', (e) => {
                const normalized = this.normalizePhoneNumber(e.target.value);
                if (normalized && normalized !== e.target.value) {
                    e.target.value = normalized;
                }
            });
        }
        
        this.form.addEventListener('submit', (e) => this.handleSubmit(e));
    }
    
    handleAdminTypeChange() {
        const adminType = document.getElementById('adminType').value;
        const quotaField = document.getElementById('adminQuota');
        const quotaLabel = quotaField ? quotaField.closest('.form-field') : null;
        
        if (adminType === 'Closed') {
            // Hide quota field for closed admins
            if (quotaLabel) {
                quotaLabel.style.display = 'none';
            }
            if (quotaField) {
                quotaField.required = false;
                quotaField.value = '';
            }
        } else {
            // Show quota field for open admins
            if (quotaLabel) {
                quotaLabel.style.display = '';
            }
            if (quotaField) {
                quotaField.required = true;
            }
        }
    }
    
    openModal(adminId = null) {
        this.editingAdminId = adminId;
        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden';
        this.form.reset();
        this.clearAllErrors();
        
        // Update modal title and button text
        const modalTitle = this.modal.querySelector('.modal-header h3');
        const submitBtn = this.form.querySelector('.btn-submit .btn-text');
        
        if (adminId) {
            // Edit mode - populate form with existing data
            modalTitle.textContent = 'Edit Admin';
            submitBtn.textContent = 'Update Admin';
            
            // Update password field label
            document.getElementById('passwordRequired').style.display = 'none';
            document.getElementById('passwordOptional').style.display = 'inline';
            document.getElementById('adminPassword').required = false;
            
            const admin = this.admins.find(a => a.id === adminId);
            if (admin) {
                document.getElementById('adminName').value = admin.name || '';
                document.getElementById('adminPhone').value = admin.phone || '';
                document.getElementById('adminType').value = admin.type || '';
                document.getElementById('adminPassword').value = ''; // Don't populate password for security
                document.getElementById('adminQuota').value = admin.quota || 0;
                document.getElementById('adminNotUShare').checked = admin.notUShare === true;
                // Handle quota field visibility based on type
                this.handleAdminTypeChange();
            }
        } else {
            // Create mode
            modalTitle.textContent = 'Add New Admin';
            submitBtn.textContent = 'Create Admin';
            
            // Update password field label
            document.getElementById('passwordRequired').style.display = 'inline';
            document.getElementById('passwordOptional').style.display = 'none';
            document.getElementById('adminPassword').required = true;
        }
    }
    
    closeModal() {
        this.modal.classList.remove('show');
        document.body.style.overflow = '';
        this.editingAdminId = null;
        setTimeout(() => {
            this.form.reset();
            this.clearAllErrors();
        }, 300);
    }
    
    clearAllErrors() {
        const errorFields = ['name', 'phone', 'type', 'password', 'quota'];
        errorFields.forEach(field => {
            const errorEl = document.getElementById(`${field}Error`);
            if (errorEl) errorEl.textContent = '';
        });
    }
    
    showError(field, message) {
        const errorEl = document.getElementById(`${field}Error`);
        if (errorEl) {
            errorEl.textContent = message;
        }
    }
    
    clearError(field) {
        const errorEl = document.getElementById(`${field}Error`);
        if (errorEl) {
            errorEl.textContent = '';
        }
    }
    
    validateForm() {
        let isValid = true;
        
        const name = document.getElementById('adminName').value.trim();
        let phone = document.getElementById('adminPhone').value.trim();
        const type = document.getElementById('adminType').value;
        const password = document.getElementById('adminPassword').value;
        const quota = document.getElementById('adminQuota').value.trim();
        
        // Normalize phone number: remove +961/961 prefix and spaces
        phone = this.normalizePhoneNumber(phone);
        
        // Validate name
        if (!name) {
            this.showError('name', 'Full name is required');
            isValid = false;
        } else if (name.length < 2) {
            this.showError('name', 'Name must be at least 2 characters');
            isValid = false;
        } else {
            this.clearError('name');
        }
        
        // Validate phone
        if (!phone) {
            this.showError('phone', 'Phone number is required');
            isValid = false;
        } else {
            this.clearError('phone');
        }
        
        // Validate type
        if (!type) {
            this.showError('type', 'Type is required');
            isValid = false;
        } else {
            this.clearError('type');
        }
        
        // Validate password - required for new admins, optional for editing
        if (!this.editingAdminId) {
            // Creating new admin - password is required
            if (!password) {
                this.showError('password', 'Password is required');
                isValid = false;
            } else if (password.length < 6) {
                this.showError('password', 'Password must be at least 6 characters');
                isValid = false;
            } else {
                this.clearError('password');
            }
        } else {
            // Editing admin - password is optional (only validate if provided)
            if (password && password.length < 6) {
                this.showError('password', 'Password must be at least 6 characters');
                isValid = false;
            } else {
                this.clearError('password');
            }
        }
        
        // Validate quota - only required for Open admins, not Closed
        if (type === 'Closed') {
            // Quota is not required for closed admins
            this.clearError('quota');
        } else {
            // Quota is required for open admins
            if (!quota) {
                this.showError('quota', 'Admin quota is required');
                isValid = false;
            } else if (isNaN(quota) || parseInt(quota) < 0) {
                this.showError('quota', 'Admin quota must be a valid number (0 or greater)');
                isValid = false;
            } else {
                this.clearError('quota');
            }
        }
        
        return isValid;
    }
    
    setLoading(loading) {
        const submitBtn = this.form.querySelector('.btn-submit');
        if (loading) {
            submitBtn.classList.add('loading');
            submitBtn.disabled = true;
        } else {
            submitBtn.classList.remove('loading');
            submitBtn.disabled = false;
        }
    }
    
    async handleSubmit(e) {
        e.preventDefault();
        
        if (!this.validateForm()) {
            return;
        }
        
        this.setLoading(true);
        
        try {
            const name = document.getElementById('adminName').value.trim();
            let phone = document.getElementById('adminPhone').value.trim();
            const type = document.getElementById('adminType').value;
            const password = document.getElementById('adminPassword').value;
            const quota = parseInt(document.getElementById('adminQuota').value.trim());
            const notUShare = document.getElementById('adminNotUShare').checked;
            
            // Normalize phone number: remove +961/961 prefix and spaces
            phone = this.normalizePhoneNumber(phone);
            
            // Get current user ID - CRITICAL for data isolation
            const currentUserId = this.getCurrentUserId();
            if (!currentUserId) {
                alert('⚠️ You must be logged in to create or edit admins.');
                this.setLoading(false);
                return;
            }
            
            // Prepare admin data
            const adminData = {
                name: name,
                phone: phone,
                type: type,
                status: type === 'Open' ? 'Open (Admin)' : 'Closed (Admin)',
                quota: quota,
                notUShare: notUShare,
                userId: currentUserId, // CRITICAL: Associate admin with current user
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            
            // Only include password if it's not empty (for edit mode)
            if (password) {
                // Note: Storing password in plain text is not recommended for production.
                // Consider using Firebase Authentication or hashing the password.
                adminData.password = password;
            }
            
            // Get auth token for API call
            const token = await this.getAuthToken();
            if (!token) {
                alert('⚠️ You must be logged in to create or edit admins.');
                this.setLoading(false);
                return;
            }
            
            // Get API base URL
            const apiBaseURL = window.AEFA_API_URL || window.ALFA_API_URL || 'https://cell-spott-manage-backend.onrender.com';
            
            if (this.editingAdminId) {
                // Update existing admin via API
                const response = await fetch(`${apiBaseURL}/api/admins/${this.editingAdminId}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        name: name,
                        phone: phone,
                        type: type,
                        password: password, // Only included if not empty
                        quota: quota,
                        notUShare: notUShare
                    })
                });
                
                // Handle both successful and error responses
                let result;
                try {
                    result = await response.json();
                } catch (jsonError) {
                    // If response is not JSON, get text
                    const errorText = await response.text();
                    console.error('❌ Non-JSON response:', errorText);
                    this.setLoading(false);
                    alert(`❌ Error: ${errorText || 'Failed to update admin'}`);
                    return;
                }
                
                if (!result.success) {
                    const errorMessage = result.error || 'Failed to update admin';
                    
                    // Check if it's a duplicate phone number error
                    if (response.status === 400 && (errorMessage.includes('phone number') || errorMessage.includes('phone'))) {
                        this.showError('phone', errorMessage);
                        // Also highlight the field
                        const phoneInput = document.getElementById('adminPhone');
                        if (phoneInput) {
                            phoneInput.focus();
                            phoneInput.style.borderColor = '#ef4444';
                        }
                        this.setLoading(false);
                        return;
                    }
                    // Check if it's a duplicate name error
                    else if (response.status === 400 && (errorMessage.includes('name already exists') || errorMessage.includes('name'))) {
                        this.showError('name', errorMessage);
                        // Also highlight the field
                        const nameInput = document.getElementById('adminName');
                        if (nameInput) {
                            nameInput.focus();
                            nameInput.style.borderColor = '#ef4444';
                        }
                        this.setLoading(false);
                        return;
                    } else {
                        // Generic error
                        console.error('❌ Update admin error:', errorMessage);
                        alert(`❌ ${errorMessage}`);
                        this.setLoading(false);
                        return;
                    }
                }
                
                // Close modal and refresh list
                this.closeModal();
                await this.loadAdmins();
                
                alert(`Admin "${name}" has been updated successfully!`);
            } else {
                // Create new admin via API (enforces admin limit)
                const response = await fetch(`${apiBaseURL}/api/admins`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        name: name,
                        phone: phone,
                        type: type,
                        password: password,
                        quota: quota,
                        notUShare: notUShare
                    })
                });
                
                // Handle both successful and error responses
                let result;
                try {
                    result = await response.json();
                } catch (jsonError) {
                    // If response is not JSON, get text
                    const errorText = await response.text();
                    console.error('❌ Non-JSON response:', errorText);
                    this.setLoading(false);
                    alert(`❌ Error: ${errorText || 'Failed to create admin'}`);
                    return;
                }
                
                if (!result.success) {
                    const errorMessage = result.error || 'Failed to create admin';
                    
                    // Check if it's an admin limit error
                    if (response.status === 403 && errorMessage.includes('admin limit')) {
                        alert(`❌ ${errorMessage}`);
                        this.setLoading(false);
                        return;
                    } 
                    // Check if it's a duplicate phone number error
                    else if (response.status === 400 && (errorMessage.includes('phone number') || errorMessage.includes('phone'))) {
                        this.showError('phone', errorMessage);
                        // Also highlight the field
                        const phoneInput = document.getElementById('adminPhone');
                        if (phoneInput) {
                            phoneInput.focus();
                            phoneInput.style.borderColor = '#ef4444';
                        }
                        this.setLoading(false);
                        return;
                    }
                    // Check if it's a duplicate name error
                    else if (response.status === 400 && (errorMessage.includes('name already exists') || errorMessage.includes('name'))) {
                        this.showError('name', errorMessage);
                        // Also highlight the field
                        const nameInput = document.getElementById('adminName');
                        if (nameInput) {
                            nameInput.focus();
                            nameInput.style.borderColor = '#ef4444';
                        }
                        this.setLoading(false);
                        return;
                    } else {
                        // Generic error
                        console.error('❌ Create admin error:', errorMessage);
                        alert(`❌ ${errorMessage}`);
                        this.setLoading(false);
                        return;
                    }
                }
                
                const newAdminId = result.adminId;
                
                // Close modal first
                this.closeModal();
                
                // Show loading message
                alert(`Admin "${name}" has been added! Fetching Alfa data... This may take a few seconds.`);
                
                // Fetch Alfa dashboard data and wait for it to complete
                try {
                    console.log(`🔄 Starting Alfa data fetch for ${name}...`);
                    await this.fetchAlfaDataForAdmin(newAdminId, phone, password, name);
                    console.log(`✅ Alfa data fetched and saved for ${name}`);
                    alert(`Admin "${name}" has been added successfully with real data!`);
                } catch (error) {
                    console.error('❌ Error fetching Alfa data:', error);
                    let errorMsg = `Admin "${name}" has been added, but failed to fetch Alfa data.`;
                    if (error.message.includes('not available') || error.message.includes('AlfaAPIService')) {
                        errorMsg += '\n\nPlease make sure the backend server is running (node server.js)';
                    } else {
                        errorMsg += `\n\nError: ${error.message}`;
                    }
                    errorMsg += '\n\nYou can refresh manually later using the refresh button.';
                    alert(errorMsg);
                }
                
                // Refresh the admins list to show the new admin
                await this.loadAdmins();
            }
            
        } catch (error) {
            console.error('Error saving admin:', error);
            let errorMessage = this.editingAdminId 
                ? 'Failed to update admin. Please try again.' 
                : 'Failed to create admin. Please try again.';
            
            if (error.code === 'permission-denied') {
                errorMessage = 'Permission denied. Please check your Firebase rules.';
            } else if (error.code === 'not-found') {
                errorMessage = 'Admin not found. It may have been deleted.';
            } else if (error.message) {
                errorMessage = error.message;
            }
            
            alert(errorMessage);
        } finally {
            this.setLoading(false);
        }
    }
    
    getStatusIndicator(admin) {
        // Determine status using the same logic as insights.js
        // RULE 1: Admin is active if ServiceNameValue contains "U-share Main"
        // RULE 2 (EXCEPTION): Admin is active if ServiceNameValue is "Mobile Internet" AND ValidityDateValue has a valid date
        // Otherwise, admin is inactive
        let status = 'inactive'; // Default to inactive
        const hasAlfaData = admin.alfaData && typeof admin.alfaData === 'object';
        
        if (hasAlfaData && admin.alfaData.primaryData) {
            try {
                const apiData = admin.alfaData.primaryData;
                
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
                console.warn(`⚠️ Error checking status from primaryData for admin ${admin.id}:`, statusError);
            }
        }
        
        // Fallback: Also check apiResponses if primaryData not available
        if (status === 'inactive' && hasAlfaData && admin.alfaData.apiResponses && Array.isArray(admin.alfaData.apiResponses)) {
            const getConsumptionResponse = admin.alfaData.apiResponses.find(resp => 
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
        
        // Fallback: Check direct status field if alfaData check didn't work
        if (status === 'inactive' && admin.status && String(admin.status).toLowerCase() === 'active') {
            status = 'active';
        }
        
        // Determine status color and icon
        let statusClass = 'status-indicator';
        let statusIcon = '';
        let tooltipText = '';
        
        if (status === 'inactive') {
            // Red: Inactive
            statusClass += ' status-inactive';
            statusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>`;
            tooltipText = 'Inactive';
        } else {
            // Green: Active
            statusClass += ' status-active';
            statusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>`;
            tooltipText = 'Active';
        }
        
        return `<div class="${statusClass}" title="${tooltipText}">
            ${statusIcon}
        </div>`;
    }
    
    bindEvents() {
        // Search input
        const searchInput = document.getElementById('adminSearch');
        const searchClear = document.getElementById('searchClear');
        
        searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.trim();
            this.applySearchFilter();
            this.currentPage = 1; // Reset to first page when searching
            this.renderTable();
            this.updatePagination();
            this.updatePageInfo();
            
            // Show/hide clear button
            if (this.searchQuery.length > 0) {
                searchClear.style.display = 'flex';
            } else {
                searchClear.style.display = 'none';
            }
        });
        
        // Clear search button
        searchClear.addEventListener('click', () => {
            searchInput.value = '';
            this.searchQuery = '';
            this.applySearchFilter();
            this.currentPage = 1;
            this.renderTable();
            this.updatePagination();
            this.updatePageInfo();
            searchClear.style.display = 'none';
            searchInput.focus();
        });
        
        // Rows per page
        document.getElementById('rowsPerPage').addEventListener('change', (e) => {
            this.rowsPerPage = parseInt(e.target.value);
            this.currentPage = 1;
            this.renderTable();
            this.updatePagination();
            this.updatePageInfo();
        });
        
        // Pagination buttons
        document.getElementById('prevPage').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
            }
        });
        
        document.getElementById('nextPage').addEventListener('click', () => {
            const totalPages = Math.ceil(this.filteredAdmins.length / this.rowsPerPage);
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
            }
        });
        
        // Dense toggle
        document.getElementById('denseToggle').addEventListener('change', (e) => {
            this.denseMode = e.target.checked;
            document.getElementById('denseSwitch').classList.toggle('active', this.denseMode);
            document.getElementById('adminsTable').classList.toggle('dense', this.denseMode);
        });
        
        // Initialize dense switch
        document.getElementById('denseSwitch').addEventListener('click', () => {
            const toggle = document.getElementById('denseToggle');
            toggle.checked = !toggle.checked;
            toggle.dispatchEvent(new Event('change'));
        });
        
        // Initialize table sorting
        this.initTableSorting();
    }
    
    initTableSorting() {
        const table = document.getElementById('adminsTable');
        if (!table) return;
        
        const headers = table.querySelectorAll('thead th[data-sort]');
        
        headers.forEach(header => {
            const field = header.getAttribute('data-sort');
            
            // Add sortable class if not already present
            if (!header.classList.contains('sortable')) {
                header.classList.add('sortable');
            }
            
            // Add sort icon if not present
            if (!header.querySelector('.sort-icon')) {
                const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                icon.classList.add('sort-icon');
                icon.setAttribute('viewBox', '0 0 24 24');
                icon.setAttribute('fill', 'none');
                icon.setAttribute('stroke', 'currentColor');
                icon.setAttribute('stroke-width', '2');
                icon.innerHTML = '<path d="M12 16V8M12 16l-4-4M12 16l4-4"/>';
                
                // If header has no child elements, append icon directly to preserve structure
                if (header.children.length === 0) {
                    const text = header.textContent.trim();
                    header.textContent = '';
                    header.appendChild(document.createTextNode(text));
                }
                header.appendChild(icon);
            }
            
            // Add click handler
            header.addEventListener('click', () => {
                // Remove active class from all headers
                headers.forEach(h => {
                    h.classList.remove('sort-active', 'sort-asc', 'sort-desc');
                    const icon = h.querySelector('.sort-icon');
                    if (icon) {
                        icon.classList.remove('sort-asc', 'sort-desc');
                    }
                });
                
                // Toggle direction if same field, otherwise set to asc
                if (this.sortField === field) {
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortField = field;
                    this.sortDirection = 'asc';
                }
                
                // Update header
                header.classList.add('sort-active', `sort-${this.sortDirection}`);
                const icon = header.querySelector('.sort-icon');
                if (icon) {
                    icon.classList.add(`sort-${this.sortDirection}`);
                    if (this.sortDirection === 'asc') {
                        icon.innerHTML = '<path d="M12 5v14M12 5l4 4M12 5L8 9"/>';
                    } else {
                        icon.innerHTML = '<path d="M12 19V5M12 19l-4-4M12 19l4-4"/>';
                    }
                }
                
                // Apply filters and re-render
                this.applySearchFilter();
                this.renderTable();
                this.updatePagination();
                this.updatePageInfo();
            });
        });
        
        // Set initial sort state (name, asc)
        const nameHeader = table.querySelector('th[data-sort="name"]');
        if (nameHeader) {
            nameHeader.classList.add('sort-active', 'sort-asc');
            const icon = nameHeader.querySelector('.sort-icon');
            if (icon) {
                icon.classList.add('sort-asc');
                icon.innerHTML = '<path d="M12 5v14M12 5l4 4M12 5L8 9"/>';
            }
        }
    }
    
    applySearchFilter() {
        if (!this.searchQuery) {
            this.filteredAdmins = [...this.admins];
            return;
        }
        
        const query = this.searchQuery.toLowerCase();
        this.filteredAdmins = this.admins.filter(admin => {
            const name = (admin.name || '').toLowerCase();
            const phone = (admin.phone || '').toLowerCase();
            return name.includes(query) || phone.includes(query);
        });
        
        // Apply sorting after filtering
        this.filteredAdmins = this.sortAdmins(this.filteredAdmins);
    }
    
    sortAdmins(admins) {
        const sorted = [...admins];
        
        sorted.sort((a, b) => {
            let aVal, bVal;
            
            switch(this.sortField) {
                case 'name':
                    aVal = (a.name || '').toLowerCase();
                    bVal = (b.name || '').toLowerCase();
                    break;
                case 'phone':
                    aVal = (a.phone || '').toLowerCase();
                    bVal = (b.phone || '').toLowerCase();
                    break;
                case 'status':
                    aVal = (a.status || '').toLowerCase();
                    bVal = (b.status || '').toLowerCase();
                    break;
                default:
                    aVal = '';
                    bVal = '';
            }
            
            if (this.sortDirection === 'asc') {
                return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
            } else {
                return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
            }
        });
        
        return sorted;
    }
    
    renderTable() {
        const tbody = document.getElementById('adminsTableBody');
        
        if (this.admins.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                            <circle cx="12" cy="7" r="4"/>
                        </svg>
                        <p>No admins found. Add your first admin to get started.</p>
                    </td>
                </tr>
            `;
            return;
        }
        
        if (this.filteredAdmins.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"/>
                            <path d="m21 21-4.35-4.35"/>
                        </svg>
                        <p>No admins found matching "${this.searchQuery}"</p>
                    </td>
                </tr>
            `;
            return;
        }
        
        const startIndex = (this.currentPage - 1) * this.rowsPerPage;
        const endIndex = startIndex + this.rowsPerPage;
        const pageAdmins = this.filteredAdmins.slice(startIndex, endIndex);
        
        tbody.innerHTML = pageAdmins.map(admin => `
            <tr>
                <td class="status-indicator-cell">
                    ${this.getStatusIndicator(admin)}
                </td>
                <td>${admin.name}</td>
                <td>${admin.phone}</td>
                <td><span class="status-badge">${admin.status}</span></td>
                <td>
                    <div class="action-buttons">
                        <button class="action-btn edit" data-admin-id="${admin.id}" aria-label="Edit">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="m11.4 18.161l7.396-7.396a10.3 10.3 0 0 1-3.326-2.234a10.3 10.3 0 0 1-2.235-3.327L5.839 12.6c-.577.577-.866.866-1.114 1.184a6.6 6.6 0 0 0-.749 1.211c-.173.364-.302.752-.56 1.526l-1.362 4.083a1.06 1.06 0 0 0 1.342 1.342l4.083-1.362c.775-.258 1.162-.387 1.526-.56q.647-.308 1.211-.749c.318-.248.607-.537 1.184-1.114m9.448-9.448a3.932 3.932 0 0 0-5.561-5.561l-.887.887l.038.111a8.75 8.75 0 0 0 2.092 3.32a8.75 8.75 0 0 0 3.431 2.13z"/>
                            </svg>
                        </button>
                        <button class="action-btn delete" data-admin-id="${admin.id}" aria-label="Delete">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 6.386c0-.484.345-.877.771-.877h2.665c.529-.016.996-.399 1.176-.965l.03-.1l.115-.391c.07-.24.131-.45.217-.637c.338-.739.964-1.252 1.687-1.383c.184-.033.378-.033.6-.033h3.478c.223 0 .417 0 .6.033c.723.131 1.35.644 1.687 1.383c.086.187.147.396.218.637l.114.391l.03.1c.18.566.74.95 1.27.965h2.57c.427 0 .772.393.772.877s-.345.877-.771.877H3.77c-.425 0-.77-.393-.77-.877"/>
                                <path d="M11.596 22h.808c2.783 0 4.174 0 5.08-.886c.904-.886.996-2.339 1.181-5.245l.267-4.188c.1-1.577.15-2.366-.303-2.865c-.454-.5-1.22-.5-2.753-.5H8.124c-1.533 0-2.3 0-2.753.5s-.404 1.288-.303 2.865l.267 4.188c.185 2.906.277 4.36 1.182 5.245c.905.886 2.296.886 5.079.886m-1.35-9.811c-.04-.434-.408-.75-.82-.707c-.413.043-.713.43-.672.864l.5 5.263c.04.434.408.75.82.707c.413-.043.713-.43.672-.864zm4.329-.707c.412.043.713.43.671.864l-.5 5.263c-.04.434-.409.75-.82.707c-.413-.043-.713-.43-.672-.864l.5-5.263c.04-.434.409-.75.82-.707"/>
                            </svg>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
        
        // Bind edit button events
        tbody.querySelectorAll('.action-btn.edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const adminId = btn.dataset.adminId;
                this.editAdmin(adminId);
            });
        });
        
        // Bind delete button events
        tbody.querySelectorAll('.action-btn.delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const adminId = btn.dataset.adminId;
                this.deleteAdmin(adminId);
            });
        });
    }
    
    // Removed selectAllRows - using status indicators instead
    
    updatePagination() {
        const totalPages = Math.ceil(this.filteredAdmins.length / this.rowsPerPage);
        document.getElementById('prevPage').disabled = this.currentPage === 1;
        document.getElementById('nextPage').disabled = this.currentPage === totalPages || totalPages === 0;
    }
    
    updatePageInfo() {
        if (this.filteredAdmins.length === 0) {
            document.getElementById('pageInfo').textContent = '0 of 0';
            return;
        }
        const startIndex = (this.currentPage - 1) * this.rowsPerPage + 1;
        const endIndex = Math.min(this.currentPage * this.rowsPerPage, this.filteredAdmins.length);
        const total = this.filteredAdmins.length;
        const displayTotal = this.searchQuery ? `${total} (filtered)` : total;
        document.getElementById('pageInfo').textContent = `${startIndex}–${endIndex} of ${displayTotal}`;
    }
    
    editAdmin(id) {
        const admin = this.admins.find(a => a.id === id);
        if (admin) {
            this.openModal(id);
        } else {
            console.error('Admin not found with id:', id);
        }
    }
    
    async deleteAdmin(id) {
        const admin = this.admins.find(a => a.id === id);
        if (!admin) {
            console.error('Admin not found with id:', id);
            alert('Error: Admin not found.');
            return;
        }
        
        if (!confirm(`Are you sure you want to delete "${admin.name}"?`)) {
            return;
        }
        
        try {
            // Get auth token for API call
            const token = await this.getAuthToken();
            if (!token) {
                alert('⚠️ You must be logged in to delete admins.');
                return;
            }
            
            // Get API base URL
            const apiBaseURL = window.AEFA_API_URL || window.ALFA_API_URL || 'https://cell-spott-manage-backend.onrender.com';
            
            // Delete admin via API (also updates adminCount)
            const response = await fetch(`${apiBaseURL}/api/admins/${id}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            const result = await response.json();
            
            if (!result.success) {
                throw new Error(result.error || 'Failed to delete admin');
            }
            
            await this.loadAdmins();
            alert(`Admin "${admin.name}" has been deleted successfully!`);
        } catch (error) {
            console.error('Error deleting admin:', error);
            let errorMessage = 'Failed to delete admin. Please try again.';
            
            if (error.message) {
                errorMessage = error.message;
            }
            
            alert(errorMessage);
        }
    }
    
    /**
     * Fetch Alfa dashboard data for a newly created admin
     * @param {string} adminId - Admin document ID
     * @param {string} phone - Alfa phone number
     * @param {string} password - Alfa password
     * @param {string} name - Admin name (for logging)
     */
    async fetchAlfaDataForAdmin(adminId, phone, password, name) {
        // Check if AlfaAPIService is available
        if (typeof window.AlfaAPIService === 'undefined' || !window.AlfaAPIService) {
            throw new Error('AlfaAPIService not loaded. Make sure backend server is running and alfa-api.js is loaded.');
        }
        
        console.log(`📡 Fetching Alfa data for admin: ${name} (${phone})`);
        
        try {
            // Check backend health first
            const isHealthy = await window.AlfaAPIService.checkHealth();
            if (!isHealthy) {
                throw new Error('Backend server is not responding. Please make sure the server is running (node server.js)');
            }
            
            console.log('✅ Backend server is healthy');
            
            // Fetch Alfa data
            const alfaResponse = await window.AlfaAPIService.fetchDashboardData(phone, password, adminId);
            
            if (!alfaResponse) {
                throw new Error('No data returned from backend');
            }
            
            // Extract actual data from response (could be at root level or in .data property)
            const alfaData = alfaResponse.data || alfaResponse;
            
            if (!alfaData) {
                throw new Error('No data in response');
            }
            
            console.log('✅ Alfa data received:', {
                hasBalance: !!alfaData.balance,
                hasTotalConsumption: !!alfaData.totalConsumption,
                hasAdminConsumption: !!alfaData.adminConsumption,
                hasPrimaryData: !!alfaData.primaryData,
                subscribersCount: alfaData.subscribersCount
            });
            
            // Update admin document with Alfa data
            console.log('💾 Saving Alfa data to Firestore for admin:', adminId);
            
            // CRITICAL: Ensure primaryData has ServiceInformationValue as an array (required for status determination)
            // This prevents new admins from being incorrectly marked as inactive on first add
            if (alfaData && typeof alfaData === 'object') {
                if (alfaData.primaryData && typeof alfaData.primaryData === 'object') {
                    // Ensure ServiceInformationValue exists as an array (even if empty)
                    // This is required for the frontend status check to work correctly
                    if (!alfaData.primaryData.ServiceInformationValue || !Array.isArray(alfaData.primaryData.ServiceInformationValue)) {
                        alfaData.primaryData.ServiceInformationValue = Array.isArray(alfaData.primaryData.ServiceInformationValue) 
                            ? alfaData.primaryData.ServiceInformationValue 
                            : [];
                        console.log('🔧 [Frontend Save] Ensured primaryData.ServiceInformationValue is an array (length:', alfaData.primaryData.ServiceInformationValue.length, ')');
                    } else {
                        console.log('✅ [Frontend Save] primaryData.ServiceInformationValue exists as array (length:', alfaData.primaryData.ServiceInformationValue.length, ')');
                    }
                } else if (!alfaData.primaryData) {
                    // If primaryData is missing entirely, create it with empty ServiceInformationValue array
                    // This ensures the structure exists for status checking (admin will be inactive but structure is correct)
                    alfaData.primaryData = { ServiceInformationValue: [] };
                    console.log('⚠️ [Frontend Save] WARNING: primaryData was missing! Created with empty ServiceInformationValue array - admin will be marked inactive');
                }
            }
            
            // Log the structure for debugging
            if (alfaData.primaryData && alfaData.primaryData.ServiceInformationValue) {
                console.log('📊 [Frontend Save] primaryData.ServiceInformationValue structure verified:', {
                    isArray: Array.isArray(alfaData.primaryData.ServiceInformationValue),
                    length: alfaData.primaryData.ServiceInformationValue.length,
                    firstService: alfaData.primaryData.ServiceInformationValue[0] ? 
                        (alfaData.primaryData.ServiceInformationValue[0].ServiceNameValue || 'N/A') : 'none'
                });
            } else {
                console.warn('⚠️ [Frontend Save] WARNING: primaryData or ServiceInformationValue is missing!');
            }
            
            // Small delay to let backend save complete first (backend save is async via process.nextTick)
            // This reduces chance of frontend overwriting backend save
            await new Promise(resolve => setTimeout(resolve, 500));
            
            await db.collection('admins').doc(adminId).update({
                alfaData: alfaData,
                alfaDataFetchedAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            console.log('✅ Alfa data saved to Firestore successfully (frontend save completed)');
            
            // Trigger a refresh of the insights page if it's open
            window.dispatchEvent(new CustomEvent('alfaDataUpdated', { 
                detail: { adminId: adminId, timestamp: Date.now() } 
            }));
            
            return alfaData;
        } catch (error) {
            console.error('❌ Error in fetchAlfaDataForAdmin:', error);
            throw error;
        }
    }
    
}

// Initialize when DOM is ready
let adminsManager;
document.addEventListener('DOMContentLoaded', () => {
    adminsManager = new AdminsManager();
});



