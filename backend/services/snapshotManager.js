const cacheLayer = require('./cacheLayer');

// Snapshot TTL: 24 hours (for scheduled refresh at 6:00 AM daily)
// This ensures snapshots persist until the next scheduled refresh
const SNAPSHOT_TTL_HOURS = parseInt(process.env.SNAPSHOT_TTL_HOURS) || 24;
const SNAPSHOT_TTL_SECONDS = SNAPSHOT_TTL_HOURS * 60 * 60; // Convert to seconds (86400 for 24 hours)

/**
 * Generate Redis key for snapshot
 * @param {string} adminId - Admin ID
 * @returns {string} Redis key
 */
function generateSnapshotKey(adminId) {
    const sanitized = String(adminId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `user:${sanitized}:lastSnapshot`;
}

/**
 * Create a lightweight snapshot from dashboard data
 * Only includes essential fields that indicate changes
 * @param {Object} dashboardData - Full dashboard data (or quick data from APIs)
 * @returns {Object} Lightweight snapshot
 */
function createSnapshot(dashboardData) {
    if (!dashboardData || typeof dashboardData !== 'object') {
        return null;
    }

    // Extract only essential fields that indicate meaningful changes
    const snapshot = {
        timestamp: Date.now(),
        // Balance (critical indicator of changes)
        balance: dashboardData.balance || null,
        // Total consumption (format: "47.97 / 77 GB")
        totalConsumption: dashboardData.totalConsumption || null,
        // Admin consumption (format: "17.11 / 15 GB") - may be null in quick snapshots
        adminConsumption: dashboardData.adminConsumption || null,
        // Subscribers count
        subscribersCount: dashboardData.subscribersCount !== undefined ? dashboardData.subscribersCount : null,
        // Expiration days
        expiration: dashboardData.expiration !== undefined ? dashboardData.expiration : null,
        // Subscription date
        subscriptionDate: dashboardData.subscriptionDate || null,
        // Validity date
        validityDate: dashboardData.validityDate || null
    };

    // Only include consumption circles data if available (full snapshot)
    // Quick snapshots from APIs don't have this data
    if (dashboardData.consumptions && Array.isArray(dashboardData.consumptions) && dashboardData.consumptions.length > 0) {
        // Consumption circles count (indicates if circles changed)
        snapshot.consumptionsCount = dashboardData.consumptions.length;
        
        // Hash of consumption data (quick comparison)
        const consumptionsData = dashboardData.consumptions.map(c => ({
            planName: c.planName,
            usage: c.usage,
            phoneNumber: c.phoneNumber
        }));
        snapshot.consumptionsHash = createHash(JSON.stringify(consumptionsData));
    }
    // If no consumptions, don't include these fields (quick snapshot)

    return snapshot;
}

/**
 * Create a simple hash from string (for comparison purposes)
 * @param {string} str - String to hash
 * @returns {string} Hash
 */
function createHash(str) {
    // Simple hash function - fast and sufficient for comparison
    let hash = 0;
    if (str.length === 0) return hash.toString();
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
}

/**
 * Compare two snapshots to detect changes
 * Only compares fields that are present in the current snapshot (for quick snapshot comparison)
 * This allows comparing quick snapshots (from APIs) with full snapshots (with circles)
 * @param {Object} currentSnapshot - Current snapshot (may be quick or full)
 * @param {Object} lastSnapshot - Last cached snapshot (usually full)
 * @returns {Object} Comparison result with changed fields
 */
function compareSnapshots(currentSnapshot, lastSnapshot) {
    if (!currentSnapshot) {
        return { hasChanges: true, reason: 'No current snapshot' };
    }

    if (!lastSnapshot) {
        return { hasChanges: true, reason: 'No previous snapshot' };
    }

    const changes = {};
    let hasChanges = false;

    // Only compare essential fields that indicate meaningful data changes
    // Exclude consumptionsCount and consumptionsHash from quick snapshot comparison
    // since quick snapshots don't have circles data
    const essentialFields = [
        'balance',
        'totalConsumption',
        'adminConsumption',
        'subscribersCount',
        'expiration',
        'subscriptionDate',
        'validityDate'
    ];

    // If current snapshot has consumptionsCount, it's a full snapshot - compare all fields
    // Otherwise, it's a quick snapshot - only compare essential fields (ignore circles data)
    const isQuickSnapshot = currentSnapshot.consumptionsCount === undefined || 
                           currentSnapshot.consumptionsCount === null;

    // For quick snapshots, only compare essential API fields (ignore consumption circles)
    // For full snapshots, compare everything
    const fieldsToCompare = isQuickSnapshot 
        ? essentialFields  // Quick snapshot: only essential API fields
        : [...essentialFields, 'consumptionsCount', 'consumptionsHash']; // Full snapshot: all fields

    for (const field of fieldsToCompare) {
        const current = currentSnapshot[field];
        const last = lastSnapshot[field];

        // Skip comparison if current value is null/undefined (field not available in quick snapshot)
        // But allow null to null comparison (both are null)
        if (current === null && last === null) {
            continue; // Both null, no change
        }
        if (current === null || current === undefined) {
            continue; // Current is null/undefined, skip (field not in quick snapshot)
        }

        // Handle null/undefined comparison
        if (current !== last) {
            // Deep comparison for objects/arrays
            if (typeof current === 'object' && typeof last === 'object' && current !== null && last !== null) {
                if (JSON.stringify(current) !== JSON.stringify(last)) {
                    changes[field] = { from: last, to: current };
                    hasChanges = true;
                }
            } else {
                changes[field] = { from: last, to: current };
                hasChanges = true;
            }
        }
    }

    return {
        hasChanges: hasChanges,
        changes: changes,
        reason: hasChanges ? 'Data changed' : 'No changes detected'
    };
}

/**
 * Get last snapshot from Redis
 * @param {string} adminId - Admin ID
 * @returns {Promise<Object|null>} Last snapshot or null
 */
async function getLastSnapshot(adminId) {
    if (!cacheLayer.isAvailable()) {
        return null;
    }

    try {
        const key = generateSnapshotKey(adminId);
        if (!cacheLayer.redis) {
            return null;
        }

        const cached = await cacheLayer.redis.get(key);
        if (!cached) {
            return null;
        }

        // Parse JSON snapshot data
        let snapshotData;
        if (typeof cached === 'string') {
            try {
                snapshotData = JSON.parse(cached);
            } catch (parseError) {
                console.warn(`⚠️ Failed to parse snapshot data for ${adminId}:`, parseError.message);
                return null;
            }
        } else if (typeof cached === 'object' && cached !== null) {
            snapshotData = cached;
        } else {
            return null;
        }

        // Validate snapshot structure
        if (!snapshotData.timestamp) {
            console.warn(`⚠️ Invalid snapshot structure for ${adminId}`);
            return null;
        }

        return snapshotData;
    } catch (error) {
        console.warn(`⚠️ Redis get snapshot error for ${adminId}:`, error.message);
        return null;
    }
}

/**
 * Save snapshot to Redis with TTL
 * @param {string} adminId - Admin ID
 * @param {Object} dashboardData - Full dashboard data
 * @returns {Promise<boolean>} Success status
 */
async function saveSnapshot(adminId, dashboardData) {
    // Don't save invalid or partial data
    if (!dashboardData || typeof dashboardData !== 'object') {
        console.log(`⚠️ Not saving invalid snapshot for ${adminId}`);
        return false;
    }

    // Don't save if data has errors
    if (dashboardData.error || dashboardData.failed) {
        console.log(`⚠️ Not saving snapshot with errors for ${adminId}`);
        return false;
    }

    if (!cacheLayer.isAvailable()) {
        return false;
    }

    try {
        const snapshot = createSnapshot(dashboardData);
        if (!snapshot) {
            console.log(`⚠️ Could not create snapshot for ${adminId}`);
            return false;
        }

        const key = generateSnapshotKey(adminId);
        const value = JSON.stringify(snapshot);

        // Save with TTL
        await cacheLayer.redis.setex(key, SNAPSHOT_TTL_SECONDS, value);
        
        const hours = Math.round(SNAPSHOT_TTL_SECONDS / (60 * 60));
        console.log(`✅ Snapshot saved for ${adminId} (TTL: ${hours} hours)`);
        return true;
    } catch (error) {
        console.warn(`⚠️ Redis save snapshot error for ${adminId}:`, error.message);
        return false;
    }
}

/**
 * Check if current data has changed compared to last snapshot
 * This is a lightweight check that can be done before full scraping
 * @param {string} adminId - Admin ID
 * @param {Object} currentSnapshot - Current snapshot (from quick page check)
 * @returns {Promise<{hasChanges: boolean, lastSnapshot: Object|null, comparison: Object}>}
 */
async function checkForChanges(adminId, currentSnapshot) {
    if (!currentSnapshot) {
        return {
            hasChanges: true,
            lastSnapshot: null,
            comparison: { hasChanges: true, reason: 'No current snapshot provided' }
        };
    }

    const lastSnapshot = await getLastSnapshot(adminId);
    
    if (!lastSnapshot) {
        console.log(`   ℹ️ No previous snapshot found for ${adminId} (first refresh or snapshot expired)`);
        return {
            hasChanges: true,
            lastSnapshot: null,
            comparison: { hasChanges: true, reason: 'No previous snapshot' }
        };
    }

    console.log(`   📋 Comparing snapshots (last saved: ${new Date(lastSnapshot.timestamp).toISOString()})`);
    const comparison = compareSnapshots(currentSnapshot, lastSnapshot);
    
    if (!comparison.hasChanges) {
        console.log(`   ✅ Snapshots match - no changes detected`);
    } else {
        console.log(`   📊 Snapshot differences found`);
    }
    
    return {
        hasChanges: comparison.hasChanges,
        lastSnapshot: lastSnapshot,
        comparison: comparison
    };
}

/**
 * Delete snapshot for an admin
 * @param {string} adminId - Admin ID
 * @returns {Promise<boolean>} Success status
 */
async function deleteSnapshot(adminId) {
    if (!cacheLayer.isAvailable()) {
        return false;
    }

    try {
        const key = generateSnapshotKey(adminId);
        await cacheLayer.redis.del(key);
        console.log(`✅ Snapshot deleted for ${adminId}`);
        return true;
    } catch (error) {
        console.warn(`⚠️ Redis delete snapshot error for ${adminId}:`, error.message);
        return false;
    }
}

module.exports = {
    createSnapshot,
    compareSnapshots,
    getLastSnapshot,
    saveSnapshot,
    checkForChanges,
    deleteSnapshot,
    generateSnapshotKey
};

