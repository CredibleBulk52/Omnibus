'use strict';
// Missing annuals on series pages (2026-11-10).
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSeriesAnnuals } = require('./seriesAnnuals');
const { yearlyTag } = require('./annualNames');

function setup({ monitored = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...a) => { db.exec('BEGIN'); try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, path TEXT, year INTEGER);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, filename TEXT, cv_issue_id TEXT);
    CREATE TABLE book_ci_index (book_id TEXT, series_name TEXT, volume_year INTEGER, cv_issue_id TEXT);
    CREATE TABLE monitored_series (id TEXT PRIMARY KEY, name TEXT, publisher TEXT, year INTEGER, total_issues INTEGER, image_url TEXT, cv_url TEXT, directory TEXT,
      series_type TEXT, parent_series_id TEXT, is_special INTEGER, series_status TEXT, fill_auto_remove INTEGER, fill_started_at TEXT, last_cv_check TEXT, annual_no_match_until TEXT);
    CREATE TABLE monitored_issues (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, title TEXT, release_date TEXT, store_date TEXT, cv_data TEXT, is_annual INTEGER, status TEXT, retry_after TEXT);
    CREATE TABLE series_annual_links (parent_series_id TEXT, annual_series_id TEXT, PRIMARY KEY (parent_series_id, annual_series_id));
    INSERT INTO scanned_series VALUES ('ss1', 'The Sensational Spider-Man', '/c/ssm', 1996);
    INSERT INTO scanned_books VALUES ('b1', 'ss1', 'The Sensational Spider-Man 001 (1996).cbz', '901'),
      ('b2', 'ss1', 'Sensational Spider-Man ''96 1996 Annual 001.cbz', '153415');
    INSERT INTO book_ci_index VALUES ('b2', 'Sensational Spider-Man ''96', 1996, '153415');`);
  if (monitored) db.exec(`INSERT INTO monitored_series (id, name, publisher, directory) VALUES ('100', 'The Sensational Spider-Man', 'Marvel', '/c/ssm')`);
  const routes = {}, calls = { cv: 0, discover: [], grab: [] };
  const reg = m => (p, ...h) => { routes[`${m} ${p}`] = h.at(-1); };
  const app = { get: reg('GET'), post: reg('POST') };
  const regular = [['1996-01-10', '0'], ['1996-11-01', '10'], ['1998-11-01', '33'], ['2012-04-01', '33.1']].map(([d, n], k) => ({ id: 'r' + k, number: n, cover_date: d, store_date: null }));
  const volumes = {
    200: [{ id: '153415', issue_number: '1', name: 'Kraven', cover_date: '1996-11-01' }],
    300: [{ id: '700', issue_number: '1', cover_date: '1970-06-01' }, { id: '701', issue_number: '20', cover_date: '1997-08-01', image: { thumb_url: 't.jpg' } }],
  };
  const deps = { app, db, requireAuth: (q, r, n) => n(), requireAdmin: (q, r, n) => n(), requireDownloadAccess: (q, r, n) => n(),
    logger: { info() {}, warn() {}, error() {} }, IN: { normIssueNumber: n => String(n) },
    cvApiGet: async url => { calls.cv++; assert.match(url, /issue\/4000-153415/); return { data: { results: { id: 153415, volume: { id: 200, name: "Sensational Spider-Man '96" } } } }; },
    getCVKey: () => 'fake-key',
    fillContext: async id => (id === 'ss1' ? { scanned: db.prepare('SELECT * FROM scanned_series WHERE id = ?').get('ss1'), meta: { name: 'The Sensational Spider-Man', publisher: 'Marvel', year: 1996 },
      volId: '100', monitored: db.prepare('SELECT * FROM monitored_series WHERE id = ?').get('100') || null, issues: regular } : { status: 404, error: 'Series not found' }),
    fetchVolumeIssues: async id => volumes[id] || [], withTimeout: p => p,
    canDownload: u => u.role === 'admin', mineFor: () => ({}),
    autoDiscoverAnnuals: async (id, name, dir, alt) => { calls.discover.push({ id, name, dir, alt: !!alt }); if (alt) { assert.equal(alt.firstDate, '1996-01-10'); alt.link({ id: 300, name: 'Spectacular Annual', start_year: 1970 }); } },
    yearlyTag, runRefreshDirectory: async () => {}, scanSeriesComicInfo: async () => {}, startAutoGrab: id => { calls.grab.push(id); return {}; }, detectSeriesType: () => 'comic' };
  const sa = createSeriesAnnuals(deps);
  const call = async (key, params, body = {}, user = { sub: 'a', role: 'admin' }) => { const out = {};
    const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; }, headersSent: false };
    await routes[key]({ params, body, user }, res); return out; };
  return { db, sa, call, calls, deps };
}

test('series annuals: a factory missing a piece refuses to start', () => {
  assert.throws(() => createSeriesAnnuals({ app: {} }), /createSeriesAnnuals: missing db/);
});

test('series annuals: the volume of an annual file in the folder is found once, and its owned issue is not missing', async () => {
  const { call, calls } = setup();
  const r = await call('GET /api/series/:id/annual-gaps', { id: 'ss1' });
  assert.deepEqual(r.body.volumes.map(v => [v.id, v.source, v.missing]), [['200', 'library', 0]]);
  assert.deepEqual(r.body.rows, []);
  await call('GET /api/series/:id/annual-gaps', { id: 'ss1' });
  assert.equal(calls.cv, 1);                                     // kept in cv_issue_volume
});

test('series annuals: Find annuals on a series that is not monitored keeps the volume here; only annuals within the run show', async () => {
  const { db, call, calls } = setup();
  const f = await call('POST /api/series/:id/find-annuals', { id: 'ss1' });
  assert.deepEqual(calls.discover, [{ id: '100', name: 'The Sensational Spider-Man', dir: '/c/ssm', alt: true }]);
  assert.deepEqual(f.body.found.map(v => v.id), ['300']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM monitored_series').get().n, 0);        // Download Manager untouched
  const r = await call('GET /api/series/:id/annual-gaps', { id: 'ss1' });
  assert.deepEqual(r.body.rows.map(x => [x.id, x.volume_id, x.state, x.image]), [['701', '300', 'missing', 't.jpg']]);   // the 1970 annual is another run's
});

test('series annuals: Get adds the volume as a Fill entry with only the pick wanted; a monitored series gets it linked', async () => {
  for (const monitored of [false, true]) {
    const { db, call, calls } = setup({ monitored });
    if (monitored) db.exec(`INSERT INTO series_annual_volumes (scanned_series_id, volume_id, name) VALUES ('ss1', '300', 'Spectacular Annual')`);   // found before it was monitored
    else await call('POST /api/series/:id/find-annuals', { id: 'ss1' });
    const g = await call('POST /api/series/:id/annual-gaps/get', { id: 'ss1' }, { issueIds: ['701'] });
    assert.equal(g.body.wanted, 1, JSON.stringify(g.body));
    const ms = db.prepare("SELECT fill_auto_remove f, series_status st, directory d FROM monitored_series WHERE id = '300'").get();
    assert.deepEqual([ms.f, ms.st, ms.d], [monitored ? 0 : 1, 'ended', '/c/ssm']);
    assert.deepEqual(db.prepare("SELECT id, status, is_annual a FROM monitored_issues WHERE series_id = '300' ORDER BY id").all().map(x => [x.id, x.status, x.a]),
      [['700', 'skipped', 1], ['701', 'wanted', 1]]);
    assert.equal(!!db.prepare("SELECT 1 FROM series_annual_links WHERE parent_series_id = '100' AND annual_series_id = '300'").get(), monitored);
    await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(calls.grab, ['300']);
    const r = await call('GET /api/series/:id/annual-gaps', { id: 'ss1' });
    assert.equal(r.body.rows.find(x => x.id === '701').state, 'wanted');
    assert.equal((await call('POST /api/series/:id/annual-gaps/get', { id: 'ss1' }, { issueIds: ['701'] })).code, 400);   // no longer missing
  }
});

test('series annuals: a request row names the annual volume', async () => {
  const { sa, call } = setup();
  await call('POST /api/series/:id/find-annuals', { id: 'ss1' });
  const row = await sa.rowFor('ss1', '701');
  assert.deepEqual([row.series_name, row.issue_number, row.volume_year, row.cv_issue_id], ['Spectacular Annual', '20', 1997, '701']);
  assert.equal(await sa.rowFor('ss1', '700'), null);
});
