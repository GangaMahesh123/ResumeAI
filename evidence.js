'use strict';
// Evidence engine: decides what the candidate can truthfully claim, and
// guards AI output so no unsupported technology reaches the resume.

const { LIBRARY, hasTerm, hasAny, allNames, findLibraryTerms } = require('./domains');

const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
const NON_TECH_CATEGORIES = new Set(['responsibility', 'experience_years', 'other']);

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

function confText(c) { return `${c.skill} ${c.evidence}`; }

function confirmationsFor(confirmations, projectId) {
  return (confirmations || []).filter(c => (projectId ? c.projectId === projectId : true));
}

function confirmationMatches(conf, terms) {
  return terms.some(t => hasTerm(conf.skill, t) || hasTerm(t, conf.skill));
}

function projectSourceText(project) {
  return [project.client, project.role, ...(project.bullets || []), project.environment || ''].join('\n');
}

/**
 * Normalise the AI requirement matrix and RE-VERIFY every status in code,
 * so the AI cannot mark something "verified" that the resume doesn't show.
 */
function normalizeRequirements(rawReqs, { model, confirmations, jdText }) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(rawReqs) ? rawReqs : [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const name = str(r.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const terms = [...new Set([name, ...(Array.isArray(r.terms) ? r.terms : [])].map(str).filter(t => t && t.length <= 60))];
    out.push({
      id: str(r.id) || `r${out.length + 1}`,
      name,
      category: str(r.category) || 'other',
      priority: PRIORITIES.includes(r.priority) ? r.priority : 'Medium',
      mandatory: !!r.mandatory,
      terms,
      yearsRequired: Number.isFinite(Number(r.yearsRequired)) && r.yearsRequired !== null ? Number(r.yearsRequired) : null,
      aiStatus: str(r.status),
      evidenceNote: str(r.evidence),
      relatedEvidence: str(r.relatedEvidence),
      source: 'ai',
    });
  }

  // Safety net: any library technology named in the JD that the AI skipped
  // (e.g. buried at the end of a long JD) becomes a Low/Medium requirement.
  for (const e of findLibraryTerms(jdText)) {
    const names = allNames(e);
    const covered = out.some(r => r.terms.some(t => names.some(n => n.toLowerCase() === t.toLowerCase())) || names.some(n => hasAny(r.name, [n])));
    if (!covered) {
      out.push({
        id: `lib_${out.length + 1}`, name: e.term, category: e.category, priority: 'Low', mandatory: false,
        terms: names, yearsRequired: null, aiStatus: '', evidenceNote: '', relatedEvidence: '', source: 'library',
      });
    }
  }

  for (const r of out) verifyRequirement(r, { model, confirmations });
  return out;
}

function verifyRequirement(r, { model, confirmations }) {
  if (r.category === 'experience_years' || r.yearsRequired) {
    const yrs = model.experienceYears;
    r.status = yrs !== null && r.yearsRequired !== null && yrs >= r.yearsRequired ? 'verified' : (yrs === null ? 'unsupported' : (yrs >= (r.yearsRequired || 0) ? 'verified' : 'unsupported'));
    r.evidence = yrs !== null ? `${yrs} years from project dates` : 'Employment dates not found';
    r.evidenceProjects = [];
    r.yearsCheck = true;
    return r;
  }
  const inResume = hasAny(model.fullText, r.terms);
  const projects = model.projects.filter(p => hasAny(projectSourceText(p), r.terms)).map(p => p.id);
  const confs = (confirmations || []).filter(c => confirmationMatches(c, r.terms));
  if (inResume) {
    r.status = 'verified';
    r.evidence = r.evidenceNote || 'Found in master resume';
  } else if (confs.length) {
    r.status = 'confirmed';
    r.evidence = confs.map(c => `${c.skill}: ${c.evidence}`).join('; ');
  } else if (NON_TECH_CATEGORIES.has(r.category) && r.aiStatus === 'verified' && r.evidenceNote) {
    // Responsibilities are judged semantically (e.g. "led backend initiatives").
    r.status = 'verified';
    r.evidence = r.evidenceNote;
  } else if (r.aiStatus === 'transferable' && r.relatedEvidence) {
    r.status = 'transferable';
    r.evidence = r.relatedEvidence;
  } else {
    r.status = 'unsupported';
    r.evidence = r.evidenceNote || 'No evidence in resume or confirmations';
  }
  r.evidenceProjects = [...new Set([...projects, ...confs.map(c => c.projectId).filter(Boolean)])];
  return r;
}

/** Groups of names that represent one technology, for the guard. */
function termGroups(requirements) {
  const groups = LIBRARY.map(e => ({ label: e.term, names: allNames(e) }));
  for (const r of requirements || []) {
    if (NON_TECH_CATEGORIES.has(r.category)) continue;
    // Only gaps need guarding by JD wording; verified/confirmed terms are
    // still guarded per project through the library groups.
    if (r.status !== 'unsupported' && r.status !== 'transferable') continue;
    const names = r.terms.filter(t => t.length >= 2 && t.split(/\s+/).length <= 4);
    if (names.length) groups.push({ label: r.name, names });
  }
  return groups;
}

/** Technology groups mentioned in `text` that have no support in `source`. */
function unsupportedIn(text, source, groups) {
  const bad = [];
  for (const g of groups) {
    if (!hasAny(text, g.names)) continue;
    if (hasAny(source, g.names)) continue;
    bad.push(g.label);
  }
  return [...new Set(bad)];
}

/**
 * Check a rewrite against the evidence rules.
 * Returns violations per section/bullet.
 */
function guardRewrite(rewrite, { model, confirmations, requirements, editable }) {
  const groups = termGroups(requirements);
  const allConf = (confirmations || []).map(confText).join('\n');
  const globalSource = `${model.fullText}\n${allConf}`;
  const violations = [];

  rewrite.professionalSummary.forEach((b, i) => {
    const bad = unsupportedIn(b, globalSource, groups);
    if (bad.length) violations.push({ section: 'summary', index: i, text: b, terms: bad });
  });

  rewrite.technicalSkills.forEach((cat, ci) => {
    cat.items.forEach((item, ii) => {
      const bad = unsupportedIn(item, globalSource, groups);
      if (bad.length) violations.push({ section: 'skills', category: ci, index: ii, text: item, terms: bad });
    });
  });

  for (const p of editable) {
    const rp = rewrite.projects[p.id];
    if (!rp) continue;
    const projConfs = (confirmations || []).filter(c => c.projectId === p.id).map(confText).join('\n');
    const source = `${projectSourceText(p)}\n${projConfs}`;
    rp.bullets.forEach((b, i) => {
      const bad = unsupportedIn(b, source, groups);
      if (bad.length) violations.push({ section: 'project', projectId: p.id, index: i, text: b, terms: bad });
    });
    rp.environment.forEach((e, i) => {
      const bad = unsupportedIn(e, source, groups);
      if (bad.length) violations.push({ section: 'environment', projectId: p.id, index: i, text: e, terms: bad });
    });
  }
  return violations;
}

/** Remove whatever is still unsupported after the AI repair passes. */
function enforceGuard(rewrite, violations) {
  const removed = [];
  const drop = (arr, idxs) => arr.filter((_, i) => !idxs.has(i));
  const bySection = key => new Set(violations.filter(key).map(v => v.index));

  const sumIdx = bySection(v => v.section === 'summary');
  if (sumIdx.size) {
    rewrite.professionalSummary.forEach((b, i) => sumIdx.has(i) && removed.push({ section: 'Professional Summary', text: b, terms: violations.find(v => v.section === 'summary' && v.index === i).terms }));
    rewrite.professionalSummary = drop(rewrite.professionalSummary, sumIdx);
  }
  rewrite.technicalSkills.forEach((cat, ci) => {
    const idx = bySection(v => v.section === 'skills' && v.category === ci);
    if (!idx.size) return;
    cat.items.forEach((it, i) => idx.has(i) && removed.push({ section: 'Technical Skills', text: it }));
    cat.items = drop(cat.items, idx);
  });
  rewrite.technicalSkills = rewrite.technicalSkills.filter(c => c.items.length);
  for (const [pid, rp] of Object.entries(rewrite.projects)) {
    const bIdx = bySection(v => v.section === 'project' && v.projectId === pid);
    rp.bullets.forEach((b, i) => bIdx.has(i) && removed.push({ section: pid, text: b, terms: violations.find(v => v.section === 'project' && v.projectId === pid && v.index === i).terms }));
    rp.bullets = drop(rp.bullets, bIdx);
    const eIdx = bySection(v => v.section === 'environment' && v.projectId === pid);
    rp.environment.forEach((e, i) => eIdx.has(i) && removed.push({ section: `${pid} Environment`, text: e }));
    rp.environment = drop(rp.environment, eIdx);
  }
  return removed;
}

/** Version numbers introduced in a project that its original text never used. */
function versionWarnings(rewrite, editable) {
  const warnings = [];
  for (const p of editable) {
    const rp = rewrite.projects[p.id];
    if (!rp) continue;
    const src = projectSourceText(p);
    const text = [...rp.bullets, ...rp.environment].join(' ');
    const re = /\b([A-Za-z.#+]{2,}(?:\s(?:Core|Web API|Framework))?)\s(\d{1,2}(?:\.\d{1,2}){0,2}x?)\b/g;
    let m;
    const seen = new Set();
    while ((m = re.exec(text)) !== null) {
      const ver = m[2];
      const tok = `${m[1]} ${ver}`;
      if (seen.has(tok)) continue;
      seen.add(tok);
      if (!src.includes(ver)) warnings.push(`${p.client}: "${tok}" — version not in the original project; check it matches the project dates.`);
    }
  }
  return warnings.slice(0, 15);
}

/** Cap stated years of experience at the true total. */
function fixYears(summary, years) {
  if (!years) return { summary, fixed: false };
  const floor = Math.floor(years);
  let fixed = false;
  const out = summary.map(b => b.replace(/(\b(?:over|more than|nearly|around)?\s*)(\d{1,2})(\+?)(\s*\+?\s*years?)/gi, (all, pre, n, plus, rest) => {
    if (Number(n) > floor) { fixed = true; return `${pre}${floor}${plus}${rest}`; }
    return all;
  }));
  return { summary: out, fixed };
}

module.exports = {
  normalizeRequirements, verifyRequirement, guardRewrite, enforceGuard, versionWarnings,
  fixYears, termGroups, unsupportedIn, projectSourceText, confirmationsFor, PRIORITIES,
};
