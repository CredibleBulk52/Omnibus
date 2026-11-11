'use strict';
const path = require('node:path');

// Read-only bridge for the legacy scanner. No journal/schema installation and
// no new ID allocation: stableIds still owns registration and reclamation.
function createScannerState({ db, fs }) {
  const hasJournal = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata_work_config'").get();
  function reserved(file, bookId = null, tree = false) {
    if (!hasJournal()) return false;
    const config = db.prepare('SELECT path_policy FROM metadata_work_config WHERE singleton=1').get();
    if (!config) return true; // Incomplete installation is not permission to scan.
    const policy = JSON.parse(config.path_policy), impl = path[policy.style];
    if (!impl || typeof policy.caseSensitive !== 'boolean') return true;
    const key = value => {
      let p = impl.normalize(value).replace(/\\/g, '/');
      if (p.length > 1) p = p.replace(/\/$/, '');
      return policy.caseSensitive ? p : p.toLowerCase();
    };
    const candidate = key(file), inside = (parent, child) => child.startsWith(parent.endsWith('/') ? parent : parent + '/');
    return db.prepare(`SELECT r.* FROM metadata_work_resources r JOIN metadata_work_operations o
      ON o.id=r.operation_id WHERE o.state!='released'`).all().some(r =>
      (r.kind === 'book' && bookId !== null && r.resource_key === String(bookId)) ||
      (r.kind === 'path' && (r.resource_key === candidate ||
        (r.scope === 'tree' && inside(r.resource_key, candidate)) || (tree && inside(candidate, r.resource_key)))));
  }
  const generation = id => id && hasJournal()
    ? db.prepare('SELECT generation FROM metadata_work_books WHERE book_id=?').get(id)?.generation || 0 : 0;
  // Reclamation may select an old ID at another path. Until that selection is
  // coordinated inside stableIds, defer new registrations while work is held.
  const mayRegister = () => !hasJournal() || !db.prepare("SELECT 1 FROM metadata_work_operations WHERE state!='released' LIMIT 1").get();
  const rowAt = file => db.prepare('SELECT * FROM scanned_books WHERE path=?').get(file) || null;
  function fileFacts(file) {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink()) return null;
    return JSON.stringify([s.size, s.mtimeMs, s.ctimeMs, s.ino, s.dev]);
  }
  function capture(file) {
    const row = rowAt(file);
    if (reserved(file, row?.id)) return null;
    try {
      const facts = fileFacts(file);
      return facts && { file, row: JSON.stringify(row), bookId: row?.id || null, generation: generation(row?.id), facts };
    } catch { return null; }
  }
  function current(snapshot) {
    if (!snapshot || reserved(snapshot.file, snapshot.bookId)) return false;
    try {
      return JSON.stringify(rowAt(snapshot.file)) === snapshot.row && generation(snapshot.bookId) === snapshot.generation
        && fileFacts(snapshot.file) === snapshot.facts;
    } catch { return false; }
  }
  // Missing is distinct from unreadable. An accessible ancestor inside the
  // configured library must witness the missing child; a lost mount cannot.
  function confirmedMissing(file, libraryRoot) {
    const root = path.resolve(libraryRoot), target = path.resolve(file), rel = path.relative(root, target);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
    let cursor = target;
    while (cursor !== root) {
      try { fs.lstatSync(cursor); return cursor !== target; }
      catch (e) { if (e.code !== 'ENOENT') return false; }
      cursor = path.dirname(cursor);
    }
    try { return fs.statSync(root).isDirectory(); } catch { return false; }
  }
  function mayRemoveBook(book, libraryRoot) {
    const row = db.prepare('SELECT * FROM scanned_books WHERE id=?').get(book.id);
    return !!row && row.path === book.path && !reserved(row.path, row.id)
      && confirmedMissing(row.path, libraryRoot);
  }
  function mayRemoveSeries(series, libraryRoot) {
    if (reserved(series.path, null, true)) return false;
    const books = db.prepare('SELECT id,path FROM scanned_books WHERE series_id=?').all(series.id);
    // A surviving filed book prevents removal even when it lives elsewhere.
    if (books.some(book => !mayRemoveBook(book, libraryRoot))) return false;
    if (confirmedMissing(series.path, libraryRoot)) return true;
    try { return !fs.readdirSync(series.path, { withFileTypes: true }).some(e => e.isFile() && /\.(cbz|cbr|zip|rar|pdf)$/i.test(e.name)); }
    catch { return false; }
  }
  return { reserved, capture, current, mayRegister, mayRemoveBook, mayRemoveSeries };
}

// Existing filing is user/library state, not an interpretation of refreshed XML.
// Fill empty values for legacy rows, but never replace useful existing values.
const BOOK_UPSERT = `
  INSERT INTO scanned_books (id, series_id, path, filename, issue_number, title, comicinfo, cv_issue_id, monitored_issue_id, sort_order, last_scanned, file_mtime, file_size)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
  ON CONFLICT(path) DO UPDATE SET
    filename=excluded.filename,
    issue_number=COALESCE(NULLIF(scanned_books.issue_number,''),excluded.issue_number),
    title=COALESCE(NULLIF(scanned_books.title,''),excluded.title),
    comicinfo=excluded.comicinfo,
    cv_issue_id=COALESCE(NULLIF(scanned_books.cv_issue_id,''),excluded.cv_issue_id),
    monitored_issue_id=COALESCE(excluded.monitored_issue_id,scanned_books.monitored_issue_id),
    sort_order=COALESCE(scanned_books.sort_order,excluded.sort_order),
    last_scanned=CURRENT_TIMESTAMP,file_mtime=excluded.file_mtime,file_size=excluded.file_size`;
module.exports = { createScannerState, BOOK_UPSERT };
