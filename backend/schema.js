// ─── schema.js ────────────────────────────────────────────────────
// Schema migrations for new feature areas, kept out of the main
// server.js to avoid bloating that file. Each `apply*` function
// receives the better-sqlite3 db handle and is idempotent — safe
// to call on every boot.
//
// Convention matches server.js:
//   - db.exec(`CREATE TABLE IF NOT EXISTS …`) for fresh tables
//   - try { db.prepare('ALTER TABLE … ADD COLUMN …').run(); } catch {}
//     for safe column additions (ignored if column already exists)

// ─── Issue-number canonicalisation migration ─────────────────────
// One-time pass after the issueNumber.js refactor. CV's raw "8AU"
// rows get rewritten to canonical "8.AU" so SQL `=` matches against
// canonical inputs (from extractIssueNumber, etc.) work.
//
// Idempotent: a row already in canonical form is left alone.
// Caller passes the canonicalisation function so this module
// stays decoupled from issueNumber.js.
function migrateMonitoredIssuesCanonical(db, canonicaliseFn) {
  // Marker key in settings table prevents re-running on every boot.
  // If you ever need to re-run (e.g. after extending the suffix list),
  // delete the row: DELETE FROM settings WHERE key = 'migrate_issuenum_v1';
  const MARKER = 'migrate_issuenum_v1';
  const seen = db.prepare('SELECT value FROM settings WHERE key = ?').get(MARKER);
  if (seen?.value === 'done') return { skipped: true };

  const rows = db.prepare(
    'SELECT id, issue_number FROM monitored_issues WHERE issue_number IS NOT NULL'
  ).all();

  const update = db.prepare('UPDATE monitored_issues SET issue_number = ? WHERE id = ?');
  let changed = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const canon = canonicaliseFn(r.issue_number);
      if (canon != null && canon !== r.issue_number) {
        update.run(canon, r.id);
        changed++;
      }
    }
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, 'done')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(MARKER);
  });
  tx();
  return { skipped: false, scanned: rows.length, changed };
}

// ─── monitored_series.is_special migration ───────────────────────
// Explicit flag for "this series is a special" so the prefix-strict
// matching logic in runRefreshDirectory and the library scanner can
// fire even when no monitored *parent* exists at the directory.
//
// Before: specials were inferred from `parent_series_id IS NOT NULL`,
// which silently dropped the "I am a special" intent at add time when
// the user picked a SCANNED parent that wasn't itself monitored.
// Result: BVA-style cross-series claims of regular files in the
// shared folder.
//
// Backfill: any pre-existing row with parent_series_id set is a true
// special — flip is_special=1 so behaviour stays consistent for them.
// Idempotent: re-running the backfill is a no-op for already-flagged rows.
function applyIsSpecialSchema(db) {
  // Add the column (ignored if already exists).
  try { db.prepare('ALTER TABLE monitored_series ADD COLUMN is_special INTEGER DEFAULT 0').run(); } catch {}
  // Backfill from parent_series_id. Safe and idempotent — only flips 0→1.
  db.prepare(
    'UPDATE monitored_series SET is_special = 1 WHERE parent_series_id IS NOT NULL AND (is_special = 0 OR is_special IS NULL)'
  ).run();
}

// ─── Reading lists ────────────────────────────────────────────────
// User-built ordered lists of issues, ranges, series, events and Top
// Shelf runs. See claude/READING_LISTS_AI_DESIGN.md.
//   reading_lists          one row per list
//   reading_list_entries   ordered entries inside a list
//   list_issues            shared issue table (owner_kind/owner_id);
//                          today only 'reading_list_entry' owns rows.
//                          Linked event/canon entries own no rows; they
//                          are read live from event_issues/canon_run_issues.
//   reading_list_follows   users following a public list (live link)
function applyReadingListsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reading_lists (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      description  TEXT,
      owner_id     TEXT NOT NULL,
      visibility   TEXT NOT NULL DEFAULT 'private',
      cover_image  TEXT,
      source       TEXT NOT NULL DEFAULT 'manual',
      copied_from  INTEGER,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rl_owner ON reading_lists(owner_id);
    CREATE INDEX IF NOT EXISTS idx_rl_visibility ON reading_lists(visibility);

    CREATE TABLE IF NOT EXISTS reading_list_entries (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id            INTEGER NOT NULL,
      sort_order         REAL NOT NULL DEFAULT 0,
      entry_type         TEXT NOT NULL,
      ref_id             TEXT,
      cv_volume_id       TEXT,
      scanned_series_id  TEXT,
      issue_start        TEXT,
      issue_end          TEXT,
      label              TEXT,
      note               TEXT,
      unpacked           INTEGER NOT NULL DEFAULT 0,
      resolve_status     TEXT,
      resolve_source     TEXT,
      resolved_at        TEXT,
      created_at         TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rle_list ON reading_list_entries(list_id, sort_order);

    CREATE TABLE IF NOT EXISTS list_issues (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_kind         TEXT NOT NULL,
      owner_id           INTEGER NOT NULL,
      sort_order         REAL NOT NULL DEFAULT 0,
      cv_issue_id        TEXT,
      scanned_book_id    TEXT,
      scanned_series_id  TEXT,
      series_name        TEXT,
      issue_number       TEXT,
      issue_title        TEXT,
      volume_year        INTEGER,
      cover_date         TEXT,
      manually_matched   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_li_owner ON list_issues(owner_kind, owner_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_li_book ON list_issues(scanned_book_id);

    CREATE TABLE IF NOT EXISTS reading_list_follows (
      user_id      TEXT NOT NULL,
      list_id      INTEGER NOT NULL,
      followed_at  TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, list_id)
    );
  `);
  try { db.prepare("ALTER TABLE reading_lists ADD COLUMN catalog_json TEXT").run(); } catch {}
  // Event entries: which tiers to show (essential | recommended | all). NULL = essential.
  try { db.prepare('ALTER TABLE reading_list_entries ADD COLUMN tier_filter TEXT').run(); } catch {}
}


// ─── Stable IDs (see claude/STABLE_IDS.md) ───────────────────────
// Additive only. Records whose files vanish are copied here instead of
// being deleted (when the stable_ids setting is 'on'), so a later scan can
// give a moved file its old identity back. With the setting 'off' these
// tables stay empty and nothing else changes.
function applyStableIdsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS missing_series (
      id            TEXT PRIMARY KEY,
      library_id    TEXT,
      path          TEXT,
      name          TEXT,
      year          INTEGER,
      cv_volume_id  TEXT,
      row_json      TEXT NOT NULL,
      missing_since TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_missing_series_cv ON missing_series(cv_volume_id);

    CREATE TABLE IF NOT EXISTS missing_books (
      id            TEXT PRIMARY KEY,
      series_id     TEXT,
      path          TEXT,
      filename      TEXT,
      issue_number  TEXT,
      cv_issue_id   TEXT,
      file_size     INTEGER,
      row_json      TEXT NOT NULL,
      missing_since TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_missing_books_cv ON missing_books(cv_issue_id);
    CREATE INDEX IF NOT EXISTS idx_missing_books_series ON missing_books(series_id);

    CREATE TABLE IF NOT EXISTS identity_rebinds (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,          -- 'series' | 'book'
      mode        TEXT NOT NULL,          -- 'on' | 'dry_run'
      outcome     TEXT NOT NULL,          -- reclaimed | ambiguous | tombstoned (prefixed would_ in dry_run)
      entity_id   TEXT,
      old_path    TEXT,
      new_path    TEXT,
      match_key   TEXT,
      candidates  TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_identity_rebinds_time ON identity_rebinds(created_at);
    CREATE INDEX IF NOT EXISTS idx_scanned_books_cv ON scanned_books(cv_issue_id);
    CREATE INDEX IF NOT EXISTS idx_scanned_books_monitored ON scanned_books(monitored_issue_id);
  `);
}

module.exports = {
  applyStableIdsSchema,
  applyReadingListsSchema,
  migrateMonitoredIssuesCanonical,
  applyIsSpecialSchema,
};
