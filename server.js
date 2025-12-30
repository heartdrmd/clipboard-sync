const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins (so iPhone can call the API)
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// In-memory storage for rooms (in production, use Redis)
const rooms = new Map();

// Clean up old rooms every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [room, data] of rooms.entries()) {
        // Remove rooms older than 1 hour
        if (now - data.timestamp > 3600000) {
            rooms.delete(room);
        }
    }
}, 300000);

// API: Send text to a room (called by iPhone app)
app.post('/api/send', (req, res) => {
    const { room, text } = req.body;
    
    if (!room || !text) {
        return res.status(400).json({ error: 'Missing room or text' });
    }
    
    const data = {
        text: text,
        timestamp: Date.now()
    };
    
    rooms.set(room, data);
    
    console.log(`[${new Date().toISOString()}] Room ${room}: Received ${text.length} chars`);
    
    res.json({ success: true, room: room });
});

// API: Get text from a room (polled by PC browser)
app.get('/api/room/:room', (req, res) => {
    const room = req.params.room;
    const data = rooms.get(room);
    
    if (!data) {
        return res.json({ text: null });
    }
    
    res.json({
        text: data.text,
        timestamp: data.timestamp
    });
});

// API: Clear a room
app.delete('/api/room/:room', (req, res) => {
    const room = req.params.room;
    rooms.delete(room);
    res.json({ success: true });
});

// In-memory storage for iPhone-bound messages
const iphoneMessages = new Map();

// API: Send text to iPhone (called by PC browser)
app.post('/api/send-to-iphone', (req, res) => {
    const { room, text } = req.body;
    
    if (!room || !text) {
        return res.status(400).json({ error: 'Missing room or text' });
    }
    
    const data = {
        text: text,
        timestamp: Date.now()
    };
    
    iphoneMessages.set(room, data);
    
    console.log(`[${new Date().toISOString()}] Room ${room}: Sending to iPhone ${text.length} chars`);
    
    res.json({ success: true, room: room });
});

// API: Get text for iPhone (polled by iPhone app)
app.get('/api/iphone/:room', (req, res) => {
    const room = req.params.room;
    const data = iphoneMessages.get(room);
    
    if (!data) {
        return res.json({ text: null });
    }
    
    res.json({
        text: data.text,
        timestamp: data.timestamp
    });
});

// API: Clear iPhone message after received
app.delete('/api/iphone/:room', (req, res) => {
    const room = req.params.room;
    iphoneMessages.delete(room);
    res.json({ success: true });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', rooms: rooms.size });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Clipboard Sync server running on http://localhost:${PORT}`);
});
