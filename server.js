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

// ── STEP 1: Claude analyzes JD and resume ────────────────────────────────────
// Claude's ONLY job: identify missing keywords and weak points
// Claude does NOT decide what to swap — the code handles swaps
async function analyzeWithClaude(resumeText, jdText) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: `You are a Resume Tailoring Assistant. Analyze a resume against a job description.

YOUR ONLY JOBS:
1. Identify JD keywords/skills that are MISSING from the resume — these need to be ADDED
2. Identify bullets that are WEAK, REPEATED, or IRRELEVANT to THIS specific JD — these can be REMOVED
3. Suggest what to add and where to add it in the recent 2 projects

YOU DO NOT handle technology swaps. The system handles swaps automatically.
DO NOT suggest swapping Azure to AWS, Angular to React, or any cloud/framework swaps.
DO NOT generate any "swaps" array entries for cloud providers or frontend frameworks.
Only generate swaps for minor phrasing improvements within the same technology.

RULES FOR ADDITIONS:
- Only add skills that are explicitly required by the JD AND missing from resume
- New bullets must match the candidate's writing style and seniority
- Only add to the 2 most recent jobs (not older clients)
- insertAfter must be first 60 chars of an EXISTING experience bullet copied exactly
- No markdown bold in text — use techTerms array
- Additions must be realistic and defensible in interviews

RULES FOR REMOVALS:
- Only remove if bullet is COMPLETELY irrelevant to this JD's domain/role
- Only remove weak/repeated/obvious statements
- NEVER remove core technical achievements
- NEVER remove primary tech stack bullets
- Only remove from recent 2 projects, never older clients

VERSION RULES:
- Any version added must match the project date range
- Never use a version released after the project end date

Return ONLY valid JSON.`,

    messages: [{
      role: 'user',
      content: `Analyze this resume vs JD. Return additions and removals only.

RESUME:
${resumeText.slice(0, 6000)}

JOB DESCRIPTION:
${jdText.slice(0, 2000)}

Return ONLY this JSON:
{
  "matchScoreBefore": <integer>,
  "matchScoreAfter": <integer 92-95>,
  "roleType": "full_stack|backend|frontend|devops|data_engineer|ml_engineer|other",
  "missingKeywords": ["keyword1", "keyword2"],
  "remove": [
    {
      "find": "first 60 chars of bullet EXACTLY from resume",
      "reason": "why irrelevant to THIS JD"
    }
  ],
  "add": [
    {
      "text": "new bullet text matching candidate style",
      "insertAfter": "first 60 chars of existing experience bullet EXACTLY from resume",
      "techTerms": ["Term1", "Term2"],
      "reason": "which JD keyword this covers"
    }
  ],
  "summaryKeywords": ["keyword1", "keyword2"],
  "summary": "brief description of changes"
}`
    }]
  });

  const raw = message.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  try {
    const cleaned = raw.replace(/```json\n?|```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
    console.log(`Claude: ${parsed.remove?.length||0} removals, ${parsed.add?.length||0} additions, role: ${parsed.roleType}`);
    return parsed;
  } catch (e) {
    console.error('Parse error:', e.message, raw.slice(0, 200));
    return { remove: [], add: [], matchScoreBefore: 70, matchScoreAfter: 88, missingKeywords: [], summary: '' };
  }
}

// ── STEP 2: Detect tech mismatches from JD vs resume ─────────────────────────
// This is where ALL swap decisions are made — based purely on JD text vs resume text
// No AI involved in swap decisions — pure rule-based detection
function detectSwaps(resumeText, jdText) {
  const jd = jdText.toLowerCase();
  const resume = resumeText.toLowerCase();
  const swaps = [];

  // Helper: does JD explicitly mention this term? (word boundary aware)
  const jdHas = (...terms) => terms.some(t => {
    const tl = t.toLowerCase();
    const idx = jd.indexOf(tl);
    if (idx === -1) return false;
    // Check word boundaries - char before and after must not be alphanumeric
    const before = idx === 0 ? ' ' : jd[idx - 1];
    const after = idx + tl.length >= jd.length ? ' ' : jd[idx + tl.length];
    return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
  });
  // Helper: does resume have this term?
  const resumeHas = (...terms) => terms.some(t => resume.includes(t.toLowerCase()));

  // ── CLOUD DETECTION ──────────────────────────────────────────────────────
  // Only swap cloud if JD explicitly requires a DIFFERENT cloud than what resume has
  // AND JD does NOT mention the resume's current cloud

  if (resumeHas('azure', 'microsoft azure')) {
    if (jdHas('aws', 'amazon web services', 'ec2', 'lambda', ' s3 ', 'rds') && !jdHas('azure', 'microsoft azure')) {
      // Resume has Azure, JD wants ONLY AWS → swap
      swaps.push(...[
        ['Azure API Management (APIM)', 'AWS API Gateway'],
        ['Azure API Management', 'AWS API Gateway'],
        ['Azure API Gateway (v2)', 'AWS API Gateway'],
        ['Azure API Gateway', 'AWS API Gateway'],
        ['Azure App Services', 'AWS Elastic Beanstalk'],
        ['Azure Functions v4', 'AWS Lambda'],
        ['Azure Functions', 'AWS Lambda'],
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
      ]);
    } else if (jdHas('gcp', 'google cloud', 'vertex ai', 'bigquery', 'cloud run') && !jdHas('azure', 'microsoft azure')) {
      // Resume has Azure, JD wants ONLY GCP → swap
      swaps.push(...[
        ['Azure API Management (APIM)', 'Google Cloud Apigee'],
        ['Azure API Management', 'Google Cloud Apigee'],
        ['Azure API Gateway', 'Google Cloud Endpoints'],
        ['Azure App Services', 'Google Cloud Run'],
        ['Azure Functions v4', 'Google Cloud Functions'],
        ['Azure Functions', 'Google Cloud Functions'],
        ['Azure Blob Storage', 'Google Cloud Storage'],
        ['Azure SQL Database', 'Google Cloud SQL'],
        ['Azure SQL', 'Google Cloud SQL'],
        ['Azure AD B2C', 'Google Identity Platform'],
        ['Azure AD', 'Google Cloud IAM'],
        ['Azure Monitor', 'Google Cloud Monitoring'],
        ['Application Insights', 'Google Cloud Trace'],
        ['Azure Key Vault', 'Google Secret Manager'],
        ['Azure DevOps CI/CD pipelines', 'Google Cloud Build CI/CD pipelines'],
        ['Azure DevOps', 'Google Cloud Build'],
        ['Azure Repos', 'Google Cloud Source Repositories'],
        ['Microsoft Azure', 'Google Cloud Platform (GCP)'],
        ['Azure services', 'GCP services'],
      ]);
    }
    // If JD has Azure OR has no cloud requirement → NO cloud swap
  }

  if (resumeHas('amazon web services', ' aws ') && !resumeHas('azure')) {
    if (jdHas('azure', 'microsoft azure') && !jdHas('aws', 'amazon')) {
      swaps.push(...[
        ['AWS Elastic Beanstalk', 'Azure App Services'],
        ['AWS Lambda', 'Azure Functions'],
        ['AWS API Gateway', 'Azure API Management'],
        ['Amazon S3', 'Azure Blob Storage'],
        ['Amazon RDS', 'Azure SQL Database'],
        ['AWS Cognito', 'Azure AD B2C'],
        ['AWS IAM', 'Azure AD'],
        ['Amazon CloudWatch', 'Azure Monitor'],
        ['AWS Secrets Manager', 'Azure Key Vault'],
        ['AWS CodePipeline', 'Azure DevOps'],
        ['AWS CodeCommit', 'Azure Repos'],
        ['Amazon Web Services (AWS)', 'Microsoft Azure'],
      ]);
    } else if (jdHas('gcp', 'google cloud') && !jdHas('aws', 'amazon')) {
      swaps.push(...[
        ['AWS Elastic Beanstalk', 'Google Cloud Run'],
        ['AWS Lambda', 'Google Cloud Functions'],
        ['AWS API Gateway', 'Google Cloud Endpoints'],
        ['Amazon S3', 'Google Cloud Storage'],
        ['Amazon RDS', 'Google Cloud SQL'],
        ['AWS Cognito', 'Google Identity Platform'],
        ['AWS IAM', 'Google Cloud IAM'],
        ['Amazon CloudWatch', 'Google Cloud Monitoring'],
        ['AWS CodePipeline', 'Google Cloud Build'],
        ['Amazon Web Services (AWS)', 'Google Cloud Platform (GCP)'],
      ]);
    }
  }

  if (resumeHas('google cloud', 'gcp')) {
    if (jdHas('aws', 'amazon web services') && !jdHas('gcp', 'google cloud')) {
      swaps.push(...[
        ['Google Cloud Run', 'AWS Elastic Beanstalk'],
        ['Google Cloud Functions', 'AWS Lambda'],
        ['Google Cloud Endpoints', 'AWS API Gateway'],
        ['Google Cloud Storage', 'Amazon S3'],
        ['Google Cloud SQL', 'Amazon RDS'],
        ['Google Identity Platform', 'AWS Cognito'],
        ['Google Cloud IAM', 'AWS IAM'],
        ['Google Cloud Monitoring', 'Amazon CloudWatch'],
        ['Google Cloud Build', 'AWS CodePipeline'],
        ['Google Cloud Platform (GCP)', 'Amazon Web Services (AWS)'],
        ['GCP services', 'AWS services'],
      ]);
    } else if (jdHas('azure', 'microsoft azure') && !jdHas('gcp', 'google cloud')) {
      swaps.push(...[
        ['Google Cloud Run', 'Azure App Services'],
        ['Google Cloud Functions', 'Azure Functions'],
        ['Google Cloud Storage', 'Azure Blob Storage'],
        ['Google Cloud SQL', 'Azure SQL Database'],
        ['Google Identity Platform', 'Azure AD B2C'],
        ['Google Cloud IAM', 'Azure AD'],
        ['Google Cloud Monitoring', 'Azure Monitor'],
        ['Google Cloud Build', 'Azure DevOps'],
        ['Google Cloud Platform (GCP)', 'Microsoft Azure'],
      ]);
    }
  }

  // ── FRONTEND DETECTION ───────────────────────────────────────────────────
  // Only swap frontend if JD explicitly requires a DIFFERENT framework

  if (resumeHas('angular') && !resumeHas('react') &&
      jdHas('react', 'react.js', 'reactjs') && !jdHas('angular')) {
    swaps.push(...[
      ['Angular 14 to Angular 18', 'React 17 to React 18'],
      ['Angular 14\u201318', 'React 17\u201318'],
      ['Angular 14, progressively upgrading to Angular 18', 'React 17, progressively upgrading to React 18'],
      ['Angular 12 to Angular 15', 'React 16 to React 18'],
      ['Angular 12\u201315', 'React 16\u201318'],
      ['Angular (11\u201318)', 'React (16\u201318)'],
      ['Angular 12 front-end', 'React 17 front-end'],
      ['Angular 19', 'React 19'],
      ['Angular 18', 'React 18'],
      ['Angular 17', 'React 18'],
      ['Angular 16', 'React 18'],
      ['Angular 15', 'React 18'],
      ['Angular 14', 'React 18'],
      ['Angular 12', 'React 17'],
      ['Angular 6', 'React 16'],
      ['AngularJS', 'React.js'],
      ['Angular', 'React'],
      ['RxJS 7 to 8', 'Redux Toolkit'],
      ['RxJS 7\u20138', 'Redux Toolkit'],
      ['RxJS', 'Redux Toolkit'],
      ['Karma', 'Jest'],
      ['Jasmine', 'React Testing Library'],
      ['Protractor', 'Cypress'],
    ]);
  }

  if (resumeHas('react') && !resumeHas('angular') &&
      jdHas('angular') && !jdHas('react')) {
    swaps.push(...[
      ['React 17 to React 18', 'Angular 14 to Angular 18'],
      ['React 18', 'Angular 18'],
      ['React 17', 'Angular 14'],
      ['React.js', 'Angular'],
      ['React', 'Angular'],
      ['Redux Toolkit', 'RxJS'],
      ['Jest', 'Karma'],
      ['React Testing Library', 'Jasmine'],
      ['Cypress', 'Protractor'],
    ]);
  }

  if (resumeHas('angular') && jdHas('vue', 'vue.js', 'vuejs') && !jdHas('angular')) {
    swaps.push(...[
      ['Angular 14 to Angular 18', 'Vue 2 to Vue 3'],
      ['Angular 18', 'Vue 3'], ['Angular 14', 'Vue 3'],
      ['Angular 12', 'Vue 2'], ['Angular', 'Vue.js'],
      ['RxJS', 'Vuex / Pinia'], ['Karma', 'Vitest'], ['Jasmine', 'Vue Test Utils'],
    ]);
  }

  // Sort longest first so specific phrases replace before generic ones
  swaps.sort((a, b) => b[0].length - a[0].length);

  console.log(`Detected ${swaps.length} swaps from JD analysis`);
  return swaps;
}

// ── STEP 3: Apply everything to DOCX ─────────────────────────────────────────
function applyToDocx(docxBuffer, instructions, resumeText, jdText, detectedSwaps) {
  const zip = new AdmZip(docxBuffer);
  const docEntry = zip.getEntry('word/document.xml');
  if (!docEntry) throw new Error('Invalid DOCX');

  let xml = docEntry.getData().toString('utf-8');

  // Find older clients boundary — NEVER touch beyond this
  const olderClientMarkers = [
    'Fannie Mae', 'LuluLemon', 'Lulu Lemon', 'Infosys', 'Wipro', 'TCS',
    'Cognizant', 'Accenture', 'Capgemini', 'Apollo', 'LAHD', 'Citigroup', 'Apple'
  ];
  let olderBoundary = xml.length;
  for (const marker of olderClientMarkers) {
    if (resumeText.includes(marker)) {
      const idx = xml.indexOf(marker);
      if (idx > 0 && idx < olderBoundary) olderBoundary = idx;
    }
  }

  const swapsApplied = [];
  const removedBullets = [];
  const addedBullets = [];

  // Apply detected swaps ONLY before older boundary
  for (const [from, to] of detectedSwaps) {
    const before = xml.slice(0, olderBoundary);
    const older = xml.slice(olderBoundary);
    const newBefore = applyTextSwap(before, from, to);
    if (newBefore !== before) {
      xml = newBefore + older;
      swapsApplied.push(`${from.slice(0, 35)} → ${to.slice(0, 35)}`);
    }
  }

  // Apply removals ONLY before older boundary
  for (const removal of (instructions.remove || [])) {
    if (!removal.find) continue;
    const snippet = removal.find.trim().slice(0, 50);
    const snippetIdx = xml.indexOf(snippet);
    if (snippetIdx === -1 || snippetIdx >= olderBoundary) continue;
    const newXml = removeParagraph(xml, snippet);
    if (newXml !== xml) {
      xml = newXml;
      removedBullets.push(snippet);
      // Update boundary after removal
      olderBoundary = Math.max(0, olderBoundary - (xml.length - newXml.length + (xml.length - newXml.length)));
    }
  }

  // Apply additions ONLY before older boundary
  let currentParas = extractParagraphs(xml);
  for (const addition of (instructions.add || [])) {
    if (!addition.text || !addition.insertAfter) continue;
    const afterSnippet = addition.insertAfter.trim().slice(0, 50);
    const templatePara = currentParas.find(p =>
      p.text.includes(afterSnippet) && p.index < olderBoundary
    );
    if (!templatePara) { console.log(`insertAfter not found: "${afterSnippet}"`); continue; }
    const newBulletXml = buildBulletPara(addition.text, addition.techTerms || [], templatePara.xml);
    const newXml = insertAfterParagraph(xml, afterSnippet, newBulletXml, currentParas);
    if (newXml !== xml) {
      xml = newXml;
      addedBullets.push(addition.text.slice(0, 60));
      currentParas = extractParagraphs(xml);
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

    const jdText = jobDescription.trim();
    const ext = path.extname(req.file.originalname).toLowerCase();
    const resumeText = await extractText(req.file.buffer, req.file.originalname);

    // Step 1: Claude identifies missing keywords and weak points (NO swaps)
    const analysis = await analyzeWithClaude(resumeText, jdText);

    // Step 2: Code detects technology swaps from JD vs resume (rule-based, no AI)
    const detectedSwaps = detectSwaps(resumeText, jdText);

    // Step 3: Apply everything to DOCX
    let docxBase64 = null;
    let swapsApplied = [], removedBullets = [], addedBullets = [];

    if (ext === '.docx') {
      try {
        const result = applyToDocx(req.file.buffer, analysis, resumeText, jdText, detectedSwaps);
        docxBase64 = result.buffer.toString('base64');
        swapsApplied = result.swapsApplied;
        removedBullets = result.removedBullets;
        addedBullets = result.addedBullets;
        console.log(`Done: ${swapsApplied.length} swaps, ${removedBullets.length} removed, ${addedBullets.length} added`);
      } catch (err) { console.error('DOCX error:', err.message); }
    }

    const changes = [
      ...swapsApplied.map(s => ({ type: 'modified', description: `Tech updated: ${s}` })),
      ...removedBullets.map(r => ({ type: 'removed', description: `Removed: ${r}` })),
      ...addedBullets.map(a => ({ type: 'added', description: `Added: ${a}` })),
    ];
    if (changes.length === 0) changes.push({ type: 'added', description: analysis.summary || 'Resume optimized' });

    const entry = {
      id: `opt_${Date.now()}`,
      jdSnippet: jdText.slice(0, 200),
      matchScore: analysis.matchScoreAfter || 93,
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
      matchScore: analysis.matchScoreAfter || 93,
      changes,
      keywordsAdded: addedBullets.length + swapsApplied.length,
      bulletsEnhanced: addedBullets.length,
      sectionsImproved: Math.min(swapsApplied.length + addedBullets.length, 6),
      swapsApplied,
      removedCount: removedBullets.length,
      addedCount: addedBullets.length,
      jdStack: { swapsDetected: detectedSwaps.length, roleType: analysis.roleType },
      summary: analysis.summary || ''
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
