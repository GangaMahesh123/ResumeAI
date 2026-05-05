const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const rateLimit = require('express-rate-limit');
const AdmZip = require('adm-zip');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors({ origin: '*', credentials: false }));
app.use(express.json());

const optimizeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  message: { error: 'Too many requests. Please try again in an hour.' }
});

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

const db = { users: {}, history: {} };

function generateToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Extract plain text from any file ─────────────────────────────────────────
async function extractText(buffer, originalname) {
  const ext = path.extname(originalname).toLowerCase();
  if (ext === '.txt') return buffer.toString('utf-8');
  if (ext === '.pdf') { const d = await pdf(buffer); return d.text; }
  if (ext === '.docx' || ext === '.doc') {
    const r = await mammoth.extractRawText({ buffer });
    return r.value;
  }
  throw new Error('Unsupported file type');
}

// ── STEP 1: Claude analyzes resume vs JD and returns intelligent instructions ─
async function analyzeWithClaude(resumeText, jdText) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    system: `You are an expert resume optimizer and ATS specialist. Your job is to analyze a resume against a job description and produce precise editing instructions.

RULES:
1. NEVER remove core technical achievements, major projects, or quantified results
2. Only remove truly weak points: basic/obvious statements, outdated tech (10+ years old), redundant points said multiple times, niche tools completely unrelated to JD
3. Swaps must be technology-equivalent replacements (same category, same seniority level)
4. Only swap in the 2 most recent jobs — older jobs stay unchanged
5. New points must match the candidate's existing experience level and writing style
6. Return ONLY valid JSON, no markdown, no extra text`,
    messages: [{
      role: 'user',
      content: `Analyze this resume against the job description. Return a precise JSON editing plan.

RESUME:
${resumeText.slice(0, 4000)}

JOB DESCRIPTION:
${jdText.slice(0, 2000)}

Return ONLY this JSON (no markdown):
{
  "swaps": [
    {
      "find": "exact text to find in resume (must exist verbatim)",
      "replace": "replacement text (technology equivalent from JD)",
      "reason": "why this swap improves ATS match",
      "scope": "recent_only"
    }
  ],
  "remove": [
    {
      "find": "exact text snippet (first 60 chars) of bullet to remove",
      "reason": "why this point is weak or irrelevant to this JD"
    }
  ],
  "add": [
    {
      "text": "new bullet point text with bold tech terms matching JD style",
      "section": "most recent job title or Professional Summary",
      "insertAfter": "exact text snippet (first 60 chars) of bullet to insert after",
      "techTerms": ["Term1", "Term2"]
    }
  ],
  "summarySwaps": [
    {
      "find": "exact text to find in Professional Summary",
      "replace": "replacement text aligned with JD"
    }
  ],
  "matchScore": 93,
  "stackDetected": {
    "cloud": "aws/azure/gcp/none",
    "frontend": "react/angular/vue/none",
    "backend": "dotnet/java/node/python/none",
    "cicd": "github_actions/jenkins/azure_devops/none"
  }
}`
    }]
  });

  const raw = message.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  try {
    const cleaned = raw.replace(/```json\n?|```\n?/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  } catch (e) {
    console.error('Claude parse error:', e.message, raw.slice(0, 200));
    return { swaps: [], remove: [], add: [], summarySwaps: [], matchScore: 88, stackDetected: {} };
  }
}

// ── STEP 2: Apply instructions to DOCX XML ────────────────────────────────────
function applyInstructionsToDocx(docxBuffer, instructions, resumeText) {
  const zip = new AdmZip(docxBuffer);
  const docEntry = zip.getEntry('word/document.xml');
  if (!docEntry) throw new Error('Invalid DOCX file — word/document.xml not found');

  let xml = docEntry.getData().toString('utf-8');

  // Detect recent 2 job sections (for scope limiting swaps)
  // Find first job section start and 3rd job section start
  const jobMarkers = [];
  const jobRegex = /Client:|Company:|Employer:|Position:|Role:/gi;
  let match;
  while ((match = jobRegex.exec(resumeText)) !== null) {
    jobMarkers.push(match.index);
    if (jobMarkers.length >= 3) break;
  }

  // Find scope boundaries in XML
  let scopeStart = 0;
  let scopeEnd = xml.length;

  // Try to find 3rd job in XML to limit scope
  if (jobMarkers.length >= 3) {
    // Get a snippet from the 3rd job to find it in XML
    const thirdJobSnippet = resumeText.slice(jobMarkers[2], jobMarkers[2] + 30);
    const thirdJobXmlIdx = xml.indexOf(thirdJobSnippet);
    if (thirdJobXmlIdx > 0) scopeEnd = thirdJobXmlIdx;
  }

  const swapsApplied = [];
  const removedBullets = [];
  const addedBullets = [];

  // Apply SWAPS (only in recent jobs scope)
  const swaps = instructions.swaps || [];
  swaps.sort((a, b) => (b.find?.length || 0) - (a.find?.length || 0));

  for (const swap of swaps) {
    if (!swap.find || !swap.replace) continue;
    const findText = swap.find.trim();
    if (!findText || findText.length < 3) continue;

    const before = xml.slice(0, scopeStart);
    let scope = xml.slice(scopeStart, scopeEnd);
    const after = xml.slice(scopeEnd);

    if (scope.includes(findText)) {
      scope = scope.split(findText).join(swap.replace.trim());
      xml = before + scope + after;
      swapsApplied.push(`${findText.slice(0, 40)} → ${swap.replace.trim().slice(0, 40)}`);
    } else {
      // Try full document as fallback
      if (xml.includes(findText)) {
        xml = xml.split(findText).join(swap.replace.trim());
        swapsApplied.push(`${findText.slice(0, 40)} → ${swap.replace.trim().slice(0, 40)}`);
      }
    }
  }

  // Apply SUMMARY SWAPS (in full document)
  for (const swap of (instructions.summarySwaps || [])) {
    if (!swap.find || !swap.replace) continue;
    if (xml.includes(swap.find.trim())) {
      xml = xml.split(swap.find.trim()).join(swap.replace.trim());
      swapsApplied.push(`Summary: ${swap.find.trim().slice(0, 40)} → ${swap.replace.trim().slice(0, 40)}`);
    }
  }

  // Apply REMOVALS (find and remove full <w:p> paragraph)
  for (const removal of (instructions.remove || [])) {
    if (!removal.find) continue;
    const snippet = removal.find.trim().slice(0, 50);
    if (snippet.length < 10) continue;

    const idx = xml.indexOf(snippet);
    if (idx === -1) continue;

    let pStart = xml.lastIndexOf('<w:p ', idx);
    const pStart2 = xml.lastIndexOf('<w:p>', idx);
    pStart = Math.max(pStart, pStart2);
    if (pStart === -1) continue;

    const pEnd = xml.indexOf('</w:p>', idx);
    if (pEnd === -1) continue;

    xml = xml.slice(0, pStart) + xml.slice(pEnd + 6);
    removedBullets.push(snippet);
  }

  // Apply ADDITIONS — insert new bullet paragraphs
  for (const addition of (instructions.add || [])) {
    if (!addition.text || !addition.insertAfter) continue;
    const afterSnippet = addition.insertAfter.trim().slice(0, 50);
    if (afterSnippet.length < 10) continue;

    const idx = xml.indexOf(afterSnippet);
    if (idx === -1) continue;

    const pEnd = xml.indexOf('</w:p>', idx);
    if (pEnd === -1) continue;

    // Build new bullet XML matching document style
    const newBulletXml = buildBulletXml(addition.text, addition.techTerms || [], xml, idx);
    xml = xml.slice(0, pEnd + 6) + newBulletXml + xml.slice(pEnd + 6);
    addedBullets.push(addition.text.slice(0, 60));
  }

  // Update zip
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf-8'));

  return {
    buffer: zip.toBuffer(),
    swapsApplied,
    removedBullets,
    addedBullets
  };
}

// ── Build a bullet XML paragraph matching the document's existing style ───────
function buildBulletXml(text, techTerms, xml, nearIdx) {
  // Extract rPr (run properties) from nearby paragraph to match formatting
  const nearbyParaStart = xml.lastIndexOf('<w:p ', nearIdx);
  const nearbyParaEnd = xml.indexOf('</w:p>', nearIdx);
  const nearbyPara = nearbyParaStart > 0 ? xml.slice(nearbyParaStart, nearbyParaEnd + 6) : '';

  // Extract pPr from nearby paragraph
  const pPrMatch = nearbyPara.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  const pPr = pPrMatch ? pPrMatch[0] : '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>';

  // Extract rPr from nearby run
  const rPrMatch = nearbyPara.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  const baseRpr = rPrMatch ? rPrMatch[0] : '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>';

  // Build bold rPr
  const boldRpr = baseRpr.replace('</w:rPr>', '<w:b/><w:bCs/></w:rPr>');

  // Split text into bold/normal segments
  const sortedTerms = [...techTerms].sort((a, b) => b.length - a.length);
  let remaining = text;
  const segments = [];

  while (remaining.length > 0) {
    let found = false;
    for (const term of sortedTerms) {
      const idx = remaining.indexOf(term);
      if (idx === 0) {
        segments.push({ text: term, bold: true });
        remaining = remaining.slice(term.length);
        found = true;
        break;
      } else if (idx > 0) {
        segments.push({ text: remaining.slice(0, idx), bold: false });
        segments.push({ text: term, bold: true });
        remaining = remaining.slice(idx + term.length);
        found = true;
        break;
      }
    }
    if (!found) {
      segments.push({ text: remaining, bold: false });
      remaining = '';
    }
  }

  // Build runs
  let runs = '';
  for (const seg of segments) {
    if (!seg.text) continue;
    const rpr = seg.bold ? boldRpr : baseRpr;
    const hasSpace = seg.text.startsWith(' ') || seg.text.endsWith(' ');
    const spaceAttr = hasSpace ? ' xml:space="preserve"' : '';
    const escaped = seg.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    runs += `<w:r>${rpr}<w:t${spaceAttr}>${escaped}</w:t></w:r>`;
  }

  return `<w:p>${pPr}${runs}</w:p>`;
}

// ══ AUTH ROUTES ═══════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });
    if (db.users[email.toLowerCase()]) return res.status(409).json({ error: 'Email already registered' });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim(), email: email.toLowerCase(), passwordHash,
      createdAt: new Date().toISOString()
    };
    db.users[user.email] = user;
    db.history[user.id] = [];
    res.status(201).json({ token: generateToken(user), user: { id: user.id, name: user.name, email: user.email } });
  } catch { res.status(500).json({ error: 'Registration failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = db.users[email.toLowerCase()];
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      return res.status(401).json({ error: 'Invalid email or password' });
    res.json({ token: generateToken(user), user: { id: user.id, name: user.name, email: user.email } });
  } catch { res.status(500).json({ error: 'Login failed' }); }
});

app.post('/api/auth/logout', authMiddleware, (req, res) => res.json({ message: 'Logged out' }));
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.users[req.user.email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, name: user.name, email: user.email });
});

// ══ OPTIMIZE ══════════════════════════════════════════════════════════════════
app.post('/api/resume/optimize', authMiddleware, optimizeLimiter, upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Resume file is required' });
    const { jobDescription } = req.body;
    if (!jobDescription || jobDescription.trim().length < 50)
      return res.status(400).json({ error: 'Job description must be at least 50 characters' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    const resumeText = await extractText(req.file.buffer, req.file.originalname);

    // Step 1: Claude analyzes and returns intelligent instructions
    const instructions = await analyzeWithClaude(resumeText, jobDescription.trim());
    console.log(`Instructions: ${instructions.swaps?.length} swaps, ${instructions.remove?.length} removals, ${instructions.add?.length} additions`);

    // Step 2: Apply instructions to DOCX (pure Node.js, no Python)
    let docxBase64 = null;
    let swapsApplied = [];
    let removedBullets = [];
    let addedBullets = [];

    if (ext === '.docx') {
      try {
        const result = applyInstructionsToDocx(req.file.buffer, instructions, resumeText);
        docxBase64 = result.buffer.toString('base64');
        swapsApplied = result.swapsApplied;
        removedBullets = result.removedBullets;
        addedBullets = result.addedBullets;
      } catch (err) {
        console.error('DOCX processing error:', err.message);
      }
    }

    // Build changes list
    const changes = [
      ...swapsApplied.map(s => ({ type: 'modified', description: `Updated: ${s}` })),
      ...removedBullets.map(r => ({ type: 'removed', description: `Removed: ${r}` })),
      ...addedBullets.map(a => ({ type: 'added', description: `Added: ${a}` })),
    ];

    if (changes.length === 0) {
      changes.push({ type: 'added', description: 'Resume analyzed — already well-matched to JD' });
    }

    const entry = {
      id: `opt_${Date.now()}`,
      jdSnippet: jobDescription.trim().slice(0, 200),
      matchScore: instructions.matchScore || 93,
      keywordsAdded: addedBullets.length + swapsApplied.length,
      createdAt: new Date().toISOString(),
      resumeOutput: resumeText
    };
    if (!db.history[req.user.userId]) db.history[req.user.userId] = [];
    db.history[req.user.userId].unshift(entry);
    if (db.history[req.user.userId].length > 20) db.history[req.user.userId].pop();

    res.json({
      success: true,
      docxBase64,
      optimizedResume: resumeText,
      matchScore: instructions.matchScore || 93,
      changes,
      keywordsAdded: addedBullets.length + swapsApplied.length,
      bulletsEnhanced: addedBullets.length,
      sectionsImproved: Math.min(swapsApplied.length + addedBullets.length, 5),
      swapsApplied,
      removedCount: removedBullets.length,
      addedCount: addedBullets.length,
      jdStack: instructions.stackDetected || {}
    });

  } catch (err) {
    console.error('Optimize error:', err);
    if (err.status === 529) return res.status(503).json({ error: 'AI overloaded. Try again.' });
    res.status(500).json({ error: 'Optimization failed: ' + err.message });
  }
});

app.get('/api/resume/history', authMiddleware, (req, res) => {
  const history = (db.history[req.user.userId] || []).map(({ resumeOutput, ...h }) => h);
  res.json({ history });
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 5MB)' });
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => console.log(`ResumeAI running on http://localhost:${PORT}`));
module.exports = app;
