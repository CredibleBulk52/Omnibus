const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { getRunIssues } = require('./runReading');

test('run progress is user-specific, ordered, and excludes missing library files', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE canon_run_issues(id INTEGER, run_id INTEGER, sort_order INTEGER, scanned_book_id TEXT);
      CREATE TABLE scanned_books(id TEXT, series_id TEXT, filename TEXT, path TEXT, comicinfo TEXT);
      CREATE TABLE scanned_series(id TEXT, name TEXT);
      CREATE TABLE read_progress(book_id TEXT, user_id TEXT, page INTEGER, completed INTEGER);
      INSERT INTO canon_run_issues VALUES (2,1,2,'b'), (1,1,1,'a'), (3,1,3,'deleted'), (4,2,1,'a');
      INSERT INTO scanned_books VALUES ('a','s','a.cbz','a','{"pageCount":24}'), ('b','s','b.cbz','b',null);
      INSERT INTO scanned_series VALUES ('s','Green Lantern');
      INSERT INTO read_progress VALUES ('a','reader',5,0), ('a','other',23,1), ('b',null,99,1);`);
    const rows = getRunIssues(db, 1, 'reader', JSON.parse);
    assert.deepEqual(rows.map(r => r.id), [1,2,3]);
    assert.deepEqual(rows[0].readProgress, { page: 5, completed: false });
    assert.equal(rows[0].media.pagesCount, 24);
    assert.equal(rows[1].readProgress, null);
    assert.equal(rows[2].scanned_book_id, null);
    assert.equal(getRunIssues(db, 1, 'other', JSON.parse)[0].readProgress.completed, true);
    assert.equal(getRunIssues(db, 1, null, JSON.parse)[0].readProgress, null);
  } finally { db.close(); }
});
