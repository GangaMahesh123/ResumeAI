'use strict';
// Review drafts: suggested bullets for JD technologies the candidate's resume
// and saved experience do not show. They are returned separately (UI + a
// separate DOCX) and are never written into the tailored resume.

const config = require('./config');
const { callJson } = require('./ai');
const { draftPrompt } = require('./prompts');
const { cleanBullet } = require('./schema');
const { NON_TECH, CONTACT_LINE } = require('./jdTerms');

function draftCandidates(requirements) {
  return requirements.filter(r => (r.status === 'unsupported' || r.status === 'transferable') && !r.yearsCheck &&
    !['responsibility', 'experience_years'].includes(r.category) && !NON_TECH.test(r.name) && !CONTACT_LINE.test(r.name))
    .slice(0, 30);
}

async function generateDrafts({ requirements, editable, window, provider, requestId, log }) {
  const reqs = draftCandidates(requirements);
  if (!reqs.length || !editable.length) return [];
  const items = reqs.map(r => ({ keyword: r.jdKeyword || r.terms[0], priority: r.priority, relatedExperience: r.status === 'transferable' ? r.evidence : '' }));
  const projects = editable.map(p => ({ projectId: p.id, client: p.client, role: p.role, sampleBullets: p.bullets.slice(0, 6), environment: p.environment }));
  let raw;
  try {
    raw = await callJson(provider, { ...draftPrompt({ items, projects, window }), maxTokens: Math.min(config.rewriteMaxTokens, 600 + items.length * 260), label: 'review-drafts', requestId, log, model: config.fastModel, retries: 2 });
  } catch (e) { log.error(`[${requestId}] review drafts failed: ${e.kind || e.message}`); return []; }
  const byKw = new Map((Array.isArray(raw.drafts) ? raw.drafts : []).map(d => [String(d && d.keyword).toLowerCase(), d]));
  return reqs.map((r, i) => {
    const kw = items[i].keyword;
    const d = byKw.get(kw.toLowerCase()) || {};
    const project = editable.find(p => p.id === String(d.projectId)) || editable[0];
    return {
      id: r.id, requirement: r.name, keyword: kw, priority: r.priority,
      status: r.status === 'transferable' ? 'Transferable' : 'Unverified',
      relatedExperience: items[i].relatedExperience,
      projectId: project.id, client: project.client,
      bullet: cleanBullet(d.bullet || ''), summaryBullet: cleanBullet(d.summaryBullet || ''),
    };
  });
}

/** Separate Word file: clearly marked as drafts for review, not the resume. */
async function draftsDocx(drafts, { candidateName, jdTitle }) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const run = (t, o = {}) => new TextRun({ text: t, font: 'Calibri', size: 20, ...o });
  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'REVIEW DRAFTS — NOT PART OF THE SUBMITTED RESUME', bold: true, font: 'Calibri', size: 28 })] }),
    new Paragraph({ children: [run(`${candidateName || 'Candidate'} · ${jdTitle || 'Job description'}`)] }),
    new Paragraph({ children: [run('Suggested wording for JD technologies the master resume does not show. Use a draft only after confirming the candidate has this experience; accepted drafts are added to the resume on regeneration.', { italics: true })] }),
  ];
  for (const d of drafts) {
    children.push(new Paragraph({ spacing: { before: 160 }, children: [run(`${d.keyword}`, { bold: true }), run(`  ·  ${d.priority}  ·  ${d.status}  ·  suggested for ${d.client}`)] }));
    if (d.relatedExperience) children.push(new Paragraph({ children: [run(`Related experience already in the resume: ${d.relatedExperience}`, { italics: true })] }));
    if (d.bullet) children.push(new Paragraph({ bullet: { level: 0 }, children: [run(d.bullet)] }));
    if (d.summaryBullet) children.push(new Paragraph({ bullet: { level: 0 }, children: [run(`Summary: ${d.summaryBullet}`)] }));
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

module.exports = { generateDrafts, draftsDocx, draftCandidates };
