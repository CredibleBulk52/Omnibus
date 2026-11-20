'use strict';
// Store dates in ComicInfo (2026-11-19): <StoreDate> written from Comic Vine or Metron, read back
// as scanned_books.store_date. claude/SERIES_READING_ORDER.md, store-date plan.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { STORE_DATE_SQL, storeDateFromComicInfo, storeDateFromMetronInfo, validStoreDate } = require('./storeDate');
const { adaptCvSource, secondSourceStoreDate } = require('./metadata/cvSource');
const { planBookMetadata } = require('./metadata/metadataService');
const { applyComicInfoPlan } = require('./metadata/comicInfoPatch');
const { createMetron } = require('./metron');

const issue = (extra = {}) => ({ id: 990024, issue_number: '1055', name: 'Tech Alive', cover_date: '2023-07-01', store_date: '2023-05-23', volume: { id: 91078, name: 'Action Comics' }, ...extra });
const volume = { id: 91078, name: 'Action Comics', start_year: 2016, publisher: { name: 'DC Comics' } };

test('Comic Vine store date becomes StoreDate; Year/Month stay the cover date and Day is not invented', () => {
  const r = adaptCvSource({ expectedIssueId: '990024', issue: issue(), volume });
  assert.equal(r.source.fields.StoreDate, '2023-05-23');
  assert.equal(r.source.fields.Year, '2023');
  assert.equal(r.source.fields.Month, '7');
  assert.equal(r.source.fields.Day, undefined);
  assert.deepEqual([r.publicationDate, r.publicationDateSource, r.publicationDatePrecision, r.storeDateSource], ['2023-05-23', 'store_date', 'day', 'comic_vine']);
});

test('a second source fills StoreDate only when Comic Vine has none', () => {
  const metron = { value: '2023-05-24', source: 'metron' };
  const withCv = adaptCvSource({ expectedIssueId: '990024', issue: issue(), volume, storeDate: metron });
  assert.equal(withCv.source.fields.StoreDate, '2023-05-23');
  const without = adaptCvSource({ expectedIssueId: '990024', issue: issue({ store_date: null }), volume, storeDate: metron });
  assert.equal(without.source.fields.StoreDate, '2023-05-24');
  assert.equal(without.storeDateSource, 'metron');
  assert.equal(without.source.fields.Month, '7');
  assert.equal(without.publicationDatePrecision, 'day');
  const neither = adaptCvSource({ expectedIssueId: '990024', issue: issue({ store_date: null }), volume, storeDate: { value: '2023-02-30' } });
  assert.equal(neither.source.fields.StoreDate, undefined);
  assert.deepEqual([neither.publicationDate, neither.publicationDatePrecision, neither.storeDateSource], ['2023-07-01', 'month', null]);
});

test('the second source is asked only when Comic Vine has no store date, and never fails the work', async () => {
  let asked = 0;
  const fetchStoreDate = async () => { asked++; return '2023-05-24'; };
  assert.equal(await secondSourceStoreDate({ fetchStoreDate, id: '990024', issue: issue() }), null);
  assert.equal(asked, 0);
  assert.deepEqual(await secondSourceStoreDate({ fetchStoreDate, id: '990024', issue: issue({ store_date: '' }) }), { value: '2023-05-24', source: 'metron' });
  assert.equal(await secondSourceStoreDate({ fetchStoreDate: async () => { throw new Error('down'); }, id: '1', issue: {} }), null);
  assert.equal(await secondSourceStoreDate({ fetchStoreDate: async () => 'soon', id: '1', issue: {} }), null);
  assert.equal(await secondSourceStoreDate({ fetchStoreDate: () => new Promise(() => {}), id: '1', issue: {}, timeoutMs: 5 }), null);
  assert.equal(await secondSourceStoreDate({ fetchStoreDate: null, id: '1', issue: {} }), null);
});

function writeStoreDate(currentXml, source, previous = null) {
  const planned = planBookMetadata({ bookId: 'sb_1', filename: 'Action Comics 1055 (2023).cbz', currentXml, source, previous });
  return { planned, out: applyComicInfoPlan({ bookId: 'sb_1', cvIssueId: '990024', currentXml, plan: planned.plan }) };
}
const tagged = extra => `<?xml version="1.0"?>\n<ComicInfo><Series>Action Comics</Series><Number>1055</Number><Year>2023</Year><Month>07</Month><Day>01</Day>${extra}<Web>https://comicvine.gamespot.com/issue/4000-990024/</Web></ComicInfo>`;

test('the writer adds StoreDate to an existing ComicInfo and keeps the cover-date group as it was', () => {
  const { planned, out } = writeStoreDate(tagged(''), { issue: issue(), volume });
  const p = planned.plan.patches.find(x => x.field === 'StoreDate');
  assert.deepEqual([p.before, p.after, p.reason], [null, '2023-05-23', 'fill_missing_field']);
  assert.equal(planned.plan.managedFieldsAfterApply.StoreDate, '2023-05-23');
  assert.equal(out.xml.match(/<StoreDate>/g).length, 1);
  assert.match(out.xml, /<StoreDate>2023-05-23<\/StoreDate>[\s\S]*<\/ComicInfo>$/);
  assert.match(out.xml, /<Month>07<\/Month><Day>01<\/Day>/);
  assert.equal(storeDateFromComicInfo(out.xml), '2023-05-23');
});

test('a StoreDate Omnibus never wrote is replaced; a blank source keeps the existing one', () => {
  const replaced = writeStoreDate(tagged('<StoreDate>2023-05-30</StoreDate>'), { issue: issue(), volume });
  assert.equal(replaced.planned.plan.patches.find(x => x.field === 'StoreDate').reason, 'comic_vine_authority');
  assert.equal(storeDateFromComicInfo(replaced.out.xml), '2023-05-23');
  const kept = writeStoreDate(tagged('<StoreDate>2023-05-30</StoreDate>'), { issue: issue({ store_date: null }), volume });
  assert.equal(kept.planned.plan.patches.some(x => x.field === 'StoreDate'), false);
  assert.equal(storeDateFromComicInfo(kept.out.xml), '2023-05-30');
});

test('scanned_books.store_date follows comicinfo through every write', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE scanned_books (id TEXT PRIMARY KEY, comicinfo TEXT)');
  db.exec(`ALTER TABLE scanned_books ADD COLUMN store_date TEXT GENERATED ALWAYS AS (${STORE_DATE_SQL}) VIRTUAL`);
  const put = db.prepare('INSERT INTO scanned_books (id, comicinfo) VALUES (?, ?)');
  const cases = [
    ['ok', '<ComicInfo><Year>2023</Year><StoreDate>2023-05-23</StoreDate></ComicInfo>', '2023-05-23'],
    ['none', '<ComicInfo><Year>2023</Year></ComicInfo>', null],
    ['short', '<ComicInfo><StoreDate>2023-5-23</StoreDate></ComicInfo>', null],
    ['time', '<ComicInfo><StoreDate>2023-05-23T10:00</StoreDate></ComicInfo>', null],
    ['null', null, null],
  ];
  for (const [id, xml] of cases) put.run(id, xml);
  for (const [id, , want] of cases) assert.equal(db.prepare('SELECT store_date FROM scanned_books WHERE id = ?').get(id).store_date, want, id);
  db.prepare("UPDATE scanned_books SET comicinfo = '<ComicInfo><StoreDate>1999-12-01</StoreDate></ComicInfo>' WHERE id = 'none'").run();
  assert.equal(db.prepare("SELECT store_date FROM scanned_books WHERE id = 'none'").get().store_date, '1999-12-01');
  assert.equal(storeDateFromComicInfo(cases[0][1]), '2023-05-23');
  assert.equal(storeDateFromComicInfo('<StoreDate>2023-02-30</StoreDate>'), null);
  assert.equal(validStoreDate('2024-02-29'), '2024-02-29');
});

test('MetronInfo.xml store dates are read', () => {
  assert.equal(storeDateFromMetronInfo('<MetronInfo><CoverDate>2026-11-01</CoverDate><StoreDate>2026-11-18</StoreDate></MetronInfo>'), '2026-11-18');
  assert.equal(storeDateFromMetronInfo('<MetronInfo><CoverDate>2026-11-01</CoverDate></MetronInfo>'), null);
});

test('Metron store date by Comic Vine issue ID: one unambiguous answer, cached, misses too', async () => {
  const calls = [];
  const answers = {
    '990024': { count: 1, results: [{ id: 5, store_date: '2023-05-23' }] },
    '2': { count: 2, results: [{ id: 6, store_date: '2023-01-01' }, { id: 7, store_date: '2023-01-08' }] },
    '3': { count: 1, results: [{ id: 8, store_date: null }] },
  };
  const axios = { get: async url => { calls.push(url); const id = new URL(url).searchParams.get('cv_id'); return { status: 200, data: answers[id] || { count: 0, results: [] } }; } };
  let t = 0;
  const m = createMetron({ axios, getToken: () => 'tok', db: new Database(':memory:'), sleep: async ms => { t += ms; }, now: () => t });
  assert.equal(await m.storeDateOfCvIssue('990024'), '2023-05-23');
  assert.equal(calls[0], 'https://metron.cloud/api/issue/?cv_id=990024');
  assert.equal(await m.storeDateOfCvIssue('2'), null);
  assert.equal(await m.storeDateOfCvIssue('3'), null);
  assert.equal(await m.storeDateOfCvIssue('nope'), null);
  const before = calls.length;
  assert.equal(await m.storeDateOfCvIssue('990024'), '2023-05-23');
  assert.equal(await m.storeDateOfCvIssue('3'), null);
  assert.equal(calls.length, before);
});
