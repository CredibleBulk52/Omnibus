'use strict';
// ─── sharedMatcher.js ─────────────────────────────────────────────
// One matcher for issue rows (Timeline events, Top Shelf runs; reading lists
// later) → library books. Built from the reading-list matcher (readingLists.js
// matchOne, which stays as it is) with two additions found in the 2026-10-17
// assessment (claude/ADMIN_REORG.md):
//   1. A stored Comic Vine id is checked, not trusted blindly: when it points
//      to a book whose volume is more than a year from the row's volume year
//      and the library has the same series + number within a year of it, that
//      book wins (event rows created by the generator store ids from the wrong
//      volume, e.g. Avengers (2012) #14 → Avengers (1998) #14). With no such
//      book the id stands (legacy numbering: The Flash #790 is in the 2016 volume).
//   2. Among name matches, the folder with the right start year wins a tie
//      (Aquaman (2016) #50 over Aquaman (2011) #50, whose ComicInfo year is
//      its 2016 cover year).
// Pure lookup: no writes. Used by the editor's Re-match preview (editorTools.js).
//
// match(row, idx, { mode }) → { id, how, dist, strong, note?, cvConflict? } | null
//   row: { series_name, issue_number, volume_year, cv_issue_id, scanned_series_id?, entry_type? }
//   mode 'full'  (events): cv id → same folder → ComicInfo name+number+year ±1 → name+number+year ±4 (closest)
//   mode 'exact' (runs):   cv id → ComicInfo name+number+year ±1 only (as canonMatch.js); never guesses
//   how: 'cv' | 'series' | 'comicinfo' | 'name' | 'continued'; strong = trustworthy enough to apply by default.

module.exports = function createSharedMatcher({ db, IN, bookIndex }) {
  const normNum = n => (n == null || n === '') ? null : IN.normIssueNumber(String(n));
  const numKey  = n => { const c = normNum(n); const f = c == null ? NaN : parseFloat(c); return isNaN(f) ? Number.MAX_SAFE_INTEGER : f; };
  const toInt   = v => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
  const ciYearSql = `CASE WHEN instr(sb.comicinfo, '<Year>') > 0
                      THEN CAST(substr(sb.comicinfo, instr(sb.comicinfo, '<Year>') + 6, 4) AS INTEGER) END`;
  const NOISE = new Set(['the', 'and', 'of', 'a', 'an']);
  const sigWords = name => new Set(String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(w => w && !NOISE.has(w)));
  const sameWords = (a, b) => a.size > 0 && a.size === b.size && [...a].every(w => b.has(w));
  // Equal, or both plain numbers within 1 (parsing artefacts). Suffixes must be equal.
  function numbersAgree(bookNum, rowNum) {
    if (!bookNum || !rowNum) return true;
    const a = normNum(bookNum), b = normNum(rowNum);
    if (!a || !b || a === b) return true;
    if (a.includes('.') || b.includes('.')) return false;
    return Math.abs(parseFloat(a) - parseFloat(b)) <= 1;
  }

  function buildIndex() {
    const books = db.prepare(`SELECT sb.id, sb.series_id, sb.issue_number, sb.cv_issue_id, sb.monitored_issue_id, sb.filename, sb.title,
        ${ciYearSql} AS ci_year, ss.name AS sname, ss.year AS syear
      FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id`).all();
    const byId = new Map(), byCv = new Map(), byMon = new Map(), bySeriesNum = new Map(), byNum = new Map();
    for (const b of books) {
      byId.set(String(b.id), b);
      if (b.cv_issue_id && !byCv.has(String(b.cv_issue_id))) byCv.set(String(b.cv_issue_id), b);
      if (b.monitored_issue_id && !byMon.has(String(b.monitored_issue_id))) byMon.set(String(b.monitored_issue_id), b);
      const n = normNum(b.issue_number);
      if (!n) continue;
      const k = `${b.series_id}|${n}`;
      if (!bySeriesNum.has(k)) bySeriesNum.set(k, b);
      if (!byNum.has(n)) byNum.set(n, []);
      byNum.get(n).push(b);
    }
    const ciVol = new Map(), ciOrig = new Map();
    if (bookIndex) for (const r of db.prepare('SELECT book_id, volume_year, orig_number FROM book_ci_index').all()) {
      ciVol.set(String(r.book_id), r.volume_year); ciOrig.set(String(r.book_id), normNum(r.orig_number));
    }
    return { byId, byCv, byMon, bySeriesNum, byNum, words: new Map(), low: new Map(), ciVol, ciOrig, ci: bookIndex ? bookIndex.matcherMap() : new Map() };
  }

  // Lowest regular issue number in a folder (continued numbering check).
  function folderLow(idx, seriesId) {
    if (idx.low.has(seriesId)) return idx.low.get(seriesId);
    const r = db.prepare(`SELECT MIN(CAST(issue_number AS REAL)) AS lo FROM scanned_books
      WHERE series_id = ? AND is_special = 0 AND LOWER(filename) NOT LIKE '%annual%' AND CAST(issue_number AS REAL) > 0`).get(seriesId);
    const lo = r?.lo || 0; idx.low.set(seriesId, lo); return lo;
  }
  const wordsOf = (idx, b) => { let w = idx.words.get(b.series_id); if (!w) { w = sigWords(b.sname); idx.words.set(b.series_id, w); } return w; };
  const label = b => b ? `${b.sname}${b.syear ? ` (${b.syear})` : ''} #${b.issue_number}` : '';
  // How far a book's volume is from a year: folder start year or ComicInfo year, the closer.
  const yearDist = (idx, b, y) => {
    const ys = [toInt(b.syear), idx.ciVol.get(String(b.id)), b.ci_year].filter(Boolean);
    return y && ys.length ? Math.min(...ys.map(v => Math.abs(v - y))) : null;
  };

  // Name-based candidates, best first.
  function byName(row, idx, mode, maxDist) {
    const num = normNum(row.issue_number);
    if (!num || !row.series_name) return null;
    const rowYear = toInt(row.volume_year), rowWords = sigWords(row.series_name);
    const rowAnnual = /annual/i.test(row.series_name || '');
    const cands = [];
    if (bookIndex && idx.ci) {
      // A year in the name already pins the book ("The Flash 2021 Annual").
      const nameYear = /\b(19|20)\d{2}\b/.test(row.series_name);
      const suffixed = /\d[a-z]+$/i.test(String(row.issue_number || '').trim());
      if (!(mode === 'exact' && (!rowYear || suffixed))) {
        for (const c of idx.ci.get(`${bookIndex.nameKey(row.series_name)}|${num}`) || []) {
          if (mode === 'exact' ? !(c.year && Math.abs(c.year - rowYear) <= 1) : (rowYear && c.year && !nameYear && Math.abs(c.year - rowYear) > 1)) continue;
          const b = idx.byId.get(String(c.id)); if (!b) continue;
          const d = rowYear && c.year ? Math.abs(c.year - rowYear) : 2;
          const fd = rowYear && b.syear && sameWords(rowWords, wordsOf(idx, b)) ? Math.abs(toInt(b.syear) - rowYear) : 99;
          cands.push({ id: b.id, how: 'comicinfo', dist: d, fd, rank: 0, retag: c.retag });
        }
      }
    }
    if (mode !== 'exact') {
      let cont = null;
      for (const b of idx.byNum.get(num) || []) {
        if (!rowAnnual && (/annual/i.test(b.sname || '') || /annual/i.test(b.filename || ''))) continue;
        if (!sameWords(rowWords, wordsOf(idx, b))) continue;
        const ys = [toInt(b.syear), b.ci_year].filter(Boolean);
        const dist = rowYear && ys.length ? Math.min(...ys.map(y => Math.abs(y - rowYear))) : 5;
        if (rowYear && ys.length && dist > 4) {
          // Continued numbering in a later folder (Action Comics (1938) #601 in "Action Comics (1987)").
          const y = toInt(b.syear), lo = folderLow(idx, b.series_id);
          if (y && y > rowYear && lo > 1 && numKey(num) >= lo && (!cont || y < cont.y)) cont = { id: b.id, y };
          continue;
        }
        const fd = rowYear && b.syear ? Math.abs(toInt(b.syear) - rowYear) : 99;
        cands.push({ id: b.id, how: 'name', dist, fd, rank: 1, retag: 0 });
      }
      if (!cands.length && cont) return { id: cont.id, how: 'continued', dist: null, strong: false };
    }
    const ok = cands.filter(c => maxDist == null || c.dist <= maxDist);
    ok.sort((a, b) => a.dist - b.dist || a.fd - b.fd || a.rank - b.rank || a.retag - b.retag);
    const best = ok[0];
    if (!best) return null;
    return { id: best.id, how: best.how, dist: best.dist, strong: best.dist <= 1 };
  }

  function match(row, idx, { mode = 'full' } = {}) {
    const num = normNum(row.issue_number);
    const cv = row.cv_issue_id ? String(row.cv_issue_id) : null;
    const rowYear = toInt(row.volume_year);
    if (cv) {
      let b = idx.byCv.get(cv);
      const agrees = x => x && (numbersAgree(x.issue_number, row.issue_number) || (num && idx.ciOrig.get(String(x.id)) === num));
      if (!agrees(b)) b = idx.byMon.get(cv);
      if (!agrees(b)) b = null;
      if (!b && mode === 'full' && row.entry_type === 'issue') {
        const x = db.prepare(`SELECT id FROM scanned_books WHERE comicinfo LIKE ? OR comicinfo LIKE ? LIMIT 1`).get(`%4000-${cv}%`, `%[Issue ID ${cv}]%`);
        if (x && agrees(idx.byId.get(String(x.id)))) b = idx.byId.get(String(x.id));
      }
      if (b) {
        const d = yearDist(idx, b, rowYear);
        if (d != null && d > 1) {
          const alt = byName(row, idx, mode, 1);
          if (alt && String(alt.id) !== String(b.id)) {
            return { ...alt, strong: true, cvConflict: b.id, note: `the stored Comic Vine id points to ${label(b)}` };
          }
        }
        return { id: b.id, how: 'cv', dist: d, strong: true };
      }
    }
    if (!num) return null;
    if (mode === 'full' && row.scanned_series_id) {
      const b = idx.bySeriesNum.get(`${row.scanned_series_id}|${num}`);
      const rowAnnual = /annual/i.test(row.series_name || '');
      if (b && rowAnnual === /annual/i.test(b.sname || '')) return { id: b.id, how: 'series', dist: 0, strong: true };   // Annual #1 is not #1
    }
    return byName(row, idx, mode, null);
  }

  return { buildIndex, match, label, numbersAgree, yearDist, normNum };
};
