'use strict';
// Strict validation + safe repair of AI rewrite output.

const { AIError } = require('./ai');

function cleanBullet(s) {
  return String(s || '')
    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1').replace(/`/g, '')
    .replace(/^\s*(?:[-•*▪●◦]|\d+[.)])\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function strList(v) {
  if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : x && (x.text || x.bullet || x.name) || '')).map(cleanBullet).filter(Boolean);
  if (typeof v === 'string') return v.split(/;|\n/).map(cleanBullet).filter(Boolean);
  return [];
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(x => { const k = x.toLowerCase().replace(/[^a-z0-9]/g, ''); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * @returns {{rewrite, warnings}}
 */
function validateRewrite(raw, { editable, model }) {
  if (!raw || typeof raw !== 'object') throw new AIError('invalid_json', 'Rewrite output was not a JSON object.');
  const warnings = [];

  const professionalSummary = dedupe(strList(raw.professionalSummary)).filter(b => b.length >= 25 && b.length <= 600);
  if (!professionalSummary.length) throw new AIError('invalid_json', 'Rewrite output had no Professional Summary bullets.');

  let technicalSkills = [];
  const ts = raw.technicalSkills;
  if (Array.isArray(ts)) {
    technicalSkills = ts.map(c => ({ category: cleanBullet(c && c.category), items: dedupe(strList(c && c.items)) }));
  } else if (ts && typeof ts === 'object') {
    technicalSkills = Object.entries(ts).map(([category, items]) => ({ category: cleanBullet(category), items: dedupe(strList(items)) }));
  }
  technicalSkills = technicalSkills.filter(c => c.category && c.items.length).slice(0, 25);

  const projects = {};
  const editableIds = new Set(editable.map(p => p.id));
  const rawProjects = Array.isArray(raw.projects) ? raw.projects
    : [raw.recentProject1, raw.recentProject2].filter(Boolean);
  for (const rp of rawProjects) {
    if (!rp || typeof rp !== 'object') continue;
    let id = String(rp.projectId || '').trim();
    if (!editableIds.has(id)) {
      // Repair: match by client name; anything else is a locked project.
      const byClient = editable.find(p => rp.client && p.client.toLowerCase().includes(String(rp.client).toLowerCase().slice(0, 12)));
      if (byClient) id = byClient.id;
      else { warnings.push(`AI output for a locked/unknown project (${rp.projectId || rp.client || '?'}) was ignored.`); continue; }
    }
    const bullets = dedupe(strList(rp.bullets)).filter(b => b.length >= 25 && b.length <= 600);
    const environment = dedupe(strList(rp.environment)).filter(e => e.length <= 120).slice(0, 60);
    if (bullets.length) projects[id] = { bullets, environment };
  }
  for (const p of editable) {
    if (!projects[p.id]) {
      warnings.push(`${p.client}: the AI returned no rewrite, so the original bullets were kept.`);
      projects[p.id] = { bullets: [...p.bullets], environment: p.environment ? p.environment.split(/;\s*/).map(s => s.trim()).filter(Boolean) : [], unchanged: true };
    }
  }

  const listOf = (v, map) => (Array.isArray(v) ? v.map(map).filter(Boolean) : []);
  return {
    rewrite: {
      professionalSummary,
      technicalSkills,
      skillsRemoved: listOf(raw.skillsRemoved, x => (x && x.item ? { item: String(x.item), reason: String(x.reason || '') } : null)),
      projects,
      transferableSkills: listOf(raw.transferableSkills, x => (x && x.requirement ? { requirement: String(x.requirement), relatedExperience: String(x.relatedExperience || '') } : null)),
      unsupportedSkills: listOf(raw.unsupportedSkills, x => (typeof x === 'string' ? x : x && x.name) || null),
      changes: listOf(raw.changes, x => (x && x.description ? { section: String(x.section || ''), type: String(x.type || 'rewritten'), description: String(x.description) } : null)).slice(0, 60),
    },
    warnings,
  };
}

/** Split a skills value into individual items. */
function splitSkillItems(value) {
  return String(value || '')
    .replace(/\s\|\s/g, ', ')
    .split(/,(?![^()]*\))|;/)
    .map(s => s.replace(/^[^:]{2,30}:\s*/, '').replace(/\.$/, '').trim())
    .filter(s => s.length > 1);
}

/**
 * Keep every original verified skill unless the AI explicitly removed it
 * with a reason. Returns list of restored items.
 */
function preserveSkills(rewrite, model) {
  if (!model.skills) return [];
  const removed = new Set((rewrite.skillsRemoved || []).map(r => r.item.toLowerCase().trim()));
  const norm = s => s.toLowerCase().replace(/\s+/g, ' ');
  const allNew = norm(rewrite.technicalSkills.map(c => `${c.category}: ${c.items.join(', ')}`).join(' | '));
  const restored = [];
  for (const row of model.skills.rows) {
    for (const item of splitSkillItems(row.value)) {
      if (allNew.includes(norm(item)) || removed.has(item.toLowerCase())) continue;
      let cat = rewrite.technicalSkills.find(c => norm(c.category) === norm(row.category));
      if (!cat) {
        cat = { category: row.category || 'Other Tools', items: [] };
        rewrite.technicalSkills.push(cat);
      }
      cat.items.push(item);
      restored.push(item);
    }
  }
  return restored;
}

module.exports = { validateRewrite, preserveSkills, splitSkillItems, cleanBullet };
