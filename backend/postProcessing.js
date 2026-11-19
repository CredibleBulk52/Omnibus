'use strict';
// ─── Post-processing downloads (moved out of server.js 2026-11-19, server.js split step 6b) ───
// postProcess (a finished download → the shared metadata runtime's arrival: identified, tagged,
// named and filed in the series folder; holds, retries and blocklisting), the "Convert anyway" and
// "Process anyway" sets, a single download that is really a pack (handed to pack processing), and the
// manga torrent post-processor with its trigger and status routes. Moved unchanged. server.js wraps
// postProcess and processMangaTorrents with its download coordination once the file has loaded
// (wrapDownloads); the 10-minute manga poller stays in server.js.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const IN = require('./issueNumber');
const { nameKey } = require('./names');
const { extractVolumeNumber } = require('./fileNaming');

const NEEDS = ['activeDownloads', 'app', 'blacklistAndRetry', 'createSeriesJsonIfMissing', 'CV_WAIT_REASON', 'db', 'execFileAsync', 'getSetting', 'invalidateDirectoryExistsCache', 'logger', 'metadataRuntime', 'requireAdmin', 'requireAuth', 'schedulePostProcessScan', 'sqlTime'];
module.exports.NEEDS = NEEDS;

module.exports.createPostProcessing = function createPostProcessing(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createPostProcessing: missing ${missing.join(', ')}`);
  const { activeDownloads, app, blacklistAndRetry, createSeriesJsonIfMissing, CV_WAIT_REASON, db, execFileAsync, getSetting, invalidateDirectoryExistsCache, logger, metadataRuntime, requireAdmin, requireAuth, schedulePostProcessScan, sqlTime } = deps;

  // ─── Manga torrent post-processor ────────────────────────────────
  // Scans /downloads/torrents for completed CBZ/CBR files, matches them
  // to wanted manga volumes, renames, moves to series directory.
  const mangaTorrentState = { running: false, lastRun: null, processed: 0, errors: 0 };

  async function processMangaTorrents() {
    if (mangaTorrentState.running) return;
    mangaTorrentState.running = true;
    const startTime = Date.now();
    let processed = 0, errors = 0;
    const TORRENT_DOWNLOAD_DIR = getSetting('torrent_completed_path') || '/downloads/torrents';

    try {
      if (!fs.existsSync(TORRENT_DOWNLOAD_DIR)) {
        logger.warn('manga-pp', `Torrent download dir not found: ${TORRENT_DOWNLOAD_DIR}`);
        return;
      }

      // ─── Path-collision guard ────────────────────────────────────
      // The torrent poller must not inspect incomplete DDL files
      // while they are being written. If the torrent completed-path is
      // configured to the same root as the DDL download path, manga-pp will
      // descend into in-progress DDL pack folders (Mega, MediaFire, etc.) and
      // observe partially-downloaded comics while the DDL handler is still
      // writing to them. Refuse to run in that case.
      const DDL_DIR = getSetting('ddl_download_path') || '/downloads/getcomics';
      const norm = p => path.resolve(p).replace(/[/\\]+$/, '');
      if (norm(DDL_DIR) === norm(TORRENT_DOWNLOAD_DIR)
          || norm(DDL_DIR).startsWith(norm(TORRENT_DOWNLOAD_DIR) + path.sep)
          || norm(TORRENT_DOWNLOAD_DIR).startsWith(norm(DDL_DIR) + path.sep)) {
        logger.warn('manga-pp', `Torrent completed-path (${TORRENT_DOWNLOAD_DIR}) overlaps DDL download path (${DDL_DIR}) — skipping. Configure these as separate directories in Settings.`);
        return;
      }

      // ─── Active-DDL guard ────────────────────────────────────────
      // Even with disjoint paths, if there's an active DDL or pack download in
      // flight, skip this poller cycle. Manga-pp runs every 10 minutes and
      // nothing bad happens if we miss one cycle. This is belt-and-suspenders
      // against future misconfiguration and against our own code writing
      // outside the expected directory.
      for (const dl of activeDownloads.values()) {
        if (dl.status === 'downloading') {
          logger.info('manga-pp', `Skipping this cycle — ${activeDownloads.size} active download(s) in progress`);
          return;
        }
      }

      // Find all CBZ/CBR files recursively — qBittorrent may put them in subfolders
      const findFiles = (dir, results = []) => {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) findFiles(full, results);
            else if (/\.(cbz|cbr|zip)$/i.test(entry.name) && !entry.name.startsWith('.')) {
              // Skip files still being written (.!qB incomplete marker sibling)
              const incompleteMarker = full + '.!qB';
              if (!fs.existsSync(incompleteMarker)) results.push(full);
            }
          }
        } catch {}
        return results;
      };

      const files = findFiles(TORRENT_DOWNLOAD_DIR);
      if (!files.length) { logger.info('manga-pp', 'No completed torrent files found'); return; }
      logger.info('manga-pp', `Found ${files.length} candidate file(s)`);

      // Load all manga series + their wanted issues
      const mangaSeries = db.prepare("SELECT * FROM monitored_series WHERE series_type = 'manga'").all();
      if (!mangaSeries.length) return;

      for (const filePath of files) {
        const filename = path.basename(filePath);
        const volNum = extractVolumeNumber(filename);
        if (!volNum) { logger.info('manga-pp', `Could not extract volume number from: ${filename}`); continue; }

        // Find matching series by name similarity
        const fileNorm = nameKey(filename);
        let bestSeries = null, bestScore = 0, tied = false;
        for (const s of mangaSeries) {
          const sNorm = nameKey(s.name);
          if (fileNorm.includes(sNorm) || sNorm.split('').every((c, i) => fileNorm[i] === c)) {
            const score = sNorm.length;
            if (score > bestScore) { bestScore = score; bestSeries = s; tied = false; }
            else if(score===bestScore)tied=true;
          }
        }
        if (!bestSeries || tied) {
          logger.debug('manga-pp', `No matching manga series for: ${filename} — retained for review`);
          continue;
        }

        // Find matching wanted issue by volume number.
        // CAST(issue_number AS INTEGER) collapsed "8AU" and "8" to the same
        // bucket, false-matching tie-ins. Pull all candidates for the series
        // and filter in JS using the canonical normaliser instead.
        const targetNum = IN.normIssueNumber(volNum);
        const candidates = db.prepare(
          "SELECT * FROM monitored_issues WHERE series_id = ? AND status IN ('wanted','snatched')"
        ).all(bestSeries.id);
        const matches = targetNum ? candidates.filter(c => IN.normIssueNumber(c.issue_number) === targetNum) : [];
        const issue = matches.length===1 ? matches[0] : null;
        if (!issue) {
          logger.debug('manga-pp', `No unique wanted issue v${volNum} for "${bestSeries.name}" — retained for review`);
          continue;
        }

        try {
          const result=await metadataRuntime.arrive({sourcePath:filePath,sourceName:filename,issue,directory:bestSeries.directory,matchedByFilename:true,profile:'manga'});
          logger.info('manga-pp', `Processed: ${filename} → ${path.basename(result.path)}`);
          processed++;
        } catch (e) {
          logger.error('manga-pp', `Failed to process ${filename}`, e.message);
          errors++;
          if(metadataRuntime.status().length || e.code==='CV_RATE_LIMIT')break;
        }
      }
    } catch (e) {
      logger.error('manga-pp', 'Post-processor error', e.message);
    } finally {
      mangaTorrentState.running = false;
      mangaTorrentState.lastRun = new Date().toISOString();
      mangaTorrentState.processed = processed;
      mangaTorrentState.errors = errors;
      logger.info('manga-pp', `Complete: ${processed} processed, ${errors} errors, ${Date.now() - startTime}ms`);
      if (processed > 0) schedulePostProcessScan();
    }
  }

  // Manual trigger endpoint
  app.post('/api/manga/process-torrents', requireAdmin, async (req, res) => {
    if (mangaTorrentState.running) return res.json({ ok: false, message: 'Already running' });
    res.json({ ok: true, message: 'Processing started' });
    setImmediate(() => processMangaTorrents().catch(e=>logger.warn('manga-pp','Job deferred',e.message)));
  });

  // Status endpoint
  app.get('/api/manga/process-torrents/status', requireAuth, (req, res) => {
    res.json(mangaTorrentState);
  });

  async function postProcess(issue, series, storageDir) {
    const tmpDir = path.join(os.tmpdir(), `omnibus-${issue.id}-${Date.now()}`);
    logger.info('postprocess', `Starting for issue ${issue.id}`, { storageDir, tmpDir });

    try {
      // slot.storage may be a file path or a directory depending on SABnzbd version/config
      let srcPath;
      let stat = null;
      let notAnArchive = null;
      try { stat = fs.statSync(storageDir); }
      catch (statErr) {
        // Path doesn't exist or isn't accessible — fall through to parent-dir recovery below.
        logger.warn('postprocess', `storageDir stat failed`, { storageDir, code: statErr.code });
      }
      // Extensionless-file recovery — DDL downloads from URLs that have no
      // extension in the last path segment land here (e.g. `/downloads/omnibus/<token>__`).
      // Probe magic bytes; if it's a known archive, rename in-place so the
      // existing extraction routing works without further special cases.
      if (stat && stat.isFile() && !/\.(cbr|cbz|rar|zip|7z)$/i.test(storageDir)) {
        try {
          const fd = fs.openSync(storageDir, 'r');
          const head = Buffer.alloc(8);
          fs.readSync(fd, head, 0, 8, 0);
          fs.closeSync(fd);
          let detectedExt = null;
          // A file host sometimes returns its web page instead of the comic.
          if (/^\s*</.test(head.toString('latin1'))) notAnArchive = 'Download host returned a web page instead of the comic';
          if (head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04) detectedExt = '.cbz';
          else if (head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21) detectedExt = '.cbr';
          else if (head[0] === 0x37 && head[1] === 0x7A && head[2] === 0xBC && head[3] === 0xAF) detectedExt = '.cbz'; // 7z — extraction handles it
          if (detectedExt) {
            const renamed = storageDir + detectedExt;
            if(fs.existsSync(renamed))throw new Error('Extension recovery destination already exists');
            fs.renameSync(storageDir, renamed);
            logger.info('postprocess', `Extensionless file detected as ${detectedExt}, renamed`, { from: storageDir, to: renamed });
            storageDir = renamed;
            stat = fs.statSync(storageDir); // refresh stat for the path with new name
          }
        } catch (probeErr) {
          logger.warn('postprocess', `Magic-byte probe failed`, { storageDir, error: probeErr.message });
        }
      }
      // The downloaded file isn't a comic (web page, unknown type): fail this
      // source and try the next one. Never substitute another file from the
      // shared downloads folder.
      if (stat && stat.isFile() && !/\.(cbr|cbz|rar|zip|7z)$/i.test(storageDir)) {
        const reason = notAnArchive || 'Downloaded file is not a comic archive';
        logger.warn('postprocess', `Issue ${issue.id}: ${reason}`, { storageDir, bytes: stat.size });
        try { fs.unlinkSync(storageDir); } catch {}
        const failedUrl = issue.download_url || null;
        db.prepare(`UPDATE monitored_issues SET status='wanted', download_id=NULL, file_path=NULL WHERE id=?`).run(issue.id);
        setImmediate(async () => {
          try { await blacklistAndRetry(issue, series, failedUrl, `Post-process: ${reason}`); }
          catch (e) { logger.error('retry', `blacklistAndRetry failed for ${issue.id}`, e.message); }
        });
        return false;
      }
      if (stat && stat.isFile() && /\.(cbr|cbz|rar|zip)$/i.test(storageDir)) {
        // SABnzbd / DDL gave us the file directly
        srcPath = storageDir;
      } else if (stat && stat.isDirectory()) {
        // SABnzbd gave us the containing folder — scan for the comic file
        const files = fs.readdirSync(storageDir);
        const comics = files.filter(f => /\.(cbr|cbz|rar|zip)$/i.test(f));
        if (comics.length > 1) { handToPackProcessing(issue, storageDir, comics.length); return false; }   // a folder of issues: a pack
        const comicFile = comics[0];
        if (!comicFile) {
          logger.warn('postprocess', `No comic file found in ${storageDir}`, { files });
          // Treat as a failure — blacklist and retry rather than silently staying 'downloaded'
          const failedUrl = issue.download_url || null;
          db.prepare(`UPDATE monitored_issues SET status='wanted', download_id=NULL, file_path=NULL WHERE id=?`).run(issue.id);
          setImmediate(async () => {
            try { await blacklistAndRetry(issue, series, failedUrl, 'Post-process: no comic file in download directory'); }
            catch (e) { logger.error('retry', `blacklistAndRetry failed after no-comic-file for ${issue.id}`, e.message); }
          });
          return false;
        }
        srcPath = path.join(storageDir, comicFile);
      } else {
        // The storage path vanished between download-complete and post-process,
        // or an odd download-client layout. Try the parent dir as a last resort:
        // only when exactly one comic sits alongside (more is ambiguous).
        const parent = path.dirname(storageDir);
        let parentFiles = [];
        try { parentFiles = fs.readdirSync(parent); } catch {}
        const siblings = parentFiles.filter(f => /\.(cbr|cbz|rar|zip)$/i.test(f));
        if(siblings.length>1)throw Object.assign(new Error('Ambiguous download source directory'),{code:'IDENTITY_REVIEW_REQUIRED'});
        const sibling = siblings[0];
        if (sibling) {
          logger.info('postprocess', `Recovered via parent dir`, { storageDir, parent, sibling });
          srcPath = path.join(parent, sibling);
        } else {
          logger.warn('postprocess', `Unrecognised storage path, skipping`, {
            storageDir,
            statType: stat ? (stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'other') : 'missing',
            parentFiles: parentFiles.slice(0, 10),
          });
          db.prepare(`UPDATE monitored_issues SET status='wanted', download_id=NULL, file_path=NULL WHERE id=?`).run(issue.id);
          return false;
        }
      }
      logger.info('postprocess', `Source file resolved`, { srcPath });
      const inside = await comicArchivesInside(srcPath);
      if (inside > 1) { handToPackProcessing(issue, srcPath, inside); return false; }

      const destSeriesDir = series.parent_series_id
        ? (db.prepare('SELECT directory FROM monitored_series WHERE id = ?').get(series.parent_series_id)?.directory || series.directory)
        : series.directory;
      const salvage = !!postProcess.salvage?.has(issue.id);
      const force = !!postProcess.force?.has(issue.id);   // admin: Process anyway (2026-11-09)
      if (force) logger.info('postprocess', `Issue ${issue.id}: processing anyway as this issue (admin)`, { file: path.basename(srcPath) });
      const result = await metadataRuntime.arrive({sourcePath: srcPath, issue, directory: destSeriesDir, salvage, force});
      postProcess.salvage?.delete(issue.id);
      postProcess.force?.delete(issue.id);   // kept after a failure (a Comic Vine wait), like Convert anyway
      const destPath = result.path;
      invalidateDirectoryExistsCache(series.parent_series_id || series.id);
      const fresh = db.prepare('SELECT cv_data FROM monitored_issues WHERE id = ?').get(issue.id);
      const cvHash = crypto.createHash('md5').update(fresh?.cv_data || '').digest('hex');
      db.prepare("UPDATE monitored_issues SET status='processed',file_path=?,date_processed=datetime('now'),has_comicinfo=1,last_retag_cv_hash=? WHERE id=?")
        .run(destPath, cvHash, issue.id);
      try { db.prepare('UPDATE monitored_issues SET retry_after=NULL,last_fail_reason=NULL WHERE id=?').run(issue.id); } catch {}
      logger.info('postprocess', 'Published identified comic', {bookId: result.bookId, destPath});

      // Special series don't get their own series.json — files live in parent's directory
      if (!series.parent_series_id) {
        createSeriesJsonIfMissing(series).catch(e =>
          logger.warn('postprocess', `series.json creation failed (non-fatal)`, e.message)
        );
      }

      // Schedule a library scan to pick up the new file
      schedulePostProcessScan(destPath);

      return true;

    } catch (e) {
      logger.error('postprocess', `Failed for issue ${issue.id}`, e.message);

      // Leave the source and any journal backups intact for retry/review. Provider
      // failures and identity conflicts are not proof that a download is corrupt.
      logger.warn('postprocess', 'Source retained for retry or metadata review', {storageDir, code: e.code, operationId: e.operationId});
      // A review result (identity/filename conflict) won't change on its own.
      // Wait 6 hours instead of repeating the same 8-second failure every poll.
      if (e.code === 'CV_RATE_LIMIT') {
        // Stays 'downloaded' (WAITING) and is tried again when the hour resets.
        try {
          db.prepare("UPDATE monitored_issues SET retry_after = ?, last_fail_reason = ? WHERE id = ? AND status = 'downloaded'")
            .run(sqlTime(e.retryAt), CV_WAIT_REASON, issue.id);
          logger.info('postprocess', `Issue ${issue.id} waiting for the Comic Vine limit`, { until: sqlTime(e.retryAt) });
        } catch {}
      } else if (e.code === 'ARCHIVE_DAMAGED') {
        // The file will not heal: stop retrying every poll (Avengers #253 was
        // tried every 30 s, 2026-10-16). Held for Convert anyway or a new copy.
        try {
          db.prepare("UPDATE monitored_issues SET retry_after = datetime('now', '+30 days'), last_fail_reason = ? WHERE id = ? AND status = 'downloaded'")
            .run(`ARCHIVE_DAMAGED: ${e.message}`.slice(0, 500), issue.id);
          logger.info('postprocess', `Issue ${issue.id} held: damaged download`, {});
        } catch {}
      } else if (e.code === 'LIBRARY_RECOVERY_REQUIRED') {
        try {
          db.prepare("UPDATE monitored_issues SET retry_after = datetime('now', '+5 minutes'), last_fail_reason = ? WHERE id = ? AND status = 'downloaded'")
            .run('Waiting for interrupted metadata work to be recovered', issue.id);
        } catch {}
      } else if (/^(IDENTITY_REVIEW_REQUIRED|CV_ISSUE_MISMATCH|ANNUAL_MISMATCH)$/.test(e.code || '')) {
        // The file names or tags another issue (2026-11-09). The file on disk will not change,
        // so trying again every 6 hours only repeated the failure and a Comic Vine lookup.
        // Held until an admin acts in Download Manager › Queue: Process anyway, Delete file or Resume.
        try {
          db.prepare("UPDATE monitored_issues SET retry_after = datetime('now', '+30 days'), last_fail_reason = ? WHERE id = ? AND status = 'downloaded'")
            .run(`${e.code}: ${e.message}`.slice(0, 500), issue.id);
          logger.info('postprocess', `Issue ${issue.id} held for an admin: the file does not match the issue`, {code: e.code});
        } catch {}
      } else if (/REVIEW|MISMATCH|OCCUPIED|UNSAFE|INVALID/.test(e.code || '')) {
        try {
          db.prepare("UPDATE monitored_issues SET retry_after = datetime('now', '+6 hours'), last_fail_reason = ? WHERE id = ? AND status = 'downloaded'")
            .run(`${e.code}: ${e.message}`.slice(0, 500), issue.id);
          logger.info('postprocess', `Issue ${issue.id} needs review; next automatic attempt in 6 hours`, {code: e.code});
        } catch {}
      } else {
        // Any other failure: wait before trying again instead of every poll (Storm #10/#11 failed
        // 7 times a minute, 2026-10-22). File problems that will not heal wait 6 hours; others 15 minutes.
        // UNSUPPORTED_XML / UNSUPPORTED_FIELD (2026-11-14): the file's own ComicInfo will not change either.
        const lasting = /^(RAR_TOOL_REQUIRED|UNSUPPORTED_ARCHIVE|NO_IMAGE_PAGES|ARCHIVE_LIMIT|UNSUPPORTED_ENCODING|INVALID_COMICINFO|UNSUPPORTED_XML|UNSUPPORTED_FIELD)$/.test(e.code || '');
        try {
          db.prepare(`UPDATE monitored_issues SET retry_after = datetime('now', '${lasting ? '+6 hours' : '+15 minutes'}'), last_fail_reason = ? WHERE id = ? AND status = 'downloaded'`)
            .run(`${e.code || 'ERROR'}: ${e.message}`.slice(0, 500), issue.id);
          logger.info('postprocess', `Issue ${issue.id} failed; next automatic attempt in ${lasting ? '6 hours' : '15 minutes'}`, {code: e.code});
        } catch {}
      }

      return false;
    } finally {
      // Cleanup temp dir
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  // "Convert anyway" for a damaged download (Download Manager → Queue): the next
  // post-processing of these issues keeps the readable pages (RAR only).
  postProcess.salvage = new Set();
  postProcess.force = new Set();   // issue ids an admin chose to process anyway (Download Manager › Queue)

  // A single-issue download that is really a pack (2026-11-14, The Expanse Origins #1: GetComics served
  // "The Expanse Origins (001-004) (2017)", one zip holding four .cbr files; it was held as
  // NO_IMAGE_PAGES and retried every 6 hours). Counts the comic archives inside an archive.
  async function comicArchivesInside(file) {
    if (!/\.(zip|cbz|rar|cbr)$/i.test(file)) return 0;
    const opts = { timeout: 60000, maxBuffer: 8 * 1024 * 1024 };
    let out = '';
    try { ({ stdout: out } = await execFileAsync('bsdtar', ['-tf', file], opts)); }
    catch { try { ({ stdout: out } = await execFileAsync('unrar', ['lb', file], opts)); } catch { return 0; } }   // unreadable: the normal path reports it
    return String(out).split('\n').map(n => n.trim())
      .filter(n => /\.(cbz|cbr|zip|rar)$/i.test(n) && !/(^|\/)(__MACOSX\/|\._)/.test(n)).length;
  }
  // Hand it to pack processing, which files every wanted issue it holds (this one included) and
  // lists the rest under Download Manager › Queue › Pack files not filed. The issue goes back to
  // wanted; the wanted scan leaves a series alone while one of its packs waits to be processed.
  function handToPackProcessing(issue, source, count) {
    db.prepare(`UPDATE monitored_issues SET status='wanted', download_id=NULL, retry_after=NULL, last_fail_reason=? WHERE id=?`)
      .run(`The download held ${count} issues: handed to pack processing`, issue.id);
    const packId = db.prepare(`INSERT INTO series_packs (series_id, file_path, status) VALUES (?, ?, 'downloaded')`).run(issue.series_id, source).lastInsertRowid;
    logger.info('postprocess', `Issue ${issue.id}: the download holds ${count} issues; handed to pack processing`, { file: path.basename(source), pack: packId });
  }

  // Download coordination (server.js, once everything has loaded), as server.js did for its own names.
  function wrapDownloads(coordinate) {
    { const salvage = postProcess.salvage, force = postProcess.force; postProcess = coordinate(postProcess); postProcess.salvage = salvage; postProcess.force = force; }
    processMangaTorrents = coordinate(processMangaTorrents);
  }
  return { comicArchivesInside, handToPackProcessing, wrapDownloads,
    get postProcess() { return postProcess; }, get processMangaTorrents() { return processMangaTorrents; }, get mangaTorrentState() { return mangaTorrentState; } };
};
