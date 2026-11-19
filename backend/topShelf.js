'use strict';
// ─── Top Shelf (moved out of server.js 2026-11-19, server.js split step 2) ───────
// The Top Shelf routes: runs (list, shelf, one run, create, edit, recommend, delete), their
// issues (add, batch, match, remove), Comic Vine resolution (resolveCanonRun; auto-resolve and
// the volume/issue link override), the Eisner import, award-note backfill, de-duplication, the
// JSON import, and GET /api/canon/creators (Notable Creators, with background photo lookups).
// Moved unchanged. The run generator is canonGenerator.js; categories are canonCategories.js.
const fs = require('fs');
const path = require('path');
const IN = require('./issueNumber');
const runOrder = require('./runOrder');
const canonResolve = require('./canonResolve');
const { nameKey } = require('./names');
const { usableImage, verifiedPersonPhoto } = require('./personPhotos');

module.exports.registerTopShelf = function registerTopShelf(deps) {
  const missing = ['app', 'bookCvId', 'cvApiGet', 'db', 'getCVKey', 'getSeriesAwards', 'logger', 'parseComicInfo', 'personPhotos', 'requireAdmin', 'requireAuth', 'tidyBadge'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerTopShelf: missing ${missing.join(', ')}`);
  const { app, bookCvId, cvApiGet, db, getCVKey, getSeriesAwards, logger, parseComicInfo, personPhotos, requireAdmin, requireAuth, tidyBadge } = deps;

  let creatorPhotosRunning = false;

  // GET /api/canon/creators
  // Returns distinct writers/pencilers from approved canon runs,
  // with cached CV person images. Triggers background image fetch
  // for any creators missing images.
  app.get('/api/canon/creators', requireAuth, async (req, res) => {
    try {
      // Get distinct writers and pencilers from approved runs
      const rows = db.prepare(`
        SELECT crc.person_name, crc.role, COUNT(DISTINCT crc.run_id) as run_count
        FROM canon_run_creators crc
        JOIN canon_runs cr ON cr.id = crc.run_id
        JOIN canon_run_categories cat ON cat.run_id = cr.id
        WHERE cr.status = 'approved'
          AND crc.role IN ('writer', 'penciler', 'penciller')
        GROUP BY lower(crc.person_name)
        ORDER BY run_count DESC, crc.person_name ASC
      `).all();

      // Look up cached images
      const withImages = rows.map(r => {
        const cached = db.prepare(
          "SELECT image_url, cv_person_id FROM cv_person_cache WHERE name = ?"
        ).get(r.person_name.toLowerCase());
        return {
          name:        r.person_name,
          role:        r.role,
          run_count:   r.run_count,
          image_url:   usableImage(cached?.image_url) || verifiedPersonPhoto(r.person_name)?.image_url || null,
          cv_person_id: cached?.cv_person_id || verifiedPersonPhoto(r.person_name)?.cv_person_id || null,
        };
      });

      // Respond immediately — don't block on image fetching
      res.json(withImages);

      // One batch at a time; the shared resolver deduplicates lookups and respects
      // negative-cache TTLs, transient-error cooldowns, and the global CV budget.
      const missing = withImages.filter(c => !c.image_url);
      if (missing.length && !creatorPhotosRunning && getCVKey()) {
        creatorPhotosRunning = true;
        setImmediate(async () => {
          try {
            for (const creator of missing) {
              try { await personPhotos.resolve(creator.name); }
              catch (e) { logger.warn('canon', 'Person image fetch failed for ' + creator.name, e.message); }
            }
          } finally { creatorPhotosRunning = false; }
        });
      }
    } catch (e) {
      logger.error('canon', 'Canon creators failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Canon Runs API ───────────────────────────────────────────────

  // Helper: attach categories, creators, and issue counts to run rows
  function enrichCanonRuns(runs) {
    return runs.map(run => {
      const categories = db.prepare(
        'SELECT category, adaptation_notes FROM canon_run_categories WHERE run_id = ? ORDER BY category'
      ).all(run.id);
      const creators = db.prepare(
        'SELECT person_name, role FROM canon_run_creators WHERE run_id = ? ORDER BY role, person_name'
      ).all(run.id);
      const issueCounts = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN scanned_book_id IS NOT NULL THEN 1 ELSE 0 END) as owned
        FROM canon_run_issues WHERE run_id = ?
      `).get(run.id);
      const coverIssue = db.prepare(
        'SELECT scanned_book_id FROM canon_run_issues WHERE run_id = ? AND scanned_book_id IS NOT NULL ORDER BY sort_order ASC LIMIT 1'
      ).get(run.id);
      const event = run.event_id
        ? db.prepare('SELECT id, name, cover_image FROM events WHERE id = ?').get(run.event_id)
        : null;

      // Award lookup — try title, parent_series, and cv_volume_id match
      let awards = [];
      const titlesToTry = [
        run.title,
        run.parent_series,
        // Strip character prefixes: "Batman: Year One" → "Year One"
        run.title ? run.title.replace(/^[^:]+:\s*/, '') : null,
      ].filter(Boolean);

      const seen = new Set();
      for (const t of titlesToTry) {
        const rows = getSeriesAwards(t, { all: true });
        for (const row of rows) {
          const key = `${row.award}|${row.year}|${row.category}`;
          if (!seen.has(key)) { seen.add(key); awards.push(row); }
        }
      }

      // Also match by cv_volume_id if award_data has one
      if (run.cv_volume_id) {
        const cvRows = db.prepare(
          'SELECT award, year, category, winner, cv_volume_id FROM award_data WHERE cv_volume_id = ? AND winner = 1'
        ).all(run.cv_volume_id);
        for (const row of cvRows) {
          const key = `${row.award}|${row.year}|${row.category}`;
          if (!seen.has(key)) { seen.add(key); awards.push(row); }
        }
      }

      // Only keep winners, sort by year desc
      awards = awards.filter(a => a.winner == 1).sort((a, b) => b.year - a.year);

      // No matched issue of its own: a run linked to a Timeline event borrows the
      // event's first owned issue as its cover.
      let coverBookId = coverIssue?.scanned_book_id || null;
      if (!coverBookId && event) {
        coverBookId = db.prepare(`SELECT scanned_book_id FROM event_issues WHERE event_id = ? AND scanned_book_id IS NOT NULL
          ORDER BY CASE tier WHEN 'essential' THEN 0 WHEN 'recommended' THEN 1 ELSE 2 END, sort_order LIMIT 1`).get(event.id)?.scanned_book_id || null;
      }
      return { ...run, categories, creators, issueCounts, coverBookId, event, awards };
    });
  }

  // GET /api/canon/runs — list runs (with optional category + status filters)
  // category=recommended is a special case — filters by admin_recommended flag
  // rather than a canon_run_categories entry.
  app.get('/api/canon/runs', requireAuth, (req, res) => {
    try {
      const { category, status } = req.query;
      let sql = 'SELECT DISTINCT cr.* FROM canon_runs cr';
      const params = [];
      if (category === 'recommended') {
        sql += ' WHERE cr.admin_recommended = 1';
        if (status) { sql += ' AND cr.status = ?'; params.push(status); }
        else { sql += " AND cr.status = 'approved'"; }
      } else {
        if (category) {
          sql += ' JOIN canon_run_categories crc ON crc.run_id = cr.id AND crc.category = ?';
          params.push(category);
        }
        sql += ' WHERE 1=1';
        if (status) { sql += ' AND cr.status = ?'; params.push(status); }
        else { sql += " AND cr.status = 'approved'"; }
      }
      sql += ' ORDER BY cr.title ASC';
      const runs = db.prepare(sql).all(...params);
      res.json(enrichCanonRuns(runs));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/canon/runs/shelf — grouped by category for the shelf page
  app.get('/api/canon/runs/shelf', requireAuth, (req, res) => {
    try {
      const categories = ['adapted_to_screen', 'award_winning', 'critically_acclaimed'];
      const shelf = {};
      for (const cat of categories) {
        const runs = db.prepare(`
          SELECT DISTINCT cr.* FROM canon_runs cr
          JOIN canon_run_categories crc ON crc.run_id = cr.id
          WHERE crc.category = ? AND cr.status = 'approved'
          ORDER BY cr.title ASC
        `).all(cat);
        shelf[cat] = enrichCanonRuns(runs);
      }
      // Admin-recommended runs — shown as a dedicated shelf regardless of category
      const recommended = db.prepare(`
        SELECT * FROM canon_runs WHERE admin_recommended = 1 AND status = 'approved' ORDER BY title ASC
      `).all();
      shelf.recommended = enrichCanonRuns(recommended);
      res.json(shelf);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/canon/runs/:id — single run with full issue list
  app.get('/api/canon/runs/:id', requireAuth, (req, res) => {
    try {
      const run = db.prepare('SELECT * FROM canon_runs WHERE id = ?').get(req.params.id);
      if (!run) return res.status(404).json({ error: 'Not found' });
      const [enriched] = enrichCanonRuns([run]);
      const issues = require('./runReading').getRunIssues(db, req.params.id, req.user?.sub, parseComicInfo);
      const publisher = require('./runPublisher').getRunPublisher(db, run, parseComicInfo);
      res.json({ ...enriched, issues, publisher });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/canon/runs — create a run
  app.post('/api/canon/runs', requireAdmin, (req, res) => {
    const { title, parent_series, cv_volume_id, issue_range_hint, description, status, categories, creators } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    try {
      const info = db.prepare(`
        INSERT INTO canon_runs (title, parent_series, cv_volume_id, issue_range_hint, description, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(title, parent_series || null, cv_volume_id || null, issue_range_hint || null, description || null, status || 'pending');
      const runId = info.lastInsertRowid;
      if (Array.isArray(categories)) {
        for (const { category, adaptation_notes } of categories) {
          if (category) db.prepare('INSERT OR IGNORE INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?, ?, ?)').run(runId, category, adaptation_notes || null);
        }
      }
      if (Array.isArray(creators)) {
        for (const { person_name, role } of creators) {
          if (person_name) db.prepare('INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (?, ?, ?)').run(runId, person_name, role || 'writer');
        }
      }
      res.json({ success: true, id: runId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/canon/runs/:id — update run metadata + status
  app.put('/api/canon/runs/:id', requireAdmin, (req, res) => {
    const { title, parent_series, cv_volume_id, issue_range_hint, description, status, categories, creators } = req.body;
    if (req.body?.event_id && !db.prepare('SELECT 1 FROM events WHERE id = ?').get(String(req.body.event_id))) {
      return res.status(400).json({ error: 'That Timeline event no longer exists' });
    }
    try {
      db.prepare(`
        UPDATE canon_runs SET title=?, parent_series=?, cv_volume_id=?, issue_range_hint=?,
          description=?, status=?, updated_at=datetime('now') WHERE id=?
      `).run(title, parent_series || null, cv_volume_id || null, issue_range_hint || null, description || null, status || 'pending', req.params.id);
      // Linked Timeline event: set, change or clear (null). Only when sent.
      if (Object.prototype.hasOwnProperty.call(req.body, 'event_id')) {
        const eid = req.body.event_id ? String(req.body.event_id) : null;
        db.prepare('UPDATE canon_runs SET event_id = ? WHERE id = ?').run(eid, req.params.id);
      }
      if (Array.isArray(categories)) {
        db.prepare('DELETE FROM canon_run_categories WHERE run_id = ?').run(req.params.id);
        for (const { category, adaptation_notes } of categories) {
          if (category) db.prepare('INSERT OR IGNORE INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?, ?, ?)').run(req.params.id, category, adaptation_notes || null);
        }
      }
      if (Array.isArray(creators)) {
        db.prepare('DELETE FROM canon_run_creators WHERE run_id = ?').run(req.params.id);
        for (const { person_name, role } of creators) {
          if (person_name) db.prepare('INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (?, ?, ?)').run(req.params.id, person_name, role || 'writer');
        }
      }
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /api/canon/runs/:id/recommend — toggle admin_recommended on/off
  app.patch('/api/canon/runs/:id/recommend', requireAdmin, (req, res) => {
    try {
      const run = db.prepare('SELECT id, admin_recommended FROM canon_runs WHERE id = ?').get(req.params.id);
      if (!run) return res.status(404).json({ error: 'Not found' });
      const newVal = run.admin_recommended ? 0 : 1;
      db.prepare("UPDATE canon_runs SET admin_recommended = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newVal, req.params.id);
      logger.info('canon', `Run ${req.params.id} admin_recommended → ${newVal}`);
      res.json({ success: true, admin_recommended: newVal });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/canon/runs/:id
  app.delete('/api/canon/runs/:id', requireAdmin, (req, res) => {
    try {
      db.prepare('DELETE FROM canon_runs WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/canon/runs/:id/issues/batch — add multiple issues in one transaction
  app.post('/api/canon/runs/:id/issues/batch', requireAdmin, (req, res) => {
    const { issues } = req.body || {};
    if (!Array.isArray(issues) || !issues.length) return res.status(400).json({ error: 'issues array required' });
    try {
      const runId = req.params.id;
      let maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM canon_run_issues WHERE run_id = ?').get(runId)?.m || 0;

      const insert = db.prepare(`
        INSERT OR IGNORE INTO canon_run_issues (run_id, cv_issue_id, scanned_book_id, sort_order, series_name, issue_number, volume_year, manually_matched)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // INSERT OR IGNORE needs a unique constraint to work — use cv_issue_id when available,
      // otherwise check manually to avoid duplicate series+issue combos
      const existsByCv   = db.prepare('SELECT 1 FROM canon_run_issues WHERE run_id = ? AND cv_issue_id = ?');
      const existsByNum  = db.prepare('SELECT 1 FROM canon_run_issues WHERE run_id = ? AND series_name = ? AND issue_number = ?');

      let added = 0, skipped = 0;
      const doAll = db.transaction(() => {
        for (const issue of issues) {
          if (!issue.series_name || !issue.issue_number) continue;
          // Resolve CV id from scanned book if not provided
          let cvId = issue.cv_issue_id || null;
          if (issue.scanned_book_id && !cvId) {
            const book = db.prepare('SELECT cv_issue_id FROM scanned_books WHERE id = ?').get(issue.scanned_book_id);
            cvId = book?.cv_issue_id || null;
          }
          // Skip if already in run
          if (cvId && existsByCv.get(runId, cvId)) { skipped++; continue; }
          if (!cvId && existsByNum.get(runId, issue.series_name, issue.issue_number)) { skipped++; continue; }

          const info = insert.run(runId, cvId, issue.scanned_book_id || null, ++maxOrder,
            issue.series_name, issue.issue_number, issue.volume_year || null,
            issue.scanned_book_id ? 1 : 0);
          if (info.changes) newIds.push(Number(info.lastInsertRowid));
          added++;
        }
        runOrder.placeNew(db, Number(runId), newIds);   // in by number, not at the end
      });
      const newIds = [];
      doAll();
      res.json({ success: true, added, skipped });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/canon/runs/:id/issues — add an issue to a run
  app.post('/api/canon/runs/:id/issues', requireAdmin, (req, res) => {
    const { scanned_book_id, series_name, issue_number, volume_year, cv_issue_id } = req.body;
    if (!series_name || !issue_number) return res.status(400).json({ error: 'series_name and issue_number required' });
    try {
      const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM canon_run_issues WHERE run_id = ?').get(req.params.id)?.m || 0;
      let resolvedCvId = cv_issue_id || null;
      let resolvedBookId = scanned_book_id || null;
      if (resolvedBookId && !resolvedCvId) {
        const book = db.prepare('SELECT cv_issue_id FROM scanned_books WHERE id = ?').get(resolvedBookId);
        resolvedCvId = book?.cv_issue_id || null;
      }
      const info = db.prepare(`
        INSERT INTO canon_run_issues (run_id, cv_issue_id, scanned_book_id, sort_order, series_name, issue_number, volume_year, manually_matched)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, resolvedCvId, resolvedBookId, maxOrder + 1, series_name, issue_number, volume_year || null, resolvedBookId ? 1 : 0);
      runOrder.placeNew(db, Number(req.params.id), [Number(info.lastInsertRowid)]);   // in by number, not at the end
      res.json({ success: true, id: info.lastInsertRowid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/canon/runs/:id/issues/:issueId/match — manual match a scanned book to an issue
  app.put('/api/canon/runs/:id/issues/:issueId/match', requireAdmin, (req, res) => {
    const { scanned_book_id, syncCv } = req.body;   // syncCv: see the event match route
    try {
      const result = db.prepare(
        'UPDATE canon_run_issues SET scanned_book_id = ?, manually_matched = ? WHERE id = ? AND run_id = ?'
      ).run(scanned_book_id || null, scanned_book_id ? 1 : 0, req.params.issueId, req.params.id);
      if (result.changes === 0) return res.status(404).json({ error: 'Issue not found' });
      const cv = syncCv && scanned_book_id ? bookCvId(scanned_book_id) : null;
      if (cv) db.prepare('UPDATE canon_run_issues SET cv_issue_id = ? WHERE id = ? AND run_id = ?').run(String(cv), req.params.issueId, req.params.id);
      res.json({ success: true, cv_issue_id: cv });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/canon/runs/:id/issues/:issueId
  app.delete('/api/canon/runs/:id/issues/:issueId', requireAdmin, (req, res) => {
    try {
      db.prepare('DELETE FROM canon_run_issues WHERE id = ? AND run_id = ?').run(req.params.issueId, req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Canon: shared CV resolution helpers ─────────────────────────

  // Parse the volume start year from an issue range hint.
  // "#404-407 (1940 vol)" → 1940
  // "#1-13 (1996)"        → 1996
  // "One-shot (1988)"     → 1988
  // "#16-20 (1991 vol)"   → 1991
  function parseYearFromHint(hint) {
    if (!hint) return null;
    // Look for a 4-digit year in parentheses
    const m = hint.match(/\((\d{4})/);
    return m ? parseInt(m[1]) : null;
  }

  // Parse issue number range from hint.
  // Returns { start, end } — both may be null if unparseable.
  function parseIssueRange(hint) {
    if (!hint) return { start: null, end: null };
    // Strip year/vol annotations first
    const stripped = hint.replace(/\(\d{4}[^)]*\)/g, '').replace(/\bvol\b/gi, '');
    const nums = stripped.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    // Filter out 4-digit numbers that slipped through
    const issueNums = nums.filter(n => n < 2000);
    if (issueNums.length === 0) return { start: null, end: null };
    if (issueNums.length === 1) return { start: issueNums[0], end: issueNums[0] };
    return { start: issueNums[0], end: issueNums[issueNums.length - 1] };
  }

  // Resolve a single canon run: find CV volume, fetch issues in range, match to library.
  // clearExisting: if true, removes non-manually-matched issues before repopulating.
  //   Use this when correcting a wrong volume (CV URL override).
  //   Leave false for auto-resolve on import (additive, skip if already populated).
  // dryRun (editor Rebuild preview, editorTools.js): nothing is written; returns the plan.
  // volumeId: use this Comic Vine volume ('' = search again) instead of the stored one.
  // The last Auto-resolve result per run since the server started (Top Shelf's Pending review shows it).
  const canonResolveResults = new Map();
  async function resolveCanonRun(runId, { clearExisting = false, dryRun = false, volumeId } = {}) {
    const run = db.prepare('SELECT * FROM canon_runs WHERE id = ?').get(runId);
    if (!run) return { error: 'Run not found' };

    const CV_API_KEY = getCVKey();
    if (!CV_API_KEY) return { error: 'No CV API key configured' };

    const hintYear  = parseYearFromHint(run.issue_range_hint);
    // Each piece of the note counts ("#1, #3, #5"; "#635-641, #645-650"); start/end
    // (lowest and highest) keep the routing below exactly as before.
    const issueSpec = canonResolve.parseIssueSpec(run.issue_range_hint);
    const rangeStart = issueSpec.start, rangeEnd = issueSpec.end;
    // "(2016 vol)" names the volume's start year: match it within a year, never relaxed.
    const explicitVol = !!issueSpec.volumeYear;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Determine routing
    const hint        = (run.issue_range_hint || '').toLowerCase();
    const isOneShot   = hint.includes('one-shot') || hint.includes('one shot') ||
                        (rangeStart !== null && rangeStart === rangeEnd);
    const isMultiRange = rangeStart !== null && rangeEnd !== null && rangeEnd > rangeStart;
    const hasParentSeries = !!(run.parent_series && run.parent_series.trim() &&
                                run.parent_series.trim().toLowerCase() !== run.title.trim().toLowerCase());

    // Route A: parent series with multi-issue range → skip title search
    const skipTitleSearch = hasParentSeries && isMultiRange;

    try {
      let cvVolumeId     = volumeId !== undefined ? (volumeId ? String(volumeId) : null) : (run.cv_volume_id || null);
      let isLimitedMatch = false;
      let volInfo = null;   // the volume found by a search (for the preview)

      // A library folder of the parent series with that start year already knows
      // its Comic Vine volume (series.json): use it before searching Comic Vine.
      if (!cvVolumeId && hasParentSeries && explicitVol) {
        const libVol = canonResolve.libraryVolume(db, run.parent_series, issueSpec.volumeYear);
        if (libVol) {
          cvVolumeId = libVol;
          volInfo = { source: 'library', name: run.parent_series, start_year: issueSpec.volumeYear };
          if (!dryRun) db.prepare('UPDATE canon_runs SET cv_volume_id = ? WHERE id = ?').run(cvVolumeId, runId);
          logger.info('canon', `resolveCanonRun ${runId}: library folder "${run.parent_series} (${issueSpec.volumeYear})" → CV volume ${cvVolumeId}`);
        }
      }

      if (!cvVolumeId) {
        // ── Title search (routes B and C) ─────────────────────────
        if (!skipTitleSearch) {
          const strippedTitle = (run.title || '')
            .replace(/^(Batman|Superman|Spider-Man|Daredevil|X-Men|Avengers|Wonder Woman|Flash|Green Lantern|Iron Man|Captain America|Thor|Hulk|Wolverine|Black Panther|Aquaman):\s*/i, '')
            .replace(/[^a-z0-9 ]/gi, '').trim();
          const fullTitle = (run.title || '').replace(/[^a-z0-9 ]/gi, '').trim();

          // Search both stripped and full title, combine and deduplicate results
          const titleSearchNames = [...new Set([strippedTitle, fullTitle].filter(s => s.length >= 3))];
          const titleResultMap = new Map();

          for (const searchName of titleSearchNames) {
            await sleep(300);
            const titleData = await cvApiGet('https://comicvine.gamespot.com/api/volumes/', {
              params: {
                api_key: CV_API_KEY, format: 'json',
                filter: `name:${searchName}`,
                field_list: 'id,name,start_year,count_of_issues',
                limit: 10,
              },
              headers: { 'User-Agent': 'Omnibus/1.0' },
              timeout: 15000,
            });
            for (const v of (titleData.data.results || [])) {
              titleResultMap.set(String(v.id), v);
            }
          }

          const titleResults = [...titleResultMap.values()];
          const normStripped = strippedTitle.toLowerCase();
          const normFull     = fullTitle.toLowerCase();

          // Find all exact name matches, then pick best by issue count
          const exactMatches = titleResults.filter(v => {
            const vNorm = (v.name || '').replace(/[^a-z0-9 ]/gi, '').toLowerCase().trim();
            return vNorm === normStripped || vNorm === normFull;
          });

          // For multi-issue ranges, prefer the volume with the most issues (avoids TPBs).
          // For one-shots, prefer the volume with fewest issues (the original, not a collected run).
          let candidate = null;
          if (exactMatches.length > 0) {
            candidate = isMultiRange
              ? exactMatches.reduce((best, v) => (v.count_of_issues || 0) > (best.count_of_issues || 0) ? v : best)
              : exactMatches.reduce((best, v) => (v.count_of_issues || 0) < (best.count_of_issues || 0) ? v : best);
          }

          if (candidate) {
            const vYear    = candidate.start_year ? parseInt(candidate.start_year) : null;
            const yearOk   = !hintYear || !vYear || Math.abs(vYear - hintYear) <= (explicitVol ? 1 : 10);
            const issCount = candidate.count_of_issues || 0;
            const tpbRejected = isMultiRange && issCount <= 2;

            if (yearOk && !tpbRejected) {
              cvVolumeId     = String(candidate.id);
              isLimitedMatch = true;
              volInfo = { source: 'title', name: candidate.name, start_year: candidate.start_year, count: issCount };
              if (!dryRun) db.prepare('UPDATE canon_runs SET cv_volume_id = ? WHERE id = ?').run(cvVolumeId, runId);
              logger.info('canon', `resolveCanonRun ${runId}: title match "${run.title}" → CV volume ${cvVolumeId} (${candidate.name}, ${candidate.start_year}, ${issCount} issues)`);
            } else if (tpbRejected) {
              logger.info('canon', `resolveCanonRun ${runId}: title match "${candidate.name}" rejected — likely TPB (${issCount} issues, multi-issue range expected)`);
            }
          }
        }

        // ── Parent series search (route A, or fallback from B/C) ───
        if (!cvVolumeId) {
          const seriesName = run.parent_series || run.title;
          if (!seriesName) {
            logger.warn('canon', `resolveCanonRun ${runId}: no series name to search`);
            return { skipped: true, reason: 'no series name', runId };
          }

          // Strip leading character prefixes — but also try full name
          const strippedSeries = seriesName
            .replace(/^(Batman|Superman|Spider-Man|Daredevil|X-Men|Avengers|Wonder Woman|Flash|Green Lantern|Iron Man|Captain America|Thor|Hulk|Wolverine|Black Panther|Aquaman):\s*/i, '')
            .trim();

          // Search both stripped and full name, combine and deduplicate
          const parentSearchNames = [...new Set([strippedSeries, seriesName].filter(s => s.trim().length >= 2))];
          const parentResultMap = new Map();

          for (const name of parentSearchNames) {
            const normSearch = name.replace(/[^a-z0-9 ]/gi, '').trim();
            await sleep(300);
            const volData = await cvApiGet('https://comicvine.gamespot.com/api/volumes/', {
              params: {
                api_key: CV_API_KEY, format: 'json',
                filter: `name:${normSearch}`,
                field_list: 'id,name,start_year,count_of_issues',
                limit: 100,   // was 20: popular names (Wonder Woman) left the right volume out
              },
              headers: { 'User-Agent': 'Omnibus/1.0' },
              timeout: 15000,
            });
            for (const v of (volData.data.results || [])) {
              parentResultMap.set(String(v.id), v);
            }
          }

          const results = [...parentResultMap.values()];
          if (results.length === 0) {
            logger.info('canon', `resolveCanonRun ${runId}: no CV volumes found for "${seriesName}"`);
            return { skipped: true, reason: 'no volumes found', runId };
          }

          logger.info('canon', `resolveCanonRun ${runId}: parent series search for "${seriesName}" → ${results.length} combined results`);

          const normForScoring = strippedSeries.replace(/[^a-z0-9 ]/gi, '').toLowerCase().trim();

          const normForScoringFull = seriesName.replace(/[^a-z0-9 ]/gi, '').toLowerCase().trim();

          const scoreVolume = (v, strict = true) => {
            const vNorm = (v.name || '').replace(/[^a-z0-9 ]/gi, '').toLowerCase().trim();
            // Check against both stripped and full name — pick the better match
            const matchStripped = vNorm === normForScoring ? 2 : (vNorm.includes(normForScoring) || normForScoring.includes(vNorm) ? 1 : 0);
            const matchFull     = vNorm === normForScoringFull ? 2 : (vNorm.includes(normForScoringFull) || normForScoringFull.includes(vNorm) ? 1 : 0);
            const nameMatch = Math.max(matchStripped, matchFull);
            if (nameMatch === 0) return -Infinity;
            const vYear = v.start_year ? parseInt(v.start_year) : null;
            if (hintYear && vYear) {
              const diff = Math.abs(vYear - hintYear);
              if (explicitVol && diff > 1) return -Infinity;   // "(YYYY vol)": that volume or none
              if (strict && diff > 5) return -Infinity;
              if (!strict && diff > 15) return -Infinity;
              return nameMatch * 100 - diff;
            }
            return nameMatch * 100 + (v.count_of_issues || 0) * 0.01;
          };

          const findBest = (strict) => results.reduce((b, v) => {
            const s = scoreVolume(v, strict);
            return s > scoreVolume(b || { name: '', start_year: null, count_of_issues: 0 }, strict) ? v : b;
          }, null);

          let best = findBest(true);
          if ((!best || scoreVolume(best, true) === -Infinity) && !explicitVol) {
            logger.info('canon', `resolveCanonRun ${runId}: strict year filter found nothing for "${seriesName}" (${hintYear}), relaxing`);
            best = findBest(false);
          }
          if (!best || scoreVolume(best, false) === -Infinity) {
            logger.info('canon', `resolveCanonRun ${runId}: no good volume match for "${seriesName}"`);
            return { skipped: true, reason: 'no matching volume', runId };
          }

          cvVolumeId = String(best.id);
          volInfo = { source: 'series', name: best.name, start_year: best.start_year, count: best.count_of_issues };
          if (!dryRun) db.prepare('UPDATE canon_runs SET cv_volume_id = ? WHERE id = ?').run(cvVolumeId, runId);
          logger.info('canon', `resolveCanonRun ${runId}: series match "${seriesName}" → CV volume ${cvVolumeId} (${best.name}, ${best.start_year})`);
        }
      }

      // ── Fetch all issues for the volume ──────────────────────────
      // If this is a corrective override, wipe non-manual issues first
      if (clearExisting && !dryRun) {
        const cleared = db.prepare(
          'DELETE FROM canon_run_issues WHERE run_id = ? AND manually_matched = 0'
        ).run(runId);
        if (cleared.changes > 0) {
          logger.info('canon', `resolveCanonRun ${runId}: cleared ${cleared.changes} auto-matched issues before re-resolve`);
        }
      }

      await sleep(300);
      let offset = 0, allIssues = [];
      while (true) {
        const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
          params: {
            api_key: CV_API_KEY, format: 'json',
            filter: `volume:${cvVolumeId}`,
            field_list: 'id,issue_number,name,cover_date,volume',
            offset, limit: 100,
          },
          headers: { 'User-Agent': 'Omnibus/1.0' },
          timeout: 15000,
        });
        const batch = r.data.results || [];
        allIssues = allIssues.concat(batch);
        if (allIssues.length >= (r.data.number_of_total_results || 0)) break;
        offset += 100;
        await sleep(500);
      }

      // ── Filter to range ───────────────────────────────────────────
      // Always apply range filter when a numeric multi-issue range is specified.
      // isLimitedMatch only skips filtering for true one-shots (no range) or
      // when the volume IS the complete run (isOneShot). Anthology series like
      // LOTDK still need range filtering even when found via title match.
      let filtered = allIssues;
      if (rangeStart !== null && (!isLimitedMatch || isMultiRange)) {
        // Each piece of the note; ranges take whole numbers (canonResolve.js).
        filtered = allIssues.filter(i => canonResolve.specIncludes(issueSpec, i.issue_number));
      }

      logger.info('canon', `resolveCanonRun ${runId}: ${allIssues.length} total, ${filtered.length} kept, isLimitedMatch=${isLimitedMatch}, route=${skipTitleSearch ? 'A-parent' : isLimitedMatch ? 'B/C-title' : 'B/C-fallback'}`);

      // ── Insert canon_run_issues, match library ────────────────────
      const existing = new Set(
        db.prepare(`SELECT cv_issue_id FROM canon_run_issues WHERE run_id = ? AND cv_issue_id IS NOT NULL${dryRun && clearExisting ? ' AND manually_matched = 1' : ''}`)
          .all(runId).map(r => String(r.cv_issue_id))
      );

      // Rebuild (clearExisting): a hand-matched issue keeps its file, but when the rebuilt list has the same
      // issue number from the (new) volume, the hand-matched row takes that Comic Vine issue instead of a
      // second row being added (user 2026-10-18: Aquaman: The Trench came back with every issue twice).
      const inVolume = new Set(filtered.map(i => String(i.id)));
      const handByNum = new Map();
      if (clearExisting) {
        for (const r of db.prepare('SELECT id, cv_issue_id, issue_number FROM canon_run_issues WHERE run_id = ? AND manually_matched = 1').all(runId)) {
          if (r.cv_issue_id && inVolume.has(String(r.cv_issue_id))) continue;   // already this volume's issue
          const k = IN.normIssueNumber(r.issue_number);
          if (k != null && !handByNum.has(k)) handByNum.set(k, r);
        }
      }

      if (dryRun) {
        const bookOf = db.prepare('SELECT id FROM scanned_books WHERE cv_issue_id = ?');
        let merged = 0;
        const issues = filtered.filter(i => !existing.has(String(i.id))).map(i => {
          const hand = handByNum.get(IN.normIssueNumber(i.issue_number));
          if (hand) merged++;
          return { cv_issue_id: String(i.id), issue_number: i.issue_number || '0', issue_title: i.name || null, cover_date: i.cover_date || null,
            series_name: i.volume?.name || run.parent_series || run.title, book_id: bookOf.get(String(i.id))?.id || null, ...(hand ? { mergesHand: true } : {}) };
        });
        return { dryRun: true, runId, cvVolumeId, volume: volInfo || { source: 'stored', name: allIssues[0]?.volume?.name || null },
          route: skipTitleSearch ? 'parent' : isLimitedMatch ? 'title' : 'fallback', total: allIssues.length, inRange: filtered.length, kept: existing.size - merged, merged, issues };
      }

      const insertIssue = db.prepare(`
        INSERT INTO canon_run_issues (run_id, cv_issue_id, scanned_book_id, sort_order, series_name, issue_number, volume_year, manually_matched)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `);

      let inserted = 0, matched = 0, skipped = 0, mergedHand = 0;
      const newIds = [];
      const mergeHand = db.prepare('UPDATE canon_run_issues SET cv_issue_id = ?, series_name = ?, volume_year = ? WHERE id = ?');
      db.transaction(issues => {
        for (const issue of issues) {
          const cvId = String(issue.id);
          if (existing.has(cvId)) { skipped++; continue; }
          const hand = handByNum.get(IN.normIssueNumber(issue.issue_number));
          if (hand) {   // same number as a hand match: that row takes this issue, keeping its file
            handByNum.delete(IN.normIssueNumber(issue.issue_number));
            mergeHand.run(cvId, issue.volume?.name || run.parent_series || run.title, issue.volume?.start_year ? String(issue.volume.start_year) : (hintYear ? String(hintYear) : null), hand.id);
            mergedHand++; continue;
          }
          const book          = db.prepare('SELECT id FROM scanned_books WHERE cv_issue_id = ?').get(cvId);
          const scannedBookId = book?.id || null;
          if (scannedBookId) matched++;
          const maxOrder   = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM canon_run_issues WHERE run_id = ?').get(runId)?.m || 0;
          const seriesName = issue.volume?.name || run.parent_series || run.title;
          const volYear    = issue.volume?.start_year ? String(issue.volume.start_year) : (hintYear ? String(hintYear) : null);
          newIds.push(Number(insertIssue.run(runId, cvId, scannedBookId, maxOrder + 1, seriesName, issue.issue_number || '0', volYear).lastInsertRowid));
          inserted++;
        }
        runOrder.placeNew(db, Number(runId), newIds);   // in by number among any hand-matched issues kept
      })(filtered);

      logger.info('canon', `resolveCanonRun ${runId}: done`, { inserted, matched, skipped, mergedHand });
      return { success: true, runId, cvVolumeId, total: allIssues.length, inRange: filtered.length, inserted, matched, skipped, mergedHand };
    } catch (e) {
      logger.error('canon', `resolveCanonRun ${runId} failed`, e.message);
      return { error: e.message, runId };
    }
  }

  // ─── Canon: CV auto-resolution ────────────────────────────────────
  // POST /api/canon/runs/:id/resolve-cv
  app.post('/api/canon/runs/:id/resolve-cv', requireAdmin, async (req, res) => {
    const run = db.prepare('SELECT * FROM canon_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const result = await resolveCanonRun(req.params.id, { clearExisting: true });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  });

  // Top Shelf run generation: canonGenerator.js (moved 2026-11-10, server.js split).

  // ─── Canon: CV URL override — add by volume or issue URL ─────────
  // POST /api/canon/runs/:id/cv-url
  // Accepts a CV volume URL (4050-XXXXX) or issue URL (4000-XXXXX).
  // Volume → triggers full resolve flow for that volume.
  // Issue → adds that single issue directly.
  app.post('/api/canon/runs/:id/cv-url', requireAdmin, async (req, res) => {
    const { url } = req.body || {};
    if (!url?.trim()) return res.status(400).json({ error: 'url required' });

    const run = db.prepare('SELECT * FROM canon_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    // Detect volume (4050) vs issue (4000)
    const volumeMatch = url.match(/4050-(\d+)/i);
    const issueMatch  = url.match(/4000-(\d+)/i);

    if (volumeMatch) {
      // Set cv_volume_id and trigger full resolution, clearing any wrong issues first
      const cvVolumeId = volumeMatch[1];
      db.prepare('UPDATE canon_runs SET cv_volume_id = ? WHERE id = ?').run(cvVolumeId, req.params.id);
      const result = await resolveCanonRun(req.params.id, { clearExisting: true });
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json({ type: 'volume', ...result });
    }

    if (issueMatch) {
      // Fetch the single issue from CV and add it
      const cvIssueId = issueMatch[1];
      try {
        const CV_API_KEY = getCVKey();
        const r = await cvApiGet(`https://comicvine.gamespot.com/api/issue/4000-${cvIssueId}/`, {
          params: {
            api_key: CV_API_KEY, format: 'json',
            field_list: 'id,issue_number,name,cover_date,volume',
          },
          headers: { 'User-Agent': 'Omnibus/1.0' },
          timeout: 15000,
        });
        const issue = r.data.results;
        if (!issue?.id) return res.status(404).json({ error: 'Issue not found on Comic Vine' });

        // Check if already added
        const existing = db.prepare('SELECT id FROM canon_run_issues WHERE run_id = ? AND cv_issue_id = ?')
          .get(req.params.id, String(issue.id));
        if (existing) return res.status(409).json({ error: 'This issue is already in the run' });

        // Match to library
        const book = db.prepare('SELECT id FROM scanned_books WHERE cv_issue_id = ?').get(String(issue.id));
        const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM canon_run_issues WHERE run_id = ?')
          .get(req.params.id)?.m || 0;

        const added = db.prepare(`
          INSERT INTO canon_run_issues (run_id, cv_issue_id, scanned_book_id, sort_order, series_name, issue_number, volume_year, manually_matched)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
          req.params.id, String(issue.id), book?.id || null, maxOrder + 1,
          issue.volume?.name || run.parent_series || run.title,
          issue.issue_number || '0',
          issue.volume?.start_year ? String(issue.volume.start_year) : null,
        );

        runOrder.placeNew(db, Number(req.params.id), [Number(added.lastInsertRowid)]);   // in by number, not at the end
        logger.info('canon', `CV URL override: added issue ${issue.id} to run ${req.params.id}`, { matched: !!book?.id });
        return res.json({ type: 'issue', success: true, cv_issue_id: String(issue.id), matched: !!book?.id, issue_number: issue.issue_number });
      } catch (e) {
        logger.error('canon', 'CV URL override issue fetch failed', e.message);
        return res.status(500).json({ error: e.message });
      }
    }

    res.status(400).json({ error: 'Could not parse a CV volume (4050-XXXXX) or issue (4000-XXXXX) ID from the URL' });
  });
  // ─── Canon: Eisner data import ────────────────────────────────────
  // POST /api/canon/eisner-import
  // Parses eisner.txt, populates award_data with CV IDs for all series-level
  // categories, and tags any matching canon_runs with award_winning.
  // Safe to run multiple times — INSERT OR IGNORE prevents duplicates.
  app.post('/api/canon/eisner-import', requireAdmin, async (req, res) => {
    // Superseded (2026-10-18): eisner.txt assigns years by position and several are wrong; the verified
    // list in data/comic_awards.json is loaded at startup instead. Kept for reference, not run.
    if (db.prepare("SELECT value FROM settings WHERE key = 'comic_awards_version'").get()) {
      return res.status(409).json({ error: 'Replaced by the verified awards list (backend/data/comic_awards.json), loaded at startup.' });
    }
    try {
      const eisnerPath = path.join(__dirname, 'eisner.txt');
      if (!fs.existsSync(eisnerPath)) return res.status(404).json({ error: 'eisner.txt not found' });

      const text    = fs.readFileSync(eisnerPath, 'utf8');
      const lines   = text.split('\n');

      // ── Parse blocks — each "Category,Winner..." header starts a new year ──
      // 35 blocks covering 1991–2025
      const START_YEAR = 1991;
      const blocks = [];
      let current  = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Category,Winner')) {
          if (current) blocks.push(current);
          current = { entries: [] };
        } else if (current && trimmed && !trimmed.startsWith('#')) {
          current.entries.push(trimmed);
        }
      }
      if (current) blocks.push(current);

      // Map blocks to years
      blocks.forEach((b, i) => { b.year = START_YEAR + i; });

      // ── Series-level categories to import ─────────────────────────
      const SERIES_CATS = new Set([
        'Best Continuing Series', 'Best Finite Series', 'Best Limited Series',
        'Best Serialized Story', 'Best New Series',
        'Best Graphic Album\u2014New', 'Best Graphic Album\u2014Reprint',
        'Best Graphic Album-New', 'Best Graphic Album-Reprint',
        'Best Humor Publication', 'Best Single Issue', 'Best Single Issue/One-Shot',
      ]);

      // ── Parse CSV line respecting quoted fields ────────────────────
      const parseCSV = (line) => {
        const cols = [];
        let cur = '', inQ = false;
        for (const ch of line) {
          if (ch === '"') { inQ = !inQ; }
          else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
          else { cur += ch; }
        }
        cols.push(cur.trim());
        return cols;
      };

      const insertAward = db.prepare(`
        INSERT OR IGNORE INTO award_data (award, year, category, series_name, publisher, winner, cv_volume_id, cv_issue_id)
        VALUES ('eisner', ?, ?, ?, NULL, ?, ?, ?)
      `);
      const updateCvId = db.prepare(`
        UPDATE award_data SET cv_volume_id = ?, cv_issue_id = ?
        WHERE award = 'eisner' AND year = ? AND category = ? AND series_name = ?
          AND (cv_volume_id IS NULL OR cv_volume_id = '')
      `);
      const insertCat  = db.prepare(`INSERT OR IGNORE INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?, 'award_winning', NULL)`);

      let awardInserted = 0, awardUpdated = 0, runsTagged = 0;

      const doAll = db.transaction(() => {
        for (const block of blocks) {
          for (const entry of block.entries) {
            const cols = parseCSV(entry);
            if (cols.length < 2) continue;

            const [category, winnerRaw, cvRaw = ''] = cols;
            if (!SERIES_CATS.has(category)) continue;

            // Extract CV IDs from the third column
            const cvStr      = cvRaw.trim();
            const volumeMatch = cvStr.match(/4050-(\d+)/i);
            const issueMatch  = cvStr.match(/4000-(\d+)/i);
            const cvVolumeId  = volumeMatch ? volumeMatch[1] : null;
            const cvIssueId   = issueMatch  ? issueMatch[1]  : null;

            // Extract series name — strip creator credits in parentheses
            // "Sandman (Neil Gaiman & artists, DC)" → "Sandman"
            const seriesName = winnerRaw
              .replace(/\s*\([^)]+\)\s*$/, '')  // strip trailing (...)
              .replace(/^"/, '').replace(/"$/, '') // strip quotes
              .trim();

            if (!seriesName) continue;

            // winner=1 only for rows that don't have losers listed — in eisner.txt
            // every row is a winner (we only list winners, not nominees)
            const isWinner = 1;

            const info = insertAward.run(block.year, category, seriesName, isWinner, cvVolumeId, cvIssueId);
            if (info.changes > 0) {
              awardInserted++;
            } else {
              // Row exists — update CV IDs if missing
              const u = updateCvId.run(cvVolumeId, cvIssueId, block.year, category, seriesName);
              if (u.changes > 0) awardUpdated++;
            }

            // ── Tag matching canon_runs ────────────────────────────
            let matchedRun = null;

            // Match by CV volume ID first (most reliable)
            if (cvVolumeId) {
              matchedRun = db.prepare('SELECT id FROM canon_runs WHERE cv_volume_id = ?').get(cvVolumeId);
            }

            // Fall back to series name match
            if (!matchedRun) {
              const normName = nameKey(seriesName);
              const runs = db.prepare('SELECT id, title, parent_series FROM canon_runs').all();
              for (const run of runs) {
                const normTitle  = nameKey(run.title);
                const normParent = nameKey(run.parent_series);
                if (normTitle === normName || normParent === normName ||
                    normTitle.includes(normName) || normName.includes(normTitle)) {
                  matchedRun = run;
                  break;
                }
              }
            }

            if (matchedRun) {
              const r = insertCat.run(matchedRun.id);
              if (r.changes > 0) runsTagged++;
            }
          }
        }
      });

      doAll();

      logger.info('canon', 'Eisner import complete', { awardInserted, awardUpdated, runsTagged });
      res.json({
        success: true,
        award_rows_inserted: awardInserted,
        award_rows_cv_updated: awardUpdated,
        canon_runs_tagged: runsTagged,
        years_covered: `${START_YEAR}–${START_YEAR + blocks.length - 1}`,
        blocks_parsed: blocks.length,
      });
    } catch (e) {
      logger.error('canon', 'Eisner import failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/canon/backfill-award-notes
  // For existing award_winning canon runs with no adaptation_notes, looks up
  // matching awards in award_data and populates the notes field.
  // Safe to run multiple times — only updates rows where notes are currently NULL/empty.
  app.post('/api/canon/backfill-award-notes', requireAdmin, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT cr.id, cr.title, cr.parent_series, crc.id as cat_id, crc.adaptation_notes
        FROM canon_runs cr
        JOIN canon_run_categories crc ON crc.run_id = cr.id AND crc.category = 'award_winning'
        WHERE (crc.adaptation_notes IS NULL OR crc.adaptation_notes = '')
      `).all();

      let updated = 0;
      const updateNotes = db.prepare('UPDATE canon_run_categories SET adaptation_notes = ? WHERE id = ?');

      for (const run of rows) {
        const awards = getSeriesAwards(run.title);
        const parentAwards = run.parent_series ? getSeriesAwards(run.parent_series) : [];
        const stripped = run.title ? getSeriesAwards(run.title.replace(/^[^:]+:\s*/, '')) : [];

        const seen = new Set();
        const all = [...awards, ...parentAwards, ...stripped].filter(a => {
          if (!a.winner) return false;
          const key = `${a.award}|${a.year}|${a.category}`;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        }).sort((a, b) => a.year - b.year);

        if (!all.length) continue;

        const notes = all.map(a =>
          `${a.award === 'eisner' ? 'Eisner' : a.award === 'harvey' ? 'Harvey' : a.award} Award — ${a.category} (${a.year})`
        ).join('; ');

        updateNotes.run(notes, run.cat_id);
        updated++;
      }

      res.json({ success: true, checked: rows.length, updated });
    } catch (e) {
      logger.error('canon', 'Award notes backfill failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/canon/dedup
  // Scans all canon runs for duplicates by title similarity, merges categories
  // from the duplicate into the original (keeping the oldest/approved one),
  // then deletes the duplicate. Safe to run multiple times.
  app.post('/api/canon/dedup', requireAdmin, (req, res) => {
    try {
      const runs = db.prepare('SELECT id, title, parent_series, status FROM canon_runs ORDER BY id ASC').all();

      const normalise = (s = '') => s.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

      const merged = [];
      const deleted = new Set();

      for (let i = 0; i < runs.length; i++) {
        if (deleted.has(runs[i].id)) continue;
        for (let j = i + 1; j < runs.length; j++) {
          if (deleted.has(runs[j].id)) continue;

          const a = normalise(runs[i].title);
          const b = normalise(runs[j].title);

          // Exact normalised title match — definite duplicate
          if (a !== b) continue;

          // Keep the approved one, or the older one if both same status
          const keepId   = (runs[i].status === 'approved' || runs[j].status !== 'approved') ? runs[i].id : runs[j].id;
          const deleteId = keepId === runs[i].id ? runs[j].id : runs[i].id;

          // Merge categories from duplicate into keeper (INSERT OR IGNORE — no overwrites)
          const cats = db.prepare('SELECT category, adaptation_notes FROM canon_run_categories WHERE run_id = ?').all(deleteId);
          for (const cat of cats) {
            db.prepare('INSERT OR IGNORE INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?, ?, ?)')
              .run(keepId, cat.category, cat.adaptation_notes);
          }

          // Merge creators
          const creators = db.prepare('SELECT person_name, role FROM canon_run_creators WHERE run_id = ?').all(deleteId);
          for (const c of creators) {
            const exists = db.prepare('SELECT 1 FROM canon_run_creators WHERE run_id = ? AND person_name = ? AND role = ?').get(keepId, c.person_name, c.role);
            if (!exists) db.prepare('INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (?, ?, ?)').run(keepId, c.person_name, c.role);
          }

          // Delete the duplicate
          db.prepare('DELETE FROM canon_runs WHERE id = ?').run(deleteId);
          deleted.add(deleteId);
          merged.push({ kept: keepId, deleted: deleteId, title: runs[i].title });
        }
      }

      res.json({ success: true, merged: merged.length, details: merged });
    } catch (e) {
      logger.error('canon', 'Dedup failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/canon/import
  // Saves selected AI-generated runs. Handles:
  //   - event linking (if matched_event was accepted)
  //   - duplicate merging (if duplicate_of exists, adds new categories to existing run)
  //   - fresh inserts for new standalone runs
  app.post('/api/canon/import', requireAdmin, (req, res) => {
    const { runs } = req.body || {};
    if (!Array.isArray(runs) || runs.length === 0) return res.status(400).json({ error: 'runs array required' });
    try {
      let inserted = 0, merged = 0, eventLinked = 0;
      const newRunIds = []; // track freshly inserted run IDs for auto-resolve

      const insertRun     = db.prepare(`INSERT INTO canon_runs (title, parent_series, issue_range_hint, description, status, event_id) VALUES (?, ?, ?, ?, 'pending', ?)`);
      const insertCat     = db.prepare('INSERT OR IGNORE INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?, ?, ?)');
      const insertCreator = db.prepare('INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (?, ?, ?)');
      const hasCreator    = db.prepare('SELECT 1 FROM canon_run_creators WHERE run_id = ? AND person_name = ? AND role = ?');

      const importAll = db.transaction((runs) => {
        for (const run of runs) {
          const eventId = run.accepted_event_id || null;
          const dupId   = run.duplicate_of?.id || null;

          if (dupId) {
            if (Array.isArray(run.categories)) {
              for (const cat of run.categories) {
                if (!cat) continue;
                const notes = tidyBadge(cat === 'adapted_to_screen' ? run.adaptation_notes
                            : cat === 'award_winning'     ? run.award_notes
                            : null);   // badge length (canonCategories.tidyNotes)
                insertCat.run(dupId, cat, notes);
              }
            }
            if (eventId) {
              db.prepare('UPDATE canon_runs SET event_id = ? WHERE id = ? AND event_id IS NULL').run(eventId, dupId);
            }
            merged++;
          } else {
            const info = insertRun.run(
              run.title || 'Untitled',
              run.parent_series || null,
              run.issue_range_hint || null,
              run.description || null,
              eventId,
            );
            const runId = info.lastInsertRowid;
            newRunIds.push(runId);
            if (run.categories_checked) db.prepare("UPDATE canon_runs SET categories_checked_at = datetime('now') WHERE id = ?").run(runId);

            if (Array.isArray(run.categories)) {
              for (const cat of run.categories) {
                if (!cat) continue;
                const notes = tidyBadge(cat === 'adapted_to_screen' ? run.adaptation_notes
                            : cat === 'award_winning'     ? run.award_notes
                            : null);   // badge length (canonCategories.tidyNotes)
                insertCat.run(runId, cat, notes);
              }
            }
            if (Array.isArray(run.creators)) {
              for (const c of run.creators) {
                if (c.name && !hasCreator.get(runId, c.name, c.role || 'writer')) {
                  insertCreator.run(runId, c.name, c.role || 'writer');
                }
              }
            }
            if (eventId) eventLinked++;
            inserted++;
          }
        }
      });

      importAll(runs);
      logger.info('canon', `Import complete`, { inserted, merged, eventLinked });
      res.json({ success: true, inserted, merged, eventLinked });

      // Fire-and-forget CV resolution for newly inserted runs
      // Runs sequentially with delays to respect CV rate limits
      if (newRunIds.length > 0) {
        setImmediate(async () => {
          logger.info('canon', `Auto-resolve: starting for ${newRunIds.length} new runs`);
          for (const runId of newRunIds) {
            try {
              const result = await resolveCanonRun(runId);
              canonResolveResults.set(String(runId), { at: Date.now(), error: result.error || null, skipped: result.skipped ? (result.reason || 'skipped') : null, inserted: result.inserted ?? null });
              if (result.error) logger.warn('canon', `Auto-resolve failed for run ${runId}`, result.error);
              else logger.info('canon', `Auto-resolve done for run ${runId}`, { inserted: result.inserted, matched: result.matched });
            } catch (e) {
              logger.warn('canon', `Auto-resolve exception for run ${runId}`, e.message);
            }
            // Pause between runs to be kind to the CV API
            await new Promise(r => setTimeout(r, 1000));
          }
          logger.info('canon', `Auto-resolve: all ${newRunIds.length} runs processed`);
        });
      }
    } catch (e) {
      logger.error('canon', 'Import failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return { enrichCanonRuns, resolveCanonRun, canonResolveResults };
};
