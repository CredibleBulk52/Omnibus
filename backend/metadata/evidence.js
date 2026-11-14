'use strict';

const { Parser } = require('xml2js');
const { MARVEL_TIE_IN_SUFFIXES } = require('../issueNumber');
const MAX_XML_BYTES = 2 * 1024 * 1024;
const CV_HOSTS = new Set(['comicvine.gamespot.com', 'www.comicvine.gamespot.com', 'comicvine.com', 'www.comicvine.com']);

// IDs remain strings: neither numeric precision loss nor arbitrary URL suffixes are acceptable.
function parseCvIssueId(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  let digits = /^\d+$/.test(raw) ? raw : null;
  if (!digits) {
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || !CV_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
      const match = url.pathname.match(/(?:^|\/)4000-(\d+)\/?$/);
      digits = match && match[1];
    } catch { return null; }
  }
  if (!digits || !/[1-9]/.test(digits)) return null;
  return digits.replace(/^0+/, '');
}

function parseIssueNumberEvidence(value) {
  const raw = value == null ? null : String(value);
  const result = { raw, normalized: null, suffix: null, requiresReview: false };
  if (!raw || !raw.trim()) return result;
  let text = raw.trim().replace(/^#\s*/, '');
  // Padded negatives: "0-1"/"000-1" is how many files spell issue -1.
  const paddedNegative = /^0+-(\d+)$/.exec(text);
  if (paddedNegative) text = '-' + paddedNegative[1];
  // Half issues (Wizard 1/2) are often filed as 0.5.
  if (text === '½' || text === '1/2' || /^0*\.50*$|^0+\.50*$/.test(text)) return { ...result, normalized: '1/2' };
  const match = text.match(/^(-?)(\d+)(\.\d+)?(?:\.?([a-z]+))?$/i);
  if (!match) return { ...result, requiresReview: true };
  const suffix = (match[4] || '').toUpperCase();
  // Preserve unknown/lettered suffixes as evidence instead of treating an insert as its parent issue.
  if (suffix && !MARVEL_TIE_IN_SUFFIXES.has(suffix)) return { ...result, suffix, requiresReview: true };
  const integer = match[2].replace(/^0+(?=\d)/, '');
  const fraction = match[3] && !/^\.0+$/.test(match[3]) ? match[3] : '';
  const sign = match[1] && (integer !== '0' || fraction) ? '-' : '';
  return { ...result, suffix: suffix || null, normalized: `${sign}${integer}${fraction}${suffix ? '.' + suffix : ''}` };
}

function parseComicInfoEvidence(xml) {
  const rawXml = typeof xml === 'string' ? xml : null;
  const result = { rawXml, status: 'absent', fields: Object.create(null), diagnostics: [], identity: { status: 'none', cvIssueId: null, ids: [], evidence: [] } };
  const invalid = reason => ({ ...result, status: 'invalid', diagnostics: [reason], identity: { ...result.identity, status: 'invalid' } });
  if (xml != null && typeof xml !== 'string') return invalid('xml_not_text');
  if (!rawXml || !rawXml.trim()) return result;
  if (Buffer.byteLength(rawXml, 'utf8') > MAX_XML_BYTES) return invalid('xml_too_large');
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(rawXml)) return invalid('xml_declarations_not_supported');
  // Wrap the document so the parser must consume it all before emitting a result.
  // Reserve this name to prevent an input from closing our wrapper early.
  const wrapper = 'OmnibusEvidenceDocument';
  if (/<\/?OmnibusEvidenceDocument\b/i.test(rawXml)) return invalid('reserved_xml_element');
  const body = rawXml.replace(/^\uFEFF/, '').replace(/^<\?xml\s[\s\S]*?\?>/, '');
  if (/<\?xml(?:\s|\?>)/i.test(body)) return invalid('misplaced_xml_declaration');
  let documents = [], errors = [];
  try {
    const parser = new Parser({ strict: true, explicitArray: true, explicitRoot: true, async: false, trim: false });
    // Keep listeners through the entire synchronous parse; callback-based parsing can finish at the first root.
    parser.on('end', doc => documents.push(doc));
    parser.on('error', error => errors.push(error));
    parser.parseString(`<${wrapper}>${body}</${wrapper}>`);
  } catch (error) { errors.push(error); }
  if (errors.length || documents.length !== 1) return invalid('malformed_xml');
  const document = documents[0]?.[wrapper];
  if (!document || typeof document !== 'object' || (document._ && document._.trim())) return invalid('malformed_xml');
  const rootNames = Object.keys(document).filter(key => key !== '_');
  if (rootNames.length !== 1 || rootNames[0].toLowerCase() !== 'comicinfo' || document[rootNames[0]].length !== 1) return invalid('unsupported_xml_root');
  const root = document[rootNames[0]][0];
  result.status = 'valid';
  if (typeof root === 'string') {
    if (root.trim()) return invalid('unexpected_root_text');
    return result;
  }
  if (root._ && root._.trim()) return invalid('unexpected_root_text');
  for (const [name, entries] of Object.entries(root)) {
    if (name === '$' || name === '_') continue;
    const key = name.toLowerCase();
    for (const entry of entries) {
      // Only direct scalar fields supply evidence; nested custom metadata never impersonates Web/Notes.
      const scalar = typeof entry === 'string' ? entry : entry && Object.keys(entry).every(k => k === '_' || k === '$') ? entry._ || '' : null;
      if (scalar === null) {
        if (['web', 'notes'].includes(key)) result.diagnostics.push('structured_identity_field');
        continue;
      }
      (result.fields[key] ||= []).push(scalar);
    }
  }
  const add = (id, source, raw) => {
    if (id) result.identity.evidence.push({ cvIssueId: id, source, raw });
  };
  for (const web of result.fields.web || []) {
    for (const token of web.match(/https?:\/\/[^\s<>"']+/gi) || []) add(parseCvIssueId(token), 'comicinfo.web', token);
  }
  for (const notes of result.fields.notes || []) eachNotesId(notes, (m, prefix, id) => { add(parseCvIssueId(id), 'comicinfo.notes', m); });
  result.identity.ids = [...new Set(result.identity.evidence.map(e => e.cvIssueId))];
  const ids = result.identity.ids;
  result.identity.status = result.diagnostics.includes('structured_identity_field') ? 'invalid' : ids.length > 1 ? 'conflict' : ids.length ? 'supported' : 'none';
  // Supported means consistent embedded evidence, not a verified Comic Vine publication or an accepted match.
  if (result.identity.status === 'supported') result.identity.cvIssueId = ids[0];
  return result;
}

// Comic Vine issue ids in Notes (2026-11-14, The Expanse (2020) #2 held as UNSUPPORTED_XML). Notes
// often hold several taggers' lines, and only Comic Vine's count:
//   ComicTagger  "… using info from Comic Vine … [CVDB825420]" or "[Issue ID 825420]"
//                "… using info from Grand Comics Database … [Issue ID 2186813]"   another database: ignored
//   comicbox     "[Issue ID 4000-825420] urn:comicvine:4000-825420"               the 4000- prefix is Comic Vine's
// "Issue ID 4000-825420" used to read as issue 4000, and the GCD id as a second Comic Vine id, so the
// file looked like it named two issues. fn(match, prefix, id) may return a replacement (corrections).
const NOTES_ID = /\b(CVDB\s*|Issue\s+ID\s+(?:4000-)?|urn:comicvine:4000-)(\d+)\b/gi;
const OTHER_DATABASE = /\b(?:grand\s+comics\s+database|gcd|metron|league\s+of\s+comic\s+geeks|locg|marvel\.com)\b/i;
const otherDatabaseLine = line => !/comic\s*vine/i.test(line) && (/using info from\s+\S/i.test(line) || OTHER_DATABASE.test(line));
function eachNotesId(text, fn) {
  return String(text || '').split(/(\r?\n)/).map(part => (/^\r?\n$/.test(part) ? part : part.replace(NOTES_ID, (m, prefix, id) => {
    if (otherDatabaseLine(part) && !/^(?:CVDB|urn:comicvine)/i.test(prefix)) return m;
    const next = fn(m, prefix, id);
    return next == null ? m : next;
  }))).join('');
}
const notesIds = text => { const ids = []; eachNotesId(text, (m, prefix, id) => { ids.push(id); }); return ids; };

// Limited-series counts are not issue numbers: "01 (of 04)", "01 [of 04]", "01 of 04".
function stripIssueCount(text) {
  return String(text || '').replace(/\s*[([]\s*of\s+\d{1,3}\s*[)\]]/gi, '').replace(/(\d)\s+of\s+\d{1,3}(?=$|[\s()[\]_.-])/gi, '$1');
}

function filenameEvidence(filename) {
  const raw = typeof filename === 'string' ? filename : '';
  // Page counts in scan names ("ctc 68p", "52pp", "100pgs") are not issue numbers: "68p" was read as a
  // lettered variant of #68 and blocked Golden Age pack files (2026-10-25, Adventure Comics 081 ctc 68p).
  const base = stripIssueCount(raw.split(/[\\/]/).pop().replace(/\.(cbz|cbr|zip|rar|pdf)$/i, ''))
    .replace(/(^|\s)[1-9]\d{1,2}(?:p|pp|pg|pgs)(?=$|[\s()[\]_-])/gi, '$1');
  const candidates = [];
  const add = (match, source) => {
    const issue = parseIssueNumberEvidence(match[1]);
    if (!candidates.some(c => c.raw === issue.raw)) candidates.push({ ...issue, source });
  };
  for (const match of base.matchAll(/#\s*(0+-\d+|-?\d+(?:\.\d+)?(?:\.?[a-z]+)?|½)(?=$|[\s()[\]_-])/gi)) add(match, 'filename.hash');
  for (const match of base.matchAll(/(?:^|\s)(0+-\d+|-?\d+(?:\.\d+)?(?:\.?[a-z]+)?)\s*\((?:19|20)\d{2}\)/gi)) add(match, 'filename.before_year');
  for (const match of base.matchAll(/(?:^|\s)(0\d+(?:\.\d+)?(?:\.?[a-z]+)?)(?=$|[\s()[\]_]|-(?!\d))/gi)) add(match, 'filename.padded');
  for (const match of base.matchAll(/\bAnnual\s+#?(\d+(?:\.\d+)?(?:\.?[a-z]+)?)(?=$|[\s()[\]_-])/gi)) add(match, 'filename.annual');
  return { raw, annualHint: /\bannual\b/i.test(base), candidates, requiresReview: candidates.some(c => c.requiresReview) || new Set(candidates.map(c => c.normalized || c.raw)).size > 1 };
}

function collectMetadataEvidence({ bookId, arrival, filename, comicInfoXml, folderMetadata, downloadIssueId, explicitIssueId, indexedIssueId } = {}) {
  if (typeof bookId !== 'string' || !bookId.trim()) throw new TypeError('A stable book ID is required');
  if (!['download', 'import', 'scanner'].includes(arrival)) throw new TypeError('Unknown arrival method');
  const identities = [], diagnostics = [];
  for (const [source, value] of [['download', downloadIssueId], ['explicit', explicitIssueId], ['library_index', indexedIssueId]]) {
    if (value == null) continue;
    const id = parseCvIssueId(value);
    if (id) identities.push({ source, cvIssueId: id });
    else diagnostics.push(`invalid_${source}_identity`);
  }
  const embedded = parseComicInfoEvidence(comicInfoXml);
  // Folder data remains a detached hint. It never becomes an issue identity here.
  const folderHint = folderMetadata == null ? null : structuredClone(folderMetadata);
  return { bookId, arrival, filename: filenameEvidence(filename), embedded, identities, folderHint, diagnostics };
}

module.exports = { MAX_XML_BYTES, eachNotesId, notesIds, parseCvIssueId, parseIssueNumberEvidence, parseComicInfoEvidence, filenameEvidence, collectMetadataEvidence, stripIssueCount };
