'use strict';
// A download saved without an extension is renamed to .cbz by post-processing. The new name is recorded,
// and a retry that only knows the old name finds it instead of guessing from the shared download folder
// (2026-11-23: Gambit Gone #1 was held as "Ambiguous download source directory" after a Comic Vine timeout).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const Database = require('better-sqlite3');
const pp = require('./postProcessing');

test('an extensionless download keeps its new .cbz name across a failed attempt and a retry', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rename-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const token = path.join(dir, 'nMniiE__YGHn8Gcj3MlmPBlCbKN0eg__');
  fs.writeFileSync(token, Buffer.from([0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0]));
  fs.writeFileSync(path.join(dir, 'Gambit Gone 002 (2026).cbz'), 'another download in the same folder');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE monitored_issues (id TEXT PRIMARY KEY, status TEXT, download_id TEXT, file_path TEXT, retry_after TEXT,
    last_fail_reason TEXT, cv_data TEXT, date_processed TEXT, has_comicinfo INTEGER, last_retag_cv_hash TEXT, download_url TEXT);
    CREATE TABLE monitored_series (id TEXT, directory TEXT);`);
  db.prepare("INSERT INTO monitored_issues (id, status, file_path) VALUES ('1194179', 'downloaded', ?)").run(token);
  const arrived = [];
  let fail = true;
  const deps = { db, logger: { info() {}, warn() {}, error() {}, debug() {} }, getSetting: () => null, activeDownloads: new Map(),
    app: new Proxy({}, { get: () => () => {} }), execFileAsync: async () => ({ stdout: '' }), CV_WAIT_REASON: 'x',
    sqlTime: x => x, schedulePostProcessScan: () => {}, invalidateDirectoryExistsCache: () => {}, createSeriesJsonIfMissing: async () => {},
    metadataRuntime: { status: () => [], arrive: async req => {
      arrived.push(req.sourcePath);
      if (fail) throw Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' });
      return { path: '/comics/Gambit Gone 001 (2026).cbz', bookId: 'sb_1' };
    } } };
  for (const k of pp.NEEDS) if (deps[k] === undefined) deps[k] = () => {};
  const { postProcess } = pp.createPostProcessing(deps);
  const issue = { id: '1194179' }, series = { id: 's', directory: '/comics' };
  const filePath = () => db.prepare("SELECT file_path FROM monitored_issues WHERE id = '1194179'").get().file_path;

  assert.equal(await postProcess(issue, series, token), false);   // Comic Vine timed out
  assert.equal(filePath(), token + '.cbz');                       // the new name is recorded
  fail = false;
  // The retry from before the fix still passes the old name: the renamed file is used, not the folder.
  db.prepare("UPDATE monitored_issues SET file_path = ? WHERE id = '1194179'").run(token);
  assert.equal(await postProcess(issue, series, token), true);
  assert.deepEqual(arrived, [token + '.cbz', token + '.cbz']);
  assert.equal(filePath(), '/comics/Gambit Gone 001 (2026).cbz');
});
