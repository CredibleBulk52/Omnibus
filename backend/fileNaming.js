'use strict';
// ─── File names for filed comics (moved out of server.js 2026-11-19, server.js split step 6b) ───
// Destination names for a downloaded or retagged issue ("Nightwing 023 (2025).cbz", "Nightwing 2025
// Annual 001.cbz", manga "Series v027 (2021).cbz"), the volume number in a manga file name, and the
// years written in a file name or carried by an issue. Moved unchanged.
const path = require('path');
const { padIssueNumStr, extractIssueNumber } = require('./issueNumber');

/** Build a ComicInfo.xml string from issue + series DB rows */
/** Build the destination filename.
 *  Regular:  "Nightwing 023 (2025).cbz"
 *  Annual:   "Nightwing 2025 Annual 001.cbz"  (year already in CV volume name, no trailing year)
 */
// Year written in a filename: "X-Men 2026 Annual 001", "Thor 015 (2019)". null if none.
function filenameYear(p) {
  const m = path.basename(String(p || '')).match(/(?:^|[^0-9])((?:19|20)[0-9]{2})(?:[^0-9]|$)/);
  return m ? m[1] : null;
}
// Cover / store years of an issue (monitored_issues row or CV issue object).
function issueYearsOf(i) {
  return [i.release_date, i.store_date, i.cover_date].filter(Boolean).map(d => String(d).slice(0, 4));
}

function buildDestFilename(issue, series) {
  // Pad integer part only — "8" → "008", "8.1" → "008.1", "1.NOW" → "001.NOW".
  // The previous padStart on the raw value left "8.1" unpadded because it was
  // already 3 chars, producing inconsistent filenames vs neighbouring "008".
  const num  = padIssueNumStr(issue.issue_number || '0', 3);
  const name = series.name.replace(/[/\\:*?"<>|]/g, '');
  const isAnnual = issue.is_annual || /annual/i.test(series.name);
  if (isAnnual) {
    // If the series name already contains a 4-digit year (e.g. "Nightwing 2025 Annual"),
    // use as-is — year is already baked in.
    if (/\d{4}/.test(name)) {
      // Year-named one-shot volumes ("Avengers 1999") have no "Annual" in the
      // name; keep the word so the file still reads (and is detected) as an annual.
      return /annual/i.test(name) ? `${name} ${num}.cbz` : `${name} Annual ${num}.cbz`;
    }
    // Series name has no year (e.g. "Venom Annual") — inject issue year so multiple
    // annuals with the same issue_number don't collide on disk.
    // Strip trailing "Annual", inject year, re-append: "Venom 2019 Annual 001.cbz"
    const year = (issue.release_date || issue.store_date || '').slice(0, 4) || series.year || '';
    const baseName = name.replace(/\s*Annual\s*$/i, '').trim();
    return year ? `${baseName} ${year} Annual ${num}.cbz` : `${name} ${num}.cbz`;
  }
  const year = (issue.release_date || issue.store_date || '').slice(0, 4) || series.year || '';
  return `${name} ${num} (${year}).cbz`;
}

// Extract volume number from manga filenames.
// Handles: v27, v027, Vol. 99, Vol 1, Volume 3
// Falls back to extractIssueNumber for edge cases.
function extractVolumeNumber(filename) {
  const base = path.basename(filename, path.extname(filename));
  // Primary: v27, v027, Vol.01, Vol 01, Volume 01 (case-insensitive)
  const vm = base.match(/v(?:ol(?:ume)?)?\.?\s*0*(\d+)/i);
  if (vm) return String(parseInt(vm[1], 10));
  // Fallback to issue number extractor
  return extractIssueNumber(filename);
}

// Build destination filename for manga volumes: "Series Name v027 (2021).cbz"
function buildMangaDestFilename(issue, series) {
  const num  = String(issue.issue_number || '0').padStart(3, '0');
  const name = series.name.replace(/[/\\:*?"<>|]/g, '');
  const year = (issue.release_date || issue.store_date || '').slice(0, 4) || series.year || '';
  return year ? `${name} v${num} (${year}).cbz` : `${name} v${num}.cbz`;
}

module.exports = { filenameYear, issueYearsOf, buildDestFilename, extractVolumeNumber, buildMangaDestFilename };
