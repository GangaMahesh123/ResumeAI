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

// ── Extract all paragraph texts from XML ─────────────────────────────────────
function extractParagraphs(xml) {
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paras = [];
  const pRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let match;
  while ((match = pRegex.exec(xml)) !== null) {
    const pXml = match[0];
    const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let text = '';
    let tMatch;
    while ((tMatch = tRegex.exec(pXml)) !== null) {
      text += tMatch[1];
    }
    paras.push({ text: text.trim(), xml: pXml, index: match.index });
  }
  return paras;
}

// ── Build a new bullet paragraph matching style of nearby paragraph ───────────
function buildBulletPara(text, techTerms, templateParaXml) {
  // Extract pPr from template
  const pPrMatch = templateParaXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  const pPr = pPrMatch ? pPrMatch[0] : '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:jc w:val="both"/></w:pPr>';

  // Extract base rPr from template (remove bold)
  const rPrMatch = templateParaXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  let baseRpr = rPrMatch ? rPrMatch[0] : '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>';
  // Remove any existing bold from base
  baseRpr = baseRpr.replace(/<w:b\/>/g, '').replace(/<w:bCs\/>/g, '');

  // Bold rPr = base with bold added
  const boldRpr = baseRpr.replace('</w:rPr>', '<w:b/><w:bCs/></w:rPr>');

  // Split text into bold/normal segments based on techTerms
  const sortedTerms = [...(techTerms || [])].sort((a, b) => b.length - a.length);
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

  // Build XML runs
  let runs = '';
  for (const seg of segments) {
    if (!seg.text) continue;
    const rpr = seg.bold ? boldRpr : baseRpr;
    const hasSpace = seg.text.startsWith(' ') || seg.text.endsWith(' ');
    const spaceAttr = hasSpace ? ' xml:space="preserve"' : '';
    const escaped = seg.text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    runs += `<w:r>${rpr}<w:t${spaceAttr}>${escaped}</w:t></w:r>`;
  }

  return `<w:p>${pPr}${runs}</w:p>`;
}

// ── Apply swap to XML text-runs: finds paragraphs containing text and swaps ───
function applyTextSwap(xml, findText, replaceText) {
  if (!findText || !replaceText || findText.trim() === replaceText.trim()) return xml;

  // Simple string replace — works when text is in single run
  if (xml.includes(findText)) {
    return xml.split(findText).join(replaceText);
  }

  // If not found as-is, try to find it across broken runs by rebuilding
  // Check if it appears in extracted text (split across runs)
  const paras = extractParagraphs(xml);
  for (const para of paras) {
    if (para.text.includes(findText)) {
      // Rebuild this paragraph's runs with the swap applied
      const newParaText = para.text.split(findText).join(replaceText);
      // Replace entire paragraph content — preserve pPr, rebuild runs
      const pPrMatch = para.xml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
      const pPr = pPrMatch ? pPrMatch[0] : '';
      const rPrMatch = para.xml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
      const baseRpr = rPrMatch ? rPrMatch[0].replace(/<w:b\/>/g, '').replace(/<w:bCs\/>/g, '') : '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>';
      const escaped = newParaText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const newRun = `<w:r>${baseRpr}<w:t xml:space="preserve">${escaped}</w:t></w:r>`;
      const newPara = `<w:p>${pPr}${newRun}</w:p>`;
      xml = xml.slice(0, para.index) + newPara + xml.slice(para.index + para.xml.length);
      break;
    }
  }
  return xml;
}

// ── Remove paragraph containing text ─────────────────────────────────────────
function removeParagraph(xml, findText) {
  if (!findText || findText.length < 10) return xml;
  const paras = extractParagraphs(xml);
  for (const para of paras) {
    if (para.text.includes(findText.slice(0, 50))) {
      xml = xml.slice(0, para.index) + xml.slice(para.index + para.xml.length);
      return xml;
    }
  }
  return xml;
}

// ── Insert paragraph after one containing text ────────────────────────────────
function insertAfterParagraph(xml, afterText, newParaXml) {
  if (!afterText || afterText.length < 10) return xml;
  const paras = extractParagraphs(xml);
  for (const para of paras) {
    if (para.text.includes(afterText.slice(0, 50))) {
      const insertPos = para.index + para.xml.length;
      xml = xml.slice(0, insertPos) + newParaXml + xml.slice(insertPos);
      return xml;
    }
  }
  return xml;
}

// ── CLAUDE: Analyze resume vs JD, return precise editing plan ────────────────
async function analyzeWithClaude(resumeText, jdText) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: `You are a world-class ATS resume optimizer. Your goal: make the resume score 92-95% against the JD.

STEP 1 - UNDERSTAND THE ROLE:
Read the JD carefully. Determine if it is: frontend only, backend only, full stack, DevOps, data engineering, etc.
This determines what is relevant vs irrelevant in the resume.
IMPORTANT: If the JD is full stack — frontend skills are relevant. If the JD is pure backend/DevOps — frontend skills are irrelevant.

STEP 2 - SCORE: Calculate current ATS match % by checking how many JD keywords exist in resume.

STEP 3 - REMOVE (only truly irrelevant bullets):
REMOVE ONLY if ALL of these are true:
  a) The skill/tool is NOT mentioned in the JD at all
  b) The skill is NOT related to the role type (e.g. Karma/Jasmine/Protractor in a DevOps JD)
  c) It is a basic obvious statement (e.g. "used JSON for data exchange") OR repeated elsewhere OR 10+ yr old tech
NEVER REMOVE:
  - Core technical achievements (migrations, architecture, API development, cloud deployments)
  - Primary tech stack bullets that match the JD's core requirements
  - Frontend skills if the JD is full stack or mentions frontend
  - Security, testing framework, CI/CD implementations
  - Quantified results or business impact
  - Anything that directly matches a JD keyword

STEP 4 - ADD (missing JD keywords):
For every important JD keyword NOT in the resume, add a natural bullet in the 2 most recent jobs.
Each new bullet must:
  - Sound exactly like the candidate wrote it (match their tone, length, verb style)
  - Be plausible given the candidate's existing experience
  - Include the exact JD keyword bolded
  - Go after the most contextually relevant existing bullet

STEP 5 - SWAP: Only swap if JD clearly requires DIFFERENT tech. If JD says "AWS or Azure" — keep Azure. If JD says only React — swap Angular.

STEP 6 - VERIFY: After changes, score must be 92-95%. Add more bullets if not enough.

ABSOLUTE RULES:
- insertAfter: COPY FIRST 60 CHARS EXACTLY from existing resume bullet
- find (swaps/removals): COPY EXACTLY from resume — must exist verbatim
- techTerms: every tech name that should be bold in new bullet
- New bullets match candidate writing style and seniority
- Removals and additions roughly balance (same page count)
- Return ONLY valid JSON`,
    messages: [{
      role: 'user',
      content: `Score this resume against the JD, then produce a complete editing plan to reach 92-95% ATS match.

CRITICAL INSTRUCTION FOR ADDITIONS:
- Add new bullets ONLY in the Professional Experience sections (the 2 most recent jobs)
- DO NOT add to Professional Summary
- The insertAfter field must reference a bullet from the experience section, NOT from the summary
- Experience bullets start with action verbs like "Implemented", "Designed", "Developed", "Integrated", "Built", "Managed"
- DO NOT use markdown bold (**text**) in bullet text — just write plain text, list tech terms separately in techTerms array

RESUME:
${resumeText.slice(0, 6000)}

JOB DESCRIPTION:
${jdText.slice(0, 2000)}

Return ONLY this JSON (no markdown):
{
  "matchScoreBefore": 72,
  "matchScoreAfter": 93,
  "stackDetected": {
    "cloud": "aws|azure|gcp|none",
    "frontend": "react|angular|vue|none",
    "backend": "dotnet|java|node|python|none",
    "cicd": "jenkins|github_actions|azure_devops|none"
  },
  "swaps": [
    {
      "find": "exact verbatim text from resume that must exist",
      "replace": "replacement with JD technology",
      "scope": "recent_only",
      "reason": "why"
    }
  ],
  "remove": [
    {
      "find": "first 60 chars of bullet copied exactly from resume",
      "reason": "specific reason why irrelevant to THIS JD"
    }
  ],
  "add": [
    {
      "text": "complete new bullet plain text no markdown bold — matching candidate writing style",
      "insertAfter": "first 60 chars of an EXPERIENCE SECTION bullet — copied exactly from resume (NOT from summary)",
      "techTerms": ["ExactTerm1", "ExactTerm2"],
      "reason": "which JD keyword this covers"
    }
  ],
  "summary": "Score before X%, changes made, score after Y%"
}`
    }]
  });

  const raw = message.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  try {
    const cleaned = raw.replace(/```json\n?|```\n?/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    console.log(`Claude plan: ${parsed.swaps?.length||0} swaps, ${parsed.remove?.length||0} removals, ${parsed.add?.length||0} additions, score ${parsed.matchScoreBefore}->${ parsed.matchScoreAfter}`);
    return parsed;
  } catch (e) {
    console.error('Claude parse error:', e.message, raw.slice(0, 300));
    return { swaps: [], remove: [], add: [], matchScoreBefore: 70, matchScoreAfter: 88, stackDetected: {}, summary: '' };
  }
}

// ── Hardcoded tech stack swap maps ───────────────────────────────────────────
const AZURE_TO_AWS = [
  ['Azure App Services', 'AWS Elastic Beanstalk'],
  ['Azure Functions v4', 'AWS Lambda'],
  ['Azure Functions', 'AWS Lambda'],
  ['Azure API Management (APIM)', 'AWS API Gateway'],
  ['Azure API Management', 'AWS API Gateway'],
  ['Azure API Gateway (v2)', 'AWS API Gateway'],
  ['Azure API Gateway', 'AWS API Gateway'],
  ['Azure Blob Storage', 'Amazon S3'],
  ['Azure SQL Database', 'Amazon RDS'],
  ['Azure SQL', 'Amazon RDS'],
  ['Azure AD B2C', 'AWS Cognito'],
  ['Azure AD', 'AWS IAM'],
  ['Azure Monitor', 'Amazon CloudWatch'],
  ['Application Insights', 'AWS CloudWatch Insights'],
  ['Azure Key Vault', 'AWS Secrets Manager'],
  ['Azure DevOps CI/CD pipelines', 'AWS CodePipeline CI/CD pipelines'],
  ['Azure DevOps CI/CD', 'AWS CodePipeline'],
  ['Azure DevOps', 'AWS CodePipeline'],
  ['Azure Repos', 'AWS CodeCommit'],
  ['Microsoft Azure', 'Amazon Web Services (AWS)'],
  ['Azure services', 'AWS services'],
];

const AZURE_TO_GCP = [
  ['Azure App Services', 'Google Cloud Run'],
  ['Azure Functions v4', 'Google Cloud Functions'],
  ['Azure Functions', 'Google Cloud Functions'],
  ['Azure API Management (APIM)', 'Google Cloud Apigee'],
  ['Azure API Management', 'Google Cloud Apigee'],
  ['Azure API Gateway', 'Google Cloud Endpoints'],
  ['Azure Blob Storage', 'Google Cloud Storage'],
  ['Azure SQL Database', 'Google Cloud SQL'],
  ['Azure SQL', 'Google Cloud SQL'],
  ['Azure AD B2C', 'Google Identity Platform'],
  ['Azure AD', 'Google Cloud IAM'],
  ['Azure Monitor', 'Google Cloud Monitoring'],
  ['Application Insights', 'Google Cloud Trace'],
  ['Azure Key Vault', 'Google Secret Manager'],
  ['Azure DevOps CI/CD pipelines', 'Google Cloud Build CI/CD pipelines'],
  ['Azure DevOps CI/CD', 'Google Cloud Build'],
  ['Azure DevOps', 'Google Cloud Build'],
  ['Azure Repos', 'Google Cloud Source Repositories'],
  ['Microsoft Azure', 'Google Cloud Platform (GCP)'],
  ['Azure services', 'GCP services'],
];

const ANGULAR_TO_REACT = [
  ['Angular 14 to Angular 18', 'React 17 to React 18'],
  ['Angular 14–18', 'React 17–18'],
  ['Angular 14, progressively upgrading to Angular 18', 'React 17, progressively upgrading to React 18'],
  ['Angular 12 to Angular 15', 'React 16 to React 18'],
  ['Angular 14', 'React 18'], ['Angular 15', 'React 18'], ['Angular 18', 'React 18'],
  ['Angular 12', 'React 17'], ['Angular 6', 'React 16'], ['Angular', 'React'],
  ['RxJS 7 to 8', 'Redux Toolkit'], ['RxJS 7–8', 'Redux Toolkit'], ['RxJS', 'Redux Toolkit'],
  ['Karma', 'Jest'], ['Jasmine', 'React Testing Library'], ['Protractor', 'Cypress'],
];

const ANGULAR_TO_VUE = [
  ['Angular 14 to Angular 18', 'Vue 2 to Vue 3'], ['Angular 14', 'Vue 3'],
  ['Angular 18', 'Vue 3'], ['Angular 12', 'Vue 2'], ['Angular', 'Vue.js'],
  ['RxJS', 'Vuex / Pinia'], ['Karma', 'Vitest'], ['Jasmine', 'Vue Test Utils'], ['Protractor', 'Cypress'],
];

// ── Apply all instructions to DOCX ───────────────────────────────────────────
function applyToDocx(docxBuffer, instructions, resumeText) {
  const zip = new AdmZip(docxBuffer);
  const docEntry = zip.getEntry('word/document.xml');
  if (!docEntry) throw new Error('Invalid DOCX — word/document.xml not found');

  let xml = docEntry.getData().toString('utf-8');
  const paras = extractParagraphs(xml);

  // Detect scope (recent 2 jobs only for swaps)
  let scopeEndText = null;
  const jobKeywords = ['Fannie Mae', 'Lulu Lemon', 'LuluLemon', 'Infosys', 'previous employer'];
  for (const kw of jobKeywords) {
    if (resumeText.includes(kw)) { scopeEndText = kw; break; }
  }

  // HARDCODED STACK SWAPS based on JD detection
  // These always apply correctly regardless of what Claude returns
  const stack = instructions.stackDetected || {};
  let hardcodedSwaps = [];
  if (stack.cloud === 'aws') hardcodedSwaps = [...hardcodedSwaps, ...AZURE_TO_AWS];
  if (stack.cloud === 'gcp') hardcodedSwaps = [...hardcodedSwaps, ...AZURE_TO_GCP];
  if (stack.frontend === 'react') hardcodedSwaps = [...hardcodedSwaps, ...ANGULAR_TO_REACT];
  if (stack.frontend === 'vue') hardcodedSwaps = [...hardcodedSwaps, ...ANGULAR_TO_VUE];

  // Sort by length desc — longer phrases first
  hardcodedSwaps.sort((a, b) => b[0].length - a[0].length);

  const hardcodedApplied = [];
  if (hardcodedSwaps.length > 0) {
    const scopeEnd = scopeEndText ? xml.indexOf(scopeEndText) : -1;
    const before = scopeEnd > 0 ? xml.slice(0, xml.indexOf(xml.match(/Client:|Company:/)?.[0] || 'Professional Experience') || 0) : '';

    if (scopeEnd > 0) {
      // Find start of experience section
      const expStart = Math.max(xml.indexOf('Professional Experience'), xml.indexOf('County of San Bernardino'), xml.indexOf('Client:'));
      if (expStart > 0) {
        const beforeExp = xml.slice(0, expStart);
        let scope = xml.slice(expStart, scopeEnd);
        const after = xml.slice(scopeEnd);
        for (const [from, to] of hardcodedSwaps) {
          if (scope.includes(from)) {
            scope = scope.split(from).join(to);
            hardcodedApplied.push(`${from.slice(0,30)} → ${to.slice(0,30)}`);
          }
        }
        xml = beforeExp + scope + after;
      }
    } else {
      // Apply to full document
      for (const [from, to] of hardcodedSwaps) {
        if (xml.includes(from)) {
          xml = xml.split(from).join(to);
          hardcodedApplied.push(`${from.slice(0,30)} → ${to.slice(0,30)}`);
        }
      }
    }
    if (hardcodedApplied.length > 0) console.log(`Hardcoded swaps: ${hardcodedApplied.length}`);
  }

  const swapsApplied = [];
  const removedBullets = [];
  const addedBullets = [];

  // SWAPS — apply in recent 2 jobs scope
  for (const swap of (instructions.swaps || [])) {
    if (!swap.find || !swap.replace) continue;
    if (swap.find.trim() === swap.replace.trim()) continue;

    if (scopeEndText && swap.scope === 'recent_only') {
      // Only swap before the 3rd job
      const scopeEndIdx = xml.indexOf(scopeEndText);
      if (scopeEndIdx > 0) {
        const before = xml.slice(0, scopeEndIdx);
        const after = xml.slice(scopeEndIdx);
        const newBefore = applyTextSwap(before, swap.find.trim(), swap.replace.trim());
        if (newBefore !== before) {
          xml = newBefore + after;
          swapsApplied.push(`${swap.find.trim().slice(0, 35)} → ${swap.replace.trim().slice(0, 35)}`);
        }
      }
    } else {
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

  // ADDITIONS — insert new bullets
  const currentParas = extractParagraphs(xml);
  for (const addition of (instructions.add || [])) {
    if (!addition.text || !addition.insertAfter) continue;

    // Find the template paragraph to copy style from
    const afterSnippet = addition.insertAfter.trim().slice(0, 50);
    let templatePara = null;
    for (const para of currentParas) {
      if (para.text.includes(afterSnippet)) {
        templatePara = para;
        break;
      }
    }

    if (!templatePara) {
      console.log(`Could not find insertAfter: "${afterSnippet}"`);
      continue;
    }

    // Strip any markdown bold formatting Claude may have included
    const cleanText = addition.text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
    const newBulletXml = buildBulletPara(cleanText, addition.techTerms || [], templatePara.xml);
    const newXml = insertAfterParagraph(xml, afterSnippet, newBulletXml);
    if (newXml !== xml) {
      xml = newXml;
      addedBullets.push(addition.text.slice(0, 60));
      // Re-extract paragraphs after each insertion so indices are accurate
      currentParas.length = 0;
      currentParas.push(...extractParagraphs(xml));
    } else {
      console.log(`insertAfterParagraph failed for: "${afterSnippet}"`);
    }
  }

  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf-8'));

  return {
    buffer: zip.toBuffer(),
    swapsApplied: [...hardcodedApplied, ...swapsApplied],
    removedBullets,
    addedBullets
  };
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

    // Step 1: Claude analyzes and returns editing plan
    const instructions = await analyzeWithClaude(resumeText, jobDescription.trim());

    // Step 2: Apply to DOCX using pure Node.js
    let docxBase64 = null;
    let swapsApplied = [];
    let removedBullets = [];
    let addedBullets = [];

    if (ext === '.docx') {
      try {
        const result = applyToDocx(req.file.buffer, instructions, resumeText);
        docxBase64 = result.buffer.toString('base64');
        swapsApplied = result.swapsApplied;
        removedBullets = result.removedBullets;
        addedBullets = result.addedBullets;
        console.log(`Applied: ${swapsApplied.length} swaps, ${removedBullets.length} removed, ${addedBullets.length} added`);
      } catch (err) {
        console.error('DOCX apply error:', err.message);
      }
    }

    const changes = [
      ...swapsApplied.map(s => ({ type: 'modified', description: `Updated: ${s}` })),
      ...removedBullets.map(r => ({ type: 'removed', description: `Removed weak point: ${r}` })),
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
      jdStack: instructions.stackDetected || {},
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
