'use strict';
const {dateInfo,issueId,planSchedule,DAY,IDLE,POLICY_VERSION}=require('./maintenancePolicy');
function createMetadataMaintenance({db,runtime,logger,now=Date.now,libraryForBook=()=>'',cachedIssue=()=>null,executionWindow=()=>({open:true}),withTask=(_context,action)=>action(),betweenBooks=async()=>{}}){
  db.exec(`CREATE TABLE IF NOT EXISTS metadata_jobs(book_id TEXT PRIMARY KEY,arrival TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',due_at INTEGER NOT NULL,last_error TEXT,checked_at INTEGER,observed_signature TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS metadata_queue_groups(group_key TEXT PRIMARY KEY,last_served INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS metadata_worker_state(id INTEGER PRIMARY KEY CHECK(id=1),provider_retry_at INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO metadata_worker_state VALUES(1,0)`);
  const columns=new Set(db.prepare('PRAGMA table_info(metadata_jobs)').all().map(c=>c.name));
  for(const [name,type] of Object.entries({observed_signature:"TEXT NOT NULL DEFAULT ''",first_seen:'INTEGER',attempts:'INTEGER NOT NULL DEFAULT 0',failures:'INTEGER NOT NULL DEFAULT 0',publication_date:'TEXT',date_basis:'TEXT',date_precision:'TEXT',group_key:"TEXT NOT NULL DEFAULT ''",kind:"TEXT NOT NULL DEFAULT 'enrichment'",manual_requested_at:"INTEGER",last_success_at:"INTEGER",initial_pending:"INTEGER NOT NULL DEFAULT 0",milestone:"INTEGER",policy_version:"INTEGER NOT NULL DEFAULT 0",match_note:"TEXT",last_result:"TEXT"})){
    if(!columns.has(name))db.exec(`ALTER TABLE metadata_jobs ADD COLUMN ${name} ${type}`);
  }
  db.prepare('UPDATE metadata_jobs SET first_seen=? WHERE first_seen IS NULL').run(now());
  // Upgrade prior monthly review retries without reopening unresolved matches.
  db.prepare("UPDATE metadata_jobs SET due_at=? WHERE state='review' AND due_at<>?").run(IDLE,IDLE);
  // Reopen only holds caused by the retired image decoder. Identity/archive
  // conflicts and interrupted publication still require their existing review.
  db.prepare(`UPDATE metadata_jobs SET state='queued',due_at=?,last_error=NULL,failures=0
    WHERE state IN ('review','waiting','retry') AND (last_error LIKE 'IMAGE_LIMIT:%'
      OR last_error LIKE 'IMAGE_DECODER_UNAVAILABLE:%' OR last_error LIKE 'IMAGE_INVALID:%')`).run(now());
  // The old storage message conflated the retired size cap with file shape.
  // Retry through current checks; links/special files still fail distinctly.
  db.prepare(`UPDATE metadata_jobs SET state='queued',due_at=?,last_error=NULL,failures=0
    WHERE state IN ('review','waiting','retry') AND last_error LIKE
    'ARCHIVE_STORAGE_UNSAFE: Archive must be a bounded regular file with one link%'`).run(now());
  db.prepare(`UPDATE metadata_jobs SET state='retry',due_at=?,failures=0
    WHERE state='waiting' AND (last_error LIKE 'ECONNABORTED:%' OR last_error LIKE 'ETIMEDOUT:%'
      OR last_error LIKE 'ECONNRESET:%' OR last_error LIKE 'ECONNREFUSED:%'
      OR last_error LIKE 'ENOTFOUND:%' OR last_error LIKE 'EAI_AGAIN:%')`).run(now()+15*60*1000);
  // One-time reopenings after matcher/merge changes. Each key runs once.
  db.exec('CREATE TABLE IF NOT EXISTS metadata_upgrades(key TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)');
  const upgradeOnce=(key,sql)=>{if(db.prepare('SELECT 1 FROM metadata_upgrades WHERE key=?').get(key))return;db.prepare(sql).run(now());db.prepare('INSERT INTO metadata_upgrades VALUES(?,?)').run(key,now());};
  // 2026-10-13: Comic Vine became the sole metadata authority, number padding
  // stopped counting as a conflict, and the matcher learned dated releases,
  // more scan-group tags and split Comic Vine volumes. Re-check held books
  // (routine overnight pacing applies; duplicates deleted since are skipped).
  upgradeOnce('2026-10-13-cv-authority',`UPDATE metadata_jobs SET state='queued',due_at=?,last_error=NULL,failures=0
    WHERE state='review' AND (last_error LIKE 'IDENTITY_REVIEW_REQUIRED%' OR last_error LIKE 'METADATA_REVIEW_REQUIRED%' OR last_error LIKE 'DESTINATION_OCCUPIED%')`);
  // 2026-10-14: the matcher learned one-shots, underscore names, bracketed
  // dates, '&' in group tags, mid-title volume markers, story labels, folder
  // titles a filename abbreviates, sale-year cover dates and a name-filter
  // lookup for split Comic Vine volumes. Re-check identity holds once.
  upgradeOnce('2026-10-14-matcher-review-list',`UPDATE metadata_jobs SET state='queued',due_at=?,last_error=NULL,failures=0
    WHERE state='review' AND last_error LIKE 'IDENTITY_REVIEW_REQUIRED%' AND last_error NOT LIKE '%Duplicate copy%'`);
  db.exec('CREATE INDEX IF NOT EXISTS metadata_jobs_due ON metadata_jobs(due_at,group_key,kind)');
  db.exec("CREATE TABLE IF NOT EXISTS metadata_last_batch(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS metadata_maintenance_control(id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO metadata_maintenance_control VALUES(1,0); CREATE TABLE IF NOT EXISTS metadata_night_summary(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL)");
  const isPaused=()=>!!db.prepare('SELECT paused FROM metadata_maintenance_control WHERE id=1').get().paused;
  const nightRead=db.prepare('SELECT record FROM metadata_night_summary WHERE id=1');
  const nightSave=db.prepare('INSERT INTO metadata_night_summary VALUES(1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record');
  const readBatch=db.prepare('SELECT record FROM metadata_last_batch WHERE id=1');
  const saveBatch=db.prepare('INSERT INTO metadata_last_batch VALUES(1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record');
  let lastBatch=JSON.parse(readBatch.get()?.record||'null');
  if(lastBatch?.state==='running'){lastBatch={...lastBatch,state:'interrupted',finishedAt:null};saveBatch.run(JSON.stringify(lastBatch));}
  let running=false, runningBookId=null,activeBatch=null;
  const signature=book=>JSON.stringify([book?.path||'',book?.file_mtime??null,book?.file_size??null]);
  const readJob=db.prepare('SELECT * FROM metadata_jobs WHERE book_id=?');
  const readBook=db.prepare('SELECT * FROM scanned_books WHERE id=?');
  function schedule(book,job={}){return planSchedule(book,job,now(),cachedIssue(issueId(book))||{});}
  const writeSchedule=db.prepare(`UPDATE metadata_jobs SET state=?,due_at=?,kind=?,publication_date=?,date_basis=?,date_precision=?,milestone=?,policy_version=?,last_error=?,last_success_at=?,initial_pending=? WHERE book_id=?`);
  function saveSchedule(book,job,s){
    writeSchedule.run(s.state,s.due_at,s.kind,s.publication_date,s.date_basis,s.date_precision,s.milestone,POLICY_VERSION,s.reason||null,job.last_success_at||null,job.initial_pending||0,book.id);
  }
  function enqueue(bookId,arrival='scanner',{initial=false}={}){
    const book=readBook.get(bookId);if(!book)return;
    const old=readJob.get(bookId),group=String(libraryForBook(book)||'');
    if(old&&old.observed_signature===signature(book))return;
    const job={initial_pending:initial?1:0,attempts:0};
    const next=schedule(book,job);
    db.prepare(`INSERT INTO metadata_jobs(book_id,arrival,due_at,observed_signature,first_seen,group_key) VALUES(?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET
      observed_signature=excluded.observed_signature,attempts=0,failures=0,group_key=excluded.group_key,checked_at=NULL,manual_requested_at=NULL`)
      .run(bookId,arrival,next.due_at,signature(book),now(),group);
    saveSchedule(book,job,next);
  }
  async function seed(){
    const page=db.prepare('SELECT b.* FROM scanned_books b WHERE b.id>? ORDER BY b.id LIMIT 100');
    let last='';
    for(;;){
      const books=page.all(last);if(!books.length)return;
      const changes=[];
      for(const book of books){
        const old=readJob.get(book.id),group=String(libraryForBook(book)||'');
        const job={...old};
        // A previous successful check counts toward elapsed milestones. Failed
        // provider attempts do not advance the schedule.
        if(old&&old.policy_version!==POLICY_VERSION&&!old.last_success_at&&old.attempts>0&&!old.last_error&&['scheduled','complete'].includes(old.state))job.last_success_at=old.checked_at;
        const next=schedule(book,job);
        const obsoleteDateHold=old?.last_error==='Publication date is more than 31 days in the future';
        const needsConversion=old&&next.kind==='normalization'&&old.kind!=='normalization';
        const preserve=old&&!obsoleteDateHold&&!needsConversion&&(old.manual_requested_at || old.state==='review' || (old.state==='waiting'&&next.kind!=='idle'));
        const deferred=old&&!obsoleteDateHold&&['source','retry','budget'].includes(old.state)&&next.kind!=='idle';
        if(preserve){next.state=old.state;next.due_at=old.due_at;next.reason=old.last_error;}
        else if(deferred){next.state=old.state==='source'?'review':old.state;next.due_at=old.state==='source'?IDLE:old.due_at;next.reason=old.last_error;}
        // Don't move an untouched due row forward on every restart.
        else if(old?.policy_version===POLICY_VERSION&&old.kind===next.kind&&old.state==='queued'&&next.state==='queued')next.due_at=old.due_at;
        const scheduleChanged=!old||old.policy_version!==POLICY_VERSION||old.last_success_at!==(job.last_success_at||null)||
          ['state','due_at','kind','publication_date','date_basis','date_precision','milestone'].some(key=>old[key]!==next[key])||old.last_error!==(next.reason||null);
        if(scheduleChanged||old.group_key!==group)changes.push({book,job,old,next,group,scheduleChanged});
      }
      if(changes.length){
        db.exec('BEGIN IMMEDIATE');
        try{for(const {book,job,old,next,group,scheduleChanged} of changes){
          if(!old)db.prepare('INSERT INTO metadata_jobs(book_id,arrival,due_at,observed_signature,first_seen,group_key) VALUES(?,?,?,?,?,?)').run(book.id,'scanner',next.due_at,signature(book),now(),group);
          else if(old.group_key!==group)db.prepare('UPDATE metadata_jobs SET group_key=? WHERE book_id=?').run(group,book.id);
          if(scheduleChanged)saveSchedule(book,job,next);
        }db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
      }
      last=books.at(-1).id;await new Promise(resolve=>setImmediate(resolve));
    }
  }
  async function run(limit=25,{bookId=null,force=false}={}){
    if(runtime.isDraining?.())return {skipped:true,draining:true};
    if(running)return {skipped:true};running=true;let batchError=false;const result={checked:0,completed:0,review:0,failed:0,deferred:0};
    try{
      const operations=runtime.status();
      if(operations.some(op=>!op.active))return {...result,held:true};
      if(operations.length)return {...result,skipped:true};
      const retryAt=db.prepare('SELECT provider_retry_at FROM metadata_worker_state WHERE id=1').get().provider_retry_at;
      if(retryAt>now())return {...result,providerRetryAt:retryAt};
      const window=executionWindow(now()),routineAllowed=force||(window.open&&!isPaused());
      const jobs=db.prepare(`WITH due AS (SELECT j.*,ROW_NUMBER() OVER(PARTITION BY j.group_key,j.kind ORDER BY (j.manual_requested_at IS NOT NULL) DESC,j.manual_requested_at,j.due_at,j.book_id) AS slot
        FROM metadata_jobs j JOIN scanned_books b ON b.id=j.book_id WHERE j.due_at<=? AND (? IS NULL OR j.book_id=?) AND (? OR j.initial_pending=1 OR j.manual_requested_at IS NOT NULL))
        SELECT d.* FROM due d LEFT JOIN metadata_queue_groups g ON g.group_key=d.group_key||':'||d.kind
        ORDER BY (d.manual_requested_at IS NOT NULL) DESC,d.manual_requested_at,d.slot,COALESCE(g.last_served,0),d.due_at,d.book_id LIMIT ?`).all(now(),bookId,bookId,routineAllowed?1:0,Math.max(1,Math.min(100,limit)));
      if(jobs.length){
        activeBatch={state:'running',startedAt:now(),finishedAt:null,selected:jobs.length,examined:0,scope:bookId?'single':force?'batch':window.open?'overnight':'arrivals',nightKey:!force&&!bookId&&window.open?(window.nightKey||null):null,result};
        saveBatch.run(JSON.stringify(activeBatch));
      }
      for(const job of jobs){
        if(runtime.status().length||runtime.isDraining?.())break;
        const routine=!job.initial_pending&&!job.manual_requested_at;
        if(routine&&!force&&(!executionWindow(now()).open||isPaused()))continue;
        let attempted=false;
        try{
          runningBookId=job.book_id;
          const current=readBook.get(job.book_id);
          if(!current)continue;
          const eligibility=schedule(current,job);
          if(!job.manual_requested_at&&(eligibility.kind==='idle'||eligibility.due_at>now())){
            saveSchedule(current,job,eligibility);continue;
          }
          attempted=true;
          let freshIssue=null;
          if(!job.manual_requested_at&&['date_discovery','date_check'].includes(eligibility.kind)){
            // Discover the date before touching the archive. A historical date
            // retires this job without rewriting an older identified book.
            freshIssue=await withTask({routine},()=>runtime.lookupIssue(issueId(current)));
            const discovered=planSchedule(current,job,now(),freshIssue);
            if(discovered.kind==='idle'||discovered.due_at>now()){
              saveSchedule(current,job,discovered);
              db.prepare('UPDATE metadata_jobs SET checked_at=?,attempts=attempts+1,failures=0 WHERE book_id=?').run(now(),job.book_id);
              result.completed++;continue;
            }
          }
          const outcome=await withTask({routine},()=>runtime.retag({bookId:job.book_id,arrival:job.arrival,preserveFilename:true,...(freshIssue?{freshIssue}:{})}));
          const book=db.prepare('SELECT * FROM scanned_books WHERE id=?').get(job.book_id);if(!book)continue;
          const date=outcome?.publicationDate?{publication_date:outcome.publicationDate,date_basis:outcome.publicationDateSource,date_precision:outcome.publicationDatePrecision}:{};
          const next={...job,...date,attempts:job.attempts+1,last_success_at:now(),initial_pending:0},s=schedule(book,next);
          saveSchedule(book,next,s);
          db.prepare('UPDATE metadata_jobs SET checked_at=?,observed_signature=?,attempts=?,failures=0,last_result=? WHERE book_id=?').run(now(),signature(book),next.attempts,resultSummary(outcome),book.id);
          // Claude-chosen annual matches stay labelled for spot-checking.
          if(outcome?.identificationNote){db.prepare('UPDATE metadata_jobs SET match_note=? WHERE book_id=?').run(String(outcome.identificationNote).slice(0,500),book.id);result.aiMatched=(result.aiMatched||0)+1;}
          result.completed++;
        }catch(error){
          if(error.code==='DEPLOYMENT_PAUSED'){attempted=false;break;}
          if(error.convertedToCbz){
            const converted=db.prepare('SELECT * FROM scanned_books WHERE id=?').get(job.book_id);
            if(converted)db.prepare('UPDATE metadata_jobs SET observed_signature=?,kind=? WHERE book_id=?').run(signature(converted),schedule(converted,job).kind,job.book_id);
            error.message='Converted to CBZ; metadata pending. '+error.message;
          }
          const httpStatus=Number(error.response?.status);
          const budget=error.code==='CV_RATE_LIMIT'||httpStatus===429,source=error.code==='CV_NO_DATA';
          const providerUnavailable=/^(ECONNABORTED|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/.test(error.code||'')||(httpStatus>=500&&httpStatus<=599);
          const providerRetryAt=budget&&Number.isFinite(error.retryAt)&&error.retryAt>now()?error.retryAt:now()+(budget?3600000:15*60*1000);
          if(budget||providerUnavailable)db.prepare('UPDATE metadata_worker_state SET provider_retry_at=? WHERE id=1').run(providerRetryAt);
          if(budget||providerUnavailable){
            // Provider availability is not a book failure. Leave metadata and
            // the book's attempt/failure budget intact, then stop this batch.
            db.prepare('UPDATE metadata_jobs SET state=?,checked_at=?,due_at=?,last_error=? WHERE book_id=?')
              .run(budget?'budget':'retry',now(),providerRetryAt,`${error.code||'HTTP_'+httpStatus}: ${error.message}`.slice(0,1000),job.book_id);
            result.deferred++;
            logger.info?.('metadata',budget?'Metadata check deferred for provider budget':'Metadata check deferred; provider unavailable',{bookId:job.book_id,retryAt:providerRetryAt});
            break;
          }
          // A check you asked for that fails goes straight to Manual intervention,
          // unless the file merely changed during the check (worth one quiet retry).
          const manualFailure=!!job.manual_requested_at&&!budget&&!/BOOK_CHANGED_RETRY|ARCHIVE_FACTS_CHANGED|STALE_/.test(error.code||'');
          const review=source||manualFailure||/REVIEW|MISMATCH|OCCUPIED|UNSUPPORTED|UNSAFE|INVALID|LIMIT|AMBIGUOUS|DAMAGED|BOOK_UNAVAILABLE|ENOENT/.test(error.code||'')&&!budget;
          const failures=job.failures+1,attempts=job.attempts+(source?1:0);
          const stopped=review||failures>=3;
          const state=review?'review':stopped?'waiting':'retry';
          db.prepare('UPDATE metadata_jobs SET state=?,checked_at=?,due_at=?,last_error=?,attempts=?,failures=?,last_result=? WHERE book_id=?')
            .run(state,now(),stopped?IDLE:now()+3600000,`${error.code||'ERROR'}: ${error.message}`.slice(0,1000),attempts,failures,
              JSON.stringify({status:'failed',code:error.code||null,series:error.matched?.series||null,number:error.matched?.number??null,cvIssueId:error.matched?.cvIssueId||null}),job.book_id);
          result[review?'review':'failed']++;logger.warn('metadata',error.message,{bookId:job.book_id,operationId:error.operationId});
          if(budget||providerUnavailable||runtime.status().length)break;
        }finally{
          runningBookId=null;
          if(activeBatch)activeBatch.examined++;
          if(attempted)db.prepare("UPDATE metadata_jobs SET manual_requested_at=NULL WHERE book_id=? AND state NOT IN ('retry','budget')").run(job.book_id);
          db.prepare('INSERT INTO metadata_queue_groups VALUES(?,?) ON CONFLICT(group_key) DO UPDATE SET last_served=excluded.last_served').run(job.group_key+':'+job.kind,now());if(attempted){result.checked++;await betweenBooks();}
        }
      }
      return result;
    }catch(error){batchError=true;throw error;}
    finally{
      try{if(activeBatch){
        const state=batchError?'failed':runtime.status().some(op=>!op.active)?'recovery':runtime.isDraining?.()?'paused':result.deferred?'deferred':!force&&!bookId&&activeBatch.examined<activeBatch.selected?'waiting':'finished';
        lastBatch={...activeBatch,state,finishedAt:now(),result:{...result}};
        if(activeBatch.nightKey){
          const saved=JSON.parse(nightRead.get()?.record||'null');
          const summary=saved?.nightKey===activeBatch.nightKey?saved:{nightKey:activeBatch.nightKey,checked:0,completed:0,review:0,failed:0,deferred:0};
          for(const key of ['checked','completed','review','failed','deferred'])summary[key]+=result[key];
          summary.updatedAt=now();nightSave.run(JSON.stringify(summary));
        }
        activeBatch=null;saveBatch.run(JSON.stringify(lastBatch));
      }
      }finally{running=false;runningBookId=null;}
    }
  }
  // Plain facts about the latest check (success or failure), shown to the person who asked for it.
  const resultSummary=outcome=>outcome?JSON.stringify({status:outcome.status||null,series:outcome.series||null,number:outcome.issueNumber??null,
    cvIssueId:outcome.cvIssueId||null,identifiedBy:outcome.identifiedBy||null,converted:!!outcome.convertedToCbz,renamedTo:outcome.renamedTo||null}):null;
  function recordSuccess(bookId,outcome,arrival='scanner'){
    const book=db.prepare('SELECT * FROM scanned_books WHERE id=?').get(bookId);if(!book)return;
    enqueue(bookId,arrival);
    const date={publication_date:outcome.publicationDate||null,date_basis:outcome.publicationDateSource||null,date_precision:outcome.publicationDatePrecision||null};
    const next={...date,attempts:1,last_success_at:now(),initial_pending:0},s=schedule(book,next);
    saveSchedule(book,next,s);
    db.prepare('UPDATE metadata_jobs SET checked_at=?,attempts=1,failures=0,observed_signature=?,manual_requested_at=NULL,match_note=NULL,last_result=? WHERE book_id=?').run(now(),signature(book),resultSummary(outcome),bookId);
  }
  function requestCheck(bookId){
    if(runtime.status().some(op=>!op.active))throw Object.assign(new Error('Recover interrupted metadata work before queuing another check'),{code:'LIBRARY_RECOVERY_REQUIRED'});
    if(!db.prepare('SELECT id FROM scanned_books WHERE id=?').get(bookId))throw Object.assign(new Error('Book no longer exists'),{code:'BOOK_UNAVAILABLE'});
    enqueue(bookId,'manual');
    const previousCheckedAt=db.prepare('SELECT checked_at FROM metadata_jobs WHERE book_id=?').get(bookId).checked_at;
    const requestedAt=now();
    db.prepare("UPDATE metadata_jobs SET state='queued',due_at=?,last_error=NULL,attempts=0,failures=0,manual_requested_at=? WHERE book_id=?").run(requestedAt,requestedAt,bookId);
    return {queued:true,requestedAt,previousCheckedAt,providerRetryAt:db.prepare('SELECT provider_retry_at FROM metadata_worker_state WHERE id=1').get().provider_retry_at};
  }
  function status({libraryId=null,offset=0,limit=50,view='attention',search='',unidentified=false,track=''}={}){
    const params=[],clauses=[];
    if(libraryId){clauses.push('s.library_id=?');params.push(String(libraryId));}
    if(unidentified)clauses.push("(b.cv_issue_id IS NULL OR b.cv_issue_id='')");
    const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
    const base=`FROM scanned_books b JOIN scanned_series s ON s.id=b.series_id LEFT JOIN metadata_jobs j ON j.book_id=b.id ${where}`;
    const lifecycle=`CASE WHEN j.book_id IS NULL THEN 'unqueued' WHEN j.state IN ('review','waiting','budget','source','retry') THEN j.state WHEN j.due_at<=${now()} THEN 'due' WHEN j.due_at<${IDLE} THEN 'scheduled' ELSE 'complete' END`;
    const counts=Object.fromEntries(db.prepare(`SELECT ${lifecycle} AS state,COUNT(*) AS count ${base} GROUP BY 1`).all(...params).map(r=>[r.state,r.count]));
    const needsIdentification=db.prepare(`SELECT COUNT(*) AS n ${base} ${where?'AND':'WHERE'} (b.cv_issue_id IS NULL OR b.cv_issue_id='')`).get(...params).n;
    const recent=`j.publication_date BETWEEN '${new Date(now()-90*DAY).toISOString().slice(0,10)}' AND '${new Date(now()).toISOString().slice(0,10)}'`;
    const intervention="j.state IN ('review','waiting') AND j.checked_at IS NOT NULL";
    const conversion="lower(b.filename) GLOB '*.cbr' OR lower(b.filename) GLOB '*.rar' OR lower(b.filename) GLOB '*.zip'";
    const unknownWithId="j.publication_date IS NULL AND b.cv_issue_id IS NOT NULL AND b.cv_issue_id<>''";
    const unknownWithoutId="j.publication_date IS NULL AND (b.cv_issue_id IS NULL OR b.cv_issue_id='')";
    const categories=db.prepare(`SELECT COALESCE(SUM(CASE WHEN ${recent} THEN 1 ELSE 0 END),0) AS recent,COALESCE(SUM(CASE WHEN ${intervention} THEN 1 ELSE 0 END),0) AS intervention,COALESCE(SUM(CASE WHEN ${conversion} THEN 1 ELSE 0 END),0) AS conversion,COALESCE(SUM(CASE WHEN j.publication_date IS NULL THEN 1 ELSE 0 END),0) AS unknownDates,COALESCE(SUM(CASE WHEN ${unknownWithId} THEN 1 ELSE 0 END),0) AS unknownDatesWithId,COALESCE(SUM(CASE WHEN ${unknownWithoutId} THEN 1 ELSE 0 END),0) AS unknownDatesWithoutId ${base}`).get(...params);
    categories.unidentified=needsIdentification;
    categories.ai=db.prepare(`SELECT COUNT(*) AS n ${base} ${where?'AND':'WHERE'} j.match_note IS NOT NULL`).get(...params).n;
    const categoryFilters={ai:"j.match_note IS NOT NULL",recent,intervention,conversion,unknown:unknownWithId,unidentified:"(b.cv_issue_id IS NULL OR b.cv_issue_id='')",
      // Library health links (libraryHealth.js): damaged archives and unsafe archive paths.
      damaged:`${intervention} AND j.last_error LIKE '%Damaged archive%'`,
      unsafe:`${intervention} AND (j.last_error LIKE '%Unsafe archive member path%' OR j.last_error LIKE '%Ambiguous archive member path%')`};
    const filters={attention:"IN ('review','waiting','source','retry','budget')",review:"IN ('review','waiting')",deferred:"IN ('source','retry','budget')",due:"IN ('due')",unqueued:"IN ('unqueued')",scheduled:"IN ('scheduled')",complete:"IN ('complete')"};
    const extra=[];if(view!=='all')extra.push(categoryFilters[view]?`(${categoryFilters[view]})`:`(${lifecycle}) ${filters[view]||filters.attention}`);
    if(String(search).trim()){extra.push('(instr(lower(b.filename),?)>0 OR instr(lower(s.name),?)>0)');params.push(String(search).trim().toLowerCase(),String(search).trim().toLowerCase());}
    const filtered=base+(extra.length?(where?' AND ':' WHERE ')+extra.join(' AND '):'');
    const matched=db.prepare(`SELECT COUNT(*) n ${filtered}`).get(...params).n;
    const take=Math.max(1,Math.min(100,Number(limit)||50)),skip=Math.max(0,Number(offset)||0);
    const books=db.prepare(`SELECT b.id,b.filename,b.series_id,b.cv_issue_id,s.name AS series_name,j.kind,j.milestone,${lifecycle} AS state,j.last_error,j.checked_at,j.due_at,j.attempts,j.publication_date,j.date_basis,j.date_precision,j.match_note,j.last_result ${filtered} ORDER BY s.name,b.filename,b.id LIMIT ? OFFSET ?`).all(...params,take,skip);
    const dueByKind=Object.fromEntries(db.prepare(`SELECT COALESCE(j.kind,'enrichment') AS kind,COUNT(*) n ${base} ${where?'AND':'WHERE'} (${lifecycle})='due' GROUP BY 1`).all(...(libraryId?[String(libraryId)]:[])).map(r=>[r.kind,r.n]));
    const operations=runtime.status(),activeOperations=operations.filter(op=>op.active);
    // Follow explicitly requested books even after they leave a filter/page.
    // Admin-only status reporting; no provider calls, scheduling or writes.
    const trackedIds=[...new Set(String(track).split(',').filter(Boolean))].slice(0,20);
    const trackedBooks=trackedIds.length?db.prepare(`SELECT b.id,b.filename,b.series_id,j.state,j.checked_at,j.last_success_at,j.manual_requested_at,j.due_at,j.last_error,j.last_result FROM scanned_books b LEFT JOIN metadata_jobs j ON j.book_id=b.id WHERE b.id IN (${trackedIds.map(()=>'?').join(',')})`).all(...trackedIds):[];
    return {trackedBooks,running:running||activeOperations.length>0,runningBookId:runningBookId||activeOperations[0]?.bookId||null,dueByKind,categories,maintenanceWindow:{...executionWindow(now()),paused:isPaused()},overnightSummary:JSON.parse(nightRead.get()?.record||'null'),batch:activeBatch?{...activeBatch,result:{...activeBatch.result}}:lastBatch,providerRetryAt:db.prepare('SELECT provider_retry_at FROM metadata_worker_state WHERE id=1').get().provider_retry_at,counts,total:Object.values(counts).reduce((a,b)=>a+b,0),needsIdentification,books,matched,offset:skip,limit:take,unfinished:operations.filter(op=>!op.active),activeOperations,filesPerRun:25};
  }
  return {enqueue,run,seed,status,isRunning:()=>running,recordSuccess,recordManualSuccess:recordSuccess,requestCheck,setPaused(value){db.prepare('UPDATE metadata_maintenance_control SET paused=? WHERE id=1').run(value?1:0);return {paused:isPaused()};}};
}
module.exports={createMetadataMaintenance,dateInfo};
