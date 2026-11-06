'use strict';
// Fast gap closing after the rewrite:
//  - Technical Skills and Environment gaps are filled in code (the keyword is
//    already proven for that section by the evidence check).
//  - Summary / project bullet gaps are fixed with ONE small call to the fast
//    model that edits only the bullets involved.

const config = require('./config');
const { callJson } = require('./ai');
const { coveragePatchPrompt } = require('./prompts');
const { termGroups, unsupportedIn, projectSourceText } = require('./evidence');
const { cleanBullet } = require('./schema');
const { hasAny } = require('./domains');

const CATEGORY_HINTS = {
  language: /language|programming/i, framework: /framework|backend|\.net|library/i, frontend: /front|ui|web/i,
  cloud: /cloud|azure|aws|gcp/i, database: /data|sql|database/i, architecture: /architect|design|pattern/i,
  messaging: /messag|event|stream/i, devops: /devops|ci|cd|tool|container/i, security: /secur|auth|identity/i,
  testing: /test|quality/i, genai: /ai|ml|genai|llm|agent/i, aiml: /ai|ml|machine|data science/i, domain: /domain|industry/i,
};

function pickCategory(skills, category) {
  const hint = CATEGORY_HINTS[category];
  return (hint && skills.find(c => hint.test(c.category))) || skills[skills.length - 1];
}

/**
 * @param rows   score rows for the current draft (scoreResume().rows)
 * @returns { fixedSkills, fixedEnv, patchedBullets }
 */
async function closeGaps(rw, rows, ctx) {
  const { requirements, editable, model, confirmations, window, provider, requestId, log } = ctx;
  const stats = { fixedSkills: 0, fixedEnv: 0, patchedBullets: 0 };
  const reqById = new Map(requirements.map(r => [r.id, r]));
  const bulletTasks = new Map(); // section id → keywords

  for (const row of rows) {
    if (row.supportStatus !== 'verified' && row.supportStatus !== 'confirmed') continue;
    const r = reqById.get(row.id);
    const kw = row.keyword;
    for (const [key, cell] of Object.entries(row.cells)) {
      if (!cell.applicable || cell.present) continue;
      if (key === 'skills' && rw.technicalSkills.length) {
        const cat = pickCategory(rw.technicalSkills, r && r.category);
        if (!cat.items.some(i => hasAny(i, [kw]))) { cat.items.push(kw); stats.fixedSkills++; }
      } else if (key.startsWith('env:')) {
        const p = rw.projects[key.slice(4)];
        if (p && !p.environment.some(e => hasAny(e, [kw]))) { p.environment.push(kw); stats.fixedEnv++; }
      } else if (key === 'summary' || key.startsWith('project:')) {
        const sec = key === 'summary' ? 's' : `p:${key.slice(8)}`;
        if (!bulletTasks.has(sec)) bulletTasks.set(sec, []);
        bulletTasks.get(sec).push(kw);
      }
    }
  }
  if (!bulletTasks.size) return stats;

  const sectionBullets = sec => (sec === 's' ? rw.professionalSummary : (rw.projects[sec.slice(2)] || { bullets: [] }).bullets);
  const tasks = [...bulletTasks.entries()].map(([sec, keywords]) => ({
    section: sec,
    sectionName: sec === 's' ? 'Professional Summary' : (editable.find(p => p.id === sec.slice(2)) || {}).client,
    keywordsToInclude: [...new Set(keywords)],
    bullets: sectionBullets(sec).map((text, index) => ({ index, text })),
  }));
  let raw;
  try {
    raw = await callJson(provider, { ...coveragePatchPrompt({ tasks, window }), maxTokens: Math.min(config.rewriteMaxTokens, 800 + tasks.reduce((n, t) => n + t.keywordsToInclude.length, 0) * 220), label: 'coverage-patch', requestId, log, model: config.fastModel, retries: 2 });
  } catch (e) { log.error(`[${requestId}] coverage-patch failed: ${e.kind || e.message}`); return stats; }

  const groups = termGroups(requirements);
  const confText = c => `${c.skill} ${c.evidence}`;
  for (const ed of Array.isArray(raw.edits) ? raw.edits : []) {
    const sec = String(ed && ed.section);
    const list = sectionBullets(sec);
    const i = Number(ed.index);
    const text = cleanBullet(ed && ed.text);
    if (!list.length || !Number.isInteger(i) || i < 0 || i >= list.length || text.length < 60) continue;
    const src = sec === 's'
      ? `${model.fullText}\n${(confirmations || []).map(confText).join('\n')}`
      : `${projectSourceText(editable.find(p => p.id === sec.slice(2)) || {})}\n${(confirmations || []).filter(c => c.projectId === sec.slice(2)).map(confText).join('\n')}`;
    const before = new Set(unsupportedIn(list[i], src, groups));
    if (unsupportedIn(text, src, groups).some(t => !before.has(t))) continue;
    list[i] = text;
    stats.patchedBullets++;
  }
  return stats;
}

module.exports = { closeGaps };
