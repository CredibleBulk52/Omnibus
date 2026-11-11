'use strict';
// Editor Tools (editorTools.js + sharedMatcher.js): Re-match preview/apply and the Rebuild preview.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const IN = require('./issueNumber');
const logger = { info() {}, warn() {}, error() {} };

function setup({ plan } = {}) {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...a) => { db.exec('BEGIN'); try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, cv_issue_id TEXT, monitored_issue_id TEXT, filename TEXT, title TEXT, comicinfo TEXT, is_special INTEGER DEFAULT 0);
    INSERT INTO scanned_series VALUES ('s1','Avengers',1998),('s2','Avengers',2012),('s3','The Flash',2016),('s4','Aquaman',2011),('s5','Aquaman',2016),('s7','Batwoman',2011),('s8','Batwoman',2017);
    INSERT INTO scanned_books (id, series_id, issue_number, cv_issue_id, filename) VALUES
      ('b1','s1','14','50773','Avengers 014 (1999).cbz'), ('b2','s2','14','400014','Avengers 014 (2013).cbz'),
      ('b3','s3','790','790790','The Flash 790 (2023).cbz'), ('b4','s4','50',NULL,'Aquaman 050.cbz'), ('b5','s5','50',NULL,'Aquaman 050 (2019).cbz'),
      ('b7','s7','3','7003','Batwoman 003 (2012).cbz'), ('b8','s8','3','8003','Batwoman 003 (2017).cbz'), ('b9','s8','4','8004','Batwoman 004 (2017).cbz');
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO events VALUES ('e','Infinity'), ('e2','Hydrology');
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, cv_issue_id TEXT, scanned_book_id TEXT, sort_order INTEGER, series_name TEXT, issue_number TEXT, volume_year TEXT, manually_matched INTEGER DEFAULT 0);
    INSERT INTO event_issues VALUES (1,'e','50773','b1',1,'Avengers','14','2012',0), (2,'e','790790',NULL,2,'The Flash','790','1959',0),
      (3,'e',NULL,'b4',3,'Aquaman','50','2016',0), (4,'e',NULL,'b1',4,'Avengers','14','1998',1),
      (6,'e2','8003','b8',1,'Batwoman','3','2011',1), (7,'e2',NULL,'b9',2,'Batwoman','4','2011',1), (8,'e2',NULL,'b8',3,'Batwoman','9','2017',1), (9,'e2',NULL,'b2',4,'Avengers','14','2012',1);
    CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, title TEXT, cv_volume_id TEXT, status TEXT DEFAULT 'pending', issue_range_hint TEXT);
    INSERT INTO canon_runs (id, title, cv_volume_id, issue_range_hint) VALUES (9,'Avengers by Hickman','91298','#14-15, #50 (2012 vol)'), (10,'The Killing Joke',NULL,'One-shot (1988)');
    CREATE TABLE canon_run_issues (id INTEGER PRIMARY KEY, run_id INTEGER, cv_issue_id TEXT, scanned_book_id TEXT, sort_order INTEGER, series_name TEXT, issue_number TEXT, volume_year TEXT, manually_matched INTEGER DEFAULT 0);
    INSERT INTO canon_run_issues VALUES (21,9,'50773','b1',1,'Avengers','14','2012',0), (22,9,'x2',NULL,2,'Avengers','15','2012',0), (23,9,'x3','b5',3,'Aquaman','50','2016',1), (24,9,NULL,NULL,4,'Avengers','14','2012',0);`);
  const bookIndex = require('./bookIndex')({ db, logger, IN });
  const key = bookIndex.nameKey;
  const ci = db.prepare('INSERT INTO book_ci_index (book_id, series_name, name_key, volume_year, number, orig_number) VALUES (?,?,?,?,?,?)');
  ci.run('b2', 'Avengers', key('Avengers'), 2012, '14', '14');
  ci.run('b4', 'Aquaman', key('Aquaman'), 2016, '50', '50');   // no <Volume>: the 2016 cover year
  const routes = {};
  const reg = m => (p, ...h) => { routes[m + ' ' + p] = h.at(-1); };
  const bookCvId = id => db.prepare('SELECT cv_issue_id FROM scanned_books WHERE id = ?').get(id)?.cv_issue_id || null;
  const resolveCanonRun = async (id, opts) => { assert.equal(opts.dryRun, true); return plan; };
  const canonResolveResults = new Map([['10', { at: 1, error: null, skipped: 'no matching volume', inserted: null }]]);
  require('./editorTools')({ app: { get: reg('GET'), post: reg('POST') }, db, requireAdmin: () => {}, logger, IN, bookIndex, bookCvId, resolveCanonRun, canonResolveResults });
  const call = async (key, params, body, query = {}) => { const out = {}; const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; } };
    await routes[key]({ params, body, query, user: { username: 'a' } }, res); return out; };
  return { db, call };
}

test('re-match event: stored id from another volume, legacy number, closest folder year; hand matches untouched', async () => {
  const { db, call } = setup();
  const g = await call('GET /api/editor/:kind(event|run)/:id/rematch', { kind: 'event', id: 'e' });
  assert.equal(g.body.manual, 1);
  const by = new Map(g.body.proposals.map(p => [p.id, p]));
  assert.equal(g.body.proposals.length, 3);
  assert.equal(by.get(1).proposed.book_id, 'b2'); assert.equal(by.get(1).cvFix, true); assert.equal(by.get(1).current.book_id, 'b1');
  assert.equal(by.get(2).proposed.book_id, 'b3'); assert.equal(by.get(2).how, 'cv');   // The Flash #790 is in the 2016 volume
  assert.equal(by.get(3).proposed.book_id, 'b5'); assert.equal(by.get(3).strong, true);
  const a = await call('POST /api/editor/:kind(event|run)/:id/rematch', { kind: 'event', id: 'e' }, { items: [{ id: 1, book_id: 'b2' }, { id: 3, book_id: 'b5' }, { id: 2, book_id: 'b9' }] });
  assert.deepEqual(a.body.stale, [2]);
  assert.deepEqual(db.prepare('SELECT id, scanned_book_id b, cv_issue_id cv FROM event_issues WHERE event_id = ? ORDER BY id').all('e').map(r => ({ ...r })),
    [{ id: 1, b: 'b2', cv: '400014' }, { id: 2, b: null, cv: '790790' }, { id: 3, b: 'b5', cv: null }, { id: 4, b: 'b1', cv: null }]);
  const g2 = await call('GET /api/editor/:kind(event|run)/:id/rematch', { kind: 'event', id: 'e' });
  assert.deepEqual(g2.body.proposals.map(p => p.id), [2]);
  // Right match, wrong stored id: offered as an id fix alone.
  db.exec("UPDATE event_issues SET cv_issue_id = '50773' WHERE id = 1");
  const g3 = await call('GET /api/editor/:kind(event|run)/:id/rematch', { kind: 'event', id: 'e' });
  const p1 = g3.body.proposals.find(p => p.id === 1);
  assert.equal(p1.cvOnly, true); assert.equal(p1.proposed.book_id, 'b2');
  await call('POST /api/editor/:kind(event|run)/:id/rematch', { kind: 'event', id: 'e' }, { items: [{ id: 1, book_id: 'b2' }] });
  assert.equal(db.prepare('SELECT cv_issue_id FROM event_issues WHERE id = 1').get().cv_issue_id, '400014');
});

test('re-match run: exact signals only; a book another issue holds is not proposed', async () => {
  const { call } = setup();
  const g = await call('GET /api/editor/:kind(event|run)/:id/rematch', { kind: 'run', id: '9' });
  assert.deepEqual(g.body.proposals.map(p => [p.id, p.proposed.book_id, p.how]), [[21, 'b2', 'comicinfo']]);
  assert.equal(g.body.manual, 1);
  assert.equal(g.body.none, 2);   // #15: no exact signal, no guess; the second Avengers #14: its book is already proposed for #21
});

test('rebuild preview: new, kept and removed issues', async () => {
  const plan = { dryRun: true, cvVolumeId: '91298', volume: { source: 'stored', name: 'Avengers' }, total: 44, inRange: 2, kept: 1,
    issues: [{ cv_issue_id: '50773', issue_number: '14', book_id: 'b1' }, { cv_issue_id: '50774', issue_number: '16', book_id: null }] };
  const { call } = setup({ plan });
  const r = await call('GET /api/editor/run/:id/rebuild', { id: '9' }, null, {});
  assert.deepEqual(r.body.issues.map(i => [i.issue_number, i.isNew]), [['14', false], ['16', true]]);
  assert.deepEqual(r.body.removed.map(x => x.id), [22, 24]);
  assert.deepEqual(r.body.handMatched.map(x => x.id), [23]);
});

test('hand matches: a different exact match is offered (and stays a hand match); doubtful ones are listed', async () => {
  const { db, call } = setup();
  const g = await call('GET /api/editor/:kind(event|run)/:id/rematch', { kind: 'event', id: 'e2' });
  assert.deepEqual(g.body.proposals.map(p => [p.id, p.proposed.book_id, !!p.manual]), [[6, 'b7', true]]);
  assert.deepEqual(g.body.handCheck.map(c => [c.id, c.reason]), [[7, 'its volume year is 6 years off'], [8, 'it is #3']]);   // #9 → Avengers (2012) #14 is fine
  await call('POST /api/editor/:kind(event|run)/:id/rematch', { kind: 'event', id: 'e2' }, { items: [{ id: 6, book_id: 'b7' }] });
  assert.deepEqual({ ...db.prepare('SELECT scanned_book_id b, manually_matched m, cv_issue_id cv FROM event_issues WHERE id = 6').get() }, { b: 'b7', m: 1, cv: '7003' });
});

test('pending runs: issues found against the range note, and the last Auto-resolve result', async () => {
  const { call } = setup();
  const r = await call('GET /api/editor/runs/check', {}, null, {});
  const by = new Map(r.body.map(x => [x.id, x]));
  assert.deepEqual([by.get(9).total, by.get(9).owned, by.get(9).expected, by.get(9).result], [4, 2, 3, null]);
  assert.deepEqual([by.get(10).total, by.get(10).expected, by.get(10).result.skipped], [0, 1, 'no matching volume']);
});
