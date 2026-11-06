'use strict';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const config = {
  port: num(process.env.PORT, 3001),
  jwtSecret: process.env.JWT_SECRET || 'your-super-secret-jwt-key',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  // Faster model for analysis, length fitting and page filling (falls back to CLAUDE_MODEL if unavailable).
  fastModel: process.env.CLAUDE_FAST_MODEL || 'claude-haiku-5-5',
  // Target end-to-end time. Optional polishing steps are skipped once this is used up.
  timeBudgetMs: num(process.env.TIME_BUDGET_MS, 110000),
  analysisMaxTokens: num(process.env.CLAUDE_ANALYSIS_MAX_TOKENS, 8000),
  rewriteMaxTokens: num(process.env.CLAUDE_REWRITE_MAX_TOKENS, 12000),
  requestTimeoutMs: num(process.env.CLAUDE_TIMEOUT_MS, 90000),
  maxRetries: num(process.env.CLAUDE_MAX_RETRIES, 3),
  optimizationPasses: num(process.env.OPTIMIZATION_MAX_PASSES, 1),
  layoutPasses: num(process.env.LAYOUT_MAX_PASSES, 2),
  lineFitPasses: num(process.env.LINEFIT_MAX_PASSES, 2),
  renderTimeoutMs: num(process.env.RENDER_TIMEOUT_MS, 90000),
  sofficePath: process.env.SOFFICE_PATH || 'soffice',
  dataDir: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
  rateLimitPerHour: num(process.env.RATE_LIMIT_PER_HOUR, 20),
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean),
  maxEditableProjects: 4,
  defaults: {
    alignmentTarget: 100,
    rewriteSummary: true,
    rewriteProject1: true,
    rewriteProject2: true,
    lockOlderProjects: true,
    optimizeSkills: true,
    reconcileEnvironment: true,
    requiredPages: 6,
    summaryMinBullets: 18,
    projectMinBullets: 15,
    preserveFacts: true,
    exactTwoLineBullets: true,
    domainOverride: '',
  },
};

module.exports = config;
