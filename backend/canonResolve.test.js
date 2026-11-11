'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { parseIssueSpec, specIncludes, libraryVolume } = require('./canonResolve');
const pick = (hint, nums) => nums.filter(n => specIncludes(parseIssueSpec(hint), n));
test('range notes: every piece counts; ranges take whole numbers', () => {
  assert.deepEqual(pick('#1, #3, #5, #7, #9, #11 (2016 vol)', ['1', '2', '3', '4', '11', '12']), ['1', '3', '11']);
  assert.deepEqual(pick('#635-641, #645-650 (1940 vol)', ['635', '641', '642', '644', '645', '650', '651']), ['635', '641', '645', '650']);
  assert.deepEqual(pick('#76-89, #122 (1960 vol)', ['76', '89', '90', '121', '122']), ['76', '89', '122']);
  assert.deepEqual(pick('#21-33 (2011 vol)', ['21', '23', '23.1', '23.4', '33']), ['21', '23', '33']);
  assert.deepEqual(pick('#608-619 (1940 vol)', ['608', '616a', '619', '620']), ['608', '616a', '619']);
  assert.deepEqual(pick('One-shot (1988)', ['1', '2']), ['1', '2']);   // no numbers: the volume as is
  assert.deepEqual(pick('#0.5-1', ['0.5', '1', '1.5']), ['0.5', '1']);
});
test('start, end and years are read as before', () => {
  assert.deepEqual(parseIssueSpec('#404-407 (1940 vol)'), { parts: [[404, 407]], start: 404, end: 407, year: 1940, volumeYear: 1940 });
  const p = parseIssueSpec('#1-13 (1996)'); assert.equal(p.year, 1996); assert.equal(p.volumeYear, null); assert.equal(p.end, 13);
  assert.deepEqual([parseIssueSpec('Vol. 1 graphic novel (2018)').start, parseIssueSpec('One-shot (1988)').start, parseIssueSpec('1').end], [1, null, 1]);
  assert.deepEqual(pick('Superman #423, Action Comics #583 (1986)', ['423', '500', '583']), ['423', '583']);
});
test('library volume: same name and start year, one clear answer', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (name TEXT, year INTEGER, series_json TEXT);
    INSERT INTO scanned_series VALUES ('Wonder Woman', 2016, '{"metadata":{"comicid":91774}}'), ('Wonder Woman', 2006, '{"metadata":{"comicid":18208}}'),
      ('Wonder Woman: Earth One', 2016, '{"metadata":{"comicid":5}}'), ('Flash', 2016, '{"metadata":{"comicid":1}}'), ('The Flash', 2016, '{"metadata":{"comicid":2}}');`);
  assert.equal(libraryVolume(db, 'Wonder Woman', 2016), '91774');
  assert.equal(libraryVolume(db, 'Wonder Woman', 2011), null);
  assert.equal(libraryVolume(db, 'Flash', 2016), null);   // two folders disagree: no answer
});
