const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Anthropic client (uses ANTHROPIC_API_KEY env var)
const anthropic = new Anthropic();

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

// ============ MEDICAL VALIDATION API (Claude) ============

app.post('/api/validate', async (req, res) => {
    const { text, templateCode, model, depth, includeSuggestions, ignoreSpelling, ignorePunctuation, userProfile } = req.body;
    
    if (!text) {
        return res.status(400).json({ error: 'Missing text' });
    }
    
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
    
    console.log(`[${new Date().toISOString()}] Validating ${text.length} chars with ${selectedModel}, depth: ${depth || 'quick'}, thinking: ${thinkingBudget}, suggestions: ${includeSuggestions || false}, profile: ${userProfile ? 'yes' : 'no'}`);
    
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
                content: `You are an expert medical transcription reviewer with deep knowledge of cardiology, internal medicine, and clinical documentation. Analyze this dictation thoroughly.
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

## RESPONSE FORMAT:

For EACH issue, you MUST provide:
- "original": The exact problematic text from the dictation (so it can be found and replaced)
- "suggested": The corrected text to replace it with
- "explanation": Why this is an issue

Return JSON only (no markdown, no backticks):
{
  "issues": [
    {
      "type": "clinical_value",
      "severity": "error",
      "original": "Normal ejection fraction of 15%",
      "suggested": "Severely reduced ejection fraction of 15%",
      "explanation": "15% EF is severely reduced (normal is 55-70%), not normal. Verify if 15% is correct or if it should be 50-55%."
    },
    {
      "type": "transcription",
      "severity": "warning",
      "original": "history of dye-a-beat-ease",
      "suggested": "history of diabetes",
      "explanation": "Likely speech-to-text error for 'diabetes'"
    }
  ],
  "abbreviations": [
    {"abbrev": "EF", "full": "Ejection Fraction"},
    {"abbrev": "SOB", "full": "Shortness of Breath"}
  ],
  "icd10": [
    {"code": "I50.9", "description": "Heart failure, unspecified"},
    {"code": "I10", "description": "Essential (primary) hypertension"}
  ],
  "suggestions": ${includeSuggestions ? `{
    "diagnoses": ["Possible differential diagnoses to consider"],
    "diagnosticTests": ["Recommended tests to confirm or rule out conditions"],
    "therapeutics": ["Treatment considerations based on findings"]
  }` : 'null'},
  "summary": "Brief 1-line summary"
}

Severity levels: "error" (critical/dangerous), "warning" (should review), "info" (minor/suggestion)

IMPORTANT: The "original" field must contain the EXACT text from the dictation so it can be found and replaced. If you cannot find exact text to replace, set original to null.

If no issues: {"issues": [], "abbreviations": [...], "icd10": [...], "suggestions": null, "summary": "No issues found"}
${includeSuggestions ? `
## CLINICAL SUGGESTIONS REQUESTED:
The user has requested clinical suggestions. Please include in your response:
- **Diagnosis conclusions**: Based on the clinical picture, what diagnoses are supported or should be considered?
- **Diagnostic tests**: What additional tests might help confirm, rule out, or further evaluate the conditions mentioned?
- **Therapeutic suggestions**: Based on the findings and likely diagnoses, what treatment approaches should be considered?

Keep suggestions evidence-based, relevant to the specific case, and appropriately cautious. These are meant as decision support, not definitive recommendations.
` : ''}${ignoreSpelling ? `
## IGNORE SPELLING:
Do NOT flag spelling errors or typos. Focus only on medical/clinical issues, not spelling mistakes.
` : ''}${ignorePunctuation ? `
## IGNORE PUNCTUATION:
Do NOT flag punctuation issues (missing periods, commas, capitalization, etc). Focus only on medical/clinical content.
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
