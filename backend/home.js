'use strict';
// ─── Home (moved out of server.js 2026-11-19, server.js split) ───────────────
// The Home page's data: GET /api/home/v2 (Continue Reading, Recently Released, Characters,
// library stats), the Continue Reading dismissals, GET /api/home/discover (Discover and the
// Characters pool) and the older GET /api/home (no longer called by the app; kept for now).
// Moved unchanged, except that readingContexts (created near the end of server.js) is read when
// a request comes in.
// An issue's release date for Home's Recently Released and My Pulls (pullBox.js): Comic Vine's store
// date, else its cover date, else (2026-11-18) the day it was listed, for a downloaded issue Comic Vine
// has not dated yet. New issues often appear on Comic Vine on release day with no dates at all.
const { RELEASE_DATE_SQL } = require('./pullBox');

module.exports.registerHome = function registerHome(deps) {
  const missing = ['app', 'charMapCache', 'db', 'fetchAllSeries', 'getReadingContexts', 'getSeriesJsonCached', 'getSeriesRating', 'mergeSeriesWithJson', 'parseComicInfo', 'requireAuth'].filter(k => deps[k] === undefined);
  // The series' reading order (seriesPlacement.js, 2026-11-21); optional: without it, issue order.
  const getSeriesPlacement = deps.getSeriesPlacement || (() => null);
  if (missing.length) throw new Error(`registerHome: missing ${missing.join(', ')}`);
  const { app, charMapCache, db, fetchAllSeries, getReadingContexts, getSeriesJsonCached, getSeriesRating, mergeSeriesWithJson, parseComicInfo, requireAuth } = deps;

  // ─── HOME SHELF DATA ──────────────────────────────────────────────
  app.get('/api/home', (req, res) => {
    try {
      const { libraryId } = req.query;
      const libFilter = libraryId ? ' AND ss.library_id = ?' : '';
      const libParams = libraryId ? [libraryId] : [];

      // Recently added books (scanned_books ordered by last_scanned)
      const recentBooks = db.prepare(`
        SELECT sb.*, ss.name as seriesName, ss.id as seriesId FROM scanned_books sb
        JOIN scanned_series ss ON ss.id = sb.series_id
        WHERE 1=1 ${libFilter} ORDER BY sb.last_scanned DESC LIMIT 20
      `).all(...libParams);

      // Recently added series
      const recentSeries = db.prepare(`
        SELECT * FROM scanned_series WHERE 1=1 ${libraryId ? 'AND library_id = ?' : ''}
        ORDER BY last_scanned DESC LIMIT 20
      `).all(...libParams).map(mergeSeriesWithJson);

      // Random discover series
      const allSeries = fetchAllSeries(libraryId);
      const discoverSeries = [...allSeries].sort(() => Math.random() - 0.5).slice(0, 8).map(mergeSeriesWithJson);

      // Characters shelf — top characters with up to 8 series each
      const charMap = {};
      allSeries.forEach(s => {
        const json = getSeriesJsonCached(s.id, s.path);
        (json?.metadata?.characters || []).forEach(char => {
          if (!charMap[char]) charMap[char] = [];
          if (charMap[char].length < 8) charMap[char].push(mergeSeriesWithJson(s));
        });
      });
      const topCharacters = Object.entries(charMap)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8)
        .map(([name, series]) => ({ name, series }));

      res.json({ recentBooks, recentSeries, discoverSeries, topCharacters });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Updated home endpoint ────────────────────────────────────────
  // An issue's release date for Home's Recently Released and My Pulls (pullBox.js): Comic Vine's store
  // date, else its cover date, else (2026-11-18) the day it was listed, for a downloaded issue Comic Vine
  // has not dated yet. New issues often appear on Comic Vine on release day with no dates at all.
  app.get('/api/home/v2', requireAuth, (req, res) => {
    try {
      const readingContexts = getReadingContexts();
      const { libraryId } = req.query;
      const libFilter = libraryId ? ' AND ss.library_id = ?' : '';
      const libParams = libraryId ? [libraryId] : [];
      const userId = req.user?.sub || null;

      // Per-series Continue Reading.
      // A series qualifies if EITHER (a) it has an in-progress issue (page>0, not completed),
      // OR (b) at least one issue is completed AND a later un-started issue exists.
      // Series dismissed by the user are skipped unless new activity has occurred since dismissal.
      // A book read from another series' Issues (reading context 'series:<id>': a linked mini or
      // annual volume in that series' reading order, 2026-11-21) counts for that series.
      const SID = `CASE WHEN rp.context LIKE 'series:%' AND EXISTS (SELECT 1 FROM scanned_series x WHERE x.id = substr(rp.context, 8))
        THEN substr(rp.context, 8) ELSE sb.series_id END`;
      const seriesProgress = db.prepare(`
        SELECT
          ${SID} AS series_id,
          -- Activity = reading in the reader. Issues marked read in bulk (read
          -- history) still count as read when choosing the next issue below.
          MAX(CASE WHEN COALESCE(rp.marked, 0) = 0 AND (rp.completed = 1 OR rp.page > 0) THEN rp.updated_at ELSE NULL END) AS last_activity,
          MAX(CASE WHEN rp.completed = 0 AND rp.page > 0 THEN 1 ELSE 0 END) AS has_in_progress,
          MAX(CASE WHEN rp.completed = 1 THEN 1 ELSE 0 END) AS has_completed,
          MAX(CASE WHEN rp.completed = 1 THEN sb.sort_order ELSE -1 END) AS max_completed_sort
        FROM read_progress rp
        JOIN scanned_books sb ON sb.id = rp.book_id
        JOIN scanned_series ss ON ss.id = ${SID}
        WHERE rp.user_id = ? ${libFilter}
        GROUP BY ${SID}
        HAVING last_activity IS NOT NULL AND (has_in_progress = 1 OR has_completed = 1)
        ORDER BY last_activity DESC
      `).all(userId, ...libParams);
      // No LIMIT, and only series read in the reader: ~6,400 issues marked read
      // as reading history (2026-10-14) were the newest "activity" and filled the
      // old LIMIT 100, pushing real continue-reading series out (1 of 22 shown).
      // The loop below stops at 30 qualifying series.

      const dismissedMap = userId ? new Map(
        db.prepare('SELECT series_id, dismissed_at FROM dismissed_continue_reading WHERE user_id = ?')
          .all(userId).map(r => [r.series_id, r.dismissed_at])
      ) : new Map();

      const pickInProgressBook = db.prepare(`
        SELECT sb.*, rp.page, ss.name as seriesName, ss.id as seriesId
        FROM read_progress rp
        JOIN scanned_books sb ON sb.id = rp.book_id
        JOIN scanned_series ss ON ss.id = sb.series_id
        WHERE rp.user_id = ? AND ${SID} = ?
          AND rp.completed = 0 AND rp.page > 0
        ORDER BY rp.updated_at DESC LIMIT 1
      `);
      // The next book in the series' displayed order: the first not started after the last one read.
      const seriesPlacement = getSeriesPlacement();
      const progressOf = db.prepare('SELECT book_id, page, completed FROM read_progress WHERE user_id = ? AND book_id IN (SELECT value FROM json_each(?))');
      const bookRow = db.prepare(`SELECT sb.*, ss.name as seriesName, ss.id as seriesId, 0 as page FROM scanned_books sb
        JOIN scanned_series ss ON ss.id = sb.series_id WHERE sb.id = ?`);
      const nextInOrder = seriesId => {
        let order = null;
        try { order = seriesPlacement ? seriesPlacement.order(seriesId) : null; } catch { order = null; }
        if (!order || !order.length) return undefined;                // no order: issue order below
        const progress = new Map(progressOf.all(userId, JSON.stringify(order.map(x => x.id))).map(r => [String(r.book_id), r]));
        let last = -1;
        order.forEach((x, i) => { if (progress.get(String(x.id))?.completed) last = i; });
        for (let i = last + 1; last >= 0 && i < order.length; i++) {
          const p = progress.get(String(order[i].id));
          if (!p || (!p.completed && !(p.page > 0))) return { id: order[i].id, placed: order[i].placed };
        }
        return null;
      };
      // A card for a placed book: its label ("2026 Annual #1"), and, for another series' book, the
      // series it is read from (Read now keeps that order; View series goes to that series).
      const asSeriesCard = (book, seriesId, placed) => {
        if (!book) return null;
        const out = { ...book };
        if (String(book.series_id) !== String(seriesId)) { out.readQs = `?fromSeries=${encodeURIComponent(seriesId)}`; out.seriesId = seriesId; }
        else if (placed?.label) out.placedLabel = placed.label;     // its own series' extra: "2026 Annual #1"
        return out;
      };
      const pickNextUnstartedBook = db.prepare(`
        SELECT sb.*, ss.name as seriesName, ss.id as seriesId, 0 as page
        FROM scanned_books sb
        JOIN scanned_series ss ON ss.id = sb.series_id
        LEFT JOIN read_progress rp ON rp.book_id = sb.id AND rp.user_id = ?
        WHERE sb.series_id = ?
          AND sb.sort_order > ?
          AND (rp.id IS NULL OR (rp.completed = 0 AND rp.page = 0))
        ORDER BY sb.sort_order ASC LIMIT 1
      `);

      // One card per event / run / list being read, with its next issue in that order; a series
      // last read through one of them gets no card of its own (readingContexts.js).
      const contexts = readingContexts ? readingContexts.cards(userId, { libraryId }) : { cards: [], live: new Set() };
      const inProgress = [];
      for (const sp of seriesProgress) {
        const dismissedAt = dismissedMap.get(sp.series_id);
        // If dismissed and no new activity since dismissal, skip.
        if (dismissedAt && (!sp.last_activity || dismissedAt >= sp.last_activity)) continue;
        const viaContext = readingContexts && readingContexts.seriesLastContext(userId, sp.series_id);
        if (viaContext && contexts.live.has(viaContext)) continue;

        let book = null;
        if (sp.has_in_progress) {
          const b = pickInProgressBook.get(userId, sp.series_id);
          let placed = null;
          try { placed = b && seriesPlacement ? (seriesPlacement.order(sp.series_id) || []).find(x => String(x.id) === String(b.id))?.placed || null : null; } catch {}
          book = asSeriesCard(b, sp.series_id, placed);
        } else if (sp.has_completed) {
          const n = nextInOrder(sp.series_id);
          book = n === undefined ? pickNextUnstartedBook.get(userId, sp.series_id, sp.max_completed_sort)
            : n ? asSeriesCard(bookRow.get(n.id), sp.series_id, n.placed) : null;
        }
        if (book) inProgress.push({ ...book, _activity: sp.last_activity });
        if (inProgress.length >= 30) break;
      }

      // Post-process: collapse per-series entries into single event entries for crossovers.
      // If 2+ different series from the same event appear in inProgress, replace them all
      // with one event entry (using the most-recently-read book as the visual anchor).
      if (inProgress.length > 0) {
        const bookIds = inProgress.map(b => b.id);
        const placeholders = bookIds.map(() => '?').join(',');
        const eventMatches = db.prepare(`
          SELECT ei.event_id, ei.scanned_book_id, e.name AS event_name
          FROM event_issues ei
          JOIN events e ON e.id = ei.event_id
          WHERE ei.scanned_book_id IN (${placeholders})
        `).all(...bookIds);

        if (eventMatches.length > 0) {
          // book_id → { eventId, eventName }
          const bookEventMap = new Map(
            eventMatches.map(m => [m.scanned_book_id, { eventId: m.event_id, eventName: m.event_name }])
          );

          // Group items by eventId, tracking distinct series per event
          const eventGroups = new Map();
          for (const book of inProgress) {
            const evInfo = bookEventMap.get(book.id);
            if (!evInfo) continue;
            if (!eventGroups.has(evInfo.eventId)) {
              eventGroups.set(evInfo.eventId, { eventId: evInfo.eventId, eventName: evInfo.eventName, items: [], seriesIds: new Set() });
            }
            const g = eventGroups.get(evInfo.eventId);
            g.items.push(book);
            g.seriesIds.add(book.seriesId);
          }

          // Only collapse events where 2+ distinct series are represented
          const collapsedEvents = new Map(); // eventId → synthetic event entry
          for (const [eventId, g] of eventGroups) {
            if (g.seriesIds.size >= 2) {
              const anchor = g.items[0]; // most recently read (inProgress is already DESC by last_activity)
              collapsedEvents.set(eventId, { ...anchor, fromEvent: true, eventId: g.eventId, eventName: g.eventName });
            }
          }

          if (collapsedEvents.size > 0) {
            const seenEvents = new Set();
            const consolidated = [];
            for (const book of inProgress) {
              const evInfo = bookEventMap.get(book.id);
              if (evInfo && collapsedEvents.has(evInfo.eventId)) {
                if (!seenEvents.has(evInfo.eventId)) {
                  seenEvents.add(evInfo.eventId);
                  consolidated.push(collapsedEvents.get(evInfo.eventId));
                }
                // subsequent books from the same collapsed event are dropped
              } else {
                consolidated.push(book);
              }
            }
            inProgress.length = 0;
            inProgress.push(...consolidated);
          }
        }
      }

      // Context cards in among the series cards, newest reading first. An older-style event card
      // (series cards of one event folded together) gives way to that event's own context card.
      if (contexts.cards.length) {
        const ctxEvents = new Set(contexts.cards.filter(c => c.fromContext.kind === 'event').map(c => String(c.fromContext.id)));
        const merged = [...inProgress.filter(b => !(b.fromEvent && ctxEvents.has(String(b.eventId)))), ...contexts.cards]
          .sort((a, b) => String(b._activity || '').localeCompare(String(a._activity || ''))).slice(0, 30);
        inProgress.length = 0;
        inProgress.push(...merged);
      }
      for (const b of inProgress) delete b._activity;

      const allSeries = fetchAllSeries(libraryId);

      // Recently released — 30 most recent monitored issues by effective date.
      // No per-series dedupe so the shelf shows variety, not the same N series.
      // An issue Comic Vine has not dated yet goes by the day it was listed (RELEASE_DATE_SQL).
      const recentlyReleased = db.prepare(`
        SELECT sb.*, ss.name as seriesName, ss.id as seriesId,
               ${RELEASE_DATE_SQL} as effective_date,
               mi.issue_number as mi_issue_number
        FROM scanned_books sb
        JOIN scanned_series ss ON ss.id = sb.series_id
        LEFT JOIN monitored_issues mi ON mi.id = sb.monitored_issue_id
        WHERE 1=1 ${libFilter}
          AND ${RELEASE_DATE_SQL} IS NOT NULL
          AND ${RELEASE_DATE_SQL} <= date('now')
        ORDER BY ${RELEASE_DATE_SQL} DESC
        LIMIT 30
      `).all(...libParams);
      const recentlyReleasedDeduped = recentlyReleased
        .map(b => ({ ...b, rating: getSeriesRating(b.seriesId) }));

      // Character map — cached for 5 minutes, expensive to rebuild
      const cacheKey = libraryId || '';
      const charHit = charMapCache.get(cacheKey);
      let topCharacters;
      if (charHit && (Date.now() - charHit.ts) < 5 * 60 * 1000) {
        topCharacters = charHit.data;
      } else {
        // Count first, merge only the 8 characters shown (2026-11-05): merging up to 4 series for
        // every character in the library (thousands, each with its own lookups) took ~4.5 s and
        // held up every other request on the page. Same result: the first 4 series per character.
        const charMap = {};
        allSeries.forEach(s => {
          const json = getSeriesJsonCached(s.id, s.path);
          (json?.metadata?.characters || []).forEach(char => {
            if (!charMap[char]) charMap[char] = { name: char, series: [], count: 0 };
            if (charMap[char].series.length < 4) charMap[char].series.push(s);
            charMap[char].count++;
          });
        });
        topCharacters = Object.values(charMap)
          .filter(c => c.count >= 3)
          .sort((a, b) => b.count - a.count).slice(0, 8)
          .map(c => ({ ...c, series: c.series.map(mergeSeriesWithJson) }));
        charMapCache.set(cacheKey, { data: topCharacters, ts: Date.now() });
      }

      res.set('Cache-Control', 'private, max-age=60');

      // Library stats — fast COUNT queries, library-filtered
      const statsFilter = libraryId ? 'WHERE library_id = ?' : '';
      const statsParams = libraryId ? [libraryId] : [];
      const seriesCount = db.prepare(`SELECT COUNT(*) as n FROM scanned_series ${statsFilter}`).get(...statsParams).n;
      const issuesCount = db.prepare(`SELECT COUNT(*) as n FROM scanned_books sb ${libraryId ? 'JOIN scanned_series ss ON ss.id = sb.series_id WHERE ss.library_id = ?' : ''}`).get(...statsParams).n;
      const readCount   = db.prepare(`SELECT COUNT(*) as n FROM read_progress rp ${libraryId ? 'JOIN scanned_books sb ON sb.id = rp.book_id JOIN scanned_series ss ON ss.id = sb.series_id WHERE rp.completed = 1 AND ss.library_id = ?' : 'WHERE rp.completed = 1'} ${!libraryId && userId ? 'AND rp.user_id = ?' : libraryId && userId ? 'AND rp.user_id = ?' : ''}`).get(...statsParams, ...(userId ? [userId] : [])).n;

      res.json({ inProgress: inProgress.map(book => ({ ...book, pagesCount: book.comicinfo ? (parseComicInfo(book.comicinfo).pageCount || null) : null })), recentlyReleased: recentlyReleasedDeduped, topCharacters, stats: { seriesCount, issuesCount, readCount } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Dismiss / Restore Continue Reading ──────────────────────────
  // Body: { seriesId } — adds (or refreshes) a dismissal for the user.
  // Series stays hidden until the user logs new reading activity on it.
  app.post('/api/home/continue-reading/dismiss', requireAuth, (req, res) => {
    try {
      const readingContexts = getReadingContexts();
      const userId = req.user?.sub || null;
      const { seriesId, context } = req.body || {};
      if (!userId)   return res.status(401).json({ error: 'Authentication required' });
      // An event / run / list card: hidden until that context is read again.
      if (context) return readingContexts && readingContexts.dismiss(userId, String(context)) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not on Continue Reading' });
      if (!seriesId) return res.status(400).json({ error: 'seriesId required' });
      db.prepare(`
        INSERT INTO dismissed_continue_reading (user_id, series_id, dismissed_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(user_id, series_id) DO UPDATE SET dismissed_at = datetime('now')
      `).run(userId, seriesId);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Removes a dismissal so the series can re-appear on Continue Reading immediately.
  app.delete('/api/home/continue-reading/dismiss/:seriesId', requireAuth, (req, res) => {
    try {
      const userId = req.user?.sub || null;
      const { seriesId } = req.params;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      db.prepare('DELETE FROM dismissed_continue_reading WHERE user_id = ? AND series_id = ?')
        .run(userId, seriesId);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Discover shelf — random shuffle, never cached
  app.get('/api/home/discover', (req, res) => {
    try {
      const { libraryId } = req.query;
      const allSeries = fetchAllSeries(libraryId);

      // Random discover series
      const discoverSeries = [...allSeries].sort(() => Math.random() - 0.5).slice(0, 8).map(s => ({
        ...mergeSeriesWithJson(s),
        rating: getSeriesRating(s.id),
      }));

      // Character shelf — pool is all characters in top 3 of any series.json.
      // Cached indefinitely — charMapCache is cleared by invalidateSeriesCache()
      // at the end of every library scan, so the pool rebuilds exactly when new
      // series might have been added and never expires mid-session.
      const cacheKey = (libraryId || '') + ':charpool';
      const poolHit = charMapCache.get(cacheKey);
      let charPool;
      if (poolHit) {
        charPool = poolHit.data;
      } else {
        const poolMap = {};
        allSeries.forEach(s => {
          const json = getSeriesJsonCached(s.id, s.path);
          const chars = json?.metadata?.characters || [];
          // Only consider first 3 positions — the series' primary characters
          chars.slice(0, 3).forEach(char => {
            if (!poolMap[char]) poolMap[char] = { name: char, count: 0 };
            poolMap[char].count++;
          });
        });
        charPool = Object.values(poolMap).filter(c => c.count >= 3).sort((a, b) => b.count - a.count);
        charMapCache.set(cacheKey, { data: charPool });
      }

      // Shuffle pool and pick up to 8 — different every load
      const shuffled = [...charPool].sort(() => Math.random() - 0.5);
      const topCharacters = shuffled.slice(0, 8).map(c => ({ name: c.name, count: c.count }));

      res.set('Cache-Control', 'no-store');
      res.json({ discoverSeries, topCharacters });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
