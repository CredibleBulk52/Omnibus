'use strict';
// ─── Download watcher (moved out of server.js 2026-11-19, server.js split step 7A) ───
// The completion watcher (SABnzbd and qBittorrent results, dead torrents, then post-processing of
// downloaded issues and packs), the download progress poller, the series status backfill from
// series.json, and the library scan schedule. Moved unchanged, timers included.
const axios = require('axios');

const NEEDS = ['activeDownloads', 'asArrival', 'blacklistAndRetry', 'db', 'deriveStatusFromSeriesJson', 'getSetting', 'logger', 'metadataRuntime', 'postProcess', 'postProcessPack', 'pushDownloadUpdate', 'qbtLogin', 'runLibraryScan', 'SABNZBD_API_KEY', 'SABNZBD_URL', 'scanner'];
module.exports.NEEDS = NEEDS;

module.exports.createDownloadWatcher = function createDownloadWatcher(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createDownloadWatcher: missing ${missing.join(', ')}`);
  const { activeDownloads, asArrival, blacklistAndRetry, db, deriveStatusFromSeriesJson, getSetting, logger, metadataRuntime, postProcess, postProcessPack, pushDownloadUpdate, qbtLogin, runLibraryScan, SABNZBD_API_KEY, SABNZBD_URL, scanner } = deps;
  // ─── SABnzbd completion watcher ───────────────────────────────────
  // Two-phase loop every 60s:
  //   Phase 1 — check 'snatched' items against SABnzbd history
  //             Completed → mark 'downloaded' (stores file path)
  //             Failed    → reset to 'wanted' so user can re-grab
  //   Phase 2 — run post-processor on all 'downloaded' items
  //             Success → mark 'processed'
  //             Failure → leave as 'downloaded', retry next tick automatically
  // ─── Dead torrent detection (issues and packs) ───────────────────
  // A torrent is dead when qBittorrent reports an error, when it has made no
  // download progress for QBT_STALL_HOURS (no seeders: state stalledDL, or
  // metaDL when it never got metadata), or when it has vanished from qBittorrent
  // for QBT_MISSING_GRACE_MS (removed by hand). Paused/stopped and queued
  // torrents are never counted as stalled. Dead torrents are removed from
  // qBittorrent (partial data kept on disk) and the issue goes through the same
  // retry path as GetComics and Usenet failures.
  const QBT_STALL_HOURS      = 48;
  const QBT_MISSING_GRACE_MS = 30 * 60 * 1000;
  const QBT_STALL_STATES     = new Set(['stalledDL', 'metaDL', 'forcedMetaDL']);
  const qbtMissingSince      = new Map();   // hash → first time it was not found
  function qbtLastProgressMs(t) {
    return Math.max(t?.last_activity || 0, t?.added_on || 0) * 1000;
  }
  function qbtDeadReason(t, hash) {
    if (!t) {
      const first = qbtMissingSince.get(hash) || Date.now();
      qbtMissingSince.set(hash, first);
      return Date.now() - first > QBT_MISSING_GRACE_MS ? 'Torrent no longer in qBittorrent' : null;
    }
    qbtMissingSince.delete(hash);
    if (t.state === 'error' || t.state === 'missingFiles') return `qBittorrent: ${t.state}`;
    if (QBT_STALL_STATES.has(t.state) && (t.progress || 0) < 1) {
      const last = qbtLastProgressMs(t);
      const hours = last ? (Date.now() - last) / 3600000 : 0;
      if (hours >= QBT_STALL_HOURS) {
        return `qBittorrent: stalled, no download progress for ${Math.floor(hours)} h (${Math.round((t.progress || 0) * 100)}% done)`;
      }
    }
    return null;
  }
  async function qbtRemoveTorrent(url, qbtHeaders, hash) {
    try {
      await axios.post(`${url}/api/v2/torrents/delete`, `hashes=${encodeURIComponent(hash)}&deleteFiles=false`, {
        headers: { ...qbtHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000,
      });
      logger.info('watcher', `Removed dead torrent ${hash} from qBittorrent (partial data kept)`);
    } catch (e) {
      logger.warn('watcher', `Could not remove torrent ${hash} from qBittorrent`, e.message);
    }
  }

  let watcherBusy = false;

  // SAB statuses that mean "still working, don't touch". Anything NOT in this set
  // and NOT 'Completed' is a real failure. Historically we only whitelisted
  // Downloading/Queued/Paused/Checking, which caused 'Extracting' / 'Verifying' /
  // 'Repairing' jobs to be wrongly marked as failed mid-unpack.
  // Full list cross-referenced with SAB API docs + status filter UI.
  const SAB_IN_PROGRESS = new Set([
    'Downloading', 'Queued', 'Paused', 'Checking',
    'Extracting', 'Verifying', 'Repairing', 'Moving',
    'QuickCheck', 'Running', 'Fetching', 'Propagating',
    'Grabbing',
  ]);

  // DDL issues whose download job is post-processing them right now.
  const ddlPostProcessing = new Set();

  async function runCompletionWatcher() {
    if (watcherBusy) return;
    watcherBusy = true;
    try {

      // ── Phase 1: snatched → downloaded ──────────────────────────────
      const snatched = db.prepare(`
      SELECT i.*, s.name AS series_name, s.publisher, s.year, s.directory
      FROM monitored_issues i
      JOIN monitored_series s ON s.id = i.series_id
      WHERE i.status = 'snatched' AND i.download_id IS NOT NULL
        AND i.download_id != 'ddl'
    `).all();

      // Fetch SABnzbd history once — reused by Phase 1 and Phase 3
      let historySlots = null;

      if (snatched.length) {
        // Split snatched issues by source. download_id starts with 'qbt_' for
        // qBit-routed comic torrents; everything else is a SAB nzo_id.
        const sabSnatched = snatched.filter(i => !String(i.download_id).startsWith('qbt_'));
        const qbtSnatched = snatched.filter(i =>  String(i.download_id).startsWith('qbt_'));

        // ── SAB completion check ──
        if (sabSnatched.length) {
          const sabUrl = getSetting('sabnzbd_url')     || SABNZBD_URL;
          const sabKey = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;

          const r = await axios.get(`${sabUrl}/api`, {
            params: { apikey: sabKey, mode: 'history', output: 'json', limit: 200 },
            timeout: 10000,
          });
          historySlots = r.data?.history?.slots || [];

          for (const issue of sabSnatched) {
            const slot = historySlots.find(s => s.nzo_id === issue.download_id);
            if (!slot) continue;

            logger.debug('watcher', `Phase1: slot for issue ${issue.id}`, { status: slot.status });

            if (slot.status === 'Completed') {
              // Store the file path from SABnzbd so Phase 2 knows where to find it
              db.prepare(`UPDATE monitored_issues SET status = 'downloaded', file_path = ?, retry_after = NULL WHERE id = ?`)
                .run(slot.storage, issue.id);
              logger.info('watcher', `Issue ${issue.id} downloaded`, { storage: slot.storage });
            } else if (!SAB_IN_PROGRESS.has(slot.status)) {
              // Any status that isn't Completed and isn't an in-progress state is a
              // real failure (Failed, Aborted, etc.). See SAB_IN_PROGRESS for the
              // full list of recognized in-progress states.
              logger.warn('watcher', `SABnzbd job failed for issue ${issue.id}`, { nzo_id: issue.download_id, status: slot.status });
              const failedUrl = issue.download_url || null;
              const seriesForRetry = { id: issue.series_id, name: issue.series_name, publisher: issue.publisher, year: issue.year, directory: issue.directory };
              // Reset first so retry sees clean state
              db.prepare(`UPDATE monitored_issues SET status='wanted', download_id=NULL, file_path=NULL WHERE id=?`).run(issue.id);
              setImmediate(async () => {
                try { await blacklistAndRetry({ ...issue, status: 'wanted' }, seriesForRetry, failedUrl, `SABnzbd: ${slot.status}`); }
                catch (e) { logger.error('retry', `watcher blacklistAndRetry failed for ${issue.id}`, e.message); }
              });
            }
          }
        }

        // ── qBit completion check (single issue) ──
        // Same shape as SAB block above but querying qBit's torrents/info API.
        // Dead torrents (error, stalled 48 h, or removed) are removed from qBit
        // and go through blacklistAndRetry, which tries GetComics/Usenet next.
        // Before 2026-10-08 errors were marked failed with no retry, and stalled
        // torrents stayed 'snatched' forever.
        if (qbtSnatched.length) {
          try {
            const { url, qbtHeaders } = await qbtLogin();
            const r = await axios.get(`${url}/api/v2/torrents/info`, {
              headers: qbtHeaders,
              timeout: 5000,
            });
            const torrents = r.data || [];
            const completedStates = new Set(['uploading', 'pausedUP', 'stalledUP', 'queuedUP', 'forcedUP', 'checkingUP']);
            for (const issue of qbtSnatched) {
              const hash = String(issue.download_id).replace('qbt_', '').toLowerCase();
              const t = torrents.find(x => x.hash?.toLowerCase() === hash);
              const isComplete = t && ((t.progress >= 1) || completedStates.has(t.state));
              const deadReason = isComplete ? null : qbtDeadReason(t, hash);
              if (isComplete) {
                const filePath = t.content_path || t.save_path;
                db.prepare(`UPDATE monitored_issues SET status = 'downloaded', file_path = ?, retry_after = NULL WHERE id = ?`)
                  .run(filePath, issue.id);
                logger.info('watcher', `Issue ${issue.id} downloaded (qBit)`, { hash, content_path: filePath });
              } else if (deadReason) {
                logger.warn('watcher', `qBit torrent dead for issue ${issue.id}`, { hash, state: t?.state, reason: deadReason });
                if (t) await qbtRemoveTorrent(url, qbtHeaders, hash);
                qbtMissingSince.delete(hash);
                const failedUrl = issue.download_url || null;
                const seriesForRetry = { id: issue.series_id, name: issue.series_name, publisher: issue.publisher, year: issue.year, directory: issue.directory };
                db.prepare(`UPDATE monitored_issues SET status='wanted', download_id=NULL, file_path=NULL WHERE id=?`).run(issue.id);
                setImmediate(async () => {
                  try { await blacklistAndRetry({ ...issue, status: 'wanted' }, seriesForRetry, failedUrl, deadReason); }
                  catch (e) { logger.error('retry', `watcher blacklistAndRetry failed for ${issue.id}`, e.message); }
                });
              }
            }
          } catch (e) {
            logger.warn('watcher', 'qBit issue status check failed', e.message);
          }
        }
      }

      // ── Phase 2: downloaded → processed ─────────────────────────────
      // Includes DDL issues stuck as 'downloaded' for >10 minutes (runDdlDownload crashed mid-flight)
      const downloaded = db.prepare(`
      SELECT i.*, s.name AS series_name, s.publisher, s.year, s.directory
      FROM monitored_issues i
      JOIN monitored_series s ON s.id = i.series_id
      WHERE i.status = 'downloaded' AND i.file_path IS NOT NULL
        AND (i.retry_after IS NULL OR i.retry_after <= datetime('now'))
    `).all()
        // A DDL issue is post-processed by its own download job. Skip only while
        // that job is running in this process; after a restart (or a crash of the
        // job) the watcher resumes it. The old date_processed test never matched
        // because DDL downloads leave date_processed NULL.
        .filter(i => i.download_id !== 'ddl' || !ddlPostProcessing.has(i.id));

      for (const issue of downloaded) {
        // Fetch the full series row so parent_series_id and all other fields are available
        const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(issue.series_id) || {
          id:        issue.series_id,
          name:      issue.series_name,
          publisher: issue.publisher,
          year:      issue.year,
          directory: issue.directory,
        };
        await asArrival('postprocess', () => postProcess(issue, series, issue.file_path));
      }

      // ── Phase 3: pack snatched → downloaded ──────────────────────────
      const snatchedPacks = db.prepare(`
      SELECT p.*, s.name, s.publisher, s.year, s.directory
      FROM series_packs p
      JOIN monitored_series s ON s.id = p.series_id
      WHERE p.status = 'snatched' AND p.download_id IS NOT NULL
    `).all();

      if (snatchedPacks.length) {
        // Split packs by source — SAB packs have download_id starting with the
        // SAB nzo_id, qBit packs start with 'qbt_'. The two sources need to be
        // queried independently because their status APIs are different.
        const sabPacks = snatchedPacks.filter(p => !String(p.download_id).startsWith('qbt_'));
        const qbtPacks = snatchedPacks.filter(p =>  String(p.download_id).startsWith('qbt_'));

        // ── SAB pack status check ──
        if (sabPacks.length) {
          // Reuse already-fetched history if available, else fetch
          let packHistory = historySlots;
          if (!packHistory) {
            const sabUrl = getSetting('sabnzbd_url')     || SABNZBD_URL;
            const sabKey = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;
            const pr = await axios.get(`${sabUrl}/api`, {
              params: { apikey: sabKey, mode: 'history', output: 'json', limit: 200 },
              timeout: 10000,
            });
            packHistory = pr.data?.history?.slots || [];
          }

          for (const pack of sabPacks) {
            const slot = packHistory.find(s => s.nzo_id === pack.download_id);
            if (!slot) continue;
            if (slot.status === 'Completed') {
              db.prepare(`UPDATE series_packs SET status = 'downloaded', file_path = ? WHERE id = ?`)
                .run(slot.storage, pack.id);
              logger.info('watcher', `Pack ${pack.id} downloaded (SAB)`, { storage: slot.storage });
            } else if (!SAB_IN_PROGRESS.has(slot.status)) {
              logger.warn('watcher', `Pack ${pack.id} SABnzbd job failed`, { status: slot.status });
              db.prepare(`UPDATE series_packs SET status = 'failed' WHERE id = ?`).run(pack.id);
            }
          }
        }

        // ── qBit comic torrent pack status check ──
        // Mirrors the SAB completion check but uses qBit's torrents/info API.
        // qBit returns content_path which points to either a single file or
        // the pack directory — pack post-processor handles both shapes.
        if (qbtPacks.length) {
          try {
            const { url, qbtHeaders } = await qbtLogin();
            const r = await axios.get(`${url}/api/v2/torrents/info`, {
              headers: qbtHeaders,
              timeout: 5000,
            });
            const torrents = r.data || [];
            for (const pack of qbtPacks) {
              const hash = String(pack.download_id).replace('qbt_', '').toLowerCase();
              const t = torrents.find(x => x.hash?.toLowerCase() === hash);
              if (!t) {
                const gone = qbtDeadReason(null, hash);
                if (gone) {
                  logger.warn('watcher', `Pack ${pack.id} torrent gone from qBit`, { hash });
                  qbtMissingSince.delete(hash);
                  db.prepare(`UPDATE series_packs SET status = 'failed' WHERE id = ?`).run(pack.id);
                }
                continue;
              }
              // qBit progress is 0..1 — completed = 1.0, or the state is 'pausedUP'/'uploading'/'stalledUP'
              // (i.e. seeding states implying download is done). Don't trip on 'pausedDL' or 'error'.
              const completedStates = new Set(['uploading', 'pausedUP', 'stalledUP', 'queuedUP', 'forcedUP', 'checkingUP']);
              const isComplete = (t.progress >= 1) || completedStates.has(t.state);
              const deadReason = isComplete ? null : qbtDeadReason(t, hash);
              if (isComplete) {
                const filePath = t.content_path || t.save_path;
                db.prepare(`UPDATE series_packs SET status = 'downloaded', file_path = ? WHERE id = ?`)
                  .run(filePath, pack.id);
                logger.info('watcher', `Pack ${pack.id} downloaded (qBit)`, { hash, content_path: filePath });
              } else if (deadReason) {
                // Packs have no automatic fallback source; mark failed and clean up.
                logger.warn('watcher', `Pack ${pack.id} qBit torrent dead`, { state: t.state, reason: deadReason });
                await qbtRemoveTorrent(url, qbtHeaders, hash);
                db.prepare(`UPDATE series_packs SET status = 'failed' WHERE id = ?`).run(pack.id);
              }
            }
          } catch (e) {
            logger.warn('watcher', 'qBit pack status check failed', e.message);
          }
        }
      }

      // ── Phase 4: pack downloaded → processed ─────────────────────────
      // Packs that failed only because metadata work was held go back in the
      // queue as soon as the hold is gone.
      if (!metadataRuntime.status().length) {
        const requeued = db.prepare(`UPDATE series_packs SET status = 'downloaded', fail_reason = NULL
        WHERE status = 'failed' AND fail_reason = 'LIBRARY_RECOVERY_REQUIRED' AND file_path IS NOT NULL`).run().changes;
        if (requeued) logger.info('pack-process', `Re-queued ${requeued} pack(s) held by interrupted metadata work`);
      }
      const downloadedPacks = db.prepare(`
      SELECT p.*, s.name, s.publisher, s.year, s.directory
      FROM series_packs p
      JOIN monitored_series s ON s.id = p.series_id
      WHERE p.status = 'downloaded' AND p.file_path IS NOT NULL
        AND (p.retry_after IS NULL OR p.retry_after <= datetime('now'))
    `).all();

      for (const pack of downloadedPacks) {
        const series = {
          id:        pack.series_id,
          name:      pack.name,
          publisher: pack.publisher,
          year:      pack.year,
          directory: pack.directory,
        };
        db.prepare(`UPDATE series_packs SET status = 'processing' WHERE id = ?`).run(pack.id);
        await asArrival('pack-process', () => postProcessPack(pack, series));
      }

    } catch (e) {
      logger.error('watcher', 'Completion check error', e.message);
    } finally {
      watcherBusy = false;
    }
  }

  // A restart mid-pack leaves it 'processing' forever; put it back in the queue.
  try {
    const n = db.prepare(`UPDATE series_packs SET status = 'downloaded' WHERE status = 'processing' AND file_path IS NOT NULL`).run().changes;
    if (n) logger.info('pack-process', `Resuming ${n} pack(s) interrupted by a restart`);
  } catch (e) { logger.warn('pack-process', 'Could not resume interrupted packs', e.message); }

  // Start watcher after 30s delay (let server fully start), then every 60s
  setTimeout(() => {
    runCompletionWatcher();
    setInterval(runCompletionWatcher, 30 * 1000);
  }, 30 * 1000);

  // ─── Download progress poller ─────────────────────────────────────
  // Polls SABnzbd queue and qBittorrent for in-progress downloads every 8s
  // and pushes updates to the SSE stream so the frontend toast panel stays live.
  async function pollDownloadProgress() {
    // Get all snatched issues so we know what to look for
    const snatched = db.prepare(`
    SELECT i.*, s.name AS series_name
    FROM monitored_issues i
    JOIN monitored_series s ON s.id = i.series_id
    WHERE i.status = 'snatched' AND i.download_id IS NOT NULL AND i.download_id != 'ddl'
  `).all();

    if (!snatched.length) return;

    const sabIssues = snatched.filter(i => !i.download_id.startsWith('qbt_'));
    const qbtIssues = snatched.filter(i => i.download_id.startsWith('qbt_'));

    // ── SABnzbd queue polling ──────────────────────────────────────
    if (sabIssues.length) {
      try {
        const sabUrl = getSetting('sabnzbd_url') || SABNZBD_URL;
        const sabKey = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;
        const r = await axios.get(`${sabUrl}/api`, {
          params: { apikey: sabKey, mode: 'queue', output: 'json' },
          timeout: 5000,
        });
        const slots = r.data?.queue?.slots || [];
        for (const issue of sabIssues) {
          const slot = slots.find(s => s.nzo_id === issue.download_id);
          if (!slot) continue;
          const pct = parseFloat(slot.percentage) || 0;
          const totalBytes = parseFloat(slot.mb) * 1024 * 1024 || 0;
          const bytesReceived = totalBytes * (pct / 100);
          const dlId = `sab-${issue.download_id}`;
          const entry = {
            id: dlId,
            filename: slot.filename || issue.series_name,
            seriesName: issue.series_name,
            bytesReceived: Math.round(bytesReceived),
            totalBytes: Math.round(totalBytes),
            status: 'downloading',
            source: 'sabnzbd',
            startedAt: activeDownloads.get(dlId)?.startedAt || new Date().toISOString(),
          };
          activeDownloads.set(dlId, entry);
          pushDownloadUpdate({ ...entry });
        }
        // Clean up completed SABnzbd entries no longer in queue
        let anyCompleted = false;
        for (const [id, dl] of activeDownloads) {
          if (dl.source !== 'sabnzbd') continue;
          const nzoId = id.replace('sab-', '');
          if (!slots.find(s => s.nzo_id === nzoId)) {
            // Push 'complete' first so the toast shows a finished state,
            // then remove after a short delay so the user can see it.
            const completedEntry = {
              ...dl,
              status: 'complete',
              bytesReceived: dl.totalBytes || dl.bytesReceived,
              filename: dl.filename || dl.seriesName,
            };
            activeDownloads.set(id, completedEntry);
            pushDownloadUpdate({ ...completedEntry });
            setTimeout(() => {
              activeDownloads.delete(id);
              pushDownloadUpdate({ id, status: 'removed' });
            }, 8000);
            anyCompleted = true;
          }
        }
        // If any SABnzbd job just finished, kick the watcher immediately
        // instead of waiting up to 60 seconds for the next scheduled run
        if (anyCompleted) setImmediate(runCompletionWatcher);
      } catch (e) {
        logger.debug('progress-poll', 'SABnzbd queue poll failed', e.message);
      }
    }

    // ── qBittorrent polling ────────────────────────────────────────
    if (qbtIssues.length) {
      try {
        const { url, cookie, qbtHeaders } = await qbtLogin();
        const r = await axios.get(`${url}/api/v2/torrents/info`, {
          headers: qbtHeaders,
          timeout: 5000,
        });
        const torrents = r.data || [];
        for (const issue of qbtIssues) {
          // qBittorrent hash is stored as 'qbt_HASH'
          const hash = issue.download_id.replace('qbt_', '').toLowerCase();
          const torrent = torrents.find(t => t.hash?.toLowerCase() === hash);
          if (!torrent) continue;
          const dlId = `qbt_${hash}`;
          const entry = {
            id: dlId,
            filename: torrent.name || issue.series_name,
            seriesName: issue.series_name,
            bytesReceived: torrent.completed || 0,
            totalBytes: torrent.size || 0,
            status: 'downloading',
            source: 'qbittorrent',
            qbtState: torrent.state,
            stalledSince: QBT_STALL_STATES.has(torrent.state) ? (qbtLastProgressMs(torrent) || null) : null,
            stallLimitHours: QBT_STALL_HOURS,
            startedAt: activeDownloads.get(dlId)?.startedAt || new Date().toISOString(),
          };
          activeDownloads.set(dlId, entry);
          pushDownloadUpdate({ ...entry });
        }
        // Clean up completed qBittorrent entries
        for (const [id, dl] of activeDownloads) {
          if (dl.source !== 'qbittorrent') continue;
          const hash = id.replace('qbt_', '').toLowerCase();
          const torrent = torrents.find(t => t.hash?.toLowerCase() === hash);
          if (!torrent || torrent.progress >= 1) {
            activeDownloads.delete(id);
            pushDownloadUpdate({ id, status: 'removed' });
          }
        }
      } catch (e) {
        logger.debug('progress-poll', 'qBittorrent poll failed', e.message);
      }
    }
  }

  // Start progress poller after 35s, then every 8s
  setTimeout(() => {
    setInterval(pollDownloadProgress, 8000);
  }, 35 * 1000);

  // ─── Series status backfill: series.json → DB ────────────────────
  // Resolves 'unknown' series_status rows by reading series.json (fast, no API).
  // Also rescues mis-stamped 'ended' series that have recent issues.
  // Runs at startup and then every 30 minutes so newly added series get
  // their status set without requiring a server restart.
  function runSeriesStatusBackfill(label = 'Periodic') {
    // Pass 1: resolve unknowns from series.json
    const unknown = db.prepare(`SELECT id, directory FROM monitored_series WHERE series_status = 'unknown' OR series_status IS NULL`).all();
    let updated = 0;
    for (const s of unknown) {
      const status = deriveStatusFromSeriesJson(s.directory);
      if (status) {
        db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(status, s.id);
        updated++;
      }
    }
    if (unknown.length > 0 && updated > 0) {
      logger.info('series-status', `${label} backfill: ${updated}/${unknown.length} unknown series resolved from series.json`);
    }

    // Pass 2: rescue mis-stamped 'ended' series that have recent issues.
    // A series with an issue dated within the last 120 days cannot credibly be
    // ended — reset it to 'ongoing' so the weekly cron re-evaluates it. Series
    // that Metron confirmed finished are left alone (2026-10-28).
    try {
      const ended = db.prepare(`SELECT id, name FROM monitored_series WHERE series_status = 'ended' AND status = 'active' AND COALESCE(series_status_source, '') <> 'metron'`).all();
      const eighteenMonthsAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      let rescued = 0;
      for (const s of ended) {
        const recent = db.prepare(`
        SELECT 1 FROM monitored_issues
        WHERE series_id = ? AND COALESCE(store_date, release_date) >= ?
        LIMIT 1
      `).get(s.id, eighteenMonthsAgo);
        if (recent) {
          db.prepare(`UPDATE monitored_series SET series_status = 'ongoing' WHERE id = ?`).run(s.id);
          rescued++;
          logger.info('series-status', `Rescued mis-stamped series: "${s.name}" ended → ongoing`);
        }
      }
      if (rescued > 0) logger.info('series-status', `${label} rescue: ${rescued} series reset from ended → ongoing`);
    } catch (e) {
      logger.warn('series-status', `${label} rescue pass failed`, e.message);
    }
  }

  // Run at startup (immediate) then every 30 minutes.
  setImmediate(() => runSeriesStatusBackfill('Startup'));
  setInterval(() => runSeriesStatusBackfill('Periodic'), 30 * 60 * 1000);

  // ─── Library scan scheduler (every 15 minutes) ───────────────────
  // Checks all libraries with scan_interval_hours > 0. If enough time
  // has elapsed since last_scanned_at, fires a scan for that library.
  // One library per tick to avoid stacking scans.
  setInterval(() => {
    if (scanner.scanState.running) return;
    const libs = db.prepare('SELECT * FROM libraries WHERE scan_interval_hours > 0').all();
    for (const lib of libs) {
      const intervalMs = lib.scan_interval_hours * 60 * 60 * 1000;
      const lastMs = lib.last_scanned_at ? new Date(lib.last_scanned_at).getTime() : 0;
      if (Date.now() - lastMs >= intervalMs) {
        logger.info('scanner', `Scheduled scan triggered for "${lib.name}"`, { interval: `${lib.scan_interval_hours}h` });
        setImmediate(() => runLibraryScan(lib).catch(e => logger.warn('scan', 'Scan deferred', e.message)));
        break; // one library per tick
      }
    }
  }, 15 * 60 * 1000);
  return { ddlPostProcessing, runCompletionWatcher, get watcherBusy() { return watcherBusy; } };
};
