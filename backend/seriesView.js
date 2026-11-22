'use strict';
// ─── Series view (2026-11-22) ────────────────────────────────────────
// Each reader's choice for series pages, remembered across all series:
//   issues   "Issues only": the series' regular issues (the default until a reader chooses)
//   reading  "Reading order": annuals, specials and linked books placed after the issue they follow
//            (seriesPlacement.js)
// The series page's Issues shelf and Continue button, the reader's next issue (series reading) and
// Home's next issue all follow it. Annuals and specials keep their own tabs either way.
const VIEWS = ['issues', 'reading'];
const DEFAULT_VIEW = 'issues';
const NEEDS = ['app', 'db', 'requireAuth'];

function createSeriesView(deps = {}) {
  const missing = NEEDS.filter(n => !deps[n]);
  if (missing.length) throw new Error(`createSeriesView: missing ${missing.join(', ')}`);
  const { app, db, requireAuth } = deps;
  db.exec(`CREATE TABLE IF NOT EXISTS user_series_view (
    user_id TEXT PRIMARY KEY, view TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`);
  const get = db.prepare('SELECT view FROM user_series_view WHERE user_id = ?');
  const viewOf = userId => {
    const v = userId ? get.get(String(userId))?.view : null;
    return VIEWS.includes(v) ? v : DEFAULT_VIEW;
  };
  app.get('/api/users/me/series-view', requireAuth, (req, res) => res.json({ view: viewOf(req.user?.sub), views: VIEWS }));
  app.put('/api/users/me/series-view', requireAuth, (req, res) => {
    const v = String(req.body?.view || '');
    if (!VIEWS.includes(v)) return res.status(400).json({ error: `view must be ${VIEWS.join(' or ')}` });
    db.prepare(`INSERT INTO user_series_view (user_id, view, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET view = excluded.view, updated_at = excluded.updated_at`).run(String(req.user.sub), v);
    res.json({ view: v });
  });
  return { viewOf };
}

// A series' order for one view: placement order entries [{ id, placed }] → ids.
// Issues only keeps the regular issues; a book that is not one of them (an annual opened from its
// tab) still reads in the full order, so its next issue is the one it was placed before.
function sequenceFor(order, view, bookId = null) {
  if (!order) return null;
  const all = order.map(x => x.id);
  if (view !== 'issues') return all;
  const regular = order.filter(x => !x.placed).map(x => x.id);
  return bookId && !regular.includes(bookId) ? all : regular;
}

module.exports = { createSeriesView, sequenceFor, VIEWS, DEFAULT_VIEW };
