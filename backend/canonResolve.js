'use strict';
// ─── canonResolve.js ──────────────────────────────────────────────
// Helpers for Top Shelf Auto-resolve (resolveCanonRun in server.js), which
// fills a run's issues from Comic Vine; the run generator's Import depends
// on it. User 2026-10-17, after an assessment (claude/ADMIN_REORG.md):
//   1. Range notes with several pieces ("#1, #3, #5", "#635-641, #645-650")
//      were read as first-to-last (#1-11, #635-650), adding the issues
//      between. Now each piece counts; ranges take whole numbers only
//      (Batman #21-33 no longer brings Villains Month #23.1-23.4).
//   2. "(2016 vol)" names the volume's start year. It is now matched
//      within a year (no relaxing), and a library folder of that series
//      and year with a Comic Vine id is used first. Before, Wonder Woman
//      (2011 vol) and (2016 vol) runs got the 2006 volume.

const norm = t => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');

// "#635-641, #645-650 (1940 vol)" → { parts: [[635,641],[645,650]], start: 635, end: 650, year: 1940, volumeYear: 1940 }
function parseIssueSpec(hint) {
  const out = { parts: [], start: null, end: null, year: null, volumeYear: null };
  if (!hint) return out;
  const s = String(hint);
  const ym = s.match(/\((\d{4})([^)]*)\)/);
  if (ym) { out.year = Number(ym[1]); if (/\bvol/i.test(ym[2])) out.volumeYear = out.year; }
  const stripped = s.replace(/\(\d{4}[^)]*\)/g, ' ');
  for (const piece of stripped.split(/,|;|&|\band\b/i)) {
    const m = piece.match(/#?\s*(\d+(?:\.\d+)?)\s*(?:[-–—]|\bto\b)\s*#?\s*(\d+(?:\.\d+)?)/i);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (a < 2000 && b < 2000) out.parts.push(a <= b ? [a, b] : [b, a]);
      continue;
    }
    for (const x of piece.match(/\d+(?:\.\d+)?/g) || []) { const v = Number(x); if (v < 2000) out.parts.push([v, v]); }
  }
  const all = out.parts.flat();
  if (all.length) { out.start = Math.min(...all); out.end = Math.max(...all); }
  return out;
}

// Is a Comic Vine issue number in the run? No pieces → everything is.
function specIncludes(spec, issueNumber) {
  if (!spec || !spec.parts.length) return true;
  const f = parseFloat(issueNumber);
  if (!Number.isFinite(f)) return false;
  return spec.parts.some(([a, b]) => f === a || f === b || (f > a && f < b && Number.isInteger(f)));
}

// The Comic Vine volume of a library folder with exactly this series name and
// start year (series.json comicid). One clear answer only; null otherwise.
function libraryVolume(db, seriesName, year) {
  if (!seriesName || !year) return null;
  const want = norm(seriesName);
  const hits = new Set();
  for (const s of db.prepare("SELECT name, year, json_extract(series_json, '$.metadata.comicid') AS cid FROM scanned_series WHERE series_json IS NOT NULL AND CAST(year AS INTEGER) = ?").all(Number(year))) {
    if (s.cid && norm(s.name) === want) hits.add(String(s.cid));
  }
  return hits.size === 1 ? [...hits][0] : null;
}

module.exports = { parseIssueSpec, specIncludes, libraryVolume, norm };
