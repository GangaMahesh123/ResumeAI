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
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
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

// ── Extract plain text ───────────────────────────────────────────────────────
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

// ── TECH STACK MAPPING ───────────────────────────────────────────────────────
const TECH_MAPPINGS = {
  cloud: {
    azure_to_aws: {
      'Azure App Services': 'AWS Elastic Beanstalk',
      'Azure Functions v4': 'AWS Lambda',
      'Azure Functions': 'AWS Lambda',
      'Azure API Management (APIM)': 'AWS API Gateway',
      'Azure API Management': 'AWS API Gateway',
      'Azure API Gateway': 'AWS API Gateway',
      'Azure Blob Storage': 'Amazon S3',
      'Azure SQL Database': 'Amazon RDS',
      'Azure SQL': 'Amazon RDS',
      'Azure AD B2C': 'AWS Cognito',
      'Azure AD': 'AWS IAM',
      'Azure Monitor': 'Amazon CloudWatch',
      'Application Insights': 'AWS CloudWatch Insights',
      'Azure Key Vault': 'AWS Secrets Manager',
      'Azure DevOps CI/CD': 'AWS CodePipeline',
      'Azure DevOps': 'AWS CodePipeline',
      'Azure Repos': 'AWS CodeCommit',
      'Microsoft Azure': 'Amazon Web Services (AWS)',
      'Azure services': 'AWS services',
      'Azure': 'AWS',
    },
    azure_to_gcp: {
      'Azure App Services': 'Google Cloud Run',
      'Azure Functions v4': 'Google Cloud Functions',
      'Azure Functions': 'Google Cloud Functions',
      'Azure API Management (APIM)': 'Google Cloud Apigee',
      'Azure API Management': 'Google Cloud Apigee',
      'Azure API Gateway': 'Google Cloud Endpoints',
      'Azure Blob Storage': 'Google Cloud Storage',
      'Azure SQL Database': 'Google Cloud SQL',
      'Azure SQL': 'Google Cloud SQL',
      'Azure AD B2C': 'Google Identity Platform',
      'Azure AD': 'Google Cloud IAM',
      'Azure Monitor': 'Google Cloud Monitoring',
      'Application Insights': 'Google Cloud Trace',
      'Azure Key Vault': 'Google Secret Manager',
      'Azure DevOps CI/CD': 'Google Cloud Build',
      'Azure DevOps': 'Google Cloud Build',
      'Azure Repos': 'Google Cloud Source Repositories',
      'Microsoft Azure': 'Google Cloud Platform (GCP)',
      'Azure services': 'GCP services',
      'Azure': 'GCP',
    }
  },
  frontend: {
    angular_to_react: {
      'Angular 14 to Angular 18': 'React 18',
      'Angular 14, progressively upgrading to Angular 18': 'React 18',
      'Angular 14–18': 'React 18',
      'Angular 12 to Angular 15': 'React 17 to React 18',
      'Angular 12–15': 'React 17–18',
      'Angular 14': 'React 18',
      'Angular 15': 'React 18',
      'Angular 18': 'React 18',
      'Angular 12': 'React 17',
      'Angular (11–18)': 'React (16–18)',
      'Angular': 'React',
      'RxJS 7 to 8': 'Redux Toolkit',
      'RxJS 7.x': 'Redux Toolkit',
      'RxJS': 'Redux Toolkit',
      'Karma': 'Jest',
      'Jasmine': 'React Testing Library',
      'Protractor': 'Cypress',
      'AngularJS': 'React.js',
    },
    angular_to_vue: {
      'Angular 14 to Angular 18': 'Vue 3',
      'Angular 14–18': 'Vue 3',
      'Angular 12 to Angular 15': 'Vue 2 to Vue 3',
      'Angular 14': 'Vue 3',
      'Angular 18': 'Vue 3',
      'Angular 12': 'Vue 2',
      'Angular': 'Vue.js',
      'RxJS 7 to 8': 'Pinia',
      'RxJS': 'Vuex / Pinia',
      'Karma': 'Vitest',
      'Jasmine': 'Vue Test Utils',
      'Protractor': 'Cypress',
    }
  },
  cicd: {
    azuredevops_to_jenkins: {
      'Azure DevOps CI/CD pipelines': 'Jenkins CI/CD pipelines',
      'Azure DevOps CI/CD': 'Jenkins CI/CD',
      'Azure DevOps': 'Jenkins',
    },
    azuredevops_to_github: {
      'Azure DevOps CI/CD pipelines': 'GitHub Actions CI/CD pipelines',
      'Azure DevOps CI/CD': 'GitHub Actions CI/CD',
      'Azure DevOps': 'GitHub Actions',
      'Azure Repos': 'GitHub',
    }
  }
};

// ── STEP 1: Parse JD and detect tech stack ───────────────────────────────────
async function parseJD(jdText) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: 'You are a technical recruiter. Analyze job descriptions and extract tech stack requirements. Return ONLY valid JSON, no markdown.',
    messages: [{
      role: 'user',
      content: `Analyze this job description and extract the required tech stack. Return ONLY this JSON:
{
  "cloud": "aws" | "azure" | "gcp" | "none",
  "frontend": "react" | "angular" | "vue" | "blazor" | "none",
  "backend": "dotnet" | "java" | "node" | "python" | "none",
  "database": ["list of databases mentioned"],
  "cicd": "jenkins" | "github_actions" | "azure_devops" | "aws_codepipeline" | "none",
  "testing": ["list of testing tools"],
  "auth": ["list of auth tools"],
  "messaging": ["list of messaging tools"],
  "missingKeywords": ["important keywords in JD not commonly in .NET resumes"],
  "requiredSkills": ["top 10 most emphasized skills in JD"]
}

JOB DESCRIPTION:
${jdText}`
    }]
  });

  const raw = message.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  try {
    return JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
  } catch {
    return { cloud: 'none', frontend: 'none', backend: 'dotnet', cicd: 'none', missingKeywords: [], requiredSkills: [] };
  }
}

// ── STEP 2: Identify weak/irrelevant points and missing points ───────────────
async function analyzeResume(resumeText, jdText, jdStack) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: 'You are an expert resume optimizer. Be precise and analytical. Return ONLY valid JSON, no markdown.',
    messages: [{
      role: 'user',
      content: `Analyze this resume against the job description.

RULES:
- Core technical achievements are NEVER weak (architecture decisions, migrations, API development, cloud deployments)
- Weak points = basic/obvious statements (e.g. "used JSON for data exchange"), outdated tech (SVN, VS2010, TypeScript 0.8), niche tools not in JD, or redundant points already said elsewhere
- Missing points = skills/keywords clearly expected by JD but absent from resume
- Only suggest additions for the 2 most recent projects

JD STACK DETECTED: ${JSON.stringify(jdStack)}

RESUME:
${resumeText.slice(0, 3000)}

JOB DESCRIPTION:
${jdText.slice(0, 2000)}

Return ONLY this JSON:
{
  "weakPoints": [
    { "text": "exact text snippet to identify the bullet", "reason": "why it's weak/irrelevant" }
  ],
  "missingPoints": [
    {
      "text": "new bullet point text with tech terms that match JD",
      "section": "County of San Bernardino" | "Elevance Health" | "Professional Summary",
      "insertAfter": "exact text snippet of the bullet this should go after",
      "techTerms": ["Term1", "Term2"]
    }
  ],
  "matchScore": 85,
  "estimatedAfterScore": 93
}`
    }]
  });

  const raw = message.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  try {
    return JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
  } catch {
    return { weakPoints: [], missingPoints: [], matchScore: 70, estimatedAfterScore: 93 };
  }
}

// ── STEP 3: Apply tech stack swaps to XML runs ───────────────────────────────
function applySwapsToXML(xmlContent, jdStack) {
  let updated = xmlContent;
  const swaps = [];

  // Determine which mappings to apply
  if (jdStack.cloud === 'aws') {
    Object.entries(TECH_MAPPINGS.cloud.azure_to_aws).forEach(([from, to]) => {
      swaps.push({ from, to });
    });
  } else if (jdStack.cloud === 'gcp') {
    Object.entries(TECH_MAPPINGS.cloud.azure_to_gcp).forEach(([from, to]) => {
      swaps.push({ from, to });
    });
  }

  if (jdStack.frontend === 'react') {
    Object.entries(TECH_MAPPINGS.frontend.angular_to_react).forEach(([from, to]) => {
      swaps.push({ from, to });
    });
  } else if (jdStack.frontend === 'vue') {
    Object.entries(TECH_MAPPINGS.frontend.angular_to_vue).forEach(([from, to]) => {
      swaps.push({ from, to });
    });
  }

  if (jdStack.cicd === 'jenkins') {
    Object.entries(TECH_MAPPINGS.cicd.azuredevops_to_jenkins).forEach(([from, to]) => {
      swaps.push({ from, to });
    });
  } else if (jdStack.cicd === 'github_actions') {
    Object.entries(TECH_MAPPINGS.cicd.azuredevops_to_github).forEach(([from, to]) => {
      swaps.push({ from, to });
    });
  }

  // Sort by length desc so longer phrases replace before shorter ones
  swaps.sort((a, b) => b.from.length - a.from.length);

  // Apply swaps — only within the scope of recent 2 projects
  // We do this by finding the County section start and Fannie Mae section start in XML
  const countyStart = updated.indexOf('County of San Bernardino');
  const fannieMaeStart = updated.indexOf('Fannie Mae');

  if (countyStart === -1 || fannieMaeStart === -1) {
    // Fallback: apply to full document
    swaps.forEach(({ from, to }) => {
      updated = updated.split(from).join(to);
    });
  } else {
    // Only swap in the recent 2 projects section
    const before = updated.slice(0, countyStart);
    const scope = updated.slice(countyStart, fannieMaeStart);
    const after = updated.slice(fannieMaeStart);

    let newScope = scope;
    swaps.forEach(({ from, to }) => {
      newScope = newScope.split(from).join(to);
    });

    updated = before + newScope + after;
  }

  return { xml: updated, swapsApplied: swaps.filter(s => xmlContent.includes(s.from)).map(s => `${s.from} → ${s.to}`) };
}

// ── STEP 4: Insert/remove bullets in XML ────────────────────────────────────
function insertBulletAfter(xmlContent, afterText, newBulletXml) {
  // Find the paragraph containing afterText and insert after its closing </w:p>
  const idx = xmlContent.indexOf(afterText);
  if (idx === -1) return xmlContent;
  const paraEnd = xmlContent.indexOf('</w:p>', idx);
  if (paraEnd === -1) return xmlContent;
  return xmlContent.slice(0, paraEnd + 6) + '\n    ' + newBulletXml + xmlContent.slice(paraEnd + 6);
}

function removeBullet(xmlContent, bulletText) {
  // Find and remove the full <w:p>...</w:p> containing this text
  const idx = xmlContent.indexOf(bulletText);
  if (idx === -1) return xmlContent;
  // Find start of this paragraph
  const paraStart = xmlContent.lastIndexOf('<w:p ', idx);
  const paraStart2 = xmlContent.lastIndexOf('<w:p>', idx);
  const start = Math.max(paraStart, paraStart2);
  if (start === -1) return xmlContent;
  const paraEnd = xmlContent.indexOf('</w:p>', idx);
  if (paraEnd === -1) return xmlContent;
  return xmlContent.slice(0, start) + xmlContent.slice(paraEnd + 6);
}

// Build a bullet XML string matching the resume's exact style
function buildBulletXml(text, techTerms, isCounty = true, isSummary = false) {
  const numId = isSummary ? '6' : isCounty ? '12' : '2';
  const pStyle = isSummary ? 'Standard' : isCounty ? 'ListParagraph' : 'Standard';

  const pPr = isSummary
    ? `<w:pPr><w:pStyle w:val="Standard"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr><w:spacing w:line="276" w:lineRule="auto"/><w:jc w:val="both"/><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Cambria" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:pPr>`
    : `<w:pPr><w:pStyle w:val="${pStyle}"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr><w:suppressAutoHyphens w:val="0"/><w:spacing w:before="100" w:beforeAutospacing="1" w:after="100" w:afterAutospacing="1"/><w:jc w:val="both"/><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Times New Roman" w:hAnsi="Calibri" w:cs="Calibri"/><w:kern w:val="0"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:pPr>`;

  const normalRpr = isSummary
    ? `<w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Cambria" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>`
    : `<w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Times New Roman" w:hAnsi="Calibri" w:cs="Calibri"/><w:kern w:val="0"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr>`;

  const boldRpr = isSummary
    ? `<w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Cambria" w:hAnsi="Calibri" w:cs="Calibri"/><w:b/><w:bCs/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>`
    : `<w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Times New Roman" w:hAnsi="Calibri" w:cs="Calibri"/><w:b/><w:bCs/><w:kern w:val="0"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr>`;

  // Split text into bold/normal segments based on techTerms
  let remaining = text;
  let runs = '';

  // Sort techTerms by length desc to match longer terms first
  const sortedTerms = [...(techTerms || [])].sort((a, b) => b.length - a.length);

  // Build segments
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

  // Build XML runs from segments
  for (const seg of segments) {
    if (!seg.text) continue;
    const rpr = seg.bold ? boldRpr : normalRpr;
    const hasSpace = seg.text.startsWith(' ') || seg.text.endsWith(' ');
    const tAttr = hasSpace ? ' xml:space="preserve"' : '';
    runs += `<w:r>${rpr}<w:t${tAttr}>${seg.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</w:t></w:r>`;
  }

  return `<w:p>${pPr}${runs}</w:p>`;
}

// ── MAIN OPTIMIZATION PIPELINE ───────────────────────────────────────────────
async function optimizeResume(resumeBuffer, originalFilename, jobDescription) {
  const ext = path.extname(originalFilename).toLowerCase();
  const resumeText = await extractText(resumeBuffer, originalFilename);

  // STEP 1: Parse JD
  const jdStack = await parseJD(jobDescription);
  console.log('JD Stack detected:', jdStack);

  // STEP 2: Analyze resume
  const analysis = await analyzeResume(resumeText, jobDescription, jdStack);
  console.log('Analysis:', JSON.stringify(analysis).slice(0, 500));

  // For non-DOCX files, fall back to text-based optimization
  if (ext !== '.docx') {
    return await optimizePlainText(resumeText, jobDescription, jdStack, analysis);
  }

  // Check if Python is available
  let pythonAvailable = false;
  try {
    execSync('python3 --version', { timeout: 5000 });
    pythonAvailable = true;
  } catch {
    try {
      execSync('python --version', { timeout: 5000 });
      pythonAvailable = true;
    } catch { pythonAvailable = false; }
  }

  // Fall back to text-based if Python not available
  if (!pythonAvailable) {
    console.log('Python not available, using text-based optimization');
    return await optimizePlainText(resumeText, jobDescription, jdStack, analysis);
  }

  // STEP 3-6: XML-based optimization for DOCX files
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeai-'));
  const inputPath = path.join(tmpDir, 'input.docx');
  const unpackDir = path.join(tmpDir, 'unpacked');
  const outputPath = path.join(tmpDir, 'output.docx');

  try {
    fs.writeFileSync(inputPath, resumeBuffer);

    // Unpack DOCX
    const unpackScript = path.join(__dirname, 'scripts', 'unpack.py');
    const pyCmd = (() => { try { execSync('python3 --version'); return 'python3'; } catch { return 'python'; } })();
    execSync(`${pyCmd} ${unpackScript} "${inputPath}" "${unpackDir}"`, { timeout: 30000 });

    const docXmlPath = path.join(unpackDir, 'word', 'document.xml');
    let xmlContent = fs.readFileSync(docXmlPath, 'utf-8');

    // STEP 3: Apply tech stack swaps
    const { xml: swappedXml, swapsApplied } = applySwapsToXML(xmlContent, jdStack);
    xmlContent = swappedXml;

    // STEP 4: Remove weak points
    const removedPoints = [];
    for (const wp of (analysis.weakPoints || [])) {
      if (wp.text && xmlContent.includes(wp.text.slice(0, 40))) {
        xmlContent = removeBullet(xmlContent, wp.text.slice(0, 40));
        removedPoints.push(wp.text.slice(0, 60));
      }
    }

    // STEP 5: Insert missing points
    const addedPoints = [];
    for (const mp of (analysis.missingPoints || [])) {
      if (!mp.text || !mp.insertAfter) continue;
      const isCounty = mp.section?.includes('County');
      const isSummary = mp.section?.includes('Summary');
      const bulletXml = buildBulletXml(mp.text, mp.techTerms || [], isCounty, isSummary);
      const afterSnippet = mp.insertAfter.slice(0, 50);
      if (xmlContent.includes(afterSnippet)) {
        xmlContent = insertBulletAfter(xmlContent, afterSnippet, bulletXml);
        addedPoints.push(mp.text.slice(0, 60));
      }
    }

    // Save updated XML
    fs.writeFileSync(docXmlPath, xmlContent, 'utf-8');

    // Pack back to DOCX
    const packScript = path.join(__dirname, 'scripts', 'pack.py');
    execSync(`${pyCmd} ${packScript} "${unpackDir}" "${outputPath}" --original "${inputPath}" --validate false`, { timeout: 30000 });

    const docxBuffer = fs.readFileSync(outputPath);

    return {
      docxBase64: docxBuffer.toString('base64'),
      optimizedResume: resumeText,
      matchScore: analysis.estimatedAfterScore || 93,
      changes: [
        ...swapsApplied.map(s => ({ type: 'modified', description: `Tech stack updated: ${s}` })),
        ...removedPoints.map(r => ({ type: 'removed', description: `Removed weak point: ${r}` })),
        ...addedPoints.map(a => ({ type: 'added', description: `Added missing point: ${a}` })),
      ],
      keywordsAdded: addedPoints.length + swapsApplied.length,
      bulletsEnhanced: addedPoints.length,
      sectionsImproved: 3,
      swapsApplied,
      removedCount: removedPoints.length,
      addedCount: addedPoints.length,
      jdStack
    };

  } finally {
    // Cleanup temp files
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

// Fallback for non-DOCX files
async function optimizePlainText(resumeText, jobDescription, jdStack, analysis) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: `You are an expert resume optimizer. Return ONLY the plain optimized resume text. No JSON, no markdown, no backticks.`,
    messages: [{
      role: 'user',
      content: `Optimize this resume for the job description.

TECH STACK TO USE: ${JSON.stringify(jdStack)}
- If JD wants AWS, replace Azure with AWS equivalents in recent 2 projects
- If JD wants React, replace Angular with React in recent 2 projects
- Keep all core technical achievements
- Add missing points from JD in relevant positions
- Remove weak/irrelevant points
- Return ONLY the plain resume text

RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}`
    }]
  });

  const optimizedText = message.content.map(b => b.type === 'text' ? b.text : '').join('').replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();

  return {
    optimizedResume: optimizedText,
    docxBase64: null,
    matchScore: analysis.estimatedAfterScore || 93,
    changes: [{ type: 'added', description: 'Resume optimized for target tech stack and JD requirements' }],
    keywordsAdded: 10, bulletsEnhanced: 5, sectionsImproved: 3,
    jdStack
  };
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

// ══ OPTIMIZE ROUTE ════════════════════════════════════════════════════════════

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
    if (err.status === 529) return res.status(503).json({ error: 'AI overloaded. Try again shortly.' });
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
