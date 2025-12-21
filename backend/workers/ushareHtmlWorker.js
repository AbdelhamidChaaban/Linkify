/**
 * Ushare HTML Parsing Worker
 * Processes Ushare HTML parsing jobs from BullMQ queue
 */

const { Worker } = require('bullmq');
const { getUshareQueue, QUEUE_NAMES } = require('../services/queue');
const { fetchUshareHtml } = require('../services/ushareHtmlParser');

let worker = null;

/**
 * Initialize Ushare HTML parsing worker
 */
function initializeWorker() {
    if (worker) {
        console.log('⚠️ Ushare HTML worker already initialized');
        return worker;
    }
    
    try {
        const queue = getUshareQueue();
        
        // BullMQ requires maxRetriesPerRequest: null
        // Create connection config matching the queue
        const connectionConfig = {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined,
            maxRetriesPerRequest: null, // REQUIRED by BullMQ
            enableReadyCheck: false
        };
        
        // Handle TLS if needed
        if (process.env.REDIS_TLS === 'true') {
            connectionConfig.tls = {
                rejectUnauthorized: false
            };
        }
        
        worker = new Worker(
            QUEUE_NAMES.USHARE_HTML,
            async (job) => {
                const { phone, cookies, useCache } = job.data;
                
                console.log(`\n🔄 [Worker] Processing Ushare HTML parsing job ${job.id}`);
                console.log(`   Phone: ${phone}`);
                console.log(`   Use cache: ${useCache}`);
                
                try {
                    // Update job progress
                    await job.updateProgress(10);
                    
                    // Fetch Ushare HTML
                    const result = await fetchUshareHtml(phone, cookies, useCache);
                    
                    await job.updateProgress(90);
                    
                    if (result.success) {
                        console.log(`✅ [Worker] Job ${job.id} completed successfully`);
                        return {
                            success: true,
                            data: result.data,
                            source: result.source || 'puppeteer'
                        };
                    } else {
                        console.log(`❌ [Worker] Job ${job.id} failed: ${result.error}`);
                        throw new Error(result.error || 'Failed to parse Ushare HTML');
                    }
                } catch (error) {
                    console.error(`❌ [Worker] Job ${job.id} error:`, error);
                    throw error;
                }
            },
            {
                connection: connectionConfig,
            concurrency: 2, // Process 2 jobs concurrently
            removeOnComplete: {
                age: 3600, // Keep completed jobs for 1 hour
                count: 1000
            },
            removeOnFail: {
                age: 86400 // Keep failed jobs for 24 hours
            }
        });
        
        // Worker event handlers
        worker.on('completed', (job) => {
            console.log(`✅ [Worker] Job ${job.id} completed`);
        });
        
        worker.on('failed', (job, err) => {
            console.error(`❌ [Worker] Job ${job?.id} failed:`, err.message);
        });
        
        worker.on('error', (err) => {
            console.error(`❌ [Worker] Error:`, err);
        });
        
        console.log('✅ Ushare HTML parsing worker initialized');
        return worker;
    } catch (error) {
        console.error('❌ Failed to initialize Ushare HTML worker:', error);
        throw error;
    }
}

/**
 * Close worker
 */
async function closeWorker() {
    if (worker) {
        await worker.close();
        worker = null;
        console.log('✅ Ushare HTML parsing worker closed');
    }
}

module.exports = {
    initializeWorker,
    closeWorker
};

