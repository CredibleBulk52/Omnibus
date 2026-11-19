'use strict';
// Series caches (seriesCaches.js, moved out of server.js 2026-11-19). The latest release date of a
// series now uses the shared release-date rule (pullBox.RELEASE_DATE_SQL): a downloaded issue
// Comic Vine has not dated yet goes by the day it was listed, as on Home and My Pulls.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSeriesCaches } = require('./seriesCaches');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series(id TEXT PRIMARY KEY, monitored_series_id TEXT);
    CREATE TABLE scanned_books(id TEXT PRIMARY KEY, series_id TEXT, comicinfo TEXT);
    CREATE TABLE monitored_issues(id TEXT PRIMARY KEY, series_id TEXT, store_date TEXT, release_date TEXT, date_added TEXT, date_processed TEXT);`);
  const parseComicInfo = xml => ({ writer: /<Writer>([^<]*)/.exec(xml)?.[1] || '', penciller: /<Penciller>([^<]*)/.exec(xml)?.[1] || '' });
  return { db, caches: createSeriesCaches({ db, parseComicInfo }) };
}

test('latest release date: an undated downloaded issue counts by the day it was listed; an undated wanted one does not', () => {
  const { db, caches } = fixture();
  db.exec(`INSERT INTO scanned_series VALUES ('a','ma'),('b','mb'),('c',NULL);
    INSERT INTO monitored_issues VALUES ('a8','ma','2026-11-11',NULL,'2026-10-01 08:00:00','2026-11-11 09:00:00'),
      ('a9','ma',NULL,NULL,'2026-11-18 08:00:20','2026-11-18 12:22:55'),
      ('b4','mb','2026-11-04',NULL,NULL,'2026-11-04 10:00:00'),('b5','mb',NULL,NULL,'2026-11-18 08:00:00',NULL);
    INSERT INTO scanned_books VALUES ('c1','c','<ComicInfo><Year>1986</Year><Month>3</Month></ComicInfo>');`);
  caches.warmLatestReleaseDateCache();
  assert.equal(caches.latestReleaseDateCache.get('a'), '2026-11-18');   // the listed day of the downloaded #9
  assert.equal(caches.latestReleaseDateCache.get('b'), '2026-11-04');   // #5 is wanted, not downloaded
  assert.equal(caches.latestReleaseDateCache.get('c'), '1986-03-01');   // unmonitored: ComicInfo date
});

test('creators come from ComicInfo; invalidating clears every cache', () => {
  const { db, caches } = fixture();
  db.exec(`INSERT INTO scanned_books VALUES ('x1','s','<ComicInfo><Writer>Grant Morrison [2]</Writer><Penciller>Frank Quitely</Penciller></ComicInfo>');`);
  caches.warmCreatorsCache();
  assert.deepEqual(caches.creatorsCache.get('s'), { writers: ['Grant Morrison'], artists: ['Frank Quitely'] });
  caches.seriesCache.set('__all__', { data: [], ts: 1 }); caches.charMapCache.set('', { data: [] });
  caches.invalidateSeriesCache();
  assert.equal(caches.seriesCache.size + caches.charMapCache.size + caches.creatorsCache.size + caches.latestReleaseDateCache.size, 0);
  assert.equal(caches.getSeriesCacheKey(null), '__all__');
});
