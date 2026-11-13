'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSeriesLinkCheck, suspects, decide, initSeriesLinkCheck } = require('./seriesLinkCheck');

const quiet = { info() {}, warn() {} };
const ci = series => `<?xml version="1.0"?><ComicInfo><Series>${series}</Series></ComicInfo>`;
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, path TEXT, series_json TEXT, book_count INTEGER);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, filename TEXT, comicinfo TEXT, cv_issue_id TEXT, is_special INTEGER DEFAULT 0);
    CREATE TABLE monitored_issues (id TEXT PRIMARY KEY, series_id TEXT);`);
  initSeriesLinkCheck(db);
  const folder = (id, name, json, books) => {
    db.prepare('INSERT INTO scanned_series VALUES (?, ?, ?, ?, ?)').run(id, name, `/comics/${name}`, JSON.stringify({ metadata: json }), books.length);
    books.forEach(([series, cv, file], i) => db.prepare('INSERT INTO scanned_books (id, series_id, filename, comicinfo, cv_issue_id) VALUES (?, ?, ?, ?, ?)')
      .run(`${id}-${i}`, id, file || `${name} ${String(i + 1).padStart(3, '0')}.cbz`, ci(series), cv));
  };
  return { db, folder };
}

test('only folders whose files disagree with series.json are suspects', () => {
  const { db, folder } = fixture();
  folder('a', 'Arkham Manor (2014)', { name: 'Arkham Manor', comicid: 81000, total_issues: 1 }, [['Arkham Manor', '1'], ['Arkham Manor', '2'], ['Arkham Manor', '3']]);
  folder('b', 'Batman & Robin Eternal', { name: 'Batman & Robin Eternal', comicid: 85000, total_issues: 26 }, [['Batman &amp; Robin Eternal', '9']]);
  folder('c', 'Ion', { name: 'Ion', comicid: 18143, total_issues: 12 }, [['Ion: Guardian of the Universe', '20']]);
  folder('d', 'Superman Annuals only', { name: 'Superman', comicid: 5, total_issues: 1 }, [['Superman', '30'], ['Superman Annual', '31', 'Superman Annual 001.cbz']]);
  const s = suspects(db);
  assert.deepEqual(s.map(x => [x.id, x.reason]), [['a', 'count'], ['c', 'name']]);
});

test('decide: same volume is fine, several volumes is mixed, none is a wrong link', () => {
  assert.equal(decide('1', [{ volumeId: '1' }]).status, 'ok');
  assert.equal(decide('1', [{ volumeId: '2', volumeName: 'Flash' }, { volumeId: '1' }]).status, 'mixed');
  assert.deepEqual(decide('1', [{ volumeId: '2', volumeName: 'Arkham Manor' }]), { status: 'mismatch', volumeId: '2', volumeName: 'Arkham Manor' });
  assert.equal(decide('1', [{ volumeId: null }]).status, 'unknown');
});

test('a run looks up one book per group, lists the wrong link, and drops it once re-linked or kept', async () => {
  const { db, folder } = fixture();
  folder('a', 'Arkham Manor (2014)', { name: 'Arkham Manor: Endgame', comicid: 81000, total_issues: 1 }, [['Arkham Manor', '1'], ['Arkham Manor', '2']]);
  folder('f', 'Flash (2010)', { name: 'The Flash', comicid: 32562, total_issues: 2 }, [['The Flash', '10'], ['The Flash', '11'], ['The Flash: Rebirth', '12']]);
  folder('i', 'Ion', { name: 'Ion', comicid: 18143, total_issues: 12 }, [['Ion: Guardian of the Universe', '20']]);
  db.prepare("INSERT INTO monitored_issues VALUES ('20', '18143')").run();   // known without asking Comic Vine
  const vols = { 1: ['77000', 'Arkham Manor'], 10: ['32562', 'The Flash'], 12: ['25000', 'The Flash: Rebirth'] };
  const asked = [];
  const check = createSeriesLinkCheck({ db, logger: quiet, now: () => 1000, volumeOfIssue: async id => { asked.push(id); return { id: vols[id][0], name: vols[id][1] }; } });
  const stats = await check.run();
  assert.deepEqual(asked.sort(), ['1', '10', '12']);
  assert.deepEqual([stats.mismatch, stats.mixed, stats.ok], [1, 1, 1]);
  assert.equal(check.count(), 1);
  const [it] = check.mismatches();
  assert.equal(it.seriesId, 'a');
  assert.deepEqual(it.proposed, { volumeId: '77000', name: 'Arkham Manor' });
  // Nothing new to look up on the next run (saved answers).
  assert.equal((await check.run()).checked, 0);
  // Re-linked: the series.json now names the files' volume.
  db.prepare('UPDATE scanned_series SET series_json = ? WHERE id = ?').run(JSON.stringify({ metadata: { name: 'Arkham Manor', comicid: 77000, total_issues: 6 } }), 'a');
  assert.equal(check.count(), 0);
  // Kept as is: "Link is right".
  folder('x', 'Injustice', { name: 'Injustice: Gods Among Us Annual', comicid: 1, total_issues: 1 }, [['Injustice: Gods Among Us', '1'], ['Injustice: Gods Among Us', '2']]);
  vols[1] = ['50000', 'Injustice: Gods Among Us'];
  await check.run();
  assert.equal(check.count(), 1);
  assert.equal(check.dismiss('x'), true);
  assert.equal(check.count(), 0);
});

test('the Comic Vine hourly limit stops the run without recording a result', async () => {
  const { db, folder } = fixture();
  folder('a', 'Arkham Manor (2014)', { name: 'Arkham Manor: Endgame', comicid: 81000, total_issues: 1 }, [['Arkham Manor', '1'], ['Arkham Manor', '2']]);
  const check = createSeriesLinkCheck({ db, logger: quiet, volumeOfIssue: async () => { throw Object.assign(new Error('limit'), { code: 'CV_RATE_LIMIT' }); } });
  const stats = await check.run();
  assert.equal(stats.rateLimited, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM series_link_checks WHERE series_id = 'a'").get().n, 0);
});

test('a folder that would need Comic Vine past the reserved allowance waits; the others go on', async () => {
  const { db, folder } = fixture();
  folder('a', 'Arkham Manor (2014)', { name: 'Arkham Manor: Endgame', comicid: 81000, total_issues: 1 }, [['Arkham Manor', '1'], ['Arkham Manor', '2']]);
  folder('i', 'Ion', { name: 'Ion', comicid: 18143, total_issues: 12 }, [['Ion: Guardian of the Universe', '20']]);
  const check = createSeriesLinkCheck({ db, logger: quiet, volumeOfIssue: async id => {
    if (id === '1') throw Object.assign(new Error('reserved'), { code: 'CV_HEADROOM' });
    return { id: '18143', name: 'Ion' };
  } });
  const stats = await check.run();
  assert.equal(stats.deferred, 1); assert.equal(stats.ok, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM series_link_checks WHERE series_id = 'a'").get().n, 0);
});
