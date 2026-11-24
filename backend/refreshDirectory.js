'use strict';
// ─── Refresh a series folder (moved out of server.js 2026-11-23, server.js split step 7B) ───
// Match a monitored series' files to its issues and fix the database (runRefreshDirectory), read
// ComicInfo of files whose issue is unknown (scanSeriesComicInfo), the refresh routes for one series and
// for all, and the file-paths diagnostic. Moved unchanged. server.js wraps both functions with the
// library read lock once the file has loaded (wrapReads).
const fs = require('fs');
const path = require('path');
const { nameKey } = require('./names');
const { buildDestFilename } = require('./fileNaming');

const NEEDS = ['activeDownloads', 'app', 'appendResetLog', 'archiveHasComicInfo', 'backfillMonitoredLinksByCv', 'db', 'decideMetadataIdentity', 'extractComicInfo', 'extractIssueNumber', 'invalidateDirectoryExistsCache', 'logger', 'normalizeIssueNum', 'pushDownloadUpdate', 'refreshSeriesIssuesFromCV', 'requireAdmin'];
module.exports.NEEDS = NEEDS;

module.exports.createRefreshDirectory = function createRefreshDirectory(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createRefreshDirectory: missing ${missing.join(', ')}`);
  const { activeDownloads, app, appendResetLog, archiveHasComicInfo, backfillMonitoredLinksByCv, db, decideMetadataIdentity, extractComicInfo, extractIssueNumber, invalidateDirectoryExistsCache, logger, normalizeIssueNum, pushDownloadUpdate, refreshSeriesIssuesFromCV, requireAdmin } = deps;
  // ─── Refresh series directory ────────────────────────────────────
  // Scans the series folder for comic files, matches them to monitored issues
  // by issue number, and reconciles DB state:
  //   - File found, issue not processed → mark processed
  //   - Issue marked processed, file missing → reset to wanted
  // Returns { matched, reset, unmatched, detail }
  /**
   * Core refresh logic — scans a series directory and reconciles DB state.
   * Returns { matched, reset, unmatched, total_files, detail } or throws.
   * Safe to call any time (add, import, manual refresh button).
   */
  // Scan all processed issues in a series and populate their has_comicinfo flag.
  // Async + sequential so we don't thrash the disk or flood the DB.
  // If onlyUnknown is true (the default), skips issues that have already been
  // scanned — much faster on repeat runs. Set to false to force a full re-scan.
  async function scanSeriesComicInfo(seriesId, { onlyUnknown = true } = {}) {
    const whereFlag = onlyUnknown ? 'AND has_comicinfo IS NULL' : '';
    const issues = db.prepare(
      `SELECT id, file_path FROM monitored_issues
     WHERE series_id = ? AND status = 'processed' AND file_path IS NOT NULL ${whereFlag}`
    ).all(seriesId);

    if (!issues.length) return { scanned: 0, tagged: 0, untagged: 0, skipped: 0 };

    const update = db.prepare('UPDATE monitored_issues SET has_comicinfo = ? WHERE id = ?');
    let tagged = 0, untagged = 0, skipped = 0;

    for (const i of issues) {
      if (!fs.existsSync(i.file_path)) { skipped++; continue; }
      const has = await archiveHasComicInfo(i.file_path);
      if (has === null) { skipped++; continue; }
      update.run(has ? 1 : 0, i.id);
      if (has) tagged++; else untagged++;
    }
    logger.info('comicinfo-scan', `Series ${seriesId}`, { total: issues.length, tagged, untagged, skipped });
    return { scanned: issues.length, tagged, untagged, skipped };
  }

  async function runRefreshDirectory(seriesId) {
    const observedIdentities=new Map();
    const confirmedIdentity=async(file,issue)=>{
      if(!observedIdentities.has(file)){
        const xml=await extractComicInfo(file);
        const decision=decideMetadataIdentity({bookId:'refresh-observation',arrival:'scanner',filename:path.basename(file),comicInfoXml:xml});
        observedIdentities.set(file,decision.status==='accepted'?decision.cvIssueId:null);
      }
      return observedIdentities.get(file)===String(issue.id);
    };
    const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(seriesId);
    if (!series) throw new Error('Series not found');

    // Directory missing: reset every previously-matched issue back to 'wanted'.
    // Bailing without resetting (the previous behaviour) left stale 'processed'
    // rows whose file_path pointed into a directory the series no longer owns,
    // producing misleading card UIs ("5/51 issues" with no directory on disk).
    // The reset matches the same field set Phase 2 below uses when an
    // individual file goes missing — symmetric, predictable, and recoverable
    // (point the directory back at valid files, click Refresh, those issues
    // return to 'processed' via the regular match path).
    if (!fs.existsSync(series.directory)) {
      // Retry after 3 seconds — Windows/Docker volume mounts can be briefly
      // unavailable at startup or after a hiccup. Don't nuke processed state
      // on a transient read failure.
      await new Promise(r => setTimeout(r, 3000));
      if (!fs.existsSync(series.directory)) {
        const stale = db.prepare(`
        SELECT id, issue_number, file_path FROM monitored_issues
        WHERE series_id = ? AND status IN ('processed', 'downloaded') AND is_annual = 0
      `).all(series.id);
        if (stale.length) {
          logger.warn('refresh-dir',
            `Series "${series.name}" directory missing — reset ${stale.length} stale match(es)`,
            { directory: series.directory, caller: new Error().stack.split('\n').slice(1,4).join(' | ') });
          appendResetLog(`Series "${series.name}" directory missing — reset ${stale.length} issues`, { directory: series.directory });
          const reset = db.prepare(`
          UPDATE monitored_issues
          SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
          WHERE id = ?
        `);
          for (const issue of stale) {
            reset.run(issue.id);
          }
          return { matched: 0, reset: stale.length, unmatched: 0, total_files: 0, detail: [], directory_missing: true };
        }
        return { matched: 0, reset: 0, unmatched: 0, total_files: 0, detail: [], directory_missing: true };
      }
      logger.info('refresh-dir', `Series "${series.name}" directory appeared on retry — continuing`, { directory: series.directory });
      invalidateDirectoryExistsCache(seriesId);
    }

    const allIssues = db.prepare('SELECT * FROM monitored_issues WHERE series_id = ?').all(series.id);

    let dirFiles;
    try {
      dirFiles = fs.readdirSync(series.directory).filter(f => /\.(cbz|cbr|zip|rar)$/i.test(f));
    } catch (e) {
      throw new Error(`Cannot read directory: ${e.message}`);
    }

    // Build a map: normalized issue number → full file path
    // Keys stored as BOTH integer string AND full extracted string (e.g. "14" AND "14.1")
    // Annual-named files are excluded — they are handled separately in Phase 2
    //
    // For special series (sharing a directory with a parent), require the filename to
    // start with the normalised series name. This is much more reliable than word matching:
    // "Amazing Spider-Man Blood Hunt 001.cbz" starts with "amazingspidermanbloodhunt" ✓
    // "Amazing Spider-Man 001 (2022).cbz" does not                                    ✗
    let specialNamePrefix = null;
    // is_special is the authoritative "I am a special" flag — set on add when
    // the user picked "Special of …". parent_series_id is also accepted for
    // backwards compat (older specials backfilled to is_special=1 at startup,
    // but the OR keeps us safe if the migration ever lags).
    if (series.is_special || series.parent_series_id) {
      specialNamePrefix = nameKey(series.name);
      logger.info('refresh-dir', `Special series — filtering files by name prefix`, { series: series.name, prefix: specialNamePrefix });
    }

    // The reverse, for a parent: files that belong to a special sharing this
    // folder ("Knight Terrors Catwoman 001" in Catwoman (2018)) are never matched
    // to the parent's issues by number. Same name-prefix rule the special uses.
    const normFile = f => nameKey(f);
    const ownNorm = normFile(series.name);
    const specialPrefixes = specialNamePrefix ? [] : db.prepare(
      `SELECT name FROM monitored_series WHERE directory = ? AND id != ? AND (is_special = 1 OR parent_series_id IS NOT NULL)`
    ).all(series.directory, series.id).map(r => normFile(r.name)).filter(p => p.length >= 4 && p !== ownNorm && !ownNorm.startsWith(p));
    const belongsToSpecial = f => specialPrefixes.some(p => normFile(path.basename(f)).startsWith(p));
    if (specialPrefixes.length) logger.info('refresh-dir', `Parent series — ignoring files of ${specialPrefixes.length} special(s) in this folder`, { series: series.name });

    // Several files can share an issue number ("Superman 001", "Superman House
    // of Brainiac Special 001"). Prefer the one named exactly like the series;
    // the file tagged with the issue's own Comic Vine id wins over both (below).
    const nameScore = f => { const n = normFile(f); return ownNorm && n.startsWith(ownNorm) && /^\d/.test(n.slice(ownNorm.length)) ? 2 : 1; };
    const better = (newF, oldPath, isCbz) => {
      if (!oldPath) return true;
      const a = nameScore(newF), b = nameScore(path.basename(oldPath));
      return a !== b ? a > b : isCbz;   // equal names: the old rule (CBZ wins)
    };
    // Comic Vine id → file, for files in this folder (the scanner's record).
    const cvFile = new Map();
    try {
      for (const r of db.prepare(`SELECT path, cv_issue_id FROM scanned_books WHERE path LIKE ? AND cv_issue_id IS NOT NULL AND cv_issue_id != ''`)
        .all(series.directory.replace(/[\\/]+$/, '') + '/%')) {
        if (path.dirname(r.path) !== series.directory.replace(/[\\/]+$/, '')) continue;
        if (specialPrefixes.length && belongsToSpecial(r.path)) continue;
        if (/annual/i.test(path.basename(r.path))) continue;   // same rule as by-number: annual files never stand in for regular issues
        if (fs.existsSync(r.path)) cvFile.set(String(r.cv_issue_id), r.path);
      }
    } catch (e) { logger.warn('refresh-dir', 'CV file lookup failed', e.message); }

    // Comic Vine id the scanner recorded for every file (annuals included) in the
    // folders this refresh looks at. A file tagged as a DIFFERENT CV issue is never
    // matched to an issue by number — that is how a monitored 2023 annual got
    // linked to the 2026 annual's file (every year's annual is #1).
    const cvOfPath = new Map();
    const cvLoaded = new Set();
    const loadCv = dir => {
      const d = String(dir || '').replace(/[\\/]+$/, '');
      if (!d || cvLoaded.has(d)) return;
      cvLoaded.add(d);
      try {
        for (const r of db.prepare(`SELECT path, cv_issue_id FROM scanned_books WHERE path LIKE ? AND cv_issue_id IS NOT NULL AND cv_issue_id != ''`).all(d + '/%'))
          if (path.dirname(r.path) === d) cvOfPath.set(r.path, String(r.cv_issue_id));
      } catch (e) { logger.warn('refresh-dir', 'CV tag lookup failed', e.message); }
    };
    loadCv(series.directory);
    const taggedAsOther = (p, issue) => { const c = cvOfPath.get(p); return !!c && c !== String(issue.id); };
    const claimedByOther = (p, issue) => !!db.prepare(
      `SELECT 1 FROM monitored_issues WHERE file_path = ? AND id != ? AND status = 'processed' LIMIT 1`).get(p, issue.id);
    const fileYear = p => { const m = path.basename(p).match(/(?:^|[^0-9])((?:19|20)[0-9]{2})(?:[^0-9]|$)/); return m ? m[1] : null; };
    const issueYears = issue => [issue.release_date, issue.store_date].filter(Boolean).map(d => String(d).slice(0, 4));
    const pushNum = (m, k, p) => { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(p)) m.get(k).push(p); };
    // Pick the file for an annual issue: the file tagged with its own CV id; else
    // by issue number, but only a file that is not tagged as another issue, not
    // already linked to another issue, and whose filename year (if any) is the
    // issue's year. Several still possible → no match (logged), never a guess.
    function pickAnnualFile(issue, byNum, dir, label) {
      const d = String(dir || '').replace(/[\\/]+$/, '');
      loadCv(d);
      const id = String(issue.id);
      for (const [p, c] of cvOfPath) {
        if (c === id && path.dirname(p) === d && /annual/i.test(path.basename(p)) && fs.existsSync(p)) return p;
      }
      const norm = normalizeIssueNum(issue.issue_number);
      if (!norm) return null;
      let cands = byNum.get(norm) || [];
      if (!cands.length && !norm.includes('.')) {
        const intKey = String(parseInt(String(issue.issue_number || '0').replace(/,/g, ''), 10) || 0);
        if (intKey !== norm) cands = byNum.get(intKey) || [];
      }
      const ys = issueYears(issue);
      const ok = cands.filter(p => !taggedAsOther(p, issue) && !claimedByOther(p, issue)
        && (!ys.length || !fileYear(p) || ys.includes(fileYear(p))));
      if (!ok.length) {
        if (cands.length) logger.info('refresh-dir', `Annual #${issue.issue_number} not matched — candidate file(s) are another year, another CV issue, or already linked`,
          { series: label, issueYears: ys, files: cands.map(p => path.basename(p)) });
        return null;
      }
      if (ok.length > 1) {
        const cbz = ok.filter(p => /\.cbz$/i.test(p));
        if (cbz.length === 1) return cbz[0];
        logger.warn('refresh-dir', `Annual #${issue.issue_number} not matched — ${ok.length} possible files`, { series: label, files: ok.map(p => path.basename(p)) });
        return null;
      }
      return ok[0];
    }

    const filesByNum = new Map();
    for (const filename of dirFiles) {
      if (/annual/i.test(filename)) continue; // never match annual files to regular issues
      if (specialPrefixes.length && belongsToSpecial(filename)) continue;  // a special's file, not ours
      // For special series, only match files whose normalised name starts with the series name
      if (specialNamePrefix) {
        const fileNorm = nameKey(filename);
        if (!fileNorm.startsWith(specialNamePrefix)) continue;
      }
      const extracted = extractIssueNumber(filename);
      if (extracted !== null) {
        const fullPath = path.join(series.directory, filename);
        const isCbz = filename.toLowerCase().endsWith('.cbz');
        // Always store the full extracted key (handles 14.1, 14.MU, 1000000, 8.AU)
        if (better(filename, filesByNum.get(extracted), isCbz)) {
          filesByNum.set(extracted, fullPath);
        }
        // Integer-only alias — ONLY when the extracted form is a pure integer
        // (no dot). Adding the alias for "8.AU" or "14.1" was the bug: it let
        // a regular issue 8 query hit an 8.AU file (or vice versa) via the
        // matching loop's intKey fallback. With canonical extraction, "008"
        // already collapses to "8", so this branch is effectively a no-op for
        // plain integers and is skipped entirely for suffixed/decimal forms.
        if (!extracted.includes('.')) {
          const intKey = String(parseInt(extracted, 10));
          if (intKey !== extracted && better(filename, filesByNum.get(intKey), isCbz)) {
            filesByNum.set(intKey, fullPath);
          }
        }
      }
    }

    const detail = [];
    let matched = 0, reset = 0, unmatched = filesByNum.size; // only non-annual files

    // Phase 1: match files → issues
    for (const issue of allIssues.filter(i => !i.is_annual)) {
      // Linked to a special's file: drop the link and SKIP the issue (do not
      // make it wanted — these are issues the owner chose not to collect here).
      // Clearing the retag state means the retagger never writes this issue's
      // data into the special's file.
      if (specialPrefixes.length && issue.file_path && belongsToSpecial(issue.file_path)) {
        db.prepare(`UPDATE monitored_issues SET status = 'skipped', file_path = NULL, download_id = NULL, date_processed = NULL,
        has_comicinfo = NULL, last_retag_cv_hash = NULL WHERE id = ?`).run(issue.id);
        detail.push({ issue_number: issue.issue_number, action: 'skipped', reason: `file belongs to a special: ${path.basename(issue.file_path)}` });
        logger.info('refresh-dir', `Issue #${issue.issue_number} unlinked from a special's file`, { series: series.name, file: issue.file_path });
        // Fall through to the normal match below: if the real issue's file is
        // also in the folder it gets linked (processed); otherwise it stays skipped.
        issue.status = 'skipped'; issue.file_path = null;
      }
      // normalizeIssueNum produces canonical form: "8.AU", "14.1", "1.NOW", "1000000".
      const norm = normalizeIssueNum(issue.issue_number);
      // Integer fallback ONLY when the canonical form has no dot — i.e. a plain
      // integer issue. For "8.AU" / "14.1" / "1.NOW", the suffix/decimal IS the
      // identity of the issue and the fallback would false-match against a
      // plain-integer file ("8.AU" matching a regular #8 file was the bug).
      let filePath = cvFile.get(String(issue.id)) || filesByNum.get(norm);
      if (!filePath && !norm.includes('.')) {
        const intKey = String(parseInt(String(issue.issue_number || '0').replace(/,/g,''), 10) || 0);
        if (intKey !== norm) filePath = filesByNum.get(intKey);
      }
      // Matched by number only: refuse a file that is tagged as another CV issue.
      if (filePath && cvFile.get(String(issue.id)) !== filePath && taggedAsOther(filePath, issue)) {
        logger.info('refresh-dir', `Issue #${issue.issue_number} not matched — file is tagged as CV issue ${cvOfPath.get(filePath)}`,
          { series: series.name, file: path.basename(filePath) });
        filePath = null;
      }

      if (filePath && await confirmedIdentity(filePath,issue)) {


        unmatched--; // this file was matched
        // Sanity check — file must be inside the series directory
        const inDir = filePath.startsWith(series.directory + path.sep) || filePath.startsWith(series.directory + '/');
        if (inDir && issue.status !== 'processed') {
          // has_comicinfo is set to NULL on a fresh match — the async post-refresh
          // scan will populate it. This avoids claiming "tagged" for files we haven't inspected yet.
          db.prepare(`UPDATE monitored_issues
          SET status = 'processed', file_path = ?, date_processed = datetime('now'), has_comicinfo = NULL
          WHERE id = ?`).run(filePath, issue.id);
          detail.push({ issue_number: issue.issue_number, action: 'matched', file: path.basename(filePath) });
          matched++;
          logger.info('refresh-dir', `Issue #${issue.issue_number} matched to file`, { file: filePath });
        } else if (inDir && issue.status === 'processed' && issue.file_path !== filePath) {
          // Already-processed issue whose file moved/renamed — also invalidate the flag so
          // we re-inspect. Covers the case where someone replaces a file in-place.
          db.prepare(`UPDATE monitored_issues SET file_path = ?, has_comicinfo = NULL WHERE id = ?`)
            .run(filePath, issue.id);
        }
      } else if (issue.status === 'processed') {
        // Check for annual mismatch — file_path points to an annual-named file but issue is not annual
        const filePathIsAnnual = issue.file_path && /annual/i.test(path.basename(issue.file_path));
        if (filePathIsAnnual && !issue.is_annual) {
          db.prepare(`UPDATE monitored_issues
          SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
          WHERE id = ?`).run(issue.id);
          detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'file_path points to annual-named file but issue is not an annual' });
          reset++;
          logger.info('refresh-dir', `Issue #${issue.issue_number} reset — file was renamed to annual`, { was: issue.file_path });
        } else if (issue.file_path && !fs.existsSync(issue.file_path)) {
          // Double-check before resetting — Windows/Docker mounts can have brief
          // hiccups where existsSync returns false even though the file is there.
          // Wait 2 seconds and check again before committing to a reset.
          const stillMissing = await new Promise(resolve => {
            setTimeout(() => resolve(!fs.existsSync(issue.file_path)), 2000);
          });
          if (!stillMissing) {
            logger.info('refresh-dir', `Issue #${issue.issue_number} — file appeared on retry, skipping reset`, { path: issue.file_path });
          } else {
            db.prepare(`UPDATE monitored_issues
            SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
            WHERE id = ?`).run(issue.id);
            detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'file missing' });
            reset++;
            logger.info('refresh-dir', `Issue #${issue.issue_number} reset — file gone`, { was: issue.file_path });
            appendResetLog(`Issue #${issue.issue_number} reset — file gone`, { series: series.name, was: issue.file_path });
          }
        } else if (!issue.file_path) {
          // Processed but no file_path recorded — try to find by expected filename
          const expectedFilename = buildDestFilename(issue, series);
          const expectedPath = path.join(series.directory, expectedFilename);
          if (!fs.existsSync(expectedPath)) {
            db.prepare(`UPDATE monitored_issues
            SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
            WHERE id = ?`).run(issue.id);
            detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'file missing (no path recorded)' });
            reset++;
          }
        }
      }
    }

    // Phase 2: reconcile linked annual series issues (they have their own series_id)
    const linkedAnnualIds = db.prepare(
      `SELECT annual_series_id FROM series_annual_links WHERE parent_series_id = ?`
    ).all(series.id).map(r => r.annual_series_id);

    for (const annualSeriesId of linkedAnnualIds) {
      const annualSeries = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(annualSeriesId);
      if (!annualSeries) continue;

      // Build a map of annual-named files in the directory keyed by extracted issue number.
      // Annual series share the parent directory, so scan the same dirFiles list
      // but restrict to filenames containing "annual" to avoid false matches with regular issues.
      const annualFilesByNum = new Map();
      const annualDir = annualSeries.directory || series.directory;
      let annualDirFiles = dirFiles; // default: same dir as parent
      if (annualDir !== series.directory) {
        try { annualDirFiles = fs.readdirSync(annualDir).filter(f => /\.(cbz|cbr|zip|rar)$/i.test(f)); } catch { annualDirFiles = []; }
      }
      for (const filename of annualDirFiles) {
        if (!/annual/i.test(filename)) continue; // only consider annual-named files
        const extracted = extractIssueNumber(filename);
        if (extracted !== null) {
          const fullPath = path.join(annualDir, filename);
          // Every annual file per number (several years' annuals are all #1);
          // pickAnnualFile chooses among them.
          pushNum(annualFilesByNum, extracted, fullPath);
          // Integer alias only for plain-integer extracts — same suffix-safety
          // gate as the regular-issues map above.
          if (!extracted.includes('.')) {
            const intKey = String(parseInt(extracted, 10));
            if (intKey !== extracted) pushNum(annualFilesByNum, intKey, fullPath);
          }
        }
      }

      const allAnnualIssues = db.prepare(
        `SELECT * FROM monitored_issues WHERE series_id = ?`
      ).all(annualSeriesId);

      for (const issue of allAnnualIssues) {
        if (issue.status === 'processed') {
          // Deletion check — reset if file is gone
          if (issue.file_path && !fs.existsSync(issue.file_path)) {
            db.prepare(`UPDATE monitored_issues
            SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
            WHERE id = ?`).run(issue.id);
            detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'annual file missing', series: annualSeries.name });
            reset++;
            logger.info('refresh-dir', `Annual issue #${issue.issue_number} reset — file gone`, { series: annualSeries.name, was: issue.file_path });
          } else if (!issue.file_path) {
            const expectedFilename = buildDestFilename(issue, annualSeries);
            const expectedPath = path.join(annualDir, expectedFilename);
            if (!fs.existsSync(expectedPath)) {
              db.prepare(`UPDATE monitored_issues
              SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
              WHERE id = ?`).run(issue.id);
              detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'annual file missing (no path)', series: annualSeries.name });
              reset++;
            }
          }
        } else {
          // Forward-match: try to find an existing annual file for this wanted issue.
          // Integer fallback gated on no-dot for the same suffix-safety reason
          // as the regular-issues lookup above.
          const filePath = pickAnnualFile(issue, annualFilesByNum, annualDir, annualSeries.name);
          if (filePath && await confirmedIdentity(filePath,issue)) {
            db.prepare(`UPDATE monitored_issues
            SET status = 'processed', file_path = ?, date_processed = datetime('now')
            WHERE id = ?`).run(filePath, issue.id);
            detail.push({ issue_number: issue.issue_number, action: 'matched', file: path.basename(filePath), series: annualSeries.name });
            matched++;
            logger.info('refresh-dir', `Annual #${issue.issue_number} matched to file`, { file: filePath, series: annualSeries.name });
          }
        }
      }
    }

    // Phase 3: reconcile is_annual=1 issues embedded directly in the parent series.
    // This covers CV volumes that list annuals as issue entries rather than as separate
    // volumes — in that case there are no series_annual_links rows and Phase 2 is a
    // no-op, but Phase 1 also skips them (filter: !i.is_annual), leaving them in a
    // dead zone where Refresh never matched them to files on disk.
    // Only runs when no linked annual volumes exist — consistent with the API endpoint
    // which uses the same guard when deciding what to show in the series card.
    if (linkedAnnualIds.length === 0) {
      const inSeriesAnnuals = allIssues.filter(i => i.is_annual);
      if (inSeriesAnnuals.length > 0) {
        // Build annual-file map from the same dirFiles scan already done above,
        // restricted to filenames that contain "annual" — same logic as Phase 2.
        const annualFilesByNum = new Map();
        for (const filename of dirFiles) {
          if (!/annual/i.test(filename)) continue;
          const extracted = extractIssueNumber(filename);
          if (extracted !== null) {
            const fullPath = path.join(series.directory, filename);
            pushNum(annualFilesByNum, extracted, fullPath);
            if (!extracted.includes('.')) {
              const intKey = String(parseInt(extracted, 10));
              if (intKey !== extracted) pushNum(annualFilesByNum, intKey, fullPath);
            }
          }
        }

        for (const issue of inSeriesAnnuals) {
          if (issue.status === 'processed') {
            // Deletion check — reset if the file is gone
            if (issue.file_path && !fs.existsSync(issue.file_path)) {
              db.prepare(`UPDATE monitored_issues
              SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
              WHERE id = ?`).run(issue.id);
              detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'annual file missing (in-series)' });
              reset++;
              logger.info('refresh-dir', `In-series annual #${issue.issue_number} reset — file gone`, { was: issue.file_path });
            } else if (!issue.file_path) {
              const expectedFilename = buildDestFilename(issue, series);
              const expectedPath = path.join(series.directory, expectedFilename);
              if (!fs.existsSync(expectedPath)) {
                db.prepare(`UPDATE monitored_issues
                SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
                WHERE id = ?`).run(issue.id);
                detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'annual file missing (no path, in-series)' });
                reset++;
              }
            }
          } else {
            // Forward-match: find an annual-named file for this wanted/snatched issue.
            const filePath = pickAnnualFile(issue, annualFilesByNum, series.directory, series.name);
            if (filePath && await confirmedIdentity(filePath,issue)) {
              db.prepare(`UPDATE monitored_issues
              SET status = 'processed', file_path = ?, date_processed = datetime('now')
              WHERE id = ?`).run(filePath, issue.id);
              detail.push({ issue_number: issue.issue_number, action: 'matched', file: path.basename(filePath) });
              matched++;
              logger.info('refresh-dir', `In-series annual #${issue.issue_number} matched to file`, { file: filePath });
            }
          }
        }
      }
    }

    backfillMonitoredLinksByCv('refresh');
    // Update have_count implicitly via the counts query on next series load
    logger.info('refresh-dir', `Series ${series.id} refresh done`, { matched, reset, unmatched });
    return { success: true, matched, reset, unmatched, total_files: dirFiles.length, detail };
  }

  // Route wrapper — covers all 3 goals in one button press:
  //   G1 (disk scan)  — runRefreshDirectory matches files → processed
  //   G2+G3 (CV sync) — refreshSeriesIssuesFromCV inserts missing/new issues → wanted
  //   Annuals         — autoDiscoverAnnuals fires inside refreshSeriesIssuesFromCV
  app.post('/api/monitor/series/:id/refresh-directory', requireAdmin, async (req, res) => {
    // Fetch series row here so it's in scope for the async block below.
    const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(req.params.id);
    if (!series) return res.status(404).json({ error: 'Series not found' });

    // G1: disk scan — synchronous, result returned immediately to UI
    let dirResult;
    try {
      dirResult = await runRefreshDirectory(req.params.id);
      // Invalidate cache so next poll picks up directory existence accurately —
      // directory may have been created between polls (common after first
      // download lands), or may have been deleted manually.
      invalidateDirectoryExistsCache(req.params.id);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    // G1b: ComicInfo.xml presence scan — runs before the response so the UI
    // gets accurate has_comicinfo values on the very first refresh, not after
    // a second click. onlyUnknown: true means this is a no-op after the first
    // run for any given issue (repeat refreshes stay cheap).
    try {
      const scanResult = await scanSeriesComicInfo(req.params.id, { onlyUnknown: true });
      if (scanResult.scanned > 0) {
        logger.info('refresh-dir', `ComicInfo scan complete for "${series.name}"`, scanResult);
      }
    } catch (e) {
      logger.warn('refresh-dir', `ComicInfo scan failed for "${series.name}"`, e.message);
    }

    res.json(dirResult);

    // G2+G3+Annuals: CV sync — async, fire-and-forget after response sent.
    // Kept async because CV calls are slow and not needed to display has_comicinfo.
    setImmediate(async () => {
      try {
        // Prune any bad annual links before re-discovery
        const STOPWORDS = new Set(['the','a','an','of','and','or','in','to','for','by']);
        const keyWords = series.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));

        const links = db.prepare(`
        SELECT l.annual_series_id, a.name as annual_name, a.year as annual_year
        FROM series_annual_links l
        JOIN monitored_series a ON a.id = l.annual_series_id
        WHERE l.parent_series_id = ?
      `).all(series.id);

        for (const link of links) {
          const aName = link.annual_name.toLowerCase();
          // Use `some` (any keyword matches) rather than `every` (all keywords match).
          // The `every` logic was too aggressive — series with subtitles like
          // "Invincible Iron Man" would prune "Iron Man Annual" because "invincible"
          // wasn't present. Now we only prune when the annual shares zero keywords
          // with the parent series, which catches genuinely unrelated links.
          const failsKeyword = keyWords.length > 0 && !keyWords.some(w => aName.includes(w));
          const failsYearGuard = series.year && link.annual_year
            ? parseInt(link.annual_year) < parseInt(series.year)
            : false;
          if (failsKeyword || failsYearGuard) {
            const reason = failsKeyword ? 'keyword mismatch (no shared keywords)' : `year ${link.annual_year} < series ${series.year}`;
            db.prepare('DELETE FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?')
              .run(series.id, link.annual_series_id);
            // Delete the annual series itself only when nothing else links to it.
            // (Deleting a shared annual failed on the FK after its issues were
            // already gone, leaving it with no issue list.)
            const stillLinked = db.prepare('SELECT 1 FROM series_annual_links WHERE annual_series_id = ? OR parent_series_id = ?')
              .get(link.annual_series_id, link.annual_series_id);
            if (!stillLinked) {
              db.transaction(() => {
                db.prepare('DELETE FROM series_packs WHERE series_id = ?').run(link.annual_series_id);
                db.prepare('DELETE FROM monitored_issues WHERE series_id = ?').run(link.annual_series_id);
                db.prepare('DELETE FROM monitored_series WHERE id = ?').run(link.annual_series_id);
              })();
            }
            logger.info('refresh-dir', `Pruned bad annual link: "${link.annual_name}" from "${series.name}" (${reason})`);
          }
        }

        // CV sync: inserts new/missing issues as wanted + fires autoDiscoverAnnuals internally
        await refreshSeriesIssuesFromCV(series.id);
        logger.info('refresh-dir', `CV sync complete for "${series.name}"`);
      } catch (e) {
        logger.warn('refresh-dir', `Post-refresh CV sync failed for "${series.name}"`, e.message);
      }
    });
  });

  // ─── Refresh ALL monitored series (bulk) ─────────────────────────
  // Streams SSE progress as it iterates every monitored series and runs
  // runRefreshDirectory on each. Each per-series call does a fresh
  // readdirSync against the series directory and updates monitored_issues
  // status based on what files are actually on disk — so this is the
  // canonical way to rebuild Download Manager state after any wipe or
  // after issue-number canonicalisation.
  //
  // Bypasses ALL the scanned_books mtime caching that the library
  // scanner uses, because runRefreshDirectory does not touch
  // scanned_books — it only reads the filesystem and writes
  // monitored_issues. That's exactly what we want for recovery.
  //
  // Single-flight: a global lock prevents concurrent runs.
  let _refreshAllRunning = false;
  app.post('/api/monitor/refresh-all-directories', requireAdmin, async (req, res) => {
    if (_refreshAllRunning) {
      return res.status(409).json({ error: 'Refresh All already running' });
    }
    _refreshAllRunning = true;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

    const allSeries = db.prepare(
      'SELECT id, name FROM monitored_series ORDER BY name COLLATE NOCASE'
    ).all();

    // Mirror progress to the global download toast so the user sees activity
    // regardless of which page they're on.
    const dlId = `refresh-all-${Date.now()}`;
    const dlEntry = {
      id: dlId,
      filename: `Refresh All Directories`,
      seriesName: 'All monitored series',
      bytesReceived: 0,
      totalBytes: allSeries.length,
      status: 'downloading',
      startedAt: new Date().toISOString(),
    };
    activeDownloads.set(dlId, dlEntry);
    pushDownloadUpdate(dlEntry);

    send({ start: true, total: allSeries.length });

    let aborted = false;
    req.on('close', () => { aborted = true; });

    let totalMatched = 0, totalReset = 0, errors = 0;
    try {
      for (let i = 0; i < allSeries.length; i++) {
        if (aborted) break;
        const s = allSeries[i];
        try {
          const r = await runRefreshDirectory(s.id);
          totalMatched += r?.matched || 0;
          totalReset   += r?.reset   || 0;
          send({
            index: i + 1, total: allSeries.length,
            seriesId: s.id, seriesName: s.name,
            matched: r?.matched || 0,
            reset:   r?.reset   || 0,
            unmatched: r?.unmatched || 0,
            totalFiles: r?.total_files || 0,
            directoryMissing: !!r?.directory_missing,
          });
        } catch (e) {
          errors++;
          logger.warn('refresh-all', `series ${s.id} (${s.name}) failed: ${e.message}`);
          send({
            index: i + 1, total: allSeries.length,
            seriesId: s.id, seriesName: s.name,
            error: e.message,
          });
        }
        dlEntry.bytesReceived = i + 1;
        pushDownloadUpdate({ ...dlEntry });
        // Yield every series so HTTP requests can be served.
        await new Promise(r => setImmediate(r));
      }
      send({ done: true, total: allSeries.length, totalMatched, totalReset, errors, aborted });
    } finally {
      _refreshAllRunning = false;
      dlEntry.status = aborted ? 'cancelled' : 'complete';
      pushDownloadUpdate({ ...dlEntry });
      setTimeout(() => { activeDownloads.delete(dlId); pushDownloadUpdate({ id: dlId, status: 'removed' }); }, 8000);
      try { res.end(); } catch {}
    }
  });

  // ─── Diagnostic: processed issue file paths ───────────────────────
  // Returns all processed issues with their file_path so the UI can
  // surface mismatched / cross-directory files.
  app.get('/api/monitor/series/:id/file-paths', requireAdmin, (req, res) => {   // shows disk paths: admin only
    const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(req.params.id);
    if (!series) return res.status(404).json({ error: 'Series not found' });

    const issues = db.prepare(`
    SELECT issue_number, status, file_path, is_annual
    FROM monitored_issues
    WHERE series_id = ? AND status = 'processed' AND file_path IS NOT NULL
    ORDER BY CAST(issue_number AS REAL)
  `).all(req.params.id);

    // Flag any file that lives outside the expected series directory
    const result = issues.map(i => ({
      issue_number: i.issue_number,
      is_annual: i.is_annual,
      file_path: i.file_path,
      filename: path.basename(i.file_path),
      in_series_dir: i.file_path.startsWith(series.directory + path.sep) || i.file_path.startsWith(series.directory + '/'),
    }));

    res.json({ directory: series.directory, issues: result });
  });

  // The library read lock (server.js, once everything has loaded), as server.js did for its own names.
  function wrapReads(wrap) { runRefreshDirectory = wrap('read', runRefreshDirectory); scanSeriesComicInfo = wrap('read', scanSeriesComicInfo); }
  return { wrapReads, get runRefreshDirectory() { return runRefreshDirectory; }, get scanSeriesComicInfo() { return scanSeriesComicInfo; } };
};
