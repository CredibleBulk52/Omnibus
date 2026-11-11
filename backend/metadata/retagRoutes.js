'use strict';
const {parseCvIssueId}=require('./evidence');
function errorResponse(res,error) {
  const status=error.code==='BOOK_UNAVAILABLE'?404:error.code==='INVALID_CV_ID'?400:error.code==='CV_RATE_LIMIT'?429:
    /REVIEW|MISMATCH|OCCUPIED|RECOVERY|CONFIRMATION|INCOMPLETE|SELECTION|ARCHIVE_/.test(error.code||'')?409:500;
  return res.status(status).json({error:error.message,code:error.code,operationId:error.operationId});
}
// prefetch(bookId): optional; looks up the next book's Comic Vine issue while the current one is being
// written, so its retag starts with the (cached) reply. Read-only (2026-10-22).
function createRetagHandlers({getRuntime,logger,prefetch=null}) {
  const single=async(req,res)=>{
    try {
      const body=req.body||{},values=[body.cvIssueId,body.cv_issue_url].filter(v=>v!==undefined&&v!==null&&v!=='');
      const ids=values.map(parseCvIssueId);
      if(ids.some(id=>!id)||new Set(ids).size>1)throw Object.assign(new Error('Use one matching Comic Vine issue URL or issue ID'),{code:'INVALID_CV_ID'});
      // salvage: "Convert anyway" for a damaged CBR (unreadable pages dropped).
      const result=await getRuntime().retag({bookId:req.params.id,explicitIssueId:ids[0]||null,salvage:body.salvage===true});
      res.json({success:true,source:ids.length?'cv-url':'monitored',...result});
    } catch(error){logger.warn('retag',error.message);errorResponse(res,error);}
  };
  const batch=async(req,res)=>{
    const ids=req.body?.bookIds;
    if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id))return res.status(400).json({error:'bookIds required'});
    const books=[...new Set(ids)],controller=new AbortController();
    const closed=()=>controller.abort();res.on('close',closed);
    res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');
    const send=value=>{if(!res.destroyed)res.write(`data: ${JSON.stringify(value)}\n\n`);};
    let done=0,errors=0,aborted=false;
    try {
      for(const [index,bookId] of books.entries()){
        if(controller.signal.aborted)break;
        try {send({log:`Retagging ${bookId}...\n`});const current=getRuntime().retag({bookId,signal:controller.signal});
          if(prefetch&&books[index+1])try{prefetch(books[index+1]);}catch{}
          await current;done++;}
        catch(error){errors++;send({log:`Error: ${error.message}\n`,code:error.code,operationId:error.operationId});
          if(['CV_RATE_LIMIT','LIBRARY_RECOVERY_REQUIRED','ARCHIVE_CANCELLED'].includes(error.code)||getRuntime().status().length){aborted=true;break;}}
        send({progress:{done:done+errors,total:books.length}});
      }
      send({done:true,total:books.length,succeeded:done,errors,aborted,cancelled:controller.signal.aborted});res.end();
    } catch(error){logger.warn('retag',error.message);if(!res.destroyed)res.end();}
    finally {res.removeListener('close',closed);}
  };
  return {single,batch,errorResponse};
}
module.exports={createRetagHandlers,errorResponse};
