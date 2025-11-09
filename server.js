const express = require('express');
const cors = require('cors');
const { fetchAlfaData } = require('./services/alfaService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
        console.error('Error fetching Alfa data:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Linkify backend server running on port ${PORT}`);
});
