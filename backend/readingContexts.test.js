'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { create, parse } = require('./readingContexts');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, library_id TEXT);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, sort_order INTEGER);
    CREATE TABLE read_progress (id INTEGER PRIMARY KEY, book_id TEXT, user_id TEXT, page INTEGER DEFAULT 0, completed INTEGER DEFAULT 0, marked INTEGER DEFAULT 0, updated_at TEXT, UNIQUE(user_id, book_id));
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, scanned_book_id TEXT, sort_order INTEGER, tier TEXT);
    CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE canon_run_issues (id INTEGER PRIMARY KEY, run_id INTEGER, scanned_book_id TEXT, sort_order INTEGER);
    CREATE TABLE reading_lists (id INTEGER PRIMARY KEY, name TEXT, visibility TEXT);
    INSERT INTO scanned_series VALUES ('gl', 'Green Lantern', 'dc'), ('fl', 'The Flash', 'dc'), ('va', 'Valor', 'dc');
    INSERT INTO scanned_books VALUES ('gl0', 'gl', '0', 1), ('gl1', 'gl', '1', 2), ('fl0', 'fl', '0', 1), ('va20', 'va', '20', 1), ('va21', 'va', '21', 2);
    INSERT INTO events VALUES ('zh', 'Zero Hour');
    INSERT INTO event_issues (event_id, scanned_book_id, sort_order, tier) VALUES ('zh', 'va20', 1, 'recommended'), ('zh', 'gl0', 2, 'essential'), ('zh', NULL, 3, 'essential'), ('zh', 'fl0', 4, 'all');
    INSERT INTO canon_runs VALUES (5, 'Kyle Rayner begins');
    INSERT INTO canon_run_issues (run_id, scanned_book_id, sort_order) VALUES (5, 'gl0', 1), (5, 'gl1', 2);
    INSERT INTO reading_lists VALUES (9, 'Speed Force', 'essential');`);
  const lists = { orderedBooks: (id, user) => (String(id) === '9' ? ['fl0', 'va21'] : null) };
  const rc = create({ db, readingLists: lists });
  let clock = 0;
  const read = (book, page, completed, ctx) => {
    clock++;
    db.prepare(`INSERT INTO read_progress (book_id, user_id, page, completed, updated_at) VALUES (?, 'u', ?, ?, datetime('2026-10-29', '+${clock} minutes'))
      ON CONFLICT(user_id, book_id) DO UPDATE SET page = excluded.page, completed = excluded.completed, updated_at = excluded.updated_at`).run(book, page, completed ? 1 : 0);
    rc.record('u', book, ctx ? parse(ctx) : null, { page, completed: completed ? 1 : 0 });
    db.prepare(`UPDATE reading_contexts SET updated_at = datetime('2026-10-29', '+${clock} minutes') WHERE last_book_id = ?`).run(book);
  };
  return { db, rc, read };
}

test('parse accepts only event / run / list contexts with safe ids', () => {
  assert.deepEqual(parse({ kind: 'event', id: 'zh', minTier: 'essential' }), { kind: 'event', id: 'zh', minTier: 'essential', key: 'event:zh' });
  assert.equal(parse({ kind: 'list', id: 9, minTier: 'essential' }).minTier, null);
  for (const bad of [null, {}, { kind: 'series', id: 'x' }, { kind: 'list', id: '../1' }, { kind: 'run', id: '' }]) assert.equal(parse(bad), null);
});

test('event card: the next issue in event order, across series, following the reading path', () => {
  const { rc, read } = setup();
  read('va20', 22, true, { kind: 'event', id: 'zh', minTier: 'all' });
  let c = rc.cards('u').cards;
  assert.equal(c.length, 1);
  assert.equal(c[0].id, 'gl0');                         // Valor #20 done → Green Lantern #0, not Valor #21
  assert.equal(c[0].fromContext.name, 'Zero Hour');
  assert.equal(c[0].fromContext.readQs, '?eventId=zh&minTier=all');
  assert.deepEqual([c[0].fromContext.position, c[0].fromContext.total, c[0].fromContext.read], [2, 3, 1]);
  read('gl0', 5, false, { kind: 'event', id: 'zh', minTier: 'all' });
  c = rc.cards('u').cards;
  assert.equal(c[0].id, 'gl0'); assert.equal(c[0].page, 5);   // part-read: resume it
  read('gl0', 22, true, { kind: 'event', id: 'zh', minTier: 'essential' });
  assert.equal(rc.cards('u').cards.length, 0);           // essential path: nothing after GL #0 owned → finished
  read('gl0', 22, true, { kind: 'event', id: 'zh', minTier: 'all' });
  assert.equal(rc.cards('u').cards[0].id, 'fl0');
});

test('run and list cards; an issue read on its own clears its context; hide until read again', () => {
  const { rc, read, db } = setup();
  read('gl0', 22, true, { kind: 'run', id: '5' });
  read('fl0', 3, false, { kind: 'list', id: '9' });
  let c = rc.cards('u').cards;
  assert.deepEqual(c.map(x => [x.fromContext.kind, x.id]), [['list', 'fl0'], ['run', 'gl1']]);
  assert.equal(c[0].fromContext.to, '/essentials/9');
  assert.equal(rc.seriesLastContext('u', 'gl'), 'run:5');
  read('gl0', 22, true, null);                            // re-read outside the run
  assert.equal(rc.seriesLastContext('u', 'gl'), null);
  assert.equal(rc.dismiss('u', 'list:9'), true);
  db.exec("UPDATE reading_contexts SET dismissed_at = datetime('2026-10-29', '+3 minutes') WHERE ctx = 'list:9'");   // on the test's clock
  c = rc.cards('u');
  assert.deepEqual(c.cards.map(x => x.fromContext.kind), ['run']);
  assert.ok(c.live.has('list:9'));                        // hidden, still live (its series stay off)
  read('fl0', 9, false, { kind: 'list', id: '9' });
  assert.equal(rc.cards('u').cards[0].fromContext.kind, 'list');
  assert.equal(rc.cards('u', { libraryId: 'marvel' }).cards.length, 0);
  db.exec('DELETE FROM canon_runs');
  assert.equal(rc.cards('u').live.has('run:5'), false);   // a deleted run gives its series back
});

test('opening an issue (page 0) does not start a context; no access to a list → no card', () => {
  const { rc, read } = setup();
  read('va21', 0, false, { kind: 'list', id: '9' });
  assert.equal(rc.cards('u').cards.length, 0);
  read('va21', 2, false, { kind: 'list', id: '7' });
  assert.equal(rc.cards('u').cards.length, 0);
});

test('nextIn: part-read last issue, then first unfinished after, then first unfinished anywhere', () => {
  const { rc } = setup();
  const p = m => new Map(Object.entries(m));
  assert.equal(rc.nextIn(['a', 'b', 'c'], 'b', p({ b: { page: 4, completed: 0 } })), 1);
  assert.equal(rc.nextIn(['a', 'b', 'c'], 'b', p({ b: { page: 9, completed: 1 } })), 2);
  assert.equal(rc.nextIn(['a', 'b', 'c'], 'c', p({ b: { completed: 1 }, c: { completed: 1 } })), 0);
  assert.equal(rc.nextIn(['a'], 'a', p({ a: { completed: 1 } })), -1);
});
