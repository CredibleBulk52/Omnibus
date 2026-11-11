'use strict';
// ─── Single-issue downloads: next-source retry, GetComics download queue, Queue tab ───
// Moved out of server.js (2026-11-05, downloads stage 3): blacklistAndRetry
// (record a failed link, try the next source), the GetComics download queue (limits,
// spacing, cooldown hand-back), the Download Manager Queue tab routes and
// runDdlDownloadNow (one issue's download, then post-processing). The retry rules are
// in ./retryPolicy.js; server.js passes in what it shares.
module.exports.createIssueDownloads = function createIssueDownloads(deps) {
  const missing = ['activeDownloads', 'asArrival', 'axios', 'db', 'DDL_COOLDOWN_STEPS_MIN', 'ddlPostProcessing', 'deferForRateLimit', 'downloadPixeldrain', 'downloadThirdParty', 'finalizeCancellation', 'fs', 'fsCache', 'getSetting', 'isCancelled', 'isTransientDownloadError', 'logger', 'MANUAL_ONLY_HOSTS', 'MAX_DOWNLOAD_ATTEMPTS', 'metadataRuntime', 'path', 'postProcess', 'pushDownloadProgress', 'pushDownloadUpdate', 'requireAdmin', 'requireDownloadAccess', 'retryPolicy', 'sourceSearch', 'stallGuard'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createIssueDownloads: missing ${missing.join(', ')}`);
  const { activeDownloads, asArrival, axios, db, DDL_COOLDOWN_STEPS_MIN, ddlPostProcessing, deferForRateLimit, downloadPixeldrain, downloadThirdParty, finalizeCancellation, fs, fsCache, getSetting, isCancelled, isTransientDownloadError, logger, MANUAL_ONLY_HOSTS, MAX_DOWNLOAD_ATTEMPTS, metadataRuntime, path, postProcess, pushDownloadProgress, pushDownloadUpdate, requireAdmin, requireDownloadAccess, retryPolicy, sourceSearch, stallGuard } = deps;

// Record a failed link and try the next source.
// Called from: postProcess failure, SABnzbd failure watcher, DDL failure handler.
// The search and link choice are shared with auto-grab and the wanted scanner
// (./sourceSearch.js, 2026-11-05).
async function blacklistAndRetry(issue, series, failedUrl, reason) {
  if (retryPolicy.triage(issue, failedUrl, reason) === 'deferred') return;
  try { retryPolicy.record(issue.id, failedUrl, reason); } catch {}
  // Blocked links stay excluded (retry-kind ones until the failed-issue retry releases
  // them); attempts count from the last failed-issue retry, so each round gets fresh tries.
  const epoch = db.prepare('SELECT retry_epoch FROM monitored_issues WHERE id = ?').get(issue.id)?.retry_epoch || null;
  const attemptCount = retryPolicy.attempts(issue.id, epoch);

  logger.info('retry', `Issue ${issue.id} — attempt ${attemptCount}/${MAX_DOWNLOAD_ATTEMPTS}`, { reason });

  if (attemptCount >= MAX_DOWNLOAD_ATTEMPTS) {
    db.prepare(
      `UPDATE monitored_issues SET status='failed', download_id=NULL, file_path=NULL,
       fail_count=?, last_fail_reason=? WHERE id=?`
    ).run(attemptCount, reason || 'All sources exhausted', issue.id);
    logger.warn('retry', `Issue ${issue.id} exhausted all ${MAX_DOWNLOAD_ATTEMPTS} sources — marked failed`);
    return;
  }

  try {
    const { ddl, nzb, blocked } = await sourceSearch.findSources(issue, series.name || issue.series_name, series.year || issue.series_year);
    // GetComics first (curated, fewer wrong matches), then the best NZB.
    const next = ddl[0] || nzb[0] || null;

    if (!next) {
      db.prepare(
        `UPDATE monitored_issues SET status='failed', download_id=NULL, file_path=NULL,
         fail_count=?, last_fail_reason=? WHERE id=?`
      ).run(attemptCount, 'No sources available after blacklisting', issue.id);
      logger.warn('retry', `Issue ${issue.id} — no candidates remaining`);
      return;
    }

    logger.info('retry', `Issue ${issue.id} — trying next source`, { source: next._source, title: next.title || next.url });

    if (next._source === 'nzb') {
      const sab = await sourceSearch.sendToSab(next);
      if (sab.ok) {
        db.prepare(
          `UPDATE monitored_issues SET status='snatched', download_id=?, download_url=?,
           fail_count=?, last_fail_reason=NULL WHERE id=?`
        ).run(sab.nzo_id, next.downloadUrl, attemptCount, issue.id);
        logger.info('retry', `Issue ${issue.id} — snatched via NZB`, { nzo_id: sab.nzo_id });
      } else {
        logger.warn('retry', `Issue ${issue.id} — SABnzbd rejected on retry`, sab.error);
        await blacklistAndRetry(issue, series, next.downloadUrl, 'SABnzbd rejected');
      }

    } else {
      // DDL via GetComics: a link from the post page
      try {
        const link = await sourceSearch.pickDdlLink(issue, next.url, blocked, 'retry');
        if (!link) throw new Error('All DDL links blacklisted or unresolvable');
        const resolvedUrl = link.url;

        // Mark snatched, then kick off DDL download
        db.prepare(
          `UPDATE monitored_issues SET status='snatched', download_id='ddl', download_url=?,
           fail_count=?, last_fail_reason=NULL WHERE id=?`
        ).run(resolvedUrl, attemptCount, issue.id);

        // Fire-and-forget DDL download
        setImmediate(() => runDdlDownload(issue, series, resolvedUrl, null));
        logger.info('retry', `Issue ${issue.id} — DDL retry started`, { url: resolvedUrl });

      } catch (e) {
        logger.warn('retry', `Issue ${issue.id} — DDL retry failed`, e.message);
        await blacklistAndRetry(issue, series, next.url, `DDL failed: ${e.message}`);
      }
    }

  } catch (e) {
    logger.error('retry', `Issue ${issue.id} — search error during retry`, e.message);
    db.prepare(
      `UPDATE monitored_issues SET status='failed', download_id=NULL, file_path=NULL,
       fail_count=?, last_fail_reason=? WHERE id=?`
    ).run(attemptCount, `Search error: ${e.message}`, issue.id);
  }
}

// Core DDL download logic extracted so it can be called from both
// the /api/getcomics/download endpoint and the retry engine.
// ─── GetComics download queue ────────────────────────────────────
// Up to DDL_CONCURRENCY downloads run at once, and new downloads start at
// least DDL_START_GAP_MS apart. Before 2026-10-08 every grab started at once
// and tripped the host's rate limit; strictly one-at-a-time was too slow.
// While a rate-limit cooldown is active, queued downloads go back to wanted
// instead of being attempted.
// Both limits can be changed by an admin in the Download Manager Queue tab
// (stored in settings as ddl_concurrency / ddl_start_gap_sec). DDL_CONCURRENCY
// in .env is the default when nothing has been saved. The ceiling is high so
// an admin who pays to lift the host's rate limit can raise it.
const DDL_CONCURRENCY_MAX   = 20;
const DDL_START_GAP_MAX_SEC = 120;
const DDL_CONCURRENCY_ENV   = Math.max(1, parseInt(process.env.DDL_CONCURRENCY || '3', 10) || 3);
function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
function ddlConcurrency()   { return clampInt(getSetting('ddl_concurrency'), 1, DDL_CONCURRENCY_MAX, Math.min(DDL_CONCURRENCY_ENV, DDL_CONCURRENCY_MAX)); }
function ddlStartGapMs()    { return clampInt(getSetting('ddl_start_gap_sec'), 0, DDL_START_GAP_MAX_SEC, 5) * 1000; }
let ddlJobSeq = 0;
const ddlQueue = [];
let ddlActive = 0;
let ddlLastStart = 0;
let ddlStartTimer = null;

function runDdlDownload(issue, series, resolvedUrl, filename) {
  return new Promise(resolve => {
    ddlQueue.push({ jobId: `q${++ddlJobSeq}`, queuedAt: new Date().toISOString(), issue, series, resolvedUrl, filename, resolve });
    pumpDdlQueue();
  });
}

function pumpDdlQueue() {
  if (ddlStartTimer) return;                       // a delayed start is already scheduled
  while (ddlQueue.length) {
    if (retryPolicy.cooldownActive()) {             // cooling down: hand everything back to wanted
      const job = ddlQueue.shift();
      try { deferForRateLimit(job.issue, 'cooldown active'); } catch {}
      job.resolve();
      continue;
    }
    if (ddlActive >= ddlConcurrency()) return;      // a finishing download calls pump again
    const wait = ddlLastStart + ddlStartGapMs() - Date.now();
    if (wait > 0) {
      ddlStartTimer = setTimeout(() => { ddlStartTimer = null; pumpDdlQueue(); }, wait);
      return;
    }
    const job = ddlQueue.shift();
    ddlActive++;
    ddlLastStart = Date.now();
    (async () => {
      try {
        await runDdlDownloadNow(job.issue, job.series, job.resolvedUrl, job.filename);
      } catch (e) {
        logger.error('getcomics-ddl', `Queued download failed for issue ${job.issue?.id}`, e.message);
      } finally {
        ddlActive--;
        job.resolve();
        pumpDdlQueue();
      }
    })();
  }
}

// ─── Download queue view (Download Manager → Queue tab) ───────────
// One read-only snapshot of everything in flight: downloads running in
// GetComics / SABnzbd / qBittorrent, GetComics jobs waiting for a slot, issues
// held back by a retry delay, files being post-processed, and failed issues.
// Admins can also change the limits and reorder or remove waiting jobs.
// Registered once the wanted scanner exists (its progress shows on the Queue tab).
function registerQueueRoutes(app, { wantedScanState, FAILED_RETRY_MAX_WEEKS }) {
const sqlUtc = (v) => (v ? String(v).replace(' ', 'T') + (String(v).endsWith('Z') ? '' : 'Z') : null);
function nextUtcRun(fn) {               // fn(date) → true when a cron would fire at that minute
  const d = new Date(); d.setUTCSeconds(0, 0); d.setUTCMinutes(d.getUTCMinutes() + 1);
  for (let i = 0; i < 8 * 24 * 60; i++) { if (fn(d)) return d.toISOString(); d.setUTCMinutes(d.getUTCMinutes() + 1); }
  return null;
}
function ddlJobView(j, i) {
  return {
    jobId: j.jobId, position: i + 1, queuedAt: j.queuedAt,
    issueId: j.issue?.id, issueNumber: j.issue?.issue_number,
    seriesName: j.series?.name || j.issue?.series_name || '',
    host: (() => { try { return new URL(j.resolvedUrl).hostname; } catch { return ''; } })(),
  };
}

app.get('/api/downloads/queue', requireDownloadAccess, (req, res) => {
  try {
    const now = Date.now();
    const pick = (d) => ({
      id: d.id, source: d.source, kind: d.kind || null, issueId: d.issueId || null, issueNumber: d.issueNumber || null,
      seriesName: d.seriesName, filename: d.filename, status: d.status, error: d.error || null,
      bytesReceived: d.bytesReceived || 0, totalBytes: d.totalBytes || 0, startedAt: d.startedAt,
      cancelling: !!d.cancelling,
      qbtState: d.qbtState || null, stalledSince: d.stalledSince || null, stallLimitHours: d.stallLimitHours || null,
    });
    const active = [...activeDownloads.values()]
      .filter(d => ['getcomics', 'sabnzbd', 'qbittorrent'].includes(d.source))
      .map(pick);
    const activeIds = new Set(active.map(a => a.id));
    const activeIssueIds = new Set(active.map(a => a.issueId).filter(Boolean));
    const queuedIssueIds = new Set(ddlQueue.map(j => j.issue?.id));

    // Snatched issues not yet visible as a live download: sent to SABnzbd /
    // qBittorrent but not started there, or a GetComics link being prepared.
    const snatched = db.prepare(`
      SELECT i.id, i.issue_number, i.download_id, s.name AS series_name
      FROM monitored_issues i JOIN monitored_series s ON s.id = i.series_id
      WHERE i.status = 'snatched'`).all();
    for (const r of snatched) {
      if (!r.download_id || r.download_id === 'ddl') {
        if (activeIssueIds.has(r.id) || queuedIssueIds.has(r.id)) continue;
        active.push({ id: `prep-${r.id}`, source: 'getcomics', issueId: r.id, issueNumber: r.issue_number,
                      seriesName: r.series_name, filename: null, status: 'preparing', bytesReceived: 0, totalBytes: 0 });
        continue;
      }
      const isQbt = r.download_id.startsWith('qbt_');
      const key = isQbt ? `qbt_${r.download_id.slice(4).toLowerCase()}` : `sab-${r.download_id}`;
      if (activeIds.has(key)) {
        const a = active.find(x => x.id === key);
        if (a) { a.issueId = r.id; a.issueNumber = r.issue_number; }
        continue;
      }
      active.push({ id: key, source: isQbt ? 'qbittorrent' : 'sabnzbd', issueId: r.id, issueNumber: r.issue_number,
                    seriesName: r.series_name, filename: null, status: 'sent', bytesReceived: 0, totalBytes: 0 });
    }

    const processing = db.prepare(`
      SELECT i.id, i.issue_number, i.status, i.retry_after, i.last_fail_reason, i.file_path, s.name AS series_name, s.year AS series_year
      FROM monitored_issues i JOIN monitored_series s ON s.id = i.series_id
      WHERE i.status IN ('downloaded', 'processing')
      ORDER BY s.name COLLATE NOCASE, CAST(i.issue_number AS REAL)`).all()
      // file: the download's file name (2026-11-09: shown with the issue for held downloads).
      .map(({ file_path, ...r }) => ({ ...r, kind: 'issue', file: file_path ? path.basename(file_path) : null,
        retry_after: r.retry_after ? sqlUtc(r.retry_after) : null,
        last_fail_reason: r.retry_after ? r.last_fail_reason : null }));

    // Whole-series packs: invisible here before once the bytes finished.
    const packRows = db.prepare(`
      SELECT p.id, p.series_id, p.status, p.file_path, p.fail_reason, p.failed_at, p.grabbed_at, p.retry_after, s.name AS series_name
      FROM series_packs p JOIN monitored_series s ON s.id = p.series_id
      WHERE p.status IN ('downloaded', 'processing')
         OR (p.status = 'failed' AND p.file_path IS NOT NULL)
      ORDER BY p.id DESC LIMIT 50`).all();
    const packView = p => ({ id: p.id, kind: 'pack', series_id: p.series_id, series_name: p.series_name, status: p.status,
      file: p.file_path ? path.basename(p.file_path) : null, fail_reason: p.fail_reason || null,
      failed_at: p.failed_at ? sqlUtc(p.failed_at) : null,
      retry_after: p.status === 'downloaded' && p.retry_after ? sqlUtc(p.retry_after) : null,
      fileMissing: !!p.file_path && !fs.existsSync(p.file_path) });
    const processingPacks = packRows.filter(p => p.status !== 'failed').map(packView);
    // A failed pack is only actionable while its file is still on disk.
    const failedPacks = packRows.filter(p => p.status === 'failed').map(packView).filter(p => !p.fileMissing);

    const waiting = db.prepare(`
      SELECT i.id, i.issue_number, i.retry_after, i.last_fail_reason, s.name AS series_name
      FROM monitored_issues i JOIN monitored_series s ON s.id = i.series_id
      WHERE i.status = 'wanted' AND i.retry_after IS NOT NULL AND i.retry_after > datetime('now')
      ORDER BY i.retry_after`).all()
      .map(r => ({ ...r, retry_after: sqlUtc(r.retry_after) }));

    // Pack files not filed (2026-11-10, packs.js): by pack, while the pack file is on disk.
    let packLeftovers = [];
    try {
      const byPack = new Map();
      for (const r of db.prepare(`SELECT l.id, l.pack_id, l.name, l.reason, l.detail, p.file_path, p.status AS pack_status, s.name AS series_name, s.year AS series_year
          FROM pack_leftovers l JOIN series_packs p ON p.id = l.pack_id JOIN monitored_series s ON s.id = p.series_id
          WHERE l.status = 'open' ORDER BY l.pack_id DESC, l.name LIMIT 500`).all()) {
        if (!byPack.has(r.pack_id)) {
          if (!r.file_path || !fs.existsSync(r.file_path)) continue;
          byPack.set(r.pack_id, { pack_id: r.pack_id, series_name: r.series_name, series_year: r.series_year, file: path.basename(r.file_path), status: r.pack_status, files: [] });
        }
        byPack.get(r.pack_id).files.push({ id: r.id, name: r.name, reason: r.reason, detail: r.detail });
      }
      packLeftovers = [...byPack.values()];
    } catch { packLeftovers = []; }   // table not there yet (before the first pack pass)

    const failedTotal = db.prepare(`SELECT COUNT(*) AS n FROM monitored_issues WHERE status = 'failed'`).get().n;
    const failed = db.prepare(`
      SELECT i.id, i.series_id, i.issue_number, i.last_fail_reason, i.fail_count,
             COALESCE(i.weekly_retries, 0) AS weekly_retries,
             COALESCE(i.failed_at, (SELECT MAX(b.failed_at) FROM download_blacklist b WHERE b.issue_id = i.id)) AS failed_at,
             s.name AS series_name
      FROM monitored_issues i JOIN monitored_series s ON s.id = i.series_id
      WHERE i.status = 'failed'
      ORDER BY failed_at IS NULL, failed_at DESC
      LIMIT 100`).all()
      .map(r => ({ ...r, failed_at: sqlUtc(r.failed_at) }));

    const scan = wantedScanState || {};
    res.json({
      settings: {
        concurrency: ddlConcurrency(), concurrencyMax: DDL_CONCURRENCY_MAX, concurrencyEnvDefault: DDL_CONCURRENCY_ENV,
        startGapSec: ddlStartGapMs() / 1000, startGapMaxSec: DDL_START_GAP_MAX_SEC,
        cooldownStepsMin: DDL_COOLDOWN_STEPS_MIN, failedRetryMaxWeeks: FAILED_RETRY_MAX_WEEKS,
      },
      limiter: {
        running: ddlActive, waiting: ddlQueue.length,
        cooldownUntil: retryPolicy.cooldown().until,
        strikes: retryPolicy.cooldown().strikes,
      },
      active,
      queued: ddlQueue.map(ddlJobView),
      processing,
      processingPacks, failedPacks, packLeftovers,
      metadataHold: metadataRuntime.status().length,
      waiting,
      failed, failedTotal,
      scan: {
        running: !!scan.running, current: scan.current || null, done: scan.done || 0, total: scan.total || 0,
        lastRun: scan.lastRun || null,
        nextRun: nextUtcRun(d => d.getUTCMinutes() === 0 && d.getUTCHours() % 6 === 0),
      },
      nextWeeklyRetry: nextUtcRun(d => d.getUTCDate() % 2 === 0 && d.getUTCDate() <= 30 && d.getUTCHours() === 5 && d.getUTCMinutes() === 50),
      isAdmin: req.user?.role === 'admin',
    });
  } catch (e) {
    logger.error('dl-queue', 'Queue snapshot failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/downloads/queue/settings', requireAdmin, (req, res) => {
  const { concurrency, startGapSec } = req.body || {};
  const save = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const changed = {};
  if (concurrency !== undefined) {
    const n = parseInt(concurrency, 10);
    if (!Number.isFinite(n) || n < 1 || n > DDL_CONCURRENCY_MAX) return res.status(400).json({ error: `Simultaneous downloads must be 1–${DDL_CONCURRENCY_MAX}` });
    save.run('ddl_concurrency', String(n)); changed.concurrency = n;
  }
  if (startGapSec !== undefined) {
    const n = parseInt(startGapSec, 10);
    if (!Number.isFinite(n) || n < 0 || n > DDL_START_GAP_MAX_SEC) return res.status(400).json({ error: `Start spacing must be 0–${DDL_START_GAP_MAX_SEC} seconds` });
    save.run('ddl_start_gap_sec', String(n)); changed.startGapSec = n;
  }
  logger.info('dl-queue', `Download limits changed by ${req.user?.username || 'admin'}`, changed);
  if (ddlStartTimer) { clearTimeout(ddlStartTimer); ddlStartTimer = null; }
  pumpDdlQueue();                       // a higher limit starts waiting jobs right away
  res.json({ success: true, concurrency: ddlConcurrency(), startGapSec: ddlStartGapMs() / 1000 });
});

// Remove a waiting GetComics job. The issue goes back to wanted and is tried
// again at the next wanted scan (to stop it for good, mark it Skipped).
app.post('/api/downloads/queue/:jobId/remove', requireAdmin, (req, res) => {
  const i = ddlQueue.findIndex(j => j.jobId === req.params.jobId);
  if (i === -1) return res.status(404).json({ error: 'Job not in queue (it may have started)' });
  const [job] = ddlQueue.splice(i, 1);
  db.prepare(`UPDATE monitored_issues SET status = 'wanted', download_id = NULL, file_path = NULL,
              last_fail_reason = 'Removed from download queue' WHERE id = ? AND status = 'snatched'`).run(job.issue.id);
  job.resolve();
  logger.info('dl-queue', `Removed queued download for issue ${job.issue.id}`);
  res.json({ success: true });
});

app.post('/api/downloads/queue/:jobId/top', requireAdmin, (req, res) => {
  const i = ddlQueue.findIndex(j => j.jobId === req.params.jobId);
  if (i === -1) return res.status(404).json({ error: 'Job not in queue (it may have started)' });
  const [job] = ddlQueue.splice(i, 1);
  ddlQueue.unshift(job);
  res.json({ success: true });
});
}

async function runDdlDownloadNow(issue, series, resolvedUrl, filename) {
  const dlDir = getSetting('ddl_download_path') || '/downloads/getcomics';
  if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });

  // Reject known manual-only hosts up front so we don't burn a retry loop on
  // a URL that needs a browser session. See the matching block in the pack
  // download path for rationale.
  if (MANUAL_ONLY_HOSTS.test(resolvedUrl)) {
    const host = resolvedUrl.split('/')[2] || 'this host';
    const msg  = `${host} is not supported for auto-download. The link must be downloaded manually in your browser.`;
    logger.warn('getcomics-ddl', `Issue ${issue.id} download skipped — manual-only host`, { resolvedUrl });
    await blacklistAndRetry(issue, series, resolvedUrl, msg);
    return;
  }

  // A MediaFire or Mega folder URL represents a pack (many files), not a
  // single issue. If we hit one here, the wanted-scan probably picked a
  // folder URL for an individual issue, which won't match. Skip so downstream
  // post-processing doesn't try to treat a directory as one file.
  if (/mediafire\.com\/folder\//i.test(resolvedUrl)
      || /mega\.nz\/folder\//i.test(resolvedUrl)
      || /mega\.nz\/#F!/i.test(resolvedUrl)) {
    const msg = 'Folder URLs are pack-only, not valid for single-issue downloads';
    logger.warn('getcomics-ddl', `Issue ${issue.id} download skipped — folder URL`, { resolvedUrl });
    await blacklistAndRetry(issue, series, resolvedUrl, msg);
    return;
  }

  // Only use the supplied filename if it looks like an actual comic file.
  // Button labels like "Download Now" must be ignored — derive from URL instead.
  const FILE_EXT = /\.(cbz|cbr|zip|rar)(\?.*)?$/i;
  const validFilename = (filename && FILE_EXT.test(filename)) ? filename : null;
  const baseName = validFilename || decodeURIComponent(resolvedUrl.split('/').pop().split('?')[0]) || `getcomics-${Date.now()}.cbz`;
  const safeFilename = baseName.replace(/[^a-zA-Z0-9._\-() ]/g, '_');
  let destPath = path.join(dlDir, safeFilename);

  const isThirdParty = /pixeldrain\.com|mediafire\.com|mega\.nz/i.test(resolvedUrl);

  try {
    const dlId = `gc-retry-${Date.now()}-${issue.id}`;
    const dlEntry = { id: dlId, filename: safeFilename, seriesName: series.name, bytesReceived: 0, totalBytes: 0, status: 'downloading', startedAt: new Date().toISOString(),
                      source: 'getcomics', issueId: issue.id, issueNumber: issue.issue_number };
    activeDownloads.set(dlId, dlEntry);
    pushDownloadUpdate(dlEntry);

    if (isThirdParty) {
      destPath = await downloadThirdParty(resolvedUrl, destPath, dlEntry);
    } else {
      const headers = require('../downloadSecurity').cachedDownloadHeaders(resolvedUrl, fsCache, { 'Referer': 'https://getcomics.org/' });
      // AbortController wired to dlEntry so the cancel endpoint can abort
      // mid-download. Same pattern as pack retry loop.
      const ac = new AbortController();
      dlEntry.abortController = ac;
      const r = await axios.get(resolvedUrl, { headers, responseType: 'stream', timeout: 300000, signal: ac.signal });
      // GetComics /dls/ links can redirect (on GET only) to a Pixeldrain page.
      // Download through Pixeldrain's file API instead of saving its web page.
      const finalUrl = r.request?.res?.responseUrl || resolvedUrl;
      const contentType = String(r.headers['content-type'] || '');
      let pixeldrainUrl = /pixeldrain\.(?:com|net)\/u\/[A-Za-z0-9]+/i.test(finalUrl) ? finalUrl : null;
      const otherHost = !pixeldrainUrl && /mediafire\.com|mega\.nz/i.test(finalUrl) ? finalUrl : null;
      if (otherHost) {
        r.data.destroy();
        logger.info('getcomics-ddl', `Issue ${issue.id}: link redirected to ${new URL(otherHost).hostname} — using its downloader`, { from: resolvedUrl, to: otherHost });
        destPath = await downloadThirdParty(otherHost, destPath, dlEntry);
      } else if (!pixeldrainUrl && /text\/html/i.test(contentType)) {
        const page = await new Promise((resolve, reject) => {
          let text = '';
          r.data.on('data', chunk => { text += chunk.toString('utf8'); if (text.length > 512 * 1024) r.data.destroy(); });
          r.data.on('end', () => resolve(text)); r.data.on('close', () => resolve(text)); r.data.on('error', reject);
        });
        const id = page.match(/pixeldrain\.(?:com|net)\/(?:u|api\/file)\/([A-Za-z0-9]+)/i)?.[1];
        if (!id) throw new Error(`Download host returned a web page instead of the comic (${new URL(finalUrl).hostname})`);
        pixeldrainUrl = `https://pixeldrain.com/u/${id}`;
      } else if (pixeldrainUrl) r.data.destroy();
      if (otherHost) {
        // downloaded above
      } else if (pixeldrainUrl) {
        logger.info('getcomics-ddl', `Issue ${issue.id}: link led to Pixeldrain — using its file API`, { from: resolvedUrl, pixeldrainUrl });
        destPath = await downloadPixeldrain(pixeldrainUrl, destPath, dlEntry);
      } else {
      const cd = r.headers['content-disposition'] || '';
      const cdMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
      if (cdMatch) {
        const cdName = decodeURIComponent(cdMatch[1].trim().replace(/["']/g, ''));
        if (cdName && /\.(cbz|cbr|zip|rar)$/i.test(cdName))
          destPath = path.join(dlDir, cdName.replace(/[^a-zA-Z0-9._\-() ]/g, '_'));
      }
      dlEntry.totalBytes = parseInt(r.headers['content-length'] || '0', 10);
      pushDownloadUpdate({ ...dlEntry });
      // A dropped or stalled connection is retried here (twice), resuming from
      // what is on disk, before the link counts as failed (2026-10-27).
      let resp = r, flags = 'w';
      for (let attempt = 0; ; attempt++) {
        try {
          await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(destPath, { flags });
            let failed = null;
            const fail = (err) => { if (failed) return; failed = err; resp.data.unpipe(writer); writer.end(); };
            resp.data.on('data', chunk => { dlEntry.bytesReceived += chunk.length; pushDownloadProgress(dlEntry); });
            stallGuard(resp.data);
            resp.data.pipe(writer);
            // Settle once the file is closed, so a resume starts from what is really on disk.
            writer.on('close', () => (failed ? reject(failed) : resolve()));
            writer.on('error', fail);
            resp.data.on('error', fail);
          });
          if (dlEntry.totalBytes && dlEntry.bytesReceived < dlEntry.totalBytes) {
            throw new Error(`Stream ended early at ${Math.floor(dlEntry.bytesReceived / 1048576)}MB of ${Math.floor(dlEntry.totalBytes / 1048576)}MB`);
          }
          break;
        } catch (err) {
          if (axios.isCancel(err) || isCancelled(dlId) || attempt >= 2 || !isTransientDownloadError(err.message)) throw err;
          let have = 0;
          try { have = fs.statSync(destPath).size; } catch {}
          logger.warn('getcomics-ddl', `Issue ${issue.id}: download interrupted at ${Math.floor(have / 1048576)}MB, retrying (${attempt + 1}/2)`, { error: err.message });
          await new Promise(res => setTimeout(res, 3000 * (attempt + 1)));
          resp = await axios.get(resolvedUrl, { headers: have > 0 ? { ...headers, Range: `bytes=${have}-` } : headers, responseType: 'stream', timeout: 60000, signal: ac.signal });
          const start = parseInt((/^bytes (\d+)-/.exec(resp.headers['content-range'] || '') || [])[1], 10);
          if (have > 0 && resp.status === 206 && start === have) { flags = 'a'; dlEntry.bytesReceived = have; }
          else { flags = 'w'; dlEntry.bytesReceived = 0; dlEntry.totalBytes = parseInt(resp.headers['content-length'] || '0', 10); }
        }
      }
      }
    }

    dlEntry.status = 'complete';
    retryPolicy.noteSuccess(issue.id);   // host is accepting downloads again — reset the cooldown ladder
    pushDownloadUpdate({ ...dlEntry });
    setTimeout(() => { activeDownloads.delete(dlId); pushDownloadUpdate({ id: dlId, status: 'removed' }); }, 8000);

    ddlPostProcessing.add(issue.id);
    let ok = false;
    try {
      db.prepare(`UPDATE monitored_issues SET status='downloaded', file_path=?, retry_after=NULL WHERE id=?`).run(destPath, issue.id);

      const issueSeries = issue.series_id !== series.id
        ? (db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(issue.series_id) || series)
        : series;

      ok = await asArrival('postprocess', () => postProcess(issue, issueSeries, destPath));
    } catch (ppErr) {
      // The download worked; post-processing could not start (a deployment pause,
      // metadata recovery). That is not the link's fault: before 2026-10-27 it was
      // blocklisted. Keep the file; the post-process watcher tries again.
      logger.warn('getcomics-ddl', `Issue ${issue.id}: downloaded, post-processing deferred`, { error: ppErr.message });
      try {
        db.prepare("UPDATE monitored_issues SET retry_after = datetime('now', '+5 minutes'), last_fail_reason = ? WHERE id = ? AND status = 'downloaded'")
          .run(`Post-processing deferred: ${ppErr.message}`.slice(0, 500), issue.id);
      } catch {}
    } finally {
      ddlPostProcessing.delete(issue.id);
    }
    if (ok) {
      try { fs.unlinkSync(destPath); } catch {}
    }
    // Post-processing retains sources on metadata review or publication failure.

  } catch (e) {
    // Cancellation path — don't blacklist the URL or retry (the user wanted
    // it stopped, not failed-over to a different source). Finalize any
    // matching dlEntry that wasn't already finalized upstream.
    const wasCancelled = axios.isCancel?.(e) || /Cancelled by user/i.test(e.message || '');
    if (wasCancelled) {
      logger.info('getcomics-ddl', `DDL download cancelled for issue ${issue.id}`);
      try { fs.unlinkSync(destPath); } catch {}
      // Previously the issue stayed 'snatched' with nothing downloading.
      try {
        db.prepare(`UPDATE monitored_issues SET status = 'wanted', download_id = NULL, file_path = NULL,
                    last_fail_reason = 'Download cancelled by user' WHERE id = ? AND status = 'snatched'`).run(issue.id);
      } catch {}
      for (const [id, dl] of activeDownloads) {
        if (dl.filename === safeFilename && dl.status !== 'cancelled') {
          finalizeCancellation(dl);
          break;
        }
      }
      return;
    }
    logger.error('getcomics-ddl', `DDL download failed for issue ${issue.id}`, e.message);
    for (const [id, dl] of activeDownloads) {
      if (dl.filename === safeFilename && dl.status === 'downloading') {
        dl.status = 'error'; dl.error = e.message;
        pushDownloadUpdate({ ...dl });
        setTimeout(() => { activeDownloads.delete(id); pushDownloadUpdate({ id, status: 'removed' }); }, 15000);
        break;
      }
    }
    // Blacklist this URL and retry from next source
    await blacklistAndRetry(issue, series, resolvedUrl, `DDL download error: ${e.message}`);
  }
}

return { blacklistAndRetry, runDdlDownload, registerQueueRoutes };
};
