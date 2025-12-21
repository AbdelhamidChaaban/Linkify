/**
 * BullMQ Queue Service
 * Manages background jobs for Puppeteer operations
 */

const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

// Redis connection for BullMQ (reuse existing Redis if available)
const cacheLayer = require('./cacheLayer');
let redisConnection = null;

// Initialize Redis connection for BullMQ
function getRedisConnection() {
    if (redisConnection) {
        return redisConnection;
    }
    
    // Try to reuse existing Redis connection from cacheLayer
    if (cacheLayer.redis && cacheLayer.isAvailable()) {
        redisConnection = cacheLayer.redis;
        return redisConnection;
    }
    
    // Create new Redis connection for BullMQ
    const redisConfig = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false
    };
    
    // Handle TLS if needed
    if (process.env.REDIS_TLS === 'true') {
        redisConfig.tls = {
            rejectUnauthorized: false
        };
    }
    
    redisConnection = new Redis(redisConfig);
    return redisConnection;
}

// Queue names
const QUEUE_NAMES = {
    USHARE_HTML: 'ushare-html-parsing',
    PUPPETEER_JOBS: 'puppeteer-jobs'
};

// Initialize queues
const queues = {};

function getQueue(queueName) {
    if (queues[queueName]) {
        return queues[queueName];
    }
    
    // BullMQ requires maxRetriesPerRequest: null
    // Always use connection config (not the Redis instance) to ensure correct settings
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
    
    queues[queueName] = new Queue(queueName, {
        connection: connectionConfig,
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 2000
            },
            removeOnComplete: {
                age: 3600, // Keep completed jobs for 1 hour
                count: 1000 // Keep max 1000 completed jobs
            },
            removeOnFail: {
                age: 86400 // Keep failed jobs for 24 hours
            }
        }
    });
    
    console.log(`✅ BullMQ queue "${queueName}" initialized`);
    return queues[queueName];
}

// Get Ushare HTML parsing queue
function getUshareQueue() {
    return getQueue(QUEUE_NAMES.USHARE_HTML);
}

// Get general Puppeteer jobs queue
function getPuppeteerQueue() {
    return getQueue(QUEUE_NAMES.PUPPETEER_JOBS);
}

/**
 * Add job to Ushare HTML parsing queue
 * @param {Object} jobData - Job data
 * @param {string} jobData.phone - Admin phone number
 * @param {Array} jobData.cookies - Cookie array
 * @param {boolean} jobData.useCache - Whether to use cache
 * @returns {Promise<Object>} Job info
 */
async function enqueueUshareHtmlParsing(jobData) {
    const queue = getUshareQueue();
    
    const job = await queue.add('parse-ushare-html', {
        phone: jobData.phone,
        cookies: jobData.cookies,
        useCache: jobData.useCache !== false,
        timestamp: Date.now()
    }, {
        jobId: `ushare-${jobData.phone}-${Date.now()}`,
        priority: jobData.priority || 0
    });
    
    console.log(`📋 Enqueued Ushare HTML parsing job: ${job.id} for phone: ${jobData.phone}`);
    
    return {
        jobId: job.id,
        status: 'queued',
        queue: QUEUE_NAMES.USHARE_HTML
    };
}

/**
 * Get job status
 * @param {string} queueName - Queue name
 * @param {string} jobId - Job ID
 * @returns {Promise<Object>} Job status
 */
async function getJobStatus(queueName, jobId) {
    const queue = getQueue(queueName);
    const job = await queue.getJob(jobId);
    
    if (!job) {
        return {
            status: 'not_found',
            message: 'Job not found'
        };
    }
    
    const state = await job.getState();
    const progress = job.progress;
    const result = job.returnvalue;
    const failedReason = job.failedReason;
    
    return {
        jobId: job.id,
        status: state,
        progress: progress,
        result: result,
        failedReason: failedReason,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn
    };
}

/**
 * Initialize queue workers
 * This should be called after services are initialized
 */
function initializeWorkers() {
    // Ushare HTML parsing worker will be initialized when needed
    // to avoid circular dependencies
    console.log('✅ BullMQ queues initialized (workers will be created on demand)');
}

/**
 * Close all queues and connections
 */
async function closeQueues() {
    for (const queueName in queues) {
        await queues[queueName].close();
    }
    console.log('✅ All BullMQ queues closed');
}

module.exports = {
    getQueue,
    getUshareQueue,
    getPuppeteerQueue,
    enqueueUshareHtmlParsing,
    getJobStatus,
    initializeWorkers,
    closeQueues,
    QUEUE_NAMES
};

