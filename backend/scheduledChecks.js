'use strict';
// ─── Scheduled Comic Vine and Metron checks (moved out of server.js 2026-11-23, server.js split step 7B) ───
// The weekly Tuesday 03:00 poll for new issues of monitored series, the hourly library series status
// check (libraryStatus.js) and its manual trigger, "Series without details: create from the files",
// and the hourly check for series linked to the wrong Comic Vine volume (seriesLinkCheck.js) with
// its Library Health routes. Moved unchanged; the weekly poll is now registered here, later at load.
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const IN = require('./issueNumber');

const NEEDS = ['app', 'createSeriesJsonFromVolume', 'CV_CAP_BACKGROUND', 'CV_CAP_INTERACTIVE', 'cvApiGet', 'cvWindow', 'db', 'getCVKey', 'getSetting', 'invalidateSeriesCache', 'libraryAccess', 'logger', 'metron', 'requireAdmin', 'runRefreshDirectory', 'seriesGrouping', 'seriesStatusLib', 'sleepMs', 'writeSeriesJsonSynced'];
module.exports.NEEDS = NEEDS;

module.exports.createScheduledChecks = function createScheduledChecks(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createScheduledChecks: missing ${missing.join(', ')}`);
  const { app, createSeriesJsonFromVolume, CV_CAP_BACKGROUND, CV_CAP_INTERACTIVE, cvApiGet, cvWindow, db, getCVKey, getSetting, invalidateSeriesCache, libraryAccess, logger, metron, requireAdmin, runRefreshDirectory, seriesGrouping, seriesStatusLib, sleepMs, writeSeriesJsonSynced } = deps;
  // ─── CV poller (weekly) ───────────────────────────────────────────
  const libraryStatus = require('./libraryStatus');
  let cvPollStartedAt = 0;   // while the weekly poll runs, the library status check stands aside
  // Every Monday at 03:00, check each active monitored series for new
  // CV issues not yet in our DB. Respects the 2 req/sec CV rate limit.
  cron.schedule('0 3 * * 2', async () => {
    logger.info('cvpoller', 'Weekly CV poll starting (Tuesday catch-all)');
    const CV_API_KEY = getCVKey();

    // Least recently checked first, and when the hourly allowance runs out the poll waits for it to
    // reset and carries on (2026-11-12): it used to fail the rest of the list, always the same series.
    cvPollStartedAt = Date.now();
    const pollWait = { waits: 0 };
    const activeSeries = db.prepare(`SELECT * FROM monitored_series WHERE status = 'active' AND (series_status = 'ongoing' OR series_status = 'unknown' OR series_status IS NULL)
    ORDER BY last_cv_check IS NOT NULL, last_cv_check ASC`).all();
    logger.info('cvpoller', `Checking ${activeSeries.length} active non-ended series`);
    // Metron is the second opinion on each series' status (seriesStatus.js); off without a token or after it refuses.
    let metronOn = !!(getSetting('metron_api_token') || process.env.METRON_API_TOKEN);

    for (let pi = 0; pi < activeSeries.length; pi++) {
      const series = activeSeries[pi];
      try {
        let offset = 0;
        let fetched = 0;
        let newCount = 0;

        while (true) {
          const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
            params: {
              api_key: getCVKey(), format: 'json',
              filter: `volume:${series.id}`,
              field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
              offset, limit: 100,
            },
            headers: { 'User-Agent': 'Omnibus/1.0' },
          });

          const results   = r.data.results || [];
          const total     = r.data.number_of_total_results || 0;
          const isAnnualCV = (num, name) => {
            const s = ((num || '') + ' ' + (name || '')).toLowerCase();
            return s.includes('annual') ? 1 : 0;
          };
          const insertIssue = db.prepare(`
          INSERT OR IGNORE INTO monitored_issues (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
          const txn = db.transaction(issues => {
            for (const i of issues) {
              const canonNum = IN.normIssueNumber(i.issue_number) || '0';
              const info = insertIssue.run(
                String(i.id), series.id, canonNum,
                i.name || null, i.cover_date || null, i.store_date || null,
                JSON.stringify(i),
                isAnnualCV(i.issue_number, i.name)
              );
              if (info.changes > 0) newCount++;
            }
          });
          txn(results);

          fetched += results.length;
          if (fetched >= total || results.length === 0) break;
          offset += 100;
          await new Promise(resolve => setTimeout(resolve, 600)); // ~1.6 req/sec within CV limit
        }

        // Update last_cv_check and total_issues
        db.prepare(`
        UPDATE monitored_series
        SET last_cv_check = datetime('now'),
            total_issues  = (SELECT COUNT(*) FROM monitored_issues WHERE series_id = ?)
        WHERE id = ?
      `).run(series.id, series.id);

        if (newCount > 0) logger.info('cvpoller', `${series.name}: +${newCount} new issues`);

        // Re-derive series_status from the freshly synced issues, with Metron as a second
        // opinion (rules in seriesStatus.js; the old "final issue / finale" title test is gone).
        try {
          const held = db.prepare(`SELECT MAX(COALESCE(store_date, release_date)) AS d, COUNT(*) AS n FROM monitored_issues WHERE series_id = ?`).get(series.id);
          let m = null;
          if (metronOn) {
            try {
              m = await metron.seriesStatus(series.id, { name: series.name, year: series.year, knownId: series.metron_series_id });
              if (m && m.id !== series.metron_series_id) db.prepare('UPDATE monitored_series SET metron_series_id = ? WHERE id = ?').run(m.id, series.id);
            } catch (e) {
              logger.warn('cvpoller', `Metron status check failed for "${series.name}"`, e.message);
              if (e.code === 'METRON_AUTH' || e.code === 'METRON_TOKEN_MISSING') metronOn = false;
            }
          }
          const v = seriesStatusLib.decideSeriesStatus({ newCount, latestDate: held?.d || null, issueCount: held?.n || 0, metron: m });
          db.prepare(`UPDATE monitored_series SET series_status = ?, series_status_source = ? WHERE id = ?`)
            .run(v.status, v.source, series.id);
          if (v.status !== series.series_status) {
            logger.info('cvpoller', `${series.name}: series_status ${series.series_status} → ${v.status} (${v.reason})`);
          }
        } catch (e) {
          logger.warn('cvpoller', `Status re-derive failed for "${series.name}"`, e.message);
        }

        // G1 backstop — sync disk state so files that landed since last refresh
        // are marked processed. Catches post-processor failures and user error.
        try {
          const dr = await runRefreshDirectory(series.id);
          if (dr.matched > 0) logger.info('cvpoller', `${series.name}: ${dr.matched} files matched on disk`);
        } catch (e) {
          logger.warn('cvpoller', `Disk refresh failed for "${series.name}"`, e.message);
        }

        // ComicInfo refresh for recent issues now runs in the daily retag rotation
        // (shared metadata maintenance), which checks eligible books within provider limits.

        await new Promise(resolve => setTimeout(resolve, 600)); // rate limit between series
      } catch (e) {
        if (await libraryStatus.waitForCvReset(e, pollWait, { sleep: sleepMs, logger })) { pi--; continue; }
        logger.error('cvpoller', `Failed for series ${series.id} (${series.name})`, e.message);
      }
    }
    // Also poll linked annual volumes
    const annualLinks = db.prepare(`
    SELECT DISTINCT l.annual_series_id, s.name, s.directory
    FROM series_annual_links l
    JOIN monitored_series s ON s.id = l.annual_series_id
    WHERE s.status = 'active' AND (s.series_status = 'ongoing' OR s.series_status = 'unknown' OR s.series_status IS NULL)
  `).all();

    logger.info('cvpoller', `Checking ${annualLinks.length} linked annual volumes`);

    for (let ai = 0; ai < annualLinks.length; ai++) {
      const annual = annualLinks[ai];
      try {
        let offset = 0, fetched = 0, newCount = 0, total = Infinity;
        while (fetched < total) {
          const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
            params: {
              api_key: getCVKey(), format: 'json',
              filter: `volume:${annual.annual_series_id}`,
              field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
              offset, limit: 100,
            },
            headers: { 'User-Agent': 'Omnibus/1.0' },
          });
          total = r.data.number_of_total_results || 0;
          const results = r.data.results || [];
          const insertIssue = db.prepare(`
          INSERT OR IGNORE INTO monitored_issues
            (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `);
          db.transaction(issues => {
            for (const i of issues) {
              const info = insertIssue.run(String(i.id), annual.annual_series_id,
                i.issue_number || '0', i.name || null,
                i.cover_date || null, i.store_date || null, JSON.stringify(i));
              if (info.changes > 0) newCount++;
            }
          })(results);
          fetched += results.length;
          if (!results.length) break;
          offset += 100;
          await new Promise(r => setTimeout(r, 600));
        }
        db.prepare(`UPDATE monitored_series SET last_cv_check = datetime('now'), total_issues = (SELECT COUNT(*) FROM monitored_issues WHERE series_id = ?) WHERE id = ?`)
          .run(annual.annual_series_id, annual.annual_series_id);
        if (newCount > 0) logger.info('cvpoller', `Annual ${annual.name}: +${newCount} new issues`);
        try {
          const fourMonthsAgo = Date.now() - 120 * 24 * 60 * 60 * 1000;
          let freshStatus = 'unknown';
          if (newCount > 0) {
            freshStatus = 'ongoing';
          } else {
            // Latest issue date only; the "final issue / finale" title test was dropped (2026-10-28).
            const latest = db.prepare(
              `SELECT MAX(COALESCE(store_date, release_date)) AS d FROM monitored_issues WHERE series_id = ?`
            ).get(annual.annual_series_id);
            if (latest?.d) {
              const ms = new Date(latest.d).getTime();
              freshStatus = (!isNaN(ms) && ms >= fourMonthsAgo) ? 'ongoing' : 'ended';
            }
          }
          db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`)
            .run(freshStatus, annual.annual_series_id);
        } catch (e) {
          logger.warn('cvpoller', `Status re-derive failed for annual "${annual.name}"`, e.message);
        }
        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        if (await libraryStatus.waitForCvReset(e, pollWait, { sleep: sleepMs, logger })) { ai--; continue; }
        logger.error('cvpoller', `Failed for annual ${annual.annual_series_id}`, e.message);
      }
    }

    cvPollStartedAt = 0;
    logger.info('cvpoller', 'Weekly CV poll complete');
  });

  // ─── Library series status check (hourly, 2026-11-12) ────────────
  // Unmonitored library series whose series.json still says "Continuing" (libraryStatus.js).
  // Metron first when a token is set; one Comic Vine request otherwise. Ended series are not checked.
  let libraryMetronOn = true;
  async function libraryStatusLookup(comicid, { name, year } = {}) {
    let m = null;
    if (libraryMetronOn && (getSetting('metron_api_token') || process.env.METRON_API_TOKEN)) {
      try { m = await metron.seriesStatus(comicid, { name, year }); }
      catch (e) {
        if (e.code === 'METRON_AUTH' || e.code === 'METRON_TOKEN_MISSING') libraryMetronOn = false;
        logger.warn('library-status', `Metron check failed for "${name}" — using Comic Vine`, e.message);
      }
    }
    if (m && m.status === 'ended') return { metron: m, yearEnd: m.yearEnd || null };
    if (!getCVKey()) return { metron: m, yearEnd: m?.yearEnd || null };   // Metron-only install
    const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
      params: { api_key: getCVKey(), format: 'json', filter: `volume:${comicid}`, sort: 'cover_date:desc', limit: 1, field_list: 'id,cover_date,store_date' },
      headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 15000,
    });
    const i = (r.data?.results || [])[0] || null;
    const dates = i ? [i.store_date, i.cover_date].filter(Boolean).sort() : [];
    const count = parseInt(r.data?.number_of_total_results, 10);
    return { latestDate: dates.length ? dates[dates.length - 1] : null, lastCover: i?.cover_date || null,
      issueCount: Number.isFinite(count) ? count : null, metron: m, yearEnd: m?.yearEnd || null };
  }
  const runLibraryStatusCheck = libraryStatus.createLibraryStatusCheck({
    db, lookup: libraryStatusLookup, logger,
    readSeriesJson: dir => JSON.parse(fs.readFileSync(path.join(dir, 'series.json'), 'utf8')),
    writeSeriesJson: (dir, data) => writeSeriesJsonSynced(dir, data),
    pause: () => sleepMs(1100),
  });
  // ─── Series without details: create series.json from the files (2026-11-13) ─
  // Library page › Series without details › "Create from files". For each folder without a
  // series.json, the Comic Vine volume of its comics (the largest ComicInfo series group; saved
  // lookups, the monitored issue lists, Metron, then Comic Vine outside the reserve), then the normal
  // create and enrich (Metron first, one Comic Vine volume request). One folder at a time.
  const filesJob = { running: false, stop: false, total: 0, done: 0, created: 0, skipped: [], current: null, startedAt: null, finishedAt: null, note: null };
  async function volumeForFolder(seriesId) {
    const groups = new Map();
    for (const b of db.prepare('SELECT filename, comicinfo, cv_issue_id FROM scanned_books WHERE series_id = ? AND COALESCE(is_special, 0) = 0').all(seriesId)) {
      if (/annual/i.test(b.filename || '') || !b.cv_issue_id) continue;
      const m = /<Series>([^<]*)<\/Series>/.exec(b.comicinfo || '');
      const key = (m ? m[1] : '').trim().toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(String(b.cv_issue_id));
    }
    const main = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    if (!main) return { reason: 'no Comic Vine IDs in its files' };
    for (const issueId of main.slice(0, 2)) {
      const saved = db.prepare('SELECT volume_id, volume_name FROM cv_issue_volume WHERE issue_id = ?').get(issueId);
      if (saved?.volume_id) return { id: saved.volume_id, name: saved.volume_name };
      const mon = db.prepare('SELECT series_id FROM monitored_issues WHERE id = ?').get(issueId);
      if (mon) return { id: String(mon.series_id), name: null };
      const v = await volumeOfIssueAnySource(issueId);
      db.prepare('INSERT OR REPLACE INTO cv_issue_volume (issue_id, volume_id, volume_name, at) VALUES (?, ?, ?, ?)').run(issueId, v?.id || null, v?.name || null, Date.now());
      if (v?.id) return v;
    }
    return { reason: 'its Comic Vine issue was not found' };
  }
  async function runCreateFromFiles(libraryId, userId) {
    const rows = db.prepare(`SELECT id, name, path FROM scanned_series WHERE metadata_status = 'none' ${libraryId ? 'AND library_id = ?' : ''} ORDER BY name`).all(...(libraryId ? [libraryId] : []))
      .filter(r => r.path && !fs.existsSync(path.join(r.path, 'series.json')));
    Object.assign(filesJob, { running: true, stop: false, total: rows.length, done: 0, created: 0, skipped: [], current: null, startedAt: Date.now(), finishedAt: null, note: null });
    try {
      for (const r of rows) {
        if (filesJob.stop) { filesJob.note = 'Stopped.'; break; }
        // Created by hand since the list was made: leave it alone.
        if (fs.existsSync(path.join(r.path, 'series.json'))) { filesJob.done++; continue; }
        filesJob.current = r.name;
        try {
          const v = await volumeForFolder(r.id);
          if (!v.id) { filesJob.skipped.push({ id: r.id, name: r.name, reason: v.reason }); continue; }
          // The library writer scope, as the series page's create gets from its route; one folder at a time,
          // so scans and downloads are not held up for the whole run.
          const out = await libraryAccess.run('write', () => createSeriesJsonFromVolume(r.id, v.id, userId));
          if (out.status) filesJob.skipped.push({ id: r.id, name: r.name, reason: out.error });
          else { filesJob.created++; logger.info('create-from-files', `${r.name} → ${out.name} (Comic Vine ${out.comicid})`); }
        } catch (e) {
          if (e.code === 'CV_HEADROOM' || e.code === 'CV_RATE_LIMIT') {
            filesJob.skipped.push({ id: r.id, name: r.name, reason: 'Comic Vine is at its limit; run again later for this one' });
          } else filesJob.skipped.push({ id: r.id, name: r.name, reason: e.message });
        } finally { filesJob.done++; }
      }
    } finally {
      filesJob.running = false; filesJob.current = null; filesJob.finishedAt = Date.now();
      invalidateSeriesCache();
      try { seriesGrouping.run('create from files'); } catch {}
      logger.info('create-from-files', 'Finished', { total: filesJob.total, created: filesJob.created, skipped: filesJob.skipped.length });
    }
  }
  app.get('/api/series/no-metadata/create-from-files', requireAdmin, (req, res) => res.json(filesJob));
  app.post('/api/series/no-metadata/create-from-files', requireAdmin, (req, res) => {
    if (filesJob.running) return res.json(filesJob);
    if (!anyProvider()) return res.status(400).json({ error: 'Set a Comic Vine API key or a Metron token first (Settings → Connections)' });
    setImmediate(() => runCreateFromFiles(req.body?.libraryId || null, req.user?.sub || null).catch(e => logger.error('create-from-files', 'Failed', e.message)));
    filesJob.running = true;
    res.json(filesJob);
  });
  app.post('/api/series/no-metadata/create-from-files/stop', requireAdmin, (req, res) => { filesJob.stop = true; res.json(filesJob); });

  // Manual run (admin): one batch now; results go to the server log (library-status).
  app.post('/api/monitor/library-status/run', requireAdmin, (req, res) => {
    if (!anyProvider()) return res.status(400).json({ error: 'Set a Comic Vine API key or a Metron token first (Settings → Connections)' });
    setImmediate(() => runLibraryStatusCheck().catch(e => logger.error('library-status', 'Run failed', e.message)));
    res.json({ ok: true, message: 'Library status check started — see server log (library-status)' });
  });
  // ─── Series linked to the wrong Comic Vine volume (hourly, 2026-11-13) ─
  // seriesLinkCheck.js; listed on the Library page. Which Comic Vine volume an issue belongs to:
  // Metron first (it keeps Comic Vine IDs; its own allowance), then one Comic Vine 'issue' request.
  // The background check never uses the last CV_LINK_RESERVE 'issue' requests of the hour, so a
  // re-link (which needs them) is not left waiting behind it.
  const CV_LINK_RESERVE = 40;
  let linkMetronOn = true;
  const metronSeriesCv = new Map();   // Metron series id → { id, name } (Comic Vine volume)
  async function metronVolumeOfIssue(cvIssueId) {
    if (!linkMetronOn || !(getSetting('metron_api_token') || process.env.METRON_API_TOKEN)) return null;
    try {
      const r = await metron.get('issue/', { cv_id: cvIssueId });
      const hit = (r && r.results || [])[0];
      if (!hit) return null;
      let seriesId = hit.series && hit.series.id;
      if (!seriesId) {
        const d = await metron.get(`issue/${hit.id}/`);
        if (!d || String(d.cv_id) !== String(cvIssueId)) return null;
        seriesId = d.series && d.series.id;
      }
      if (!seriesId) return null;
      if (!metronSeriesCv.has(seriesId)) {
        const sr = await metron.get(`series/${seriesId}/`);
        metronSeriesCv.set(seriesId, sr && sr.cv_id ? { id: String(sr.cv_id), name: sr.name || null } : null);
      }
      return metronSeriesCv.get(seriesId);
    } catch (e) {
      if (e.code === 'METRON_AUTH' || e.code === 'METRON_TOKEN_MISSING') linkMetronOn = false;
      logger.warn('series-links', `Metron lookup failed for issue ${cvIssueId} — using Comic Vine`, e.message);
      return null;
    }
  }
  // The Comic Vine volume of one Comic Vine issue: Metron first, then one Comic Vine request outside
  // the reserve kept for clicks (throws CV_HEADROOM inside it). Shared by the link check and
  // "Create from files".
  async function volumeOfIssueAnySource(issueId) {
    const m = await metronVolumeOfIssue(issueId);
    if (m) return m;
    if (!getCVKey()) return null;   // Metron-only install: unknown for now
    if (cvWindow('issue').used >= CV_CAP_BACKGROUND - CV_LINK_RESERVE)
      throw Object.assign(new Error('Comic Vine allowance kept for clicks'), { code: 'CV_HEADROOM' });
    const r = await cvApiGet(`https://comicvine.gamespot.com/api/issue/4000-${issueId}/`, {
      params: { api_key: getCVKey(), format: 'json', field_list: 'id,volume' }, headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000 });
    const v = r.data?.results?.volume;
    return v?.id ? { id: String(v.id), name: v.name || null } : null;
  }
  const seriesLinkCheck = require('./seriesLinkCheck').createSeriesLinkCheck({
    db, logger, pause: () => sleepMs(1100), volumeOfIssue: volumeOfIssueAnySource,
  });
  // A re-link (enricher create) waits up to an hour when Comic Vine is at its limit; say so instead.
  // Returns null when Comic Vine can take the re-link's requests now, else the time it can.
  function cvBusyUntil() {
    const now = Date.now();
    let until = 0;
    for (const resource of ['volume', 'issue']) {
      const bo = db.prepare('SELECT until FROM cv_backoff WHERE resource = ?').get(resource);
      if (bo && bo.until > now) until = Math.max(until, bo.until);
      const w = cvWindow(resource);
      if (w.resetAt && w.used >= CV_CAP_INTERACTIVE - 5) until = Math.max(until, w.resetAt);
    }
    return until || null;
  }
  cron.schedule('41 * * * *', () => {
    if (!anyProvider()) return;
    if (cvPollStartedAt && Date.now() - cvPollStartedAt < 6 * 60 * 60 * 1000) return;
    seriesLinkCheck.run().catch(e => logger.error('series-links', 'Run failed', e.message));
  });
  app.get('/api/admin/library-health/series-links', requireAdmin, (req, res) => {
    try { res.json({ items: seriesLinkCheck.mismatches(), progress: seriesLinkCheck.progress() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/library-health/series-links/run', requireAdmin, (req, res) => {
    if (!anyProvider()) return res.status(400).json({ error: 'Set a Comic Vine API key or a Metron token first (Settings → Connections)' });
    // A larger batch on request: most lookups go to Metron, and Comic Vine's reserve is kept.
    seriesLinkCheck.run({ limit: 300 }).catch(e => logger.error('series-links', 'Run failed', e.message));
    res.json({ ok: true });
  });
  // "Link is right": the folder's series.json stays as it is.
  app.post('/api/admin/library-health/series-links/:id/dismiss', requireAdmin, (req, res) => {
    res.json({ ok: seriesLinkCheck.dismiss(req.params.id) });
  });
  // Either source is enough: Comic Vine, Metron, or both (an install may have only one key).
  const metronToken = () => getSetting('metron_api_token') || process.env.METRON_API_TOKEN || '';
  const anyProvider = () => !!(getCVKey() || metronToken());
  cron.schedule('23 * * * *', () => {
    if (!anyProvider()) return;
    if (cvPollStartedAt && Date.now() - cvPollStartedAt < 6 * 60 * 60 * 1000) return;
    runLibraryStatusCheck().catch(e => logger.error('library-status', 'Run failed', e.message));
  });
  return { cvBusyUntil, metronToken, seriesLinkCheck };
};
