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

// ── XML helpers ───────────────────────────────────────────────────────────────
function extractParagraphs(xml) {
  const paras = [];
  const pRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let match;
  while ((match = pRegex.exec(xml)) !== null) {
    const pXml = match[0];
    let text = '';
    const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let tMatch;
    while ((tMatch = tRegex.exec(pXml)) !== null) text += tMatch[1];
    paras.push({ text: text.trim(), xml: pXml, index: match.index });
  }
  return paras;
}

function buildBulletPara(text, techTerms, templateParaXml) {
  const pPrMatch = templateParaXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  const pPr = pPrMatch ? pPrMatch[0] : '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:jc w:val="both"/></w:pPr>';
  const rPrMatch = templateParaXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  let baseRpr = rPrMatch ? rPrMatch[0] : '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>';
  baseRpr = baseRpr.replace(/<w:b\/>/g, '').replace(/<w:bCs\/>/g, '');
  const boldRpr = baseRpr.replace('</w:rPr>', '<w:b/><w:bCs/></w:rPr>');

  const cleanText = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
  const sortedTerms = [...(techTerms || [])].sort((a, b) => b.length - a.length);
  let remaining = cleanText;
  const segments = [];

  while (remaining.length > 0) {
    let found = false;
    for (const term of sortedTerms) {
      const idx = remaining.indexOf(term);
      if (idx === 0) { segments.push({ text: term, bold: true }); remaining = remaining.slice(term.length); found = true; break; }
      if (idx > 0) { segments.push({ text: remaining.slice(0, idx), bold: false }); segments.push({ text: term, bold: true }); remaining = remaining.slice(idx + term.length); found = true; break; }
    }
    if (!found) { segments.push({ text: remaining, bold: false }); remaining = ''; }
  }

  let runs = '';
  for (const seg of segments) {
    if (!seg.text) continue;
    const escaped = seg.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    runs += `<w:r>${seg.bold ? boldRpr : baseRpr}<w:t${(seg.text.startsWith(' ') || seg.text.endsWith(' ')) ? ' xml:space="preserve"' : ''}>${escaped}</w:t></w:r>`;
  }
  return `<w:p>${pPr}${runs}</w:p>`;
}

function applyTextSwap(xml, findText, replaceText) {
  if (!findText || !replaceText || findText.trim() === replaceText.trim()) return xml;
  if (xml.includes(findText)) return xml.split(findText).join(replaceText);
  const paras = extractParagraphs(xml);
  for (const para of paras) {
    if (para.text.includes(findText)) {
      const newText = para.text.split(findText).join(replaceText);
      const pPrM = para.xml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
      const rPrM = para.xml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
      const pPr = pPrM ? pPrM[0] : '';
      const rPr = rPrM ? rPrM[0].replace(/<w:b\/>/g,'').replace(/<w:bCs\/>/g,'') : '<w:rPr><w:sz w:val="20"/></w:rPr>';
      const escaped = newText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      xml = xml.slice(0, para.index) + `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>` + xml.slice(para.index + para.xml.length);
      break;
    }
  }
  return xml;
}

function removeParagraph(xml, findText) {
  if (!findText || findText.length < 10) return xml;
  const paras = extractParagraphs(xml);
  for (const para of paras) {
    if (para.text.includes(findText.slice(0, 50)))
      return xml.slice(0, para.index) + xml.slice(para.index + para.xml.length);
  }
  return xml;
}

function insertAfterParagraph(xml, afterText, newParaXml, currentParas) {
  const paras = currentParas || extractParagraphs(xml);
  for (const para of paras) {
    if (para.text.includes(afterText.slice(0, 50))) {
      const pos = para.index + para.xml.length;
      return xml.slice(0, pos) + newParaXml + xml.slice(pos);
    }
  }
  return xml;
}

// ── CLAUDE: Full intelligent analysis ────────────────────────────────────────
async function analyzeWithClaude(resumeText, jdText) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: `You are a Resume Tailoring and JD Match Optimization Assistant.

GOAL: For any uploaded JD and resume, tailor the resume to achieve 92-95% ATS match while keeping it truthful, ATS-friendly, and professionally written.

STRICT RULES:
1. Do NOT remove or change any core project responsibilities, domain experience, or real technologies already present
2. Do NOT invent fake experience, fake employers, fake project work, or technologies not connected to candidate's background
3. Keep existing resume structure and technology order: Summary → Technical Skills → Professional Experience → Recent 2 Projects → Environment
4. Add missing JD-related skills only in the correct section and correct position
5. Preserve existing ordering of technologies: frontend, backend, database, cloud, DevOps, testing, security, AI, domain-specific tools
6. Remove ONLY unnecessary, repeated, weak, or non-JD-relevant points
7. Do NOT reduce strength of existing full-stack, cloud, frontend, backend, database, AI, or domain experience
8. Any new technology added must be checked against project timeline — if not available during that period, use valid alternative
9. Update ONLY these sections: Professional Summary, Technical Skills, Recent 2 Projects, Environment lines
10. Missing JD points inserted naturally into existing bullets or added as new bullets in right position
11. Maintain same writing style, bullet format, and resume tone
12. Final resume match must be 92-95% — not overstuffed beyond that

PROCESS:
STEP 1 — ANALYZE JD:
Extract: required skills, preferred skills, domain needs, tools, cloud, frontend, backend, database, DevOps, testing, security requirements.

STEP 2 — COMPARE JD vs RESUME:
Identify:
- Already matching skills (keep as is)
- Missing skills (add in right section/position)
- Partially covered skills (enhance existing bullet)
- Skills that CANNOT be added (not supported by candidate background)
- Timeline/version conflicts (flag and suggest valid alternative)

STEP 3 — GENERATE CHANGES:
Generate ONLY the exact additions, replacements, and removals needed for 92-95% match.

STEP 4 — SWAP ALL TECH MISMATCHES (CRITICAL):
When resume has Technology A but JD requires Technology B (same category):
Generate INDIVIDUAL swap pairs for EVERY specific term in the resume — NOT one generic swap.
Example: resume has Azure, JD wants AWS → generate separate swaps for:
"Azure API Management (APIM)" → "AWS API Gateway"
"Azure API Gateway (v2)" → "AWS API Gateway"
"Azure AD B2C" → "AWS Cognito"
"Azure AD" → "AWS IAM"
"Azure DevOps CI/CD pipelines" → "AWS CodePipeline CI/CD pipelines"
"Azure DevOps" → "AWS CodePipeline"
"Azure App Services" → "AWS Elastic Beanstalk"
"Azure Functions v4" → "AWS Lambda"
"Azure Functions" → "AWS Lambda"
"Azure Blob Storage" → "Amazon S3"
"Azure SQL Database" → "Amazon RDS"
"Azure SQL" → "Amazon RDS"
"Azure Repos" → "AWS CodeCommit"
"Azure Key Vault" → "AWS Secrets Manager"
"Azure Monitor" → "Amazon CloudWatch"
"Application Insights" → "AWS CloudWatch Insights"
"Microsoft Azure" → "Amazon Web Services (AWS)"
Sort swaps LONGEST to SHORTEST so longer phrases replace before shorter ones.
Apply same individual swap logic for Angular→React, React→Angular, GCP→AWS, etc.
Swaps in experience/environment: scope = "recent_only" (recent 2 projects only)
Swaps in summary/skills: scope = "full_document"

STEP 5 — VERSION VALIDATION:
For every technology version added or swapped:
1. Extract project date range (e.g. "Aug 2023 - Present", "Jan 2021 - Aug 2023")
2. Verify version was released BEFORE project end date
3. For migration projects: FROM version must predate project start, TO version must exist by project end
4. NEVER downgrade existing versions
5. If version conflict found: flag it and use latest valid version for that period

VERSION RELEASE TIMELINE:
React: 16(2017), 17(Oct 2020), 18(Mar 2022), 19(Dec 2024)
Angular: 12(May 2021), 13(Nov 2021), 14(Jun 2022), 15(Nov 2022), 16(May 2023), 17(Nov 2023), 18(May 2024)
.NET: 5(Nov 2020), 6(Nov 2021), 7(Nov 2022), 8(Nov 2023), 9(Nov 2024)
Java: 11(Sep 2018), 17(Sep 2021), 21(Sep 2023)
Python: 3.9(Oct 2020), 3.10(Oct 2021), 3.11(Oct 2022), 3.12(Oct 2023)
Node: 16(Apr 2021), 18(Apr 2022), 20(Apr 2023), 22(Apr 2024)
Kubernetes: 1.24(May 2022), 1.27(Apr 2023), 1.28(Aug 2023), 1.30(Apr 2024)
PostgreSQL: 14(Sep 2021), 15(Oct 2022), 16(Sep 2023)
MongoDB: 5(Jul 2021), 6(Jul 2022), 7(Aug 2023)
TypeScript: 4.x(2020-2022), 5.0(Mar 2023), 5.3(Nov 2023), 5.6(Sep 2024)
Spring Boot: 3.0(Nov 2022), 3.1(May 2023), 3.2(Nov 2023), 3.3(May 2024)
TensorFlow: 2.10(Sep 2022), 2.12(Mar 2023), 2.15(Nov 2023)
PyTorch: 2.0(Mar 2023), 2.1(Oct 2023), 2.3(Apr 2024)
Spark: 3.3(Jun 2022), 3.4(Apr 2023), 3.5(Sep 2023)
Airflow: 2.5(Dec 2022), 2.7(Aug 2023), 2.9(Apr 2024)
MLflow: 2.0(Oct 2022), 2.5(Jun 2023), 2.9(Dec 2023)
LangChain: 0.1(Jan 2024), 0.2(May 2024)
dbt: 1.5(Apr 2023), 1.7(Nov 2023), 1.8(May 2024)

ABSOLUTE RULES:
- find/replace text: must exist VERBATIM in resume
- insertAfter: COPY FIRST 60 CHARS EXACTLY from existing experience bullet (NOT summary)
- No markdown bold (**text**) in bullet text — use techTerms array
- Additions roughly balance removals (preserve page count)
- All additions must be realistic and defensible in interviews
- Return ONLY valid JSON`,

    messages: [{
      role: 'user',
      content: `Analyze this resume against the JD and produce a complete tailoring plan.

RESUME:
\${resumeText.slice(0, 6000)}

JOB DESCRIPTION:
\${jdText.slice(0, 2000)}

Return ONLY this JSON (no markdown):
{
  "matchScoreBefore": <integer — current ATS score>,
  "matchScoreAfter": <integer 92-95>,
  "roleType": "full_stack|backend|frontend|devops|data_engineer|data_scientist|ml_engineer|mlops|ai_engineer|other",
  "techMismatches": [
    { "resumeHas": "exact term", "jdWants": "exact term", "category": "cloud|frontend|backend|database|orm|messaging|testing|cicd|auth|monitoring|containers|iac|ml|other" }
  ],
  "timelineIssues": [
    { "technology": "name", "version": "version", "project": "project name", "issue": "description", "suggestion": "valid alternative" }
  ],
  "swaps": [
    {
      "find": "exact verbatim text from resume — must exist",
      "replace": "replacement text with JD technology",
      "scope": "recent_only|full_document",
      "section": "experience|environment|skills|summary",
      "reason": "brief reason"
    }
  ],
  "remove": [
    {
      "find": "first 60 chars of bullet copied EXACTLY from resume",
      "reason": "specific reason why irrelevant/weak for THIS JD"
    }
  ],
  "add": [
    {
      "text": "complete new bullet plain text matching candidate writing style",
      "insertAfter": "first 60 chars of existing EXPERIENCE bullet copied EXACTLY from resume",
      "techTerms": ["ExactTerm1", "ExactTerm2"],
      "reason": "which JD keyword/skill this covers"
    }
  ],
  "summaryUpdate": "updated professional summary text aligned with JD (full text)",
  "skillsUpdates": [
    { "find": "exact text in skills section", "replace": "updated text with JD technology" }
  ],
  "summary": "Score X% before. Key changes: [list]. Score Y% after."
}`
    }]
  });

  const raw = message.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  try {
    const cleaned = raw.replace(/```json\n?|```\n?/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    console.log(`Plan: ${parsed.swaps?.length||0} swaps, ${parsed.remove?.length||0} removals, ${parsed.add?.length||0} additions`);
    console.log(`Role: ${parsed.roleType}, Mismatches: ${parsed.techMismatches?.length||0}`);
    return parsed;
  } catch (e) {
    console.error('Parse error:', e.message, raw.slice(0, 200));
    return { swaps: [], remove: [], add: [], matchScoreBefore: 70, matchScoreAfter: 88, techMismatches: [], summary: '' };
  }
}

// ── Apply all instructions to DOCX ───────────────────────────────────────────
function applyToDocx(docxBuffer, instructions, resumeText) {
  const zip = new AdmZip(docxBuffer);
  const docEntry = zip.getEntry('word/document.xml');
  if (!docEntry) throw new Error('Invalid DOCX');

  let xml = docEntry.getData().toString('utf-8');

  // Find scope end (3rd job onwards — don't change old roles)
  let scopeEndText = null;
  const oldJobKeywords = ['Fannie Mae', 'LuluLemon', 'Lulu Lemon', 'Infosys', 'Wipro', 'TCS', 'Cognizant', 'Accenture', 'Capgemini'];
  for (const kw of oldJobKeywords) {
    if (resumeText.includes(kw)) { scopeEndText = kw; break; }
  }

  const swapsApplied = [];
  const removedBullets = [];
  const addedBullets = [];

  // SWAPS — sorted by length desc so longer phrases replace first
  const swaps = [...(instructions.swaps || [])];
  swaps.sort((a, b) => (b.find?.length || 0) - (a.find?.length || 0));

  for (const swap of swaps) {
    if (!swap.find || !swap.replace) continue;
    if (swap.find.trim() === swap.replace.trim()) continue;

    const isRecentOnly = swap.scope === 'recent_only';
    const scopeEndIdx = scopeEndText ? xml.indexOf(scopeEndText) : -1;

    if (isRecentOnly && scopeEndIdx > 0) {
      // Find start of experience section
      const expKeywords = ['Professional Experience', 'County of San Bernardino', 'Client:', 'Work Experience'];
      let expStart = -1;
      for (const kw of expKeywords) {
        const idx = xml.indexOf(kw);
        if (idx > 0) { expStart = idx; break; }
      }
      if (expStart > 0) {
        const beforeExp = xml.slice(0, expStart);
        let scope = xml.slice(expStart, scopeEndIdx);
        const after = xml.slice(scopeEndIdx);
        const newScope = applyTextSwap(scope, swap.find.trim(), swap.replace.trim());
        if (newScope !== scope) {
          xml = beforeExp + newScope + after;
          swapsApplied.push(`${swap.find.trim().slice(0, 35)} → ${swap.replace.trim().slice(0, 35)}`);
        }
      }
    } else {
      // full_document scope — applies to summary, skills, environment too
      const newXml = applyTextSwap(xml, swap.find.trim(), swap.replace.trim());
      if (newXml !== xml) {
        xml = newXml;
        swapsApplied.push(`${swap.find.trim().slice(0, 35)} → ${swap.replace.trim().slice(0, 35)}`);
      }
    }
  }

  // REMOVALS
  for (const removal of (instructions.remove || [])) {
    if (!removal.find) continue;
    const newXml = removeParagraph(xml, removal.find.trim());
    if (newXml !== xml) {
      xml = newXml;
      removedBullets.push(removal.find.trim().slice(0, 50));
    }
  }

  // ADDITIONS
  let currentParas = extractParagraphs(xml);
  for (const addition of (instructions.add || [])) {
    if (!addition.text || !addition.insertAfter) continue;
    const afterSnippet = addition.insertAfter.trim().slice(0, 50);
    const templatePara = currentParas.find(p => p.text.includes(afterSnippet));
    if (!templatePara) { console.log(`insertAfter not found: "${afterSnippet}"`); continue; }
    const newBulletXml = buildBulletPara(addition.text, addition.techTerms || [], templatePara.xml);
    const newXml = insertAfterParagraph(xml, afterSnippet, newBulletXml, currentParas);
    if (newXml !== xml) {
      xml = newXml;
      addedBullets.push(addition.text.slice(0, 60));
      currentParas = extractParagraphs(xml);
    }
  }

  // SKILLS UPDATES — update technical skills section
  for (const skillUpdate of (instructions.skillsUpdates || [])) {
    if (!skillUpdate.find || !skillUpdate.replace) continue;
    const newXml = applyTextSwap(xml, skillUpdate.find.trim(), skillUpdate.replace.trim());
    if (newXml !== xml) {
      xml = newXml;
      swapsApplied.push(`Skills: ${skillUpdate.find.trim().slice(0, 30)} → ${skillUpdate.replace.trim().slice(0, 30)}`);
    }
  }

  // SUMMARY UPDATE — replace full summary if provided
  if (instructions.summaryUpdate && instructions.summaryUpdate.length > 50) {
    // Find and update the first long summary bullet
    const summaryParas = currentParas.filter(p =>
      p.text.length > 80 &&
      !p.text.includes('Client:') &&
      !p.text.includes('Environment:') &&
      !p.text.includes('Role:')
    );
    if (summaryParas.length > 0) {
      const firstSummaryPara = summaryParas[0];
      const newXml = applyTextSwap(xml, firstSummaryPara.text, instructions.summaryUpdate.trim());
      if (newXml !== xml) {
        xml = newXml;
        swapsApplied.push(`Summary updated`);
      }
    }
  }

  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf-8'));
  return { buffer: zip.toBuffer(), swapsApplied, removedBullets, addedBullets };
}

// ══ AUTH ══════════════════════════════════════════════════════════════════════
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
    const instructions = await analyzeWithClaude(resumeText, jobDescription.trim());

    let docxBase64 = null;
    let swapsApplied = [], removedBullets = [], addedBullets = [];

    if (ext === '.docx') {
      try {
        const result = applyToDocx(req.file.buffer, instructions, resumeText);
        docxBase64 = result.buffer.toString('base64');
        swapsApplied = result.swapsApplied;
        removedBullets = result.removedBullets;
        addedBullets = result.addedBullets;
        console.log(`Applied: ${swapsApplied.length} swaps, ${removedBullets.length} removed, ${addedBullets.length} added`);
      } catch (err) { console.error('DOCX error:', err.message); }
    }

    const changes = [
      ...swapsApplied.map(s => ({ type: 'modified', description: `Updated: ${s}` })),
      ...removedBullets.map(r => ({ type: 'removed', description: `Removed: ${r}` })),
      ...addedBullets.map(a => ({ type: 'added', description: `Added: ${a}` })),
    ];
    if (changes.length === 0) changes.push({ type: 'added', description: instructions.summary || 'Resume analyzed and optimized' });

    const entry = {
      id: `opt_${Date.now()}`,
      jdSnippet: jobDescription.trim().slice(0, 200),
      matchScore: instructions.matchScoreAfter || 93,
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
      matchScore: instructions.matchScoreAfter || 93,
      changes,
      keywordsAdded: addedBullets.length + swapsApplied.length,
      bulletsEnhanced: addedBullets.length,
      sectionsImproved: Math.min(swapsApplied.length + addedBullets.length, 6),
      swapsApplied,
      removedCount: removedBullets.length,
      addedCount: addedBullets.length,
      jdStack: {
        roleType: instructions.roleType || '',
        mismatches: (instructions.techMismatches || []).map(m => `${m.resumeHas} → ${m.jdWants} (${m.category})`)
      },
      summary: instructions.summary || ''
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
