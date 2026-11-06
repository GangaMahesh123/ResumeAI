'use strict';
// Requirement-based, section-aware coverage scoring. Every metric is 0–100,
// with no artificial floor or ceiling.
//
// For each JD requirement the matrix checks every target section:
//   Professional Summary · Technical Skills · each editable project's bullets
//   and Environment line (a project is applicable only when the candidate's
//   evidence — original text or a project-scoped confirmation — shows it there).
//
// Keyword Coverage          = JD requirements whose keywords appear in the resume ÷ all requirements
// Qualification Match       = Σ(weight × support) ÷ Σweight   (verified/confirmed 1, transferable 0.5, unsupported 0;
//                              weights Critical 5, High 3, Medium 2, Low 1) — measures real experience, never inflated
// Supported Keyword Coverage = applicable section slots filled ÷ applicable slots, over supported requirements
//                              (the 100% optimisation target)
// JD Extraction Completeness = explicit JD technical terms evaluated ÷ explicit terms found

const { hasAny, sameTech } = require('./domains');

const WEIGHTS = { Critical: 5, High: 3, Medium: 2, Low: 1 };
const SUPPORT = { verified: 1, confirmed: 1, transferable: 0.5, unsupported: 0 };
const NO_SKILLS_ROW = new Set(['responsibility', 'experience_years', 'domain', 'other']);

const round1 = n => Math.round(n * 10) / 10;
const isSupported = r => r.status === 'verified' || r.status === 'confirmed';

/**
 * @param sections { summary, skills, all, projects: [{ id, label, bullets, environment }] }
 */
function scoreResume(requirements, sections, { explicitTerms = null } = {}) {
  const explicitCount = explicitTerms ? explicitTerms.length : null;
  const rows = [];
  let present = 0, wSum = 0, qSum = 0, slots = 0, filled = 0;
  for (const r of requirements) {
    const supported = isSupported(r);
    const weight = WEIGHTS[r.priority] || 1;
    wSum += weight;
    qSum += weight * (SUPPORT[r.status] ?? 0);

    const inResume = r.yearsCheck ? r.status === 'verified' : hasAny(sections.all, r.terms);
    if (inResume) present++;

    const cells = {};
    const check = (key, applicable, text) => {
      cells[key] = { applicable, present: applicable ? (r.yearsCheck ? true : hasAny(text, r.terms)) : hasAny(text, r.terms) };
      if (applicable && supported) { slots++; if (cells[key].present) filled++; }
    };
    // The Summary must use the JD's exact wording; other sections accept equivalent names.
    cells.summary = { applicable: supported, present: r.yearsCheck ? true : hasAny(sections.summary, r.jdKeyword ? [r.jdKeyword] : r.terms) };
    if (supported) { slots++; if (cells.summary.present) filled++; }
    check('skills', supported && !NO_SKILLS_ROW.has(r.category) && !r.yearsCheck, sections.skills);
    for (const p of sections.projects) {
      const evidenced = supported && (r.evidenceProjects || []).includes(p.id);
      check(`project:${p.id}`, evidenced, p.bullets);
      check(`env:${p.id}`, evidenced && !NO_SKILLS_ROW.has(r.category), p.environment);
    }

    const applicable = Object.values(cells).filter(c => c.applicable);
    let finalStatus;
    if (!supported) finalStatus = r.status === 'transferable' ? 'Transferable' : 'Unverified';
    else if (applicable.every(c => c.present)) finalStatus = 'Covered';
    else if (applicable.some(c => c.present)) finalStatus = 'Partially covered';
    else finalStatus = 'Missing';

    rows.push({
      id: r.id, requirement: r.name, keyword: r.jdKeyword || r.terms[0], relatedEvidence: r.status === 'transferable' ? r.evidence : '', priority: r.priority, mandatory: r.mandatory, category: r.category,
      explicit: !!r.explicit, supportStatus: r.status, evidenceSource: r.evidence, evidenceProjects: r.evidenceProjects || [],
      cells, inResume, finalStatus,
      // legacy field used by older frontends
      resumeSection: cells.summary && cells.summary.present ? 'summary' : sections.projects.some(p => cells[`project:${p.id}`].present) ? 'recent' : inResume ? 'other' : 'none',
      scoreContribution: round1(weight * (SUPPORT[r.status] ?? 0)), maxContribution: weight,
    });
  }
  const n = requirements.length || 1;
  const explicitEvaluated = explicitTerms ? explicitTerms.filter(x => requirements.some(r => r.terms.some(t => sameTech(t, x.term)))).length : 0;
  return {
    keywordCoverage: round1((present / n) * 100),
    qualificationMatch: round1(wSum ? (qSum / wSum) * 100 : 0),
    supportedKeywordCoverage: round1(slots ? (filled / slots) * 100 : 0),
    supportedAlignment: round1(slots ? (filled / slots) * 100 : 0), // alias kept for compatibility
    extractionCompleteness: explicitCount ? round1(Math.min(100, (explicitEvaluated / explicitCount) * 100)) : 100,
    explicitTerms: explicitCount,
    criticalTotal: requirements.filter(r => r.priority === 'Critical').length,
    criticalCovered: rows.filter(x => x.priority === 'Critical' && x.finalStatus === 'Covered').length,
    supportedCount: rows.filter(x => x.supportStatus === 'verified' || x.supportStatus === 'confirmed').length,
    needsConfirmation: rows.filter(x => x.finalStatus === 'Unverified' || x.finalStatus === 'Transferable').length,
    rows,
    formula: 'Keyword Coverage = JD requirements found in the resume ÷ all requirements. Qualification Match = Σ(priority weight × support) ÷ Σweight, weights Critical 5 / High 3 / Medium 2 / Low 1, support verified/confirmed 1, related 0.5, unsupported 0. Supported Keyword Coverage = filled ÷ applicable sections (Summary, Technical Skills, and each recent project + Environment where the candidate has evidence) over supported requirements. JD Extraction Completeness = explicit JD technical terms evaluated ÷ found.',
  };
}

const SECTION_LABEL = (key, projects) => {
  if (key === 'summary') return 'Professional Summary';
  if (key === 'skills') return 'Technical Skills';
  const [kind, id] = key.split(':');
  const p = projects.find(x => x.id === id);
  return `${kind === 'env' ? 'Environment of ' : ''}${p ? p.label : id}`;
};

/** Supported requirements still missing from a section where they belong. */
function underrepresented(score, projects = []) {
  return score.rows
    .filter(r => (r.supportStatus === 'verified' || r.supportStatus === 'confirmed') && r.finalStatus !== 'Covered')
    .map(r => ({
      requirement: r.requirement, keyword: r.keyword, priority: r.priority, evidenceProjects: r.evidenceProjects,
      missingIn: Object.entries(r.cells).filter(([, c]) => c.applicable && !c.present).map(([k]) => SECTION_LABEL(k, projects)),
    }))
    .filter(x => x.missingIn.length);
}

module.exports = { scoreResume, underrepresented, WEIGHTS };
