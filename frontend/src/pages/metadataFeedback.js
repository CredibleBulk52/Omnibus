// Presentation only: the server remains responsible for work and retry timing.
export const when=value=>value && value<Number.MAX_SAFE_INTEGER?new Date(value).toLocaleString():null;
// Specific causes first; the broader patterns below catch the rest.
const PROBLEMS=[
  [/AMBIGUOUS_COMICINFO/,'The file has more than one ComicInfo.xml and Omnibus cannot tell which is right. Remove the extra copy from the file, then try again.'],
  [/UNSUPPORTED_ENCODING/,'The file’s ComicInfo.xml is not saved as UTF-8 text, so Omnibus left it untouched.'],
  [/INVALID_COMICINFO|UNSUPPORTED_XML|OUTPUT_XML_INVALID|INVALID_PATCH/,'The file’s existing ComicInfo.xml is damaged or unusual, so Omnibus left it untouched. Fix or remove it, then try again.'],
  [/XML_LIMIT|ARCHIVE_LIMIT|IMAGE_LIMIT/,'The file is larger than Omnibus’s safety limit for rewriting, so it was left unchanged.'],
  [/ARCHIVE_DAMAGED|Damaged archive/,'Some pages inside the file are damaged and cannot be read. Replace the file with a good copy, or use Convert anyway to keep every readable page and leave the damaged ones out.'],
  [/NO_IMAGE_PAGES/,'No comic pages were found in the file. It may be damaged or not a comic.'],
  [/ENCRYPTED_ARCHIVE/,'The file is password-protected, so Omnibus cannot update it.'],
  [/UNSUPPORTED_ARCHIVE|UNSUPPORTED_COMPRESSION|CBZ_REQUIRED|RAR_TOOL_REQUIRED|ARCHIVE_INTEGRITY/,'Omnibus could not open this file as a comic archive. It may be damaged; try re-downloading it.'],
  [/UNSAFE_MEMBER|DUPLICATE_MEMBER/,'The file contains unsafe or duplicated entries, so Omnibus will not rewrite it.'],
  [/ANNUAL_MISMATCH/,'The filename says Annual, but the matched Comic Vine issue is not an annual. Choose the correct match.'],
  [/existing_value_preserved|externally_changed_field/,'The file already has a different series, number or volume from another source, and automatic checks never overwrite those. Use Choose match to apply the Comic Vine issue; it replaces them.'],
  [/METADATA_REVIEW_REQUIRED|Metadata needs review/,'Some existing details in the file cannot be updated safely (repeated or structured entries), so they were left as they are.'],
  [/BOOK_CHANGED_RETRY|ARCHIVE_FACTS_CHANGED|STALE_|BOOK_PATH_CHANGED|BOOK_GENERATION_CHANGED/,'The file changed while it was being checked. Try again.'],
  [/BOOK_UNAVAILABLE|ENOENT/,'The file is no longer where Omnibus expects it. Rescan the series, then try again.'],
  [/EACCES|EPERM/,'Omnibus was not allowed to write to the file or its folder.'],
  [/PRESERVATION_FAILED|OUTPUT_FIELD_MISMATCH/,'The safety check after rewriting did not match, so the original file was kept unchanged.'],
  [/DESTINATION_UNSAFE|ARCHIVE_STORAGE_UNSAFE/,'The file is outside the library folders, so nothing was written.'],
  [/RECOVERY_REQUIRED/,'An earlier update was interrupted and needs recovery before this book can be checked.'],
];
export function explainProblem(message='') {
  for(const [pattern,text] of PROBLEMS)if(pattern.test(message))return text;
  if(/ECONNABORTED|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(message))return 'Comic Vine did not respond. Your saved details are kept; Omnibus will try again.';
  if(/CV_RATE_LIMIT|HTTP_429/.test(message))return 'Comic Vine requests are temporarily paused. Omnibus will try again when requests are available.';
  if(/OCCUPIED|Duplicate copy|destination filename/i.test(message))return 'Another file already uses this issue or filename. Review the copies on the series page before trying again.';
  if(/MISMATCH/.test(message))return 'The available details disagree about which issue this is. Review the filename and Comic Vine match.';
  if(/IDENTITY_REVIEW_REQUIRED|corroborated publication|unambiguous publication/i.test(message))return 'Omnibus could not choose one matching Comic Vine issue. Choose a match, or try again after correcting the book or folder details.';
  if(/CV_NO_DATA/.test(message))return 'Comic Vine did not return the needed issue details. Check the saved Comic Vine issue, then try again.';
  return 'This check could not finish.';
}
// The saved error without its internal code, short enough for one line.
export function shortError(message='') {
  const text=String(message||'').replace(/^[A-Z_0-9]+:\s*/,'').trim();
  return text?(text.length>400?text.slice(0,397)+'…':text):'';
}
function matchedIssue(r) {
  return r?.series?`${r.series}${r.number!=null?' #'+r.number:''}${r.cvIssueId?' (Comic Vine '+r.cvIssueId+')':''}`:null;
}
export function describeFailure(lastError,raw) {
  let r=null;try{r=typeof raw==='string'?JSON.parse(raw):raw;}catch{}
  const parts=[explainProblem(lastError)];
  const issue=r?.status==='failed'?matchedIssue(r):null;
  if(issue)parts.push(`Matched issue: ${issue}.`);
  const detail=shortError(lastError);
  if(detail)parts.push(`Reported: “${detail}”`);
  return parts.join(' ');
}
// Turn the server's saved summary of a successful check into one plain sentence.
export function describeResult(raw) {
  let r=null;try{r=typeof raw==='string'?JSON.parse(raw):raw;}catch{}
  if(!r||!r.status)return 'Check finished. Existing details were kept or updated as needed.';
  if(r.status==='failed')return `Failed — ${explainProblem(r.code||'')}${matchedIssue(r)?' Matched issue: '+matchedIssue(r)+'.':''}`;
  const issue=r.series?`${r.series}${r.number!=null?' #'+r.number:''}`:'the saved issue';
  const cv=r.cvIssueId?` (Comic Vine ${r.cvIssueId})`:'';
  const how=r.identifiedBy==='ai'?'Matched by Claude to ':r.identifiedBy==='rules'?'Matched by filename to ':'';
  const parts=[r.status==='unchanged'
    ?`Success — already up to date as ${issue}${cv}. Nothing needed changing.`
    :`Success — ${how?how+issue:'Updated as '+issue}${cv}.${how?' Details written to the file.':' Details refreshed in the file.'}`];
  if(r.converted)parts.push('Converted to CBZ.');
  if(r.renamedTo)parts.push(`Renamed to ${r.renamedTo}.`);
  if(r.identifiedBy==='ai')parts.push('Please check this match.');
  return parts.join(' ');
}
export function checkResult(result) {
  if(result.held)return 'An unfinished update needs recovery before this book can be checked.';
  if(result.providerRetryAt>Date.now())return 'Waiting for Comic Vine until '+when(result.providerRetryAt)+'.';
  if(result.draining)return 'Waiting for the app update to finish.';
  if(result.started)return 'Check requested. Waiting for a progress update…';
  if(result.deferred)return 'Waiting to retry. Comic Vine could not be reached or requests are paused.';
  if(result.review||result.failed)return 'Check finished — manual intervention needed. See this book’s details.';
  if(result.completed)return 'Check finished. Existing details were kept or updated as needed.';
  return 'Waiting for another check to finish. Omnibus checks requested work every 30 seconds.';
}
export function updateReceipt(receipt,data,requestedIds) {
  if(!receipt.watching || !requestedIds.includes(receipt.id))return receipt;
  if(data.runningBookId===receipt.id || data.activeOperations?.some(op=>op.bookId===receipt.id))return {...receipt,message:'Checking this book…',phase:'running'};
  if(!Array.isArray(data.trackedBooks))return receipt; // Older server: never infer completion from disappearance.
  const book=data.trackedBooks.find(book=>book.id===receipt.id);
  if(!book)return {...receipt,watching:false,phase:'attention',message:'This book is no longer in the library. Its check result is unavailable.'};
  const fresh=book.checked_at!=null && book.checked_at!==receipt.previousCheckedAt && (!receipt.requestedAt || book.checked_at>=receipt.requestedAt);
  if(fresh){
    if(['review','waiting'].includes(book.state))return {...receipt,watching:false,phase:'attention',message:'Failed — manual intervention needed. '+describeFailure(book.last_error,book.last_result)};
    if(['retry','budget','source'].includes(book.state))return {...receipt,watching:false,phase:'waiting',message:'Not finished — will retry. '+describeFailure(book.last_error,book.last_result)+' Next eligible retry: '+(when(Math.max(book.due_at||0,data.providerRetryAt||0))||'not scheduled')+'.'};
    if(book.manual_requested_at==null)return {...receipt,watching:false,phase:'done',message:describeResult(book.last_result)};
  }
  if(data.unfinished?.length)return {...receipt,phase:'waiting',message:'Waiting — an unfinished update needs recovery.'};
  if(data.providerRetryAt>Date.now())return {...receipt,phase:'waiting',message:'Waiting for Comic Vine until '+when(data.providerRetryAt)+'.'};
  return {...receipt,phase:'waiting',message:book.manual_requested_at?'Waiting for its turn. Omnibus checks requested work every 30 seconds.':'Waiting for a confirmed result. No check has been repeated.'};
}
