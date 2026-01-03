class AIAssistantSignupForm {
    constructor() {
        this.form = document.getElementById('signupForm');
        this.nameInput = document.getElementById('name');
        this.emailInput = document.getElementById('email');
        this.phoneInput = document.getElementById('phone');
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
        this.nameInput.addEventListener('blur', () => this.validateName());
        this.emailInput.addEventListener('blur', () => this.validateEmail());
        this.phoneInput.addEventListener('blur', () => this.validatePhone());
        this.passwordInput.addEventListener('blur', () => this.validatePassword());
        this.nameInput.addEventListener('input', () => this.clearError('name'));
        this.emailInput.addEventListener('input', () => this.clearError('email'));
        this.phoneInput.addEventListener('input', () => this.clearError('phone'));
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
    
    validateName() {
        const name = this.nameInput.value.trim();
        
        if (!name) {
            this.showError('name', 'Name is required');
            return false;
        }
        
        if (name.length < 2) {
            this.showError('name', 'Name must be at least 2 characters');
            return false;
        }
        
        this.clearError('name');
        return true;
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
    
    validatePhone() {
        const phone = this.phoneInput.value.trim();
        
        if (!phone) {
            this.showError('phone', 'Phone number is required');
            return false;
        }
        
        this.clearError('phone');
        return true;
    }
    
    validatePassword() {
        const password = this.passwordInput.value;
        
        if (!password) {
            this.showError('password', 'Password is required');
            return false;
        }
        
        if (password.length < 6) {
            this.showError('password', 'Password must be at least 6 characters');
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
        
        const isNameValid = this.validateName();
        const isEmailValid = this.validateEmail();
        const isPhoneValid = this.validatePhone();
        const isPasswordValid = this.validatePassword();
        
        if (!isNameValid || !isEmailValid || !isPhoneValid || !isPasswordValid) {
            return;
        }
        
        this.setLoading(true);
        
        try {
            const email = this.emailInput.value.trim();
            const password = this.passwordInput.value;
            const name = this.nameInput.value.trim();
            const phone = this.phoneInput.value.trim();
            
            // Create user with Firebase Authentication
            const userCredential = await auth.createUserWithEmailAndPassword(email, password);
            const user = userCredential.user;
            
            // Save additional user information to Firestore
            await db.collection('users').doc(user.uid).set({
                name: name,
                email: email,
                phone: phone,
                adminCount: 0, // Initialize admin count
                isApproved: false, // New users require owner approval
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            // Show success
            this.showNeuralSuccess();
        } catch (error) {
            console.error('Signup error:', error);
            let errorMessage = 'Account creation failed. Please try again.';
            
            // Handle specific Firebase errors
            if (error.code === 'auth/email-already-in-use') {
                errorMessage = 'This email is already registered.';
                this.showError('email', errorMessage);
            } else if (error.code === 'auth/weak-password') {
                errorMessage = 'Password should be at least 6 characters.';
                this.showError('password', errorMessage);
            } else if (error.code === 'auth/invalid-email') {
                errorMessage = 'Invalid email address.';
                this.showError('email', errorMessage);
            } else {
                this.showError('email', errorMessage);
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
        
        setTimeout(() => {
            this.form.style.display = 'none';
            
            // Show success message
            if (this.successMessage) {
                this.successMessage.classList.add('show');
            }
            
        }, 300);
        
        // Redirect to login page after success
        setTimeout(() => {
            window.location.href = '/auth/login.html';
        }, 2500);
    }
}

// Initialize the signup form when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new AIAssistantSignupForm();
});
