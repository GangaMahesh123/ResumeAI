'use strict';
// Deterministic stand-in for Claude used by the automated tests.
// It behaves like a cooperative-but-imperfect model: it claims every JD term
// is "verified" (so the code's re-verification is tested), it can inject
// unsupported claims on request (to test the guards), and it reuses the
// candidate's real bullets so the DOCX/page pipeline is exercised end to end.

const { LIBRARY, allNames, hasAny } = require('../lib/domains');

function between(text, tag) {
  const m = text.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  return m ? m[1] : '';
}

function createMockProvider(opts = {}) {
  const calls = [];
  const provider = {
    calls,
    async complete({ system, user }) {
      calls.push({ system, user });
      if (opts.failAll) {
        const e = new Error(opts.failMessage || 'Overloaded'); e.status = opts.failStatus || 529; throw e;
      }
      if (opts.badJson) return 'Sorry, I cannot help with that.';

      // ── analysis ──
      if (/build a precise, prioritised requirement matrix/.test(system)) {
        const jd = between(user, 'job_description');
        const found = LIBRARY.filter(e => hasAny(jd, allNames(e)));
        const requirements = found.map((e, i) => ({
          id: `r${i + 1}`, name: e.term, category: e.category,
          priority: i < 4 ? 'Critical' : i < 8 ? 'High' : 'Medium', mandatory: i < 4,
          terms: allNames(e), status: 'verified', evidence: 'mock says verified', evidenceProjects: [],
        }));
        (opts.extraRequirements || []).forEach(r => requirements.push(r));
        return JSON.stringify({ jdTitle: opts.jdTitle || 'Mock Role', jdDomain: 'dotnet', roleType: 'full_stack', requirements });
      }

      const resume = JSON.parse(between(user, 'resume'));

      // ── layout passes: return the same content (lightly trimmed when shrinking) ──
      if (/exact page count/.test(system)) {
        const shrink = /Shorten/.test(user);
        const words = shrink ? (opts.shrinkWords || 24) : 0;
        const adjust = b => (shrink ? b.split(' ').slice(0, words).join(' ').replace(/[,;]?$/, '.') : b);
        const grow = list => (shrink ? list : [...list, ...list.slice(0, 2).map(b => b.replace(/\.$/, ', documenting the approach for future maintenance and onboarding.'))]);
        return JSON.stringify({
          professionalSummary: grow(resume.professionalSummary.map(adjust)),
          projects: resume.projects.map(p => ({ projectId: p.projectId, bullets: grow(p.bullets.map(adjust)), environment: p.environment })),
        });
      }

      // ── rewrite ──
      const editableIds = (user.match(/Include one "projects" entry for EACH editable project: ([^\n.]+)/) || [])[1].split(',').map(s => s.trim());
      const draft = (user.match(/Your previous draft follows; return the complete corrected JSON:\n([\s\S]+?)\n\nReturn JSON exactly/) || [])[1];
      if (draft && !opts.ignoreFeedback) {
        // Respect feedback: drop bullets naming the flagged unsupported terms.
        const prev = JSON.parse(draft.trim());
        const flagged = (user.match(/Remove or rephrase these unsupported claims[^:]*: ([^\n]+)/) || [])[1] || '';
        const bad = flagged.split(';').map(s => s.replace(/\[[^\]]*\]/, '').replace(/\.$/, '').split(',').map(x => x.trim())).flat().filter(Boolean);
        const ok = t => !bad.some(b => t.includes(b));
        const underLine = (user.match(/under-represented[^:]*: ([^\n]+)/) || [])[1] || '';
        const under = underLine.split(';').map(x => x.replace(/\[[^\]]*\]/, '').replace(/\.$/, '').trim()).filter(Boolean);
        const added = under.map(u => `Applied hands-on ${u} experience from prior enterprise delivery to support scalable, well-tested releases across environments and teams.`);
        return JSON.stringify({
          professionalSummary: [...prev.professionalSummary.filter(ok), ...added],
          technicalSkills: prev.technicalSkills,
          projects: prev.projects.map(p => ({ ...p, bullets: p.bullets.filter(ok) })),
          changes: [{ section: 'Professional Summary', type: 'rewritten', description: 'Applied optimization feedback' }],
        });
      }

      const projects = resume.projects.filter(p => editableIds.includes(p.projectId));
      const pool = projects.flatMap(p => p.bullets);
      const summary = [...resume.professionalSummary];
      for (let i = 0; summary.length < 18 && i < pool.length; i++) summary.push(pool[i]);
      (opts.summaryInjections || []).forEach(t => summary.unshift(t));

      const outProjects = projects.map((p, idx) => {
        let bullets = [...p.bullets];
        if (opts.trimProjectsTo) bullets = bullets.slice(0, opts.trimProjectsTo);
        (opts.projectInjections && opts.projectInjections[idx] || []).forEach(t => bullets.unshift(t));
        const env = p.environment.split(/;\s*/).filter(Boolean);
        if (opts.envInjections && opts.envInjections[idx]) env.push(...opts.envInjections[idx]);
        return { projectId: p.projectId, bullets, environment: env };
      });
      if (opts.touchLocked) {
        const lockedP = resume.projects.find(p => !editableIds.includes(p.projectId));
        if (lockedP) outProjects.push({ projectId: lockedP.projectId, bullets: ['Rewrote a locked project, which must be ignored by the server.'], environment: [] });
      }

      const skills = resume.technicalSkills.map(r => ({ category: r.category, items: r.value.split(/,(?![^()]*\))/).map(s => s.trim()).filter(Boolean) }));
      if (opts.skillInjections) skills[0].items.unshift(...opts.skillInjections);
      if (opts.dropSkill) skills.forEach(c => { c.items = c.items.filter(i => !i.includes(opts.dropSkill)); });

      return JSON.stringify({
        professionalSummary: summary,
        technicalSkills: skills.reverse(),
        skillsRemoved: [],
        projects: outProjects,
        transferableSkills: [],
        unsupportedSkills: [],
        changes: [{ section: 'Professional Summary', type: 'rewritten', description: 'Rewrote summary for the JD' }],
      });
    },
  };
  return provider;
}

module.exports = { createMockProvider };
