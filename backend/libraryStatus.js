'use strict';
// ─── Library series status check (2026-11-12) ─────────────────────
// Series in the library that are not monitored never had their series.json status checked
// again after the first enrichment, so one-shots from the 1990s could still say
// "Continuing … Present". This job looks only at series.json files that claim the series is
// still running (ended series stay ended), oldest start year first, a few per hour.
// Metron answers first when a token is set (it has its own allowance): "Completed" or
// "Cancelled" ends the series with no Comic Vine request. Otherwise one Comic Vine request
// gets the newest issue and the issue count, and the rules in seriesStatus.js decide:
//   • Newest issue within 4 months (or Metron "Ongoing" within a year) → still ongoing;
//     checked again in 30 days.
//   • Older → Ended, with the run closed at that issue's month ("April 1998").
//   • No answer from either → left alone; checked again in 90 days.
const { decideSeriesStatus } = require('./seriesStatus');

const PER_RUN = 20;
const ONGOING_RECHECK_DAYS = 30;
const UNKNOWN_RECHECK_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthYear(d) {
  const y = parseInt(String(d || '').slice(0, 4), 10), m = parseInt(String(d || '').slice(5, 7), 10);
  return y && m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${y}` : null;
}

function claimsOngoing(m) {
  return !!m && ((m.status || '').toLowerCase() === 'continuing' || /present/i.test(m.publication_run || ''));
}

function initLibraryStatus(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS library_status_checks (
    comicid    TEXT PRIMARY KEY,
    path       TEXT,
    checked_at INTEGER NOT NULL,      -- ms since epoch
    result     TEXT NOT NULL          -- ongoing | ended | unknown
  )`);
}

// Library series due a check: series.json says it is still running, the folder is not a
// monitored series (the weekly Comic Vine check covers those), and it is not recently checked.
function dueSeries(db, now = Date.now(), limit = PER_RUN) {
  const monitored = new Set(db.prepare('SELECT directory FROM monitored_series WHERE directory IS NOT NULL').all().map(r => r.directory));
  const checks = new Map(db.prepare('SELECT comicid, checked_at, result FROM library_status_checks').all().map(r => [r.comicid, r]));
  const due = [];
  for (const row of db.prepare('SELECT path, series_json FROM scanned_series WHERE series_json IS NOT NULL').all()) {
    if (monitored.has(row.path)) continue;
    let m;
    try { const d = JSON.parse(row.series_json); m = d && typeof d === 'object' && !Array.isArray(d) ? d.metadata : null; } catch { continue; }
    if (!m || typeof m !== 'object' || !claimsOngoing(m)) continue;
    const comicid = String(m.comicid ?? '');
    if (!/^\d+$/.test(comicid)) continue;
    const c = checks.get(comicid);
    if (c) {
      const wait = (c.result === 'unknown' ? UNKNOWN_RECHECK_DAYS : ONGOING_RECHECK_DAYS) * DAY;
      if (now - c.checked_at < wait) continue;
    }
    const year = parseInt(m.year, 10);
    due.push({ path: row.path, comicid, name: m.name || comicid, year: Number.isFinite(year) ? year : 9999, checked: c ? c.checked_at : 0 });
  }
  // Never-checked first, then oldest start year (the clearest cases), then least recently checked.
  due.sort((a, b) => (a.checked > 0) - (b.checked > 0) || a.year - b.year || a.checked - b.checked);
  return due.slice(0, limit);
}

// The series.json changes for one Comic Vine answer. latestDate decides the status (store
// date when known); lastCover, the cover month that closes the run. Returns { status, changes, metadata }.
function applyFacts(metadata, { latestDate = null, lastCover = null, issueCount = null, metron = null, yearEnd = null }, now = Date.now()) {
  const m = { ...metadata };
  const v = decideSeriesStatus({ latestDate, issueCount: issueCount || 0, metron, now });
  const changes = [];
  if (v.status === 'unknown') return { status: 'unknown', reason: v.reason, changes, metadata: m };
  const start = String(m.publication_run || '').split(' - ')[0].trim() || (m.year ? String(m.year) : null);
  const last = monthYear(lastCover || latestDate) || (yearEnd ? String(yearEnd) : null);   // the run is shown by cover month
  const status = v.status === 'ongoing' ? 'Continuing' : 'Ended';
  const run = !start ? null : v.status === 'ongoing' ? `${start} - Present` : (!last || last === start || start.endsWith(` ${last}`) ? start : `${start} - ${last}`);
  if (m.status !== status) { changes.push(`status ${m.status || '—'} → ${status}`); m.status = status; }
  if (run && m.publication_run !== run) { changes.push(`run → ${run}`); m.publication_run = run; }
  if (Number.isFinite(issueCount) && issueCount > 0 && m.total_issues !== issueCount) {
    changes.push(`issues ${m.total_issues ?? '—'} → ${issueCount}`); m.total_issues = issueCount;
  }
  return { status: v.status, reason: v.reason, changes, metadata: m };
}

// One run: up to PER_RUN series. lookup(comicid, { name, year }) → { latestDate, lastCover,
// issueCount, metron, yearEnd } (throws err.code 'CV_RATE_LIMIT' when the Comic Vine hour is
// used up; the run stops and resumes next hour).
function createLibraryStatusCheck({ db, lookup, readSeriesJson, writeSeriesJson, logger, now = Date.now, pause = () => Promise.resolve() }) {
  initLibraryStatus(db);
  const record = db.prepare(`INSERT INTO library_status_checks (comicid, path, checked_at, result) VALUES (?, ?, ?, ?)
    ON CONFLICT(comicid) DO UPDATE SET path = excluded.path, checked_at = excluded.checked_at, result = excluded.result`);
  let running = false;
  return async function run({ limit = PER_RUN } = {}) {
    if (running) return { skipped: true };
    running = true;
    const stats = { checked: 0, ended: 0, ongoing: 0, unknown: 0, failed: 0, rateLimited: false };
    try {
      for (const s of dueSeries(db, now(), limit)) {
        let facts;
        try { facts = await lookup(s.comicid, { name: s.name, year: s.year === 9999 ? null : s.year }); }
        catch (e) {
          if (e.code === 'CV_RATE_LIMIT') { stats.rateLimited = true; break; }
          stats.failed++; logger.warn('library-status', `Status check failed for "${s.name}"`, e.message);
          record.run(s.comicid, s.path, now(), 'unknown'); await pause(); continue;
        }
        stats.checked++;
        // Re-read the file: it may have changed since the library scan cached it.
        let data;
        try { data = readSeriesJson(s.path); } catch { data = null; }
        const m = data && data.metadata;
        if (!m || String(m.comicid ?? '') !== s.comicid || !claimsOngoing(m)) { record.run(s.comicid, s.path, now(), 'ended'); continue; }
        const out = applyFacts(m, facts || {}, now());
        if (out.changes.length) {
          try {
            writeSeriesJson(s.path, { ...data, metadata: out.metadata });
            logger.info('library-status', `${m.name || s.comicid}: ${out.changes.join(', ')} (${out.reason})`);
          } catch (e) {
            stats.failed++; logger.warn('library-status', `Could not write series.json for "${s.name}"`, e.message);
            await pause(); continue;
          }
        }
        stats[out.status]++;
        record.run(s.comicid, s.path, now(), out.status);
        await pause();
      }
    } finally { running = false; }
    if (stats.checked || stats.failed) logger.info('library-status', 'Run complete', stats);
    return stats;
  };
}

// The weekly Comic Vine check: when the hourly allowance runs out, wait for it to reset and
// carry on rather than skipping the rest of the list. Returns true when the caller should
// retry the same series. state: { waits } shared across one poll; maxWaits bounds the run.
async function waitForCvReset(e, state, { sleep, logger, now = Date.now, maxWaits = 6 }) {
  if (!e || e.code !== 'CV_RATE_LIMIT' || !e.retryAt || state.waits >= maxWaits) return false;
  state.waits++;
  const ms = Math.max(0, e.retryAt - now()) + 5000;
  logger.info('cvpoller', `Comic Vine hourly allowance used — waiting ${Math.ceil(ms / 60000)} min, then continuing`);
  await sleep(ms);
  return true;
}

module.exports = { initLibraryStatus, dueSeries, applyFacts, createLibraryStatusCheck, waitForCvReset, claimsOngoing, PER_RUN };
