'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { initializeWorkJournal, createWorkJournal } = require('./workJournal');

const original = Buffer.from('fixture original bytes: XML and pages are not parsed in this step');
const prepared = Buffer.from('fixture changed bytes: actual archive validation belongs to Step 3.2');
const fingerprint = bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
const policy = { style: process.platform === 'win32' ? 'win32' : 'posix', caseSensitive: process.platform !== 'win32' };
const code = value => error => error.code === value;

function fixture(t, { intent = 'metadata_refresh', rename = false, replacement = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-recovery-test-'));
  const connections = [];
  const open = () => { const db = new DatabaseSync(path.join(root, 'work.sqlite')); db.exec('PRAGMA busy_timeout=1'); connections.push(db); return db; };
  const db = open();
  db.exec(`CREATE TABLE fixture_books(id TEXT PRIMARY KEY,path TEXT,xml TEXT);
    CREATE TABLE fixture_progress(book_id TEXT,page INTEGER);
    CREATE TABLE fixture_lists(book_id TEXT,position INTEGER);
    INSERT INTO fixture_progress VALUES('one',12); INSERT INTO fixture_lists VALUES('one',7);`);
  const source = path.join(root, intent === 'convert' ? 'Original.cbr' : 'Original.cbz');
  const destination = intent === 'convert' ? source.replace(/cbr$/, 'cbz') : rename ? path.join(root, 'Renamed.cbz') : source;
  fs.writeFileSync(source, original);
  db.prepare('INSERT INTO fixture_books VALUES(?,?,?)').run('one', source, 'preserved XML');
  initializeWorkJournal(db, policy);
  let time = 1000;
  const makeJournal = (connection = db, ownerId = 'worker') => createWorkJournal({ db: connection, ownerId, pathPolicy: policy,
    now: () => time, leaseMs: 100, readBook: id => connection.prepare('SELECT * FROM fixture_books WHERE id=?').get(id) });
  const journal = makeJournal();
  const replacementPath = path.join(root, 'Replacement.cbr');
  if (replacement) fs.writeFileSync(replacementPath, prepared);
  const request = { requestKey: 'one', actor: 'fixture', intent, sourcePath: source, destinationPath: destination,
    bookId: intent === 'initial_arrival' ? null : 'one', expectedGeneration: intent === 'initial_arrival' ? null : 0,
    sourceFingerprint: fingerprint(original), ...(replacement ? { replacement: { path: replacementPath, ...fingerprint(prepared) } } : {}) };
  const work = journal.begin(request);
  const p = work.operation.payload;
  // Fixture-only adapter. All files below are synthetic bytes in a unique temp
  // directory; these helpers are NOT a production archive writer.
  const checked = value => {
    const absolute = path.resolve(value);
    assert.equal(path.dirname(absolute), path.resolve(root));
    return absolute;
  };
  const observe = value => {
    if (!value) return { status: 'missing' };
    try { return { status: 'file', ...fingerprint(fs.readFileSync(checked(value))) }; }
    catch (error) { if (error.code === 'ENOENT' && fs.statSync(root).isDirectory()) return { status: 'missing' }; return { status: 'unavailable' }; }
  };
  const remove = value => { const target = checked(value); if (fs.existsSync(target)) fs.unlinkSync(target); };
  const adapter = {
    inspect: () => ({ source: observe(p.source), destination: observe(p.destination), staged: observe(p.artifacts.staged), backup: observe(p.artifacts.backup), replacement: observe(p.replacement?.path) }),
    prepare: () => { fs.writeFileSync(checked(p.artifacts.staged), prepared, { flag: 'wx' }); return fingerprint(prepared); },
    backup: () => fs.copyFileSync(checked(p.source), checked(p.artifacts.backup), fs.constants.COPYFILE_EXCL),
    publish: () => fs.copyFileSync(checked(p.artifacts.staged), checked(p.destination), source === destination ? 0 : fs.constants.COPYFILE_EXCL),
    rollback: () => {
      if (fs.existsSync(checked(p.artifacts.backup))) fs.copyFileSync(checked(p.artifacts.backup), checked(p.source));
      if (source !== destination) remove(p.destination);
      remove(p.artifacts.staged); remove(p.artifacts.backup);
    },
  };
  t.after(() => {
    for (const connection of connections) { try { connection.close(); } catch {} }
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('omnibus-recovery-test-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const run = step => journal.executeArchiveStep(work.handle, step, adapter);
  const expire = () => { time += 200; journal.quarantineExpired(); };
  return { root, db, open, makeJournal, journal, work, p, adapter, run, expire, source, destination, replacementPath,
    setTime: value => { time = value; }, remove };
}

test('intent commits before effects; successful publication retains all reservations and originals', t => {
  const f = fixture(t); const other = f.makeJournal(f.open(), 'observer');
  for (const [step, pending, complete] of [['prepare', 'prepare_intent', 'prepared'], ['backup', 'backup_intent', 'backed_up'], ['publish', 'publish_intent', 'published']]) {
    const effect = f.adapter[step];
    f.adapter[step] = row => {
      assert.equal(other.execution(row.id).checkpoint, pending);
      return effect(row);
    };
    assert.equal(f.run(step).execution.checkpoint, complete);
  }
  assert.deepEqual(fs.readFileSync(f.source), prepared);
  assert.deepEqual(fs.readFileSync(f.p.artifacts.backup), original);
  assert.equal(f.journal.get(f.work.operation.id).state, 'reserved');
  assert.throws(() => f.journal.releaseUnstarted(f.work.handle, 'no_work'), code('RECOVERY_REQUIRED'));
  assert.throws(() => f.run('publish'), code('CHECKPOINT_MISMATCH'));
  assert.throws(() => f.journal.captureScan({ paths: [{ path: f.source, scope: 'file' }] }), code('WORK_CONFLICT'));
});

for (const options of [{}, { intent: 'convert' }, { intent: 'reprocess', rename: true }, { intent: 'initial_arrival', rename: true }, { intent: 'replace_content', replacement: true }]) {
  test(`published ${options.intent || 'metadata_refresh'} rolls back one physical target and preserves relationships`, t => {
    const f = fixture(t, options);
    const snapshot = () => ['fixture_books', 'fixture_progress', 'fixture_lists'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    f.run('prepare'); f.run('backup'); f.run('publish'); f.expire();
    const other = f.makeJournal(f.open(), 'recovery');
    assert.equal(other.inspectRecovery(f.work.operation.id, f.adapter).action, 'rollback');
    assert.equal(other.recoverOperation(f.work.operation.id, f.adapter).action, 'rolled_back');
    assert.deepEqual(fs.readFileSync(f.source), original);
    if (f.source !== f.destination) assert.equal(fs.existsSync(f.destination), false);
    if (options.replacement) assert.deepEqual(fs.readFileSync(f.replacementPath), prepared);
    assert.deepEqual(snapshot(), before);
    assert.equal(other.recoverOperation(f.work.operation.id, f.adapter).action, 'none');
    assert.throws(() => f.run('prepare'), code('STALE_WORK_HANDLE'));
    assert.equal(other.listUnfinished().length, 0);
  });
}

for (const step of ['prepare', 'backup', 'publish']) {
  for (const when of ['before', 'after']) {
    test(`interrupted ${step} ${when} effect is reconciled from bytes, not its last checkpoint`, t => {
      const f = fixture(t);
      if (step !== 'prepare') f.run('prepare');
      if (step === 'publish') f.run('backup');
      const effect = f.adapter[step];
      f.adapter[step] = row => { if (when === 'after') effect(row); throw Error('simulated interruption'); };
      assert.throws(() => f.run(step), /simulated interruption/);
      assert.equal(f.journal.execution(f.work.operation.id).checkpoint, `${step}_intent`);
      assert.equal(f.journal.get(f.work.operation.id).state, 'recovery_required');
      const result = f.journal.recoverOperation(f.work.operation.id, f.adapter);
      if (step === 'prepare' && when === 'after') {
        assert.deepEqual(result, { action: 'hold', reason: 'unverified_staging' });
        assert.ok(fs.existsSync(f.p.artifacts.staged));
      } else {
        assert.ok(['released', 'rolled_back'].includes(result.action));
        assert.deepEqual(fs.readFileSync(f.source), original);
      }
    });
  }
}

for (const role of ['source', 'destination', 'staged', 'backup', 'replacement']) {
  test(`changed ${role} is held without overwriting or deleting external bytes`, t => {
    const f = fixture(t, { intent: 'replace_content', replacement: true, rename: true });
    f.run('prepare'); f.run('backup'); f.run('publish'); f.expire();
    const targets = { source: f.source, destination: f.destination, staged: f.p.artifacts.staged, backup: f.p.artifacts.backup, replacement: f.replacementPath };
    const changed = Buffer.from(`external change to ${role}`); fs.writeFileSync(targets[role], changed);
    const result = f.journal.recoverOperation(f.work.operation.id, f.adapter);
    assert.equal(result.action, 'hold'); assert.deepEqual(fs.readFileSync(targets[role]), changed);
    assert.throws(() => f.journal.captureScan({ paths: [{ path: f.source, scope: 'file' }] }), code('WORK_CONFLICT'));
  });
}

test('unavailable storage is not absence and never releases reservations', t => {
  const f = fixture(t); f.expire();
  const inspect = f.adapter.inspect;
  f.adapter.inspect = () => ({ ...inspect(), source: { status: 'unavailable' } });
  assert.deepEqual(f.journal.recoverOperation(f.work.operation.id, f.adapter), { action: 'hold', reason: 'storage_unavailable' });
  assert.equal(f.journal.listUnfinished().length, 1);
});
test('verified missing original without backup remains held', t => {
  const f = fixture(t); f.remove(f.source); f.expire();
  assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).action, 'hold');
});
test('an unbound initial arrival with no effects can release without creating a book', t => {
  const f = fixture(t, { intent: 'initial_arrival', rename: true }); f.expire();
  assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).action, 'released');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM fixture_books').get().n, 1);
});
test('bound initial arrival stays held for stableIds provisional-record reconciliation', t => {
  const f = fixture(t, { intent: 'initial_arrival', rename: true });
  f.db.prepare('INSERT INTO fixture_books VALUES(?,?,?)').run('provisional', f.destination, 'pending');
  f.journal.bindInitialBook(f.work.handle, { bookId: 'provisional', expectedGeneration: 0 });
  assert.throws(() => f.journal.releaseUnstarted(f.work.handle, 'no_work'), code('RECOVERY_REQUIRED'));
  f.expire();
  assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).reason, 'provisional_book_requires_finalization');
  assert.ok(f.db.prepare('SELECT * FROM fixture_books WHERE id=?').get('provisional'));
});
test('reclaimed or externally moved stable book is held even if old bytes remain', t => {
  const f = fixture(t); f.run('prepare'); f.expire();
  f.db.prepare('UPDATE fixture_books SET path=? WHERE id=?').run(path.join(f.root, 'Elsewhere.cbz'), 'one');
  assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).reason, 'BOOK_PATH_CHANGED');
});
test('a second connection cannot take over even if a synchronous effect outlasts its lease', t => {
  const f = fixture(t); const other = f.makeJournal(f.open(), 'recovery'); const prepare = f.adapter.prepare;
  f.adapter.prepare = row => {
    f.setTime(1200);
    assert.throws(() => other.quarantineExpired(), /locked|busy/i);
    return prepare(row);
  };
  f.run('prepare');
  assert.equal(other.quarantineExpired().length, 1);
  assert.throws(() => f.run('backup'), code('STALE_WORK_HANDLE'));
  assert.equal(other.recoverOperation(f.work.operation.id, f.adapter).action, 'rolled_back');
});
test('prepared work survives database close/reopen and is not replayed', t => {
  const f = fixture(t); f.run('prepare'); f.db.close();
  const other = f.makeJournal(f.open(), 'restart'); f.setTime(1200); other.quarantineExpired();
  assert.equal(other.execution(f.work.operation.id).checkpoint, 'prepared');
  assert.equal(other.recoverOperation(f.work.operation.id, f.adapter).action, 'rolled_back');
});
test('rollback interrupted after restoring source can be repeated without losing original', t => {
  const f = fixture(t); f.run('prepare'); f.run('backup'); f.run('publish'); f.expire();
  const rollback = f.adapter.rollback;
  f.adapter.rollback = () => { fs.copyFileSync(f.p.artifacts.backup, f.source); throw Error('rollback interrupted'); };
  assert.throws(() => f.journal.recoverOperation(f.work.operation.id, f.adapter), /rollback interrupted/);
  assert.equal(f.journal.execution(f.work.operation.id).checkpoint, 'rollback_intent');
  assert.deepEqual(fs.readFileSync(f.source), original);
  f.adapter.rollback = rollback;
  assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).action, 'rolled_back');
});
test('rollback interrupted after cleanup releases only after verifying the restored original', t => {
  const f = fixture(t); f.run('prepare'); f.run('backup'); f.run('publish'); f.expire();
  const rollback = f.adapter.rollback;
  f.adapter.rollback = () => { rollback(); throw Error('after cleanup'); };
  assert.throws(() => f.journal.recoverOperation(f.work.operation.id, f.adapter), /after cleanup/);
  assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).action, 'released');
});
test('existing CBZ collision blocks conversion before preparation and is preserved', t => {
  const f = fixture(t, { intent: 'convert' }); fs.writeFileSync(f.destination, 'unrelated destination');
  assert.throws(() => f.run('prepare'), code('ARCHIVE_FACTS_CHANGED'));
  assert.equal(f.journal.execution(f.work.operation.id).checkpoint, 'reserved');
  f.expire(); assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).action, 'hold');
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'unrelated destination');
});
test('byte-identical destination appearing before publication intent is still a collision', t => {
  const f = fixture(t, { intent: 'reprocess', rename: true }); f.run('prepare');
  fs.writeFileSync(f.destination, prepared); f.expire();
  assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).reason, 'destination_collision');
});
test('unexpected byte-identical backup is not cleanup authority', t => {
  const f = fixture(t); f.run('prepare'); fs.writeFileSync(f.p.artifacts.backup, original); f.expire();
  assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).reason, 'unexpected_backup');
});
test('async storage adapters and incomplete observations are rejected before effects', t => {
  const f = fixture(t);
  assert.throws(() => f.journal.executeArchiveStep(f.work.handle, 'prepare', { ...f.adapter, prepare: async () => {} }), /synchronous/);
  assert.throws(() => f.journal.executeArchiveStep(f.work.handle, 'prepare', { ...f.adapter, inspect: () => ({}) }), /observation/);
  assert.equal(f.journal.execution(f.work.operation.id).checkpoint, 'reserved');
});
test('v1 fixture migration preserves outstanding reservations and rejects old configuration', t => {
  const f = fixture(t);
  f.db.exec('DROP TABLE metadata_work_execution; UPDATE metadata_work_config SET schema_version=1');
  assert.throws(() => f.makeJournal(), code('JOURNAL_CONFIG_MISMATCH'));
  initializeWorkJournal(f.db, policy);
  assert.equal(f.journal.execution(f.work.operation.id).checkpoint, 'reserved');
  assert.equal(f.journal.listUnfinished().length, 1);
  assert.throws(() => f.journal.captureScan({ paths: [{ path: f.source, scope: 'file' }] }), code('WORK_CONFLICT'));
});

test('rollback reporting success without restoring bytes cannot release reservations', t => {
  const f = fixture(t); f.run('prepare'); f.run('backup'); f.run('publish'); f.expire();
  f.adapter.rollback = () => {};
  assert.throws(() => f.journal.recoverOperation(f.work.operation.id, f.adapter), code('ROLLBACK_NOT_VERIFIED'));
  assert.equal(f.journal.get(f.work.operation.id).state, 'recovery_required');
  assert.deepEqual(fs.readFileSync(f.p.artifacts.backup), original);
});
test('a missing original can be restored from the verified backup after publication intent', t => {
  const f = fixture(t, { intent: 'reprocess', rename: true });
  f.run('prepare'); f.run('backup'); f.run('publish'); f.remove(f.source); f.expire();
  assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).action, 'rolled_back');
  assert.deepEqual(fs.readFileSync(f.source), original);
});
test('a missing backup after in-place publication holds the new content without deleting it', t => {
  const f = fixture(t); f.run('prepare'); f.run('backup'); f.run('publish'); f.remove(f.p.artifacts.backup); f.expire();
  assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).reason, 'original_unavailable');
  assert.deepEqual(fs.readFileSync(f.source), prepared);
});
test('external source change after preparation prevents backup/publication', t => {
  const f = fixture(t); f.run('prepare'); fs.writeFileSync(f.source, 'external metadata');
  assert.throws(() => f.run('backup'), code('ARCHIVE_FACTS_CHANGED'));
  assert.equal(f.journal.execution(f.work.operation.id).checkpoint, 'prepared');
  assert.equal(fs.existsSync(f.p.artifacts.backup), false);
});
test('a partially written destination is retained for review with its original backup', t => {
  const f = fixture(t); f.run('prepare'); f.run('backup');
  f.adapter.publish = () => { fs.writeFileSync(f.source, 'partial'); throw Error('publication interrupted'); };
  assert.throws(() => f.run('publish'), /publication interrupted/);
  assert.equal(f.journal.recoverOperation(f.work.operation.id, f.adapter).reason, 'source_changed');
  assert.deepEqual(fs.readFileSync(f.p.artifacts.backup), original);
});

for (const step of ['prepare', 'publish']) {
  test(`process exit during ${step} leaves a durable intent and recoverable evidence`, t => {
    const f = fixture(t);
    if (step === 'publish') { f.run('prepare'); f.run('backup'); }
    // Exit the child inside its file-effect transaction, without running the
    // journal's catch handler. This tests process loss, not power-loss durability.
    const script = `
      const fs = require('node:fs');
      const { DatabaseSync } = require('node:sqlite');
      const input = JSON.parse(process.argv[1]);
      const { createWorkJournal } = require(input.module);
      const db = new DatabaseSync(input.database);
      const journal = createWorkJournal({ db, ownerId: 'worker', pathPolicy: input.policy, now: () => 1000,
        readBook: id => db.prepare('SELECT * FROM fixture_books WHERE id=?').get(id) });
      journal.executeArchiveStep(input.handle, input.step, {
        inspect: () => input.facts,
        [input.step]: row => {
          if (input.step === 'prepare') fs.writeFileSync(row.payload.artifacts.staged, Buffer.from(input.bytes, 'base64'), {flag:'wx'});
          else fs.copyFileSync(row.payload.artifacts.staged, row.payload.destination);
          process.exit(23);
        }
      });`;
    const result = spawnSync(process.execPath, ['-e', script, JSON.stringify({ module: require.resolve('./workJournal'),
      database: path.join(f.root, 'work.sqlite'), policy, handle: f.work.handle, step, facts: f.adapter.inspect(), bytes: prepared.toString('base64') })], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 23, result.stderr || result.error?.message);
    assert.equal(f.journal.execution(f.work.operation.id).checkpoint, `${step}_intent`);
    f.db.close(); const restarted = f.makeJournal(f.open(), 'restart'); f.setTime(1200); restarted.quarantineExpired();
    const recovery = restarted.recoverOperation(f.work.operation.id, f.adapter);
    if (step === 'prepare') assert.equal(recovery.reason, 'unverified_staging');
    else assert.equal(recovery.action, 'rolled_back');
    assert.deepEqual(fs.readFileSync(f.source), original);
  });
}
