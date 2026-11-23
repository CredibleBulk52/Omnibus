'use strict';

// A manual ownership link for a catalog gap. The selected file keeps its tags and shelf.
module.exports = function registerGapMatches({ app, db, requireAdmin }, kind, missingRows) {
  db.exec(`CREATE TABLE IF NOT EXISTS series_gap_matches (
    cv_issue_id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES scanned_books(id) ON DELETE CASCADE)`);
  app.post(`/api/series/:id/${kind}/:issueId/match`, requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.issueId);
      const rows = await missingRows(req.params.id);
      if (!rows.some(r => String(r.id) === id)) return res.status(409).json({ error: 'This issue is no longer missing. Refresh the shelf.' });
      const bookId = req.body?.bookId;
      if (typeof bookId !== 'string' || !db.prepare('SELECT 1 FROM scanned_books WHERE id=?').get(bookId)) {
        return res.status(400).json({ error: 'Choose an issue from the library.' });
      }
      const saved = db.prepare('INSERT INTO series_gap_matches (cv_issue_id,book_id) VALUES (?,?) ON CONFLICT(cv_issue_id) DO NOTHING').run(id, bookId);
      if (!saved.changes) return res.status(409).json({ error: 'This issue already has a match. Refresh the shelf.' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
