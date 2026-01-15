// Edit Subscriber Page - Admin Selector Functions (extends EditSubscriberPageManager prototype)
// This is a placeholder - edit subscriber page currently doesn't use admin selector
// But kept for consistency and future use

EditSubscriberPageManager.prototype.closeAdminSelector = function() {
    const modal = document.getElementById('adminSelectorModal');
    if (modal) {
        modal.classList.remove('show');
        document.body.style.overflow = '';
    }
};

