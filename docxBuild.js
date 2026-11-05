'use strict';
// Builds a standard-template DOCX from plain text (PDF / TXT uploads),
// so they go through exactly the same editing engine as DOCX uploads.

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
  AlignmentType, LevelFormat, BorderStyle,
} = require('docx');
const { headingKind, parseDateRange, ENV_RE } = require('./resumeModel');

const BULLET_RE = /^\s*(?:[•●▪◦■\-–*➢►✓•]|o\s)\s*/;
const FONT = 'Calibri';

function classifyLines(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/g, ''));
  const items = [];
  let section = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { items.push({ kind: 'blank' }); continue; }
    const hk = headingKind(line);
    if (hk) { section = hk; items.push({ kind: 'heading', text: line.replace(/:$/, ''), section: hk }); continue; }
    if (BULLET_RE.test(line)) { items.push({ kind: 'bullet', text: line.replace(BULLET_RE, '').trim(), section }); continue; }
    const prev = items[items.length - 1];
    if (prev && prev.kind === 'bullet' && !ENV_RE.test(line) && !/^\s*(client|role|company)\s*:/i.test(line) && !parseDateRange(line) &&
        (/^[a-z(,&]/.test(line) || !/[.!?]$/.test(prev.text))) {
      prev.text = `${prev.text} ${line}`; continue; // wrapped continuation line from PDF
    }
    if (section === 'experience' && (/^\s*(client|company)\s*:/i.test(line) || parseDateRange(line))) {
      items.push({ kind: 'project', text: line, section }); continue;
    }
    if (section === 'skills') {
      const m = line.match(/^([^:]{2,45}):\s*(.+)$/);
      if (m) { items.push({ kind: 'skill', category: m[1].trim(), value: m[2].trim(), section }); continue; }
    }
    // Experience paragraphs that read like responsibilities become bullets.
    if (section === 'experience' && line.length > 80 && !ENV_RE.test(line)) { items.push({ kind: 'bullet', text: line, section }); continue; }
    if (section === 'summary' && line.length > 60) { items.push({ kind: 'bullet', text: line, section }); continue; }
    items.push({ kind: 'para', text: line, section, bold: ENV_RE.test(line) ? 'label' : false });
  }
  return items;
}

const run = (text, bold = false) => new TextRun({ text, bold, font: FONT, size: 20 });
const spacing = { before: 0, after: 0, line: 240 };

function buildFromText(text) {
  const items = classifyLines(text);
  const children = [];
  let skillRows = [];
  const flushSkills = () => {
    if (!skillRows.length) return;
    const border = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
    const borders = { top: border, bottom: border, left: border, right: border };
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: skillRows.map(r => new TableRow({ children: [
        new TableCell({ borders, width: { size: 26, type: WidthType.PERCENTAGE }, children: [new Paragraph({ spacing, children: [run(r.category, true)] })] }),
        new TableCell({ borders, width: { size: 74, type: WidthType.PERCENTAGE }, children: [new Paragraph({ spacing, children: [run(r.value)] })] }),
      ] })),
    }));
    skillRows = [];
  };
  let headerDone = false; let lineNo = 0;
  for (const it of items) {
    if (it.kind !== 'skill') flushSkills();
    if (it.kind === 'blank') continue;
    if (it.kind === 'heading') {
      headerDone = true;
      children.push(new Paragraph({ spacing: { before: 160, after: 40, line: 240 }, children: [new TextRun({ text: `${it.text}:`, bold: true, font: FONT, size: 22 })] }));
      continue;
    }
    if (!headerDone) {
      children.push(new Paragraph({ alignment: AlignmentType.LEFT, spacing, children: [new TextRun({ text: it.text || '', bold: lineNo === 0, font: FONT, size: lineNo === 0 ? 28 : 20 })] }));
      lineNo++;
      continue;
    }
    if (it.kind === 'skill') { skillRows.push(it); continue; }
    if (it.kind === 'bullet') { children.push(new Paragraph({ numbering: { reference: 'resume-bullets', level: 0 }, spacing, alignment: AlignmentType.JUSTIFIED, children: [run(it.text)] })); continue; }
    if (it.kind === 'project') { children.push(new Paragraph({ spacing: { before: 120, after: 0, line: 240 }, children: [run(it.text, true)] })); continue; }
    if (it.bold === 'label') {
      const m = it.text.match(/^([^:]+:)\s*(.*)$/);
      children.push(new Paragraph({ spacing, children: [run(`${m[1]} `, true), run(m[2])] }));
      continue;
    }
    children.push(new Paragraph({ spacing, children: [run(it.text)] }));
  }
  flushSkills();

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    numbering: { config: [{ reference: 'resume-bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 360 } } } }] }] },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildFromText, classifyLines };
