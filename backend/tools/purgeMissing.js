'use strict';
// Purge missing records (files that left the library) and free the links that
// pointed at them, so the next scan can re-match events / Top Shelf / reading
// lists to a copy you still own. Replaces the old /api/admin/stable-ids/purge.
//
//   node /app/backend/tools/purgeMissing.js                 preview
//   node /app/backend/tools/purgeMissing.js --apply         purge all missing records
//   node /app/backend/tools/purgeMissing.js --apply --days 30   only those missing 30+ days
// Then scan the library.
const Database = require('better-sqlite3');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const days = arg('--days', null) == null ? null : Number(arg('--days'));
const db = new Database(process.env.DB_PATH || '/appdata/omnibus.db');
db.pragma('busy_timeout = 10000');
const logger = { info() {}, warn: console.warn };
const sid = require(path.join(__dirname, '..', 'stableIds'))({ db, logger, fs, path, crypto });

const cond = days == null ? '1=1' : `missing_since <= datetime('now', '-${days} days')`;
const series = db.prepare(`SELECT path, missing_since FROM missing_series WHERE ${cond} ORDER BY path`).all();
const books = db.prepare(`SELECT path, missing_since, json_extract(row_json, '$.monitored_issue_id') AS mi FROM missing_books WHERE ${cond} ORDER BY path`).all();
const live = db.prepare(`SELECT 1 FROM monitored_issues WHERE id = ? AND status = 'processed'`);
const resets = books.filter(b => b.mi && live.get(b.mi)).length;

console.log(`${APPLY ? 'APPLYING' : 'PREVIEW (add --apply)'}${days != null ? ` — missing ${days}+ days` : ''}`);
console.log(`Series: ${series.length}`); series.forEach(s => console.log(`  ${s.path.replace(/^\/comics\//, '')}  (since ${s.missing_since})`));
console.log(`Books:  ${books.length}`); books.forEach(b => console.log(`  ${b.path.replace(/^\/comics\//, '')}  (since ${b.missing_since})`));
console.log(`Monitored issues that would go back to wanted: ${resets}`);

if (APPLY) {
  const r = sid.purgeMissing(days);
  const freed = {};
  for (const t of ['event_issues', 'list_issues', 'canon_run_issues']) {
    freed[t] = db.prepare(`UPDATE ${t} SET scanned_book_id = NULL WHERE scanned_book_id IS NOT NULL AND COALESCE(manually_matched, 0) = 0
      AND CAST(scanned_book_id AS TEXT) NOT IN (SELECT id FROM scanned_books) AND CAST(scanned_book_id AS TEXT) NOT IN (SELECT id FROM missing_books)`).run().changes;
  }
  console.log('Purged', r, 'freed links', freed, '— now scan the library.');
}
