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

// ── TECH STACK SWAP MAPS ─────────────────────────────────────────────────────
const SWAPS = {
  azure_to_aws: [
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
  ],
  azure_to_gcp: [
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
  ],
  angular_to_react: [
    ['Angular 14 to Angular 18', 'React 17 to React 18'],
    ['Angular 14\u201318', 'React 17\u201318'],
    ['Angular 14, progressively upgrading to Angular 18', 'React 17, progressively upgrading to React 18'],
    ['Angular 12 to Angular 15', 'React 16 to React 18'],
    ['Angular 12\u201315', 'React 16\u201318'],
    ['Angular 14', 'React 18'],
    ['Angular 15', 'React 18'],
    ['Angular 18', 'React 18'],
    ['Angular 12', 'React 17'],
    ['Angular 6', 'React 16'],
    ['Angular (11\u201318)', 'React (16\u201318)'],
    ['AngularJS', 'React.js'],
    ['Angular', 'React'],
    ['RxJS 7 to 8', 'Redux Toolkit'],
    ['RxJS 7.x', 'Redux Toolkit'],
    ['RxJS 7\u20138', 'Redux Toolkit'],
    ['RxJS', 'Redux Toolkit'],
    ['Karma', 'Jest'],
    ['Jasmine', 'React Testing Library'],
    ['Protractor', 'Cypress'],
  ],
  angular_to_vue: [
    ['Angular 14 to Angular 18', 'Vue 2 to Vue 3'],
    ['Angular 14', 'Vue 3'],
    ['Angular 18', 'Vue 3'],
    ['Angular 12', 'Vue 2'],
    ['Angular', 'Vue.js'],
    ['RxJS 7 to 8', 'Pinia'],
    ['RxJS', 'Vuex / Pinia'],
    ['Karma', 'Vitest'],
    ['Jasmine', 'Vue Test Utils'],
    ['Protractor', 'Cypress'],
  ],
  azuredevops_to_jenkins: [
    ['Azure DevOps CI/CD pipelines', 'Jenkins CI/CD pipelines'],
    ['Azure DevOps CI/CD', 'Jenkins CI/CD'],
    ['Azure DevOps', 'Jenkins'],
  ],
  azuredevops_to_github: [
    ['Azure DevOps CI/CD pipelines', 'GitHub Actions CI/CD pipelines'],
    ['Azure DevOps CI/CD', 'GitHub Actions CI/CD'],
    ['Azure DevOps', 'GitHub Actions'],
    ['Azure Repos', 'GitHub'],
  ],
};

// Weak bullets to always remove regardless of JD
const ALWAYS_REMOVE = [
  'Standardized client-server communication using JSON, ensuring lightweight data exchange',
  'Standardized all client-server communication using JSON, ensuring lightweight, structured data exchange',
  'Standardized all data transmission using JSON, ensuring consistency',
  'Defined and documented data elements, schemas, and metadata into structured data dictionaries',
  'Built data pipelines to support reporting, audit logging, and patient care reminders',
  'Enhanced test traceability and defect lifecycle management using Microfocus ALM Octane',
  'Managed data serialization and deserialization in JSON format for asynchronous client-side updates',
  'Utilized TypeScript 0.8 for modular scripting',
  'Maintained version control using Apache Subversion (SVN)',
  'Used Visual Studio 2010',
  'avoiding NodeJS to maintain architectural consistency',
];

// ── Parse JD ─────────────────────────────────────────────────────────────────
async function parseJD(jdText) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    system: 'Analyze job descriptions. Return ONLY valid JSON, no markdown, no extra text.',
    messages: [{
      role: 'user',
      content: `Return ONLY this JSON for this JD:
{"cloud":"aws"|"azure"|"gcp"|"none","frontend":"react"|"angular"|"vue"|"none","backend":"dotnet"|"java"|"node"|"none","cicd":"jenkins"|"github_actions"|"azure_devops"|"none","missingKeywords":["up to 5 important keywords from JD not commonly in .NET resumes"]}
JD: ${jdText.slice(0, 1500)}`
    }]
  });
  const raw = message.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  try {
    return JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
  } catch {
    return { cloud: 'none', frontend: 'none', backend: 'dotnet', cicd: 'none', missingKeywords: [] };
  }
}

// ── Pure Node.js DOCX processor ──────────────────────────────────────────────
function processDocx(docxBuffer, jdStack) {
  const zip = new AdmZip(docxBuffer);
  const docEntry = zip.getEntry('word/document.xml');
  if (!docEntry) throw new Error('Invalid DOCX file');

  let xml = docEntry.getData().toString('utf-8');

  // Build swap list based on JD stack
  let swapList = [];
  if (jdStack.cloud === 'aws') swapList = [...swapList, ...SWAPS.azure_to_aws];
  else if (jdStack.cloud === 'gcp') swapList = [...swapList, ...SWAPS.azure_to_gcp];
  if (jdStack.frontend === 'react') swapList = [...swapList, ...SWAPS.angular_to_react];
  else if (jdStack.frontend === 'vue') swapList = [...swapList, ...SWAPS.angular_to_vue];
  if (jdStack.cicd === 'jenkins') swapList = [...swapList, ...SWAPS.azuredevops_to_jenkins];
  else if (jdStack.cicd === 'github_actions') swapList = [...swapList, ...SWAPS.azuredevops_to_github];

  // Sort by length desc so longer phrases replace first
  swapList.sort((a, b) => b[0].length - a[0].length);

  const swapsApplied = [];
  const countyIdx = xml.indexOf('County of San Bernardino');
  const fannieIdx = xml.indexOf('Fannie Mae');

  if (countyIdx > 0 && fannieIdx > countyIdx && swapList.length > 0) {
    const before = xml.slice(0, countyIdx);
    let scope = xml.slice(countyIdx, fannieIdx);
    const after = xml.slice(fannieIdx);
    for (const [from, to] of swapList) {
      if (scope.includes(from)) {
        scope = scope.split(from).join(to);
        swapsApplied.push(`${from} → ${to}`);
      }
    }
    xml = before + scope + after;
  }

  // Remove weak bullets — find and remove entire <w:p>...</w:p> containing weak text
  const removedBullets = [];
  for (const weakText of ALWAYS_REMOVE) {
    const snippet = weakText.slice(0, 50);
    const idx = xml.indexOf(snippet);
    if (idx === -1) continue;
    // Find start of paragraph
    let pStart = xml.lastIndexOf('<w:p ', idx);
    let pStart2 = xml.lastIndexOf('<w:p>', idx);
    const start = Math.max(pStart, pStart2);
    if (start === -1) continue;
    // Find end of paragraph
    const pEnd = xml.indexOf('</w:p>', idx);
    if (pEnd === -1) continue;
    xml = xml.slice(0, start) + xml.slice(pEnd + 6);
    removedBullets.push(weakText.slice(0, 60));
  }

  // Update the zip with modified XML
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf-8'));

  return {
    buffer: zip.toBuffer(),
    swapsApplied,
    removedBullets
  };
}

// ── Main optimization pipeline ────────────────────────────────────────────────
async function optimizeResume(fileBuffer, originalname, jobDescription) {
  const ext = path.extname(originalname).toLowerCase();
  const resumeText = await extractText(fileBuffer, originalname);

  // Step 1: Parse JD
  const jdStack = await parseJD(jobDescription);
  console.log('JD Stack:', jdStack);

  // Step 2: Process DOCX directly in Node.js (no Python needed)
  let docxBase64 = null;
  let swapsApplied = [];
  let removedBullets = [];

  if (ext === '.docx') {
    try {
      const result = processDocx(fileBuffer, jdStack);
      docxBase64 = result.buffer.toString('base64');
      swapsApplied = result.swapsApplied;
      removedBullets = result.removedBullets;
      console.log(`Swaps: ${swapsApplied.length}, Removed: ${removedBullets.length}`);
    } catch (err) {
      console.error('DOCX processing error:', err.message);
    }
  }

  // Step 3: Build changes list
  const changes = [
    ...swapsApplied.map(s => ({ type: 'modified', description: `Stack updated: ${s}` })),
    ...removedBullets.map(r => ({ type: 'removed', description: `Removed weak point: ${r}` })),
  ];

  if (changes.length === 0) {
    changes.push({ type: 'added', description: 'Resume analyzed — tech stack already matches JD or no swaps needed' });
  }

  // Calculate match score
  const baseScore = 75;
  const stackBonus = (jdStack.cloud !== 'none' ? 8 : 0) + (jdStack.frontend !== 'none' ? 7 : 0);
  const matchScore = Math.min(baseScore + stackBonus + swapsApplied.length, 95);

  return {
    docxBase64,
    optimizedResume: resumeText,
    matchScore,
    changes,
    keywordsAdded: swapsApplied.length,
    bulletsEnhanced: swapsApplied.length,
    sectionsImproved: swapsApplied.length > 0 ? 2 : 0,
    swapsApplied,
    removedCount: removedBullets.length,
    addedCount: 0,
    jdStack
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

// ══ OPTIMIZE ═════════════════════════════════════════════════════════════════
app.post('/api/resume/optimize', authMiddleware, optimizeLimiter, upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Resume file is required' });
    const { jobDescription } = req.body;
    if (!jobDescription || jobDescription.trim().length < 50)
      return res.status(400).json({ error: 'Job description must be at least 50 characters' });

    const result = await optimizeResume(req.file.buffer, req.file.originalname, jobDescription.trim());

    const entry = {
      id: `opt_${Date.now()}`,
      jdSnippet: jobDescription.trim().slice(0, 200),
      matchScore: result.matchScore,
      keywordsAdded: result.keywordsAdded,
      createdAt: new Date().toISOString(),
      resumeOutput: result.optimizedResume
    };
    if (!db.history[req.user.userId]) db.history[req.user.userId] = [];
    db.history[req.user.userId].unshift(entry);
    if (db.history[req.user.userId].length > 20) db.history[req.user.userId].pop();

    res.json({ success: true, ...result });
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
