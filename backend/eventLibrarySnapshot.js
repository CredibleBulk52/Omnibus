'use strict';
// ─── One read of the library for Timeline matching (2026-11-24) ───────────────────────────────────
// Timeline matching (eventReconcile.js) searched every book three times for each unmatched event
// issue: its Comic Vine ID inside ComicInfo text (two LIKE '%…%' patterns), books with the same
// issue number, and books whose file name contains the padded number (LIKE '%001%'). None of these
// can use an index, so with ~150 issues that never match (ones not owned) and 51,000 books they took
// about 25 of the check's 28.5 s. This reads the books once per run and answers the same questions
// from memory, with the same rows, in the same order (table order, as the scans returned them) and
// the same comparisons:
//   - LIKE in SQLite ignores case for ASCII letters only, and % matches any text: both are kept.
//   - '%4000-<id>%' matches when some "4000-" in the text is followed by digits that start with
//     <id>; '%[Issue ID <id>]%' when some "[issue id " is followed by exactly <id> and "]".
//   - Anything these rules do not cover (an ID or number with other characters, or with % or _)
//     returns undefined, and the caller uses its SQL instead.
// ComicInfo text is not kept: only each book's <Year> and the ID keys.
const lowerAscii = s => s.replace(/[A-Z]+/g, m => m.toLowerCase());
const yearOf = ci => { if (!ci) return null; const m = ci.match(/<Year>(\d{4})<\/Year>/i); return m ? parseInt(m[1]) : null; };

function createLibrarySnapshot(db) {
  const all = [];            // every book, table order: { id, issue_number }
  const withSeries = [];     // books with a series row (the JOIN), table order
  const byNumber = new Map();
  const webIds = new Map();  // digits after "4000-", and every prefix of them → first book (index into all)
  const notesIds = new Map(); // text between "[issue id " and "]" → first book
  const first = (map, key, i) => { if (!map.has(key)) map.set(key, i); };
  const rows = db.prepare(`SELECT sb.id, sb.issue_number, sb.filename, sb.comicinfo, ss.id AS sid, ss.name AS sname, ss.year AS syear
    FROM scanned_books sb LEFT JOIN scanned_series ss ON ss.id = sb.series_id ORDER BY sb.rowid`).iterate();
  for (const r of rows) {
    const i = all.push({ id: r.id, issue_number: r.issue_number }) - 1;
    if (typeof r.comicinfo === 'string') {
      const lc = lowerAscii(r.comicinfo);
      for (let at = lc.indexOf('4000-'); at >= 0; at = lc.indexOf('4000-', at + 1)) {
        const digits = /^\d*/.exec(lc.slice(at + 5, at + 45))[0];
        for (let k = 0; k <= digits.length; k++) first(webIds, digits.slice(0, k), i);
      }
      for (let at = lc.indexOf('[issue id '); at >= 0; at = lc.indexOf('[issue id ', at + 1)) {
        const end = lc.indexOf(']', at + 10);
        if (end >= 0) first(notesIds, lc.slice(at + 10, end), i);
      }
    }
    if (r.sid == null) continue;
    const row = { id: r.id, issue_number: r.issue_number, filename: r.filename, sname: r.sname, syear: r.syear, ciYear: yearOf(r.comicinfo),
      fnLower: typeof r.filename === 'string' ? lowerAscii(r.filename) : null };
    withSeries.push(row);
    if (typeof r.issue_number === 'string') { if (!byNumber.has(r.issue_number)) byNumber.set(r.issue_number, []); byNumber.get(r.issue_number).push(row); }
  }
  return {
    // = SELECT id, issue_number FROM scanned_books WHERE comicinfo LIKE '%4000-<id>%' OR comicinfo LIKE '%[Issue ID <id>]%' LIMIT 1
    cvInComicInfo(cvIssueId) {
      const id = String(cvIssueId);
      if (!/^\d+$/.test(id)) return undefined;
      const a = webIds.get(id), b = notesIds.get(id);
      const i = a === undefined ? b : b === undefined ? a : Math.min(a, b);
      return i === undefined ? undefined : { ...all[i] };
    },
    // = SELECT … FROM scanned_books sb JOIN scanned_series ss … WHERE sb.issue_number = ?
    sameNumber(issueNumber) {
      if (typeof issueNumber !== 'string') return issueNumber == null ? [] : undefined;
      return byNumber.get(issueNumber) || [];
    },
    // = SELECT … FROM scanned_books sb JOIN scanned_series ss … WHERE sb.filename LIKE '%<text>%'
    fileNameContains(text) {
      const s = String(text);
      if (/[%_]/.test(s)) return undefined;
      const needle = lowerAscii(s);
      return withSeries.filter(b => b.fnLower !== null && b.fnLower.includes(needle));
    },
    size: all.length,
  };
}

module.exports = { createLibrarySnapshot, lowerAscii, yearOf };
