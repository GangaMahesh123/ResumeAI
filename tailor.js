'use strict';
// ResumeAI V2 pipeline — one universal engine for .NET, GenAI and AI/ML resumes.
// Upload → Parse resume → Parse JD → Requirement matrix → Evidence → Rewrite
// summary + recent projects + skills + environments → Validate facts →
// Optimization passes → Generate DOCX → Render & validate pages → Score → Results

const path = require('path');
const mammoth = require('mammoth');
const config = require('./config');
const { callJson, AIError } = require('./ai');
const { loadDocx, modelForAI } = require('./resumeModel');
const { buildFromText } = require('./docxBuild');
const { detectDomain, DOMAIN_LABEL } = require('./domains');
const { analysisPrompt, rewritePrompt, layoutPrompt } = require('./prompts');
const { normalizeRequirements, guardRewrite, enforceGuard, versionWarnings, fixYears, projectSourceText } = require('./evidence');
const { validateRewrite, preserveSkills } = require('./schema');
const { scoreResume, underrepresented } = require('./scoring');
const { extractExplicitTerms, NON_TECH, CONTACT_LINE } = require('./jdTerms');
const { closeGaps } = require('./coverage');
const { applyRewrite, lockedSectionsIntact, setMargins, getMargins, auditFormatting } = require('./docxEngine');
const render = require('./render');
const { learnWindow } = require('./lineFit');
const { fitLengths, verifyRendered, repairTargets, targetPages } = require('./twoLine');

class PipelineError extends Error {
  constructor(code, message, status = 422) { super(message); this.code = code; this.status = status; }
}

function mergeSettings(input) {
  const d = config.defaults;
  const s = { ...d, ...(input || {}) };
  const clamp = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def; };
  const bool = (v, def) => (v === undefined ? def : v === true || v === 'true' || v === 1 || v === '1');
  return {
    alignmentTarget: clamp(s.alignmentTarget, 50, 100, d.alignmentTarget),
    rewriteSummary: bool(s.rewriteSummary, true),
    rewriteProject1: bool(s.rewriteProject1, true),
    rewriteProject2: bool(s.rewriteProject2, true),
    lockOlderProjects: bool(s.lockOlderProjects, true),
    optimizeSkills: bool(s.optimizeSkills, true),
    reconcileEnvironment: bool(s.reconcileEnvironment, true),
    requiredPages: clamp(s.requiredPages, 1, 12, d.requiredPages),
    summaryMinBullets: clamp(s.summaryMinBullets, 5, 40, d.summaryMinBullets),
    projectMinBullets: clamp(s.projectMinBullets, 5, 40, d.projectMinBullets),
    preserveFacts: true, // always on — cannot be disabled
    exactTwoLineBullets: bool(s.exactTwoLineBullets, true),
    matchJobTitle: bool(s.matchJobTitle, true),
    domainOverride: ['dotnet', 'genai', 'aiml', 'hybrid'].includes(s.domainOverride) ? s.domainOverride : '',
    editableProjectIds: Array.isArray(s.editableProjectIds) ? s.editableProjectIds.map(String).slice(0, config.maxEditableProjects) : null,
  };
}

/** Normalise any supported upload into a DOCX buffer. */
async function toDocx(buffer, fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  if (ext === '.docx') return { docx: buffer, source: 'docx' };
  if (ext === '.doc') return { docx: await render.docToDocx(buffer), source: 'doc' };
  let text;
  if (ext === '.txt') text = buffer.toString('utf-8');
  else if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    try { text = (await pdfParse(buffer)).text; } catch (e) { throw new PipelineError('PARSE_FAILED', `The PDF could not be read: ${e.message}`); }
  } else throw new PipelineError('UNSUPPORTED_FORMAT', 'Only PDF, DOC, DOCX and TXT files are supported.', 400);
  if (!text || text.trim().length < 200) throw new PipelineError('PARSE_FAILED', 'Very little text could be extracted from this file (it may be a scanned image). Please upload a DOCX.');
  return { docx: await buildFromText(text), source: ext.slice(1) };
}

function sectionsFromModel(model, editableIds) {
  return {
    summary: model.summary ? model.summary.bullets.join('\n') : '',
    skills: model.skills ? model.skills.rows.map(r => `${r.category}: ${r.value}`).join('\n') : '',
    all: model.fullText,
    projects: model.projects.filter(p => editableIds.includes(p.id)).map(p => ({ id: p.id, label: p.client, bullets: p.bullets.join('\n'), environment: p.environment })),
  };
}

function sectionsFromRewrite(rewrite, model, editable) {
  const editableIds = editable.map(p => p.id);
  const locked = model.projects.filter(p => !editableIds.includes(p.id)).map(projectSourceText).join('\n');
  const summary = rewrite.professionalSummary.join('\n');
  const skills = rewrite.technicalSkills.length ? rewrite.technicalSkills.map(c => `${c.category}: ${c.items.join(', ')}`).join('\n')
    : (model.skills ? model.skills.rows.map(r => `${r.category}: ${r.value}`).join('\n') : '');
  const projects = editable.map(p => ({ id: p.id, label: p.client, bullets: (rewrite.projects[p.id] || { bullets: [] }).bullets.join('\n'), environment: (rewrite.projects[p.id] || { environment: [] }).environment.join('; ') }));
  return { summary, skills, projects, all: [summary, skills, ...projects.map(x => `${x.bullets}\n${x.environment}`), locked, model.header.lines.join('\n')].join('\n') };
}

function countShortfalls(rewrite, editable, settings) {
  const out = [];
  if (rewrite.professionalSummary.length < settings.summaryMinBullets) out.push(`Professional Summary has ${rewrite.professionalSummary.length} bullets; it needs at least ${settings.summaryMinBullets}.`);
  for (const p of editable) {
    const n = (rewrite.projects[p.id] || { bullets: [] }).bullets.length;
    if (n < settings.projectMinBullets) out.push(`${p.id} (${p.client}) has ${n} bullets; it needs at least ${settings.projectMinBullets}.`);
  }
  return out;
}

/** Score a draft as it would look after the evidence guard removes violations. */
function scoreDraft(requirements, rewrite, violations, model, editable, explicitCount) { // explicitCount = explicit term list
  const copy = JSON.parse(JSON.stringify(rewrite));
  enforceGuard(copy, violations);
  return scoreResume(requirements, sectionsFromRewrite(copy, model, editable), { explicitTerms: explicitCount });
}

function draftForPrompt(rewrite) {
  return JSON.stringify({
    professionalSummary: rewrite.professionalSummary,
    technicalSkills: rewrite.technicalSkills,
    projects: Object.entries(rewrite.projects).map(([projectId, p]) => ({ projectId, bullets: p.bullets, environment: p.environment })),
  });
}

/**
 * Run the full V2 tailoring workflow.
 * @param ctx { provider, requestId, log }
 */
async function tailor({ fileBuffer, fileName, jdText, settings: rawSettings, confirmations = [], prepared = null }, ctx) {
  const { provider, requestId = 'local', log = console } = ctx;
  const progress = typeof ctx.progress === 'function' ? ctx.progress : () => {};
  const settings = mergeSettings(rawSettings);
  const t0 = Date.now();
  const timings = {};
  const mark = k => { timings[k] = Date.now() - t0; };
  const elapsed = () => Date.now() - t0;
  const hasTime = ms => elapsed() + ms < config.timeBudgetMs;
  const warnings = [];

  // 1. Parse complete resume
  const { docx: baseDocx, source } = prepared || await toDocx(fileBuffer, fileName);
  const baseState = loadDocx(baseDocx);
  const model = baseState.model;
  if (!model.projects.length) throw new PipelineError('PARSE_FAILED', 'No employment sections (client/company with dates) could be identified in this resume, so it cannot be tailored reliably. Please use a DOCX with "Client:" or company lines that include dates.');
  if (!model.summary) warnings.push('No Professional Summary heading was found; the summary could not be rewritten.');
  if (!model.skills) warnings.push('No Technical Skills heading was found; skills could not be optimized.');
  mark('parsed');

  // 2. Domains
  const resumeDom = detectDomain(model.fullText);
  const jdDom = detectDomain(jdText);
  let domain = settings.domainOverride || jdDom.domain;
  if (!settings.domainOverride && jdDom.domain !== 'hybrid' && resumeDom.domain !== 'hybrid' && resumeDom.domain !== jdDom.domain) domain = 'hybrid';

  // 3. Editable vs locked projects (by date order, not hard-coded names)
  const byRecency = [...model.projects].sort((a, b) => a.recency - b.recency);
  let editable;
  if (settings.editableProjectIds && settings.editableProjectIds.length) {
    editable = byRecency.filter(p => settings.editableProjectIds.includes(p.id));
  } else {
    editable = [];
    if (settings.rewriteProject1 && byRecency[0]) editable.push(byRecency[0]);
    if (settings.rewriteProject2 && byRecency[1]) editable.push(byRecency[1]);
  }
  const locked = model.projects.filter(p => !editable.includes(p));
  for (const p of locked) {
    if (p.bullets.length < settings.projectMinBullets) warnings.push(`Formatting exception: protected project "${p.client}" has ${p.bullets.length} bullets (minimum ${settings.projectMinBullets}); it was left unchanged.`);
  }

  const resumeJson = modelForAI(model);

  // 4. Requirement matrix (fast model) runs in parallel with measuring the
  //    two-line bullet length on the rendered original.
  progress('Reading the JD and building the requirement matrix');
  const ap = analysisPrompt({ resumeJson, jdText, confirmations, resumeDomain: resumeDom.domain, jdDomain: jdDom.domain });
  const [rawAnalysis, lengthWindow] = await Promise.all([
    callJson(provider, { ...ap, maxTokens: config.analysisMaxTokens, label: 'analysis', requestId, log, model: config.fastModel }),
    settings.exactTwoLineBullets ? learnWindow(baseDocx, model) : Promise.resolve(null),
  ]);
  if (lengthWindow) settings.lengthWindow = lengthWindow;
  const explicitTerms = extractExplicitTerms(jdText);
  const requirements = normalizeRequirements(rawAnalysis.requirements, { model, confirmations, jdText, explicitTerms });
  const explicitCount = explicitTerms.length;
  if (!requirements.length) throw new AIError('invalid_json', 'The analysis returned no job requirements.', { stage: 'analysis' });
  const analysis = { ...rawAnalysis, requirements };
  mark('analysis');

  const editableIds = editable.map(p => p.id);
  const before = scoreResume(requirements, sectionsFromModel(model, editableIds), { explicitTerms });

  // 5. Rewrite — the summary/skills and each recent project are written by
  //    parallel calls (same evidence and rules), then merged and validated.
  const rewriteOnce = async extraInstructions => {
    const scopes = [{ key: 'summary', note: 'SCOPE OF THIS CALL: return the complete "professionalSummary", "technicalSkills", "skillsRemoved", "transferableSkills", "unsupportedSkills" and "changes". Return "projects": [] — the projects are written by separate calls.' },
      ...editable.map(p => ({ key: p.id, note: `SCOPE OF THIS CALL: return ONLY the "projects" entry for ${p.id} (${p.client}) with all its bullets and environment. Return "professionalSummary": [] and "technicalSkills": [] — those are written by a separate call. Avoid repeating content that belongs to the other project.` }))];
    const parts = await Promise.all(scopes.map(sc => {
      const rp = rewritePrompt({ resumeJson, jdText, analysis, confirmations, editable, settings, domain, extraInstructions: `${sc.note}${extraInstructions ? `\n${extraInstructions}` : ''}` });
      return callJson(provider, { ...rp, maxTokens: config.rewriteMaxTokens, label: `rewrite-${sc.key === 'summary' ? 'summary' : 'project'}`, requestId, log });
    }));
    const [sumPart, ...projParts] = parts;
    const raw = {
      ...sumPart,
      // Each call's own project, plus any attempt to touch a protected project
      // (kept so validation ignores and reports it).
      projects: [
        ...projParts.flatMap((pp, i) => (Array.isArray(pp.projects) ? pp.projects : []).filter(x => x && String(x.projectId) === editable[i].id)),
        ...parts.flatMap(pp => (Array.isArray(pp.projects) ? pp.projects : []).filter(x => x && x.projectId && !editable.some(e => e.id === String(x.projectId)))).slice(0, 3),
      ],
      changes: [...(sumPart.changes || []), ...projParts.flatMap(pp => pp.changes || [])],
    };
    const { rewrite, warnings: w } = validateRewrite(raw, { editable, model });
    if (!settings.rewriteSummary) rewrite.professionalSummary = model.summary ? [...model.summary.bullets] : [];
    if (!settings.optimizeSkills) rewrite.technicalSkills = [];
    const yrs = fixYears(rewrite.professionalSummary, model.experienceYears);
    rewrite.professionalSummary = yrs.summary;
    if (yrs.fixed) w.push(`Years of experience in the summary were capped at the true total (${Math.floor(model.experienceYears)}+).`);
    const restored = settings.optimizeSkills ? preserveSkills(rewrite, model) : [];
    return { rewrite, warnings: w, restored };
  };

  progress('Rewriting the Professional Summary and the two most recent projects');
  let best = await rewriteOnce('');
  const firstDraftWarnings = [...best.warnings];
  let violations = guardRewrite(best.rewrite, { model, confirmations, requirements, editable });
  let draftScore = scoreDraft(requirements, best.rewrite, violations, model, editable, explicitTerms);
  mark('rewrite');

  // 6a. Fast targeted gap closing (code for Skills/Environment, one fast call for bullets).
  const passes = [];
  {
    const under0 = underrepresented(draftScore, editable.map(p => ({ id: p.id, label: p.client })));
    if (under0.length) {
      progress('Closing remaining keyword gaps');
      const stats = await closeGaps(best.rewrite, draftScore.rows, { requirements, editable, model, confirmations, window: lengthWindow, provider, requestId, log });
      violations = guardRewrite(best.rewrite, { model, confirmations, requirements, editable });
      draftScore = scoreDraft(requirements, best.rewrite, violations, model, editable, explicitTerms);
      passes.push({ pass: 'targeted', ...stats, supportedKeywordCoverage: draftScore.supportedKeywordCoverage, gapsBefore: under0.length });
    }
  }

  // 6b. Full optimization pass only if still needed and time allows.
  for (let pass = 1; pass <= config.optimizationPasses; pass++) {
    const under = underrepresented(draftScore, editable.map(p => ({ id: p.id, label: p.client })));
    const short = countShortfalls(best.rewrite, editable, settings);
    if (!violations.length && !short.length && (!under.length || draftScore.supportedKeywordCoverage >= settings.alignmentTarget)) break;
    if (!hasTime(50000)) { warnings.push('Skipped an extra optimization pass to stay within the time budget.'); break; }
    progress('Closing remaining keyword gaps');
    const lines = [];
    if (violations.length) lines.push(`Remove or rephrase these unsupported claims (the technology is not evidenced for that section): ${violations.slice(0, 25).map(v => `[${v.section}${v.projectId ? ` ${v.projectId}` : ''}] ${v.terms.join(', ')}`).join('; ')}.`);
    if (under.length) lines.push(`COVERAGE GAPS — these requirements are supported by the candidate's evidence but are missing from sections where they belong. Use the exact JD keyword and add each one to every section listed (rewrite or merge existing bullets; do not just append): ${under.slice(0, 40).map(r => `"${r.keyword}" → [${r.missingIn.join(' | ')}]`).join('; ')}.`);
    if (short.length) lines.push(short.join(' '));
    lines.push(`Your previous draft follows; return the complete corrected JSON:\n${draftForPrompt(best.rewrite)}`);
    let candidate;
    try { candidate = await rewriteOnce(lines.join('\n')); } catch (e) { warnings.push(`Optimization pass ${pass} failed (${e.kind || e.message}); kept the previous draft.`); break; }
    const cViol = guardRewrite(candidate.rewrite, { model, confirmations, requirements, editable });
    const cScore = scoreDraft(requirements, candidate.rewrite, cViol, model, editable, explicitTerms);
    const better = cViol.length <= violations.length && cScore.supportedKeywordCoverage >= draftScore.supportedKeywordCoverage - 0.5 &&
      countShortfalls(candidate.rewrite, editable, settings).length <= short.length;
    passes.push({ pass, accepted: better, supportedKeywordCoverage: cScore.supportedKeywordCoverage, gapsBefore: under.length, violations: cViol.length });
    if (!better) break;
    best = candidate; violations = cViol; draftScore = cScore;
  }
  mark('optimization');

  // 7. Enforce facts: strip whatever is still unsupported.
  const removedClaims = enforceGuard(best.rewrite, violations);
  const rewrite = best.rewrite;
  // Headline under the name = the JD's role title (past job titles are never changed).
  const cleanTitle = t => String(t || '').replace(/^(job\s*title|position|role|title)\s*:\s*/i, '').replace(/\s*[(\[][^)\]]*(remote|onsite|on-site|hybrid|contract|full[- ]time|w2|c2c|location)[^)\]]*[)\]]/ig, '').split(/\s+\|\s+|\s+@\s+/)[0].replace(/\s+/g, ' ').trim();
  const headline = cleanTitle(analysis.jdTitle);
  if (settings.matchJobTitle && headline && headline.length <= 90 && model.header.titleIdx !== null) rewrite.headline = headline;
  warnings.push(...firstDraftWarnings, ...best.warnings);
  if (removedClaims.length) warnings.push(`${removedClaims.length} statement(s) were removed because they named technologies without supporting evidence.`);
  warnings.push(...versionWarnings(rewrite, editable));
  warnings.push(...countShortfalls(rewrite, editable, settings));

  const tlCtx = { provider, window: lengthWindow, requestId, log, requirements, model, confirmations, editable, jdText,
    model_fast: config.fastModel, deadline: t0 + config.timeBudgetMs, hardDeadline: t0 + config.timeBudgetMs + 25000 };
  progress('Fitting every bullet to exactly two full lines');
  if (lengthWindow) await fitLengths(rewrite, tlCtx);
  mark('lengths');

  // 8. Generate DOCX + layout validation
  const build = rw => {
    const state = loadDocx(baseDocx);
    const boldExtra = requirements.filter(r => r.status === 'verified' || r.status === 'confirmed').flatMap(r => r.terms);
    return applyRewrite(state, rw, { editable: state.model.projects.filter(p => editableIds.includes(p.id)), settings, boldExtra });
  };
  let built = build(rewrite);
  warnings.push(...built.warnings);
  let buffer = built.buffer;

  const target = settings.requiredPages;
  let page;
  let layoutLog = [];
  let twoLineReport = null;
  if (lengthWindow) {
    // Page target by whole bullets; margins stay exactly as in the original.
    progress('Rendering and checking the page count');
    const tp = await targetPages(rewrite, build, tlCtx, settings);
    buffer = tp.buffer; layoutLog = tp.log; warnings.push(...tp.warnings);
    // Verify each bullet on the rendered page and repair mis-wrapped ones.
    let measured = await verifyRendered(buffer, rewrite);
    for (let k = 0; k < 2 && measured && measured.some(m => m.ok === false) && Date.now() < tlCtx.hardDeadline; k++) {
      const changed = await fitLengths(rewrite, tlCtx, { targets: repairTargets(measured, lengthWindow), passes: 1 });
      if (!changed) break;
      buffer = build(rewrite).buffer;
      measured = await verifyRendered(buffer, rewrite);
    }
    page = await render.countPages(buffer);
    if (page.verified && page.pages !== target && Date.now() < tlCtx.hardDeadline) {
      const tp2 = await targetPages(rewrite, build, tlCtx, settings);
      buffer = tp2.buffer; layoutLog.push(...tp2.log);
      measured = await verifyRendered(buffer, rewrite);
      page = await render.countPages(buffer);
    }
    if (measured) {
      const failed = measured.filter(m => m.ok === false);
      twoLineReport = {
        window: lengthWindow, checked: measured.filter(m => m.ok !== null).length,
        passed: measured.filter(m => m.ok).length,
        failed: failed.map(m => ({ section: m.id.startsWith('s:') ? 'Professional Summary' : (editable.find(p => m.id.split(':')[1] === p.id) || {}).client, text: m.text, lines: m.lines, lastLineFill: m.lastFill })),
      };
      if (failed.length) warnings.push(`${failed.length} bullet(s) do not fill exactly two complete lines; they are listed under "Two-line check".`);
    }
    if (!page.verified) warnings.push(page.error);
    else if (page.pages !== target) warnings.push(`The resume renders to ${page.pages} page(s), not the required ${target}. It is delivered as a best effort.`);
    else for (let i = warnings.length - 1; i >= 0; i--) if (/^Cannot reach \d+ pages|^Could not add enough/.test(warnings[i])) warnings.splice(i, 1);
  } else {
    page = await render.countPages(buffer);
    layoutLog = [];
    if (page.verified) {
      layoutLog.push({ step: 'initial', pages: page.pages });
      // Margin adjustment within professional limits (0.5"–1").
      let margin = getMargins(buffer);
      const shrinking = page.pages > target;
      for (let i = 0; i < 4 && page.pages !== target; i++) {
        const next = shrinking ? Math.max(720, margin - 180) : Math.min(1440, margin + 180);
        if (next === margin) break;
        const trial = setMargins(buffer, next);
        const tp = await render.countPages(trial);
        if (!tp.verified) break;
        layoutLog.push({ step: `margins ${(next / 1440).toFixed(2)}in`, pages: tp.pages });
        // Widening margins must not overshoot the target.
        if (!shrinking && tp.pages > target) break;
        margin = next; buffer = trial; page = tp;
      }
      // AI shrink / expand passes.
      for (let i = 0; i < config.layoutPasses && page.pages !== target; i++) {
        const direction = page.pages > target ? 'shrink' : 'expand';
        const lp = layoutPrompt({ direction, pages: page.pages, target, settings, sectionsJson: JSON.parse(draftForPrompt(rewrite)) });
        let raw;
        try { raw = await callJson(provider, { ...lp, maxTokens: config.rewriteMaxTokens, label: `layout-${direction}`, requestId, log }); }
        catch (e) { warnings.push(`Layout ${direction} pass failed (${e.kind || e.message}).`); break; }
        let adjusted;
        try { adjusted = validateRewrite({ ...raw, technicalSkills: raw.technicalSkills || rewrite.technicalSkills }, { editable, model }).rewrite; } catch { break; }
        if (!settings.rewriteSummary) adjusted.professionalSummary = rewrite.professionalSummary;
        adjusted.technicalSkills = rewrite.technicalSkills; // skills are not touched by layout passes
        for (const p of editable) {
          const a = adjusted.projects[p.id];
          if (!a || a.unchanged) adjusted.projects[p.id] = rewrite.projects[p.id];
          else if (!a.environment.length) a.environment = rewrite.projects[p.id].environment;
        }
        const v = guardRewrite(adjusted, { model, confirmations, requirements, editable });
        enforceGuard(adjusted, v);
        if (countShortfalls(adjusted, editable, settings).length > countShortfalls(rewrite, editable, settings).length) break;
        const b2 = build(adjusted);
        const trial = setMargins(b2.buffer, margin);
        const tp = await render.countPages(trial);
        if (!tp.verified) break;
        layoutLog.push({ step: `ai-${direction}`, pages: tp.pages });
        if (Math.abs(tp.pages - target) <= Math.abs(page.pages - target)) {
          Object.assign(rewrite, { professionalSummary: adjusted.professionalSummary, projects: adjusted.projects });
          buffer = trial; page = tp; built = b2;
        }
      }
      // Once on target, relax margins back toward the original where possible.
      const originalMargin = getMargins(baseDocx);
      for (let i = 0; i < 4 && page.pages === target && margin < originalMargin; i++) {
        const next = Math.min(originalMargin, margin + 180);
        const trial = setMargins(buffer, next);
        const tp = await render.countPages(trial);
        if (!tp.verified || tp.pages !== target) break;
        layoutLog.push({ step: `relax margins ${(next / 1440).toFixed(2)}in`, pages: tp.pages });
        margin = next; buffer = trial; page = tp;
      }
      if (page.pages !== target) warnings.push(`The resume renders to ${page.pages} page(s), not the required ${target}, after ${layoutLog.length - 1} layout adjustment(s). It is delivered as a best effort.`);
    } else {
      warnings.push(page.error);
    }

  }
  mark('layout');

  // 9. Validation of the final document
  const finalState = loadDocx(buffer);
  const finalModel = finalState.model;
  const lockedCheck = lockedSectionsIntact(baseState.body, finalState.documentXml, locked);
  const lockedOk = lockedCheck.every(x => x.intact);
  if (!lockedOk) warnings.push('Protected project content changed unexpectedly — please review before sending.');
  const formatting = auditFormatting(buffer, finalModel, editableIds, settings);
  const after = scoreResume(requirements, sectionsFromModel(finalModel, editableIds), { explicitTerms });
  mark('done');

  const supported = requirements.filter(r => r.status === 'verified' || r.status === 'confirmed');
  const unsupportedReqs = requirements.filter(r => r.status === 'unsupported');
  const transferable = requirements.filter(r => r.status === 'transferable');

  const changes = [];
  if (settings.rewriteSummary && model.summary) changes.push({ type: 'modified', section: 'Professional Summary', description: `Professional Summary rewritten: ${model.summary.bullets.length} → ${finalModel.summary ? finalModel.summary.bullets.length : 0} bullets` });
  if (rewrite.headline && rewrite.headline !== model.header.title) changes.push({ type: 'modified', section: 'Header', description: `Headline changed to the JD title: "${model.header.title}" → "${rewrite.headline}"` });
  if (settings.optimizeSkills && model.skills) changes.push({ type: 'modified', section: 'Technical Skills', description: `Technical Skills reordered by JD relevance (${rewrite.technicalSkills.length} categories)` });
  for (const p of editable) {
    const fp = finalModel.projects.find(x => x.id === p.id);
    changes.push({ type: 'modified', section: p.client, description: `${p.client}: responsibilities rewritten (${p.bullets.length} → ${fp ? fp.bullets.length : '?'} bullets)${settings.reconcileEnvironment ? ', Environment reconciled' : ''}` });
  }
  for (const c of rewrite.changes.slice(0, 20)) changes.push({ type: c.type === 'removed' ? 'removed' : c.type === 'added' ? 'added' : 'modified', section: c.section, description: c.description });
  for (const r of removedClaims.slice(0, 10)) changes.push({ type: 'removed', section: r.section, description: `Removed unsupported claim (${(r.terms || []).join(', ') || 'unverified'}): ${r.text.slice(0, 90)}` });

  return {
    buffer,
    source,
    settings,
    domain: { resume: resumeDom.domain, jd: jdDom.domain, used: domain, label: DOMAIN_LABEL[domain], override: !!settings.domainOverride },
    jdTitle: analysis.jdTitle || '',
    roleType: analysis.roleType || 'other',
    candidateName: model.header.name,
    projects: model.projects.map(p => ({ id: p.id, client: p.client, role: p.role, dates: p.dates ? p.dates.raw : null, recency: p.recency, editable: editableIds.includes(p.id) })),
    editableProjects: editable.map(p => ({ id: p.id, client: p.client })),
    lockedProjects: lockedCheck,
    requirements: after.rows,
    coverageMatrix: {
      sections: [{ key: 'summary', label: 'Professional Summary' }, ...editable.map(p => ({ key: `project:${p.id}`, label: p.client })), { key: 'skills', label: 'Technical Skills' }, ...editable.map(p => ({ key: `env:${p.id}`, label: `Environment — ${p.client}` }))],
      rows: after.rows,
    },
    confirmationQueue: after.rows.filter(r => (r.finalStatus === 'Needs confirmation' || r.finalStatus === 'Related experience only') &&
        !['responsibility', 'experience_years'].includes(r.category) && !NON_TECH.test(r.keyword) && !CONTACT_LINE.test(r.keyword))
      .map(r => ({ requirement: r.requirement, keyword: r.keyword, priority: r.priority, status: r.supportStatus, note: r.supportStatus === 'transferable' ? r.evidenceSource : '' }))
      .sort((a, b) => ({ Critical: 0, High: 1, Medium: 2, Low: 3 }[a.priority] - { Critical: 0, High: 1, Medium: 2, Low: 3 }[b.priority])),
    scores: {
      before: { keywordCoverage: before.keywordCoverage, qualificationMatch: before.qualificationMatch, supportedKeywordCoverage: before.supportedKeywordCoverage, supportedAlignment: before.supportedKeywordCoverage, extractionCompleteness: before.extractionCompleteness },
      after: { keywordCoverage: after.keywordCoverage, qualificationMatch: after.qualificationMatch, supportedKeywordCoverage: after.supportedKeywordCoverage, supportedAlignment: after.supportedKeywordCoverage, extractionCompleteness: after.extractionCompleteness },
      target: settings.alignmentTarget,
      targetMet: after.supportedKeywordCoverage >= settings.alignmentTarget,
      explicitTerms: explicitCount,
      supportedCount: after.supportedCount,
      needsConfirmation: after.needsConfirmation,
      criticalCovered: after.criticalCovered,
      criticalTotal: after.criticalTotal,
      formula: after.formula,
    },
    supportedSkills: supported.map(r => r.name),
    transferableSkills: [...transferable.map(r => ({ requirement: r.name, relatedExperience: r.evidence })), ...rewrite.transferableSkills.filter(t => !transferable.some(r => r.name === t.requirement))].slice(0, 30),
    unsupportedSkills: unsupportedReqs.map(r => ({ requirement: r.name, priority: r.priority })),
    preview: {
      headline: finalModel.header.title || '',
      originalHeadline: model.header.title || '',
      professionalSummary: finalModel.summary ? finalModel.summary.bullets : [],
      technicalSkills: finalModel.skills ? finalModel.skills.rows : [],
      projects: finalModel.projects.filter(p => editableIds.includes(p.id)).map(p => ({ id: p.id, client: p.client, role: p.role, dates: p.dates ? p.dates.raw : '', bullets: p.bullets, environment: p.environment })),
      protected: finalModel.projects.filter(p => !editableIds.includes(p.id)).map(p => ({ id: p.id, client: p.client, dates: p.dates ? p.dates.raw : '', bullets: p.bullets.length })),
      original: {
        professionalSummary: model.summary ? model.summary.bullets : [],
        projects: editable.map(p => ({ id: p.id, bullets: p.bullets })),
      },
    },
    fullText: finalModel.fullText,
    changes,
    validation: {
      pageCount: page.pages,
      pageCountVerified: page.verified,
      requiredPages: target,
      pagesOk: page.verified && page.pages === target,
      layoutLog,
      formatting,
      twoLineBullets: twoLineReport,
      lockedProjectsIntact: lockedOk,
      optimizationPasses: passes,
      restoredSkills: best.restored,
      removedClaims,
      warnings: [...new Set(warnings.filter(Boolean))],
    },
    timings,
  };
}

module.exports = { tailor, mergeSettings, PipelineError, toDocx };
