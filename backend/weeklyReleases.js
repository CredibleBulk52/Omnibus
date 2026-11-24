'use strict';
// ─── Weekly releases (moved out of server.js 2026-11-23, server.js split step 7B) ───
// The Weekly tab (League of Comic Geeks first, then FreshComics; Walksoftly for older weeks), the
// current-week Comic Vine refresh, League of Comic Geeks series ids (resolver, sync with series.json,
// and their schedules), the release-source comparison, and the weekly and LoCG debug routes. Moved unchanged.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const { nameKey } = require('./names');

const NEEDS = ['app', 'cvApiGet', 'db', 'DB_BACKUP_DIR', 'fetchAndSetSeriesStatus', 'FLARESOLVERR_URL', 'fsCache', 'getCVKey', 'getSetting', 'LOCG_BASE', 'logger', 'metron', 'patchSeriesJsonWithLocg', 'PORT', 'refreshSeriesIssuesFromCV', 'requireAdmin', 'requireDownloadAccess'];
module.exports.NEEDS = NEEDS;

module.exports.registerWeeklyReleases = function registerWeeklyReleases(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerWeeklyReleases: missing ${missing.join(', ')}`);
  const { app, cvApiGet, db, DB_BACKUP_DIR, fetchAndSetSeriesStatus, FLARESOLVERR_URL, fsCache, getCVKey, getSetting, LOCG_BASE, logger, metron, patchSeriesJsonWithLocg, PORT, refreshSeriesIssuesFromCV, requireAdmin, requireDownloadAccess } = deps;
  // ─── Weekly releases ──────────────────────────────────────────────
  // ALL weeks use Walksoftly/LOCG exclusively (session 13+).
  // Walksoftly serves LOCG data as clean JSON — same source Mylar uses.
  // Provides: publisher, series, issue, shipdate, comicid (CV volume ID), type
  // Pre-filters reprints server-side. CV fallback only if Walksoftly unreachable.

  // ─── Walksoftly / LOCG helpers ───────────────────────────────────

  // Compute Python-compatible %U week number (Sunday-based, 00–53).
  // Pass the Monday date string directly — do NOT add +6 days.
  function getLocgWeekNum(dateStr) {
    const d    = new Date(dateStr + 'T12:00:00Z');
    const jan1 = new Date(d.getUTCFullYear() + '-01-01T12:00:00Z');
    const jan1Day   = jan1.getUTCDay(); // 0=Sun
    const dayOfYear = Math.floor((d - jan1) / 86400000);
    return Math.floor((dayOfYear + jan1Day) / 7);
  }

  const LOCG_TPB_TYPES = new Set(['tpb','hc','gn','sc','omnibus','digest','manga','anthology','hardcover','trade']);

  /**
   * Normalize a publisher name for comparison.
   * Strips generic words ("Comics", "Entertainment", "Publishing") and punctuation
   * so "Marvel Comics" and "Marvel" both normalize to "marvel".
   */
  function normPublisher(pub) {
    return (pub || '')
      .toLowerCase()
      .replace(/\bcomics?\b/g, '')
      .replace(/\bentertainment\b/g, '')
      .replace(/\bpublishing\b/g, '')
      .replace(/\bpublications?\b/g, '')
      .replace(/\binc\.?\b/g, '')
      .replace(/\bllc\.?\b/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }

  /**
   * Returns true if two publisher names are compatible (same root after normalisation).
   * Unknown/empty publishers are always compatible (can't rule out a match).
   */
  function publishersCompatible(pubA, pubB) {
    const nA = normPublisher(pubA);
    const nB = normPublisher(pubB);
    if (!nA || !nB || nA === 'unknown' || nB === 'unknown') return true;
    return nA === nB || nA.includes(nB) || nB.includes(nA);
  }

  function isLocgTpb(item) {
    const type = (item.type || '').toLowerCase().trim();
    if (LOCG_TPB_TYPES.has(type)) return true;
    const issue = String(item.issue || '').trim();
    // Blank or non-numeric start → not a single issue
    if (!issue || !/^\d/.test(issue)) return true;
    return false;
  }

  // ─── Current-week CV refresh ─────────────────────────────────────
  /**
   * Fetches this week's LOCG list, finds monitored series in it,
   * and runs refreshSeriesIssuesFromCV for each.
   * Called by: daily 8am cron + frontend when current week tab loads.
   */
  async function refreshCurrentWeekMonitoredSeries() {
    // Get Monday of current week (server local time)
    const today = new Date();
    const dow = today.getDay(); // 0=Sun
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
    const weekStr = monday.toISOString().slice(0, 10);

    logger.info('week-refresh', `Fetching LOCG for week ${weekStr}`);
    let weekData;
    try {
      const result = await fetchWeeklyReleases(weekStr);
      weekData = result.items;
      logger.info('week-refresh', `Release data from ${result.source}: ${weekData.length} items`);
    } catch (e) {
      logger.warn('week-refresh', 'Could not fetch weekly releases', e.message);
      return { refreshed: 0, skipped: 0 };
    }

    if (!weekData || !weekData.length) return { refreshed: 0, skipped: 0 };

    // Match monitored series by CV volume ID (Walksoftly) OR by normalised series name (FreshComics)
    const weekCvIds = new Set(weekData.map(c => String(c.comicid)).filter(id => id && id !== 'undefined' && id !== 'null'));
    const weekNames = new Set(weekData.map(c => nameKey(c.series)).filter(Boolean));

    // Find active monitored series whose CV ID or name is in this week's list
    const monitored = db.prepare(`SELECT id, name FROM monitored_series WHERE status = 'active'`).all();
    const toRefresh = monitored.filter(s => {
      if (weekCvIds.has(String(s.id))) return true;
      const key = nameKey(s.name);
      return weekNames.has(key);
    });

    logger.info('week-refresh', `${toRefresh.length} monitored series shipping this week`, { ids: toRefresh.map(s => s.id) });

    // Comic Vine often lists a new issue on its release day with no dates at all (2026-11-18: that
    // week's issues arrived with neither store nor cover date, so Home's Recently Released and My
    // Pulls, which go by date, never showed them once downloaded). The weekly list knows the ship
    // date: use it until Comic Vine has its own (the series sync replaces it when CV dates appear).
    const numKey = n => String(n || '').trim().replace(/^0+/, '');   // same as SQLite's ltrim(…, '0'): #0 and #0.5 match too
    const shipDate = db.prepare(`UPDATE monitored_issues SET store_date = ?
    WHERE series_id = ? AND store_date IS NULL AND release_date IS NULL AND ltrim(issue_number, '0') = ?`);
    let refreshed = 0, skipped = 0, shipDated = 0;
    for (const series of toRefresh) {
      try {
        const { inserted, total } = await refreshSeriesIssuesFromCV(series.id);
        if (inserted > 0) logger.info('week-refresh', `${series.name}: +${inserted} new issues (${total} total on CV)`);
        for (const c of weekData) {
          if (!c.issue || !/^\d{4}-\d{2}-\d{2}$/.test(c.shipdate || '')) continue;
          if (String(c.comicid) !== String(series.id) && nameKey(c.series) !== nameKey(series.name)) continue;
          shipDated += shipDate.run(c.shipdate, series.id, numKey(c.issue)).changes;
        }
        refreshed++;
        await new Promise(r => setTimeout(r, 700)); // respect CV rate limit
      } catch (e) {
        logger.warn('week-refresh', `Failed for ${series.name}`, e.message);
        skipped++;
      }
    }

    logger.info('week-refresh', `Done — ${refreshed} refreshed, ${skipped} failed${shipDated ? `, ${shipDated} undated issue(s) given the weekly list's ship date` : ''}`);
    return { refreshed, skipped, series: toRefresh.map(s => s.name) };
  }


  // Frontend calls this when DownloadManager mounts — fire-and-forget.
  // Server-side cooldown: won't re-run within 2 hours to prevent CV hammering
  // when the user navigates back and forth between pages.
  let _weekRefreshLastRun = 0;
  const WEEK_REFRESH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

  app.post('/api/monitor/refresh-current-week', requireDownloadAccess, async (req, res) => {
    const now = Date.now();
    if (now - _weekRefreshLastRun < WEEK_REFRESH_COOLDOWN_MS) {
      const waitMins = Math.ceil((WEEK_REFRESH_COOLDOWN_MS - (now - _weekRefreshLastRun)) / 60000);
      logger.info('week-refresh', `Skipping — cooldown active (${waitMins}min remaining)`);
      return res.json({ success: true, skipped: true, cooldownMinsRemaining: waitMins });
    }
    _weekRefreshLastRun = now;
    refreshCurrentWeekMonitoredSeries().catch(e =>
      logger.warn('week-refresh', 'Background refresh error', e.message)
    );
    res.json({ success: true });
  });

  // ─── LOCG series ID resolver ──────────────────────────────────────────────────
  // Fetches the LOCG issue page (full slug URL) for each monitored series that
  // has a locg_issue_id in locg_issue_lookup but no locg_series_id yet.
  // Extracts /comics/series/{id}/{slug} and stores it in monitored_series.
  // Rate-limited to one FlareSolverr call every ~4 seconds.
  async function resolveLocgSeriesIds(limit = 20) {
    const toResolve = db.prepare(`
    SELECT DISTINCT ms.id AS series_id, ms.directory, l.locg_issue_id, l.locg_slug
    FROM monitored_series ms
    JOIN locg_issue_lookup l ON l.cv_series_id = CAST(ms.id AS TEXT)
    WHERE ms.locg_series_id IS NULL
      AND l.locg_slug IS NOT NULL
    LIMIT ?
  `).all(limit);

    if (!toResolve.length) {
      logger.info('locg-resolve', 'No series pending LOCG series ID resolution');
      return { resolved: 0, checked: 0 };
    }

    logger.info('locg-resolve', `Resolving LOCG series IDs for ${toResolve.length} series`);
    let resolved = 0;

    const updateSeries = db.prepare(`
    UPDATE monitored_series SET locg_series_id = ?, locg_series_slug = ? WHERE id = ?
  `);

    for (const { series_id, directory, locg_issue_id, locg_slug } of toResolve) {
      try {
        const url = `${LOCG_BASE}/comic/${locg_issue_id}/${locg_slug}`;
        const r = await axios.post(`${FLARESOLVERR_URL}/v1`, {
          cmd: 'request.get', url, maxTimeout: 60000, wait: 5000,
        }, { timeout: 70000 });

        const html = r.data?.solution?.response || '';
        // Extract series link: /comics/series/{id}/{slug}
        const m = html.match(/href="\/comics\/series\/(\d+)\/([^"\/]+)/);
        if (m) {
          updateSeries.run(m[1], m[2], series_id);
          logger.info('locg-resolve', `Series ${series_id} → LOCG series ${m[1]} (${m[2]})`);
          // Write LOCG IDs into series.json on disk if it exists
          if (directory) {
            try {
              const patched = patchSeriesJsonWithLocg(directory, m[1], m[2]);
              if (patched) logger.info('locg-resolve', `Wrote LOCG series ID to series.json`, { series_id, locg_series_id: m[1] });
            } catch (pe) {
              logger.warn('locg-resolve', `series.json patch failed`, { series_id, error: pe.message });
            }
          }
          resolved++;
        } else {
          logger.warn('locg-resolve', `Series ${series_id}: no series link found`, { url, len: html.length });
        }
      } catch (e) {
        logger.warn('locg-resolve', `Series ${series_id}: fetch error`, e.message);
      }
      // 4s between requests — polite rate limit for LOCG
      await new Promise(r => setTimeout(r, 4000));
    }

    logger.info('locg-resolve', `Done — ${resolved}/${toResolve.length} resolved`);
    return { resolved, checked: toResolve.length };
  }

  // ─── Bidirectional LOCG sync: series.json → DB ───────────────────
  // On startup, scan monitored series that have no locg_series_id in the DB
  // but do have one written in their series.json (e.g. set manually or by a
  // previous install). Writes the ID back to monitored_series so the rest of
  // the app can use it without waiting for the resolver cron.
  async function syncLocgIdsFromSeriesJson() {
    const pending = db.prepare(
      `SELECT id, directory FROM monitored_series WHERE locg_series_id IS NULL AND directory IS NOT NULL`
    ).all();

    if (!pending.length) return 0;

    const updateLocg = db.prepare(
      `UPDATE monitored_series SET locg_series_id = ?, locg_series_slug = ? WHERE id = ?`
    );

    let synced = 0;
    for (const s of pending) {
      try {
        const jsonPath = path.join(s.directory, 'series.json');
        if (!fs.existsSync(jsonPath)) continue;
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (data.locg_series_id) {
          updateLocg.run(String(data.locg_series_id), data.locg_series_slug || null, s.id);
          synced++;
        }
      } catch { /* skip malformed files */ }
    }

    if (synced > 0) logger.info('locg-sync', `Synced ${synced} LOCG series IDs from series.json → DB`);
    return synced;
  }

  // Every 3 hours: resolve a batch of 20 monitored series LOCG series IDs.
  cron.schedule('0 */3 * * *', async () => {
    logger.info('locg-resolve', 'Scheduled LOCG series ID resolution starting');
    await resolveLocgSeriesIds(20);
  });

  // On startup (1-minute delay): sync any LOCG IDs already present in series.json files back to DB.
  // Then at 3 minutes: resolve a small fresh batch via FlareSolverr.
  setTimeout(() => {
    syncLocgIdsFromSeriesJson().catch(e =>
      logger.warn('locg-sync', 'Startup series.json sync error', e.message)
    );
  }, 60 * 1000);

  setTimeout(() => {
    resolveLocgSeriesIds(10).catch(e =>
      logger.warn('locg-resolve', 'Startup resolution error', e.message)
    );
  }, 3 * 60 * 1000);

  // Daily cron 8am — refreshes CV issues for series shipping this week only.
  // Lightweight: skips all non-shipping series, won't hammer CV.
  cron.schedule('0 8 * * *', async () => {
    logger.info('week-refresh', 'Daily current-week CV refresh starting');
    await refreshCurrentWeekMonitoredSeries();
  });

  // Monthly series status re-check — catches ongoing series that have ended.
  // Runs on the 1st of each month at 4:00am. Re-queries CV for every 'ongoing'
  // series; fetchAndSetSeriesStatus will now write 'ended' if the last issue
  // is more than 24 months old. Rate-limited to ~1 req/2s to be polite to CV.
  cron.schedule('0 4 1 * *', async () => {
    logger.info('series-status', 'Monthly ongoing-series status re-check starting');
    const ongoing = db.prepare(`SELECT id, name FROM monitored_series WHERE series_status = 'ongoing' AND status = 'active'`).all();
    logger.info('series-status', `Re-checking ${ongoing.length} ongoing series`);
    let changed = 0;
    for (const s of ongoing) {
      try {
        const before = db.prepare('SELECT series_status FROM monitored_series WHERE id = ?').get(s.id)?.series_status;
        await fetchAndSetSeriesStatus(s.id);
        const after  = db.prepare('SELECT series_status FROM monitored_series WHERE id = ?').get(s.id)?.series_status;
        if (after !== before) {
          logger.info('series-status', `"${s.name}" ${before} → ${after}`);
          changed++;
        }
      } catch (e) {
        logger.warn('series-status', `Re-check failed for "${s.name}"`, e.message);
      }
      // ~2s between requests — polite CV rate limit
      await new Promise(r => setTimeout(r, 2000));
    }
    logger.info('series-status', `Monthly re-check done — ${changed}/${ongoing.length} series changed`);
  });

  // Monthly blacklist prune — keep the table from growing forever.
  // Runs on the 1st of each month at 3:30am.
  // Removes entries older than 30 days for issues that are now processed or skipped
  // (no point keeping blacklist for issues we no longer need to download).
  cron.schedule('30 3 1 * *', () => {
    try {
      const { changes } = db.prepare(`
      DELETE FROM download_blacklist
      WHERE failed_at < datetime('now', '-30 days')
        AND issue_id IN (
          SELECT id FROM monitored_issues WHERE status IN ('processed','skipped')
        )
    `).run();
      logger.info('blacklist-prune', `Pruned ${changes} old blacklist entries`);
    } catch (e) {
      logger.warn('blacklist-prune', 'Prune failed', e.message);
    }
  });

  async function fetchWalksoftly(dateStr) {
    const week = getLocgWeekNum(dateStr);
    const year = new Date(dateStr + 'T12:00:00Z').getUTCFullYear();
    const weekStr = String(week).padStart(2, '0');
    const url = `https://walksoftly.itsaninja.party/newcomics.php?week=${weekStr}&year=${year}`;
    logger.info('weekly', `Walksoftly fetch: week=${weekStr} year=${year} url=${url}`);
    try {
      const r = await axios.get(url, {
        timeout: 20000,
        headers: { 'User-Agent': 'Omnibus/1.0' },
        // Don't throw on non-2xx — some weeks return non-200 codes
        // when data isn't available yet. Log body for diagnosis.
        validateStatus: () => true,
      });

      if (r.status !== 200) {
        // Log response body snippet so we can see what the server returned
        const bodySnippet = typeof r.data === 'string'
          ? r.data.slice(0, 300)
          : JSON.stringify(r.data).slice(0, 300);
        logger.warn('weekly', `Walksoftly status ${r.status} for week ${weekStr}/${year}`, { body: bodySnippet });
        return [];
      }

      // If response is a valid array, return it directly.
      if (Array.isArray(r.data)) {
        if (r.data.length === 0) {
          logger.info('weekly', `Walksoftly returned empty array for week ${weekStr}/${year}`);
        } else {
          // Log first item's field names so we can spot field renames quickly
          logger.info('weekly', `Walksoftly OK: ${r.data.length} items, fields: [${Object.keys(r.data[0]).join(', ')}]`);
        }
        return r.data;
      }

      // Some response format change — log it so we can diagnose
      const bodySnippet = JSON.stringify(r.data).slice(0, 500);
      logger.warn('weekly', `Walksoftly returned non-array 200 response for week ${weekStr}/${year}`, { body: bodySnippet });

      // Try to salvage common wrapped shapes: { issues: [...] }, { data: [...] }, { comics: [...] }
      for (const key of ['issues', 'data', 'comics', 'results', 'list', 'releases']) {
        if (Array.isArray(r.data?.[key])) {
          logger.info('weekly', `Walksoftly: salvaged array from response.${key} (${r.data[key].length} items)`);
          return r.data[key];
        }
      }

      return [];
    } catch (e) {
      logger.warn('weekly', `Walksoftly fetch failed for week ${weekStr}/${year}: ${e.message}`);
      return [];
    }
  }

  // ─── Weekly release scrapers ──────────────────────────────────────
  // Priority order: LOCG (JSON API) → FreshComics (HTML) → Walksoftly (down, last resort)

  /**
   * Returns true if this title is a reprint and should be excluded from weekly results.
   * Catches facsimile editions, Nth printings, director's cuts, etc.
   */
  function isReprintTitle(title) {
    return /\b(?:facsimile(?:\s+edition)?|(?:\d+(?:st|nd|rd|th)|second|third|fourth|fifth|sixth|new)\s+printing|director(?:'s|s)\s+cut|remastered\s+edition)\b/i.test(title);
  }

  /**
   * Shared title-type classifier used by both LOCG and FreshComics parsers.
   * Returns 'tpb' for collected editions, 'issue' for single issues.
   */
  function detectReleaseType(title) {
    const t = title.toLowerCase();
    if (/\b(tpb|trade\s+paperback|hardcover|omnibus|compendium|epic\s+collection|complete\s+collection|graphic\s+novel|manga|anthology|digest|deluxe\s+edition|absolute\s+edition|box\s+set)\b/.test(t)) return 'tpb';
    if (/\bvol\.\s*\d/.test(t) && !/\s#\d/.test(t)) return 'tpb'; // "Vol. 5" without issue# → TPB
    if (/\b(hc|gn)\b/.test(t)) return 'tpb';
    return 'issue';
  }

  // ─── 1. League of Comic Geeks (primary) ──────────────────────────
  // JSON API endpoint — no authentication required.
  // Discovered via: github.com/pruizlezcano/comicgeeks

  /**
   * Parse the HTML fragment returned in LOCG's JSON `list` field.
   * Each <li> is one issue entry.
   */
  function parseLOCGHtml(html, fallbackDateStr) {
    const items = [];

    // Split on <li to process each issue card independently
    const parts = html.split(/<li\b/i);

    for (let i = 1; i < parts.length; i++) {
      const chunk = '<li ' + parts[i];

      // Only process issue entries (skip navigation, etc.)
      if (!/class="[^"]*\bissue\b/i.test(chunk)) continue;

      // Skip variants: data-parent must be "0" (variants have data-parent set to parent's data-comic)
      const parentM = chunk.match(/\bdata-parent="(\d+)"/i);
      if (parentM && parentM[1] !== '0') continue;

      // LOCG issue ID (data-comic) and URL slug (from the title <a href>)
      // e.g. data-comic="8193797", href="/comic/8193797/absolute-wonder-woman-20"
      const comicIdM  = chunk.match(/\bdata-comic="(\d+)"/i);
      const locg_id   = comicIdM ? comicIdM[1] : null;
      const hrefM     = chunk.match(/href="\/comic\/\d+\/([^"]+)"/i);
      const locg_slug = hrefM ? hrefM[1] : null;

      // Title: prefer data-sorting attribute — it's the canonical clean title
      // e.g. data-sorting="Absolute Green Arrow #1"
      // Fall back to inner text of .title div
      let titleRaw;
      const sortM = chunk.match(/\bdata-sorting="([^"]+)"/i);
      if (sortM) {
        titleRaw = sortM[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
      } else {
        const titleM = chunk.match(/class="[^"]*\btitle\b[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/(?:div|span|p|h\d)>/i);
        if (!titleM) continue;
        titleRaw = titleM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();
      }
      if (!titleRaw) continue;

      // Publisher: <div class="publisher color-offset">Marvel Comics</div>
      const pubM = chunk.match(/class="[^"]*\bpublisher\b[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/(?:div|span|p)>/i);
      const publisher = pubM
        ? pubM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim()
        : 'Unknown';

      // Ship date: data-date="<unix timestamp>"
      const dateM = chunk.match(/\bdata-date="(\d+)"/i);
      let shipdate = fallbackDateStr;
      if (dateM) {
        const ts = parseInt(dateM[1], 10) * 1000;
        if (!isNaN(ts)) shipdate = new Date(ts).toISOString().slice(0, 10);
      }

      // Skip reprints (facsimiles, 2nd printings, etc.)
      if (isReprintTitle(titleRaw)) continue;

      // Parse "Series Name #N" or "Series Name #N.1" from title
      const issueM = titleRaw.match(/^(.+?)\s+#(\d[\d.]*)(?:\s*\(.*\))?\s*$/);
      let series, issue, type;
      if (issueM) {
        series = issueM[1].trim();
        issue  = issueM[2];
        type   = detectReleaseType(titleRaw);
      } else {
        series = titleRaw;
        issue  = '';
        type   = 'tpb';
      }

      items.push({ series, issue, publisher, type, shipdate, comicid: null, locg_id, locg_slug });
    }

    return items;
  }

  /**
   * Fetch this week's new releases from League of Comic Geeks.
   * Uses their internal JSON API; no login needed for public release data.
   *
   * Endpoint discovered from github.com/pruizlezcano/comicgeeks:
   *   GET /comic/get_comics?list=releases&view=thumbs&format[]=1&date_type=week&date=M/D/YYYY&order=pulls
   * Returns: { count: N, list: "<html fragment>" }
   */
  // ─── LOCG ─────────────────────────────────────────────────────────────────────
  // LOCG is behind Cloudflare bot protection. We bypass it using the existing
  // FlareSolverr sidecar (same one used for GetComics/Nyaa). FlareSolverr runs a
  // real Chromium instance on the server's own IP, so the resulting cf_clearance
  // cookie is valid for subsequent requests from this machine.
  //
  // The new-comics page renders its list client-side via AJAX, so fetching the
  // page HTML directly yields an empty container. Instead we:
  //   1. Hit the main page via FlareSolverr to obtain valid CF cookies (fsCache).
  //   2. Use those cached cookies to call LOCG's internal JSON API directly.
  //      API: GET /comic/get_comics?list=releases&view=thumbs&format[]=1
  //                                &date_type=week&date=M/D/YYYY&order=pulls
  //      Returns: { count: N, list: "<html fragment of <li> cards>" }
  //   3. Parse the list fragment with parseLOCGHtml.


  /**
   * Fetch this week's new releases from League of Comic Geeks.
   * dateStr = Monday of the week (YYYY-MM-DD); LOCG uses Wednesday → add 2 days.
   * Returns [] if FlareSolverr is unavailable or the API returns nothing useful.
   *
   * Strategy: use FlareSolverr for BOTH requests so real Chromium makes them.
   * Using cached CF cookies via plain axios fails because CF also checks the
   * TLS fingerprint (JA3/JA4) — a direct axios call looks like a bot regardless
   * of whether cf_clearance is present.
   *
   *   Step 1 — Page fetch with `wait: 8000`:
   *     FlareSolverr loads the new-comics page and waits 8s for the AJAX call
   *     that populates the comic list to complete. The fully-rendered HTML is
   *     returned in solution.response and passed to parseLOCGHtml.
   *
   *   Step 2 — API fetch (fallback):
   *     If step 1 yields 0 items (AJAX didn't finish / HTML structure changed),
   *     we ask FlareSolverr to navigate Chromium directly to the JSON API URL.
   *     Chrome renders the JSON as text inside a <pre>; we strip tags and parse.
   */
  async function fetchLOCG(dateStr) {
    try {
      const monday = new Date(dateStr + 'T12:00:00Z');
      const wednesday = new Date(monday);
      wednesday.setUTCDate(monday.getUTCDate() + 2);
      const wedStr = wednesday.toISOString().slice(0, 10);
      const [year, month, day] = wedStr.split('-');
      const pageUrl = `${LOCG_BASE}/comics/new-comics/${year}/${month}/${day}`;

      // ── Primary: JSON API via FlareSolverr ────────────────────────────────────
      // The API returns the complete release list (all issues, not just the first
      // AJAX batch). The `list` field contains HTML-entity-encoded markup which
      // we decode before parsing.
      // API date format: M/D/YYYY (no zero-padding)
      const apiDate = `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;
      const apiUrl  = `${LOCG_BASE}/comic/get_comics?list=releases&view=thumbs` +
                      `&format[]=1&date_type=week&date=${encodeURIComponent(apiDate)}&order=pulls`;

      logger.info('locg', 'Fetching JSON API via FlareSolverr', { apiUrl });
      const apiFs = await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd:        'request.get',
        url:        apiUrl,
        maxTimeout: 60000,
      }, { timeout: 65000 });

      const apiSolution = apiFs.data?.solution;
      if (apiSolution?.status === 200 && apiSolution.response) {
        // Chrome renders JSON endpoints as text inside a <pre>; strip HTML tags.
        const raw = (apiSolution.response || '').replace(/<[^>]+>/g, '').trim();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) data = JSON.parse(m[0]);
        }

        const rawList = data?.list || '';
        if (rawList) {
          // The `list` field contains HTML-entity-encoded markup — decode first.
          const listHtml = rawList
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

          const items = parseLOCGHtml(listHtml, wedStr);
          logger.info('locg', `API parsed ${items.length} releases`, { apiCount: data.count });
          if (items.length > 0) return items;
          logger.warn('locg', 'API returned list but parsed 0 items — falling back to page render');
        } else {
          logger.warn('locg', 'API returned no list HTML', { count: data?.count });
        }
      } else {
        logger.warn('locg', 'API fetch failed', {
          status:  apiSolution?.status,
          message: apiFs.data?.message,
        });
      }

      // ── Fallback: full page render with AJAX wait ─────────────────────────────
      // The page only renders a partial list via AJAX, but is better than nothing.
      logger.info('locg', 'Falling back to page render (wait=8000ms for AJAX)', { url: pageUrl });
      const pageFs = await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd:        'request.get',
        url:        pageUrl,
        maxTimeout: 90000,
        wait:       8000,
      }, { timeout: 100000 });

      const pageSolution = pageFs.data?.solution;
      if (pageSolution?.status === 200 && pageSolution.response) {
        fsCache.set('leagueofcomicgeeks.com', {
          cookies:   pageSolution.cookies || [],
          userAgent: pageSolution.userAgent,
          expiry:    Date.now() + 30 * 60 * 1000,
        });
        const pageItems = parseLOCGHtml(pageSolution.response, wedStr);
        logger.info('locg', `Page render parsed ${pageItems.length} releases`);
        return pageItems;
      } else {
        logger.warn('locg', 'Page render fallback also failed', {
          status:  pageSolution?.status,
          message: pageFs.data?.message,
        });
      }

      return [];

    } catch (err) {
      logger.warn('locg', 'Fetch failed — falling back to FreshComics', { error: err.message });
      return [];
    }
  }

  // ─── 2. FreshComics (fallback) ────────────────────────────────────
  // Server-rendered HTML at freshcomics.us/issues/YYYY-MM-DD (Wednesday date).
  // Used if LOCG returns nothing (e.g. LOCG is down or week not yet posted).

  /**
   * Canonicalize publisher names that FreshComics lists inconsistently.
   * Keeps a single canonical form so the same publisher doesn't appear twice.
   */
  const PUBLISHER_ALIASES = {
    // Marvel
    'marvel':                   'Marvel Comics',
    'marvel comics':            'Marvel Comics',
    // BOOM! Studios
    'boom entertainment':       'BOOM! Studios',
    'boom! entertainment':      'BOOM! Studios',
    'boom studios':             'BOOM! Studios',
    'boom! studios':            'BOOM! Studios',
    // DC
    'dc':                       'DC Comics',
    'dc comics':                'DC Comics',
    // Dark Horse
    'dark horse':               'Dark Horse Comics',
    'dark horse comics':        'Dark Horse Comics',
    // IDW
    'idw':                      'IDW Publishing',
    'idw publishing':           'IDW Publishing',
  };

  function normalizeFreshComicsPublisher(name) {
    return PUBLISHER_ALIASES[name.toLowerCase()] ?? name;
  }

  /**
   * Parse FreshComics HTML. Publisher sections are delimited by <h2> tags.
   * Deduplicates by (series, issue) to handle publishers that label every
   * cover with "(Artist Name Cover)" rather than having a plain main cover.
   */
  function parseFreshComicsHtml(html, shipdate) {
    const items = [];

    // Split on <h2 openings to isolate each publisher section
    const parts = html.split(/<h2(?:\s[^>]*)?>/i);

    // Seen sets keyed by normalized publisher name so that alias sections
    // (e.g. "Marvel" and "Marvel Comics") share the same dedup state.
    const seenByPublisher = new Map();

    for (let i = 1; i < parts.length; i++) {
      const closeH2 = parts[i].indexOf('</h2>');
      if (closeH2 === -1) continue;

      let publisher = parts[i]
        .slice(0, closeH2)
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .trim();

      // Skip non-publisher h2s (site chrome, page headers)
      if (!publisher || publisher.length < 2) continue;
      if (/freshcomics|fresh\s+comics|new\s+release|this\s+week|browse|filter/i.test(publisher)) continue;

      // Normalize known publisher name variants from FreshComics
      publisher = normalizeFreshComicsPublisher(publisher);

      const section = parts[i].slice(closeH2 + 5);

      // Deduplicate: keep only the FIRST listing of each series+issue combo,
      // shared across all sections that normalize to the same publisher name.
      if (!seenByPublisher.has(publisher)) seenByPublisher.set(publisher, new Set());
      const seen = seenByPublisher.get(publisher);

      const smallRe = /<small[^>]*>([\s\S]*?)<\/small>/gi;
      let m;
      while ((m = smallRe.exec(section)) !== null) {
        const titleRaw = m[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .trim();
        if (!titleRaw) continue;

        // Skip reprints (facsimiles, 2nd printings, etc.)
        if (isReprintTitle(titleRaw)) continue;

        // Parse "Series #N" or "Series #N (Artist Cover)" or "Series #N (2nd Printing)"
        const issueM = titleRaw.match(/^(.+?)\s+#(\d[\d.]*)(?:\s*\(.*\))?\s*$/);
        let series, issue, type;
        if (issueM) {
          series = issueM[1].trim();
          issue  = issueM[2];
          type   = detectReleaseType(titleRaw);
        } else {
          // No issue number → assume collected edition
          series = titleRaw.replace(/\s*\(.*?\)\s*$/, '').trim();
          issue  = '';
          type   = 'tpb';
        }

        // First listing of this (series, issue) wins; all subsequent covers skipped
        const key = `${series.toLowerCase()}||${issue}`;
        if (seen.has(key)) continue;
        seen.add(key);

        items.push({ series, issue, publisher, type, shipdate, comicid: null });
      }
    }

    return items;
  }

  /**
   * Fetch this week's releases from FreshComics.us.
   * dateStr = Monday of the week (YYYY-MM-DD); FreshComics uses Wednesday → add 2 days.
   */
  async function fetchFreshComics(dateStr) {
    const monday    = new Date(dateStr + 'T12:00:00Z');
    const wednesday = new Date(monday);
    wednesday.setUTCDate(monday.getUTCDate() + 2);
    const wednesdayStr = wednesday.toISOString().slice(0, 10);
    const url = `https://freshcomics.us/issues/${wednesdayStr}`;

    logger.info('weekly', `FreshComics fetch: ${url}`);
    try {
      const r = await axios.get(url, {
        timeout: 20000,
        responseType: 'text',
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        validateStatus: () => true,
      });

      if (r.status !== 200) {
        logger.warn('weekly', `FreshComics status ${r.status} for ${wednesdayStr}`);
        return [];
      }

      const html = typeof r.data === 'string' ? r.data : String(r.data);
      if (html.length < 500 || !html.includes('<small')) {
        logger.warn('weekly', `FreshComics: thin/empty response for ${wednesdayStr} (${html.length} bytes)`);
        return [];
      }

      const items = parseFreshComicsHtml(html, dateStr);
      logger.info('weekly', `FreshComics OK: ${items.length} items for ${wednesdayStr}`);
      return items;
    } catch (e) {
      logger.warn('weekly', `FreshComics fetch failed for ${wednesdayStr}: ${e.message}`);
      return [];
    }
  }

  /**
   * Unified weekly releases fetch.
   * Priority: LOCG (if credentials configured) → FreshComics → Walksoftly (legacy).
   * Returns { items, source }.
   */
  async function fetchWeeklyReleases(dateStr) {
    // 1. LOCG — richest data, includes pull counts and LOCG IDs for deep links.
    //    Uses FlareSolverr sidecar (same as GetComics) to bypass Cloudflare.
    //    Silently falls back to FreshComics if FlareSolverr is unavailable.
    const locg = await fetchLOCG(dateStr);
    if (locg.length > 0) return { items: locg, source: 'locg' };

    // 2. FreshComics — HTML scrape, full publisher coverage, no auth required
    const fresh = await fetchFreshComics(dateStr);
    if (fresh.length > 0) return { items: fresh, source: 'freshcomics' };

    // 3. Walksoftly — down since May 2026, kept as last resort
    logger.info('weekly', 'FreshComics returned 0 — trying Walksoftly fallback');
    const ws = await fetchWalksoftly(dateStr);
    if (ws.length > 0) return { items: ws, source: 'walksoftly' };

    return { items: [], source: 'none' };
  }

  app.get('/api/weekly', async (req, res) => {
    const { start } = req.query; // YYYY-MM-DD, Monday of the requested week
    if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      return res.status(400).json({ error: 'start=YYYY-MM-DD required' });
    }

    const startDate = new Date(start + 'T12:00:00Z');
    const endDate   = new Date(startDate);
    endDate.setUTCDate(startDate.getUTCDate() + 6);
    const endStr = endDate.toISOString().slice(0, 10);

    try {
      const { items: rawAll, source: releaseSource } = await fetchWeeklyReleases(start);

      // ── Publisher exclusion ───────────────────────────────────────────
      // Filter out publishers the user has excluded (e.g. Panini, Webtoon).
      // The setting is a JSON array of case-insensitive substrings.
      let excludedPubs = [];
      try { excludedPubs = JSON.parse(getSetting('weekly_excluded_publishers') || '[]'); } catch {}
      const normExcluded = excludedPubs.map(p => (p || '').toLowerCase().trim()).filter(Boolean);
      const raw = normExcluded.length
        ? rawAll.filter(item => {
            const pub = (item.publisher || '').toLowerCase();
            return !normExcluded.some(excl => pub.includes(excl));
          })
        : rawAll;

      const tpbs    = raw.filter(item => isLocgTpb(item));
      const singles = raw.filter(item => !isLocgTpb(item));
      logger.info('weekly', `${releaseSource}: ${raw.length} total, ${singles.length} singles, ${tpbs.length} TPBs filtered for ${start}`);
      if (raw.length > 0 && singles.length === 0) {
        // All items were classified as TPBs — log sample types/issue fields for diagnosis
        const sample = raw.slice(0, 5).map(i => ({ type: i.type, issue: i.issue, series: i.series }));
        logger.warn('weekly', 'All items filtered as TPBs — check type/issue fields', { sample });
      }

      // ── Build monitored series lookup ─────────────────────────────
      const monSeries = db.prepare('SELECT * FROM monitored_series').all();

      // sourceNameMap: exact source name (normalised) → series row.
      // Populated when a series is added from the weekly tab — stores the exact
      // FreshComics/Walksoftly name string so matching is always unambiguous,
      // even when multiple CV volumes share the same title (e.g. 5 ASM runs).
      const sourceNameMap = new Map(); // normalisedSourceName → series
      for (const s of monSeries) {
        if (s.source_name) {
          const key = nameKey(s.source_name);
          // Last write wins if two series somehow share a source name —
          // prefer the one with higher (more recent) start year.
          const existing = sourceNameMap.get(key);
          if (!existing || (s.year || 0) > (existing.year || 0)) {
            sourceNameMap.set(key, s);
          }
        }
      }

      // release_cv_map — O(1) (normName+normPub) → cv_volume_id lookup.
      // Pre-seeded from all monitored_series at startup; beats name fuzzy-matching.
      const releaseCvMap = new Map(); // `normName||normPub` → cv_volume_id
      for (const e of db.prepare('SELECT norm_name, norm_publisher, cv_volume_id FROM release_cv_map').all()) {
        releaseCvMap.set(`${e.norm_name}||${e.norm_publisher}`, e.cv_volume_id);
      }

      // nameMap: normalisedName → series[] (array, not single row).
      // Multiple volumes can share the same name (e.g. Amazing Spider-Man 2018
      // and Amazing Spider-Man 2025 both normalise to "amazingspiderman").
      // The old single-value map silently dropped all but the last insert.
      const nameMap = new Map(); // normalisedName → series[]
      for (const s of monSeries) {
        const key = nameKey(s.name);
        if (!nameMap.has(key)) nameMap.set(key, []);
        nameMap.get(key).push(s);
      }

      // Index by CV volume ID — the monitored_series.id IS the Comic Vine volume ID
      const idMap = {}; // cvVolumeId → series row
      for (const s of monSeries) {
        idMap[String(s.id)] = s;
      }

      // Pre-load issue statuses to avoid N+1 queries
      const issuesBySeriesNum = {}; // seriesId → { normNum → status }
      const allMonIssues = db.prepare('SELECT series_id, issue_number, status FROM monitored_issues').all();
      for (const mi of allMonIssues) {
        if (!issuesBySeriesNum[mi.series_id]) issuesBySeriesNum[mi.series_id] = {};
        const norm = String(mi.issue_number || '').replace(/^0+/, '') || '0';
        issuesBySeriesNum[mi.series_id][norm] = mi.status;
      }

      // ── Annotate singles ──────────────────────────────────────────
      const annotated = singles.map(item => {
        const key = nameKey(item.series);

        // 1. CV volume ID match (Walksoftly provides comicid; FreshComics leaves it null)
        let mon = (item.comicid ? idMap[String(item.comicid)] : null) || null;

        // 1a. release_cv_map lookup — persistent (normName+normPub) → CV volume ID table
        //     seeded from all monitored_series at startup. This is the primary matching
        //     path for FreshComics data: unambiguous, no fuzzy matching required.
        if (!mon) {
          const normPub = nameKey(item.publisher);
          const cvId = releaseCvMap.get(`${key}||${normPub}`);
          if (cvId) mon = idMap[cvId] || null;
        }

        // 1b. Source-name exact match — user-confirmed mapping stored when adding
        //     from the weekly tab. Overrides auto seed when user picks a specific volume.
        if (!mon) mon = sourceNameMap.get(key) || null;

        // Helper: given multiple monitored series candidates sharing the same
        // normalised name, pick the best one for this weekly item.
        // Priority:
        //   1. Sole 'ongoing' candidate — a new issue of an ended series won't be
        //      in FreshComics, so if exactly one series is ongoing it must be the one.
        //   2. Among multiple ongoing candidates: the one with this issue in the DB
        //      (but only if status != processed/skipped — otherwise it's a different volume).
        //   3. Among multiple ongoing candidates: most recent start year.
        //   4. No ongoing series: most recent start year as last resort.
        //
        // NOTE: "has the issue in DB" is NOT priority #1 because an ended series that ran
        // 6 issues will have a #2 in monitored_issues, and we'd wrongly pick it over the
        // new ongoing series whose #2 hasn't been fetched from CV yet.
        const pickBest = (candidates) => {
          if (candidates.length === 1) return candidates[0];
          const issNum = String(item.issue || '').replace(/^0+/, '') || '0';

          // 1. Sole ongoing series
          const ongoing = candidates.filter(c => c.series_status === 'ongoing');
          if (ongoing.length === 1) return ongoing[0];

          // 2. Multiple ongoing: prefer one with a non-processed issue match
          if (ongoing.length > 1) {
            const withWanted = ongoing.filter(c => {
              const st = (issuesBySeriesNum[c.id] || {})[issNum];
              return st && st !== 'processed' && st !== 'skipped';
            });
            if (withWanted.length === 1) return withWanted[0];
            // Fall through to most-recent-year among ongoing
            return [...ongoing].sort((a, b) => (b.year || 0) - (a.year || 0))[0];
          }

          // 3. No ongoing series: most recent start year
          return [...candidates].sort((a, b) => (b.year || 0) - (a.year || 0))[0];
        };

        // 2. Exact normalised name match
        if (!mon) {
          const candidates = nameMap.get(key);
          if (candidates?.length) {
            // Filter candidates by publisher compatibility first —
            // prevents Webtoon "Spider-Man" matching Marvel's "Amazing Spider-Man"
            const pubCompatible = candidates.filter(c => publishersCompatible(item.publisher, c.publisher));
            const pool = pubCompatible.length ? pubCompatible : candidates;
            mon = pickBest(pool);
            // Veto the match if publishers are incompatible and no pub-compatible candidate exists
            if (!pubCompatible.length && !publishersCompatible(item.publisher, mon?.publisher)) {
              mon = null;
            }
          }
        }

        // 3. Prefix match with 70% length ratio guard
        if (!mon) {
          for (const [sk, candidates] of nameMap.entries()) {
            if (sk.length > 5 && key.length > 5) {
              const shorter = Math.min(sk.length, key.length);
              const longer  = Math.max(sk.length, key.length);
              if ((key.startsWith(sk) || sk.startsWith(key)) && shorter / longer >= 0.7) {
                const pubCompatible = candidates.filter(c => publishersCompatible(item.publisher, c.publisher));
                const pool = pubCompatible.length ? pubCompatible : candidates;
                const candidate = pickBest(pool);
                // Veto if publishers incompatible
                if (publishersCompatible(item.publisher, candidate?.publisher)) {
                  mon = candidate;
                }
                break;
              }
            }
          }
        }

        // Find issue status.
        // Guard against false matches where the same CV volume ID or series name
        // is reused for a new volume (e.g. Zatanna 2025 vs Zatanna 2026).
        // If the weekly item ships more than 6 months after the matched series'
        // last known issue store_date, discard the match.
        let issueStatus = null;
        if (mon) {
          const serIssues = issuesBySeriesNum[mon.id] || {};
          const issNum = String(item.issue || '').replace(/^0+/, '') || '0';
          issueStatus = serIssues[issNum] || null;

          // Date-gap check: only applies to ended series.
          // If a series is ended and the weekly item ships more than 6 months
          // after its last known issue, this is almost certainly a different
          // volume sharing the same name/CV ID. Ongoing series are exempt —
          // they can have legitimate hiatuses longer than 6 months.
          if (item.shipdate && mon.series_status === 'ended') {
            const lastIssueRow = db.prepare(
              `SELECT store_date, release_date FROM monitored_issues
             WHERE series_id = ? AND store_date IS NOT NULL AND store_date != ''
             ORDER BY store_date DESC LIMIT 1`
            ).get(mon.id);
            const lastDate = lastIssueRow?.store_date || lastIssueRow?.release_date;
            if (lastDate) {
              const monthsGap = (new Date(item.shipdate) - new Date(lastDate)) / (1000 * 60 * 60 * 24 * 30);
              if (monthsGap > 6) {
                mon = null;
                issueStatus = null;
              }
            }
          }
        }

        // Build external links
        const locgIssueUrl = (item.locg_id && item.locg_slug)
          ? `${LOCG_BASE}/comic/${item.locg_id}/${item.locg_slug}` : null;
        const cvVolumeUrl = mon
          ? `https://comicvine.gamespot.com/volume/4050-${mon.id}/` : null;
        const locgSeriesUrl = (mon?.locg_series_id && mon?.locg_series_slug)
          ? `${LOCG_BASE}/comics/series/${mon.locg_series_id}/${mon.locg_series_slug}` : null;

        return {
          id:           item.comicid ? String(item.comicid) : null,
          issue_number: item.issue   || '',
          name:         '',
          store_date:   item.shipdate || start,
          cover_date:   '',
          image_url:    mon?.image_url || null,
          cv_url:       cvVolumeUrl,
          locg_url:     locgIssueUrl,
          locg_series_url: locgSeriesUrl,
          volume: {
            id:         item.comicid ? String(item.comicid) : null,
            name:       item.series  || '',
            publisher:  item.publisher || 'Unknown',
            start_year: mon?.year || null,
            image_url:  mon?.image_url || null,
          },
          monitored:    !!mon,
          monitored_id: mon ? String(mon.id) : null,
          issue_status: issueStatus,
          source:       'comicvine',
          // Internal — used below to seed locg_issue_lookup, stripped before response
          _locg_id:     item.locg_id || null,
          _locg_slug:   item.locg_slug || null,
        };
      });

      // ── Batch-fetch CV cover images for unmonitored series ────────
      const CV_API_KEY = getCVKey();
      const unmonIds = [...new Set(
        annotated
          .filter(a => !a.monitored && a.volume.id)
          .map(a => a.volume.id)
      )];

      const coverMap = {};
      for (let i = 0; i < unmonIds.length; i += 100) {
        const batch = unmonIds.slice(i, i + 100);
        try {
          await new Promise(r => setTimeout(r, 400));
          const vr = await cvApiGet('https://comicvine.gamespot.com/api/volumes/', {
            params: {
              api_key: getCVKey(), format: 'json',
              filter: `id:${batch.join('|')}`,
              field_list: 'id,image',
              limit: 100,
            },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 15000,
          });
          for (const vol of (vr.data.results || [])) {
            coverMap[String(vol.id)] = vol.image?.medium_url || vol.image?.small_url || null;
          }
        } catch (e) {
          logger.warn('weekly', `Cover batch fetch failed: ${e.message}`);
        }
      }

      // Apply fetched covers
      for (const a of annotated) {
        if (!a.monitored && a.volume.id && coverMap[a.volume.id]) {
          a.image_url        = coverMap[a.volume.id];
          a.volume.image_url = coverMap[a.volume.id];
        }
      }

      // ── Seed locg_issue_lookup from this week's LOCG data ────────────
      // Stores (locg_issue_id, slug, cv_series_id) so the background resolver
      // can later fetch issue pages to extract locg_series_id.
      const locgInsert = db.prepare(`
      INSERT OR IGNORE INTO locg_issue_lookup (locg_issue_id, locg_slug, cv_series_id)
      VALUES (?, ?, ?)
    `);
      const locgInsertMany = db.transaction(() => {
        for (const a of annotated) {
          if (a._locg_id && a._locg_slug) {
            locgInsert.run(a._locg_id, a._locg_slug, a.monitored_id || null);
          }
        }
      });
      locgInsertMany();

      // Strip internal fields before sending to client
      for (const a of annotated) {
        delete a._locg_id;
        delete a._locg_slug;
      }

      annotated.sort((a, b) => {
        const pa = a.volume.publisher || '', pb = b.volume.publisher || '';
        if (pa !== pb) return pa.localeCompare(pb);
        return (a.volume.name || '').localeCompare(b.volume.name || '');
      });

      // ── Gap detection — fire background CV refresh for any monitored series
      // where an issue is shipping this week but isn't in our DB yet (status null).
      // Use mon.id from the DB match, NOT a.volume.id from Walksoftly — Walksoftly's
      // comicid can be null or stale for newer series (e.g. Absolute imprint titles)
      // while the name-match still correctly identifies the monitored series.
      const gapSeriesIds = new Set(
        annotated
          .filter(a => a.monitored && a.issue_status === null && a.monitored_id)
          .map(a => a.monitored_id)  // always the verified DB series ID
      );
      if (gapSeriesIds.size > 0) {
        logger.info('weekly', `Gap detected for ${gapSeriesIds.size} monitored series — triggering background CV refresh`, { ids: [...gapSeriesIds] });
        setImmediate(async () => {
          for (const sid of gapSeriesIds) {
            try {
              const { inserted } = await refreshSeriesIssuesFromCV(sid);
              if (inserted > 0) logger.info('weekly', `Gap-fill: series ${sid} +${inserted} new issues`);
              await new Promise(r => setTimeout(r, 700));
            } catch (e) {
              logger.warn('weekly', `Gap-fill failed for series ${sid}`, e.message);
            }
          }
        });
      }

      res.json({
        start, end: endStr,
        total_fetched:  raw.length,
        total_singles:  annotated.length,
        total_tpbs_filtered: tpbs.length,
        source: 'comicvine',
        issues: annotated,
        // Diagnostic info — useful when the tab shows 0 results so the UI
        // can surface a hint rather than just a blank "No single issues found."
        _debug: {
          release_source: releaseSource,
          locg_url: (() => {
            const d = new Date(start + 'T12:00:00Z');
            return `https://leagueofcomicgeeks.com/comic/get_comics?list=releases&view=thumbs&format[]=1&date_type=week&date=${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()}&order=pulls`;
          })(),
          freshcomics_url: (() => {
            const wed = new Date(start + 'T12:00:00Z');
            wed.setUTCDate(wed.getUTCDate() + 2);
            return `https://freshcomics.us/issues/${wed.toISOString().slice(0, 10)}`;
          })(),
          walksoftly_week: getLocgWeekNum(start),
          walksoftly_url: (() => {
            const wk = getLocgWeekNum(start);
            const yr = new Date(start + 'T12:00:00Z').getUTCFullYear();
            return `https://walksoftly.itsaninja.party/newcomics.php?week=${String(wk).padStart(2,'0')}&year=${yr}`;
          })(),
          raw_count: raw.length,
          singles_count: singles.length,
          tpbs_filtered: tpbs.length,
        },
      });
    } catch (e) {
      logger.error('weekly', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Debug: raw weekly release data from all three sources for a given week.
  // Usage: GET /api/weekly/debug-locg?date=2026-05-19
  // ─── Release sources compared (admin, 2026-10-26) ─────────────────
  // One week from the current weekly source (League of Comic Geeks → FreshComics, as the Weekly tab)
  // and from Metron's issue list (official API), each matched to monitored series, against the
  // monitored issues Comic Vine dates to that week. Written to the backups folder as
  // release-compare-<start>.json for analysis on the host. GET /api/admin/releases/compare?start=YYYY-MM-DD (a Monday).
  app.get('/api/admin/releases/compare', requireAdmin, async (req, res) => {
    const start = String(req.query.start || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return res.status(400).json({ error: 'start=YYYY-MM-DD (a Monday) required' });
    const endD = new Date(start + 'T12:00:00Z'); endD.setUTCDate(endD.getUTCDate() + 6);
    const end = endD.toISOString().slice(0, 10);
    const nm = x => String(x || '').toLowerCase().replace(/&/g, ' and ').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
    const nn = x => { const t = String(x ?? '').trim().replace(/^#/, ''); return /^\d+(\.\d+)?$/.test(t) ? String(parseFloat(t)) : t.toLowerCase(); };
    const out = { start, end, at: new Date().toISOString() };
    try {
      // Monitored series and the monitored issues Comic Vine dates to this week (store date, else release date).
      const series = db.prepare("SELECT id, name, year, publisher, status FROM monitored_series").all();
      const byNameYear = new Map(), byName = new Map();
      for (const s of series) { byNameYear.set(`${nm(s.name)}|${s.year}`, s); if (!byName.has(nm(s.name))) byName.set(nm(s.name), []); byName.get(nm(s.name)).push(s); }
      const issueStatus = db.prepare('SELECT id, status FROM monitored_issues WHERE series_id = ? AND issue_number = ?');
      const yours = db.prepare(`SELECT i.id AS cv_issue_id, i.series_id, s.name, s.year, i.issue_number, COALESCE(i.store_date, i.release_date) AS date, i.status
      FROM monitored_issues i JOIN monitored_series s ON s.id = i.series_id
      WHERE COALESCE(i.store_date, i.release_date) BETWEEN ? AND ? AND s.status = 'active'`).all(start, end);
      out.monitored_this_week = yours.map(y => ({ ...y, key: `${y.series_id}|${nn(y.issue_number)}` }));

      // Current weekly source, through the Weekly tab's own route (same matching as the app).
      try {
        const r = await axios.get(`http://127.0.0.1:${PORT}/api/weekly`, { params: { start }, timeout: 300000,
          headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}), ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}) } });
        const items = r.data.issues || [];
        out.weekly = { source: r.data._debug?.release_source || r.data.source, fetched: r.data.total_fetched, singles: items.length, tpbs_filtered: r.data.total_tpbs_filtered,
          issues: items.map(a => ({ name: a.volume?.name || a.series_name || a.name || null, number: a.issue_number ?? a.number ?? null, publisher: a.volume?.publisher || a.publisher || null,
            monitored_id: a.monitored_id || null, issue_status: a.issue_status ?? null, pulls: a.pulls ?? a.pull_count ?? null })) };
        out.weekly.monitored = out.weekly.issues.filter(i => i.monitored_id).length;
      } catch (e) { out.weekly = { error: e.message }; }

      // Metron: every issue with a store date in the week (official API; paged, spaced, cached by the client).
      try {
        const list = [];
        let next = 'issue/', params = { store_date_range_after: start, store_date_range_before: end }, pages = 0;
        while (next && pages < 15) {
          const d = await metron.get(next, params);
          pages++; params = null;
          for (const i of (d && d.results) || []) list.push({ id: i.id, name: i.series?.name || '', volume_year: i.series?.year_began || null, number: String(i.number ?? ''),
            store_date: i.store_date || null, cover_date: i.cover_date || null, cv_id: i.cv_id || null, publisher: i.series?.publisher?.name || null });
          next = d && d.next ? d.next : null;
        }
        for (const i of list) {
          const s = byNameYear.get(`${nm(i.name)}|${i.volume_year}`) || ((byName.get(nm(i.name)) || []).length === 1 ? byName.get(nm(i.name))[0] : null);
          i.monitored_id = s ? s.id : null;
          i.match = s ? (byNameYear.has(`${nm(i.name)}|${i.volume_year}`) ? 'name+year' : 'name') : null;
          i.issue_status = s ? (issueStatus.get(s.id, i.number)?.status || null) : null;
        }
        out.metron = { pages, issues: list, monitored: list.filter(i => i.monitored_id).length, with_cv_id: list.filter(i => i.cv_id).length };
      } catch (e) { out.metron = { error: e.message, code: e.code || null }; }

      // Which of your monitored issues each source found.
      const found = list => new Set((list || []).filter(i => i.monitored_id).map(i => `${i.monitored_id}|${nn(i.number)}`));
      const wSet = found(out.weekly.issues), mSet = found(out.metron.issues);
      out.summary = {
        monitored_this_week: out.monitored_this_week.length,
        weekly: out.weekly.error ? { error: out.weekly.error } : { source: out.weekly.source, singles: out.weekly.singles, matched_to_monitored: out.weekly.monitored,
          found_of_yours: out.monitored_this_week.filter(y => wSet.has(y.key)).length },
        metron: out.metron.error ? { error: out.metron.error } : { issues: out.metron.issues.length, matched_to_monitored: out.metron.monitored, with_cv_id: out.metron.with_cv_id,
          found_of_yours: out.monitored_this_week.filter(y => mSet.has(y.key)).length },
      };
      let file = null;
      try { file = path.join(DB_BACKUP_DIR, `release-compare-${start}.json`); fs.writeFileSync(file, JSON.stringify(out, null, 1)); } catch { file = null; }
      res.json({ ...out.summary, file });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/weekly/debug-locg', requireAdmin, async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
    try {
      // LOCG
      const ld    = new Date(date + 'T12:00:00Z');
      const locgUrl = `https://leagueofcomicgeeks.com/comic/get_comics?list=releases&view=thumbs&format%5B%5D=1%2C6&date_type=week&date=${encodeURIComponent(`${ld.getUTCMonth()+1}/${ld.getUTCDate()}/${ld.getUTCFullYear()}`)}&order=pulls`;
      const locgData = await fetchLOCG(date);

      // FreshComics
      const wed = new Date(date + 'T12:00:00Z');
      wed.setUTCDate(wed.getUTCDate() + 2);
      const freshUrl  = `https://freshcomics.us/issues/${wed.toISOString().slice(0, 10)}`;
      const freshData = await fetchFreshComics(date);

      // Walksoftly (legacy)
      const week    = getLocgWeekNum(date);
      const year    = new Date(date + 'T12:00:00Z').getUTCFullYear();
      const weekStr = String(week).padStart(2, '0');
      const wsUrl   = `https://walksoftly.itsaninja.party/newcomics.php?week=${weekStr}&year=${year}`;
      const wsData  = await fetchWalksoftly(date);

      // Best available data
      const data   = locgData.length > 0 ? locgData : (freshData.length > 0 ? freshData : wsData);
      const source = locgData.length > 0 ? 'locg' : (freshData.length > 0 ? 'freshcomics' : (wsData.length > 0 ? 'walksoftly' : 'none'));

      const fieldNames = data.length ? Object.keys(data[0]) : [];
      const typeValues = [...new Set(data.map(d => d.type).filter(Boolean))];
      const singles    = data.filter(d => !isLocgTpb(d));
      const tpbs       = data.filter(d => isLocgTpb(d));

      res.json({
        date, source,
        locg:       { url: locgUrl,  count: locgData.length },
        freshcomics: { url: freshUrl, count: freshData.length },
        walksoftly:  { url: wsUrl, week, weekStr, year, count: wsData.length },
        total: data.length,
        singles: singles.length,
        tpbs_filtered: tpbs.length,
        field_names: fieldNames,
        type_values_present: typeValues,
        sample_items: data.slice(0, 5),
        all_data: data,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Debug: show exactly how a FreshComics series name resolves against monitored series.
  // Usage: GET /api/debug/weekly-match?name=Zatanna&publisher=DC+Comics&issue=1
  app.get('/api/debug/weekly-match', async (req, res) => {
    const { name, publisher, issue } = req.query;
    if (!name) return res.status(400).json({ error: 'name required' });

    const key     = nameKey(name);
    const issNum  = String(issue || '').replace(/^0+/, '') || '0';

    const monSeries = db.prepare('SELECT id, name, publisher, year, series_status, source_name FROM monitored_series').all();

    // Exact match candidates
    const exactCandidates = monSeries.filter(s =>
      nameKey(s.name) === key
    );

    // Prefix match candidates
    const prefixCandidates = monSeries.filter(s => {
      const sk = nameKey(s.name);
      if (sk.length <= 5 || key.length <= 5) return false;
      return key.startsWith(sk) || sk.startsWith(key);
    });

    // Source name match
    const sourceMatch = monSeries.find(s =>
      s.source_name && nameKey(s.source_name) === key
    );

    // Issue counts per candidate
    const issueInfo = (id) => {
      const total = db.prepare('SELECT COUNT(*) as c FROM monitored_issues WHERE series_id = ?').get(id);
      const specific = db.prepare('SELECT status FROM monitored_issues WHERE series_id = ? AND issue_number = ?').get(id, issNum);
      return { total_issues_in_db: total?.c, issue_status: specific?.status ?? null };
    };

    res.json({
      query: { name, key, publisher, issue, issNum },
      source_name_match: sourceMatch ? { id: sourceMatch.id, name: sourceMatch.name, year: sourceMatch.year } : null,
      exact_match_candidates: exactCandidates.map(s => ({ id: s.id, name: s.name, year: s.year, series_status: s.series_status, ...issueInfo(s.id) })),
      prefix_match_candidates: prefixCandidates.map(s => ({ id: s.id, name: s.name, year: s.year, series_status: s.series_status, ...issueInfo(s.id) })),
    });
  });

  // Debug: dump raw FlareSolverr response for the LOCG page and API URL.
  // Usage: GET /api/debug/locg-raw?date=2026-05-25
  app.get('/api/debug/locg-raw', async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
    try {
      const monday = new Date(date + 'T12:00:00Z');
      const wednesday = new Date(monday);
      wednesday.setUTCDate(monday.getUTCDate() + 2);
      const wedStr = wednesday.toISOString().slice(0, 10);
      const [year, month, day] = wedStr.split('-');
      const pageUrl = `${LOCG_BASE}/comics/new-comics/${year}/${month}/${day}`;
      const apiDate = `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;
      const apiUrl  = `${LOCG_BASE}/comic/get_comics?list=releases&view=thumbs` +
                      `&format[]=1&date_type=week&date=${encodeURIComponent(apiDate)}&order=pulls`;

      // Fetch page via FS (with wait)
      const pageFs = await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd: 'request.get', url: pageUrl, maxTimeout: 90000, wait: 8000,
      }, { timeout: 100000 });
      const pageSol = pageFs.data?.solution;

      // Fetch API via FS
      const apiFs = await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd: 'request.get', url: apiUrl, maxTimeout: 60000,
      }, { timeout: 65000 });
      const apiSol = apiFs.data?.solution;

      // Try to parse the API response
      let apiParsed = null;
      let apiParseError = null;
      let apiListPreview = null;
      if (apiSol?.status === 200 && apiSol.response) {
        try {
          const raw = apiSol.response.replace(/<[^>]+>/g, '').trim();
          const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
          const decodedList = (data?.list || '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
          apiListPreview = decodedList.slice(0, 3000);
          apiParsed = parseLOCGHtml(decodedList, wedStr);
        } catch (pe) {
          apiParseError = pe.message;
        }
      }

      // Try to parse page response
      const pageParsed = (pageSol?.status === 200 && pageSol.response)
        ? parseLOCGHtml(pageSol.response, wedStr)
        : null;

      res.json({
        wednesday: wedStr,
        page: {
          url: pageUrl,
          fs_status: pageFs.data?.status,
          solution_status: pageSol?.status,
          response_length: pageSol?.response?.length,
          response_preview: pageSol?.response?.slice(0, 2000),
          cookies: pageSol?.cookies?.map(c => c.name),
          parsed_count: pageParsed?.length ?? null,
          parsed_sample: pageParsed?.slice(0, 5) ?? null,
        },
        api: {
          url: apiUrl,
          fs_status: apiFs.data?.status,
          solution_status: apiSol?.status,
          response_length: apiSol?.response?.length,
          response_preview: apiSol?.response?.slice(0, 500),
          list_preview: apiListPreview,
          parse_error: apiParseError,
          parsed_count: apiParsed?.length ?? null,
          parsed_sample: apiParsed?.slice(0, 5) ?? null,
        },
      });
    } catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
  });

  // Debug: check if LOCG data-comic IDs exist in monitored_issues (are they CV issue IDs?)
  // Usage: GET /api/debug/locg-id-check?ids=1127152,7203519,7972288
  app.get('/api/debug/locg-id-check', (req, res) => {
    const { ids } = req.query;
    if (!ids) return res.status(400).json({ error: 'ids=comma,separated,ids required' });
    const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
    const results = idList.map(id => {
      const issue = db.prepare('SELECT id, series_id, issue_number, status FROM monitored_issues WHERE id = ?').get(id);
      let series = null;
      if (issue) {
        series = db.prepare('SELECT id, name, publisher, year, series_status FROM monitored_series WHERE id = ?').get(issue.series_id);
      }
      return { locg_data_comic: id, found: !!issue, issue, series };
    });
    res.json({ checked: idList.length, results });
  });

  // Debug: probe LOCG series search API and issue page structure.
  // Usage: GET /api/debug/locg-series-probe?issue_id=8193797&name=Absolute+Wonder+Woman
  app.get('/api/debug/locg-series-probe', async (req, res) => {
    const { issue_id = '8193797', name = 'Absolute Wonder Woman' } = req.query;
    const results = {};

    const htmlDecode = s => s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)));

    const extractSeriesHits = html => {
      const hits = [...html.matchAll(/href="\/comics\/series\/(\d+)\/([^"]+)"/g)]
        .map(m => ({ series_id: m[1], slug: m[2] }));
      return [...new Map(hits.map(h => [h.series_id, h])).values()]; // dedupe
    };

    // ── 1. Issue page WITH full slug + wait so AJAX content renders ──────────
    // ID-only URL redirects to homepage. Must include slug.
    const { slug = 'absolute-wonder-woman-20' } = req.query;
    try {
      const issueUrl = `${LOCG_BASE}/comic/${issue_id}/${slug}`;
      const r = await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd: 'request.get', url: issueUrl, maxTimeout: 60000, wait: 5000,
      }, { timeout: 70000 });
      const html = r.data?.solution?.response || '';
      const seriesHits = extractSeriesHits(html);
      const idx = html.indexOf('/comics/series/');

      results.issue_page = {
        url: issueUrl,
        status: r.data?.solution?.status,
        response_length: html.length,
        series_links: seriesHits.slice(0, 5),
        series_href_context: idx >= 0 ? html.slice(Math.max(0, idx - 80), idx + 200) : null,
        data_attrs: (html.match(/\bdata-\w+="[^"]+"/g) || [])
          .filter(a => /series|volume|comic/i.test(a)).slice(0, 20),
      };
    } catch (e) {
      results.issue_page = { error: e.message };
    }

    // ── 2. get_comics?list=series — decode entity-encoded list HTML ───────────
    // Try both query param names; also try with series_id from issue URL in case
    // LOCG has a "get series for this issue" mode.
    const apiCandidates = [
      { label: 'query param',  url: `${LOCG_BASE}/comic/get_comics?list=series&query=${encodeURIComponent(name)}&view=list&order=pulls` },
      { label: 'search param', url: `${LOCG_BASE}/comic/get_comics?list=series&search=${encodeURIComponent(name)}&view=list` },
      { label: 'series_id issue lookup', url: `${LOCG_BASE}/comic/get_comics?list=series&comic_id=${issue_id}` },
    ];

    results.api_probes = [];
    for (const { label, url } of apiCandidates) {
      try {
        const r = await axios.post(`${FLARESOLVERR_URL}/v1`, {
          cmd: 'request.get', url, maxTimeout: 30000,
        }, { timeout: 35000 });
        const raw = r.data?.solution?.response || '';
        const stripped = raw.replace(/<[^>]+>/g, '').trim();
        let json = null;
        try { json = JSON.parse(stripped.match(/\{[\s\S]*\}/)?.[0] || stripped); } catch {}

        // Decode the `list` field and look for series IDs
        const rawList = json?.list || '';
        const decodedList = rawList ? htmlDecode(rawList) : '';
        const seriesHits = extractSeriesHits(decodedList);

        // Also look for series IDs directly in raw response (unencoded)
        const rawHits = extractSeriesHits(raw);

        results.api_probes.push({
          label, url,
          status: r.data?.solution?.status,
          response_length: raw.length,
          json_keys: json ? Object.keys(json) : null,
          count: json?.count ?? null,
          configurator: json?.configurator ?? null,
          series_in_decoded_list: seriesHits.slice(0, 10),
          series_in_raw: rawHits.slice(0, 5),
          decoded_list_preview: decodedList.slice(0, 1000),
          json_preview: stripped.slice(0, 300),
        });
      } catch (e) {
        results.api_probes.push({ label, url, error: e.message });
      }
      await new Promise(r => setTimeout(r, 600));
    }

    res.json(results);
  });
  return {};
};
