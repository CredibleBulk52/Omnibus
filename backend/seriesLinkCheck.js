'use strict';
// ─── Series linked to the wrong Comic Vine volume (2026-11-13) ─────
// Step 1 of series grouping (claude/SERIES_GROUPING_PLAN.md). A folder's series.json names one
// Comic Vine volume (comicid); its files may belong to another. Examples found in the library:
// Arkham Manor (2014) linked to the 2015 Endgame one-shot, the Injustice folders linked to their
// Annual volumes. Wrong links give wrong issue counts and statuses and would misgroup series.
//
// Suspect folders only: the files' ComicInfo series differs from series.json's name, or the
// folder holds more regular issues than series.json says the volume has. For each suspect, one
// book from each of its (up to 3) largest ComicInfo series groups is looked up: its Comic Vine
// issue's volume (saved in cv_issue_volume, shared with the annual finder). Then:
//   ok        series.json's volume is the files' volume (one group): nothing to do.
//   mixed     series.json's volume is one of several volumes in the folder (Flash: Rebirth
//             inside The Flash (2010)): not a wrong link; used later for specials.
//   mismatch  none of the files belong to series.json's volume: proposed re-link to the
//             largest group's volume. Shown on the Library page; the admin decides.
//   clear     not a suspect (no lookup made).
// A folder is looked at again when series.json's comicid or its book count changes.
// "Link is right" dismisses a mismatch.
const { parseComicInfoEvidence } = require('./metadata/evidence');
const { titleKey } = require('./metadata/candidate');

const PER_RUN = 60;
const MAX_GROUPS = 3;

function initSeriesLinkCheck(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cv_issue_volume (issue_id TEXT PRIMARY KEY, volume_id TEXT, volume_name TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS series_link_checks (
      series_id   TEXT PRIMARY KEY,
      comicid     TEXT NOT NULL,          -- series.json's volume when checked
      books       INTEGER,                -- the folder's book count when checked
      status      TEXT NOT NULL,          -- clear | ok | mixed | mismatch | unknown
      volume_id   TEXT,                   -- the files' main volume
      volume_name TEXT,
      groups      TEXT,                   -- JSON: [{ name, books, volumeId, volumeName }]
      checked_at  INTEGER NOT NULL,
      dismissed   INTEGER NOT NULL DEFAULT 0
    )`);
}

const metaOf = json => {
  try { const d = JSON.parse(json); const m = d && typeof d === 'object' && !Array.isArray(d) ? d.metadata : null; return m && typeof m === 'object' ? m : null; }
  catch { return null; }
};
// The <Series> tag. A plain match first (every folder's books are read on the first pass);
// the full parser only when the tag holds markup or entities beyond the usual ones.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const seriesTag = xml => {
  const m = /<Series>([^<]*)<\/Series>/.exec(xml || '');
  if (!m) return null;
  const raw = m[1];
  if (!/&(?!(?:amp|lt|gt|quot|apos);)/.test(raw)) return raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENT[e]).trim() || null;
  try { const f = parseComicInfoEvidence(xml).fields.series; return f && f.length === 1 ? f[0] : null; } catch { return null; }
};
const isAnnualFile = name => /annual/i.test(name || '');

// The folder's regular books (not specials, not annuals) grouped by their ComicInfo series,
// largest first: [{ key, name, books: [{ id, cv_issue_id }] }].
function fileGroups(db, seriesId) {
  const groups = new Map();
  for (const b of db.prepare('SELECT id, filename, comicinfo, cv_issue_id FROM scanned_books WHERE series_id = ? AND COALESCE(is_special, 0) = 0').all(seriesId)) {
    if (isAnnualFile(b.filename)) continue;
    const name = seriesTag(b.comicinfo);
    const key = name ? titleKey(name) : '';
    if (!groups.has(key)) groups.set(key, { key, name, books: [] });
    groups.get(key).books.push({ id: b.id, cv_issue_id: b.cv_issue_id ? String(b.cv_issue_id) : null });
  }
  return [...groups.values()].sort((a, b) => b.books.length - a.books.length);
}

// Suspect folders not yet checked against their current comicid and book count. Folders found
// not to be suspects are recorded as 'clear' (markClear) so they are not read again each run.
function suspects(db, { limit = Infinity, markClear = null } = {}) {
  const checked = new Map(db.prepare('SELECT series_id, comicid, books FROM series_link_checks').all().map(r => [r.series_id, r]));
  const out = [];
  for (const s of db.prepare('SELECT id, name, path, series_json, book_count FROM scanned_series WHERE series_json IS NOT NULL').all()) {
    const m = metaOf(s.series_json);
    const comicid = m && /^\d+$/.test(String(m.comicid ?? '')) ? String(m.comicid) : null;
    const prev = checked.get(s.id);
    if (!comicid || (prev && prev.comicid === comicid && (prev.books == null || prev.books === s.book_count))) continue;
    const groups = fileGroups(db, s.id);
    const regular = groups.reduce((n, g) => n + g.books.length, 0);
    if (!regular) continue;
    const named = groups.find(g => g.key);
    const nameDiffers = !!named && named.key !== titleKey(m.name || s.name || '');
    const total = Number(m.total_issues) || 0;
    const tooMany = total > 0 && regular > total;
    if (!nameDiffers && !tooMany) { if (markClear) markClear(s.id, comicid, s.book_count); continue; }
    out.push({ id: s.id, name: m.name || s.name, path: s.path, comicid, books: s.book_count, groups, reason: nameDiffers ? 'name' : 'count' });
    if (out.length >= limit) break;
  }
  return out;
}

// Decide from the looked-up groups: [{ name, books, volumeId, volumeName }].
function decide(comicid, groups) {
  const known = groups.filter(g => g.volumeId);
  if (!known.length) return { status: 'unknown', volumeId: null, volumeName: null };
  const main = known[0];
  if (known.some(g => g.volumeId === comicid)) {
    const volumes = new Set(known.map(g => g.volumeId));
    return { status: volumes.size > 1 ? 'mixed' : 'ok', volumeId: main.volumeId, volumeName: main.volumeName };
  }
  return { status: 'mismatch', volumeId: main.volumeId, volumeName: main.volumeName };
}

// volumeOfIssue(issueId) → { id, name } | null. It throws err.code 'CV_RATE_LIMIT' when Comic Vine's
// hour is used up (the run stops), or 'CV_HEADROOM' when only the allowance kept for clicks is left
// (that folder waits for a later run; folders the saved answers or Metron can settle go on).
function createSeriesLinkCheck({ db, volumeOfIssue, logger, now = Date.now, pause = () => Promise.resolve() }) {
  initSeriesLinkCheck(db);
  const cached = db.prepare('SELECT volume_id, volume_name FROM cv_issue_volume WHERE issue_id = ?');
  const fromMonitored = db.prepare('SELECT series_id FROM monitored_issues WHERE id = ?');
  const remember = db.prepare('INSERT OR REPLACE INTO cv_issue_volume (issue_id, volume_id, volume_name, at) VALUES (?, ?, ?, ?)');
  const save = db.prepare(`INSERT INTO series_link_checks (series_id, comicid, books, status, volume_id, volume_name, groups, checked_at, dismissed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(series_id) DO UPDATE SET comicid = excluded.comicid, books = excluded.books, status = excluded.status, volume_id = excluded.volume_id,
      volume_name = excluded.volume_name, groups = excluded.groups, checked_at = excluded.checked_at,
      dismissed = CASE WHEN series_link_checks.comicid = excluded.comicid AND series_link_checks.status = excluded.status THEN series_link_checks.dismissed ELSE 0 END`);
  const markClear = (id, comicid, books) => save.run(id, comicid, books, 'clear', null, null, null, now());
  let monitoredTable = true;

  // The volume of one issue: saved answer, the monitored issue list, or one Comic Vine request.
  async function volumeOf(issueId) {
    const row = cached.get(issueId);
    if (row) return { id: row.volume_id || null, name: row.volume_name || null, asked: false };
    if (monitoredTable) {
      try { const m = fromMonitored.get(issueId); if (m) return { id: String(m.series_id), name: null, asked: false }; }
      catch { monitoredTable = false; }
    }
    const v = await volumeOfIssue(issueId);
    remember.run(issueId, v?.id ? String(v.id) : null, v?.name || null, now());
    return { id: v?.id ? String(v.id) : null, name: v?.name || null, asked: true };
  }

  let running = false;
  async function run({ limit = PER_RUN } = {}) {
    if (running) return { skipped: true };
    running = true;
    const stats = { checked: 0, ok: 0, mixed: 0, mismatch: 0, unknown: 0, requests: 0, deferred: 0, rateLimited: false };
    try {
      for (const s of suspects(db, { limit, markClear })) {
        const groups = [];
        try {
          for (const g of s.groups.slice(0, MAX_GROUPS)) {
            const book = g.books.find(b => b.cv_issue_id);
            let v = book ? await volumeOf(book.cv_issue_id) : null;
            if (v?.asked) { stats.requests++; await pause(); }
            groups.push({ name: g.name, books: g.books.length, volumeId: v?.id || null, volumeName: v?.name || null });
          }
        } catch (e) {
          if (e.code === 'CV_RATE_LIMIT') { stats.rateLimited = true; break; }
          if (e.code === 'CV_HEADROOM') { stats.deferred++; continue; }
          logger.warn('series-links', `Check failed for "${s.name}"`, e.message);
          continue;
        }
        const d = decide(s.comicid, groups);
        save.run(s.id, s.comicid, s.books, d.status, d.volumeId, d.volumeName, JSON.stringify(groups), now());
        stats.checked++; stats[d.status]++;
        if (d.status === 'mismatch') logger.info('series-links', `${s.name}: series.json is volume ${s.comicid}; its files are ${d.volumeName || 'volume'} ${d.volumeId}`);
      }
    } finally { running = false; }
    if (stats.checked || stats.rateLimited) logger.info('series-links', 'Run complete', stats);
    return stats;
  }

  // Mismatches still in force: series.json has not been re-linked since, and not dismissed.
  function mismatches() {
    const rows = db.prepare(`SELECT c.*, s.name AS folder_name, s.path, s.series_json FROM series_link_checks c
      JOIN scanned_series s ON s.id = c.series_id WHERE c.status = 'mismatch' AND c.dismissed = 0 ORDER BY s.name`).all();
    return rows.map(r => {
      const m = metaOf(r.series_json) || {};
      if (String(m.comicid ?? '') !== r.comicid) return null;   // re-linked since the check
      let groups = [];
      try { groups = JSON.parse(r.groups || '[]'); } catch {}
      return { seriesId: r.series_id, folder: r.path ? r.path.split(/[\\/]/).pop() : r.folder_name, path: r.path,
        current: { comicid: r.comicid, name: m.name || null, year: m.year || null, totalIssues: m.total_issues ?? null, image: m.comic_image || null },
        proposed: { volumeId: r.volume_id, name: r.volume_name }, groups, checkedAt: r.checked_at };
    }).filter(Boolean);
  }

  function progress() {
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM series_link_checks GROUP BY status').all().map(r => [r.status, r.n]));
    const total = db.prepare('SELECT COUNT(*) AS n FROM scanned_series WHERE series_json IS NOT NULL').get().n;
    const done = Object.values(counts).reduce((a, b) => a + b, 0);
    return { counts, notYetRead: Math.max(0, total - done) };
  }

  function dismiss(seriesId) {
    return db.prepare("UPDATE series_link_checks SET dismissed = 1 WHERE series_id = ? AND status = 'mismatch'").run(seriesId).changes > 0;
  }

  return { run, mismatches, progress, dismiss, count: () => mismatches().length };
}

module.exports = { createSeriesLinkCheck, initSeriesLinkCheck, suspects, decide, fileGroups, PER_RUN };
