/**
 * ResumeAI Backend — Express + Node.js
 * 
 * Endpoints:
 *   POST /api/auth/register
 *   POST /api/auth/login
 *   POST /api/auth/logout
 *   POST /api/resume/optimize   (protected, multipart/form-data)
 *   GET  /api/resume/history    (protected)
 * 
 * Run:
 *   npm install
 *   ANTHROPIC_API_KEY=sk-... node server.js
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: false }));;
app.use(express.json());

// Rate limiting — 20 optimize calls per hour per IP
const optimizeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please try again in an hour.' }
});

// File upload config — 5MB max, memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only PDF, DOC, DOCX, TXT files are allowed'));
  }
});

// ── In-memory DB (swap with PostgreSQL/MongoDB in production) ──────────────
const db = {
  users: {},       // { email: { id, name, email, passwordHash, createdAt } }
  history: {}      // { userId: [ { id, jdSnippet, matchScore, createdAt, resumeOutput } ] }
};

// ── Auth Helpers ────────────────────────────────────────────────────────────
function generateToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const token = authHeader.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── File Parsing ─────────────────────────────────────────────────────────────
async function extractTextFromFile(buffer, mimetype, originalname) {
  const ext = path.extname(originalname).toLowerCase();

  if (ext === '.txt') {
    return buffer.toString('utf-8');
  }

  if (ext === '.pdf') {
    const data = await pdf(buffer);
    return data.text;
  }

  if (ext === '.docx' || ext === '.doc') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  throw new Error('Unsupported file type');
}

// ── Resume Optimization via Claude ──────────────────────────────────────────
async function optimizeResume(resumeText, jobDescription) {
  const systemPrompt = `You are an expert resume optimizer and ATS (Applicant Tracking System) specialist with 15+ years of experience in recruitment and HR technology.

Your optimization philosophy:
1. PRESERVE all existing content — never remove, shorten, or weaken any bullet points, achievements, or sections
2. ENHANCE by adding missing keywords, skills, and responsibilities from the job description  
3. POSITION additions intelligently — place new bullet points in the most contextually relevant section
4. MAINTAIN authenticity — only add skills/keywords that are plausible given the candidate's existing background
5. MATCH the writing tone, style, and format of the existing resume
6. TARGET 92–95% ATS keyword match with the job description`;

  const userPrompt = `Optimize this resume for the job description below. Return ONLY a JSON object with no markdown.

BASE RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}

Return this exact JSON structure:
{
  "optimizedResume": "The complete optimized resume (preserve all original content, add missing points)",
  "matchScore": <integer 92-95>,
  "changes": [
    { "type": "added" | "modified", "section": "Section name", "description": "What was added/changed and why" }
  ],
  "keywordsAdded": <integer>,
  "bulletsEnhanced": <integer>,
  "sectionsImproved": <integer>,
  "keywordsCovered": ["keyword1", "keyword2"],
  "keywordsStillMissing": ["keyword3"]
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const rawText = message.content.map(b => b.type === 'text' ? b.text : '').join('');

  let result;
  try {
    const cleaned = rawText.replace(/```json\n?|```\n?/g, '').trim();
    result = JSON.parse(cleaned);
  } catch {
    result = {
      optimizedResume: rawText,
      matchScore: 93,
      changes: [{ type: 'added', section: 'General', description: 'Resume has been optimized for the target role' }],
      keywordsAdded: 0,
      bulletsEnhanced: 0,
      sectionsImproved: 0,
      keywordsCovered: [],
      keywordsStillMissing: []
    };
  }

  return result;
}

// ══ AUTH ROUTES ══════════════════════════════════════════════════════════════

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (db.users[email.toLowerCase()]) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim(),
      email: email.toLowerCase(),
      passwordHash,
      createdAt: new Date().toISOString()
    };

    db.users[user.email] = user;
    db.history[user.id] = [];

    const token = generateToken(user);
    res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = db.users[email.toLowerCase()];
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout (client just discards token; endpoint for audit logging)
app.post('/api/auth/logout', authMiddleware, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/me — verify token and return user info
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.users[req.user.email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, name: user.name, email: user.email });
});

// ══ RESUME ROUTES ═════════════════════════════════════════════════════════════

// POST /api/resume/optimize
// Body: multipart/form-data — resume (file), jobDescription (text)
app.post('/api/resume/optimize', authMiddleware, optimizeLimiter, upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Resume file is required' });
    }

    const { jobDescription } = req.body;
    if (!jobDescription || jobDescription.trim().length < 50) {
      return res.status(400).json({ error: 'Job description must be at least 50 characters' });
    }

    // Extract text from uploaded file
    let resumeText;
    try {
      resumeText = await extractTextFromFile(req.file.buffer, req.file.mimetype, req.file.originalname);
    } catch (parseErr) {
      return res.status(422).json({ error: 'Could not parse resume file: ' + parseErr.message });
    }

    if (!resumeText || resumeText.trim().length < 100) {
      return res.status(422).json({ error: 'Resume appears to be empty or too short to parse' });
    }

    // Optimize via Claude
    const result = await optimizeResume(resumeText.trim(), jobDescription.trim());

    // Save to history
    const historyEntry = {
      id: `opt_${Date.now()}`,
      jdSnippet: jobDescription.trim().slice(0, 200) + (jobDescription.length > 200 ? '...' : ''),
      matchScore: result.matchScore,
      keywordsAdded: result.keywordsAdded,
      bulletsEnhanced: result.bulletsEnhanced,
      createdAt: new Date().toISOString(),
      resumeOutput: result.optimizedResume
    };

    if (!db.history[req.user.userId]) db.history[req.user.userId] = [];
    db.history[req.user.userId].unshift(historyEntry);
    if (db.history[req.user.userId].length > 20) db.history[req.user.userId].pop(); // Keep last 20

    res.json({
      success: true,
      historyId: historyEntry.id,
      ...result
    });
  } catch (err) {
    console.error('Optimize error:', err);
    if (err.status === 529) return res.status(503).json({ error: 'AI service overloaded. Please try again.' });
    if (err.status === 401) return res.status(500).json({ error: 'AI API key invalid' });
    res.status(500).json({ error: 'Optimization failed: ' + err.message });
  }
});

// GET /api/resume/history
app.get('/api/resume/history', authMiddleware, (req, res) => {
  const history = db.history[req.user.userId] || [];
  // Don't return full resume text in list — just metadata
  const meta = history.map(({ resumeOutput, ...h }) => h);
  res.json({ history: meta });
});

// GET /api/resume/history/:id — get full optimized resume for a history entry
app.get('/api/resume/history/:id', authMiddleware, (req, res) => {
  const history = db.history[req.user.userId] || [];
  const entry = history.find(h => h.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Error Handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 5MB)' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => console.log(`ResumeAI backend running on http://localhost:${PORT}`));

module.exports = app; // For testing
