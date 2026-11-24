'use strict';
// eventLibrarySnapshot.js must answer exactly what the SQL it replaces answers (2026-11-24).
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createLibrarySnapshot } = require('./eventLibrarySnapshot');

function library(books, series) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, filename TEXT, issue_number TEXT, comicinfo TEXT)`);
  for (const s of series) db.prepare('INSERT INTO scanned_series VALUES (?, ?, ?)').run(s.id, s.name, s.year ?? null);
  for (const b of books) db.prepare('INSERT INTO scanned_books VALUES (?, ?, ?, ?, ?)').run(b.id, b.series_id ?? null, b.filename ?? null, b.issue_number ?? null, b.comicinfo ?? null);
  return db;
}
const sql = {
  cv: (db, id) => db.prepare('SELECT id, issue_number FROM scanned_books WHERE comicinfo LIKE ? OR comicinfo LIKE ? LIMIT 1').get(`%4000-${id}%`, `%[Issue ID ${id}]%`),
  num: (db, n) => db.prepare('SELECT sb.id FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id WHERE sb.issue_number = ?').all(n).map(r => r.id),
  file: (db, t) => db.prepare('SELECT sb.id FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id WHERE sb.filename LIKE ?').all(`%${t}%`).map(r => r.id),
};
const plain = o => (o ? { ...o } : undefined);

test('Comic Vine IDs in ComicInfo: same first book as the LIKE search, including its odd cases', () => {
  const books = [
    { id: 'a', series_id: 's1', issue_number: '1', comicinfo: '<Web>https://comicvine.gamespot.com/x/4000-1234/</Web>' },        // 123 and 12 match as prefixes
    { id: 'b', series_id: 's1', issue_number: '2', comicinfo: '<Notes>Tagged [ISSUE ID 555]</Notes>' },                          // case ignored
    { id: 'c', series_id: 's1', issue_number: '3', comicinfo: '<Web>.../4000-4000-777/</Web>' },                                   // overlapping "4000-"
    { id: 'd', series_id: 's1', issue_number: '4', comicinfo: '<Notes>[Issue ID 12[Issue ID 888]</Notes>' },                       // second marker
    { id: 'e', series_id: 's1', issue_number: '5', comicinfo: '<Web>/14000-99/</Web><Notes>[Issue ID 5551]</Notes>' },            // inside a longer number
    { id: 'f', issue_number: '6', comicinfo: '<Web>/4000-31/</Web>' },                                                              // no series row: still found here
    { id: 'g', series_id: 's1', issue_number: '7', comicinfo: null },
    { id: 'h', series_id: 's1', issue_number: '8', comicinfo: '<Notes>[issue id 555]</Notes><Web>/4000-1/</Web>' },
  ];
  const db = library(books, [{ id: 's1', name: 'X' }]);
  const snap = createLibrarySnapshot(db);
  for (const id of ['1', '12', '123', '1234', '12345', '555', '5551', '55', '777', '4000', '888', '99', '9', '31', '3', '0', '2', '7777']) {
    assert.deepEqual(plain(snap.cvInComicInfo(id)), plain(sql.cv(db, id)), `id ${id}`);
  }
  assert.equal(snap.cvInComicInfo('12a'), undefined);   // not digits: the caller uses SQL
});

test('same issue number and file name: same books, same order as the JOIN', () => {
  const books = [];
  const names = ['Batman 001 (2016).cbz', 'BATMAN 001.CBZ', 'Annual 2001.cbz', null, 'x_1.cbz', 'Café 01.cbz', 'Batman 010 (1940).cbz'];
  for (let i = 0; i < 40; i++) books.push({ id: 'b' + String(i).padStart(2, '0'), series_id: i % 7 === 0 ? 'missing' : 's' + (i % 3), filename: names[i % names.length], issue_number: [null, '1', '01', '1.0', 'A', '1'][i % 6] });
  books.reverse();   // table order differs from id order
  const db = library(books, [{ id: 's0', name: 'A' }, { id: 's1', name: 'B' }, { id: 's2', name: 'C' }]);
  const snap = createLibrarySnapshot(db);
  for (const n of ['1', '01', '1.0', 'A', 'a', '2']) assert.deepEqual(snap.sameNumber(n).map(r => r.id), sql.num(db, n), `number ${n}`);
  assert.deepEqual(snap.sameNumber(null), []);
  for (const t of ['001', '01', 'batman', 'CBZ', '2001', 'é', 'É', '']) assert.deepEqual(snap.fileNameContains(t).map(r => r.id), sql.file(db, t), `file ${t}`);
  assert.equal(snap.fileNameContains('x_1'), undefined);   // LIKE wildcard: the caller uses SQL
});

test('each book keeps the ComicInfo year the matcher reads', () => {
  const db = library([{ id: 'a', series_id: 's', issue_number: '1', comicinfo: '<ComicInfo><year>1991</year></ComicInfo>' },
    { id: 'b', series_id: 's', issue_number: '1', comicinfo: '<ComicInfo><Year>19</Year></ComicInfo>' }], [{ id: 's', name: 'X', year: 1990 }]);
  assert.deepEqual(createLibrarySnapshot(db).sameNumber('1').map(r => [r.ciYear, r.syear]), [[1991, 1990], [null, 1990]]);
});
