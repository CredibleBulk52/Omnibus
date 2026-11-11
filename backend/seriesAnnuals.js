'use strict';
// ─── Missing annuals on series pages (2026-11-10) ───────────────────────────
// Comic Vine does not link an annual volume to its series, so the series page finds them from:
//   library  the annual files already in the series folder: each one's Comic Vine issue id gives
//            its volume (one lookup per volume, kept for good in cv_issue_volume);
//   linked   a monitored series' annual links (series_annual_links: the annual finder, or a
//            manual link from the Download Manager);
//   finder   Manage › Find annuals on a series that is not monitored (the same finder; kept in
//            series_annual_volumes, never in the Download Manager's tables).
// Each volume's issues come from the saved Comic Vine issue lists (fetchVolumeIssues, as the
// regular missing issues). Only annuals dated within the series' run show: a long volume such as
// X-Men Annual (1970–2011) would otherwise list other runs' annuals. Users who may download get
// them (Get: monitored in the series' folder), others request them.

const DAY = 864e5;
const NEEDS = ['app', 'db', 'requireAuth', 'requireAdmin', 'requireDownloadAccess', 'logger', 'IN', 'cvApiGet', 'getCVKey',
  'fillContext', 'fetchVolumeIssues', 'withTimeout', 'canDownload', 'mineFor', 'autoDiscoverAnnuals', 'yearlyTag',
  'runRefreshDirectory', 'scanSeriesComicInfo', 'startAutoGrab', 'detectSeriesType'];

module.exports.createSeriesAnnuals = function createSeriesAnnuals(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createSeriesAnnuals: missing ${missing.join(', ')}`);
  const { app, db, requireAuth, requireAdmin, requireDownloadAccess, logger, IN, cvApiGet, getCVKey, fillContext, fetchVolumeIssues,
    withTimeout, canDownload, mineFor, autoDiscoverAnnuals, yearlyTag, runRefreshDirectory, scanSeriesComicInfo, startAutoGrab, detectSeriesType } = deps;
  const LOOKUPS_PER_VIEW = deps.lookupsPerView || 3;

  db.exec(`CREATE TABLE IF NOT EXISTS cv_issue_volume (issue_id TEXT PRIMARY KEY, volume_id TEXT, volume_name TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS series_annual_volumes (scanned_series_id TEXT NOT NULL, volume_id TEXT NOT NULL, name TEXT, start_year INTEGER,
      source TEXT NOT NULL DEFAULT 'finder', added_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (scanned_series_id, volume_id));`);

  const isAnnualBook = b => /annual/i.test(b.filename || '') || /\bannual\b/i.test(b.ci_series || '') || !!yearlyTag(b.ci_series);
  const dateOf = i => String(i.store_date || i.cover_date || '').slice(0, 10) || null;

  // Comic Vine volume of an issue, from the saved table or one lookup.
  async function volumeOfIssue(issueId) {
    const row = db.prepare('SELECT volume_id, volume_name FROM cv_issue_volume WHERE issue_id = ?').get(String(issueId));
    if (row) return row.volume_id ? { id: row.volume_id, name: row.volume_name } : null;
    const r = await cvApiGet(`https://comicvine.gamespot.com/api/issue/4000-${issueId}/`, {
      params: { api_key: getCVKey(), format: 'json', field_list: 'id,volume' }, headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000 });
    const v = r.data?.results?.volume;
    db.prepare('INSERT OR REPLACE INTO cv_issue_volume (issue_id, volume_id, volume_name, at) VALUES (?, ?, ?, ?)')
      .run(String(issueId), v?.id ? String(v.id) : null, v?.name || null, Date.now());
    return v?.id ? { id: String(v.id), name: v.name || null } : null;
  }

  // The series' annual volumes: { id, name, source }. pending = library volumes not looked up yet.
  async function volumesFor(c) {
    const out = new Map();
    const add = (id, name, source) => { id = String(id); if (id && id !== String(c.volId) && !out.has(id)) out.set(id, { id, name: name || null, source }); };
    if (c.monitored) {
      for (const r of db.prepare(`SELECT s.id, s.name FROM series_annual_links l JOIN monitored_series s ON s.id = l.annual_series_id
        WHERE l.parent_series_id = ?`).all(String(c.volId))) add(r.id, r.name, 'linked');
    }
    for (const r of db.prepare('SELECT volume_id, name FROM series_annual_volumes WHERE scanned_series_id = ?').all(String(c.scanned.id))) add(r.volume_id, r.name, 'finder');
    // Annual files in the folder, grouped by their ComicInfo series and volume year.
    const groups = new Map();
    for (const b of db.prepare(`SELECT sb.id, sb.filename, COALESCE(sb.cv_issue_id, ci.cv_issue_id) AS cv, ci.series_name AS ci_series, ci.volume_year AS ci_year
        FROM scanned_books sb LEFT JOIN book_ci_index ci ON ci.book_id = sb.id WHERE sb.series_id = ?`).all(String(c.scanned.id))) {
      if (!b.cv || !isAnnualBook(b)) continue;
      const k = `${String(b.ci_series || '').toLowerCase()}|${b.ci_year || ''}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(String(b.cv));
    }
    let lookups = 0, pending = 0;
    const known = db.prepare('SELECT volume_id, volume_name FROM cv_issue_volume WHERE issue_id = ?');
    for (const ids of groups.values()) {
      const hit = ids.map(id => known.get(id)).find(Boolean);
      if (hit) { if (hit.volume_id) add(hit.volume_id, hit.volume_name, 'library'); continue; }
      if (!getCVKey() || lookups >= LOOKUPS_PER_VIEW) { pending++; continue; }
      lookups++;
      try { const v = await volumeOfIssue(ids[0]); if (v) add(v.id, v.name, 'library'); }
      catch (e) { pending++; logger.warn('series-annuals', 'Comic Vine issue lookup failed', { issue: ids[0], error: e.message }); }
    }
    return { volumes: [...out.values()], pending };
  }

  // The run's dates, from the regular issues (point issues such as #258.1 left out).
  function runWindow(c) {
    const ds = c.issues.filter(i => !i.is_annual && !String(i.number || '').includes('.')).map(dateOf).filter(Boolean).sort();
    if (!ds.length) return { from: null, to: null, firstDate: null, lastDate: null };
    const first = ds[0], last = ds[ds.length - 1];
    const recent = Date.parse(last) > Date.now() - 365 * DAY;   // still publishing: open-ended
    return { from: Date.parse(first) - 75 * DAY, to: recent ? null : Date.parse(last) + 400 * DAY, firstDate: first, lastDate: last };
  }

  // Missing annuals: rows like the regular gaps, with the volume they belong to.
  async function annualGaps(c) {
    const { volumes, pending } = await volumesFor(c);
    const win = runWindow(c);
    const today = new Date().toISOString().slice(0, 10);
    const rows = [], vols = [];
    for (const v of volumes) {
      const mon = db.prepare('SELECT id, name FROM monitored_series WHERE id = ?').get(v.id);
      let issues;
      if (mon) {
        issues = db.prepare('SELECT id, issue_number, title, release_date, store_date, status, cv_data FROM monitored_issues WHERE series_id = ?').all(v.id)
          .map(i => { let cv = null; try { cv = JSON.parse(i.cv_data || 'null'); } catch {} return { id: String(i.id), number: i.issue_number, title: i.title, cover_date: i.release_date, store_date: i.store_date, monStatus: i.status, image: cv?.image || null }; });
      } else {
        try {
          issues = (await fetchVolumeIssues(v.id, { slimOk: true, once: true })).map(i => ({ id: String(i.id), number: IN.normIssueNumber(i.issue_number) || '0',
            title: i.name || null, cover_date: i.cover_date || null, store_date: i.store_date || null, monStatus: null, image: i.image || null }));
        } catch (e) { logger.warn('series-annuals', 'Annual volume issues not available', { volume: v.id, error: e.message }); continue; }
      }
      const inRun = issues.filter(i => { const d = dateOf(i); if (!d) return true; const t = Date.parse(d); return (win.from == null || t >= win.from) && (win.to == null || t <= win.to); });
      const ids = JSON.stringify(inRun.map(i => i.id));
      const owned = new Set([
        ...db.prepare('SELECT cv_issue_id AS cv FROM scanned_books WHERE cv_issue_id IN (SELECT value FROM json_each(?))').all(ids).map(r => String(r.cv)),
        ...db.prepare('SELECT cv_issue_id AS cv FROM book_ci_index WHERE cv_issue_id IN (SELECT value FROM json_each(?))').all(ids).map(r => String(r.cv)),
      ]);
      let n = 0;
      for (const i of inRun) {
        if (owned.has(i.id) || i.monStatus === 'processed') continue;
        const state = ['wanted', 'snatched', 'downloaded', 'processing'].includes(i.monStatus) ? 'wanted' : 'missing';
        const d = dateOf(i);
        rows.push({ id: i.id, number: i.number, title: i.title, date: i.cover_date || null, state, unreleased: !!(d && d > today),
          image: i.image?.thumb_url || i.image?.small_url || null, volume_id: v.id, volume_name: mon?.name || v.name });
        n++;
      }
      vols.push({ ...v, name: mon?.name || v.name, in_run: inRun.length, missing: n });
    }
    rows.sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0));
    return { volumes: vols, rows, pending, window: { first: win.firstDate, last: win.lastDate } };
  }

  const ctxFor = async id => {
    const c = await withTimeout(fillContext(id, { cachedOnce: true }), 20000);
    return c;
  };

  app.get('/api/series/:id/annual-gaps', requireAuth, async (req, res) => {
    try {
      const c = await ctxFor(req.params.id);
      if (c.status) return res.json({ rows: [], volumes: [], reason: c.status === 400 ? 'no-cv-id' : c.error });
      const g = await withTimeout(annualGaps(c), 25000);
      const dl = canDownload(req.user);
      const reqs = dl ? {} : mineFor('series', c.scanned.id, req.user.sub);
      res.json({ can_download: dl, monitored: !!c.monitored, volumes: g.volumes, pending: g.pending, window: g.window,
        rows: g.rows.map(r => ({ ...r, request: reqs[r.id] || null })) });
    } catch (e) {
      logger.warn('series-annuals', 'Missing annuals lookup failed', { id: req.params.id, error: e.message });
      res.json({ rows: [], volumes: [], reason: e.message });
    }
  });

  // Get: each picked annual is wanted in the series' folder. A volume already in the Download
  // Manager has the picks set to wanted; otherwise it is added there with the picks wanted and
  // the rest skipped: linked to the series when that is monitored, else as a Fill entry that is
  // removed once done (as Fill missing).
  app.post('/api/series/:id/annual-gaps/get', requireDownloadAccess, async (req, res) => {
    try {
      const picks = new Set((Array.isArray(req.body?.issueIds) ? req.body.issueIds : []).map(String));
      if (!picks.size) return res.status(400).json({ error: 'Pick at least one annual' });
      const c = await ctxFor(req.params.id);
      if (c.status) return res.status(c.status).json({ error: c.error });
      const g = await annualGaps(c);
      const chosen = g.rows.filter(r => r.state === 'missing' && !r.unreleased && picks.has(r.id));
      if (!chosen.length) return res.status(400).json({ error: 'None of the picked annuals are missing' });
      const byVol = new Map();
      for (const r of chosen) { if (!byVol.has(r.volume_id)) byVol.set(r.volume_id, []); byVol.get(r.volume_id).push(r); }
      const directory = c.monitored?.directory || c.scanned.path;
      const started = [];
      for (const [volId, rs] of byVol) {
        const ids = new Set(rs.map(r => r.id));
        if (db.prepare('SELECT 1 FROM monitored_series WHERE id = ?').get(volId)) {
          const up = db.prepare(`UPDATE monitored_issues SET status = 'wanted', retry_after = NULL WHERE id = ? AND series_id = ? AND status IN ('skipped','failed')`);
          db.transaction(() => { for (const id of ids) up.run(id, volId); })();
        } else {
          const issues = await fetchVolumeIssues(volId, { slimOk: true, once: true });
          const years = issues.map(i => parseInt(String(i.store_date || i.cover_date || '').slice(0, 4), 10)).filter(Boolean);
          const newest = issues.map(dateOf).filter(Boolean).sort().pop();
          const ended = !newest || Date.parse(newest) < Date.now() - 365 * DAY;
          const publisher = c.monitored?.publisher || c.meta.publisher || null;
          const linked = !!c.monitored;
          const insIssue = db.prepare(`INSERT OR IGNORE INTO monitored_issues (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`);
          db.transaction(() => {
            db.prepare(`INSERT INTO monitored_series (id, name, publisher, year, total_issues, image_url, cv_url, directory, series_type, parent_series_id, is_special, series_status, fill_auto_remove, fill_started_at, last_cv_check)
              VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 0, ?, ?, datetime('now'), datetime('now'))`)
              .run(volId, rs[0].volume_name || `Comic Vine volume ${volId}`, publisher, years.length ? Math.min(...years) : null, issues.length,
                `https://comicvine.gamespot.com/volume/4050-${volId}/`, directory, detectSeriesType(publisher), ended ? 'ended' : 'unknown', linked ? 0 : 1);
            for (const i of issues) insIssue.run(String(i.id), volId, IN.normIssueNumber(i.issue_number) || '0', i.name || null, i.cover_date || null, i.store_date || null,
              JSON.stringify(i), ids.has(String(i.id)) ? 'wanted' : 'skipped');
            if (linked) db.prepare('INSERT OR IGNORE INTO series_annual_links (parent_series_id, annual_series_id) VALUES (?, ?)').run(String(c.volId), volId);
          })();
        }
        started.push(volId);
        logger.info('series-annuals', `Get missing annuals: ${rs.length} wanted from "${rs[0].volume_name || volId}"`, { series: c.scanned.id, volume: volId, directory });
      }
      setImmediate(async () => {
        for (const volId of started) {
          try { await runRefreshDirectory(volId); } catch (e) { logger.warn('series-annuals', 'Refresh failed', e.message); }
          try { await scanSeriesComicInfo(volId, { onlyUnknown: true }); } catch (e) { logger.warn('series-annuals', 'ComicInfo scan failed', e.message); }
          try { const r = startAutoGrab(volId); if (r?.status) logger.warn('series-annuals', `Auto-grab refused: ${r.error}`, { volId }); }
          catch (e) { logger.warn('series-annuals', 'Auto-grab failed to start', e.message); }
        }
      });
      res.json({ ok: true, wanted: chosen.length, volumes: started.length, directory });
    } catch (e) {
      logger.error('series-annuals', 'Get missing annuals failed', { id: req.params.id, error: e.message });
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // Manage › Find annuals (admins): the annual finder for this series. Monitored: the Download
  // Manager's finder (links there). Not monitored: the same search and validator, kept here.
  app.post('/api/series/:id/find-annuals', requireAdmin, async (req, res) => {
    try {
      const c = await ctxFor(req.params.id);
      if (c.status) return res.status(c.status).json({ error: c.error });
      const name = c.meta.name || c.scanned.name;
      const before = new Set((await volumesFor(c)).volumes.map(v => v.id));
      if (c.monitored) {
        db.prepare('UPDATE monitored_series SET annual_no_match_until = NULL WHERE id = ?').run(String(c.volId));
        await autoDiscoverAnnuals(String(c.volId), c.monitored.name || name, c.monitored.directory);
      } else {
        const win = runWindow(c);
        await autoDiscoverAnnuals(String(c.volId), name, c.scanned.path, {
          parent: { year: c.meta.year || c.meta.start_year || c.scanned.year || null, publisher: c.meta.publisher || null },
          firstDate: win.firstDate, lastDate: win.lastDate,
          linkedHere: vid => !!db.prepare('SELECT 1 FROM series_annual_volumes WHERE scanned_series_id = ? AND volume_id = ?').get(String(c.scanned.id), String(vid)),
          link: v => db.prepare(`INSERT OR IGNORE INTO series_annual_volumes (scanned_series_id, volume_id, name, start_year, source) VALUES (?, ?, ?, ?, 'finder')`)
            .run(String(c.scanned.id), String(v.id), v.name || null, parseInt(v.start_year, 10) || null),
        });
      }
      const after = (await volumesFor(c)).volumes;
      res.json({ ok: true, monitored: !!c.monitored, volumes: after, found: after.filter(v => !before.has(v.id)) });
    } catch (e) {
      logger.error('series-annuals', 'Find annuals failed', { id: req.params.id, error: e.message });
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // For the request service: a missing annual of this series as a request row.
  async function rowFor(scannedId, issueId) {
    const c = await ctxFor(scannedId);
    if (c.status) return null;
    const g = (await annualGaps(c)).rows.find(r => r.id === String(issueId));
    if (!g) return null;
    return { id: g.id, cv_issue_id: g.id, scanned_book_id: null, scanned_series_id: String(c.scanned.id), series_name: g.volume_name || `${c.meta.name || c.scanned.name} Annual`,
      issue_number: g.number, volume_year: g.date ? parseInt(String(g.date).slice(0, 4), 10) || null : null };
  }

  return { annualGaps, volumesFor, rowFor, runWindow };
};
