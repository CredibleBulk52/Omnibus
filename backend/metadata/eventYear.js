'use strict';
const {parseComicInfoEvidence,parseCvIssueId}=require('./evidence');
// One policy for retaining and proposing event links. A monitored pointer alone
// must not recreate a match that the next year-validation pass will reject.
function eventYearMatches({volumeYear,cvIssueId,book}){
  if(!book)return false;
  const expected=parseCvIssueId(cvIssueId),ci=parseComicInfoEvidence(book.comicinfo);
  if(expected&&(parseCvIssueId(book.cv_issue_id)===expected||ci.identity.cvIssueId===expected))return true;
  const year=value=>/^\d{4}$/.test(String(value||''))?Number(value):null;
  const eventYear=year(volumeYear),bookYear=(ci.fields.year?.length===1?year(ci.fields.year[0]):null)||year(book.syear);
  return !eventYear||!bookYear||Math.abs(bookYear-eventYear)<=4;
}
module.exports={eventYearMatches};
