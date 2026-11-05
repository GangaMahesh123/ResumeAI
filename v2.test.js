'use strict';
// ResumeAI V2 acceptance tests. Run: npm test
// The AI is replaced by a deterministic mock (test/mockProvider.js); the
// parser, evidence guards, scoring, DOCX engine and LibreOffice page
// rendering are all real.

process.env.CLAUDE_MAX_RETRIES = '2';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tailor } = require('../lib/tailor');
const { createMockProvider } = require('./mockProvider');
const { makeResume } = require('./fixtures/synthetic');
const { scoreResume } = require('../lib/scoring');
const { loadDocx } = require('../lib/resumeModel');
const { hasTerm, findLibraryTerms } = require('../lib/domains');
const { createApp } = require('../server');
const { Store } = require('../lib/store');
const render = require('../lib/render');

const DOTNET = fs.readFileSync(path.join(__dirname, 'fixtures', 'dotnet_resume.docx'));
const quiet = { error() {}, log() {}, warn() {} };

async function run(input, jdText, mockOpts = {}, settings = {}, confirmations = []) {
  const provider = createMockProvider(mockOpts);
  const isText = typeof input === 'string';
  const result = await tailor({
    fileBuffer: isText ? Buffer.from(input) : input,
    fileName: isText ? 'resume.txt' : 'resume.docx',
    jdText, settings, confirmations,
  }, { provider, requestId: 'test', log: quiet });
  return { result, provider };
}

const recentText = r => r.preview.projects.map(p => `${p.bullets.join('\n')}\n${p.environment}`).join('\n');

// ── Test 1 — Existing skill under-represented ─────────────────────────
test('T1: a skill present once (older project) is strengthened in the summary, not invented in recent projects', async () => {
  const resume = makeResume('aiml').replace('Environment: SQL; Python', 'Environment: SQL; Python; Snowflake');
  const jd = 'Senior ML Engineer. Snowflake is critical: you will build Snowflake feature stores daily. Snowflake, Snowflake, Snowflake. Also Python, XGBoost, MLflow.';
  const { result } = await run(resume, jd, { projectInjections: [['Built Snowflake feature pipelines for the energy forecasting platform with automated data quality checks and lineage.']] });
  const row = result.requirements.find(r => r.requirement === 'Snowflake');
  assert.ok(row, 'Snowflake requirement extracted');
  assert.equal(row.supportStatus, 'verified');
  assert.equal(row.resumeSection, 'summary', 'Snowflake now visible in the Professional Summary');
  assert.ok(!hasTerm(recentText(result), 'Snowflake'), 'not added to a recent project without project evidence');
  assert.ok(result.validation.removedClaims.some(c => (c.terms || []).includes('Snowflake')) || result.validation.optimizationPasses.length > 0);
});

// ── Test 2 — Missing mandatory technology ─────────────────────────────
test('T2: missing VB6 / COM+ are reported, resume still completes, nothing invented', async () => {
  const jd = 'Legacy Modernization Developer. Mandatory: VB6 and COM+ component experience, C#, .NET, SQL Server, Classic ASP modernization.';
  const { result } = await run(DOTNET, jd, {
    summaryInjections: ['Maintained VB6 desktop applications and COM+ components while modernizing them into .NET services for enterprise clients.'],
  });
  const gaps = result.unsupportedSkills.map(u => u.requirement);
  assert.ok(gaps.includes('VB6') && gaps.includes('COM+'), `gaps reported: ${gaps}`);
  assert.ok(!hasTerm(result.fullText, 'VB6') && !hasTerm(result.fullText, 'COM+'), 'no invented VB6/COM+ experience');
  assert.ok(result.buffer.length > 10000, 'DOCX produced');
  assert.ok(hasTerm(result.preview.professionalSummary.join(' '), 'Classic ASP'), 'related modernization experience kept');
});

// ── Test 3 — Cloud platform consistency ───────────────────────────────
test('T3: an Azure project is never rewritten as AWS', async () => {
  const jd = 'Senior .NET Engineer, AWS preferred (would accept Azure). AWS Lambda, Amazon S3, API Gateway, C#, .NET Core.';
  const { result } = await run(DOTNET, jd, {
    projectInjections: [['Migrated county permitting services to AWS Lambda and Amazon S3 for serverless processing of permit uploads.']],
    envInjections: [['AWS Lambda', 'Amazon S3']],
  });
  const recent = recentText(result);
  assert.ok(hasTerm(recent, 'Azure'), 'Azure history preserved');
  assert.ok(!hasTerm(recent, 'AWS Lambda') && !hasTerm(recent, 'Amazon S3'), 'no AWS substitution in Azure projects');
  assert.equal(result.domain.used !== undefined, true);
});

// ── Test 4 — First two project editing, older projects locked ─────────
test('T4: summary + first two projects optimized; all older projects byte-identical', async () => {
  const { result } = await run(DOTNET, 'Senior .NET Full Stack Developer: C#, ASP.NET Core, Angular, Azure, SQL Server, Kafka.', { touchLocked: true });
  assert.deepEqual(result.editableProjects.map(p => p.client), ['County of San Bernardino, CA', 'Elevance Health, Indianapolis, IN']);
  assert.equal(result.lockedProjects.length, 3);
  assert.ok(result.lockedProjects.every(p => p.intact), 'locked projects unchanged');
  assert.ok(result.validation.warnings.some(w => /locked\/unknown project/.test(w)), 'attempt to edit a locked project was ignored and reported');
  assert.ok(!result.fullText.includes('Rewrote a locked project'));
});

// ── Test 5 — Word formatting ──────────────────────────────────────────
test('T5: Calibri 10, single spacing, no blank lines, bullet minimums, six rendered pages', async t => {
  if (!(await render.isAvailable())) return t.skip('LibreOffice not installed');
  const { result } = await run(DOTNET, 'Senior .NET Developer: C#, ASP.NET Core, Azure, SQL Server, Angular, Microservices.', { shrinkWords: 18 });
  const f = result.validation.formatting;
  assert.deepEqual(f.issues.filter(i => !/protected project/.test(i)), [], `formatting issues: ${f.issues}`);
  assert.ok(f.counts.summary >= 18);
  for (const p of f.counts.projects.filter(x => x.editable)) assert.ok(p.bullets >= 15, `${p.client} ${p.bullets}`);
  assert.equal(result.validation.pageCountVerified, true);
  assert.equal(result.validation.pageCount, 6, `rendered pages: ${result.validation.pageCount} log=${JSON.stringify(result.validation.layoutLog)}`);
  const xml = loadDocx(result.buffer).documentXml;
  assert.ok(xml.includes('w:ascii="Calibri"') && xml.includes('<w:sz w:val="20"/>'));
});

// ── Test 6 — AI failure (via the real HTTP API) ───────────────────────
async function startServer(provider, store) {
  const app = createApp({ provider, store, log: quiet });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tester', email: `t${Date.now()}${Math.random()}@example.com`, password: 'password123' }) });
  const { token } = await reg.json();
  return { server, base, token };
}

async function upload(base, token, buf, name, jd, extra = {}) {
  const fd = new FormData();
  fd.append('resume', new Blob([buf]), name);
  fd.append('jobDescription', jd);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const res = await fetch(`${base}/api/resume/optimize`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, body: await res.json() };
}

test('T6: repeated AI failures return a clear error, never "already well matched"', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'rai-')));
  const provider = createMockProvider({ failAll: true, failStatus: 529 });
  const { server, base, token } = await startServer(provider, store);
  try {
    const { status, body } = await upload(base, token, DOTNET, 'r.docx', 'Senior .NET developer with C# and Azure experience required.');
    assert.equal(status, 502);
    assert.equal(body.success, false);
    assert.equal(body.code, 'AI_OVERLOADED');
    assert.ok(body.requestId);
    assert.ok(!/already well matched/i.test(JSON.stringify(body)));
    assert.ok(provider.calls.length >= 2, 'retried');
    const bad = createMockProvider({ badJson: true });
    const s2 = await startServer(bad, store);
    const r2 = await upload(s2.base, s2.token, DOTNET, 'r.docx', 'Senior .NET developer with C# and Azure experience required.');
    s2.server.close();
    assert.equal(r2.body.code, 'AI_INVALID_JSON');
  } finally { server.close(); }
});

// ── Test 7 — Multiple independent JDs ─────────────────────────────────
test('T7: five JDs on one master resume are tailored independently', async () => {
  const jds = {
    azure: 'Azure Engineer: Azure Functions, Azure Kubernetes Service, Azure DevOps, Terraform.',
    aws: 'AWS Engineer: AWS Lambda, Amazon S3, DynamoDB, Terraform.',
    react: 'React Developer: React, Redux, TypeScript, Jest.',
    dotnet: '.NET Full Stack Developer: C#, ASP.NET Core, Angular, SQL Server, EF Core.',
    aiml: 'AI/ML Engineer: Python, PyTorch, TensorFlow, MLflow, SageMaker.',
  };
  const results = {};
  for (const [k, jd] of Object.entries(jds)) results[k] = (await run(DOTNET, jd)).result;
  for (const [k, r] of Object.entries(results)) {
    // Every requirement of a run comes from THAT run's JD only.
    const own = new Set(findLibraryTerms(jds[k]).map(e => e.term));
    for (const row of r.requirements) assert.ok(own.has(row.requirement), `${k} has foreign requirement ${row.requirement}`);
  }
  assert.ok(results.aiml.unsupportedSkills.some(u => u.requirement === 'PyTorch'));
  assert.ok(!results.dotnet.unsupportedSkills.some(u => u.requirement === 'PyTorch'));
  assert.equal(results.aiml.domain.jd, 'aiml');
});

// ── Test 8 — Score accuracy ───────────────────────────────────────────
test('T8: scores are computed from requirements with no floor/ceiling', () => {
  const req = (name, status, priority = 'Critical') => ({ id: name, name, priority, status, terms: [name], evidence: '', evidenceProjects: [] });
  const zero = scoreResume([req('Rust', 'unsupported'), req('Go', 'unsupported')], { summary: '', recent: '', other: 'C# developer' });
  assert.equal(zero.qualificationMatch, 0);
  assert.equal(zero.keywordCoverage, 0);
  const full = scoreResume([req('Azure', 'verified'), req('Kafka', 'verified', 'Low')], { summary: 'Azure and Kafka', recent: '', other: 'Azure and Kafka' });
  assert.equal(full.qualificationMatch, 100);
  assert.equal(full.supportedAlignment, 100);
  const mixed = scoreResume([req('Azure', 'verified'), req('Go', 'unsupported', 'High'), req('Kafka', 'verified', 'Medium')], { summary: 'Azure', recent: '', other: 'Azure Kafka' });
  // credits: Azure 5×1×1=5, Go 0, Kafka 2×1×0.75=1.5 → 6.5/10
  assert.equal(mixed.qualificationMatch, 65);
  assert.equal(mixed.supportedAlignment, Math.round((6.5 / 7) * 1000) / 10);
});

// ── Test 9 — Complete input processing ────────────────────────────────
test('T9: long resume and long JD are processed without truncation', async () => {
  const filler = 'You will collaborate with product, QA and platform teams on delivery planning and quality. '.repeat(70);
  const jd = `Senior .NET Developer. ${filler} Late requirement at the very end: Snowflake data warehousing and SSRS reporting.`;
  assert.ok(jd.length > 6000);
  const { result, provider } = await run(DOTNET, jd);
  const analysisCall = provider.calls[0].user;
  assert.ok(analysisCall.includes('Late requirement at the very end'), 'full JD sent');
  assert.ok(analysisCall.includes('Infosys'), 'oldest project sent (resume > 6,000 chars)');
  const lastBullet = loadDocx(DOTNET).model.projects.at(-1).bullets.at(-1).slice(0, 60);
  assert.ok(analysisCall.includes(lastBullet.slice(0, 40)), 'last bullet of the resume sent');
  const names = result.requirements.map(r => r.requirement);
  assert.ok(names.includes('Snowflake') && names.includes('SSRS'), `late JD requirements extracted: ${names}`);
});

// ── Domain tests (universal engine) ───────────────────────────────────
const DOMAIN_CASES = [
  ['D1 .NET resume vs Senior .NET/Azure JD', DOTNET, 'Senior .NET Developer: C#, ASP.NET Core, .NET 8, Azure Functions, Azure App Services, SQL Server, Entity Framework Core, Microservices.', 'dotnet'],
  ['D2 .NET resume vs Angular/React full stack JD', DOTNET, '.NET Full Stack Developer: C#, ASP.NET Core Web API, Angular or React, TypeScript, RxJS, SQL Server, Azure DevOps.', 'dotnet'],
  ['D3 GenAI resume vs RAG/LLM JD', makeResume('genai'), 'RAG / LLM Engineer: LLMs, RAG, embeddings, vector search, Pinecone, reranking, prompt engineering, LLM evaluation, Python, FastAPI.', 'genai'],
  ['D4 GenAI resume vs Agentic AI JD', makeResume('genai'), 'Agentic AI Engineer: agentic AI, LangGraph, tool calling, agent orchestration, MCP, guardrails, LLM evaluation, Python.', 'genai'],
  ['D5 AI/ML resume vs ML Engineer JD', makeResume('aiml'), 'Machine Learning Engineer: Python, Scikit-learn, XGBoost, LightGBM, feature engineering, model evaluation, PyTorch.', 'aiml'],
  ['D6 AI/ML resume vs MLOps JD', makeResume('aiml'), 'MLOps Engineer: MLflow, Kubeflow, SageMaker, model deployment, drift monitoring, Docker, Kubernetes, Python.', 'aiml'],
  ['D7 Hybrid resume vs AI-powered .NET JD', makeResume('hybrid'), 'Senior .NET AI Engineer: C#, ASP.NET Core, Azure OpenAI, Semantic Kernel, RAG, Azure AI Search, prompt engineering, Angular, SQL Server.', 'hybrid'],
];

for (const [name, resume, jd, expected] of DOMAIN_CASES) {
  test(`${name} → ${expected} engine, full V2 rules`, async () => {
    const { result } = await run(resume, jd);
    assert.equal(result.domain.used, expected, JSON.stringify(result.domain));
    assert.equal(result.editableProjects.length, 2);
    assert.ok(result.lockedProjects.every(p => p.intact));
    const f = result.validation.formatting;
    assert.ok(f.counts.summary >= 18, `summary ${f.counts.summary}`);
    for (const p of f.counts.projects.filter(x => x.editable)) assert.ok(p.bullets >= 15, `${p.client}: ${p.bullets}`);
    assert.deepEqual(f.issues.filter(i => !/protected project/.test(i)), []);
    if (result.validation.pageCountVerified && result.validation.pageCount !== 6) {
      assert.ok(result.validation.warnings.some(w => /renders to \d+ page/.test(w)), 'page shortfall is reported, not hidden');
    }
    assert.ok(result.scores.after.supportedAlignment >= 0 && result.scores.after.supportedAlignment <= 100);
  });
}

test('D8: AI/ML resume is not given .NET responsibilities by a .NET JD', async () => {
  const { result } = await run(makeResume('aiml'), 'Senior .NET Developer: C#, ASP.NET Core, Angular, SQL Server, Azure Functions.', {
    projectInjections: [['Developed ASP.NET Core Web APIs in C# for the forecasting platform with Angular dashboards.']],
  });
  const recent = recentText(result);
  assert.ok(!hasTerm(recent, 'ASP.NET Core') && !hasTerm(recent, 'C#') && !hasTerm(recent, 'Angular'));
  assert.ok(result.unsupportedSkills.some(u => u.requirement === 'C#'));
});

test('D9: candidate profiles are isolated (no cross-candidate leakage)', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'rai-')));
  const provider = createMockProvider();
  const { server, base, token } = await startServer(provider, store);
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const a = await upload(base, token, Buffer.from(makeResume('genai')), 'a.txt', 'RAG Engineer: LLMs, RAG, Pinecone, Python.');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const cidA = a.body.v2.candidate.id;
    const projA = a.body.v2.projects[0].id;
    const conf = await fetch(`${base}/api/candidates/${cidA}/confirmations`, { method: 'POST', headers: auth, body: JSON.stringify({ skill: 'Weaviate', projectId: projA, evidence: 'Ran a Weaviate cluster for the claims search pilot, 40M vectors, hybrid queries.' }) });
    assert.equal(conf.status, 201);
    const bad = await fetch(`${base}/api/candidates/${cidA}/confirmations`, { method: 'POST', headers: auth, body: JSON.stringify({ skill: 'Rust', evidence: 'yes' }) });
    assert.equal(bad.status, 400, 'a bare keyword without evidence is rejected');

    provider.calls.length = 0;
    const b = await upload(base, token, Buffer.from(makeResume('aiml')), 'b.txt', 'ML Engineer: Python, Weaviate, PyTorch, MLflow.');
    assert.equal(b.status, 200);
    assert.notEqual(b.body.v2.candidate.id, cidA);
    const prompts = provider.calls.map(c => c.user).join('\n');
    assert.ok(!prompts.includes('Weaviate cluster') && !prompts.includes('Northwind'), 'candidate A data never reaches candidate B');
    assert.ok(b.body.v2.unsupportedSkills.some(u => u.requirement === 'Weaviate'));

    provider.calls.length = 0;
    const a2 = await upload(base, token, Buffer.from(makeResume('genai')), 'a.txt', 'RAG Engineer: Weaviate, LLMs, Python.', { candidateId: cidA });
    assert.equal(a2.status, 200);
    const w = a2.body.v2.requirements.find(r => r.requirement === 'Weaviate');
    assert.equal(w.supportStatus, 'confirmed', 'confirmed skill reused for the same candidate');

    const list = await (await fetch(`${base}/api/candidates`, { headers: auth })).json();
    assert.equal(list.candidates.length, 2);
  } finally { server.close(); }
});

test('D10: V1 response fields are preserved for the existing frontend', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'rai-')));
  const { server, base, token } = await startServer(createMockProvider(), store);
  try {
    const { status, body } = await upload(base, token, DOTNET, 'r.docx', 'Senior .NET Developer: C#, Azure, SQL Server, Angular.');
    assert.equal(status, 200);
    for (const k of ['success', 'docxBase64', 'optimizedResume', 'matchScore', 'matchScoreBefore', 'changes', 'keywordsAdded', 'bulletsEnhanced', 'stackSwaps', 'pointsTrimmed', 'sectionsImproved', 'swapsApplied', 'removedCount', 'addedCount', 'jdStack', 'summary']) assert.ok(k in body, k);
    assert.ok(!body.changes.some(c => /already well matched/i.test(c.description)));
    const hist = await (await fetch(`${base}/api/resume/history`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(hist.history.length, 1);
  } finally { server.close(); }
});
