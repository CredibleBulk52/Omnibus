'use strict';
// ─── Wanted issues: auto-grab, wanted list, wanted scanner, failed-issue retry ───
// Moved out of server.js (2026-11-05, downloads stage 3); the search itself is shared
// with the next-source retry in ./sourceSearch.js. Routes and the two
// schedules (scan every 6 hours; failed issues back to wanted every 2 days) are set up
// when server.js creates this; server.js passes in what it shares.
module.exports.createWanted = function createWanted(deps) {
  const missing = ['activeDownloads', 'activePackFor', 'annotateWaiting', 'app', 'cron', 'db', 'finalizeCancellation', 'getSetting', 'isCancelled', 'logger', 'PROWLARR_API_KEY', 'PROWLARR_URL', 'pushDownloadUpdate', 'requireDownloadAccess', 'retryPolicy', 'runDdlDownload', 'runFillAutoRemove', 'SABNZBD_API_KEY', 'SABNZBD_URL', 'sourceSearch'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createWanted: missing ${missing.join(', ')}`);
  const { activeDownloads, activePackFor, annotateWaiting, app, cron, db, finalizeCancellation, getSetting, isCancelled, logger, PROWLARR_API_KEY, PROWLARR_URL, pushDownloadUpdate, requireDownloadAccess, retryPolicy, runDdlDownload, runFillAutoRemove, SABNZBD_API_KEY, SABNZBD_URL, sourceSearch } = deps;

// ─── Auto-grab endpoint ───────────────────────────────────────────
// Searches Prowlarr for every wanted issue in a series and grabs the
// best-scoring result. Runs server-side so it won't time out.
// Returns { grabbed, skipped, errors } counts + per-issue detail.
// Auto-grab every wanted issue of one monitored series (background). Used by
// the route below and by Fill missing issues. Returns { status, error } on a
// refusal, else what the route sends.
function startAutoGrab(id) {
  id = String(id);
  const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(id);
  if (!series) return { status: 404, error: 'Series not found' };
  if (series.series_type === 'manga') return { status: 400, error: 'Auto-grab not available for manga — use Nyaa search to download volumes manually' };

  const wantedIssues = db.prepare(
    `SELECT * FROM monitored_issues WHERE series_id = ? AND status = 'wanted' ORDER BY CAST(issue_number AS REAL)`
  ).all(id);

  if (!wantedIssues.length) return { grabbed: 0, skipped: 0, errors: 0, detail: [], async: false };

  // Respond immediately — auto-grab runs in background. The previous synchronous
  // version blocked until every wanted issue was searched + grabbed, which for
  // series with many wanted issues takes minutes and almost always hits a proxy
  // or browser timeout. Now we spawn the work in setImmediate and report
  // progress via the same activeDownloads/SSE toast system used by DDL.
  const started = { async: true, total: wantedIssues.length, message: `Auto-grab started for ${wantedIssues.length} issue(s)` };

  setImmediate(async () => {
    const prowlarrUrl = getSetting('prowlarr_url') || PROWLARR_URL;
    const prowlarrKey = getSetting('prowlarr_api_key') || PROWLARR_API_KEY;
    const sabUrl      = getSetting('sabnzbd_url')     || SABNZBD_URL;
    const sabKey      = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;

    if (!prowlarrUrl || !prowlarrKey) {
      logger.error('auto-grab', `Series ${id} aborted — Prowlarr not configured`, { prowlarrUrl: !!prowlarrUrl, prowlarrKey: !!prowlarrKey });
    }
    if (!sabUrl || !sabKey) {
      logger.error('auto-grab', `Series ${id} aborted — SABnzbd not configured`, { sabUrl: !!sabUrl, sabKey: !!sabKey });
    }

    const dlId = `auto-grab-${id}-${Date.now()}`;
    const dlEntry = {
      id: dlId,
      filename: `Auto-grab: ${series.name}`,
      seriesName: series.name,
      bytesReceived: 0,
      totalBytes: wantedIssues.length,
      status: 'downloading',
      startedAt: new Date().toISOString(),
    };
    activeDownloads.set(dlId, dlEntry);
    pushDownloadUpdate(dlEntry);

    logger.info('auto-grab', `Series ${id} starting — ${wantedIssues.length} wanted issue(s)`);

    const detail = [];
    let grabbed = 0, skipped = 0, errors = 0;

    for (let i = 0; i < wantedIssues.length; i++) {
      // Cancel check — user clicked ✕ on the toast. Stop iterating; issues
      // already sent to SABnzbd continue in SAB (those aren't Omnibus's to
      // cancel), but we stop grabbing new ones.
      if (isCancelled(dlId)) {
        logger.info('auto-grab', `Series ${id} cancelled by user after ${grabbed} grabbed, ${skipped} skipped`, { remaining: wantedIssues.length - i });
        finalizeCancellation(dlEntry, `Cancelled: ${grabbed} grabbed, ${wantedIssues.length - i} not processed`);
        return;
      }
      const issue = wantedIssues[i];
      dlEntry.filename = `Auto-grab: ${series.name} — ${i + 1}/${wantedIssues.length} (#${issue.issue_number})`;
      dlEntry.bytesReceived = i;
      pushDownloadUpdate({ ...dlEntry });

      try {
        // Search, link choice and SABnzbd hand-off are shared with the wanted scanner
        // and the next-source retry (./sourceSearch.js, 2026-11-05).
        const { ddl: ddlCandidates, nzb: nzbCandidates, q, qGc, blocked } = await sourceSearch.findSources(issue, series.name, series.year);
        logger.debug('auto-grab', `Searched #${issue.issue_number}`, { q, qGc });

        // Pick best: DDL preferred (no usenet retention concerns, faster
        // post-processing, no SAB par2 overhead), NZB as fallback.
        const best = ddlCandidates[0] || nzbCandidates[0] || null;
        const sendNzb = async (cand, source) => {
          const sab = await sourceSearch.sendToSab(cand);
          if (sab.ok) {
            db.prepare(`UPDATE monitored_issues SET status='snatched', download_id=?, download_url=? WHERE id=?`).run(sab.nzo_id, cand.downloadUrl, issue.id);
            detail.push({ issue_number: issue.issue_number, result: 'grabbed', source, title: cand.title, score: cand._score });
            grabbed++;
            logger.info('auto-grab', `#${issue.issue_number} ${source === 'nzb' ? 'NZB' : 'NZB fallback'} grabbed`, { title: cand.title, score: cand._score });
          } else {
            detail.push({ issue_number: issue.issue_number, result: 'error', reason: sab.error });
            errors++;
            logger.warn('auto-grab', `#${issue.issue_number} SAB rejected`, { reason: sab.error });
          }
        };

        if (!best) {
          detail.push({ issue_number: issue.issue_number, result: 'skipped', reason: 'no match' });
          skipped++;
          logger.info('auto-grab', `#${issue.issue_number} skipped — no match`, { q, qGc });
        } else if (best._source === 'ddl') {
          let link = null;
          try { link = await sourceSearch.pickDdlLink(issue, best.url, blocked, 'auto-grab'); }
          catch (gcErr) { logger.warn('auto-grab', `GC link fetch failed for #${issue.issue_number}`, gcErr.message); }
          if (link) {
            db.prepare(`UPDATE monitored_issues SET status='snatched', download_id='ddl', download_url=? WHERE id=?`)
              .run(link.url, issue.id);
            setImmediate(() => runDdlDownload(issue, series, link.url, null));
            detail.push({ issue_number: issue.issue_number, result: 'grabbed', source: 'ddl', title: best.title || best.url, score: best._score });
            grabbed++;
            logger.info('auto-grab', `#${issue.issue_number} DDL grabbed`, { title: best.title || best.url, score: best._score });
          } else if (nzbCandidates[0]) {
            // DDL failed to resolve any usable link — fall back to NZB
            await sendNzb(nzbCandidates[0], 'nzb-fallback');
          } else {
            detail.push({ issue_number: issue.issue_number, result: 'skipped', reason: 'DDL link unresolvable, no NZB fallback' });
            skipped++;
          }
        } else {
          // NZB-only path (no DDL match was found) — send to SABnzbd
          await sendNzb(best, 'nzb');
        }
      } catch (e) {
        detail.push({ issue_number: issue.issue_number, result: 'error', reason: e.message });
        errors++;
        logger.warn('auto-grab', `#${issue.issue_number} error`, e.message);
      }
      // Rate limit: don't hammer Prowlarr
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    // Final toast — show a short summary then auto-remove
    dlEntry.bytesReceived = wantedIssues.length;
    dlEntry.status = 'complete';
    dlEntry.filename = `Auto-grab ${series.name}: ${grabbed} grabbed, ${skipped} skipped${errors ? `, ${errors} error${errors !== 1 ? 's' : ''}` : ''}`;
    pushDownloadUpdate({ ...dlEntry });
    setTimeout(() => { activeDownloads.delete(dlId); pushDownloadUpdate({ id: dlId, status: 'removed' }); }, 12000);

    logger.info('auto-grab', `Series ${id} done`, { grabbed, skipped, errors });
  });
  return started;
}

app.post('/api/monitor/series/:id/auto-grab', requireDownloadAccess, (req, res) => {
  const r = startAutoGrab(req.params.id);
  if (r.status) return res.status(r.status).json({ error: r.error });
  res.json(r);
});

// ─── Global wanted list ───────────────────────────────────────────
// Returns wanted/snatched/downloaded/errored/failed issues across every monitored series.
app.get('/api/monitor/wanted', (req, res) => {
  const rows = db.prepare(`
    SELECT
      i.*,
      s.name        AS series_name,
      s.directory   AS series_directory,
      s.publisher   AS series_publisher,
      s.year        AS series_year,
      s.image_url   AS series_image_url
    FROM monitored_issues i
    JOIN monitored_series s ON s.id = i.series_id
    WHERE i.status IN ('wanted', 'snatched', 'downloaded', 'failed')
      AND (s.series_type IS NULL OR s.series_type != 'manga')
    ORDER BY s.name COLLATE NOCASE, CAST(i.issue_number AS REAL)
  `).all();
  const packs = new Map();
  for (const r of rows) {
    if (!packs.has(r.series_id)) packs.set(r.series_id, activePackFor(r.series_id));
    annotateWaiting(r, packs.get(r.series_id));
  }
  res.json(rows);
});

// ─── Wanted scanner ───────────────────────────────────────────────
// Iterates every wanted issue across all series and tries Prowlarr.
// Skips issues whose release/store date is in the future.
// Year is included in the search query to improve accuracy.
const wantedScanState = {
  running: false,
  lastRun: null,
  grabbed: 0,
  skipped: 0,
  errors: 0,
  total: 0,
  done: 0,
};

async function runWantedScan() {
  if (wantedScanState.running) {
    logger.info('wanted-scan', 'Already running, skipping');
    return;
  }
  wantedScanState.running = true;
  wantedScanState.grabbed = 0;
  wantedScanState.skipped = 0;
  wantedScanState.errors  = 0;
  wantedScanState.done    = 0;

  try {
    const today = new Date().toISOString().slice(0, 10);

    // Only grab issues at or past their release date (or with no date recorded)
    const wanted = db.prepare(`
      SELECT i.*, s.name AS series_name, s.year AS series_year, s.directory, s.publisher
      FROM monitored_issues i
      JOIN monitored_series s ON s.id = i.series_id
      WHERE i.status = 'wanted'
        AND (i.retry_after IS NULL OR i.retry_after <= datetime('now'))
        AND (s.series_type IS NULL OR s.series_type != 'manga')
        -- covered by a pack still downloading or waiting to be processed
        AND NOT EXISTS (SELECT 1 FROM series_packs p WHERE p.status IN ('snatched', 'downloaded', 'processing')
          AND (p.series_id = i.series_id OR p.series_id IN (SELECT parent_series_id FROM series_annual_links WHERE annual_series_id = i.series_id)))
        AND (
          (i.store_date  IS NULL OR i.store_date  = '' OR i.store_date  <= ?)
          OR
          (i.release_date IS NULL OR i.release_date = '' OR i.release_date <= ?)
        )
      ORDER BY s.name COLLATE NOCASE, CAST(i.issue_number AS REAL)
    `).all(today, today);

    wantedScanState.total = wanted.length;
    logger.info('wanted-scan', `Starting scan of ${wanted.length} wanted issues`);

    for (const issue of wanted) {
      wantedScanState.current = { seriesName: issue.series_name, issueNumber: issue.issue_number, issueId: issue.id };
      try {
        // Search, link choice and SABnzbd hand-off are shared with auto-grab and the
        // next-source retry (./sourceSearch.js, 2026-11-05). Sources that already failed
        // for this issue are never retried automatically.
        const { ddl: ddlCandidates, nzb: nzbCandidates, q, qGc, blocked } = await sourceSearch.findSources(issue, issue.series_name, issue.series_year);

        // Pick best: DDL first if available, then best NZB
        const best = ddlCandidates[0] || nzbCandidates[0] || null;
        const sendNzb = async (cand, what) => {
          const sab = await sourceSearch.sendToSab(cand);
          if (sab.ok) {
            db.prepare(`UPDATE monitored_issues SET status='snatched', download_id=?, download_url=? WHERE id=?`).run(sab.nzo_id, cand.downloadUrl, issue.id);
            logger.info('wanted-scan', `${what} grabbed ${issue.series_name} #${issue.issue_number}`, { score: cand._score, title: cand.title, q });
            wantedScanState.grabbed++;
            return true;
          }
          return false;
        };

        if (!best) {
          logger.info('wanted-scan', `No sources found for ${issue.series_name} #${issue.issue_number}`, { q, qGc });
          wantedScanState.skipped++;
        } else if (best._source === 'ddl') {
          // Grab via GetComics DDL
          let link = null;
          try { link = await sourceSearch.pickDdlLink(issue, best.url, blocked, 'wanted-scan'); }
          catch (gcErr) { logger.info('wanted-scan', `GC link fetch failed for ${issue.series_name} #${issue.issue_number}`, gcErr.message); }
          if (link) {
            const issueSeries = { id: issue.series_id, name: issue.series_name, year: issue.series_year, directory: issue.directory, publisher: issue.publisher };
            db.prepare(`UPDATE monitored_issues SET status='snatched', download_id='ddl', download_url=? WHERE id=?`)
              .run(link.url, issue.id);
            setImmediate(() => runDdlDownload(issue, issueSeries, link.url, null));
            logger.info('wanted-scan', `DDL grabbed ${issue.series_name} #${issue.issue_number}`, { score: best._score, title: best.title || best.url, qGc });
            wantedScanState.grabbed++;
          } else if (!(nzbCandidates[0] && await sendNzb(nzbCandidates[0], 'NZB fallback'))) {
            // DDL failed to resolve links and there is no NZB that SABnzbd took
            logger.info('wanted-scan', `No sources found for ${issue.series_name} #${issue.issue_number}`, { q, qGc });
            wantedScanState.skipped++;
          }
        } else if (!(await sendNzb(best, 'NZB'))) {
          logger.warn('wanted-scan', `SABnzbd rejected ${issue.series_name} #${issue.issue_number}`);
          wantedScanState.errors++;
        }
      } catch (e) {
        logger.warn('wanted-scan', `Error on ${issue.series_name} #${issue.issue_number}`, e.message);
        wantedScanState.errors++;
      }
      wantedScanState.done++;
      await new Promise(r => setTimeout(r, 800)); // rate-limit
    }

    wantedScanState.lastRun = new Date().toISOString();
    logger.info('wanted-scan', 'Scan complete', {
      grabbed: wantedScanState.grabbed,
      skipped: wantedScanState.skipped,
      errors:  wantedScanState.errors,
    });
  } catch (e) {
    logger.error('wanted-scan', 'Scan failed', e.message);
  } finally {
    wantedScanState.running = false;
    try { runFillAutoRemove(); } catch (e) { logger.warn('fill', 'Auto-remove check failed', e.message); }
    wantedScanState.current = null;
  }
}

// ─── Retry of failed issues (every 2 days, 05:50 UTC) ────────────
// Was weekly (Sundays) until 2026-10-08; every 2 days catches late uploads sooner.
// Runs on even dates (2nd, 4th … 30th); from the 30th to the 2nd the gap is
// 2–3 days depending on month length.
// A failed issue never got searched again, though good releases often appear
// days later. Each run: put failed issues back to wanted (up to 4 times), so
// the 06:00 scan tries them. Sources that already failed stay excluded, except
// rate-limit failures, which were temporary. After 4 retries an issue stays failed
// until Reset in the Download Manager.
const FAILED_RETRY_MAX_WEEKS = 4;
function requeueFailedIssues(trigger = 'scheduled') {
  try {
    // Retry-kind blocks of these failed issues are released, so a source the host fixed
    // gets another chance; permanent ones (unsupported host, folder link) stay (2026-11-03).
    const released = retryPolicy.releaseForFailedRetry(FAILED_RETRY_MAX_WEEKS);
    if (released) logger.info('failed-retry', `Released ${released} blocked link(s) for another try`);
    const { changes } = db.prepare(`
      UPDATE monitored_issues
      SET status = 'wanted', download_id = NULL, file_path = NULL, retry_after = NULL,
          retry_epoch = datetime('now'), weekly_retries = COALESCE(weekly_retries, 0) + 1
      WHERE status = 'failed' AND COALESCE(weekly_retries, 0) < ?
    `).run(FAILED_RETRY_MAX_WEEKS);
    logger.info('failed-retry', `Failed-issue retry (${trigger}): ${changes} failed issue(s) back to wanted`);
    return changes;
  } catch (e) {
    logger.error('failed-retry', 'Failed-issue retry failed', e.message);
    return 0;
  }
}
const FAILED_RETRY_DAYS = '2,4,6,8,10,12,14,16,18,20,22,24,26,28,30';   // every 2 days (even dates)
cron.schedule(`50 5 ${FAILED_RETRY_DAYS} * *`, () => requeueFailedIssues('scheduled'));

// Manual trigger — responds immediately, scan runs in background
app.post('/api/monitor/wanted/scan', requireDownloadAccess, (req, res) => {
  if (wantedScanState.running) {
    return res.json({ started: false, reason: 'Already running', state: wantedScanState });
  }
  setImmediate(runWantedScan);
  res.json({ started: true, state: wantedScanState });
});

// Poll scan progress / last-run info
app.get('/api/monitor/wanted/scan/status', (req, res) => {
  res.json(wantedScanState);
});

// Scheduled: every 6 hours
cron.schedule('0 */6 * * *', () => {
  logger.info('wanted-scan', 'Scheduled scan triggered');
  runWantedScan();
});

return { startAutoGrab, runWantedScan, requeueFailedIssues, wantedScanState, FAILED_RETRY_MAX_WEEKS };
};
