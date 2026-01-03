class AIAssistantLoginForm {
    constructor() {
        this.form = document.getElementById('loginForm');
        this.emailInput = document.getElementById('email');
        this.passwordInput = document.getElementById('password');
        this.passwordToggle = document.getElementById('passwordToggle');
        this.submitButton = this.form.querySelector('.submit-button-modern');
        this.successMessage = document.getElementById('successMessage');
        
        this.init();
    }
    
    init() {
        this.bindEvents();
        this.setupPasswordToggle();
    }
    
    bindEvents() {
        this.form.addEventListener('submit', (e) => this.handleSubmit(e));
        this.emailInput.addEventListener('blur', () => this.validateEmail());
        this.passwordInput.addEventListener('blur', () => this.validatePassword());
        this.emailInput.addEventListener('input', () => this.clearError('email'));
        this.passwordInput.addEventListener('input', () => this.clearError('password'));
    }
    
    setupPasswordToggle() {
        if (this.passwordToggle) {
            this.passwordToggle.addEventListener('click', () => {
                const type = this.passwordInput.type === 'password' ? 'text' : 'password';
                this.passwordInput.type = type;
                this.passwordToggle.classList.toggle('active', type === 'text');
            });
        }
    }
    
    validateEmail() {
        const email = this.emailInput.value.trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        
        if (!email) {
            this.showError('email', 'Email address is required');
            return false;
        }
        
        if (!emailRegex.test(email)) {
            this.showError('email', 'Invalid email format');
            return false;
        }
        
        this.clearError('email');
        return true;
    }
    
    validatePassword() {
        const password = this.passwordInput.value;
        
        if (!password) {
            this.showError('password', 'Password is required');
            return false;
        }
        
        this.clearError('password');
        return true;
    }
    
    showError(field, message) {
        const formField = document.getElementById(field)?.closest('.form-field-modern');
        const errorElement = document.getElementById(`${field}Error`);
        
        if (formField) {
            formField.classList.add('error');
        }
        if (errorElement) {
            errorElement.textContent = message;
            errorElement.classList.add('show');
        }
    }
    
    clearError(field) {
        const formField = document.getElementById(field)?.closest('.form-field-modern');
        const errorElement = document.getElementById(`${field}Error`);
        
        if (formField) {
            formField.classList.remove('error');
        }
        if (errorElement) {
            errorElement.classList.remove('show');
            setTimeout(() => {
                errorElement.textContent = '';
            }, 200);
        }
    }
    
    async handleSubmit(e) {
        e.preventDefault();
        
        // DEBUG: Force console log to verify file is loaded
        console.log('[LOGIN] handleSubmit called - login.js v2 loaded');
        
        const isEmailValid = this.validateEmail();
        const isPasswordValid = this.validatePassword();
        
        if (!isEmailValid || !isPasswordValid) {
            return;
        }
        
        this.setLoading(true);
        
        try {
            const email = this.emailInput.value.trim();
            const password = this.passwordInput.value;
            
            // Sign in with Firebase Authentication
            const userCredential = await auth.signInWithEmailAndPassword(email, password);
            const user = userCredential.user;
            
            // IMPORTANT: Check if user is approved BEFORE allowing access
            console.log('[LOGIN CHECK] Starting approval check for user:', user.uid);
            const userDoc = await db.collection('users').doc(user.uid).get();
            
            if (!userDoc.exists) {
                console.log('[LOGIN CHECK] User document does not exist - blocking login');
                await auth.signOut();
                localStorage.clear();
                sessionStorage.clear();
                throw new Error('Please contact 71829887');
            }
            
            const userData = userDoc.data();
            console.log('[LOGIN CHECK] User data retrieved:', { isApproved: userData.isApproved, isBlocked: userData.isBlocked });
            const isApproved = userData.isApproved === true; // Must be explicitly true
            
            // Check approval status FIRST
            if (!isApproved) {
                console.log('[LOGIN CHECK] User NOT approved - blocking login and signing out');
                await auth.signOut();
                localStorage.clear();
                sessionStorage.clear();
                throw new Error('Please contact 71829887');
            }
            
            console.log('[LOGIN CHECK] User is approved, checking block status...');
            
            // Check if user is blocked
            if (userData.isBlocked === true) {
                console.log('[LOGIN CHECK] User is blocked - signing out');
                await auth.signOut();
                localStorage.clear();
                sessionStorage.clear();
                throw new Error('Your account has been blocked. Please contact support.');
            }
            
            console.log('[LOGIN CHECK] All checks passed, allowing login');
            
            // Show neural success
            this.showNeuralSuccess();
        } catch (error) {
            console.error('Login error:', error);
            let errorMessage = 'Login failed. Please check your credentials.';
            
            // Handle specific Firebase errors
            if (error.code === 'auth/user-not-found') {
                errorMessage = 'No account found with this email.';
                this.showError('email', errorMessage);
            } else if (error.code === 'auth/wrong-password') {
                errorMessage = 'Incorrect password.';
                this.showError('password', errorMessage);
            } else if (error.code === 'auth/invalid-email') {
                errorMessage = 'Invalid email address.';
                this.showError('email', errorMessage);
            } else if (error.code === 'auth/user-disabled') {
                errorMessage = 'This account has been disabled.';
                this.showError('email', errorMessage);
            } else if (error.message && error.message.includes('Please contact')) {
                errorMessage = error.message;
                this.showError('email', errorMessage);
            } else if (error.message && error.message.includes('blocked')) {
                errorMessage = error.message;
                this.showError('email', errorMessage);
            } else {
                this.showError('password', errorMessage);
            }
        } finally {
            this.setLoading(false);
        }
    }
    
    setLoading(loading) {
        this.submitButton.classList.toggle('loading', loading);
        this.submitButton.disabled = loading;
    }
    
    showNeuralSuccess() {
        // Hide form with transition
        this.form.style.opacity = '0';
        this.form.style.transform = 'translateY(-20px)';
        this.form.style.transition = 'all 0.3s ease';
        
        const formFooter = document.querySelector('.form-footer-modern');
        if (formFooter) {
            formFooter.style.display = 'none';
        }
        
        setTimeout(() => {
            this.form.style.display = 'none';
            
            // Show success message
            if (this.successMessage) {
                this.successMessage.classList.add('show');
            }
            
        }, 300);
        
        // Redirect to home page after success
        setTimeout(() => {
            window.location.href = '/pages/home.html';
        }, 1500);
    }
}

// Initialize the neural form when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new AIAssistantLoginForm();
});

