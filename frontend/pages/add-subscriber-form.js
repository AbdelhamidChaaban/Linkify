// Add Subscriber Page - Form Functions (extends AddSubscriberPageManager prototype)
// Extracted and adapted from insights.js modal functions

AddSubscriberPageManager.prototype.initAddSubscribersPage = function() {
    const container = document.getElementById('subscribersItemsContainer');
    if (!container) return;
    
    // Clear existing items
    container.innerHTML = '';
    
    // Clear messages when form is initialized
    this.clearMessages();
    
    // Start with just 1 subscriber row (user can add more up to 3)
    this.addSubscriberRow();
    
    // Bind add button (but it will be disabled when 3 rows are present)
    const addBtn = document.getElementById('addSubscriberRowBtn');
    if (addBtn) {
        addBtn.onclick = () => this.addSubscriberRow();
        // Initially enable since we only have 1 row
        this.updateAddSubscriberButtonState();
    }
    
    // Bind form submit
    const form = document.getElementById('addSubscribersForm');
    if (form) {
        form.onsubmit = (e) => {
            e.preventDefault();
            // Clear previous messages before submitting
            this.clearMessages();
            this.handleAddSubscribersSubmit();
        };
    }
    
    // Attach blur handlers to all subscriber phone inputs for normalization
    this.attachAddSubscriberPhoneNormalizationHandlers();
};

AddSubscriberPageManager.prototype.attachAddSubscriberPhoneNormalizationHandlers = function() {
    const container = document.getElementById('subscribersItemsContainer');
    if (!container) return;
    
    // Find all subscriber phone inputs
    const subscriberInputs = container.querySelectorAll('input[name*="subscriber"]');
    
    subscriberInputs.forEach(input => {
        // Skip if already has handler
        if (input.dataset.normalizeHandler) return;
        
        // Attach blur handler
        const handler = (e) => {
            const normalized = this.normalizePhoneNumber(e.target.value);
            if (normalized && normalized !== e.target.value) {
                e.target.value = normalized;
            }
        };
        
        input.addEventListener('blur', handler);
        
        // Mark as having handler
        input.dataset.normalizeHandler = 'true';
    });
};

AddSubscriberPageManager.prototype.addSubscriberRow = function() {
    const container = document.getElementById('subscribersItemsContainer');
    if (!container) return;
    
    // Limit to maximum 3 subscriber rows
    const MAX_SUBSCRIBERS = 3;
    if (container.children.length >= MAX_SUBSCRIBERS) {
        console.log(`⚠️ Maximum ${MAX_SUBSCRIBERS} subscribers allowed`);
        return;
    }
    
    const itemIndex = container.children.length;
    const itemDiv = document.createElement('div');
    itemDiv.className = 'add-subscribers-item';
    itemDiv.dataset.index = itemIndex;
    
    // Only require fields for the first row (index 0)
    const isFirstRow = itemIndex === 0;
    const requiredAttr = isFirstRow ? 'required' : '';
    
    itemDiv.innerHTML = `
        <div class="add-subscribers-item-fields">
            <div class="add-subscribers-field">
                <label for="subscriber_${itemIndex}">Subscriber</label>
                <input type="tel" id="subscriber_${itemIndex}" name="items[${itemIndex}].subscriber" placeholder="Enter phone number" ${requiredAttr}>
            </div>
            <div class="add-subscribers-field">
                <label for="quota_${itemIndex}">Quota</label>
                <input type="number" id="quota_${itemIndex}" name="items[${itemIndex}].quota" step="any" placeholder="Enter quota" ${requiredAttr}>
            </div>
            <div class="add-subscribers-field">
                <label for="service_${itemIndex}">Service</label>
                <div class="service-selector" id="service_selector_${itemIndex}" data-index="${itemIndex}">
                    <span class="service-selector-text" id="service_text_${itemIndex}">Select admin</span>
                    <svg class="service-selector-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M6 9l6 6 6-6"/>
                    </svg>
                </div>
                <input type="hidden" id="service_${itemIndex}" name="items[${itemIndex}].service" data-admin-id="" data-admin-name="" ${requiredAttr}>
            </div>
        </div>
        <button type="button" class="add-subscribers-remove-btn" data-index="${itemIndex}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 6.386c0-.484.345-.877.771-.877h2.665c.529-.016.996-.399 1.176-.965l.03-.1l.115-.391c.07-.24.131-.45.217-.637c.338-.739.964-1.252 1.687-1.383c.184-.033.378-.033.6-.033h3.478c.223 0 .417 0 .6.033c.723.131 1.35.644 1.687 1.383c.086.187.147.396.218.637l.114.391l.03.1c.18.566.74.95 1.27.965h2.57c.427 0 .772.393.772.877s-.345.877-.771.877H3.77c-.425 0-.77-.393-.77-.877"/>
                <path fill-rule="evenodd" d="M11.596 22h.808c2.783 0 4.174 0 5.08-.886c.904-.886.996-2.339 1.181-5.245l.267-4.188c.1-1.577.15-2.366-.303-2.865c-.454-.5-1.22-.5-2.753-.5H8.124c-1.533 0-2.3 0-2.753.5s-.404 1.288-.303 2.865l.267 4.188c.185 2.906.277 4.36 1.182 5.245c.905.886 2.296.886 5.079.886m-1.35-9.811c-.04-.434-.408-.75-.82-.707c-.413.043-.713.43-.672.864l.5 5.263c.04.434.408.75.82.707c.413-.043.713-.43.672-.864zm4.329-.707c.412.043.713.43.671.864l-.5 5.263c-.04.434-.409.75-.82.707c-.413-.043-.713-.43-.672-.864l.5-5.263c.04-.434.409-.75.82-.707" clip-rule="evenodd"/>
            </svg>
            Remove
        </button>
    `;
    
    container.appendChild(itemDiv);
    
    // Bind click handler for service selector
    const selector = document.getElementById(`service_selector_${itemIndex}`);
    if (selector) {
        // Prevent keyboard on mobile by handling touch events properly
        selector.setAttribute('tabindex', '-1');
        selector.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Blur any active input to prevent keyboard
            if (document.activeElement && document.activeElement.tagName === 'INPUT') {
                document.activeElement.blur();
            }
            this.openAdminSelector(itemIndex);
        });
    }
    
    // Bind remove button
    const removeBtn = itemDiv.querySelector('.add-subscribers-remove-btn');
    if (removeBtn) {
        removeBtn.addEventListener('click', () => {
            this.removeSubscriberRow(removeBtn);
        });
    }
    
    // Attach blur handlers to all subscriber phone inputs (including the new one)
    this.attachAddSubscriberPhoneNormalizationHandlers();
    
    // Update add button state after adding a row
    this.updateAddSubscriberButtonState();
};

AddSubscriberPageManager.prototype.updateAddSubscriberButtonState = function() {
    const container = document.getElementById('subscribersItemsContainer');
    const addBtn = document.getElementById('addSubscriberRowBtn');
    const MAX_SUBSCRIBERS = 3;
    
    if (!container || !addBtn) return;
    
    const currentCount = container.children.length;
    if (currentCount >= MAX_SUBSCRIBERS) {
        // Hide the button completely when limit is reached
        addBtn.style.display = 'none';
    } else {
        // Show the button when below limit
        addBtn.style.display = '';
        addBtn.disabled = false;
        addBtn.style.opacity = '1';
        addBtn.style.cursor = 'pointer';
    }
};

AddSubscriberPageManager.prototype.removeSubscriberRow = function(button) {
    const item = button.closest('.add-subscribers-item');
    if (item) {
        item.remove();
        // Re-index remaining items
        const container = document.getElementById('subscribersItemsContainer');
        if (container) {
            Array.from(container.children).forEach((child, index) => {
                child.dataset.index = index;
                const inputs = child.querySelectorAll('input');
                const selectors = child.querySelectorAll('.service-selector');
                inputs.forEach(input => {
                    const name = input.name;
                    if (name) {
                        input.name = name.replace(/\[\d+\]/, `[${index}]`);
                        input.id = input.id.replace(/\d+$/, index);
                    }
                    const label = child.querySelector(`label[for="${input.id}"]`);
                    if (label) {
                        label.setAttribute('for', input.id);
                    }
                });
                selectors.forEach(selector => {
                    selector.id = `service_selector_${index}`;
                    selector.dataset.index = index;
                    selector.setAttribute('tabindex', '-1');
                    selector.onclick = null; // Remove old handler
                    selector.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        // Blur any active input to prevent keyboard
                        if (document.activeElement && document.activeElement.tagName === 'INPUT') {
                            document.activeElement.blur();
                        }
                        this.openAdminSelector(index);
                    });
                    const textSpan = selector.querySelector('.service-selector-text');
                    if (textSpan) {
                        textSpan.id = `service_text_${index}`;
                    }
                });
                // Re-bind remove button
                const removeBtn = child.querySelector('.add-subscribers-remove-btn');
                if (removeBtn) {
                    removeBtn.setAttribute('data-index', index);
                }
            });
        }
        
        // Update add button state after removing a row (re-enable if below limit)
        this.updateAddSubscriberButtonState();
    }
};

// Submit handler - adapted from modal to redirect on success
AddSubscriberPageManager.prototype.handleAddSubscribersSubmit = async function() {
    // Prevent duplicate submissions
    if (this.isSubmittingAddForm) {
        console.log('⏸️ Form submission already in progress, ignoring duplicate request');
        return;
    }
    
    const form = document.getElementById('addSubscribersForm');
    if (!form) return;
    
    this.isSubmittingAddForm = true;
    
    // Show loading animation
    this.showPageLoading('Adding subscribers...');
    
    // Disable submit button to prevent multiple clicks
    const submitBtn = document.getElementById('shareSubscribersBtn');
    let originalButtonText = '';
    if (submitBtn) {
        originalButtonText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Processing...';
    }
    
    try {
        const formData = new FormData(form);
        const items = [];
        
        // Collect all subscriber items
        const container = document.getElementById('subscribersItemsContainer');
        if (container) {
            const itemDivs = container.querySelectorAll('.add-subscribers-item');
            itemDivs.forEach((itemDiv, index) => {
                const subscriberInput = itemDiv.querySelector(`input[name="items[${index}].subscriber"]`);
                let subscriber = subscriberInput?.value.trim() || '';
                // Normalize phone number on submit (fallback in case blur didn't fire)
                if (subscriber) {
                    subscriber = this.normalizePhoneNumber(subscriber);
                    // Update the input field with normalized value
                    if (subscriberInput) {
                        subscriberInput.value = subscriber;
                    }
                }
                const quota = itemDiv.querySelector(`input[name="items[${index}].quota"]`)?.value.trim();
                const serviceInput = itemDiv.querySelector(`input[name="items[${index}].service"]`);
                const adminId = serviceInput?.dataset.adminId || serviceInput?.value.trim();
                const adminName = serviceInput?.dataset.adminName || '';
                
                if (subscriber && quota && adminId) {
                    items.push({
                        subscriber: subscriber,
                        quota: parseFloat(quota) || 0,
                        adminId: adminId,
                        adminName: adminName
                    });
                }
            });
        }
        
        if (items.length === 0) {
            alert('Please add at least one subscriber with all fields filled.');
            this.isSubmittingAddForm = false;
            this.hidePageLoading();
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalButtonText;
            }
            return;
        }
        
        // Validate that all items have admin selected
        const missingAdmin = items.find(item => !item.adminId);
        if (missingAdmin) {
            alert('Please select an admin for all subscribers.');
            this.isSubmittingAddForm = false;
            this.hidePageLoading();
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalButtonText;
            }
            return;
        }
        
        // Check for duplicate subscriber numbers within the form itself first
        const normalizePhoneForComparison = (phone) => {
            return (phone || '').replace(/^961/, '').replace(/^0+/, '').replace(/\D/g, '');
        };
        
        const phonesInForm = new Set();
        const duplicatesInForm = [];
        for (const item of items) {
            const normalizedPhone = normalizePhoneForComparison(this.normalizePhoneNumber(item.subscriber));
            if (phonesInForm.has(normalizedPhone)) {
                duplicatesInForm.push(item.subscriber);
            } else {
                phonesInForm.add(normalizedPhone);
            }
        }
        
        if (duplicatesInForm.length > 0) {
            alert(`Cannot add subscribers - the following numbers appear multiple times in the form:\n\n${duplicatesInForm.join('\n')}\n\nPlease remove the duplicate subscriber numbers and try again.`);
            this.isSubmittingAddForm = false;
            this.hidePageLoading();
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalButtonText;
            }
            return;
        }
        
        console.log('Submitting subscribers:', items);
        
        // Call API for each subscriber
        const results = [];
        for (const item of items) {
            try {
                const baseURL = window.AEFA_API_URL || window.ALFA_API_URL || 'https://cell-spott-manage-backend.onrender.com';
                const response = await fetch(`${baseURL}/api/subscribers/add`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        adminId: item.adminId,
                        subscriberPhone: item.subscriber,
                        quota: item.quota
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    results.push({
                        subscriber: item.subscriber,
                        success: true,
                        message: data.message
                    });
                } else {
                    results.push({
                        subscriber: item.subscriber,
                        success: false,
                        message: data.error || 'Failed to add subscriber'
                    });
                }
            } catch (error) {
                console.error(`Error adding subscriber ${item.subscriber}:`, error);
                results.push({
                    subscriber: item.subscriber,
                    success: false,
                    message: error.message || 'Network error occurred'
                });
            }
        }
        
        // Show results
        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;
        
        // Handle results based on success/failure
        if (failCount === 0) {
            // All succeeded - generate and display success messages for each subscriber
            const successMessages = [];
            results.forEach(result => {
                if (result.success) {
                    const item = items.find(item => item.subscriber === result.subscriber);
                    if (item) {
                        const admin = this.subscribers.find(s => s.id === item.adminId);
                        const adminPhone = admin?.phone || item.adminId;
                        const quota = item.quota !== undefined && item.quota !== null ? item.quota : 0;
                        const message = `Send ${adminPhone} to 1323 (${quota} GB)`;
                        successMessages.push(message);
                    }
                }
            });
            
            // Display all success messages (each on a separate line)
            if (successMessages.length > 0) {
                this.displayMessages(successMessages, 'success');
                // Also copy first message to clipboard (for backward compatibility)
                this.copyToClipboard(successMessages[0]).catch(() => {});
            }
            
            // Show toast notification immediately (don't wait for refresh)
            if (typeof notification !== 'undefined') {
                notification.set({ delay: 3000 });
                notification.success('Operation succeeded');
            } else {
                alert(`✅ Successfully added ${successCount} subscriber(s)!`);
            }
            
            // Automatically refresh all selected admins in the background (non-blocking)
            // Firebase real-time listeners will automatically update the UI when refresh completes
            const uniqueAdminIds = [...new Set(items.map(item => item.adminId))];
            console.log(`🔄 [Add Subscriber] Refreshing ${uniqueAdminIds.length} admin(s) in background after successful subscriber addition...`);
            
            if (window.AlfaAPIService) {
                // Fire-and-forget: Don't await - let it run in background
                // The Firebase real-time listener will update the UI automatically when data is refreshed
                Promise.allSettled(
                    uniqueAdminIds.map(adminId => {
                        return window.AlfaAPIService.refreshAdmin(adminId).catch(error => {
                            console.error(`⚠️ [Add Subscriber] Failed to refresh admin ${adminId}:`, error);
                            // Don't throw - continue with other refreshes
                            return { success: false, adminId, error: error.message };
                        });
                    })
                ).then(() => {
                    console.log(`✅ [Add Subscriber] Background admin refresh completed`);
                }).catch(error => {
                    console.error('⚠️ [Add Subscriber] Error during background admin refresh:', error);
                    // Not critical - Firebase listener will still update when data changes
                });
            } else {
                console.warn('⚠️ [Add Subscriber] AlfaAPIService not available, skipping admin refresh');
            }
            
            // Don't redirect immediately - let user see the messages
            // User can manually navigate away or we can add a delay if needed
            // For now, keep the messages visible so user can copy them
        } else {
            // Errors occurred - display cancel message
            const cancelMessage = `Cancel old service\n*111*7*2*1*2*1#`;
            await this.copyToClipboard(cancelMessage);
            
            // Display cancel message
            this.displayMessages([cancelMessage], 'error');
            
            // Show toast notification
            if (typeof notification !== 'undefined') {
                notification.set({ delay: 3000 });
                notification.error('Cancel message copied to clipboard automatically');
            } else {
                alert('Cancel message copied to clipboard automatically');
            }
            
            // Re-enable submit button and reset loading state
            this.hidePageLoading();
            this.isSubmittingAddForm = false;
            if (submitBtn && originalButtonText) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalButtonText;
            }
            
            // Don't redirect - let user see the error
            return;
        }
    } catch (error) {
        console.error('Error adding subscribers:', error);
        alert('Failed to add subscribers. Please try again.');
    } finally {
        // Hide loading animation
        this.hidePageLoading();
        
        // Re-enable submit button and reset flag
        this.isSubmittingAddForm = false;
        if (submitBtn && originalButtonText) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalButtonText;
        }
    }
};

// Page loading functions (adapted from modal loading)
AddSubscriberPageManager.prototype.showPageLoading = function(message = 'Processing...') {
    const container = document.querySelector('.add-subscriber-page-container');
    if (!container) return;
    
    // Ensure container has relative positioning
    container.style.position = 'relative';
    
    // Create or show loading overlay
    let loadingOverlay = container.querySelector('.add-modal-loading');
    if (!loadingOverlay) {
        loadingOverlay = document.createElement('div');
        loadingOverlay.className = 'add-modal-loading';
        container.appendChild(loadingOverlay);
    }
    
    // Update loading message
    loadingOverlay.innerHTML = `
        <div class="add-modal-loading-spinner">
            <div class="refresh-loading">
                <div class="loader">
                    <div class="inner one"></div>
                    <div class="inner two"></div>
                    <div class="inner three"></div>
                </div>
            </div>
            <p>${this.escapeHtml(message)}</p>
        </div>
    `;
    loadingOverlay.style.display = 'flex';
};

AddSubscriberPageManager.prototype.hidePageLoading = function() {
    const container = document.querySelector('.add-subscriber-page-container');
    if (!container) return;
    
    const loadingOverlay = container.querySelector('.add-modal-loading');
    if (loadingOverlay) {
        loadingOverlay.style.display = 'none';
    }
};

// Display messages in the messages container
AddSubscriberPageManager.prototype.displayMessages = function(messages, type = 'success') {
    const container = document.getElementById('addSubscribersMessagesContainer');
    const messagesList = document.getElementById('addSubscribersMessagesList');
    
    if (!container || !messagesList) return;
    
    // Clear existing messages
    messagesList.innerHTML = '';
    
    // Add each message on a separate line with copy button
    messages.forEach((message, index) => {
        const messageItem = document.createElement('div');
        messageItem.className = `add-subscribers-message-item add-subscribers-message-${type}`;
        messageItem.innerHTML = `
            <div class="add-subscribers-message-text">${this.escapeHtml(message)}</div>
            <button type="button" class="add-subscribers-message-copy-btn" data-message="${this.escapeHtml(message)}" title="Copy message">
                <img src="/assets/copy.png" alt="Copy" style="width: 16px; height: 16px; object-fit: contain;">
            </button>
        `;
        
        // Add copy button click handler
        const copyBtn = messageItem.querySelector('.add-subscribers-message-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                const messageText = copyBtn.dataset.message;
                const success = await this.copyToClipboard(messageText);
                if (success) {
                    // Visual feedback
                    const img = copyBtn.querySelector('img');
                    if (img) {
                        img.style.opacity = '0.5';
                        setTimeout(() => {
                            img.style.opacity = '1';
                        }, 2000);
                    }
                }
            });
        }
        
        messagesList.appendChild(messageItem);
    });
    
    // Show the messages container
    container.style.display = 'block';
    
    // Scroll to messages container
    setTimeout(() => {
        container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
};

// Clear messages display
AddSubscriberPageManager.prototype.clearMessages = function() {
    const container = document.getElementById('addSubscribersMessagesContainer');
    const messagesList = document.getElementById('addSubscribersMessagesList');
    
    if (container) {
        container.style.display = 'none';
    }
    if (messagesList) {
        messagesList.innerHTML = '';
    }
};

