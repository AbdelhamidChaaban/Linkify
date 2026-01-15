// Edit Subscriber Page - Core Class Definition
class EditSubscriberPageManager {
    constructor() {
        this.subscribers = [];
        this.currentUserId = null;
        this.isSubmittingEditForm = false;
        this.unsubscribe = null;
        this.editingAdminId = null; // Admin ID being edited (from URL query parameter)
    }
    
    async init() {
        console.log('🚀 [Edit Subscriber] Initializing page...');
        this.showPageLoading('Loading page...');
        
        try {
            await this.waitForAuth();
            await this.waitForFirebase();
            
            this.currentUserId = this.getCurrentUserId();
            if (!this.currentUserId) {
                console.error('❌ [Edit Subscriber] User not authenticated after wait - redirecting to login');
                window.location.href = '/auth/login.html';
                return;
            }
            
            console.log('✅ [Edit Subscriber] User authenticated:', this.currentUserId);
            
            // Get adminId from URL query parameter
            const urlParams = new URLSearchParams(window.location.search);
            const adminId = urlParams.get('id') || urlParams.get('adminId');
            
            if (!adminId) {
                console.error('❌ [Edit Subscriber] No admin ID provided in URL');
                alert('Error: No admin ID provided. Redirecting to Insights...');
                window.location.href = '/pages/insights.html';
                return;
            }
            
            this.editingAdminId = adminId;
            console.log('📋 [Edit Subscriber] Editing admin:', adminId);
            
            // IMMEDIATE LOAD: For edit page, we need data immediately - no lazy loading
            // User came specifically to edit this admin, so load data right away
            this.loadAdmins();
            
            // Initialize the form (will be populated when data loads)
            this.initEditSubscribersPage();
            
        } catch (error) {
            console.error('❌ [Edit Subscriber] Initialization error:', error);
            this.hidePageLoading();
            alert('Error initializing page: ' + error.message);
            window.location.href = '/auth/login.html';
        }
        // NOTE: Don't hide loading in finally block - keep it visible until data is loaded
    }
    
    getCurrentUserId() {
        if (typeof auth !== 'undefined' && auth && auth.currentUser) {
            return auth.currentUser.uid;
        }
        return null;
    }
    
    async waitForAuth() {
        let attempts = 0;
        while (attempts < 50) {
            if (typeof auth !== 'undefined' && auth) {
                return new Promise((resolve, reject) => {
                    const unsubscribe = auth.onAuthStateChanged((user) => {
                        unsubscribe();
                        if (user && user.uid) {
                            this.currentUserId = user.uid;
                            resolve();
                        } else {
                            reject(new Error('User not authenticated'));
                        }
                    });
                    if (auth.currentUser && auth.currentUser.uid) {
                        this.currentUserId = auth.currentUser.uid;
                        unsubscribe();
                        resolve();
                    }
                });
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        throw new Error('Auth timeout');
    }
    
    async waitForFirebase() {
        let attempts = 0;
        while (typeof db === 'undefined' && attempts < 50) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
        if (typeof db === 'undefined') {
            throw new Error('Firestore not initialized');
        }
    }
    
    normalizePhoneNumber(phone) {
        if (!phone) return phone;
        let cleaned = phone.trim().replace(/\s+/g, '');
        if (cleaned.startsWith('+961')) {
            cleaned = cleaned.substring(4);
        } else if (cleaned.startsWith('961') && cleaned.length >= 11) {
            cleaned = cleaned.substring(3);
        }
        return cleaned.replace(/\D/g, '');
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    showPageLoading(message = 'Loading...') {
        // Create loading overlay if it doesn't exist
        let loadingOverlay = document.getElementById('pageLoadingOverlay');
        if (!loadingOverlay) {
            loadingOverlay = document.createElement('div');
            loadingOverlay.id = 'pageLoadingOverlay';
            loadingOverlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(13, 17, 32, 0.95);
                backdrop-filter: blur(4px);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                flex-direction: column;
                gap: 1rem;
            `;
            document.body.appendChild(loadingOverlay);
        }
        
        loadingOverlay.innerHTML = `
            <div class="page-loading-spinner">
                <div class="refresh-loading">
                    <div class="loader">
                        <div class="inner one"></div>
                        <div class="inner two"></div>
                        <div class="inner three"></div>
                    </div>
                </div>
                <p style="color: #f8fafc; font-size: 1rem; margin-top: 1.5rem; text-align: center;">${this.escapeHtml(message)}</p>
            </div>
        `;
        loadingOverlay.style.display = 'flex';
    }
    
    hidePageLoading() {
        const loadingOverlay = document.getElementById('pageLoadingOverlay');
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
    }
    
    async copyToClipboard(text) {
        try {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            document.body.appendChild(textArea);
            textArea.select();
            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);
            if (successful) return true;
        } catch (err) {}
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (err) {}
        return false;
    }
    
    destroy() {
        // Cleanup Firebase listener
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
    }
}

