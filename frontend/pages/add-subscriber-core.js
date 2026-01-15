// Add Subscriber Page - Core Class Definition
class AddSubscriberPageManager {
    constructor() {
        this.subscribers = [];
        this.currentUserId = null;
        this.isSubmittingAddForm = false;
        this.unsubscribe = null;
    }
    
    async init() {
        console.log('🚀 [Add Subscriber] Initializing page...');
        this.showPageLoading('Loading page...');
        
        try {
            await this.waitForAuth();
            await this.waitForFirebase();
            
            this.currentUserId = this.getCurrentUserId();
            if (!this.currentUserId) {
                console.error('❌ [Add Subscriber] User not authenticated after wait - redirecting to login');
                window.location.href = '/auth/login.html';
                return;
            }
            
            console.log('✅ [Add Subscriber] User authenticated:', this.currentUserId);
            
            // LAZY LOAD: Load admins data only after page is visible/interactive
            // This improves initial page load performance by deferring Firebase listener setup
            this.loadAdminsLazy();
            
            // Initialize the form
            this.initAddSubscribersPage();
            
        } catch (error) {
            console.error('❌ [Add Subscriber] Initialization error:', error);
            alert('Error initializing page: ' + error.message);
            window.location.href = '/auth/login.html';
        } finally {
            this.hidePageLoading();
        }
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
    
    formatDate(date) {
        if (!date) return 'N/A';
        const d = new Date(date);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
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
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
    }
}

