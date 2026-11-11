'use strict';
// ─── Problem reports (2026-10-28, claude/REQUESTS_AND_REPORTS.md) ──────────────
// Any signed-in user can report a problem; the admin works through them in the
// Problem reports page in the account menu (/admin/reports) and the reporter sees the status on My requests.
//   kind:   file (bad scan, missing or out-of-order pages, won't open)
//           metadata (wrong title, number, cover or series)
//           order (wrong order or wrong issue on an event, run or list)
//           other (anything, free text)
//   target: what it is about: book | series | event | run | list | page, with an id
//           and a label saved at the time (so the report still reads if the thing goes).
//   status: open → resolved | dismissed (the admin may add a reply).
const KINDS = new Set(['file', 'metadata', 'order', 'other']);
const TARGETS = new Set(['book', 'series', 'event', 'run', 'list', 'page']);
const STATUSES = new Set(['open', 'resolved', 'dismissed']);
const DAILY_LIMIT = 30;
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

module.exports = function createProblemReports({ app, db, requireAuth, requireAdmin, logger }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS problem_reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL,
      kind         TEXT NOT NULL,
      target_type  TEXT NOT NULL,
      target_id    TEXT,
      target_label TEXT,
      page_url     TEXT,
      note         TEXT,
      status       TEXT NOT NULL DEFAULT 'open',
      admin_note   TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      handled_at   TEXT,
      handled_by   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status ON problem_reports(status);
    CREATE INDEX IF NOT EXISTS idx_reports_user   ON problem_reports(user_id);
  `);

  const openCount = () => db.prepare(`SELECT COUNT(*) AS n FROM problem_reports WHERE status = 'open'`).get().n;
  const view = r => ({
    id: r.id, kind: r.kind, target_type: r.target_type, target_id: r.target_id, target_label: r.target_label,
    page_url: r.page_url, note: r.note, status: r.status, admin_note: r.admin_note,
    created_at: r.created_at, handled_at: r.handled_at, user: r.username || undefined,
  });

  function create(body, user) {
    const kind = String(body?.kind || '');
    const target = String(body?.target_type || 'page');
    if (!KINDS.has(kind)) throw Object.assign(new Error('Pick what kind of problem it is'), { status: 400 });
    if (!TARGETS.has(target)) throw Object.assign(new Error('Unknown report target'), { status: 400 });
    const note = clip(body?.note, 2000);
    if (kind === 'other' && !note) throw Object.assign(new Error('Describe the problem'), { status: 400 });
    const today = db.prepare(`SELECT COUNT(*) AS n FROM problem_reports WHERE user_id = ? AND created_at >= datetime('now', '-1 day')`).get(String(user.sub)).n;
    if (today >= DAILY_LIMIT) throw Object.assign(new Error('Too many reports today; try again tomorrow'), { status: 429 });
    let pageUrl = clip(body?.page_url, 500);
    if (pageUrl && !pageUrl.startsWith('/')) pageUrl = null;   // app paths only
    const id = db.prepare(`INSERT INTO problem_reports (user_id, kind, target_type, target_id, target_label, page_url, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(String(user.sub), kind, target, clip(body?.target_id, 100), clip(body?.target_label, 300), pageUrl, note).lastInsertRowid;
    logger.info('reports', `Problem reported: ${kind} on ${target} ${body?.target_label || body?.target_id || ''}`.trim(), { user: user.sub, id });
    return view(db.prepare('SELECT * FROM problem_reports WHERE id = ?').get(id));
  }

  app.post('/api/reports', requireAuth, (req, res) => {
    try { res.json(create(req.body, req.user)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.get('/api/reports/mine', requireAuth, (req, res) => {
    res.json({ reports: db.prepare(`SELECT * FROM problem_reports WHERE user_id = ? ORDER BY id DESC LIMIT 200`).all(String(req.user.sub)).map(view) });
  });

  // ── Admin ──
  app.get('/api/reports/count', requireAdmin, (req, res) => res.json({ open: openCount() }));
  app.get('/api/reports', requireAdmin, (req, res) => {
    const status = STATUSES.has(req.query.status) ? req.query.status : 'open';
    const rows = db.prepare(`SELECT r.*, u.username FROM problem_reports r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.status = ? ORDER BY r.id DESC LIMIT 300`).all(status);
    res.json({ open: openCount(), reports: rows.map(view) });
  });
  app.post('/api/reports/:id', requireAdmin, (req, res) => {
    const status = req.body?.status;
    if (!STATUSES.has(status)) return res.status(400).json({ error: 'status must be open, resolved or dismissed' });
    const r = db.prepare(`UPDATE problem_reports SET status = ?, admin_note = COALESCE(?, admin_note),
      handled_at = CASE WHEN ? = 'open' THEN NULL ELSE datetime('now') END,
      handled_by = CASE WHEN ? = 'open' THEN NULL ELSE ? END WHERE id = ?`)
      .run(status, clip(req.body?.admin_note, 1000), status, status, req.user?.sub || null, parseInt(req.params.id, 10));
    if (!r.changes) return res.status(404).json({ error: 'Report not found' });
    res.json({ ok: true, open: openCount() });
  });

  return { create, openCount };
};
