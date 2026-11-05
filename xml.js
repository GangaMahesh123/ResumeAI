'use strict';
// Low-level WordprocessingML helpers.
// Works on the raw document.xml string so the original formatting of every
// untouched paragraph is preserved byte-for-byte.

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/**
 * Visible text of a paragraph (or any XML fragment).
 * Handles text split across runs, <w:tab/>, <w:br/> and ignores
 * deleted text and field instructions.
 */
function paragraphText(xml) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:tab\s[^>]*\/>|<w:br\/>|<w:br\s[^>]*\/>|<w:cr\/>|<w:delText[\s\S]*?<\/w:delText>|<w:instrText[\s\S]*?<\/w:instrText>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tok = m[0];
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else if (tok.startsWith('<w:tab')) out += '\t';
    else if (tok.startsWith('<w:br') || tok.startsWith('<w:cr')) out += '\n';
  }
  return out;
}

/** Collapse whitespace for analysis (keeps line breaks as " | "). */
function cleanText(t) {
  return String(t || '')
    .replace(/\n+/g, ' | ')
    .replace(/[\t  ]+/g, ' ')
    .trim();
}

/**
 * Split the <w:body> content into top-level blocks (paragraphs, tables,
 * section properties, anything else) while respecting nesting
 * (text boxes contain nested paragraphs).
 */
function tokenizeBody(documentXml) {
  const bodyOpen = documentXml.indexOf('<w:body>');
  const bodyClose = documentXml.lastIndexOf('</w:body>');
  if (bodyOpen < 0 || bodyClose < 0) throw new Error('Invalid DOCX: missing <w:body>');
  const prefix = documentXml.slice(0, bodyOpen + '<w:body>'.length);
  const suffix = documentXml.slice(bodyClose);
  const body = documentXml.slice(bodyOpen + '<w:body>'.length, bodyClose);

  const blocks = [];
  const tagRe = /<(\/?)w:(p|tbl|sectPr)(?=[\s>\/])[^>]*?(\/?)>/g;
  let depth = 0;
  let current = null; // {type, start}
  let lastEnd = 0;
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    const closing = m[1] === '/';
    const selfClosing = m[3] === '/';
    const name = m[2];
    if (depth === 0 && !closing) {
      if (m.index > lastEnd) {
        const between = body.slice(lastEnd, m.index);
        if (between.trim()) blocks.push({ type: 'raw', xml: between });
      }
      if (selfClosing) {
        blocks.push({ type: name, xml: m[0] });
        lastEnd = tagRe.lastIndex;
        continue;
      }
      current = { type: name, start: m.index, name };
      depth = 1;
      continue;
    }
    if (!current) continue;
    if (name !== current.name) continue; // only count same-name nesting
    if (selfClosing) continue;
    if (closing) depth -= 1; else depth += 1;
    if (depth === 0) {
      const xml = body.slice(current.start, tagRe.lastIndex);
      blocks.push({ type: current.type, xml });
      lastEnd = tagRe.lastIndex;
      current = null;
    }
  }
  if (lastEnd < body.length) {
    const tail = body.slice(lastEnd);
    if (tail.trim()) blocks.push({ type: 'raw', xml: tail });
  }
  for (const b of blocks) {
    b.text = b.type === 'p' || b.type === 'tbl' ? paragraphText(b.xml) : '';
  }
  return { prefix, blocks, suffix };
}

function joinBody({ prefix, blocks, suffix }) {
  return prefix + blocks.map(b => b.xml).join('') + suffix;
}

function getPPr(pXml) {
  const m = pXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  return m ? m[0] : '';
}

/** First run properties that actually carry formatting for text. */
function getFirstRunRPr(pXml) {
  const runs = pXml.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) || [];
  for (const r of runs) {
    if (!/<w:t[\s>]/.test(r)) continue;
    const m = r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    if (m) return m[0];
  }
  return '';
}

function isListParagraph(pXml) {
  const ppr = getPPr(pXml);
  return /<w:numPr>/.test(ppr) || /w:pStyle w:val="(ListParagraph|ListBullet|List Bullet|ListBullet\d?)"/i.test(ppr);
}

/** Split a table XML into rows and each row into cells. */
function parseTable(tblXml) {
  const rows = [];
  const rowRe = /<w:tr[\s>][\s\S]*?<\/w:tr>/g;
  let rm;
  while ((rm = rowRe.exec(tblXml)) !== null) {
    const rowXml = rm[0];
    const cells = [];
    const cellRe = /<w:tc>[\s\S]*?<\/w:tc>|<w:tc\s[\s\S]*?<\/w:tc>/g;
    let cm;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      cells.push({ xml: cm[0], text: cleanText(paragraphText(cm[0])) });
    }
    rows.push({ xml: rowXml, cells, index: rm.index });
  }
  const tblStart = tblXml.indexOf('<w:tr');
  const lastRowEnd = tblXml.lastIndexOf('</w:tr>') + '</w:tr>'.length;
  return {
    rows,
    head: tblStart >= 0 ? tblXml.slice(0, tblStart) : tblXml,
    tail: lastRowEnd > 0 ? tblXml.slice(lastRowEnd) : ''
  };
}

module.exports = {
  escapeXml, unescapeXml, paragraphText, cleanText, tokenizeBody, joinBody,
  getPPr, getFirstRunRPr, isListParagraph, parseTable
};
