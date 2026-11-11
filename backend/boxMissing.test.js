'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let Database;
try { Database = require('better-sqlite3'); } catch { Database = null; }
const { createBoxMissing, pickVolume } = require('./boxMissing');

function setup(searchVolumes) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, series_json TEXT);
    CREATE TABLE collection_series (collection_id TEXT, series_id TEXT, manually_added INTEGER, PRIMARY KEY (collection_id, series_id));
    INSERT INTO scanned_series VALUES ('s-woods', 'The Woods', 2014, NULL), ('s-saga', 'Saga', 2012, '{"metadata":{"comicid":43763}}');`);
  const calls = [];
  const m = createBoxMissing({ db, logger: { info() {}, warn() {} }, searchVolumes: searchVolumes ? async q => { calls.push(q); return searchVolumes(q); } : null });
  return { db, m, calls };
}
const inBox = (db, id) => db.prepare('SELECT series_id FROM collection_series WHERE collection_id = ? ORDER BY series_id').all(id).map(r => r.series_id);

test('pickVolume: same name only; the year decides (exact, then ±1); no year → the longest run', () => {
  const res = [{ id: 1, name: 'Uzumaki', start_year: '2001', count_of_issues: 3 }, { id: 2, name: 'Uzumaki', start_year: '2013', count_of_issues: 1 }, { id: 3, name: 'Uzumaki Deluxe', start_year: '2013' }];
  assert.equal(pickVolume(res, 'uzumaki', 2013).id, 2);
  assert.equal(pickVolume(res, 'Uzumaki', 2002).id, 1);
  assert.equal(pickVolume(res, 'Uzumaki', 1990), null, 'a far-off year is not a match');
  assert.equal(pickVolume(res, 'Uzumaki', null).id, 1);
  assert.equal(pickVolume(res, 'Gyo', null), null);
});

test('missing series: library ones go into the box; the rest are kept once, then looked up on Comic Vine once per name and year', { skip: !Database }, async () => {
  const { db, m, calls } = setup(q => (q === 'Harrow County' ? [{ id: 777, name: 'Harrow County', start_year: '2015', count_of_issues: 32, image: { small_url: 'https://cv/hc.jpg' } }] : []));
  const r = m.add('box1', [
    { name: 'The Woods', start_year: 2014, reason: 'Already here' },
    { name: 'Harrow County', start_year: 2015, publisher: 'Dark Horse', reason: 'Southern gothic' },
    { name: 'harrow county!', start_year: 2015 },                                   // same series again
    { name: 'Gideon Falls', start_year: 2018 },
    { name: '' },
  ]);
  assert.deepEqual(r, { added: 2, in_library: ['s-woods'] });
  assert.deepEqual(inBox(db, 'box1'), ['s-woods']);
  await m.resolveSoon();
  assert.deepEqual(calls, ['Harrow County', 'Gideon Falls']);
  const list = m.list('box1');
  assert.deepEqual(list.map(x => [x.name, x.cv_volume_id, x.image_url, x.looked_up]), [['Harrow County', '777', 'https://cv/hc.jpg', true], ['Gideon Falls', null, null, true]]);
  // Another box with the same series reuses the lookup.
  m.add('box2', [{ name: 'Harrow County', start_year: 2015 }]);
  await m.resolveSoon();
  assert.equal(calls.length, 2);
  assert.equal(m.list('box2')[0].cv_volume_id, '777');
});

test('missing series: when the library gets the series it moves into the box; copy and forget', { skip: !Database }, async () => {
  const { db, m } = setup(() => [{ id: 43763, name: 'Saga', start_year: '2012' }]);
  db.prepare("DELETE FROM scanned_series WHERE id = 's-saga'").run();
  m.add('box1', [{ name: 'Saga', start_year: 2012 }]);
  await m.resolveSoon();
  m.copy('box1', 'box9');
  assert.equal(m.list('box9')[0].cv_volume_id, '43763');
  db.prepare("INSERT INTO scanned_series VALUES ('s-saga2', 'Saga (Image)', 2012, '{\"metadata\":{\"comicid\":43763}}')").run();   // arrives under another folder name
  assert.deepEqual(m.list('box1'), []);
  assert.deepEqual(inBox(db, 'box1'), ['s-saga2']);
  m.forget('box9');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collection_missing_series').get().n, 0);
});

test('missing series: a rate-limit refusal stops the lookups and leaves them pending', { skip: !Database }, async () => {
  const { m } = setup(() => { throw Object.assign(new Error('paused'), { code: 'CV_RATE_LIMIT' }); });
  m.add('box1', [{ name: 'Gyo', start_year: 2001 }]);
  await m.resolveSoon();
  assert.equal(m.list('box1')[0].looked_up, false);
});
