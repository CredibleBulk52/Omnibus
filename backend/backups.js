'use strict';
// ─── Database backups and restore (user 2026-11-02) ──────────────────────────
// A backup is omnibus-<YYYY-MM-DD-HH-MM>.db (consistent online copy, integrity
// checked) plus omnibus-<stamp>.files/ with the few files kept beside the
// database (EXTRA_FILES; not the thumbnail cache, which rebuilds itself).
// Kinds, by name: omnibus-* (pruned to `keep`), pinned-* (never pruned),
// before-restore-* (the database as it was before a restore; never pruned).
// Locations: the primary folder (/backups, mapped to the host by docker-compose)
// and an optional second folder an admin sets in Settings (settings
// backup_copy_dir; it must be a folder mounted into the container, e.g.
// /backup-copy from BACKUP_COPY_HOST_PATH).
// Restore: stageRestore() checks the chosen backup, copies it into the data
// folder as restore-incoming.db and writes restore-pending.json; the server
// then restarts, and applyPendingRestore() swaps it in before the database is
// opened (a copy of the current database is kept as before-restore-*).
const fs = require('fs');
const path = require('path');

const EXTRA_FILES = ['cv_overrides.json', 'assistant-avatar.png', 'mass_json_config.yaml', 'create_tmp_config.yaml'];
const SET_RE = /^(omnibus|pinned|before-restore)-([A-Za-z0-9._-]+)\.db$/;
const MARKER = 'restore-pending.json', STAGED = 'restore-incoming.db', RESULT = 'restore-result.json';

const stampOf = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[:T]/g, '-');
const filesDirOf = file => file.replace(/\.db$/, '.files');
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const rmrf = p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
function copyFileAtomic(src, dest) { fs.copyFileSync(src, dest + '.partial'); fs.renameSync(dest + '.partial', dest); }
function copyFiles(srcDir, destDir) {
  if (!exists(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(srcDir)) { const s = path.join(srcDir, f); if (fs.statSync(s).isFile()) { fs.copyFileSync(s, path.join(destDir, f)); n++; } }
  return n;
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// Readable, intact and an Omnibus database.
function checkDatabase(Database, file) {
  let c;
  try { c = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { return { ok: false, error: `cannot open: ${e.message}` }; }
  try {
    const r = c.pragma('integrity_check', { simple: true });
    if (r !== 'ok') return { ok: false, error: `integrity check failed: ${r}` };
    const tables = new Set(c.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(x => x.name));
    for (const t of ['users', 'settings']) if (!tables.has(t)) return { ok: false, error: `not an Omnibus database (no ${t} table)` };
    return { ok: true, users: c.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      series: tables.has('scanned_series') ? c.prepare('SELECT COUNT(*) AS n FROM scanned_series').get().n : null };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { try { c.close(); } catch {} }
}

// Before the server opens its database: apply a staged restore, if there is one.
function applyPendingRestore({ dbPath, Database, backupDir = null, log = console }) {
  const appDir = path.dirname(dbPath);
  const marker = path.join(appDir, MARKER), staged = path.join(appDir, STAGED);
  if (!exists(marker)) return null;
  const m = readJson(marker) || {};
  const result = { at: new Date().toISOString(), source: m.source || null, by: m.by || null, ok: false };
  try {
    if (!exists(staged)) throw new Error('the staged backup is missing');
    const chk = checkDatabase(Database, staged);
    if (!chk.ok) throw new Error(chk.error);
    if (exists(dbPath)) {
      // Fold the write-ahead log into the current database, then keep a copy of it.
      try { const c = new Database(dbPath); c.pragma('wal_checkpoint(TRUNCATE)'); c.close(); }
      catch (e) { log.warn?.(`[restore] could not checkpoint the current database: ${e.message}`); }
      let keepDir = appDir;
      if (backupDir) { try { fs.mkdirSync(backupDir, { recursive: true }); fs.accessSync(backupDir, fs.constants.W_OK); keepDir = backupDir; } catch {} }
      const before = path.join(keepDir, `before-restore-${stampOf()}.db`);
      copyFileAtomic(dbPath, before);
      const extras = filesDirOf(before);
      for (const f of EXTRA_FILES) if (exists(path.join(appDir, f))) { fs.mkdirSync(extras, { recursive: true }); fs.copyFileSync(path.join(appDir, f), path.join(extras, f)); }
      result.before = path.basename(before);
      result.beforeDir = keepDir;
    }
    const stale = path.join(appDir, 'stale');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (exists(dbPath + suffix)) { fs.mkdirSync(stale, { recursive: true }); fs.renameSync(dbPath + suffix, path.join(stale, `${path.basename(dbPath)}${suffix}-${stampOf()}`)); }
    }
    fs.renameSync(staged, dbPath);
    const extras = path.join(appDir, filesDirOf(STAGED));
    result.files = exists(extras) ? copyFiles(extras, appDir) : 0;
    result.ok = true;
    result.users = chk.users; result.series = chk.series;
    log.warn?.(`[restore] Restored ${result.source}; the previous database is ${result.before || '(none)'}`);
  } catch (e) {
    result.error = e.message;
    log.error?.(`[restore] Restore of ${result.source} failed, the current database was kept: ${e.message}`);
  } finally {
    rmrf(marker); rmrf(staged); rmrf(staged + '.partial'); rmrf(path.join(appDir, filesDirOf(STAGED)));
    try { fs.writeFileSync(path.join(appDir, RESULT), JSON.stringify(result, null, 1)); } catch {}
  }
  return result;
}

function createBackups({ db, Database, dbPath, dir, keep = 14, getSetting, setSetting, logger = null }) {
  const appDir = path.dirname(dbPath);
  let running = false;
  const copyDir = () => String(getSetting('backup_copy_dir') || '').trim();
  const where = w => (w === 'copy' ? copyDir() : dir);

  function prune(folder) {
    const sets = fs.readdirSync(folder).filter(f => /^omnibus-.*\.db$/.test(f)).sort();
    const old = sets.slice(0, Math.max(0, sets.length - keep));
    for (const f of old) { rmrf(path.join(folder, f)); rmrf(path.join(folder, filesDirOf(f))); }
    for (const f of fs.readdirSync(folder).filter(f => f.endsWith('.partial'))) rmrf(path.join(folder, f));
    return old.length;
  }

  // Is this a folder the second copy can go to?
  function testFolder(folder) {
    if (!folder) return { ok: false, error: 'No folder given' };
    if (!path.isAbsolute(folder)) return { ok: false, error: 'Use a full path inside the container, such as /backup-copy' };
    const abs = path.resolve(folder);
    if (abs === path.resolve(dir)) return { ok: false, error: 'That is the main backup folder; choose another one' };
    if (abs === path.resolve(appDir) || abs.startsWith(path.resolve(appDir) + path.sep)) return { ok: false, error: 'That folder is inside the data volume; choose a folder on another drive' };
    if (!exists(path.dirname(abs))) return { ok: false, error: `${path.dirname(abs)} does not exist in the container. Mount the folder in docker-compose first (BACKUP_COPY_HOST_PATH → /backup-copy).` };
    try {
      fs.mkdirSync(abs, { recursive: true });
      const probe = path.join(abs, `.omnibus-write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    } catch (e) { return { ok: false, error: `Cannot write there: ${e.message}` }; }
    let free = null;
    try { const s = fs.statfsSync(abs); free = s.bavail * s.bsize; } catch {}
    return { ok: true, dir: abs, freeBytes: free };
  }

  async function run(trigger = 'scheduled') {
    if (running) return { ok: false, error: 'A backup is already running' };
    running = true;
    const out = { ok: false, trigger, at: new Date().toISOString() };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = `omnibus-${stampOf()}.db`;
      const dest = path.join(dir, file), tmp = dest + '.partial';
      await db.backup(tmp);                                   // consistent online copy
      const chk = checkDatabase(Database, tmp);
      if (!chk.ok) { rmrf(tmp); throw new Error(chk.error); }
      fs.renameSync(tmp, dest);
      const extras = path.join(dir, filesDirOf(file));
      for (const f of EXTRA_FILES) if (exists(path.join(appDir, f))) { fs.mkdirSync(extras, { recursive: true }); fs.copyFileSync(path.join(appDir, f), path.join(extras, f)); }
      Object.assign(out, { ok: true, file, bytes: fs.statSync(dest).size, dir, removedOld: prune(dir) });
      // The second copy: a failure here does not fail the backup itself.
      const second = copyDir();
      if (second) {
        const t = testFolder(second);
        try {
          if (!t.ok) throw new Error(t.error);
          copyFileAtomic(dest, path.join(second, file));
          if ((fs.statSync(path.join(second, file)).size) !== out.bytes) throw new Error('the copy has a different size');
          copyFiles(extras, path.join(second, filesDirOf(file)));
          out.copy = { ok: true, dir: second, removedOld: prune(second) };
        } catch (e) {
          out.copy = { ok: false, dir: second, error: e.message };
          logger?.error?.('db-backup', 'Second backup copy failed', { dir: second, error: e.message });
        }
      }
      logger?.info?.('db-backup', `Backup written (${trigger})`, { file, mb: +(out.bytes / 1048576).toFixed(1), removedOld: out.removedOld, copy: out.copy ? (out.copy.ok ? 'ok' : out.copy.error) : 'off' });
    } catch (e) {
      out.error = e.message;
      logger?.error?.('db-backup', 'Backup failed', e.message);
    } finally {
      running = false;
      try { setSetting('backup_last', JSON.stringify(out)); } catch {}
    }
    return out;
  }

  function listFolder(folder) {
    if (!folder || !exists(folder)) return [];
    return fs.readdirSync(folder).filter(f => SET_RE.test(f)).map(f => {
      const st = fs.statSync(path.join(folder, f));
      return { file: f, kind: f.match(SET_RE)[1], bytes: st.size, modified: st.mtime.toISOString(), files: exists(path.join(folder, filesDirOf(f))) };
    }).sort((a, b) => b.modified.localeCompare(a.modified));
  }

  function list() {
    const second = copyDir();
    let copyErr = null;
    if (second && !exists(second)) copyErr = `${second} is not reachable in the container`;
    const fresh = (() => {
      try {
        const users = db.prepare('SELECT username FROM users').all();
        const series = db.prepare('SELECT COUNT(*) AS n FROM scanned_series').get().n;
        return series === 0 && users.length <= 1;
      } catch { return false; }
    })();
    return {
      primary: { dir, files: listFolder(dir) },
      copy: { dir: second || null, files: copyErr ? [] : listFolder(second), error: copyErr },
      keep, extraFiles: EXTRA_FILES, fresh,
      last: readJsonSetting('backup_last'),
      restore: readJson(path.join(appDir, RESULT)),
      pending: exists(path.join(appDir, MARKER)),
    };
  }
  function readJsonSetting(k) { try { return JSON.parse(getSetting(k) || 'null'); } catch { return null; } }

  function resolve(w, file) {
    const folder = where(w);
    if (!folder) throw Object.assign(new Error('No second backup folder is set'), { status: 400 });
    if (typeof file !== 'string' || !SET_RE.test(file) || path.basename(file) !== file) throw Object.assign(new Error('Unknown backup'), { status: 400 });
    const p = path.join(folder, file);
    if (!exists(p)) throw Object.assign(new Error('That backup is not there any more'), { status: 404 });
    return { folder, path: p };
  }

  // Pin (never pruned) or unpin a nightly backup, in whichever folders hold it.
  function pin(w, file, pinned) {
    resolve(w, file);
    const from = pinned ? /^omnibus-/ : /^pinned-/, to = pinned ? 'pinned-' : 'omnibus-';
    if (!from.test(file)) throw Object.assign(new Error(pinned ? 'Only a nightly backup can be pinned' : 'That backup is not pinned'), { status: 400 });
    const next = file.replace(from, to);
    for (const folder of [dir, copyDir()].filter(Boolean)) {
      if (!exists(path.join(folder, file))) continue;
      fs.renameSync(path.join(folder, file), path.join(folder, next));
      if (exists(path.join(folder, filesDirOf(file)))) fs.renameSync(path.join(folder, filesDirOf(file)), path.join(folder, filesDirOf(next)));
    }
    return { ok: true, file: next };
  }

  // Check a backup and stage it for the next start.
  function stageRestore(w, file, by) {
    const src = resolve(w, file);
    const chk = checkDatabase(Database, src.path);
    if (!chk.ok) throw Object.assign(new Error(`That backup cannot be restored: ${chk.error}`), { status: 400 });
    const staged = path.join(appDir, STAGED);
    copyFileAtomic(src.path, staged);
    const again = checkDatabase(Database, staged);                 // the copy itself, not just the source
    if (!again.ok) { rmrf(staged); throw new Error(`Copying the backup failed: ${again.error}`); }
    rmrf(path.join(appDir, filesDirOf(STAGED)));
    copyFiles(path.join(src.folder, filesDirOf(file)), path.join(appDir, filesDirOf(STAGED)));
    fs.writeFileSync(path.join(appDir, MARKER), JSON.stringify({ source: `${w === 'copy' ? 'second folder' : 'backups'}/${file}`, by, at: new Date().toISOString() }));
    logger?.warn?.('db-backup', 'Restore staged; it is applied when the server restarts', { file, where: w, by, users: chk.users, series: chk.series });
    return { ok: true, file, users: chk.users, series: chk.series };
  }
  function cancelRestore() {
    for (const f of [MARKER, STAGED, STAGED + '.partial', filesDirOf(STAGED)]) rmrf(path.join(appDir, f));
  }

  return { run, list, pin, stageRestore, cancelRestore, testFolder, isRunning: () => running };
}

module.exports = { createBackups, applyPendingRestore, checkDatabase, EXTRA_FILES, stampOf };
