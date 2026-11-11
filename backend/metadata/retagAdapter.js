'use strict';
// Adapter contract for the existing controls. No new screen/route and no live
// switch yet: caller must first supply the coordinated runtime service.
function createRetagAdapter({db,service,buildDestFilename}) {
  return async ({bookId=null,issue=null,series=null,requestKey,explicitIssueId=null,signal})=>{
    if(!bookId){
      const candidates=issue?.file_path?db.prepare('SELECT id FROM scanned_books WHERE path=?').all(issue.file_path):[];
      if(candidates.length!==1)throw Object.assign(new Error('Select one physical library book before retagging'),{code:'BOOK_SELECTION_REQUIRED'});
      bookId=candidates[0].id;
    }
    const canonicalFilename=issue&&series?buildDestFilename(issue,series):null;
    return service.reprocess({bookId,requestKey,explicitIssueId,expectedIssueId:issue?.id??null,canonicalFilename,signal});
  };
}
module.exports={createRetagAdapter};
