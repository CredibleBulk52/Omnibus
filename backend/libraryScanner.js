'use strict';
// ─── Library scanner (moved out of server.js 2026-11-19, server.js split step 5) ───
// Scanning a library: the scan state, scanSeriesDir (one series folder: books added, changed,
// moved or gone; ComicInfo read; covers warmed; stable ids; deferral of changed evidence),
// runLibraryScan, the shared upsert statements (makeScanStmts), and the routes for libraries
// (list, add, edit, remove, scan, scan all) and GET /api/scan/status. Moved unchanged.
// server.js wraps runLibraryScan and scanSeriesDir for library reads once the file has loaded
// (wrapReads); the routes and runLibraryScan use the wrapped ones, as before.
const fs = require('fs');
const path = require('path');
const { nameKey } = require('./names');

const NEEDS = ['BOOK_UPSERT', 'COMIC_EXTS', 'THUMB_CACHE_DIR', 'app', 'backfillMonitoredLinksByCv', 'coverThumb', 'db', 'decideMetadataIdentity', 'deriveMetadataStatus', 'evictThumbCache', 'extractComicInfo', 'extractNumberFromFilename', 'filterImages', 'findThumbCache', 'invalidateSeriesCache', 'jsonMemCache', 'linkMonitoredByCv', 'listArchiveFiles', 'logger', 'metadataMaintenance', 'monitoredIssueGone', 'parseComicInfo', 'readArchiveMember', 'readSeriesJson', 'requireAdmin', 'runCbrQueue', 'scannerState', 'scheduleReconcile', 'stableIds', 'warmCreatorsCache', 'warmLatestReleaseDateCache'];
module.exports.NEEDS = NEEDS;

module.exports.createLibraryScanner = function createLibraryScanner(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createLibraryScanner: missing ${missing.join(', ')}`);
  const { BOOK_UPSERT, COMIC_EXTS, THUMB_CACHE_DIR, app, backfillMonitoredLinksByCv, coverThumb, db, decideMetadataIdentity, deriveMetadataStatus, evictThumbCache, extractComicInfo, extractNumberFromFilename, filterImages, findThumbCache, invalidateSeriesCache, jsonMemCache, linkMonitoredByCv, listArchiveFiles, logger, metadataMaintenance, monitoredIssueGone, parseComicInfo, readArchiveMember, readSeriesJson, requireAdmin, runCbrQueue, scannerState, scheduleReconcile, stableIds, warmCreatorsCache, warmLatestReleaseDateCache } = deps;

  // In-memory scan state
  let scanState = {
    running: false,
    libraryId: null,
    progress: 0,
    total: 0,
    currentPath: '',
    startedAt: null,
    completedAt: null,
    errors: [],
  };

  // ─── Shared scanner helpers ───────────────────────────────────────
  function makeScanStmts() {
    const upsertSeries = db.prepare(`
      INSERT INTO scanned_series (id, library_id, path, name, year, metadata_status, series_json, monitored_series_id, book_count, last_scanned, dir_mtime, dir_file_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        library_id=excluded.library_id, name=excluded.name, year=excluded.year,
        metadata_status=excluded.metadata_status, series_json=excluded.series_json,
        monitored_series_id=excluded.monitored_series_id, book_count=excluded.book_count,
        last_scanned=CURRENT_TIMESTAMP, dir_mtime=excluded.dir_mtime, dir_file_count=excluded.dir_file_count
    `);
    const upsertBook = db.prepare(BOOK_UPSERT);
    return { upsertSeries, upsertBook };
  }

  // Keep archive readers and their cache writes inside the scan lifetime. A
  // changed file/row invalidates the result before it can populate a stale cover.
  async function warmScannedThumbnail(filePath, cacheKeys) {
    const snapshot = scannerState.capture(filePath);
    if (!snapshot) return false;
    try {
      const images = filterImages(await listArchiveFiles(filePath));
      if (!images.length) return false;
      const stdout = await readArchiveMember(filePath, images[0], 10 * 1024 * 1024);
      if (!scannerState.current(snapshot)) return false;
      const t = await coverThumb(stdout, path.extname(images[0]).toLowerCase() || '.jpg');
      if (!scannerState.current(snapshot)) return false;
      for (const key of cacheKeys) fs.writeFileSync(path.join(THUMB_CACHE_DIR, key + t.ext), t.buf);
      return true;
    } catch { return false; } // Thumbnail failure must not make a comic disappear.
  }

  /** Scan one directory; defer changed evidence without losing existing filing. */
  async function scanSeriesDir(seriesDir, libraryId, upsertSeries, upsertBook, arrival = 'scanner') {
    // Held/crashed work retains these reservations until explicit recovery.
    // Do not cache directory freshness when a later retry is required.
    if (scannerState.reserved(seriesDir, null, true) ||
        (!db.prepare('SELECT id FROM scanned_series WHERE path=?').get(seriesDir) && !scannerState.mayRegister())) {
      db.prepare('UPDATE scanned_series SET dir_mtime=-1 WHERE path=?').run(seriesDir);
      return { skipped: true, skippedBooks: 0, changedBooks: 0, deferred: true };
    }
    // Stable ID: the live row at this path, else a reclaimed record (CV volume ID), else a new ID.
    const seriesId = stableIds.resolveSeriesId(seriesDir, () => readSeriesJson(seriesDir));
    const dirStat = fs.statSync(seriesDir);
    const dirMtime = Math.floor(dirStat.mtimeMs);
    const dirEntries = fs.readdirSync(seriesDir, { withFileTypes: true });
    const comicFiles = dirEntries.filter(e => e.isFile() && COMIC_EXTS.test(e.name)).map(e => e.name).sort();
    const dirFileCount = comicFiles.length;

    const existingRow = db.prepare('SELECT dir_mtime, dir_file_count FROM scanned_series WHERE id = ?').get(seriesId);
    const seriesUnchanged = existingRow &&
      existingRow.dir_mtime === dirMtime &&
      existingRow.dir_file_count === dirFileCount;

    // Disk unchanged: no rescan, but every book's cover must be in the cache (2026-11-26). Shelves show
    // each book's own cover, and a series shows its cover book's (covers.js pickSeriesCoverBook). Covers go
    // missing after a backup is restored on a new install or "Clear all thumbnails"; before, this only made
    // an unused series_<id> file, so every cover was then made while someone browsed. A cover that cannot
    // be made is tried again on the next scan; it does not force a full rescan.
    if (seriesUnchanged) {
      const missing = db.prepare('SELECT id, path FROM scanned_books WHERE series_id = ?').all(seriesId).filter(b => !findThumbCache(b.id));
      let coversMade = 0;
      for (let i = 0; i < missing.length; i++) {
        if (i > 0 && i % 5 === 0) await new Promise(r => setImmediate(r));
        if (await warmScannedThumbnail(missing[i].path, [missing[i].id])) coversMade++;
      }
      return { skipped: true, skippedBooks: 0, changedBooks: 0, coversMade };
    }

    const folderName = path.basename(seriesDir);
    // "(YYYY)" anchored at the end only: the old /^(.+?)\s*\((\d{4})\)\s*$/ could backtrack (CodeQL, 2026-11-12).
    const folderYearMatch = /\((\d{4})\)$/.exec(folderName.trim());
    const folderTitle = folderYearMatch ? folderName.trim().slice(0, folderYearMatch.index).trim() : folderName;
    const folderYear  = folderYearMatch ? parseInt(folderYearMatch[1]) : null;

    const jsonData = readSeriesJson(seriesDir);
    const metaStatus = deriveMetadataStatus(jsonData);
    const jsonTitle = jsonData?.metadata?.name || jsonData?.metadata?.title || null;
    const jsonYear  = jsonData?.metadata?.year  || null;
    const seriesName = jsonTitle || folderTitle;
    const seriesYear = jsonYear  || folderYear;

    // Pull EVERY monitored series at this directory (parent + sibling specials),
    // not just one. The old `.get()` returned an arbitrary row when multiple
    // monitored series cohabited a folder (a parent series with one or more
    // specials), which then drove the per-file miRow lookup against whatever
    // series happened to come back first — wrongly linking, e.g., a regular
    // "Guardians of the Galaxy 001.cbz" to the special "Black Vortex Alpha" #1.
    // The parent (no parent_series_id) becomes the series-level link;
    // specials are kept aside for per-file prefix routing below.
    const monitoredAtDir = db.prepare(
      'SELECT id, name, parent_series_id, is_special FROM monitored_series WHERE directory = ?'
    ).all(seriesDir);
    // "Special" status comes from the explicit flag OR (legacy) parent_series_id.
    // Parent fallback excludes anything flagged as a special.
    const isSpecialRow = s => !!(s.is_special || s.parent_series_id);
    const parentSeries        = monitoredAtDir.find(s => !isSpecialRow(s)) || null;
    const specialSeriesAtDir  = monitoredAtDir.filter(isSpecialRow);
    // Pre-normalise sibling-special prefixes once per directory.
    const specialPrefixes = specialSeriesAtDir
      .map(s => ({ id: s.id, prefix: nameKey(s.name) }))
      .filter(s => s.prefix.length > 0);
    // Series-level link: prefer parent; fall back to first row when a dir has
    // only specials and no monitored parent (rare but legal).
    const monitoredId = parentSeries
      ? parentSeries.id
      : (monitoredAtDir[0]?.id || null);

    upsertSeries.run(seriesId, libraryId, seriesDir, seriesName, seriesYear, metaStatus,
      jsonData ? JSON.stringify(jsonData) : null, monitoredId, comicFiles.length, dirMtime, dirFileCount);

    jsonMemCache.delete(seriesId);
    db.prepare('DELETE FROM series_json_cache WHERE series_id = ?').run(seriesId);

    let skippedBooks = 0, changedBooks = 0, coversMade = 0, deferred = false;

    for (let i = 0; i < comicFiles.length; i++) {
      // Yield every 5 books so HTTP requests can be handled between ComicInfo extractions
      if (i > 0 && i % 5 === 0) await new Promise(r => setImmediate(r));

      const filename = comicFiles[i];
      const filePath = path.join(seriesDir, filename);
      const scanSnapshot = scannerState.capture(filePath);
      if (!scanSnapshot) { deferred = true; skippedBooks++; continue; }
      // Stable ID: the live row at this path; a file at an unknown path gets its
      // ID after ComicInfo is read (reclaimed record or new).
      const pathRow = stableIds.bookAtPath(filePath);
      let bookId = pathRow ? pathRow.id : null;

      const fileStat = fs.statSync(filePath);
      const fileMtime = Math.floor(fileStat.mtimeMs);
      const fileSize  = fileStat.size;
      const existingBook = pathRow;
      const bookUnchanged = existingBook && existingBook.file_mtime === fileMtime && existingBook.file_size === fileSize;

      // The book's own cover (the series cover is its cover book's; the old series_<id> file was unused).
      let bookCacheKey     = bookId;
      let bookThumbMissing = bookId ? !findThumbCache(bookCacheKey) : true;

      // Skip entirely if book unchanged AND its cover is cached
      if (bookUnchanged && !bookThumbMissing) { skippedBooks++; continue; }

      // If book unchanged but only its cover is missing — make the cover without re-extracting ComicInfo
      if (bookUnchanged && bookThumbMissing) {
        if (await warmScannedThumbnail(filePath, [bookCacheKey])) coversMade++; else deferred = true;
        skippedBooks++;
        continue;
      }

      let ciRaw = null, ci = {}, issueNum = null, title = null;
      if (!bookUnchanged) {
        // A file replaced at the same path keeps its book id: its old cover thumbnail must go too
        // (2026-10-17: a replaced Superman #39 kept showing the Ultimate Spider-Man cover).
        if (existingBook && bookId) { evictThumbCache(bookId); bookThumbMissing = true; }
        if (/\.(cbz|cbr|zip|rar)$/i.test(filename)) {
          ciRaw = await extractComicInfo(filePath);
          ci = parseComicInfo(ciRaw);
          issueNum = ci.number || extractNumberFromFilename(filename);
          title = ci.title || null;
        }
        const isSpecialDetected = /special|one-shot|oneshot/i.test(filename) || /(<format>special<\/format>|<format>one-shot<\/format>)/i.test(ciRaw || '');
        // Specials get sort_order 9000+ so they always sort after regular issues
        // This prevents a "Special 001" from appearing as the series thumbnail source
        const baseSortOrder = issueNum ? (parseFloat(issueNum) || i) : i;
        const sortOrder = isSpecialDetected ? 9000 + baseSortOrder : baseSortOrder;
        const fileIsAnnual = /annual/i.test(filename) || /<format>annual<\/format>/i.test(ciRaw || '');

        // ── Per-file monitored-series routing ─────────────────────────
        // When a directory has a parent series AND one or more sibling specials,
        // we have to pick the right monitored_series PER FILE — longest-prefix
        // sibling special wins, parent is the fallback. Without this, a regular
        // file ("Guardians of the Galaxy 001.cbz") would get matched against the
        // special's monitored_issues just because the special row happened to
        // come first from the directory query above.
        const fileNormForRouting = nameKey(filename);
        let chosenMonitoredId = parentSeries ? parentSeries.id : null;
        let longestSpecialMatch = 0;
        let matchedSpecialId = null;
        for (const sp of specialPrefixes) {
          if (fileNormForRouting.startsWith(sp.prefix) && sp.prefix.length > longestSpecialMatch) {
            chosenMonitoredId = sp.id;
            longestSpecialMatch = sp.prefix.length;
            matchedSpecialId = sp.id;
          }
        }

        let miRow = (!fileIsAnnual && !isSpecialDetected && issueNum && chosenMonitoredId)
          ? db.prepare('SELECT id FROM monitored_issues WHERE series_id = ? AND issue_number = ? AND (is_annual = 0 OR is_annual IS NULL)').get(chosenMonitoredId, issueNum)
          : null;
        // The file changed and opened cleanly with no ComicInfo.xml where it had
        // one before: the tags were removed on purpose (2026-10-16, mistagged
        // files cleaned by hand). Forget the stored identity and let the normal
        // identification find it again. '' = archive read, no ComicInfo; null =
        // unreadable, which still defers below.
        const tagsRemoved = !!(existingBook?.comicinfo && ciRaw === '' && !bookUnchanged);
        const identity = decideMetadataIdentity({bookId:bookId || 'scan-observation',arrival:'scanner',filename,comicInfoXml:ciRaw,indexedIssueId:tagsRemoved ? null : existingBook?.cv_issue_id});
        const cvIssueId = identity.status === 'accepted' ? identity.cvIssueId : null;
        miRow = null; // No processed/link decisions from folder + number alone.
        // Identity first: a file tagged with a monitored issue's CV id IS that issue —
        // annuals and specials included, whatever folder or number. A number match
        // that contradicts the tag is dropped (it is another comic).
        const cvMi = cvIssueId
          ? db.prepare('SELECT id, status, file_path FROM monitored_issues WHERE id = ?').get(String(cvIssueId))
          : null;
        if (miRow && cvIssueId && String(miRow.id) !== String(cvIssueId)) miRow = null;
        // ComicInfo extraction yields: the file, stable row, or journal may have
        // changed while it was running. Never commit that stale observation.
        if ((identity.status==='needs_review' && existingBook?.comicinfo && !tagsRemoved) || !scannerState.current(scanSnapshot) ||
            (existingBook?.comicinfo && !ciRaw && !tagsRemoved) ||
            (existingBook?.cv_issue_id && cvIssueId && String(existingBook.cv_issue_id) !== String(cvIssueId) && !tagsRemoved)) {
          deferred = true; skippedBooks++;
          logger.warn('scanner', 'Deferred changed or conflicting book evidence', { path: filePath });
          continue;
        }
        // Unknown path: reclaim the record this file used to be, or a new ID.
        if (!bookId) {
          if (!scannerState.mayRegister()) { deferred = true; skippedBooks++; continue; }
          bookId = stableIds.resolveBookId({ filePath, seriesId, cvIssueId, issueNum, fileSize });
          // A reclaimed record is a different file now (a replacement under a new name): its cached
          // cover may be the old file's, so it is made again from this one.
          if (db.prepare('SELECT 1 FROM scanned_books WHERE id = ?').get(bookId)) evictThumbCache(bookId);
          bookCacheKey = bookId; bookThumbMissing = !findThumbCache(bookId);
        }
        const newPhysicalBook = !stableIds.bookAtPath(filePath); // Reclaimed rows keep their filing flags too.
        upsertBook.run(bookId, seriesId, filePath, filename, issueNum, title, ciRaw, cvIssueId, cvMi ? cvMi.id : (miRow ? miRow.id : null), sortOrder, fileMtime, fileSize);
        if (tagsRemoved) {
          // The upsert keeps a stored Comic Vine ID; clear it so identification starts fresh.
          db.prepare("UPDATE scanned_books SET cv_issue_id = NULL WHERE id = ?").run(bookId);
          try { db.prepare("DELETE FROM library_health_dismissed WHERE kind = 'mistag-confirmed' AND key = ?").run(bookId); } catch {}
          logger.info('scanner', 'ComicInfo removed from file; stored Comic Vine match cleared', { path: filePath, was: existingBook.cv_issue_id || null });
        }
        if (cvMi) linkMonitoredByCv(cvMi, filePath);
        changedBooks++;
        if(typeof metadataMaintenance !== 'undefined') metadataMaintenance.enqueue(bookId, arrival, {initial:newPhysicalBook});
        if (newPhysicalBook && isSpecialDetected) db.prepare('UPDATE scanned_books SET is_special = 1 WHERE id = ? AND is_special = 0').run(bookId);
        // Mark scanned_books.is_special when the file belongs to a sibling-special.
        // Uses the pre-computed prefix list and the routing match above — no extra SQL,
        // and stays consistent with whichever series miRow was linked to.
        if (newPhysicalBook && !isSpecialDetected && matchedSpecialId) {
          db.prepare('UPDATE scanned_books SET is_special = 1 WHERE id = ? AND is_special = 0').run(bookId);
        }
        if (miRow && !cvMi) {
          // Only mark processed if the file is actually inside the resolved series
          // directory. `chosenMonitoredId` is the per-file routed series id
          // (parent or the longest-prefix matching sibling special).
          const monSeries = db.prepare('SELECT directory FROM monitored_series WHERE id = ?').get(chosenMonitoredId);
          const inSeriesDir = monSeries && filePath.startsWith(monSeries.directory + path.sep);
          if (inSeriesDir) {
            db.prepare(`UPDATE monitored_issues SET file_path = ?, status = 'processed' WHERE id = ? AND (file_path IS NULL OR file_path != ?)`)
              .run(filePath, miRow.id, filePath);
          } else {
            logger.warn('scanner', `Skipped cross-directory match`, { file: filePath, monitoredId, expected: monSeries?.directory });
          }
        }
      }

      if (bookThumbMissing) {
        if (await warmScannedThumbnail(filePath, [bookCacheKey])) coversMade++; else deferred = true;
      }
    }

    // Remove books that no longer exist on disk.
    // Safety guard: if the directory scan returned zero comic files but the DB
    // has books for this series, the mount point may have been temporarily
    // unavailable (common with Windows/Docker volume mounts). Skip the removal
    // pass entirely to avoid mass-resetting all issues to wanted on a bad read.
    const currentPaths = new Set(comicFiles.map(f => path.join(seriesDir, f)));
    const existingBooks = db.prepare('SELECT id, path, monitored_issue_id, cv_issue_id FROM scanned_books WHERE series_id = ?').all(seriesId);
    const mountLooksSuspect = comicFiles.length === 0 && existingBooks.length > 2;
    if (mountLooksSuspect) {
      logger.warn('scanner', `Skipping book removal for "${path.basename(seriesDir)}" — 0 files on disk but ${existingBooks.length} in DB (mount may be temporarily unavailable)`);
    } else {
      for (const book of existingBooks) {
        if (!currentPaths.has(book.path) && scannerState.mayRemoveBook(book, seriesDir)) {
          // Keep the record (and every link to it) so a later scan can reclaim it.
          stableIds.tombstoneBook(book.id);
          changedBooks++;
          logger.info('scanner', `kept missing book`, { path: book.path });
          monitoredIssueGone(book, 'missing from disk');
        }
      }
    }

    const regularCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM scanned_books WHERE series_id = ? AND is_special = 0 AND LOWER(filename) NOT LIKE '%annual%'`
    ).get(seriesId);
    db.prepare('UPDATE scanned_series SET book_count = ? WHERE id = ?').run(regularCount.cnt, seriesId);

    if (scannerState.reserved(seriesDir, null, true)) deferred = true;
    if (deferred) db.prepare('UPDATE scanned_series SET dir_mtime=-1 WHERE id=?').run(seriesId);
    return { skipped: false, skippedBooks, changedBooks, coversMade, deferred };
  }

  async function runLibraryScan(library) {
    scanState = { running: true, libraryId: library.id, progress: 0, total: 0, currentPath: '', startedAt: new Date().toISOString(), completedAt: null, errors: [] };
    logger.info('scanner', `starting scan`, { library: library.name, path: library.path });

    try {
      // Collect all series-level directories (subdirs that contain comic files)
      const seriesDirs = [];
      async function walkForSeries(dir, depth) {
        if (depth > 5) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        const files = entries.filter(e => e.isFile() && COMIC_EXTS.test(e.name));
        if (files.length > 0) { seriesDirs.push(dir); return; }
        const subdirs = entries.filter(e => e.isDirectory());
        for (let i = 0; i < subdirs.length; i++) {
          if (i > 0 && i % 10 === 0) await new Promise(r => setImmediate(r));
          await walkForSeries(path.join(dir, subdirs[i].name), depth + 1);
        }
      }
      await walkForSeries(library.path, 0);
      scanState.total = seriesDirs.length;
      logger.info('scanner', `found series dirs`, { count: seriesDirs.length });

      const { upsertSeries, upsertBook } = makeScanStmts();
      let skippedSeries = 0, skippedBooks = 0, changedBooks = 0, coversMade = 0;

      for (let si = 0; si < seriesDirs.length; si++) {
        const seriesDir = seriesDirs[si];
        scanState.currentPath = seriesDir;
        if (si > 0 && si % 5 === 0) await new Promise(r => setImmediate(r));
        try {
          const result = await scanSeriesDir(seriesDir, library.id, upsertSeries, upsertBook);
          skippedSeries += result.skipped ? 1 : 0;
          skippedBooks  += result.skippedBooks;
          changedBooks  += result.changedBooks;
          coversMade    += result.coversMade || 0;
        } catch (e) {
          logger.error('scanner', `series error`, { path: seriesDir, error: e.message });
          scanState.errors.push({ path: seriesDir, error: e.message });
        }
        scanState.progress++;
      }

      // Remove scanned_series/books for series that no longer exist on disk or have no comic files.
      // Catches: (a) deleted directories, (b) emptied directories (files removed but folder left).
      const COMIC_EXT_RE = /\.(cbz|cbr|zip|rar)$/i;
      const allScanned = db.prepare('SELECT id, path FROM scanned_series WHERE library_id = ?').all(library.id);
      for (const row of allScanned) {
        let shouldRemove = false;
        if (!fs.existsSync(row.path)) {
          shouldRemove = true;
        } else {
          // Directory exists — check if it still has any comic files
          try {
            const entries = fs.readdirSync(row.path, { withFileTypes: true });
            const hasComics = entries.some(e => e.isFile() && COMIC_EXT_RE.test(e.name));
            if (!hasComics) shouldRemove = true;
          } catch {
            shouldRemove = false; // Unreadable is not evidence that a directory was removed.
          }
        }
        if (shouldRemove && scannerState.mayRemoveSeries(row, library.path)) {
          stableIds.tombstoneSeries(row.id);
          changedBooks++;
          logger.info('scanner', `kept missing series`, { path: row.path });
        }
      }

      backfillMonitoredLinksByCv('scan');
      scheduleReconcile(changedBooks > 0);
      invalidateSeriesCache();
      setImmediate(warmCreatorsCache);
      setImmediate(warmLatestReleaseDateCache);
      scanState.running = false;
      scanState.completedAt = new Date().toISOString();
      logger.info('scanner', `scan complete`, { series: seriesDirs.length, skippedSeries, skippedBooks, changedBooks, coversMade, errors: scanState.errors.length });
      // Record completion time for scheduled rescan logic
      db.prepare("UPDATE libraries SET last_scanned_at = datetime('now') WHERE id = ?").run(library.id);
      // Kick off background CBR rating fetch for any uncached series
      setTimeout(runCbrQueue, 5000);
    } catch (e) {
      scanState.running = false;
      scanState.completedAt = new Date().toISOString();
      logger.error('scanner', `scan failed`, { error: e.message });
    }
  }

  // ─── LIBRARIES ────────────────────────────────────────────────────
  app.get('/api/libraries', (req, res) => {
    try {
      const libs = db.prepare('SELECT * FROM libraries ORDER BY name').all();
      const result = libs.map(l => {
        const seriesCount = db.prepare('SELECT COUNT(*) as n FROM scanned_series WHERE library_id = ?').get(l.id).n;
        return { ...l, seriesCount };
      });
      res.json(Array.isArray(result) ? result : []);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/libraries', requireAdmin, (req, res) => {
    try {
      const { name, path: libPath, icon, color } = req.body;
      if (!name || !libPath) return res.status(400).json({ error: 'name and path required' });
      const resolvedPath = path.resolve(libPath);
      if (!fs.existsSync(resolvedPath)) return res.status(400).json({ error: `Path does not exist: ${resolvedPath}` });
      const id = 'lib_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      db.prepare('INSERT INTO libraries (id, name, path, icon, color) VALUES (?, ?, ?, ?, ?)').run(id, name.trim(), resolvedPath, icon || null, color || null);
      res.json({ id, success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/libraries/:id', requireAdmin, (req, res) => {
    try {
      const { name, icon, color } = req.body;
      db.prepare('UPDATE libraries SET name=?, icon=?, color=? WHERE id=?').run(name, icon || null, color || null, req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH — update scan schedule interval (0=manual, 3/6/12/24/48/168 hours)
  app.patch('/api/libraries/:id', requireAdmin, (req, res) => {
    try {
      const { scan_interval_hours } = req.body;
      if (scan_interval_hours !== undefined) {
        db.prepare('UPDATE libraries SET scan_interval_hours=? WHERE id=?')
          .run(Number(scan_interval_hours), req.params.id);
      }
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/libraries/:id', requireAdmin, (req, res) => {
    try {
      // Cascade: remove scanned_books then scanned_series for this library
      const series = db.prepare('SELECT id FROM scanned_series WHERE library_id = ?').all(req.params.id);
      for (const s of series) db.prepare('DELETE FROM scanned_books WHERE series_id = ?').run(s.id);
      db.prepare('DELETE FROM scanned_series WHERE library_id = ?').run(req.params.id);
      db.prepare('DELETE FROM libraries WHERE id = ?').run(req.params.id);
      invalidateSeriesCache();
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/libraries/:id/scan', requireAdmin, async (req, res) => {
    if (scanState.running) return res.status(409).json({ error: 'Scan already in progress' });
    const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
    if (!lib) return res.status(404).json({ error: 'Library not found' });
    setImmediate(() => runLibraryScan(lib).catch(e => logger.warn('scan', 'Scan deferred', e.message)));
    res.json({ success: true, message: `Scan started for "${lib.name}"` });
  });

  app.post('/api/libraries/scan-all', requireAdmin, async (req, res) => {
    if (scanState.running) return res.status(409).json({ error: 'Scan already in progress' });
    const libs = db.prepare('SELECT * FROM libraries ORDER BY name').all();
    if (!libs.length) return res.status(400).json({ error: 'No libraries configured' });
    // Scan all libraries sequentially in background
    setImmediate(async () => {
      for (const lib of libs) await runLibraryScan(lib).catch(e => logger.warn('scan', 'Scan deferred', e.message));
    });
    res.json({ success: true, message: `Scanning ${libs.length} libraries` });
  });

  app.get('/api/scan/status', (req, res) => {
    res.json(scanState);
  });

  // Library-read wrapping (server.js, once everything has loaded): the routes and runLibraryScan call these names.
  function wrapReads(wrap) {
    runLibraryScan = wrap('read', runLibraryScan);
    scanSeriesDir = wrap('read', scanSeriesDir);
  }
  return { makeScanStmts, warmScannedThumbnail, wrapReads,
    get scanSeriesDir() { return scanSeriesDir; }, get runLibraryScan() { return runLibraryScan; }, get scanState() { return scanState; } };
};
