/**
 * Owner Login Handler
 */
class OwnerLogin {
    constructor() {
        this.form = document.getElementById('ownerLoginForm');
        this.usernameInput = document.getElementById('ownerUsername');
        this.passwordInput = document.getElementById('ownerPassword');
        this.passwordToggle = document.getElementById('passwordToggle');
        this.submitBtn = document.getElementById('submitBtn');
        this.errorMessage = document.getElementById('errorMessage');
        this.baseURL = window.ALFA_API_URL || 'http://localhost:3000';
        
        this.init();
    }
    
    init() {
        this.bindEvents();
    }
    
    bindEvents() {
        // Form submission
        if (this.form) {
            this.form.addEventListener('submit', (e) => this.handleSubmit(e));
        }
        
        // Password toggle
        if (this.passwordToggle) {
            this.passwordToggle.addEventListener('click', () => this.togglePassword());
        }
    }
    
    togglePassword() {
        const isPassword = this.passwordInput.type === 'password';
        this.passwordInput.type = isPassword ? 'text' : 'password';
        
        const eyeIcon = this.passwordToggle.querySelector('.eye-icon');
        const eyeOffIcon = this.passwordToggle.querySelector('.eye-off-icon');
        
        if (eyeIcon && eyeOffIcon) {
            if (isPassword) {
                eyeIcon.style.display = 'none';
                eyeOffIcon.style.display = 'block';
            } else {
                eyeIcon.style.display = 'block';
                eyeOffIcon.style.display = 'none';
            }
        }
    }
    
    showError(message) {
        if (this.errorMessage) {
            this.errorMessage.textContent = message;
            this.errorMessage.classList.add('show');
            setTimeout(() => {
                this.errorMessage.classList.remove('show');
            }, 5000);
        }
    }
    
    setLoading(loading) {
        if (this.submitBtn) {
            this.submitBtn.disabled = loading;
            const btnText = this.submitBtn.querySelector('.btn-text');
            const btnLoader = this.submitBtn.querySelector('.btn-loader');
            
            if (btnText) btnText.style.display = loading ? 'none' : 'inline';
            if (btnLoader) btnLoader.style.display = loading ? 'inline-block' : 'none';
        }
    }
    
    async handleSubmit(e) {
        e.preventDefault();
        
        const username = this.usernameInput.value.trim();
        const password = this.passwordInput.value;
        
        if (!username || !password) {
            this.showError('Please enter both username and password');
            return;
        }
        
        this.setLoading(true);
        this.showError(''); // Clear any previous errors
        
        try {
            const response = await fetch(`${this.baseURL}/api/owner/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password })
            });
            
            const result = await response.json();
            
            if (!response.ok) {
                throw new Error(result.error || 'Login failed');
            }
            
            // Store owner token in sessionStorage
            if (result.token) {
                sessionStorage.setItem('ownerToken', result.token);
                // Redirect to owner panel
                window.location.href = '/pages/owner-panel.html';
            } else {
                throw new Error('No token received from server');
            }
            
        } catch (error) {
            console.error('Owner login error:', error);
            this.showError(error.message || 'Login failed. Please check your credentials.');
        } finally {
            this.setLoading(false);
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new OwnerLogin();
});
