'use strict';
// Structured resume model built from a DOCX body.
// Identifies header, Professional Summary, Technical Skills, every
// employment section (with dates, role, bullets, Environment line) and
// orders projects by date so "first two recent projects" is reliable and
// not based on hard-coded client names.

const AdmZip = require('adm-zip');
const { tokenizeBody, cleanText, isListParagraph, parseTable } = require('./xml');

const HEADINGS = [
  { kind: 'summary', re: /^(professional\s+summary|summary|career\s+summary|executive\s+summary|professional\s+profile|profile|summary\s+of\s+qualifications|overview)$/i },
  { kind: 'skills', re: /^(technical\s+skills|skills|core\s+competencies|technical\s+expertise|technical\s+proficiencies|skills\s+summary|key\s+skills|technology\s+stack)$/i },
  { kind: 'experience', re: /^(professional\s+experience|work\s+experience|experience|employment\s+history|work\s+history|professional\s+history|relevant\s+experience|project\s+experience)$/i },
  { kind: 'education', re: /^(education|academic\s+background|education\s+&\s+certifications|education\s+and\s+certifications)$/i },
  { kind: 'certifications', re: /^(certifications?|licenses?\s+&\s+certifications|certificates)$/i },
  { kind: 'other', re: /^(projects|awards|achievements|publications|languages|interests|references|volunteer(ing)?|training)$/i },
];

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_PART = `(?:${MON}\\.?\\s*'?(\\d{2,4})|(\\d{1,2})\\/(\\d{4})|(\\d{4}))`;
const END_WORDS = '(present|current|till\\s*date|to\\s*date|now|ongoing)';
const DATE_RANGE_RE = new RegExp(`${DATE_PART}\\s*(?:-|–|—|to|until)\\s*(?:${DATE_PART}|${END_WORDS})`, 'i');

function headingKind(text) {
  const t = text.replace(/[:\-–—|•*_#]+\s*$/, '').replace(/^[\s•*#]+/, '').trim();
  if (!t || t.length > 60) return null;
  for (const h of HEADINGS) if (h.re.test(t)) return h.kind;
  return null;
}

function toYear(y) {
  let n = Number(y);
  if (y && y.length === 2) n = n > 50 ? 1900 + n : 2000 + n;
  return n;
}

function parseOneDate(groups) {
  // groups: [mon, yy, mm, yyyy, yyyyOnly]
  const [mon, yy, mm, yyyy2, yOnly] = groups;
  if (mon) return { y: toYear(yy), m: MONTHS[mon.toLowerCase().slice(0, 3)] ?? 0 };
  if (mm) return { y: Number(yyyy2), m: Math.max(0, Math.min(11, Number(mm) - 1)) };
  if (yOnly) return { y: Number(yOnly), m: 0 };
  return null;
}

function parseDateRange(text, now = new Date()) {
  const m = String(text).match(DATE_RANGE_RE);
  if (!m) return null;
  const start = parseOneDate([m[1], m[2], m[3], m[4], m[5]]);
  let end;
  if (m[11]) end = { y: now.getFullYear(), m: now.getMonth(), present: true };
  else end = parseOneDate([m[6], m[7], m[8], m[9], m[10]]);
  if (!start || !end || !start.y || !end.y) return null;
  return { raw: m[0].trim(), start, end, startKey: start.y * 12 + start.m, endKey: end.y * 12 + end.m };
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
}

function extractClient(text, dates) {
  let t = text.replace(/\|/g, ' ');
  const label = t.match(/client\s*:\s*(.+)/i) || t.match(/(?:company|employer|organization)\s*:\s*(.+)/i);
  if (label) t = label[1];
  if (dates) t = t.replace(dates.raw, ' ');
  t = t.replace(/role\s*:.*/i, '');
  t = t.split(/\s{3,}|\t/)[0];
  return t.replace(/[,.;:\s]+$/, '').replace(/^[,.;:\s]+/, '').trim();
}

function extractRole(texts) {
  for (const t of texts) {
    const m = t.match(/(?:role|title|position|designation)\s*:\s*([^|\n]+?)(?:\s{3,}|\s*\||$)/i);
    if (m) return m[1].trim().replace(/[,.;]+$/, '');
  }
  return '';
}

const ENV_RE = /^\s*(environment|technical\s+environment|tech(nology)?\s+stack|technologies(\s+used)?|tools\s*&\s*technologies)\s*:/i;
const RESP_RE = /^\s*(responsibilities|key\s+responsibilities|roles?\s*&\s*responsibilities)\s*:?\s*$/i;

/**
 * Build the structured model from tokenized body blocks.
 */
function buildModel(body) {
  const blocks = body.blocks.map((b, idx) => ({
    idx,
    type: b.type,
    text: cleanText(b.text),
    rawText: b.text,
    isList: b.type === 'p' && isListParagraph(b.xml),
  }));

  // 1. Section headings
  const headings = [];
  for (const b of blocks) {
    if (b.type !== 'p' || b.isList) continue;
    const k = headingKind(b.text);
    if (k) headings.push({ idx: b.idx, kind: k, title: b.text });
  }
  const sections = headings.map((h, i) => ({
    ...h,
    start: h.idx + 1,
    end: i + 1 < headings.length ? headings[i + 1].idx : blocks.length,
  }));
  const firstHeading = headings.length ? headings[0].idx : blocks.length;
  const headerBlocks = blocks.slice(0, firstHeading).filter(b => b.type === 'p' && b.text);
  const header = headerBlocks.map(b => b.text);
  const ROLE = /\b(developer|engineer|architect|lead|manager|analyst|consultant|scientist|programmer|administrator|specialist|designer|director|head|owner)\b/i;
  const titleBlock = headerBlocks.slice(1, 4).find(b => b.text.length <= 90 && ROLE.test(b.text) && !/@|https?:|www\.|linkedin|\d{3}[-.\s]\d{3}[-.\s]\d{4}|:/i.test(b.text));

  const model = {
    header: { name: header[0] || '', lines: header, titleIdx: titleBlock ? titleBlock.idx : null, title: titleBlock ? titleBlock.text : '' },
    sections: sections.map(s => ({ kind: s.kind, title: s.title, headingIdx: s.idx, start: s.start, end: s.end })),
    summary: null,
    skills: null,
    projects: [],
    blocks,
  };

  // 2. Summary
  const sum = sections.find(s => s.kind === 'summary');
  if (sum) {
    const inRange = blocks.slice(sum.start, sum.end).filter(b => b.type === 'p' && b.text);
    let bullets = inRange.filter(b => b.isList);
    if (!bullets.length) bullets = inRange; // paragraph-style summary
    model.summary = { headingIdx: sum.idx, bulletIdxs: bullets.map(b => b.idx), bullets: bullets.map(b => b.text) };
  }

  // 3. Technical skills
  const sk = sections.find(s => s.kind === 'skills');
  if (sk) {
    const tbl = blocks.slice(sk.start, sk.end).find(b => b.type === 'tbl');
    if (tbl) {
      const parsed = parseTable(body.blocks[tbl.idx].xml);
      const rows = parsed.rows.map(r => ({
        category: (r.cells[0] && r.cells[0].text) || '',
        value: r.cells.slice(1).map(c => c.text).join(' '),
      })).filter(r => r.category || r.value);
      model.skills = { kind: 'table', tableIdx: tbl.idx, headingIdx: sk.idx, rows };
    } else {
      const paras = blocks.slice(sk.start, sk.end).filter(b => b.type === 'p' && b.text);
      const rows = [];
      for (let i = 0; i < paras.length; i++) {
        const t = paras[i].text;
        const m = t.match(/^([^:]{2,45}):\s*(.+)$/);
        if (m) rows.push({ category: m[1].trim(), value: m[2].trim() });
        else if (t.length <= 45 && paras[i + 1] && paras[i + 1].text.length > t.length) {
          rows.push({ category: t, value: paras[i + 1].text }); i++;
        } else rows.push({ category: '', value: t });
      }
      model.skills = { kind: 'paragraphs', headingIdx: sk.idx, idxs: paras.map(p => p.idx), rows };
    }
  }

  // 4. Experience → projects
  const exps = sections.filter(s => s.kind === 'experience');
  for (const ex of exps) {
    const range = blocks.slice(ex.start, ex.end);
    const headIdxs = [];
    for (const b of range) {
      if (b.type !== 'p' || b.isList || !b.text || b.text.length > 450) continue;
      if (ENV_RE.test(b.text)) continue;
      const isClient = /^\s*(client|company|employer|organization)\s*:/i.test(b.text);
      const dates = parseDateRange(b.text);
      if (isClient || dates) {
        // A dates-only line directly after a client line belongs to the same project.
        const prev = headIdxs[headIdxs.length - 1];
        if (prev !== undefined && !isClient && b.idx - prev <= 2 &&
            /^\s*(client|company)\s*:/i.test(blocks[prev].text) && !parseDateRange(blocks[prev].text)) continue;
        headIdxs.push(b.idx);
      }
    }
    headIdxs.forEach((hIdx, i) => {
      const end = i + 1 < headIdxs.length ? headIdxs[i + 1] : ex.end;
      const inRange = blocks.slice(hIdx, end);
      const headText = blocks[hIdx].text;
      const near = inRange.slice(0, 5).filter(b => b.type === 'p' && !b.isList).map(b => b.text);
      const dates = parseDateRange(headText) || near.map(t => parseDateRange(t)).find(Boolean) || null;
      const env = inRange.find(b => b.type === 'p' && ENV_RE.test(b.text));
      let bullets = inRange.filter(b => b.isList && b.text && (!env || b.idx !== env.idx));
      if (!bullets.length) {
        bullets = inRange.filter(b => b.type === 'p' && b.idx !== hIdx && b.text.length > 60 &&
          !ENV_RE.test(b.text) && !RESP_RE.test(b.text) && !/^\s*role\s*:/i.test(b.text) && !parseDateRange(b.text));
      }
      const client = extractClient(headText, dates);
      model.projects.push({
        docOrder: model.projects.length,
        client,
        role: extractRole([headText, ...near]),
        dates: dates ? { raw: dates.raw, start: dates.start, end: dates.end, startKey: dates.startKey, endKey: dates.endKey } : null,
        headingIdx: hIdx,
        blockStart: hIdx,
        blockEnd: end, // exclusive
        bulletIdxs: bullets.map(b => b.idx),
        bullets: bullets.map(b => b.text),
        envIdx: env ? env.idx : null,
        environment: env ? env.text.replace(ENV_RE, '').trim() : '',
      });
    });
  }

  // 5. Order projects by start date (most recent first); fall back to doc order.
  const ordered = [...model.projects].sort((a, b) => {
    const ak = a.dates ? a.dates.endKey * 10000 + a.dates.startKey : -1;
    const bk = b.dates ? b.dates.endKey * 10000 + b.dates.startKey : -1;
    if (ak !== bk) return bk - ak;
    return a.docOrder - b.docOrder;
  });
  ordered.forEach((p, i) => {
    p.recency = i; // 0 = most recent
    p.id = `p${p.docOrder + 1}-${slug(p.client)}`;
  });

  model.fullText = blocks.filter(b => b.text).map(b => b.text).join('\n');
  model.experienceYears = computeYears(model.projects);
  return model;
}

function computeYears(projects) {
  const dated = projects.filter(p => p.dates);
  if (!dated.length) return null;
  // Merge overlapping ranges so concurrent roles are not double counted.
  const ranges = dated.map(p => [p.dates.startKey, p.dates.endKey]).sort((a, b) => a[0] - b[0]);
  let total = 0; let [cs, ce] = ranges[0];
  for (const [s, e] of ranges.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else { total += ce - cs; cs = s; ce = e; }
  }
  total += ce - cs;
  return Math.round((total / 12) * 10) / 10;
}

function loadDocx(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch (e) { throw Object.assign(new Error('The DOCX file could not be opened (not a valid Word document).'), { code: 'INVALID_DOCX' }); }
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw Object.assign(new Error('The DOCX file has no main document part.'), { code: 'INVALID_DOCX' });
  const documentXml = entry.getData().toString('utf-8');
  const body = tokenizeBody(documentXml);
  const model = buildModel(body);
  return { zip, documentXml, body, model };
}

/** Compact JSON view of the model for the AI (no XML). */
function modelForAI(model) {
  return {
    header: model.header.lines.slice(0, 3),
    totalExperienceYears: model.experienceYears,
    professionalSummary: model.summary ? model.summary.bullets : [],
    technicalSkills: model.skills ? model.skills.rows : [],
    projects: [...model.projects].sort((a, b) => a.recency - b.recency).map(p => ({
      projectId: p.id,
      recencyRank: p.recency + 1,
      client: p.client,
      role: p.role,
      dates: p.dates ? p.dates.raw : 'unknown',
      bullets: p.bullets,
      environment: p.environment,
    })),
  };
}

module.exports = { loadDocx, buildModel, parseDateRange, headingKind, modelForAI, computeYears, ENV_RE, slug };
