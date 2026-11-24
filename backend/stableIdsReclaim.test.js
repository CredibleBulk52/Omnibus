'use strict';
// Reclaim after tagging (2026-11-24): a replaced file that tagging gives its old Comic Vine ID takes
// over the old record's links (300 Hellblazer files replaced on 2026-11-24).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...a) => { db.exec('BEGIN'); try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  db.exec(`CREATE TABLE scanned_books(id TEXT PRIMARY KEY, series_id TEXT, path TEXT UNIQUE, cv_issue_id TEXT, issue_number TEXT);
    CREATE TABLE missing_books(id TEXT, series_id TEXT, path TEXT, filename TEXT, issue_number TEXT, cv_issue_id TEXT, file_size INTEGER, row_json TEXT, missing_since TEXT);
    CREATE TABLE missing_series(id TEXT, library_id TEXT, path TEXT, name TEXT, year INTEGER, cv_volume_id TEXT, row_json TEXT, missing_since TEXT);
    CREATE TABLE identity_rebinds(id INTEGER PRIMARY KEY, kind TEXT, mode TEXT, outcome TEXT, entity_id TEXT, old_path TEXT, new_path TEXT, match_key TEXT, candidates TEXT);
    CREATE TABLE read_progress(id INTEGER PRIMARY KEY, book_id TEXT, user_id TEXT, page INTEGER, completed INTEGER, updated_at TEXT, marked INTEGER, context TEXT, UNIQUE(user_id, book_id));
    CREATE TABLE reading_log(id INTEGER PRIMARY KEY, user_id TEXT, book_id TEXT);
    CREATE TABLE list_issues(id INTEGER PRIMARY KEY, scanned_book_id TEXT, manually_matched INTEGER DEFAULT 0);
    CREATE TABLE event_issues(id TEXT PRIMARY KEY, scanned_book_id TEXT);
    CREATE TABLE crossover_wiki_books(book_id TEXT PRIMARY KEY, page TEXT);
    CREATE TABLE library_health_reidentify(book_id TEXT PRIMARY KEY, note TEXT);`);
  const sid = require('./stableIds')({ db, logger: { info() {}, warn() {} }, fs, path, crypto });
  const book = (id, cv, p) => db.prepare('INSERT INTO scanned_books (id, path, cv_issue_id) VALUES (?, ?, ?)').run(id, p || `/comics/${id}.cbz`, cv);
  const gone = (id, cv) => db.prepare("INSERT INTO missing_books (id, path, cv_issue_id, row_json, missing_since) VALUES (?, ?, ?, '{}', datetime('now'))").run(id, `/comics/old-${id}.cbz`, cv);
  return { db, sid, book, gone };
}
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

test('a tagged replacement takes over the old record: reading orders, Timeline, history, progress', () => {
  const { db, sid, book, gone } = setup();
  gone('old47', '34843'); book('new47', '34843', '/comics/Hellblazer 047 (1991) (digital-Empire).cbz');
  db.exec(`INSERT INTO list_issues (id, scanned_book_id) VALUES (1, 'old47'), (2, 'other');
    INSERT INTO event_issues VALUES ('e1', 'old47');
    INSERT INTO reading_log (user_id, book_id) VALUES ('u1', 'old47');
    INSERT INTO read_progress (book_id, user_id, page, completed, updated_at) VALUES ('old47', 'u1', 22, 1, '2026-11-01'), ('old47', 'u2', 5, 0, '2026-11-02');
    INSERT INTO read_progress (book_id, user_id, page, completed, updated_at) VALUES ('new47', 'u2', 9, 0, '2026-11-24');
    INSERT INTO crossover_wiki_books VALUES ('old47', 'wiki'); INSERT INTO library_health_reidentify VALUES ('old47', 'x')`);
  assert.deepEqual(sid.reclaimAfterTagging(), { reclaimed: 1 });
  assert.equal(one(db, 'SELECT scanned_book_id AS b FROM list_issues WHERE id = 1').b, 'new47');
  assert.equal(one(db, 'SELECT scanned_book_id AS b FROM list_issues WHERE id = 2').b, 'other');
  assert.equal(one(db, "SELECT scanned_book_id AS b FROM event_issues WHERE id = 'e1'").b, 'new47');
  assert.equal(one(db, 'SELECT book_id AS b FROM reading_log').b, 'new47');
  // u1 read the old copy: now read on the new one. u2 had progress on both: the further one is kept.
  assert.deepEqual({ ...one(db, "SELECT page, completed FROM read_progress WHERE user_id = 'u1'") }, { page: 22, completed: 1 });
  assert.deepEqual({ ...one(db, "SELECT book_id, page, updated_at FROM read_progress WHERE user_id = 'u2'") }, { book_id: 'new47', page: 9, updated_at: '2026-11-24' });
  assert.equal(one(db, "SELECT COUNT(*) AS n FROM read_progress WHERE book_id = 'old47'").n, 0);
  assert.equal(one(db, "SELECT book_id AS b FROM crossover_wiki_books").b, 'new47');
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM library_health_reidentify').n, 0);
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM missing_books').n, 0);
  assert.equal(one(db, 'SELECT outcome FROM identity_rebinds').outcome, 'reclaimed after tagging');
  assert.deepEqual(sid.reclaimAfterTagging(), { reclaimed: 0 });   // nothing left to do
});

test('only one-to-one: two copies or two old records of the same issue are left alone, as are untagged files', () => {
  const { db, sid, book, gone } = setup();
  gone('a', '1'); book('a2', '1'); book('a3', '1');          // two library copies of issue 1
  gone('b', '2'); gone('b2', '2'); book('b3', '2');          // two old records of issue 2
  gone('c', '3'); book('c2', null);                            // the new copy is not tagged yet
  gone('d', null); book('d2', null);
  db.exec("INSERT INTO list_issues (id, scanned_book_id) VALUES (1, 'a'), (2, 'b'), (3, 'c')");
  assert.deepEqual(sid.reclaimAfterTagging(), { reclaimed: 0 });
  assert.deepEqual(db.prepare('SELECT scanned_book_id AS b FROM list_issues ORDER BY id').all().map(r => r.b), ['a', 'b', 'c']);
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM missing_books').n, 5);
});

test('a reader with the old copy finished and the new one half-read keeps it finished', () => {
  const { db, sid, book, gone } = setup();
  gone('o', '9'); book('n', '9');
  db.exec(`INSERT INTO read_progress (book_id, user_id, page, completed, updated_at) VALUES ('o', 'u', 30, 1, '2026-10-01'), ('n', 'u', 4, 0, '2026-11-24')`);
  sid.reclaimAfterTagging();
  assert.deepEqual({ ...one(db, "SELECT book_id, page, completed, updated_at FROM read_progress WHERE user_id = 'u'") }, { book_id: 'n', page: 30, completed: 1, updated_at: '2026-11-24' });
});
