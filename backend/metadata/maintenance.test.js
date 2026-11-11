'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {createMetadataMaintenance}=require('./maintenance');
const day=86400000,now=Date.UTC(2026,9,12);
test('requested book status follows completion outside filters without writes or provider work',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE scanned_books(id TEXT PRIMARY KEY,comicinfo TEXT,series_id TEXT,cv_issue_id TEXT,filename TEXT);CREATE TABLE scanned_series(id TEXT PRIMARY KEY,library_id TEXT,name TEXT);INSERT INTO scanned_series VALUES('s','L','Series');INSERT INTO scanned_books VALUES('a',NULL,'s',NULL,'A.cbz'),('b',NULL,'s',NULL,'B.cbz')");
 let clock=now,finish;
 const q=createMetadataMaintenance({db,now:()=>clock,logger:{warn(){}},runtime:{status:()=>[],retag:async()=>{await new Promise(resolve=>{finish=resolve;});db.exec("UPDATE scanned_books SET cv_issue_id='123' WHERE id='a'");}}});
 q.enqueue('a');q.enqueue('b');db.exec("UPDATE metadata_jobs SET state='review',checked_at=100,last_error='old error' WHERE book_id='a'");
 const requested=q.requestCheck('a');assert.equal(requested.requestedAt,now);assert.equal(requested.previousCheckedAt,100);
 const running=q.run(1,{bookId:'a'});await new Promise(resolve=>setImmediate(resolve));
 let result=q.status({unidentified:true,view:'intervention',track:'a'});assert.equal(result.runningBookId,'a');assert.equal(result.trackedBooks[0].checked_at,100);
 clock+=1000;finish();await running;
 const changes=db.prepare('SELECT total_changes() n').get().n;
 result=q.status({unidentified:true,view:'intervention',offset:100,search:'not this book',track:'a,a,b,missing'});
 assert.equal(result.books.length,0);assert.equal(result.trackedBooks.length,2);
 assert.equal(result.trackedBooks.find(b=>b.id==='a').checked_at,clock);assert.equal(result.trackedBooks.find(b=>b.id==='a').manual_requested_at,null);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 assert.equal(q.status({track:Array.from({length:20},(_,i)=>'missing'+i).concat('a').join(',')}).trackedBooks.length,0);
});
function fixture(t){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE scanned_books(id TEXT PRIMARY KEY,comicinfo TEXT)');t.after(()=>db.close());const calls=[];let failure=null,held=false;
 const runtime={status:()=>held?[{}]:[],retag:async request=>{calls.push(request);if(failure)throw failure;}};
 const make=()=>createMetadataMaintenance({db,runtime,now:()=>now,logger:{warn(){}}});return {db,calls,make,setFailure:value=>failure=value,setHeld:value=>held=value};}
test('maintenance persists and refreshes recent unmonitored books without changing names',async t=>{
 const f=fixture(t);f.db.prepare('INSERT INTO scanned_books VALUES(?,?)').run('unmonitored','<ComicInfo><Year>2026</Year><Month>10</Month><Writer>A</Writer><Notes>CVDB1</Notes></ComicInfo>');
 f.make().enqueue('unmonitored','import');assert.equal((await f.make().run()).completed,1);
 assert.deepEqual(f.calls,[{bookId:'unmonitored',arrival:'import',preserveFilename:true}]);assert.equal(f.db.prepare('SELECT due_at FROM metadata_jobs').get().due_at,Date.UTC(2026,9,31));
 assert.equal((await f.make().run()).checked,0);
});
test('baseline queues identification and recent books but leaves older identified books idle',async t=>{
 const f=fixture(t);const insert=f.db.prepare('INSERT INTO scanned_books VALUES(?,?)');
 insert.run('recent','<ComicInfo><Year>2026</Year><Month>10</Month></ComicInfo>');insert.run('old','<ComicInfo><Year>2000</Year><Month>1</Month><Writer>A</Writer><Notes>CVDB1</Notes></ComicInfo>');insert.run('sparse',null);
 await f.make().seed();const jobs=f.db.prepare('SELECT * FROM metadata_jobs ORDER BY book_id').all();assert.equal(jobs[0].due_at,Number.MAX_SAFE_INTEGER);assert.equal(jobs[1].due_at,now);assert.equal(jobs[2].due_at,now);
 assert.equal((await f.make().run()).checked,2);assert.equal(f.calls[0].bookId,'recent');
});

test('restart seeding performs zero writes for unchanged existing books and preserves job state',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL),('b',NULL)");const q=f.make();await q.seed();
 f.db.exec("UPDATE metadata_jobs SET state='review',due_at=123,attempts=2,failures=1,last_error='keep',publication_date='2026-10-01',date_basis='cover_date',date_precision='month' WHERE book_id='a'");
 const before=f.db.prepare('SELECT * FROM metadata_jobs ORDER BY book_id').all(),changes=f.db.prepare('SELECT total_changes() n').get().n;
 await q.seed();assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 assert.deepEqual(f.db.prepare('SELECT * FROM metadata_jobs ORDER BY book_id').all(),before);
});
test('seeding updates only changed library grouping without reopening completed or held jobs',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL),('b',NULL)");let moved=false;
 const q=createMetadataMaintenance({db:f.db,runtime:{status:()=>[{}]},logger:{warn(){}},now:()=>now,libraryForBook:book=>moved&&book.id==='a'?'new':'old'});
 await q.seed();f.db.exec("UPDATE metadata_jobs SET state='review',attempts=3");const changes=f.db.prepare('SELECT total_changes() n').get().n;
 moved=true;await q.seed();assert.equal(f.db.prepare('SELECT total_changes() n').get().n-changes,1);
 assert.deepEqual(f.db.prepare('SELECT group_key,state,attempts FROM metadata_jobs ORDER BY book_id').all().map(r=>({...r})),[{group_key:'new',state:'review',attempts:3},{group_key:'old',state:'review',attempts:3}]);
});
test('initial seeding commits bounded batches and yields before the full library is processed',async t=>{
 const f=fixture(t),insert=f.db.prepare('INSERT INTO scanned_books VALUES(?,NULL)');for(let i=0;i<251;i++)insert.run(String(i).padStart(4,'0'));
 const q=f.make(),statements=[];const exec=f.db.exec.bind(f.db);f.db.exec=sql=>{statements.push(sql);return exec(sql);};
 let observed;const tick=new Promise(resolve=>setImmediate(()=>{observed=f.db.prepare('SELECT COUNT(*) n FROM metadata_jobs').get().n;resolve();}));
 await Promise.all([q.seed(),tick]);assert.equal(observed,100);assert.equal(statements.filter(s=>s==='COMMIT').length,3);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM metadata_jobs').get().n,251);
});
test('failed seed batch rolls back together and can resume without partial scheduling changes',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL),('b',NULL)");const q=f.make();
 f.db.exec("CREATE TRIGGER fail_seed BEFORE INSERT ON metadata_jobs WHEN NEW.book_id='b' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 await assert.rejects(q.seed(),/fixture failure/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM metadata_jobs').get().n,0);
 f.db.exec('DROP TRIGGER fail_seed');await q.seed();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM metadata_jobs').get().n,2);
});
test('review waits for new evidence, rate limits stop a batch, and journal holds admit no work',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL),('b',NULL)");let queue=f.make();queue.enqueue('a');queue.enqueue('b');f.setHeld(true);assert.equal((await queue.run()).held,true);assert.equal(f.calls.length,0);f.setHeld(false);
 f.setFailure(Object.assign(Error('rate limit'),{code:'CV_RATE_LIMIT'}));await queue.run();assert.equal(f.calls.length,1);
 assert.equal((await queue.run()).providerRetryAt,now+3600000);f.db.exec('UPDATE metadata_worker_state SET provider_retry_at=0');f.setFailure(Object.assign(Error('review'),{code:'IDENTITY_REVIEW_REQUIRED'}));await queue.run();assert.equal(f.db.prepare("SELECT due_at FROM metadata_jobs WHERE book_id='b'").get().due_at,Number.MAX_SAFE_INTEGER);
});

test('provider budget does not consume attempts and an unidentified result does not loop',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL)");const q=f.make();q.enqueue('a');
 f.setFailure(Object.assign(Error('budget'),{code:'CV_RATE_LIMIT'}));await q.run();assert.equal(f.db.prepare('SELECT attempts FROM metadata_jobs').get().attempts,0);
 f.db.exec('UPDATE metadata_worker_state SET provider_retry_at=0;UPDATE metadata_jobs SET due_at=0');f.setFailure(null);await q.run();
 const j=f.db.prepare('SELECT * FROM metadata_jobs').get();assert.equal(j.state,'waiting');assert.equal(j.attempts,1);assert.equal(j.due_at,Number.MAX_SAFE_INTEGER);assert.equal((await q.run()).checked,0);
});

test('far future dates do not generate daily checks and invalid months remain unknown',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('future','<ComicInfo><Year>2099</Year><Month>1</Month></ComicInfo>'),('bad','<ComicInfo><Year>2026</Year><Month>13</Month></ComicInfo>')");
 await f.make().seed();assert.equal(f.db.prepare("SELECT state FROM metadata_jobs WHERE book_id='future'").get().state,'queued');
 assert.equal(f.db.prepare("SELECT due_at FROM metadata_jobs WHERE book_id='bad'").get().due_at,now);
});
test('fresh provider publication date governs cadence without altering ComicInfo date',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE scanned_books(id TEXT PRIMARY KEY,comicinfo TEXT);INSERT INTO scanned_books VALUES('a','<ComicInfo><Year>2000</Year><Month>1</Month><Writer>A</Writer><Notes>CVDB1</Notes></ComicInfo>')");
 const q=createMetadataMaintenance({db,now:()=>now,logger:{warn(){}},runtime:{status:()=>[],retag:async()=>({publicationDate:'2026-10-01',publicationDateSource:'store_date',publicationDatePrecision:'day'})}});
 q.requestCheck('a');await q.run();const j=db.prepare('SELECT * FROM metadata_jobs').get();assert.equal(j.due_at,Date.UTC(2026,9,31));assert.equal(j.date_basis,'store_date');assert.match(db.prepare('SELECT comicinfo FROM scanned_books').get().comicinfo,/2000/);
});
test('fairness rotates library/work groups across worker recreation and live-only status counts reconcile',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN series_id TEXT;ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;ALTER TABLE scanned_books ADD COLUMN filename TEXT;CREATE TABLE scanned_series(id TEXT PRIMARY KEY,library_id TEXT,name TEXT);INSERT INTO scanned_series VALUES('s1','L1','One'),('s2','L2','Two')");
 for(const [id,series] of [['a','s1'],['b','s1'],['z','s2']])f.db.prepare('INSERT INTO scanned_books(id,series_id,filename) VALUES(?,?,?)').run(id,series,id+'.cbz');
 const make=()=>createMetadataMaintenance({db:f.db,now:()=>now,logger:{warn(){}},libraryForBook:b=>b.series_id==='s1'?'L1':'L2',runtime:{status:()=>[],retag:async x=>f.calls.push(x)}});
 let q=make();q.enqueue('a');q.enqueue('b');q.enqueue('z');await q.run(1);q=make();await q.run(1);assert.deepEqual(f.calls.map(x=>x.bookId),['a','z']);
 const status=q.status();assert.equal(status.total,3);assert.equal(status.counts.due,1);assert.equal(status.counts.waiting,2);assert.equal(q.status({libraryId:'L1'}).total,2);
 f.db.exec("DELETE FROM scanned_books WHERE id='a'");assert.equal(q.status().total,2);assert.equal(q.status().counts.waiting,1);
});
test('changed files reopen review but repeated scanner observations do not',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN file_size INTEGER;INSERT INTO scanned_books(id,comicinfo,file_size) VALUES('a',NULL,10)");const q=f.make();q.enqueue('a');f.setFailure(Object.assign(Error('choose issue'),{code:'IDENTITY_REVIEW_REQUIRED'}));await q.run();q.enqueue('a');assert.equal(f.db.prepare('SELECT state FROM metadata_jobs').get().state,'review');
 f.db.exec('UPDATE scanned_books SET file_size=11');q.enqueue('a');assert.equal(f.db.prepare('SELECT state FROM metadata_jobs').get().state,'queued');assert.equal(f.db.prepare('SELECT due_at FROM metadata_jobs').get().due_at,now);
});
test('three transient failures stop; a missing Comic Vine issue requires intervention',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL)");const q=f.make();q.enqueue('a');f.setFailure(Object.assign(Error('network'),{code:'NETWORK'}));
 for(let n=0;n<3;n++){f.db.exec('UPDATE metadata_jobs SET due_at=0');await q.run();}assert.equal(f.db.prepare('SELECT state FROM metadata_jobs').get().state,'waiting');
 f.db.exec('UPDATE metadata_jobs SET due_at=0,attempts=0,failures=0');f.setFailure(Object.assign(Error('absent'),{code:'CV_NO_DATA'}));await q.run();const j=f.db.prepare('SELECT * FROM metadata_jobs').get();assert.equal(j.state,'review');assert.equal(j.due_at,Number.MAX_SAFE_INTEGER);assert.equal(j.attempts,1);
});
test('manual successful no-op clears old review state and records provider scheduling evidence',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL)");const q=f.make();q.enqueue('a');f.setFailure(Object.assign(Error('old error'),{code:'IDENTITY_REVIEW_REQUIRED'}));await q.run();
 f.db.exec("UPDATE scanned_books SET comicinfo='<ComicInfo><Notes>CVDB1</Notes></ComicInfo>' WHERE id='a'");
 q.recordManualSuccess('a',{publicationDate:'2026-10-01',publicationDateSource:'store_date',publicationDatePrecision:'day'});
 const j=f.db.prepare('SELECT * FROM metadata_jobs').get();assert.equal(j.state,'scheduled');assert.equal(j.last_error,null);assert.equal(j.due_at,Date.UTC(2026,9,31));assert.equal(j.attempts,1);
});
test('status partitions mixed due times within one queue state instead of losing groups',t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN series_id TEXT;ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;ALTER TABLE scanned_books ADD COLUMN filename TEXT;CREATE TABLE scanned_series(id TEXT,library_id TEXT,name TEXT);INSERT INTO scanned_series VALUES('s','L','Series');INSERT INTO scanned_books(id,series_id) VALUES('a','s'),('b','s')");
 const q=f.make();q.enqueue('a');q.enqueue('b');f.db.prepare("UPDATE metadata_jobs SET due_at=? WHERE book_id='b'").run(Date.UTC(2026,9,31));const s=q.status();assert.equal(s.total,2);assert.equal(s.counts.due,1);assert.equal(s.counts.scheduled,1);
});
test('provider outages stop the batch and persist a cooldown without failing untouched books',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL),('b',NULL)");let q=f.make();q.enqueue('a');q.enqueue('b');f.setFailure(Object.assign(Error('timeout'),{code:'ECONNABORTED'}));await q.run();assert.equal(f.calls.length,1);
 assert.equal(f.db.prepare("SELECT failures FROM metadata_jobs WHERE book_id='b'").get().failures,0);q=f.make();assert.equal((await q.run()).providerRetryAt,now+15*60*1000);assert.equal(f.calls.length,1);
});

test('repeated provider timeouts and rate limits remain deferred without exhausting a book',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a','<ComicInfo><Notes>CVDB1</Notes><Writer>Keep</Writer></ComicInfo>')");const q=f.make();q.requestCheck('a');
 for(const error of [Object.assign(Error('timeout'),{code:'ECONNABORTED'}),Object.assign(Error('limited'),{response:{status:429}}),Object.assign(Error('unavailable'),{response:{status:503}})]){
  f.setFailure(error);
  for(let n=0;n<4;n++){
   f.db.exec('UPDATE metadata_jobs SET due_at=0;UPDATE metadata_worker_state SET provider_retry_at=0');
   const result=await q.run(),job=f.db.prepare('SELECT * FROM metadata_jobs').get();
   assert.equal(result.deferred,1);assert.equal(result.failed,0);assert.equal(job.failures,0);assert.equal(job.attempts,0);assert.ok(job.due_at>now&&job.due_at<Number.MAX_SAFE_INTEGER);
  }
 }
 assert.match(f.db.prepare('SELECT comicinfo FROM scanned_books').get().comicinfo,/<Writer>Keep<\/Writer>/);
});

test('upgrade reopens retired image checks and exhausted network retries without reopening identity conflicts',t=>{
 const f=fixture(t),q=f.make();
 const errors=['IMAGE_LIMIT: pixels','IMAGE_INVALID: decode failed','IMAGE_DECODER_UNAVAILABLE: BMP','ECONNABORTED: timeout','IDENTITY_REVIEW_REQUIRED: choose issue','ARCHIVE_PRESERVATION_FAILED: changed pages'];
 errors.forEach((error,i)=>{f.db.prepare('INSERT INTO scanned_books VALUES(?,NULL)').run(String(i));q.enqueue(String(i));f.db.prepare('UPDATE metadata_jobs SET state=?,due_at=?,last_error=?,failures=3 WHERE book_id=?').run(i===3?'waiting':'review',Number.MAX_SAFE_INTEGER,error,String(i));});
 f.make();const jobs=f.db.prepare('SELECT * FROM metadata_jobs ORDER BY book_id').all();
 assert.deepEqual(jobs.map(j=>j.state),['queued','queued','queued','retry','review','review']);
 assert.ok(jobs.slice(0,4).every(j=>j.due_at<Number.MAX_SAFE_INTEGER&&j.failures===0));
 const changes=f.db.prepare('SELECT total_changes() n').get().n;f.make();assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
});

test('retired storage-size holds retry once while current file-shape holds remain',t=>{
 const f=fixture(t),q=f.make();f.db.exec("INSERT INTO scanned_books VALUES('old',NULL),('current',NULL)");q.enqueue('old');q.enqueue('current');
 f.db.prepare("UPDATE metadata_jobs SET state='review',due_at=?,last_error=? WHERE book_id='old'").run(Number.MAX_SAFE_INTEGER,'ARCHIVE_STORAGE_UNSAFE: Archive must be a bounded regular file with one link');
 f.db.prepare("UPDATE metadata_jobs SET state='review',due_at=?,last_error=? WHERE book_id='current'").run(Number.MAX_SAFE_INTEGER,'ARCHIVE_STORAGE_UNSAFE: Archive must be a regular file with one link');
 f.make();assert.equal(f.db.prepare("SELECT state FROM metadata_jobs WHERE book_id='old'").get().state,'queued');assert.equal(f.db.prepare("SELECT state FROM metadata_jobs WHERE book_id='current'").get().state,'review');
 const changes=f.db.prepare('SELECT total_changes() n FROM metadata_jobs').get().n;f.make();assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
});

test('seed queues required format conversion once even for an old complete or unidentified held book',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN filename TEXT;INSERT INTO scanned_books VALUES('old','<ComicInfo><Year>2000</Year><Month>1</Month><Writer>A</Writer><Notes>CVDB1</Notes></ComicInfo>','Old.cbr'),('held',NULL,'Unknown.zip')");
 const q=f.make();q.enqueue('held');f.db.prepare("UPDATE metadata_jobs SET kind='identification',state='review',due_at=?,last_error='Choose issue' WHERE book_id='held'").run(Number.MAX_SAFE_INTEGER);
 await q.seed();const rows=f.db.prepare('SELECT state,kind,due_at FROM metadata_jobs').all();assert.ok(rows.every(j=>j.state==='queued'&&j.kind==='normalization'&&j.due_at===now));
 f.db.exec("UPDATE metadata_jobs SET state='review',last_error='Conversion failed'");const changes=f.db.prepare('SELECT total_changes() n').get().n;await q.seed();assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
});

test('shared views filter and paginate live books with literal search and unidentified scope',t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN series_id TEXT;ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;ALTER TABLE scanned_books ADD COLUMN filename TEXT;CREATE TABLE scanned_series(id TEXT,library_id TEXT,name TEXT);INSERT INTO scanned_series VALUES('s','L','Series'),('other','Other','Other');INSERT INTO scanned_books(id,series_id,filename,cv_issue_id) VALUES('a','s','A 100%.cbz',NULL),('b','s','B.cbz','123'),('c','s','C.cbz',''),('d','other','D.cbz',NULL)");
 const q=f.make();for(const id of ['a','b','c','d'])q.enqueue(id);f.db.exec("UPDATE metadata_jobs SET state='review' WHERE book_id='a';UPDATE metadata_jobs SET state='retry' WHERE book_id='b'");
 assert.equal(q.status({libraryId:'L',unidentified:true,view:'all'}).total,2);
 const first=q.status({view:'all',libraryId:'L',limit:1});assert.equal(first.matched,3);assert.equal(first.books.length,1);assert.equal(q.status({view:'all',libraryId:'L',offset:1,limit:1}).books[0].id,'b');
 assert.equal(q.status({view:'all',search:'100%'}).matched,1);assert.equal(q.status({view:'review'}).books[0].id,'a');assert.equal(q.status({view:'deferred'}).books[0].id,'b');
});
test('explicit check requeues one stable book without bypassing recovery or provider cooldown',t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL),('b',NULL)");const q=f.make();q.enqueue('a');q.enqueue('b');f.db.exec("UPDATE metadata_jobs SET state='review',attempts=3;UPDATE metadata_worker_state SET provider_retry_at=9999999999999");
 q.requestCheck('a');assert.equal(f.db.prepare("SELECT state FROM metadata_jobs WHERE book_id='a'").get().state,'queued');assert.equal(f.db.prepare("SELECT state FROM metadata_jobs WHERE book_id='b'").get().state,'review');assert.equal(f.db.prepare('SELECT provider_retry_at FROM metadata_worker_state').get().provider_retry_at,9999999999999);
 f.setHeld(true);assert.throws(()=>q.requestCheck('b'),e=>e.code==='LIBRARY_RECOVERY_REQUIRED');f.setHeld(false);assert.throws(()=>q.requestCheck('missing'),e=>e.code==='BOOK_UNAVAILABLE');
});


test('single-book check targets the requested book rather than unrelated backlog and preserves cooldown',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL),('z',NULL)");const q=f.make();q.enqueue('a');q.requestCheck('z');
 const result=await q.run(1,{bookId:'z'});assert.equal(result.completed,1);assert.deepEqual(f.calls.map(c=>c.bookId),['z']);
 assert.equal(f.db.prepare("SELECT state FROM metadata_jobs WHERE book_id='a'").get().state,'queued');
 q.requestCheck('z');f.db.exec('UPDATE metadata_worker_state SET provider_retry_at=9999999999999');assert.ok((await q.run(1,{bookId:'z'})).providerRetryAt);assert.equal(f.calls.length,1);
});

test('manual check queued behind a busy worker receives priority on the next run',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL),('b',NULL),('z',NULL)");let release;const gate=new Promise(resolve=>release=resolve);const calls=[];
 const q=createMetadataMaintenance({db:f.db,now:()=>now,logger:{warn(){}},runtime:{status:()=>[],retag:async r=>{calls.push(r.bookId);if(r.bookId==='a')await gate;}}});
 q.enqueue('a');q.enqueue('b');q.enqueue('z');const active=q.run(1);q.requestCheck('z');assert.equal((await q.run(1,{bookId:'z'})).skipped,true);release();await active;await q.run(1);assert.deepEqual(calls,['a','z']);
});

test('scanner leaves older tagged books idle and migration retires historical backlog including previously checked jobs',async t=>{
 const f=fixture(t);const xml='<ComicInfo><Year>2000</Year><Month>1</Month><Writer>A</Writer><Notes>CVDB1</Notes></ComicInfo>';
 for(const id of ['old','backlog','manual','review','checked'])f.db.prepare('INSERT INTO scanned_books VALUES(?,?)').run(id,xml);
 const q=f.make();for(const id of ['old','backlog','manual','review','checked'])q.enqueue(id);
 assert.equal(f.db.prepare("SELECT state FROM metadata_jobs WHERE book_id='old'").get().state,'complete');
 f.db.exec("UPDATE metadata_jobs SET state='queued',due_at=0 WHERE book_id IN ('backlog','checked');UPDATE metadata_jobs SET checked_at=1 WHERE book_id='checked';UPDATE metadata_jobs SET state='review',last_error='Inspect identity' WHERE book_id='review'");q.requestCheck('manual');
 await q.seed();const rows=Object.fromEntries(f.db.prepare('SELECT * FROM metadata_jobs').all().map(j=>[j.book_id,j]));
 assert.equal(rows.backlog.state,'complete');assert.equal(rows.manual.state,'queued');assert.equal(rows.review.state,'review');assert.equal(rows.checked.state,'complete');
 const changes=f.db.prepare('SELECT total_changes() n').get().n;await q.seed();assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
});

test('queue setup is not due work and purpose counts respect the same library and identity scope',t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN series_id TEXT;ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;ALTER TABLE scanned_books ADD COLUMN filename TEXT;CREATE TABLE scanned_series(id TEXT,library_id TEXT,name TEXT);INSERT INTO scanned_series VALUES('s','L','Series'),('other','Other','Other');INSERT INTO scanned_books(id,series_id,filename,cv_issue_id) VALUES('a','s','A.cbz',NULL),('b','s','B.cbz','123'),('c','s','C.cbz',NULL),('d','other','D.cbz',NULL)");
 const q=f.make();for(const id of ['a','b','d'])q.enqueue(id);
 const view=q.status({libraryId:'L',unidentified:true,view:'due'});assert.equal(view.counts.unqueued,1);assert.equal(view.matched,1);assert.equal(view.total,2);assert.equal(view.dueByKind.identification,1);
 assert.equal(q.status({libraryId:'L',view:'unqueued'}).books[0].id,'c');
});

test('milestones perform four successful checks total and never daily checks',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;INSERT INTO scanned_books VALUES('a',NULL,'123')");let clock=Date.UTC(2026,6,1),calls=0;
 const q=createMetadataMaintenance({db:f.db,now:()=>clock,logger:{warn(){}},cachedIssue:()=>({store_date:'2026-07-01'}),runtime:{status:()=>[],retag:async()=>{calls++;return {publicationDate:'2026-07-01',publicationDateSource:'store_date',publicationDatePrecision:'day'};}}});
 q.enqueue('a','import',{initial:true});
 for(let d=0;d<=100;d++){clock=Date.UTC(2026,6,1)+d*day;await q.run();if([0,7,30,90].includes(d))assert.equal(f.db.prepare('SELECT checked_at FROM metadata_jobs').get().checked_at,clock);}
 assert.equal(calls,4);assert.equal(f.db.prepare('SELECT due_at FROM metadata_jobs').get().due_at,Number.MAX_SAFE_INTEGER);
});

test('late arrival skips elapsed milestones; delayed checks coalesce and final provider deferral survives day 90',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;INSERT INTO scanned_books VALUES('a',NULL,'123')");const released=Date.UTC(2026,6,1);let clock=released+60*day,calls=0,timeout=false;
 const q=createMetadataMaintenance({db:f.db,now:()=>clock,logger:{warn(){}},cachedIssue:()=>({store_date:'2026-07-01'}),runtime:{status:()=>[],retag:async()=>{calls++;if(timeout)throw Object.assign(Error('provider timeout'),{code:'ECONNABORTED'});return {publicationDate:'2026-07-01',publicationDateSource:'store_date',publicationDatePrecision:'day'};}}});
 q.enqueue('a','import',{initial:true});await q.run();assert.equal(f.db.prepare('SELECT due_at FROM metadata_jobs').get().due_at,released+90*day);assert.equal((await q.run()).checked,0);
 clock=released+90*day;timeout=true;await q.run();assert.equal(f.db.prepare('SELECT milestone FROM metadata_jobs').get().milestone,90);
 clock=released+92*day;timeout=false;await q.run();assert.equal(calls,3);assert.equal(f.db.prepare('SELECT due_at FROM metadata_jobs').get().due_at,Number.MAX_SAFE_INTEGER);
});

test('startup replaces daily timing with remaining milestones without replaying missed work',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;INSERT INTO scanned_books VALUES('a',NULL,'123')");const released=now-35*day;
 const date=new Date(released).toISOString().slice(0,10);const q=createMetadataMaintenance({db:f.db,now:()=>now,logger:{warn(){}},cachedIssue:()=>({store_date:date}),runtime:{status:()=>[],retag:async()=>({publicationDate:date,publicationDateSource:'store_date'})}});
 q.enqueue('a');f.db.prepare("UPDATE metadata_jobs SET policy_version=0,state='scheduled',attempts=12,checked_at=?,due_at=?").run(now-day,now);
 await q.seed();assert.equal(f.db.prepare('SELECT due_at FROM metadata_jobs').get().due_at,released+90*day);assert.equal((await q.run()).checked,0);
 // A genuinely missed milestone is one check, then the remaining day-90 milestone.
 f.db.prepare("UPDATE metadata_jobs SET last_success_at=?,due_at=?,milestone=7").run(released,released+7*day);
 assert.equal((await q.run()).completed,1);assert.equal((await q.run()).checked,0);assert.equal(f.db.prepare('SELECT milestone FROM metadata_jobs').get().milestone,90);
});

test('historical indexed books with missing or differently formatted fields are retired without provider or file work',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;ALTER TABLE scanned_books ADD COLUMN filename TEXT");
 for(let n=0;n<250;n++)f.db.prepare('INSERT INTO scanned_books VALUES(?,?,?,?)').run(String(n),n%2?'<ComicInfo><Year>2000</Year><Month>1</Month><Title>Keep</Title></ComicInfo>':'<ComicInfo><Year>2000</Year><Month>1</Month></ComicInfo>',String(100+n),n+'.cbz');
 const q=f.make();for(let n=0;n<250;n++){q.enqueue(String(n));f.db.prepare("UPDATE metadata_jobs SET kind='enrichment',state=?,due_at=0,policy_version=0,last_error=?,attempts=2,checked_at=1 WHERE book_id=?").run(n%3===0?'waiting':n%2?'retry':'queued',n%2?'ECONNABORTED: old timeout':null,String(n));}
 const before=f.db.prepare('SELECT * FROM scanned_books ORDER BY id').all();await q.seed();assert.equal(f.db.prepare("SELECT COUNT(*) n FROM metadata_jobs WHERE state='complete'").get().n,250);await q.run();assert.equal(f.calls.length,0);assert.deepEqual(f.db.prepare('SELECT * FROM scanned_books ORDER BY id').all(),before);
 const changes=f.db.prepare('SELECT total_changes() n').get().n;await q.seed();assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
});

test('a newly discovered old book still gets initial tagging once, without historical follow-ups',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;INSERT INTO scanned_books VALUES('a','<ComicInfo><Year>2000</Year><Month>1</Month></ComicInfo>','123')");const q=f.make();q.enqueue('a','scanner',{initial:true});assert.equal((await q.run()).completed,1);assert.equal(f.db.prepare('SELECT kind FROM metadata_jobs').get().kind,'idle');q.enqueue('a','scanner');await q.run();assert.equal(f.calls.length,1);
});

test('cached store date clears a never-checked cover-date hold without API calls or ComicInfo changes',async t=>{
 const f=fixture(t);const xml='<ComicInfo><Year>2026</Year><Month>12</Month><Notes>CVDB123</Notes></ComicInfo>';f.db.prepare('INSERT INTO scanned_books VALUES(?,?)').run('a',xml);
 const q=createMetadataMaintenance({db:f.db,now:()=>now,logger:{warn(){}},cachedIssue:id=>id==='123'?{store_date:'2026-10-01',cover_date:'2026-12-01'}:null,runtime:{status:()=>[],retag:async()=>f.calls.push(1)}});
 q.enqueue('a');f.db.prepare("UPDATE metadata_jobs SET state='review',due_at=?,last_error='Publication date is more than 31 days in the future',policy_version=0").run(Number.MAX_SAFE_INTEGER);
 await q.seed();const j=f.db.prepare('SELECT * FROM metadata_jobs').get();assert.equal(j.kind,'recent');assert.equal(j.state,'queued');assert.equal(j.publication_date,'2026-10-01');assert.equal(j.date_basis,'store_date');assert.equal(j.last_error,null);assert.equal(f.calls.length,0);assert.equal(f.db.prepare('SELECT comicinfo FROM scanned_books').get().comicinfo,xml);
});

test('uncached near-future cover month permits one store-date lookup instead of a false intervention hold',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a','<ComicInfo><Year>2026</Year><Month>12</Month><Notes>CVDB123</Notes></ComicInfo>')");
 const q=createMetadataMaintenance({db:f.db,now:()=>now,logger:{warn(){}},runtime:{status:()=>[],lookupIssue:async()=>({id:'123',store_date:'2026-10-01'}),retag:async()=>({publicationDate:'2026-10-01',publicationDateSource:'store_date',publicationDatePrecision:'day'})}});
 await q.seed();assert.equal(f.db.prepare('SELECT kind FROM metadata_jobs').get().kind,'date_check');await q.run();const j=f.db.prepare('SELECT * FROM metadata_jobs').get();assert.equal(j.kind,'recent');assert.equal(j.due_at,Date.UTC(2026,9,31));assert.equal(j.milestone,30);
});

test('headline populations count recent releases independently of queue state and exclude provider delays from intervention',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN series_id TEXT;ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;ALTER TABLE scanned_books ADD COLUMN filename TEXT;CREATE TABLE scanned_series(id TEXT,library_id TEXT,name TEXT);INSERT INTO scanned_series VALUES('s','L','Series')");
 for(const id of ['due','future','retry','decision','old','unknown'])f.db.prepare('INSERT INTO scanned_books(id,series_id,cv_issue_id,filename) VALUES(?,?,?,?)').run(id,'s',id==='unknown'?null:'123',id+'.cbz');
 const q=f.make();for(const id of ['due','future','retry','decision','old','unknown'])q.enqueue(id);
 f.db.exec("UPDATE metadata_jobs SET publication_date='2026-10-01',date_basis='store_date' WHERE book_id IN ('due','future','retry','decision');UPDATE metadata_jobs SET state='review',checked_at=1 WHERE book_id='decision';UPDATE metadata_jobs SET state='retry',checked_at=1 WHERE book_id='retry';UPDATE metadata_jobs SET state='scheduled',due_at=9999999999999 WHERE book_id='future'");
 const s=q.status({view:'recent'});assert.equal(s.categories.recent,4);assert.equal(s.matched,4);assert.equal(s.categories.unidentified,1);assert.equal(s.categories.intervention,1);assert.equal(q.status({view:'intervention'}).books[0].id,'decision');assert.equal(q.status({view:'unidentified'}).books[0].id,'unknown');
});


test('tagging before a known store release does not add another check on release day',t=>{
 const {planSchedule}=require('./maintenancePolicy'),release=Date.UTC(2026,9,20);
 const next=planSchedule({cv_issue_id:'123'}, {last_success_at:now},now,{store_date:'2026-10-20'});
 assert.equal(next.due_at,release+7*day);assert.equal(next.milestone,7);
});


test('unknown-date discovery retires historical books before archive work and retains recent milestones',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;INSERT INTO scanned_books VALUES('old',NULL,'1'),('recent',NULL,'2'),('future',NULL,'3')");
 const dates={'1':'2000-01-01','2':'2026-10-01','3':'2026-11-01'},lookups=[],retags=[];
 const q=createMetadataMaintenance({db:f.db,now:()=>now,logger:{warn(){}},runtime:{status:()=>[],lookupIssue:async id=>{lookups.push(id);return {id,store_date:dates[id]};},retag:async r=>{retags.push(r);return {publicationDate:r.freshIssue.store_date,publicationDateSource:'store_date',publicationDatePrecision:'day'};}}});
 await q.seed();assert.equal((await q.run()).completed,3);assert.equal(lookups.length,3);assert.deepEqual(retags.map(r=>r.bookId),['recent']);
 const jobs=Object.fromEntries(f.db.prepare('SELECT * FROM metadata_jobs').all().map(j=>[j.book_id,j]));assert.equal(jobs.old.kind,'idle');assert.equal(jobs.old.due_at,Number.MAX_SAFE_INTEGER);assert.equal(jobs.recent.milestone,30);assert.equal(jobs.future.kind,'upcoming');
 await q.run();assert.equal(lookups.length,3);const changes=f.db.prepare('SELECT total_changes() n').get().n;await q.seed();assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
});

test('identified books remaining undated are provisionally refreshed only monthly, across restart',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;INSERT INTO scanned_books VALUES('a',NULL,'123')");let clock=now,lookups=0,retags=0;
 const make=()=>createMetadataMaintenance({db:f.db,now:()=>clock,logger:{warn(){}},runtime:{status:()=>[],lookupIssue:async()=>{lookups++;return {id:'123'};},retag:async()=>{retags++;return {};}}});
 let q=make();await q.seed();await q.run();assert.equal(retags,1);assert.equal(f.db.prepare('SELECT due_at FROM metadata_jobs').get().due_at,now+30*day);
 for(let d=1;d<=90;d++){clock=now+d*day;if(d===15){q=make();await q.seed();}await q.run();}assert.equal(retags,4);assert.equal(lookups,4);
});

test('unknown-date discovery respects shared provider cooldown and leaves archives untouched on timeout',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;INSERT INTO scanned_books VALUES('a',NULL,'123'),('b',NULL,'124')");let calls=0;
 const q=createMetadataMaintenance({db:f.db,now:()=>now,logger:{warn(){}},runtime:{status:()=>[],lookupIssue:async()=>{calls++;throw Object.assign(Error('timeout'),{code:'ECONNABORTED'});},retag:async()=>assert.fail('must not write')}});
 await q.seed();assert.equal((await q.run()).deferred,1);await q.run();assert.equal(calls,1);assert.equal(f.db.prepare("SELECT attempts FROM metadata_jobs WHERE book_id='a'").get().attempts,0);
});

test('date coverage splits identified and unidentified unknown dates; due purposes exclude delayed rows',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN series_id TEXT;ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;ALTER TABLE scanned_books ADD COLUMN filename TEXT;CREATE TABLE scanned_series(id TEXT,library_id TEXT,name TEXT);INSERT INTO scanned_series VALUES('s','L','Series');INSERT INTO scanned_books(id,series_id,filename,cv_issue_id) VALUES('a','s','A.cbz',NULL),('b','s','B.cbz','123'),('c','s','C.cbz','124')");
 const q=f.make();await q.seed();f.db.exec("UPDATE metadata_jobs SET state='retry',due_at=0 WHERE book_id='c'");
 const result=q.status({view:'unknown',libraryId:'L'});assert.equal(result.matched,2);assert.equal(result.categories.unknownDates,3);assert.equal(result.categories.unknownDatesWithId,2);assert.equal(result.categories.unknownDatesWithoutId,1);assert.equal(result.counts.due,2);assert.equal(Object.values(result.dueByKind).reduce((a,b)=>a+b,0),2);
 assert.equal(q.status({view:'unknown',unidentified:true}).matched,0);
});


test('active runtime work accepts a priority request without reporting an interruption',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL)");let active=true;
 const q=createMetadataMaintenance({db:f.db,now:()=>now,logger:{warn(){}},runtime:{status:()=>active?[{active:true,bookId:'other'}]:[],retag:async()=>{}}});
 q.enqueue('a');q.requestCheck('a');assert.equal((await q.run()).skipped,true);assert.ok(f.db.prepare('SELECT manual_requested_at FROM metadata_jobs').get().manual_requested_at);
 active=false;assert.equal((await q.run()).completed,1);
});


test('batch progress survives refresh and completed results survive restart and empty polls',async t=>{
 const f=fixture(t);f.db.exec("ALTER TABLE scanned_books ADD COLUMN series_id TEXT;ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT;ALTER TABLE scanned_books ADD COLUMN filename TEXT;CREATE TABLE scanned_series(id TEXT,library_id TEXT,name TEXT);INSERT INTO scanned_series VALUES('s','L','Series');INSERT INTO scanned_books(id,series_id,filename) VALUES('a','s','A.cbz')");
 let finish;const wait=new Promise(r=>finish=r);const q=createMetadataMaintenance({db:f.db,now:()=>now,logger:{warn(){}},runtime:{status:()=>[],retag:async()=>wait}});
 q.enqueue('a');const running=q.run();let b=q.status({view:'all'}).batch;assert.equal(b.state,'running');assert.equal(b.selected,1);assert.equal(b.examined,0);
 finish();await running;b=q.status({view:'all'}).batch;assert.equal(b.state,'finished');assert.equal(b.result.checked,1);assert.equal(b.finishedAt,now);
 const restarted=f.make();assert.deepEqual(restarted.status({view:'all'}).batch,b);await restarted.run();assert.deepEqual(restarted.status({view:'all'}).batch,b);
});

test('provider-deferred batches do not claim normal completion and stale running records are interrupted',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL)");const q=f.make();q.enqueue('a');f.setFailure(Object.assign(Error('timeout'),{code:'ECONNABORTED'}));await q.run();
 let b=JSON.parse(f.db.prepare('SELECT record FROM metadata_last_batch').get().record);assert.equal(b.state,'deferred');assert.equal(b.result.deferred,1);
 f.db.prepare('UPDATE metadata_last_batch SET record=?').run(JSON.stringify({...b,state:'running',finishedAt:null}));f.make();b=JSON.parse(f.db.prepare('SELECT record FROM metadata_last_batch').get().record);assert.equal(b.state,'interrupted');assert.equal(b.finishedAt,null);
});


test('overnight gate excludes routine daytime work but permits arrivals, manual checks and explicit batches',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('routine',NULL),('arrival',NULL),('manual',NULL)");
 const q=createMetadataMaintenance({db:f.db,runtime:{status:()=>[],retag:async r=>f.calls.push(r)},now:()=>now,logger:{warn(){}},executionWindow:()=>({open:false})});
 q.enqueue('arrival','scanner',{initial:true});await q.seed();q.requestCheck('manual');
 await q.run();assert.deepEqual(f.calls.map(r=>r.bookId).sort(),['arrival','manual']);
 await q.run(25,{force:true});assert.equal(f.calls.at(-1).bookId,'routine');
});
test('night work stops between books, persists pause and resumes with cumulative summary',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL),('b',NULL)");let open=true;
 const make=()=>createMetadataMaintenance({db:f.db,runtime:{status:()=>[],retag:async r=>{f.calls.push(r);open=false;}},now:()=>now,logger:{warn(){}},executionWindow:()=>({open,nightKey:'2026-10-12'})});
 let q=make();await q.seed();await q.run();assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.db.prepare('SELECT record FROM metadata_last_batch').get().record).state,'waiting');assert.equal(JSON.parse(f.db.prepare('SELECT record FROM metadata_night_summary').get().record).checked,1);
 q.setPaused(true);q=make();open=true;await q.run();assert.equal(f.calls.length,1);assert.equal(f.db.prepare('SELECT paused FROM metadata_maintenance_control').get().paused,1);
 q.setPaused(false);await q.run();assert.equal(f.calls.length,2);assert.equal(JSON.parse(f.db.prepare('SELECT record FROM metadata_night_summary').get().record).checked,2);
});
test('provider budget resumes at its actual reset time',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO scanned_books VALUES('a',NULL)");const q=f.make();q.enqueue('a');
 f.setFailure(Object.assign(Error('budget'),{code:'CV_RATE_LIMIT',retryAt:now+123456}));await q.run();assert.equal(f.db.prepare('SELECT provider_retry_at FROM metadata_worker_state').get().provider_retry_at,now+123456);
});

test('Claude-chosen annual matches are labelled on the job and cleared by a later explicit tag',async t=>{
 const f=fixture(t);f.db.prepare('INSERT INTO scanned_books VALUES(?,?)').run('annual',null);
 const runtime={status:()=>[],retag:async()=>({identifiedBy:'ai',identificationNote:"AI match: Hulk / Sub-Mariner '98 #1 — crossover"})};
 const q=createMetadataMaintenance({db:f.db,runtime,now:()=>now,logger:{warn(){}}});q.enqueue('annual','scanner');
 const result=await q.run();assert.equal(result.completed,1);assert.equal(result.aiMatched,1);
 assert.match(f.db.prepare("SELECT match_note FROM metadata_jobs WHERE book_id='annual'").get().match_note,/Sub-Mariner/);
 q.recordManualSuccess('annual',{});assert.equal(f.db.prepare("SELECT match_note FROM metadata_jobs WHERE book_id='annual'").get().match_note,null);
});
