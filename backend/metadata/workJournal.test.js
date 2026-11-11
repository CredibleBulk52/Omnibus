'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { initializeWorkJournal, createWorkJournal } = require('./workJournal');
const policy = { style: 'posix', caseSensitive: true };
const fp = { sha256: 'a'.repeat(64), size: 500 };
function fixture(t, { file = false, pathPolicy = policy } = {}) {
  const dir = file ? fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-journal-test-')) : null;
  const location = dir ? path.join(dir, 'fixture.sqlite') : ':memory:';
  const connections = [];
  const open = () => { const db = new DatabaseSync(location); connections.push(db); return db; };
  const db = open();
  db.exec(`CREATE TABLE fixture_books(id TEXT PRIMARY KEY,path TEXT,xml TEXT);
    CREATE TABLE fixture_progress(book_id TEXT,page INTEGER);
    CREATE TABLE fixture_list(book_id TEXT,position INTEGER);
    INSERT INTO fixture_books VALUES('book-a','/comics/Series/A.cbz','original');
    INSERT INTO fixture_books VALUES('book-b','/comics/Series/B.cbz','other copy');
    INSERT INTO fixture_progress VALUES('book-a',12);
    INSERT INTO fixture_list VALUES('book-a',3);`);
  initializeWorkJournal(db, pathPolicy);
  let time = 1000;
  const create = (connection = db, ownerId = 'worker-a') => createWorkJournal({ db: connection, ownerId, pathPolicy,
    leaseMs: 100, now: () => time, readBook: id => connection.prepare('SELECT * FROM fixture_books WHERE id=?').get(id) });
  t.after(() => {
    for (const connection of connections) { try { connection.close(); } catch {} }
    // Only this uniquely allocated test directory is removed; no library paths are used.
    if (dir) {
      const target = path.resolve(dir);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.ok(path.basename(target).startsWith('omnibus-journal-test-'));
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
  return { db, open, create, journal: create(), setTime: value => { time = value; } };
}
function request(extra = {}) {
  return { requestKey: 'request-a', actor: 'test', intent: 'metadata_refresh', bookId: 'book-a', expectedGeneration: 0,
    sourcePath: '/comics/Series/A.cbz', destinationPath: '/comics/Series/A.cbz', sourceFingerprint: fp,
    context: { policyVersion: 'merge-v2', evidence: { cvIssueId: '123' } }, ...extra };
}
function code(expected) { return error => error.code === expected; }

test('installation is explicit, repeatable and rejects inconsistent filesystem policy', t => {
  const f = fixture(t);
  initializeWorkJournal(f.db, policy);
  assert.throws(() => initializeWorkJournal(f.db, { ...policy, caseSensitive: false }), code('JOURNAL_CONFIG_MISMATCH'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM metadata_work_operations').get().n, 0);
});
test('reserves one book and records intent, source evidence and distinct owned artifact paths', t => {
  const { journal } = fixture(t); const r = journal.begin(request());
  assert.equal(r.operation.state, 'reserved'); assert.equal(r.operation.book_id, 'book-a');
  assert.deepEqual(r.operation.payload.sourceFingerprint, fp);
  assert.equal(r.operation.payload.context.evidence.cvIssueId, '123');
  assert.notEqual(r.operation.payload.artifacts.staged, r.operation.payload.artifacts.backup);
  assert.equal(journal.assertOwned(r.handle).id, r.operation.id);
  assert.equal(journal.events(r.operation.id)[0].event, 'reserved');
});
test('same request is idempotent but cannot give a second worker ownership', t => {
  const f = fixture(t); const a = f.journal.begin(request());
  const b = f.create(f.db, 'worker-b').begin(request());
  assert.equal(b.operation.id, a.operation.id); assert.equal(b.reused, true); assert.equal(b.handle, null);
  assert.throws(() => f.journal.begin(request({ context: { changed: true } })), code('REQUEST_KEY_REUSED'));
});
test('same publication can have independently reserved physical copies', t => {
  const { journal } = fixture(t); journal.begin(request());
  const b = journal.begin(request({ requestKey: 'b', bookId: 'book-b', sourcePath: '/comics/Series/B.cbz', destinationPath: '/comics/Series/B.cbz' }));
  assert.equal(b.operation.payload.context.evidence.cvIssueId, '123'); assert.equal(journal.listUnfinished().length, 2);
});
test('same book is blocked even if a stale caller presents another destination', t => {
  const { journal } = fixture(t); journal.begin(request());
  assert.throws(() => journal.begin(request({ intent: 'reprocess', requestKey: 'b', expectedGeneration: 1, destinationPath: '/comics/Series/New.cbz' })), code('WORK_CONFLICT'));
  assert.equal(journal.listUnfinished().length, 1);
});
test('another book cannot reserve an occupied destination or generated scratch path', t => {
  const { journal } = fixture(t); const a = journal.begin(request());
  assert.throws(() => journal.begin(request({ intent: 'reprocess', requestKey: 'b', bookId: 'book-b', sourcePath: '/comics/Series/B.cbz' })), code('WORK_CONFLICT'));
  assert.throws(() => journal.captureScan({ paths: [{ path: a.operation.payload.artifacts.staged, scope: 'file' }] }), code('WORK_CONFLICT'));
});
test('directory moves reserve both subtrees and respect component boundaries', t => {
  const { journal } = fixture(t);
  journal.begin({ requestKey: 'move', actor: 'test', intent: 'move_directory', sourcePath: '/comics/Series', destinationPath: '/comics/Moved' });
  for (const p of ['/comics/Series/A.cbz', '/comics/Moved/A.cbz']) assert.throws(() => journal.captureScan({ paths: [{ path: p, scope: 'file' }] }), code('WORK_CONFLICT'));
  assert.doesNotThrow(() => journal.captureScan({ paths: [{ path: '/comics/Series2/A.cbz', scope: 'file' }] }));
});
test('a book reservation also blocks an ancestor-directory delete', t => {
  const { journal } = fixture(t); journal.begin(request());
  assert.throws(() => journal.begin({ requestKey: 'dir-delete', actor: 'test', intent: 'delete_directory', sourcePath: '/comics' }), code('WORK_CONFLICT'));
});
test('canonical case/segment aliases cannot bypass reservations', t => {
  const { journal } = fixture(t, { pathPolicy: { style: 'win32', caseSensitive: false } });
  journal.begin({ requestKey: 'dir', actor: 'test', intent: 'delete_directory', sourcePath: 'D:\\Comics\\Series' });
  assert.throws(() => journal.captureScan({ paths: [{ path: 'd:/comics/Other/../SERIES/A.cbz', scope: 'file' }] }), code('WORK_CONFLICT'));
  assert.throws(() => journal.captureScan({ paths: [{ path: 'relative.cbz', scope: 'file' }] }), TypeError);
});
test('normal work requires a current stable-book path and generation', t => {
  const { journal } = fixture(t);
  assert.throws(() => journal.begin(request({ bookId: 'absent' })), code('BOOK_UNAVAILABLE'));
  assert.throws(() => journal.begin(request({ sourcePath: '/old/A.cbz', destinationPath: '/old/A.cbz' })), code('BOOK_PATH_CHANGED'));
  assert.throws(() => journal.begin(request({ expectedGeneration: 4 })), code('BOOK_GENERATION_CHANGED'));
  assert.equal(journal.listUnfinished().length, 0);
});
test('release leaves an audit trail and invalidates previously planned generations', t => {
  const { journal } = fixture(t); const a = journal.begin(request());
  journal.releaseUnstarted(a.handle, 'no_work');
  assert.equal(journal.listUnfinished().length, 0);
  assert.throws(() => journal.assertOwned(a.handle), code('STALE_WORK_HANDLE'));
  assert.throws(() => journal.begin(request({ requestKey: 'b' })), code('BOOK_GENERATION_CHANGED'));
  assert.equal(journal.begin(request({ requestKey: 'b', expectedGeneration: 1 })).operation.book_generation, 2);
  assert.equal(journal.events(a.operation.id).at(-1).event, 'released');
});
test('heartbeat is owned and expired work cannot renew or release itself', t => {
  const f = fixture(t); const a = f.journal.begin(request());
  assert.throws(() => f.create(f.db, 'other').heartbeat(a.handle), code('STALE_WORK_HANDLE'));
  f.setTime(1050); assert.equal(f.journal.heartbeat(a.handle), 1150);
  f.setTime(1150); assert.throws(() => f.journal.heartbeat(a.handle), code('LEASE_EXPIRED'));
  assert.throws(() => f.journal.releaseUnstarted(a.handle, 'no_work'), code('LEASE_EXPIRED'));
});
test('expiry keeps reservations; quarantine fences stale handles without stealing work', t => {
  const f = fixture(t); const a = f.journal.begin(request()); f.setTime(1101);
  assert.throws(() => f.journal.begin(request({ requestKey: 'b', expectedGeneration: 1 })), code('WORK_CONFLICT'));
  const [held] = f.journal.quarantineExpired(); assert.equal(held.state, 'recovery_required'); assert.ok(held.fence > a.handle.fence);
  assert.throws(() => f.journal.assertOwned(a.handle), code('STALE_WORK_HANDLE'));
  assert.throws(() => f.journal.captureScan({ bookId: 'book-a', paths: [{ path: '/comics/Series/A.cbz', scope: 'file' }] }), code('WORK_CONFLICT'));
  assert.deepEqual(f.journal.quarantineExpired(), []);
});
test('initial arrival reserves paths before an existing ID authority binds the book', t => {
  const f = fixture(t);
  const a = f.journal.begin(request({ intent: 'initial_arrival', bookId: null, expectedGeneration: null, sourcePath: '/downloads/New.cbr', destinationPath: '/comics/Series/New.cbz' }));
  assert.equal(a.operation.book_id, null);
  assert.throws(() => f.journal.bindInitialBook(a.handle, { bookId: 'new-id', expectedGeneration: 0 }), code('BOOK_UNAVAILABLE'));
  // Simulates registration by the existing stable-ID adapter, not allocation by the journal.
  f.db.prepare('INSERT INTO fixture_books VALUES(?,?,?)').run('new-id', '/comics/Series/New.cbz', 'pending');
  assert.equal(f.journal.bindInitialBook(a.handle, { bookId: 'new-id', expectedGeneration: 0 }).book_id, 'new-id');
  assert.throws(() => f.journal.bindInitialBook(a.handle, { bookId: 'new-id', expectedGeneration: 1 }), code('BIND_NOT_ALLOWED'));
});
test('targeted replacement retains source fingerprint and separately reserves replacement input', t => {
  const { journal } = fixture(t);
  const replacement = { path: '/downloads/intact.cbr', sha256: 'b'.repeat(64), size: 2000 };
  const a = journal.begin(request({ intent: 'replace_content', replacement }));
  assert.equal(a.operation.book_id, 'book-a'); assert.equal(a.operation.payload.replacement.sha256, replacement.sha256);
  assert.throws(() => journal.captureScan({ paths: [{ path: replacement.path, scope: 'file' }] }), code('WORK_CONFLICT'));
});
test('conversion is work even with no scalar metadata patches', t => {
  const f = fixture(t); f.db.prepare('UPDATE fixture_books SET path=? WHERE id=?').run('/comics/Series/A.cbr', 'book-a');
  const a = f.journal.begin(request({ intent: 'convert', sourcePath: '/comics/Series/A.cbr', context: { patches: [] } }));
  assert.equal(a.operation.intent, 'convert'); assert.equal(a.operation.payload.destination, '/comics/Series/A.cbz');
});
test('rejects non-CBZ output, missing fingerprints and replacement input aliases', t => {
  const { journal } = fixture(t);
  for (const extra of [{ destinationPath: '/comics/A.cbr' }, { sourceFingerprint: null }, { intent: 'replace_content' },
    { intent: 'replace_content', replacement: { path: '/comics/Series/A.cbz', ...fp } }, { context: { invalid: undefined } }]) assert.throws(() => journal.begin(request(extra)), TypeError);
  assert.equal(journal.listUnfinished().length, 0);
});
test('scan commits are atomic and stale scans cannot undo reserved/released work', t => {
  const f = fixture(t); const input = { bookId: 'book-a', paths: [{ path: '/comics/Series/A.cbz', scope: 'file' }] };
  const stale = f.journal.captureScan(input); const a = f.journal.begin(request()); f.journal.releaseUnstarted(a.handle, 'validation_failed');
  assert.throws(() => f.journal.commitScan(stale, db => db.prepare("UPDATE fixture_books SET xml='stale'").run()), code('STALE_SCAN'));
  const current = f.journal.captureScan(input);
  assert.throws(() => f.journal.commitScan(current, db => { db.prepare("UPDATE fixture_books SET xml='rolled-back'").run(); throw Error('scan failure'); }), /scan failure/);
  assert.equal(f.db.prepare("SELECT xml FROM fixture_books WHERE id='book-a'").get().xml, 'original');
  f.journal.commitScan(current, db => db.prepare("UPDATE fixture_books SET xml='fresh' WHERE id='book-a'").run());
  assert.throws(() => f.journal.commitScan(current, () => {}), code('STALE_SCAN'));
});
test('scan protection rejects asynchronous callbacks and caller-owned transactions', t => {
  const f = fixture(t); const token = f.journal.captureScan({ paths: [{ path: '/comics/Elsewhere', scope: 'tree' }] });
  assert.throws(() => f.journal.commitScan(token, async () => {}), TypeError);
  f.db.exec('BEGIN');
  assert.throws(() => f.journal.begin(request()), code('NESTED_TRANSACTION')); f.db.exec('ROLLBACK');
});
test('two database connections share reservations and durable history after reopening', t => {
  const f = fixture(t, { file: true }); const a = f.journal.begin(request());
  const second = f.open(), other = f.create(second, 'worker-b');
  assert.throws(() => other.begin(request({ requestKey: 'other', expectedGeneration: 1 })), code('WORK_CONFLICT'));
  assert.equal(other.get(a.operation.id).payload.sourceFingerprint.sha256, fp.sha256);
  f.db.close(); const reopened = f.create(f.open(), 'restarted');
  assert.equal(reopened.listUnfinished().length, 1);
  f.setTime(1200); assert.equal(reopened.quarantineExpired().length, 1);
  assert.equal(reopened.events(a.operation.id).length, 2);
});
test('journal operations leave book metadata, progress and list membership untouched', t => {
  const f = fixture(t); const tables = ['fixture_books', 'fixture_progress', 'fixture_list'];
  const snapshot = () => tables.map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot(); const a = f.journal.begin(request()); f.journal.heartbeat(a.handle); f.journal.releaseUnstarted(a.handle, 'cancelled_before_write');
  assert.deepEqual(snapshot(), before);
});

test('case-insensitive reservation keys retain original filesystem spelling in the plan', t => {
  const { journal } = fixture(t, { pathPolicy: { style: 'posix', caseSensitive: false } });
  const a = journal.begin(request());
  assert.equal(a.operation.payload.source, '/comics/Series/A.cbz');
  assert.ok(a.operation.payload.artifacts.staged.startsWith('/comics/Series/A.cbz.'));
  assert.throws(() => journal.captureScan({ paths: [{ path: '/COMICS/series/a.cbz', scope: 'file' }] }), code('WORK_CONFLICT'));
});
test('automatic refresh cannot request canonical renaming but explicit reprocessing can', t => {
  const { journal } = fixture(t);
  assert.throws(() => journal.begin(request({ destinationPath: '/comics/Series/Canonical 001.cbz' })), /Automatic work/);
  assert.equal(journal.begin(request({ intent: 'reprocess', destinationPath: '/comics/Series/Canonical 001.cbz' })).operation.intent, 'reprocess');
});
test('invalid ownership handles cannot renew or authorize an operation', t => {
  const { journal } = fixture(t); const a = journal.begin(request());
  for (const handle of [null, {}, { ...a.handle, fence: a.handle.fence + 1 }, { ...a.handle, ownerId: 'other' }]) assert.throws(() => journal.assertOwned(handle), code('STALE_WORK_HANDLE'));
});

test('Windows UNC aliases conflict while ambiguous device/stream spellings are rejected', t => {
  const { journal } = fixture(t, { pathPolicy: { style: 'win32', caseSensitive: false } });
  journal.begin({ requestKey: 'dir', actor: 'test', intent: 'delete_directory', sourcePath: '\\\\server\\share\\Comics' });
  assert.throws(() => journal.captureScan({ paths: [{ path: '\\\\SERVER\\share\\comics\\A.cbz', scope: 'file' }] }), code('WORK_CONFLICT'));
  for (const value of ['D:\\Comics\\A.cbz.', 'D:\\Comics\\A.cbz:stream', 'D:\\Comics\\NUL', '\\\\?\\D:\\Comics\\A.cbz']) assert.throws(() => journal.captureScan({ paths: [{ path: value, scope: 'file' }] }), TypeError);
});
test('database contention cannot partly acquire reservations', t => {
  const f = fixture(t, { file: true }); const connection = f.open(), other = f.create(connection, 'other');
  connection.exec('PRAGMA busy_timeout=1'); f.db.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => other.begin(request()), /locked|busy/i); } finally { f.db.exec('ROLLBACK'); }
  assert.equal(f.journal.listUnfinished().length, 0);
  assert.equal(f.journal.bookGeneration('book-a'), 0);
  assert.equal(other.begin(request()).reused, false);
});
test('deletion reservations reject a scan observed before the deletion intent', t => {
  const f = fixture(t); const token = f.journal.captureScan({ bookId: 'book-a', paths: [{ path: '/comics/Series/A.cbz', scope: 'file' }] });
  f.journal.begin(request({ intent: 'delete_book', destinationPath: null }));
  assert.throws(() => f.journal.commitScan(token, () => assert.fail('Must not recreate a reserved book')), code('STALE_SCAN'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM fixture_books').get().n, 2);
});
