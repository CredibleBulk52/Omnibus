'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const create = require('./editorAdd');
function setup({ cvVolume = [], cvSearch = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, book_count INTEGER, series_json TEXT);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, cv_issue_id TEXT, title TEXT, filename TEXT);
    CREATE TABLE book_ci_index (book_id TEXT PRIMARY KEY, cv_issue_id TEXT, series_name TEXT, volume_year INTEGER, orig_number TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT, year INTEGER, publisher TEXT);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT);
    CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, title TEXT, parent_series TEXT, issue_range_hint TEXT, status TEXT);
    CREATE TABLE canon_run_issues (id INTEGER PRIMARY KEY, run_id INTEGER);
    INSERT INTO scanned_series VALUES ('s06', 'Wonder Woman', 2006, 40, '{"metadata":{"comicid":18208,"publisher":"DC Comics"}}'),
      ('s16', 'Wonder Woman', 2016, 3, '{"metadata":{"comicid":91774,"publisher":"DC Comics"}}'),
      ('s87', 'Wonder Woman', 1987, 200, NULL), ('sb', 'Batman', 1940, 700, NULL), ('sww', 'Wonder Woman: Earth One', 2016, 3, NULL),
      ('slg', 'L.E.G.I.O.N.', 1989, 70, NULL), ('slsh', 'Legion of Super-Heroes', 1989, 120, NULL);
    INSERT INTO scanned_books VALUES ('b1', 's16', '1', '537223', 'The Lies 1', 'Wonder Woman 001.cbz'), ('b2', 's16', '2', NULL, NULL, 'Wonder Woman 002.cbz'),
      ('ba', 's16', '1', NULL, NULL, 'Wonder Woman Annual 001.cbz'), ('hq', 's16', '1', NULL, NULL, 'Queen in Black Hela 001 (2026).cbz');
    ALTER TABLE scanned_books ADD COLUMN is_special INTEGER DEFAULT 0;
    UPDATE scanned_books SET is_special = 1 WHERE id = 'hq';
    INSERT INTO book_ci_index VALUES ('hq', NULL, 'Queen in Black: Hela', 2026, '1');
    INSERT INTO events VALUES ('e1', 'Wonder Woman: War of the Gods', 1991, 'DC');
    INSERT INTO canon_runs VALUES (1, 'Wonder Woman: The Lies', 'Wonder Woman', '#1, 3', 'approved'), (2, 'Wonder Woman draft', 'Wonder Woman', '', 'pending');`);
  const routes = {};
  create({ app: { get: (p, ...h) => { routes[p] = h.at(-1); } }, db, requireAuth: () => {}, getCVKey: () => 'k', logger: { warn() {} },
    IN: { normIssueNumber: n => String(n).replace(/^0+(?=\d)/, '') },
    fetchVolumeIssues: async () => cvVolume,
    cvApiGet: async () => ({ data: { status_code: 1, results: cvSearch } }) });
  const call = async (path, query, user = { role: 'admin' }) => { const out = {}; const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; } }; await routes[path]({ query, user }, res); return out; };
  return { call };
}
test('search: library volumes by name and year (exact, then the year either side); events and runs for lists', async () => {
  const { call } = setup();
  let r = (await call('/api/editor/add/search', { q: 'wonder woman', year: '2016', lists: '1' })).body;
  assert.deepEqual(r.volumes.map(v => v.id), ['s16', 'sww']);   // exact name first
  assert.equal(r.volumes[0].cv_volume_id, '91774'); assert.equal(r.yearMatch, 'exact');
  assert.deepEqual(r.runs.map(x => x.id), ['1', '2']);
  assert.deepEqual((await call('/api/editor/add/search', { q: 'wonder woman', lists: '1' }, { role: 'user' })).body.runs.map(x => x.id), ['1']);   // pending runs: admin only
  r = (await call('/api/editor/add/search', { q: 'wonder woman', year: '2017' })).body;
  assert.equal(r.yearMatch, 'near'); assert.deepEqual(r.volumes.map(v => v.id), ['s16', 'sww']);
  assert.equal((await call('/api/editor/add/search', { q: 'wonder woman', year: '1991', lists: '1' })).body.events[0].id, 'e1');
});
test('search: Comic Vine volumes, marked when already in the library', async () => {
  const { call } = setup({ cvSearch: [{ id: 91774, name: 'Wonder Woman', start_year: '2016', publisher: { name: 'DC Comics' }, count_of_issues: 83 }, { id: 5, name: 'Wonder Woman', start_year: '2025', count_of_issues: 2 }] });
  const r = (await call('/api/editor/add/search', { q: 'wonder woman', year: '2016', cv: '1' })).body;
  assert.deepEqual(r.cv.map(v => [v.id, v.in_library]), [['91774', true]]);
});
test('volume: Comic Vine issues with owned books (by Comic Vine id, else number; annual files never by number); extra books kept', async () => {
  const { call } = setup({ cvVolume: [{ id: 537223, issue_number: '1', name: 'The Lies' }, { id: 539226, issue_number: '2' }, { id: 541185, issue_number: '3', image: { thumb_url: 'http://cv/3.jpg' } }] });
  const r = (await call('/api/editor/add/volume', { library: 's16' })).body;
  // Annuals and specials filed here come last, under the name they were published as.
  assert.deepEqual(r.issues.map(i => [i.number, i.book_id, !!i.extra, i.group || null]),
    [['1', 'b1', false, null], ['2', 'b2', false, null], ['3', null, false, null], ['1', 'ba', false, 'Wonder Woman Annual'], ['1', 'hq', false, 'Queen in Black: Hela (2026)']]);
  assert.equal(r.issues[2].image, 'http://cv/3.jpg');
  assert.deepEqual([r.issues[4].series_name, r.issues[4].volume_year, r.issues[4].kind], ['Queen in Black: Hela', 2026, 'special']);
  const c = (await call('/api/editor/add/volume', { cv: '91774', name: 'Wonder Woman', year: '2016' })).body;
  assert.deepEqual(c.issues.map(i => [i.number, i.book_id]), [['1', 'b1'], ['2', null], ['3', null]]);   // cv volume: owned only by id
});

test('search: annuals and specials by published name or "<series> annual" return the parent volume, focused on them', async () => {
  const { call } = setup();
  let r = (await call('/api/editor/add/search', { q: 'wonder woman annual' })).body;
  assert.equal(r.volumes[0].id, 's16'); assert.deepEqual(r.volumes[0].focus, { name: 'Wonder Woman Annual', year: null, kind: 'annual' });
  r = (await call('/api/editor/add/search', { q: 'queen in black hela' })).body;
  assert.deepEqual(r.volumes.map(v => [v.id, v.focus && v.focus.name]), [['s16', 'Queen in Black: Hela']]);
  r = (await call('/api/editor/add/search', { q: 'wonder woman' })).body;          // the plain name: no focus
  assert.ok(r.volumes.every(v => !v.focus));
});

test('search: dotted initials ("L.E.G.I.O.N.") are one word, with or without the dots', async () => {
  const { call } = setup();
  for (const q of ['L.E.G.I.O.N.', 'legion', 'L.E.G.I.O.N'])
    assert.equal((await call('/api/editor/add/search', { q })).body.volumes[0]?.name, 'L.E.G.I.O.N.', q);
  assert.equal((await call('/api/editor/add/search', { q: 'L.E.G.I.O.N.', year: '1989' })).body.volumes[0]?.name, 'L.E.G.I.O.N.');
});
