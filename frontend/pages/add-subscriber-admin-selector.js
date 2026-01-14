// Add Subscriber Page - Admin Selector Functions (extends AddSubscriberPageManager prototype)
// Extracted and adapted from insights.js modal functions

AddSubscriberPageManager.prototype.isAdminAvailableService = function(admin) {
    // Must be active
    if (admin.status !== 'active') {
        return false;
    }
    
    // Count subscribers by status (Active, Requested, Out)
    const activeCount = admin.subscribersActiveCount || 0;
    const requestedCount = admin.subscribersRequestedCount || 0;
    const removedActiveSubscribers = admin.removedActiveSubscribers || [];
    const outCount = Array.isArray(removedActiveSubscribers) ? removedActiveSubscribers.length : 0;
    
    // NEW EXCLUSION LOGIC: Check if admin matches any of the 9 exclusion conditions
    // 1. One active and two requested
    if (activeCount === 1 && requestedCount === 2 && outCount === 0) {
        return false; // Exclude this admin
    }
    // 2. Three requested
    if (activeCount === 0 && requestedCount === 3 && outCount === 0) {
        return false; // Exclude this admin
    }
    // 3. Three active
    if (activeCount === 3 && requestedCount === 0 && outCount === 0) {
        return false; // Exclude this admin
    }
    // 4. Two active and one requested
    if (activeCount === 2 && requestedCount === 1 && outCount === 0) {
        return false; // Exclude this admin
    }
    // 5. One active and two out
    if (activeCount === 1 && requestedCount === 0 && outCount === 2) {
        return false; // Exclude this admin
    }
    // 6. Two active and one out
    if (activeCount === 2 && requestedCount === 0 && outCount === 1) {
        return false; // Exclude this admin
    }
    // 7. One active and one requested and one out
    if (activeCount === 1 && requestedCount === 1 && outCount === 1) {
        return false; // Exclude this admin
    }
    // 8. Two requested and one out
    if (activeCount === 0 && requestedCount === 2 && outCount === 1) {
        return false; // Exclude this admin
    }
    // 9. Two out and one requested
    if (activeCount === 0 && requestedCount === 1 && outCount === 2) {
        return false; // Exclude this admin
    }
    
    // TERM 1 & 2: Admin must have less than 3 total subscribers (active + requested + removed "Out" subscribers)
    const totalSubscribersCount = activeCount + requestedCount + outCount;
    if (totalSubscribersCount >= 3) {
        return false; // Exclude this admin
    }
    
    // TERM 3: Admin must have minimum 20 days before validity date
    const validityDateStr = admin.validityDate || '';
    
    // Helper function to parse DD/MM/YYYY date
    const parseDDMMYYYY = (dateStr) => {
        if (!dateStr || dateStr === 'N/A' || dateStr.trim() === '') return null;
        const parts = String(dateStr).trim().split('/');
        if (parts.length !== 3) return null;
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
        const year = parseInt(parts[2], 10);
        if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
        return new Date(year, month, day);
    };
    
    // Helper function to calculate days until validity date
    const daysUntilValidity = (dateStr) => {
        const validityDate = parseDDMMYYYY(dateStr);
        if (!validityDate) return null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        validityDate.setHours(0, 0, 0, 0);
        const diffTime = validityDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays;
    };
    
    const daysUntil = daysUntilValidity(validityDateStr);
    if (daysUntil === null || daysUntil < 20) {
        return false; // Exclude if validity date is invalid or less than 20 days away
    }
    
    return true; // All criteria passed
};

AddSubscriberPageManager.prototype.openAdminSelector = function(itemIndex) {
    try {
        const modal = document.getElementById('adminSelectorModal');
        if (!modal) {
            console.error('Admin selector modal not found');
            return;
        }
        
        // Store the current item index for when admin is selected
        modal.dataset.itemIndex = itemIndex;
        
        // Get active admins that match "Available Services" criteria
        let activeAdmins = [];
        try {
            activeAdmins = this.subscribers.filter(sub => {
                try {
                    return this.isAdminAvailableService(sub);
                } catch (error) {
                    console.error('Error checking admin availability:', error, sub);
                    return false; // Skip admins that cause errors
                }
            });
        } catch (error) {
            console.error('Error filtering admins:', error);
            // Fallback to all active admins if filtering fails
            activeAdmins = this.subscribers.filter(sub => sub.status === 'active');
        }
        
        // Populate the modal
        this.populateAdminSelector(activeAdmins);
        
        // Show modal with animation
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
        
        // Get search input element
        const searchInput = document.getElementById('adminSelectorSearch');
        
        // Only auto-focus search input on desktop (not mobile to avoid keyboard popup)
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
        if (!isMobile && searchInput) {
            setTimeout(() => searchInput.focus(), 100);
        }
        
        // Bind search functionality
        if (searchInput) {
            searchInput.oninput = (e) => {
                const searchTerm = e.target.value.toLowerCase().trim();
                this.filterAdminSelector(searchTerm, activeAdmins);
            };
        }
        
        // Bind close button
        const closeBtn = modal.querySelector('.admin-selector-close');
        if (closeBtn) {
            closeBtn.removeAttribute('onclick');
            closeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.closeAdminSelector();
            }, { capture: true });
        }
        
        // Close on overlay click
        modal.onclick = (e) => {
            if (e.target === modal) {
                this.closeAdminSelector();
            }
        };
    } catch (error) {
        console.error('Error opening admin selector:', error);
        alert('Error opening admin selector. Please check the console for details.');
    }
};

AddSubscriberPageManager.prototype.closeAdminSelector = function() {
    const modal = document.getElementById('adminSelectorModal');
    if (modal) {
        modal.classList.remove('show');
        document.body.style.overflow = '';
        
        // Clear search
        const searchInput = document.getElementById('adminSelectorSearch');
        if (searchInput) {
            searchInput.value = '';
        }
    }
};

AddSubscriberPageManager.prototype.calculateAdminSelectorData = function(admin) {
    const alfaData = admin.alfaData || {};
    
    // Use values directly from insights table (already calculated)
    const packageSize = admin.totalLimit || 0;
    const adminQuota = admin.adminLimit || 0;
    
    // Use subscriber counts from insights table
    const activeCount = admin.subscribersActiveCount || 0;
    const requestedCount = admin.subscribersRequestedCount || 0;
    const removedActiveSubscribers = admin.removedActiveSubscribers || [];
    const outCount = Array.isArray(removedActiveSubscribers) ? removedActiveSubscribers.length : 0;
    const subscriberCount = activeCount + requestedCount + outCount;
    
    // Get subscriber quotas from secondarySubscribers (active/requested) and removedActiveSubscribers (out)
    const secondarySubscribers = alfaData.secondarySubscribers || [];
    const subscriberQuotas = [];
    
    // Add quotas from active/requested subscribers
    if (Array.isArray(secondarySubscribers)) {
        secondarySubscribers.forEach(sub => {
            if (sub && sub.phoneNumber) {
                let quota = 0;
                
                // Try multiple sources for quota (same logic as flow-manager.js)
                if (typeof sub.quota === 'number') {
                    quota = sub.quota;
                } else if (sub.totalQuota) {
                    quota = parseFloat(sub.totalQuota) || 0;
                } else if (sub.consumptionText) {
                    // Parse from consumptionText (format: "0.48 / 30 GB") - get the number after "/"
                    const consumptionMatch = sub.consumptionText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    if (consumptionMatch) {
                        quota = parseFloat(consumptionMatch[2]) || 0; // Second number is the quota
                    }
                } else if (sub.consumption) {
                    // Parse from consumption string (format: "1.18 / 30 GB") - get the number after "/"
                    const consumptionStr = String(sub.consumption);
                    const consumptionMatch = consumptionStr.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                    if (consumptionMatch) {
                        quota = parseFloat(consumptionMatch[2]) || 0; // Second number is the quota
                    }
                } else if (sub.limit) {
                    quota = parseFloat(sub.limit) || 0;
                }
                
                if (quota > 0) {
                    subscriberQuotas.push(quota);
                }
            }
        });
    }
    
    // Add quotas from out subscribers (removedActiveSubscribers)
    if (Array.isArray(removedActiveSubscribers)) {
        removedActiveSubscribers.forEach(sub => {
            if (sub && sub.phoneNumber) {
                let quota = 0;
                
                // Try multiple sources for quota
                if (typeof sub.quota === 'number') {
                    quota = sub.quota;
                } else if (sub.limit) {
                    quota = parseFloat(sub.limit) || 0;
                }
                
                if (quota > 0) {
                    subscriberQuotas.push(quota);
                }
            }
        });
    }
    
    // Calculate free space: package size - (admin quota + sum of all subscriber quotas)
    const totalSubscriberQuota = subscriberQuotas.reduce((sum, q) => sum + q, 0);
    const freeSpace = Math.max(0, packageSize - (adminQuota + totalSubscriberQuota));
    
    // Get validity date and calculate days remaining
    const validityDate = alfaData.validityDate || admin.validityDate || '';
    let daysRemaining = null;
    if (validityDate && validityDate !== 'N/A' && validityDate.trim() !== '') {
        const parts = String(validityDate).trim().split('/');
        if (parts.length === 3) {
            const day = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10) - 1;
            const year = parseInt(parts[2], 10);
            if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
                const validityDateObj = new Date(year, month, day);
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                validityDateObj.setHours(0, 0, 0, 0);
                const diffTime = validityDateObj.getTime() - today.getTime();
                daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            }
        }
    }
    
    return {
        packageSize,
        adminQuota,
        subscriberCount,
        subscriberQuotas,
        freeSpace,
        validityDate,
        daysRemaining
    };
};

AddSubscriberPageManager.prototype.populateAdminSelector = function(admins) {
    const list = document.getElementById('adminSelectorList');
    if (!list) return;
    
    list.innerHTML = '';
    
    if (admins.length === 0) {
        list.innerHTML = '<div class="admin-selector-empty">No active admins available</div>';
        return;
    }
    
    // Sort admins by validity date from farthest to nearest (descending order by date)
    const sortedAdmins = [...admins].sort((a, b) => {
        const alfaDataA = a.alfaData || {};
        const alfaDataB = b.alfaData || {};
        const validityDateA = alfaDataA.validityDate || '';
        const validityDateB = alfaDataB.validityDate || '';
        
        if (!validityDateA && !validityDateB) return 0;
        if (!validityDateA) return 1; // A goes last
        if (!validityDateB) return -1; // B goes last
        
        // Parse dates (DD/MM/YYYY format)
        const parseDate = (dateStr) => {
            const parts = String(dateStr).trim().split('/');
            if (parts.length !== 3) return null;
            const day = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10) - 1;
            const year = parseInt(parts[2], 10);
            if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
            return new Date(year, month, day);
        };
        
        const dateA = parseDate(validityDateA);
        const dateB = parseDate(validityDateB);
        
        if (!dateA && !dateB) return 0;
        if (!dateA) return 1;
        if (!dateB) return -1;
        
        // Sort in descending order (farthest date first)
        return dateB.getTime() - dateA.getTime();
    });
    
    sortedAdmins.forEach((admin, index) => {
        const data = this.calculateAdminSelectorData(admin);
        const item = document.createElement('div');
        item.className = 'admin-selector-item';
        item.style.animationDelay = `${index * 0.05}s`;
        item.onclick = () => this.selectAdmin(admin);
        
        // Format subscriber quotas
        const subscriberQuotasStr = data.subscriberQuotas.length > 0
            ? data.subscriberQuotas.map(q => `${q} GB`).join(', ')
            : '';
        const subscribersInfo = data.subscriberCount > 0 
            ? (subscriberQuotasStr 
                ? `Subscribers: ${data.subscriberCount} (${subscriberQuotasStr})`
                : `Subscribers: ${data.subscriberCount}`)
            : 'Subscribers: 0';
        
        // Format validity date info
        const validityInfo = data.validityDate && data.daysRemaining !== null
            ? `Expiry Date: ${data.validityDate} (${data.daysRemaining} days)`
            : data.validityDate || '';
        
        item.innerHTML = `
            <div class="admin-selector-item-info">
                <div class="admin-selector-item-header">
                    <span class="admin-selector-item-name">${this.escapeHtml(admin.name || 'Unknown')}</span>
                    ${data.packageSize > 0 ? `<span class="admin-selector-package-badge">${data.packageSize} GB</span>` : ''}
                </div>
                <div class="admin-selector-item-details">
                    Admin: ${data.adminQuota} GB | ${subscribersInfo} | Free: ${data.freeSpace.toFixed(1)} GB
                </div>
                <div class="admin-selector-item-phone">${this.escapeHtml(admin.phone || '')}</div>
                ${validityInfo ? `<div class="admin-selector-item-validity">${this.escapeHtml(validityInfo)}</div>` : ''}
            </div>
            <svg class="admin-selector-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 18l6-6-6-6"/>
            </svg>
        `;
        
        list.appendChild(item);
    });
};

AddSubscriberPageManager.prototype.filterAdminSelector = function(searchTerm, allAdmins) {
    const list = document.getElementById('adminSelectorList');
    if (!list) return;
    
    if (!searchTerm) {
        this.populateAdminSelector(allAdmins);
        return;
    }
    
    const filtered = allAdmins.filter(admin => {
        const name = (admin.name || '').toLowerCase();
        const phone = (admin.phone || '').toLowerCase();
        return name.includes(searchTerm) || phone.includes(searchTerm);
    });
    
    list.innerHTML = '';
    
    if (filtered.length === 0) {
        list.innerHTML = '<div class="admin-selector-empty">No admins found</div>';
        return;
    }
    
    filtered.forEach((admin, index) => {
        const data = this.calculateAdminSelectorData(admin);
        const item = document.createElement('div');
        item.className = 'admin-selector-item';
        item.style.animationDelay = `${index * 0.05}s`;
        item.onclick = () => this.selectAdmin(admin);
        
        // Format subscriber quotas
        const subscriberQuotasStr = data.subscriberQuotas.length > 0
            ? data.subscriberQuotas.map(q => `${q} GB`).join(', ')
            : '';
        const subscribersInfo = data.subscriberCount > 0 
            ? (subscriberQuotasStr 
                ? `Subscribers: ${data.subscriberCount} (${subscriberQuotasStr})`
                : `Subscribers: ${data.subscriberCount}`)
            : 'Subscribers: 0';
        
        // Format validity date info
        const validityInfo = data.validityDate && data.daysRemaining !== null
            ? `Expiry Date: ${data.validityDate} (${data.daysRemaining} days)`
            : data.validityDate || '';
        
        item.innerHTML = `
            <div class="admin-selector-item-info">
                <div class="admin-selector-item-header">
                    <span class="admin-selector-item-name">${this.escapeHtml(admin.name || 'Unknown')}</span>
                    ${data.packageSize > 0 ? `<span class="admin-selector-package-badge">${data.packageSize} GB</span>` : ''}
                </div>
                <div class="admin-selector-item-details">
                    Admin: ${data.adminQuota} GB | ${subscribersInfo} | Free: ${data.freeSpace.toFixed(1)} GB
                </div>
                <div class="admin-selector-item-phone">${this.escapeHtml(admin.phone || '')}</div>
                ${validityInfo ? `<div class="admin-selector-item-validity">${this.escapeHtml(validityInfo)}</div>` : ''}
            </div>
            <svg class="admin-selector-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 18l6-6-6-6"/>
            </svg>
        `;
        
        list.appendChild(item);
    });
};

AddSubscriberPageManager.prototype.selectAdmin = function(admin) {
    const modal = document.getElementById('adminSelectorModal');
    if (!modal) return;
    
    const itemIndex = parseInt(modal.dataset.itemIndex);
    
    if (!isNaN(itemIndex)) {
        // Update the service selector in add subscribers form
        const selector = document.getElementById(`service_selector_${itemIndex}`);
        const selectorText = document.getElementById(`service_text_${itemIndex}`);
        const hiddenInput = document.getElementById(`service_${itemIndex}`);
        
        if (selector && selectorText && hiddenInput) {
            selectorText.textContent = `${admin.name || admin.phone}`;
            selectorText.classList.add('selected');
            hiddenInput.value = admin.id;
            hiddenInput.dataset.adminId = admin.id;
            hiddenInput.dataset.adminName = admin.name || admin.phone;
        }
    }
    
    // Close modal
    this.closeAdminSelector();
};

