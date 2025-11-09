// Settings page functionality
class SettingsManager {
    constructor() {
        this.form = document.getElementById('settingsForm');
        this.currentPasswordInput = document.getElementById('currentPassword');
        this.newPasswordInput = document.getElementById('newPassword');
        this.confirmPasswordInput = document.getElementById('confirmPassword');
        this.saveBtn = document.getElementById('saveBtn');
        
        this.init();
    }
    
    init() {
        if (this.form) {
            this.form.addEventListener('submit', (e) => this.handleSubmit(e));
        }
        
        // Check authentication
        this.checkAuth();
    }
    
    async checkAuth() {
        try {
            if (typeof auth === 'undefined') {
                window.location.href = '../index.html';
                return;
            }
            
            auth.onAuthStateChanged((user) => {
                if (!user) {
                    window.location.href = '../index.html';
                }
            });
        } catch (error) {
            console.error('Auth check error:', error);
            window.location.href = '../index.html';
        }
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
        
        const currentPassword = this.currentPasswordInput.value;
        const newPassword = this.newPasswordInput.value;
        const confirmPassword = this.confirmPasswordInput.value;
        
        // Clear previous errors
        this.clearError('currentPassword');
        this.clearError('newPassword');
        this.clearError('confirmPassword');
        
        // Validate current password
        if (!currentPassword) {
            this.showError('currentPassword', 'Current password is required');
            isValid = false;
        }
        
        // Validate new password
        if (!newPassword) {
            this.showError('newPassword', 'New password is required');
            isValid = false;
        } else if (newPassword.length < 6) {
            this.showError('newPassword', 'Password must be at least 6 characters');
            isValid = false;
        }
        
        // Validate confirm password
        if (!confirmPassword) {
            this.showError('confirmPassword', 'Please confirm your new password');
            isValid = false;
        } else if (newPassword !== confirmPassword) {
            this.showError('confirmPassword', 'Passwords do not match');
            isValid = false;
        }
        
        return isValid;
    }
    
    setLoading(loading) {
        if (loading) {
            this.saveBtn.disabled = true;
            this.saveBtn.textContent = 'Saving...';
        } else {
            this.saveBtn.disabled = false;
            this.saveBtn.textContent = 'Save Changes';
        }
    }
    
    async handleSubmit(e) {
        e.preventDefault();
        
        if (!this.validateForm()) {
            return;
        }
        
        this.setLoading(true);
        
        try {
            const currentPassword = this.currentPasswordInput.value;
            const newPassword = this.newPasswordInput.value;
            const user = auth.currentUser;
            
            if (!user) {
                throw new Error('No user logged in');
            }
            
            // Re-authenticate user with current password
            const credential = firebase.auth.EmailAuthProvider.credential(
                user.email,
                currentPassword
            );
            
            await user.reauthenticateWithCredential(credential);
            
            // Update password
            await user.updatePassword(newPassword);
            
            // Update password in Firestore if needed
            try {
                await db.collection('users').doc(user.uid).update({
                    password: newPassword, // Note: In production, don't store plain passwords
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            } catch (firestoreError) {
                console.warn('Could not update Firestore:', firestoreError);
                // Continue even if Firestore update fails
            }
            
            alert('Password changed successfully!');
            
            // Reset form
            this.form.reset();
            this.clearError('currentPassword');
            this.clearError('newPassword');
            this.clearError('confirmPassword');
            
        } catch (error) {
            console.error('Error changing password:', error);
            let errorMessage = 'Failed to change password. Please try again.';
            
            if (error.code === 'auth/wrong-password') {
                errorMessage = 'Current password is incorrect.';
                this.showError('currentPassword', errorMessage);
            } else if (error.code === 'auth/weak-password') {
                errorMessage = 'New password is too weak.';
                this.showError('newPassword', errorMessage);
            } else if (error.code === 'auth/requires-recent-login') {
                errorMessage = 'Please log out and log back in before changing your password.';
                alert(errorMessage);
            } else if (error.message) {
                errorMessage = error.message;
            }
            
            if (error.code !== 'auth/wrong-password' && error.code !== 'auth/weak-password') {
                alert(errorMessage);
            }
        } finally {
            this.setLoading(false);
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new SettingsManager();
});

