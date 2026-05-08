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

// ════════════════════════════════════════════════════════════════════
// FIX 1: WORD BOUNDARY MATCH — prevents 'rds' matching 'standards'
// ════════════════════════════════════════════════════════════════════
function wordMatch(text, term) {
  const tl = term.toLowerCase();
  const txt = text.toLowerCase();
  let idx = txt.indexOf(tl);
  while (idx !== -1) {
    const before = idx === 0 ? ' ' : txt[idx - 1];
    const after = idx + tl.length >= txt.length ? ' ' : txt[idx + tl.length];
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    idx = txt.indexOf(tl, idx + 1);
  }
  return false;
}
function textHasAny(text, ...terms) {
  return terms.some(t => wordMatch(text, t));
}

// ════════════════════════════════════════════════════════════════════
// FIX 2: FUZZY MATCH — finds closest paragraph even with minor diffs
// ════════════════════════════════════════════════════════════════════
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function findClosestParagraph(paras, target, maxBoundary = Infinity) {
  if (!target || target.length < 10) return null;
  const t = target.toLowerCase().trim().slice(0, 60);
  let best = null, bestScore = Infinity;
  for (const para of paras) {
    if (para.index >= maxBoundary) continue;
    if (para.text.length < 20) continue;
    const p = para.text.toLowerCase().slice(0, 60);
    // Exact include first
    if (para.text.toLowerCase().includes(t.slice(0, 40))) return para;
    // Fuzzy fallback
    const score = levenshtein(p, t);
    if (score < bestScore && score < 30) { bestScore = score; best = para; }
  }
  return best;
}

// ════════════════════════════════════════════════════════════════════
// SCOPE HELPERS
// ════════════════════════════════════════════════════════════════════
const OLDER_MARKERS = [
  'Fannie Mae','LuluLemon','Lulu Lemon','Infosys','Wipro','TCS',
  'Cognizant','Accenture','Capgemini','Apollo','LAHD','Citigroup','Apple'
];

function getRecentText(resumeText) {
  const lower = resumeText.toLowerCase();
  const starts = ['professional experience','county of san bernardino','client:','work experience'];
  let start = resumeText.length;
  for (const m of starts) { const i = lower.indexOf(m); if (i > 0 && i < start) start = i; }
  let end = resumeText.length;
  for (const m of OLDER_MARKERS) { const i = lower.indexOf(m.toLowerCase()); if (i > 0 && i < end) end = i; }
  return resumeText.slice(start, end);
}

function getOlderBoundary(xml, resumeText) {
  for (const m of OLDER_MARKERS) {
    if (resumeText.includes(m)) {
      const idx = xml.indexOf(m);
      if (idx > 0) return idx;
    }
  }
  return xml.length;
}

// ════════════════════════════════════════════════════════════════════
// XML HELPERS
// ════════════════════════════════════════════════════════════════════
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
    const escaped = seg.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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

function removeParagraph(xml, findText, boundary) {
  const paras = extractParagraphs(xml);
  for (const para of paras) {
    if (para.index >= boundary) continue;
    if (para.text.toLowerCase().includes(findText.toLowerCase().slice(0, 50)))
      return xml.slice(0, para.index) + xml.slice(para.index + para.xml.length);
  }
  return xml;
}

// ════════════════════════════════════════════════════════════════════
// FIX 3: CODE-BASED MATCH SCORE (not AI guess)
// ════════════════════════════════════════════════════════════════════
function calculateMatchScore(resumeText, jdText) {
  const jdWords = jdText.toLowerCase().match(/\b[a-z][a-z0-9#.\-+]{2,}\b/g) || [];
  const jdUnique = [...new Set(jdWords)].filter(w =>
    w.length > 3 && !['with','that','this','from','have','will','your','their','they','been','more','also','into','than','when','what','which','about','after','before','through','between'].includes(w)
  );
  const resumeLower = resumeText.toLowerCase();
  const matched = jdUnique.filter(w => resumeLower.includes(w));
  return Math.min(95, Math.round((matched.length / Math.max(jdUnique.length, 1)) * 100));
}

// ════════════════════════════════════════════════════════════════════
// FIX 4: TECH SWAP DETECTION — pure logic, no AI, word-boundary safe
// ════════════════════════════════════════════════════════════════════
function detectTechSwaps(resumeText, jdText) {
  const jd = jdText.toLowerCase();
  const recentText = getRecentText(resumeText).toLowerCase();
  const jdWants = (...terms) => textHasAny(jd, ...terms);
  const recentHas = (...terms) => textHasAny(recentText, ...terms);
  const swaps = [];

  // CLOUD: Azure → AWS (only if JD wants AWS AND NOT Azure)
  if (recentHas('azure') && jdWants('aws','amazon web services','ec2','lambda','dynamodb') && !jdWants('azure','microsoft azure')) {
    swaps.push(
      ['Azure API Management (APIM)','AWS API Gateway'],
      ['Azure API Management','AWS API Gateway'],
      ['Azure API Gateway (v2)','AWS API Gateway'],
      ['Azure API Gateway','AWS API Gateway'],
      ['Azure App Services','AWS Elastic Beanstalk'],
      ['Azure Functions v4','AWS Lambda'],
      ['Azure Functions','AWS Lambda'],
      ['Azure Blob Storage','Amazon S3'],
      ['Azure SQL Database','Amazon RDS'],
      ['Azure SQL','Amazon RDS'],
      ['Azure AD B2C','AWS Cognito'],
      ['Azure AD','AWS IAM'],
      ['Azure Monitor','Amazon CloudWatch'],
      ['Application Insights','AWS CloudWatch Insights'],
      ['Azure Key Vault','AWS Secrets Manager'],
      ['Azure DevOps CI/CD pipelines','AWS CodePipeline CI/CD pipelines'],
      ['Azure DevOps CI/CD','AWS CodePipeline'],
      ['Azure DevOps','AWS CodePipeline'],
      ['Azure Repos','AWS CodeCommit'],
      ['Microsoft Azure','Amazon Web Services (AWS)'],
      ['Azure services','AWS services']
    );
  }
  // CLOUD: Azure → GCP
  if (recentHas('azure') && jdWants('gcp','google cloud','bigquery','vertex ai','cloud run') && !jdWants('azure','microsoft azure')) {
    swaps.push(
      ['Azure API Management (APIM)','Google Cloud Apigee'],
      ['Azure API Management','Google Cloud Apigee'],
      ['Azure API Gateway','Google Cloud Endpoints'],
      ['Azure App Services','Google Cloud Run'],
      ['Azure Functions v4','Google Cloud Functions'],
      ['Azure Functions','Google Cloud Functions'],
      ['Azure Blob Storage','Google Cloud Storage'],
      ['Azure SQL Database','Google Cloud SQL'],
      ['Azure SQL','Google Cloud SQL'],
      ['Azure AD B2C','Google Identity Platform'],
      ['Azure AD','Google Cloud IAM'],
      ['Azure Monitor','Google Cloud Monitoring'],
      ['Application Insights','Google Cloud Trace'],
      ['Azure Key Vault','Google Secret Manager'],
      ['Azure DevOps CI/CD pipelines','Google Cloud Build CI/CD pipelines'],
      ['Azure DevOps','Google Cloud Build'],
      ['Azure Repos','Google Cloud Source Repositories'],
      ['Microsoft Azure','Google Cloud Platform (GCP)'],
      ['Azure services','GCP services']
    );
  }
  // CLOUD: AWS → Azure
  if (recentHas('amazon web services','aws elastic','aws lambda') && jdWants('azure','microsoft azure') && !jdWants('aws','amazon')) {
    swaps.push(
      ['AWS Elastic Beanstalk','Azure App Services'],['AWS Lambda','Azure Functions'],
      ['AWS API Gateway','Azure API Management'],['Amazon S3','Azure Blob Storage'],
      ['Amazon RDS','Azure SQL Database'],['AWS Cognito','Azure AD B2C'],
      ['AWS IAM','Azure AD'],['Amazon CloudWatch','Azure Monitor'],
      ['AWS Secrets Manager','Azure Key Vault'],['AWS CodePipeline','Azure DevOps'],
      ['AWS CodeCommit','Azure Repos'],['Amazon Web Services (AWS)','Microsoft Azure']
    );
  }
  // CLOUD: AWS → GCP
  if (recentHas('amazon web services','aws') && jdWants('gcp','google cloud') && !jdWants('aws','amazon')) {
    swaps.push(
      ['AWS Elastic Beanstalk','Google Cloud Run'],['AWS Lambda','Google Cloud Functions'],
      ['Amazon S3','Google Cloud Storage'],['Amazon RDS','Google Cloud SQL'],
      ['AWS Cognito','Google Identity Platform'],['AWS IAM','Google Cloud IAM'],
      ['Amazon CloudWatch','Google Cloud Monitoring'],['AWS CodePipeline','Google Cloud Build'],
      ['Amazon Web Services (AWS)','Google Cloud Platform (GCP)']
    );
  }
  // CLOUD: GCP → AWS
  if (recentHas('google cloud','gcp') && jdWants('aws','amazon') && !jdWants('gcp','google cloud')) {
    swaps.push(
      ['Google Cloud Run','AWS Elastic Beanstalk'],['Google Cloud Functions','AWS Lambda'],
      ['Google Cloud Storage','Amazon S3'],['Google Cloud SQL','Amazon RDS'],
      ['Google Identity Platform','AWS Cognito'],['Google Cloud IAM','AWS IAM'],
      ['Google Cloud Monitoring','Amazon CloudWatch'],['Google Cloud Build','AWS CodePipeline'],
      ['Google Cloud Platform (GCP)','Amazon Web Services (AWS)']
    );
  }
  // CLOUD: GCP → Azure
  if (recentHas('google cloud','gcp') && jdWants('azure','microsoft azure') && !jdWants('gcp','google cloud')) {
    swaps.push(
      ['Google Cloud Run','Azure App Services'],['Google Cloud Functions','Azure Functions'],
      ['Google Cloud Storage','Azure Blob Storage'],['Google Cloud SQL','Azure SQL Database'],
      ['Google Identity Platform','Azure AD B2C'],['Google Cloud IAM','Azure AD'],
      ['Google Cloud Monitoring','Azure Monitor'],['Google Cloud Build','Azure DevOps'],
      ['Google Cloud Platform (GCP)','Microsoft Azure']
    );
  }

  // FRONTEND: Angular → React (check recentHas to avoid old React.js blocking)
  if (recentHas('angular') && !recentHas('react') && jdWants('react','reactjs','react.js') && !jdWants('angular')) {
    swaps.push(
      ['Angular 14 to Angular 18','React 17 to React 18'],
      ['Angular 14\u201318','React 17\u201318'],
      ['Angular 14, progressively upgrading to Angular 18','React 17, progressively upgrading to React 18'],
      ['Angular 12 to Angular 15','React 16 to React 18'],
      ['Angular 12\u201315','React 16\u201318'],
      ['Angular (11\u201318)','React (16\u201318)'],
      ['Angular 12 front-end','React 17 front-end'],
      ['Angular 12 front','React 17 front'],
      ['Angular 19','React 19'],['Angular 18','React 18'],
      ['Angular 17','React 18'],['Angular 16','React 18'],
      ['Angular 15','React 18'],['Angular 14','React 18'],
      ['Angular 12','React 17'],['Angular 6','React 16'],
      ['AngularJS','React.js'],['Angular','React'],
      ['RxJS 7 to 8','Redux Toolkit'],['RxJS 7\u20138','Redux Toolkit'],
      ['RxJS 7.x','Redux Toolkit'],['RxJS','Redux Toolkit'],
      ['Karma','Jest'],['Jasmine','React Testing Library'],['Protractor','Cypress']
    );
  }
  // FRONTEND: React → Angular
  if (recentHas('react') && !recentHas('angular') && jdWants('angular') && !jdWants('react','reactjs')) {
    swaps.push(
      ['React 17 to React 18','Angular 14 to Angular 18'],
      ['React 18','Angular 18'],['React 17','Angular 14'],['React 16','Angular 12'],
      ['React.js','Angular'],['React','Angular'],
      ['Redux Toolkit','RxJS'],['Redux','RxJS'],
      ['Jest','Karma'],['React Testing Library','Jasmine'],['Cypress','Protractor']
    );
  }
  // FRONTEND: Angular → Vue
  if (recentHas('angular') && !recentHas('vue') && jdWants('vue','vue.js','vuejs') && !jdWants('angular')) {
    swaps.push(
      ['Angular 14 to Angular 18','Vue 2 to Vue 3'],
      ['Angular 14','Vue 3'],['Angular 18','Vue 3'],['Angular 12','Vue 2'],
      ['Angular','Vue.js'],['RxJS','Vuex / Pinia'],
      ['Karma','Vitest'],['Jasmine','Vue Test Utils']
    );
  }

  // Sort longest first, deduplicate
  swaps.sort((a, b) => b[0].length - a[0].length);
  const seen = new Set();
  return swaps.filter(([f]) => { if (seen.has(f)) return false; seen.add(f); return true; });
}

// ════════════════════════════════════════════════════════════════════
// FIX 5: SIMPLIFIED CLAUDE PROMPT — AI only extracts skills + bullets
//         No insertAfter, no placement, no structural decisions
// ════════════════════════════════════════════════════════════════════
async function analyzeWithClaude(resumeText, jdText) {
  const attempt = async () => {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      system: `You are a precise resume gap analyzer. Your job is to achieve 92-95% JD match.

STEP 1 — EXTRACT: List every skill/tool/technology from the JD.
STEP 2 — CHECK: For each one, search the ENTIRE resume text. If it exists ANYWHERE — skip it, do NOT add it again.
STEP 3 — IDENTIFY REAL GAPS: Only skills that are completely absent from the resume.
STEP 4 — WRITE BULLETS: For each real gap, write a realistic bullet.

CRITICAL RULES FOR BULLETS:
- Each bullet MUST be realistic for the specific project it will go into
- You will be told which are the recent 2 projects — bullets must fit those projects' domain, tech stack, and cloud provider
- If project uses Azure — do NOT write AWS bullets for it
- If project is a government/county system — do NOT add payment processing, Go, or enterprise fintech patterns
- If project uses Angular — do NOT switch to React unless JD explicitly requires React and project already has React context
- Match the candidate's existing writing style exactly
- Bullets must be interview-defensible — a real engineer could explain this in detail
- Do NOT add a skill the candidate clearly has no background in based on the resume

RULES FOR DISTRIBUTION:
- Tag each bullet with "project": "recent1" or "project": "recent2"
- Distribute bullets across BOTH recent projects based on which fits better contextually
- Do NOT dump all bullets into one project
- Balance: if 6 bullets needed → 3 for recent1, 3 for recent2

RULES FOR REMOVALS:
- Only remove bullets that are COMPLETELY irrelevant to this JD
- Only remove from recent 2 projects
- Never remove core tech achievements, architecture decisions, or quantified results

Return ONLY valid JSON, no markdown.`,
      messages: [{
        role: 'user',
        content: `Analyze this resume against the JD. Find ONLY the genuinely missing skills and write realistic bullets.

RESUME:
${resumeText.slice(0, 6000)}

JOB DESCRIPTION:
${jdText.slice(0, 2000)}

INSTRUCTIONS:
1. First identify the 2 most recent projects from the resume (name them)
2. For each JD skill — search the ENTIRE resume text first. Only flag as missing if truly absent.
3. For each missing skill — write a bullet that fits naturally into one of the 2 recent projects
4. Tag each bullet with which project it belongs to ("recent1" or "recent2")
5. Distribute bullets across both projects — do NOT put everything in recent1
6. Make every bullet realistic for that project's domain and tech stack

Return ONLY this JSON:
{
  "roleType": "full_stack|backend|frontend|devops|data_engineer|ml_engineer|other",
  "recentProject1": "name of most recent project/client",
  "recentProject2": "name of second most recent project/client",
  "missingSkills": [
    {
      "skill": "exact skill name from JD",
      "bullet": "complete realistic bullet text — no markdown bold — matches candidate writing style",
      "techTerms": ["Term1", "Term2"],
      "category": "frontend|backend|cloud|database|devops|testing|security|other",
      "project": "recent1 or recent2 — which project this bullet belongs to",
      "reason": "why this fits this project specifically"
    }
  ],
  "weakBullets": [
    {
      "snippet": "first 40 chars of weak bullet from resume",
      "reason": "why irrelevant to this JD"
    }
  ],
  "summary": "X missing skills added across 2 projects"
}`
      }]
    });
    const raw = message.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
    const cleaned = raw.replace(/```json\n?|```\n?/g, '').trim();
    return JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
  };

  // FIX 6: RETRY with fallback
  for (let i = 0; i < 3; i++) {
    try {
      const result = await attempt();
      console.log(`Claude: ${result.missingSkills?.length||0} missing, ${result.weakBullets?.length||0} weak`);
      return result;
    } catch (e) {
      console.error(`Claude attempt ${i+1} failed:`, e.message);
      if (i === 2) return { missingSkills: [], weakBullets: [], roleType: 'full_stack', summary: '' };
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// FIX 7: VALIDATION LAYER — validate and repair AI output
// ════════════════════════════════════════════════════════════════════
function validateAIOutput(aiOutput) {
  if (!aiOutput || typeof aiOutput !== 'object') {
    return { missingSkills: [], weakBullets: [], roleType: 'full_stack', summary: '' };
  }
  return {
    roleType: aiOutput.roleType || 'full_stack',
    summary: aiOutput.summary || '',
    missingSkills: (aiOutput.missingSkills || []).filter(s =>
      s && s.skill && s.bullet && s.bullet.length > 20 && s.bullet.length < 500
    ),
    weakBullets: (aiOutput.weakBullets || []).filter(w =>
      w && w.snippet && w.snippet.length > 10
    )
  };
}

// ════════════════════════════════════════════════════════════════════
// FIX 8: CODE-DRIVEN PLACEMENT — backend decides where bullets go
//         No more insertAfter from AI — fuzzy match finds best position
// ════════════════════════════════════════════════════════════════════
function decidePlacement(skill, paras, olderBoundary, resumeText, recentProject1Name, recentProject2Name) {
  const cat = (skill.category || '').toLowerCase();
  const skillLower = (skill.skill || '').toLowerCase();
  const bulletLower = (skill.bullet || '').toLowerCase();
  const projectTag = (skill.project || 'recent1').toLowerCase(); // 'recent1' or 'recent2'

  // ── Find boundaries of each recent project ──────────────────────────────────
  // Project 1 = most recent (starts at first client marker, ends at second client marker)
  // Project 2 = second most recent (starts at second client marker, ends at older boundary)

  const skipMarkers = ['Technical Skills', 'Professional Summary', 'Summary:', 'Technical Skills:'];

  // Find project start indices in paras
  let p1Start = -1, p2Start = -1;
  const clientMarkers = [];

  for (const para of paras) {
    const t = para.text;
    // A client header line — "Client:" or contains client name
    if ((t.startsWith('Client:') || t.includes('Client :') || t.includes('Client:')) && para.index < olderBoundary) {
      clientMarkers.push(para.index);
    }
    // Also detect by project names Claude identified
    if (recentProject1Name && t.includes(recentProject1Name) && para.index < olderBoundary) {
      if (p1Start === -1) p1Start = para.index;
    }
    if (recentProject2Name && t.includes(recentProject2Name) && para.index < olderBoundary) {
      if (p2Start === -1) p2Start = para.index;
    }
  }

  // If we found project names, use them; otherwise fall back to client markers
  if (p1Start === -1 && clientMarkers.length > 0) p1Start = clientMarkers[0];
  if (p2Start === -1 && clientMarkers.length > 1) p2Start = clientMarkers[1];

  // Determine which project's paragraphs to use
  let projectParas;
  if (projectTag === 'recent2' && p2Start > 0) {
    // Use paragraphs from project 2 start to older boundary
    projectParas = paras.filter(p =>
      p.index >= p2Start &&
      p.index < olderBoundary &&
      p.text.length > 40 &&
      !skipMarkers.some(m => p.text.includes(m))
    );
  } else {
    // Use paragraphs from project 1 start to project 2 start (or older boundary if no p2)
    const p1End = p2Start > 0 ? p2Start : olderBoundary;
    projectParas = paras.filter(p =>
      p.index >= p1Start &&
      p.index < p1End &&
      p.text.length > 40 &&
      !skipMarkers.some(m => p.text.includes(m))
    );
    // If no p1 paras found, fall back to all experience paras
    if (projectParas.length === 0) {
      const experienceStart = p1Start > 0 ? p1Start : (clientMarkers[0] || 0);
      projectParas = paras.filter(p =>
        p.index >= experienceStart &&
        p.index < olderBoundary &&
        p.text.length > 40 &&
        !skipMarkers.some(m => p.text.includes(m))
      );
    }
  }

  // ── Find best paragraph within the target project ──────────────────────────
  const categoryKeywords = {
    frontend: ['angular','react','vue','typescript','html','css','ui','frontend','interface','component','blazor'],
    backend: ['api','service','microservice','rest','asp.net','entity framework','linq','mvc','minimal api'],
    cloud: ['azure','aws','gcp','cloud','deploy','kubernetes','docker','container','app service'],
    database: ['sql','database','postgresql','mongodb','cosmos','redis','query','stored procedure'],
    devops: ['ci/cd','pipeline','jenkins','github actions','devops','terraform','bicep','iac','helm'],
    testing: ['test','xunit','jest','karma','jasmine','unit test','integration test','selenium','automation'],
    security: ['oauth','jwt','auth','security','rbac','ad b2c','cognito','key vault','tls'],
    other: []
  };

  const keywords = categoryKeywords[cat] || categoryKeywords.other;
  const allKeywords = [...keywords, skillLower, ...bulletLower.split(' ').filter(w => w.length > 4)];

  // Find best matching paragraph within target project
  for (const kw of allKeywords) {
    const match = projectParas.find(p => p.text.toLowerCase().includes(kw));
    if (match) return match;
  }

  // Fallback: last bullet of target project
  return projectParas[projectParas.length - 1] || null;
}

// ════════════════════════════════════════════════════════════════════
// MAIN DOCX PROCESSOR
// ════════════════════════════════════════════════════════════════════
function applyToDocx(docxBuffer, analysis, resumeText, detectedSwaps) {
  const zip = new AdmZip(docxBuffer);
  const docEntry = zip.getEntry('word/document.xml');
  if (!docEntry) throw new Error('Invalid DOCX file');

  let xml = docEntry.getData().toString('utf-8');
  const olderBoundary = getOlderBoundary(xml, resumeText);
  const swapsApplied = [], removedBullets = [], addedBullets = [];

  // 1. Apply tech swaps before older boundary
  for (const [from, to] of detectedSwaps) {
    const before = xml.slice(0, olderBoundary);
    const older = xml.slice(olderBoundary);
    const newBefore = applyTextSwap(before, from, to);
    if (newBefore !== before) {
      xml = newBefore + older;
      swapsApplied.push(`${from.slice(0,35)} → ${to.slice(0,35)}`);
    }
  }

  // 2. Remove weak bullets before older boundary
  for (const weak of (analysis.weakBullets || [])) {
    if (!weak.snippet || weak.snippet.length < 10) continue;
    const newXml = removeParagraph(xml, weak.snippet, olderBoundary);
    if (newXml !== xml) {
      xml = newXml;
      removedBullets.push(weak.snippet.slice(0, 50));
    }
  }

  // 3. Add missing skill bullets — code decides placement (no insertAfter from AI)
  let currentParas = extractParagraphs(xml);
  const addedSkills = new Set();

  for (const skill of (analysis.missingSkills || [])) {
    if (!skill.bullet || addedSkills.has(skill.skill)) continue;

    // Use code-driven placement
    const targetPara = decidePlacement(skill, currentParas, olderBoundary, resumeText, analysis.recentProject1 || '', analysis.recentProject2 || '');
    if (!targetPara) {
      console.log(`No placement found for: ${skill.skill}`);
      continue;
    }

    const newBulletXml = buildBulletPara(skill.bullet, skill.techTerms || [], targetPara.xml);
    const insertPos = targetPara.index + targetPara.xml.length;
    xml = xml.slice(0, insertPos) + newBulletXml + xml.slice(insertPos);
    addedBullets.push(skill.bullet.slice(0, 60));
    addedSkills.add(skill.skill);
    currentParas = extractParagraphs(xml); // refresh after each insert

    console.log(`Added [${skill.category}]: ${skill.skill}`);
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

    // Step 1: Code detects tech swaps (pure logic, no AI, word-boundary safe)
    const detectedSwaps = detectTechSwaps(resumeText, jdText);

    // Step 2: Claude finds missing skills and weak bullets only (no placement, no swaps)
    const rawAnalysis = await analyzeWithClaude(resumeText, jdText);

    // Step 3: Validate and repair AI output
    const analysis = validateAIOutput(rawAnalysis);

    // Step 4: Code-based match scores
    const scoreBefore = calculateMatchScore(resumeText, jdText);

    // Step 5: Apply to DOCX
    let docxBase64 = null;
    let swapsApplied = [], removedBullets = [], addedBullets = [];

    if (ext === '.docx') {
      try {
        const result = applyToDocx(req.file.buffer, analysis, resumeText, detectedSwaps);
        docxBase64 = result.buffer.toString('base64');
        swapsApplied = result.swapsApplied;
        removedBullets = result.removedBullets;
        addedBullets = result.addedBullets;
        console.log(`Done: ${swapsApplied.length} swaps, ${removedBullets.length} removed, ${addedBullets.length} added`);
      } catch (err) { console.error('DOCX error:', err.message); }
    }

    // Step 6: Code-based score after
    const scoreAfter = Math.min(95, scoreBefore + swapsApplied.length * 2 + addedBullets.length * 3);

    const changes = [
      ...swapsApplied.map(s => ({ type: 'modified', description: `Tech updated: ${s}` })),
      ...removedBullets.map(r => ({ type: 'removed', description: `Removed: ${r}` })),
      ...addedBullets.map(a => ({ type: 'added', description: `Added: ${a}` })),
    ];
    if (changes.length === 0) changes.push({ type: 'added', description: 'Resume analyzed — already well matched' });

    const entry = {
      id: `opt_${Date.now()}`,
      jdSnippet: jdText.slice(0, 200),
      matchScore: scoreAfter,
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
      matchScore: scoreAfter,
      matchScoreBefore: scoreBefore,
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
