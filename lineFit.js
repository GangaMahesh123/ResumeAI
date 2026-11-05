'use strict';
// Exact two-line bullet enforcement.
// 1. Learn the character window that fills exactly two full lines from the
//    candidate's own original bullets (rendered at the original margins).
// 2. Measure every new bullet on the rendered PDF: number of lines and how
//    full the last line is.

const config = require('./config');
const render = require('./render');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

const norm = s => String(s || '').replace(/[ \s]+/g, ' ').trim();

/** Split rendered PDF text into visual lines. */
async function pdfLines(docxBuffer) {
  const pdfBuf = await render.toPdf(docxBuffer);
  if (!pdfBuf) return null;
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(pdfBuf);
  return data.text.split('\n').map(norm).filter(Boolean)
    .map(l => l.replace(/^[•●▪\-]\s*/, '')); // strip bullet glyphs
}

/**
 * For each bullet, find how many rendered lines it occupies and how full its
 * last line is (relative to a full line).
 */
function measureBullets(lines, bullets) {
  const joined = [];
  const lineStart = [];
  let pos = 0;
  for (const l of lines) { lineStart.push(pos); joined.push(l); pos += l.length + 1; }
  const text = joined.join(' ');
  const lineOf = idx => { let lo = 0, hi = lineStart.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= idx) lo = mid; else hi = mid - 1; } return lo; };
  const fullLens = lines.map(l => l.length).sort((a, b) => a - b);
  const fullLine = percentile(fullLens, 90) || 1;

  let searchFrom = 0;
  return bullets.map(b => {
    const t = norm(b);
    const head = t.slice(0, 40);
    let start = text.indexOf(head, searchFrom);
    if (start < 0) start = text.indexOf(head);
    if (start < 0) return { text: b, lines: null, lastFill: null, ok: null };
    searchFrom = start + 1;
    const end = start + t.length - 1;
    const l1 = lineOf(start), l2 = lineOf(Math.min(end, text.length - 1));
    const lastLen = end - lineStart[l2] + 1;
    const lineCount = l2 - l1 + 1;
    const lastFill = Math.round((lastLen / fullLine) * 100) / 100;
    return { text: b, lines: lineCount, lastFill, ok: lineCount === 2 && lastFill >= 0.85 };
  });
}

/**
 * Character window [lo, hi] that renders as two complete lines, learned from
 * the original bullets that already render as exactly two full lines.
 */
async function learnWindow(originalDocx, model) {
  const all = [
    ...(model.summary ? model.summary.bullets : []),
    ...model.projects.flatMap(p => p.bullets),
  ].filter(b => b.length > 60);
  const lens = all.map(b => b.length).sort((a, b) => a - b);
  const fallback = { lo: Math.max(150, percentile(lens, 15)), hi: Math.max(160, percentile(lens, 95)), source: 'original bullet lengths' };
  let lines = null;
  try { lines = await pdfLines(originalDocx); } catch { lines = null; }
  if (!lines) return { ...fallback, verified: false };
  const m = measureBullets(lines, all);
  const good = m.filter(x => x.ok).map(x => x.text.length).sort((a, b) => a - b);
  if (good.length < 5) {
    // Derive from characters per line instead.
    const per = m.filter(x => x.lines).map(x => x.text.length / (x.lines - 1 + (x.lastFill || 1))).sort((a, b) => a - b);
    const cpl = percentile(per, 50);
    if (!cpl) return { ...fallback, verified: false };
    return { lo: Math.round(cpl * 1.88), hi: Math.round(cpl * 1.99), source: `rendered ~${Math.round(cpl)} characters per line`, verified: true };
  }
  return { lo: percentile(good, 10), hi: percentile(good, 95), source: `${good.length} original two-line bullets`, verified: true };
}

/** Pages, lines on the last page and typical lines per page of a rendered DOCX. */
async function pageStats(docxBuffer) {
  const pdfBuf = await render.toPdf(docxBuffer);
  if (!pdfBuf) return null;
  const pdfParse = require('pdf-parse');
  const counts = [];
  await pdfParse(pdfBuf, {
    pagerender: async pd => {
      const tc = await pd.getTextContent({ normalizeWhitespace: true });
      const ys = new Set(tc.items.filter(i => String(i.str).trim()).map(i => Math.round(i.transform[5])));
      counts.push(ys.size);
      return '';
    },
  });
  const sorted = [...counts].sort((a, b) => a - b);
  return { pages: counts.length, lastPageLines: counts[counts.length - 1] || 0, linesPerPage: sorted[Math.max(0, sorted.length - 2)] || sorted[0] || 50 };
}

module.exports = { learnWindow, measureBullets, pdfLines, pageStats, norm };
