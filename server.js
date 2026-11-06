'use strict';
// ResumeAI V2 — universal, domain-aware resume tailoring API.
// Backward compatible with the V1 frontend (same auth routes and the same
// /api/resume/optimize response fields), plus V2 fields under `v2`.

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const { Store } = require('./store');
const { createAnthropicProvider, AIError } = require('./ai');
const { tailor, PipelineError, toDocx, mergeSettings } = require('./tailor');
const { loadDocx, slug } = require('./resumeModel');
const render = require('./render');

function createApp({ provider = createAnthropicProvider(), store = new Store(), log = console } = {}) {
  const app = express();
  app.set('trust proxy', 1);

  if (config.jwtSecret === 'your-super-secret-jwt-key') log.warn('[security] JWT_SECRET is not set — using the insecure default. Set JWT_SECRET on Railway.');

  app.use(cors({ origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins, credentials: false, exposedHeaders: ['X-Request-Id'] }));
  app.use(express.json({ limit: '1mb' }));

  // Request IDs
  app.use((req, res, next) => {
    req.id = (req.get('X-Request-Id') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    next();
  });

  const fail = (res, req, status, code, error, extra = {}) => res.status(status).json({ success: false, error, code, requestId: req.id, ...extra });

  const optimizeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: config.rateLimitPerHour,
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => fail(res, req, 429, 'RATE_LIMITED', 'Too many requests. Please try again in an hour.'),
  });
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => fail(res, req, 429, 'RATE_LIMITED', 'Too many attempts. Please wait a few minutes.') });

  const ALLOWED = ['.pdf', '.doc', '.docx', '.txt'];
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED.includes(ext)) cb(null, true);
      else cb(Object.assign(new Error('Only PDF, DOC, DOCX, TXT files are allowed'), { code: 'UNSUPPORTED_FORMAT' }));
    },
  });

  /** Check the file content matches its extension (magic bytes). */
  function sniff(buf, ext) {
    const head = buf.slice(0, 8);
    if (ext === '.docx') return head[0] === 0x50 && head[1] === 0x4b;
    if (ext === '.pdf') return head.slice(0, 4).toString() === '%PDF';
    if (ext === '.doc') return head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
    if (ext === '.txt') return !buf.slice(0, 4096).includes(0);
    return false;
  }

  function generateToken(user) {
    return jwt.sign({ userId: user.id, email: user.email }, config.jwtSecret, { expiresIn: '7d' });
  }

  function authMiddleware(req, res, next) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return fail(res, req, 401, 'NO_TOKEN', 'No token provided');
    try {
      req.user = jwt.verify(h.split(' ')[1], config.jwtSecret);
      if (!store.getUser(req.user.email)) return fail(res, req, 401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
      next();
    } catch { return fail(res, req, 401, 'INVALID_TOKEN', 'Invalid or expired token'); }
  }

  // ══ AUTH (unchanged contract) ═══════════════════════════════════════
  app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
      const { name, email, password } = req.body || {};
      if (!name || !email || !password) return fail(res, req, 400, 'VALIDATION', 'All fields required');
      if (!/^\S+@\S+\.\S+$/.test(String(email))) return fail(res, req, 400, 'VALIDATION', 'Enter a valid email');
      if (String(password).length < 8) return fail(res, req, 400, 'VALIDATION', 'Password must be 8+ characters');
      if (store.getUser(email)) return fail(res, req, 409, 'EXISTS', 'Email already registered');
      const user = {
        id: `user_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        name: String(name).trim().slice(0, 100), email: String(email).toLowerCase().trim(),
        passwordHash: await bcrypt.hash(String(password), 12), createdAt: new Date().toISOString(),
      };
      store.addUser(user);
      res.status(201).json({ token: generateToken(user), user: { id: user.id, name: user.name, email: user.email } });
    } catch (e) { log.error(`[${req.id}] register`, e); fail(res, req, 500, 'SERVER', 'Registration failed'); }
  });

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) return fail(res, req, 400, 'VALIDATION', 'Email and password required');
      const user = store.getUser(email);
      if (!user || !(await bcrypt.compare(String(password), user.passwordHash))) return fail(res, req, 401, 'BAD_CREDENTIALS', 'Invalid email or password');
      res.json({ token: generateToken(user), user: { id: user.id, name: user.name, email: user.email } });
    } catch (e) { log.error(`[${req.id}] login`, e); fail(res, req, 500, 'SERVER', 'Login failed'); }
  });

  app.post('/api/auth/logout', authMiddleware, (req, res) => res.json({ message: 'Logged out' }));

  app.get('/api/auth/me', authMiddleware, (req, res) => {
    const u = store.getUser(req.user.email);
    res.json({ id: u.id, name: u.name, email: u.email });
  });

  // ══ SETTINGS ════════════════════════════════════════════════════════
  app.get('/api/settings/defaults', (req, res) => res.json({ defaults: config.defaults, domains: ['dotnet', 'genai', 'aiml', 'hybrid'] }));

  // ══ CANDIDATES & CONFIRMATIONS (isolated per user + candidate) ══════
  app.get('/api/candidates', authMiddleware, (req, res) => res.json({ candidates: store.listCandidates(req.user.userId) }));

  app.get('/api/candidates/:cid', authMiddleware, (req, res) => {
    const c = store.getCandidate(req.user.userId, req.params.cid);
    if (!c) return fail(res, req, 404, 'NOT_FOUND', 'Candidate not found');
    res.json({ candidate: { id: c.id, name: c.name, projects: c.projects, confirmations: c.confirmations, domain: c.domain } });
  });

  app.post('/api/candidates/:cid/confirmations', authMiddleware, (req, res) => {
    const { skill, projectId, evidence } = req.body || {};
    if (!skill || String(skill).trim().length < 2) return fail(res, req, 400, 'VALIDATION', 'Skill is required');
    // The description is optional; ticking the skill is the recruiter's confirmation.
    if (String(skill).length > 80 || String(evidence).length > 1000) return fail(res, req, 400, 'VALIDATION', 'Skill or evidence is too long');
    try {
      const conf = store.addConfirmation(req.user.userId, req.params.cid, { skill, projectId: projectId || null, evidence: String(evidence || '').trim() || 'Confirmed by recruiter' });
      res.status(201).json({ confirmation: conf });
    } catch (e) { fail(res, req, e.status || 500, 'CONFIRMATION', e.message); }
  });

  // Confirm several queued skills in one click.
  app.post('/api/candidates/:cid/confirmations/batch', authMiddleware, (req, res) => {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 40) : [];
    if (!items.length) return fail(res, req, 400, 'VALIDATION', 'No confirmations supplied');
    const saved = [], errors = [];
    for (const it of items) {
      const skill = String((it && it.skill) || '').trim();
      const evidence = String((it && it.evidence) || '').trim() || 'Confirmed by recruiter';
      if (skill.length < 2 || skill.length > 80 || evidence.length > 1000) { errors.push({ skill, error: 'Invalid skill name or description too long' }); continue; }
      try { saved.push(store.addConfirmation(req.user.userId, req.params.cid, { skill, projectId: it.projectId || null, evidence })); }
      catch (e) { errors.push({ skill, error: e.message }); }
    }
    if (!saved.length) return fail(res, req, 400, 'VALIDATION', errors.map(e => `${e.skill}: ${e.error}`).join('; ') || 'Nothing to save', { saved, errors });
    res.status(201).json({ saved, errors });
  });

  app.delete('/api/candidates/:cid/confirmations/:confId', authMiddleware, (req, res) => {
    try {
      const ok = store.removeConfirmation(req.user.userId, req.params.cid, req.params.confId);
      if (!ok) return fail(res, req, 404, 'NOT_FOUND', 'Confirmation not found');
      res.json({ removed: true });
    } catch (e) { fail(res, req, e.status || 500, 'CONFIRMATION', e.message); }
  });

  // ── background jobs (in memory, cleared after 30 minutes) ──
  const jobs = new Map();
  setInterval(() => { const cut = Date.now() - 30 * 60 * 1000; for (const [id, j] of jobs) if ((j.finishedAt || j.startedAt) < cut) jobs.delete(id); }, 60 * 1000).unref();

  function errorInfo(err, requestId) {
    if (err instanceof AIError) {
      log.error(`[${requestId}] AI failure at ${err.stage || 'ai'}: ${err.kind} — ${err.message}`);
      return { status: err.kind === 'config' || err.kind === 'auth' ? 503 : 502, code: `AI_${String(err.kind).toUpperCase()}`, stage: err.stage || null,
        error: `The AI step failed (${err.kind.replace('_', ' ')}): ${err.message} Your resume was NOT tailored — please try again.` };
    }
    if (err instanceof PipelineError || err.code === 'INVALID_DOCX' || err.code === 'UNSUPPORTED_FORMAT') return { status: err.status || 422, code: err.code || 'PARSE_FAILED', error: err.message };
    log.error(`[${requestId}] optimize error`, err);
    return { status: 500, code: 'SERVER', error: `Optimization failed: ${err.message}` };
  }

  function buildPayload(result, { requestId, historyId, candidate }) {
    const added = result.changes.filter(c => c.type === 'added').length;
    const removed = result.changes.filter(c => c.type === 'removed').length;
    return {
      success: true, requestId, historyId,
      docxBase64: result.buffer.toString('base64'),
      optimizedResume: result.fullText,
      matchScore: Math.round(result.scores.after.qualificationMatch),
      matchScoreBefore: Math.round(result.scores.before.qualificationMatch),
      changes: result.changes.map(c => ({ type: c.type, description: c.description, section: c.section })),
      keywordsAdded: result.scores.after.keywordCoverage > result.scores.before.keywordCoverage ? Math.round((result.scores.after.keywordCoverage - result.scores.before.keywordCoverage) / 100 * result.requirements.length) : 0,
      bulletsEnhanced: result.preview.projects.reduce((n, p) => n + p.bullets.length, 0) + result.preview.professionalSummary.length,
      stackSwaps: 0, pointsTrimmed: removed,
      sectionsImproved: result.changes.filter(c => c.type === 'modified').length,
      swapsApplied: [], removedCount: removed, addedCount: added,
      jdStack: { swapsDetected: 0, roleType: result.roleType },
      summary: `Tailored for ${result.jdTitle || 'this JD'} (${result.domain.label}). Supported keyword coverage ${result.scores.after.supportedKeywordCoverage}%; ${result.reviewDrafts.length} review draft(s) for unverified JD technologies.`,
      v2: {
        candidate: { id: candidate.id, name: candidate.name },
        domain: result.domain, jdTitle: result.jdTitle, scores: result.scores,
        requirements: result.requirements, coverageMatrix: result.coverageMatrix, confirmationQueue: result.confirmationQueue,
        reviewDrafts: result.reviewDrafts, reviewDraftsDocxBase64: result.reviewDraftsDocx ? result.reviewDraftsDocx.toString('base64') : null,
        supportedSkills: result.supportedSkills, transferableSkills: result.transferableSkills, unsupportedSkills: result.unsupportedSkills,
        projects: result.projects, lockedProjects: result.lockedProjects, preview: result.preview,
        validation: result.validation, settings: result.settings, source: result.source, timings: result.timings,
      },
    };
  }

  // ══ OPTIMIZE ════════════════════════════════════════════════════════
  app.post('/api/resume/optimize', authMiddleware, optimizeLimiter, upload.single('resume'), async (req, res) => {
    const started = Date.now();
    try {
      if (!req.file) return fail(res, req, 400, 'VALIDATION', 'Resume file is required');
      const jdText = String((req.body && req.body.jobDescription) || '').trim();
      if (jdText.length < 20) return fail(res, req, 400, 'VALIDATION', 'Job description is required');
      if (jdText.length > 60000) return fail(res, req, 400, 'VALIDATION', 'Job description is too long (60,000 characters max).');
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!sniff(req.file.buffer, ext)) return fail(res, req, 400, 'FILE_MISMATCH', `The file content does not look like a valid ${ext} file.`);

      let settings = {};
      if (req.body.settings) {
        try { settings = JSON.parse(req.body.settings); } catch { return fail(res, req, 400, 'VALIDATION', 'settings must be valid JSON'); }
      }
      if (req.body.domainOverride) settings.domainOverride = req.body.domainOverride;

      // Parse once to identify the candidate and their confirmations.
      const prepared = await toDocx(req.file.buffer, req.file.originalname);
      const { model } = loadDocx(prepared.docx);
      let candidateId = String(req.body.candidateId || '').trim();
      if (candidateId && !store.getCandidate(req.user.userId, candidateId)) return fail(res, req, 404, 'NOT_FOUND', 'Selected candidate profile not found');
      if (!candidateId) candidateId = slug(model.header.name || 'candidate');
      const existing = store.getCandidate(req.user.userId, candidateId);
      const candidate = store.upsertCandidate(req.user.userId, {
        id: candidateId,
        name: (existing && existing.name) || model.header.name || 'Candidate',
        projects: model.projects.map(p => ({ id: p.id, client: p.client, role: p.role, dates: p.dates ? p.dates.raw : null })),
        masterText: model.fullText,
      });
      const confirmations = candidate.confirmations || [];

      const runTailor = progress => tailor(
        { fileBuffer: req.file.buffer, fileName: req.file.originalname, jdText, settings, confirmations, prepared },
        { provider, requestId: req.id, log, progress },
      );
      const finish = result => {
        const historyId = `opt_${Date.now()}`;
        store.addHistory(req.user.userId, {
          id: historyId, candidateId, candidateName: candidate.name,
          jdSnippet: jdText.slice(0, 200), jdTitle: result.jdTitle,
          matchScore: Math.round(result.scores.after.qualificationMatch),
          matchScoreBefore: Math.round(result.scores.before.qualificationMatch),
          scores: result.scores, pageCount: result.validation.pageCount, domain: result.domain.used,
          keywordsAdded: result.changes.length, createdAt: new Date().toISOString(),
        });
        log.log(`[${req.id}] optimize ok in ${Date.now() - started}ms — ${result.domain.used}, pages=${result.validation.pageCount}, supported=${result.scores.after.supportedKeywordCoverage}%`);
        return buildPayload(result, { requestId: req.id, historyId, candidate });
      };

      // Background job: the browser polls, so long runs never hit a connection timeout.
      if (String(req.body.async || '') === '1') {
        const job = { id: `job_${crypto.randomBytes(8).toString('hex')}`, userId: req.user.userId, status: 'running', stage: 'Starting', startedAt: Date.now(), requestId: req.id };
        jobs.set(job.id, job);
        res.status(202).json({ success: true, jobId: job.id, requestId: req.id });
        runTailor(stage => { job.stage = stage; })
          .then(result => { job.result = finish(result); job.status = 'done'; })
          .catch(err => { const e = errorInfo(err, req.id); job.status = 'error'; job.error = e; })
          .finally(() => { job.finishedAt = Date.now(); });
        return;
      }

      const result = await runTailor();
      res.json(finish(result));
    } catch (err) {
      const e = errorInfo(err, req.id);
      fail(res, req, e.status, e.code, e.error, e.stage ? { stage: e.stage } : {});
    }
  });

  app.get('/api/resume/jobs/:id', authMiddleware, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.userId) return fail(res, req, 404, 'JOB_NOT_FOUND', 'This run is no longer on the server (it may have restarted). Please click Generate again.');
    const base = { jobId: job.id, status: job.status, stage: job.stage, elapsedMs: (job.finishedAt || Date.now()) - job.startedAt, requestId: job.requestId };
    if (job.status === 'done') return res.json({ ...base, success: true, result: job.result });
    if (job.status === 'error') return res.status(job.error.status).json({ ...base, success: false, error: job.error.error, code: job.error.code });
    res.json({ ...base, success: true });
  });

  app.get('/api/resume/history', authMiddleware, (req, res) => res.json({ history: store.getHistory(req.user.userId) }));

  app.get('/health', async (req, res) => res.json({
    status: 'ok', uptime: process.uptime(), model: config.model,
    aiConfigured: !!config.anthropicApiKey, pageRenderer: await render.isAvailable(),
    jwtSecretSet: config.jwtSecret !== 'your-super-secret-jwt-key',
  }));

  // Errors (multer, JSON body, etc.)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') return fail(res, req, 413, 'FILE_TOO_LARGE', 'File too large (max 5MB)');
    if (err.code === 'UNSUPPORTED_FORMAT') return fail(res, req, 400, 'UNSUPPORTED_FORMAT', err.message);
    if (err.type === 'entity.parse.failed') return fail(res, req, 400, 'VALIDATION', 'Invalid JSON body');
    log.error(`[${req.id}] unhandled`, err);
    fail(res, req, 500, 'SERVER', err.message || 'Server error');
  });

  return app;
}

if (require.main === module) {
  // Log, don't crash, on stray async errors so the service stays up.
  process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
  process.on('uncaughtException', e => console.error('[uncaughtException]', e));
  const app = createApp();
  app.listen(config.port, () => console.log(`ResumeAI V2 running on http://localhost:${config.port} (model ${config.model})`));
}

module.exports = { createApp, mergeSettings };
