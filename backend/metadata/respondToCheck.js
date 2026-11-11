'use strict';
async function respondToCheck({work,res,queued={},logger,waitMs=2000}){
  let timer;
  const outcome=Promise.resolve(work).then(result=>({result}),error=>{
    logger.warn('metadata-http','Check failed',{code:error.code||'ERROR',message:error.message});
    return {error};
  });
  let value;
  try{value=await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(()=>resolve({pending:true}),waitMs);})]);}
  finally{clearTimeout(timer);}
  if(value.error)throw value.error;
  if(res.destroyed||res.writableEnded)return;
  if(value.pending)return res.status(202).json({...queued,started:true});
  return res.json({...queued,...value.result});
}
module.exports={respondToCheck};
