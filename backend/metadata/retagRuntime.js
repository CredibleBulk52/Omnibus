'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {parseCvIssueId,parseComicInfoEvidence}=require('./evidence');
const {initializeWorkJournal,createWorkJournal}=require('./workJournal');
const {initializeBookFinalization}=require('./bookFinalization');
const {createReprocessingService}=require('./reprocessingService');
const {adaptCvSource}=require('./cvSource');
const {publicationHint,candidateMatches,isMangaPublication,bookFolderName}=require('./candidate');
const {isYearNamedVolume}=require('./annualIdentification');
const {flattenUnsafeFolders}=require('./flattenUnsafeFolders');
// Annual files may be identified as a year-named one-shot ("Wolverine '97").
const annualVolume=(volumeName,filename)=>/\bannual\b/i.test(volumeName)||(/\bannual\b/i.test(filename||'')&&isYearNamedVolume(volumeName));
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};

// Runtime only: called after the application's DB, index and reconcilers exist.
// Uses their providers, naming and conversion services; owns no second cache.
function createRetagRuntime({db,access,deploymentGate=null,stableIds,bookIndex,getLibraryRoots,scratchParent,
  fetchIssue,fetchVolume,saveIssue,buildDestFilename,buildMangaDestFilename=null,followups,executables,discoverCandidates=async()=>[],discoverAnnual=null,registerArrival,onManualSuccess=()=>{},onTimings=null,logger=null,
  pathPolicy={style:process.platform==='win32'?'win32':'posix',caseSensitive:false}}) {
  initializeWorkJournal(db,pathPolicy);initializeBookFinalization(db);
  const ownerId=crypto.randomUUID();let activeRequests=0;
  const journal=createWorkJournal({db,ownerId,pathPolicy,
    readBook:id=>db.prepare('SELECT * FROM scanned_books WHERE id=?').get(id)});
  const recoveryToken={},stopped=new Set();
  const heldError=()=>Object.assign(new Error('Interrupted metadata work needs recovery. See /api/admin/metadata-work.'),{code:'LIBRARY_RECOVERY_REQUIRED'});
  const bookScope=book=>book?.series_id ? 'series:'+book.series_id : null;
  access.setAdmission((mode,admission,scope)=>{
    if(admission===recoveryToken)return;
    const unfinished=journal.listUnfinished();
    if(!unfinished.length)return;
    // A failed existing-book retag must not turn the whole library offline.
    // Unknown/arrival/directory operations remain globally fenced. Never infer
    // a safe scope from a missing row or an operation of another kind.
    if(mode==='read' && scope && unfinished.every(row=>{
      if(row.payload.context?.kind!=='existing_book_reprocess')return false;
      const affected=bookScope(db.prepare('SELECT series_id FROM scanned_books WHERE id=?').get(row.book_id));
      return affected && affected!==scope;
    }))return;
    throw heldError();
  });
  function checkFree(){if(journal.listUnfinished().length)throw heldError();}
  async function lookupIssue(id){
    checkFree();
    id=parseCvIssueId(id);
    if(!id)fail('INVALID_CV_ID','A Comic Vine issue ID is required');
    const issue=await fetchIssue(id);
    if(!issue||parseCvIssueId(issue.id)!==id)fail('CV_NO_DATA','Comic Vine returned no matching issue');
    saveIssue(id,issue);return issue;
  }
  async function publication(id,fresh=null){
    const issue=fresh||await fetchIssue(id);
    if(!issue||parseCvIssueId(issue.id)!==id)fail('CV_NO_DATA','Comic Vine returned no matching issue');
    const volumeId=parseCvIssueId(issue.volume?.id);
    if(!volumeId)fail('CV_NO_DATA','Comic Vine issue has no referenced volume');
    const volume=await fetchVolume(volumeId);
    if(adaptCvSource({expectedIssueId:id,issue,volume}).status!=='ready'||!volume?.name||issue.issue_number==null)fail('CV_NO_DATA','Comic Vine returned incomplete or conflicting publication data');
    saveIssue(id,issue);return {issue,volume};
  }
  function options(loadSource,arrivalRoots=[]) {
    const roots=getLibraryRoots();
    // Scratch is application data, never a watched library directory.
    fs.mkdirSync(scratchParent,{recursive:true,mode:0o700});
    const scratch=fs.realpathSync(scratchParent);
    for(const root of roots){const rel=path.relative(fs.realpathSync(root),scratch);if(!rel||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep)))fail('UNSAFE_SCRATCH','Metadata scratch must be outside libraries');}
    return {db,journal,stableIds,bookIndex,libraryRoots:roots,scratchParent:scratch,executables,loadSource,followups,registerArrival,onTimings,
      arrivalRoots:[...new Set([...arrivalRoots,...journal.listUnfinished().map(r=>r.payload.context?.sourceRoot).filter(Boolean)])],
      // No authoritative per-book field-override store exists in this app yet.
      // Existing unowned XML and all library filing fields remain protected.
      readOverrides:()=>null,
      withExclusiveMutation:(scope,action)=>access.run('write',()=>{
        if(!scope.recoveryOperationId)checkFree();return action();
      },{admission:scope.recoveryOperationId?recoveryToken:undefined})};
  }
  // rediscover: identify again from the filename and folder only, ignoring the
  // Comic Vine ID stored in the file and the index (Library health "Retag
  // mismatched files", 2026-10-16). A unique corroborated match is applied as an
  // explicit correction, the same as choosing the issue by hand.
  async function retag({bookId=null,issue=null,requestKey=crypto.randomUUID(),explicitIssueId=null,
    preserveFilename=false,freshIssue=null,arrival='scanner',salvage=false,rediscover=false,signal}={}) {
    let normalized=false,matched=null;
    // Provider lookup does not own archive access. The service rechecks the
    // physical archive under exclusive ownership before any mutation.
    return (async()=>{
      if(signal?.aborted)fail('ARCHIVE_CANCELLED','Retag cancelled');
      checkFree();
      if(!bookId){const books=issue?.file_path?db.prepare('SELECT id FROM scanned_books WHERE path=?').all(issue.file_path):[];
        if(books.length!==1)fail('BOOK_SELECTION_REQUIRED','No unique registered book at the monitored file path; select the physical book in the library');bookId=books[0].id;}
      bookId=String(bookId);
      let book=db.prepare('SELECT * FROM scanned_books WHERE id=?').get(bookId);
      if(!book)fail('BOOK_UNAVAILABLE','Selected book no longer exists');
      let explicit=explicitIssueId==null?null:parseCvIssueId(explicitIssueId);
      if(explicitIssueId!=null&&!explicit)fail('INVALID_CV_ID','Use a Comic Vine issue URL or a positive issue ID');
      // Automatic arrivals become readable independently of provider identity.
      // Reuse the same conversion/publication lifecycle, preserving all XML and
      // filing. Explicit retag retains its existing canonical naming behavior.
      if(preserveFilename && /\.(cbr|rar|zip)$/i.test(book.filename)){
        await access.run('write',async()=>{
          checkFree();
          const current=db.prepare('SELECT * FROM scanned_books WHERE id=?').get(bookId);
          if(!current || ['series_id','path','filename','file_mtime','file_size'].some(key=>current[key]!==book[key]))fail('BOOK_CHANGED_RETRY','Book changed before conversion; retry using its current evidence');
          const service=createReprocessingService(options(async()=>{throw new Error('Format normalization must not fetch metadata');}));
          try{
            const result=await service.reprocess({bookId,requestKey:requestKey+':format',arrival,normalizationOnly:true,salvage,signal});
            if(!['completed','unchanged'].includes(result.status))fail('METADATA_WORK_INCOMPLETE','Format normalization did not complete');
            normalized=result.status==='completed';
          }catch(error){if(error.operationId&&!error.cleanupError&&journal.get(error.operationId)?.state!=='released')stopped.add(error.operationId);throw error;}
        },{signal,scope:bookScope(book)});
        book=db.prepare('SELECT * FROM scanned_books WHERE id=?').get(bookId);
        if(!book)fail('BOOK_UNAVAILABLE','Converted book no longer exists');
      }
      const embedded=parseComicInfoEvidence(book.comicinfo).identity.ids;
      // This proposes provider/naming work only. The service independently reads
      // the physical archive and must accept the same identity before any write.
      let id=explicit||(rediscover?null:((embedded.length===1?embedded[0]:null)||parseCvIssueId(book.cv_issue_id)))||parseCvIssueId(issue?.id),candidate=null;
      if(!id){
        const identifyStart=Date.now();
        const evidenceXml=rediscover?null:book.comicinfo;   // the stored tags are what is in doubt
        const matches=c=>candidateMatches({filename:book.filename,comicInfoXml:evidenceXml,folderName:bookFolderName(book),...c});
        const hint=publicationHint(book.filename,evidenceXml,bookFolderName(book));
        let problem=hint?null:'No unambiguous publication evidence; choose the Comic Vine issue explicitly. Omnibus could not read a series, issue number and year from the filename, ComicInfo and folder together';
        if(hint){
          const discovered=await discoverCandidates(hint,book);
          const accepted=discovered.filter(matches);
          const unique=[...new Map(accepted.map(c=>[String(c.issue.id),c])).values()];
          const looked=`Looked for ${hint.name} #${hint.number} (${hint.year})`+(discovered.trace?.length?': '+discovered.trace.join('; '):'');
          if(unique.length===1)candidate=unique[0];
          else problem=(unique.length?'Multiple publications fit; choose the Comic Vine issue':'No corroborated publication match; choose the Comic Vine issue')+'. '+looked+'.';
        }
        // Annual files: search annual volumes, year-named one-shots and
        // crossovers; Claude chooses only among real Comic Vine candidates.
        if(!candidate&&discoverAnnual&&/\bannual\b/i.test(book.filename)){
          const found=await discoverAnnual(book);
          if(found?.candidate&&matches(found.candidate)){
            const owner=db.prepare('SELECT path FROM scanned_books WHERE cv_issue_id=? AND id<>? LIMIT 1').get(String(found.candidate.issue.id),bookId);
            if(owner)fail('IDENTITY_REVIEW_REQUIRED',`Duplicate copy: ${found.candidate.volume.name} #${found.candidate.issue.issue_number} is already in your library as ${owner.path}. Delete one copy.`);
            candidate=found.candidate;
          }else if(found?.reason)problem=found.reason;
        }
        try{onTimings?.({kind:'identification',bookId,file:book.filename,outcome:candidate?(candidate.annualMatch?.rule==='ai'?'ai_match':'matched'):'needs_help',total_ms:Date.now()-identifyStart});}catch{}
        if(!candidate)fail('IDENTITY_REVIEW_REQUIRED',problem);
        id=String(candidate.issue.id);
        if(rediscover)explicit=id;
      }
      if(issue&&parseCvIssueId(issue.id)!==id)fail('CV_ISSUE_MISMATCH','Monitored issue does not match the selected book');
      let loaded;
      const loadSource=async expected=>{
        if(expected!==id)fail('CV_ISSUE_MISMATCH','Archive identity differs from naming evidence');
        if(loaded)return loaded;
        loaded=await publication(id,freshIssue);return loaded;
      };
      const source=await loadSource(id);
      matched={series:source.volume?.name||null,number:source.issue?.issue_number??null,cvIssueId:id};
      // A stored index/monitor link alone is not authority for an untagged
      // physical book. Corroborate it against provider publication evidence too.
      // The refreshed publication keeps how discovery found it: a related-title
      // volume ("Peter Parker, the Spectacular Spider-Man" for a "Spectacular
      // Spider-Man" file) failed identity corroboration once the flag was
      // dropped here (83 books, 2026-10-16).
      if(!explicit&&!embedded.length){
        const keep={};
        if(candidate?.annualMatch)keep.annualMatch=candidate.annualMatch;
        if(candidate?.relatedTitle===true&&String(candidate.issue?.id)===String(source.issue?.id)){keep.relatedTitle=true;keep.parentStartYear=candidate.parentStartYear??null;}
        candidate={...source,...keep};
      }
      if(signal?.aborted)fail('ARCHIVE_CANCELLED','Retag cancelled');
      const annual=annualVolume(source.volume.name,book.filename);
      if(/\bannual\b/i.test(book.filename)&&!annual&&!issue?.is_annual)fail('ANNUAL_MISMATCH','Annual filename conflicts with the identified publication');
      const naming=isMangaPublication(book.filename,book.comicinfo)&&buildMangaDestFilename?buildMangaDestFilename:buildDestFilename;
      const canonicalFilename=preserveFilename?null:naming({issue_number:source.issue.issue_number,
        release_date:source.issue.cover_date,store_date:source.issue.store_date,is_annual:annual||!!issue?.is_annual},
        {name:source.volume.name,year:source.volume.start_year,publisher:source.volume.publisher?.name});
      return access.run('write',async()=>{
      checkFree();
      const current=db.prepare('SELECT * FROM scanned_books WHERE id=?').get(bookId);
      if(!current || ['series_id','path','filename','comicinfo','cv_issue_id','file_mtime','file_size'].some(key=>current[key]!==book[key]))
        fail('BOOK_CHANGED_RETRY','Book changed during provider lookup; retry using its current evidence');
      // Pages in a folder whose name the validator rejects ("Wizard Wolverine
      // 1:2"): rebuild with the pages at the top level first (verified; the
      // original is kept beside the scratch folder in metadata-repair-backups).
      try{await flattenUnsafeFolders(current.path,{backupDir:path.join(path.dirname(scratchParent),'metadata-repair-backups'),logger});}
      catch(error){logger?.warn?.('retag','Could not rebuild archive without unsafe folders',{bookId,error:error.message});}
      const service=createReprocessingService(options(loadSource));
      try {
        const result=await service.reprocess({bookId,requestKey,explicitIssueId:explicit,expectedIssueId:id,canonicalFilename,arrival,candidate,salvage,signal});
        if(!['completed','unchanged'].includes(result.status))fail('METADATA_WORK_INCOMPLETE','The previous request did not complete; retry with a new request key');
        const dates=adaptCvSource({expectedIssueId:id,...source});
        if(!preserveFilename)onManualSuccess(bookId,dates);
        return {...result,cvIssueId:id,series:source.volume.name,issueNumber:source.issue.issue_number??null,
          identifiedBy:candidate?.annualMatch?.rule==='ai'?'ai':candidate?'rules':null,
          identificationNote:candidate?.annualMatch?.rule==='ai'?`AI match: ${source.volume.name} #${source.issue.issue_number}${candidate.annualMatch.reason?' — '+candidate.annualMatch.reason:''}`:null,
          publicationDate:dates.publicationDate,publicationDateSource:dates.publicationDateSource,publicationDatePrecision:dates.publicationDatePrecision,
          convertedToCbz:normalized||!book.filename.toLowerCase().endsWith('.cbz'),
          renamedTo:result.path&&result.path!==book.path?path.basename(result.path):null};
      } catch(error){if(error.operationId&&!error.cleanupError&&journal.get(error.operationId)?.state!=='released')stopped.add(error.operationId);throw error;}
      },{signal,scope:bookScope(book)});
    })().catch(error=>{if(normalized)error.convertedToCbz=true;if(matched&&!error.matched)error.matched=matched;throw error;});
  }
  // force: an admin's "Process anyway" for a held download (2026-11-09): the file is filed as
  // this issue (explicit identity), without the filename / annual / embedded-ID cross-checks.
  // An occupied destination, damaged archive or unreadable metadata still stops it.
  async function arrive({sourcePath,sourceName=path.basename(sourcePath),issue,directory,matchedByFilename=false,profile=null,salvage=false,force=false,signal}){
    if(signal?.aborted)fail('ARCHIVE_CANCELLED','Arrival cancelled');
    checkFree();const id=parseCvIssueId(issue?.id);if(!id)fail('IDENTITY_REVIEW_REQUIRED','Download needs an identified issue');
    const lookupStart=Date.now();const source=await publication(id);
    try{onTimings?.({kind:'arrival_provider_lookup',file:sourceName,total_ms:Date.now()-lookupStart});}catch{}
    return access.run('write',async()=>{
      checkFree();
      if(!force&&/\bannual\b/i.test(sourceName)&&!annualVolume(source.volume.name,sourceName)&&!issue.is_annual)fail('ANNUAL_MISMATCH','Annual filename conflicts with the selected issue');
      if(profile!==null&&profile!=='manga')fail('INVALID_PROFILE','Unsupported publication profile');
      if(profile==='manga'&&!buildMangaDestFilename)fail('INVALID_PROFILE','Manga naming adapter required');
      const filename=(profile==='manga'?buildMangaDestFilename:buildDestFilename)({issue_number:source.issue.issue_number,release_date:source.issue.cover_date,store_date:source.issue.store_date,is_annual:!!issue.is_annual},
        {name:source.volume.name,year:source.volume.start_year,publisher:source.volume.publisher?.name});
      if(path.basename(filename)!==filename)fail('DESTINATION_UNSAFE','Invalid canonical filename');
      // Validate the existing real parent before creating any child directory.
      let parent=path.resolve(directory);while(!fs.existsSync(parent)){const next=path.dirname(parent);if(next===parent)fail('DESTINATION_UNSAFE','No accessible destination parent');parent=next;}
      const realParent=fs.realpathSync(parent);
      if(!getLibraryRoots().some(root=>{const rel=path.relative(fs.realpathSync(root),realParent);return !rel||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));}))fail('DESTINATION_UNSAFE','Download destination is outside libraries');
      fs.mkdirSync(directory,{recursive:true});
      const service=createReprocessingService(options(async expected=>{if(expected!==id)fail('CV_ISSUE_MISMATCH','Downloaded archive identifies a different issue');return source;},[fs.realpathSync(path.dirname(sourcePath))]));
      try{return await service.arrive({sourcePath,sourceName,destinationPath:path.join(directory,filename),requestKey:crypto.randomUUID(),
        downloadIssueId:force||matchedByFilename?null:id,explicitIssueId:force?id:null,candidate:!force&&matchedByFilename?source:null,profile,salvage,signal});}
      catch(error){if(error.operationId&&!error.cleanupError&&journal.get(error.operationId)?.state!=='released')stopped.add(error.operationId);throw error;}
    },{signal});
  }
  async function recover({operationId,previousWorkerStopped=false}) {
    if(!stopped.has(operationId)&&previousWorkerStopped!==true)fail('WORKER_STOP_CONFIRMATION_REQUIRED','Confirm the previous application worker and its child processes have stopped before recovery');
    const service=createReprocessingService(options(async()=>{throw new Error('Recovery must not fetch metadata');}));
    return service.recover({operationId,isQuiescent:()=>stopped.has(operationId)||previousWorkerStopped===true});
  }
  const guarded=fn=>(...args)=>{
    const action=async()=>{activeRequests++;try{return await fn(...args);}finally{activeRequests--;}};
    return deploymentGate?deploymentGate.run(action):action();
  };
  return {retag:guarded(retag),arrive:guarded(arrive),recover:guarded(recover),lookupIssue:guarded(lookupIssue),isDraining:()=>!!deploymentGate?.snapshot().draining,journal,status:()=>journal.listUnfinished().map(row=>({operationId:row.id,bookId:row.book_id,state:row.state,active:row.owner_id===ownerId&&activeRequests>0&&!stopped.has(row.id),
    source:row.payload.source,destination:row.payload.destination,canRecoverInThisProcess:stopped.has(row.id)}))};
}
module.exports={createRetagRuntime};
