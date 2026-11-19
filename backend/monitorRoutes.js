'use strict';
// ─── Monitored series routes (moved out of server.js 2026-11-19, server.js split step 7A) ───
// The Download Manager's series list and issue lists, adding a series (or a special of one), removing
// and pruning series, editing a series, the Specials-shelf routes, and the has-series.json and
// folder-exists caches the list uses. Moved unchanged.
const fs = require('fs');
const path = require('path');
const IN = require('./issueNumber');
const { nameKey } = require('./names');

const NEEDS = ['activePackFor', 'annotateWaiting', 'annualStillPublishing', 'app', 'autoDiscoverAnnuals', 'createSeriesJsonIfMissing', 'cvApiGet', 'db', 'deriveStatusFromSeriesJson', 'fetchAndSetSeriesStatus', 'getCVKey', 'LOCG_BASE', 'logger', 'requireAdmin', 'requireAuth', 'requireDownloadAccess', 'runRefreshDirectory', 'scanSeriesComicInfo', 'scheduleGroupingRun', 'seriesGrouping', 'shelvesOn', 'visibleInSeriesAnnuals'];
module.exports.NEEDS = NEEDS;

module.exports.registerMonitorRoutes = function registerMonitorRoutes(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerMonitorRoutes: missing ${missing.join(', ')}`);
  const { activePackFor, annotateWaiting, annualStillPublishing, app, autoDiscoverAnnuals, createSeriesJsonIfMissing, cvApiGet, db, deriveStatusFromSeriesJson, fetchAndSetSeriesStatus, getCVKey, LOCG_BASE, logger, requireAdmin, requireAuth, requireDownloadAccess, runRefreshDirectory, scanSeriesComicInfo, scheduleGroupingRun, seriesGrouping, shelvesOn, visibleInSeriesAnnuals } = deps;
  // ─── Monitored Series API ────────────────────────────────────────

  // Cache has_series_json results — invalidated when series.json is created/deleted.
  // Avoids hitting the filesystem for every series on every 30s poll.
  const seriesJsonCache = new Map(); // series_id → boolean
  function invalidateSeriesJsonCache(seriesId) { seriesJsonCache.delete(seriesId); }
  function getHasSeriesJson(seriesId, directory) {
    if (!seriesJsonCache.has(seriesId)) {
      seriesJsonCache.set(seriesId, fs.existsSync(path.join(directory, 'series.json')));
    }
    return seriesJsonCache.get(seriesId);
  }

  // Cache directory_exists results — invalidated when the directory is changed
  // via PATCH or after refresh-directory might have caused mkdir. Used by the
  // frontend to surface a "directory missing" warning state on the series card
  // and disable buttons that would create files at the wrong place. Cached
  // for the same reason as has_series_json — fs.existsSync per series per
  // 30s poll is wasteful at scale.
  const directoryExistsCache = new Map(); // series_id → boolean
  function invalidateDirectoryExistsCache(seriesId) { directoryExistsCache.delete(seriesId); }
  function getDirectoryExists(seriesId, directory) {
    if (!directory) return false;
    if (!directoryExistsCache.has(seriesId)) {
      try {
        directoryExistsCache.set(seriesId, fs.existsSync(directory));
      } catch {
        directoryExistsCache.set(seriesId, false);
      }
    }
    return directoryExistsCache.get(seriesId);
  }

  app.get('/api/monitor/series', (req, res) => {
    // Exclude linked annual series and child special series — shown inside parent card only
    const linkedAnnualIds = new Set(
      db.prepare('SELECT annual_series_id FROM series_annual_links').all().map(r => r.annual_series_id)
    );

    // Single aggregated query — includes parent name and scanned_series_id for merge/special features
    const rows = db.prepare(`
    SELECT s.*,
      p.name as _parent_name,
      hs.name as _shelf_home_name,
      ss.id as scanned_series_id,
      SUM(CASE WHEN i.is_annual = 0 AND i.status != 'skipped' THEN 1 ELSE 0 END) as total_tracked,
      SUM(CASE WHEN i.is_annual = 0 AND i.status = 'wanted'    THEN 1 ELSE 0 END) as wanted_count,
      SUM(CASE WHEN i.is_annual = 0 AND i.status = 'processed' THEN 1 ELSE 0 END) as have_count,
      SUM(CASE WHEN i.is_annual = 0 AND i.status = 'processed' AND i.has_comicinfo = 0 THEN 1 ELSE 0 END) as untagged_count
    FROM monitored_series s
    LEFT JOIN monitored_issues i ON i.series_id = s.id
    LEFT JOIN monitored_series p ON p.id = s.parent_series_id
    LEFT JOIN scanned_series hs ON hs.id = s.shelf_home_id
    LEFT JOIN scanned_series ss ON ss.path = s.directory
    GROUP BY s.id
    ORDER BY s.name
  `).all().filter(s => !linkedAnnualIds.has(s.id));

    // Annual counts — one query for all parents
    const annualTotals = db.prepare(`
    SELECT l.parent_series_id,
      SUM(CASE WHEN i.status != 'skipped' THEN 1 ELSE 0 END) as annual_total,
      SUM(CASE WHEN i.status = 'wanted'    THEN 1 ELSE 0 END) as annual_wanted,
      SUM(CASE WHEN i.status = 'processed' THEN 1 ELSE 0 END) as annual_have,
      SUM(CASE WHEN i.status = 'processed' AND i.has_comicinfo = 0 THEN 1 ELSE 0 END) as annual_untagged
    FROM series_annual_links l
    JOIN monitored_issues i ON i.series_id = l.annual_series_id
    GROUP BY l.parent_series_id
  `).all().reduce((acc, r) => { acc[r.parent_series_id] = r; return acc; }, {});

    // Visible in-series annuals (see visibleInSeriesAnnuals) count toward the totals too.
    const inSeriesBySeries = {};
    for (const r of db.prepare(`SELECT series_id, issue_number, release_date, store_date, status, has_comicinfo
                              FROM monitored_issues WHERE is_annual = 1`).all()) {
      (inSeriesBySeries[r.series_id] ||= []).push(r);
    }
    const linkedIssuesByParent = {};
    for (const r of db.prepare(`SELECT l.parent_series_id, i.issue_number, i.release_date, i.store_date
                              FROM series_annual_links l JOIN monitored_issues i ON i.series_id = l.annual_series_id`).all()) {
      (linkedIssuesByParent[r.parent_series_id] ||= []).push(r);
    }

    const annotated = rows.map(s => {
      const at = annualTotals[s.id] || { annual_total: 0, annual_wanted: 0, annual_have: 0, annual_untagged: 0 };
      const extra = visibleInSeriesAnnuals(inSeriesBySeries[s.id] || [], linkedIssuesByParent[s.id] || []);
      const ex = {
        total:    extra.filter(r => r.status !== 'skipped').length,
        wanted:   extra.filter(r => r.status === 'wanted').length,
        have:     extra.filter(r => r.status === 'processed').length,
        untagged: extra.filter(r => r.status === 'processed' && r.has_comicinfo === 0).length,
      };
      return {
        ...s,
        total_tracked:  (s.total_tracked  || 0) + at.annual_total    + ex.total,
        wanted_count:   (s.wanted_count   || 0) + at.annual_wanted   + ex.wanted,
        have_count:     (s.have_count     || 0) + at.annual_have     + ex.have,
        untagged_count: (s.untagged_count || 0) + at.annual_untagged + ex.untagged,
        has_series_json:   getHasSeriesJson(s.id, s.directory),
        directory_exists:  getDirectoryExists(s.id, s.directory),
        cv_volume_url:     `https://comicvine.gamespot.com/volume/4050-${s.id}/`,
        locg_series_url:   (s.locg_series_id && s.locg_series_slug)
          ? `${LOCG_BASE}/comics/series/${s.locg_series_id}/${s.locg_series_slug}` : null,
      };
    });
    res.json(annotated);
  });

  app.get('/api/monitor/series/:id/issues', (req, res) => {
    const { id } = req.params;

    // Regular (non-annual) issues from the main series
    const rows = db.prepare(`
    SELECT * FROM monitored_issues WHERE series_id = ? ORDER BY CAST(issue_number AS REAL)
  `).all(id);
    const issues = rows.filter(r => !r.is_annual);

    // Linked annual volumes (standalone CV volumes via series_annual_links)
    const linkedAnnualIds = db.prepare(`
    SELECT annual_series_id FROM series_annual_links WHERE parent_series_id = ?
  `).all(id).map(r => r.annual_series_id);

    // Build annuals list:
    // - If linked volumes exist, use ONLY those — they are the authoritative source.
    //   In-series is_annual=1 rows (set by startup backfill) represent the same real-world
    //   issues and would cause duplicates if mixed in.
    // - If no linked volumes, fall back to in-series is_annual=1 rows (e.g. a series
    //   that mixes annual issues directly into its main CV volume).
    let annuals = [];
    if (linkedAnnualIds.length === 0) {
      annuals = rows.filter(r => r.is_annual);
    } else {
      for (const annualId of linkedAnnualIds) {
        const annualSeries = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(annualId);
        const annualIssues = db.prepare(`
        SELECT * FROM monitored_issues WHERE series_id = ? ORDER BY CAST(issue_number AS REAL)
      `).all(annualId).map(i => ({
          ...i,
          is_annual: 1,
          _annual_series_name: annualSeries?.name || null,
        }));
        annuals = annuals.concat(annualIssues);
      }
      // Keep in-series "annual" rows that don't match a linked annual issue visible.
      const unmatched = visibleInSeriesAnnuals(rows.filter(r => r.is_annual), annuals);
      annuals = annuals.concat(unmatched.map(r => ({ ...r, _in_series_unmatched: true })));
    }

    // Sort annuals by release_date then issue_number
    annuals.sort((a, b) => {
      const da = a.release_date || a.store_date || '9999';
      const db2 = b.release_date || b.store_date || '9999';
      if (da !== db2) return da.localeCompare(db2);
      return (parseFloat(a.issue_number) || 0) - (parseFloat(b.issue_number) || 0);
    });

    // Skipped issues the library already has in ANOTHER folder (era splits,
    // books filed elsewhere), by Comic Vine id: label them "Owned · in <folder>".
    try {
      const dir = db.prepare('SELECT directory FROM monitored_series WHERE id = ?').get(id)?.directory || '';
      const skipped = [...issues, ...annuals].filter(i => i.status === 'skipped');
      if (skipped.length) {
        const ids = JSON.stringify(skipped.map(i => String(i.id)));
        const where = new Map();
        const q = col => db.prepare(`SELECT ${col} AS cv, ss.path, (ss.name || COALESCE(' (' || ss.year || ')', '')) AS folder
        FROM ${col.startsWith('ci.') ? 'book_ci_index ci JOIN scanned_books sb ON sb.id = ci.book_id' : 'scanned_books sb'}
        JOIN scanned_series ss ON ss.id = sb.series_id WHERE ${col} IN (SELECT value FROM json_each(?))`).all(ids);
        for (const r of [...q('sb.cv_issue_id'), ...q('ci.cv_issue_id')]) {
          if (r.path === dir) { where.set(String(r.cv), null); continue; }      // also here: no label
          if (!where.has(String(r.cv))) where.set(String(r.cv), r.folder);
        }
        for (const i of skipped) { const f = where.get(String(i.id)); if (f) i.owned_in = f; }
      }
    } catch (e) { logger.warn('monitor', 'Owned-elsewhere lookup failed', e.message); }

    const pack = activePackFor(id);
    for (const i of issues) annotateWaiting(i, pack);
    for (const i of annuals) annotateWaiting(i, pack);
    // Link only exact indexed files; no archive reads during list browsing.
    const paths = [...new Set([...issues, ...annuals].map(i => i.file_path).filter(Boolean))];
    if (paths.length) {
      const books = db.prepare('SELECT id, path FROM scanned_books WHERE path IN (SELECT value FROM json_each(?))').all(JSON.stringify(paths));
      const byPath = new Map(books.map(book => [book.path, book.id]));
      for (const issue of [...issues, ...annuals]) issue.book_id = byPath.get(issue.file_path) || null;
    }
    res.json({ issues, annuals });
  });

  // ─── Special Series ────────────────────────────────────────────
  //
  // A "special" series is a limited series, one-shot or tie-in that belongs with another series.
  // Since 2026-11-14 every route makes it a Specials-shelf link (seriesGrouping.js) and nothing on disk
  // moves:
  //   1. Add Series "Special of …" — its own folder beside the series, shelf_home_id (MONITORED_SPECIALS.md)
  //   2. Download Manager "◈ Make Special of…" — POST /api/specials/shelve
  //   3. Series page Manage › "Put on a Specials shelf…" — POST /api/series/:id/shelf
  // The old merge (files moved into the parent's folder, marked is_special) is gone; specials merged
  // that way before stay as they are. Annuals are separate (series_annual_links).

  // GET /api/specials/scanned-series — all scanned series for parent picker
  // Returns both monitored and unmonitored series so any can be a parent.
  app.get('/api/specials/scanned-series', requireAuth, (req, res) => {
    const q = (req.query.q || '').toLowerCase().trim();
    let rows = db.prepare(`
    SELECT ss.id, ss.name, ss.year, ss.path,
           (SELECT ms.id FROM monitored_series ms WHERE ms.directory = ss.path
            AND ms.parent_series_id IS NULL LIMIT 1) as monitored_id
    FROM scanned_series ss
    ORDER BY ss.name ASC
  `).all();
    if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q));
    res.json(rows.slice(0, 50));
  });

  // POST /api/specials/shelve — "◈ Make Special of…": put a series on another series' Specials shelf.
  // Body: { sourceScannedSeriesId, parentScannedSeriesId }. A monitored source also gets shelf_home_id,
  // so the Download Manager shows "◈ Special of". With shelves off the link is kept for when they are on.
  app.post('/api/specials/shelve', requireAdmin, (req, res) => {
    const source = String(req.body?.sourceScannedSeriesId || ''), parent = String(req.body?.parentScannedSeriesId || '');
    try {
      seriesGrouping.link(source, parent);
      const src = db.prepare('SELECT path, name FROM scanned_series WHERE id = ?').get(source);
      if (src) db.prepare('UPDATE monitored_series SET shelf_home_id = ? WHERE directory = ? AND COALESCE(is_special, 0) = 0 AND parent_series_id IS NULL').run(parent, src.path);
      logger.info('specials', `Shelved "${src?.name || source}" as a special`, { parent });
      res.json({ ok: true, shelvesOn: shelvesOn() });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Known manga publishers — used to auto-detect series_type on monitor add.
  // Dark Horse excluded (too many western comics). Tokyopop included (overwhelmingly manga).
  const MANGA_PUBLISHERS = new Set([
    'viz media', 'viz', 'kodansha', 'kodansha comics', 'yen press',
    'seven seas entertainment', 'seven seas', 'shueisha', 'shogakukan',
    'tokyopop', 'j-novel club', 'vertical', 'udon entertainment',
  ]);

  function detectSeriesType(publisher) {
    if (!publisher) return 'comic';
    return MANGA_PUBLISHERS.has(publisher.toLowerCase().trim()) ? 'manga' : 'comic';
  }

  app.post('/api/monitor/series', requireDownloadAccess, async (req, res) => {
    const { id, name, publisher, year, total_issues, image_url, cv_url, parentDir, parentScannedSeriesId, source_name } = req.body;
    if (!id || !name || !parentDir) return res.status(400).json({ error: 'id, name, parentDir required' });
    if (typeof name !== 'string' || typeof parentDir !== 'string' || (publisher != null && typeof publisher !== 'string')) return res.status(400).json({ error: 'Invalid name, publisher or parent directory' });

    const COMICS_ROOT = process.env.COMICS_PATH || '/comics';
    let directory;
    let parentMonitoredId = null;

    let shelfHomeId = null;
    if (parentScannedSeriesId) {
      // Special of … (2026-11-14): its own folder beside the series it belongs to, as a series in its
      // own right; the Specials-shelf rules then put it on that series' shelf (shelf_home_id). Earlier
      // specials shared the parent's folder; they stay as they are.
      const parentScanned = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(String(parentScannedSeriesId));
      if (!parentScanned) return res.status(404).json({ error: 'Parent series not found' });
      const folderName = `${name} (${year || 'Unknown'})`.replace(/[/\\:*?"<>|]/g, '');
      try {
        directory = require('./pathSecurity').resolveCreatableWithinRoot(COMICS_ROOT, path.join(path.dirname(parentScanned.path), folderName));
        if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
      } catch (e) {
        return res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not create directory' });
      }
      shelfHomeId = parentScanned.id;
      logger.info('monitor', `Adding special "${name}" in its own folder, for the Specials shelf of "${parentScanned.name}"`, { directory });
    } else {
      // Normal series — create a new folder
      let resolvedParentDir = parentDir;
      if (path.resolve(parentDir) === path.resolve(COMICS_ROOT) && publisher) {
        const safePublisher = publisher.replace(/[/\\:*?"<>|]/g, '').trim();
        resolvedParentDir = path.join(COMICS_ROOT, safePublisher);
      }
      const folderName = `${name} (${year || 'Unknown'})`.replace(/[/\\:*?"<>|]/g, '');
      directory = path.join(resolvedParentDir, folderName);
      try {
        directory = require('./pathSecurity').resolveCreatableWithinRoot(COMICS_ROOT, directory);
        if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
      } catch (e) {
        return res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not create directory' });
      }
    }

    // Insert series. is_special is set when the user added this via the
    // "Special of …" picker — i.e. they provided parentScannedSeriesId.
    // We record this independently of parent_series_id so the prefix-strict
    // matcher fires even when the scanned parent isn't itself monitored.
    // Since 2026-11-14 a "Special of" series is not marked is_special: it has its own folder, so its
    // files are its regular issues; shelf_home_id records where it is shelved.
    const isSpecial = 0;
    try {
      const seriesType = detectSeriesType(publisher);
      db.prepare(`
      INSERT OR REPLACE INTO monitored_series (id, name, publisher, year, total_issues, image_url, cv_url, directory, series_type, parent_series_id, is_special, source_name, shelf_home_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, publisher, year, total_issues || 0, image_url, cv_url, directory, seriesType, parentMonitoredId, isSpecial, source_name || null, shelfHomeId);
      if (seriesType === 'manga') logger.info('monitor', `Auto-detected manga series: "${name}" (publisher: ${publisher})`);
      if (shelfHomeId) scheduleGroupingRun('special added');
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    // Fetch all issues from CV and insert as wanted
    try {
      const CV_API_KEY = getCVKey();
      let offset = 0;
      let allIssues = [];
      while (true) {
        const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
          params: {
            api_key: getCVKey(), format: 'json',
            filter: `volume:${id}`,
            field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
            offset, limit: 100,
          },
          headers: { 'User-Agent': 'Omnibus/1.0' },
        });
        const results = r.data.results || [];
        allIssues = allIssues.concat(results);
        if (allIssues.length >= r.data.number_of_total_results) break;
        offset += 100;
        await new Promise(resolve => setTimeout(resolve, 500)); // CV rate limit
      }

      const insertIssue = db.prepare(`
      INSERT OR IGNORE INTO monitored_issues (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
      const isAnnual = (num, name) => {
        const s = ((num || '') + ' ' + (name || '')).toLowerCase();
        return s.includes('annual') ? 1 : 0;
      };
      const insertMany = db.transaction(issues => {
        for (const i of issues) {
          // Canonicalise CV's raw "8AU" → "8.AU" so all SQL `=` matches
          // (scanner, manga-pp, etc.) compare apples to apples without
          // each call site having to normalise.
          const canonNum = IN.normIssueNumber(i.issue_number) || '0';
          insertIssue.run(
            String(i.id), id, canonNum,
            i.name || null,
            i.cover_date || null,
            i.store_date || null,
            JSON.stringify(i),
            isAnnual(i.issue_number, i.name)
          );
        }
      });
      insertMany(allIssues);

      // Update total_issues count and last_cv_check
      db.prepare('UPDATE monitored_series SET total_issues = ?, last_cv_check = datetime(\'now\') WHERE id = ?').run(allIssues.length, id);

      // Keep release_cv_map in sync — upsert this series so the weekly tab can
      // find it immediately by name+publisher without waiting for next startup.
      // User-confirmed entries (source='user') are not overwritten by auto seeds.
      try {
        const normName = nameKey(name);
        const normPub  = nameKey(publisher);
        db.prepare(`
        INSERT INTO release_cv_map (norm_name, norm_publisher, cv_volume_id, source, updated_at)
        VALUES (?, ?, ?, 'auto', datetime('now'))
        ON CONFLICT(norm_name, norm_publisher) DO UPDATE SET
          cv_volume_id = excluded.cv_volume_id,
          updated_at   = excluded.updated_at
        WHERE source != 'user'
      `).run(normName, normPub, String(id));
      } catch (e) { logger.warn('monitor', 'release_cv_map upsert failed', e.message); }

      res.json({ success: true, directory, issues_added: allIssues.length });

      // Fire-and-forget post-add setup. Each step is independently wrapped so a
      // failure in one (e.g. CV rate limit during fetchAndSetSeriesStatus) doesn't
      // block the others — series.json creation in particular must always run.
      // NOTE: createSeriesJsonIfMissing runs BEFORE fetchAndSetSeriesStatus so
      // that deriveStatusFromSeriesJson (reading series.json) is tried first.
      // If series.json already has 'Continuing'/'Ended', no CV API call is needed.
      setImmediate(async () => {
        try { await runRefreshDirectory(id); } catch (e) { logger.warn('monitor', 'Post-add refresh failed', e.message); }
        // A new special: refresh the parent too, so it lets go of the special's files now.
        if (parentMonitoredId) { try { await runRefreshDirectory(parentMonitoredId); } catch (e) { logger.warn('monitor', 'Post-add parent refresh failed', e.message); } }
        // Scan immediately after directory refresh so untagged issues are flagged
        // without requiring a manual refresh button press.
        try { await scanSeriesComicInfo(id, { onlyUnknown: true }); } catch (e) { logger.warn('monitor', 'Post-add ComicInfo scan failed', e.message); }
        try { await autoDiscoverAnnuals(id, name, directory); } catch (e) { logger.warn('monitor', 'Post-add annual discovery failed', e.message); }
        // Auto-create series.json + run enricher BEFORE status check so that
        // deriveStatusFromSeriesJson can read the 'Continuing'/'Ended' field
        // written by the enricher, avoiding a redundant CV API call.
        try {
          const created = await createSeriesJsonIfMissing({ id, directory });
          if (created) {
            logger.info('monitor', `Auto-created series.json for new series "${name}"`);
            // Update series_status from the freshly written series.json so
            // fetchAndSetSeriesStatus can skip the CV API call entirely.
            const statusFromJson = deriveStatusFromSeriesJson(directory);
            if (statusFromJson) {
              db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(statusFromJson, id);
              logger.info('monitor', `Post-add status from series.json: ${statusFromJson}`, { id });
            }
          } else if (fs.existsSync(path.join(directory, 'series.json'))) {
            // Already there (e.g. the folder was in the library before it was
            // monitored): not a failure. Still use it for the status.
            logger.info('monitor', `series.json already present for "${name}" — kept`);
            const statusFromJson = deriveStatusFromSeriesJson(directory);
            if (statusFromJson) {
              db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(statusFromJson, id);
              logger.info('monitor', `Post-add status from series.json: ${statusFromJson}`, { id });
            }
          } else {
            logger.warn('monitor', `Auto series.json creation returned false for "${name}"`);
          }
        } catch (e) {
          logger.warn('monitor', 'Auto series.json creation failed', e.message);
        }
        // Status check: series.json path will short-circuit if status was just set above.
        // Falls back to CV API for series where the enricher didn't set a status.
        try { await fetchAndSetSeriesStatus(id); } catch (e) { logger.warn('monitor', 'Post-add status fetch failed', e.message); }
      });
    } catch (e) {
      // Series was added but issue fetch failed — not fatal
      logger.error('monitor', 'Failed to fetch CV issues', e.message);
      res.json({ success: true, directory, issues_added: 0, warning: `CV fetch failed: ${e.message}` });

      // Same isolation as above — each step independent, series.json before status check.
      setImmediate(async () => {
        try { await runRefreshDirectory(id); } catch (e) { logger.warn('monitor', 'Post-add refresh failed', e.message); }
        // A new special: refresh the parent too, so it lets go of the special's files now.
        if (parentMonitoredId) { try { await runRefreshDirectory(parentMonitoredId); } catch (e) { logger.warn('monitor', 'Post-add parent refresh failed', e.message); } }
        try { await scanSeriesComicInfo(id, { onlyUnknown: true }); } catch (e) { logger.warn('monitor', 'Post-add ComicInfo scan failed', e.message); }
        try { await autoDiscoverAnnuals(id, name, directory); } catch (e) { logger.warn('monitor', 'Post-add annual discovery failed', e.message); }
        try {
          const created = await createSeriesJsonIfMissing({ id, directory });
          if (created) {
            logger.info('monitor', `Auto-created series.json for new series "${name}"`);
            const statusFromJson = deriveStatusFromSeriesJson(directory);
            if (statusFromJson) {
              db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(statusFromJson, id);
              logger.info('monitor', `Post-add status from series.json: ${statusFromJson}`, { id });
            }
          }
        } catch (e) {
          logger.warn('monitor', 'Auto series.json creation failed', e.message);
        }
        try { await fetchAndSetSeriesStatus(id); } catch (e) { logger.warn('monitor', 'Post-add status fetch failed', e.message); }
      });
    }
  });

  // Remove a monitored series from the download manager: its issues, packs and
  // linked annual series. Files and the library are not touched. Returns the
  // linked annuals ({ id, dir }) so a caller can delete their folders if asked.
  function removeMonitoredSeriesRows(id) {
    // Fetch linked annuals before any deletes
    const linkedAnnuals = db.prepare(
      'SELECT annual_series_id FROM series_annual_links WHERE parent_series_id = ?'
    ).all(id);

    // Annuals are often shared (X-Men Annual is linked to X-Men (2024) and to
    // older entries). One still linked to another series stays: only this
    // series' link to it goes.
    const sharedWithOthers = aid => !!db.prepare('SELECT 1 FROM series_annual_links WHERE annual_series_id = ? AND parent_series_id != ?').get(aid, id);
    const annualDirs = linkedAnnuals.filter(link => !sharedWithOthers(link.annual_series_id)).map(link => ({
      id: link.annual_series_id,
      dir: db.prepare('SELECT directory FROM monitored_series WHERE id = ?').get(link.annual_series_id)?.directory,
    }));

    // Single transaction for all DB deletes — order matters for FK constraints:
    // series_annual_links must be deleted before the monitored_series rows they reference
    db.transaction(() => {
      // 1. Drop all annual links where this series is the parent
      db.prepare('DELETE FROM series_annual_links WHERE parent_series_id = ?').run(id);
      // 2. Remove any link where this series was itself an annual child
      db.prepare('DELETE FROM series_annual_links WHERE annual_series_id = ?').run(id);
      // 3. Delete annual series_packs, issues, and series rows
      for (const a of annualDirs) {
        // Clear any annual links the annual series itself may have (as parent or child)
        // before deleting its monitored_series row — prevents FK constraint failure
        db.prepare('DELETE FROM series_annual_links WHERE parent_series_id = ?').run(a.id);
        db.prepare('DELETE FROM series_annual_links WHERE annual_series_id = ?').run(a.id);
        db.prepare('DELETE FROM series_packs WHERE series_id = ?').run(a.id);
        db.prepare('UPDATE scanned_books SET monitored_issue_id=NULL WHERE monitored_issue_id IN (SELECT id FROM monitored_issues WHERE series_id=?)').run(a.id);
        db.prepare('DELETE FROM monitored_issues WHERE series_id = ?').run(a.id);
        db.prepare('DELETE FROM monitored_series WHERE id = ?').run(a.id);
      }
      // 4. Delete parent series_packs, issues, and series row
      db.prepare('DELETE FROM series_packs WHERE series_id = ?').run(id);
      db.prepare('UPDATE scanned_books SET monitored_issue_id=NULL WHERE monitored_issue_id IN (SELECT id FROM monitored_issues WHERE series_id=?)').run(id);
      db.prepare('DELETE FROM monitored_issues WHERE series_id = ?').run(id);
      db.prepare('DELETE FROM monitored_series WHERE id = ?').run(id);
    })();

    return annualDirs;
  }

  app.delete('/api/monitor/series/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const deleteFiles = req.query.deleteFiles === 'true';

    try {
      // Fetch directory before deleting the row
      const row = db.prepare('SELECT directory, name FROM monitored_series WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Series not found' });

      const annualDirs = removeMonitoredSeriesRows(id);

      logger.info('monitor', `Deleted series "${row.name}" (${id}) and ${annualDirs.length} linked annuals`);

      // File deletion outside transaction (best-effort)
      if (deleteFiles) {
        for (const a of annualDirs) {
          if (a.dir && a.dir !== row.directory) {
            try { fs.rmSync(a.dir, { recursive: true, force: true }); } catch {}
          }
        }
        if (row.directory) {
          try {
            fs.rmSync(row.directory, { recursive: true, force: true });
            logger.info('monitor', `Deleted directory`, { directory: row.directory });
          } catch (e) {
            logger.warn('monitor', `Could not delete directory`, { directory: row.directory, error: e.message });
          }
        }
      }

      res.json({ success: true });
    } catch (e) {
      logger.error('monitor', `Failed to delete series ${id}`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Prune ended series from the download manager (admin) ─────────────
  // Ended series keep their files and library entries; only their download
  // tracking goes (as with Remove). Linked annual series go with their parent.
  // Ticked by default: ended, nothing wanted, and not the annual of a series
  // that is still ongoing.
  app.get('/api/monitor/prune/candidates', requireAdmin, (req, res) => {
    try {
      const rows = db.prepare(`
      SELECT ms.id, ms.name, ms.year, ms.publisher, ms.directory, ms.is_special, ms.parent_series_id, ms.last_cv_check,
        SUM(CASE WHEN mi.status = 'processed' THEN 1 ELSE 0 END) AS processed,
        SUM(CASE WHEN mi.status = 'skipped'   THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN mi.status = 'wanted'    THEN 1 ELSE 0 END) AS wanted,
        COUNT(mi.id) AS issues
      FROM monitored_series ms LEFT JOIN monitored_issues mi ON mi.series_id = ms.id
      WHERE ms.series_status = 'ended'
      GROUP BY ms.id
      ORDER BY ms.name COLLATE NOCASE, ms.year`).all();
      // Every parent of each annual (annuals are often shared between series).
      const parentsOf = new Map();
      for (const r of db.prepare(`SELECT l.annual_series_id AS a, p.id, p.name, p.year, p.series_status AS st
      FROM series_annual_links l JOIN monitored_series p ON p.id = l.parent_series_id`).all()) {
        if (!parentsOf.has(String(r.a))) parentsOf.set(String(r.a), []);
        parentsOf.get(String(r.a)).push(r);
      }
      const annualCount = new Map(db.prepare('SELECT parent_series_id AS p, COUNT(*) AS n FROM series_annual_links GROUP BY parent_series_id').all().map(r => [String(r.p), r.n]));
      // Wanted issues in a parent's linked annuals (they would be removed with it).
      const annualWanted = new Map(db.prepare(`SELECT l.parent_series_id AS p, COUNT(*) AS n FROM series_annual_links l
      JOIN monitored_issues mi ON mi.series_id = l.annual_series_id WHERE mi.status = 'wanted' GROUP BY l.parent_series_id`).all().map(r => [String(r.p), r.n]));
      const out = [];
      for (const r of rows) {
        const parents = parentsOf.get(String(r.id)) || [];
        const liveParent = parents.find(p => p.st !== 'ended');
        // An annual whose parents are all ended goes with them: listed under the parents only.
        if (parents.length && !liveParent) continue;
        const reasons = [];
        if (r.wanted) reasons.push(`${r.wanted} wanted`);
        if (annualWanted.get(String(r.id))) reasons.push(`its annuals have ${annualWanted.get(String(r.id))} wanted`);
        if (liveParent) reasons.push(`annual of ${liveParent.name} (${liveParent.year || '?'}), still ongoing`);
        // Hold back: its annual volume is still publishing and no live run has it yet —
        // pruning now would drop the volume before a new run can take it over.
        for (const a of db.prepare(`SELECT l.annual_series_id AS id, s.name FROM series_annual_links l
          JOIN monitored_series s ON s.id = l.annual_series_id WHERE l.parent_series_id = ?`).all(r.id)) {
          const live = (parentsOf.get(String(a.id)) || []).some(p => p.st !== 'ended' && String(p.id) !== String(r.id));
          if (!live && annualStillPublishing(a.id)) reasons.push(`annual ${a.name} still publishing — waiting for a new run to take it over`);
        }
        if (r.is_special || r.parent_series_id) {
          const host = db.prepare(`SELECT name, year FROM monitored_series WHERE directory = ? AND id != ? AND COALESCE(is_special, 0) = 0
          AND parent_series_id IS NULL AND series_status != 'ended' LIMIT 1`).get(r.directory, r.id);
          if (host) reasons.push(`special filed in ${host.name} (${host.year || '?'}), keeps its files out of that series' matches`);
        }
        out.push({ id: r.id, name: r.name, year: r.year, publisher: r.publisher, directory: r.directory, special: !!(r.is_special || r.parent_series_id),
          issues: r.issues, processed: r.processed || 0, skipped: r.skipped || 0, wanted: r.wanted || 0,
          annuals: annualCount.get(String(r.id)) || 0, last_cv_check: r.last_cv_check, keep_reasons: reasons, suggested: !reasons.length });
      }
      res.json({ candidates: out, total_monitored: db.prepare('SELECT COUNT(*) AS n FROM monitored_series').get().n });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/monitor/prune', requireAdmin, (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).slice(0, 5000);
    if (!ids.length) return res.status(400).json({ error: 'No series selected' });
    let removed = 0, annuals = 0; const errors = [];
    for (const id of ids) {
      const row = db.prepare("SELECT id, name, series_status FROM monitored_series WHERE id = ?").get(id);
      if (!row) continue;                                             // already gone (e.g. removed with its parent)
      if (row.series_status !== 'ended') { errors.push({ id, error: 'not ended' }); continue; }
      try { annuals += removeMonitoredSeriesRows(id).length; removed++; }
      catch (e) { errors.push({ id, error: e.message }); }
    }
    logger.info('monitor', `Pruned ${removed} ended series (+${annuals} linked annual series) from the download manager`, { errors: errors.length });
    res.json({ ok: true, removed, annuals, errors });
  });

  app.patch('/api/monitor/series/:id', requireAdmin, (req, res) => {
    const { status, series_type, directory, locg_series_id } = req.body;
    if (series_type !== undefined) {
      if (!['comic', 'manga'].includes(series_type)) return res.status(400).json({ error: 'series_type must be comic or manga' });
      db.prepare('UPDATE monitored_series SET series_type = ? WHERE id = ?').run(series_type, req.params.id);
    }
    if (status !== undefined) {
      db.prepare('UPDATE monitored_series SET status = ? WHERE id = ?').run(status, req.params.id);
    }
    if (directory !== undefined) {
      // Used to disambiguate same-name same-year series (e.g. two "Old Man
      // Logan (2016)" volumes — V Wars / V2). Validates the path is non-empty
      // and not already taken by another monitored series, but does NOT
      // create the folder on disk or move existing files. The user is
      // responsible for putting files at the new path; clicking Refresh
      // afterwards rescans.
      const trimmed = String(directory).trim();
      if (!trimmed) return res.status(400).json({ error: 'directory cannot be empty' });
      // A series may share its folder with its own linked annual volumes and
      // special series (they're stored in the parent's folder by design). Only an
      // unrelated series in the same folder is a conflict.
      const self = db.prepare('SELECT id, parent_series_id FROM monitored_series WHERE id = ?').get(req.params.id);
      const related = new Set([
        ...db.prepare('SELECT annual_series_id AS id FROM series_annual_links WHERE parent_series_id = ?').all(req.params.id).map(r => String(r.id)),
        ...db.prepare('SELECT parent_series_id AS id FROM series_annual_links WHERE annual_series_id = ?').all(req.params.id).map(r => String(r.id)),
        ...db.prepare('SELECT id FROM monitored_series WHERE parent_series_id = ?').all(req.params.id).map(r => String(r.id)),
        ...(self?.parent_series_id ? [String(self.parent_series_id)] : []),
      ]);
      const collision = db.prepare(
        'SELECT id, name FROM monitored_series WHERE directory = ? AND id != ?'
      ).all(trimmed, req.params.id).find(r => !related.has(String(r.id)));
      if (collision) {
        return res.status(409).json({
          error: `Directory already used by monitored series: ${collision.name}`,
          conflictingId: collision.id,
        });
      }
      db.prepare('UPDATE monitored_series SET directory = ? WHERE id = ?').run(trimmed, req.params.id);
      invalidateDirectoryExistsCache(req.params.id);
      invalidateSeriesJsonCache(req.params.id);  // new dir may or may not have series.json
      logger.info('series', `Series ${req.params.id} directory updated`, { directory: trimmed });
    }
    if (locg_series_id !== undefined) {
      // Manual LOCG series ID override — parse from full URL or bare ID
      // Accepts: "154909", "https://leagueofcomicgeeks.com/comics/series/154909/batman-superman-worlds-finest"
      const urlMatch = String(locg_series_id).match(/\/comics\/series\/(\d+)\/([^/?]+)/);
      const bareId   = String(locg_series_id).match(/^(\d+)$/);
      if (urlMatch) {
        db.prepare('UPDATE monitored_series SET locg_series_id = ?, locg_series_slug = ? WHERE id = ?')
          .run(urlMatch[1], urlMatch[2], req.params.id);
        logger.info('series', `Series ${req.params.id} LOCG series ID set manually`, { locg_series_id: urlMatch[1] });
      } else if (bareId) {
        db.prepare('UPDATE monitored_series SET locg_series_id = ?, locg_series_slug = ? WHERE id = ?')
          .run(bareId[1], null, req.params.id);
      } else if (locg_series_id === '' || locg_series_id === null) {
        db.prepare('UPDATE monitored_series SET locg_series_id = NULL, locg_series_slug = NULL WHERE id = ?')
          .run(req.params.id);
      } else {
        return res.status(400).json({ error: 'locg_series_id must be a numeric ID or full LOCG series URL' });
      }
    }
    res.json({ success: true });
  });
  return { detectSeriesType, invalidateDirectoryExistsCache, invalidateSeriesJsonCache, removeMonitoredSeriesRows };
};
