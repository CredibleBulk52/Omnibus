'use strict';
// ── Top Shelf (canon run) re-matching after library scans ───────────
// Run issues used to be matched to books only when the run was built, so a
// book bought afterwards stayed "missing" (and a run linked to a Timeline
// event lost its cover). This re-matches UNMATCHED run issues after scans,
// with exact signals only:
//   1. the issue's Comic Vine id = the book's Comic Vine id (the rule used
//      when a run is built), number check retag-aware: the folder number is
//      within 1, or the book was published under the run's number (ComicInfo);
//   2. ComicInfo index: published series name + original number + volume
//      year within 1 (needs a volume year; no year, no match).
// No name-only or filename guessing. Manual and existing matches are never
// changed; matches to books that no longer exist are cleared (not manual).

module.exports = function createCanonMatch({ db, logger, IN, bookIndex }) {
  const normNum = n => (n == null || n === '') ? null : IN.normIssueNumber(String(n));
  const numbersAgree = (folderNum, wanted) => {
    const a = normNum(folderNum), b = normNum(wanted);
    if (!a || !b || a === b) return true;
    if (a.includes('.') || b.includes('.')) return false;
    return Math.abs(parseFloat(a) - parseFloat(b)) <= 1;
  };
  const yieldLoop = () => new Promise(r => setImmediate(r));

  // Returns the book id to link, or null. Pure lookup; no writes.
  function matchRow(row, ci) {
    if (row.cv_issue_id) {
      const b = db.prepare('SELECT id, issue_number FROM scanned_books WHERE cv_issue_id = ? LIMIT 1').get(String(row.cv_issue_id));
      if (b && (numbersAgree(b.issue_number, row.issue_number) || (bookIndex && bookIndex.publishedAs(b.id, row.issue_number)))) return { id: b.id, how: 'cv' };
    }
    const y = parseInt(row.volume_year, 10);
    // "616a" (a variant or reprint listing) is not "616": only its own CV id may match it.
    const suffixed = /\d[a-z]+$/i.test(String(row.issue_number || '').trim());
    if (bookIndex && ci && row.series_name && y && !suffixed) {
      const n = normNum(row.issue_number);
      if (n) {
        // Annuals are their own ComicInfo series ("Batman Annual"), so the name
        // key already keeps Annual #1 apart from #1.
        const cands = (ci.get(`${bookIndex.nameKey(row.series_name)}|${n}`) || []).filter(c => c.year && Math.abs(c.year - y) <= 1)
          .sort((a, b) => Math.abs(a.year - y) - Math.abs(b.year - y) || a.retag - b.retag);
        if (cands[0]) return { id: cands[0].id, how: 'comicinfo' };
      }
    }
    return null;
  }

  const completeReconcile = require('./metadata/completionQueue').createCompletionQueue();
  function reconcile(scanChanged = true, options = {}) {
    return completeReconcile(() => runReconcile(scanChanged, options));
  }
  async function runReconcile(scanChanged = true, { dryRun = false, strict = false } = {}) {
    const out = { cleared: 0, checked: 0, matched: 0, byCv: 0, byComicInfo: 0, added: [] };
    try {
      if (scanChanged && !dryRun) {
        out.cleared = db.prepare(`UPDATE canon_run_issues SET scanned_book_id = NULL
          WHERE scanned_book_id IS NOT NULL AND (manually_matched IS NULL OR manually_matched = 0)
            AND CAST(scanned_book_id AS TEXT) NOT IN (SELECT id FROM scanned_books)
            AND CAST(scanned_book_id AS TEXT) NOT IN (SELECT id FROM missing_books)`).run().changes;
        await yieldLoop();
      }
      const rows = db.prepare(`SELECT cri.id, cri.run_id, cri.cv_issue_id, cri.series_name, cri.issue_number, cri.volume_year, cr.title AS run_title
        FROM canon_run_issues cri JOIN canon_runs cr ON cr.id = cri.run_id WHERE cri.scanned_book_id IS NULL`).all();
      out.checked = rows.length;
      if (!rows.length) return out;
      const ci = bookIndex ? bookIndex.matcherMap() : null;
      const upd = db.prepare('UPDATE canon_run_issues SET scanned_book_id = ? WHERE id = ? AND scanned_book_id IS NULL');
      // One book per run: never link a book that another issue of the same run already has.
      const inRun = new Map();
      for (const x of db.prepare('SELECT run_id, CAST(scanned_book_id AS TEXT) AS b FROM canon_run_issues WHERE scanned_book_id IS NOT NULL').all()) {
        if (!inRun.has(x.run_id)) inRun.set(x.run_id, new Set()); inRun.get(x.run_id).add(x.b);
      }
      const hits = [];
      for (const r of rows) {
        const m = matchRow(r, ci);
        if (!m) continue;
        const used = inRun.get(r.run_id) || new Set();
        if (used.has(String(m.id))) continue;
        used.add(String(m.id)); inRun.set(r.run_id, used);
        hits.push({ r, m });
      }
      if (!dryRun) db.transaction(() => { for (const { r, m } of hits) upd.run(m.id, r.id); })();
      out.matched = hits.length;
      out.byCv = hits.filter(h => h.m.how === 'cv').length;
      out.byComicInfo = hits.length - out.byCv;
      out.added = hits.map(({ r, m }) => ({ run: r.run_title, issue: `${r.series_name} (${r.volume_year || '?'}) #${r.issue_number}`, book_id: m.id, how: m.how }));
      if (hits.length && !dryRun) logger.info('canon', `Matched ${hits.length} of ${rows.length} unmatched Top Shelf issues`, { byCv: out.byCv, byComicInfo: out.byComicInfo });
      return out;
    } catch (e) {
      logger.error('canon', 'Top Shelf reconcile failed', { error: e.message });
      if (strict) throw e;
      return { ...out, error: e.message };
    }
  }

  return { reconcile, matchRow, numbersAgree };
};
