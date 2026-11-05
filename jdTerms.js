'use strict';
// Deterministic extraction of every explicit technical term in a JD.
// Not limited to a dictionary: it reads skill lists ("Languages: C#, Python"),
// requirement sentences ("Experience with Agentic AI, MCP, and RAG") and adds
// any known library term found anywhere in the text.

const { findLibraryTerms, allNames } = require('./domains');

const SECTION_PRIORITY = [
  { re: /^(mandatory|required|must[- ]have|minimum qualifications|requirements?)\b/i, priority: 'Critical' },
  { re: /^(technical skills?|skills|tech(nology)? stack|key skills|technologies)\b/i, priority: 'High' },
  { re: /^(preferred|nice[- ]to[- ]have|desired|bonus|plus)\b/i, priority: 'Medium' },
  { re: /^(job description|responsibilities|key responsibilities|duties|about|overview|summary)\b/i, priority: 'Medium' },
  { re: /^(contact|interested|apply|location|working hours|experience\s*:|benefits)\b/i, priority: null },
];

const LEAD_IN = /^(strong|solid|deep|proven|extensive|advanced|hands[- ]on|working|good|excellent|expert|expertise|knowledge|proficiency|proficient|familiarity|experience|experienced|background|understanding|ability)(\s+(experience|knowledge|expertise|proficiency|skills?))?\s+(in|with|of|using|on)\s+/i;
const GENERIC = new Set(['experience', 'skills', 'skill', 'development', 'developer', 'knowledge', 'solutions', 'solution', 'systems', 'applications', 'application',
  'design', 'develop', 'build', 'lead', 'apply', 'leverage', 'deliver', 'business', 'teams', 'team', 'years', 'year', 'remote', 'usa', 'domain', 'the', 'and', 'or',
  'enterprise', 'scalable', 'architecture', 'cloud', 'engineering', 'initiatives', 'technologies', 'tools', 'frameworks', 'framework', 'platforms', 'platform',
  'including', 'etc', 'other', 'related', 'modern', 'database', 'languages', 'language']);
const STRIP_TAIL = /\s+(skills?|experience|development|knowledge|expertise|proficiency|domain knowledge|domain experience|domain|technologies|solutions)$/i;

function cleanTerm(t) {
  let s = String(t).replace(/[•*▪●◦]/g, ' ').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(LEAD_IN, '').replace(/^(and|or|with|using|including|such as|e\.g\.,?)\s+/i, '').replace(/[.;:,]+$/, '').trim();
  for (let i = 0; i < 2; i++) s = s.replace(STRIP_TAIL, '').trim();
  s = s.replace(/^(advanced|strong|hands-on|solid|modern)\s+/i, '').trim();
  const using = s.match(/\s(?:using|with|on|via)\s+(.+)$/i);
  if (using) s = using[1].trim();
  return s;
}

const VAGUE = new Set(['ai', 'it', 'api', 'apis', 'ui', 'ux', 'sdlc', 'usa', 'us', 'mst', 'pst', 'est']);

function looksTechnical(t) {
  if (!t || t.length < 2 || t.length > 40) return false;
  if (VAGUE.has(t.toLowerCase())) return false;
  const words = t.split(/\s+/);
  if (words.length > 5) return false;
  if (words.every(w => GENERIC.has(w.toLowerCase()))) return false;
  // Proper nouns / acronyms / symbols are what make a term technical.
  return /[A-Z]{2,}|[#+./]|[a-z][A-Z]|^[A-Z][a-z]+/.test(t) || findLibraryTerms(t).length > 0;
}

function splitList(text) {
  return text.split(/,|;|\/(?=\s*[A-Z])|\s+and\s+|\s+&\s+|\s+or\s+/).map(cleanTerm).filter(Boolean);
}

/**
 * @returns [{ term, priority, source }]
 */
function extractExplicitTerms(jdText) {
  const out = new Map();
  const add = (term, priority, source) => {
    const t = cleanTerm(term);
    if (!looksTechnical(t)) return;
    const key = t.toLowerCase();
    const prev = out.get(key);
    const rank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    if (!prev || rank[priority] < rank[prev.priority]) out.set(key, { term: t, priority, source });
  };

  let sectionPriority = 'Medium';
  let skipSection = false;
  for (const raw of String(jdText).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const head = SECTION_PRIORITY.find(s => s.re.test(line.replace(/^[#*\s]+/, '')));
    const isHeading = head && line.length < 60 && !/,/.test(line);
    if (isHeading) { skipSection = head.priority === null; if (head.priority) sectionPriority = head.priority; continue; }
    if (skipSection) continue;
    const labelled = line.match(/^([^:]{2,50}):\s*(.+)$/);
    if (labelled && (/,/.test(labelled[2]) || sectionPriority !== 'Medium')) { splitList(labelled[2]).forEach(t => add(t, sectionPriority === 'Medium' ? 'High' : sectionPriority, 'skill list')); continue; }
    if ((line.match(/,/g) || []).length >= 1 || sectionPriority === 'Critical') {
      const body = line.replace(LEAD_IN, '').replace(/^(design|develop|build|implement|lead|apply|leverage|use|create)\s+(and\s+\w+\s+)?/i, '');
      splitList(body).forEach(t => add(t, sectionPriority, 'requirement sentence'));
    }
  }
  // Any known technology mentioned anywhere (catches prose mentions).
  for (const e of findLibraryTerms(jdText)) {
    const covered = [...out.values()].some(v => allNames(e).some(n => n.toLowerCase() === v.term.toLowerCase() || new RegExp(`(^|[^A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(v.term)));
    if (!covered) add(e.term, 'Medium', 'library');
  }
  return [...out.values()];
}

module.exports = { extractExplicitTerms, cleanTerm };
