'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const createStableIds = require('../stableIds');
const createBookIndex = require('../bookIndex');
const { initializeWorkJournal, createWorkJournal, SCHEMA_VERSION } = require('./workJournal');
const { initializeBookFinalization, createBookFinalizer } = require('./bookFinalization');
const fp = bytes => ({ sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
const code = value => error => error.code === value;
const oldXml = '<ComicInfo><Series>Alpha</Series><Number>2</Number><Volume>2020</Volume></ComicInfo>';
const newXml = oldXml.replace('Alpha', 'Bravo');
function fixture(t, { rename = true, intent = rename ? 'convert' : 'metadata_refresh' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-finalize-test-'));
  const db = new DatabaseSync(path.join(root, 'work.sqlite'));
  const source = path.join(root, rename ? 'Original.cbr' : 'Original.cbz'), destination = rename ? path.join(root, 'Original.cbz') : source;
  // Synthetic file bytes exercise transaction/recovery, not archive decoding.
  // Archive round trips are covered by archivePreparationJob.test.js.
  const original = Buffer.from('original fixture container'), output = Buffer.from('published fixture container');
  fs.writeFileSync(source, original);
  db.exec(`CREATE TABLE scanned_books(id TEXT PRIMARY KEY,series_id TEXT,path TEXT UNIQUE,filename TEXT,comicinfo TEXT,file_size INTEGER,file_mtime REAL,
    issue_number TEXT,sort_order REAL,title TEXT,cv_issue_id TEXT,monitored_issue_id TEXT,manual_notes TEXT);
    CREATE TABLE monitored_issues(id TEXT PRIMARY KEY,file_path TEXT);
    CREATE TABLE read_progress(book_id TEXT PRIMARY KEY,page INTEGER,completed INTEGER);
    CREATE TABLE list_members(book_id TEXT,position INTEGER,manual INTEGER);
    CREATE TABLE metadata_overrides(book_id TEXT,field TEXT,value TEXT);
    CREATE TABLE scanned_series(id TEXT PRIMARY KEY,path TEXT);
    CREATE TABLE missing_books(id TEXT,series_id TEXT,path TEXT,filename TEXT,issue_number TEXT,cv_issue_id TEXT,file_size INTEGER,row_json TEXT);
    CREATE TABLE missing_series(id TEXT,library_id TEXT,path TEXT,name TEXT,year INTEGER,cv_volume_id TEXT,row_json TEXT);
    CREATE TABLE identity_rebinds(kind TEXT,mode TEXT,outcome TEXT,entity_id TEXT,old_path TEXT,new_path TEXT,match_key TEXT,candidates TEXT);`);
  const insert = db.prepare('INSERT INTO scanned_books VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('one','series',source,path.basename(source),oldXml,original.length,100,'0.2',0.2,'manual title','123','monitor-one','keep note');
  insert.run('copy','series',path.join(root,'Copy.cbz'),'Copy.cbz',oldXml,90,100,'2',2,'copy title','123','monitor-copy','copy note');
  db.prepare('INSERT INTO monitored_issues VALUES(?,?)').run('monitor-one',source);
  db.prepare('INSERT INTO monitored_issues VALUES(?,?)').run('monitor-copy',path.join(root,'Copy.cbz'));
  db.exec("INSERT INTO read_progress VALUES('one',7,0); INSERT INTO list_members VALUES('one',3,1); INSERT INTO metadata_overrides VALUES('one','Title','manual title');");
  const logger = { info() {}, warn() {}, error() {} };
  const stableIds = createStableIds({ db, logger, fs, path, crypto });
  const bookIndex = createBookIndex({ db, logger, IN: { normIssueNumber: n => String(n) } });
  db.exec('BEGIN'); bookIndex.updateBook('one'); db.exec('COMMIT');
  const policy = { style: process.platform === 'win32' ? 'win32' : 'posix', caseSensitive: process.platform !== 'win32' };
  initializeWorkJournal(db, policy); initializeBookFinalization(db); let time = 1000;
  const journal = createWorkJournal({ db, ownerId: 'fixture', pathPolicy: policy, now: () => time, leaseMs: 100,
    readBook: id => db.prepare('SELECT * FROM scanned_books WHERE id=?').get(id) });
  const work = journal.begin({ requestKey: 'one', actor: 'fixture', intent, bookId: 'one', expectedGeneration: 0,
    sourcePath: source, destinationPath: destination, sourceFingerprint: fp(original) });
  const p = work.operation.payload;
  const observe = file => !file || !fs.existsSync(file) ? { status: 'missing' } : { status: 'file', ...fp(fs.readFileSync(file)), mtimeMs: 100 };
  const adapter = { inspect: () => ({ source: observe(source), destination: observe(destination), staged: observe(p.artifacts.staged), backup: observe(p.artifacts.backup), replacement: observe(null) }),
    prepare: () => { fs.writeFileSync(p.artifacts.staged, output, { flag: 'wx' }); return fp(output); },
    backup: () => fs.copyFileSync(source, p.artifacts.backup, fs.constants.COPYFILE_EXCL),
    publish: () => fs.copyFileSync(p.artifacts.staged, destination, rename ? fs.constants.COPYFILE_EXCL : 0) };
  const pages = [{ name: '001.png', ...fp(Buffer.from('page')) }], comicInfo = { name: 'ComicInfo.xml', xml: newXml };
  const prepared = { status: 'prepared', report: { sourceFingerprint: fp(original), pages, comicInfo }, validation: { fingerprint: fp(output), pages, comicInfo } };
  const finalize = createBookFinalizer({ stableIds, bookIndex, prepared });
  t.after(() => { db.close(); const target = path.resolve(root); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('omnibus-finalize-test-')); fs.rmSync(target,{recursive:true,force:true}); });
  return { db, root, source, destination, original, output, journal, work, p, adapter, prepared, finalize, stableIds, bookIndex, policy,
    publish: () => { for (const step of ['prepare','backup','publish']) journal.executeArchiveStep(work.handle,step,adapter); },
    finish: fn => journal.finalizePublishedBook(work.handle,{ inspect: adapter.inspect, finalize: fn || finalize }),
    expire: () => { time += 200; journal.quarantineExpired(); } };
}
for (const rename of [false,true]) test(`finalization preserves stable copy and user state (${rename ? 'conversion' : 'in-place'})`, t => {
  const f = fixture(t,{rename}), before = f.db.prepare("SELECT * FROM scanned_books WHERE id='one'").get(), copy = f.db.prepare("SELECT * FROM scanned_books WHERE id='copy'").get();
  f.publish(); const result = f.finish(); assert.equal(result.reused,false);
  const after = f.db.prepare("SELECT * FROM scanned_books WHERE id='one'").get();
  assert.equal(after.id,'one'); assert.equal(after.path,f.destination); assert.equal(after.comicinfo,newXml);
  for (const key of ['series_id','issue_number','sort_order','title','cv_issue_id','monitored_issue_id','manual_notes']) assert.equal(after[key],before[key]);
  assert.deepEqual(f.db.prepare("SELECT * FROM scanned_books WHERE id='copy'").get(),copy);
  assert.equal(f.db.prepare('SELECT page FROM read_progress').get().page,7); assert.equal(f.db.prepare('SELECT position FROM list_members').get().position,3);
  assert.equal(f.db.prepare('SELECT value FROM metadata_overrides').get().value,'manual title');
  assert.equal(f.db.prepare("SELECT file_path FROM monitored_issues WHERE id='monitor-one'").get().file_path,f.destination);
  assert.equal(f.bookIndex.info('one').series_name,'Bravo'); // same mtime AND XML length
  assert.equal(f.db.prepare('SELECT archive_revision FROM metadata_book_revisions').get().archive_revision,fp(f.output).sha256);
  const followup = f.db.prepare('SELECT * FROM metadata_book_followups').get(); assert.equal(followup.state,'pending');
  assert.deepEqual(JSON.parse(followup.payload).order,['cache_invalidation','events','canon','reading_lists']);
  assert.deepEqual(fs.readFileSync(f.p.artifacts.backup),f.original); assert.equal(f.journal.get(f.work.operation.id).state,'reserved');
  assert.equal(f.finish(() => { throw Error('must not replay'); }).reused,true);
  f.expire(); assert.equal(f.journal.inspectRecovery(f.work.operation.id,f.adapter).reason,'finalized_book_requires_forward_completion');
});

test('index failure rolls back book, monitoring paths and finalization record together', t => {
  const f=fixture(t); f.publish();
  const bad = createBookFinalizer({stableIds:f.stableIds,bookIndex:{updateBook(){throw Error('index failed');}},prepared:f.prepared});
  assert.throws(()=>f.finish(bad),/index failed/);
  assert.equal(f.db.prepare("SELECT path FROM scanned_books WHERE id='one'").get().path,f.source);
  assert.equal(f.db.prepare("SELECT file_path FROM monitored_issues WHERE id='monitor-one'").get().file_path,f.source);
  assert.equal(f.journal.finalization(f.work.operation.id),null); assert.equal(f.db.prepare('SELECT count(*) n FROM metadata_book_revisions').get().n,0);
  assert.equal(f.bookIndex.info('one').series_name,'Alpha'); assert.equal(f.finish().reused,false);
});

test('failure after revision and followup insertion leaves no partial database commit', t => {
  const f=fixture(t); f.publish();
  assert.throws(()=>f.finish((...args)=>{f.finalize(...args);throw Error('simulated crash before receipt');}),/simulated crash/);
  for(const table of ['metadata_book_revisions','metadata_book_followups','metadata_work_finalization']) assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal(f.db.prepare("SELECT path FROM scanned_books WHERE id='one'").get().path,f.source);
  assert.deepEqual(fs.readFileSync(f.destination),f.output); assert.deepEqual(fs.readFileSync(f.p.artifacts.backup),f.original);
});

test('changed published content and changed book path prevent finalization', t => {
  const f=fixture(t); f.publish(); fs.writeFileSync(f.destination,'external change');
  assert.throws(()=>f.finish(),code('ARCHIVE_FACTS_CHANGED')); assert.equal(f.journal.finalization(f.work.operation.id),null);
  fs.writeFileSync(f.destination,f.output); f.db.prepare("UPDATE scanned_books SET path=? WHERE id='one'").run(path.join(f.root,'Moved.cbz'));
  assert.throws(()=>f.finish(),code('BOOK_PATH_CHANGED'));
});

test('wrong candidate and occupied database destination cannot repoint a different copy', t => {
  const f=fixture(t); f.publish();
  const wrong=JSON.parse(JSON.stringify(f.prepared));wrong.validation.fingerprint=fp(Buffer.from('other'));
  assert.throws(()=>f.finish(createBookFinalizer({stableIds:f.stableIds,bookIndex:f.bookIndex,prepared:wrong})),/not this published operation/);
  f.db.prepare("UPDATE scanned_books SET path=? WHERE id='copy'").run(f.destination);
  assert.throws(()=>f.finish(),/another copy/); assert.equal(f.journal.finalization(f.work.operation.id),null);
});

test('unpublished work and expired ownership cannot finalize', t => {
  const f=fixture(t); assert.throws(()=>f.finish(),code('CHECKPOINT_MISMATCH'));
  f.publish(); f.expire(); assert.throws(()=>f.finish(),code('STALE_WORK_HANDLE'));
});

test('stable update and forced index methods refuse an absent outer transaction', t => {
  const f=fixture(t);
  assert.throws(()=>f.stableIds.updatePublishedBook({bookId:'one'}),/transaction/);
  assert.throws(()=>f.bookIndex.updateBook('one'),/transaction/);
});

test('schema v3 upgrades explicitly without changing outstanding work', t => {
  const f=fixture(t);f.db.exec('DROP TABLE metadata_work_finalization; UPDATE metadata_work_config SET schema_version=3');
  initializeWorkJournal(f.db,f.policy);assert.equal(f.db.prepare('SELECT schema_version FROM metadata_work_config').get().schema_version,SCHEMA_VERSION);
  assert.equal(f.journal.get(f.work.operation.id).state,'reserved');
});

test('committed receipt survives a second connection and is not replayed after lost response', t => {
  const f=fixture(t);f.publish();const first=f.finish();
  const secondDb=new DatabaseSync(path.join(f.root,'work.sqlite'));
  try {
    const second=createWorkJournal({db:secondDb,ownerId:'new-process',pathPolicy:f.policy,readBook:id=>secondDb.prepare('SELECT * FROM scanned_books WHERE id=?').get(id)});
    const result=second.finalizePublishedBook(f.work.handle,{inspect(){throw Error('must not reread old source');},finalize(){throw Error('must not replay');}});
    assert.equal(result.reused,true);assert.deepEqual(result.finalization.receipt,first.finalization.receipt);
    assert.equal(secondDb.prepare('SELECT count(*) n FROM metadata_book_followups').get().n,1);
  } finally {secondDb.close();}
});

test('dangling monitoring link does not prevent physical-book finalization', t => {
  const f=fixture(t);f.db.exec("DELETE FROM monitored_issues WHERE id='monitor-one'");f.publish();f.finish();
  assert.equal(f.db.prepare("SELECT path FROM scanned_books WHERE id='one'").get().path,f.destination);
  assert.equal(f.db.prepare("SELECT monitored_issue_id FROM scanned_books WHERE id='one'").get().monitored_issue_id,'monitor-one');
  assert.equal(f.db.prepare('SELECT count(*) n FROM monitored_issues').get().n,1);
});
