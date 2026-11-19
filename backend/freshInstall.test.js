'use strict';
// ─── A new install gets the same database as a long-running one (2026-11-18) ─────────────────
// Omnibus builds its database at startup: CREATE TABLE IF NOT EXISTS for each table and, for
// columns added later, ALTER TABLE … ADD COLUMN with the error ignored. On a long-running install
// each ALTER ran when its release was deployed; on a brand-new database all of them run at once,
// in file order, and an ALTER that runs before its CREATE TABLE fails silently. The column is then
// never made, and the app breaks later on the page that needs it. This happened three times
// (2026-11-05 five missing columns; 2026-11-11 read_progress's old UNIQUE rule; 2026-11-14 events.draft).
//
// The test starts the real server twice: on an empty database (a new install) and on the shape of
// the maintainer's long-running database (fixtures/schema-*.sql, no data), then compares the two
// shapes. Both runs use today's code, so every change is checked without updating the fixture:
//   missing — an upgraded install has it, a new install does not (ALTER before CREATE)
//   extra   — a new install has it, an upgraded install does not (a CREATE TABLE gained a column
//             but has no ALTER for existing installs)
//   differ  — a column type, default, NOT NULL or unique rule differs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { shape, compare } = require('./schemaShape');

let Database = null;
try { Database = require('better-sqlite3'); } catch {}

const FIXTURE = path.join(__dirname, 'fixtures', 'schema-2026-11-18.sql');

// Only on long-running installs, left by features since removed; nothing reads or writes them.
// (Removing them from those installs is a job for the numbered database changes, later.)
const LEFTOVERS = [
  'table ai_selftest',                     // Comic Book Guy's test set, removed 2026-10-23
  'table comicinfo_cache',
  'table series_metadata',
  'table sweep_extra_volumes',             // the old sweeper
  'column scanned_books.sweep_checked_at',
  'column scanned_books.sweep_result',
  'table user_xp_state',                   // the old XP system
  'table xp_events',
  'index xp_events_user_date',
  'index xp_events_user_occ',
  'column collections.color_primary',      // box colours before box artwork
  'column collections.color_secondary',
  'column download_requests.scanned_series_id',
];

// Start server.js on a database and wait until it is running and its shape has stopped changing.
function boot(dir) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: '0', DB_PATH: path.join(dir, 'omnibus.db'), DB_BACKUP_DIR: path.join(dir, 'backups'),
      COMICS_PATH: path.join(dir, 'comics'), JWT_SECRET: 'a1'.repeat(32), OMNIBUS_SECRET: 'b2'.repeat(32),
      CV_API_KEY: '', ANTHROPIC_API_KEY: '', LOG_LEVEL: 'info',
    };
    fs.mkdirSync(env.COMICS_PATH, { recursive: true });
    const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', running = false, last = '', steady = 0, done = false;
    const finish = (err, value) => { if (done) return; done = true; clearInterval(poll); clearTimeout(limit); child.kill('SIGKILL'); err ? reject(err) : resolve(value); };
    const seen = d => { log += d; if (/Omnibus running/.test(log)) running = true; };
    child.stdout.on('data', seen); child.stderr.on('data', seen);
    child.on('exit', code => { if (!done) finish(new Error(`The server stopped during startup (exit ${code}):\n${log.slice(-3000)}`)); });
    const read = () => { const db = new Database(env.DB_PATH, { readonly: true, fileMustExist: true }); try { return shape(db); } finally { db.close(); } };
    const poll = setInterval(() => {
      if (!running) return;
      let s; try { s = read(); } catch { return; }
      const key = JSON.stringify(s);
      steady = key === last ? steady + 1 : 0; last = key;
      if (steady >= 4) finish(null, s);   // unchanged for two seconds after startup
    }, 500);
    const limit = setTimeout(() => finish(new Error(`The server did not finish starting in 90 s:\n${log.slice(-3000)}`)), 90000);
  });
}

function fromFixture(dir) {
  const db = new Database(path.join(dir, 'omnibus.db'));
  db.exec(fs.readFileSync(FIXTURE, 'utf8'));
  db.close();
}

test('a new install has the same database shape as a long-running install', { skip: !Database && 'better-sqlite3 is not installed', timeout: 180000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-shape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fresh = path.join(root, 'new'), upgraded = path.join(root, 'upgraded');
  fs.mkdirSync(fresh); fs.mkdirSync(upgraded);
  fromFixture(upgraded);
  const [a, b] = await Promise.all([boot(fresh), boot(upgraded)]);
  const r = compare(a, b, LEFTOVERS);
  const list = (title, items) => items.length ? `\n${title}:\n  ${items.join('\n  ')}` : '';
  assert.ok(r.same, 'A new install and an upgraded install would have different databases.'
    + list('Missing on a new install (usually an ALTER TABLE that runs before its CREATE TABLE)', r.missing)
    + list('Missing on an upgraded install (a CREATE TABLE gained a column with no ALTER TABLE for existing installs)', r.extra)
    + list('Different', r.differ));
});

test('the comparison finds a column only one kind of install would get', () => {
  const s = (cols, unique = []) => ({ tables: { t: { cols, unique } }, indexes: {}, other: {} });
  const col = { type: 'TEXT', notnull: 0, default: null, pk: 0 };
  assert.deepEqual(compare(s({ a: col }), s({ a: col, b: col })).missing, ['column t.b']);
  assert.deepEqual(compare(s({ a: col, b: col }), s({ a: col })).extra, ['column t.b']);
  assert.equal(compare(s({ a: col }), s({ a: col, b: col }), ['column t.b']).same, true);
  assert.match(compare(s({ a: col }), s({ a: col }, ['a'])).differ[0], /unique rules on t/);   // read_progress, 2026-11-11
});
