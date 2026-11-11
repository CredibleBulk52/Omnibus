'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {decideIdentity}=require('./identity');
const {planBookMetadata}=require('./metadataService');
const {prepareJournalArchive}=require('./archivePreparationJob');
const {createArchiveStorage}=require('./archiveStorage');
const {createBookFinalizer}=require('./bookFinalization');
const {runBookFollowups}=require('./bookFollowups');
function fail(code,message){throw Object.assign(new Error(message),{code});}
// Step timings for the log (Phase 6.6): where a tag/arrival spends its time.
function stepTimer(){
  const start=Date.now(),steps={};let last=start;
  return {mark(name){const t=Date.now();steps[name]=(steps[name]||0)+(t-last);last=t;},
    add(name,ms){steps[name]=(steps[name]||0)+ms;},
    summary(extra={}){return {...extra,total_ms:Date.now()-start,steps};}};
}

// Runtime dependencies are explicit. Production must provide exclusion shared
// by ALL old writers/scanners and revision-aware, manual-link-safe follow-ups.
// There is deliberately no permissive default lock or no-op cache handler.
function createReprocessingService({db,journal,stableIds,bookIndex,libraryRoots,scratchParent,executables,
  loadSource,withExclusiveMutation,followups,readOverrides=()=>null,arrivalRoots=[],registerArrival,onTimings=null}) {
  const report=(timer,extra)=>{try{onTimings?.(timer.summary(extra));}catch{}};
  if(typeof loadSource!=='function'||typeof withExclusiveMutation!=='function')throw new TypeError('Provider and coordinated mutation adapters required');
  for(const key of ['cache_invalidation','events','canon','reading_lists'])if(typeof followups?.[key]!=='function')throw new TypeError(`Missing ${key} follow-up`);
  const storage=()=>createArchiveStorage({libraryRoots:[...libraryRoots,...arrivalRoots]});
  const heartbeat=handle=>setInterval(()=>{try{journal.heartbeat(handle);}catch{}},1000);
  // Let ready HTTP/image callbacks run between completed journal transactions.
  // This does not make an individual synchronous disk operation asynchronous.
  const yieldRequests=()=>new Promise(resolve=>setImmediate(resolve));
  const checkCancelled=signal=>{if(signal?.aborted)fail('ARCHIVE_CANCELLED','Reprocessing cancelled');};
  // A file that needs no rewrite can still be ahead of the library index (for
  // example an older scan read a nested ComicInfo copy). Record what was verified.
  function syncUnchanged(book,report){
    try{
      const xml=report?.comicInfo?.xml,cv=report?.appliedMetadata?.cvIssueId||null;
      if(typeof xml==='string'&&xml!==book.comicinfo)db.prepare('UPDATE scanned_books SET comicinfo=? WHERE id=? AND path=?').run(xml,book.id,book.path);
      if(cv)db.prepare("UPDATE scanned_books SET cv_issue_id=? WHERE id=? AND (cv_issue_id IS NULL OR cv_issue_id='')").run(String(cv),book.id);
    }catch{}
  }
  async function reprocess({bookId,requestKey,explicitIssueId=null,expectedIssueId=null,canonicalFilename=null,arrival='scanner',candidate=null,downloadIssueId=null,normalizationOnly=false,salvage=false,signal}) {
    if(typeof bookId!=='string'||!bookId||typeof requestKey!=='string'||!requestKey)throw new TypeError('Stable book and request key required');
    if(normalizationOnly && (canonicalFilename!==null || explicitIssueId!==null || expectedIssueId!==null || candidate || downloadIssueId))throw new TypeError('Format-only work cannot assign identity or canonical naming');
    if(canonicalFilename!==null && (typeof canonicalFilename!=='string'||path.basename(canonicalFilename)!==canonicalFilename||/[\\/:\x00-\x1f]/.test(canonicalFilename)||!canonicalFilename.toLowerCase().endsWith('.cbz')))throw new TypeError('Canonical name must be one CBZ filename');
    const timer=stepTimer();let outcome='failed';
    try{return await withExclusiveMutation({bookId},async()=>{
      timer.mark('wait_for_library_access');checkCancelled(signal);
      const context={kind:'existing_book_reprocess',bookId,explicitIssueId,expectedIssueId,canonicalFilename,arrival,candidateId:candidate?.issue?.id?String(candidate.issue.id):null,downloadIssueId,...(normalizationOnly?{normalizationOnly:true}:{})};
      const previous=journal.findRequest(requestKey);
      if(previous){if(!previous.payload.context||(previous.payload.context.normalizationOnly===true)!==normalizationOnly||Object.keys(context).some(key=>previous.payload.context[key]!==context[key]))fail('REQUEST_KEY_REUSED','Request key belongs to another user request');return {status:previous.state==='released'?(previous.release_reason==='completed'?'completed':previous.release_reason==='no_work'?'unchanged':'existing'):'existing',operationId:previous.id,reused:true};}
      const book=db.prepare('SELECT * FROM scanned_books WHERE id=?').get(bookId);
      if(!book)fail('BOOK_UNAVAILABLE','Selected stable book no longer exists');
      const reader=storage(), source=reader.readSource(book.path);timer.mark('read_and_fingerprint_source');
      const destination=path.join(path.dirname(book.path),canonicalFilename||path.basename(book.path).replace(/\.(cbz|cbr|zip|rar)$/i,'.cbz'));
      if(!destination.toLowerCase().endsWith('.cbz'))fail('CBZ_REQUIRED','Unsupported source extension');
      const occupied=db.prepare('SELECT id FROM scanned_books WHERE path=? AND id!=?').get(destination,bookId);
      // A leftover CBR beside its own converted CBZ: say so plainly.
      if(occupied&&/\.cbr$/i.test(book.path)&&path.resolve(destination)===path.resolve(book.path.replace(/\.cbr$/i,'.cbz')))
        fail('DESTINATION_OCCUPIED','A CBZ copy of this CBR already exists in the folder; delete the CBR once you have confirmed the CBZ is complete');
      if(occupied)fail('DESTINATION_OCCUPIED','Canonical filename belongs to another physical book');
      if(path.resolve(destination)!==path.resolve(book.path) && fs.existsSync(destination))fail('DESTINATION_OCCUPIED','Destination file already exists');
      const work=journal.begin({requestKey,actor:'explicit_retag',intent:'reprocess',bookId,expectedGeneration:journal.bookGeneration(bookId),
        sourcePath:book.path,destinationPath:destination,sourceFingerprint:source.fingerprint,context});
      const handle=work.handle;let prepared, beat=heartbeat(handle);timer.mark('journal_begin');
      try {
        prepared=await prepareJournalArchive({journal,handle,inputPath:source.path,sourceName:book.filename,scratchParent,executables,signal,salvage,onStage:name=>timer.mark(name),
          forceOutput:path.resolve(destination)!==path.resolve(book.path),planMetadata:normalizationOnly?null:async currentXml=>{
            const lookup=Date.now();try{
            const decision=decideIdentity({bookId,arrival,filename:book.filename,folderName:path.basename(path.dirname(book.path)),comicInfoXml:currentXml,indexedIssueId:book.cv_issue_id,explicitIssueId,downloadIssueId,candidate});
            if(decision.status!=='accepted')fail('IDENTITY_REVIEW_REQUIRED',decision.reason);
            if(expectedIssueId!==null&&String(expectedIssueId)!==decision.cvIssueId)fail('CV_ISSUE_MISMATCH','Naming/monitoring evidence conflicts with the selected physical book');
            const loaded=await loadSource(decision.cvIssueId,{signal});checkCancelled(signal);journal.assertOwned(handle);
            const saved=db.prepare('SELECT record FROM metadata_book_managed WHERE book_id=?').get(bookId);
            return planBookMetadata({bookId,arrival,filename:book.filename,folderName:path.basename(path.dirname(book.path)),currentXml,indexedIssueId:book.cv_issue_id,explicitIssueId,downloadIssueId,candidate,
              source:loaded,previous:saved?JSON.parse(saved.record):null,overrides:readOverrides(bookId)});
            }finally{timer.add('provider_lookup_in_prepare',Date.now()-lookup);}
          }});
        timer.mark('extract_inspect_build_cbz');
        checkCancelled(signal);journal.assertOwned(handle);
        if(prepared.status==='unchanged'){journal.releaseUnstarted(handle,'no_work');outcome='unchanged';syncUnchanged(book,prepared.report);return {status:'unchanged',operationId:work.operation.id};}
        const adapter=createArchiveStorage({libraryRoots,candidate:prepared});
        journal.executeArchiveStep(handle,'prepare',adapter);await yieldRequests();timer.mark('journal_stage_copy');
        await prepared.cleanup();timer.mark('scratch_cleanup');
        checkCancelled(signal);journal.executeArchiveStep(handle,'backup',adapter);await yieldRequests();timer.mark('backup_original');
        journal.executeArchiveStep(handle,'publish',adapter);await yieldRequests();timer.mark('publish_to_library');
        journal.finalizePublishedBook(handle,{inspect:adapter.inspect,finalize:createBookFinalizer({stableIds,bookIndex,prepared})});timer.mark('finalize_database');
        await runBookFollowups({db,journal,handle,handlers:followups,signal});timer.mark('followups');
        journal.finishPublishedBook(handle,adapter);timer.mark('retire_backup');
        outcome='completed';return {status:'completed',operationId:work.operation.id,bookId,path:destination};
      } catch(error) {
        if(prepared?.cleanup)try{await prepared.cleanup();}catch(cleanupError){error.cleanupError=cleanupError;}
        try{journal.releaseUnstarted(handle,'validation_failed');}catch{journal.holdOperation(handle,error.code||'reprocessing_interrupted');}
        error.operationId=work.operation.id;throw error;
      } finally {clearInterval(beat);}
    });}finally{report(timer,{kind:normalizationOnly?'convert':'retag',bookId,outcome});}
  }
  // explicitIssueId: an admin's "Process anyway" (2026-11-09): this file is that issue, as a manual
  // Tag is for a library book. Then the filename and embedded tags no longer decide identity.
  async function arrive({sourcePath,destinationPath,sourceName=path.basename(sourcePath),requestKey,downloadIssueId=null,explicitIssueId=null,candidate=null,profile=null,salvage=false,signal}) {
    if(typeof registerArrival!=='function')throw new TypeError('Atomic stable-ID registration required');
    if(!libraryRoots.some(root=>{const rel=path.relative(fs.realpathSync(root),fs.realpathSync(path.dirname(destinationPath)));return !rel||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));}))fail('DESTINATION_UNSAFE','Destination must be inside a configured library');
    const timer=stepTimer();let outcome='failed';
    try{return await withExclusiveMutation({},async()=>{
      timer.mark('wait_for_library_access');checkCancelled(signal);
      if(fs.existsSync(destinationPath)||db.prepare('SELECT id FROM scanned_books WHERE path=?').get(destinationPath))fail('DESTINATION_OCCUPIED','A physical book already owns this destination');
      const source=storage().readSource(sourcePath);timer.mark('read_and_fingerprint_source');
      const work=journal.begin({requestKey,actor:'download',intent:'initial_arrival',sourcePath,destinationPath,sourceFingerprint:source.fingerprint,
        context:{sourceRoot:fs.realpathSync(path.dirname(sourcePath)),downloadIssueId,...(explicitIssueId?{explicitIssueId}:{}),profile}});
      const handle=work.handle;let prepared;const beat=heartbeat(handle);timer.mark('journal_begin');
      try{
        const planningId='arrival:'+work.operation.id;
        prepared=await prepareJournalArchive({journal,handle,inputPath:source.path,sourceName,scratchParent,executables,signal,salvage,mode:'download_container',forceOutput:true,onStage:name=>timer.mark(name),
          planMetadata:async currentXml=>{
            const decision=decideIdentity({bookId:planningId,arrival:'download',filename:sourceName,comicInfoXml:currentXml,downloadIssueId,explicitIssueId,candidate});
            if(decision.status!=='accepted')fail('IDENTITY_REVIEW_REQUIRED',decision.reason);
            const lookup=Date.now();const loaded=await loadSource(decision.cvIssueId,{signal});timer.add('provider_lookup_in_prepare',Date.now()-lookup);
            return planBookMetadata({bookId:planningId,arrival:'download',filename:sourceName,currentXml,downloadIssueId,explicitIssueId,candidate,source:loaded,profile});
          }});
        timer.mark('extract_inspect_build_cbz');
        checkCancelled(signal);journal.assertOwned(handle);
        const adapter=createArchiveStorage({libraryRoots:[...libraryRoots,...arrivalRoots],candidate:prepared});
        journal.executeArchiveStep(handle,'prepare',adapter);await yieldRequests();timer.mark('journal_stage_copy');await prepared.cleanup();timer.mark('scratch_cleanup');checkCancelled(signal);
        journal.executeArchiveStep(handle,'backup',adapter);await yieldRequests();timer.mark('backup_original');journal.executeArchiveStep(handle,'publish',adapter);await yieldRequests();timer.mark('publish_to_library');
        journal.finalizePublishedBook(handle,{inspect:adapter.inspect,
          register:(connection,operation,execution,facts)=>registerArrival({connection,operation,prepared,facts}),
          finalize:(connection,operation,execution,facts)=>{
            // Planning tokens never allocate book IDs. StableIds resolves the
            // actual physical identity atomically with publication registration.
            const rebound=structuredClone(prepared.report.appliedMetadata);
            rebound.bookId=operation.book_id;rebound.plan.bookId=operation.book_id;
            return createBookFinalizer({stableIds,bookIndex,prepared:{...prepared,report:{...prepared.report,appliedMetadata:rebound}}})(connection,operation,execution,facts);
          }});timer.mark('register_and_finalize_database');
        await runBookFollowups({db,journal,handle,handlers:followups,signal});timer.mark('followups');journal.finishPublishedBook(handle,adapter);timer.mark('retire_backup');
        outcome='completed';return {status:'completed',operationId:work.operation.id,bookId:journal.get(work.operation.id).book_id,path:destinationPath};
      }catch(error){
        if(prepared?.cleanup)try{await prepared.cleanup();}catch(cleanupError){error.cleanupError=cleanupError;}
        try{journal.releaseUnstarted(handle,'validation_failed');}catch{journal.holdOperation(handle,error.code||'arrival_interrupted');}
        error.operationId=work.operation.id;throw error;
      }finally{clearInterval(beat);}
    });}finally{report(timer,{kind:'arrival',file:path.basename(destinationPath),outcome});}
  }
  async function recover({operationId,isQuiescent,signal}) {
    if(typeof isQuiescent!=='function')throw new TypeError('Explicit stopped-job proof required');
    const operation=journal.get(operationId);
    if(!operation)fail('WORK_NOT_FOUND','Unknown operation');
    return withExclusiveMutation({bookId:operation.book_id,recoveryOperationId:operationId},async()=>{
      checkCancelled(signal);
      if(operation.state==='released')return {status:'already_released'};
      if(isQuiescent(operation)!==true)fail('WORKER_ACTIVE','Previous job or consumers may still be active');
      journal.quarantineExpired();
      const parent=fs.realpathSync(scratchParent);
      const checkedRoot=row=>{const root=path.resolve(row.root);if(path.dirname(root)!==parent||!/^omnibus-archive-[a-f0-9-]{36}$/.test(path.basename(root)))fail('UNSAFE_SCRATCH','Unexpected scratch recovery root');return root;};
      const scratch=journal.recoverScratch(operationId,{isQuiescent:()=>isQuiescent(operation),
        remove:row=>fs.rmSync(checkedRoot(row),{recursive:true,force:true}),
        isAbsent:row=>{const target=checkedRoot(row);try{fs.lstatSync(target);return false;}catch(e){if(e.code==='ENOENT'){fs.statSync(parent);return true;}throw e;}}});
      if(scratch.action==='hold')return {status:'held',reason:scratch.reason};
      const adapter=storage();
      if(!journal.finalization(operationId))return journal.recoverOperation(operationId,adapter);
      const facts=adapter.inspect(journal.get(operationId)),expected=journal.execution(operationId).prepared;
      if(facts.destination.status!=='file'||facts.destination.sha256!==expected.sha256||facts.destination.size!==expected.size)fail('ARCHIVE_FACTS_CHANGED','Published content changed; do not run completion callbacks');
      const handle=journal.claimFinalized(operationId,isQuiescent),timer=heartbeat(handle);
      try{await runBookFollowups({db,journal,handle,handlers:followups,signal});journal.finishPublishedBook(handle,adapter);return {status:'completed',operationId};}
      catch(error){journal.holdOperation(handle,error.code||'completion_interrupted');throw error;}
      finally{clearInterval(timer);}
    });
  }
  return {reprocess,arrive,recover};
}
module.exports={createReprocessingService};
