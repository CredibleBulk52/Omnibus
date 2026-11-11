'use strict';
// Container-local Unix socket, never exposed through the public HTTP server.
const http=require('node:http'),fs=require('node:fs');
const socketPath='/tmp/omnibus-deploy.sock';
function serve(gate){
  if(process.platform==='win32')return null;
  try{fs.unlinkSync(socketPath);}catch(e){if(e.code!=='ENOENT')throw e;}
  const server=http.createServer(async(req,res)=>{
    if(req.method!=='POST'||!['/drain','/resume'].includes(req.url)){res.writeHead(404);return res.end();}
    if(req.url==='/resume'){gate.resume();res.writeHead(200);return res.end('Resumed');}
    const done=await gate.drain();res.writeHead(done?200:409);res.end(done?'Drained':'Active work did not finish; deployment must stop');
  });
  server.listen(socketPath,()=>fs.chmodSync(socketPath,0o600));
  return server;
}
if(require.main===module){
  const action=process.argv[2];
  if(!['drain','resume'].includes(action))process.exit(2);
  const req=http.request({socketPath,path:'/'+action,method:'POST'},res=>{
    res.pipe(process.stdout);res.on('end',()=>{process.exitCode=res.statusCode===200?0:1;});
  });
  req.setTimeout(125000,()=>req.destroy(Error('Deployment control timed out')));
  req.on('error',e=>{console.error(e.message);process.exitCode=1;});req.end();
}
module.exports={serve};
