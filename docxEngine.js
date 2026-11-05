'use strict';
// Applies a validated rewrite to the original DOCX.
// Only the Professional Summary bullets, Technical Skills, and the bullets +
// Environment line of editable projects are replaced. Every other block keeps
// its original XML, so headers, dates, titles and older projects are untouched.

const AdmZip = require('adm-zip');
const { escapeXml, getPPr, getFirstRunRPr, parseTable, joinBody, tokenizeBody, paragraphText, cleanText } = require('./xml');
const { LIBRARY, allNames } = require('./domains');

const FONT = 'Calibri';
const SIZE = 20; // half-points → 10 pt

// Canonical CT_PPr child order (Word rejects out-of-order elements).
const PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];

/** Split the direct children of an element's inner XML. */
function childElements(inner) {
  const out = [];
  const re = /<w:([A-Za-z0-9]+)(\s[^>]*?)?(\/?)>/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const name = m[1];
    if (m[3] === '/') { out.push({ name, xml: m[0] }); continue; }
    // find matching close, honouring nesting of same name
    let depth = 1; const open = new RegExp(`<w:${name}(?=[\\s>/])[^>]*?(/?)>|</w:${name}>`, 'g');
    open.lastIndex = re.lastIndex;
    let mm; let end = -1;
    while ((mm = open.exec(inner)) !== null) {
      if (mm[0].startsWith('</')) { depth--; if (depth === 0) { end = open.lastIndex; break; } }
      else if (mm[1] !== '/') depth++;
    }
    if (end < 0) end = inner.length;
    out.push({ name, xml: inner.slice(m.index, end) });
    re.lastIndex = end;
  }
  return out;
}

function runProps({ bold = false, color = null } = {}) {
  return `<w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="${FONT}"/>${bold ? '<w:b/><w:bCs/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${SIZE}"/><w:szCs w:val="${SIZE}"/></w:rPr>`;
}

/** Normalise paragraph properties: single spacing, 0 before/after, Calibri 10 mark. */
function normalizePPr(pPr, { keepSpacing = false } = {}) {
  const inner = pPr ? pPr.replace(/^<w:pPr>/, '').replace(/<\/w:pPr>$/, '') : '';
  let kids = childElements(inner).filter(k => k.name !== 'pPrChange' && k.name !== 'sectPr');
  if (!keepSpacing) {
    kids = kids.filter(k => k.name !== 'spacing');
    kids.push({ name: 'spacing', xml: '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' });
  }
  kids = kids.filter(k => k.name !== 'rPr');
  kids.push({ name: 'rPr', xml: runProps() });
  kids.sort((a, b) => {
    const ia = PPR_ORDER.indexOf(a.name), ib = PPR_ORDER.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return `<w:pPr>${kids.map(k => k.xml).join('')}</w:pPr>`;
}

function templateColor(rPr) {
  const m = rPr && rPr.match(/<w:color w:val="([0-9A-Fa-f]{6})"/);
  return m && m[1].toUpperCase() !== '000000' ? m[1] : null;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Build the list of technology names to bold. */
function boldTermList(extra = []) {
  const set = new Set();
  for (const e of LIBRARY) for (const n of allNames(e)) if (n.length > 2 || /[A-Z]{2}/.test(n)) set.add(n);
  for (const t of extra) if (t && t.length > 2 && t.length < 40) set.add(t);
  return [...set].sort((a, b) => b.length - a.length);
}

let _boldRe = null; let _boldKey = '';
function boldRegex(terms) {
  const key = terms.join('|');
  if (_boldRe && _boldKey === key) return _boldRe;
  _boldKey = key;
  _boldRe = new RegExp(`(^|[^A-Za-z0-9])(${terms.map(escapeRe).join('|')})(\\s?(?:v?\\d+(?:\\.\\d+){0,2}x?|[\\d.]+\\+))?(?=$|[^A-Za-z0-9+#])`, 'gi');
  return _boldRe;
}

/** Split text into runs, bolding technology names and their versions. */
function runsFor(text, { boldTerms, color = null, allBold = false }) {
  if (allBold || !boldTerms || !boldTerms.length) {
    return `<w:r>${runProps({ bold: allBold, color })}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  }
  const re = boldRegex(boldTerms);
  re.lastIndex = 0;
  const segs = [];
  let last = 0; let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[1].length;
    const end = start + m[2].length + (m[3] ? m[3].length : 0);
    if (start > last) segs.push({ t: text.slice(last, start), b: false });
    segs.push({ t: text.slice(start, end), b: true });
    last = end;
    re.lastIndex = Math.max(end, re.lastIndex);
  }
  if (last < text.length) segs.push({ t: text.slice(last), b: false });
  return segs.filter(s => s.t).map(s => `<w:r>${runProps({ bold: s.b, color })}<w:t xml:space="preserve">${escapeXml(s.t)}</w:t></w:r>`).join('');
}

function paragraph({ pPr, text, boldTerms, allBold = false, color = null, prefix = null }) {
  const pre = prefix ? `<w:r>${runProps({ bold: true, color })}<w:t xml:space="preserve">${escapeXml(prefix)}</w:t></w:r>` : '';
  return `<w:p>${normalizePPr(pPr)}${pre}${runsFor(text, { boldTerms, allBold, color })}</w:p>`;
}

function stripIds(xml) { return xml.replace(/\s(?:w14:paraId|w14:textId|w:rsidR|w:rsidRDefault|w:rsidP|w:rsidRPr|w:rsidTr)="[^"]*"/g, ''); }

/** Replace an inclusive block range with new blocks, keeping any unexpected content. */
function spliceRange(blocks, first, last, newXmls, warnings, label) {
  const kept = [];
  for (let i = first; i <= last; i++) {
    const b = blocks[i];
    const isEmptyP = b.type === 'p' && !cleanText(b.text);
    const isBulletish = b.type === 'p';
    if (b.__replace || isEmptyP) continue;
    if (!isBulletish) { kept.push(b); warnings.push(`${label}: kept a non-paragraph element found between bullets.`); }
  }
  const replacement = newXmls.map(xml => ({ type: 'p', xml, text: '', __new: true }));
  return [...blocks.slice(0, first), ...replacement, ...kept, ...blocks.slice(last + 1)];
}

function buildSkillsTable(tblXml, categories, boldTerms) {
  const { rows, head, tail } = parseTable(tblXml);
  if (!rows.length) return null;
  const tpl = rows[0];
  const rowPrefix = stripIds(tpl.xml.slice(0, tpl.xml.indexOf('<w:tc')));
  const cellXmls = tpl.cells.map(c => c.xml);
  const cellPart = (cellXml, text, isCategory) => {
    const tcPr = (cellXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [''])[0];
    const firstP = (cellXml.match(/<w:p[\s>][\s\S]*?<\/w:p>/) || ['<w:p></w:p>'])[0];
    const pPr = getPPr(firstP);
    const color = templateColor(getFirstRunRPr(firstP));
    const p = `<w:p>${normalizePPr(pPr)}${runsFor(text, { boldTerms: isCategory ? null : boldTerms, allBold: isCategory, color: isCategory ? color : null })}</w:p>`;
    return `<w:tc>${tcPr}${p}</w:tc>`;
  };
  const newRows = categories.map(cat => {
    const cells = cellXmls.map((cx, i) => cellPart(cx, i === 0 ? cat.category : i === 1 ? cat.items.join(', ') : '', i === 0));
    return `${rowPrefix}${cells.join('')}</w:tr>`;
  });
  return `${head}${newRows.join('')}${tail}`;
}

/**
 * @param state  result of loadDocx(): { zip, body, model }
 * @param rewrite validated rewrite { professionalSummary, technicalSkills, projects{id:{bullets,environment}} }
 * @param opts { editable, settings, boldExtra }
 * @returns { buffer, warnings, lockedIntact }
 */
function applyRewrite(state, rewrite, { editable, settings, boldExtra = [] }) {
  const { zip, body, model } = state;
  const warnings = [];
  const boldTerms = boldTermList(boldExtra);
  let blocks = body.blocks.map(b => ({ ...b }));
  const ops = []; // {first,last,xmls,label} applied from bottom up

  // Summary
  if (settings.rewriteSummary && model.summary && model.summary.bulletIdxs.length && rewrite.professionalSummary.length) {
    const tplXml = blocks[model.summary.bulletIdxs[0]].xml;
    const xmls = rewrite.professionalSummary.map(t => paragraph({ pPr: getPPr(tplXml), text: t, boldTerms }));
    ops.push({ first: model.summary.bulletIdxs[0], last: model.summary.bulletIdxs[model.summary.bulletIdxs.length - 1], xmls, label: 'Professional Summary' });
  } else if (settings.rewriteSummary) {
    warnings.push('Professional Summary section was not found, so it could not be rewritten.');
  }

  // Skills
  if (settings.optimizeSkills && model.skills && rewrite.technicalSkills.length) {
    if (model.skills.kind === 'table') {
      const newTbl = buildSkillsTable(blocks[model.skills.tableIdx].xml, rewrite.technicalSkills, boldTerms);
      if (newTbl) ops.push({ first: model.skills.tableIdx, last: model.skills.tableIdx, xmls: [newTbl], label: 'Technical Skills', raw: true });
    } else if (model.skills.idxs.length) {
      const tpl = blocks[model.skills.idxs[0]].xml;
      const xmls = rewrite.technicalSkills.map(c => paragraph({ pPr: getPPr(tpl), text: c.items.join(', '), prefix: `${c.category}: `, boldTerms: null }));
      ops.push({ first: model.skills.idxs[0], last: model.skills.idxs[model.skills.idxs.length - 1], xmls, label: 'Technical Skills' });
    }
  }

  // Projects
  for (const p of editable) {
    const rp = rewrite.projects[p.id];
    if (!rp) continue;
    if (p.bulletIdxs.length && rp.bullets.length) {
      const tplXml = blocks[p.bulletIdxs[0]].xml;
      const xmls = rp.bullets.map(t => paragraph({ pPr: getPPr(tplXml), text: t, boldTerms }));
      ops.push({ first: p.bulletIdxs[0], last: p.bulletIdxs[p.bulletIdxs.length - 1], xmls, label: p.client });
    } else {
      warnings.push(`${p.client}: no responsibility bullets were found to rewrite.`);
    }
    if (settings.reconcileEnvironment && p.envIdx !== null && rp.environment.length) {
      const envBlock = blocks[p.envIdx];
      const origText = paragraphText(envBlock.xml);
      const sep = (origText.match(/;/g) || []).length >= 3 ? '; ' : ', ';
      const color = templateColor(getFirstRunRPr(envBlock.xml));
      const xml = paragraph({ pPr: getPPr(envBlock.xml), text: rp.environment.join(sep), prefix: 'Environment: ', boldTerms: null, color });
      ops.push({ first: p.envIdx, last: p.envIdx, xmls: [xml], label: `${p.client} Environment`, raw: true });
    }
  }

  // Apply bottom-up so indexes stay valid.
  ops.sort((a, b) => b.first - a.first);
  for (const op of ops) {
    if (op.raw) {
      blocks = [...blocks.slice(0, op.first), ...op.xmls.map(xml => ({ type: op.label === 'Technical Skills' && xml.startsWith('<w:tbl') ? 'tbl' : 'p', xml, text: '', __new: true })), ...blocks.slice(op.last + 1)];
    } else {
      for (let i = op.first; i <= op.last; i++) if (blocks[i].type === 'p' && blocks[i].text && /<w:numPr>|ListParagraph|List/i.test(getPPr(blocks[i].xml))) blocks[i].__replace = true;
      // Summary/paragraph-style bullets without list formatting are also replaced.
      for (let i = op.first; i <= op.last; i++) if (blocks[i].type === 'p') blocks[i].__replace = true;
      blocks = spliceRange(blocks, op.first, op.last, op.xmls, warnings, op.label);
    }
  }

  // Drop empty paragraphs at the very end (they can spill onto a blank last page).
  let end = blocks.length;
  while (end > 0) {
    const b = blocks[end - 1];
    if (b.type === 'sectPr' || b.type === 'raw') { end--; continue; }
    break;
  }
  let cut = end;
  while (cut > 0 && blocks[cut - 1].type === 'p' && !cleanText(blocks[cut - 1].text || paragraphText(blocks[cut - 1].xml)) &&
         !/<w:sectPr|<w:drawing|<w:pict|<w:object/.test(blocks[cut - 1].xml)) cut--;
  if (cut < end) blocks = [...blocks.slice(0, cut), ...blocks.slice(end)];

  const newXml = joinBody({ prefix: body.prefix, blocks, suffix: body.suffix });
  zip.updateFile('word/document.xml', Buffer.from(newXml, 'utf-8'));
  return { buffer: zip.toBuffer(), documentXml: newXml, warnings };
}

/** Verify locked projects survived byte-for-byte. */
function lockedSectionsIntact(originalBody, newDocumentXml, lockedProjects) {
  const results = [];
  for (const p of lockedProjects) {
    const xml = originalBody.blocks.slice(p.blockStart, p.blockEnd).map(b => b.xml).join('');
    results.push({ projectId: p.id, client: p.client, intact: newDocumentXml.includes(xml) });
  }
  return results;
}

/** Set page margins (twips) on all section properties. */
function setMargins(buffer, twips) {
  const zip = new AdmZip(buffer);
  let xml = zip.getEntry('word/document.xml').getData().toString('utf-8');
  xml = xml.replace(/<w:pgMar\b[^>]*\/>/g, tag => tag
    .replace(/w:top="\d+"/, `w:top="${twips}"`).replace(/w:bottom="\d+"/, `w:bottom="${twips}"`)
    .replace(/w:left="\d+"/, `w:left="${twips}"`).replace(/w:right="\d+"/, `w:right="${twips}"`));
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf-8'));
  return zip.toBuffer();
}

function getMargins(buffer) {
  const zip = new AdmZip(buffer);
  const xml = zip.getEntry('word/document.xml').getData().toString('utf-8');
  const m = xml.match(/<w:pgMar\b[^>]*w:left="(\d+)"/);
  return m ? Number(m[1]) : 1440;
}

/** Formatting audit of the edited sections in a finished DOCX. */
function auditFormatting(buffer, model, editableIds, settings) {
  const zip = new AdmZip(buffer);
  const xml = zip.getEntry('word/document.xml').getData().toString('utf-8');
  const body = tokenizeBody(xml);
  const issues = [];
  const checkPara = (b, where) => {
    const runs = b.xml.match(/<w:r>[\s\S]*?<\/w:r>|<w:r\s[\s\S]*?<\/w:r>/g) || [];
    for (const r of runs) {
      if (!/<w:t[\s>]/.test(r)) continue;
      if (!/w:ascii="Calibri"/.test(r) || !/<w:sz w:val="20"\/>/.test(r)) { issues.push(`${where}: text not Calibri 10`); return; }
    }
    const ppr = getPPr(b.xml);
    if (!/<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"\/>/.test(ppr)) issues.push(`${where}: spacing not single/0/0`);
  };
  const checkRange = (idxs, label) => {
    if (!idxs.length) return;
    let blank = 0;
    for (let i = idxs[0]; i <= idxs[idxs.length - 1]; i++) {
      const b = body.blocks[i];
      if (b.type === 'p' && !cleanText(b.text)) blank++;
    }
    if (blank) issues.push(`${label}: ${blank} empty line(s) between bullets`);
    idxs.forEach(i => checkPara(body.blocks[i], label));
  };
  checkRange(model.summary ? model.summary.bulletIdxs : [], 'Professional Summary');
  for (const p of model.projects.filter(x => editableIds.includes(x.id))) checkRange(p.bulletIdxs, p.client);
  const counts = {
    summary: model.summary ? model.summary.bulletIdxs.length : 0,
    projects: model.projects.map(p => ({ id: p.id, client: p.client, bullets: p.bulletIdxs.length, editable: editableIds.includes(p.id) })),
  };
  if (counts.summary < settings.summaryMinBullets) issues.push(`Professional Summary has ${counts.summary} bullets (minimum ${settings.summaryMinBullets}).`);
  for (const p of counts.projects) {
    if (p.bullets < settings.projectMinBullets) issues.push(`${p.client} has ${p.bullets} bullets (minimum ${settings.projectMinBullets})${p.editable ? '' : ' — protected project, left unchanged'}.`);
  }
  return { issues: [...new Set(issues)].slice(0, 40), counts, font: 'Calibri 10' };
}

module.exports = { applyRewrite, lockedSectionsIntact, setMargins, getMargins, auditFormatting, normalizePPr, childElements, boldTermList, runsFor };
