'use strict';
// One-time repair after the 2026-10-11 Marvel merge scan, which ran before the
// stable-ID tie-breaker existed.
//   1. Series logged 'ambiguous' got new IDs. Give each its old ID back: the
//      missing (or stale) record with the same CV volume ID and the same folder name.
//   2. Books logged 'ambiguous' likewise, preferring same series + same filename.
//   3. Every series under the given path prefixes gets dir_mtime = 0 so the next
//      scan re-reads it (reclaimed series were skipped and their books still have
//      old paths).
// Usage (inside the container):
//   node /app/backend/tools/archive/stableIdsRepair.js              → dry run, prints plan
//   node /app/backend/tools/archive/stableIdsRepair.js --apply      → does it
// Options: --since "-12 hours"   --prefix "/comics/Marvel Comics/"
const Database = require('better-sqlite3');
const fs = require('fs'), path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const SINCE = arg('--since', '-12 hours');
const PREFIX = arg('--prefix', '/comics/Marvel Comics/');
const db = new Database(process.env.DB_PATH || '/appdata/omnibus.db');
db.pragma('busy_timeout = 10000');

const tryRun = (sql, ...a) => { try { return db.prepare(sql).run(...a).changes; } catch { return 0; } };
function restoreRow(table, rowJson, overrides) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const row = { ...JSON.parse(rowJson), ...overrides };
  const use = cols.filter(c => c in row);
  db.prepare(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`).run(...use.map(c => row[c]));
}
function remapBook(from, to) {
  for (const [t, c] of [['event_issues', 'scanned_book_id'], ['list_issues', 'scanned_book_id']])
    tryRun(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`, to, from);
  tryRun('UPDATE canon_run_issues SET scanned_book_id = ? WHERE CAST(scanned_book_id AS TEXT) = ?', to, from);
  tryRun('UPDATE OR IGNORE read_progress SET book_id = ? WHERE book_id = ?', to, from);
  tryRun('DELETE FROM read_progress WHERE book_id = ?', from);
  tryRun('DELETE FROM book_ci_index WHERE book_id = ?', from);
}
function remapSeries(from, to) {
  tryRun('UPDATE scanned_books SET series_id = ? WHERE series_id = ?', to, from);
  tryRun('UPDATE missing_books SET series_id = ? WHERE series_id = ?', to, from);
  tryRun('UPDATE list_issues SET scanned_series_id = ? WHERE scanned_series_id = ?', to, from);
  tryRun('UPDATE reading_list_entries SET scanned_series_id = ? WHERE scanned_series_id = ?', to, from);
  for (const t of ['collection_series', 'user_favorites', 'series_ratings', 'series_user_tags', 'dismissed_continue_reading']) {
    tryRun(`UPDATE OR IGNORE ${t} SET series_id = ? WHERE series_id = ?`, to, from);
    tryRun(`DELETE FROM ${t} WHERE series_id = ?`, from);
  }
  tryRun('DELETE FROM series_json_cache WHERE series_id = ?', from);
}
// Pick one candidate by tie-breakers; null if still not unique.
function pick(cands, tests) {
  if (cands.length === 1) return cands[0];
  for (const t of tests) { const h = cands.filter(t); if (h.length === 1) return h[0]; }
  return null;
}
const cvOf = json => { try { const j = JSON.parse(json || 'null'); const v = j?.metadata?.comicid ?? j?.comicid; return v == null ? null : String(v); } catch { return null; } };
const log = db.prepare(`INSERT INTO identity_rebinds (kind, mode, outcome, entity_id, old_path, new_path, match_key) VALUES (?, 'on', 'repaired', ?, ?, ?, ?)`);

const out = { series: { fixed: [], skipped: [] }, books: { fixed: 0, skipped: [] }, rescanFlagged: 0 };

// ── 1. Series ─────────────────────────────────────────────────────
const sAmb = db.prepare(`SELECT DISTINCT new_path, match_key FROM identity_rebinds
  WHERE kind = 'series' AND outcome = 'ambiguous' AND mode = 'on' AND created_at >= datetime('now', ?)`).all(SINCE);
for (const a of sAmb) {
  const live = db.prepare('SELECT id, series_json FROM scanned_series WHERE path = ?').get(a.new_path);
  if (!live) { out.series.skipped.push([a.new_path, 'no live row at path']); continue; }
  const cv = (a.match_key || '').replace(/^cv_volume:/, '').split('+')[0];
  const base = path.basename(a.new_path);
  // The old rows were tombstoned at the end of that scan, so candidates are missing records.
  const cands = db.prepare('SELECT id, path, row_json FROM missing_series WHERE cv_volume_id = ?').all(cv);
  const c = pick(cands, [x => path.basename(x.path) === base]);
  if (!c) { out.series.skipped.push([a.new_path, `${cands.length} candidates, none unique by folder name`]); continue; }
  out.series.fixed.push([base, `${live.id} -> ${c.id}`]);
  if (!APPLY) continue;
  db.transaction(() => {
    const cur = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(live.id);
    // Order matters (foreign keys + unique path): free the path, bring the old
    // row back, move everything onto it, then drop the new row.
    db.prepare('UPDATE scanned_series SET path = ? WHERE id = ?').run(a.new_path + ' [repair]', live.id);
    restoreRow('scanned_series', c.row_json, { path: a.new_path, dir_mtime: 0, library_id: cur.library_id });
    db.prepare('DELETE FROM missing_series WHERE id = ?').run(c.id);
    remapSeries(live.id, c.id);
    db.prepare('DELETE FROM scanned_series WHERE id = ?').run(live.id);
    log.run('series', c.id, c.path, a.new_path, a.match_key);
  })();
}

// ── 2. Books ──────────────────────────────────────────────────────
const bAmb = db.prepare(`SELECT DISTINCT new_path, match_key FROM identity_rebinds
  WHERE kind = 'book' AND outcome = 'ambiguous' AND mode = 'on' AND created_at >= datetime('now', ?)`).all(SINCE);
for (const a of bAmb) {
  const live = db.prepare('SELECT id, series_id, cv_issue_id, issue_number, file_size FROM scanned_books WHERE path = ?').get(a.new_path);
  if (!live) { out.books.skipped.push([a.new_path, 'no live row at path']); continue; }
  const base = path.basename(a.new_path);
  let cands;
  if (live.cv_issue_id) {
    cands = [
      ...db.prepare('SELECT id, path, series_id, row_json, \'missing\' AS src FROM missing_books WHERE cv_issue_id = ?').all(String(live.cv_issue_id)),
      ...db.prepare('SELECT id, path, series_id, NULL AS row_json, \'live\' AS src FROM scanned_books WHERE cv_issue_id = ? AND id != ?').all(String(live.cv_issue_id), live.id)
        .filter(r => !fs.existsSync(r.path)),
    ];
  } else {
    cands = db.prepare(`SELECT id, path, series_id, row_json, 'missing' AS src FROM missing_books
      WHERE series_id = ? AND file_size = ? AND issue_number = ? AND (cv_issue_id IS NULL OR cv_issue_id = '')`).all(live.series_id, live.file_size, String(live.issue_number));
  }
  const c = pick(cands, [
    x => x.series_id === live.series_id && path.basename(x.path) === base,
    x => x.series_id === live.series_id,
    x => path.basename(x.path) === base,
  ]);
  if (!c) { out.books.skipped.push([a.new_path, `${cands.length} candidates, none unique`]); continue; }
  out.books.fixed++;
  if (!APPLY) continue;
  db.transaction(() => {
    db.prepare('UPDATE scanned_books SET path = ? WHERE id = ?').run(a.new_path + ' [repair]', live.id);
    if (c.src === 'missing') {
      restoreRow('scanned_books', c.row_json, { path: a.new_path, series_id: live.series_id });
      db.prepare('DELETE FROM missing_books WHERE id = ?').run(c.id);
    } else {
      db.prepare('UPDATE scanned_books SET path = ?, series_id = ? WHERE id = ?').run(a.new_path, live.series_id, c.id);
    }
    remapBook(live.id, c.id);
    db.prepare('DELETE FROM scanned_books WHERE id = ?').run(live.id);
    log.run('book', c.id, c.path, a.new_path, a.match_key);
  })();
}

// ── 3. Force a rescan of everything under the prefix ──────────────
const flagged = db.prepare('SELECT COUNT(*) AS n FROM scanned_series WHERE substr(path, 1, ?) = ?').get(PREFIX.length, PREFIX).n;
out.rescanFlagged = flagged;
if (APPLY) db.prepare('UPDATE scanned_series SET dir_mtime = 0 WHERE substr(path, 1, ?) = ?').run(PREFIX.length, PREFIX);

console.log(`${APPLY ? 'APPLIED' : 'DRY RUN (add --apply to make changes)'}  since ${SINCE}`);
console.log(`Series: ${out.series.fixed.length} restored, ${out.series.skipped.length} skipped`);
out.series.fixed.forEach(([b, m]) => console.log(`  ${b}: ${m}`));
out.series.skipped.forEach(([p, w]) => console.log(`  SKIPPED ${p}: ${w}`));
console.log(`Books:  ${out.books.fixed} restored, ${out.books.skipped.length} skipped`);
out.books.skipped.slice(0, 30).forEach(([p, w]) => console.log(`  SKIPPED ${p}: ${w}`));
console.log(`Series flagged for rescan under ${PREFIX}: ${flagged}`);
