const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection (uses DATABASE_URL env var from Render)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialize database table
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS templates (
                storage_code VARCHAR(20) PRIMARY KEY,
                templates JSONB NOT NULL DEFAULT '[]',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log('Database initialized');
    } catch (err) {
        console.error('Database init error:', err.message);
        // Continue without DB - will use in-memory fallback
    }
}

initDB();

// Enable CORS for all origins (so iPhone can call the API)
app.use(cors());
app.use(express.json({ limit: '10mb' }));  // Increase limit for templates
app.use(express.static(path.join(__dirname)));

// In-memory storage for rooms (temporary clipboard sync - doesn't need persistence)
const rooms = new Map();
const iphoneMessages = new Map();

// In-memory fallback for templates (if no DB)
const templatesMemory = new Map();

// Clean up old rooms every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [room, data] of rooms.entries()) {
        if (now - data.timestamp > 3600000) {
            rooms.delete(room);
        }
    }
    for (const [room, data] of iphoneMessages.entries()) {
        if (now - data.timestamp > 3600000) {
            iphoneMessages.delete(room);
        }
    }
}, 300000);

// API: Send text to a room (called by iPhone app)
app.post('/api/send', (req, res) => {
    const { room, text } = req.body;
    
    if (!room || !text) {
        return res.status(400).json({ error: 'Missing room or text' });
    }
    
    rooms.set(room, { text, timestamp: Date.now() });
    console.log(`[${new Date().toISOString()}] Room ${room}: Received ${text.length} chars`);
    res.json({ success: true, room });
});

// API: Get text from a room (polled by PC browser)
app.get('/api/room/:room', (req, res) => {
    const room = req.params.room;
    const data = rooms.get(room);
    
    if (!data) {
        return res.json({ text: null });
    }
    
    res.json({ text: data.text, timestamp: data.timestamp });
});

// API: Clear a room
app.delete('/api/room/:room', (req, res) => {
    rooms.delete(req.params.room);
    res.json({ success: true });
});

// API: Send text to iPhone (called by PC browser)
app.post('/api/send-to-iphone', (req, res) => {
    const { room, text } = req.body;
    
    if (!room || !text) {
        return res.status(400).json({ error: 'Missing room or text' });
    }
    
    iphoneMessages.set(room, { text, timestamp: Date.now() });
    console.log(`[${new Date().toISOString()}] Room ${room}: Sending to iPhone ${text.length} chars`);
    res.json({ success: true, room });
});

// API: Get text for iPhone (polled by iPhone app)
app.get('/api/iphone/:room', (req, res) => {
    const room = req.params.room;
    const data = iphoneMessages.get(room);
    
    if (!data) {
        return res.json({ text: null });
    }
    
    res.json({ text: data.text, timestamp: data.timestamp });
});

// API: Clear iPhone message after received
app.delete('/api/iphone/:room', (req, res) => {
    iphoneMessages.delete(req.params.room);
    res.json({ success: true });
});

// ============ TEMPLATES API (PostgreSQL backed) ============

// API: Save templates for a storage code
app.post('/api/templates/:code', async (req, res) => {
    const code = req.params.code;
    const { templates } = req.body;
    
    if (!templates) {
        return res.status(400).json({ error: 'Missing templates' });
    }
    
    try {
        // Try PostgreSQL first
        if (process.env.DATABASE_URL) {
            // Upsert - insert or update
            await pool.query(`
                INSERT INTO templates (storage_code, templates, updated_at)
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (storage_code) 
                DO UPDATE SET templates = $2, updated_at = CURRENT_TIMESTAMP
            `, [code, JSON.stringify(templates)]);
        } else {
            // Fallback to memory
            templatesMemory.set(code, { templates, timestamp: Date.now() });
        }
        
        console.log(`[${new Date().toISOString()}] Code ${code}: Saved ${templates.length} templates`);
        res.json({ success: true, count: templates.length });
    } catch (err) {
        console.error('Save templates error:', err.message);
        // Fallback to memory
        templatesMemory.set(code, { templates, timestamp: Date.now() });
        res.json({ success: true, count: templates.length, storage: 'memory' });
    }
});

// API: Get templates for a storage code
app.get('/api/templates/:code', async (req, res) => {
    const code = req.params.code;
    
    try {
        // Try PostgreSQL first
        if (process.env.DATABASE_URL) {
            const result = await pool.query('SELECT templates FROM templates WHERE storage_code = $1', [code]);
            
            if (result.rows.length > 0) {
                const templates = result.rows[0].templates;
                return res.json({ templates: typeof templates === 'string' ? JSON.parse(templates) : templates });
            }
        }
        
        // Fallback to memory
        const data = templatesMemory.get(code);
        if (data) {
            return res.json({ templates: data.templates });
        }
        
        res.json({ templates: [] });
    } catch (err) {
        console.error('Get templates error:', err.message);
        // Fallback to memory
        const data = templatesMemory.get(code);
        res.json({ templates: data ? data.templates : [] });
    }
});

// Health check
app.get('/api/health', async (req, res) => {
    let dbStatus = 'not configured';
    
    if (process.env.DATABASE_URL) {
        try {
            await pool.query('SELECT 1');
            dbStatus = 'connected';
        } catch (err) {
            dbStatus = 'error: ' + err.message;
        }
    }
    
    res.json({ 
        status: 'ok', 
        rooms: rooms.size,
        database: dbStatus
    });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Clipboard Sync server running on http://localhost:${PORT}`);
});
