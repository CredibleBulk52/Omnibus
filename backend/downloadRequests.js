'use strict';
// ─── Missing issues: get them, or ask the admin (one request service) ─────────
// Used wherever a missing issue is shown: reading lists (since 2026-10), and
// since 2026-10-28 Timeline events, Top Shelf runs and series pages
// (claude/REQUESTS_AND_REPORTS.md). Plus requests for whole series.
//   Admin, or any user when the Download Manager is open to everyone:
//     the series is monitored → mark the issue wanted (or show its status);
//     a library folder of the series has it missing → get it into that folder;
//     otherwise → open the Download Manager's Add Series search, prefilled.
//   Users when the Download Manager is admin-only: send a request. The admin
//     sees open requests on Requests in the account menu (/admin/requests).
// Request status: open → added (admin acted) | dismissed. A request whose
// issue is now in the library reports `owned` (not stored).
// Sources (`src`) and request kinds:
//   list   list_issue    list_id + list_issue_id (the original columns)
//   event  event_issue   source_id = event id, source_issue_id = event_issues.id
//   run    run_issue     source_id = run id,   source_issue_id = canon_run_issues.id
//   series series_issue  source_id = scanned series id, source_issue_id = Comic Vine issue id
//   —      series        a series not in the library: name, year, publisher, note
// Users see their own requests on My requests (/my-requests).
// rowFor(src, owner, issue) → the issue row { id, cv_issue_id, scanned_book_id,
// scanned_series_id, series_name, issue_number, volume_year } (server.js);
// planFor(row) → the download plan for users who may download (server.js).

const KIND = { list: 'list_issue', event: 'event_issue', run: 'run_issue', series: 'series_issue' };
const SOURCES = new Set(['event', 'run', 'series']);   // lists keep their own routes (list visibility rules)

module.exports = function createDownloadRequests({ app, db, requireAuth, requireAdmin, getSetting, logger, IN, rowFor = null, planFor = null }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS download_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL,
      list_id       INTEGER,
      list_issue_id INTEGER,
      series_name   TEXT,
      issue_number  TEXT,
      volume_year   INTEGER,
      cv_issue_id   TEXT,
      status        TEXT NOT NULL DEFAULT 'open',
      created_at    TEXT DEFAULT (datetime('now')),
      handled_at    TEXT,
      handled_by    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dlreq_status ON download_requests(status);
    CREATE INDEX IF NOT EXISTS idx_dlreq_issue  ON download_requests(list_issue_id, user_id);
  `);
  for (const col of ["kind TEXT DEFAULT 'list_issue'", 'source_id TEXT', 'source_issue_id TEXT', 'publisher TEXT', 'note TEXT']) {
    try { db.exec(`ALTER TABLE download_requests ADD COLUMN ${col}`); } catch {}
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dlreq_source ON download_requests(kind, source_issue_id, user_id)'); } catch {}

  const STATUSES = new Set(['open', 'added', 'dismissed']);
  const normNum = n => (n == null || n === '') ? null : IN.normIssueNumber(n);
  const canDownload = user => user?.role === 'admin' || getSetting('download_manager_admin_only') !== 'true';
  const isAnnual = name => /annual/i.test(name || '');
  const fail = (status, msg) => Object.assign(new Error(msg), { status });

  // The monitored issue for a row: by Comic Vine issue id (monitored issue ids
  // are CV ids), else by number in the monitored series behind the row's
  // library folder.
  function monitoredFor(row) {
    let mi = null;
    if (row.cv_issue_id) mi = db.prepare('SELECT id, series_id, status FROM monitored_issues WHERE id = ?').get(String(row.cv_issue_id)) || null;
    if (!mi && row.scanned_series_id) {
      const ss = db.prepare('SELECT monitored_series_id FROM scanned_series WHERE id = ?').get(String(row.scanned_series_id));
      const n = normNum(row.issue_number);
      if (ss?.monitored_series_id && n) {
        const annual = isAnnual(row.series_name);
        mi = db.prepare('SELECT id, series_id, status, issue_number, is_annual FROM monitored_issues WHERE series_id = ?')
          .all(String(ss.monitored_series_id))
          .find(i => normNum(i.issue_number) === n && !!i.is_annual === annual) || null;
      }
    }
    if (!mi) return null;
    const ms = db.prepare('SELECT name, year FROM monitored_series WHERE id = ?').get(String(mi.series_id));
    return { series_id: String(mi.series_id), series_name: ms?.name || null, series_year: ms?.year || null,
      issue_id: String(mi.id), status: mi.status };
  }

  // Is the requested issue in the library now?
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };
  const cvOwned = cvId => !!(cvId && (one('SELECT 1 FROM scanned_books WHERE cv_issue_id = ? LIMIT 1', String(cvId))
    || one('SELECT 1 FROM book_ci_index WHERE cv_issue_id = ? LIMIT 1', String(cvId))));
  function ownedNow(kind, sourceIssueId, cvId) {
    if (kind === 'list_issue') return !!one('SELECT scanned_book_id FROM list_issues WHERE id = ?', Number(sourceIssueId))?.scanned_book_id;
    if (kind === 'event_issue') return !!one('SELECT scanned_book_id FROM event_issues WHERE id = ?', Number(sourceIssueId))?.scanned_book_id;
    if (kind === 'run_issue') return !!one('SELECT scanned_book_id FROM canon_run_issues WHERE id = ?', Number(sourceIssueId))?.scanned_book_id;
    if (kind === 'series_issue') return cvOwned(cvId || sourceIssueId);
    return false;
  }
  const rowOwned = r => {
    const kind = r.kind || 'list_issue';
    return kind === 'series' ? false : ownedNow(kind, kind === 'list_issue' ? r.list_issue_id : r.source_issue_id, r.cv_issue_id);
  };

  // The user's latest request for one issue of a source.
  function latest(src, issueId, userId) {
    const kind = KIND[src];
    const r = src === 'list'
      ? db.prepare(`SELECT id, status, created_at, handled_at FROM download_requests WHERE list_issue_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`).get(Number(issueId), String(userId))
      : db.prepare(`SELECT id, status, created_at, handled_at FROM download_requests WHERE kind = ? AND source_issue_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`).get(kind, String(issueId), String(userId));
    return r ? { ...r, owned: ownedNow(kind, issueId, null) } : null;
  }

  // What the missing-issue box shows. plan (users who may download): owned |
  // monitored | fill | add, from server.js planFor.
  function infoFor(src, row, user, plan = null) {
    const dl = canDownload(user);
    return {
      mode: dl ? 'download' : 'request',
      monitored: dl ? monitoredFor(row) : null,
      plan: dl ? plan : null,
      search: row.series_name || '',
      request: dl ? null : latest(src, row.id, user?.sub),
    };
  }

  function requestFor(src, row, ownerId, user) {
    if (canDownload(user)) throw fail(400, 'Add this in the Download Manager instead');
    if (ownedNow(KIND[src], row.id, row.cv_issue_id)) throw fail(400, 'This issue is already in the library');
    const prev = latest(src, row.id, user.sub);
    if (prev && prev.status === 'open') return prev;
    const num = row.issue_number == null ? null : String(row.issue_number), cv = row.cv_issue_id ? String(row.cv_issue_id) : null;
    if (src === 'list') {
      db.prepare(`INSERT INTO download_requests (user_id, kind, list_id, list_issue_id, series_name, issue_number, volume_year, cv_issue_id)
        VALUES (?, 'list_issue', ?, ?, ?, ?, ?, ?)`).run(String(user.sub), Number(ownerId), Number(row.id), row.series_name || null, num, row.volume_year || null, cv);
    } else {
      db.prepare(`INSERT INTO download_requests (user_id, kind, source_id, source_issue_id, series_name, issue_number, volume_year, cv_issue_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(String(user.sub), KIND[src], String(ownerId), String(row.id), row.series_name || null, num, row.volume_year || null, cv);
    }
    logger.info('download-requests', `Requested ${row.series_name || '?'} #${row.issue_number ?? '?'}`, { user: user.sub, from: src, id: ownerId });
    return latest(src, row.id, user.sub);
  }

  // Status of the user's requests in one source: { issueId: status }.
  function mineFor(src, ownerId, userId) {
    const out = {};
    const rows = src === 'list'
      ? db.prepare(`SELECT list_issue_id AS i, status FROM download_requests WHERE list_id = ? AND user_id = ? ORDER BY id`).all(Number(ownerId), String(userId))
      : db.prepare(`SELECT source_issue_id AS i, status FROM download_requests WHERE kind = ? AND source_id = ? AND user_id = ? ORDER BY id`).all(KIND[src], String(ownerId), String(userId));
    for (const r of rows) out[r.i] = r.status;
    return out;
  }

  // With the download plan (Get into a library folder, Mark wanted, Add series) for users who may download.
  async function infoWithPlan(src, row, user) {
    const plan = canDownload(user) && planFor ? await planFor(row) : null;
    return infoFor(src, row, user, plan);
  }

  // Reading lists (readingLists.js routes, which apply the list's own visibility).
  const info = (row, user) => infoFor('list', row, user);
  const request = (row, list, user) => requestFor('list', row, list.id, user);
  const mineForList = (listId, userId) => mineFor('list', listId, userId);

  // A series that is not in the library.
  function requestSeries(body, user) {
    if (canDownload(user)) throw fail(400, 'You can add series in the Download Manager yourself');
    const name = String(body?.name || '').trim().slice(0, 200);
    if (!name) throw fail(400, 'Enter the series name');
    const year = parseInt(body?.year, 10);
    const yr = year >= 1900 && year <= 2100 ? year : null;
    const dup = db.prepare(`SELECT id, status FROM download_requests WHERE kind = 'series' AND user_id = ? AND lower(series_name) = lower(?) AND COALESCE(volume_year, 0) = ? AND status = 'open'`)
      .get(String(user.sub), name, yr || 0);
    if (dup) return dup;
    const id = db.prepare(`INSERT INTO download_requests (user_id, kind, series_name, volume_year, publisher, note) VALUES (?, 'series', ?, ?, ?, ?)`)
      .run(String(user.sub), name, yr, String(body?.publisher || '').trim().slice(0, 100) || null, String(body?.note || '').trim().slice(0, 1000) || null).lastInsertRowid;
    logger.info('download-requests', `Series requested: ${name}${yr ? ` (${yr})` : ''}`, { user: user.sub });
    return { id, status: 'open' };
  }

  // ── Routes for events, runs and series pages ──────────────────
  const send = (res, e) => res.status(e.status || 500).json({ error: e.message });
  async function loadRow(req) {
    if (!SOURCES.has(req.params.src) || !rowFor) throw fail(404, 'Not available');
    const row = await rowFor(req.params.src, req.params.owner, req.params.issue);
    if (!row) throw fail(404, 'Issue not found');
    return row;
  }
  app.get('/api/requests/:src/:owner/issues/:issue/acquire', requireAuth, async (req, res) => {
    try {
      res.json(await infoWithPlan(req.params.src, await loadRow(req), req.user));
    } catch (e) { send(res, e); }
  });
  app.post('/api/requests/:src/:owner/issues/:issue/request', requireAuth, async (req, res) => {
    try { res.json(requestFor(req.params.src, await loadRow(req), req.params.owner, req.user)); }
    catch (e) { send(res, e); }
  });
  app.get('/api/requests/:src/:owner/mine', requireAuth, (req, res) => {
    if (!SOURCES.has(req.params.src)) return res.status(404).json({ error: 'Not available' });
    res.json(mineFor(req.params.src, req.params.owner, req.user.sub));
  });
  app.post('/api/requests/series', requireAuth, (req, res) => {
    try { res.json(requestSeries(req.body, req.user)); }
    catch (e) { send(res, e); }
  });

  // Where a request came from, for the lists of requests.
  function sourceOf(r) {
    const kind = r.kind || 'list_issue';
    if (kind === 'list_issue') return { kind, link: r.list_id ? `/reading-lists/${r.list_id}` : null, label: r.list_name || 'reading list' };
    if (kind === 'event_issue') return { kind, link: `/events/${r.source_id}`, label: one('SELECT name FROM events WHERE id = ?', String(r.source_id))?.name || 'Timeline event' };
    if (kind === 'run_issue') return { kind, link: `/canon/run/${r.source_id}`, label: one('SELECT title FROM canon_runs WHERE id = ?', Number(r.source_id))?.title || 'Top Shelf run' };
    if (kind === 'series_issue') {
      const ss = one('SELECT name, year FROM scanned_series WHERE id = ?', String(r.source_id));
      return { kind, link: `/series/${r.source_id}`, label: ss ? `${ss.name}${ss.year ? ` (${ss.year})` : ''}` : 'series page' };
    }
    return { kind, link: null, label: 'series request' };
  }

  // Everything the user has asked for, newest first.
  app.get('/api/requests/mine', requireAuth, (req, res) => {
    const rows = db.prepare(`SELECT r.*, l.name AS list_name FROM download_requests r LEFT JOIN reading_lists l ON l.id = r.list_id
      WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 300`).all(String(req.user.sub));
    res.json({ requests: rows.map(r => ({
      id: r.id, kind: r.kind || 'list_issue', status: r.status, created_at: r.created_at, handled_at: r.handled_at,
      series_name: r.series_name, issue_number: r.issue_number, volume_year: r.volume_year, publisher: r.publisher || null, note: r.note || null,
      from: sourceOf(r), owned: rowOwned(r),
    })) });
  });

  const openCount = () => db.prepare(`SELECT COUNT(*) AS n FROM download_requests WHERE status = 'open'`).get().n;

  // ── Admin ─────────────────────────────────────────────────────
  app.get('/api/download-requests/count', requireAdmin, (req, res) => res.json({ open: openCount() }));

  app.get('/api/download-requests', requireAdmin, (req, res) => {
    const status = STATUSES.has(req.query.status) ? req.query.status : 'open';
    const rows = db.prepare(`SELECT r.*, u.username, l.name AS list_name, li.scanned_series_id AS li_scanned_series_id
      FROM download_requests r
      LEFT JOIN users u ON u.id = r.user_id
      LEFT JOIN reading_lists l ON l.id = r.list_id
      LEFT JOIN list_issues li ON li.id = r.list_issue_id
      WHERE r.status = ? ORDER BY r.id DESC LIMIT 300`).all(status);
    res.json({
      open: openCount(),
      requests: rows.map(r => {
        const kind = r.kind || 'list_issue';
        const scanned = kind === 'series_issue' ? r.source_id : r.li_scanned_series_id || null;
        return {
          id: r.id, kind, status: r.status, created_at: r.created_at, handled_at: r.handled_at,
          user: r.username || r.user_id, list_id: r.list_id, list_name: r.list_name || null, from: sourceOf(r),
          series_name: r.series_name, issue_number: r.issue_number, volume_year: r.volume_year,
          publisher: r.publisher || null, note: r.note || null,
          scanned_series_id: kind === 'series_issue' ? r.source_id : null, cv_issue_id: r.cv_issue_id || null,
          owned: rowOwned(r),
          monitored: kind === 'series' ? null : monitoredFor({ ...r, scanned_series_id: scanned }),
          search: [r.series_name, kind === 'series' && r.volume_year ? r.volume_year : null].filter(Boolean).join(' '),
        };
      }),
    });
  });

  app.post('/api/download-requests/:id', requireAdmin, (req, res) => {
    const status = req.body?.status;
    if (!STATUSES.has(status)) return res.status(400).json({ error: 'status must be open, added or dismissed' });
    const r = db.prepare(`UPDATE download_requests SET status = ?, handled_at = CASE WHEN ? = 'open' THEN NULL ELSE datetime('now') END,
      handled_by = CASE WHEN ? = 'open' THEN NULL ELSE ? END WHERE id = ?`).run(status, status, status, req.user?.sub || null, parseInt(req.params.id, 10));
    if (!r.changes) return res.status(404).json({ error: 'Request not found' });
    res.json({ ok: true, open: openCount() });
  });

  return { info, infoWithPlan, request, mineForList, mineFor, monitoredFor, openCount, canDownload, requestSeries };
};
