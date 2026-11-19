'use strict';
// ─── Covers and reader pages (moved out of server.js 2026-11-19, server.js split step 4) ───
// The thumbnail disk cache (thumbcache/: covers resized by coverThumb.js; reader page thumbs under
// thumbcache/pages/), the limit on archive extractions at once (withThumbSlot), streamArchivePage
// (a cover or a reader page from an archive), the series cover pick (pickSeriesCoverBook), and the
// routes: series and book thumbnails, thumbnail cache eviction, the reader's page count, pages and
// page thumbnails. Moved unchanged. Archive listing and member reads are archiveFiles.js.
// server.js wraps streamArchivePage and withThumbSlot for library reads once the file has loaded
// (wrapReads); the routes here use the wrapped ones, as before.
const fs = require('fs');
const path = require('path');
const { AsyncResource } = require('node:async_hooks');

// The library scope a reader route reads under (coordinateLibraryRoutes in server.js): a series
// thumbnail its series, a book route the book's series. Moved unchanged from server.js; getDb
// returns the database, which server.js opens after this is set up.
module.exports.readScope = getDb => (route,req) => {
  // Resolve before admission, then the coordinator rechecks after any wait.
  // Retagging preserves series membership and edits only within that folder.
  if(route==='/api/series/:id/thumbnail')return 'series:'+req.params.id;
  if(route.startsWith('/api/books/:id/')){
    const book=getDb().prepare('SELECT series_id FROM scanned_books WHERE id=?').get(req.params.id);
    return book?.series_id ? 'series:'+book.series_id : null;
  }
  return null; // Disk covers and unknown archive consumers stay conservative.
};

module.exports.createCovers = function createCovers(deps) {
  const missing = ['app', 'coverThumb', 'db', 'dbDir', 'filterImages', 'listArchiveFiles', 'logger', 'readArchiveMember', 'requireAdmin'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createCovers: missing ${missing.join(', ')}`);
  const { app, coverThumb, db, dbDir, filterImages, listArchiveFiles, logger, readArchiveMember, requireAdmin } = deps;

  // ─── Thumbnail disk cache ─────────────────────────────────────────
  // Caches first-page extractions so bsdtar only runs once per book.
  // Files stored as /appdata/thumbcache/{cacheKey}.{ext}
  const THUMB_CACHE_DIR = path.join(dbDir, 'thumbcache');
  fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });

  // Incremented whenever all thumbnails are cleared — invalidates browser ETags
  let thumbCacheGen = Date.now();

  // ─── Thumbnail extraction concurrency limiter ─────────────────────
  // Caps simultaneous archive extractions so a page with 30+ thumbnails
  // doesn't spawn 30 unrar/7z processes at once and stall the server.
  const THUMB_CONCURRENCY = deps.thumbConcurrency || 4;   // tests use 1
  let _thumbActive = 0;
  const _thumbQueue = [];
  function withThumbSlot(fn) {
    return new Promise((resolve, reject) => {
      const run = AsyncResource.bind(() => {
        _thumbActive++;
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          _thumbActive--;
          if (_thumbQueue.length) _thumbQueue.shift()();
        });
      });
      if (_thumbActive < THUMB_CONCURRENCY) run();
      else _thumbQueue.push(run);
    });
  }

  function findThumbCache(cacheKey) {
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.gif']) {
      const p = path.join(THUMB_CACHE_DIR, `${cacheKey}${ext}`);
      if (fs.existsSync(p)) {
        try { if (fs.statSync(p).size === 0) { fs.unlinkSync(p); continue; } } catch {}
        return { filePath: p, ext };
      }
    }
    return null;
  }

  function evictThumbCache(cacheKey) {
    // A key is a plain file name (a book id or series_<id>); anything else could reach outside the cache.
    if (!/^[A-Za-z0-9_.-]+$/.test(String(cacheKey || '')) || /^\.+$/.test(String(cacheKey))) return;
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.gif']) {
      const p = path.join(THUMB_CACHE_DIR, `${cacheKey}${ext}`);
      try { fs.unlinkSync(p); } catch {}
    }
  }

  // ─── Series thumbnail: extract first page of first book ───────────
  app.get('/api/series/:id/thumbnail', async (req, res) => {
    try {
      const book = pickSeriesCoverBook(req.params.id);
      if (!book) return res.status(404).send();
      // Serve the chosen book's own thumbnail, so the series cover follows the
      // pick (and its ETag changes) instead of a separately cached series image.
      await streamArchivePage(book.path, 0, res, book.id);
    } catch (e) { res.status(404).send(); }
  });

  // Cover = the series' actual issue #1. Reading order (sort_order) is not used
  // first because folders often lead with a #0, a prequel mini or an event
  // tie-in (e.g. "Green Lantern Corps - Futures End 001"). Ranking:
  //   1. books whose ComicInfo <Series> is a different title are pushed back
  //   2. issue number exactly 1, then the lowest number above 1, then the rest
  //   3. a ComicInfo match, no " - Subtitle" in the filename, reading order
  // Annuals and specials are skipped unless nothing else exists. Previews, ashcans and samplers
  // (X-Men Ashcan #1 filed as X-Men #1) go last (2026-11-13).
  const PROMO_BOOK = /\b(preview|previews|ashcan|sampler)\b/i;
  function pickSeriesCoverBook(seriesId) {
    const books = db.prepare('SELECT id, path, filename, issue_number, sort_order, is_special, comicinfo FROM scanned_books WHERE series_id = ?').all(seriesId);
    if (!books.length) return null;
    const ss = db.prepare('SELECT name FROM scanned_series WHERE id = ?').get(seriesId);
    const norm = t => String(t || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
    const want = norm(ss?.name);
    const wantShort = norm(String(ss?.name || '').split(':')[0]); // "Luke Cage: Marvel Digital Original" -> "Luke Cage"
    const regular = books.filter(b => !b.is_special && !/annual/i.test(b.filename));
    const pool = regular.length ? regular : books;
    const ranked = pool.map(b => {
      const ciSeries = ((b.comicinfo || '').match(/<Series>([^<]*)<\/Series>/i) || [])[1];
      // Title from the filename: drop "1. " prefixes, (tags), [tags], the issue
      // number and anything after it, and a "v2"/"Vol. 2" volume marker.
      const bare = String(b.filename).replace(/\.[^.]+$/, '').replace(/^\d+\.\s*/, '')
        .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').trim();
      const fm = bare.match(/^(.*?)\s*#?(\d+(?:\.\d+)?)(?:\s+-\s+.*)?\s*$/);
      const fileTitle = (fm ? fm[1] : bare).replace(/\b(v\d*|vol\.?|volume)\s*$/i, '');
      const ciOk = ciSeries && norm(ciSeries) === want;
      const fileOk = !!norm(fileTitle) && (norm(fileTitle) === want || norm(fileTitle) === wantShort);
      const match = (ciOk || fileOk) ? 0 : (!ciSeries ? 1 : 2);
      let n = parseFloat(String(b.issue_number ?? '').replace(/^#/, ''));
      if (!Number.isFinite(n) && fm && b.issue_number) n = parseFloat(fm[2]); // e.g. issue_number "HC"
      const tier = n === 1 ? 0 : (Number.isFinite(n) && n > 1 ? 1 : 2);
      const dash = /\s-\s/.test(b.filename) ? 1 : 0;
      const promo = PROMO_BOOK.test(b.filename) || PROMO_BOOK.test(((b.comicinfo || '').match(/<Title>([^<]*)<\/Title>/i) || [])[1] || '') ? 1 : 0;
      return { b, key: [promo, match === 2 ? 1 : 0, tier, Number.isFinite(n) ? n : 1e9, match, dash, b.sort_order ?? 1e9] };
    });
    ranked.sort((x, y) => {
      for (let i = 0; i < x.key.length; i++) if (x.key[i] !== y.key[i]) return x.key[i] - y.key[i];
      return String(x.b.filename).localeCompare(String(y.b.filename));
    });
    return ranked[0].b;
  }

  app.get('/api/books/:id/thumbnail', async (req, res) => {
    try {
      const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(req.params.id);
      if (!book) return res.status(404).send();
      await streamArchivePage(book.path, 0, res, book.id);
    } catch (e) { res.status(404).send(); }
  });

  // ─── Thumbnail cache eviction ─────────────────────────────────────
  // DELETE /api/books/:id/thumbnail/cache — bust a single book's cached thumb
  // DELETE /api/series/:id/thumbnail/cache — bust a series thumb cache
  // Called automatically by the library scanner when a book's path changes.
  app.delete('/api/books/:id/thumbnail/cache', requireAdmin, (req, res) => {
    evictThumbCache(req.params.id);
    res.json({ ok: true });
  });
  app.delete('/api/series/:id/thumbnail/cache', requireAdmin, (req, res) => {
    evictThumbCache(`series_${req.params.id}`);
    res.json({ ok: true });
  });

  // DELETE /api/thumbnails/all — clear entire thumb cache
  app.delete('/api/thumbnails/all', requireAdmin, (req, res) => {
    try {
      const files = fs.readdirSync(THUMB_CACHE_DIR);
      let count = 0;
      for (const f of files) {
        try { fs.unlinkSync(path.join(THUMB_CACHE_DIR, f)); count++; } catch {}
      }
      try { fs.rmSync(path.join(THUMB_CACHE_DIR, 'pages'), { recursive: true, force: true }); } catch {}   // reader page thumbs
      thumbCacheGen = Date.now(); // invalidate all browser ETags
      logger.info('thumbcache', `Cleared all thumbnails`, { count });
      res.json({ ok: true, cleared: count });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/books/:id/pages
  // Returns { count } — number of image pages in the archive.
  // Used by the reader on load to know total pages without fetching images.
  app.get('/api/books/:id/pages', async (req, res) => {
    try {
      const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(req.params.id);
      if (!book) return res.status(404).json({ error: 'Book not found' });
      const files = await listArchiveFiles(book.path);
      const images = filterImages(files);
      res.json({ count: images.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Reader: stream a specific page (0-indexed) ───────────────────
  // GET /api/books/:id/pages/:page
  // Streams the image for page N (0-indexed) from the archive.
  // Full pages require a reader session and must not enter shared/browser caches.
  // The reader preloads page N+1 by creating an <img> with this URL.
  app.get('/api/books/:id/pages/:page', async (req, res) => {
    try {
      const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(req.params.id);
      if (!book) return res.status(404).send();
      const pageIndex = Math.max(0, parseInt(req.params.page, 10) || 0);
      await streamArchivePage(book.path, pageIndex, res);
    } catch (e) {
      logger.error('reader', `Page ${req.params.page} failed for book ${req.params.id}`, e.message);
      res.status(404).send();
    }
  });

  // ─── Reader: small page thumbnail for the page overview ──────────
  // GET /api/books/:id/page-thumbs/:page — 240px-wide JPEG, cached on disk under
  // thumbcache/pages/<bookId>_<mtime>/ (a changed file gets fresh thumbs).
  const _pageListCache = new Map();   // path|mtime -> sorted image names (overview asks for every page)
  async function pageImagesCached(book) {
    const key = `${book.path}|${book.file_mtime || 0}`;
    const hit = _pageListCache.get(key);
    if (hit) return hit;
    const images = filterImages(await listArchiveFiles(book.path));
    _pageListCache.set(key, images);
    if (_pageListCache.size > 50) _pageListCache.delete(_pageListCache.keys().next().value);
    return images;
  }
  app.get('/api/books/:id/page-thumbs/:page', async (req, res) => {
    try {
      const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(req.params.id);
      if (!book) return res.status(404).send();
      const n = Math.max(0, parseInt(req.params.page, 10) || 0);
      const dir = path.join(THUMB_CACHE_DIR, 'pages', `${book.id}_${book.file_mtime || 0}`);
      const file = path.join(dir, `${n}.jpg`);
      res.set('Cache-Control', 'private, no-store');
      if (fs.existsSync(file)) return res.type('image/jpeg').sendFile(file);
      await withThumbSlot(async () => {
        const images = await pageImagesCached(book);
        if (!images.length || n >= images.length) return res.status(404).send();
        const target = images[n];
        let stdout;
        try { stdout = await readArchiveMember(book.path, target); }
        catch (e) { return res.status(404).send(); }
        const out = await require('sharp')(stdout).resize({ width: 240, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
        try { await fs.promises.mkdir(dir, { recursive: true }); await fs.promises.writeFile(file, out); } catch {}
        res.type('image/jpeg').send(out);
      });
    } catch (e) {
      logger.error('reader', `Page thumb ${req.params.page} failed for book ${req.params.id}`, e.message);
      if (!res.headersSent) res.status(404).send();
    }
  });

  // Helper: stream a specific page (0-indexed) from a comic archive
  // Pass cacheKey (e.g. book ID) to enable disk caching for thumbnails.
  async function streamArchivePage(filePath, pageIndex, res, cacheKey = null) {
    // ── Serve from disk cache if available ──────────────────────────
    if (cacheKey) {
      const hit = findThumbCache(cacheKey);
      if (hit) {
        const mime = hit.ext === '.png' ? 'image/png' : hit.ext === '.gif' ? 'image/gif' : hit.ext === '.webp' ? 'image/webp' : 'image/jpeg';
        // The cached file's time is part of the ETag: a thumbnail made again from a replaced file
        // (same book id) is fetched anew instead of the browser's old copy (2026-10-17).
        let fileTime = 0; try { fileTime = Math.floor(fs.statSync(hit.filePath).mtimeMs); } catch {}
        const etag = `"${cacheKey}-${thumbCacheGen}-${fileTime}"`;
        if (res.req && res.req.headers['if-none-match'] === etag) {
          return res.status(304).end();
        }
        res.set('Content-Type', mime);
        res.set('Cache-Control', cacheKey ? 'public, max-age=0, must-revalidate' : 'private, no-store');
        res.set('ETag', etag);
        return res.sendFile(hit.filePath);
      }
    }
    // ── Extract from archive (rate-limited) ─────────────────────────
    await withThumbSlot(async () => {
      try {
        const files = await listArchiveFiles(filePath);
        const images = filterImages(files);
        if (!images.length) return res.status(404).send();
        const target = images[Math.min(pageIndex, images.length - 1)];
        const archExt = path.extname(filePath).toLowerCase();
        let stdout;
        try {
          stdout = await readArchiveMember(filePath, target);
        } catch (extractErr) {
          logger.error('thumb', `extraction failed`, { filePath, target, error: extractErr.message, stderr: extractErr.stderr?.slice(0,200) });
          return res.status(404).send();
        }
        let ext = path.extname(target).toLowerCase() || '.jpg';
        let mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        let fileTime = 0;
        if (cacheKey) {
          // A cover for a shelf: cached and sent resized (coverThumb.js). Reader pages (no cacheKey) stay full size.
          const t = await coverThumb(stdout, ext);
          stdout = t.buf; ext = t.ext; mime = t.mime;
          const cachePath = path.join(THUMB_CACHE_DIR, `${cacheKey}${ext}`);
          await fs.promises.writeFile(cachePath, stdout);
          try { fileTime = Math.floor(fs.statSync(cachePath).mtimeMs); } catch {}
        }
        const etag = cacheKey ? `"${cacheKey}-${thumbCacheGen}-${fileTime}"` : null;
        if (etag && res.req && res.req.headers['if-none-match'] === etag) {
          return res.status(304).end();
        }
        res.set('Content-Type', mime);
        res.set('Cache-Control', cacheKey ? 'public, max-age=0, must-revalidate' : 'private, no-store');
        if (etag) res.set('ETag', etag);
        res.send(stdout);
      } catch (e) {
        logger.error('thumb', `streamArchivePage failed`, { filePath, error: e.message });
        if (!res.headersSent) res.status(404).send();
      }
    });
  }

  // A series rescan that cleared its thumbnails (server.js) changes the ETags too.
  function bumpThumbCacheGen() { thumbCacheGen = Date.now(); }
  // Library-read wrapping (server.js, once everything has loaded): the routes above call these names.
  function wrapReads(wrap) {
    streamArchivePage = wrap('read', streamArchivePage);
    withThumbSlot = wrap('read', withThumbSlot);
  }
  return { THUMB_CACHE_DIR, findThumbCache, evictThumbCache, pickSeriesCoverBook, bumpThumbCacheGen, wrapReads,
    get streamArchivePage() { return streamArchivePage; }, get withThumbSlot() { return withThumbSlot; } };
};
