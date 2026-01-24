// Edit Subscriber Page - Form Functions (extends EditSubscriberPageManager prototype)
// Extracted and adapted from insights.js modal functions

EditSubscriberPageManager.prototype.initEditSubscribersPage = function() {
    // This will be called after data is loaded
    // The actual initialization happens in initEditSubscribersPageWithUshareData or initEditSubscribersPageWithExistingData
    
    // Clear messages when form is initialized
    this.clearMessages();
};

EditSubscriberPageManager.prototype.initEditSubscribersPageWithUshareData = function(subscriber, ushareData) {
    // Set admin info
    const adminInfoEl = document.getElementById('editSubscribersAdminInfo');
    if (adminInfoEl) {
        adminInfoEl.innerHTML = `
            <h6 class="edit-subscribers-admin-name">${this.escapeHtml(subscriber.name)} - ${this.escapeHtml(subscriber.phone)} (${subscriber.quota || 0} GB)</h6>
        `;
    }
    
    // Load subscribers from Ushare data
    const itemsContainer = document.getElementById('editSubscribersItems');
    if (!itemsContainer) return;
    
    itemsContainer.innerHTML = '';
    
    // Add subscribers from Ushare data
    if (ushareData.subscribers && Array.isArray(ushareData.subscribers)) {
        ushareData.subscribers.forEach((sub, index) => {
            const isPending = sub.status === 'Requested';
            
            // Extract consumption - handle multiple field name variations
            let consumption = 0;
            if (typeof sub.usedConsumption === 'number') {
                consumption = sub.usedConsumption;
            } else if (typeof sub.consumption === 'number') {
                consumption = sub.consumption;
            } else if (sub.usedConsumption) {
                consumption = parseFloat(sub.usedConsumption) || 0;
            } else if (sub.consumption) {
                // Could be string like "1.5 / 30 GB" or just a number string
                const consumptionStr = String(sub.consumption);
                const match = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                consumption = match ? parseFloat(match[1]) || 0 : parseFloat(consumptionStr) || 0;
            }
            
            // Extract quota - handle multiple field name variations
            let quota = 0;
            if (typeof sub.totalQuota === 'number') {
                quota = sub.totalQuota;
            } else if (typeof sub.quota === 'number') {
                quota = sub.quota;
            } else if (typeof sub.limit === 'number') {
                quota = sub.limit;
            } else if (sub.totalQuota) {
                quota = parseFloat(sub.totalQuota) || 0;
            } else if (sub.quota) {
                quota = parseFloat(sub.quota) || 0;
            } else if (sub.limit) {
                quota = parseFloat(sub.limit) || 0;
            } else if (sub.consumptionText) {
                // Parse from consumptionText (format: "0.48 / 30 GB")
                const match = sub.consumptionText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                if (match) {
                    quota = parseFloat(match[2]) || 0;
                }
            } else if (sub.consumption && typeof sub.consumption === 'string') {
                // Parse from consumption string (format: "1.18 / 30 GB")
                const match = String(sub.consumption).match(/([\d.]+)\s*\/\s*([\d.]+)/);
                if (match) {
                    quota = parseFloat(match[2]) || 0;
                }
            }
            
            console.log(`[Edit Subscriber] Subscriber ${sub.phoneNumber}: consumption=${consumption}, quota=${quota}`);
            
            const itemHtml = this.createEditSubscriberItem(
                sub.phoneNumber,
                consumption,
                quota,
                index,
                isPending
            );
            itemsContainer.insertAdjacentHTML('beforeend', itemHtml);
        });
    }
    
    // Bind events
    this.bindEditSubscribersEvents();
    
    // Attach blur handlers to all subscriber phone inputs
    this.attachPhoneNormalizationHandlers();
    
    // Update add button state
    this.updateEditAddSubscriberButtonState();
};

EditSubscriberPageManager.prototype.initEditSubscribersPageWithExistingData = function(subscriber) {
    // Set admin info
    const adminInfoEl = document.getElementById('editSubscribersAdminInfo');
    if (adminInfoEl) {
        adminInfoEl.innerHTML = `
            <h6 class="edit-subscribers-admin-name">${this.escapeHtml(subscriber.name)} - ${this.escapeHtml(subscriber.phone)} (${subscriber.quota || 0} GB)</h6>
        `;
    }
    
    // Load existing subscribers (confirmed and pending) using extractViewDetailsData
    this.loadSubscribersIntoEditPage(subscriber);
    
    // Bind event listeners
    this.bindEditSubscribersEvents();
};

EditSubscriberPageManager.prototype.loadSubscribersIntoEditPage = function(subscriber) {
    const itemsContainer = document.getElementById('editSubscribersItems');
    if (!itemsContainer) return;
    
    itemsContainer.innerHTML = '';
    
    // Get subscribers from View Details data (extractViewDetailsData equivalent)
    const viewData = this.extractViewDetailsData(subscriber);
    
    // Add confirmed subscribers
    viewData.subscribers.forEach((sub, index) => {
        const itemHtml = this.createEditSubscriberItem(sub.phoneNumber, sub.consumption, sub.limit, index, false);
        itemsContainer.insertAdjacentHTML('beforeend', itemHtml);
    });
    
    // Add pending subscribers
    if (viewData.pendingSubscribers && Array.isArray(viewData.pendingSubscribers)) {
        viewData.pendingSubscribers.forEach((pending, index) => {
            const itemHtml = this.createEditSubscriberItem(pending.phoneNumber || pending.phone, 0, pending.quota, viewData.subscribers.length + index, true);
            itemsContainer.insertAdjacentHTML('beforeend', itemHtml);
        });
    }
    
    // Bind events after loading
    this.bindEditSubscribersEvents();
    
    // Attach blur handlers to all subscriber phone inputs
    this.attachPhoneNormalizationHandlers();
    
    // Update add button state after loading subscribers
    this.updateEditAddSubscriberButtonState();
};

EditSubscriberPageManager.prototype.createEditSubscriberItem = function(phone, consumption, quota, index, isPending) {
    return `
        <div class="edit-subscriber-item" data-index="${index}" data-phone="${this.escapeHtml(phone)}" data-pending="${isPending}">
            <div class="edit-subscriber-fields">
                <div class="edit-subscriber-field">
                    <label>Subscriber</label>
                    <input type="tel" name="items[${index}].subscriber" value="${this.escapeHtml(phone)}" readonly disabled class="edit-subscriber-input readonly">
                </div>
                <div class="edit-subscriber-field">
                    <label>Consumption</label>
                    <input type="number" name="items[${index}].consumption" value="${consumption.toFixed(2)}" readonly disabled class="edit-subscriber-input readonly">
                </div>
                <div class="edit-subscriber-field">
                    <label>Quota</label>
                    <input type="number" step="any" name="items[${index}].quota" value="${quota}" ${isPending ? 'readonly disabled' : ''} class="edit-subscriber-input ${isPending ? 'readonly' : ''}">
                </div>
            </div>
            ${isPending ? '<span class="edit-subscriber-pending-badge">Requested</span>' : ''}
            <button type="button" class="edit-subscriber-remove-btn" data-index="${index}" data-phone="${this.escapeHtml(phone)}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
                Remove
            </button>
        </div>
        <hr class="edit-subscriber-divider">
    `;
};

EditSubscriberPageManager.prototype.attachPhoneNormalizationHandlers = function() {
    const itemsContainer = document.getElementById('editSubscribersItems');
    if (!itemsContainer) return;
    
    // Find all subscriber phone inputs
    const subscriberInputs = itemsContainer.querySelectorAll('input[name*="subscriber"]');
    
    subscriberInputs.forEach(input => {
        // Skip if already has handler
        if (input.dataset.normalizeHandler) return;
        
        // Skip readonly/disabled inputs (existing subscribers that can't be edited)
        if (input.readOnly || input.disabled) return;
        
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

EditSubscriberPageManager.prototype.bindEditSubscribersEvents = function() {
    // Close button - navigate back to insights
    const closeBtn = document.querySelector('.edit-subscribers-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.location.href = '/pages/insights.html';
        }, { capture: true });
    }
    
    // Remove subscriber button
    document.querySelectorAll('.edit-subscriber-remove-btn').forEach(btn => {
        btn.removeEventListener('click', btn._removeHandler); // Remove old handler if exists
        btn._removeHandler = (e) => {
            const index = e.currentTarget.dataset.index;
            this.removeEditSubscriberItem(index);
        };
        btn.addEventListener('click', btn._removeHandler);
    });
    
    // Add subscriber button
    const addBtn = document.getElementById('editSubscribersAddBtn');
    if (addBtn) {
        addBtn.removeEventListener('click', addBtn._addHandler); // Remove old handler if exists
        addBtn._addHandler = () => {
            this.addEditSubscriberItem();
        };
        addBtn.addEventListener('click', addBtn._addHandler);
        // Update button state initially
        this.updateEditAddSubscriberButtonState();
    }
    
    // Form submit
    const form = document.getElementById('editSubscribersForm');
    if (form) {
        form.removeEventListener('submit', form._submitHandler); // Remove old handler if exists
        form._submitHandler = (e) => {
            e.preventDefault();
            // Clear previous messages before submitting
            this.clearMessages();
            this.handleEditSubscribersSubmit();
        };
        form.addEventListener('submit', form._submitHandler);
    }
    
    // Normalize phone numbers on blur using focusout event (which bubbles) for dynamically added inputs
    const itemsContainer = document.getElementById('editSubscribersItems');
    if (itemsContainer) {
        // Remove existing listener if any (prevent duplicates)
        if (itemsContainer._phoneNormalizeHandler) {
            itemsContainer.removeEventListener('focusout', itemsContainer._phoneNormalizeHandler);
        }
        
        // Create handler function
        const phoneNormalizeHandler = (e) => {
            // Check if the blurred element is a subscriber phone input
            const input = e.target;
            if (input && input.tagName === 'INPUT' && input.name && input.name.includes('subscriber') && input.type !== 'number') {
                const normalized = this.normalizePhoneNumber(input.value);
                if (normalized && normalized !== input.value) {
                    input.value = normalized;
                }
            }
        };
        
        // Store reference and attach listener
        itemsContainer._phoneNormalizeHandler = phoneNormalizeHandler;
        itemsContainer.addEventListener('focusout', phoneNormalizeHandler, true); // Use capture phase
    }
};

EditSubscriberPageManager.prototype.removeEditSubscriberItem = function(index) {
    const itemsContainer = document.getElementById('editSubscribersItems');
    if (!itemsContainer) return;
    
    const item = document.querySelector(`.edit-subscriber-item[data-index="${index}"]`);
    if (item) {
        // Check if this is a new subscriber (just added, not saved yet)
        // data-is-new="true" attribute means it's a newly added row (not saved to server yet)
        const isNew = item.getAttribute('data-is-new') === 'true' || item.dataset.isNew === 'true';
        
        // Only skip confirmation for NEW subscribers (just added, not saved)
        // Active and Pending subscribers both require confirmation
        if (!isNew) {
            // Get subscriber phone for confirmation message
            const subscriberInput = item.querySelector('input[name*="subscriber"]');
            const subscriberPhone = subscriberInput ? subscriberInput.value.trim() : 'this subscriber';
            
            // Ask for confirmation before removing active or pending subscriber
            if (!confirm(`Are you sure you want to remove ${subscriberPhone}?`)) {
                return; // User cancelled
            }
        }
        // If it's a new subscriber, remove it immediately without confirmation
        
        const divider = item.nextElementSibling;
        if (divider && divider.classList.contains('edit-subscriber-divider')) {
            divider.remove();
        }
        item.remove();
        this.reindexEditSubscriberItems();
        // Update add button state after removing an item
        this.updateEditAddSubscriberButtonState();
    }
};

EditSubscriberPageManager.prototype.addEditSubscriberItem = function() {
    const itemsContainer = document.getElementById('editSubscribersItems');
    if (!itemsContainer) return;
    
    // Limit to maximum 3 subscriber rows
    const MAX_SUBSCRIBERS = 3;
    const existingItems = itemsContainer.querySelectorAll('.edit-subscriber-item');
    if (existingItems.length >= MAX_SUBSCRIBERS) {
        console.log(`⚠️ Maximum ${MAX_SUBSCRIBERS} subscribers allowed`);
        return;
    }
    
    // Find the highest index
    let maxIndex = -1;
    existingItems.forEach(item => {
        const idx = parseInt(item.dataset.index) || 0;
        if (idx > maxIndex) maxIndex = idx;
    });
    const newIndex = maxIndex + 1;
    
    // Create a new row with editable subscriber phone number input
    const itemHtml = `
        <div class="edit-subscriber-item" data-index="${newIndex}" data-phone="" data-pending="false" data-is-new="true">
            <div class="edit-subscriber-fields">
                <div class="edit-subscriber-field">
                    <label>Subscriber</label>
                    <input type="tel" name="items[${newIndex}].subscriber" value="" placeholder="Enter phone number (8 digits)" class="edit-subscriber-input" data-item-index="${newIndex}">
                </div>
                <div class="edit-subscriber-field">
                    <label>Consumption</label>
                    <input type="number" name="items[${newIndex}].consumption" value="0" readonly disabled class="edit-subscriber-input readonly">
                </div>
                <div class="edit-subscriber-field">
                    <label>Quota</label>
                    <input type="number" step="any" name="items[${newIndex}].quota" value="0" class="edit-subscriber-input" placeholder="Enter quota">
                </div>
            </div>
            <button type="button" class="edit-subscriber-remove-btn" data-index="${newIndex}" data-phone="">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
                Remove
            </button>
        </div>
        <hr class="edit-subscriber-divider">
    `;
    itemsContainer.insertAdjacentHTML('beforeend', itemHtml);
    
    // Re-bind events for the new item
    const newItem = itemsContainer.querySelector(`.edit-subscriber-item[data-index="${newIndex}"]`);
    if (newItem) {
        const removeBtn = newItem.querySelector('.edit-subscriber-remove-btn');
        if (removeBtn) {
            removeBtn._removeHandler = (e) => {
                this.removeEditSubscriberItem(newIndex);
            };
            removeBtn.addEventListener('click', removeBtn._removeHandler);
        }
    }
    
    // Attach blur handlers to all subscriber phone inputs (including the new one)
    this.attachPhoneNormalizationHandlers();
    
    // Update add button state after adding an item
    this.updateEditAddSubscriberButtonState();
};

EditSubscriberPageManager.prototype.updateEditAddSubscriberButtonState = function() {
    const itemsContainer = document.getElementById('editSubscribersItems');
    const addBtn = document.getElementById('editSubscribersAddBtn');
    const MAX_SUBSCRIBERS = 3;
    
    if (!itemsContainer || !addBtn) return;
    
    const existingItems = itemsContainer.querySelectorAll('.edit-subscriber-item');
    const currentCount = existingItems.length;
    
    if (currentCount >= MAX_SUBSCRIBERS) {
        // Hide the button completely when limit is reached
        addBtn.style.display = 'none';
    } else {
        // Show the button when below limit
        addBtn.style.display = '';
    }
};

EditSubscriberPageManager.prototype.reindexEditSubscriberItems = function() {
    const itemsContainer = document.getElementById('editSubscribersItems');
    if (!itemsContainer) return;
    
    const items = Array.from(itemsContainer.querySelectorAll('.edit-subscriber-item'));
    items.forEach((item, newIndex) => {
        const oldIndex = item.dataset.index;
        item.dataset.index = newIndex;
        
        // Update input names
        item.querySelectorAll('input').forEach(input => {
            const name = input.name;
            if (name) {
                input.name = name.replace(`[${oldIndex}]`, `[${newIndex}]`);
            }
        });
        
        // Update remove button data-index
        const removeBtn = item.querySelector('.edit-subscriber-remove-btn');
        if (removeBtn) {
            removeBtn.dataset.index = newIndex;
        }
    });
};

// Extract view details data - simplified version based on insights.js
EditSubscriberPageManager.prototype.extractViewDetailsData = function(subscriber) {
    // Admin limit should always be the quota set when creating the admin
    let adminLimit = 0;
    if (subscriber.quota) {
        const quotaStr = String(subscriber.quota).trim();
        const quotaMatch = quotaStr.match(/^([\d.]+)/);
        adminLimit = quotaMatch ? parseFloat(quotaMatch[1]) : parseFloat(quotaStr) || 0;
    } else if (subscriber.adminLimit) {
        adminLimit = subscriber.adminLimit;
    }
    
    const data = {
        adminPhone: subscriber.phone,
        adminConsumption: subscriber.adminConsumption || 0,
        adminLimit: adminLimit,
        subscribers: [],
        pendingSubscribers: [],
        removedSubscribers: subscriber.removedSubscribers || [],
        removedActiveSubscribers: subscriber.removedActiveSubscribers || [],
        totalConsumption: subscriber.totalConsumption || 0,
        totalLimit: subscriber.totalLimit || 0,
        hasUshareHtmlData: false
    };
    
    // PRIORITY 1: Get subscriber data from secondarySubscribers array (from ushare HTML)
    const hasUshareHtmlArray = subscriber.alfaData && subscriber.alfaData.secondarySubscribers && Array.isArray(subscriber.alfaData.secondarySubscribers);
    if (hasUshareHtmlArray) {
        data.hasUshareHtmlData = true;
        if (subscriber.alfaData.secondarySubscribers.length > 0) {
            subscriber.alfaData.secondarySubscribers.forEach((secondary) => {
                if (secondary && secondary.phoneNumber) {
                    let used = 0;
                    let total = 0;
                    
                    // Try multiple ways to extract consumption and quota
                    // Priority 1: Direct numeric values
                    if (typeof secondary.consumption === 'number' && typeof secondary.quota === 'number') {
                        used = secondary.consumption;
                        total = secondary.quota;
                    } 
                    // Priority 2: Check for totalQuota field (used in ushare data)
                    else if (typeof secondary.consumption === 'number' && typeof secondary.totalQuota === 'number') {
                        used = secondary.consumption;
                        total = secondary.totalQuota;
                    }
                    // Priority 3: Check for limit field
                    else if (typeof secondary.consumption === 'number' && typeof secondary.limit === 'number') {
                        used = secondary.consumption;
                        total = secondary.limit;
                    }
                    // Priority 4: Parse from consumptionText string (format: "X / Y GB")
                    else if (secondary.consumptionText) {
                        const consumptionMatch = secondary.consumptionText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                        if (consumptionMatch) {
                            used = parseFloat(consumptionMatch[1]) || 0;
                            total = parseFloat(consumptionMatch[2]) || 0;
                        }
                    } 
                    // Priority 5: Parse from consumption string (format: "X / Y GB")
                    else if (secondary.consumption) {
                        const consumptionMatch = String(secondary.consumption).match(/([\d.]+)\s*\/\s*([\d.]+)/);
                        if (consumptionMatch) {
                            used = parseFloat(consumptionMatch[1]) || 0;
                            total = parseFloat(consumptionMatch[2]) || 0;
                        }
                    }
                    
                    // Fallback: If we have consumption but no quota yet, try to get quota from other fields
                    if (used > 0 && total === 0) {
                        if (typeof secondary.quota === 'number') {
                            total = secondary.quota;
                        } else if (typeof secondary.totalQuota === 'number') {
                            total = secondary.totalQuota;
                        } else if (typeof secondary.limit === 'number') {
                            total = secondary.limit;
                        } else if (secondary.quota) {
                            total = parseFloat(secondary.quota) || 0;
                        } else if (secondary.totalQuota) {
                            total = parseFloat(secondary.totalQuota) || 0;
                        } else if (secondary.limit) {
                            total = parseFloat(secondary.limit) || 0;
                        }
                    }
                    
                    // Fallback: If we have quota but no consumption, try to get consumption
                    if (total > 0 && used === 0) {
                        if (typeof secondary.consumption === 'number') {
                            used = secondary.consumption;
                        } else if (secondary.consumption) {
                            used = parseFloat(secondary.consumption) || 0;
                        }
                    }
                    
                    if (secondary.phoneNumber) {
                        const subscriberStatus = secondary.status || 'Active';
                        data.subscribers.push({
                            phoneNumber: secondary.phoneNumber,
                            fullPhoneNumber: secondary.fullPhoneNumber || secondary.phoneNumber,
                            status: subscriberStatus,
                            consumption: used,
                            limit: total
                        });
                    }
                }
            });
        }
    }
    
    // If no Ushare HTML data, don't show pending subscribers (they're stale)
    if (!data.hasUshareHtmlData && subscriber.pendingSubscribers && Array.isArray(subscriber.pendingSubscribers)) {
        const activePending = subscriber.pendingSubscribers.filter(pending => {
            const pendingPhone = String(pending.phone || '').trim();
            return !(data.removedSubscribers || []).includes(pendingPhone);
        });
        data.pendingSubscribers = activePending;
    }
    
    return data;
};

// Submit handler - adapted from insights.js handleEditSubscribersSubmit
EditSubscriberPageManager.prototype.handleEditSubscribersSubmit = async function() {
    // Prevent duplicate submissions
    if (this.isSubmittingEditForm) {
        console.log('⏸️ Form submission already in progress, ignoring duplicate request');
        return;
    }
    
    if (!this.editingAdminId) {
        console.error('No admin ID set for editing');
        return;
    }
    
    this.isSubmittingEditForm = true;
    
    // Show loading animation
    this.showPageLoading('Processing subscriber changes...');
    
    // Disable submit button to prevent multiple clicks
    const submitButton = document.querySelector('#editSubscribersForm button[type="submit"]');
    let originalButtonText = '';
    if (submitButton) {
        originalButtonText = submitButton.textContent;
        submitButton.disabled = true;
        submitButton.textContent = 'Processing...';
    }
    
    try {
        const itemsContainer = document.getElementById('editSubscribersItems');
        if (!itemsContainer) {
            this.isSubmittingEditForm = false;
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = originalButtonText;
            }
            return;
        }
        
        const items = Array.from(itemsContainer.querySelectorAll('.edit-subscriber-item'));
        const updates = [];
        const removals = [];
        const additions = [];
        
        // Get original subscriber data to compare
        const subscriber = this.subscribers.find(s => s.id === this.editingAdminId);
        if (!subscriber) {
            console.error('Subscriber not found');
            this.isSubmittingEditForm = false;
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = originalButtonText;
            }
            return;
        }
        
        const viewData = this.extractViewDetailsData(subscriber);
        const originalSubscribers = viewData.subscribers.map(s => s.phoneNumber);
        const originalPending = (viewData.pendingSubscribers || []).map(p => p.phoneNumber || p.phone);
        
        // Check for duplicate subscriber numbers (only for new additions)
        // Normalize phone numbers for comparison
        const normalizePhoneForComparison = (phone) => {
            return (phone || '').replace(/^961/, '').replace(/^0+/, '').replace(/\D/g, '');
        };
        
        // Build comprehensive set of all existing subscriber numbers
        // Include both active and pending/requested subscribers
        const allExistingPhones = new Set();
        
        // Add active subscribers (status = "Active" or no status)
        originalSubscribers.forEach(phone => {
            if (phone) {
                allExistingPhones.add(normalizePhoneForComparison(phone));
            }
        });
        
        // Add pending subscribers from pendingSubscribers array
        originalPending.forEach(phone => {
            if (phone) {
                allExistingPhones.add(normalizePhoneForComparison(phone));
            }
        });
        
        // Also check secondarySubscribers directly for "Requested" status subscribers
        // (in case they're not in pendingSubscribers array)
        const alfaData = subscriber.alfaData || {};
        const secondarySubscribers = alfaData.secondarySubscribers || [];
        secondarySubscribers.forEach(sub => {
            if (sub && sub.phoneNumber) {
                const status = (sub.status || '').toLowerCase();
                // Include both "Active" and "Requested" status
                if (status === 'active' || status === 'requested' || !status) {
                    const normalizedPhone = normalizePhoneForComparison(sub.phoneNumber);
                    allExistingPhones.add(normalizedPhone);
                }
            }
        });
        
        // Also check subscriber.pendingSubscribers directly (if exists)
        if (subscriber.pendingSubscribers && Array.isArray(subscriber.pendingSubscribers)) {
            subscriber.pendingSubscribers.forEach(pending => {
                const phone = pending.phoneNumber || pending.phone;
                if (phone) {
                    allExistingPhones.add(normalizePhoneForComparison(phone));
                }
            });
        }
        
        const duplicateNewSubscribers = [];
        items.forEach((item) => {
            const subscriberInput = item.querySelector('input[name*="subscriber"]');
            const isNew = item.dataset.isNew === 'true';
            const originalPhone = item.dataset.phone;
            
            if (subscriberInput && isNew) {
                let phone = subscriberInput.value.trim();
                if (phone) {
                    phone = this.normalizePhoneNumber(phone);
                    const normalizedPhone = normalizePhoneForComparison(phone);
                    
                    // Check if this new subscriber already exists
                    if (allExistingPhones.has(normalizedPhone)) {
                        duplicateNewSubscribers.push(phone);
                    } else {
                        // Also check against other new subscribers in the same form to prevent duplicates within the form
                        allExistingPhones.add(normalizedPhone);
                    }
                }
            } else if (subscriberInput && originalPhone) {
                // For existing subscribers being edited, add their normalized phone to the set
                let phone = subscriberInput.value.trim();
                if (phone) {
                    phone = this.normalizePhoneNumber(phone);
                    const normalizedPhone = normalizePhoneForComparison(phone);
                    allExistingPhones.add(normalizedPhone);
                }
            }
        });
        
        if (duplicateNewSubscribers.length > 0) {
            alert(`Cannot add subscribers - the following numbers already exist for this admin:\n\n${duplicateNewSubscribers.join('\n')}\n\nPlease remove the duplicate subscriber numbers and try again.`);
            this.isSubmittingEditForm = false;
            this.hidePageLoading();
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = originalButtonText;
            }
            return;
        }
        
        // Collect data from form
        items.forEach((item) => {
            const subscriberInput = item.querySelector('input[name*="subscriber"]');
            const quotaInput = item.querySelector('input[name*="quota"]');
            const isPending = item.dataset.pending === 'true';
            const originalPhone = item.dataset.phone;
            const isNew = item.dataset.isNew === 'true';
            
            if (subscriberInput && quotaInput) {
                let phone = subscriberInput.value.trim();
                const quota = parseFloat(quotaInput.value) || 0;
                
                if (!phone) return; // Skip empty rows
                
                // Normalize phone number
                phone = this.normalizePhoneNumber(phone);
                
                if (isNew) {
                    additions.push({ phone, quota });
                } else if (originalPhone && originalPhone !== phone) {
                    removals.push(originalPhone);
                    additions.push({ phone, quota });
                } else if (originalPhone && originalPhone === phone) {
                    const originalQuota = isPending 
                        ? (viewData.pendingSubscribers.find(p => (p.phoneNumber || p.phone) === phone)?.quota || 0)
                        : (viewData.subscribers.find(s => s.phoneNumber === phone)?.limit || 0);
                    
                    if (quota !== originalQuota) {
                        updates.push({ phone, quota });
                    }
                }
            }
        });
        
        // Find removed subscribers (in original but not in form)
        const currentPhones = items
            .map(item => {
                const input = item.querySelector('input[name*="subscriber"]');
                if (!input) return '';
                const phone = input.value.trim();
                return phone ? this.normalizePhoneNumber(phone) : '';
            })
            .filter(phone => phone);
        
        originalSubscribers.forEach(phone => {
            if (!currentPhones.includes(phone)) {
                removals.push(phone);
            }
        });
        
        originalPending.forEach(phone => {
            if (!currentPhones.includes(phone)) {
                removals.push(phone);
            }
        });
        
        // Call backend API
        const adminId = this.editingAdminId;
        const results = {
            additions: [],
            updates: [],
            removals: []
        };
        
        // Process additions
        for (const addition of additions) {
            try {
                console.log(`🔄 [Edit Subscriber] Adding subscriber ${addition.phone} with quota ${addition.quota}...`);
                const result = await window.AlfaAPIService.addSubscriber(adminId, addition.phone, addition.quota);
                
                // CRITICAL: Verify result - if API call succeeded (no exception), it means success
                // The API throws an error if result.success is false, so if we reach here, it's success
                console.log(`✅ [Edit Subscriber] Successfully added subscriber ${addition.phone}`, result);
                results.additions.push({ phone: addition.phone, success: true });
            } catch (error) {
                // CRITICAL: Log full error details for debugging
                console.error(`❌ [Edit Subscriber] Error adding subscriber ${addition.phone}:`, {
                    message: error.message,
                    error: error,
                    stack: error.stack
                });
                
                // Mark as failure only if we got a clear error
                const errorMessage = error.message || String(error);
                results.additions.push({ 
                    phone: addition.phone, 
                    success: false, 
                    error: errorMessage || 'Unknown error' 
                });
            }
        }
        
        // Process updates
        for (const update of updates) {
            try {
                await window.AlfaAPIService.editSubscriber(adminId, update.phone, update.quota);
                results.updates.push({ phone: update.phone, success: true });
            } catch (error) {
                console.error(`❌ Failed to update subscriber ${update.phone}:`, error);
                results.updates.push({ phone: update.phone, success: false, error: error.message });
            }
        }
        
        // Process removals in parallel
        if (removals.length > 0) {
            const removalPromises = removals.map((phone) => {
                return window.AlfaAPIService.removeSubscriber(adminId, phone, true)
                    .then(() => ({ phone, success: true }))
                    .catch((error) => {
                        console.error(`❌ Failed to remove subscriber ${phone}:`, error);
                        return { phone, success: false, error: error.message };
                    });
            });
            results.removals = await Promise.all(removalPromises);
        }
        
        // Clear previous messages before showing new ones
        this.clearMessages();
        
        // Check if all operations succeeded
        const allSuccess = 
            results.additions.every(r => r.success) &&
            results.updates.every(r => r.success) &&
            results.removals.every(r => r.success);
        
        // Determine operation types (used in multiple places)
        const hasAdditions = results.additions.length > 0 && results.additions.some(r => r.success);
        const hasRemovals = results.removals.length > 0 && results.removals.some(r => r.success);
        const hasUpdates = results.updates.length > 0 && results.updates.some(r => r.success);
        const hasRemovalsOrUpdates = hasRemovals || hasUpdates;
        const hasFailedAdditions = results.additions.some(r => !r.success);
        
        // Debug logging
        console.log('📊 [Edit Subscriber] Operation results:', {
            allSuccess,
            hasAdditions,
            hasFailedAdditions,
            additions: results.additions.map(r => ({ phone: r.phone, success: r.success, error: r.error })),
            updates: results.updates.map(r => ({ phone: r.phone, success: r.success })),
            removals: results.removals.map(r => ({ phone: r.phone, success: r.success }))
        });
        
        // CRITICAL: Hide loading animation immediately after operations complete (before refresh)
        // This ensures the user sees the result right away, not after refresh completes
        this.hidePageLoading();
        this.isSubmittingEditForm = false;
        if (submitButton && originalButtonText) {
            submitButton.disabled = false;
            submitButton.textContent = originalButtonText;
        }
        
        // CRITICAL: If we have successful additions, always show success messages first
        // Even if some operations failed, we should acknowledge the successful ones
        if (hasAdditions) {
            // Subscribers were added - generate and display success messages for each successful addition
            const successMessages = [];
            results.additions.forEach(result => {
                if (result.success) {
                    const additionItem = additions.find(a => a.phone === result.phone);
                    if (additionItem && subscriber) {
                        const adminPhone = subscriber.phone || '';
                        const quota = additionItem.quota !== undefined && additionItem.quota !== null ? additionItem.quota : 0;
                        const message = `Send ${adminPhone} to 1323 (${quota} GB)`;
                        successMessages.push(message);
                    }
                }
            });
            
            // Display all success messages (each on a separate line with copy button)
            if (successMessages.length > 0) {
                this.displayMessages(successMessages, 'success');
                // Also copy first message to clipboard (for backward compatibility)
                this.copyToClipboard(successMessages[0]).catch(() => {});
            }
            
            // Show toast notification for successful additions
            if (typeof window !== 'undefined' && window.notification) {
                window.notification.set({ delay: 3000 });
                window.notification.success('Subscriber added successfully!');
            } else if (typeof notification !== 'undefined') {
                notification.set({ delay: 3000 });
                notification.success('Subscriber added successfully!');
            }
        }
        
        if (allSuccess) {
            // All operations succeeded - success messages already shown above if hasAdditions
            // Only handle removals/updates here
            if (!hasAdditions) {
                // No additions - only removals/updates - wait for refresh then redirect
                // Show toast notification based on operation type
                if (hasRemovals) {
                    // Show removal success toast
                    if (typeof window !== 'undefined' && window.notification) {
                        window.notification.set({ delay: 3000 });
                        window.notification.success('Subscriber removed successfully!');
                    } else if (typeof notification !== 'undefined') {
                        notification.set({ delay: 3000 });
                        notification.success('Subscriber removed successfully!');
                    } else {
                        alert(`✅ Successfully removed ${results.removals.length} subscriber(s)!`);
                    }
                } else {
                    // Updates only
                    if (typeof window !== 'undefined' && window.notification) {
                        window.notification.set({ delay: 3000 });
                        window.notification.success('Subscriber updated successfully!');
                    } else if (typeof notification !== 'undefined') {
                        notification.set({ delay: 3000 });
                        notification.success('Subscriber updated successfully!');
                    } else {
                        alert(`✅ Successfully updated ${results.updates.length} subscriber(s)!`);
                    }
                }
                
                // Note: Refresh will happen below, and redirect will happen after refresh completes
            }
        } else {
            // Some operations failed
            // Note: If hasAdditions is true, success messages were already shown above
            const hasFailedRemovals = results.removals.some(r => !r.success);
            const hasFailedUpdates = results.updates.some(r => !r.success);
            
            // Only show cancel message if ADDITION operations failed AND we don't have successful additions
            // If we have successful additions, they were already shown above, so only show error for failed ones
            if (hasFailedAdditions && !hasAdditions) {
                const cancelMessage = `Cancel old service\n*111*7*2*1*2*1#`;
                await this.copyToClipboard(cancelMessage);
                
                // Display cancel message with copy button
                this.displayMessages([cancelMessage], 'error');
                
                // Show toast notification
                if (typeof window !== 'undefined' && window.notification) {
                    window.notification.set({ delay: 3000 });
                    window.notification.error('Operation failed. Cancel message copied to clipboard automatically');
                } else if (typeof notification !== 'undefined') {
                    notification.set({ delay: 3000 });
                    notification.error('Operation failed. Cancel message copied to clipboard automatically');
                }
            } else {
                // Removal or update failed - show error messages without cancel message
                const failed = [
                    ...results.removals.filter(r => !r.success).map(r => `Remove ${r.phone}: ${r.error || 'Unknown error'}`),
                    ...results.updates.filter(r => !r.success).map(r => `Update ${r.phone}: ${r.error || 'Unknown error'}`)
                ];
                
                // Display error messages
                if (failed.length > 0) {
                    this.displayMessages(failed, 'error');
                }
                
                // Show toast notification
                if (typeof window !== 'undefined' && window.notification) {
                    window.notification.set({ delay: 3000 });
                    window.notification.error(`${failed.length} operation(s) failed`);
                } else if (typeof notification !== 'undefined') {
                    notification.set({ delay: 3000 });
                    notification.error(`${failed.length} operation(s) failed`);
                } else {
                    const successCount = 
                        results.additions.filter(r => r.success).length +
                        results.updates.filter(r => r.success).length +
                        results.removals.filter(r => r.success).length;
                    alert(`⚠️ Some operations failed (${successCount} succeeded). Errors:\n${failed.join('\n')}`);
                }
            }
        }
        
        // Refresh admin after successful operations
        // For additions: wait for refresh to complete (user stays on page)
        // For removals/updates: wait for refresh to complete, then redirect (ensures insights page shows updated data)
        const hasSuccessfulOperations = hasRemovals || hasAdditions || hasUpdates;
        
        console.log('🔄 [Edit Subscriber] Refresh check:', {
            hasSuccessfulOperations,
            hasRemovals,
            hasAdditions,
            hasUpdates,
            hasRemovalsOrUpdates,
            alfaAPIServiceAvailable: !!window.AlfaAPIService,
            adminId
        });
        
        if (hasSuccessfulOperations && window.AlfaAPIService) {
            // For additions: refresh in background (fire-and-forget)
            // For removals/updates: refresh and then redirect
            if (hasAdditions) {
                // Refresh in background for additions (non-blocking)
                console.log('🔄 [Edit Subscriber] Refreshing admin data in background after additions...');
                window.AlfaAPIService.refreshAdmin(adminId).then(() => {
                    console.log('✅ [Edit Subscriber] Background admin refresh completed');
                }).catch(error => {
                    console.error('⚠️ [Edit Subscriber] Error during background admin refresh:', error);
                });
            } else if (hasRemovalsOrUpdates) {
                // For removals/updates: refresh in background and redirect (don't show loading - already hidden)
                console.log('🔄 [Edit Subscriber] Refreshing admin data in background before redirect...');
                
                // Start refresh in background (don't await - let it run while we redirect)
                window.AlfaAPIService.refreshAdmin(adminId).then(() => {
                    console.log('✅ [Edit Subscriber] Background admin refresh completed');
                }).catch(error => {
                    console.error('⚠️ [Edit Subscriber] Error during background admin refresh:', error);
                    // Don't block redirect if refresh fails
                });
                
                // Redirect immediately (don't wait for refresh - it will complete in background)
                console.log('🔄 [Edit Subscriber] Redirecting to insights page...');
                setTimeout(() => {
                    window.location.href = '/pages/insights.html';
                }, 500);
                return; // Exit early since we're redirecting
            }
        } else {
            console.warn('⚠️ [Edit Subscriber] Refresh skipped:', {
                hasSuccessfulOperations,
                alfaAPIServiceAvailable: !!window.AlfaAPIService
            });
            
            // If we have removals/updates but refresh didn't happen, still redirect
            if (hasRemovalsOrUpdates && !hasAdditions) {
                console.log('🔄 [Edit Subscriber] Redirecting to insights page (no refresh needed or available)...');
                setTimeout(() => {
                    window.location.href = '/pages/insights.html';
                }, 1000);
                return; // Exit early since we're redirecting
            }
        }
        
    } catch (error) {
        console.error('❌ Error calling API:', error);
        alert('Error updating subscribers: ' + (error.message || 'Please try again.'));
    } finally {
        // Always reset flag and cleanup (except if we already reset it before redirect or if we're redirecting)
        // The redirect checks above already reset the flag, so this is a safety net
        // Only hide loading if we're not redirecting (redirect cases handle their own loading)
        if (this.isSubmittingEditForm) {
            this.isSubmittingEditForm = false;
            this.hidePageLoading();
            
            // Re-enable submit button
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = originalButtonText;
            }
        }
    }
};

// Display messages in the messages container (same as add subscriber page)
EditSubscriberPageManager.prototype.displayMessages = function(messages, type = 'success') {
    const container = document.getElementById('editSubscribersMessagesContainer');
    const messagesList = document.getElementById('editSubscribersMessagesList');
    
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
EditSubscriberPageManager.prototype.clearMessages = function() {
    const container = document.getElementById('editSubscribersMessagesContainer');
    const messagesList = document.getElementById('editSubscribersMessagesList');
    
    if (container) {
        container.style.display = 'none';
    }
    if (messagesList) {
        messagesList.innerHTML = '';
    }
};

