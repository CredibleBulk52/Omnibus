'use strict';
const {parseComicInfoEvidence,parseCvIssueId}=require('./evidence');
// Stored observations only. This report does not assert current disk contents.
function createMetadataReconciliation({db}){
  const dangling=`monitored_issue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM monitored_issues m WHERE m.id=scanned_books.monitored_issue_id)`;
  function report(){
    const counts={books:0,missingIndexedIdentity:0,identityConflict:0,invalidXml:0};const samples=[];
    for(const book of db.prepare('SELECT id,filename,comicinfo,cv_issue_id FROM scanned_books').iterate()){
      counts.books++;const evidence=parseComicInfoEvidence(book.comicinfo);let reason=null;
      if(evidence.status==='invalid'){counts.invalidXml++;reason='invalid_xml';}
      else if(evidence.identity.status==='conflict'||(evidence.identity.cvIssueId&&book.cv_issue_id&&evidence.identity.cvIssueId!==parseCvIssueId(book.cv_issue_id))){counts.identityConflict++;reason='identity_conflict';}
      else if(evidence.identity.status==='supported'&&!book.cv_issue_id){counts.missingIndexedIdentity++;reason='index_missing_identity';}
      if(reason&&samples.length<100)samples.push({id:book.id,filename:book.filename,reason});
    }
    const stale=db.prepare(`SELECT id,filename,monitored_issue_id FROM scanned_books WHERE ${dangling} ORDER BY id LIMIT 100`).all();
    return {basis:'stored_scanner_observations',...counts,danglingMonitoring:db.prepare(`SELECT COUNT(*) AS n FROM scanned_books WHERE ${dangling}`).get().n,samples,danglingSamples:stale,
      repairScope:'Only dangling monitoring references can be cleared here. Identity differences require an archive rescan or explicit review.'};
  }
  function clearDangling(){
    // One atomic statement rechecks existence at application time; retains CV ID,
    // book ID, progress, filing, metadata and all existing monitoring references.
    return {cleared:db.prepare(`UPDATE scanned_books SET monitored_issue_id=NULL WHERE ${dangling}`).run().changes};
  }
  return {report,clearDangling};
}
module.exports={createMetadataReconciliation};
