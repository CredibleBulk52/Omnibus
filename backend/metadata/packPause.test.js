'use strict';
// Pack post-processing and the Comic Vine limit: the pack pauses (back to
// 'downloaded' with retry_after) instead of failing every remaining file, and
// a later pass counts files already processed as done, not unmatched.
// Runs the real postProcessPack (downloads/packs.js since 2026-11-05) against node:sqlite,
// with server.js's filenameYear / issueYearsOf.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const IN = require('../issueNumber');
const { createPacks } = require('../downloads/packs');

const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const slice = (start, end) => { const a = src.indexOf(start); assert.ok(a >= 0, start); return src.slice(a, src.indexOf(end, a)); };
const { filenameYear, issueYearsOf } = new Function(`${slice('function filenameYear(', 'function buildDestFilename(')}\nreturn { filenameYear, issueYearsOf };`)();

function setup(t, files, rateLimitAt, seriesName = 'Showcase', { archive = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packpause-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packDir = path.join(root, 'pack'), lib = path.join(root, 'lib');
  fs.mkdirSync(packDir); fs.mkdirSync(lib);
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(packDir, f)), { recursive: true }); fs.writeFileSync(path.join(packDir, f), archive ? `content of ${path.basename(f)}` : 'x'); }
  // archive: the same files as one .zip pack, extracted with the real 7z / bsdtar
  const packFile = archive ? path.join(root, 'pack.zip') : packDir;
  if (archive) require('child_process').execFileSync('7z', ['a', '-tzip', packFile, '.'], { cwd: packDir, stdio: 'ignore' });
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE monitored_issues (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, status TEXT, file_path TEXT, date_processed TEXT, has_comicinfo INTEGER, release_date TEXT, store_date TEXT, is_annual INTEGER DEFAULT 0);
    CREATE TABLE series_annual_links (parent_series_id TEXT, annual_series_id TEXT);
    CREATE TABLE monitored_series (id TEXT PRIMARY KEY, directory TEXT);
    CREATE TABLE series_packs (id INTEGER PRIMARY KEY, series_id TEXT, file_path TEXT, status TEXT, fail_reason TEXT, failed_at TEXT, retry_after TEXT);`);
  for (let n = 1; n <= 3; n++) db.prepare("INSERT INTO monitored_issues (id, series_id, issue_number, status) VALUES (?, 's1', ?, 'wanted')").run(String(100 + n), String(n));
  db.prepare("INSERT INTO series_packs (id, series_id, file_path, status) VALUES (1, 's1', ?, 'processing')").run(packFile);
  let calls = 0; const trust = [], arrived = [];
  const runtime = {
    status: () => [],
    arrive: async ({ issue, matchedByFilename, sourcePath, force }) => {
      calls++; trust.push(matchedByFilename); arrived.push({ issue: issue.issue_number, content: fs.readFileSync(sourcePath, 'utf8'), force: !!force });
      if (rateLimitAt.has(calls)) { const e = new Error('limit'); e.code = 'CV_RATE_LIMIT'; e.retryAt = Date.parse('2030-01-01T05:00:00Z'); throw e; }
      const p = path.join(lib, `issue-${issue.issue_number}.cbz`); fs.writeFileSync(p, 'x'); return { path: p };
    },
  };
  const scans = { n: 0 };
  const routes = {};
  const { postProcessPack } = createPacks({
    app: { post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; }, get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; } }, requireDownloadAccess: () => {}, db, logger: { info() {}, warn() {}, error() {} }, axios: {}, fs, path,
    getSetting: () => '/nowhere', IN, DB_PATH: path.join(root, 'omnibus.db'), SABNZBD_URL: '', SABNZBD_API_KEY: '',
    qbtLogin: async () => {}, resolveQbtHash: async () => {}, sniffDownload: () => 'zip', execFileAsync: archive ? require('util').promisify(require('child_process').execFile) : async () => {},
    metadataRuntime: runtime, filenameYear, issueYearsOf, CV_WAIT_REASON: 'Comic Vine hourly limit',
    sqlTime: ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' '), schedulePostProcessScan: () => { scans.n++; },
    requireAdmin: () => {}, asArrival: (c, fn) => fn(), coverThumb: async b => ({ buf: b }), filterImages: f => f, readArchiveMember: async () => null, listArchiveFiles: async () => [],
  });
  const run = postProcessPack;
  const pack = () => db.prepare('SELECT * FROM series_packs WHERE id = 1').get();
  const status = () => db.prepare('SELECT issue_number, status FROM monitored_issues ORDER BY id').all().map(r => `${r.issue_number}:${r.status}`);
  const leftovers = () => db.prepare("SELECT name, reason, status FROM pack_leftovers ORDER BY id").all().map(r => ({ ...r }));
  return { db, run: () => run(pack(), { id: 's1', name: seriesName, directory: lib }), pack, status, scans, trust, routes, leftovers, packDir, lib, root, arrived };
}
const FILES = ['Showcase 001 (1956).cbz', 'Showcase 002 (1956).cbz', 'Showcase 003 (1956).cbz'];

test('Comic Vine limit pauses the pack instead of failing the rest', async t => {
  const f = setup(t, FILES, new Set([2]));
  assert.strictEqual(await f.run(), false);
  const p = f.pack();
  assert.deepStrictEqual([p.status, p.retry_after, p.fail_reason], ['downloaded', '2030-01-01 05:00:00', 'Comic Vine hourly limit']);
  assert.deepStrictEqual(f.status(), ['1:processed', '2:wanted', '3:wanted']);
  assert.ok(fs.existsSync(p.file_path));                     // source kept
  assert.strictEqual(f.scans.n, 1);                           // the processed issue is scanned in
});

test('the next pass counts already-processed files as done and finishes as processed', async t => {
  const f = setup(t, FILES, new Set([2]));
  await f.run();
  f.db.prepare("UPDATE series_packs SET status = 'processing' WHERE id = 1").run();
  assert.strictEqual(await f.run(), true);
  const p = f.pack();
  assert.deepStrictEqual([p.status, p.retry_after, p.fail_reason], ['processed', null, null]);
  assert.deepStrictEqual(f.status(), ['1:processed', '2:processed', '3:processed']);
});

test('without a limit nothing changes: unmatched files still fail the pack', async t => {
  const f = setup(t, [...FILES, 'Showcase 009 (1957).cbz'], new Set());
  f.db.prepare("INSERT INTO monitored_issues (id, series_id, issue_number, status) VALUES ('109', 's1', '9', 'skipped')").run();   // on Comic Vine, not wanted
  assert.strictEqual(await f.run(), false);
  assert.deepStrictEqual([f.pack().status, f.pack().fail_reason], ['failed', '0 failed, 1 unmatched file(s)']);
  assert.deepStrictEqual(f.leftovers(), [{ name: 'Showcase 009 (1957).cbz', reason: 'unmatched', status: 'open' }]);   // listed in the Queue tab
});

test('nested pack folders: only this series is filed; other volumes and covers are left alone', async t => {
  const P = "Showcase v1 (001-106+ Showcase '93-'96) (1956-1996)";
  const f = setup(t, [
    `${P}/Showcase v1 (001-106)(1956-1978)/Showcase v1 001 (1956) (c2c) - Fire Fighters.cbr`,
    `${P}/Showcase v1 (001-106)(1956-1978)/Showcase v1 002 (1956) - Kings of the Wild.cbr`,
    `${P}/Showcase v1 (001-106)(1956-1978)/Showcase v1 003 (1956) - The Frogmen.cbr`,
    `${P}/Showcase '93 (001-012) (1993)/Showcase '93 01 (of 12) (1993).cbr`,
    `${P}/Showcase '94 (001-012) (1994)/Showcase '94 02 (of 12).cbr`,
    `${P}/Covers/Showcase 028 (1960) (cover upgrade) (duckdodgers-dcp).cbr`,
    `${P}/Silver Age Showcase/Silver Age Showcase Presents The 7 Soldiers of Victory 001 (2000) (Digital).cbr`,
  ], new Set());
  assert.strictEqual(await f.run(), true);
  assert.deepStrictEqual(f.status(), ['1:processed', '2:processed', '3:processed']);
  assert.strictEqual(f.pack().status, 'processed');
  assert.deepStrictEqual(f.trust, [false, false, false]);   // named like the series: identified like a single download
  assert.deepStrictEqual(f.leftovers().map(l => l.reason), ['other_series', 'other_series', 'other_series']);
});

test('a pack with no file named like the series fails with a reason', async t => {
  const f = setup(t, ["Showcase '93 01 (of 12) (1993).cbr", "Showcase '93 02 (of 12) (1993).cbr"], new Set());
  assert.strictEqual(await f.run(), false);
  assert.deepStrictEqual([f.pack().status, f.pack().fail_reason], ['failed', 'No files named like Showcase; 2 file(s) look like other series']);
  assert.deepStrictEqual(f.status(), ['1:wanted', '2:wanted', '3:wanted']);
});

test('a file whose number Comic Vine does not list (unpublished) does not fail the pack', async t => {
  const f = setup(t, [...FILES, 'Showcase v1 105 (Unpublished) - Deadman.cbz'], new Set());
  assert.strictEqual(await f.run(), true);
  assert.deepStrictEqual([f.pack().status, f.pack().fail_reason], ['processed', null]);
});

// Pack files not filed (2026-11-10): File as issue files one leftover as the issue the admin chose.
test('a file left in a pack can be filed as the issue an admin chooses', async t => {
  const f = setup(t, [...FILES, 'Showcase Special 009 (1957).cbz'], new Set());
  f.db.prepare("INSERT INTO monitored_issues (id, series_id, issue_number, status) VALUES ('109', 's1', '9', 'skipped')").run();
  f.db.prepare("INSERT INTO monitored_series (id, directory) VALUES ('s1', ?)").run(f.lib);
  await f.run();
  const lo = f.db.prepare('SELECT id FROM pack_leftovers').get();
  const call = (key, params, body) => new Promise(resolve => f.routes[key]({ params, body, user: { username: 'admin' } },
    { status(n) { this.code = n; return this; }, json(v) { resolve({ code: this.code || 200, body: v }); } }));
  // only issues not yet in the library are offered (the three filed ones are processed)
  f.db.exec('CREATE TABLE IF NOT EXISTS series_annual_links (parent_series_id TEXT, annual_series_id TEXT)');
  try { f.db.exec('ALTER TABLE monitored_series ADD COLUMN name TEXT; ALTER TABLE monitored_series ADD COLUMN year INTEGER'); } catch {}
  f.db.prepare("UPDATE monitored_series SET name = 'Showcase', year = 1956 WHERE id = 's1'").run();
  const offered = await call('GET /api/admin/pack-leftovers/:id/issues', { id: lo.id });
  assert.deepStrictEqual(offered.body.issues.map(i => i.label), ['Showcase (1956) #9']);
  assert.strictEqual((await call('POST /api/admin/pack-leftovers/:id/file', { id: lo.id }, { issueId: '101' })).code, 400);   // already in the library
  const r = await call('POST /api/admin/pack-leftovers/:id/file', { id: lo.id }, { issueId: '109' });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(f.status(), ['1:processed', '2:processed', '3:processed', '9:processed']);
  // named "Showcase Special": flagged as another series, the usual edge case
  assert.deepStrictEqual(f.leftovers(), [{ name: 'Showcase Special 009 (1957).cbz', reason: 'other_series', status: 'filed' }]);
});

const hasTools = !require('child_process').spawnSync('7z', [], { stdio: 'ignore' }).error && !require('child_process').spawnSync('bsdtar', ['--version'], { stdio: 'ignore' }).error;
test('a file left in a .zip pack is taken out of the pack and filed as the chosen issue', { skip: !hasTools && '7z or bsdtar missing' }, async t => {
  const f = setup(t, ['Pack/Showcase 001 (1956).cbz', 'Pack/Specials/Showcase Special 009 (1957).cbz'], new Set(), 'Showcase', { archive: true });
  f.db.prepare("INSERT INTO monitored_issues (id, series_id, issue_number, status) VALUES ('109', 's1', '9', 'skipped')").run();
  f.db.prepare("INSERT INTO monitored_series (id, directory) VALUES ('s1', ?)").run(f.lib);
  try { f.db.exec('ALTER TABLE monitored_series ADD COLUMN name TEXT; ALTER TABLE monitored_series ADD COLUMN year INTEGER'); } catch {}
  await f.run();
  const lo = f.db.prepare('SELECT id, file FROM pack_leftovers').get();
  assert.strictEqual(lo.file, path.join('Pack', 'Specials', 'Showcase Special 009 (1957).cbz'));
  const call = (key, params, body) => new Promise(resolve => f.routes[key]({ params, body, user: { username: 'admin' } },
    { status(n) { this.code = n; return this; }, json(v) { resolve({ code: this.code || 200, body: v }); } }));
  const r = await call('POST /api/admin/pack-leftovers/:id/file', { id: lo.id }, { issueId: '109' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(f.arrived.at(-1), { issue: '9', content: 'content of Showcase Special 009 (1957).cbz', force: true });
  assert.ok(!fs.readdirSync(f.root).some(n => n.startsWith('metadata-pack-')));   // scratch removed
});
