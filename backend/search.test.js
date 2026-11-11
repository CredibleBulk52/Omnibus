'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSearch, parseQuery, scoreName, norm } = require('./search');

test('parseQuery: volume years and issue numbers', () => {
  assert.deepEqual(parseQuery('Batman 1940'), { full: 'batman 1940', title: 'batman', year: 1940, issue: null });
  assert.deepEqual(parseQuery('Batman #497'), { full: 'batman 497', title: 'batman', year: null, issue: '497' });
  assert.deepEqual(parseQuery('Batman 497'), { full: 'batman 497', title: 'batman', year: null, issue: '497' });
  assert.deepEqual(parseQuery('Batman 1940 497'), { full: 'batman 1940 497', title: 'batman', year: 1940, issue: '497' });
  assert.deepEqual(parseQuery('Green Lantern 2005 #001'), { full: 'green lantern 2005 001', title: 'green lantern', year: 2005, issue: '1' });
  assert.equal(parseQuery('52').issue, null);   // a one-word title stays a title
});

test('scoreName: forgiving matches, ordered', () => {
  assert.equal(scoreName('Spider-Man', norm('spiderman')), 95);
  assert.equal(scoreName('The X-Men', norm('x men')), 100);
  assert.equal(scoreName('Batman: Year One', norm('batman year one')), 100);
  assert.ok(scoreName('Batman', 'batman') > scoreName('Batman Beyond', 'batman'));
  assert.ok(scoreName('Batman Beyond', 'batman') > scoreName('Detective Comics', 'batman'));
  assert.equal(scoreName('Daredevil', 'superman'), 0);
});

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE libraries (id TEXT, name TEXT);
    CREATE TABLE scanned_series (id TEXT, library_id TEXT, name TEXT, year INTEGER, book_count INTEGER);
    CREATE TABLE scanned_books (id TEXT, series_id TEXT, title TEXT, filename TEXT, issue_number TEXT, comicinfo TEXT);
    CREATE TABLE read_progress (book_id TEXT, user_id TEXT, page INTEGER, completed INTEGER);
    CREATE TABLE events (id TEXT, name TEXT, year INTEGER, publisher TEXT);
    CREATE TABLE event_issues (event_id TEXT, scanned_book_id TEXT, sort_order INTEGER);
    CREATE TABLE canon_runs (id INTEGER, title TEXT, parent_series TEXT, status TEXT);
    CREATE TABLE canon_run_issues (run_id INTEGER, scanned_book_id TEXT, sort_order INTEGER);
    CREATE TABLE reading_lists (id INTEGER, name TEXT, visibility TEXT, owner_id TEXT);
    INSERT INTO scanned_series VALUES ('b40','L','Batman',1940,700),('b16','L','Batman',2016,150),('bb','L','Batman Beyond',1999,24),('sm','L','The Amazing Spider-Man',1963,800),('dc','L','Detective Comics',1937,900);
    INSERT INTO scanned_books VALUES ('k497','b40','Knightfall Part 11','Batman 497.cbz','497','<ComicInfo><Title>Knightfall, Part 11</Title></ComicInfo>'),('n1','b16','I Am Gotham','Batman 001.cbz','1',NULL);
    INSERT INTO events VALUES ('e1','Batman: Knightfall',1993,'DC'),('e2','Infinite Crisis',2005,'DC');
    INSERT INTO event_issues VALUES ('e1','k497',1);
    INSERT INTO canon_runs VALUES (7,'Batman: Year One','Batman','approved'),(8,'Secret Run','Batman','pending');
    INSERT INTO reading_lists VALUES (1,'Batman for beginners','public','u2'),(2,'My secret Batman','private','u2'),(3,'My Batman','private','u1');`);
  const all = db.prepare('SELECT * FROM scanned_series').all();
  return createSearch({ db, fetchAllSeries: () => all, mergeSeriesWithJson: s => ({ ...s }), creatorsCache: new Map([['dc', { writers: ['Tom King'], artists: [] }]]) });
}

test('search: ranking, volume year, issue jump, events, runs, lists', () => {
  const s = setup();
  const r = s.search({ q: 'batman', user: { sub: 'u1' } });
  assert.deepEqual(r.series.slice(0, 3).map(x => x.id).sort(), ['b16', 'b40', 'bb']);
  assert.ok(['b40', 'b16'].includes(r.series[0].id));
  assert.equal(r.series[2].id, 'bb');
  assert.deepEqual(r.events.map(e => e.id), ['e1']);
  assert.deepEqual(r.runs.map(x => x.id), [7]);                       // pending runs left out
  assert.deepEqual(r.lists.map(l => l.id).sort(), [1, 3]);           // someone else's private list left out
  assert.equal(s.search({ q: 'Batman 2016' }).series[0].id, 'b16');
  const j = s.search({ q: 'batman #497' });
  assert.deepEqual(j.issues.map(i => [i.id, i.title]), [['k497', 'Knightfall, Part 11']]);
  assert.equal(s.search({ q: 'Batman 1940 497' }).issues[0].id, 'k497');
  assert.equal(s.search({ q: 'spiderman' }).series[0].id, 'sm');
  assert.equal(s.search({ q: 'tom king' }).series[0].matched_by, 'creator');
  const sug = s.suggest({ q: 'batman 497' });
  assert.equal(sug[0].type, 'issue');
  assert.equal(sug[0].url, '/read/k497');
});

test('issue jump with a year keeps to that volume', () => {
  const s = setup();
  const r = s.search({ q: 'Batman 2016 1' });
  assert.deepEqual(r.issues.map(i => i.id), ['n1']);
});

// Annuals and specials (2026-10-26): found as issues of the parent series they are filed in.
function setupSubs() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT, library_id TEXT, name TEXT, year INTEGER, book_count INTEGER);
    CREATE TABLE scanned_books (id TEXT, series_id TEXT, title TEXT, filename TEXT, issue_number TEXT, comicinfo TEXT, is_special INTEGER DEFAULT 0);
    CREATE TABLE book_ci_index (book_id TEXT, series_name TEXT, volume_year INTEGER, orig_number TEXT);
    INSERT INTO scanned_series VALUES ('b11','L','Batman',2011,58),('qb','L','Queen in Black',2026,5),('si','L','Sinestro',2014,25),('th','L','Thor',2025,10);
    INSERT INTO scanned_books VALUES ('r3','b11','The Thirteenth Hour','Batman 003.cbz','3',NULL,0),
      ('a3','b11','Friends','Batman Annual 003 (2015).cbz','3',NULL,0),
      ('a1','b11','First Snow','Batman Annual 001 (2012).cbz','1',NULL,0),
      ('h1','qb',NULL,'Queen in Black Hela 001 (2026).cbz','1',NULL,1),
      ('t1','th',NULL,'Queen in Black Thor 001 (2026).cbz','1',NULL,1),
      ('s1','si',NULL,'Sinestro Annual 001 (After 11).cbz','1',NULL,0);
    INSERT INTO book_ci_index VALUES ('a3','Batman Annual',2012,'3'),('a1','Batman Annual',2012,'1'),('h1','Queen in Black: Hela',2026,'1'),('t1','Queen in Black: Thor',2026,'1');`);
  const all = db.prepare('SELECT * FROM scanned_series').all();
  return createSearch({ db, fetchAllSeries: () => all, mergeSeriesWithJson: s => ({ ...s }), creatorsCache: new Map() });
}

test('annuals and specials: by published name, with the parent series', () => {
  const s = setupSubs();
  let r = s.search({ q: 'Batman Annual 3' });
  assert.deepEqual(r.issues.map(i => [i.id, i.sub_name, i.series_name]), [['a3', 'Batman Annual', 'Batman']]);
  assert.equal(r.series[0].id, 'b11'); assert.equal(r.series[0].contains, 'Batman Annual');
  assert.deepEqual(s.search({ q: 'Sinestro Annual 1' }).issues.map(i => [i.id, i.sub_name]), [['s1', 'Sinestro Annual']]);   // name from the file
  assert.deepEqual(s.search({ q: 'Queen in Black Hela' }).books.map(b => b.id), ['h1']);
  assert.deepEqual(s.search({ q: 'hela' }).books.map(b => [b.id, b.series_name]), [['h1', 'Queen in Black']]);
  assert.deepEqual(s.search({ q: 'batman annual' }).books.map(b => b.id), ['a1', 'a3']);
  assert.deepEqual(s.search({ q: 'thor special' }).books.map(b => b.id), ['t1']);           // "<series> special"
  const sug = s.suggest({ q: 'Batman Annual 3' });
  assert.equal(sug[0].label, 'Batman Annual #3'); assert.match(sug[0].sub, /in Batman \(2011\)/);
  assert.ok(sug.some(x => x.type === 'series' && x.url === '/series/b11?tab=annuals'));
});

test('annuals and specials stay out of plain searches; "Batman 3" is the regular issue', () => {
  const s = setupSubs();
  assert.deepEqual(s.search({ q: 'Batman 3' }).issues.map(i => i.id), ['r3']);
  // "Queen in Black": not its own folder's Hela special, but the Thor tie-in filed in Thor.
  assert.deepEqual(s.search({ q: 'Queen in Black' }).books.filter(b => b.sub_name).map(b => b.id), ['t1']);
  assert.deepEqual(s.search({ q: 'Thor' }).books.filter(b => b.sub_name).map(b => b.id), []);
  assert.deepEqual(s.search({ q: 'Batman Annual 2016' }).books, []);                       // year filters
});
