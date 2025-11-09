// Navigation functionality - Theme toggle and Avatar menu
class NavigationManager {
    constructor() {
        this.init();
    }
    
    init() {
        this.initThemeToggle();
        this.initAvatarMenu();
        this.loadTheme();
        this.updateAvatar();
    }
    
    updateAvatar() {
        const avatar = document.getElementById('userAvatar');
        if (!avatar) return;
        
        // Check if Firebase auth is available and get current user
        if (typeof auth !== 'undefined') {
            // Try to get current user immediately (if already logged in)
            const currentUser = auth.currentUser;
            if (currentUser && currentUser.email) {
                const firstLetter = currentUser.email.charAt(0).toUpperCase();
                avatar.textContent = firstLetter;
            }
            
            // Also listen for auth state changes (for login/logout)
            auth.onAuthStateChanged((user) => {
                if (user && user.email) {
                    // Get first letter of email and make it uppercase
                    const firstLetter = user.email.charAt(0).toUpperCase();
                    avatar.textContent = firstLetter;
                } else {
                    // Default to 'A' if no user
                    avatar.textContent = '';
                }
            });
        } else {
            // Wait for Firebase to load, then try again
            setTimeout(() => {
                if (typeof auth !== 'undefined') {
                    const currentUser = auth.currentUser;
                    if (currentUser && currentUser.email) {
                        const firstLetter = currentUser.email.charAt(0).toUpperCase();
                        avatar.textContent = firstLetter;
                    }
                }
            }, 100);
        }
    }
    
    initThemeToggle() {
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                this.toggleTheme();
            });
        }
    }
    
    initAvatarMenu() {
        const avatar = document.getElementById('userAvatar');
        const dropdown = document.getElementById('avatarDropdown');
        const settingsLink = document.getElementById('settingsLink');
        const logoutLink = document.getElementById('logoutLink');
        
        if (avatar && dropdown) {
            // Toggle dropdown
            avatar.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdown.classList.toggle('show');
            });
            
            // Close dropdown when clicking outside
            document.addEventListener('click', (e) => {
                if (!avatar.contains(e.target) && !dropdown.contains(e.target)) {
                    dropdown.classList.remove('show');
                }
            });
            
            // Settings link
            if (settingsLink) {
                settingsLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    // Use absolute path (settings.html is in /pages/)
                    window.location.href = '/pages/settings.html';
                    dropdown.classList.remove('show');
                });
            }
            
            // Logout link
            if (logoutLink) {
                logoutLink.addEventListener('click', async (e) => {
                    e.preventDefault();
                    await this.handleLogout();
                    dropdown.classList.remove('show');
                });
            }
        }
    }
    
    toggleTheme() {
        const body = document.body;
        const isLightMode = body.classList.contains('light-mode');
        
        if (isLightMode) {
            body.classList.remove('light-mode');
            localStorage.setItem('theme', 'dark');
        } else {
            body.classList.add('light-mode');
            localStorage.setItem('theme', 'light');
        }
    }
    
    loadTheme() {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'light') {
            document.body.classList.add('light-mode');
        }
    }
    
    async handleLogout() {
        try {
            // Check if Firebase is loaded
            if (typeof auth !== 'undefined') {
                await auth.signOut();
            }
            
            // Redirect to login page (use absolute path)
            window.location.href = '/index.html';
        } catch (error) {
            console.error('Logout error:', error);
            // Still redirect even if logout fails (use absolute path)
            window.location.href = '/index.html';
        }
    }
}

// Initialize navigation when DOM is ready
let navManager;

// Function to initialize nav after Firebase is loaded
function initializeNavigation() {
    if (!navManager) {
        navManager = new NavigationManager();
    } else {
        // If already initialized, just update avatar
        navManager.updateAvatar();
    }
}

// Try to initialize immediately if DOM and Firebase are ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        // Wait a bit for Firebase to be available
        if (typeof auth !== 'undefined') {
            initializeNavigation();
        } else {
            // Wait for Firebase to load
            setTimeout(initializeNavigation, 100);
        }
    });
} else {
    // DOM already loaded
    if (typeof auth !== 'undefined') {
        initializeNavigation();
    } else {
        setTimeout(initializeNavigation, 100);
    }
}

