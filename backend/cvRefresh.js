'use strict';
// ─── Comic Vine issue refresh and series status (moved out of server.js 2026-11-23, server.js split step 7B) ───
// refreshSeriesIssuesFromCV (add a series' new Comic Vine issues), the Download Manager's refresh-cv
// route, and the series status helpers (from series.json, or from Comic Vine). Moved unchanged.
const fs = require('fs');
const path = require('path');

const NEEDS = ['app', 'cvApiGet', 'db', 'getCVKey', 'logger', 'requireAdmin'];
module.exports.NEEDS = NEEDS;

module.exports.createCvRefresh = function createCvRefresh(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createCvRefresh: missing ${missing.join(', ')}`);
  const { app, cvApiGet, db, getCVKey, logger, requireAdmin } = deps;
  // ─── CV data refresh ─────────────────────────────────────────────
  // Re-fetches cv_data for all issues in a series from Comic Vine.
  // Use after a series' credits/details have been updated on CV.

  // ─── Shared CV issue refresh ──────────────────────────────────────
  /**
   * Fetch all issues for a series from CV and INSERT any new ones.
   * Also UPDATEs cv_data/title on existing rows.
   * Returns { inserted, updated } counts.
   * Safe to call any time — INSERT OR IGNORE means no duplicates.
   */
  async function refreshSeriesIssuesFromCV(seriesId) {
    const CV_API_KEY = getCVKey();
    let offset = 0, allIssues = [], total = Infinity;

    while (allIssues.length < total) {
      const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
        params: {
          api_key: getCVKey(), format: 'json',
          filter: `volume:${seriesId}`,
          field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
          offset, limit: 100,
        },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 15000,
      });
      total = r.data.number_of_total_results || 0;
      const results = r.data.results || [];
      allIssues = allIssues.concat(results);
      if (!results.length) break;
      offset += 100;
      if (allIssues.length < total) await new Promise(res => setTimeout(res, 600));
    }

    const isAnnualCV = (num, name) =>
      ((num || '') + ' ' + (name || '')).toLowerCase().includes('annual') ? 1 : 0;

    const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO monitored_issues
      (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const updateStmt = db.prepare(`
    UPDATE monitored_issues
    SET cv_data = ?, title = ?,
        release_date = COALESCE(?, release_date), store_date = COALESCE(?, store_date)
    WHERE id = ? AND series_id = ?
  `);

    let inserted = 0, updated = 0;
    db.transaction(issues => {
      for (const i of issues) {
        const ins = insertStmt.run(
          String(i.id), seriesId, i.issue_number || '0',
          i.name || null, i.cover_date || null, i.store_date || null,
          JSON.stringify(i), isAnnualCV(i.issue_number, i.name)
        );
        if (ins.changes > 0) {
          inserted++;
        } else {
          updateStmt.run(JSON.stringify(i), i.name || null, i.cover_date || null, i.store_date || null, String(i.id), seriesId);
          updated++;
        }
      }
    })(allIssues);

    db.prepare(`
    UPDATE monitored_series
    SET last_cv_check = datetime('now'),
        total_issues  = (SELECT COUNT(*) FROM monitored_issues WHERE series_id = ?)
    WHERE id = ?
  `).run(seriesId, seriesId);

    return { inserted, updated, total: allIssues.length };
  }

  app.post('/api/monitor/series/:id/refresh-cv', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(id);
    if (!series) return res.status(404).json({ error: 'Series not found' });
    try {
      const { inserted, updated, total } = await refreshSeriesIssuesFromCV(id);
      logger.info('cv-refresh', `Series ${id}: ${total} issues (${inserted} new, ${updated} updated)`);
      fetchAndSetSeriesStatus(id).catch(() => {});
      res.json({ success: true, total, inserted, updated });
    } catch (e) {
      logger.error('cv-refresh', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // ─── Series status helpers ─────────────────────────────────────────
  /**
   * Derive ongoing/ended from series.json (primary) or CV API (fallback).
   * series.json sets metadata.status = 'Continuing' | 'Ended'
   * and metadata.publication_run containing 'Present' for ongoing.
   */
  function deriveStatusFromSeriesJson(directory) {
    try {
      const jsonPath = path.join(directory, 'series.json');
      if (!fs.existsSync(jsonPath)) return null;
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const m = data?.metadata;
      if (!m) return null;
      const status = (m.status || '').toLowerCase();
      const pubRun = (m.publication_run || '').toLowerCase();
      if (status === 'continuing' || pubRun.includes('present')) return 'ongoing';
      if (status === 'ended' || status === 'completed' || status === 'cancelled') return 'ended';
      return null;
    } catch { return null; }
  }

  async function fetchAndSetSeriesStatus(seriesId) {
    // 1. Try series.json first — it's already on disk, no API call needed
    const series = db.prepare('SELECT directory FROM monitored_series WHERE id = ?').get(String(seriesId));
    if (series) {
      const fromJson = deriveStatusFromSeriesJson(series.directory);
      if (fromJson) {
        db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(fromJson, String(seriesId));
        logger.info('series-status', `Series ${seriesId} → ${fromJson} (from series.json)`);
        return;
      }
    }
    // 2. Fallback: CV API volume endpoint — use last_issue.cover_date for recency check.
    // Thresholds (from last issue cover_date):
    //   < 12 months  → ongoing  (actively publishing)
    //   12–24 months → unknown  (possible hiatus; keep polling)
    //   > 24 months  → ended    (almost certainly wrapped up; stop polling)
    // NOTE: last_issue being present does NOT mean ended — CV sets it for every volume.
    try {
      const r = await cvApiGet(`https://comicvine.gamespot.com/api/volume/4050-${seriesId}/`, {
        params: { api_key: getCVKey(), format: 'json', field_list: 'id,last_issue,count_of_issues' },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 10000,
      });
      const vol = r.data?.results;
      if (!vol) return;

      let status = 'unknown';
      const coverDate = vol.last_issue?.cover_date; // "YYYY-MM-DD" or "YYYY-MM-00"
      if (coverDate) {
        const issueYear  = parseInt(coverDate.slice(0, 4), 10);
        const issueMonth = parseInt(coverDate.slice(5, 7), 10) || 1;
        const issueMs    = Date.UTC(issueYear, issueMonth - 1, 1);
        const now        = Date.now();
        const twelveMonthsAgo     = now - 365 * 24 * 60 * 60 * 1000;
        const twentyFourMonthsAgo = now - 2 * 365 * 24 * 60 * 60 * 1000;
        if      (issueMs >= twelveMonthsAgo)     status = 'ongoing';
        else if (issueMs <= twentyFourMonthsAgo) status = 'ended';
        // 12–24 month gap stays 'unknown' — possible hiatus, keep polling
      }

      // Only downgrade ongoing → ended, never silently flip ended → unknown via this path.
      // (series.json is the authoritative override for confirmed status.)
      const current = db.prepare('SELECT series_status FROM monitored_series WHERE id = ?').get(String(seriesId));
      if (current?.series_status === 'ended' && status !== 'ongoing') {
        // Already ended and no evidence of new activity — leave it alone.
        logger.debug('series-status', `Series ${seriesId} already ended, no change`);
        return;
      }

      db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(status, String(seriesId));
      logger.info('series-status', `Series ${seriesId} → ${status} (from CV API, last_issue: ${coverDate || 'none'})`);
    } catch (e) {
      logger.warn('series-status', `Could not fetch status for ${seriesId}`, e.message);
    }
  }
  return { deriveStatusFromSeriesJson, fetchAndSetSeriesStatus, refreshSeriesIssuesFromCV };
};
