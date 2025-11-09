// Load environment variables first
// Try to load from backend folder first, then from parent directory (root)
const path = require('path');
const fs = require('fs');

const backendEnvPath = path.join(__dirname, '.env');
const rootEnvPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(backendEnvPath)) {
    require('dotenv').config({ path: backendEnvPath });
    console.log('✅ Loaded .env from backend folder');
} else if (fs.existsSync(rootEnvPath)) {
    require('dotenv').config({ path: rootEnvPath });
    console.log('✅ Loaded .env from root folder');
} else {
    // Try default location (current directory)
    require('dotenv').config();
    console.log('⚠️  No .env file found in backend/ or root/. Using default dotenv behavior.');
}

const express = require('express');
const cors = require('cors');

// Load services
const { fetchAlfaData } = require('./services/alfaService');

const app = express();
const PORT = process.env.PORT || 3000;

// Function to find available port
function findAvailablePort(startPort) {
    return new Promise((resolve, reject) => {
        const server = require('net').createServer();
        server.listen(startPort, () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                // Try next port
                findAvailablePort(startPort + 1).then(resolve).catch(reject);
            } else {
                reject(err);
            }
        });
    });
}

// Middleware
app.use(cors());
app.use(express.json());

// Health check (before static files to avoid conflicts)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend static files
const frontendPath = path.join(__dirname, '../frontend');
console.log('📁 Frontend path:', frontendPath);
app.use(express.static(frontendPath));

// Log static file serving for debugging
app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/health') {
        return next();
    }
    console.log(`[Static] Request: ${req.path}`);
    next();
});

// Fetch Alfa dashboard data
app.post('/api/alfa/fetch', async (req, res) => {
    try {
        const { phone, password, adminId } = req.body;

        if (!phone || !password) {
            return res.status(400).json({
                success: false,
                error: 'Phone and password are required'
            });
        }

        console.log(`[${new Date().toISOString()}] Fetching Alfa data for admin: ${adminId || phone}`);

        const startTime = Date.now();
        const data = await fetchAlfaData(phone, password, adminId);
        const duration = Date.now() - startTime;

        console.log(`[${new Date().toISOString()}] Completed in ${duration}ms`);

        res.json({
            success: true,
            data: data,
            duration: duration
        });
    } catch (error) {
        console.error('❌ Error fetching Alfa data:', error);
        console.error('Error message:', error?.message);
        console.error('Stack trace:', error?.stack);
        
        res.status(500).json({
            success: false,
            error: error?.message || 'Unknown error occurred'
        });
    }
});

// Start server on available port
findAvailablePort(PORT).then(actualPort => {
    app.listen(actualPort, () => {
        console.log(`🚀 Linkify backend server running on port ${actualPort}`);
        console.log(`📁 Serving static files from: ${frontendPath}`);
        console.log(`🌐 Access frontend at: http://localhost:${actualPort}/`);
        console.log(`📄 Home page: http://localhost:${actualPort}/pages/home.html`);
        console.log(`\n⚠️  Note: If port ${PORT} was in use, server is running on port ${actualPort}`);
    });
}).catch(err => {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
});

