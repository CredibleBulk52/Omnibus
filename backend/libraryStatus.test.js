'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { dueSeries, applyFacts, createLibraryStatusCheck, waitForCvReset, initLibraryStatus } = require('./libraryStatus');

const NOW = Date.parse('2026-11-12T12:00:00Z');
const DAY = 864e5;
const sj = (comicid, name, year, status = 'Continuing', run = `April ${year} - Present`) =>
  ({ version: '1.0.2', metadata: { name, comicid, year, status, publication_run: run, total_issues: 1 } });

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (path TEXT, series_json TEXT);
    CREATE TABLE monitored_series (id TEXT, directory TEXT);`);
  initLibraryStatus(db);
  const files = new Map();
  const add = (dir, data) => { files.set(dir, data); db.prepare('INSERT INTO scanned_series VALUES (?, ?)').run(dir, JSON.stringify(data)); };
  return { db, files, add };
}
const quiet = { info() {}, warn() {} };

test('only unmonitored series that still claim to be running are due, oldest first', () => {
  const { db, add } = fixture();
  add('/c/Blackgate', sj(18932, 'Batman: Blackgate, Isle of Men', 1998));
  add('/c/Newer', sj(5, 'Newer', 2015));
  add('/c/Ended', sj(6, 'Ended', 1990, 'Ended', 'May 1990 - June 1991'));
  add('/c/Monitored', sj(7, 'Monitored', 1980));
  add('/c/NoId', sj(null, 'No ID', 1980));
  db.prepare("INSERT INTO monitored_series VALUES ('7', '/c/Monitored')").run();
  assert.deepEqual(dueSeries(db, NOW).map(s => s.comicid), ['18932', '5']);
  // Checked and still ongoing: not again for 30 days.
  db.prepare("INSERT INTO library_status_checks VALUES ('5', '/c/Newer', ?, 'ongoing')").run(NOW - 10 * DAY);
  assert.deepEqual(dueSeries(db, NOW).map(s => s.comicid), ['18932']);
  assert.deepEqual(dueSeries(db, NOW + 25 * DAY).map(s => s.comicid), ['18932', '5']);
});

test('a one-shot from 1998 is closed at its last cover month; a current series stays open', () => {
  const ended = applyFacts(sj(18932, 'Blackgate', 1998).metadata, { latestDate: '1998-04-01', lastCover: '1998-04-01', issueCount: 1 }, NOW);
  assert.equal(ended.status, 'ended');
  assert.equal(ended.metadata.status, 'Ended');
  assert.equal(ended.metadata.publication_run, 'April 1998');
  const mini = applyFacts(sj(1, 'Mini', 2015, 'Continuing', 'July 2015 - Present').metadata, { latestDate: '2016-03-02', lastCover: '2016-04-01', issueCount: 6 }, NOW);
  assert.equal(mini.metadata.publication_run, 'July 2015 - April 2016');
  assert.equal(mini.metadata.total_issues, 6);
  const live = applyFacts(sj(2, 'Live', 2024, 'Continuing', 'May 2024 - Present').metadata, { latestDate: '2026-10-28', issueCount: 30 }, NOW);
  assert.equal(live.status, 'ongoing');
  assert.equal(live.metadata.publication_run, 'May 2024 - Present');
  assert.deepEqual(live.changes, ['issues 1 → 30']);
  const none = applyFacts(sj(3, 'Unknown', 2000).metadata, {}, NOW);
  assert.equal(none.status, 'unknown');
  assert.deepEqual(none.changes, []);
});

test('Metron "Completed" ends a series without Comic Vine; the run closes at its end year', () => {
  const out = applyFacts(sj(4, 'Arc', 2001, 'Continuing', 'November 2001 - Present').metadata,
    { metron: { status: 'ended', raw: 'Completed', issueCount: 4 }, yearEnd: 2002 }, NOW);
  assert.equal(out.metadata.status, 'Ended');
  assert.equal(out.metadata.publication_run, 'November 2001 - 2002');
  // Metron's count fills a low or missing count, never lowers one.
  assert.equal(out.metadata.total_issues, 4);
  const lower = applyFacts({ ...sj(4, 'Arc', 2001).metadata, total_issues: 6 }, { metron: { status: 'ended', raw: 'Completed', issueCount: 4 }, yearEnd: 2002 }, NOW);
  assert.equal(lower.metadata.total_issues, 6);
  const missing = applyFacts({ ...sj(4, 'Arc', 2001).metadata, total_issues: null }, { metron: { status: 'ended', raw: 'Completed', issueCount: 4 } }, NOW);
  assert.equal(missing.metadata.total_issues, 4);
});

test('a run writes the corrected series.json, records the result and stops at the Comic Vine limit', async () => {
  const { db, files, add } = fixture();
  add('/c/Blackgate', sj(18932, 'Batman: Blackgate, Isle of Men', 1998));
  add('/c/Later', sj(9, 'Later', 2010));
  const asked = [];
  const run = createLibraryStatusCheck({ db, logger: quiet, now: () => NOW,
    lookup: async id => { asked.push(id); if (id === '9') throw Object.assign(new Error('limit'), { code: 'CV_RATE_LIMIT' }); return { latestDate: '1998-04-01', issueCount: 1 }; },
    readSeriesJson: dir => files.get(dir), writeSeriesJson: (dir, data) => files.set(dir, data) });
  const stats = await run();
  assert.deepEqual(asked, ['18932', '9']);
  assert.equal(stats.ended, 1); assert.equal(stats.rateLimited, true);
  assert.equal(files.get('/c/Blackgate').metadata.status, 'Ended');
  assert.equal(files.get('/c/Blackgate').version, '1.0.2');
  assert.equal(db.prepare("SELECT result FROM library_status_checks WHERE comicid = '18932'").get().result, 'ended');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM library_status_checks WHERE comicid = '9'").get().n, 0);
});

test('the weekly check waits for the Comic Vine hour to reset instead of giving up', async () => {
  const slept = []; const state = { waits: 0 };
  const e = Object.assign(new Error('limit'), { code: 'CV_RATE_LIMIT', retryAt: NOW + 25 * 60000 });
  const opts = { sleep: async ms => slept.push(ms), logger: quiet, now: () => NOW, maxWaits: 2 };
  assert.equal(await waitForCvReset(e, state, opts), true);
  assert.equal(slept[0], 25 * 60000 + 5000);
  assert.equal(await waitForCvReset(new Error('other'), state, opts), false);
  assert.equal(await waitForCvReset(e, state, opts), true);
  assert.equal(await waitForCvReset(e, state, opts), false);   // bounded
});
