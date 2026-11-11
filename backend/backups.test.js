'use strict';
// Backups and restore (backups.js) with a real better-sqlite3 database in a temp folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
let Database;
try { Database = require('better-sqlite3'); } catch { Database = null; }
const { createBackups, applyPendingRestore, checkDatabase } = require('./backups');

function setup({ keep = 14 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-bk-'));
  const appDir = path.join(root, 'appdata'), dir = path.join(root, 'backups'), copy = path.join(root, 'copy');
  fs.mkdirSync(appDir); fs.mkdirSync(path.join(root, 'copyparent'));
  const dbPath = path.join(appDir, 'omnibus.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE scanned_series (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('1', 'admin'), ('2', 'reader'); INSERT INTO scanned_series VALUES ('s1');
    INSERT INTO settings VALUES ('marker', 'first');`);
  fs.writeFileSync(path.join(appDir, 'cv_overrides.json'), '{"batman":"1699"}');
  const settings = new Map();
  const bk = createBackups({ db, Database, dbPath, dir, keep, getSetting: k => settings.get(k) || null, setSetting: (k, v) => settings.set(k, v) });
  return { root, appDir, dir, copy, dbPath, db, bk, settings };
}

test('backups: a backup holds the database and the small files, is checked, pruned to keep, and copied to the second folder', { skip: !Database }, async () => {
  const { dir, copy, bk, settings, root } = setup({ keep: 2 });
  const r = await bk.run('manual');
  assert.equal(r.ok, true, r.error);
  assert.ok(fs.existsSync(path.join(dir, r.file)));
  assert.equal(fs.readFileSync(path.join(dir, r.file.replace(/\.db$/, '.files'), 'cv_overrides.json'), 'utf8'), '{"batman":"1699"}');
  assert.equal(checkDatabase(Database, path.join(dir, r.file)).users, 2);
  assert.equal(r.copy, undefined);                                 // no second folder yet
  // Second folder: refused when unsuitable, then used.
  assert.match(bk.testFolder('relative/path').error, /full path/);
  assert.match(bk.testFolder(dir).error, /main backup folder/);
  assert.match(bk.testFolder(path.join(root, 'nope', 'deeper')).error, /does not exist/);
  assert.equal(bk.testFolder(copy).ok, true);
  settings.set('backup_copy_dir', copy);
  // Three more backups (distinct names), keep 2.
  const names = ['omnibus-2026-01-01-00-00.db', 'omnibus-2026-01-02-00-00.db'];
  for (const n of names) fs.copyFileSync(path.join(dir, r.file), path.join(dir, n));
  const r2 = await bk.run('manual');
  assert.equal(r2.copy.ok, true, r2.copy.error);
  assert.ok(fs.existsSync(path.join(copy, r2.file)));
  const left = fs.readdirSync(dir).filter(f => /^omnibus-.*\.db$/.test(f)).sort();
  assert.equal(left.length, 2);
  assert.ok(!left.includes(names[0]));
  // Pinned survives pruning.
  const pinned = bk.pin('primary', left[0], true).file;
  assert.ok(pinned.startsWith('pinned-') && fs.existsSync(path.join(dir, pinned)));
  assert.throws(() => bk.pin('primary', pinned, true), /Only a nightly/);
  const l = bk.list();
  assert.ok(l.primary.files.some(f => f.kind === 'pinned'));
  assert.equal(l.copy.dir, copy);
  assert.equal(l.fresh, false);
  assert.throws(() => bk.pin('primary', '../omnibus.db', true), /Unknown backup/);
});

test('restore: staged, then swapped in at startup; the current database is kept first', { skip: !Database }, async () => {
  const { dir, appDir, dbPath, db, bk } = setup();
  const r = await bk.run('manual');
  db.prepare("UPDATE settings SET value = 'second' WHERE key = 'marker'").run();
  fs.writeFileSync(path.join(appDir, 'cv_overrides.json'), '{"batman":"9999"}');
  const staged = bk.stageRestore('primary', r.file, 'admin');
  assert.equal(staged.users, 2);
  assert.ok(bk.list().pending);
  db.close();                                                       // the server exits here
  const result = applyPendingRestore({ dbPath, Database, backupDir: dir, log: { warn() {}, error() {} } });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.before.startsWith('before-restore-'));
  const after = new Database(dbPath, { readonly: true });
  assert.equal(after.prepare("SELECT value FROM settings WHERE key = 'marker'").get().value, 'first');
  after.close();
  const kept = new Database(path.join(dir, result.before), { readonly: true });
  assert.equal(kept.prepare("SELECT value FROM settings WHERE key = 'marker'").get().value, 'second');   // the WAL was folded in first
  kept.close();
  assert.equal(fs.readFileSync(path.join(appDir, 'cv_overrides.json'), 'utf8'), '{"batman":"1699"}');
  assert.ok(!fs.existsSync(path.join(appDir, 'restore-pending.json')) && !fs.existsSync(path.join(appDir, 'restore-incoming.db')));
  assert.equal(applyPendingRestore({ dbPath, Database, backupDir: dir }), null);   // nothing pending any more
  assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, 'restore-result.json'), 'utf8')).ok, true);
});

test('restore: a damaged or foreign file is refused and the current database stays', { skip: !Database }, async () => {
  const { dir, appDir, dbPath, db, bk } = setup();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'omnibus-2026-02-02-00-00.db'), 'not a database at all');
  assert.throws(() => bk.stageRestore('primary', 'omnibus-2026-02-02-00-00.db', 'admin'), /cannot be restored/);
  const other = new Database(path.join(dir, 'omnibus-2026-02-03-00-00.db')); other.exec('CREATE TABLE x (a)'); other.close();
  assert.throws(() => bk.stageRestore('primary', 'omnibus-2026-02-03-00-00.db', 'admin'), /not an Omnibus database/);
  assert.throws(() => bk.stageRestore('copy', 'omnibus-2026-02-03-00-00.db', 'admin'), /No second backup folder/);
  // A marker whose staged file went missing: the restore fails safely.
  fs.writeFileSync(path.join(appDir, 'restore-pending.json'), JSON.stringify({ source: 'backups/x.db' }));
  db.close();
  const res = applyPendingRestore({ dbPath, Database, backupDir: dir, log: { warn() {}, error() {} } });
  assert.equal(res.ok, false);
  const still = new Database(dbPath, { readonly: true });
  assert.equal(still.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
  still.close();
});
