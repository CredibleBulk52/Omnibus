'use strict';
// Automatic purge of missing records (2026-10-21): purges records missing N+ days, skips outages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function setup({ books = [], live = 100, mkdirs = ['DC Comics'] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...a) => { db.exec('BEGIN'); try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  db.exec(`CREATE TABLE scanned_books(id TEXT PRIMARY KEY,series_id TEXT,path TEXT UNIQUE,filename TEXT,comicinfo TEXT,file_size INTEGER,file_mtime REAL,
    issue_number TEXT,sort_order REAL,title TEXT,cv_issue_id TEXT,monitored_issue_id TEXT,manual_notes TEXT);
    CREATE TABLE monitored_issues(id TEXT PRIMARY KEY,status TEXT,file_path TEXT,download_id TEXT,date_processed TEXT);
    CREATE TABLE read_progress(book_id TEXT PRIMARY KEY,page INTEGER,completed INTEGER);
    CREATE TABLE list_members(book_id TEXT,position INTEGER,manual INTEGER);
    CREATE TABLE metadata_overrides(book_id TEXT,field TEXT,value TEXT);
    CREATE TABLE scanned_series(id TEXT PRIMARY KEY,path TEXT);
    CREATE TABLE missing_books(id TEXT,series_id TEXT,path TEXT,filename TEXT,issue_number TEXT,cv_issue_id TEXT,file_size INTEGER,row_json TEXT,missing_since TEXT);
    CREATE TABLE missing_series(id TEXT,library_id TEXT,path TEXT,name TEXT,year INTEGER,cv_volume_id TEXT,row_json TEXT,missing_since TEXT);
    CREATE TABLE identity_rebinds(id INTEGER PRIMARY KEY,kind TEXT,mode TEXT,outcome TEXT,entity_id TEXT,old_path TEXT,new_path TEXT,match_key TEXT,candidates TEXT);`);
  for (let k = 0; k < live; k++) db.prepare('INSERT INTO scanned_books (id, path) VALUES (?, ?)').run(`b${k}`, `/p${k}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comics-'));
  for (const d of mkdirs) fs.mkdirSync(path.join(root, d));
  books.forEach((b, k) => db.prepare(`INSERT INTO missing_books (id, path, row_json, missing_since) VALUES (?, ?, '{}', datetime('now', ?))`).run(`m${k}`, `${root}/${b.dir}/x${k}.cbz`, `-${b.days} days`));
  const sid = require('./stableIds')({ db, logger: { info() {}, warn() {} }, fs, path, crypto });
  return { db, sid, root };
}

test('purges records missing 5+ days, keeps newer ones', () => {
  const { db, sid, root } = setup({ books: [{ dir: 'DC Comics', days: 6 }, { dir: 'DC Comics', days: 2 }] });
  const r = sid.autoPurge({ days: 5, comicsRoot: root });
  assert.equal(r.books, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM missing_books').get().n, 1);
});

test('skips when a whole top-level folder is gone, the root is empty, or too many are due', () => {
  let s = setup({ books: [{ dir: 'Marvel Comics', days: 9 }] });
  assert.match(s.sid.autoPurge({ days: 5, comicsRoot: s.root }).reason, /Marvel Comics/);
  s = setup({ books: [{ dir: 'DC Comics', days: 9 }], mkdirs: [] });
  assert.match(s.sid.autoPurge({ days: 5, comicsRoot: s.root }).reason, /empty/);
  s = setup({ books: Array.from({ length: 60 }, () => ({ dir: 'DC Comics', days: 9 })), live: 1000 });
  assert.match(s.sid.autoPurge({ days: 5, comicsRoot: s.root }).reason, /60 records due/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM missing_books').get().n, 60);
});
