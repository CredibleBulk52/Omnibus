'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createScannerState, BOOK_UPSERT } = require('./scannerState');
const { initializeWorkJournal, createWorkJournal } = require('./workJournal');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
// Execute the actual scanner functions without booting the server, opening its
// database, contacting providers or reading a user's comics.
const scannerCode = source.slice(source.indexOf('function makeScanStmts()'), source.indexOf('\nasync function runLibraryScan('));
function fixture(t, { existing = true, reclaim = false, filename = 'Example 002.cbz', thumbs = true, extract = async () => '<ComicInfo><Web>https://comicvine.gamespot.com/issue/4000-123/</Web></ComicInfo>', thumbnail = async () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-scanner-test-'));
  const dir = path.join(root, 'Series'), file = path.join(dir, filename);
  fs.mkdirSync(dir); fs.writeFileSync(file, 'fixture archive bytes');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series(id TEXT PRIMARY KEY,library_id TEXT,path TEXT UNIQUE,name TEXT,year INTEGER,metadata_status TEXT,series_json TEXT,monitored_series_id TEXT,book_count INTEGER,last_scanned TEXT,dir_mtime REAL,dir_file_count INTEGER);
    CREATE TABLE scanned_books(id TEXT PRIMARY KEY,series_id TEXT,path TEXT UNIQUE,filename TEXT,issue_number TEXT,title TEXT,comicinfo TEXT,cv_issue_id TEXT,monitored_issue_id TEXT,sort_order REAL,last_scanned TEXT,file_mtime REAL,file_size INTEGER,is_special INTEGER DEFAULT 0);
    CREATE TABLE monitored_series(id TEXT,name TEXT,parent_series_id TEXT,is_special INTEGER,directory TEXT);
    CREATE TABLE monitored_issues(id TEXT,status TEXT,file_path TEXT,series_id TEXT,issue_number TEXT,is_annual INTEGER);
    CREATE TABLE series_json_cache(series_id TEXT);
    CREATE TABLE read_progress(book_id TEXT,page INTEGER);
    CREATE TABLE list_members(book_id TEXT,manual INTEGER);
    INSERT INTO read_progress VALUES('one',7); INSERT INTO list_members VALUES('one',1);`);
  if (existing) db.prepare(BOOK_UPSERT).run('one','series',file,path.basename(file),'0.2','My title','<old/>','123',null,0.2,0,0);
  const scannerState = createScannerState({ db, fs }), removed = [], cache = [], calls = [], evicted = [];
  const deps = {
    db,fs,path,BOOK_UPSERT,scannerState,process,setImmediate,decideMetadataIdentity:require('./identity').decideIdentity,
    stableIds: { resolveSeriesId: () => 'series', bookAtPath: p => db.prepare('SELECT * FROM scanned_books WHERE path=?').get(p),
      resolveBookId: () => { calls.push('allocate');
        if (reclaim) { db.prepare(BOOK_UPSERT).run('one','series',file,filename,'0.2','Restored title','<old/>','123',null,0.2,0,0); return 'one'; }
        return 'new'; }, tombstoneBook: id => removed.push(id) },
    readSeriesJson: () => null, deriveMetadataStatus: () => 'none', COMIC_EXTS: /\.(cbz|cbr)$/i,
    findThumbCache: () => thumbs, evictThumbCache: id => evicted.push(id), jsonMemCache: new Map(), logger: { info(){},warn(){},error(){} },
    extractComicInfo: p => extract({p, db, file}), parseComicInfo: () => ({number:'2',title:'Provider title'}),
    extractNumberFromFilename: () => '2', extractCvIdFromComicInfo: xml => xml === '<ComicInfo><Web>https://comicvine.gamespot.com/issue/4000-999/</Web></ComicInfo>' ? '999' : '123',
    linkMonitoredByCv: () => {}, listArchiveFiles: async () => ['page.png'], filterImages: x => x,
    execFileAsync: async () => { calls.push('thumbnail'); await thumbnail({db,file}); return {stdout:Buffer.from('image')}; }, THUMB_CACHE_DIR: root,
    readArchiveMember: async () => { calls.push('thumbnail'); await thumbnail({db,file}); return Buffer.from('image'); },
    coverThumb: require('../coverThumb').coverThumb,   // not an image here: kept as it was
  };
  const api = new Function(...Object.keys(deps), scannerCode + '\nreturn {makeScanStmts,scanSeriesDir,warmScannedThumbnail};')(...Object.values(deps));
  const scan = () => { const stmts=api.makeScanStmts(); return api.scanSeriesDir(dir,'library',stmts.upsertSeries,stmts.upsertBook); };
  const book = () => db.prepare('SELECT * FROM scanned_books WHERE id=?').get('one');
  function journal() {
    const policy={style:process.platform==='win32'?'win32':'posix',caseSensitive:process.platform!=='win32'};
    initializeWorkJournal(db,policy);
    return createWorkJournal({db,ownerId:'test',pathPolicy:policy,readBook:id=>db.prepare('SELECT * FROM scanned_books WHERE id=?').get(id)});
  }
  function reserve(j) { return j.begin({requestKey:crypto.randomUUID(),actor:'fixture',intent:'reprocess',bookId:'one',expectedGeneration:j.bookGeneration('one'),sourcePath:file,destinationPath:file,sourceFingerprint:{sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),size:fs.statSync(file).size}}); }
  t.after(() => { db.close(); fs.rmSync(root,{recursive:true,force:true}); });
  return {root,dir,file,db,scannerState,scan,book,journal,reserve,removed,cache,calls,api,evicted};
}
test('actual scanner refresh preserves filing, progress and manual list membership', async t => {
  const f=fixture(t); const result=await f.scan(), b=f.book();
  assert.equal(result.changedBooks,1);assert.equal(b.comicinfo,'<ComicInfo><Web>https://comicvine.gamespot.com/issue/4000-123/</Web></ComicInfo>');assert.equal(b.issue_number,'0.2');assert.equal(b.sort_order,0.2);assert.equal(b.title,'My title');assert.equal(b.series_id,'series');
  assert.equal(f.db.prepare('SELECT page FROM read_progress').get().page,7);
  assert.equal(f.db.prepare('SELECT manual FROM list_members').get().manual,1);
});
test('new arrival still gets scanner values and stableIds registration',async t=>{
  const f=fixture(t,{existing:false});await f.scan();const b=f.db.prepare('SELECT * FROM scanned_books').get();
  assert.equal(b.id,'new');assert.equal(b.issue_number,'2');assert.equal(b.title,'Provider title');assert.deepEqual(f.calls,['allocate']);
});
test('reclaimed physical copy keeps special flag and manual filing',async t=>{
  const f=fixture(t,{existing:false,reclaim:true,filename:'Special 002.cbz'});await f.scan();
  assert.equal(f.book().is_special,0);assert.equal(f.book().issue_number,'0.2');assert.equal(f.book().title,'Restored title');
});
test('archive changed during awaited extraction is deferred and directory retried',async t=>{
  const f=fixture(t,{extract:async({file})=>{fs.writeFileSync(file,'different archive bytes');return '<ComicInfo><Web>https://comicvine.gamespot.com/issue/4000-123/</Web></ComicInfo>';}});
  assert.equal((await f.scan()).deferred,true);assert.equal(f.book().comicinfo,'<old/>');
  assert.equal(f.db.prepare('SELECT dir_mtime FROM scanned_series').get().dir_mtime,-1);
});
test('manual row change during extraction cannot be overwritten',async t=>{
  const f=fixture(t,{extract:async({db})=>{db.exec("UPDATE scanned_books SET title='Edited while scanning'");return '<ComicInfo><Web>https://comicvine.gamespot.com/issue/4000-123/</Web></ComicInfo>';}});
  assert.equal((await f.scan()).deferred,true);assert.equal(f.book().title,'Edited while scanning');assert.equal(f.book().comicinfo,'<old/>');
});
test('conflicting embedded identity holds observation instead of replacing indexed identity',async t=>{
  const f=fixture(t,{extract:async()=>'<ComicInfo><Web>https://comicvine.gamespot.com/issue/4000-999/</Web></ComicInfo>'});assert.equal((await f.scan()).deferred,true);assert.equal(f.book().cv_issue_id,'123');assert.equal(f.book().comicinfo,'<old/>');
});
test('failed ComicInfo read cannot erase useful stored metadata',async t=>{
  const f=fixture(t,{extract:async()=>null});assert.equal((await f.scan()).deferred,true);assert.equal(f.book().comicinfo,'<old/>');
});
test('reclamation at another path waits for held work to release',t=>{
  const f=fixture(t),j=f.journal();assert.equal(f.scannerState.mayRegister(),true);
  const w=f.reserve(j);assert.equal(f.scannerState.mayRegister(),false);
  j.releaseUnstarted(w.handle,'no_work');assert.equal(f.scannerState.mayRegister(),true);
});
test('active and quarantined journal work block scanner until explicitly released',async t=>{
  const f=fixture(t), j=f.journal(), work=f.reserve(j);
  assert.equal((await f.scan()).deferred,true);j.holdOperation(work.handle,'fixture');
  assert.equal((await f.scan()).deferred,true);assert.equal(f.book().comicinfo,'<old/>');
});
test('reservation created during extraction blocks stale commit',async t=>{
  let f,j; f=fixture(t,{extract:async()=>{f.reserve(j);return '<ComicInfo><Web>https://comicvine.gamespot.com/issue/4000-123/</Web></ComicInfo>';}});j=f.journal();
  assert.equal((await f.scan()).deferred,true);assert.equal(f.book().comicinfo,'<old/>');
});
test('completed operation generation invalidates an earlier scan snapshot',t=>{
  const f=fixture(t),j=f.journal(),snapshot=f.scannerState.capture(f.file),work=f.reserve(j);
  j.releaseUnstarted(work.handle,'no_work');assert.equal(f.scannerState.current(snapshot),false);
});
test('scanner does not tombstone a filed book that exists outside scanned directory',async t=>{
  const f=fixture(t),other=path.join(f.root,'Filed.cbz');fs.writeFileSync(other,'comic');
  f.db.prepare('UPDATE scanned_books SET path=?,filename=?').run(other,'Filed.cbz');await f.scan();assert.deepEqual(f.removed,[]);
});
test('missing book is removable only when library is accessible and unreserved',t=>{
  const f=fixture(t), b=f.book(),j=f.journal(),work=f.reserve(j);fs.unlinkSync(f.file);
  assert.equal(f.scannerState.mayRemoveBook(b,f.root),false);
  j.releaseUnstarted(work.handle,'cancelled_before_write');assert.equal(f.scannerState.mayRemoveBook(b,f.root),true);
  fs.rmdirSync(f.dir);fs.rmdirSync(f.root);assert.equal(f.scannerState.mayRemoveBook(b,f.root),false);
});
test('inaccessible paths are never treated as missing',t=>{
  const f=fixture(t),guard=createScannerState({db:f.db,fs:{...fs,lstatSync(){throw Object.assign(Error('denied'),{code:'EACCES'});}}});
  assert.equal(guard.mayRemoveBook(f.book(),f.root),false);
  assert.equal(guard.mayRemoveSeries({id:'series',path:f.dir},f.root),false);
});
test('scan awaits thumbnail extraction and cache writes',async t=>{
  const f=fixture(t,{thumbs:false});await f.scan();assert.deepEqual(f.calls,['thumbnail']);
  assert.equal(fs.readFileSync(path.join(f.root,'one.png'),'utf8'),'image');
  assert.equal(fs.readFileSync(path.join(f.root,'series_series.png'),'utf8'),'image');
});
test('changed archive cannot leave a stale thumbnail or suppress the next scan',async t=>{
  const f=fixture(t,{thumbs:false,thumbnail:async({file})=>fs.writeFileSync(file,'changed during thumbnail')});
  assert.equal((await f.scan()).deferred,true);assert.equal(fs.existsSync(path.join(f.root,'one.png')),false);
  assert.equal(f.db.prepare('SELECT dir_mtime FROM scanned_series').get().dir_mtime,-1);
});

test('a file replaced at the same path loses its cached cover (made again from the new file)',async t=>{
  const f=fixture(t);await f.scan();
  assert.deepEqual(f.evicted,['one']);assert.ok(f.calls.includes('thumbnail'));
});
test('an unchanged file keeps its cached cover',async t=>{
  const f=fixture(t);await f.scan();f.evicted.length=0;f.calls.length=0;await f.scan();
  assert.deepEqual(f.evicted,[]);assert.deepEqual(f.calls,[]);
});
