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
9. Update ONLY these sections: Professional Summary, Technical Skills, Recent 2 Projects (latest 2 clients only), Environment lines of latest 2 clients only
   NEVER touch older client projects — they must remain exactly as in the original resume
10. Missing JD points inserted naturally into existing bullets or added as new bullets in right position
11. Maintain same writing style, bullet format, and resume tone
12. Final resume match must be 92-96% — not overstuffed beyond that
13. CRITICAL — DO NOT SWAP IF NOT NEEDED: If the JD does not mention a different cloud (e.g. JD says nothing about AWS), do NOT swap Azure to AWS. If JD mentions Angular, do NOT swap Angular to React. Only swap when there is a CLEAR mismatch between what the resume has and what the JD explicitly requires.
14. NEVER reduce years of experience — if resume says 12+ years, keep 12+ years
15. NEVER swap a technology when the JD already accepts or requires that technology (e.g. JD wants Angular → keep Angular, do not swap to React)
16. If JD has no cloud requirement — keep existing cloud stack as is, do not add AWS or GCP

PROCESS:
STEP 1 — ANALYZE JD:
Extract: required skills, preferred skills, role type (full_stack/backend/frontend/devops/data_engineer/ml_engineer), and role pattern (greenfield/migration/maintenance/modernization).
For MIGRATION PATTERN jobs: keep legacy tech to show FROM state, frame bullets as migration narratives showing journey from old to new tech., preferred skills, domain needs, tools, cloud, frontend, backend, database, DevOps, testing, security requirements.

STEP 2 — COMPARE JD vs RESUME:
Identify:
- Already matching skills (keep as is)
- Missing skills (add in right section/position)
- Partially covered skills (enhance existing bullet)
- Skills that CANNOT be added (not supported by candidate background)
- Timeline/version conflicts (flag and suggest valid alternative)

STEP 3 — GENERATE CHANGES:
Generate ONLY the exact additions, replacements, and removals needed for 92-95% match.

STEP 4 — TECHNOLOGY SWAPS (VERY STRICT RULES):
BEFORE generating ANY swap, ask yourself: "Does the JD EXPLICITLY name this target technology?"
If NO → DO NOT generate that swap. Leave the resume technology as is.

SWAP ONLY WHEN:
- JD explicitly names "AWS" or "Amazon" → then swap Azure to AWS
- JD explicitly names "React" or "React.js" (and NOT Angular) → then swap Angular to React  
- JD explicitly names "GCP" or "Google Cloud" → then swap Azure to GCP
- JD explicitly names "Angular" (and resume has React) → then swap React to Angular
- JD explicitly names a different database (e.g. PostgreSQL only, not SQL Server) → then swap
- JD explicitly names a different CI/CD tool that conflicts with resume → then swap

DO NOT SWAP WHEN:
- JD mentions .NET, C#, ASP.NET Core → these already match, no swap needed
- JD does not mention cloud at all → keep Azure as is
- JD does not mention frontend framework → keep Angular as is
- JD mentions Blazor → Blazor is already in resume, no swap needed
- JD mentions RabbitMQ → RabbitMQ is already in resume (Kafka stays too, both are valid)
- JD mentions MongoDB → add it if missing, but do NOT remove SQL Server
- The technology is already present in the resume AND acceptable for the JD

Generate swaps ONLY for genuine mismatches where JD explicitly requires a DIFFERENT technology.
Scope: experience/environment = "recent_only", summary/skills = "full_document"

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

    // Build stackDetected from techMismatches for guaranteed swaps
    const mismatches = parsed.techMismatches || [];
    parsed.stackDetected = {
      cloud: mismatches.find(m => m.category === 'cloud')?.jdWants?.toLowerCase().includes('aws') ? 'aws'
           : mismatches.find(m => m.category === 'cloud')?.jdWants?.toLowerCase().includes('gcp') ? 'gcp'
           : mismatches.find(m => m.category === 'cloud')?.jdWants?.toLowerCase().includes('azure') ? 'azure'
           : parsed.stackDetected?.cloud || 'none',
      frontend: mismatches.find(m => m.category === 'frontend')?.jdWants?.toLowerCase().includes('react') ? 'react'
              : mismatches.find(m => m.category === 'frontend')?.jdWants?.toLowerCase().includes('vue') ? 'vue'
              : mismatches.find(m => m.category === 'frontend')?.jdWants?.toLowerCase().includes('angular') ? 'angular'
              : parsed.stackDetected?.frontend || 'none',
    };
    console.log(`Stack detected: cloud=${parsed.stackDetected.cloud}, frontend=${parsed.stackDetected.frontend}`);
    return parsed;
  } catch (e) {
    console.error('Parse error:', e.message, raw.slice(0, 200));
    return { swaps: [], remove: [], add: [], matchScoreBefore: 70, matchScoreAfter: 88, techMismatches: [], summary: '' };
  }
}

// ── Build guaranteed swap list — only if JD actually requires the technology ──
function buildGuaranteedSwaps(stackDetected, resumeText, jdText) {
  const swaps = [];
  const resumeHas = (term) => resumeText.toLowerCase().includes(term.toLowerCase());
  const jdWants = (term) => jdText.toLowerCase().includes(term.toLowerCase());
  const jdWantsAny = (...terms) => terms.some(t => jdText.toLowerCase().includes(t.toLowerCase()));

  // CLOUD SWAPS — only if JD explicitly mentions the target cloud AND does NOT mention existing cloud
  // If JD says "AWS" or "Amazon" AND does not say "Azure" → swap Azure to AWS
  if (stackDetected.cloud === 'aws'
      && jdWantsAny('AWS', 'Amazon Web Services', 'Amazon S3', 'EC2', 'Lambda', 'RDS')
      && !jdWantsAny('Azure', 'Microsoft Azure')
      && resumeHas('Azure')) {
      // Longest phrases first
      [
        ['Azure API Management (APIM)', 'AWS API Gateway'],
        ['Azure API Management', 'AWS API Gateway'],
        ['Azure API Gateway (v2)', 'AWS API Gateway'],
        ['Azure API Gateway', 'AWS API Gateway'],
        ['Azure App Services', 'AWS Elastic Beanstalk'],
        ['Azure Functions v4', 'AWS Lambda'],
        ['Azure Functions', 'AWS Lambda'],
        ['Azure Blob Storage', 'Amazon S3'],
        ['Azure SQL Database', 'Amazon RDS PostgreSQL'],
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
      ].forEach(([f, t]) => swaps.push([f, t]));
  }

  // GCP swaps — only if JD explicitly mentions GCP and NOT Azure
  if (stackDetected.cloud === 'gcp'
      && jdWantsAny('GCP', 'Google Cloud', 'Vertex AI', 'BigQuery', 'Cloud Run')
      && !jdWantsAny('Azure', 'Microsoft Azure')
      && resumeHas('Azure')) {
    [
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
    ].forEach(([f, t]) => swaps.push([f, t]));
  }

  // FRONTEND SWAPS — only if JD explicitly requires React (not Angular)
  // If JD mentions Angular, do NOT swap Angular to React
  if (stackDetected.frontend === 'react'
      && jdWantsAny('React', 'React.js', 'ReactJS')
      && !jdWantsAny('Angular')
      && resumeHas('Angular')) {
    [
      ['Angular 14 to Angular 18', 'React 17 to React 18'],
      ['Angular 14–18', 'React 17–18'],
      ['Angular 14, progressively upgrading to Angular 18', 'React 17, progressively upgrading to React 18'],
      ['Angular (11–18)', 'React (16–18)'],
      ['Angular 12 to Angular 15', 'React 16 to React 18'],
      ['Angular 12 to React 18', 'React 16 to React 18'],
      ['Angular 12 front-end', 'React 17 front-end'],
      ['Angular 12', 'React 17'],
      ['Angular 14', 'React 18'],
      ['Angular 15', 'React 18'],
      ['Angular 18', 'React 18'],
      ['Angular 6', 'React 16'],
      ['AngularJS', 'React.js'],
      ['Angular', 'React'],
      ['RxJS 7 to 8', 'Redux Toolkit'],
      ['RxJS 7–8', 'Redux Toolkit'],
      ['RxJS', 'Redux Toolkit'],
      ['Karma', 'Jest'],
      ['Jasmine', 'React Testing Library'],
      ['Protractor', 'Cypress'],
    ].forEach(([f, t]) => swaps.push([f, t]));
  }

  if (stackDetected.frontend === 'vue' && jdWantsAny('Vue', 'Vue.js', 'VueJS') && !jdWantsAny('Angular') && resumeHas('Angular')) {
    [
      ['Angular 14 to Angular 18', 'Vue 2 to Vue 3'],
      ['Angular 14', 'Vue 3'], ['Angular 18', 'Vue 3'],
      ['Angular 12', 'Vue 2'], ['Angular', 'Vue.js'],
      ['RxJS', 'Vuex / Pinia'], ['Karma', 'Vitest'], ['Jasmine', 'Vue Test Utils'],
    ].forEach(([f, t]) => swaps.push([f, t]));
  }

  if (stackDetected.frontend === 'angular' && jdWantsAny('Angular') && !jdWantsAny('React') && resumeHas('React')) {
    [
      ['React 17 to React 18', 'Angular 14 to Angular 18'],
      ['React 18', 'Angular 18'], ['React 17', 'Angular 14'],
      ['React.js', 'Angular'], ['React', 'Angular'],
      ['Redux Toolkit', 'RxJS'], ['Jest', 'Karma'],
      ['React Testing Library', 'Jasmine'], ['Cypress', 'Protractor'],
    ].forEach(([f, t]) => swaps.push([f, t]));
  }

  return swaps;
}

// ── Apply all instructions to DOCX ───────────────────────────────────────────
function applyToDocx(docxBuffer, instructions, resumeText, jdText) {
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

  // SWAPS — validate each swap against JD before applying
  // REJECT any swap that introduces a technology not mentioned in the JD
  const jdLower = (jdText || '').toLowerCase();

  // Technologies that should NEVER be swapped unless JD explicitly asks
  const cloudSwapGuards = [
    // Cloud swaps — require JD to mention target AND not mention existing
    { from: 'azure', to: 'aws', jdRequired: ['aws', 'amazon web services', 'ec2', 'lambda', 's3', 'rds'], jdMustNotHave: ['azure', 'microsoft azure'] },
    { from: 'azure', to: 'gcp', jdRequired: ['gcp', 'google cloud', 'vertex ai', 'bigquery'], jdMustNotHave: ['azure', 'microsoft azure'] },
    { from: 'aws', to: 'azure', jdRequired: ['azure', 'microsoft azure'], jdMustNotHave: ['aws', 'amazon'] },
    { from: 'aws', to: 'gcp', jdRequired: ['gcp', 'google cloud'], jdMustNotHave: ['aws', 'amazon'] },
    { from: 'angular', to: 'react', jdRequired: ['react', 'react.js', 'reactjs'], jdMustNotHave: [] },
    { from: 'react', to: 'angular', jdRequired: ['angular'], jdMustNotHave: [] },
    { from: 'angular', to: 'vue', jdRequired: ['vue', 'vue.js', 'vuejs'], jdMustNotHave: [] },
  ];

  function isSwapAllowed(findText, replaceText) {
    const findLower = (findText || '').toLowerCase();
    const replaceLower = (replaceText || '').toLowerCase();
    for (const guard of cloudSwapGuards) {
      // Check if this swap matches a guarded pattern
      const isGuardedSwap = findLower.includes(guard.from) && replaceLower.includes(guard.to.split(' ')[0]);
      if (isGuardedSwap) {
        // Only allow if JD explicitly mentions the target technology
        const jdAllows = guard.jdRequired.some(req => jdLower.includes(req));
        // Block if JD explicitly mentions the source technology (means it wants to KEEP it)
        const jdForbids = (guard.jdMustNotHave || []).some(req => jdLower.includes(req));
        if (!jdAllows || jdForbids) {
          console.log(`BLOCKED swap: "${findText.slice(0,40)}" → "${replaceText.slice(0,40)}" (JD requires=${jdAllows}, forbids=${jdForbids})`);
          return false;
        }
      }
    }
    return true;
  }

  const swaps = [...(instructions.swaps || [])];
  swaps.sort((a, b) => (b.find?.length || 0) - (a.find?.length || 0));

  for (const swap of swaps) {
    if (!swap.find || !swap.replace) continue;
    if (swap.find.trim() === swap.replace.trim()) continue;
    // Validate swap against JD before applying
    if (!isSwapAllowed(swap.find, swap.replace)) continue;

    const isRecentOnly = swap.scope === 'recent_only';

    // Find older projects boundary — never touch beyond this
    const olderBoundary = (() => {
      const oldMarkers = ['Fannie Mae', 'LuluLemon', 'Lulu Lemon', 'Infosys', 'Wipro', 'TCS',
        'Cognizant', 'Accenture', 'Capgemini', 'Apple', 'Citigroup', 'LAHD',
        'Apollo', 'previous employer'];
      for (const m of oldMarkers) {
        if (resumeText.includes(m)) {
          const idx = xml.indexOf(m);
          if (idx > 0) return idx;
        }
      }
      return xml.length;
    })();

    if (isRecentOnly) {
      // Only swap before older projects boundary
      const before = xml.slice(0, olderBoundary);
      const older = xml.slice(olderBoundary);
      const newBefore = applyTextSwap(before, swap.find.trim(), swap.replace.trim());
      if (newBefore !== before) {
        xml = newBefore + older;
        swapsApplied.push(`${swap.find.trim().slice(0, 35)} → ${swap.replace.trim().slice(0, 35)}`);
      }
    } else {
      // full_document — applies to summary + skills + recent projects only (not older)
      const before = xml.slice(0, olderBoundary);
      const older = xml.slice(olderBoundary);
      const newBefore = applyTextSwap(before, swap.find.trim(), swap.replace.trim());
      if (newBefore !== before) {
        xml = newBefore + older;
        swapsApplied.push(`${swap.find.trim().slice(0, 35)} → ${swap.replace.trim().slice(0, 35)}`);
      }
    }
  }

  // GUARANTEED TECH STACK SWAPS — only in recent 2 projects, summary, and skills
  // Never touch older clients
  const guaranteedSwaps = buildGuaranteedSwaps(instructions.stackDetected || {}, resumeText, jdText);
  if (guaranteedSwaps.length > 0) {
    // Find boundaries: recent 2 projects start and 3rd (older) project start
    const recentProjectsStart = (() => {
      const markers = ['Professional Experience', 'County of San Bernardino', 'Client:'];
      for (const m of markers) {
        const idx = xml.indexOf(m);
        if (idx > 0) return idx;
      }
      return 0;
    })();

    const olderProjectsStart = (() => {
      // Find 3rd client/project marker
      const oldMarkers = ['Fannie Mae', 'LuluLemon', 'Lulu Lemon', 'Infosys', 'Wipro', 'TCS',
        'Cognizant', 'Accenture', 'Capgemini', 'Apple', 'Citigroup', 'LAHD',
        'Apollo', 'previous employer'];
      for (const m of oldMarkers) {
        if (resumeText.includes(m)) {
          const idx = xml.indexOf(m);
          if (idx > 0) return idx;
        }
      }
      return xml.length; // No older projects found — apply to all
    })();

    // Split XML into: before recent projects | recent 2 projects | older projects
    const beforeRecent = xml.slice(0, recentProjectsStart);
    let recentScope = xml.slice(recentProjectsStart, olderProjectsStart);
    const olderScope = xml.slice(olderProjectsStart);

    // Apply guaranteed swaps ONLY in recent scope
    for (const [from, to] of guaranteedSwaps) {
      if (recentScope.includes(from)) {
        recentScope = recentScope.split(from).join(to);
        swapsApplied.push(`Guaranteed: ${from.slice(0, 30)} → ${to.slice(0, 30)}`);
      } else {
        // Try paragraph-level swap within recent scope only
        const paras = extractParagraphs(recentScope);
        for (const para of paras) {
          if (para.text.includes(from)) {
            const newText = para.text.split(from).join(to);
            const pPrM = para.xml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
            const rPrM = para.xml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
            const pPr = pPrM ? pPrM[0] : '';
            const rPr = rPrM ? rPrM[0].replace(/<w:b\/>/g,'').replace(/<w:bCs\/>/g,'') : '<w:rPr><w:sz w:val="20"/></w:rPr>';
            const escaped = newText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            recentScope = recentScope.slice(0, para.index) +
              `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>` +
              recentScope.slice(para.index + para.xml.length);
            swapsApplied.push(`Guaranteed: ${from.slice(0, 30)} → ${to.slice(0, 30)}`);
            break;
          }
        }
      }
    }

    // Also apply summary/skills swaps to the before-recent section (summary + skills)
    let beforeRecentUpdated = beforeRecent;
    for (const [from, to] of guaranteedSwaps) {
      if (beforeRecentUpdated.includes(from)) {
        beforeRecentUpdated = beforeRecentUpdated.split(from).join(to);
      }
    }

    xml = beforeRecentUpdated + recentScope + olderScope; // Older scope NEVER touched
  }

  // REMOVALS — only from recent 2 projects, never older clients
  const removalBoundary = (() => {
    const oldMarkers = ['Fannie Mae', 'LuluLemon', 'Lulu Lemon', 'Infosys', 'Wipro', 'TCS',
      'Cognizant', 'Accenture', 'Capgemini', 'Apple', 'Citigroup', 'LAHD',
      'Apollo', 'previous employer'];
    for (const m of oldMarkers) {
      if (resumeText.includes(m)) {
        const idx = xml.indexOf(m);
        if (idx > 0) return idx;
      }
    }
    return xml.length;
  })();

  for (const removal of (instructions.remove || [])) {
    if (!removal.find) continue;
    const snippet = removal.find.trim().slice(0, 50);
    // Only remove if the bullet is in recent 2 projects (before older boundary)
    const snippetIdx = xml.indexOf(snippet);
    if (snippetIdx === -1 || snippetIdx > removalBoundary) continue;
    const newXml = removeParagraph(xml, snippet);
    if (newXml !== xml) {
      xml = newXml;
      removedBullets.push(snippet);
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
        const result = applyToDocx(req.file.buffer, instructions, resumeText, jobDescription.trim());
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
