'use strict';
// ─── Series caches (moved out of server.js 2026-11-19, server.js split) ─────
// The in-memory caches behind the Series list, Home and search: the series rows per library
// (fetchAllSeries), Home's character lists, each series' creators from ComicInfo, and each
// series' latest release date. server.js keeps the same names as aliases, so its callers
// (invalidateSeriesCache after scans and edits, the warmers at startup) are unchanged.
// Moved unchanged except for the release date (see warmLatestReleaseDateCache).
const { RELEASE_DATE_SQL } = require('./pullBox');

module.exports.createSeriesCaches = function createSeriesCaches(deps) {
  const missing = ['db', 'parseComicInfo'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createSeriesCaches: missing ${missing.join(', ')}`);
  const { db, parseComicInfo } = deps;

  // ─── In-memory caches ─────────────────────────────────────────────
  // Stores fetchAllSeries results so tab switches don't re-hit Komga
  const seriesCache  = new Map(); // key: libraryId|'' → { data, ts }
  const charMapCache = new Map(); // key: libraryId|'' → { data, ts }
  const creatorsCache = new Map(); // key: seriesId → { writers: string[], artists: string[] }
  const latestReleaseDateCache = new Map(); // key: seriesId → ISO date string | null
  const SERIES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  function getSeriesCacheKey(libraryId) { return libraryId || '__all__'; }

  function invalidateSeriesCache() { seriesCache.clear(); charMapCache.clear(); creatorsCache.clear(); latestReleaseDateCache.clear(); }

  // In-memory creators cache — built from scanned_books comicinfo in one pass at startup
  // Maps seriesId → { writers: string[], artists: string[] }
  // "artists" = pencillers + inkers + colorists + cover artists
  function warmCreatorsCache() {
    try {
      const rows = db.prepare(
        'SELECT series_id, comicinfo FROM scanned_books WHERE comicinfo IS NOT NULL'
      ).all();
      const tmp = {}; // seriesId → { writers: Set, artists: Set }
      for (const row of rows) {
        const ci = parseComicInfo(row.comicinfo);
        if (!tmp[row.series_id]) tmp[row.series_id] = { writers: new Set(), artists: new Set() };
        const e = tmp[row.series_id];
        const norm = n => n.trim().replace(/\s*\[\d+\]\s*$/, '');
        if (ci.writer)      ci.writer.split(',').map(norm).filter(Boolean).forEach(n => e.writers.add(n));
        if (ci.penciller)   ci.penciller.split(',').map(norm).filter(Boolean).forEach(n => e.artists.add(n));
        if (ci.inker)       ci.inker.split(',').map(norm).filter(Boolean).forEach(n => e.artists.add(n));
        if (ci.colorist)    ci.colorist.split(',').map(norm).filter(Boolean).forEach(n => e.artists.add(n));
        if (ci.coverArtist) ci.coverArtist.split(',').map(norm).filter(Boolean).forEach(n => e.artists.add(n));
      }
      for (const [sid, sets] of Object.entries(tmp)) {
        creatorsCache.set(sid, { writers: [...sets.writers], artists: [...sets.artists] });
      }
      console.log(`[cache] Warmed creators for ${creatorsCache.size} series`);
    } catch (e) {
      console.warn('[cache] Failed to warm creators cache:', e.message);
    }
  }

  // In-memory latest release date cache — most recent issue date per scanned_series.id.
  // Two-pass strategy so both monitored and unmonitored (concluded) series sort correctly:
  //   Pass 1 — monitored: join scanned_series → monitored_series → monitored_issues for
  //             structured store_date/release_date. Keyed by scanned_series.id. Uses the shared
  //             release-date rule (pullBox.RELEASE_DATE_SQL, 2026-11-19): a downloaded issue Comic
  //             Vine has not dated yet goes by the day it was listed, as on Home and My Pulls.
  //   Pass 2 — unmonitored: parse Year/Month/Day from ComicInfo XML in scanned_books.
  //             Fills gaps for any series without a monitored_series_id.
  function warmLatestReleaseDateCache() {
    try {
      latestReleaseDateCache.clear();

      // Pass 1: monitored series — pull dates from monitored_issues via the FK bridge.
      const monitoredRows = db.prepare(`
        SELECT ss.id AS series_id, MAX(${RELEASE_DATE_SQL}) AS latest_date
        FROM scanned_series ss
        JOIN monitored_issues mi ON mi.series_id = ss.monitored_series_id
        WHERE ss.monitored_series_id IS NOT NULL
          AND ${RELEASE_DATE_SQL} IS NOT NULL
        GROUP BY ss.id
      `).all();
      for (const row of monitoredRows) {
        if (row.latest_date) latestReleaseDateCache.set(row.series_id, row.latest_date);
      }

      // Pass 2: unmonitored series — extract dates from ComicInfo XML stored in scanned_books.
      // Only runs for series not already covered by Pass 1.
      const unmonitoredBooks = db.prepare(`
        SELECT sb.series_id, sb.comicinfo
        FROM scanned_books sb
        JOIN scanned_series ss ON ss.id = sb.series_id
        WHERE ss.monitored_series_id IS NULL
          AND sb.comicinfo IS NOT NULL
      `).all();

      const ciDates = new Map(); // series_id → max ISO date string found in comicinfo
      for (const book of unmonitoredBooks) {
        const ci = book.comicinfo;
        if (!ci) continue;
        const yearM  = ci.match(/<Year>(\d{4})<\/Year>/);
        if (!yearM) continue;
        const monthM = ci.match(/<Month>(\d{1,2})<\/Month>/);
        const dayM   = ci.match(/<Day>(\d{1,2})<\/Day>/);
        const dateStr = `${yearM[1]}-${(monthM ? monthM[1] : '1').padStart(2,'0')}-${(dayM ? dayM[1] : '1').padStart(2,'0')}`;
        const existing = ciDates.get(book.series_id);
        if (!existing || dateStr > existing) ciDates.set(book.series_id, dateStr);
      }
      for (const [sid, date] of ciDates) latestReleaseDateCache.set(sid, date);

      console.log(`[cache] Warmed latest release dates for ${latestReleaseDateCache.size} series`);
    } catch (e) {
      console.warn('[cache] Failed to warm latest release date cache:', e.message);
    }
  }

  return { seriesCache, charMapCache, creatorsCache, latestReleaseDateCache, SERIES_CACHE_TTL, getSeriesCacheKey,
    invalidateSeriesCache, warmCreatorsCache, warmLatestReleaseDateCache };
};
