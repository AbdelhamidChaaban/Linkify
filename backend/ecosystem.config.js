/**
 * PM2 Ecosystem Configuration
 * 
 * This configuration file is used by PM2 to manage the Node.js process.
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 stop ecosystem.config.js
 *   pm2 restart ecosystem.config.js
 *   pm2 logs
 *   pm2 monit
 * 
 * For Render.com deployment:
 *   - Render.com will automatically detect and use this file
 *   - Or you can specify it in the build command: pm2 start ecosystem.config.js
 */
module.exports = {
    apps: [{
        name: 'linkify-backend',
        script: './server.js',
        instances: 1, // Single instance to maintain one browser pool
        exec_mode: 'fork', // Use fork mode (not cluster) to maintain single browser instance
        autorestart: true,
        watch: false, // Disable watch in production
        max_memory_restart: '1G', // Restart if memory exceeds 1GB
        env: {
            NODE_ENV: 'production',
            PORT: 3000
        },
        env_production: {
            NODE_ENV: 'production',
            PORT: process.env.PORT || 3000
        },
        // Logging
        error_file: './logs/err.log',
        out_file: './logs/out.log',
        log_file: './logs/combined.log',
        time: true, // Add timestamp to logs
        merge_logs: true,
        // Graceful shutdown
        kill_timeout: 10000, // 10 seconds to gracefully shutdown
        wait_ready: true, // Wait for app to be ready
        listen_timeout: 10000, // Timeout for app to start listening
        // Restart policy
        min_uptime: '10s', // Minimum uptime before considering app stable
        max_restarts: 10, // Maximum restarts in 1 minute
        restart_delay: 4000, // Delay between restarts
        // Advanced
        node_args: '--max-old-space-size=1024', // Limit memory to 1GB
        // Ignore watch patterns (if watch is enabled)
        ignore_watch: [
            'node_modules',
            'logs',
            '.git',
            '*.log'
        ]
    }]
};

