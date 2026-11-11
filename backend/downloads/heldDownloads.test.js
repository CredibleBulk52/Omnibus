'use strict';
// Held downloads (2026-11-09): Process anyway, Delete file and View for an issue whose
// downloaded file names or tags another issue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { registerHeldDownloads } = require('./heldDownloads');

function setup(t, { reason = 'CV_ISSUE_MISMATCH: Download filename contradicts the intended publication', where = 'downloads' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'held-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const downloads = path.join(root, 'downloads'), library = path.join(root, 'library');
  fs.mkdirSync(path.join(downloads, 'getcomics'), { recursive: true }); fs.mkdirSync(library);
  const file = path.join(where === 'library' ? library : path.join(downloads, 'getcomics'), 'Justice League Quarterly 003 (1991).cbz');
  fs.writeFileSync(file, 'zip bytes');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE monitored_issues (id TEXT PRIMARY KEY, status TEXT, download_id TEXT, file_path TEXT, retry_after TEXT, last_fail_reason TEXT);
           CREATE TABLE libraries (id TEXT, path TEXT);`);
  db.prepare('INSERT INTO libraries VALUES (?, ?)').run('lib', library);
  db.prepare("INSERT INTO monitored_issues VALUES ('i1', 'downloaded', 'ddl', ?, '2030-01-01 00:00:00', ?)").run(file, reason);
  const routes = {}, forced = [], watched = { n: 0 };
  const add = m => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
  const settings = { sabnzbd_completed_path: downloads, ddl_download_path: path.join(downloads, 'getcomics') };
  registerHeldDownloads({
    app: { get: add('GET'), post: add('POST') }, requireAdmin: () => {}, db, fs, path, logger: { info() {}, warn() {} },
    getSetting: k => settings[k] ?? null, processAnyway: id => forced.push(id), isProcessing: () => false,
    runCompletionWatcher: () => { watched.n++; }, listArchiveFiles: async () => ['ComicInfo.xml', 'p002.jpg', 'p001.jpg'],
    filterImages: f => f.filter(x => /\.jpg$/.test(x)).sort(), readArchiveMember: async (f, m) => Buffer.from(`${path.basename(f)}:${m}`),
    coverThumb: async buf => ({ buf, mime: 'image/jpeg' }),
  });
  const call = (key, id = 'i1') => new Promise(resolve => {
    const res = { code: 200, headers: {}, status(n) { this.code = n; return this; }, json(v) { resolve({ code: this.code, body: v }); },
      set(k, v) { this.headers[k] = v; return this; }, type(v) { this.headers.type = v; return this; }, send(b) { resolve({ code: this.code, buf: b, headers: this.headers }); } };
    routes[key]({ params: { id }, user: { username: 'admin' } }, res);
  });
  const row = () => ({ ...db.prepare("SELECT * FROM monitored_issues WHERE id = 'i1'").get() });
  return { call, row, file, forced, watched };
}

test('Process anyway marks the issue, clears its wait and runs the watcher', async t => {
  const f = setup(t);
  const r = await f.call('POST /api/admin/downloads/issues/:id/process-anyway');
  await new Promise(res => setImmediate(res));
  assert.equal(r.code, 200);
  assert.deepEqual(f.forced, ['i1']);
  assert.equal(f.row().retry_after, null);
  assert.equal(f.watched.n, 1);
});

test('Process anyway is refused for other holds (a damaged file has Convert anyway)', async t => {
  const f = setup(t, { reason: 'ARCHIVE_DAMAGED: bad CRC' });
  assert.equal((await f.call('POST /api/admin/downloads/issues/:id/process-anyway')).code, 409);
  assert.deepEqual(f.forced, []);
});

test('Delete file removes the download and puts the issue back to wanted, nothing blocked', async t => {
  const f = setup(t);
  const r = await f.call('POST /api/admin/downloads/issues/:id/delete-file');
  assert.equal(r.code, 200);
  assert.equal(fs.existsSync(f.file), false);
  const row = f.row();
  assert.deepEqual([row.status, row.file_path, row.download_id, row.retry_after], ['wanted', null, null, null]);
});

test('Delete file never touches a file inside a library', async t => {
  const f = setup(t, { where: 'library' });
  const r = await f.call('POST /api/admin/downloads/issues/:id/delete-file');
  assert.equal(r.code, 409);
  assert.ok(fs.existsSync(f.file));
  assert.equal(f.row().status, 'downloaded');
});

test('View sends the first page of the download', async t => {
  const f = setup(t);
  const r = await f.call('GET /api/admin/downloads/issues/:id/cover');
  assert.equal(r.buf.toString(), 'Justice League Quarterly 003 (1991).cbz:p001.jpg');
  assert.equal(r.headers.type, 'image/jpeg');
  assert.equal((await f.call('GET /api/admin/downloads/issues/:id/cover', 'nope')).code, 404);
});
