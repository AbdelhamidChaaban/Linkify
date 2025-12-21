/**
 * Action Logs Routes
 * API routes for fetching action logs
 * All routes require JWT authentication
 */

const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middleware/auth');
const { getActionLogs, deleteActionLog } = require('../services/firebaseDbService');

/**
 * DELETE /api/actionLogs/:logId
 * Delete an action log by ID
 * NOTE: This route must be defined BEFORE the GET route to avoid conflicts
 */
router.delete('/actionLogs/:logId', authenticateJWT, async (req, res) => {
    try {
        console.log('🗑️ [ActionLogs DELETE] Request received:', req.params);
        const { logId } = req.params;
        const userId = req.userId;
        
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'User ID not found in request'
            });
        }
        
        if (!logId) {
            return res.status(400).json({
                success: false,
                error: 'Action log ID is required'
            });
        }
        
        const deleted = await deleteActionLog(logId, userId);
        
        if (deleted) {
            console.log(`✅ [ActionLogs] Deleted action log ${logId} for user ${userId}`);
            return res.json({
                success: true,
                message: 'Action log deleted successfully'
            });
        } else {
            return res.status(404).json({
                success: false,
                error: 'Action log not found or unauthorized'
            });
        }
    } catch (error) {
        console.error('❌ Error deleting action log:', error);
        console.error('   Stack:', error.stack);
        res.status(500).json({
            success: false,
            error: error?.message || 'Failed to delete action log'
        });
    }
});

/**
 * GET /api/actionLogs
 * Get action logs for the authenticated user
 * Query params: actionFilter (optional, default: 'all'), limit (optional, default: 100)
 */
router.get('/actionLogs', authenticateJWT, async (req, res) => {
    try {
        console.log('📋 [ActionLogs] Request received:', req.query);
        const { actionFilter = 'all', limit: limitCount = 100 } = req.query;
        const userId = req.userId;
        
        console.log('📋 [ActionLogs] UserId:', userId, 'ActionFilter:', actionFilter);
        
        if (!userId) {
            console.warn('⚠️ [ActionLogs] No userId found in request');
            return res.status(401).json({
                success: false,
                error: 'User ID not found in request'
            });
        }
        
        const logs = await getActionLogs(userId, {
            actionFilter,
            limitCount: parseInt(limitCount, 10)
        });
        
        console.log(`✅ [ActionLogs] Returning ${logs.length} log(s) for user ${userId}`);
        
        res.json({
            success: true,
            data: logs
        });
    } catch (error) {
        console.error('❌ Error fetching action logs:', error);
        console.error('   Stack:', error.stack);
        res.status(500).json({
            success: false,
            error: error?.message || 'Failed to fetch action logs'
        });
    }
});

// Log registered routes on module load
console.log('✅ [ActionLogs Routes] Registered routes:');
console.log('   DELETE /api/actionLogs/:logId');
console.log('   GET /api/actionLogs');

module.exports = router;

