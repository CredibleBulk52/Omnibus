'use strict';
// ─── Missing issues (moved out of server.js 2026-11-19, server.js split step 7A) ───
// Fill missing issues of an ended series (preview and fill), missing issues on series pages (gaps and
// "get"), the shared editor's "get a missing issue", removing filled series from the Download Manager,
// and resetting an issue to wanted. Moved unchanged.
const path = require('path');
const IN = require('./issueNumber');

const NEEDS = ['activeDownloads', 'app', 'bookIndex', 'cvApiGet', 'db', 'deriveStatusFromSeriesJson', 'detectSeriesType', 'downloadRequests', 'fetchAndSetSeriesStatus', 'getCVKey', 'logger', 'readSeriesJson', 'removeMonitoredSeriesRows', 'requireAdmin', 'requireAuth', 'requireDownloadAccess', 'runRefreshDirectory', 'scanSeriesComicInfo', 'startAutoGrab'];
module.exports.NEEDS = NEEDS;

module.exports.createMissingIssues = function createMissingIssues(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createMissingIssues: missing ${missing.join(', ')}`);
  const { activeDownloads, app, bookIndex, cvApiGet, db, deriveStatusFromSeriesJson, detectSeriesType, downloadRequests, fetchAndSetSeriesStatus, getCVKey, logger, readSeriesJson, removeMonitoredSeriesRows, requireAdmin, requireAuth, requireDownloadAccess, runRefreshDirectory, scanSeriesComicInfo, startAutoGrab } = deps;
  // ─── Fill missing issues (admin) ──────────────────────────────────
  // For an old, ended library series: show the Comic Vine volume's issues
  // against what the whole library owns (by Comic Vine id, so era-split folders
  // and books filed elsewhere count), let the admin pick missing issues, then
  // monitor the EXISTING folder (no new folder) with the picks wanted and
  // everything else skipped, and auto-grab. Downloads then take the normal path:
  // grab → completion watcher → post-processing into that folder.
  // fill_auto_remove = 1 entries are removed from the download manager once no
  // pick is still wanted or in flight (ended series only; files untouched).
  const fillVolumeCache = new Map();   // volume id → { at, issues }
  // Slim copies of volume issue lists kept for the series pages' missing issues
  // (2026-10-28): every series page can show its gaps, so a volume is asked of
  // Comic Vine at most every few days instead of on every visit.
  db.exec(`CREATE TABLE IF NOT EXISTS cv_volume_issues_cache (vol_id TEXT PRIMARY KEY, at INTEGER NOT NULL, issues TEXT NOT NULL)`);
  const slimIssue = i => ({ id: i.id, issue_number: i.issue_number, name: i.name || null, cover_date: i.cover_date || null, store_date: i.store_date || null,
    image: i.image ? { thumb_url: i.image.thumb_url || null, small_url: i.image.small_url || null } : null });
  // once: the stored copy is used for good when the series has ended (series.json
  // says so, or its newest issue is over a year old); otherwise it is refreshed
  // after a week. Most series are fetched from Comic Vine once only.
  const VOLUME_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
  async function fetchVolumeIssues(volId, { maxAgeMs = 30 * 60 * 1000, slimOk = false, once = false, ended = false } = {}) {
    const hit = fillVolumeCache.get(volId);
    if (hit && Date.now() - hit.at < (once ? VOLUME_REFRESH_MS : maxAgeMs)) return hit.issues;
    if (slimOk) {
      const row = db.prepare('SELECT at, issues FROM cv_volume_issues_cache WHERE vol_id = ?').get(String(volId));
      if (row) {
        let issues = null; try { issues = JSON.parse(row.issues); } catch {}
        if (issues) {
          const newest = issues.reduce((m, i) => { const d = i.store_date || i.cover_date || ''; return d > m ? d : m; }, '');
          const stale = newest && Date.parse(newest) < Date.now() - 365 * 24 * 60 * 60 * 1000;
          const fresh = once ? (ended || stale || Date.now() - row.at < VOLUME_REFRESH_MS) : Date.now() - row.at < maxAgeMs;
          if (fresh) return issues;
        }
      }
    }
    let offset = 0, all = [];
    while (true) {
      const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
        params: {
          api_key: getCVKey(), format: 'json', filter: `volume:${volId}`,
          field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits,image',
          offset, limit: 100,
        },
        headers: { 'User-Agent': 'Omnibus/1.0' },
      });
      const results = r.data.results || [];
      all = all.concat(results);
      if (!results.length || all.length >= r.data.number_of_total_results) break;
      offset += 100;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    fillVolumeCache.set(volId, { at: Date.now(), issues: all });
    try { db.prepare('INSERT OR REPLACE INTO cv_volume_issues_cache (vol_id, at, issues) VALUES (?, ?, ?)').run(String(volId), Date.now(), JSON.stringify(all.map(slimIssue))); } catch {}
    return all;
  }

  async function fillContext(scannedId, volumeOpts = {}) {
    const scanned = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(String(scannedId));
    if (!scanned) return { status: 404, error: 'Series not found' };
    const sj = readSeriesJson(scanned.path);
    const m = sj?.metadata || sj || {};
    const volId = m.comicid ? String(m.comicid) : null;
    if (!volId) return { status: 400, error: 'No Comic Vine ID in series.json. Create metadata first (Enrich tab).' };
    const monitored = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(volId) || null;
    let issues;
    if (monitored) {
      issues = db.prepare('SELECT id, issue_number, title, release_date, store_date, status, file_path, cv_data, is_annual FROM monitored_issues WHERE series_id = ?').all(volId)
        .map(i => { let cv = null; try { cv = JSON.parse(i.cv_data || 'null'); } catch {} return { id: String(i.id), number: i.issue_number, title: i.title, cover_date: i.release_date, store_date: i.store_date, monStatus: i.status, file_path: i.file_path, is_annual: i.is_annual, cv }; });
    } else {
      const opts = volumeOpts.cachedOnce ? { slimOk: true, once: true, ended: deriveStatusFromSeriesJson(scanned.path) === 'ended' } : volumeOpts;
      issues = (await fetchVolumeIssues(volId, opts)).map(i => ({ id: String(i.id), number: IN.normIssueNumber(i.issue_number) || '0', title: i.name || null, cover_date: i.cover_date || null, store_date: i.store_date || null, monStatus: null, cv: i }));
    }
    const ids = JSON.stringify(issues.map(i => i.id));
    // Owned anywhere in the library, by Comic Vine id (folder tag or ComicInfo).
    const owned = new Map();
    const note = (cvId, r) => { if (!owned.has(String(cvId))) owned.set(String(cvId), { book_id: r.book_id, folder: r.folder, here: r.series_id === scanned.id }); };
    for (const r of db.prepare(`SELECT m.cv_issue_id AS cv, sb.id AS book_id, sb.series_id, ss.name AS folder
      FROM series_gap_matches m JOIN scanned_books sb ON sb.id=m.book_id JOIN scanned_series ss ON ss.id=sb.series_id
      WHERE m.cv_issue_id IN (SELECT value FROM json_each(?))`).all(ids)) note(r.cv, r);
    for (const r of db.prepare(`SELECT sb.cv_issue_id AS cv, sb.id AS book_id, sb.series_id, (ss.name || COALESCE(' (' || ss.year || ')', '')) AS folder FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id
      WHERE sb.cv_issue_id IN (SELECT value FROM json_each(?))`).all(ids)) note(r.cv, r);
    for (const r of db.prepare(`SELECT ci.cv_issue_id AS cv, sb.id AS book_id, sb.series_id, (ss.name || COALESCE(' (' || ss.year || ')', '')) AS folder FROM book_ci_index ci JOIN scanned_books sb ON sb.id = ci.book_id JOIN scanned_series ss ON ss.id = sb.series_id
      WHERE ci.cv_issue_id IN (SELECT value FROM json_each(?))`).all(ids)) note(r.cv, r);
    // Untagged books in this folder count by number (never annual files, never
    // books tagged as some other comic).
    const byNum = new Map();
    for (const b of db.prepare(`SELECT sb.id, sb.filename, sb.issue_number, sb.cv_issue_id, ci.cv_issue_id AS ci_cv FROM scanned_books sb LEFT JOIN book_ci_index ci ON ci.book_id = sb.id WHERE sb.series_id = ?`).all(scanned.id)) {
      if (b.cv_issue_id || b.ci_cv || /annual/i.test(b.filename)) continue;
      const n = b.issue_number != null ? IN.normIssueNumber(String(b.issue_number)) : null;
      if (n && !byNum.has(n)) byNum.set(n, b.id);
    }
    // Books whose ComicInfo says they were published as this series (same name,
    // volume year within 1, same number), even when their Comic Vine link points
    // at a different id than Comic Vine's issue list now gives (CV re-ids issues).
    const pub = new Map();
    try {
      const volYear = m.start_year || m.year || scanned.year;
      for (const [n, r] of bookIndex.lookup(m.name || scanned.name, volYear)) {
        const f = db.prepare("SELECT (name || COALESCE(' (' || year || ')', '')) AS folder FROM scanned_series WHERE id = ?").get(r.series_id);
        pub.set(n, { book_id: r.book_id, folder: f?.folder || null, here: r.series_id === scanned.id });
      }
    } catch (e) { logger.warn('fill', 'Published-name lookup failed', e.message); }
    const today = new Date().toISOString().slice(0, 10);
    const rows = issues.filter(i => !i.is_annual).map(i => {
      const o = owned.get(i.id) || pub.get(IN.normIssueNumber(String(i.number)));
      const numHit = !o && byNum.get(IN.normIssueNumber(String(i.number)));
      const state = o || numHit || i.monStatus === 'processed' ? 'owned'
        : (i.monStatus === 'wanted' || i.monStatus === 'snatched' || i.monStatus === 'downloaded' || i.monStatus === 'processing') ? 'wanted' : 'missing';
      const d = i.store_date || i.cover_date;
      return {
        id: i.id, number: i.number, title: i.title, date: i.cover_date || null,
        state, unreleased: !!(d && d > today),
        where: o ? (o.here ? null : o.folder) : null,
        image: i.cv?.image?.thumb_url || i.cv?.image?.small_url || null,
      };
    }).sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0) || String(a.number).localeCompare(String(b.number)));
    return { scanned, meta: m, volId, monitored, issues, rows };
  }

  app.get('/api/series/:id/fill/preview', requireAdmin, async (req, res) => {
    try {
      const c = await fillContext(req.params.id);
      if (c.status) return res.status(c.status).json({ error: c.error });
      const mon = c.monitored;
      res.json({
        volume: { id: c.volId, name: c.meta.name || c.scanned.name, year: c.meta.year || c.scanned.year, publisher: c.meta.publisher || null },
        monitored: mon ? { directory: mon.directory, same_folder: path.resolve(mon.directory || '') === path.resolve(c.scanned.path), series_status: mon.series_status, fill: !!mon.fill_auto_remove } : null,
        status: mon?.series_status || deriveStatusFromSeriesJson(c.scanned.path) || 'unknown',
        issues: c.rows,
        counts: { total: c.rows.length, owned: c.rows.filter(r => r.state === 'owned').length, missing: c.rows.filter(r => r.state === 'missing').length, wanted: c.rows.filter(r => r.state === 'wanted').length },
      });
    } catch (e) {
      logger.error('fill', 'Preview failed', { id: req.params.id, error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/series/:id/fill', requireAdmin, async (req, res) => {
    try {
      const r = await fillMissing(req.params.id, Array.isArray(req.body?.issueIds) ? req.body.issueIds : [], req.body?.autoRemove !== false);
      if (r.status) return res.status(r.status).json({ error: r.error });
      res.json(r);
    } catch (e) {
      logger.error('fill', 'Fill failed', { id: req.params.id, error: e.message });
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
  // ─── Missing issues on series pages (2026-10-28, claude/REQUESTS_AND_REPORTS.md) ───
  // Every series with a Comic Vine ID shows the issues it is missing as placeholders.
  // Users who may download get them (the Fill missing path); other users request them.
  // Volume issue lists for these pages are fetched once; only series that may
  // still be publishing are refreshed, weekly (user, 2026-10-28). See fetchVolumeIssues.
  const GAPS_VOLUME = { cachedOnce: true };
  require('./seriesGapMatches')(deps, 'gaps', async id => {
    const c = await fillContext(id, GAPS_VOLUME);
    return (c.rows || []).filter(r => r.state !== 'owned');
  });
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Comic Vine is slow to answer right now')), ms))]);
  app.get('/api/series/:id/gaps', requireAuth, async (req, res) => {
    try {
      const c = await withTimeout(fillContext(req.params.id, GAPS_VOLUME), 20000);
      if (c.status) return res.json({ rows: [], reason: c.status === 400 ? 'no-cv-id' : c.error });
      const canDl = downloadRequests.canDownload(req.user);
      const reqs = canDl ? {} : downloadRequests.mineFor('series', c.scanned.id, req.user.sub);
      const rows = c.rows.filter(r => r.state !== 'owned').map(r => ({ ...r, request: reqs[r.id] || null }));
      res.json({ volume_id: c.volId, monitored: !!c.monitored, can_download: canDl, owned: c.rows.length - rows.length, rows });
    } catch (e) {
      logger.warn('gaps', 'Missing issues lookup failed', { id: req.params.id, error: e.message });
      res.json({ rows: [], reason: e.message });
    }
  });
  app.post('/api/series/:id/gaps/get', requireDownloadAccess, async (req, res) => {
    try {
      const r = await fillMissing(req.params.id, Array.isArray(req.body?.issueIds) ? req.body.issueIds : [], true);
      if (r.status) return res.status(r.status).json({ error: r.error });
      res.json(r);
    } catch (e) {
      logger.error('gaps', 'Get missing issues failed', { id: req.params.id, error: e.message });
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });


  // Fill missing issues into a library folder (also used by the shared
  // editor's "Get this issue"): monitor the existing folder with the picks
  // wanted and everything else skipped, then auto-grab.
  // Returns { ok, created, wanted, directory, auto_remove } or { status, error }.
  async function fillMissing(scannedId, pickIds, autoRemove = true) {
    {
      const picks = new Set((pickIds || []).map(String));
      if (!picks.size) return { status: 400, error: 'Pick at least one issue' };
      const c = await fillContext(scannedId);
      if (c.status) return { status: c.status, error: c.error };
      const missing = new Set(c.rows.filter(r => r.state === 'missing').map(r => r.id));
      const chosen = [...picks].filter(id => missing.has(id));
      if (!chosen.length) return { status: 400, error: 'None of the picked issues are missing' };
      const volId = c.volId;
      let created = false, directory;

      if (c.monitored) {
        // Already monitored (maybe in another folder): add the picks to that entry.
        directory = c.monitored.directory;
        const up = db.prepare(`UPDATE monitored_issues SET status = 'wanted', retry_after = NULL WHERE id = ? AND series_id = ? AND status IN ('skipped','failed')`);
        db.transaction(() => { for (const id of chosen) up.run(id, volId); })();
      } else {
        directory = c.scanned.path;
        const m = c.meta;
        const name = m.name || c.scanned.name;
        const publisher = m.publisher || null;
        const status = deriveStatusFromSeriesJson(directory) || 'unknown';
        const chosenSet = new Set(chosen);
        const isAnnual = (num, nm) => (((num || '') + ' ' + (nm || '')).toLowerCase().includes('annual') ? 1 : 0);
        const insIssue = db.prepare(`INSERT OR IGNORE INTO monitored_issues (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        db.transaction(() => {
          db.prepare(`INSERT INTO monitored_series (id, name, publisher, year, total_issues, image_url, cv_url, directory, series_type, parent_series_id, is_special, series_status, fill_auto_remove, fill_started_at, last_cv_check)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, datetime('now'), datetime('now'))`)
            .run(volId, name, publisher, m.year || c.scanned.year || null, c.issues.length, m.image || m.image_url || null,
              `https://comicvine.gamespot.com/series/4050-${volId}/`, directory, detectSeriesType(publisher), status, autoRemove ? 1 : 0);
          for (const i of c.issues) {
            insIssue.run(i.id, volId, i.number, i.title, i.cover_date, i.store_date, JSON.stringify(i.cv || {}),
              isAnnual(i.cv?.issue_number, i.cv?.name), chosenSet.has(i.id) ? 'wanted' : 'skipped');
          }
        })();
        created = true;
      }
      logger.info('fill', `Fill missing: ${chosen.length} issue(s) wanted for "${c.meta.name || c.scanned.name}"`, { volId, directory, created, autoRemove: created ? autoRemove : false });
      const result = { ok: true, created, wanted: chosen.length, directory, auto_remove: created ? autoRemove : false };

      // Link the files already in the folder, then grab. No annual discovery
      // (old annuals would all become wanted) and no series.json creation
      // (the folder already has one).
      setImmediate(async () => {
        try { await runRefreshDirectory(volId); } catch (e) { logger.warn('fill', 'Refresh failed', e.message); }
        try { await scanSeriesComicInfo(volId, { onlyUnknown: true }); } catch (e) { logger.warn('fill', 'ComicInfo scan failed', e.message); }
        try {
          const r = startAutoGrab(volId);
          if (r.status) logger.warn('fill', `Auto-grab refused: ${r.error}`, { volId });
        } catch (e) { logger.warn('fill', 'Auto-grab failed to start', e.message); }
        if (created) {
          const s = db.prepare('SELECT series_status FROM monitored_series WHERE id = ?').get(volId);
          if (s && (!s.series_status || s.series_status === 'unknown')) { try { await fetchAndSetSeriesStatus(volId); } catch (e) { logger.warn('fill', 'Status fetch failed', e.message); } }
        }
      });
      return result;
    }
  }

  // ─── Shared editor: get a missing issue (claude/ADMIN_REORG.md) ───
  // For an unmatched issue in the editor: a reading-list issue (kind list,
  // owner = list id), a Timeline event issue (event) or a Top Shelf run issue
  // (run). Admin only.
  //   GET  /api/editor/acquire/:kind/:owner/:issue  → plan:
  //     owned | monitored {series_id, series_name, issue_id, status}
  //     | fill {scanned_id, folder, cv_issue_id} (other issues of the series are in the library)
  //     | add {search} (none are: the Download Manager's Add Series)
  //   POST same path { action: 'wanted' } (monitored, skipped/failed → wanted, then grab)
  //                  { action: 'fill' } (this issue wanted, the rest of the series skipped; user 2026-10-16)
  function editorIssueRow(kind, owner, issue) {
    if (kind === 'list') return db.prepare(`SELECT li.id, li.cv_issue_id, li.scanned_book_id, li.scanned_series_id, li.series_name, li.issue_number, li.volume_year
    FROM list_issues li JOIN reading_list_entries e ON e.id = li.owner_id WHERE li.owner_kind = 'reading_list_entry' AND li.id = ? AND e.list_id = ?`).get(Number(issue), Number(owner));
    if (kind === 'event') return db.prepare(`SELECT id, cv_issue_id, scanned_book_id, NULL AS scanned_series_id, series_name, issue_number, volume_year
    FROM event_issues WHERE id = ? AND event_id = ?`).get(Number(issue), String(owner));
    if (kind === 'run') return db.prepare(`SELECT id, cv_issue_id, CAST(scanned_book_id AS TEXT) AS scanned_book_id, NULL AS scanned_series_id, series_name, issue_number, volume_year
    FROM canon_run_issues WHERE id = ? AND run_id = ?`).get(Number(issue), Number(owner));
    return null;
  }
  async function editorAcquirePlan(row, volumeOpts = {}) {
    if (row.scanned_book_id && db.prepare('SELECT 1 FROM scanned_books WHERE id = ?').get(String(row.scanned_book_id))) return { state: 'owned' };
    const m = downloadRequests.monitoredFor(row);
    if (m) return { state: 'monitored', ...m };
    // Library folders of this series (same name; same volume year when both are known).
    const norm = t => String(t || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
    const want = norm(row.series_name), n = IN.normIssueNumber(String(row.issue_number ?? ''));
    const cands = db.prepare('SELECT id, name, year FROM scanned_series WHERE series_json IS NOT NULL').all()
      .filter(x => String(x.id) === String(row.scanned_series_id || '') || (norm(x.name) === want && (!row.volume_year || !x.year || String(x.year) === String(row.volume_year))))
      .sort((a, b) => (String(b.id) === String(row.scanned_series_id || '')) - (String(a.id) === String(row.scanned_series_id || '')));
    for (const x of cands.slice(0, 4)) {
      let c; try { c = await fillContext(x.id, volumeOpts); } catch (e) { continue; }
      if (c.status) continue;
      const hit = c.rows.find(r => r.state === 'missing' && (row.cv_issue_id ? String(r.id) === String(row.cv_issue_id) : IN.normIssueNumber(String(r.number)) === n));
      if (hit) return { state: 'fill', scanned_id: String(x.id), folder: `${x.name}${x.year ? ` (${x.year})` : ''}`, cv_issue_id: hit.id, series_name: c.meta.name || x.name };
      const has = c.rows.find(r => (row.cv_issue_id ? String(r.id) === String(row.cv_issue_id) : IN.normIssueNumber(String(r.number)) === n));
      if (has && has.state === 'wanted') return { state: 'monitored', series_id: c.volId, series_name: c.meta.name || x.name, issue_id: has.id, status: 'wanted' };
    }
    return { state: 'add', search: row.series_name || '' };
  }
  app.get('/api/editor/acquire/:kind/:owner/:issue', requireAdmin, async (req, res) => {
    try {
      const row = editorIssueRow(req.params.kind, req.params.owner, req.params.issue);
      if (!row) return res.status(404).json({ error: 'Issue not found' });
      res.json(await editorAcquirePlan(row));
    } catch (e) { logger.error('editor', 'Acquire plan failed', e.message); res.status(500).json({ error: e.message }); }
  });
  app.post('/api/editor/acquire/:kind/:owner/:issue', requireAdmin, async (req, res) => {
    try {
      const row = editorIssueRow(req.params.kind, req.params.owner, req.params.issue);
      if (!row) return res.status(404).json({ error: 'Issue not found' });
      const plan = await editorAcquirePlan(row), action = req.body?.action;
      if (action === 'wanted' && plan.state === 'monitored') {
        const changed = db.prepare(`UPDATE monitored_issues SET status = 'wanted', retry_after = NULL WHERE id = ? AND series_id = ? AND status IN ('skipped','failed')`).run(plan.issue_id, plan.series_id).changes;
        logger.info('editor', `Marked wanted: ${row.series_name} #${row.issue_number}`, { series: plan.series_id, changed });
        setImmediate(() => { try { const r = startAutoGrab(plan.series_id); if (r && r.status) logger.warn('editor', `Auto-grab refused: ${r.error}`); } catch (e) { logger.warn('editor', 'Auto-grab failed to start', e.message); } });
        return res.json({ ok: true, plan: { ...plan, status: 'wanted' } });
      }
      if (action === 'fill' && plan.state === 'fill') {
        const r = await fillMissing(plan.scanned_id, [plan.cv_issue_id], true);
        if (r.status) return res.status(r.status).json({ error: r.error });
        return res.json({ ok: true, plan: { state: 'monitored', series_id: null, series_name: plan.series_name, status: 'wanted' }, directory: r.directory });
      }
      res.status(409).json({ error: 'That is no longer possible for this issue. Close and reopen it.', plan });
    } catch (e) { logger.error('editor', 'Acquire failed', e.message); res.status(500).json({ error: e.message }); }
  });

  // Remove Fill-made entries once their picks are done. Only entries Fill
  // created (fill_auto_remove = 1), only ended series, not within 30 minutes of
  // the fill, and not while any issue is wanted or in flight.
  function runFillAutoRemove() {
    const rows = db.prepare(`SELECT id, name FROM monitored_series ms
    WHERE fill_auto_remove = 1 AND series_status = 'ended'
      AND (fill_started_at IS NULL OR fill_started_at <= datetime('now', '-30 minutes'))
      AND NOT EXISTS (SELECT 1 FROM monitored_issues mi WHERE mi.series_id = ms.id AND mi.status IN ('wanted','snatched','downloaded','processing','failed'))`).all();
    for (const r of rows) {
      if ([...activeDownloads.keys()].some(k => String(k).startsWith(`auto-grab-${r.id}-`))) continue;
      try {
        const done = db.prepare(`SELECT COUNT(*) AS n FROM monitored_issues WHERE series_id = ? AND status = 'processed'`).get(r.id).n;
        removeMonitoredSeriesRows(r.id);
        logger.info('fill', `Fill done: removed "${r.name}" from the download manager`, { id: r.id, processed: done });
      } catch (e) { logger.warn('fill', `Auto-remove failed for "${r.name}"`, e.message); }
    }
  }
  setInterval(() => { try { runFillAutoRemove(); } catch (e) { logger.warn('fill', 'Auto-remove check failed', e.message); } }, 30 * 60 * 1000);


  app.post('/api/monitor/series/:id/issues/:issueId/reset', requireDownloadAccess, (req, res) => {
    const { issueId } = req.params;
    const issue = db.prepare('SELECT * FROM monitored_issues WHERE id = ?').get(issueId);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    if (['wanted', 'processed'].includes(issue.status)) {
      return res.status(400).json({ error: `Issue is already ${issue.status}` });
    }
    // Clear blacklist so all sources are eligible again
    db.prepare('DELETE FROM download_blacklist WHERE issue_id = ?').run(issueId);
    db.prepare(`
    UPDATE monitored_issues
    SET status = 'wanted', download_id = NULL, file_path = NULL,
        download_url = NULL, fail_count = 0, last_fail_reason = NULL,
        date_processed = NULL, retry_after = NULL, retry_epoch = NULL, weekly_retries = 0
    WHERE id = ?
  `).run(issueId);
    logger.info('reset', `Issue ${issueId} reset to wanted + blacklist cleared (was: ${issue.status})`);
    res.json({ success: true });
  });
  return { editorAcquirePlan, editorIssueRow, fetchVolumeIssues, fillContext, GAPS_VOLUME, runFillAutoRemove, withTimeout };
};
