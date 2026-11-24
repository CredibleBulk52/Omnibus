'use strict';
// ─── Comic Vine's hour, as Comic Vine counts it (2026-11-24) ───────────────────────────────────────
// Measured with a fresh API key against Comic Vine's own usage page (claude/COMICVINE.md):
//   - one timer for every path (issue, issues, volume, search …), started by the first request;
//   - a request on a path not yet used in the current hour restarts that timer at 60 minutes
//     (a /search at 3:22 moved every path's reset from 4:08 to 4:22);
//   - requests on paths already used do not move it (requests at 4:08 left the 4:22 reset alone);
//   - each path keeps its own count (limit 200), and every count goes back to 0 when the timer runs out;
//   - /types (the key check) is not counted.
// Until this date Omnibus gave each path its own hour from its first request, so a long import
// (one hour that Comic Vine kept extending) was refused at 200 while Omnibus counted 80.
//
// State: one row in cv_windows (resource '*': start, ends). The paths already used in the current
// hour and the counts are read from cv_api_log, which is kept for as long as the hour lasts.
const HOUR_MS = 60 * 60 * 1000;
const UNCOUNTED = new Set(['types']);
const SHARED = '*';

function createCvWindows(db, { hourMs = HOUR_MS } = {}) {
  try { db.exec('ALTER TABLE cv_windows ADD COLUMN ends INTEGER'); } catch {}
  const readRow = () => db.prepare('SELECT start, ends FROM cv_windows WHERE resource = ?').get(SHARED);
  const save = (start, ends) => db.prepare('INSERT OR REPLACE INTO cv_windows (resource, start, ends) VALUES (?, ?, ?)').run(SHARED, start, ends);
  const usedSince = (resource, start) => db.prepare('SELECT COUNT(*) AS n FROM cv_api_log WHERE resource = ? AND ts >= ?').get(resource, start).n;

  // The hour as the log says it went (no saved row yet: the first run after this change, or a
  // restored database). Replays the logged requests with the rules above.
  function fromLog(now) {
    let start = null, ends = null, used = new Set();
    for (const r of db.prepare('SELECT ts, resource FROM cv_api_log WHERE ts > ? AND ts <= ? ORDER BY ts, id').all(now - 3 * hourMs, now)) {
      if (UNCOUNTED.has(r.resource)) continue;
      if (start === null || r.ts >= ends) { start = r.ts; ends = r.ts + hourMs; used = new Set([r.resource]); continue; }
      if (!used.has(r.resource)) { used.add(r.resource); ends = r.ts + hourMs; }
    }
    return start !== null && now < ends ? { start, ends } : null;
  }

  function current(now = Date.now()) {
    let row = readRow();
    if (!row || row.ends == null) { row = fromLog(now); if (row) save(row.start, row.ends); }
    return row && now < row.ends ? row : null;
  }

  // { start, resetAt, used } for one path. With open=true (called just before a request is sent and
  // logged) a request starts the hour when none is running, or restarts it when its path is new.
  function window(resource, now = Date.now(), { open = false } = {}) {
    let row = current(now);
    if (open && !UNCOUNTED.has(resource)) {
      if (!row) { row = { start: now, ends: now + hourMs }; save(row.start, row.ends); }
      else if (!usedSince(resource, row.start)) { row = { start: row.start, ends: now + hourMs }; save(row.start, row.ends); }
    }
    if (!row) return { start: null, resetAt: null, used: 0 };
    return { start: row.start, resetAt: row.ends, used: usedSince(resource, row.start) };
  }

  // Oldest log row still needed (the current hour's start), for pruning.
  const keepFrom = (now = Date.now()) => current(now)?.start ?? null;

  return { window, current, keepFrom, fromLog };
}

module.exports = { createCvWindows, UNCOUNTED, HOUR_MS };
