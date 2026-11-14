'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');const {spawnSync}=require('node:child_process');
const archiver=require('archiver'),sharp=require('sharp');
const {createWorkJournal,initializeWorkJournal}=require('./workJournal');
const {initializeBookFinalization}=require('./bookFinalization');
const {createReprocessingService}=require('./reprocessingService');
const {createRetagAdapter}=require('./retagAdapter');
const {inspectArchive}=require('./archiveValidation');
const {createArchiveStorage}=require('./archiveStorage');
const {storedRar}=require('./testFixtures/storedRar');
const {createLibraryAccess}=require('./libraryAccess');
const binary=process.env.OMNIBUS_TEST_7Z||'7z',tar=process.env.OMNIBUS_TEST_BSDTAR||(process.platform==='win32'?path.join(process.env.SystemRoot,'System32','tar.exe'):'bsdtar');
const real={skip:!!spawnSync(binary,[],{windowsHide:true}).error||!!spawnSync(tar,['--version'],{windowsHide:true}).error};
const xml='<ComicInfo><Series>Example</Series><Number>2</Number><Web>https://comicvine.gamespot.com/issue/4000-123/</Web><Title>Keep title</Title><Pages><Page Image="0" Bookmark="cover"/></Pages><Extra>keep</Extra></ComicInfo>';
function zip(entries){return new Promise((resolve,reject)=>{const a=archiver('zip'),chunks=[];a.on('data',c=>chunks.push(c));a.on('error',reject);a.on('end',()=>resolve(Buffer.concat(chunks)));for(const [name,data]of entries)a.append(data,{name});a.finalize().catch(reject);});}
async function fixture(t,{rar=false,linked=true,sourceXml=xml,failTask=null}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'omnibus-workflow-test-')),library=path.join(root,'library'),scratch=path.join(root,'scratch');fs.mkdirSync(library);fs.mkdirSync(scratch);
 const image=await sharp({create:{width:4,height:3,channels:3,background:'#abcdef'}}).png().toBuffer();
 const entries=[['a/001.png',image],['z/001.png',image],['nested/ComicInfo.xml',sourceXml],['notes.txt','keep']];
 const input=rar?storedRar(entries):await zip(entries),source=path.join(library,rar?'Original.cbr':'Original.cbz');fs.writeFileSync(source,input);
 const db=new DatabaseSync(path.join(root,'work.sqlite'));
 db.exec(`CREATE TABLE scanned_books(id TEXT PRIMARY KEY,series_id TEXT,path TEXT UNIQUE,filename TEXT,comicinfo TEXT,file_size INTEGER,file_mtime REAL,issue_number TEXT,sort_order REAL,title TEXT,cv_issue_id TEXT,monitored_issue_id TEXT,manual_notes TEXT);
 CREATE TABLE monitored_issues(id TEXT PRIMARY KEY,file_path TEXT);
 CREATE TABLE read_progress(book_id TEXT PRIMARY KEY,page INTEGER,completed INTEGER);
 CREATE TABLE list_members(book_id TEXT,position INTEGER,manual INTEGER);
 CREATE TABLE scanned_series(id TEXT PRIMARY KEY,path TEXT);
 CREATE TABLE missing_books(id TEXT,series_id TEXT,path TEXT,filename TEXT,issue_number TEXT,cv_issue_id TEXT,file_size INTEGER,row_json TEXT);
 CREATE TABLE missing_series(id TEXT,library_id TEXT,path TEXT,name TEXT,year INTEGER,cv_volume_id TEXT,row_json TEXT);
 CREATE TABLE identity_rebinds(kind TEXT,mode TEXT,outcome TEXT,entity_id TEXT,old_path TEXT,new_path TEXT,match_key TEXT,candidates TEXT);`);
 db.prepare('INSERT INTO scanned_books VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('one','series',source,path.basename(source),sourceXml,input.length,100,'0.2',0.2,'manual title','123',linked?'123':null,'manual note');
 if(linked)db.prepare('INSERT INTO monitored_issues VALUES(?,?)').run('123',source);
 db.exec("INSERT INTO read_progress VALUES('one',1,0);INSERT INTO list_members VALUES('one',7,1)");
 const logger={info(){},warn(){},error(){}},stableIds=require('../stableIds')({db,logger,fs,path,crypto}),bookIndex=require('../bookIndex')({db,logger,IN:{normIssueNumber:n=>String(n)}});
 const policy={style:process.platform==='win32'?'win32':'posix',caseSensitive:process.platform!=='win32'};initializeWorkJournal(db,policy);initializeBookFinalization(db);
 const journal=createWorkJournal({db,ownerId:'fixture',pathPolicy:policy,readBook:id=>db.prepare('SELECT * FROM scanned_books WHERE id=?').get(id)});
 let exclusive=false, fail=failTask,credit='New writer';const calls=[],access=createLibraryAccess();
 const followups=Object.fromEntries(['cache_invalidation','events','canon','reading_lists'].map(name=>[name,async payload=>{assert.equal(exclusive,true);assert.equal(payload.preserveManualLinks,true);calls.push(name);if(fail===name)throw Error('fixture follow-up failure');}]));
 const options={db,journal,stableIds,bookIndex,libraryRoots:[library],scratchParent:scratch,executables:{'7z':binary,unrar:'fixture-no-unrar',bsdtar:tar},followups,
 withExclusiveMutation:async(scope,action)=>access.run('write',async()=>{assert.equal(exclusive,false);exclusive=true;try{return await action();}finally{exclusive=false;}}),
 loadSource:async id=>{assert.equal(id,'123');return {issue:{id:'123',issue_number:'2',name:'Incoming title',volume:{id:'10',name:'Example'},person_credits:[{name:credit,role:'writer'}]}};}};
 const service=createReprocessingService(options),adapter=createRetagAdapter({db,service,buildDestFilename:()=> 'Example 002 (2020).cbz'});
 t.after(()=>{db.close();const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('omnibus-workflow-test-'));fs.rmSync(target,{recursive:true,force:true});});
 return {db,root,library,scratch,source,input,journal,service,adapter,options,calls,access,setFail:v=>fail=v,setCredit:v=>credit=v};
}
test('real reprocessing waits for admitted readers and excludes later archive access',real,async t=>{
 const f=await fixture(t);let release,started;const ready=new Promise(r=>started=r);
 const reading=f.access.run('read',async()=>{started();await new Promise(r=>release=r);assert.deepEqual(fs.readFileSync(f.source),f.input);});await ready;
 const processing=f.service.reprocess({bookId:'one',requestKey:'coordinated',canonicalFilename:'Renamed.cbz'});
 await new Promise(r=>setImmediate(r));assert.equal(f.journal.listUnfinished().length,0);
 let seen;const nextRead=f.access.run('read',()=>{seen=f.db.prepare("SELECT path FROM scanned_books WHERE id='one'").get().path;assert.ok(fs.existsSync(seen));});
 release();const [,result]=await Promise.all([reading,processing,nextRead]);assert.equal(result.status,'completed');assert.equal(seen,path.join(f.library,'Renamed.cbz'));
});
test('application ZIP reader closes real nested, untagged and invalid archive inputs',{timeout:3000},async t=>{
 const f=await fixture(t),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const code=source.slice(source.indexOf('function readZipComicInfo('),source.indexOf('\nasync function readRarComicInfo('));
 const read=new Function('require','COMICINFO_RE','COMICINFO_MAX',code+';return readZipComicInfo;')(require,/(^|[\\/])comicinfo\.xml$/i,4*1024*1024);
 assert.equal(await f.access.run('read',()=>read(f.source)),xml);
 const untagged=path.join(f.library,'Untagged.cbz');fs.writeFileSync(untagged,await zip([['notes.txt','no XML']]));assert.equal(await read(untagged),'');
 const invalid=path.join(f.library,'Invalid.cbz');fs.writeFileSync(invalid,'not a zip');assert.equal(await read(invalid),null);
});
for(const rar of [false,true])test(`complete retag workflow preserves a physical book (${rar?'RAR':'ZIP'})`,real,async t=>{
 const f=await fixture(t,{rar});const result=await f.adapter({bookId:'one',issue:{id:'123'},series:{name:'Example'},requestKey:'retag-1'});
 assert.equal(result.status,'completed');const book=f.db.prepare("SELECT * FROM scanned_books WHERE id='one'").get();assert.equal(book.path,path.join(f.library,'Example 002 (2020).cbz'));
 assert.equal(fs.existsSync(f.source),false);assert.deepEqual(fs.readdirSync(f.library),['Example 002 (2020).cbz']);assert.deepEqual(fs.readdirSync(f.scratch),[]);
 const inspected=await inspectArchive({input:fs.readFileSync(book.path),sourceName:book.filename});assert.deepEqual(inspected.pages.map(p=>p.name),['a/001.png','z/001.png']);
 assert.ok(inspected.comicInfo.xml.includes('<Title>Incoming title</Title>'));assert.ok(inspected.comicInfo.xml.includes('<Writer>New writer</Writer>'));assert.ok(inspected.comicInfo.xml.includes('<Extra>keep</Extra>'));
 assert.equal(book.sort_order,0.2);assert.equal(book.issue_number,'0.2');assert.equal(book.manual_notes,'manual note');assert.equal(f.db.prepare('SELECT page FROM read_progress').get().page,1);assert.equal(f.db.prepare('SELECT position FROM list_members').get().position,7);
 assert.equal(f.journal.get(result.operationId).release_reason,'completed');assert.equal(f.db.prepare('SELECT state FROM metadata_book_followups').get().state,'complete');
 assert.equal(JSON.parse(f.db.prepare('SELECT record FROM metadata_book_managed').get().record).fields.Writer,'New writer');
 const again=await f.adapter({bookId:'one',issue:{id:'123'},series:{name:'Example'},requestKey:'retag-1'});assert.equal(again.reused,true);assert.equal(f.calls.length,4);
 f.setCredit('Updated writer');await f.service.reprocess({bookId:'one',requestKey:'retag-2'});assert.ok(f.db.prepare("SELECT comicinfo FROM scanned_books WHERE id='one'").get().comicinfo.includes('<Writer>Updated writer</Writer>'));
});

test('unmonitored book uses the same service and preserves custom filename',real,async t=>{
 const f=await fixture(t,{linked:false});await f.adapter({bookId:'one',requestKey:'unmonitored'});
 assert.ok(fs.existsSync(f.source));assert.equal(f.db.prepare('SELECT count(*) n FROM monitored_issues').get().n,0);assert.equal(f.db.prepare('SELECT monitored_issue_id FROM scanned_books').get().monitored_issue_id,null);
});

test('follow-up failure retains original and backup, then resumes forward without retagging',real,async t=>{
 const f=await fixture(t,{rar:true,failTask:'canon'});let id;
 await assert.rejects(f.adapter({bookId:'one',issue:{id:'123'},series:{name:'Example'},requestKey:'failure'}),e=>{id=e.operationId;return /follow-up failure/.test(e.message);});
 const op=f.journal.get(id);assert.equal(op.state,'recovery_required');assert.ok(f.journal.finalization(id));assert.deepEqual(fs.readFileSync(f.source),f.input);assert.ok(fs.existsSync(op.payload.artifacts.backup));
 await assert.rejects(f.service.recover({operationId:id,isQuiescent:()=>false}),e=>e.code==='WORKER_ACTIVE');
 f.setFail(null);assert.equal((await f.service.recover({operationId:id,isQuiescent:()=>true})).status,'completed');
 assert.deepEqual(f.calls,['cache_invalidation','events','canon','canon','reading_lists']);assert.equal(fs.existsSync(f.source),false);assert.equal(f.journal.get(id).state,'released');
});

test('conflicting embedded identity and canonical collision leave original untouched',real,async t=>{
 const f=await fixture(t,{sourceXml:xml.replace('4000-123','4000-999')});await assert.rejects(f.service.reprocess({bookId:'one',requestKey:'wrong'}),e=>e.code==='IDENTITY_REVIEW_REQUIRED');assert.deepEqual(fs.readFileSync(f.source),f.input);
 const occupied=path.join(f.library,'Taken.cbz');fs.writeFileSync(occupied,'unrelated');await assert.rejects(f.service.reprocess({bookId:'one',requestKey:'collision',canonicalFilename:'Taken.cbz'}),e=>e.code==='DESTINATION_OCCUPIED');assert.equal(fs.readFileSync(occupied,'utf8'),'unrelated');
});

test('interrupted retirement is repeatable; changed backup is never deleted',real,async t=>{
 const f=await fixture(t,{rar:true,failTask:'reading_lists'});let id;
 await assert.rejects(f.adapter({bookId:'one',issue:{id:'123'},series:{name:'Example'},requestKey:'retire'}),e=>{id=e.operationId;return true;});f.setFail(null);
 const originalFinish=f.journal.finishPublishedBook;
 f.journal.finishPublishedBook=(handle,adapter)=>originalFinish(handle,{...adapter,cleanup:row=>{fs.unlinkSync(row.payload.source);throw Error('crash during retirement');}});
 await assert.rejects(f.service.recover({operationId:id,isQuiescent:()=>true}),/crash during retirement/);assert.equal(fs.existsSync(f.source),false);
 const p=f.journal.get(id).payload,backup=fs.readFileSync(p.artifacts.backup);fs.writeFileSync(p.artifacts.backup,'external');f.journal.finishPublishedBook=originalFinish;
 await assert.rejects(f.service.recover({operationId:id,isQuiescent:()=>true}),e=>e.code==='ARCHIVE_FACTS_CHANGED');assert.equal(fs.readFileSync(p.artifacts.backup,'utf8'),'external');
 fs.writeFileSync(p.artifacts.backup,backup);assert.equal((await f.service.recover({operationId:id,isQuiescent:()=>true})).status,'completed');
});

test('runtime refuses missing coordination or follow-up adapters',real,async t=>{
 const f=await fixture(t);assert.throws(()=>createReprocessingService({...f.options,withExclusiveMutation:null}),/coordinated/);assert.throws(()=>createReprocessingService({...f.options,followups:{}}),/follow-up/);
 await assert.rejects(f.adapter({issue:{id:'123',file_path:path.join(f.library,'missing.cbz')},requestKey:'ambiguous'}),e=>e.code==='BOOK_SELECTION_REQUIRED');
});

test('retag adapter refuses monitored naming evidence for another issue',real,async t=>{
 const f=await fixture(t);await assert.rejects(f.adapter({bookId:'one',issue:{id:'999'},series:{name:'Other'},requestKey:'wrong-monitor'}),e=>e.code==='CV_ISSUE_MISMATCH');assert.deepEqual(fs.readFileSync(f.source),f.input);assert.equal(fs.readdirSync(f.library).length,1);
});

test('unchanged repeat does not rebuild the archive or create follow-ups',real,async t=>{
 const f=await fixture(t);await f.service.reprocess({bookId:'one',requestKey:'first'});const before=fs.readFileSync(f.source),stat=fs.statSync(f.source),calls=f.calls.length;
 assert.equal((await f.service.reprocess({bookId:'one',requestKey:'noop'})).status,'unchanged');assert.deepEqual(fs.readFileSync(f.source),before);assert.equal(fs.statSync(f.source).mtimeMs,stat.mtimeMs);assert.equal(f.calls.length,calls);
 assert.equal((await f.service.reprocess({bookId:'one',requestKey:'noop'})).status,'unchanged');
});

test('changed finalized destination stops recovery before any follow-up callback',real,async t=>{
 const f=await fixture(t,{failTask:'events'});let id;await assert.rejects(f.service.reprocess({bookId:'one',requestKey:'changed'}),e=>{id=e.operationId;return true;});
 const calls=f.calls.length;fs.writeFileSync(f.source,'external change');f.setFail(null);
 await assert.rejects(f.service.recover({operationId:id,isQuiescent:()=>true}),e=>e.code==='ARCHIVE_FACTS_CHANGED');assert.equal(f.calls.length,calls);assert.ok(fs.existsSync(f.journal.get(id).payload.artifacts.backup));
});

test('applied manual overrides retain their provenance without becoming provider-owned fields',real,async t=>{
 const f=await fixture(t),overrides={bookId:'one',cvIssueId:'123',fields:{Title:'Chosen title'}};
 const service=createReprocessingService({...f.options,readOverrides:()=>overrides});await service.reprocess({bookId:'one',requestKey:'override'});
 const record=JSON.parse(f.db.prepare('SELECT record FROM metadata_book_managed').get().record);assert.deepEqual(record.appliedOverrides,overrides);assert.equal(record.fields.Title,undefined);assert.ok(record.identityProvenance.acceptedSources.length);
 assert.ok(f.db.prepare("SELECT comicinfo FROM scanned_books WHERE id='one'").get().comicinfo.includes('<Title>Chosen title</Title>'));
});

// Phase 4.1: real runtime + real route handlers + existing archive tools.
const {createRetagRuntime}=require('./retagRuntime');
const {createRetagHandlers}=require('./retagRoutes');
const {EventEmitter}=require('node:events');
async function runtimeFixture(t,settings={}) {
 const f=await fixture(t,settings);let failTask=null;const providerCalls=[],tasks=[];
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const namingCode=source.slice(source.indexOf('function buildDestFilename('),source.indexOf('// Extract volume number from manga filenames.'));
 const naming=new Function('padIssueNumStr',namingCode+';return buildDestFilename;')(require('../issueNumber').padIssueNumStr);
 const issue={id:'123',issue_number:'2',cover_date:'2020-04-01',volume:{id:'10',name:'Example'},person_credits:[{name:'Runtime writer',role:'writer'}]};
 const volume={id:'10',name:'Example',start_year:'2019',publisher:{name:'Publisher'}};
 const opts={pathPolicy:{style:process.platform==='win32'?'win32':'posix',caseSensitive:process.platform!=='win32'},db:f.db,access:f.access,stableIds:f.options.stableIds,bookIndex:f.options.bookIndex,getLibraryRoots:()=>[f.library],scratchParent:f.scratch,
  executables:f.options.executables,fetchIssue:async id=>{providerCalls.push(['issue',id]);return issue;},fetchVolume:async id=>{providerCalls.push(['volume',id]);return volume;},
  saveIssue:(id,value)=>providerCalls.push(['save',id]),buildDestFilename:naming,
  buildMangaDestFilename:new Function(source.slice(source.indexOf('function buildMangaDestFilename('),source.indexOf('/** Patch locg_series_id'))+';return buildMangaDestFilename;')(),
  followups:Object.fromEntries(['cache_invalidation','events','canon','reading_lists'].map(name=>[name,async()=>{tasks.push(name);if(failTask===name)throw Error('runtime follow-up failed');}]))};
 const runtime=createRetagRuntime(opts),handlers=createRetagHandlers({getRuntime:()=>runtime,logger:{warn(){}}});
 return {...f,runtime,handlers,opts,issue,volume,providerCalls,tasks,setFailure:value=>failTask=value};
}
function response(){const r=new EventEmitter();r.code=200;r.headers={};r.events=[];r.status=n=>{r.code=n;return r;};r.json=v=>{r.body=v;return r;};r.setHeader=(k,v)=>r.headers[k]=v;r.write=v=>{r.events.push(JSON.parse(v.slice(6)));};r.end=()=>{r.ended=true;};return r;}

test('actual retag allows another series to read throughout publication follow-ups', {...real,timeout:10000},async t=>{
 const f=await runtimeFixture(t);let release,started;
 const other=path.join(f.library,'Unrelated.cbz');fs.writeFileSync(other,f.input);
 const entered=new Promise(r=>started=r),stop=new Promise(r=>release=r);
 const runtime=createRetagRuntime({...f.opts,followups:{...f.opts.followups,events:async()=>{started();await stop;}}});
 const processing=runtime.retag({bookId:'one'});await entered;
 let sameRead=false;
 const reading=f.access.run('read',()=>{sameRead=true;},{scope:'series:series'});
 try{
   await f.access.run('read',async()=>{
     const result=await require('node:util').promisify(require('node:child_process').execFile)(binary,['e','-so',other,'a/001.png'],{encoding:'buffer',windowsHide:true});
     assert.equal((await sharp(result.stdout).metadata()).width,4);
   },{scope:'series:unrelated'});
   assert.equal(sameRead,false);assert.equal(f.access.snapshot().writer,true);
 }finally{release();}
 await Promise.all([processing,reading]);assert.equal(sameRead,true);
});

test('held retag and restart fence affected images while unrelated series remain available',real,async t=>{
 const f=await runtimeFixture(t);f.setFailure('canon');
 await assert.rejects(f.runtime.retag({bookId:'one'}),/follow-up failed/);
 for(const runtime of [f.runtime,createRetagRuntime(f.opts)]){
   assert.equal(runtime.status().length,1);
   await f.access.run('read',()=>{}, {scope:'series:unrelated'});
   await assert.rejects(f.access.run('read',()=>assert.fail(),{scope:'series:series'}),{code:'LIBRARY_RECOVERY_REQUIRED'});
   await assert.rejects(f.access.run('write',()=>assert.fail(),{scope:'series:unrelated'}),{code:'LIBRARY_RECOVERY_REQUIRED'});
 }
 // Missing book identity must fall back to a global hold, never guess safety.
 f.db.prepare('DELETE FROM scanned_books WHERE id=?').run('one');
 await assert.rejects(f.access.run('read',()=>assert.fail(),{scope:'series:unrelated'}),{code:'LIBRARY_RECOVERY_REQUIRED'});
});

test('single library retag route renames an unmonitored imported book using real naming and conversion',real,async t=>{
 const f=await runtimeFixture(t,{rar:true,linked:false}),res=response();await f.handlers.single({params:{id:'one'},body:{cvIssueId:'123'}},res);
 assert.equal(res.code,200,JSON.stringify(res.body));assert.equal(res.body.success,true);assert.equal(res.body.renamedTo,'Example 002 (2020).cbz');
 assert.equal(f.db.prepare('SELECT path FROM scanned_books').get().path,path.join(f.library,'Example 002 (2020).cbz'));
 assert.equal(f.db.prepare('SELECT page FROM read_progress').get().page,1);assert.equal(f.db.prepare('SELECT position FROM list_members').get().position,7);
 assert.deepEqual(f.providerCalls,[['issue','123'],['volume','10'],['save','123']]);assert.equal(f.runtime.status().length,0);assert.equal(f.tasks.length,4);
});
test('selected-book batch supports unmonitored books and deduplicates stable IDs',real,async t=>{
 const f=await runtimeFixture(t,{linked:false}),res=response();await f.handlers.batch({body:{bookIds:['one','one']}},res);
 assert.deepEqual(res.events.at(-1),{done:true,total:1,succeeded:1,errors:0,aborted:false,cancelled:false});assert.ok(fs.existsSync(path.join(f.library,'Example 002 (2020).cbz')));
});
test('automatic refresh retains basename while using the same runtime',real,async t=>{
 const f=await runtimeFixture(t,{rar:true});const result=await f.runtime.retag({issue:{id:'123',file_path:f.source},preserveFilename:true,freshIssue:f.issue});
 assert.equal(result.path,path.join(f.library,'Original.cbz'));assert.deepEqual(f.providerCalls.map(v=>v[0]),['volume','save']);assert.equal(f.db.prepare('SELECT file_path FROM monitored_issues').get().file_path,result.path);
});
test('actual naming retains annual and decimal issue conventions',real,async t=>{
 const f=await runtimeFixture(t,{sourceXml:xml.replace('<Series>Example</Series>','<Series>Example Annual</Series>').replace('<Number>2</Number>','<Number>2.1</Number>')});f.volume.name='Example Annual';f.issue.issue_number='2.1';
 const result=await f.runtime.retag({bookId:'one'});assert.equal(path.basename(result.path),'Example 2020 Annual 002.1.cbz');
});
test('Download Manager cannot fall back to another scanned copy at a stale path',real,async t=>{
 const f=await runtimeFixture(t);await assert.rejects(f.runtime.retag({issue:{id:'123',file_path:path.join(f.library,'Missing.cbz')}}),e=>e.code==='BOOK_SELECTION_REQUIRED');
 assert.equal(f.providerCalls.length,0);assert.deepEqual(fs.readFileSync(f.source),f.input);
});
test('single route accepts CV URL and rejects conflicting request aliases',real,async t=>{
 const f=await runtimeFixture(t);const bad=response();await f.handlers.single({params:{id:'one'},body:{cvIssueId:'123',cv_issue_url:'456'}},bad);assert.equal(bad.code,400);assert.equal(f.providerCalls.length,0);
 const good=response();await f.handlers.single({params:{id:'one'},body:{cv_issue_url:'https://comicvine.gamespot.com/example/4000-123/'}},good);assert.equal(good.code,200,JSON.stringify(good.body));
});
test('an unchanged file still fills a missing library ID and stale ComicInfo row',real,async t=>{
 const f=await fixture(t);await f.service.reprocess({bookId:'one',requestKey:'first'});
 const saved=f.db.prepare("SELECT comicinfo,cv_issue_id FROM scanned_books WHERE id='one'").get();
 f.db.prepare("UPDATE scanned_books SET cv_issue_id=NULL,comicinfo='<ComicInfo><Title>nested copy</Title></ComicInfo>' WHERE id='one'").run();
 assert.equal((await f.service.reprocess({bookId:'one',requestKey:'noop'})).status,'unchanged');
 const row=f.db.prepare("SELECT comicinfo,cv_issue_id FROM scanned_books WHERE id='one'").get();
 assert.equal(row.comicinfo,saved.comicinfo);assert.equal(row.cv_issue_id,saved.cv_issue_id||'123');
});
test('provider volume mismatch and physical XML conflict leave bytes and names unchanged',real,async t=>{
 const f=await runtimeFixture(t);f.volume.id='999';await assert.rejects(f.runtime.retag({bookId:'one'}),e=>e.code==='CV_NO_DATA');f.volume.id='10';
 // DB suggests 123, actual archive remains 123: explicit correction is held.
 await assert.rejects(f.runtime.retag({bookId:'one',explicitIssueId:'999'}),e=>e.code==='CV_NO_DATA');
 assert.equal(f.runtime.status().length,0);assert.deepEqual(fs.readFileSync(f.source),f.input);
 // A manual Tag with a different issue is the user's correction and replaces the identity.
 f.issue.id='999';const corrected=await f.runtime.retag({bookId:'one',explicitIssueId:'999'});assert.equal(corrected.status,'completed');
 const book=f.db.prepare("SELECT * FROM scanned_books WHERE id='one'").get();assert.equal(book.cv_issue_id,'999');assert.ok(book.comicinfo.includes('4000-999/'));assert.ok(!/4000-123\/|CVDB123/.test(book.comicinfo));
});
test('durable hold blocks later readers/writers, including a new runtime, until explicit recovery',real,async t=>{
 const f=await runtimeFixture(t);f.setFailure('canon');let operationId;
 await assert.rejects(f.runtime.retag({bookId:'one'}),e=>{operationId=e.operationId;return /follow-up failed/.test(e.message);});
 for(const mode of ['read','write'])await assert.rejects(f.access.run(mode,()=>assert.fail('must remain fenced')),e=>e.code==='LIBRARY_RECOVERY_REQUIRED');
 assert.equal(f.runtime.status()[0].canRecoverInThisProcess,true);
 const restarted=createRetagRuntime(f.opts);assert.equal(restarted.status()[0].canRecoverInThisProcess,false);
 await assert.rejects(restarted.recover({operationId}),e=>e.code==='WORKER_STOP_CONFIRMATION_REQUIRED');
 f.setFailure(null);assert.equal((await restarted.recover({operationId,previousWorkerStopped:true})).status,'completed');
 await f.access.run('read',()=>assert.ok(fs.existsSync(path.join(f.library,'Example 002 (2020).cbz'))));assert.equal(restarted.status().length,0);
 assert.deepEqual(f.tasks,['cache_invalidation','events','canon','canon','reading_lists']);
});
test('failed batch stops at first durable hold and returns recovery operation',real,async t=>{
 const f=await runtimeFixture(t);f.setFailure('events');const res=response();await f.handlers.batch({body:{bookIds:['one','second']}},res);
 assert.equal(res.events.at(-1).aborted,true);assert.equal(res.events.at(-1).errors,1);assert.ok(res.events.find(v=>v.operationId));
 f.setFailure(null);assert.equal((await f.runtime.recover({operationId:f.runtime.status()[0].operationId})).status,'completed');
});
test('queued cancelled retag never fetches a provider or reserves a book',real,async t=>{
 const f=await runtimeFixture(t),controller=new AbortController();controller.abort();await assert.rejects(f.runtime.retag({bookId:'one',signal:controller.signal}),e=>e.code==='ARCHIVE_CANCELLED');
 assert.equal(f.providerCalls.length,0);assert.equal(f.runtime.status().length,0);
});
test('server controls are wired to runtime, fresh issue includes volume, and legacy rotation uses the shared queue',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 assert.ok(source.includes("app.post('/api/books/:id/tag', requireAdmin, retagHandlers.single)"));assert.ok(source.includes("app.post('/api/books/batch/retag', requireAdmin, retagHandlers.batch)"));
 assert.ok(source.includes('metadataRuntime.retag({issue, freshIssue, preserveFilename, signal})'));assert.ok(!source.includes('async function runRetagRotation('));assert.ok(source.includes('metadataMaintenance.run(25,{force:true})'));
 assert.ok(source.includes("location_credits,volume';"));assert.ok(source.includes("canonMatch.reconcile(true, { strict: true })"));assert.ok(source.includes("events: async () => scheduleLinkReconcile(),"));   // links re-checked once per batch (2026-10-22)
 assert.ok(!source.includes("SELECT path FROM scanned_books WHERE monitored_issue_id = ? ORDER BY last_scanned DESC LIMIT 1"));
});

test('batch disconnect cancels active work and does not start another book',async()=>{
 const calls=[],runtime={retag:({bookId,signal})=>new Promise((resolve,reject)=>{calls.push(bookId);signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{code:'ARCHIVE_CANCELLED'})),{once:true});}),status:()=>[]};
 const handlers=createRetagHandlers({getRuntime:()=>runtime,logger:{warn(){}}}),res=response();const running=handlers.batch({body:{bookIds:['first','second']}},res);
 await new Promise(resolve=>setImmediate(resolve));res.destroyed=true;res.emit('close');await running;assert.deepEqual(calls,['first']);assert.equal(res.listenerCount('close'),0);
});
test('rate limit aborts selected-book batch before the next request',async()=>{
 let count=0;const runtime={retag:async()=>{count++;throw Object.assign(Error('rate limited'),{code:'CV_RATE_LIMIT'});},status:()=>[]};
 const handlers=createRetagHandlers({getRuntime:()=>runtime,logger:{warn(){}}}),res=response();await handlers.batch({body:{bookIds:['first','second']}},res);assert.equal(count,1);assert.equal(res.events.at(-1).aborted,true);
});
test('explicit initial identity tags an untagged book while preserving useful metadata',real,async t=>{
 const f=await runtimeFixture(t,{sourceXml:'<ComicInfo><Title>Keep my title</Title></ComicInfo>'});
 const result=await f.runtime.retag({bookId:'one',explicitIssueId:'123'});assert.equal(result.status,'completed');const book=f.db.prepare("SELECT * FROM scanned_books WHERE id='one'").get();assert.ok(book.comicinfo.includes('Keep my title'));assert.ok(book.comicinfo.includes('/4000-123/'));assert.equal(f.runtime.status().length,0);
});

async function downloadFixture(t,settings={}){
 const f=await runtimeFixture(t,settings);const downloads=path.join(f.root,'downloads');fs.mkdirSync(downloads);const incoming=path.join(downloads,settings.rar?'Incoming.cbr':'Incoming.cbz');fs.writeFileSync(incoming,f.input);
 f.db.exec(`CREATE TABLE libraries(id TEXT PRIMARY KEY,path TEXT);CREATE UNIQUE INDEX scanned_series_path ON scanned_series(path);
 ALTER TABLE scanned_series ADD COLUMN library_id TEXT;ALTER TABLE scanned_series ADD COLUMN name TEXT;ALTER TABLE scanned_series ADD COLUMN year INTEGER;
 ALTER TABLE scanned_series ADD COLUMN metadata_status TEXT;ALTER TABLE scanned_series ADD COLUMN series_json TEXT;ALTER TABLE scanned_series ADD COLUMN monitored_series_id TEXT;
 ALTER TABLE scanned_series ADD COLUMN book_count INTEGER;ALTER TABLE scanned_series ADD COLUMN last_scanned TEXT;ALTER TABLE scanned_series ADD COLUMN dir_mtime INTEGER;ALTER TABLE scanned_series ADD COLUMN dir_file_count INTEGER;
 ALTER TABLE scanned_books ADD COLUMN last_scanned TEXT;`);
 f.db.exec(`ALTER TABLE monitored_issues ADD COLUMN series_id TEXT;ALTER TABLE scanned_books ADD COLUMN is_special INTEGER DEFAULT 0;CREATE TABLE monitored_series(id TEXT PRIMARY KEY,is_special INTEGER DEFAULT 0,parent_series_id TEXT);`);
 f.db.exec(`ALTER TABLE monitored_issues ADD COLUMN status TEXT;ALTER TABLE monitored_issues ADD COLUMN cv_data TEXT;ALTER TABLE monitored_issues ADD COLUMN date_processed TEXT;ALTER TABLE monitored_issues ADD COLUMN has_comicinfo INTEGER;ALTER TABLE monitored_issues ADD COLUMN last_retag_cv_hash TEXT;`);
 f.db.prepare('INSERT INTO libraries VALUES(?,?)').run('lib',f.library);
 f.db.transaction=fn=>(...args)=>{f.db.exec('SAVEPOINT fixture_reclaim');try{const result=fn(...args);f.db.exec('RELEASE fixture_reclaim');return result;}catch(e){f.db.exec('ROLLBACK TO fixture_reclaim; RELEASE fixture_reclaim');throw e;}};
 const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const scanStmts=server.slice(server.indexOf('function makeScanStmts()'),server.indexOf('// Keep archive readers'));
 const makeScanStmts=new Function('db','BOOK_UPSERT',scanStmts+';return makeScanStmts;')(f.db,require('./scannerState').BOOK_UPSERT);
 const register=server.slice(server.indexOf('  registerArrival: ({connection'),server.indexOf('  fetchVolume: async id =>',server.indexOf('const metadataRuntime =')));
 const parseComicInfo=xml=>{const ci=require('./evidence').parseComicInfoEvidence(xml);return {number:ci.fields.number?.[0],title:ci.fields.title?.[0]};};
 const maintenance=require('./maintenance').createMetadataMaintenance({db:f.db,runtime:{},now:()=>Date.UTC(2020,3,2),logger:{warn(){}}});
 const registerArrival=new Function('path','stableIds','readSeriesJson','parseComicInfo','makeScanStmts','metadataMaintenance','return ({'+register+'}).registerArrival;')(path,f.options.stableIds,()=>null,parseComicInfo,makeScanStmts,maintenance);
 const runtime=createRetagRuntime({...f.opts,registerArrival});return {...f,runtime,incoming,registerArrival,maintenance};
}
for(const rar of [false,true])test(`download arrival shares preservation, atomic stable registration and conversion (${rar?'RAR':'ZIP'})`,real,async t=>{
 const f=await downloadFixture(t,{rar,sourceXml:'<ComicInfo><Title>Original title</Title><Web>https://example.org/original</Web><Notes>Personal note</Notes><Extra>keep</Extra></ComicInfo>'});
 const result=await f.runtime.arrive({sourcePath:f.incoming,issue:{id:'123'},directory:f.library});assert.equal(result.status,'completed');
 const book=f.db.prepare('SELECT * FROM scanned_books WHERE id=?').get(result.bookId);assert.notEqual(book.id,'one');assert.equal(book.cv_issue_id,'123');assert.equal(book.filename,'Example 002 (2020).cbz');
 assert.ok(book.comicinfo.includes('Original title'));assert.ok(book.comicinfo.includes('https://example.org/original'));assert.ok(book.comicinfo.includes('Personal note'));assert.ok(book.comicinfo.includes('<Extra>keep</Extra>'));
 assert.equal(f.db.prepare('SELECT cv_issue_id FROM book_ci_index WHERE book_id=?').get(book.id).cv_issue_id,'123');
 assert.equal(fs.existsSync(f.incoming),false);assert.ok(fs.existsSync(f.source));assert.equal(f.db.prepare('SELECT page FROM read_progress WHERE book_id=?').get('one').page,1);
 assert.equal(f.runtime.status().length,0);assert.deepEqual(fs.readdirSync(f.scratch),[]);assert.ok(f.runtime.journal.finalization(result.operationId));
});
test('download arrival for a "Special of" series is filed as a special',real,async t=>{
 const f=await downloadFixture(t);
 f.db.exec("INSERT INTO monitored_series VALUES('sp',1,NULL);UPDATE monitored_issues SET series_id='sp' WHERE id='123'");
 const result=await f.runtime.arrive({sourcePath:f.incoming,issue:{id:'123'},directory:f.library});assert.equal(result.status,'completed');
 const book=f.db.prepare('SELECT is_special,sort_order FROM scanned_books WHERE id=?').get(result.bookId);
 assert.equal(book.is_special,1);assert.equal(book.sort_order,9002);
});
test('download arrival for an ordinary series is not a special',real,async t=>{
 const f=await downloadFixture(t);
 f.db.exec("INSERT INTO monitored_series VALUES('reg',0,NULL);UPDATE monitored_issues SET series_id='reg' WHERE id='123'");
 const result=await f.runtime.arrive({sourcePath:f.incoming,issue:{id:'123'},directory:f.library});
 assert.equal(f.db.prepare('SELECT is_special FROM scanned_books WHERE id=?').get(result.bookId).is_special,0);
});
test('initial arrival registration failure rolls back all DB effects and recovers original bytes',real,async t=>{
 const f=await downloadFixture(t);const runtime=createRetagRuntime({...f.opts,registerArrival:args=>{f.registerArrival(args);throw Error('registration failure');}});let operationId;
 await assert.rejects(runtime.arrive({sourcePath:f.incoming,issue:{id:'123'},directory:f.library}),e=>{operationId=e.operationId;return /registration failure/.test(e.message);});
 assert.equal(f.db.prepare('SELECT count(*) n FROM scanned_books').get().n,1);assert.equal(runtime.journal.get(operationId).book_id,null);assert.deepEqual(fs.readFileSync(f.incoming),f.input);
 const recovered=await runtime.recover({operationId});assert.equal(recovered.action,'rolled_back');assert.equal(runtime.status().length,0);assert.deepEqual(fs.readFileSync(f.incoming),f.input);
});
test('published arrival recovers forward after a follow-up failure without allocating another ID',real,async t=>{
 const f=await downloadFixture(t);f.db.prepare("UPDATE monitored_issues SET file_path=?,status='downloaded' WHERE id='123'").run(f.incoming);f.setFailure('events');let operationId;
 await assert.rejects(f.runtime.arrive({sourcePath:f.incoming,issue:{id:'123'},directory:f.library}),e=>{operationId=e.operationId;return /follow-up failed/.test(e.message);});
 const id=f.runtime.journal.get(operationId).book_id;assert.ok(id);assert.ok(fs.existsSync(f.incoming));assert.equal(f.db.prepare("SELECT status FROM monitored_issues WHERE id='123'").get().status,'processed');assert.equal(f.db.prepare("SELECT file_path FROM monitored_issues WHERE id='123'").get().file_path,path.join(f.library,'Example 002 (2020).cbz'));f.setFailure(null);
 assert.equal((await f.runtime.recover({operationId})).status,'completed');assert.equal(f.runtime.journal.get(operationId).book_id,id);assert.equal(f.db.prepare('SELECT count(*) n FROM scanned_books').get().n,2);
});
test('download conflicting XML and duplicate destination never replace library content',real,async t=>{
 const f=await downloadFixture(t,{sourceXml:xml.replace('4000-123','4000-999')});await assert.rejects(f.runtime.arrive({sourcePath:f.incoming,issue:{id:'123'},directory:f.library}),e=>e.code==='IDENTITY_REVIEW_REQUIRED');assert.deepEqual(fs.readFileSync(f.incoming),f.input);
 fs.writeFileSync(path.join(f.library,'Example 002 (2020).cbz'),'other copy');await assert.rejects(f.runtime.arrive({sourcePath:f.incoming,issue:{id:'123'},directory:f.library}),e=>e.code==='DESTINATION_OCCUPIED');assert.equal(fs.readFileSync(path.join(f.library,'Example 002 (2020).cbz'),'utf8'),'other copy');
});
// Process anyway (2026-11-09): an admin files a held download as its issue. The embedded ID of
// another issue and an unexpected file name no longer stop it; an occupied destination still does.
test('download Process anyway: explicit identity wins over conflicting XML and file name, never over an existing copy',real,async t=>{
 const f=await downloadFixture(t,{sourceXml:xml.replace('4000-123','4000-999')});
 await assert.rejects(f.runtime.arrive({sourcePath:f.incoming,sourceName:'Justice League Quarterly 007 (1991).cbz',issue:{id:'123'},directory:f.library}),e=>['IDENTITY_REVIEW_REQUIRED','CV_ISSUE_MISMATCH'].includes(e.code));
 fs.writeFileSync(path.join(f.library,'Example 002 (2020).cbz'),'other copy');
 await assert.rejects(f.runtime.arrive({sourcePath:f.incoming,sourceName:'Justice League Quarterly 007 (1991).cbz',issue:{id:'123'},directory:f.library,force:true}),e=>e.code==='DESTINATION_OCCUPIED');
 assert.equal(fs.readFileSync(path.join(f.library,'Example 002 (2020).cbz'),'utf8'),'other copy');
 fs.unlinkSync(path.join(f.library,'Example 002 (2020).cbz'));
 const result=await f.runtime.arrive({sourcePath:f.incoming,sourceName:'Justice League Quarterly 007 (1991).cbz',issue:{id:'123'},directory:f.library,force:true});
 assert.equal(result.status,'completed');assert.equal(path.basename(result.path),'Example 002 (2020).cbz');
});
test('unmonitored scanner candidate can initialize identity, but ambiguous candidates never tag',real,async t=>{
 const f=await runtimeFixture(t,{linked:false,sourceXml:'<ComicInfo><Series>Example</Series><Number>2</Number><Volume>2019</Volume></ComicInfo>'});
 f.db.exec("UPDATE scanned_books SET cv_issue_id=NULL,filename='Example 002 (2020).cbz'");
 let runtime=createRetagRuntime({...f.opts,discoverCandidates:async()=>[{issue:f.issue,volume:f.volume},{issue:{...f.issue,id:'456'},volume:f.volume}]});
 await assert.rejects(runtime.retag({bookId:'one'}),e=>e.code==='IDENTITY_REVIEW_REQUIRED');assert.deepEqual(fs.readFileSync(f.source),f.input);
 runtime=createRetagRuntime({...f.opts,discoverCandidates:async()=>[{issue:f.issue,volume:f.volume}]});assert.equal((await runtime.retag({bookId:'one'})).status,'completed');assert.equal(f.db.prepare("SELECT cv_issue_id FROM scanned_books WHERE id='one'").get().cv_issue_id,'123');
});

test('actual downloader handler publishes through runtime and retains ambiguous sources',real,async t=>{
 const f=await downloadFixture(t,{rar:true,sourceXml:''});

 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),code=source.slice(source.indexOf('async function postProcess('),source.indexOf('// ─── Existing-book reprocessing',source.indexOf('async function postProcess(')));
 let scans=0;const postProcess=new Function('fs','path','os','crypto','db','metadataRuntime','logger','invalidateDirectoryExistsCache','createSeriesJsonIfMissing','schedulePostProcessScan',code+';return postProcess;')(fs,path,os,crypto,f.db,f.runtime,{info(){},warn(){},error(){}},()=>{},async()=>{},()=>scans++);
 const result=await postProcess({id:'123'},{id:'10',directory:f.library},f.incoming);assert.equal(result,true);assert.equal(scans,1);assert.equal(f.db.prepare("SELECT status FROM monitored_issues WHERE id='123'").get().status,'processed');
 // A folder holding several comics is a pack (2026-11-14): handed to pack processing, files untouched.
 f.db.exec("CREATE TABLE IF NOT EXISTS series_packs (id INTEGER PRIMARY KEY AUTOINCREMENT, series_id TEXT, file_path TEXT, status TEXT)");
 for(const c of ['download_id TEXT','retry_after TEXT','last_fail_reason TEXT'])try{f.db.exec(`ALTER TABLE monitored_issues ADD COLUMN ${c}`);}catch{}
 const dir=path.join(f.root,'ambiguous');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'a.cbz'),f.input);fs.writeFileSync(path.join(dir,'b.cbz'),f.input);
 assert.equal(await postProcess({id:'123',series_id:'10'},{id:'10',directory:f.library},dir),false);assert.equal(fs.readdirSync(dir).length,2);
 assert.deepEqual({...f.db.prepare('SELECT series_id,file_path,status FROM series_packs').get()},{series_id:'10',file_path:dir,status:'downloaded'});
 assert.equal(f.db.prepare("SELECT status FROM monitored_issues WHERE id='123'").get().status,'wanted');
});
test('unmonitored scanner queue performs initial tagging through native service while retaining basename',real,async t=>{
 const f=await runtimeFixture(t,{linked:false,sourceXml:'<ComicInfo><Series>Example</Series><Number>2</Number><Volume>2019</Volume></ComicInfo>'});
 f.db.exec("UPDATE scanned_books SET cv_issue_id=NULL");
 const runtime=createRetagRuntime({...f.opts,discoverCandidates:async()=>[{issue:f.issue,volume:f.volume}]});
 const queue=require('./maintenance').createMetadataMaintenance({db:f.db,runtime,logger:{warn(){}},now:()=>Date.UTC(2020,3,15)});queue.enqueue('one','scanner');assert.equal((await queue.run()).completed,1);
 const book=f.db.prepare("SELECT * FROM scanned_books WHERE id='one'").get();assert.equal(book.path,f.source);assert.equal(book.cv_issue_id,'123');assert.ok(book.comicinfo.includes('4000-123'));assert.equal(f.db.prepare('SELECT count(*) n FROM monitored_issues').get().n,0);
});
for(const rar of [false,true])test(`manga arrival uses existing tools and naming, then shares independent retag (${rar?'RAR':'ZIP'})`,real,async t=>{
 const original='<ComicInfo><Series>Example</Series><Volume>002</Volume><Year>2020</Year><Manga>YesAndRightToLeft</Manga><Notes>Personal note</Notes><Extra>keep</Extra></ComicInfo>';
 const f=await downloadFixture(t,{rar,sourceXml:original});const result=await f.runtime.arrive({sourcePath:f.incoming,sourceName:`Example v002 (2020).${rar?'cbr':'cbz'}`,issue:{id:'123'},directory:f.library,matchedByFilename:true,profile:'manga'});
 assert.equal(result.status,'completed');const book=f.db.prepare('SELECT * FROM scanned_books WHERE id=?').get(result.bookId);assert.equal(book.filename,'Example v002 (2020).cbz');assert.match(book.comicinfo,/<Volume>002<\/Volume>/);assert.match(book.comicinfo,/Personal note/);assert.equal(book.cv_issue_id,'123');assert.equal(fs.existsSync(f.incoming),false);
 const refreshed=await f.runtime.retag({bookId:book.id,preserveFilename:true});assert.equal(refreshed.status,'unchanged');const explicit=await f.runtime.retag({bookId:book.id});assert.equal(explicit.status,'unchanged');assert.equal(f.db.prepare('SELECT filename FROM scanned_books WHERE id=?').get(book.id).filename,book.filename);
});
test('manga arrival retains mismatched and ambiguous source evidence without publishing',real,async t=>{
 const f=await downloadFixture(t,{sourceXml:'<ComicInfo/>'});
 await assert.rejects(f.runtime.arrive({sourcePath:f.incoming,sourceName:'Other Example v002 (2020).cbz',issue:{id:'123'},directory:f.library,matchedByFilename:true,profile:'manga'}),e=>e.code==='IDENTITY_REVIEW_REQUIRED');assert.ok(fs.existsSync(f.incoming));assert.equal(f.runtime.status().length,0);
});
test('actual manga poller delegates publication and retains unmatched or ambiguous files',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'omnibus-manga-poller-'));t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('omnibus-manga-poller-'));fs.rmSync(root,{recursive:true,force:true});});
 for(const name of ['Example v002 (2020).cbz','Other v002 (2020).cbz','Example v099 (2020).cbz'])fs.writeFileSync(path.join(root,name),'fixture');
 const calls=[],state={running:false},series={id:'10',name:'Example',directory:path.join(root,'library')};let scans=0,duplicates=false;
 const db={prepare:sql=>({all:()=>sql.includes('monitored_series')?[series]:duplicates?[{id:'123',issue_number:'2'},{id:'124',issue_number:'2'}]:[{id:'123',issue_number:'2'}]})};
 const code=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');const start=code.indexOf('async function processMangaTorrents()'),end=code.indexOf('// Manual trigger endpoint',start);
 const runtime={status:()=>[],arrive:async request=>{calls.push(request);return {path:path.join(series.directory,'Example v002 (2020).cbz')};}};
 const run=new Function('fs','path','getSetting','logger','activeDownloads','db','IN','extractVolumeNumber','metadataRuntime','mangaTorrentState','schedulePostProcessScan',code.slice(start,end)+';return processMangaTorrents;')(fs,path,key=>key==='torrent_completed_path'?root:root+'-ddl',{info(){},debug(){},warn(){},error(){}},new Map(),db,{normIssueNumber:n=>String(Number(n))},name=>name.match(/v0*(\d+)/)?.[1],runtime,state,()=>scans++);
 await run();assert.equal(calls.length,1);assert.equal(calls[0].profile,'manga');assert.equal(calls[0].matchedByFilename,true);assert.equal(scans,1);assert.equal(fs.readdirSync(root).length,3);
 duplicates=true;await run();assert.equal(calls.length,1);assert.equal(fs.readdirSync(root).length,3);
});
test('provider lookup allows thumbnail readers and a timeout never reserves archive work',real,async t=>{
 const f=await runtimeFixture(t);let began,finish;const started=new Promise(r=>began=r),waiting=new Promise(r=>finish=r);
 const runtime=createRetagRuntime({...f.opts,fetchIssue:async()=>{began();await waiting;throw Object.assign(Error('timeout of 15000ms exceeded'),{code:'ECONNABORTED'});}});
 const pending=runtime.retag({bookId:'one',preserveFilename:true});const rejected=assert.rejects(pending,e=>e.code==='ECONNABORTED');await started;
 assert.equal(f.access.snapshot().writer,false);await Promise.race([f.access.run('read',()=>assert.deepEqual(fs.readFileSync(f.source),f.input)),new Promise((_,reject)=>setTimeout(()=>reject(Error('reader blocked on provider')),1000))]);
 finish();await rejected;assert.equal(runtime.status().length,0);assert.deepEqual(fs.readFileSync(f.source),f.input);
});
test('retag rechecks book evidence after an unlocked provider wait before publication',real,async t=>{
 const f=await runtimeFixture(t);let began,finish;const started=new Promise(r=>began=r),waiting=new Promise(r=>finish=r);
 const runtime=createRetagRuntime({...f.opts,fetchIssue:async()=>{began();await waiting;return f.issue;}});const pending=runtime.retag({bookId:'one'});const rejected=assert.rejects(pending,e=>e.code==='BOOK_CHANGED_RETRY');await started;
 await f.access.run('write',()=>f.db.prepare("UPDATE scanned_books SET comicinfo=? WHERE id='one'").run(xml.replace('Keep title','External edit')));finish();await rejected;assert.equal(runtime.status().length,0);assert.deepEqual(fs.readFileSync(f.source),f.input);
});

for(const arrival of ['scanner','import'])test(`automatic ${arrival} converts an unidentified RAR while retaining its metadata and library identity`,real,async t=>{
 const original='<ComicInfo><Title>Manual title</Title><Pages><Page Image="0" Bookmark="cover"/></Pages><Unknown>Keep</Unknown></ComicInfo>';
 const f=await runtimeFixture(t,{rar:true,linked:false,sourceXml:original});f.db.exec("UPDATE scanned_books SET cv_issue_id=NULL");
 const queue=require('./maintenance').createMetadataMaintenance({db:f.db,runtime:f.runtime,logger:{warn(){}},now:()=>Date.UTC(2026,9,12)});
 queue.enqueue('one',arrival);const result=await queue.run();assert.equal(result.review,1);
 const book=f.db.prepare("SELECT * FROM scanned_books WHERE id='one'").get();assert.equal(book.filename,'Original.cbz');assert.equal(book.path,path.join(f.library,'Original.cbz'));assert.equal(book.cv_issue_id,null);
 assert.equal(fs.existsSync(f.source),false);assert.equal(f.providerCalls.length,0);assert.equal(f.runtime.status().length,0);
 const actual=await inspectArchive({inputPath:book.path,sourceName:book.filename});assert.equal(actual.comicInfo.xml,original);assert.deepEqual(actual.pages.map(p=>p.name),['a/001.png','z/001.png']);
 assert.equal(f.db.prepare("SELECT page FROM read_progress WHERE book_id='one'").get().page,1);assert.equal(f.db.prepare("SELECT position FROM list_members WHERE book_id='one'").get().position,7);
 assert.equal(book.manual_notes,'manual note');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM metadata_book_managed').get().n,0);
 const job=f.db.prepare("SELECT * FROM metadata_jobs WHERE book_id='one'").get();assert.match(job.last_error,/Converted to CBZ; metadata pending/);queue.enqueue('one',arrival);assert.equal(f.db.prepare("SELECT state FROM metadata_jobs WHERE book_id='one'").get().state,'review');
});

test('provider outage after conversion preserves existing tags and leaves a retryable CBZ',real,async t=>{
 const f=await runtimeFixture(t,{rar:true});const runtime=createRetagRuntime({...f.opts,fetchIssue:async()=>{throw Object.assign(Error('timeout'),{code:'ECONNABORTED'});}});
 const queue=require('./maintenance').createMetadataMaintenance({db:f.db,runtime,logger:{info(){},warn(){}},now:()=>Date.UTC(2026,9,12)});queue.enqueue('one','scanner');assert.equal((await queue.run()).deferred,1);
 const book=f.db.prepare("SELECT * FROM scanned_books WHERE id='one'").get();assert.equal(book.filename,'Original.cbz');assert.equal(book.cv_issue_id,'123');assert.equal(book.monitored_issue_id,'123');
 assert.equal((await inspectArchive({inputPath:book.path,sourceName:book.filename})).comicInfo.xml,xml);
 const job=f.db.prepare('SELECT * FROM metadata_jobs').get();assert.equal(job.state,'retry');assert.equal(job.failures,0);assert.equal(runtime.status().length,0);
});

test('format-only conversion refuses an occupied CBZ without altering either copy',real,async t=>{
 const f=await runtimeFixture(t,{rar:true,linked:false});f.db.exec("UPDATE scanned_books SET cv_issue_id=NULL");
 const occupied=path.join(f.library,'Original.cbz');fs.writeFileSync(occupied,'other physical copy');
 await assert.rejects(f.runtime.retag({bookId:'one',preserveFilename:true}),e=>e.code==='DESTINATION_OCCUPIED');assert.deepEqual(fs.readFileSync(f.source),f.input);assert.equal(fs.readFileSync(occupied,'utf8'),'other physical copy');assert.equal(f.providerCalls.length,0);
});

test('an entirely untagged ZIP mislabeled CBR normalizes before identification without inventing ComicInfo',real,async t=>{
 const f=await runtimeFixture(t,{rar:true,linked:false});const input=await zip([['001.png',Buffer.from('opaque page payload')]]);fs.writeFileSync(f.source,input);
 f.db.prepare("UPDATE scanned_books SET cv_issue_id=NULL,comicinfo=NULL,file_size=? WHERE id='one'").run(input.length);
 await assert.rejects(f.runtime.retag({bookId:'one',preserveFilename:true,arrival:'import'}),e=>e.code==='IDENTITY_REVIEW_REQUIRED'&&e.convertedToCbz===true);
 const book=f.db.prepare("SELECT * FROM scanned_books WHERE id='one'").get();const actual=await inspectArchive({inputPath:book.path,sourceName:book.filename});
 assert.equal(book.filename,'Original.cbz');assert.equal(book.cv_issue_id,null);assert.equal(actual.comicInfo.xml,null);assert.equal(actual.pages[0].sha256,crypto.createHash('sha256').update('opaque page payload').digest('hex'));
});


test('date discovery reuses issue provider without opening archives or requesting volumes',async t=>{
 const f=await runtimeFixture(t);const before=f.db.prepare('SELECT * FROM scanned_books').all();
 assert.equal((await f.runtime.lookupIssue('123')).id,'123');assert.deepEqual(f.providerCalls,[['issue','123'],['save','123']]);
 assert.equal(f.runtime.status().length,0);assert.deepEqual(f.db.prepare('SELECT * FROM scanned_books').all(),before);assert.deepEqual(fs.readFileSync(f.source),f.input);
 const wrong=createRetagRuntime({...f.opts,fetchIssue:async()=>({id:'999'})});await assert.rejects(wrong.lookupIssue('123'),e=>e.code==='CV_NO_DATA');
});


test('runtime deployment drain counts provider lookup and rejects new arrivals before mutation',async t=>{
 const f=await runtimeFixture(t),gate=require('./deploymentGate').createDeploymentGate();let finish;const wait=new Promise(r=>finish=r);
 const runtime=createRetagRuntime({...f.opts,deploymentGate:gate,fetchIssue:async()=>{await wait;return f.issue;}});
 const active=runtime.lookupIssue('123');assert.equal(gate.snapshot().active,1);const drain=gate.drain(1000);
 await assert.rejects(runtime.retag({bookId:'one'}),{code:'DEPLOYMENT_PAUSED'});await assert.rejects(runtime.arrive({}),{code:'DEPLOYMENT_PAUSED'});
 finish();await active;assert.equal(await drain,true);assert.equal(runtime.status().length,0);
});


test('live publication is marked active; a stopped failed operation requires recovery',real,async t=>{
 const f=await runtimeFixture(t);let entered,finish;const started=new Promise(r=>entered=r),waiting=new Promise(r=>finish=r);
 const runtime=createRetagRuntime({...f.opts,followups:{...f.opts.followups,events:async()=>{entered();await waiting;throw Error('follow-up failed');}}});
 const running=runtime.retag({bookId:'one'});const rejected=assert.rejects(running,/follow-up failed/);await started;
 assert.equal(runtime.status().length,1);assert.equal(runtime.status()[0].active,true);
 finish();await rejected;assert.equal(runtime.status()[0].active,false);assert.equal(runtime.status()[0].canRecoverInThisProcess,true);
 const restarted=createRetagRuntime(f.opts);assert.equal(restarted.status()[0].active,false);
});


test('folder title/year identifies a numbered file through runtime and physical archive planning',real,async t=>{
 const f=await runtimeFixture(t,{linked:false,sourceXml:'<ComicInfo/>'});
 const directory=path.join(f.library,'Example (2019)');fs.mkdirSync(directory);
 const target=path.join(directory,'002.cbz');fs.renameSync(f.source,target);
 f.db.prepare("UPDATE scanned_books SET path=?,filename='002.cbz',cv_issue_id=NULL WHERE id='one'").run(target);
 let observed;
 const runtime=createRetagRuntime({...f.opts,discoverCandidates:async hint=>{observed=hint;return [{issue:f.issue,volume:f.volume}];}});
 await runtime.retag({bookId:'one',preserveFilename:true});
 assert.equal(observed.name,'Example');assert.equal(observed.volumeYear,'2019');
 const book=f.db.prepare("SELECT * FROM scanned_books WHERE id='one'").get();assert.equal(book.path,target);assert.equal(book.cv_issue_id,'123');assert.match(book.comicinfo,/Runtime writer/);
 assert.equal(f.db.prepare('SELECT page FROM read_progress').get().page,1);assert.equal(f.db.prepare('SELECT position FROM list_members').get().position,7);
});


test('arrival provider waits leave readers free and initial success persists through follow-up recovery',{...real,timeout:10000},async t=>{
 const f=await downloadFixture(t);let begin,release,failFollowup=true;
 const started=new Promise(r=>begin=r),wait=new Promise(r=>release=r);
 const runtime=createRetagRuntime({...f.opts,registerArrival:f.registerArrival,fetchIssue:async()=>{begin();await wait;return f.issue;},followups:{...f.opts.followups,events:async()=>{if(failFollowup)throw Error('followup interrupted');}}});
 const work=runtime.arrive({sourcePath:f.incoming,issue:{id:'123'},directory:f.library});await started;
 let read=false;await f.access.run('read',()=>{read=true;});assert.equal(read,true);release();
 await assert.rejects(work,/followup interrupted/);
 const row=f.db.prepare("SELECT * FROM metadata_jobs WHERE arrival='download'").get();
 assert.equal(row.last_success_at,Date.UTC(2020,3,2));assert.equal(row.due_at,Date.UTC(2020,3,8));assert.equal(row.milestone,7);
 const op=runtime.status()[0];failFollowup=false;await runtime.recover({operationId:op.operationId,previousWorkerStopped:true});
 assert.equal(f.db.prepare('SELECT last_success_at FROM metadata_jobs WHERE book_id=?').get(row.book_id).last_success_at,row.last_success_at);
});

// Phase 6.5: annual identification through the shared runtime.
test('annual file identified as a year-named one-shot keeps its filename; Claude picks are labelled; duplicates are held',real,async t=>{
 const f=await fixture(t,{linked:false,sourceXml:'<ComicInfo><Notes>keep</Notes></ComicInfo>'});
 const serverSource=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const naming=new Function('padIssueNumStr',serverSource.slice(serverSource.indexOf('function buildDestFilename('),serverSource.indexOf('// Extract volume number from manga filenames.'))+';return buildDestFilename;')(require('../issueNumber').padIssueNumStr);
 f.opts={db:f.db,access:f.access,stableIds:f.options.stableIds,bookIndex:f.options.bookIndex,getLibraryRoots:()=>[f.library],scratchParent:f.scratch,executables:f.options.executables,
  saveIssue:()=>{},buildDestFilename:naming,followups:Object.fromEntries(['cache_invalidation','events','canon','reading_lists'].map(name=>[name,async()=>{}]))};
 f.issue={id:'123',volume:{id:'11'}};f.volume={publisher:{name:'Publisher'}};
 const annualPath=path.join(f.library,"Example Annual 2020 (2020) (Digital).cbz");fs.renameSync(f.source,annualPath);
 f.db.prepare("UPDATE scanned_books SET cv_issue_id=NULL,path=?,filename=? WHERE id='one'").run(annualPath,path.basename(annualPath));
 const issue={...f.issue,issue_number:'1',cover_date:'2021-01-01',volume:{id:'11',name:"Example '20"}},volume={...f.volume,id:'11',name:"Example '20",start_year:'2020'};
 const pick={issue,volume,annualMatch:{rule:'ai',reason:'Example 2020 annual one-shot'}};
 const opts={...f.opts,pathPolicy:{style:process.platform==='win32'?'win32':'posix',caseSensitive:process.platform!=='win32'},fetchIssue:async()=>issue,fetchVolume:async()=>volume,discoverAnnual:async()=>({candidate:pick,reason:null}),onTimings:t=>timings.push(t)};const timings=[];
 f.db.prepare("INSERT INTO scanned_books(id,series_id,path,filename,cv_issue_id) VALUES('two','series',?,?,'123')").run(path.join(f.library,'Other.cbz'),'Other.cbz');
 await assert.rejects(createRetagRuntime(opts).retag({bookId:'one',preserveFilename:true}),e=>e.code==='IDENTITY_REVIEW_REQUIRED'&&/Duplicate copy/.test(e.message));
 f.db.exec("DELETE FROM scanned_books WHERE id='two'");
 const result=await createRetagRuntime(opts).retag({bookId:'one',preserveFilename:true});
 assert.equal(result.status,'completed');assert.equal(result.identifiedBy,'ai');assert.match(result.identificationNote,/AI match: Example '20 #1/);
 assert.ok(timings.some(t=>t.kind==='identification'&&t.outcome==='ai_match'));const retagTiming=timings.find(t=>t.kind==='retag'&&t.outcome==='completed');assert.ok(retagTiming.steps.publish_to_library>=0&&retagTiming.total_ms>=0);
 const book=f.db.prepare("SELECT * FROM scanned_books WHERE id='one'").get();assert.equal(book.filename,path.basename(annualPath));assert.equal(book.cv_issue_id,'123');assert.match(book.comicinfo,/keep/);
 // A Claude pick whose year disagrees is never applied.
 f.db.prepare("UPDATE scanned_books SET filename=? WHERE id='one'").run('Example Annual 2018 (2018).cbz');
 const wrong=createRetagRuntime({...opts,discoverAnnual:async()=>({candidate:pick,reason:null})});
 f.db.exec("UPDATE scanned_books SET cv_issue_id=NULL,comicinfo='<ComicInfo/>' WHERE id='one'");
 await assert.rejects(wrong.retag({bookId:'one',preserveFilename:true}),e=>e.code==='IDENTITY_REVIEW_REQUIRED');
});
