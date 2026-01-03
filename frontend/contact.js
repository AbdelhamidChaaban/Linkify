// Contact Form JavaScript

document.addEventListener('DOMContentLoaded', () => {
    const contactForm = document.getElementById('contactForm');
    const sendButton = contactForm?.querySelector('.send-message-btn');
    
    if (contactForm) {
        contactForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            // Get form data
            const formData = new FormData(contactForm);
            const data = {
                name: formData.get('name'),
                email: formData.get('email'),
                message: formData.get('message')
            };
            
            // Disable button and show loading state
            if (sendButton) {
                sendButton.disabled = true;
                const span = sendButton.querySelector('span');
                if (span) {
                    const originalText = span.textContent;
                    span.textContent = 'Sending...';
                }
            }
            
            try {
                // Get API base URL from config or use default
                const API_BASE_URL = (typeof window.AEFA_API_URL !== 'undefined' && window.AEFA_API_URL) || 
                                     (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
                                     ? 'http://localhost:3000' 
                                     : window.location.origin;
                
                // Send data to backend
                const response = await fetch(`${API_BASE_URL}/api/contact`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(data)
                });
                
                const result = await response.json();
                
                if (response.ok && result.success) {
                    // Show success message
                    alert(result.message || 'Thank you for your message! We\'ll get back to you soon.');
                    
                    // Reset form
                    contactForm.reset();
                } else {
                    // Show error message
                    alert(result.error || 'Failed to send message. Please try again later.');
                }
            } catch (error) {
                console.error('Error submitting contact form:', error);
                alert('Failed to send message. Please check your connection and try again.');
            } finally {
                // Re-enable button
                if (sendButton) {
                    sendButton.disabled = false;
                    const span = sendButton.querySelector('span');
                    if (span) {
                        span.textContent = 'Send Message';
                    }
                }
            }
        });
    }
});

