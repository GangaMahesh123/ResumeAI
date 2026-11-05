'use strict';
// Requirement-based, explainable scoring. 0–100, no artificial floor/ceiling.
//
// Score A — Keyword Coverage
//   = requirements whose terms appear anywhere in the resume / all requirements × 100
//
// Score B — Qualification Match (priority-weighted)
//   weight:  Critical 5, High 3, Medium 2, Low 1
//   support: verified/confirmed 1.0, transferable 0.5, unsupported 0
//   visibility (where the evidence is shown in THIS resume version):
//     summary or an editable recent project  1.0
//     elsewhere (skills / older project)     0.75
//     not shown at all                        0.4
//   credit = weight × support × visibility;  B = Σcredit / Σweight × 100
//
// Supported Alignment = B computed only over verified/confirmed requirements.
//   This is the number the 98% target applies to (gaps cannot be "optimized").

const { hasAny } = require('./domains');

const WEIGHTS = { Critical: 5, High: 3, Medium: 2, Low: 1 };
const SUPPORT = { verified: 1, confirmed: 1, transferable: 0.5, unsupported: 0 };

function locate(req, sections) {
  if (req.yearsCheck) return req.status === 'verified' ? 'summary' : 'none';
  const terms = req.status === 'transferable' && req.relatedEvidence ? [...req.terms] : req.terms;
  if (hasAny(sections.summary, terms)) return 'summary';
  if (hasAny(sections.recent, terms)) return 'recent';
  if (hasAny(sections.other, terms)) return 'other';
  return 'none';
}

const VIS = { summary: 1, recent: 1, other: 0.75, none: 0.4 };

function round1(n) { return Math.round(n * 10) / 10; }

/**
 * @param requirements normalised requirement matrix
 * @param sections { summary, recent, other } plain text of the resume version
 */
function scoreResume(requirements, sections) {
  const rows = [];
  let present = 0, wSum = 0, cSum = 0, sW = 0, sC = 0;
  const all = `${sections.summary}\n${sections.recent}\n${sections.other}`;
  for (const r of requirements) {
    const location = locate(r, sections);
    const inResume = r.yearsCheck ? r.status === 'verified' : hasAny(all, r.terms);
    if (inResume) present++;
    const weight = WEIGHTS[r.priority] || 1;
    const support = SUPPORT[r.status] ?? 0;
    // Transferable credit depends on the related experience being shown, which
    // we can't literally match; give it full visibility so it's not double-penalised.
    const vis = r.status === 'transferable' ? 1 : VIS[location];
    const credit = weight * support * (support ? vis : 0);
    wSum += weight; cSum += credit;
    if (r.status === 'verified' || r.status === 'confirmed') { sW += weight; sC += credit; }
    rows.push({
      id: r.id, requirement: r.name, priority: r.priority, mandatory: r.mandatory,
      supportStatus: r.status, evidenceSource: r.evidence, evidenceProjects: r.evidenceProjects || [],
      resumeSection: location, inResume,
      scoreContribution: round1(credit), maxContribution: weight,
    });
  }
  const n = requirements.length || 1;
  return {
    keywordCoverage: round1((present / n) * 100),
    qualificationMatch: round1(wSum ? (cSum / wSum) * 100 : 0),
    supportedAlignment: round1(sW ? (sC / sW) * 100 : 0),
    criticalTotal: requirements.filter(r => r.priority === 'Critical').length,
    criticalCovered: rows.filter(x => x.priority === 'Critical' && (x.supportStatus === 'verified' || x.supportStatus === 'confirmed') && x.inResume).length,
    rows,
    formula: 'Keyword Coverage = requirements found in resume ÷ all requirements. Qualification Match = Σ(weight × support × visibility) ÷ Σweight, weights Critical 5 / High 3 / Medium 2 / Low 1; support verified/confirmed 1, transferable 0.5, unsupported 0; visibility summary or recent project 1, elsewhere 0.75, not shown 0.4. Supported Alignment = Qualification Match over verified/confirmed requirements only.',
  };
}

/** Supported requirements that are not shown in the summary or recent projects. */
function underrepresented(score) {
  return score.rows.filter(r => (r.supportStatus === 'verified' || r.supportStatus === 'confirmed') && (r.resumeSection === 'other' || r.resumeSection === 'none'));
}

module.exports = { scoreResume, underrepresented, WEIGHTS };
