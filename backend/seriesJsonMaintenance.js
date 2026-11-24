'use strict';
// ─── series.json upkeep and "(Unknown)" folders (moved out of server.js 2026-11-23, server.js split step 7B) ───
// Keeping a copy of series.json while a rebuild runs, writing series.json with the database in step,
// Comic Vine volume facts for the run text, renaming "(Unknown)" series folders once the year is known,
// and the daily 04:45 series.json refresh with its manual trigger. Moved unchanged. server.js wraps the
// refresh (background Comic Vine lane) and the folder rename (library write lock) once the file has loaded.
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const NEEDS = ['app', 'cvApiGet', 'db', 'DB_PATH', 'deriveMetadataStatus', 'getCVKey', 'getSetting', 'invalidateDirectoryExistsCache', 'invalidateSeriesCache', 'invalidateSeriesJsonCache', 'jsonMemCache', 'logger', 'metadataMaintenance', 'missingCatalog', 'readingLists', 'requireAdmin', 'scanner'];
module.exports.NEEDS = NEEDS;

module.exports.createSeriesJsonMaintenance = function createSeriesJsonMaintenance(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createSeriesJsonMaintenance: missing ${missing.join(', ')}`);
  const { app, cvApiGet, db, DB_PATH, deriveMetadataStatus, getCVKey, getSetting, invalidateDirectoryExistsCache, invalidateSeriesCache, invalidateSeriesJsonCache, jsonMemCache, logger, metadataMaintenance, missingCatalog, readingLists, requireAdmin, scanner } = deps;
  // ─── series.json helpers ─────────────────────────────────────────
  // Rebuilds (the Download Manager { } button and Mass JSON with Force) delete
  // series.json and let enricher.py recreate it. Keep the previous version as
  // series.json.bak first so a failed rebuild can be rolled back.
  function backupAndRemoveSeriesJson(directory) {
    const jsonPath = path.join(directory, 'series.json');
    if (!fs.existsSync(jsonPath)) return false;
    fs.copyFileSync(jsonPath, jsonPath + '.bak');
    fs.unlinkSync(jsonPath);
    return true;
  }

  function restoreSeriesJsonBackup(directory) {
    const jsonPath = path.join(directory, 'series.json');
    const bak = jsonPath + '.bak';
    if (fs.existsSync(jsonPath) || !fs.existsSync(bak)) return false;
    fs.copyFileSync(bak, jsonPath);
    return true;
  }

  // Write series.json in place and keep the app's cached copies in step.
  // Rewriting an existing file doesn't change the folder's mtime, so the library
  // scanner would otherwise keep serving the old copy from scanned_series.
  function writeSeriesJsonSynced(directory, data) {
    const jsonPath = path.join(directory, 'series.json');
    const bak = jsonPath + '.bak';
    if (fs.existsSync(jsonPath) && !fs.existsSync(bak)) fs.copyFileSync(jsonPath, bak);
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(jsonPath, content, 'utf8');
    const ss = db.prepare('SELECT id FROM scanned_series WHERE path = ?').get(directory);
    if (ss) {
      db.prepare('DELETE FROM series_json_cache WHERE series_id = ?').run(ss.id);
      jsonMemCache.delete(ss.id);
      db.prepare('UPDATE scanned_series SET metadata_status = ?, series_json = ?, year = COALESCE(?, year) WHERE id = ?')
        .run(deriveMetadataStatus(data), content, data?.metadata?.year || null, ss.id);
    }
  }

  // ─── Comic Vine volume fetch (series-level facts) ────────────────
  // Separate endpoint (and quota) from single issues. Same rate-limit handling.
  async function fetchCvVolumeFacts(volumeId) {
    const r = await cvApiGet(`https://comicvine.gamespot.com/api/volume/4050-${volumeId}/`, {
      params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,start_year,count_of_issues,image' },
      timeout: 15000,
    });
    const v = r.data?.results;
    if (!v || Array.isArray(v)) return null;
    const year = parseInt(v.start_year, 10);
    const count = parseInt(v.count_of_issues, 10);
    return {
      year: Number.isFinite(year) && year > 1800 ? year : null,
      issueCount: Number.isFinite(count) ? count : null,
      image: v.image?.medium_url || null,
    };
  }

  const SJ_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function sjMonthYear(d) {
    const y = parseInt(String(d || '').slice(0, 4), 10);
    const m = parseInt(String(d || '').slice(5, 7), 10);
    return (y && m >= 1 && m <= 12) ? `${SJ_MONTHS[m - 1]} ${y}` : null;
  }

  // Publication run + status from data already in the DB (no CV call).
  // Status follows monitored_series.series_status, which the CV poller maintains;
  // falls back to "an issue dated within ~4 months (or later) = ongoing".
  function deriveRunForSeriesJson(series) {
    const row = db.prepare(`
    SELECT MIN(COALESCE(release_date, store_date)) AS first_cover,
           MAX(COALESCE(release_date, store_date)) AS last_cover,
           MAX(COALESCE(store_date, release_date)) AS last_store
    FROM monitored_issues WHERE series_id = ? AND COALESCE(is_annual, 0) = 0
  `).get(series.id);
    if (!row?.first_cover) return null;
    let ongoing;
    if (series.series_status === 'ongoing') ongoing = true;
    else if (series.series_status === 'ended') ongoing = false;
    else ongoing = row.last_store >= new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
    const first = sjMonthYear(row.first_cover);
    const last  = sjMonthYear(row.last_cover);
    if (!first) return null;
    const run = ongoing ? `${first} - Present` : (!last || first === last ? first : `${first} - ${last}`);
    return { run, status: ongoing ? 'Continuing' : 'Ended' };
  }

  // ─── "(Unknown)" folder rename ───────────────────────────────────
  // Series added before Comic Vine had a start year got a "Name (Unknown)" folder.
  // The rename updates paths in one transaction (IDs are stable, so nothing that
  // links to the series or its books changes), and moves the folder back if the
  // database update fails.
  const FOLDER_RENAME_LOG = path.join(path.dirname(DB_PATH), 'folder_renames.log');

  function planUnknownFolderRename(series) {
    const from = series.directory;
    if (!from || !/\(Unknown\)$/.test(path.basename(from))) return null;
    if (series.parent_series_id) return { from, skip: 'special series (lives in parent folder)' };
    let sj = null;
    try { sj = JSON.parse(fs.readFileSync(path.join(from, 'series.json'), 'utf8')); } catch {}
    if (sj && !ownsSeriesJson(series, sj)) return { from, skip: 'folder belongs to another series (e.g. annual in parent folder)' };
    let year = parseInt(series.year, 10) || null;
    if (!year) year = parseInt(sj?.metadata?.year, 10) || null;
    if (!year) return { from, skip: 'start year still unknown on Comic Vine' };
    const to = path.join(path.dirname(from), `${series.name} (${year})`.replace(/[/\\:*?"<>|]/g, ''));
    if (to === from) return null;
    if (!fs.existsSync(from)) return { from, to, year, skip: 'folder not found on disk' };
    if (fs.existsSync(to)) return { from, to, year, skip: 'target folder already exists' };
    if (db.prepare('SELECT 1 FROM monitored_series WHERE directory = ? AND id != ?').get(to, series.id)) {
      return { from, to, year, skip: 'target folder already used by another monitored series' };
    }
    const busy = db.prepare(`SELECT COUNT(*) AS n FROM monitored_issues WHERE series_id = ? AND status IN ('snatched','downloaded','processing')`).get(series.id).n;
    if (busy) return { from, to, year, skip: `${busy} download(s) in progress` };
    return { from, to, year };
  }

  function remapRenamedFolder(from, to, seriesId, year) {
    // Stable IDs: a renamed folder keeps every series and book ID, so nothing that
    // links to them (progress, events, Top Shelf, lists, favorites, boxes, ratings,
    // tags, offline copies, thumbnails) needs remapping — only paths change.
    const fromSlash = from + '/';
    const tryRun = (sql, ...args) => { try { return db.prepare(sql).run(...args).changes; } catch { return 0; } };
    const counts = { books: 0, series: 0, progress: 0 };

    db.transaction(() => {
      counts.books = db.prepare('UPDATE scanned_books SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?')
        .run(to, from.length + 1, fromSlash.length, fromSlash).changes;
      const seriesRows = db.prepare('SELECT id, path FROM scanned_series WHERE path = ? OR substr(path, 1, ?) = ?').all(from, fromSlash.length, fromSlash);
      for (const r of seriesRows) {
        db.prepare('UPDATE scanned_series SET path = ?, year = CASE WHEN path = ? THEN ? ELSE year END WHERE id = ?')
          .run(to + r.path.slice(from.length), from, year, r.id);
        tryRun('DELETE FROM series_json_cache WHERE series_id = ?', r.id);
        jsonMemCache.delete(r.id);
        counts.series++;
      }
      // Monitored series (parent + any specials sharing the folder) and file paths
      db.prepare('UPDATE monitored_series SET directory = ? WHERE directory = ?').run(to, from);
      db.prepare('UPDATE monitored_series SET year = ? WHERE id = ? AND (year IS NULL OR year = \'\')').run(year, seriesId);
      for (const t of ['monitored_issues', 'series_packs']) {
        tryRun(`UPDATE ${t} SET file_path = ? || substr(file_path, ?) WHERE substr(file_path, 1, ?) = ?`,
          to, from.length + 1, fromSlash.length, fromSlash);
      }
    })();
    return counts;
  }

  async function renameUnknownFolder(series, plan) {
    if (scanner.scanState.running) return { ...plan, skip: 'library scan running — try again later' };
    // The old retag rotation flag no longer existed (ReferenceError on every rename); metadata
    // checks are what now touch files across the library (fixed 2026-10-26).
    if (metadataMaintenance.isRunning()) return { ...plan, skip: 'metadata checks running — try again later' };
    try {
      fs.renameSync(plan.from, plan.to);
    } catch (e) {
      return { ...plan, skip: `rename failed: ${e.code || e.message}` };
    }
    try {
      const counts = remapRenamedFolder(plan.from, plan.to, series.id, plan.year);
      for (const m of db.prepare('SELECT id FROM monitored_series WHERE directory = ?').all(plan.to)) {
        invalidateDirectoryExistsCache(m.id);
        invalidateSeriesJsonCache(m.id);
      }
      invalidateSeriesCache();
      try { fs.appendFileSync(FOLDER_RENAME_LOG, `${new Date().toISOString()}\t${plan.from}\t${plan.to}\n`); } catch {}
      logger.info('folder-rename', `Renamed "${path.basename(plan.from)}" → "${path.basename(plan.to)}"`, counts);
      return { ...plan, renamed: true, ...counts };
    } catch (e) {
      // Database update failed (transaction rolled back) — put the folder back.
      try { fs.renameSync(plan.to, plan.from); } catch {}
      logger.error('folder-rename', `DB remap failed, folder restored`, { from: plan.from, error: e.message });
      return { ...plan, skip: `database update failed (folder restored): ${e.message}` };
    }
  }

  // Annual volumes (and other linked series) are monitored as their own series but
  // share the parent's folder, so the series.json there belongs to the parent.
  // A series only owns the file when its comicid matches (or the file has none).
  function ownsSeriesJson(series, data) {
    const cid = data?.metadata?.comicid ?? data?.comicid;
    return cid == null || cid === '' || String(cid) === String(series.id);
  }

  function folderAutoRenameEnabled() {
    return getSetting('series_folder_autorename') === 'true';
  }

  // ─── Scheduled series.json refresh (daily 04:45) ─────────────────
  // Updates only Comic Vine facts in place: issue count, publication run and
  // status every time; year and cover image only when missing. Descriptions,
  // genres, characters, era, imprint and manual edits are left alone.
  // Due: ongoing/unknown series weekly; ended series monthly for 6 months after
  // their last issue; series with no year weekly (CV may have added it).
  // One CV volume request per series, capped per run, least-recently-refreshed first.
  const SJ_REFRESH_CAP = 100;
  const SJ_REFRESH_DELAY_MS = 1100;
  let sjRefreshRunning = false;

  async function runSeriesJsonRefresh(trigger = 'scheduled') {
    if (sjRefreshRunning) { logger.info('sj-refresh', 'Already running — skipped'); return { skipped: true }; }
    sjRefreshRunning = true;
    const stats = { due: 0, updated: 0, unchanged: 0, noJson: 0, notOwner: 0, noData: 0, failed: 0, renamed: 0, rateLimited: false };
    const pause = () => new Promise(r => setTimeout(r, SJ_REFRESH_DELAY_MS));
    try {
      const due = db.prepare(`
      SELECT * FROM (
        SELECT ms.*,
               (SELECT MAX(COALESCE(store_date, release_date)) FROM monitored_issues WHERE series_id = ms.id) AS last_issue_date
        FROM monitored_series ms
        WHERE ms.status = 'active' AND ms.parent_series_id IS NULL
      ) s
      WHERE (s.year IS NULL OR s.year = ''
             OR COALESCE(s.series_status, 'unknown') <> 'ended'
             OR s.last_issue_date >= date('now', '-6 months'))
        AND (s.series_json_refreshed_at IS NULL
             OR s.series_json_refreshed_at < datetime('now',
                  CASE WHEN COALESCE(s.series_status, 'unknown') <> 'ended' OR s.year IS NULL OR s.year = ''
                       THEN '-7 days' ELSE '-30 days' END))
      ORDER BY s.series_json_refreshed_at ASC
      LIMIT ?
    `).all(SJ_REFRESH_CAP);
      stats.due = due.length;
      logger.info('sj-refresh', `Starting (${trigger}) — ${due.length} series due`);
      const markDone = db.prepare(`UPDATE monitored_series SET series_json_refreshed_at = datetime('now') WHERE id = ?`);
      const autoRename = folderAutoRenameEnabled();

      for (const s of due) {
        const jsonPath = path.join(s.directory, 'series.json');
        let data = null;
        if (fs.existsSync(jsonPath)) {
          try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) {
            logger.warn('sj-refresh', `Unreadable series.json for "${s.name}" — skipped`, e.message);
            markDone.run(s.id); stats.failed++; continue;
          }
        }

        let facts;
        try {
          facts = await fetchCvVolumeFacts(s.id);
        } catch (e) {
          if (e.code === 'CV_RATE_LIMIT') { stats.rateLimited = true; break; }
          logger.warn('sj-refresh', `CV fetch failed for "${s.name}"`, e.message);
          markDone.run(s.id); stats.failed++; await pause(); continue;
        }
        markDone.run(s.id);

        // Keep the DB year in step even when there's no series.json yet
        if (facts?.year && !s.year) {
          db.prepare('UPDATE monitored_series SET year = ? WHERE id = ?').run(facts.year, s.id);
          s.year = facts.year;
        }

        if (!data) {
          stats.noJson++;
        } else if (!ownsSeriesJson(s, data)) {
          stats.notOwner++;   // e.g. an annual volume sharing its parent's folder
        } else if (!facts) {
          stats.noData++;
        } else {
          const m = data.metadata || (data.metadata = {});
          const changes = [];
          if (facts.year && !m.year) { changes.push(`year → ${facts.year}`); m.year = facts.year; }
          if (facts.year && !m.volume) m.volume = facts.year;
          if (facts.issueCount != null && m.total_issues !== facts.issueCount) {
            changes.push(`issues ${m.total_issues ?? '—'} → ${facts.issueCount}`); m.total_issues = facts.issueCount;
          }
          if (facts.image && !m.comic_image) { changes.push('cover image'); m.comic_image = facts.image; }
          const run = deriveRunForSeriesJson(s);
          if (run) {
            if (m.publication_run !== run.run) { changes.push(`run → ${run.run}`); m.publication_run = run.run; }
            if (m.status !== run.status) { changes.push(`status ${m.status || '—'} → ${run.status}`); m.status = run.status; }
          }
          if (changes.length) {
            try {
              writeSeriesJsonSynced(s.directory, data);
              stats.updated++;
              logger.info('sj-refresh', `${s.name}: ${changes.join(', ')}`);
            } catch (e) {
              stats.failed++;
              logger.warn('sj-refresh', `Write failed for "${s.name}"`, e.message);
            }
          } else {
            stats.unchanged++;
          }
        }

        if (autoRename) {
          const plan = planUnknownFolderRename(s);
          if (plan && !plan.skip) {
            const res = await renameUnknownFolder(s, plan);
            if (res.renamed) stats.renamed++;
            else logger.info('folder-rename', `Skipped "${path.basename(plan.from)}": ${res.skip}`);
          }
        }
        await pause();
      }
      invalidateSeriesCache();
      logger.info('sj-refresh', stats.rateLimited ? 'Stopped early — Comic Vine rate limit reached' : 'Complete', stats);
    } catch (e) {
      logger.error('sj-refresh', 'Run failed', e.message);
    } finally {
      sjRefreshRunning = false;
    }
    return stats;
  }

  // One-time repair (2026-10-08): the first refresh runs let annual volumes write
  // their issue count into the parent's series.json. Mark every series in a shared
  // folder as due so the next run restores the parent's own values.
  try {
    const done = getSetting('sj_shared_folder_repair_20261008');
    if (done !== 'done') {
      const { changes } = db.prepare(`
      UPDATE monitored_series SET series_json_refreshed_at = NULL
      WHERE directory IN (SELECT directory FROM monitored_series GROUP BY directory HAVING COUNT(*) > 1)
    `).run();
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('sj_shared_folder_repair_20261008', 'done');
      if (changes) console.log(`[sj-refresh] Marked ${changes} series in shared folders for re-refresh`);
    }
  } catch (e) { console.warn('[sj-refresh] shared-folder repair mark failed', e.message); }

  cron.schedule('45 4 * * *', () => {
    runSeriesJsonRefresh('scheduled').catch(e => logger.error('sj-refresh', 'Run failed', e.message))
      // Then pick up new issues for whole-series / range reading-list entries.
      .finally(() => readingLists.refreshAll('scheduled'))
      .finally(() => missingCatalog.start())
      .catch(e => logger.warn('library', 'Scheduled reading-list refresh failed', e.message));
  });

  // Manual trigger — background; results go to the server log (sj-refresh).
  app.post('/api/monitor/series-json-refresh/run', requireAdmin, (req, res) => {
    if (sjRefreshRunning) return res.json({ ok: false, message: 'Already running' });
    setImmediate(() => runSeriesJsonRefresh('manual').catch(e => logger.error('sj-refresh', 'Run failed', e.message)));
    res.json({ ok: true, message: 'series.json refresh started — see server log (sj-refresh)' });
  });

  // "(Unknown)" folders: preview (default), apply, and turn automatic renaming on/off.
  // Body: { dryRun: true|false, autoRename: true|false (optional) }
  app.post('/api/monitor/unknown-folders/rename', requireAdmin, async (req, res) => {
    try {
      const { dryRun = true, autoRename } = req.body || {};
      if (autoRename !== undefined) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('series_folder_autorename', autoRename ? 'true' : 'false');
      }
      const candidates = db.prepare(`SELECT * FROM monitored_series WHERE directory LIKE '%(Unknown)'`).all();
      const results = [];
      for (const s of candidates) {
        const plan = planUnknownFolderRename(s);
        if (!plan) continue;
        if (dryRun || plan.skip) { results.push({ name: s.name, ...plan, willRename: !plan.skip }); continue; }
        results.push({ name: s.name, ...(await renameUnknownFolder(s, plan)) });
      }
      res.json({ dryRun: !!dryRun, autoRename: folderAutoRenameEnabled(), count: results.length, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Wrapping by server.js once everything has loaded, as server.js did for its own names.
  function wrapRefresh(wrap) { runSeriesJsonRefresh = wrap(runSeriesJsonRefresh); }
  function wrapRename(wrap) { renameUnknownFolder = wrap(renameUnknownFolder); }
  return { backupAndRemoveSeriesJson, restoreSeriesJsonBackup, writeSeriesJsonSynced, wrapRefresh, wrapRename };
};
