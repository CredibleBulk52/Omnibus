'use strict';
// Timeline event markers on issue cards (eventMarkers.js, 2026-11-19).
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { eventMarkersFor, withEventMarkers } = require('./eventMarkers');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT, year TEXT, draft INTEGER DEFAULT 0);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, scanned_book_id TEXT, tier TEXT);`);
  const ev = db.prepare('INSERT INTO events VALUES (?,?,?,?)');
  ev.run('kt', 'Knight Terrors', '2023', 0);
  ev.run('ap', 'Absolute Power', '2024', 0);
  ev.run('dr', 'Draft Event', '2025', 1);
  const ei = db.prepare('INSERT INTO event_issues (event_id, scanned_book_id, tier) VALUES (?,?,?)');
  ei.run('kt', 'b1', 'tie-in');
  ei.run('ap', 'b1', 'essential');      // more important here: listed first
  ei.run('ap', 'b2', 'tie-in');
  ei.run('ap', 'b2', 'recommended');    // same event twice: keep the more important role
  ei.run('dr', 'b3', 'essential');      // draft events are not shown
  ei.run('kt', null, 'essential');      // not in the library
  return db;
}

test('a book lists its events, most important role first; drafts and unmatched rows are left out', () => {
  const m = eventMarkersFor(fixture(), ['b1', 'b2', 'b3', 'b4']);
  assert.deepEqual(m.get('b1').map(e => [e.name, e.tier]), [['Absolute Power', 'essential'], ['Knight Terrors', 'tie-in']]);
  assert.deepEqual(m.get('b2').map(e => [e.name, e.tier]), [['Absolute Power', 'recommended']]);
  assert.equal(m.has('b3'), false);
  assert.equal(m.has('b4'), false);
});

test('equal roles fall back to event year, then name', () => {
  const db = fixture();
  db.prepare("UPDATE event_issues SET tier = 'tie-in' WHERE scanned_book_id = 'b1'").run();
  assert.deepEqual(eventMarkersFor(db, ['b1']).get('b1').map(e => e.name), ['Knight Terrors', 'Absolute Power']);
});

test('every mapped book gets an events list, empty when it is in none; large id lists are chunked', () => {
  const db = fixture();
  const books = withEventMarkers(db, [{ id: 'b1', title: 'x' }, { id: 'b9' }]);
  assert.equal(books[0].title, 'x');
  assert.equal(books[0].events.length, 2);
  assert.deepEqual(books[1].events, []);
  const many = Array.from({ length: 1200 }, (_, i) => `n${i}`).concat('b2');
  assert.equal(eventMarkersFor(db, many).get('b2')[0].id, 'ap');
  assert.equal(eventMarkersFor(db, []).size, 0);
});
