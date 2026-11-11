'use strict';
const {randomUUID}=require('node:crypto');
function metadataRequestDiagnostics({logger,now=Date.now}){
  return (req,res,next)=>{
    if(!/^\/api\/admin\/(metadata[-/]|untagged-sweep)/.test(req.path))return next();
    const requestId=randomUUID(),start=now();let finished=false;
    res.setHeader('X-Omnibus-Request-ID',requestId);
    const info=()=>({requestId,method:req.method,path:req.path,status:res.statusCode,ms:now()-start});
    res.once('finish',()=>{finished=true;if(res.statusCode>=400||now()-start>2000)logger.warn('metadata-http','Metadata response completed',info());});
    res.once('close',()=>{if(!finished)logger.warn('metadata-http','Connection closed before metadata response finished',info());});
    next();
  };
}
module.exports={metadataRequestDiagnostics};
