// Navigation functionality - Theme toggle and Avatar menu
class NavigationManager {
    constructor() {
        this.init();
    }
    
    init() {
        this.initThemeToggle();
        this.initAvatarMenu();
        this.initMobileSidebar();
        this.loadTheme();
        this.updateAvatar();
    }
    
    updateAvatar() {
        const avatar = document.getElementById('userAvatar');
        const mobileAvatar = document.getElementById('mobileUserAvatar');
        const mobileUserEmail = document.getElementById('mobileUserEmail');
        
        if (!avatar && !mobileAvatar) {
            // Retry if avatar elements don't exist yet (only once)
            if (!this._avatarRetryAttempted) {
                this._avatarRetryAttempted = true;
                setTimeout(() => this.updateAvatar(), 100);
            }
            return;
        }
        
        // Helper function to set avatar letter
        const setAvatarLetter = (email) => {
            if (email && typeof email === 'string' && email.length > 0) {
                const firstLetter = email.charAt(0).toUpperCase();
                if (avatar) {
                    avatar.textContent = firstLetter;
                }
                if (mobileAvatar) {
                    mobileAvatar.textContent = firstLetter;
                }
                if (mobileUserEmail) {
                    mobileUserEmail.textContent = email;
                }
            } else {
                if (avatar) avatar.textContent = '';
                if (mobileAvatar) mobileAvatar.textContent = '';
                if (mobileUserEmail) mobileUserEmail.textContent = 'User';
            }
        };
        
        // Check if Firebase auth is available
        if (typeof auth !== 'undefined' && auth) {
            // Only set up listener once
            if (!this._authListenerSet) {
                this._authListenerSet = true;
                
                // Listen for auth state changes (this will fire when user logs in or state changes)
                auth.onAuthStateChanged((user) => {
                    if (user && user.email) {
                        setAvatarLetter(user.email);
                    } else {
                        // No user logged in
                        if (avatar) avatar.textContent = '';
                        if (mobileAvatar) mobileAvatar.textContent = '';
                        if (mobileUserEmail) mobileUserEmail.textContent = 'User';
                    }
                });
            }
            
            // Try to get current user immediately (if already logged in)
            const currentUser = auth.currentUser;
            if (currentUser && currentUser.email) {
                setAvatarLetter(currentUser.email);
            } else {
                // User not logged in - clear avatar silently
                if (avatar) avatar.textContent = '';
                if (mobileAvatar) mobileAvatar.textContent = '';
                if (mobileUserEmail) mobileUserEmail.textContent = 'User';
            }
        } else {
            // Firebase auth not loaded yet, wait and retry (only once)
            if (!this._authRetryAttempted) {
                this._authRetryAttempted = true;
                setTimeout(() => {
                    if (typeof auth !== 'undefined' && auth) {
                        this._authRetryAttempted = false; // Reset so we can set up listener
                        this.updateAvatar();
                    }
                }, 200);
            }
        }
    }
    
    initThemeToggle() {
        const themeToggle = document.getElementById('themeToggle');
        const mobileThemeToggle = document.getElementById('mobileThemeToggle');
        
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                this.toggleTheme();
            });
        }
        
        if (mobileThemeToggle) {
            mobileThemeToggle.addEventListener('click', () => {
                this.toggleTheme();
            });
        }
    }
    
    initMobileSidebar() {
        // Set active page in mobile sidebar
        const currentPath = window.location.pathname;
        const mobileNavLinks = document.querySelectorAll('.mobile-nav-link');
        mobileNavLinks.forEach(link => {
            const page = link.getAttribute('data-page');
            if (currentPath.includes(page + '.html') || (page === 'home' && currentPath.endsWith('/pages/home.html'))) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });
        
        // Close sidebar when clicking overlay
        const overlay = document.querySelector('.mobile-sidebar-overlay');
        const mobileMenuCheck = document.getElementById('mobileMenuCheck');
        if (overlay && mobileMenuCheck) {
            overlay.addEventListener('click', () => {
                mobileMenuCheck.checked = false;
            });
        }
        
        // Close sidebar when clicking nav links
        mobileNavLinks.forEach(link => {
            link.addEventListener('click', () => {
                if (mobileMenuCheck) {
                    mobileMenuCheck.checked = false;
                }
            });
        });
        
        // Handle mobile logout
        const mobileLogoutLink = document.getElementById('mobileLogoutLink');
        if (mobileLogoutLink) {
            mobileLogoutLink.addEventListener('click', async (e) => {
                e.preventDefault();
                if (mobileMenuCheck) {
                    mobileMenuCheck.checked = false;
                }
                await this.handleLogout();
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
let initAttempts = 0;
const MAX_INIT_ATTEMPTS = 10;

// Function to initialize nav after Firebase is loaded
function initializeNavigation() {
    initAttempts++;
    
    // Check if Firebase auth is available
    if (typeof auth !== 'undefined' && auth) {
        if (!navManager) {
            navManager = new NavigationManager();
            console.log('✅ Navigation initialized');
        } else {
            // If already initialized, just update avatar
            navManager.updateAvatar();
        }
    } else {
        // Firebase not ready yet, retry
        if (initAttempts < MAX_INIT_ATTEMPTS) {
            const delay = Math.min(initAttempts * 100, 1000); // Exponential backoff, max 1s
            console.log(`⏳ Firebase auth not ready, retrying in ${delay}ms (attempt ${initAttempts}/${MAX_INIT_ATTEMPTS})...`);
            setTimeout(initializeNavigation, delay);
        } else {
            console.error('❌ Failed to initialize navigation after', MAX_INIT_ATTEMPTS, 'attempts');
        }
    }
}

// Try to initialize immediately if DOM and Firebase are ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        // Wait a bit for Firebase to be available
        if (typeof auth !== 'undefined' && auth) {
            initializeNavigation();
        } else {
            // Wait for Firebase to load
            setTimeout(initializeNavigation, 100);
        }
    });
} else {
    // DOM already loaded
    if (typeof auth !== 'undefined' && auth) {
        initializeNavigation();
    } else {
        setTimeout(initializeNavigation, 100);
    }
}

// Also try to update avatar periodically in case auth loads later
// This is a fallback for cases where Firebase loads after our initial attempts
// Only check if auth listener hasn't been set up yet
let avatarCheckInterval = setInterval(() => {
    if (navManager && typeof auth !== 'undefined' && auth) {
        // If auth listener is set up, we don't need to keep checking
        if (navManager._authListenerSet) {
            clearInterval(avatarCheckInterval);
            return;
        }
        
        const avatar = document.getElementById('userAvatar');
        if (avatar && !avatar.textContent) {
            // Avatar exists but has no content, try to update it (will set up listener)
            navManager.updateAvatar();
        }
    }
}, 2000); // Check every 2 seconds

// Stop checking after 30 seconds (Firebase should be loaded by then)
setTimeout(() => {
    clearInterval(avatarCheckInterval);
}, 30000);

