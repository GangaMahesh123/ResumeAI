'use strict';
// Exact two-line bullets: length repair (AI), rendered verification, and
// page targeting by bullet count (margins are never changed in this mode,
// because changing them changes how much text fits on a line).

const config = require('./config');
const { callJson } = require('./ai');
const { fitPrompt, expandPrompt } = require('./prompts');
const { termGroups, unsupportedIn, projectSourceText } = require('./evidence');
const { cleanBullet } = require('./schema');
const { measureBullets, pdfLines, pageStats } = require('./lineFit');
const { hasAny } = require('./domains');
const { WEIGHTS } = require('./scoring');

function listBullets(rw) {
  const out = rw.professionalSummary.map((text, i) => ({ id: `s:${i}`, text }));
  for (const [pid, p] of Object.entries(rw.projects)) p.bullets.forEach((text, i) => out.push({ id: `p:${pid}:${i}`, text }));
  return out;
}

function setBullet(rw, id, text) {
  const [kind, a, b] = id.split(':');
  if (kind === 's') rw.professionalSummary[Number(a)] = text;
  else rw.projects[a].bullets[Number(b)] = text;
}

function sourceFor(id, { model, confirmations, editable }) {
  const confText = c => `${c.skill} ${c.evidence}`;
  if (id.startsWith('s:')) return `${model.fullText}\n${(confirmations || []).map(confText).join('\n')}`;
  const pid = id.split(':')[1];
  const p = editable.find(x => x.id === pid);
  return `${p ? projectSourceText(p) : ''}\n${(confirmations || []).filter(c => c.projectId === pid).map(confText).join('\n')}`;
}

/**
 * Ask the AI to resize bullets to their target ranges, in bounded passes.
 * targets: optional { id: {lo, hi} }; otherwise every bullet uses the window.
 * A resized bullet is accepted only if it gets closer to the target and adds
 * no unsupported technology.
 */
async function fitLengths(rw, ctx, { targets = null, passes = config.lineFitPasses } = {}) {
  const { provider, window, requestId, log } = ctx;
  const groups = termGroups(ctx.requirements);
  let changed = 0;
  for (let pass = 0; pass < passes; pass++) {
    if (ctx.hardDeadline && Date.now() > ctx.hardDeadline) break;
    const items = listBullets(rw)
      .map(b => ({ ...b, ...(targets && targets[b.id] ? targets[b.id] : { lo: window.lo, hi: window.hi }) }))
      .filter(b => (targets ? !!targets[b.id] : true) && (b.text.length < b.lo || b.text.length > b.hi));
    if (!items.length) break;
    let raw;
    try { raw = await callJson(provider, { ...fitPrompt({ items }), maxTokens: Math.min(config.rewriteMaxTokens, 400 + items.length * 140), label: 'fit-lengths', requestId, log, model: ctx.model_fast }); }
    catch (e) { log.error(`[${requestId}] fit-lengths failed: ${e.kind || e.message}`); break; }
    const byId = new Map((Array.isArray(raw.bullets) ? raw.bullets : []).map(x => [String(x && x.id), cleanBullet(x && x.text)]));
    for (const it of items) {
      const next = byId.get(it.id);
      if (!next || next.length < 40) continue;
      const mid = (it.lo + it.hi) / 2;
      if (Math.abs(next.length - mid) >= Math.abs(it.text.length - mid)) continue;
      const src = sourceFor(it.id, ctx);
      const before = new Set(unsupportedIn(it.text, src, groups));
      const after = unsupportedIn(next, src, groups).filter(t => !before.has(t));
      if (after.length) continue;
      // Never lose a supported JD keyword while resizing.
      const lost = (ctx.requirements || []).some(r => (r.status === 'verified' || r.status === 'confirmed') && hasAny(it.text, r.terms) && !hasAny(next, r.terms));
      if (lost) continue;
      setBullet(rw, it.id, next);
      changed++;
    }
    if (targets) targets = Object.fromEntries(Object.entries(targets).filter(([id]) => listBullets(rw).some(b => b.id === id)));
  }
  return changed;
}

/** Measure every rewritten bullet on the rendered document. */
async function verifyRendered(buffer, rw) {
  const lines = await pdfLines(buffer);
  if (!lines) return null;
  const bullets = listBullets(rw);
  const m = measureBullets(lines, bullets.map(b => b.text));
  return bullets.map((b, i) => ({ ...b, lines: m[i].lines, lastFill: m[i].lastFill, ok: m[i].ok }));
}

/** Targets that move a mis-wrapped bullet onto exactly two full lines. */
function repairTargets(measured, window) {
  const cpl = window.hi / 2;
  const targets = {};
  for (const b of measured) {
    if (b.ok || b.lines === null) continue;
    const n = b.text.length;
    let t;
    if (b.lines < 2) t = n + Math.ceil((1.93 - b.lastFill) * cpl);
    else if (b.lines === 2) t = n + Math.ceil((0.95 - b.lastFill) * cpl);
    else t = n - Math.ceil((b.lines - 2 + b.lastFill - 0.95) * cpl);
    t = Math.max(window.lo - 12, Math.min(window.hi + 14, t));
    targets[b.id] = { lo: t - 3, hi: t + 4 };
  }
  return targets;
}

/** How relevant a bullet is to the JD (for choosing which to drop). */
function relevance(text, requirements) {
  let s = /\d/.test(text) ? 3 : 0; // keep quantified achievements
  for (const r of requirements) {
    if (r.status !== 'verified' && r.status !== 'confirmed') continue;
    if (hasAny(text, r.terms)) s += WEIGHTS[r.priority] || 1;
  }
  return s;
}

/** Remove the n least JD-relevant bullets, never going below the minimums. */
function removeLeastRelevant(rw, n, settings, requirements) {
  const removed = [];
  for (let k = 0; k < n; k++) {
    const pool = [];
    if (rw.professionalSummary.length > settings.summaryMinBullets) rw.professionalSummary.forEach((t, i) => pool.push({ sec: 's', i, t }));
    for (const [pid, p] of Object.entries(rw.projects)) if (p.bullets.length > settings.projectMinBullets) p.bullets.forEach((t, i) => pool.push({ sec: pid, i, t }));
    if (!pool.length) break;
    // Never drop the only bullet in a section that carries a supported JD keyword.
    const sectionOf = x => (x.sec === 's' ? rw.professionalSummary : rw.projects[x.sec].bullets);
    const sole = x => requirements.some(r => (r.status === 'verified' || r.status === 'confirmed') && hasAny(x.t, r.terms) &&
      !sectionOf(x).some((t, j) => j !== x.i && hasAny(t, r.terms)));
    const score = x => relevance(x.t, requirements) + (sole(x) ? 1000 : 0);
    pool.sort((a, b) => score(a) - score(b) || b.i - a.i);
    if (score(pool[0]) >= 1000) break;
    const x = pool[0];
    if (x.sec === 's') rw.professionalSummary.splice(x.i, 1); else rw.projects[x.sec].bullets.splice(x.i, 1);
    removed.push(x.t);
  }
  return removed;
}

/** Ask the AI for n additional, evidence-backed bullets. */
async function addBullets(rw, n, ctx) {
  const { provider, window, requestId, log, jdText, editable } = ctx;
  const sectionsJson = {
    professionalSummary: rw.professionalSummary,
    projects: editable.map(p => ({ projectId: p.id, client: p.client, bullets: rw.projects[p.id].bullets, environment: rw.projects[p.id].environment, originalBullets: p.bullets })),
  };
  let raw;
  try { raw = await callJson(provider, { ...expandPrompt({ count: n, window, sectionsJson, jdText }), maxTokens: Math.min(config.rewriteMaxTokens, 600 + n * 160), label: 'add-bullets', requestId, log, model: ctx.model_fast }); }
  catch (e) { log.error(`[${requestId}] add-bullets failed: ${e.kind || e.message}`); return 0; }
  const groups = termGroups(ctx.requirements);
  let added = 0;
  const seen = new Set(listBullets(rw).map(b => b.text.toLowerCase()));
  const accept = (text, id) => {
    const t = cleanBullet(text);
    if (t.length < 60 || seen.has(t.toLowerCase())) return false;
    if (unsupportedIn(t, sourceFor(id, ctx), groups).length) return false;
    seen.add(t.toLowerCase());
    return t;
  };
  for (const s of Array.isArray(raw.professionalSummary) ? raw.professionalSummary : []) {
    const t = accept(s, 's:new'); if (t) { rw.professionalSummary.push(t); added++; }
  }
  for (const p of Array.isArray(raw.projects) ? raw.projects : []) {
    const pid = String(p && p.projectId);
    if (!rw.projects[pid]) continue;
    for (const nb of Array.isArray(p.newBullets) ? p.newBullets : []) {
      const t = accept(nb, `p:${pid}:new`); if (t) { rw.projects[pid].bullets.push(t); added++; }
    }
  }
  return added;
}

/**
 * Reach the required page count by adding/removing whole two-line bullets.
 * build(rw) → { buffer }. Returns { buffer, stats, log, warnings }.
 */
async function targetPages(rw, build, ctx, settings) {
  const target = settings.requiredPages;
  const logOut = [];
  const warnings = [];
  let buffer = build(rw).buffer;
  let st = await pageStats(buffer);
  if (!st) return { buffer, stats: null, log: logOut, warnings: ['LibreOffice is not installed on the server, so the page count could not be verified.'] };
  logOut.push({ step: 'initial', pages: st.pages, lastPageLines: st.lastPageLines });
  for (let i = 0; i < config.layoutPasses + 3 && st.pages !== target; i++) {
    if (ctx.hardDeadline && Date.now() > ctx.hardDeadline) { warnings.push('Stopped page fitting to stay within the time budget.'); break; }
    const lpp = st.linesPerPage;
    if (st.pages > target) {
      const linesToCut = (st.pages - target - 1) * lpp + st.lastPageLines + 1;
      const removed = removeLeastRelevant(rw, Math.ceil(linesToCut / 2), settings, ctx.requirements);
      if (!removed.length) { warnings.push(`Cannot reach ${target} pages without going below the minimum bullet counts (${settings.summaryMinBullets} summary / ${settings.projectMinBullets} per project).`); break; }
      logOut.push({ step: `removed ${removed.length} least-relevant bullet(s)` });
    } else {
      const linesNeeded = (target - st.pages - 1) * lpp + (lpp - st.lastPageLines) + 1;
      const n = Math.min(40, Math.ceil(linesNeeded / 2) + Math.floor(lpp / 8));
      const before = listBullets(rw).map(b => b.id + b.text);
      const added = await addBullets(rw, n, ctx);
      if (!added) { warnings.push('Could not add enough supported content to reach the page target.'); break; }
      // Make the new bullets exactly two lines as well.
      const fresh = Object.fromEntries(listBullets(rw).filter(b => !before.includes(b.id + b.text)).map(b => [b.id, { lo: ctx.window.lo, hi: ctx.window.hi }]));
      await fitLengths(rw, ctx, { targets: fresh, passes: 1 });
      logOut.push({ step: `added ${added} supported bullet(s)` });
    }
    buffer = build(rw).buffer;
    st = await pageStats(buffer);
    logOut.push({ step: 'rendered', pages: st.pages, lastPageLines: st.lastPageLines });
  }
  // A removal can undershoot by one page; add back a little if so.
  return { buffer, stats: st, log: logOut, warnings };
}

module.exports = { fitLengths, verifyRendered, repairTargets, targetPages, listBullets, removeLeastRelevant };
