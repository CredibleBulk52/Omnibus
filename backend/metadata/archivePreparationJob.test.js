'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const archiver = require('archiver');
const sharp = require('sharp');
const { initializeWorkJournal, createWorkJournal, SCHEMA_VERSION } = require('./workJournal');
const { prepareJournalArchive } = require('./archivePreparationJob');
const { prepareValidatedArchive } = require('./archiveStaging');
const { storedRar } = require('./testFixtures/storedRar');
const { planMetadataMerge } = require('./merge');
const fp = bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
const code = value => error => error.code === value;
const binary = process.env.OMNIBUS_TEST_7Z || '7z';
const tar = process.env.OMNIBUS_TEST_BSDTAR || (process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'bsdtar');
const available = !spawnSync(binary, [], { windowsHide: true }).error && !spawnSync(tar, ['--version'], { windowsHide: true }).error;
const real = { skip: !available && '7z/bsdtar required' };
const executables = { '7z': binary, unrar: 'omnibus-no-unrar-fixture', bsdtar: tar };
const xml = '<ComicInfo><Title>Keep</Title><Pages><Page Image="0" Bookmark="cover"/></Pages><Unknown>keep</Unknown></ComicInfo>';
const metadata = { bookId: 'one', cvIssueId: '123', plan: planMetadataMerge({ bookId: 'one', currentXml: xml,
  decision: { status: 'accepted', bookId: 'one', cvIssueId: '123' }, source: { cvIssueId: '123', fields: { Writer: 'New credit' } } }) };
const page = () => sharp({ create: { width: 3, height: 2, channels: 3, background: '#4080c0' } }).png().toBuffer();
function zip(entries) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip'), chunks = [];
    archive.on('error', reject); archive.on('data', c => chunks.push(c)); archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, value] of entries) archive.append(value, { name });
    archive.finalize().catch(reject);
  });
}
function fixture(t, input) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-preparation-test-'));
  const parent = path.join(root, 'scratch'); fs.mkdirSync(parent);
  const source = path.join(root, 'comic.cbr'), destination = path.join(root, 'comic.cbz'); fs.writeFileSync(source, input);
  const location = path.join(root, 'work.sqlite'), db = new DatabaseSync(location);
  const policy = { style: process.platform === 'win32' ? 'win32' : 'posix', caseSensitive: process.platform !== 'win32' };
  db.exec('CREATE TABLE books(id TEXT PRIMARY KEY,path TEXT); CREATE TABLE progress(book_id TEXT,page INTEGER); CREATE TABLE lists(book_id TEXT,position INTEGER);');
  db.prepare('INSERT INTO books VALUES(?,?)').run('one', source);
  db.exec("INSERT INTO progress VALUES('one',7); INSERT INTO lists VALUES('one',3)");
  initializeWorkJournal(db, policy); let time = 1000;
  const journal = createWorkJournal({ db, ownerId: 'fixture-worker', pathPolicy: policy, now: () => time, leaseMs: 60000,
    readBook: id => db.prepare('SELECT * FROM books WHERE id=?').get(id) });
  const work = journal.begin({ requestKey: 'job', intent: 'convert', actor: 'fixture', bookId: 'one', expectedGeneration: 0,
    sourcePath: source, destinationPath: destination, sourceFingerprint: fp(input) });
  t.after(() => { try { db.close(); } catch {} const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('omnibus-preparation-test-')); fs.rmSync(target, { recursive: true, force: true }); });
  const scratchPath = () => path.join(parent, 'omnibus-archive-' + randomUUID());
  const register = () => { const owned = scratchPath(); journal.registerScratch(work.handle, { root: owned, parent, sourceFingerprint: fp(input) }); fs.mkdirSync(owned); journal.markScratchCreated(work.handle); return owned; };
  const recovery = stopped => ({ isQuiescent: () => stopped,
    remove: row => { const target = path.resolve(row.root); assert.equal(path.dirname(target), path.resolve(parent)); assert.match(path.basename(target), /^omnibus-archive-/); fs.rmSync(target, { recursive: true, force: true }); },
    isAbsent: row => !fs.existsSync(row.root) });
  return { root, parent, source, destination, location, db, policy, journal, work, register, recovery,
    expire: () => { time += 70000; journal.quarantineExpired(); },
    prepare: extra => prepareJournalArchive({ journal, handle: work.handle, input, sourceName: 'comic.cbr', scratchParent: parent, executables, ...extra }) };
}

test('journal preparation converts real RAR through existing tools and records a preserved candidate', real, async t => {
  const image = await page(), input = storedRar([['z/001.png', image], ['a/001.png', image], ['meta/ComicInfo.xml', xml], ['notes.txt', 'keep']]);
  const f = fixture(t, input), result = await f.prepare({ metadata });
  // unrar is disabled in this fixture; either remaining extractor is valid.
  // 7z RAR support varies between installed builds.
  assert.ok(['7z', 'bsdtar'].includes(result.report.conversion.extractor));
  assert.deepEqual(result.report.sourceFingerprint, fp(input));
  assert.deepEqual(result.validation.pages.map(p => p.name), ['a/001.png', 'z/001.png']);
  assert.ok(result.validation.comicInfo.xml.includes('<Writer>New credit</Writer>'));
  assert.ok(result.validation.comicInfo.xml.includes('<Unknown>keep</Unknown>'));
  assert.equal(f.journal.scratch(f.work.operation.id).state, 'ready');
  assert.deepEqual(f.journal.scratch(f.work.operation.id).candidate.fingerprint, result.validation.fingerprint);
  assert.throws(() => f.journal.releaseUnstarted(f.work.handle, 'no_work'), code('RECOVERY_REQUIRED'));
  assert.deepEqual(fs.readFileSync(f.source), input); assert.equal(fs.existsSync(f.destination), false);
  assert.equal(f.db.prepare('SELECT page FROM progress').get().page, 7); assert.equal(f.db.prepare('SELECT position FROM lists').get().position, 3);
  await result.cleanup(); await result.cleanup();
  assert.equal(f.journal.scratch(f.work.operation.id).state, 'cleaned');
  f.journal.releaseUnstarted(f.work.handle, 'validation_failed');
});

test('RAR without metadata changes still produces validated CBZ; zero-page RAR fails and cleans', real, async t => {
  const input = storedRar([['001.png', await page()], ['ComicInfo.xml', xml]]), f = fixture(t, input);
  const result = await f.prepare(); assert.equal(result.report.metadataChanged, false); assert.equal(result.status, 'prepared'); await result.cleanup();
  const bad = fixture(t, storedRar([['ComicInfo.xml', xml]]));
  await assert.rejects(bad.prepare(), code('NO_IMAGE_PAGES'));
  assert.equal(bad.journal.scratch(bad.work.operation.id).state, 'cleaned'); assert.deepEqual(fs.readdirSync(bad.parent), []);
});

test('failed shared tools leave original intact and durably record cleanup', async t => {
  const input = storedRar([['ComicInfo.xml', xml]]), f = fixture(t, input);
  await assert.rejects(f.prepare({ executables: { '7z': 'no-7z-fixture', unrar: 'no-unrar-fixture', bsdtar: 'no-tar-fixture' } }), e => e.code === 'ENOENT');
  assert.equal(f.journal.scratch(f.work.operation.id).state, 'cleaned'); assert.deepEqual(fs.readFileSync(f.source), input);
  assert.deepEqual(fs.readdirSync(f.parent), []);
});

test('changed input and pre-cancelled preparation allocate no scratch', async t => {
  const input = await zip([['001.png', await page()]]), f = fixture(t, input);
  await assert.rejects(f.prepare({ input: Buffer.from('changed') }), code('ARCHIVE_FACTS_CHANGED'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.prepare({ signal: controller.signal }), code('ARCHIVE_CANCELLED'));
  assert.equal(f.journal.scratch(f.work.operation.id), null); assert.deepEqual(fs.readdirSync(f.parent), []);
});

test('active scratch blocks release, publication preparation and recovery despite lease expiry', t => {
  const f = fixture(t, Buffer.from('fixture')), owned = f.register(); fs.writeFileSync(path.join(owned, 'partial'), 'keep');
  assert.throws(() => f.journal.beginScratchCleanup(f.work.handle), code('SCRATCH_ACTIVE'));
  assert.throws(() => f.journal.releaseUnstarted(f.work.handle, 'no_work'), code('RECOVERY_REQUIRED'));
  assert.throws(() => f.journal.executeArchiveStep(f.work.handle, 'prepare', { inspect: () => {}, prepare: () => {} }), code('SCRATCH_ACTIVE'));
  f.expire();
  assert.equal(f.journal.inspectRecovery(f.work.operation.id, { inspect: () => {} }).reason, 'scratch_requires_quiescent_cleanup');
  assert.equal(f.journal.recoverScratch(f.work.operation.id, f.recovery(false)).reason, 'worker_quiescence_unknown');
  assert.equal(fs.readFileSync(path.join(owned, 'partial'), 'utf8'), 'keep');
  assert.equal(f.journal.recoverScratch(f.work.operation.id, f.recovery(true)).action, 'cleaned');
  assert.throws(() => f.journal.settleScratch(f.work.handle, null), code('STALE_WORK_HANDLE'));
});

test('old worker can report actual close after expiry, but cannot publish or resume', t => {
  const f = fixture(t, Buffer.from('fixture')); f.register(); f.expire();
  f.journal.settleScratch(f.work.handle, null);
  assert.equal(f.journal.scratch(f.work.operation.id).state, 'stopped');
  assert.throws(() => f.journal.assertOwned(f.work.handle), code('STALE_WORK_HANDLE'));
  f.journal.beginScratchCleanup(f.work.handle); f.journal.finishScratchCleanup(f.work.handle);
  assert.equal(f.journal.scratch(f.work.operation.id).state, 'cleaned');
});

test('failed cleanup is retained and retry requires proof the previous cleanup is stopped', t => {
  const f = fixture(t, Buffer.from('fixture')), owned = f.register();
  f.journal.settleScratch(f.work.handle, null); f.journal.beginScratchCleanup(f.work.handle); f.expire();
  assert.equal(f.journal.recoverScratch(f.work.operation.id, f.recovery(false)).action, 'hold');
  assert.throws(() => f.journal.recoverScratch(f.work.operation.id, { ...f.recovery(true), remove: () => { throw Error('mount unavailable'); } }), /mount unavailable/);
  assert.equal(f.journal.scratch(f.work.operation.id).state, 'cleaning');
  assert.equal(f.journal.recoverScratch(f.work.operation.id, f.recovery(true)).action, 'cleaned');
  assert.deepEqual(fs.readFileSync(f.source), Buffer.from('fixture'));
});

test('scratch ownership survives a real child-process exit before completion', t => {
  const f = fixture(t, Buffer.from('fixture')), owned = path.join(f.parent, 'omnibus-archive-' + randomUUID());
  const config = { location: f.location, policy: f.policy, handle: f.work.handle, root: owned, parent: f.parent, sourceFingerprint: fp(Buffer.from('fixture')) };
  const configPath = path.join(f.root, 'child.json'); fs.writeFileSync(configPath, JSON.stringify(config));
  const script = `const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.argv[1]));const {DatabaseSync}=require('node:sqlite');const {createWorkJournal}=require(process.argv[2]);const db=new DatabaseSync(c.location);const j=createWorkJournal({db,ownerId:'fixture-worker',pathPolicy:c.policy,now:()=>1000,readBook:id=>db.prepare('SELECT * FROM books WHERE id=?').get(id)});j.registerScratch(c.handle,c);fs.mkdirSync(c.root);j.markScratchCreated(c.handle);fs.writeFileSync(require('path').join(c.root,'partial'),'partial');process.exit(23);`;
  const child = spawnSync(process.execPath, ['-e', script, configPath, require.resolve('./workJournal')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr); assert.equal(f.journal.scratch(f.work.operation.id).state, 'active');
  f.expire(); assert.equal(f.journal.recoverScratch(f.work.operation.id, f.recovery(false)).action, 'hold');
  // This fixture child started no converter/descendants; its observed exit is
  // sufficient for this fixture only, not a production supervisor policy.
  assert.equal(f.journal.recoverScratch(f.work.operation.id, f.recovery(true)).action, 'cleaned');
  assert.equal(fs.existsSync(owned), false);
});

test('schema v2 upgrades explicitly and unregistered directories are not cleanup targets', t => {
  const f = fixture(t, Buffer.from('fixture'));
  f.db.exec('DROP TABLE metadata_work_scratch; UPDATE metadata_work_config SET schema_version=2');
  initializeWorkJournal(f.db, f.policy); assert.equal(f.db.prepare('SELECT schema_version FROM metadata_work_config').get().schema_version, SCHEMA_VERSION);
  const unrelated = path.join(f.parent, 'unrelated'); fs.mkdirSync(unrelated); f.expire();
  assert.equal(f.journal.recoverScratch(f.work.operation.id, f.recovery(true)).action, 'none'); assert.ok(fs.existsSync(unrelated));
});

test('cancellation after durable registration waits for preparation to settle before cleanup', async t => {
  const input = storedRar([['001.png', await page()]]), f = fixture(t, input), controller = new AbortController();
  const wrapped = { ...f.journal, registerScratch: (...args) => { f.journal.registerScratch(...args); controller.abort(); } };
  await assert.rejects(f.prepare({ journal: wrapped, signal: controller.signal }), code('ARCHIVE_CANCELLED'));
  assert.equal(f.journal.scratch(f.work.operation.id).state, 'cleaned');
  assert.deepEqual(fs.readdirSync(f.parent), []); assert.deepEqual(fs.readFileSync(f.source), input);
  const events = f.journal.events(f.work.operation.id).map(e => e.event);
  assert.ok(events.indexOf('scratch_settled') < events.indexOf('scratch_cleanup_intent'));
});

test('heartbeat failure cancels asynchronous validation without releasing reservations', async t => {
  const input = await zip([['001.png', await page()]]), f = fixture(t, input);
  const wrapped = { ...f.journal, heartbeat: () => { throw Object.assign(Error('lost ownership'), { code: 'STALE_WORK_HANDLE' }); } };
  await assert.rejects(f.prepare({ journal: wrapped, heartbeatMs: 1 }), e => e.code === 'ARCHIVE_CANCELLED' && e.ownershipError.code === 'STALE_WORK_HANDLE');
  assert.equal(f.journal.get(f.work.operation.id).state, 'reserved');
  assert.deepEqual(fs.readdirSync(f.parent), []);
});

test('validated candidate hands off through existing synchronous prepare without converting under the DB lock', real, async t => {
  const input = await zip([['001.png', await page()], ['ComicInfo.xml', xml]]), f = fixture(t, input);
  const result = await f.prepare(), p = f.work.operation.payload;
  const observe = value => {
    if (!value || !fs.existsSync(value)) return { status: 'missing' };
    return { status: 'file', ...fp(fs.readFileSync(value)) };
  };
  const adapter = {
    inspect: () => ({ source: observe(p.source), destination: observe(p.destination), staged: observe(p.artifacts.staged), backup: observe(p.artifacts.backup), replacement: observe(null) }),
    prepare: () => { fs.copyFileSync(result.candidatePath, p.artifacts.staged, fs.constants.COPYFILE_EXCL); return result.validation.fingerprint; },
  };
  const outcome = f.journal.executeArchiveStep(f.work.handle, 'prepare', adapter);
  assert.equal(outcome.execution.checkpoint, 'prepared');
  assert.deepEqual(outcome.execution.prepared, result.validation.fingerprint);
  await result.cleanup(); assert.ok(fs.existsSync(p.artifacts.staged));
  assert.deepEqual(fs.readFileSync(f.source), input); assert.equal(fs.existsSync(f.destination), false);
});

test('scratch intent precedes mkdir: collisions are retained rather than deleted', async t => {
  const input = storedRar([['001.png', await page()]]), f = fixture(t, input);
  const wrapped = { ...f.journal, registerScratch: (handle, facts) => {
    f.journal.registerScratch(handle, facts); fs.mkdirSync(facts.root); fs.writeFileSync(path.join(facts.root, 'external.txt'), 'preserve');
  } };
  await assert.rejects(f.prepare({ journal: wrapped }), e => e.code === 'EEXIST' && e.cleanupError.code === 'SCRATCH_NOT_CREATED');
  const row = f.journal.scratch(f.work.operation.id);
  assert.equal(row.state, 'stopped'); assert.equal(fs.readFileSync(path.join(row.root, 'external.txt'), 'utf8'), 'preserve');
  f.expire(); assert.equal(f.journal.recoverScratch(f.work.operation.id, f.recovery(true)).reason, 'scratch_creation_unverified');
  assert.equal(fs.readFileSync(path.join(row.root, 'external.txt'), 'utf8'), 'preserve');
});
