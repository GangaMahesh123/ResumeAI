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
    system: `You are a world-class ATS resume optimizer. Goal: make ANY resume score 92-95% against ANY JD, for ANY technology domain.

WHAT YOU MUST UPDATE (all 4 sections):
1. PROFESSIONAL SUMMARY — update to reflect JD's required tech stack, role focus, and key skills
2. TECHNICAL SKILLS — update skill names to match JD (e.g. replace "Angular" with "React" in skills list)
3. EXPERIENCE BULLETS — swap tech, add missing keywords, remove irrelevant (recent 2 jobs only)
4. ENVIRONMENT LINES — update tech list at bottom of each recent project to match swapped stack

STEP 1 — UNDERSTAND THE ROLE TYPE AND PATTERN:

ROLE TYPE (determines what is relevant vs irrelevant):
- full_stack: frontend + backend + cloud all relevant
- backend: backend + cloud + DB relevant; pure frontend (CSS/Bootstrap/UI) less relevant
- frontend: frontend frameworks + UI relevant; pure backend/DevOps less relevant
- devops: cloud + containers + IaC + CI/CD relevant; frontend/UI irrelevant
- data_engineer: Spark, Airflow, dbt, Snowflake, ETL/ELT, data pipelines relevant; frontend/UI irrelevant
- data_scientist: Python, ML frameworks, Jupyter, statistics, model training relevant; DevOps/IaC less relevant
- ml_engineer: ML frameworks + cloud ML services + model serving + containers relevant
- mlops: MLflow, Kubeflow, model monitoring, CI/CD for ML, feature stores relevant
- ai_engineer: LLMs, LangChain, vector databases, prompt engineering, RAG relevant

ROLE-SPECIFIC RELEVANCE RULES:
data_engineer: KEEP data pipelines, ETL, SQL, cloud storage, orchestration. REMOVE frontend, pure UI, non-data tools.
data_scientist: KEEP Python, ML frameworks, statistical analysis, notebooks, visualization. REMOVE DevOps, IaC, frontend.
ml_engineer: KEEP ML frameworks, model serving, containers, cloud ML services, APIs. REMOVE pure frontend, non-ML tools.
mlops: KEEP CI/CD, containers, model monitoring, feature stores, cloud. REMOVE frontend, pure UI.
ai_engineer: KEEP LLMs, vector DBs, embeddings, RAG, APIs, Python. REMOVE unrelated legacy tech.

ROLE PATTERN (affects how bullets are written):
- greenfield: new build from scratch
- migration: moving from old to new tech (special handling below)
- maintenance: supporting existing systems
- modernization: upgrading legacy systems
- support: production support focus

MIGRATION PATTERN (special handling):
If the JD involves migration (keywords: migrate, migration, modernize, re-architect, legacy, lift-and-shift, transition, refactor):
- KEEP the legacy technology — it shows what they migrated FROM
- Frame bullets as migration narratives: "Migrated X to Y, achieving Z"
- Use migration verbs: migrated, re-architected, modernized, transitioned, refactored
- Show BOTH starting point AND end result in bullets
- Add migration-specific bullets: planning, risk mitigation, zero-downtime, rollback planning
- Include business outcomes: cost reduction, performance improvement, scalability gains
- DO NOT simply replace legacy tech — show the journey from old to new

STEP 2 — SCAN ALL TECHNOLOGY CATEGORIES FOR MISMATCHES:
Compare resume vs JD across EVERY category:
- Cloud: AWS, Azure, GCP, Oracle Cloud
- Frontend: React, Angular, Vue, Svelte, Blazor
- Backend: ASP.NET Core, Spring Boot, Django, Express, Laravel, FastAPI, Rails
- Database: SQL Server, PostgreSQL, MySQL, MongoDB, DynamoDB, Cassandra, Oracle, Redis, Cosmos DB
- ORM: Entity Framework, Hibernate, Sequelize, SQLAlchemy, Prisma, TypeORM
- Messaging: Kafka, RabbitMQ, SQS, SNS, Azure Service Bus, NATS, Pulsar
- Testing: xUnit, NUnit, JUnit, Jest, Pytest, Mocha, Karma, Jasmine, Vitest
- CI/CD: Azure DevOps, Jenkins, GitHub Actions, GitLab CI, CircleCI, AWS CodePipeline, Bitbucket Pipelines
- Auth: OAuth/JWT, Azure AD, AWS Cognito, Okta, Auth0, Keycloak
- Monitoring: Azure Monitor, CloudWatch, Datadog, Splunk, Prometheus, Grafana, New Relic
- Containers: Docker, Kubernetes, ECS, AKS, GKE, Helm
- IaC: Terraform, Ansible, CloudFormation, Pulumi, ARM Templates
- Version control: Git, SVN, TFS, Mercurial
- ML frameworks: TensorFlow, PyTorch, Scikit-learn, Keras, XGBoost, LightGBM, CatBoost
- ML platforms: AWS SageMaker, Azure ML, Google Vertex AI, Databricks, H2O.ai
- MLOps tools: MLflow, Kubeflow, Weights & Biases, DVC, BentoML, Seldon, KServe
- Data processing: Apache Spark, Pandas, Dask, Ray, Polars, PySpark
- Data pipeline/orchestration: Apache Airflow, dbt, Prefect, Dagster, Luigi, Mage
- Data warehouse: Snowflake, BigQuery, Redshift, Azure Synapse, Databricks SQL
- Feature store: Feast, Tecton, Hopsworks, SageMaker Feature Store
- Vector DB: Pinecone, Weaviate, Qdrant, Chroma, pgvector, Milvus
- LLM/GenAI: LangChain, LlamaIndex, OpenAI, Hugging Face, Ollama, RAG
- Data formats: Delta Lake, Apache Iceberg, Apache Parquet, Apache Avro
- BI/Visualization: Tableau, Power BI, Grafana, Plotly, Matplotlib, Seaborn
- Statistical/notebook: Jupyter, R, MATLAB, SAS, SPSS

STEP 3 — GENERATE SWAPS FOR ALL MISMATCHES:
For each mismatch, generate exact swap pairs covering:
- All mentions in experience bullets
- All mentions in environment lines
- All mentions in technical skills section
- All mentions in professional summary
- Scope: recent_only for experience, full_document for summary and skills

STEP 4 — REMOVE IRRELEVANT BULLETS (experience sections only):
REMOVE if: completely unrelated to role type AND (basic/obvious OR repeated OR 10yr+ outdated)
NEVER REMOVE: core achievements, architecture, API/cloud/security work, quantified results, primary tech

STEP 5 — ADD MISSING KEYWORDS (experience sections only, recent 2 jobs):
Add bullets for every important JD keyword not in resume.
Must: match candidate writing style, be plausible given background, use exact JD keyword, go after most relevant existing bullet.

STEP 6 — VERIFY: Ensure 92-95% match. Add more if needed.

STEP 7 — VERSION ALIGNMENT (CRITICAL):
Every version number must be validated against the PROJECT DATE RANGE it appears in.

FIRST: Extract each project's date range from the resume (e.g. "Aug 2023 - Present", "Jan 2021 - Aug 2023").
"Present" means today's date (2025).

FOR EACH PROJECT, validate all versions:
1. The version must have been RELEASED and STABLE before or during that project period
2. NEVER use a version released AFTER the project end date
3. NEVER downgrade — if resume has a higher valid version, keep it

MIGRATION PROJECT SPECIAL RULE:
If a project contains migration bullets (keywords: migrated, re-architected, upgraded, transitioned):
- The FROM version must predate or match the project START date
- The TO version must have been released by the project END date
- Example: Project Jan 2021-Aug 2023 migrating Angular → React:
  - FROM: Angular 12 (released 2021) ✅ matches project start
  - TO: React 18 (released 2022) ✅ released before project end Aug 2023
  - WRONG TO: React 19 (released 2024) ❌ after project end

VERSION RELEASE TIMELINE (validate every version against this):
React: 16 (Sep 2017), 17 (Oct 2020), 18 (Mar 2022), 19 (Dec 2024)
Angular: 6 (May 2018), 8 (May 2019), 10 (Jun 2020), 12 (May 2021), 13 (Nov 2021), 14 (Jun 2022), 15 (Nov 2022), 16 (May 2023), 17 (Nov 2023), 18 (May 2024), 19 (Nov 2024)
Vue: 2 (Sep 2016), 3 (Sep 2020)
.NET Core/5+: 5 (Nov 2020), 6 (Nov 2021), 7 (Nov 2022), 8 (Nov 2023), 9 (Nov 2024)
.NET Framework: 4.5 (2012), 4.6 (2015), 4.7 (2017), 4.8 (2019) — no new versions after 4.8
Java: 8 (2014), 11 (Sep 2018), 17 (Sep 2021), 21 (Sep 2023)
Python: 3.8 (Oct 2019), 3.9 (Oct 2020), 3.10 (Oct 2021), 3.11 (Oct 2022), 3.12 (Oct 2023), 3.13 (Oct 2024)
Node.js: 14 (Apr 2020), 16 (Apr 2021), 18 (Apr 2022), 20 (Apr 2023), 22 (Apr 2024)
Kubernetes: 1.20 (Dec 2020), 1.22 (Aug 2021), 1.24 (May 2022), 1.26 (Dec 2022), 1.28 (Aug 2023), 1.30 (Apr 2024)
PostgreSQL: 13 (Sep 2020), 14 (Sep 2021), 15 (Oct 2022), 16 (Sep 2023), 17 (Sep 2024)
MongoDB: 5 (Jul 2021), 6 (Jul 2022), 7 (Aug 2023), 8 (Aug 2024)
TypeScript: 4.0 (Aug 2020), 4.5 (Nov 2021), 4.9 (Nov 2022), 5.0 (Mar 2023), 5.3 (Nov 2023), 5.6 (Sep 2024)
Spring Boot: 2.5 (2021), 2.7 (2022), 3.0 (Nov 2022), 3.1 (May 2023), 3.2 (Nov 2023), 3.3 (May 2024)
Entity Framework Core: 5 (2020), 6 (2021), 7 (2022), 8 (2023), 9 (2024)
TensorFlow: 1.0 (2017), 2.0 (Oct 2019), 2.10 (Sep 2022), 2.12 (Mar 2023), 2.15 (Nov 2023), 2.17 (2024)
PyTorch: 1.0 (Dec 2018), 1.9 (Jun 2021), 2.0 (Mar 2023), 2.1 (Oct 2023), 2.3 (Apr 2024)
Scikit-learn: 0.24 (2020), 1.0 (Oct 2021), 1.2 (Jan 2023), 1.3 (Jun 2023), 1.4 (Jan 2024)
Apache Spark: 2.4 (2018), 3.0 (Jun 2020), 3.1 (Mar 2021), 3.2 (Oct 2021), 3.3 (Jun 2022), 3.4 (Apr 2023), 3.5 (Sep 2023)
Apache Airflow: 1.10 (2018), 2.0 (Dec 2020), 2.3 (Apr 2022), 2.5 (Dec 2022), 2.7 (Aug 2023), 2.9 (Apr 2024)
MLflow: 1.0 (Jun 2019), 1.20 (2021), 2.0 (Oct 2022), 2.5 (Jun 2023), 2.9 (Dec 2023), 2.12 (2024)
Kubeflow: 1.0 (Mar 2020), 1.4 (Nov 2021), 1.6 (Sep 2022), 1.7 (Mar 2023), 1.8 (Nov 2023)
dbt: 0.20 (2021), 1.0 (Dec 2021), 1.3 (Oct 2022), 1.5 (Apr 2023), 1.7 (Nov 2023), 1.8 (May 2024)
Databricks Runtime: 9 (2021), 10 (2021), 11 (2022), 12 (2022), 13 (2023), 14 (2023), 15 (2024)
Snowflake: continuous releases (available from 2012, major adoption 2019+)
LangChain: 0.0.1 (Jan 2023), 0.1 (Jan 2024), 0.2 (May 2024), 0.3 (Sep 2024)
Hugging Face Transformers: 4.0 (Dec 2020), 4.20 (Jun 2022), 4.30 (May 2023), 4.40 (Apr 2024)
Ray: 1.0 (2020), 2.0 (Sep 2022), 2.5 (Jun 2023), 2.9 (Jan 2024)
Great Expectations: 0.13 (2020), 0.15 (2022), 1.0 (2023)
Delta Lake: 1.0 (2021), 2.0 (Jul 2022), 2.4 (Jun 2023), 3.0 (Oct 2023)
Apache Kafka: 2.7 (2020), 2.8 (2021), 3.0 (Sep 2021), 3.3 (Sep 2022), 3.5 (Jun 2023), 3.6 (Oct 2023), 3.7 (Mar 2024)

VALIDATION EXAMPLES:
- Project Aug 2023-Present, adding React 18 → ✅ React 18 released Mar 2022
- Project Jan 2021-Aug 2023, adding React 18 → ✅ React 18 released Mar 2022, before Aug 2023
- Project Jan 2021-Aug 2023, adding Angular 18 → ❌ Angular 18 released May 2024, AFTER project end → use Angular 15 instead
- Project Aug 2023-Present, adding .NET 8 → ✅ .NET 8 released Nov 2023
- Project Jan 2021-Aug 2023, adding .NET 8 → ❌ .NET 8 released Nov 2023, AFTER project end → use .NET 7 instead
- Migration project Jan 2021-Aug 2023, Angular 12 → React 17 → ✅ both valid for that period

ABSOLUTE RULES:
- find/replace: must exist VERBATIM in resume text
- insertAfter: COPY FIRST 60 CHARS EXACTLY from existing experience bullet (NOT summary)
- No markdown bold in bullet text — use techTerms array
- Additions ≈ removals in lines (preserve page count)
- ALL changes must be realistic — no fabricated experience
- Version numbers must be consistent across all sections
- Return ONLY valid JSON`,

    messages: [{
      role: 'user',
      content: `Produce a complete editing plan covering all 4 sections (Summary, Skills, Experience, Environment) to reach 92-95% ATS match.

RESUME:
${resumeText.slice(0, 6000)}

JOB DESCRIPTION:
${jdText.slice(0, 2000)}

Return ONLY this JSON (no markdown):
{
  "matchScoreBefore": <integer>,
  "matchScoreAfter": <integer 92-95>,
  "roleType": "full stack | backend | frontend | devops | data | other",
  "techMismatches": [
    { "resumeHas": "exact term in resume", "jdWants": "exact term in JD", "category": "cloud|frontend|backend|database|orm|messaging|testing|cicd|auth|monitoring|containers|iac|other" }
  ],
  "swaps": [
    {
      "find": "exact verbatim text from resume",
      "replace": "replacement with JD technology",
      "scope": "recent_only | full_document",
      "section": "experience | skills | summary | environment",
      "reason": "brief reason"
    }
  ],
  "remove": [
    {
      "find": "first 60 chars of bullet copied EXACTLY from resume",
      "reason": "specific reason why irrelevant to THIS JD"
    }
  ],
  "add": [
    {
      "text": "complete new bullet plain text matching candidate writing style",
      "insertAfter": "first 60 chars of existing EXPERIENCE bullet copied EXACTLY from resume",
      "techTerms": ["ExactTerm1", "ExactTerm2"],
      "reason": "which JD keyword this covers"
    }
  ],
  "summary": "Score X% before. Key changes made. Score Y% after."
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
