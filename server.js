const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Anthropic client (uses ANTHROPIC_API_KEY env var)
const anthropic = new Anthropic();

// Initialize OpenAI client (uses OPENAI_API_KEY env var)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS favorites (
                storage_code VARCHAR(20) PRIMARY KEY,
                favorites JSONB NOT NULL DEFAULT '[]',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS room_settings (
                storage_code VARCHAR(20) PRIMARY KEY,
                settings JSONB NOT NULL DEFAULT '{}',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // CardioScan: image analysis sessions
        await pool.query(`
            CREATE TABLE IF NOT EXISTS image_sessions (
                id SERIAL PRIMARY KEY,
                session_id VARCHAR(50) NOT NULL,
                storage_code VARCHAR(20),
                mode VARCHAR(20) DEFAULT 'clinic',
                images JSONB NOT NULL DEFAULT '[]',
                reader_model VARCHAR(50),
                reader_settings JSONB DEFAULT '{}',
                interpreter_model VARCHAR(50),
                interpreter_settings JSONB DEFAULT '{}',
                extracted_data JSONB,
                interpretation JSONB,
                suggestions JSONB,
                cost JSONB DEFAULT '{}',
                timing JSONB DEFAULT '{}',
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Index for fast lookups
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_image_sessions_session ON image_sessions(session_id)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_image_sessions_code ON image_sessions(storage_code)
        `);
        
        console.log('Database initialized');
    } catch (err) {
        console.error('Database init error:', err.message);
        // Continue without DB - will use in-memory fallback
    }
}

initDB();

// Enable CORS for all origins (so iPhone can call the API)
const compression = require('compression');

app.use(compression());  // Gzip responses — shrinks 223KB JSON to ~20KB
app.use(cors());
app.use(express.json({ limit: '50mb' }));  // Increased for image uploads (CardioScan)
app.use(express.static(path.join(__dirname)));

// In-memory storage for rooms (temporary clipboard sync - doesn't need persistence)
const rooms = new Map();
const iphoneMessages = new Map();

// In-memory fallback for templates (if no DB)
const templatesMemory = new Map();
const favoritesMemory = new Map();

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
    
    console.log(`[${new Date().toISOString()}] iPhone polling room ${room}: ${data ? 'has data' : 'empty'}`);
    
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

// API: Save templates for a storage code (REPLACE mode - overwrites cloud)
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

// API: Merge templates (adds new ones, doesn't delete existing)
app.post('/api/templates/:code/merge', async (req, res) => {
    const code = req.params.code;
    const { templates: newTemplates } = req.body;
    
    if (!newTemplates) {
        return res.status(400).json({ error: 'Missing templates' });
    }
    
    try {
        let existing = [];
        
        // Get existing templates
        if (process.env.DATABASE_URL) {
            const result = await pool.query('SELECT templates FROM templates WHERE storage_code = $1', [code]);
            if (result.rows.length > 0) {
                existing = typeof result.rows[0].templates === 'string' 
                    ? JSON.parse(result.rows[0].templates) 
                    : result.rows[0].templates;
            }
        } else {
            const data = templatesMemory.get(code);
            if (data) existing = data.templates;
        }
        
        // Merge: add new templates that don't exist (by id)
        const existingIds = new Set(existing.map(t => t.id));
        const toAdd = newTemplates.filter(t => !existingIds.has(t.id));
        const merged = [...existing, ...toAdd];
        
        // Save merged
        if (process.env.DATABASE_URL) {
            await pool.query(`
                INSERT INTO templates (storage_code, templates, updated_at)
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (storage_code) 
                DO UPDATE SET templates = $2, updated_at = CURRENT_TIMESTAMP
            `, [code, JSON.stringify(merged)]);
        } else {
            templatesMemory.set(code, { templates: merged, timestamp: Date.now() });
        }
        
        console.log(`[${new Date().toISOString()}] Code ${code}: Merged templates (${existing.length} existing + ${toAdd.length} new = ${merged.length} total)`);
        res.json({ success: true, added: toAdd.length, total: merged.length });
    } catch (err) {
        console.error('Merge templates error:', err.message);
        res.status(500).json({ error: 'Merge failed' });
    }
});

// API: Delete single template by ID
app.delete('/api/templates/:code/:id', async (req, res) => {
    const { code, id } = req.params;
    
    try {
        let existing = [];
        
        // Get existing templates
        if (process.env.DATABASE_URL) {
            const result = await pool.query('SELECT templates FROM templates WHERE storage_code = $1', [code]);
            if (result.rows.length > 0) {
                existing = typeof result.rows[0].templates === 'string' 
                    ? JSON.parse(result.rows[0].templates) 
                    : result.rows[0].templates;
            }
        } else {
            const data = templatesMemory.get(code);
            if (data) existing = data.templates;
        }
        
        // Remove the template with matching id
        const filtered = existing.filter(t => t.id !== id);
        
        if (filtered.length === existing.length) {
            return res.status(404).json({ error: 'Template not found' });
        }
        
        // Save filtered
        if (process.env.DATABASE_URL) {
            await pool.query(`
                INSERT INTO templates (storage_code, templates, updated_at)
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (storage_code) 
                DO UPDATE SET templates = $2, updated_at = CURRENT_TIMESTAMP
            `, [code, JSON.stringify(filtered)]);
        } else {
            templatesMemory.set(code, { templates: filtered, timestamp: Date.now() });
        }
        
        console.log(`[${new Date().toISOString()}] Code ${code}: Deleted template ${id}`);
        res.json({ success: true, remaining: filtered.length });
    } catch (err) {
        console.error('Delete template error:', err.message);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// API: Delete ALL templates for a storage code (clear cloud)
app.delete('/api/templates/:code', async (req, res) => {
    const code = req.params.code;
    
    try {
        if (process.env.DATABASE_URL) {
            await pool.query('DELETE FROM templates WHERE storage_code = $1', [code]);
        } else {
            templatesMemory.delete(code);
        }
        
        console.log(`[${new Date().toISOString()}] Code ${code}: Cleared all templates from cloud`);
        res.json({ success: true });
    } catch (err) {
        console.error('Clear templates error:', err.message);
        res.status(500).json({ error: 'Clear failed' });
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

// ============ FAVORITES API ============

// API: Save favorites for a storage code (REPLACE mode)
app.post('/api/favorites/:code', async (req, res) => {
    const code = req.params.code;
    const { favorites } = req.body;
    
    if (!favorites) {
        return res.status(400).json({ error: 'Missing favorites' });
    }
    
    try {
        // Try PostgreSQL first
        if (process.env.DATABASE_URL) {
            await pool.query(`
                INSERT INTO favorites (storage_code, favorites, updated_at)
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (storage_code) 
                DO UPDATE SET favorites = $2, updated_at = CURRENT_TIMESTAMP
            `, [code, JSON.stringify(favorites)]);
        } else {
            // Fallback to memory
            favoritesMemory.set(code, { favorites, timestamp: Date.now() });
        }
        
        console.log(`[${new Date().toISOString()}] Code ${code}: Saved ${favorites.length} favorites`);
        res.json({ success: true, count: favorites.length });
    } catch (err) {
        console.error('Save favorites error:', err.message);
        // Fallback to memory
        favoritesMemory.set(code, { favorites, timestamp: Date.now() });
        res.json({ success: true, count: favorites.length, storage: 'memory' });
    }
});

// API: Merge favorites (adds new ones, doesn't delete existing)
app.post('/api/favorites/:code/merge', async (req, res) => {
    const code = req.params.code;
    const { favorites: newFavorites } = req.body;
    
    if (!newFavorites) {
        return res.status(400).json({ error: 'Missing favorites' });
    }
    
    try {
        let existing = [];
        
        // Get existing favorites
        if (process.env.DATABASE_URL) {
            const result = await pool.query('SELECT favorites FROM favorites WHERE storage_code = $1', [code]);
            if (result.rows.length > 0) {
                existing = typeof result.rows[0].favorites === 'string' 
                    ? JSON.parse(result.rows[0].favorites) 
                    : result.rows[0].favorites;
            }
        } else {
            const data = favoritesMemory.get(code);
            if (data) existing = data.favorites;
        }
        
        // Merge: add new favorites that don't exist (by exact text match)
        const existingSet = new Set(existing);
        const toAdd = newFavorites.filter(f => !existingSet.has(f));
        const merged = [...existing, ...toAdd];
        
        // Save merged
        if (process.env.DATABASE_URL) {
            await pool.query(`
                INSERT INTO favorites (storage_code, favorites, updated_at)
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (storage_code) 
                DO UPDATE SET favorites = $2, updated_at = CURRENT_TIMESTAMP
            `, [code, JSON.stringify(merged)]);
        } else {
            favoritesMemory.set(code, { favorites: merged, timestamp: Date.now() });
        }
        
        console.log(`[${new Date().toISOString()}] Code ${code}: Merged favorites (${existing.length} existing + ${toAdd.length} new = ${merged.length} total)`);
        res.json({ success: true, added: toAdd.length, total: merged.length });
    } catch (err) {
        console.error('Merge favorites error:', err.message);
        res.status(500).json({ error: 'Merge failed' });
    }
});

// API: Delete single favorite by index
app.delete('/api/favorites/:code/:index', async (req, res) => {
    const { code, index } = req.params;
    const idx = parseInt(index);
    
    try {
        let existing = [];
        
        // Get existing favorites
        if (process.env.DATABASE_URL) {
            const result = await pool.query('SELECT favorites FROM favorites WHERE storage_code = $1', [code]);
            if (result.rows.length > 0) {
                existing = typeof result.rows[0].favorites === 'string' 
                    ? JSON.parse(result.rows[0].favorites) 
                    : result.rows[0].favorites;
            }
        } else {
            const data = favoritesMemory.get(code);
            if (data) existing = data.favorites;
        }
        
        if (idx < 0 || idx >= existing.length) {
            return res.status(404).json({ error: 'Favorite not found' });
        }
        
        // Remove the favorite at index
        existing.splice(idx, 1);
        
        // Save filtered
        if (process.env.DATABASE_URL) {
            await pool.query(`
                INSERT INTO favorites (storage_code, favorites, updated_at)
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (storage_code) 
                DO UPDATE SET favorites = $2, updated_at = CURRENT_TIMESTAMP
            `, [code, JSON.stringify(existing)]);
        } else {
            favoritesMemory.set(code, { favorites: existing, timestamp: Date.now() });
        }
        
        console.log(`[${new Date().toISOString()}] Code ${code}: Deleted favorite at index ${idx}`);
        res.json({ success: true, remaining: existing.length });
    } catch (err) {
        console.error('Delete favorite error:', err.message);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// API: Delete ALL favorites for a storage code (clear cloud)
app.delete('/api/favorites/:code', async (req, res) => {
    const code = req.params.code;
    
    try {
        if (process.env.DATABASE_URL) {
            await pool.query('DELETE FROM favorites WHERE storage_code = $1', [code]);
        } else {
            favoritesMemory.delete(code);
        }
        
        console.log(`[${new Date().toISOString()}] Code ${code}: Cleared all favorites from cloud`);
        res.json({ success: true });
    } catch (err) {
        console.error('Clear favorites error:', err.message);
        res.status(500).json({ error: 'Clear failed' });
    }
});

// API: Get favorites for a storage code
app.get('/api/favorites/:code', async (req, res) => {
    const code = req.params.code;
    
    try {
        // Try PostgreSQL first
        if (process.env.DATABASE_URL) {
            const result = await pool.query('SELECT favorites FROM favorites WHERE storage_code = $1', [code]);
            
            if (result.rows.length > 0) {
                const favorites = result.rows[0].favorites;
                return res.json({ favorites: typeof favorites === 'string' ? JSON.parse(favorites) : favorites });
            }
        }
        
        // Fallback to memory
        const data = favoritesMemory.get(code);
        if (data) {
            return res.json({ favorites: data.favorites });
        }
        
        res.json({ favorites: [] });
    } catch (err) {
        console.error('Get favorites error:', err.message);
        // Fallback to memory
        const data = favoritesMemory.get(code);
        res.json({ favorites: data ? data.favorites : [] });
    }
});

// ============ IGNORE RULES API ============

app.get('/api/ignore-rules/:code', async (req, res) => {
    const { code } = req.params;
    
    try {
        if (process.env.DATABASE_URL) {
            // Create table if not exists
            await pool.query(`
                CREATE TABLE IF NOT EXISTS ignore_rules (
                    id SERIAL PRIMARY KEY,
                    storage_code VARCHAR(50),
                    rule_text TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);
            
            const result = await pool.query(
                'SELECT id, rule_text, created_at FROM ignore_rules WHERE storage_code = $1 ORDER BY created_at DESC',
                [code]
            );
            res.json({ rules: result.rows });
        } else {
            res.json({ rules: [] });
        }
    } catch (e) {
        console.error('Error loading ignore rules:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ignore-rules/:code', async (req, res) => {
    const { code } = req.params;
    const { rule_text } = req.body;
    
    if (!rule_text || !rule_text.trim()) {
        return res.status(400).json({ error: 'Rule text required' });
    }
    
    try {
        if (process.env.DATABASE_URL) {
            const result = await pool.query(
                'INSERT INTO ignore_rules (storage_code, rule_text) VALUES ($1, $2) RETURNING id, rule_text, created_at',
                [code, rule_text.trim()]
            );
            console.log(`[${new Date().toISOString()}] Ignore rule added for ${code}: ${rule_text.trim()}`);
            res.json({ success: true, rule: result.rows[0] });
        } else {
            res.status(400).json({ error: 'Database not configured' });
        }
    } catch (e) {
        console.error('Error saving ignore rule:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/ignore-rules/:code/:id', async (req, res) => {
    const { code, id } = req.params;
    
    try {
        if (process.env.DATABASE_URL) {
            await pool.query(
                'DELETE FROM ignore_rules WHERE id = $1 AND storage_code = $2',
                [id, code]
            );
            console.log(`[${new Date().toISOString()}] Ignore rule ${id} deleted for ${code}`);
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Database not configured' });
        }
    } catch (e) {
        console.error('Error deleting ignore rule:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/ignore-rules/:code', async (req, res) => {
    const { code } = req.params;
    
    try {
        if (process.env.DATABASE_URL) {
            const result = await pool.query(
                'DELETE FROM ignore_rules WHERE storage_code = $1',
                [code]
            );
            console.log(`[${new Date().toISOString()}] All ignore rules cleared for ${code}: ${result.rowCount} deleted`);
            res.json({ success: true, deleted: result.rowCount });
        } else {
            res.status(400).json({ error: 'Database not configured' });
        }
    } catch (e) {
        console.error('Error clearing ignore rules:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ============ ROOM SETTINGS API ============

// Get room settings
app.get('/api/room-settings/:code', async (req, res) => {
    const { code } = req.params;
    
    try {
        if (process.env.DATABASE_URL) {
            const result = await pool.query(
                'SELECT settings FROM room_settings WHERE storage_code = $1',
                [code]
            );
            if (result.rows.length > 0) {
                res.json({ settings: result.rows[0].settings });
            } else {
                res.json({ settings: {} });
            }
        } else {
            res.json({ settings: {} });
        }
    } catch (e) {
        console.error('Error loading room settings:', e.message);
        res.json({ settings: {} });
    }
});

// Update room settings
app.put('/api/room-settings/:code', async (req, res) => {
    const { code } = req.params;
    const { settings } = req.body;
    
    try {
        if (process.env.DATABASE_URL) {
            await pool.query(
                `INSERT INTO room_settings (storage_code, settings, updated_at) 
                 VALUES ($1, $2, CURRENT_TIMESTAMP)
                 ON CONFLICT (storage_code) 
                 DO UPDATE SET settings = $2, updated_at = CURRENT_TIMESTAMP`,
                [code, JSON.stringify(settings)]
            );
            console.log(`[${new Date().toISOString()}] Room settings updated for ${code}: ${JSON.stringify(settings)}`);
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Database not configured' });
        }
    } catch (e) {
        console.error('Error saving room settings:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ============ ATTESTATION GENERATOR API (GPT-5.2) ============

app.post('/api/generate-attestation', async (req, res) => {
    const { noteText } = req.body;
    
    if (!noteText) {
        return res.status(400).json({ error: 'Note text is required' });
    }
    
    console.log(`[${new Date().toISOString()}] Generating attestation for note (${noteText.length} chars)`);
    
    try {
        const systemPrompt = `You are helping a supervising cardiologist (Dr. Aker) create a brief, audit-proof attestation.

CONTEXT: The physician personally performs >80% of the interview, exam, evaluation, and medical decision-making. The APP participates in discussions and documents the encounter.

YOUR TASK: Write a SHORT, SINGLE PARAGRAPH attestation (100-200 words MAX) that proves the physician understood THIS specific patient.

## OUTPUT FORMAT (ONE PARAGRAPH, NO BULLETS, NO HEADERS):

Start with: "I, Dr. Aker, personally saw and evaluated this patient, performing over 80% of the interview, examination, evaluation, and medical decision-making. The APP participated in discussion and documented this encounter."

Then IN THE SAME PARAGRAPH continue with a flowing summary that includes:
- Chief complaint (why they're here)
- 1-2 key history points
- 1-2 pertinent exam findings (with specific values if available)
- Assessment/diagnoses addressed
- Key plan decisions

End with: "I have reviewed and agree with the documentation above."

## CRITICAL RULES:
- ONE PARAGRAPH ONLY - no line breaks, no bullets, no headers
- 100-200 words MAXIMUM - be concise
- Include SPECIFIC details (EF 35%, BP 142/88, metoprolol 50mg, etc.)
- Extract ONLY from the note - never invent
- Must show you understood THIS patient, not generic boilerplate`;

        const userPrompt = `Generate a brief single-paragraph attestation (100-200 words max) for this note:

${noteText}`;

        // Use GPT-5.2 with temperature 0.1 for consistent, accurate extraction
        const response = await openai.responses.create({
            model: "gpt-5.2",
            input: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            reasoning: { effort: "medium" }
        });
        
        const attestation = response.output_text || '';
        
        console.log(`[${new Date().toISOString()}] Attestation generated (${attestation.length} chars)`);
        
        res.json({ 
            success: true, 
            attestation: attestation.trim()
        });
        
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Attestation error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============ MEDICAL VALIDATION API (Claude) ============

app.post('/api/validate', async (req, res) => {
    const { 
        text, 
        templateCode, 
        model, 
        depth,
        temperature,
        includeSuggestions, 
        ignoreSpelling, 
        ignorePunctuation,
        checkGrammar,
        flagVagueLanguage,
        applyCardiologyGuidelines,
        rewriteFullNote,
        examData,  // New: structured exam data from Exam Builder
        userProfile 
    } = req.body;
    
    if (!text) {
        return res.status(400).json({ error: 'Missing text' });
    }
    
    // ============ GPT-5.2 PATH ============
    // Handle GPT-5.2 separately and return early - Claude code below remains untouched
    if (model === 'gpt-5.2') {
        console.log(`[${new Date().toISOString()}] Using GPT-5.2 for validation (temp: ${temperature || 0.2})`);
        
        try {
            // Load ignore rules for this storage code
            let userRules = [];
            if (templateCode && process.env.DATABASE_URL) {
                try {
                    const result = await pool.query(
                        'SELECT rule_text FROM ignore_rules WHERE storage_code = $1',
                        [templateCode]
                    );
                    userRules = result.rows.map(r => r.rule_text);
                    console.log(`[${new Date().toISOString()}] Loaded ${userRules.length} rules for GPT-5.2`);
                } catch (err) {
                    console.error('Error loading rules for GPT-5.2:', err.message);
                }
            }
            
            // ============ HARDWIRED SYSTEM PROMPT ============
            // Based on ChatGPT 5.2 best practices for medical note editing
            // This ensures consistent, high-quality output without "creative" additions
            let systemPrompt = `You are a meticulous medical documentation editor AND a clinical reasoning partner modeled after the NEJM Case Records style of thinking. 

## YOUR DUAL ROLE:
1. **Documentation Editor**: Rewrite and format the provided clinician draft into a clean, professional cardiology follow-up note. Preserve ALL clinical meaning. Do NOT add new facts, diagnoses, meds, vitals, or test results. Fix grammar, spelling, terminology, and structure. Resolve ambiguous phrasing only by rewording—do not infer. Use standard headings: Reason for Visit, HPI, ROS, Physical Exam, Diagnostics, Assessment & Plan (numbered problems), Diagnoses (ICD-10 list). Keep concise but complete.

2. **NEJM-Style Clinical Thinker**: Approach every note the way an NEJM case discussion would—consider the full differential, weigh competing diagnoses, identify what doesn't fit the leading diagnosis, and flag when the clinical picture suggests something the note may be missing. Think through:
   - What diagnoses explain ALL the findings?
   - What findings are discordant with the stated assessment?
   - Are there red herrings vs. clinically significant details being overlooked?
   - Would a master clinician presenting this at Grand Rounds raise additional considerations?
   - Is the workup appropriate and complete for the differential?

Use clinically standard terms (e.g., LVOT gradient, LGE, HFpEF) but do not expand acronyms unless already implied.
Prefer short paragraphs and bullet points in Assessment & Plan.
Keep patient identifiers out.
Speak to me as a fellow cardiologist—skip basic explanations, focus on clinical nuance and evidence-based reasoning.`;

            // Add user profile if provided
            if (userProfile) {
                systemPrompt += `

## CLINICIAN PROFILE:
${userProfile}`;
            }
            
            // Add user rules if any
            if (userRules.length > 0) {
                systemPrompt += `

## STANDING RULES (apply to every note):
${userRules.map((r, i) => `${i + 1}) ${r}`).join('\n')}`;
            }
            
            // Add checkbox-based rules
            let checkboxRules = [];
            if (ignoreSpelling) checkboxRules.push('Ignore spelling errors entirely.');
            if (ignorePunctuation) checkboxRules.push('Ignore punctuation and comma errors entirely.');
            if (!checkGrammar) checkboxRules.push('Do NOT flag grammar issues.');
            if (!flagVagueLanguage) checkboxRules.push('Do NOT flag vague language like "some", "few", "recently".');
            
            if (checkboxRules.length > 0) {
                systemPrompt += `

## ADDITIONAL INSTRUCTIONS:
${checkboxRules.map(r => `- ${r}`).join('\n')}`;
            }
            
            // Add response format instructions
            systemPrompt += `

## RESPONSE FORMAT:
Return ONLY valid JSON (no markdown, no backticks) with this exact structure:
{
  "issues": [
    {
      "type": "transcription|clinical_value|dosage|contradiction|drug_allergy|grammar|spelling|punctuation|vague_language|high_risk_med|red_flag",
      "severity": "error|warning|info",
      "section": "Which section of the note this issue is in: HPI|ROS|Physical Exam|Vitals|Medications|Allergies|Assessment & Plan|Diagnostics|Other",
      "original": "exact text from note to highlight",
      "suggested": "corrected text or null",
      "explanation": "why this is an issue"
    }
  ],
  "icd10": [
    {"code": "I50.9", "description": "Heart failure, unspecified"}
  ],
  "guidelineAlerts": ${applyCardiologyGuidelines ? `[
    {
      "guideline": "Guideline name and year",
      "finding": "What triggered this alert",
      "recommendation": "Guideline-based recommendation",
      "class": "I/IIa/IIb/III",
      "level": "A/B/C"
    }
  ]` : '[]'},
  "suggestions": ${includeSuggestions ? `{
    "diagnoses": ["Possible diagnoses to consider"],
    "diagnosticTests": ["Recommended tests"],
    "therapeutics": ["Treatment considerations"]
  }` : 'null'},${rewriteFullNote ? `
  "rewrittenNote": "The complete rewritten note with all corrections applied. Clean, professional, billing-safe format.",
  "rewrittenAP": "ONLY the Assessment & Plan section, rewritten cleanly. This is a separate field for A&P-only replacement.",
  "originalAPStart": "The EXACT first few words (10-20 words) that begin the Assessment/Plan/Impression section in the ORIGINAL note",
  "originalAPEnd": "The EXACT last few words (10-20 words) of the Assessment/Plan section in the ORIGINAL note, or 'END_OF_NOTE' if it goes to the end",
  "removedContent": [
    {
      "original": "The exact text from the original dictation that was removed or significantly condensed",
      "corrected": "The same content but with typos/transcription errors fixed, ready to insert",
      "reason": "Why it was removed: condensed, redundant, unclear, or restructured",
      "insertionPoints": ["after HPI", "after Physical Exam", "after Assessment"]
    }
  ],` : ''}
  "summary": "Brief 1-line summary"
}

If no issues found: {"issues": [], "icd10": [], "guidelineAlerts": [], "suggestions": null, ${rewriteFullNote ? '"rewrittenNote": null, "rewrittenAP": null, "originalAPStart": null, "originalAPEnd": null, "removedContent": [], ' : ''}"summary": "No issues found"}`;

            // Add rewrite instructions if requested
            if (rewriteFullNote) {
                // Always provide BOTH full rewrite AND A&P-only rewrite
                systemPrompt += `

## REWRITE FULL NOTE:
You have been asked to provide a complete rewritten version of the note. In "rewrittenNote":
- Apply ALL corrections from the issues you identified
- Format as a clean, professional medical note
- Use proper structure (HPI, ROS, Physical Exam, Assessment/Plan)
- Preserve all clinical information and the clinician's intent
- Make it billing-safe and chart-ready
- Fix transcription errors, grammar, and unclear language
- IMPORTANT: At the end of the rewritten note, include a section titled "ICD-10 Codes:" listing all applicable ICD-10 codes with descriptions, formatted as: Code - Description (one per line)

## ALSO PROVIDE A&P-ONLY REWRITE:
In "rewrittenAP", provide ONLY the Assessment & Plan section rewritten:
- Rewrite ONLY the Assessment & Plan / Impression & Summary section
- Number each problem clearly (1. Problem Name, 2. Problem Name, etc.)
- Under each problem, include relevant discussion and specific plan items
- This allows the clinician to accept just the A&P changes while keeping original HPI/Exam

## MARK THE ORIGINAL A&P LOCATION:
CRITICAL: You must identify where the Assessment/Plan section starts and ends in the ORIGINAL note:
- "originalAPStart": Copy the EXACT first 10-20 words that begin the A&P section in the original (e.g., "Assessment and Plan: 1. Hypertension" or "Impression: This is a 65")
- "originalAPEnd": Copy the EXACT last 10-20 words of the A&P section, OR use "END_OF_NOTE" if A&P goes to the end
- These markers will be used to find and replace ONLY the A&P section if the user chooses A&P-only mode
- Be PRECISE - copy the exact text including any typos or formatting from the original

## REMOVED CONTENT TRACKING:
In "removedContent", list any content from the original note that you:
- Removed entirely (not included in rewrite)
- Significantly condensed (lost specific details)
- Restructured in a way that lost original phrasing

For EACH removed item:
- "original": The exact text from the original dictation
- "corrected": The SAME content but with typos/transcription errors FIXED
- "reason": Brief reason (e.g., "condensed into HPI", "redundant", "restructured")
- "insertionPoints": 2-3 logical places where this could be inserted back

This allows the clinician to surgically re-insert specific content they want to keep.
Do NOT include content that is fully preserved in the rewrite - only content that was lost or significantly changed.
`;
            }

            // Build user prompt
            const userPrompt = `Please review this dictated medical note and identify any issues${rewriteFullNote ? ', then provide both a complete rewritten version AND a separate A&P-only rewrite' : ''}:

${text}`;

            console.log(`[${new Date().toISOString()}] Calling GPT-5.2 API...`);
            
            // Temperature fixed at 0.1 for non-reasoning mode (most precise)
            const apiTemperature = 0.1;
            
            // Map depth to GPT-5.2 reasoning effort levels
            // none | minimal | low | medium | high | xhigh
            const reasoningEffortMap = {
                'none': 'none',
                'minimal': 'minimal',
                'low': 'low',
                'medium': 'medium',
                'high': 'high',
                'xhigh': 'xhigh'
            };
            const reasoningEffort = reasoningEffortMap[depth] || 'medium';
            
            console.log(`[${new Date().toISOString()}] GPT-5.2 reasoning effort: ${reasoningEffort}`);
            
            // GPT-5.2: temperature and reasoning are MUTUALLY EXCLUSIVE
            // When reasoning is enabled (not 'none'), temperature cannot be sent
            // When reasoning is 'none', we can use temperature for output control
            const apiCallParams = {
                model: "gpt-5.2",
                input: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ]
            };
            
            if (reasoningEffort === 'none') {
                // No reasoning - use temperature for consistency
                apiCallParams.temperature = apiTemperature;
                apiCallParams.top_p = 1;
            } else {
                // Reasoning enabled - cannot use temperature
                apiCallParams.reasoning = { effort: reasoningEffort };
                // Ensure enough room for reasoning + output
                // xhigh can use 50k+ reasoning tokens, so give plenty of headroom
                apiCallParams.max_output_tokens = 65000;
            }
            
            const response = await openai.responses.create(apiCallParams);
            
            // Check if response was truncated
            if (response.status === 'incomplete') {
                const reason = response.incomplete_details?.reason || 'unknown';
                console.log(`[${new Date().toISOString()}] ⚠️ GPT-5.2 response INCOMPLETE: ${reason}`);
            }
            
            // Get the response text
            const responseText = response.output_text || '';
            
            // Calculate actual cost from usage
            const usage = response.usage || {};
            const inputTokens = usage.input_tokens || 0;
            const outputTokens = usage.output_tokens || 0;
            const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;
            const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
            
            // GPT-5.2 pricing: $1.75/1M input, $14/1M output, cached input 90% off ($0.175/1M)
            const inputCost = ((inputTokens - cachedTokens) / 1_000_000) * 1.75;
            const cachedCost = (cachedTokens / 1_000_000) * 0.175;
            const outputCost = (outputTokens / 1_000_000) * 14.00;
            const totalCost = inputCost + cachedCost + outputCost;
            
            console.log(`[${new Date().toISOString()}] GPT-5.2 usage: ${inputTokens} in (${cachedTokens} cached), ${outputTokens} out (${reasoningTokens} reasoning), cost: $${totalCost.toFixed(6)}`);
            
            // Parse JSON response
            let result;
            try {
                const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                result = JSON.parse(cleanJson);
            } catch (parseErr) {
                console.error('GPT-5.2 JSON parse error:', parseErr.message);
                console.error('GPT-5.2 raw response (first 500 chars):', responseText.substring(0, 500));
                console.error('GPT-5.2 raw response (last 300 chars):', responseText.substring(responseText.length - 300));
                console.error('GPT-5.2 response length:', responseText.length, 'chars');
                result = {
                    issues: [{ type: "error", severity: "info", original: null, suggested: null, explanation: "Could not parse GPT-5.2 response. Response was " + responseText.length + " chars. Status: " + (response.status || 'unknown') }],
                    icd10: [],
                    guidelineAlerts: [],
                    suggestions: null,
                    rewrittenNote: null,
                    summary: "Validation completed but response format was unexpected (status: " + (response.status || 'unknown') + ")"
                };
            }
            
            console.log(`[${new Date().toISOString()}] GPT-5.2 validation complete: ${result.issues?.length || 0} issues found`);
            
            // Add usage and cost info to result
            result.usage = {
                inputTokens,
                outputTokens,
                reasoningTokens,
                cachedTokens,
                totalTokens: inputTokens + outputTokens + reasoningTokens
            };
            result.cost = {
                input: inputCost,
                cached: cachedCost,
                output: outputCost,
                total: totalCost,
                formatted: `$${totalCost.toFixed(4)}`
            };
            result.model = 'gpt-5.2';
            
            return res.json(result);
            
        } catch (err) {
            console.error('GPT-5.2 validation error:', err.message);
            return res.status(500).json({ 
                error: 'GPT-5.2 validation failed', 
                message: err.message 
            });
        }
    }
    
    // ============ CLAUDE PATH (unchanged) ============
    // Select Claude model based on request
    const modelMap = {
        'sonnet': 'claude-sonnet-4-20250514',
        'opus': 'claude-opus-4-20250514'
    };
    const selectedModel = modelMap[model] || modelMap['sonnet'];
    
    // Thinking budget based on depth
    // Note: Large budgets require streaming, keep values modest
    const depthMap = {
        'quick': 0,
        'light': 2000,
        'medium': 5000,
        'deep': 10000
    };
    const thinkingBudget = depthMap[depth] || 0;
    
    // Build exam insertion instruction if examData provided
    let examInsertionInstruction = '';
    if (examData && examData.examText) {
        examInsertionInstruction = `
## ⚠️ CRITICAL: EXAM INSERTION REQUIRED ⚠️
The user has prepared physical exam findings. You MUST insert this exam into the note and return the complete modified note.

**Exam text to insert:**
<exam_to_insert>
${examData.examText}
</exam_to_insert>

**REQUIRED STEPS:**
1. Find the physical exam section in the note. Look for:
   - "PHYSICAL EXAM:" or "PE:" or "Exam:" or "Physical Examination:"
   - "[EXAM]" or "[PE]" or similar placeholders
   - "OBJECTIVE:" section in SOAP format
   - Any exam-related header or section
2. REPLACE the existing exam content (or placeholder) with the exam text above
3. If no exam section exists, INSERT after vital signs or after the HPI section
4. In your JSON response, you MUST include:
   - "modifiedNote": The COMPLETE note text with exam inserted, wrapped with %%EXAM_INSERT_START%% before the inserted exam and %%EXAM_INSERT_END%% after it
   - "examInsertedAt": Description of where you inserted it (e.g., "Replaced PHYSICAL EXAM section")

**EXAMPLE modifiedNote format:**
"...prior note text...\\n\\nPHYSICAL EXAM:\\n%%EXAM_INSERT_START%%CV: RRR, normal S1/S2...%%EXAM_INSERT_END%%\\n\\n...rest of note..."

THIS IS MANDATORY - DO NOT SKIP THE modifiedNote FIELD!
`;
    }
    
    console.log(`[${new Date().toISOString()}] Validating ${text.length} chars with ${selectedModel}, depth: ${depth || 'quick'}, thinking: ${thinkingBudget}, suggestions: ${includeSuggestions || false}, examData: ${examData ? 'yes' : 'no'}, profile: ${userProfile ? 'yes' : 'no'}`);
    
    // Load templates to exclude if templateCode provided
    let templateExclusions = '';
    if (templateCode) {
        try {
            let templates = [];
            if (process.env.DATABASE_URL) {
                const result = await pool.query('SELECT templates FROM templates WHERE storage_code = $1', [templateCode]);
                if (result.rows.length > 0) {
                    templates = typeof result.rows[0].templates === 'string' 
                        ? JSON.parse(result.rows[0].templates) 
                        : result.rows[0].templates;
                }
            } else {
                const data = templatesMemory.get(templateCode);
                if (data) templates = data.templates;
            }
            
            if (templates.length > 0) {
                const templateTexts = templates.map(t => t.text).join('\n---\n');
                templateExclusions = `

## TEMPLATE TEXT TO IGNORE:
The following are saved templates. Do NOT flag any text that matches these templates as errors - they are intentional boilerplate:
<templates>
${templateTexts}
</templates>
`;
            }
        } catch (err) {
            console.error('Error loading templates for exclusion:', err.message);
        }
    }
    
    // Load ignore rules if templateCode provided
    let ignoreRulesSection = '';
    if (templateCode) {
        try {
            if (process.env.DATABASE_URL) {
                const result = await pool.query(
                    'SELECT rule_text FROM ignore_rules WHERE storage_code = $1',
                    [templateCode]
                );
                if (result.rows.length > 0) {
                    const rules = result.rows.map(r => `- ${r.rule_text}`).join('\n');
                    ignoreRulesSection = `

## USER RULES & PREFERENCES:
The user has specified the following rules and preferences. Follow these instructions carefully:
${rules}

These may include things to ignore, things to always check for, reminders to include certain information, or other preferences. Respect all of them.
`;
                    console.log(`[${new Date().toISOString()}] Loaded ${result.rows.length} ignore rules`);
                }
            }
        } catch (err) {
            console.error('Error loading ignore rules:', err.message);
        }
    }
    
    try {
        // max_tokens must be greater than thinking budget
        // Add 4096 for actual response on top of thinking
        const maxTokens = thinkingBudget > 0 ? thinkingBudget + 4096 : 4096;
        
        // Build API request options
        const apiOptions = {
            model: selectedModel,
            max_tokens: maxTokens,
            messages: [{
                role: "user",
                content: `You are an expert medical transcription reviewer with deep knowledge of cardiology, internal medicine, and clinical documentation. You also think like an NEJM Case Records discussant—always considering the full differential, identifying discordant findings, and flagging when the clinical picture suggests something the note may be missing. Approach every note as a master clinician would at Grand Rounds. Analyze this dictation thoroughly.
${userProfile ? `
## USER PROFILE:
The user has provided the following context about themselves. Adjust your tone, detail level, and explanations accordingly:
${userProfile}
` : ''}
## TEMPLATE PLACEHOLDERS TO IGNORE:
Do NOT flag the following as errors - they are intentional template placeholders:
- Bracketed placeholders: [PATIENT NAME], [DATE], [DOS], [DOB], [PROVIDER], [MRN], etc.
- Blank lines or underscores: ______, _________
- Variable placeholders: {{variable}}, {date}, {name}
- All-caps section headers: CHIEF COMPLAINT:, ASSESSMENT:, PLAN:, HPI:, etc.
- Standard template phrases like "as above", "see above", "as discussed"
${templateExclusions}
${ignoreRulesSection}
${examInsertionInstruction}
## CHECKS TO PERFORM:

1. **Transcription errors**: Speech-to-text mistakes, medical homophones (ileum/ilium, prostate/prostrate, mucus/mucous, fifteen/fifty)

2. **Clinical value contradictions**: Numbers that don't match their descriptors:
   - "Normal EF 15%" (normal is 55-70%, 15% is severely reduced)
   - "Bradycardia at 110 bpm" (that's tachycardia)
   - "Mild AS with AVA 0.7" (that's severe AS)
   - "Normal QTc 580ms" (that's prolonged)
   - "Hypertensive at 110/70" (that's normal)
   - Any vital sign, lab value, or measurement that contradicts its descriptor

3. **Dosage red flags**: Amounts outside typical ranges

4. **Internal contradictions**: Gender/procedure mismatches, conflicting diagnoses, rhythm vs treatment mismatches

5. **Anatomical impossibilities**: Procedures on removed organs, impossible combinations

6. **Drug-allergy conflicts**: Prescriptions that conflict with documented allergies

7. **Drug-condition conflicts**: Beta-blocker with severe bradycardia, etc.

8. **Missing critical info**: Allergies mentioned but not listed, incomplete documentation

9. **Spelling errors**: Non-medical typos and misspellings (proper nouns, common words)

10. **Grammar issues**: Subject-verb disagreement, tense inconsistencies, sentence fragments, run-on sentences, awkward phrasing

11. **Punctuation & formatting**: Missing periods, incorrect comma usage, capitalization errors, inconsistent formatting

12. **Vague language**: Flag imprecise terms that should be quantified:
   - "some", "a few", "several", "many" → suggest specific numbers
   - "recently", "a while ago", "occasionally" → suggest specific timeframes
   - "improved", "worsened", "stable" → suggest measurable comparisons

13. **HIGH-RISK MEDICATION CHECKER**: Flag any mention of high-risk medications that require extra scrutiny:
   - **Anticoagulants**: Warfarin, heparin, enoxaparin, rivaroxaban, apixaban, dabigatran, edoxaban
     → Check for: INR/anti-Xa mentioned? Bleeding risk assessed? Indication documented?
   - **Insulin**: Any insulin product
     → Check for: Blood glucose mentioned? Dose seems appropriate? Hypoglycemia risk?
   - **Opioids**: Morphine, oxycodone, hydrocodone, fentanyl, hydromorphone, methadone
     → Check for: Pain scale documented? Duration/quantity appropriate? Naloxone discussed?
   - **Antiarrhythmics**: Amiodarone, sotalol, flecainide, dofetilide
     → Check for: QTc mentioned? Monitoring plan? Drug interactions?
   - **Digoxin**: Check for renal function, potassium, drug level monitoring
   - **Chemotherapy agents**: Any chemo drug → verify dosing, labs, consent
   - **High-alert IV drugs**: Potassium chloride, vasopressors, sedatives
   
   For each high-risk med, flag as WARNING or ERROR if:
   - Required monitoring not mentioned
   - Dose seems outside typical range
   - Potential dangerous interaction with another med or condition in the note
   - Duration/quantity concerning

14. **RED FLAG DETECTOR**: Identify clinical scenarios that warrant urgent attention or specific workup:
   - **Chest pain + risk factors** → Is ACS workup documented? Troponin, EKG mentioned?
   - **Syncope** → Is cardiac vs neurologic workup addressed? Driving restrictions?
   - **New neurologic deficits** → Stroke workup? Time of onset documented?
   - **Severe hypertension** (SBP >180 or DBP >120) → End-organ damage assessed?
   - **Hypotension with symptoms** → Etiology addressed? Fluid status?
   - **Acute dyspnea** → Differential documented? (PE, HF, pneumonia, COPD exac)
   - **GI bleed signs** (melena, hematemesis, coffee-ground) → Hemoglobin? GI consult?
   - **Acute kidney injury** → Baseline creatinine compared? Nephrotoxins reviewed?
   - **Altered mental status** → Infection, metabolic, intracranial causes addressed?
   - **New murmur + fever** → Endocarditis workup mentioned?
   - **DVT symptoms + risk factors** → Ultrasound or D-dimer plan?
   - **Suicidal ideation** → Safety assessment documented?
   
   For each red flag, create an issue with:
   - type: "red_flag"
   - severity: "error" (critical) or "warning" (should address)
   - The clinical finding that triggered it
   - What documentation/workup may be missing

## RESPONSE FORMAT:

For EACH issue, you MUST provide:
- "section": Which section of the note this issue is in (HPI, ROS, Physical Exam, Vitals, Medications, Allergies, Assessment & Plan, Diagnostics, or Other)
- "original": The exact problematic text from the dictation (so it can be found and replaced)
- "suggested": The corrected text to replace it with
- "explanation": Why this is an issue

Return JSON only (no markdown, no backticks):
{
  "issues": [
    {
      "type": "clinical_value",
      "severity": "error",
      "section": "Diagnostics",
      "original": "Normal ejection fraction of 15%",
      "suggested": "Severely reduced ejection fraction of 15%",
      "explanation": "15% EF is severely reduced (normal is 55-70%), not normal. Verify if 15% is correct or if it should be 50-55%."
    },
    {
      "type": "transcription",
      "severity": "warning",
      "section": "HPI",
      "original": "history of dye-a-beat-ease",
      "suggested": "history of diabetes",
      "explanation": "Likely speech-to-text error for 'diabetes'"
    },
    {
      "type": "grammar",
      "severity": "info",
      "section": "HPI",
      "original": "Patient have chest pain",
      "suggested": "Patient has chest pain",
      "explanation": "Subject-verb agreement: singular 'patient' requires 'has'"
    },
    {
      "type": "vague_language",
      "severity": "info",
      "section": "HPI",
      "original": "some chest pain recently",
      "suggested": "chest pain for the past 3 days",
      "explanation": "'Some' and 'recently' are vague - specify quantity and timeframe"
    },
    {
      "type": "high_risk_med",
      "severity": "warning",
      "section": "Assessment & Plan",
      "original": "Started on warfarin 5mg daily",
      "suggested": null,
      "explanation": "High-risk anticoagulant: Consider documenting INR monitoring plan and bleeding precautions"
    },
    {
      "type": "red_flag",
      "severity": "error",
      "section": "HPI",
      "original": "chest pain radiating to left arm",
      "suggested": null,
      "explanation": "Red flag: Chest pain with radiation - ensure ACS workup documented (troponin, EKG results, disposition)"
    }
  ],
  "icd10": [
    {"code": "I50.9", "description": "Heart failure, unspecified"},
    {"code": "I10", "description": "Essential (primary) hypertension"}
  ],
  "guidelineAlerts": [
    {
      "guideline": "2022 AHA/ACC/HFSA Heart Failure Guideline",
      "finding": "EF 35% with NYHA Class II symptoms on ACE inhibitor only",
      "recommendation": "Four pillars of GDMT recommended: ARNI (or ACEi), beta-blocker, MRA, and SGLT2i. Consider ICD for primary prevention if EF remains ≤35% after 3+ months of optimized GDMT.",
      "class": "I",
      "level": "A"
    }
  ],
  "modifiedNote": "REQUIRED if exam insertion was requested. Contains the FULL original note with exam inserted, with %%EXAM_INSERT_START%% and %%EXAM_INSERT_END%% markers around the inserted exam. Set to null ONLY if no exam was requested.",
  "examInsertedAt": "REQUIRED if exam insertion was requested. Describes where inserted (e.g., 'Replaced PHYSICAL EXAM section'). Set to null ONLY if no exam was requested.",
  "suggestions": ${includeSuggestions ? `{
    "diagnoses": ["Possible differential diagnoses to consider"],
    "diagnosticTests": ["Recommended tests to confirm or rule out conditions"],
    "therapeutics": ["Treatment considerations based on findings"]
  }` : 'null'},
  "rewrittenNote": ${rewriteFullNote ? '"The complete rewritten note with all corrections applied. Clean, professional, billing-safe format."' : 'null'},
  "rewrittenAP": ${rewriteFullNote ? '"ONLY the Assessment & Plan section, rewritten cleanly. This is a separate field for A&P-only replacement."' : 'null'},
  "originalAPStart": ${rewriteFullNote ? '"The EXACT first few words (10-20 words) that begin the Assessment/Plan/Impression section in the ORIGINAL note"' : 'null'},
  "originalAPEnd": ${rewriteFullNote ? '"The EXACT last few words (10-20 words) of the Assessment/Plan section in the ORIGINAL note, or END_OF_NOTE if it goes to the end"' : 'null'},
  "removedContent": ${rewriteFullNote ? `[
    {
      "original": "The exact text from the original dictation that was removed or significantly condensed",
      "corrected": "The same content but with typos/transcription errors fixed, ready to insert",
      "reason": "Why it was removed: condensed, redundant, unclear, or restructured",
      "insertionPoints": ["after HPI", "after Physical Exam", "after Assessment"]
    }
  ]` : 'null'},
  "summary": "Brief 1-line summary"
}

Severity levels: "error" (critical/dangerous), "warning" (should review), "info" (minor/suggestion)
Issue types include: "transcription", "clinical_value", "dosage", "contradiction", "drug_allergy", "drug_condition", "grammar", "spelling", "punctuation", "vague_language", "high_risk_med", "red_flag"

IMPORTANT: The "original" field must contain the EXACT text from the dictation so it can be found and replaced. If you cannot find exact text to replace, set original to null.

If no issues: {"issues": [], "icd10": [...], "guidelineAlerts": [], "modifiedNote": null, "examInsertedAt": null, "suggestions": null, "rewrittenNote": null, "rewrittenAP": null, "originalAPStart": null, "originalAPEnd": null, "removedContent": [], "summary": "No issues found"}
${rewriteFullNote ? `
## REWRITE FULL NOTE:
You have been asked to provide a complete rewritten version of the note. In "rewrittenNote":
- Apply ALL corrections from the issues you identified
- Format as a clean, professional medical note
- Use proper structure (HPI, ROS, Physical Exam, Assessment/Plan)
- Preserve all clinical information and the clinician's intent
- Make it billing-safe and chart-ready
- Fix transcription errors, grammar, and unclear language
- IMPORTANT: At the end of the rewritten note, include a section titled "ICD-10 Codes:" listing all applicable ICD-10 codes with descriptions, formatted as: Code - Description (one per line)

## ALSO PROVIDE A&P-ONLY REWRITE:
In "rewrittenAP", provide ONLY the Assessment & Plan section rewritten:
- Rewrite ONLY the Assessment & Plan / Impression & Summary section
- Number each problem clearly (1. Problem Name, 2. Problem Name, etc.)
- Under each problem, include relevant discussion and specific plan items
- This allows the clinician to accept just the A&P changes while keeping original HPI/Exam

## MARK THE ORIGINAL A&P LOCATION:
CRITICAL: You must identify where the Assessment/Plan section starts and ends in the ORIGINAL note:
- "originalAPStart": Copy the EXACT first 10-20 words that begin the A&P section in the original
- "originalAPEnd": Copy the EXACT last 10-20 words of the A&P section, OR use "END_OF_NOTE" if A&P goes to the end
- Be PRECISE - copy the exact text including any typos or formatting from the original

## REMOVED CONTENT TRACKING:
In "removedContent", list any content from the original note that you:
- Removed entirely (not included in rewrite)
- Significantly condensed (lost specific details)
- Restructured in a way that lost original phrasing

For EACH removed item:
- "original": The exact text from the original dictation
- "corrected": The SAME content but with typos/transcription errors FIXED (e.g., "polyp echocardiogram" → "post-op echocardiogram", "valsava" → "Valsalva", "antriceps" → "anteroseptal")
- "reason": Brief reason (e.g., "condensed into HPI", "redundant", "restructured")
- "insertionPoints": 2-3 logical places where this could be inserted back (e.g., ["after HPI", "after Echo findings", "in Assessment"])

This allows the clinician to surgically re-insert specific content they want to keep.
Do NOT include content that is fully preserved in the rewrite - only content that was lost or significantly changed.
` : ''}${includeSuggestions ? `
## CLINICAL SUGGESTIONS REQUESTED:
The user has requested clinical suggestions. Please include in your response:
- **Diagnosis conclusions**: Based on the clinical picture, what diagnoses are supported or should be considered?
- **Diagnostic tests**: What additional tests might help confirm, rule out, or further evaluate the conditions mentioned?
- **Therapeutic suggestions**: Based on the findings and likely diagnoses, what treatment approaches should be considered?

Keep suggestions evidence-based, relevant to the specific case, and appropriately cautious. These are meant as decision support, not definitive recommendations.
` : ''}${!checkGrammar ? `
## SKIP GRAMMAR:
Do NOT flag grammar issues (subject-verb agreement, tense, sentence structure). Focus on medical/clinical content.
` : ''}${ignoreSpelling ? `
## SKIP SPELLING:
Do NOT flag spelling errors or typos. Focus only on medical/clinical issues, not spelling mistakes.
` : ''}${ignorePunctuation ? `
## SKIP PUNCTUATION:
Do NOT flag punctuation issues (missing periods, commas, capitalization, etc). Focus only on medical/clinical content.
` : ''}${!flagVagueLanguage ? `
## SKIP VAGUE LANGUAGE:
Do NOT flag vague terms like "some", "few", "recently". Focus on medical errors only.
` : ''}${!applyCardiologyGuidelines ? `
## CARDIOLOGY GUIDELINES DISABLED:
Do NOT include any guidelineAlerts in your response. The guidelineAlerts array must be empty []. Do not proactively suggest ACC/AHA/HRS guideline-based recommendations.
` : ''}${applyCardiologyGuidelines ? `
## CARDIOLOGY GUIDELINE REVIEW:
You are an expert in ACC/AHA/HRS guidelines. Actively review this dictation against current cardiology guidelines and provide alerts in the "guidelineAlerts" array when:

**Heart Failure:**
- HFrEF (EF ≤40%): Check for four pillars of GDMT (ARNI/ACEi/ARB, beta-blocker, MRA, SGLT2i)
- HFrEF with EF ≤35%: Consider ICD for primary prevention after 3+ months optimized GDMT
- HFrEF with LBBB and EF ≤35%: Consider CRT
- HFpEF: SGLT2i recommended, diuretics for congestion

**Atrial Fibrillation:**
- Calculate CHA₂DS₂-VASc and recommend anticoagulation if ≥2 (men) or ≥3 (women)
- Rate vs rhythm control considerations
- Note if rate control target (<110 resting, or <80 if symptomatic) achieved
- Ablation considerations for symptomatic AF on AAD

**Valvular Disease:**
- Severe AS (AVA <1.0, mean gradient >40, Vmax >4): Intervention if symptomatic or EF <50%
- Severe MR: Surgery considerations based on EF, LVESD, symptoms
- Indicate if valve intervention criteria may be met

**Coronary Artery Disease:**
- STEMI: Door-to-balloon <90 min, antiplatelet therapy, high-intensity statin
- NSTEMI/UA: Risk stratification, early invasive vs conservative
- Stable CAD: Optimal medical therapy, revascularization considerations
- Secondary prevention: Statin, antiplatelet, BP control, diabetes management

**Arrhythmias:**
- Bradycardia: Pacemaker indications (symptomatic, Mobitz II, CHB, pauses >3s)
- VT/VF: ICD indications, antiarrhythmic choice
- Long QT: QTc thresholds, drug interactions

**Lipids & Prevention:**
- High-intensity statin for ASCVD
- LDL targets based on risk category
- PCSK9i considerations if LDL not at goal

**Hypertension:**
- BP targets by comorbidity (general <130/80, elderly considerations)
- First-line agent selection based on comorbidities

For each guideline alert, include:
- guideline: The specific guideline name and year
- finding: What in the note triggered this alert
- recommendation: The guideline-based recommendation
- class: Recommendation class (I, IIa, IIb, III) if applicable
- level: Evidence level (A, B, C) if applicable

Be proactive - if the clinical scenario suggests a guideline applies, mention it even if not explicitly asked.
` : ''}
Dictation to review:
${text}`
            }]
        };
        
        // Add extended thinking if depth is not quick
        if (thinkingBudget > 0) {
            apiOptions.thinking = {
                type: "enabled",
                budget_tokens: thinkingBudget
            };
        }
        
        const message = await anthropic.messages.create(apiOptions);
        
        // Parse the response - handle thinking blocks if present
        let responseText = '';
        for (const block of message.content) {
            if (block.type === 'text') {
                responseText = block.text;
                break;
            }
        }
        
        // Try to parse as JSON, handle potential markdown wrapping
        let result;
        try {
            // Remove any markdown code block if present
            const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            result = JSON.parse(cleanJson);
        } catch (parseErr) {
            console.error('JSON parse error:', parseErr.message);
            result = {
                issues: [{ type: "error", severity: "info", text: "Could not parse validation response" }],
                corrected: null,
                summary: "Validation completed but response format was unexpected"
            };
        }
        
        console.log(`[${new Date().toISOString()}] Validation complete (${model || 'sonnet'}): ${result.issues.length} issues found`);
        res.json(result);
        
    } catch (err) {
        console.error('Validation error:', err.message);
        res.status(500).json({ 
            error: 'Validation failed', 
            message: err.message 
        });
    }
});

// ============================================================================
// ============ CARDIOSCAN: MEDICAL IMAGE ANALYSIS API ======================
// ============================================================================
// All endpoints below are NEW for the CardioScan iPhone app.
// They do NOT modify any existing endpoints above.
// ============================================================================

// --- Cost tables for tracking ---
const COST_TABLE = {
    // Claude pricing per 1M tokens
    'claude-opus': { input: 15.0, output: 75.0, name: 'Claude Opus 4' },
    'claude-sonnet': { input: 3.0, output: 15.0, name: 'Claude Sonnet 4' },
    // GPT-5.2 pricing per 1M tokens
    'gpt-5.2': { input: 1.75, output: 14.0, cached_input: 0.175, name: 'GPT-5.2' }
};

// --- Document type detection prompts ---
const DOC_TYPE_PROFILES = {
    echo: {
        label: 'Echocardiogram Report',
        extractPrompt: `Extract ALL echo findings into structured JSON:
{
  "documentType": "echo",
  "patientInfo": { "name": null, "mrn": null, "dob": null, "dos": null },
  "findings": {
    "lvef": { "value": null, "method": null, "priorValue": null },
    "lvedd": null, "lvesd": null, "lvedv": null, "lvesv": null,
    "wallMotion": { "normal": true, "abnormalities": [] },
    "diastolicFunction": { "grade": null, "eePrime": null, "laVolume": null, "trVelocity": null },
    "rvFunction": { "tapse": null, "rvsp": null, "size": null },
    "valves": {
      "aortic": { "stenosis": null, "regurgitation": null, "ava": null, "meanGradient": null, "peakVelocity": null },
      "mitral": { "stenosis": null, "regurgitation": null, "mva": null },
      "tricuspid": { "regurgitation": null },
      "pulmonic": { "regurgitation": null }
    },
    "pericardium": null,
    "aorticRoot": null, "ascendingAorta": null,
    "laSize": null, "raSize": null
  },
  "impressionText": "Copy the impression/summary verbatim",
  "rawText": "Full OCR text of the document"
}`
    },
    cardiac_mri: {
        label: 'Cardiac MRI Report',
        extractPrompt: `Extract ALL cardiac MRI findings into structured JSON:
{
  "documentType": "cardiac_mri",
  "patientInfo": { "name": null, "mrn": null, "dob": null, "dos": null },
  "findings": {
    "lvef": null, "rvef": null,
    "lvedv": null, "lvesv": null, "rvedv": null, "rvesv": null,
    "lvMass": null,
    "wallMotion": [],
    "lateGadoliniumEnhancement": { "present": false, "pattern": null, "segments": [] },
    "t1Mapping": null, "t2Mapping": null, "ecv": null,
    "perfusion": null,
    "pericardium": null,
    "valves": {}
  },
  "impressionText": "Copy impression verbatim",
  "rawText": "Full text"
}`
    },
    ecg: {
        label: 'ECG/EKG Strip',
        extractPrompt: `Analyze this ECG strip and extract findings into structured JSON:
{
  "documentType": "ecg",
  "patientInfo": { "name": null, "mrn": null, "dos": null },
  "findings": {
    "rate": null, "rhythm": null,
    "prInterval": null, "qrsDuration": null, "qtcInterval": null,
    "axis": { "pAxis": null, "qrsAxis": null, "tAxis": null },
    "morphology": {
      "pWave": null, "qrsComplex": null, "stSegment": null, "tWave": null
    },
    "conduction": { "avBlock": null, "bundleBranch": null, "fascicular": null },
    "ischemia": { "stChanges": [], "tWaveChanges": [], "qWaves": [] },
    "hypertrophy": { "lvh": false, "rvh": false, "lae": false, "rae": false },
    "intervals": { "shortPR": false, "deltaWave": false, "longQT": false }
  },
  "machineInterpretation": "Copy machine read if visible",
  "rawText": "Any printed text on the ECG"
}`
    },
    stress_test: {
        label: 'Stress Test Report',
        extractPrompt: `Extract stress test findings into structured JSON:
{
  "documentType": "stress_test",
  "testType": "exercise|nuclear|stress_echo|pharmacologic",
  "patientInfo": { "name": null, "mrn": null, "dos": null },
  "findings": {
    "protocol": null, "duration": null, "mets": null,
    "maxHR": null, "percentPredicted": null, "restingHR": null,
    "restingBP": null, "peakBP": null,
    "symptoms": [], "reasonStopped": null,
    "stChanges": { "present": false, "leads": [], "magnitude": null, "morphology": null },
    "arrhythmias": [],
    "nuclear": { "perfusionDefects": [], "reversibility": null, "ejectionFraction": null, "tID": null },
    "stressEcho": { "restEF": null, "stressEF": null, "wallMotionChanges": [] }
  },
  "impressionText": "Copy impression verbatim",
  "rawText": "Full text"
}`
    },
    ct_coronary: {
        label: 'CT Coronary / CT Scan Report',
        extractPrompt: `Extract CT findings into structured JSON:
{
  "documentType": "ct_coronary",
  "patientInfo": { "name": null, "mrn": null, "dos": null },
  "findings": {
    "calciumScore": { "total": null, "lad": null, "lcx": null, "rca": null, "lm": null },
    "coronaryArteries": {
      "leftMain": { "stenosis": null, "plaque": null },
      "lad": { "stenosis": null, "plaque": null },
      "lcx": { "stenosis": null, "plaque": null },
      "rca": { "stenosis": null, "plaque": null }
    },
    "grafts": [],
    "stents": [],
    "cardiac": { "lvFunction": null, "pericardium": null, "valves": null },
    "extraCardiac": []
  },
  "impressionText": "Copy impression verbatim",
  "rawText": "Full text"
}`
    },
    cath_report: {
        label: 'Catheterization Lab Report',
        extractPrompt: `Extract cath lab findings into structured JSON:
{
  "documentType": "cath_report",
  "patientInfo": { "name": null, "mrn": null, "dos": null },
  "findings": {
    "hemodynamics": {
      "lvedp": null, "pcwp": null, "paPressure": null, "raPressure": null,
      "cardiacOutput": null, "cardiacIndex": null, "pvr": null, "svr": null
    },
    "coronaryAngiography": {
      "leftMain": null, "lad": null, "diagonals": null,
      "lcx": null, "om": null, "rca": null, "pda": null, "plv": null,
      "dominance": null
    },
    "interventions": [{ "vessel": null, "type": null, "stent": null, "result": null }],
    "lv": { "ef": null, "wallMotion": null },
    "complications": []
  },
  "impressionText": "Copy impression verbatim",
  "rawText": "Full text"
}`
    },
    lab_results: {
        label: 'Lab Results / Bloodwork',
        extractPrompt: `Extract ALL lab values into structured JSON:
{
  "documentType": "lab_results",
  "patientInfo": { "name": null, "mrn": null, "dos": null },
  "panels": [
    {
      "panelName": "e.g. BMP, CBC, Lipid Panel, Coagulation, Thyroid, BNP",
      "collectionTime": null,
      "results": [
        { "test": "test name", "value": "numeric or text value", "unit": "unit", "refRange": "reference range", "flag": "H|L|C|null" }
      ]
    }
  ],
  "criticalValues": [{ "test": null, "value": null, "flag": "critical" }],
  "rawText": "Full text"
}`
    },
    clinic_note: {
        label: 'Clinic Note / H&P / Progress Note',
        extractPrompt: `Extract the clinical note into structured JSON:
{
  "documentType": "clinic_note",
  "patientInfo": { "name": null, "mrn": null, "dob": null, "dos": null, "provider": null },
  "sections": {
    "chiefComplaint": null,
    "hpi": null,
    "pmh": [],
    "medications": [],
    "allergies": [],
    "socialHistory": null,
    "familyHistory": null,
    "ros": null,
    "vitals": { "bp": null, "hr": null, "temp": null, "rr": null, "spo2": null, "weight": null },
    "physicalExam": null,
    "diagnostics": null,
    "assessment": null,
    "plan": []
  },
  "diagnoses": [{ "icd10": null, "description": null }],
  "rawText": "Full text"
}`
    },
    patient_list: {
        label: 'Patient List (Rounding)',
        extractPrompt: `Extract the patient list into structured JSON:
{
  "documentType": "patient_list",
  "patients": [
    {
      "name": null, "mrn": null, "room": null, "bed": null,
      "age": null, "sex": null,
      "admitDate": null, "admitDiagnosis": null,
      "attendingMD": null, "consultService": null,
      "briefHx": null,
      "keyLabs": [],
      "keyVitals": {},
      "activeMeds": [],
      "pendingItems": []
    }
  ],
  "rawText": "Full text"
}`
    },
    vitals: {
        label: 'Vitals Screen',
        extractPrompt: `Extract vitals into structured JSON:
{
  "documentType": "vitals",
  "patientInfo": { "name": null, "mrn": null },
  "vitalSets": [
    {
      "timestamp": null,
      "bp": { "systolic": null, "diastolic": null },
      "hr": null, "rr": null, "temp": null, "spo2": null,
      "weight": null, "height": null, "bmi": null,
      "painScore": null,
      "io": { "intake": null, "output": null }
    }
  ],
  "rawText": "Full text"
}`
    }
};

// --- Helper: Call Claude for image analysis ---
async function callClaudeWithImages(images, systemPrompt, userPrompt, model, settings = {}) {
    const startTime = Date.now();
    
    const modelMap = {
        'claude-opus': 'claude-opus-4-20250514',
        'claude-sonnet': 'claude-sonnet-4-20250514'
    };
    const selectedModel = modelMap[model] || modelMap['claude-sonnet'];
    
    // Build content array with images + text
    const content = [];
    for (const img of images) {
        content.push({
            type: "image",
            source: {
                type: "base64",
                media_type: img.mediaType || "image/jpeg",
                data: img.base64
            }
        });
    }
    content.push({ type: "text", text: userPrompt });
    
    const apiOptions = {
        model: selectedModel,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content }]
    };
    
    // Add thinking if requested
    if (settings.thinkingBudget && settings.thinkingBudget > 0) {
        apiOptions.thinking = { type: "enabled", budget_tokens: settings.thinkingBudget };
        apiOptions.max_tokens = settings.thinkingBudget + 8192;
    }
    
    const message = await anthropic.messages.create(apiOptions);
    
    // Extract text response
    let responseText = '';
    for (const block of message.content) {
        if (block.type === 'text') {
            responseText = block.text;
            break;
        }
    }
    
    const elapsed = Date.now() - startTime;
    const usage = message.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    
    const pricing = COST_TABLE[model] || COST_TABLE['claude-sonnet'];
    const cost = ((inputTokens / 1_000_000) * pricing.input) + ((outputTokens / 1_000_000) * pricing.output);
    
    return {
        text: responseText,
        model: selectedModel,
        timing: { ms: elapsed, seconds: (elapsed / 1000).toFixed(1) },
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        cost: { total: cost, formatted: `$${cost.toFixed(4)}` }
    };
}

// --- Helper: Call GPT-5.2 for image analysis ---
async function callGPTWithImages(images, systemPrompt, userPrompt, settings = {}) {
    const startTime = Date.now();
    
    // Build input array with images
    const userContent = [];
    for (const img of images) {
        userContent.push({
            type: "input_image",
            image_url: `data:${img.mediaType || 'image/jpeg'};base64,${img.base64}`
        });
    }
    userContent.push({ type: "input_text", text: userPrompt });
    
    const apiCallParams = {
        model: "gpt-5.2",
        input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
        ]
    };
    
    // GPT-5.2: reasoning and temperature are mutually exclusive
    const reasoningLevel = settings.reasoning || 'none';
    if (reasoningLevel === 'none') {
        apiCallParams.temperature = 0.1;
    } else {
        apiCallParams.reasoning = { effort: reasoningLevel };
        apiCallParams.max_output_tokens = 32000;
    }
    
    const response = await openai.responses.create(apiCallParams);
    
    const elapsed = Date.now() - startTime;
    const responseText = response.output_text || '';
    const usage = response.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;
    const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
    
    const pricing = COST_TABLE['gpt-5.2'];
    const inputCost = ((inputTokens - cachedTokens) / 1_000_000) * pricing.input;
    const cachedCost = (cachedTokens / 1_000_000) * pricing.cached_input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    const totalCost = inputCost + cachedCost + outputCost;
    
    return {
        text: responseText,
        model: 'gpt-5.2',
        timing: { ms: elapsed, seconds: (elapsed / 1000).toFixed(1) },
        usage: { inputTokens, outputTokens, reasoningTokens, cachedTokens, totalTokens: inputTokens + outputTokens },
        cost: { total: totalCost, formatted: `$${totalCost.toFixed(4)}` }
    };
}

// --- Helper: Parse AI JSON response ---
function parseAIJson(text) {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
}

// --- Helper: Call appropriate AI model ---
async function callAIWithImages(images, systemPrompt, userPrompt, model, settings = {}) {
    if (model === 'gpt-5.2') {
        return callGPTWithImages(images, systemPrompt, userPrompt, settings);
    } else {
        return callClaudeWithImages(images, systemPrompt, userPrompt, model, settings);
    }
}

// ============ ENDPOINT: Single/Multi Image Analysis ============
// POST /api/image-analyze
// Body: { images: [{base64, mediaType}], readerModel, readerSettings, interpreterModel, interpreterSettings, mode, storageCode, documentType? }
app.post('/api/image-analyze', async (req, res) => {
    const {
        images,
        readerModel = 'claude-sonnet',
        readerSettings = {},
        interpreterModel = 'claude-sonnet',
        interpreterSettings = {},
        mode = 'clinic',
        storageCode,
        documentType // optional: force a specific doc type instead of auto-detect
    } = req.body;
    
    if (!images || !images.length) {
        return res.status(400).json({ error: 'No images provided' });
    }
    
    const sessionId = `cs_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    console.log(`[${new Date().toISOString()}] CardioScan session ${sessionId}: ${images.length} image(s), reader=${readerModel}, interpreter=${interpreterModel}, mode=${mode}`);
    
    try {
        // ===== STEP 1: READER — Extract data from image(s) =====
        const readerSystemPrompt = `You are an expert medical document reader with board-certified cardiology knowledge. Your job is to extract ALL data from the provided medical image(s) with perfect accuracy. Never fabricate values. If something is unclear, note it as "unclear" rather than guessing. Return ONLY valid JSON, no markdown.`;
        
        let readerUserPrompt;
        if (documentType && DOC_TYPE_PROFILES[documentType]) {
            // User specified document type
            readerUserPrompt = `This is a ${DOC_TYPE_PROFILES[documentType].label}.\n\n${DOC_TYPE_PROFILES[documentType].extractPrompt}`;
        } else {
            // Auto-detect: ask AI to identify type first, then extract
            const typeList = Object.entries(DOC_TYPE_PROFILES).map(([k, v]) => `"${k}": ${v.label}`).join(', ');
            readerUserPrompt = `First, identify what type of medical document this is from these options: ${typeList}.

Then extract ALL data using the appropriate format below.

${Object.entries(DOC_TYPE_PROFILES).map(([key, profile]) => `If ${profile.label}:\n${profile.extractPrompt}`).join('\n\n')}

If the document doesn't match any type, extract whatever structured data you can and set documentType to "other".`;
        }
        
        const readerResult = await callAIWithImages(images, readerSystemPrompt, readerUserPrompt, readerModel, readerSettings);
        
        let extractedData;
        try {
            extractedData = parseAIJson(readerResult.text);
        } catch (e) {
            console.error(`[${new Date().toISOString()}] Reader JSON parse error:`, e.message);
            extractedData = { documentType: 'unknown', rawText: readerResult.text, parseError: true };
        }
        
        console.log(`[${new Date().toISOString()}] Reader complete: type=${extractedData.documentType}, ${readerResult.timing.seconds}s, ${readerResult.cost.formatted}`);
        
        // ===== STEP 2: INTERPRETER — Clinical analysis =====
        const detectedType = extractedData.documentType || 'unknown';
        
        const interpreterSystemPrompt = `You are a board-certified cardiologist providing clinical interpretation. Analyze the extracted medical data and provide expert clinical analysis. Think like an NEJM Case Records discussant. Be specific, evidence-based, and actionable. Return ONLY valid JSON, no markdown.`;
        
        const interpreterUserPrompt = `Here is extracted data from a ${DOC_TYPE_PROFILES[detectedType]?.label || 'medical document'}:

${JSON.stringify(extractedData, null, 2)}

Provide clinical interpretation as JSON:
{
  "documentType": "${detectedType}",
  "clinicalSummary": "2-3 sentence clinical summary a cardiologist would want to see first",
  "keyFindings": [
    { "finding": "description", "significance": "normal|abnormal|critical", "clinicalContext": "why this matters" }
  ],
  "abnormalities": [
    { "finding": "what's abnormal", "severity": "mild|moderate|severe", "implication": "clinical meaning" }
  ],
  "comparisonNotes": "If prior values exist in the data, note interval changes",
  "suggestedActions": [
    { "action": "what to do", "urgency": "routine|soon|urgent", "rationale": "why" }
  ],
  "guidelineAlerts": [
    { "guideline": "name + year", "finding": "trigger", "recommendation": "what guideline says", "class": "I/IIa/IIb/III", "level": "A/B/C" }
  ],
  "differentialConsiderations": ["if findings suggest additional diagnoses to consider"],
  "billingCodes": [{ "code": "ICD-10", "description": "text" }],
  "smartFlags": []
}

For smartFlags, flag things like:
- Value changes from prior (e.g., "EF improved from 35% to 45%")
- Lab trends (e.g., "K+ was 3.2, now 3.8 — trending up")
- Missing monitoring (e.g., "On amiodarone — TSH not checked in data")
- Medication-lab mismatches
- Critical values that need immediate attention
Format each smartFlag as: { "flag": "description", "category": "improvement|decline|trend|monitoring_gap|critical|medication_interaction", "priority": "info|warning|critical" }`;
        
        // Interpreter doesn't need images — just the extracted text
        // But we still use the image-capable call in case interpreter wants to reference the original
        const interpreterResult = await callAIWithImages(images, interpreterSystemPrompt, interpreterUserPrompt, interpreterModel, interpreterSettings);
        
        let interpretation;
        try {
            interpretation = parseAIJson(interpreterResult.text);
        } catch (e) {
            console.error(`[${new Date().toISOString()}] Interpreter JSON parse error:`, e.message);
            interpretation = { clinicalSummary: interpreterResult.text, parseError: true };
        }
        
        console.log(`[${new Date().toISOString()}] Interpreter complete: ${interpreterResult.timing.seconds}s, ${interpreterResult.cost.formatted}`);
        
        // ===== Combine results =====
        const totalCost = (readerResult.cost.total || 0) + (interpreterResult.cost.total || 0);
        const totalTime = (readerResult.timing.ms || 0) + (interpreterResult.timing.ms || 0);
        
        const result = {
            sessionId,
            mode,
            documentType: detectedType,
            extractedData,
            interpretation,
            reader: {
                model: readerResult.model,
                modelLabel: COST_TABLE[readerModel]?.name || readerModel,
                timing: readerResult.timing,
                usage: readerResult.usage,
                cost: readerResult.cost
            },
            interpreter: {
                model: interpreterResult.model,
                modelLabel: COST_TABLE[interpreterModel]?.name || interpreterModel,
                timing: interpreterResult.timing,
                usage: interpreterResult.usage,
                cost: interpreterResult.cost
            },
            totals: {
                cost: { total: totalCost, formatted: `$${totalCost.toFixed(4)}` },
                timing: { ms: totalTime, seconds: (totalTime / 1000).toFixed(1) }
            }
        };
        
        // Save session to DB
        if (process.env.DATABASE_URL) {
            try {
                await pool.query(`
                    INSERT INTO image_sessions (session_id, storage_code, mode, images, reader_model, reader_settings, interpreter_model, interpreter_settings, extracted_data, interpretation, suggestions, cost, timing, status)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'complete')
                `, [
                    sessionId, storageCode || 'default', mode,
                    JSON.stringify(images.map(i => ({ mediaType: i.mediaType, size: i.base64?.length || 0 }))), // Don't store full base64
                    readerModel, JSON.stringify(readerSettings),
                    interpreterModel, JSON.stringify(interpreterSettings),
                    JSON.stringify(extractedData), JSON.stringify(interpretation),
                    JSON.stringify(interpretation.smartFlags || []),
                    JSON.stringify(result.totals.cost), JSON.stringify(result.totals.timing)
                ]);
            } catch (dbErr) {
                console.error('Failed to save image session:', dbErr.message);
            }
        }
        
        res.json(result);
        
    } catch (err) {
        console.error(`[${new Date().toISOString()}] CardioScan error:`, err.message);
        res.status(500).json({ error: 'Image analysis failed', message: err.message, sessionId });
    }
});

// ============ ENDPOINT: Reader-Only (just extract, no interpretation) ============
app.post('/api/image-analyze/read', async (req, res) => {
    const { images, readerModel = 'claude-sonnet', readerSettings = {}, documentType, mode } = req.body;
    
    if (!images || !images.length) {
        return res.status(400).json({ error: 'No images provided' });
    }
    
    // Log image sizes for debugging
    const imageSizes = images.map((img, i) => `img${i}: ${img.base64 ? Math.round(img.base64.length / 1024) + 'KB' : 'NO_DATA'}`).join(', ');
    console.log(`[${new Date().toISOString()}] CardioScan READ: ${images.length} image(s), model=${readerModel}, mode=${mode || 'clinic'}, sizes=[${imageSizes}]`);
    
    try {
        let systemPrompt, userPrompt;
        
        if (mode === 'rounding' && !documentType) {
            // Rounding-specific extraction prompt — only when no explicit doc type chosen
            // If user explicitly chose patient_list, lab_results, etc. use the specific extractor instead
            systemPrompt = `You are an expert medical document reader preparing data for hospital rounding. You may receive MULTIPLE images from the same patient — these could include a patient list, lab results, vitals, prior notes, and imaging reports. Extract ALL data from ALL images into a single comprehensive JSON. Return ONLY valid JSON, no markdown.`;
            
            userPrompt = `These are images from a patient's chart for morning rounds. Extract everything into this structure:

{
  "documentType": "rounding_bundle",
  "patientInfo": { "name": null, "mrn": null, "room": null, "age": null, "sex": null, "admitDate": null, "admitDx": null },
  "documents": [
    {
      "imageIndex": 0,
      "documentType": "lab_results|vitals|clinic_note|echo|patient_list|etc",
      "extractedData": {}
    }
  ],
  "aggregatedLabs": [{ "test": null, "values": [{ "value": null, "timestamp": null, "flag": null }] }],
  "currentVitals": { "bp": null, "hr": null, "rr": null, "temp": null, "spo2": null, "weight": null, "io": null },
  "currentMedications": [],
  "activeDiagnoses": [],
  "recentProcedures": [],
  "rawTexts": ["full text from each image"]
}`;
        } else {
            // Standard clinic read
            systemPrompt = `You are an expert medical document reader with board-certified cardiology knowledge. Extract ALL data with perfect accuracy. Never fabricate values. If something is unclear, note it as "unclear" rather than guessing. Return ONLY valid JSON, no markdown.`;
            
            if (documentType && DOC_TYPE_PROFILES[documentType]) {
                userPrompt = `This is a ${DOC_TYPE_PROFILES[documentType].label}.\n\n${DOC_TYPE_PROFILES[documentType].extractPrompt}`;
            } else {
                const typeList = Object.entries(DOC_TYPE_PROFILES).map(([k, v]) => `"${k}": ${v.label}`).join(', ');
                userPrompt = `First, identify what type of medical document this is from these options: ${typeList}.\n\nThen extract ALL data using the appropriate format below.\n\n${Object.entries(DOC_TYPE_PROFILES).map(([k, p]) => `If ${p.label}:\n${p.extractPrompt}`).join('\n\n')}\n\nIf the document doesn't match any type, extract whatever structured data you can and set documentType to "other".`;
            }
        }
        
        console.log(`[${new Date().toISOString()}] Calling ${readerModel} API for read...`);
        const result = await callAIWithImages(images, systemPrompt, userPrompt, readerModel, readerSettings);
        
        let extractedData;
        try {
            extractedData = parseAIJson(result.text);
        } catch (e) {
            console.error(`[${new Date().toISOString()}] Reader JSON parse error:`, e.message);
            console.error(`[${new Date().toISOString()}] Raw response (first 500):`, result.text?.substring(0, 500));
            extractedData = { documentType: 'unknown', rawText: result.text, parseError: true };
        }
        
        console.log(`[${new Date().toISOString()}] READ complete: type=${extractedData.documentType}, ${result.timing.seconds}s, ${result.cost.formatted}`);
        
        // Strip rawTexts from response to reduce payload (can be 200KB+)
        const responseData = { ...extractedData };
        if (responseData.rawTexts) {
            const totalLen = responseData.rawTexts.reduce((sum, t) => sum + (t?.length || 0), 0);
            console.log(`[${new Date().toISOString()}] Stripping rawTexts from response (${totalLen} chars, ${responseData.rawTexts.length} entries)`);
            responseData.rawTextsLength = totalLen;  // Keep the length for reference
            delete responseData.rawTexts;
        }
        if (responseData.rawText) {
            console.log(`[${new Date().toISOString()}] Stripping rawText from response (${responseData.rawText.length} chars)`);
            responseData.rawTextLength = responseData.rawText.length;
            delete responseData.rawText;
        }
        
        const responsePayload = {
            extractedData: responseData,
            model: result.model,
            modelLabel: COST_TABLE[readerModel]?.name || readerModel,
            timing: result.timing,
            usage: result.usage,
            cost: result.cost
        };
        const payloadSize = JSON.stringify(responsePayload).length;
        console.log(`[${new Date().toISOString()}] Response payload: ${(payloadSize / 1024).toFixed(1)}KB`);
        
        res.json(responsePayload);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] CardioScan READ error:`, err.message);
        console.error(err.stack);
        res.status(500).json({ error: 'Read failed', message: err.message });
    }
});

// ============ ENDPOINT: Interpret-Only (from previously extracted data) ============
app.post('/api/image-analyze/interpret', async (req, res) => {
    const { extractedData, interpreterModel = 'claude-sonnet', interpreterSettings = {}, images, mode, patientContext, interpretMode } = req.body;
    
    if (!extractedData) {
        return res.status(400).json({ error: 'No extracted data provided' });
    }
    
    console.log(`[${new Date().toISOString()}] CardioScan interpret: model=${interpreterModel}, type=${extractedData.documentType}, mode=${mode || 'clinic'}, interpretMode=${interpretMode || 'full'}`);
    
    try {
        let systemPrompt, userPrompt;
        const detectedType = extractedData.documentType || 'unknown';
        
        if (interpretMode === 'significant_only') {
            // Quick significant findings only — shorter, cheaper
            systemPrompt = `You are a board-certified cardiologist. Provide ONLY the clinically significant findings — abnormals, things that need attention, and actionable items. Be brief and direct. Skip normal findings. Return ONLY valid JSON, no markdown.`;
            
            userPrompt = `Review this ${DOC_TYPE_PROFILES[detectedType]?.label || 'medical data'} and list ONLY significant/abnormal findings:

${JSON.stringify(extractedData, null, 2)}

Return concise JSON:
{
  "clinicalSummary": "1-2 sentence bottom line",
  "keyFindings": [
    { "finding": "only abnormal/significant items", "significance": "abnormal|critical", "clinicalContext": "brief why it matters" }
  ],
  "abnormalities": [
    { "finding": "what's abnormal", "severity": "mild|moderate|severe", "implication": "clinical meaning" }
  ],
  "suggestedActions": [
    { "action": "what to do about it", "urgency": "routine|soon|urgent", "rationale": "brief why" }
  ],
  "smartFlags": [
    { "flag": "brief alert", "category": "improvement|decline|trend|monitoring_gap|critical|medication_interaction", "priority": "info|warning|critical" }
  ],
  "billingCodes": [{ "code": "ICD-10", "description": "text" }]
}

IMPORTANT: Skip anything normal. Only flag what a cardiologist NEEDS to see. Be concise.`;

        } else if (mode === 'rounding') {
            // Rounding-specific interpretation
            systemPrompt = `You are a board-certified cardiologist preparing for morning rounds. Generate a structured rounding note with clinical intelligence. Think like an attending who needs to present this patient efficiently at rounds while not missing anything important. Return ONLY valid JSON, no markdown.`;
            
            userPrompt = `Based on this extracted patient data, generate a rounding note structure:

${JSON.stringify(extractedData, null, 2)}
${patientContext ? `\nAdditional context: ${JSON.stringify(patientContext)}` : ''}

Return JSON:
{
  "roundingNote": {
    "oneLiner": "Concise 1-sentence patient summary for signout",
    "subjective": "Overnight events, symptoms, complaints",
    "overnight": "Key overnight vitals, events, nursing notes",
    "labsTrending": [
      { "lab": "test name", "current": "value", "prior": "value", "trend": "up|down|stable", "flag": "normal|watch|critical", "comment": "clinical context" }
    ],
    "vitalsTrending": {
      "summary": "Hemodynamically stable/unstable, etc.",
      "concerns": []
    },
    "assessment": "Brief clinical assessment",
    "planByProblem": [
      { "problem": "diagnosis/issue", "status": "active|improving|resolved", "todaysPlan": ["specific action items"], "pendingItems": [] }
    ],
    "dispositionThoughts": "Approaching discharge? Barriers? Estimated LOS?"
  },
  "smartFlags": [
    { "flag": "description", "category": "improvement|decline|trend|monitoring_gap|critical|medication_interaction|discharge_barrier", "priority": "info|warning|critical" }
  ],
  "intervalChanges": [
    { "parameter": "what changed", "from": "prior value", "to": "current value", "significance": "explanation" }
  ],
  "suggestedFollowUp": ["things to check/order/address today"],
  "guidelineAlerts": [],
  "clinicalSummary": "2-3 sentence clinical summary",
  "keyFindings": [{ "finding": "description", "significance": "normal|abnormal|critical", "clinicalContext": "why" }],
  "abnormalities": [{ "finding": "what", "severity": "mild|moderate|severe", "implication": "meaning" }],
  "suggestedActions": [{ "action": "what", "urgency": "routine|soon|urgent", "rationale": "why" }],
  "billingCodes": [{ "code": "ICD-10", "description": "text" }]
}`;
        } else {
            // Standard clinic interpretation
            systemPrompt = `You are a board-certified cardiologist providing clinical interpretation. Be specific, evidence-based, actionable. Return ONLY valid JSON, no markdown.`;
            
            userPrompt = `Interpret this ${DOC_TYPE_PROFILES[detectedType]?.label || 'medical data'}:

${JSON.stringify(extractedData, null, 2)}

Return JSON with: clinicalSummary, keyFindings[], abnormalities[], comparisonNotes, suggestedActions[], guidelineAlerts[], differentialConsiderations[], billingCodes[], smartFlags[]

For smartFlags, flag things like:
- Value changes from prior (e.g., "EF improved from 35% to 45%")
- Lab trends (e.g., "K+ was 3.2, now 3.8 — trending up")
- Missing monitoring (e.g., "On amiodarone — TSH not checked in data")
- Medication-lab mismatches
- Critical values that need immediate attention
Format each smartFlag as: { "flag": "description", "category": "improvement|decline|trend|monitoring_gap|critical|medication_interaction", "priority": "info|warning|critical" }`;
        }
        
        let result;
        if (images && images.length > 0) {
            result = await callAIWithImages(images, systemPrompt, userPrompt, interpreterModel, interpreterSettings);
        } else {
            // Text-only interpretation (no images needed — FAST)
            if (interpreterModel === 'gpt-5.2') {
                result = await callGPTWithImages([], systemPrompt, userPrompt, interpreterSettings);
            } else {
                // Use Claude messages API without images
                const startTime = Date.now();
                const modelMap = { 'claude-opus': 'claude-opus-4-20250514', 'claude-sonnet': 'claude-sonnet-4-20250514' };
                const apiOpts = {
                    model: modelMap[interpreterModel] || modelMap['claude-sonnet'],
                    max_tokens: 8192,
                    system: systemPrompt,
                    messages: [{ role: "user", content: userPrompt }]
                };
                if (interpreterSettings.thinkingBudget && interpreterSettings.thinkingBudget > 0) {
                    apiOpts.thinking = { type: "enabled", budget_tokens: interpreterSettings.thinkingBudget };
                    apiOpts.max_tokens = interpreterSettings.thinkingBudget + 8192;
                }
                const msg = await anthropic.messages.create(apiOpts);
                const text = msg.content.find(b => b.type === 'text')?.text || '';
                const elapsed = Date.now() - startTime;
                const u = msg.usage || {};
                const pricing = COST_TABLE[interpreterModel] || COST_TABLE['claude-sonnet'];
                const cost = ((u.input_tokens || 0) / 1_000_000 * pricing.input) + ((u.output_tokens || 0) / 1_000_000 * pricing.output);
                result = {
                    text,
                    model: modelMap[interpreterModel],
                    timing: { ms: elapsed, seconds: (elapsed / 1000).toFixed(1) },
                    usage: { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 },
                    cost: { total: cost, formatted: `$${cost.toFixed(4)}` }
                };
            }
        }
        
        let interpretation;
        try {
            interpretation = parseAIJson(result.text);
        } catch (e) {
            console.error(`[${new Date().toISOString()}] Interpret JSON parse error:`, e.message);
            console.error(`[${new Date().toISOString()}] Raw response (first 300):`, result.text?.substring(0, 300));
            interpretation = { clinicalSummary: result.text, parseError: true };
        }
        
        console.log(`[${new Date().toISOString()}] Interpret complete: ${result.timing.seconds}s, ${result.cost.formatted}`);
        
        res.json({
            interpretation,
            model: result.model,
            modelLabel: COST_TABLE[interpreterModel]?.name || interpreterModel,
            timing: result.timing,
            usage: result.usage,
            cost: result.cost
        });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] CardioScan interpret error:`, err.message);
        console.error(err.stack);
        res.status(500).json({ error: 'Interpretation failed', message: err.message });
    }
});

// ============ ENDPOINT: Rounding Mode — Multi-image patient context ============
app.post('/api/image-analyze/rounding', async (req, res) => {
    const {
        images,
        readerModel = 'claude-sonnet',
        readerSettings = {},
        interpreterModel = 'claude-sonnet',
        interpreterSettings = {},
        storageCode,
        patientContext // optional: { name, room, admitDate, etc. }
    } = req.body;
    
    if (!images || !images.length) {
        return res.status(400).json({ error: 'No images provided' });
    }
    
    const sessionId = `rd_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    console.log(`[${new Date().toISOString()}] CardioScan ROUNDING session ${sessionId}: ${images.length} image(s)`);
    
    try {
        // ===== STEP 1: Extract ALL images at once (reader sees full context) =====
        const readerSystemPrompt = `You are an expert medical document reader preparing data for hospital rounding. You may receive MULTIPLE images from the same patient — these could include a patient list, lab results, vitals, prior notes, and imaging reports. Extract ALL data from ALL images into a single comprehensive JSON. Return ONLY valid JSON.`;
        
        const readerUserPrompt = `These are images from a patient's chart for morning rounds. Extract everything into this structure:

{
  "patientInfo": { "name": null, "mrn": null, "room": null, "age": null, "sex": null, "admitDate": null, "admitDx": null },
  "documents": [
    {
      "imageIndex": 0,
      "documentType": "lab_results|vitals|clinic_note|echo|patient_list|etc",
      "extractedData": { ... }
    }
  ],
  "aggregatedLabs": [{ "test": null, "values": [{ "value": null, "timestamp": null, "flag": null }] }],
  "currentVitals": { "bp": null, "hr": null, "rr": null, "temp": null, "spo2": null, "weight": null, "io": null },
  "currentMedications": [],
  "activeDiagnoses": [],
  "recentProcedures": [],
  "rawTexts": ["full text from each image"]
}`;
        
        const readerResult = await callAIWithImages(images, readerSystemPrompt, readerUserPrompt, readerModel, readerSettings);
        
        let extractedData;
        try {
            extractedData = parseAIJson(readerResult.text);
        } catch (e) {
            extractedData = { rawTexts: [readerResult.text], parseError: true };
        }
        
        // ===== STEP 2: Generate rounding note structure =====
        const interpreterSystemPrompt = `You are a board-certified cardiologist preparing for morning rounds. Generate a structured rounding note with clinical intelligence. Think like an attending who needs to present this patient efficiently at rounds while not missing anything important. Return ONLY valid JSON.`;
        
        const interpreterUserPrompt = `Based on this extracted patient data, generate a rounding note structure:

${JSON.stringify(extractedData, null, 2)}
${patientContext ? `\nAdditional context: ${JSON.stringify(patientContext)}` : ''}

Return JSON:
{
  "roundingNote": {
    "oneLiner": "Concise 1-sentence patient summary for signout",
    "subjective": "Overnight events, symptoms, complaints",
    "overnight": "Key overnight vitals, events, nursing notes",
    "labsTrending": [
      { "lab": "test name", "current": "value", "prior": "value", "trend": "up|down|stable", "flag": "normal|watch|critical", "comment": "clinical context" }
    ],
    "vitalsTrending": {
      "summary": "Hemodynamically stable/unstable, etc.",
      "concerns": []
    },
    "assessment": "Brief clinical assessment",
    "planByProblem": [
      { "problem": "diagnosis/issue", "status": "active|improving|resolved", "todaysPlan": ["specific action items"], "pendingItems": [] }
    ],
    "dispositionThoughts": "Approaching discharge? Barriers? Estimated LOS?"
  },
  "smartFlags": [
    { "flag": "description", "category": "improvement|decline|trend|monitoring_gap|critical|medication_interaction|discharge_barrier", "priority": "info|warning|critical" }
  ],
  "intervalChanges": [
    { "parameter": "what changed", "from": "prior value", "to": "current value", "significance": "explanation" }
  ],
  "suggestedFollowUp": ["things to check/order/address today"],
  "guidelineAlerts": []
}`;
        
        const interpreterResult = await callAIWithImages(images, interpreterSystemPrompt, interpreterUserPrompt, interpreterModel, interpreterSettings);
        
        let roundingData;
        try {
            roundingData = parseAIJson(interpreterResult.text);
        } catch (e) {
            roundingData = { roundingNote: { oneLiner: interpreterResult.text }, parseError: true };
        }
        
        const totalCost = (readerResult.cost.total || 0) + (interpreterResult.cost.total || 0);
        const totalTime = (readerResult.timing.ms || 0) + (interpreterResult.timing.ms || 0);
        
        const result = {
            sessionId,
            mode: 'rounding',
            patientInfo: extractedData.patientInfo || patientContext || {},
            extractedData,
            roundingData,
            reader: { model: readerResult.model, modelLabel: COST_TABLE[readerModel]?.name || readerModel, timing: readerResult.timing, usage: readerResult.usage, cost: readerResult.cost },
            interpreter: { model: interpreterResult.model, modelLabel: COST_TABLE[interpreterModel]?.name || interpreterModel, timing: interpreterResult.timing, usage: interpreterResult.usage, cost: interpreterResult.cost },
            totals: { cost: { total: totalCost, formatted: `$${totalCost.toFixed(4)}` }, timing: { ms: totalTime, seconds: (totalTime / 1000).toFixed(1) } }
        };
        
        // Save to DB
        if (process.env.DATABASE_URL) {
            try {
                await pool.query(`
                    INSERT INTO image_sessions (session_id, storage_code, mode, images, reader_model, reader_settings, interpreter_model, interpreter_settings, extracted_data, interpretation, suggestions, cost, timing, status)
                    VALUES ($1, $2, 'rounding', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'complete')
                `, [
                    sessionId, storageCode || 'default',
                    JSON.stringify(images.map(i => ({ mediaType: i.mediaType, size: i.base64?.length || 0 }))),
                    readerModel, JSON.stringify(readerSettings),
                    interpreterModel, JSON.stringify(interpreterSettings),
                    JSON.stringify(extractedData), JSON.stringify(roundingData),
                    JSON.stringify(roundingData.smartFlags || []),
                    JSON.stringify(result.totals.cost), JSON.stringify(result.totals.timing)
                ]);
            } catch (dbErr) {
                console.error('Failed to save rounding session:', dbErr.message);
            }
        }
        
        res.json(result);
        
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Rounding error:`, err.message);
        res.status(500).json({ error: 'Rounding analysis failed', message: err.message, sessionId });
    }
});

// ============ ENDPOINT: Get session history ============
app.get('/api/image-analyze/sessions/:code', async (req, res) => {
    const { code } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    
    try {
        if (process.env.DATABASE_URL) {
            const result = await pool.query(
                `SELECT session_id, mode, reader_model, interpreter_model, 
                        extracted_data->'documentType' as doc_type,
                        cost, timing, status, created_at 
                 FROM image_sessions WHERE storage_code = $1 
                 ORDER BY created_at DESC LIMIT $2`,
                [code, limit]
            );
            res.json({ sessions: result.rows });
        } else {
            res.json({ sessions: [] });
        }
    } catch (e) {
        console.error('Session history error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ============ ENDPOINT: Get single session detail ============
app.get('/api/image-analyze/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    try {
        if (process.env.DATABASE_URL) {
            const result = await pool.query(
                'SELECT * FROM image_sessions WHERE session_id = $1',
                [sessionId]
            );
            if (result.rows.length > 0) {
                res.json({ session: result.rows[0] });
            } else {
                res.status(404).json({ error: 'Session not found' });
            }
        } else {
            res.status(404).json({ error: 'Database not configured' });
        }
    } catch (e) {
        console.error('Session detail error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ============ ENDPOINT: Compare models (run same image through multiple combos) ============
app.post('/api/image-analyze/compare', async (req, res) => {
    const { images, permutations, documentType } = req.body;
    // permutations: [{ readerModel, readerSettings, interpreterModel, interpreterSettings, label }]
    
    if (!images || !images.length || !permutations || !permutations.length) {
        return res.status(400).json({ error: 'Need images and permutations' });
    }
    
    console.log(`[${new Date().toISOString()}] CardioScan COMPARE: ${permutations.length} permutation(s), ${images.length} image(s)`);
    
    const results = [];
    
    for (const perm of permutations) {
        try {
            const startTime = Date.now();
            
            // Reader
            const readerSys = `You are an expert medical document reader. Extract ALL data with perfect accuracy. Return ONLY valid JSON.`;
            let readerUser;
            if (documentType && DOC_TYPE_PROFILES[documentType]) {
                readerUser = `This is a ${DOC_TYPE_PROFILES[documentType].label}.\n\n${DOC_TYPE_PROFILES[documentType].extractPrompt}`;
            } else {
                readerUser = `Identify and extract this medical document. Return structured JSON with documentType field.\n\n${Object.entries(DOC_TYPE_PROFILES).map(([k, p]) => `If ${p.label}: ${p.extractPrompt}`).join('\n\n')}`;
            }
            
            const readerResult = await callAIWithImages(images, readerSys, readerUser, perm.readerModel || 'claude-sonnet', perm.readerSettings || {});
            let extractedData;
            try { extractedData = parseAIJson(readerResult.text); } catch (e) { extractedData = { rawText: readerResult.text, parseError: true }; }
            
            // Interpreter
            const interpSys = `You are a board-certified cardiologist. Provide clinical interpretation. Return ONLY valid JSON.`;
            const interpUser = `Interpret: ${JSON.stringify(extractedData, null, 2)}\n\nReturn: clinicalSummary, keyFindings[], abnormalities[], suggestedActions[], smartFlags[]`;
            
            const interpResult = await callAIWithImages(images, interpSys, interpUser, perm.interpreterModel || 'claude-sonnet', perm.interpreterSettings || {});
            let interpretation;
            try { interpretation = parseAIJson(interpResult.text); } catch (e) { interpretation = { clinicalSummary: interpResult.text, parseError: true }; }
            
            const totalCost = (readerResult.cost.total || 0) + (interpResult.cost.total || 0);
            const totalTime = Date.now() - startTime;
            
            results.push({
                label: perm.label || `${perm.readerModel} → ${perm.interpreterModel}`,
                readerModel: perm.readerModel,
                interpreterModel: perm.interpreterModel,
                extractedData,
                interpretation,
                readerCost: readerResult.cost,
                readerTiming: readerResult.timing,
                interpreterCost: interpResult.cost,
                interpreterTiming: interpResult.timing,
                totalCost: { total: totalCost, formatted: `$${totalCost.toFixed(4)}` },
                totalTiming: { ms: totalTime, seconds: (totalTime / 1000).toFixed(1) },
                readerUsage: readerResult.usage,
                interpreterUsage: interpResult.usage
            });
            
        } catch (err) {
            results.push({
                label: perm.label || `${perm.readerModel} → ${perm.interpreterModel}`,
                error: err.message
            });
        }
    }
    
    res.json({ comparisons: results, imageCount: images.length });
});

// ============ ENDPOINT: Supported document types ============
app.get('/api/image-analyze/doc-types', (req, res) => {
    const types = Object.entries(DOC_TYPE_PROFILES).map(([key, val]) => ({
        key,
        label: val.label
    }));
    res.json({ types, models: Object.entries(COST_TABLE).map(([k, v]) => ({ key: k, name: v.name, inputCostPer1M: v.input, outputCostPer1M: v.output })) });
});

// ============ END CARDIOSCAN ENDPOINTS ============

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

const server = app.listen(PORT, () => {
    console.log(`Clipboard Sync server running on http://localhost:${PORT}`);
});

// Increase Node.js server timeouts for long-running AI requests
server.keepAliveTimeout = 300000;  // 5 minutes
server.headersTimeout = 310000;    // slightly more than keepAlive
server.timeout = 300000;           // 5 minutes overall request timeout
